import { defineProc, t } from '@snowflake/synapse';

/**
 * Read-only "what is installed and is it up" rollup, shared by all three
 * role-scoped bundles.
 *
 * Exists because service run-state used to be reachable only through Ops-only
 * ACTION verbs, so a user who opened the wrong agent got a refusal instead of an
 * answer to "is ORS running for San Francisco?". Run-state is a fact, not an
 * action: sharing the READ while keeping suspend/resume Ops-only preserves
 * Tenet 3 role isolation and removes the dead end.
 *
 * The logic lives once in FLEET_INTELLIGENCE.SEMANTIC.DESCRIBE_DEPLOYMENT
 * (owner's rights, see fleet_sa_app/app/deployment_facts.sql). Each bundle's
 * copy of this verb is a thin, audited wrapper so the three bundles cannot drift.
 */
export const describe_deployment = defineProc({
  name: 'describe_deployment',
  description:
    'Report what this deployment has installed and whether it is up: provisioned routing ' +
    'regions with per-region routing (ORS) and optimization (VROOM) service state, the ' +
    'gateway state, the active region and asset mode, substrate counts, and how many ' +
    'solution use cases the catalog holds. Use for "is routing running for <region>", "is ' +
    'the platform up", "which regions are installed", "what is the active region". ' +
    'Read-only: it never starts, stops or wakes a service - suspend/resume is an Ops action.',
  roles: ['admin'],
  args: {},
  returns: {
    substrate_ok: t.boolean().describe('True when the routing functions AND the TOOL_* procedures are present.'),
    active_region: t.string().nullable().describe('Region the dashboards and projection views are currently scoped to.'),
    active_vehicle_type: t.string().nullable().describe('Active asset mode (e.g. hgv, car, ebike).'),
    gateway_service: t.string().describe('Routing gateway service state (RUNNING / SUSPENDED / NOT_FOUND).'),
    regions: t
      .array(t.object({}))
      .describe(
        'Per region: region, routing_service, optimization_service, and routing_available ' +
          '(true only when the routing service is RUNNING). SUSPENDED is normal and recoverable, ' +
          'not a broken install.',
      ),
    catalog_use_cases: t.number().describe('Number of demonstrable use cases in the solution catalog.'),
    details: t.object({}).describe('Full rollup, including substrate and semantic-view counts.'),
  },
  execute: async (_args, ctx) => {
    const raw = await ctx.conn.execScalar<string>('CALL FLEET_INTELLIGENCE.SEMANTIC.DESCRIBE_DEPLOYMENT()');
    let d: Record<string, unknown> = {};
    try {
      d = raw == null ? {} : (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>;
    } catch {
      d = {};
    }
    const str = (k: string): string | null => (typeof d[k] === 'string' ? (d[k] as string) : null);
    return {
      substrate_ok: d.substrate_ok === true,
      active_region: str('active_region'),
      active_vehicle_type: str('active_vehicle_type'),
      gateway_service: str('gateway_service') ?? 'UNKNOWN',
      regions: Array.isArray(d.regions) ? (d.regions as Record<string, unknown>[]) : [],
      catalog_use_cases: Number(d.catalog_use_cases ?? 0),
      details: d,
    };
  },
});
