import { defineProc, t } from '@snowflake/synapse';

/**
 * Hand over a URL that opens the Fleet ADMIN app.
 *
 * WHY A SEPARATE VERB
 * -------------------
 * `deep_link` in the user bundle now takes an `app` argument and can target the
 * admin app, but a verb's `roles` field only decides who gets GRANT USAGE - it
 * does not put the procedure in another bundle, and each agent attaches ONE MCP
 * server. So the ops and admin agents could not see it. This is the same
 * duplication pattern the bundles already use for `set_active_region` and
 * `describe_deployment`, which exist as separate files in ops and admin.
 *
 * Why it matters: every genuinely app-only capability (dataset generation,
 * matrix cancel, region cancel, catalog refresh, config edits) is done in this
 * app, and the operator agents had no way to hand it over. An instruction that
 * says "point at the admin app" with no tool to produce the URL invites the
 * model to construct one, and the ingress hostname is deployment-specific.
 *
 * Read-only. Resolving an endpoint does not wake the service.
 */

const SERVICE_FQN = 'FLEET_INTELLIGENCE.SYNAPSE_USER.FLEET_ADMIN_APP';
const ENDPOINT_NAME = 'fleet-admin-app';

// Allowlist rather than free text: the value lands in a URL, and a guessed page
// gives the user a 404 that reads as a broken deployment.
const PAGES = ['regions', 'services', 'matrix', 'studio', 'observability', 'diagnostics', 'cost'];

export const open_admin_app = defineProc({
  name: 'open_admin_app',
  description:
    'Build a shareable URL that opens the Fleet ADMIN app, optionally on a specific page. Use ' +
    'this whenever the user asks for something this deployment only exposes in the admin app - ' +
    'generating a dataset, cancelling or restoring a matrix build, cancelling a region build, ' +
    'refreshing the region catalog, editing configuration - so the answer ends with a link ' +
    'instead of a dead end. Never construct an app URL by hand: the hostname is ' +
    'deployment-specific and is resolved here. Read-only.',
  roles: ['ops'],
  args: {
    page: t
      .string({ max: 40 })
      .nullable()
      .describe(
        'Optional page: regions (build and manage routing regions), services (suspend and ' +
          'resume), matrix (travel-matrix builds), studio (Data Studio dataset generation), ' +
          'observability, diagnostics, cost. Omit for the home page.',
      ),
  },
  returns: {
    url: t.string().describe('The absolute URL, or an empty string when the host is unresolvable.'),
    label: t.string().describe('Link text to show the user.'),
    note: t.string().describe('Caveat to pass on to the user.'),
  },
  validate: async (args, ctx) => {
    const page = (args.page ?? '').trim().toLowerCase();
    if (page !== '' && !PAGES.includes(page)) {
      ctx.fail('INVALID_ADMIN_PAGE', `page must be one of ${PAGES.join(', ')} (got "${page}")`);
    }
  },
  execute: async (args, ctx) => {
    const page = (args.page ?? '').trim().toLowerCase();

    let host = '';
    try {
      const rows = await ctx.conn.exec<Record<string, unknown>>(
        `SHOW ENDPOINTS IN SERVICE ${SERVICE_FQN}`,
      );
      const row = (rows ?? []).find(
        (r) => String(r.name ?? r.NAME ?? '').toLowerCase() === ENDPOINT_NAME,
      );
      const ingress = row ? String(row.ingress_url ?? row.INGRESS_URL ?? '').trim() : '';
      if (ingress && ingress.toLowerCase() !== 'null') host = ingress;
    } catch {
      host = '';
    }

    if (host === '') {
      return {
        url: '',
        label: 'Fleet Admin app',
        note:
          'The admin app URL could not be resolved: the service may not be deployed, or its ' +
          'public endpoint may not be provisioned yet. Say which page the user needs rather ' +
          'than giving them a guessed link.',
      };
    }

    return {
      url: page === '' ? `https://${host}/` : `https://${host}/${page}`,
      label: page === '' ? 'Fleet Admin app' : `Fleet Admin app: ${page}`,
      note:
        'The admin app requires an operator or admin role and the user\'s own Snowflake login. ' +
        'Say what to do on the page, not just that the page exists.',
    };
  },
});
