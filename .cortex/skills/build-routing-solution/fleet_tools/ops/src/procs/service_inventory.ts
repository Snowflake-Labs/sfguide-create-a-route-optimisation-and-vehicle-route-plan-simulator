import { defineProc, t } from '@snowflake/synapse';

// Live inventory of SPCS services and their compute pools, replicating the ORS
// control app's Service Manager. Wraps the proven owner's-rights proc
// OPENROUTESERVICE_APP.CORE.GET_STATUS() (which runs SHOW COMPUTE POOLS + SHOW
// SERVICES IN SCHEMA OPENROUTESERVICE_APP.CORE) so we inherit its privileges
// instead of granting MONITOR on the pools to the ops role. The synapse
// envelope adds typed returns, audit logging, and role-scoped GRANTs. Ops-only.
//
// Requires: USAGE on PROCEDURE OPENROUTESERVICE_APP.CORE.GET_STATUS() granted to
// the SYNAPSE_OPS proc owner role (this proc runs EXECUTE AS OWNER).
export const service_inventory = defineProc({
  name: 'service_inventory',
  description:
    'List all SPCS services and their compute pools (state, instance family, ' +
    'node counts, per-service instance counts) for the routing platform. ' +
    'Mirrors the ORS control app Service Manager. Ops-only.',
  roles: ['ops'],
  args: {},
  returns: {
    // The "main" compute pool state, and its full metadata object.
    compute_pool: t.string().describe('State of the primary compute pool.'),
    compute_pool_info: t
      .object({})
      .nullable()
      .describe('Metadata for the primary compute pool (state, nodes, family).'),
    // Map of poolName -> { state, instance_family, min/max/active/idle_nodes, num_services }.
    compute_pools: t.object({}).describe('All compute pools keyed by name.'),
    // Array of { name, fq_name?, status, compute_pool, min/max/current/target_instances, auto_suspend_secs }.
    // Includes the ORS CORE services plus the Fleet app's own services
    // (FLEET_SA_APP, FLEET_ADMIN_APP), which carry fq_name for cross-schema control.
    services: t.array(t.object({})).describe('All non-job services with their compute pool.'),
  },
  execute: async (_args, ctx) => {
    const raw = await ctx.conn.execScalar<string>('CALL OPENROUTESERVICE_APP.CORE.GET_STATUS()');
    let parsed: Record<string, unknown> = {};
    try {
      parsed = raw == null ? {} : (JSON.parse(String(raw)) as Record<string, unknown>);
    } catch {
      parsed = {};
    }
    const services: Record<string, unknown>[] = Array.isArray(parsed.services)
      ? (parsed.services as Record<string, unknown>[])
      : [];

    // GET_STATUS only scopes SHOW SERVICES to OPENROUTESERVICE_APP.CORE, so the
    // Fleet app's own services (FLEET_SA_APP, FLEET_ADMIN_APP), which run in the
    // shared OPENROUTESERVICE_APP_COMPUTE_POOL but live in a different schema, are
    // missing. Fetch them here so the Ops Console can nest them under their real
    // compute pool with live status instead of as a detached, status-less row.
    // Each carries fq_name so the UI targets the correct schema for control verbs.
    // SHOW + RESULT_SCAN(LAST_QUERY_ID()) run as two sequential statements on the
    // same proc session (the pattern CORE.GET_STATUS uses) -- do NOT wrap in
    // EXECUTE IMMEDIATE, whose dollar-quoted body fails to parse here.
    // Best-effort: a privilege/visibility miss leaves the base inventory intact.
    try {
      await ctx.conn.execScalar<string>('SHOW SERVICES IN SCHEMA FLEET_INTELLIGENCE.SYNAPSE_USER');
      const appsJson = await ctx.conn.execScalar<string>(
        `SELECT COALESCE(ARRAY_AGG(OBJECT_CONSTRUCT(
            'name', "name",
            'fq_name', 'FLEET_INTELLIGENCE.SYNAPSE_USER.' || "name",
            'status', "status",
            'compute_pool', "compute_pool",
            'min_instances', "min_instances",
            'max_instances', "max_instances",
            'current_instances', "current_instances",
            'target_instances', "target_instances",
            'auto_suspend_secs', "auto_suspend_secs"
          )), ARRAY_CONSTRUCT())::STRING
          FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
          WHERE "is_job" = 'false'`,
      );
      const apps = appsJson == null ? [] : (JSON.parse(String(appsJson)) as Record<string, unknown>[]);
      if (Array.isArray(apps)) {
        for (const app of apps) services.push(app);
      }
    } catch {
      /* leave base inventory intact on privilege/visibility miss */
    }

    return {
      compute_pool: typeof parsed.compute_pool === 'string' ? (parsed.compute_pool as string) : 'UNKNOWN',
      compute_pool_info:
        parsed.compute_pool_info && typeof parsed.compute_pool_info === 'object'
          ? (parsed.compute_pool_info as Record<string, unknown>)
          : null,
      compute_pools:
        parsed.compute_pools && typeof parsed.compute_pools === 'object'
          ? (parsed.compute_pools as Record<string, unknown>)
          : {},
      services,
    };
  },
});
