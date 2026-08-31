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
 */

const APP_SERVICE_FQN = 'FLEET_INTELLIGENCE.SYNAPSE_USER.FLEET_SA_APP';
const APP_ENDPOINT_NAME = 'fleet-sa-app';

export const deep_link = defineProc({
  name: 'deep_link',
  description:
    'Build a shareable URL that opens a specific dashboard view in the Fleet app with a region, ' +
    'asset mode, dataset and/or selection already applied. Use this whenever a question is ' +
    'inherently visual (a map, a route, a catchment, a heatmap) and you are NOT running inside ' +
    'the app: answer with the figures you can retrieve, then offer this link so the user can see ' +
    'the actual map. Never describe a map as if you had rendered it, and never construct an app ' +
    'URL by hand - the hostname is deployment-specific and is resolved here. The view id must be ' +
    'one from the solution catalog (search_solution_catalog or list_use_cases).',
  roles: ['user'],
  args: {
    view_id: t
      .string({ min: 1, max: 120 })
      .describe('View to open, e.g. "delivery_sync" or "catchment". Must exist in the catalog.'),
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
    const id = (args.view_id ?? '').trim();
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
    const viewId = args.view_id.trim();

    let label = viewId;
    try {
      const got = await ctx.conn.execScalar<string>(
        `SELECT LABEL FROM FLEET_INTELLIGENCE.SEMANTIC.VIEW_CATALOG WHERE VIEW_ID = ? LIMIT 1`,
        [viewId],
      );
      if (got) label = String(got);
    } catch {
      // Keep the id as the label.
    }

    // Resolve the ingress host from the live service.
    let host = '';
    try {
      const rows = await ctx.conn.exec<Record<string, unknown>>(
        `SHOW ENDPOINTS IN SERVICE ${APP_SERVICE_FQN}`,
      );
      const row = (rows ?? []).find(
        (r) => String(r.name ?? r.NAME ?? '').toLowerCase() === APP_ENDPOINT_NAME,
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

    const qs = new URLSearchParams();
    qs.set('view', viewId);
    if (args.region) qs.set('region', args.region.trim());
    if (args.vehicle_type) qs.set('vehicle', args.vehicle_type.trim());
    if (args.dataset_id) qs.set('dataset', args.dataset_id.trim());
    if (args.selection) qs.set('select', args.selection.trim());

    return {
      url: `https://${host}/?${qs.toString()}`,
      view_id: viewId,
      label,
      note:
        'Opening the link applies the region and selection on load. The app requires the ' +
        "user's own Snowflake login, and a routing view needs that region's services running.",
    };
  },
});
