import { defineProc, t } from '@snowflake/synapse';
import { OpsCodes } from '../codes.js';

// Promote the GLOBAL active dashboard context (region and/or vehicle/asset mode)
// by updating the per-schema CONFIG single-row tables that the projection views
// and routing tool layer read. This is the audited synapse equivalent of the
// raw UPDATE the /api/region POST used to run directly (Tenet 7): the SA app now
// routes that mutation through this verb so it lands in VERB_ATTEMPT and inherits
// the region-provisioned guard.
//
// NOTE: this is distinct from set_active_region, which flips
// CORE.REGION_REGISTRY.IS_DEFAULT (the routing substrate's default region). The
// two are complementary: set_active_context drives the app dashboards/projection
// views; set_active_region drives the substrate default. Ops-only.
const DB = 'FLEET_INTELLIGENCE';

// The dashboard CONFIG schemas are DISCOVERED, not listed.
//
// There used to be three hardcoded lists in three separately-deployed packages -
// this verb and the SA app's /api/region both carried 3 schemas while the admin
// app's region-sync carried 8 - so promoting a region moved HALF the account and
// left the rest wherever the last Data Studio run had put it. Measured on
// tib85385: DWELL_ANALYSIS / ROUTE_DEVIATION / ROUTE_OPTIMIZATION on
// SanFrancisco while CATCHMENT / MARKETPLACE / BACKLOAD_MATCHING sat on Europe,
// so a cross-domain question silently mixed San Francisco e-bikes with European
// trucks. Because the three lists live in different npm packages there is no
// shared module to import, so any list-based fix would drift again.
//
// Discovery keys off the SHAPE of the table (a CONFIG table carrying both REGION
// and VEHICLE_TYPE), so a seventh domain is picked up with no code change
// (Tenet 4: config-driven, not code-edited). Schema names come from
// INFORMATION_SCHEMA and are re-validated against an identifier pattern before
// interpolation; only the VALUES are ever user-supplied.
const IDENT = /^[A-Z_][A-Z0-9_]*$/;

type ExecFn = (sql: string, binds?: unknown[]) => Record<string, unknown>[] | Promise<Record<string, unknown>[]>;

async function discoverConfigSchemas(exec: ExecFn): Promise<string[]> {
  const rows = await exec(
    `SELECT TABLE_SCHEMA
       FROM ${DB}.INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = 'CONFIG'
        AND COLUMN_NAME IN ('REGION', 'VEHICLE_TYPE')
      GROUP BY TABLE_SCHEMA
     HAVING COUNT(DISTINCT COLUMN_NAME) = 2
      ORDER BY TABLE_SCHEMA`,
  );
  return (Array.isArray(rows) ? rows : [])
    .map((r) => String(Object.values(r)[0] ?? '').toUpperCase())
    .filter((s) => IDENT.test(s));
}

export const set_active_context = defineProc({
  name: 'set_active_context',
  description:
    'MUTATES SHARED GLOBAL STATE for every user of this deployment: promotes the ' +
    'default dashboard context by setting region and/or vehicle/asset mode in the ' +
    'per-domain CONFIG tables. Confirm the exact target with the user and call ONLY ' +
    'after explicit agreement. NOT needed to ANSWER a question about a region - the ' +
    'dashboards and semantic views carry every loaded region as a filterable ' +
    'dimension, so reading about another region requires no switch. Provide region, ' +
    'vehicle_type, or both (at least one). Fails NO_CONTEXT_VALUE when neither is ' +
    'given and REGION_NOT_PROVISIONED for an unknown region. Distinct from ' +
    'set_active_region (substrate default). Ops-only.',
  roles: ['ops'],
  args: {
    region: t
      .string({ max: 80 })
      .nullable()
      .describe('Region to activate across dashboards, or null to leave the region unchanged.'),
    vehicle_type: t
      .string({ max: 80 })
      .nullable()
      .describe('Vehicle/asset mode to activate (e.g. hgv, car, cycling-regular), or null to leave unchanged.'),
  },
  returns: {
    applied: t.object({}).describe('The context values applied: {region?, vehicle_type?}.'),
    updated: t.object({}).describe('Map of CONFIG schema -> rows updated.'),
  },
  validate: async (args, ctx) => {
    const region = args.region != null && String(args.region).trim() !== '' ? String(args.region).trim() : null;
    const vt = args.vehicle_type != null && String(args.vehicle_type).trim() !== '' ? String(args.vehicle_type).trim() : null;
    if (!region && !vt) {
      ctx.fail(OpsCodes.NO_CONTEXT_VALUE, 'Provide at least one of region or vehicle_type.');
    }
    // Region, when supplied, must be a provisioned region. Checked through the
    // routing contract (Tenet 1), never by reading the engine schema directly.
    if (region) {
      const ok = await ctx.conn.execScalar<boolean>(
        'SELECT ROUTING_PLATFORM.CONTRACT.REGION_EXISTS(?)',
        [region],
      );
      if (!ok) {
        ctx.fail(OpsCodes.REGION_NOT_PROVISIONED, `region '${region}' is not a provisioned routing region.`);
      }
    }
  },
  execute: async (args, ctx) => {
    const region = args.region != null && String(args.region).trim() !== '' ? String(args.region).trim() : null;
    const vt = args.vehicle_type != null && String(args.vehicle_type).trim() !== '' ? String(args.vehicle_type).trim() : null;

    // Fixed SET clause with bound values (no user-supplied identifiers).
    const sets: string[] = [];
    const binds: unknown[] = [];
    const applied: Record<string, string> = {};
    if (region) {
      sets.push('REGION = ?');
      binds.push(region);
      applied.region = region;
    }
    if (vt) {
      sets.push('VEHICLE_TYPE = ?');
      binds.push(vt);
      applied.vehicle_type = vt;
    }

    const updated: Record<string, number> = {};
    const schemas = await discoverConfigSchemas((sql, b) => ctx.conn.exec(sql, b));
    for (const schema of schemas) {
      // schema is validated against IDENT above; values are bound.
      const rows = (await ctx.conn.exec(`UPDATE ${DB}.${schema}.CONFIG SET ${sets.join(', ')}`, binds)) as Record<
        string,
        unknown
      >[];
      const n = Array.isArray(rows) && rows[0] ? Number(Object.values(rows[0])[0]) : 0;
      updated[schema] = Number.isFinite(n) ? n : 0;
    }

    return { applied, updated };
  },
});
