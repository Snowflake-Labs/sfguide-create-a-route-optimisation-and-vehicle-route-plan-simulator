import { defineProc, t } from '@snowflake/synapse';
import { OpsCodes } from '../codes.js';

/**
 * Delete a routing region: its ORS service, its VROOM service, its catalog row
 * and its launch task.
 *
 * THIS IS DESTRUCTIVE AND EXPENSIVE TO UNDO. Rebuilding the region means another
 * multi-hour graph build, so the verb requires an explicit `confirm` rather than
 * trusting the agent to have asked. Two guards:
 *
 *   confirm !== true      -> CONFIRMATION_REQUIRED
 *   region is the ACTIVE  -> REGION_IS_ACTIVE
 *
 * The active-region guard matters because every dashboard, semantic view and
 * projection binds to the active region: dropping it does not fail loudly, it
 * quietly empties the whole app. Switching the active region first is a
 * deliberate step, not something to infer.
 */
export const drop_region = defineProc({
  name: 'drop_region',
  description:
    'DESTRUCTIVE. Delete a routing region: drops its routing and optimizer services and removes ' +
    'it from the region map. Rebuilding it later costs another multi-hour graph build, so state ' +
    'the exact region and get explicit user agreement BEFORE calling, then pass confirm=true. ' +
    'Refuses to drop the currently active region, because every dashboard binds to it and ' +
    'dropping it silently empties the app - switch the active region first with set_active_region.',
  roles: ['ops'],
  args: {
    region: t.string({ min: 1, max: 80 }).describe('Region to delete.'),
    confirm: t
      .boolean()
      .describe(
        'Must be true. Set it only after the user has explicitly agreed to delete this specific ' +
          'region; do not default it to true.',
      ),
  },
  returns: {
    message: t.string().describe('What was dropped.'),
    region: t.string().describe('The region that was dropped.'),
  },
  validate: async (args, ctx) => {
    if (args.confirm !== true) {
      ctx.fail(
        OpsCodes.CONFIRMATION_REQUIRED,
        `dropping region '${args.region}' removes its routing services and requires a ` +
          'multi-hour rebuild to undo. Confirm with the user, then call again with confirm=true.',
      );
      return;
    }

    // Refuse if this is the active region. Read through the substrate CONFIG the
    // dashboards actually bind to, not the engine's own map.
    let active: string | null = null;
    try {
      active = await ctx.conn.execScalar<string>(
        `SELECT REGION FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG LIMIT 1`,
      );
    } catch {
      // No substrate CONFIG (engine-only deployment): nothing binds to a region,
      // so there is nothing to protect and the drop may proceed.
      active = null;
    }
    if (
      active != null &&
      String(active).replace(/\s+/g, '').toUpperCase() ===
        args.region.replace(/\s+/g, '').toUpperCase()
    ) {
      ctx.fail(
        OpsCodes.REGION_IS_ACTIVE,
        `'${args.region}' is the ACTIVE region: every dashboard and semantic view binds to it, ` +
          'so dropping it would leave the app rendering empty panels with no error. Point the ' +
          'active region at another provisioned region first (set_active_region), then retry.',
      );
    }
  },
  execute: async (args, ctx) => {
    const out = await ctx.conn.execScalar<string>(
      'CALL OPENROUTESERVICE_APP.CORE.DROP_REGION_ORS(?)',
      [args.region],
    );

    // Mark any in-flight build for this region cancelled, mirroring what the
    // admin app's DELETE does. Without this the job row stays RUNNING forever and
    // the provision_region in-flight guard would refuse a future rebuild.
    try {
      await ctx.conn.exec(
        `UPDATE OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
            SET STATUS = 'CANCELLED', COMPLETED_AT = SYSDATE()
          WHERE UPPER(REGION) = UPPER(?) AND STATUS IN ('RUNNING', 'PENDING')`,
        [args.region],
      );
    } catch {
      // Non-fatal: the services are already gone, which is the important part.
    }

    return {
      message: out == null ? `Dropped region ${args.region}` : String(out),
      region: args.region,
    };
  },
});
