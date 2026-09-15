import { defineProc, t } from '@snowflake/synapse';
import { DataCodes } from '../codes.js';

/**
 * Build a URL that opens a specific SA app view, already scoped.
 *
 * WHY THIS EXISTS
 * ---------------
 * Outside the app - in Cowork / Snowflake Intelligence - there is no deck.gl
 * canvas, so the agent cannot draw the accelerator's maps. It has two honest
 * options: answer with the numbers it can get, and hand over a link that opens
 * the real map with the right region and selection already applied. This verb is
 * the second one. Claiming to display a map it cannot render would be a defect,
 * and so would inventing a URL.
 *
 * The host is resolved from the live service endpoint (SHOW ENDPOINTS IN
 * SERVICE), matching how the app's own /api/admin-link cross-link works, rather
 * than being hardcoded - the ingress hostname is account and deployment
 * specific.
 *
 * The view id is validated against VIEW_CATALOG, so a link can only ever point
 * at a view this deployment actually has.
 *
 * TWO APPS, ONE VERB
 * ------------------
 * This used to be pinned to the SA app, and it is a `user` verb, so the ADMIN
 * agent had no deep link at all: an operational answer about a region build or a
 * matrix could only end in prose, with no way to hand over the page that does
 * the work. Since the whole point of the verb is "do not invent a URL", the
 * absence of an admin target made inventing one the only option. `app` selects
 * the target and the verb is published to all three bundles.
 *
 * The admin app takes no view parameters, so an admin link is host-only plus an
 * optional `page` hint. Passing a view id at an admin target is a refusal rather
 * than a silently ignored argument.
 */

const TARGETS: Record<string, { service: string; endpoint: string }> = {
  sa: {
    service: 'FLEET_INTELLIGENCE.SYNAPSE_USER.FLEET_SA_APP',
    endpoint: 'fleet-sa-app',
  },
  admin: {
    service: 'FLEET_INTELLIGENCE.SYNAPSE_USER.FLEET_ADMIN_APP',
    endpoint: 'fleet-admin-app',
  },
};

// Admin pages an agent may hand over. An allowlist rather than free text: the
// value lands in a URL, and a wrong guess sends the user to a 404 that looks
// like a broken deployment.
const ADMIN_PAGES = [
  'regions',
  'services',
  'matrix',
  'studio',
  'observability',
  'diagnostics',
  'cost',
];

