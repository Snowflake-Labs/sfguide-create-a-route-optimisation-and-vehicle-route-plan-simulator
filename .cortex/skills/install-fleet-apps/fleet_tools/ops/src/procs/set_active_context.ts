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
// The dashboard CONFIG schemas whose single-row CONFIG table carries REGION /
// VEHICLE_TYPE. Matches the /api/region default schema allowlist. Hardcoded to
// FLEET_INTELLIGENCE (this bundle is fleet-scoped, like the other ops verbs).
const SCHEMAS = ['DWELL_ANALYSIS', 'ROUTE_DEVIATION', 'ROUTE_OPTIMIZATION'] as const;

export const set_active_context = defineProc({
  name: 'set_active_context',
  description:
    'Promote the global active dashboard context by setting the region and/or ' +
    'vehicle/asset mode in the per-schema CONFIG tables that dashboards and the ' +
    'routing tool layer read. Provide region, vehicle_type, or both (at least ' +
    'one). Fails NO_CONTEXT_VALUE when neither is given and REGION_NOT_PROVISIONED ' +
    'for an unknown region. Distinct from set_active_region (substrate default). Ops-only.',
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
    for (const schema of SCHEMAS) {
      // schema is a compile-time constant identifier; values are bound.
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