export const deep_link = defineProc({
  name: 'deep_link',
  description:
    'Build a shareable URL that opens a specific dashboard view in the Fleet app with a region, ' +
    'asset mode, dataset and/or selection already applied. Use this whenever a question is ' +
    'inherently visual (a map, a route, a catchment, a heatmap) and you are NOT running inside ' +
    'the app: answer with the figures you can retrieve, then offer this link so the user can see ' +
    'the actual map. Never describe a map as if you had rendered it, and never construct an app ' +
    'URL by hand - the hostname is deployment-specific and is resolved here. The view id must be ' +
    'one from the solution catalog (search_solution_catalog or list_use_cases). Set app to ' +
    '"admin" instead to hand over the Fleet ADMIN app, which is where region builds, matrix ' +
    'builds, dataset generation, service control and diagnostics are done - use that whenever the ' +
    'user asks for an operation this deployment only exposes in the admin app.',
  // Stays a USER-bundle verb. `roles` only decides GRANT USAGE, not which
  // bundle publishes the procedure, and each agent attaches ONE MCP server - so
  // widening it to ops/admin grants a privilege on a procedure those agents
  // still cannot see as a tool, and the framework then rejects the bundle for a
  // missing role binding. The ops and admin agents get open_admin_app instead.
  roles: ['user'],
  args: {
    app: t
      .string({ max: 10 })
      .nullable()
      .describe(
        'Which app to open: "sa" (default) for the analytics dashboards, or "admin" for the ' +
          'operator console (region builds, matrix builds, Data Studio, diagnostics).',
      ),
    page: t
      .string({ max: 40 })
      .nullable()
      .describe(
        'Admin app only. One of regions, services, matrix, studio, observability, diagnostics, ' +
          'cost. Omit for the admin home page.',
      ),
    view_id: t
      .string({ min: 1, max: 120 })
      .nullable()
      .describe(
        'SA app only. View to open, e.g. "delivery_sync" or "catchment". Must exist in the ' +
          'catalog. Required when app is "sa".',
      ),
    region: t.string({ max: 80 }).nullable().describe('Optional region to preselect.'),
    vehicle_type: t
      .string({ max: 80 })
      .nullable()
      .describe('Optional asset mode to preselect (e.g. car, hgv, ebike).'),
    dataset_id: t.string({ max: 200 }).nullable().describe('Optional dataset id to preselect.'),
    selection: t
      .string({ max: 300 })
      .nullable()
      .describe(
        'Optional selection to apply on open. Either "key=value" pairs separated by commas, or a ' +
          'bare value when the view has a single selectable entity.',
      ),
  },
  returns: {
    url: t.string().describe('The absolute URL, or an empty string when the host is unresolvable.'),
    view_id: t.string().describe('The validated view id.'),
    label: t.string().describe('The view label, for use as the link text.'),
    note: t.string().describe('Caveat to pass on to the user, if any.'),
  },
  validate: async (args, ctx) => {
    const app = (args.app ?? 'sa').trim().toLowerCase() || 'sa';
    if (!(app in TARGETS)) {
      ctx.fail(DataCodes.INVALID_OBJECT_NAME, `app must be "sa" or "admin" (got "${app}")`);
      return;
    }

    if (app === 'admin') {
      const page = (args.page ?? '').trim().toLowerCase();
      if (page !== '' && !ADMIN_PAGES.includes(page)) {
        ctx.fail(
          DataCodes.INVALID_OBJECT_NAME,
          `page must be one of ${ADMIN_PAGES.join(', ')} (got "${page}")`,
        );
      }
      // A view id at an admin target is a category error, not a spare argument:
      // silently dropping it would return a link that does not do what the
      // agent just told the user it does.
      if ((args.view_id ?? '').trim() !== '') {
        ctx.fail(
          DataCodes.INVALID_OBJECT_NAME,
          'view_id applies to the SA app only. The admin app has no dashboard views - pass page ' +
            'instead, or set app to "sa".',
        );
      }
      return;
    }

    const id = (args.view_id ?? '').trim();
    if (id === '') {
      ctx.fail(DataCodes.INVALID_OBJECT_NAME, 'view_id is required when app is "sa"');
      return;
    }
    // Reject anything that is not a bare view id up front: the value goes into a
    // URL, and a catalog lookup on a crafted string is not a substitute for
    // knowing the shape is safe.
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      ctx.fail(
        DataCodes.INVALID_OBJECT_NAME,
        'view_id must contain only letters, digits, underscores and hyphens',
      );
      return;
    }
    let n = 0;
    try {
      n = Number(
        (await ctx.conn.execScalar<number>(
          `SELECT COUNT(*) FROM FLEET_INTELLIGENCE.SEMANTIC.VIEW_CATALOG WHERE VIEW_ID = ?`,
          [id],
        )) ?? 0,
      );
    } catch {
      // No catalog (not yet generated): fall through rather than blocking the
      // link. A wrong id then degrades in the app to "opens the default page",
      // which is better than refusing every link because a table is missing.
      return;
    }
    if (n === 0) {
      ctx.fail(
        DataCodes.UNKNOWN_VIEW_ID,
        `"${id}" is not a view in this deployment. Use search_solution_catalog or ` +
          'list_use_cases to find the right view id.',
      );
    }
  },
  execute: async (args, ctx) => {
    const app = (args.app ?? 'sa').trim().toLowerCase() || 'sa';
    const target = TARGETS[app] ?? TARGETS.sa!;
    const viewId = (args.view_id ?? '').trim();

    let label = app === 'admin' ? 'Fleet Admin app' : viewId;
    if (app === 'sa') {
      try {
        const got = await ctx.conn.execScalar<string>(
          `SELECT LABEL FROM FLEET_INTELLIGENCE.SEMANTIC.VIEW_CATALOG WHERE VIEW_ID = ? LIMIT 1`,
          [viewId],
        );
        if (got) label = String(got);
      } catch {
        // Keep the id as the label.
      }
    }

    // Resolve the ingress host from the live service.
    let host = '';
    try {
      const rows = await ctx.conn.exec<Record<string, unknown>>(
        `SHOW ENDPOINTS IN SERVICE ${target.service}`,
      );
      const row = (rows ?? []).find(
        (r) => String(r.name ?? r.NAME ?? '').toLowerCase() === target.endpoint,
      );
      const ingress = row ? String(row.ingress_url ?? row.INGRESS_URL ?? '').trim() : '';
      if (ingress && ingress.toLowerCase() !== 'null') host = ingress;
    } catch {
      host = '';
    }

    if (host === '') {
      return {
        url: '',
        view_id: viewId,
        label,
        note:
          'The app URL could not be resolved: the app service may not be deployed, or its public ' +
          'endpoint may not be provisioned yet. Tell the user the view name and that they can ' +
          `open it from the app nav ("${label}") rather than giving them a guessed link.`,
      };
    }

    if (app === 'admin') {
      const page = (args.page ?? '').trim().toLowerCase();
      return {
        url: page === '' ? `https://${host}/` : `https://${host}/${page}`,
        view_id: '',
        label: page === '' ? 'Fleet Admin app' : `Fleet Admin app: ${page}`,
        note:
          'The admin app requires an operator or admin role. It is where region builds, matrix ' +
          'builds, Data Studio generation, service control and diagnostics are done - say which ' +
          'page to open and what to do there, rather than implying the task is impossible.',
      };
    }

    // Built by hand rather than with URLSearchParams: synapse emits every verb
    // as a LANGUAGE JAVASCRIPT procedure, and that runtime has no WHATWG URL
    // APIs - so `new URLSearchParams()` threw "URLSearchParams is not defined"
    // at the very last line, AFTER the catalog lookup and the endpoint probe had
    // already succeeded. Nothing caught it at build or deploy time: the bundle
    // compiles, `synapse deploy` succeeds, and the procedure is created, so the
    // first sign of trouble was an agent failing to hand a user a link. Only
    // `encodeURIComponent` is safe here (it is an ECMAScript built-in, not a
    // host API). scripts/check_verb_js_globals.py now fails the commit on this
    // whole class of global.
    const parts: string[] = [`view=${encodeURIComponent(viewId)}`];
    const add = (key: string, value: string | null): void => {
      const v = (value ?? '').trim();
      if (v !== '') parts.push(`${key}=${encodeURIComponent(v)}`);
    };
    add('region', args.region);
    add('vehicle', args.vehicle_type);
    add('dataset', args.dataset_id);
    add('select', args.selection);

    return {
      url: `https://${host}/?${parts.join('&')}`,
      view_id: viewId,
      label,
      note:
        'Opening the link applies the region and selection on load. The app requires the ' +
        "user's own Snowflake login, and a routing view needs that region's services running.",
    };
  },
});
