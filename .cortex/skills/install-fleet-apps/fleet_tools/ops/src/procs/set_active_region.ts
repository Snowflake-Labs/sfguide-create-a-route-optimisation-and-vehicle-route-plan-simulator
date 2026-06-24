import { defineProc, t } from '@snowflake/synapse';
import { OpsCodes } from '../codes.js';

export const set_active_region = defineProc({
  name: 'set_active_region',
  description:
    'Set the active routing region (updates the server-side CONFIG used by the ' +
    'routing substrate and projection views). Fails with REGION_NOT_PROVISIONED ' +
    'when the region has not been provisioned. Ops-only operation.',
  roles: ['ops'],
  args: {
    region: t.string({ min: 1, max: 80 }).describe('Region name to activate (e.g. "SanFrancisco").'),
  },
  returns: {
    message: t.string().describe('Confirmation message from the substrate.'),
  },
  validate: async (args, ctx) => {
    // Reject activating a region that is not provisioned. Checked through the
    // routing contract (Tenet 1) — never by reading the engine schema directly.
    // REGION_EXISTS returns TRUE for null/empty, so guard the empty case too
    // (the schema already enforces min length 1).
    if (args.region != null && args.region.trim() !== '') {
      const ok = await ctx.conn.execScalar<boolean>(
        'SELECT ROUTING_PLATFORM.CONTRACT.REGION_EXISTS(?)',
        [args.region],
      );
      if (!ok) {
        ctx.fail(
          OpsCodes.REGION_NOT_PROVISIONED,
          `region '${args.region}' is not a provisioned routing region.`,
        );
      }
    }
  },
  execute: async (args, ctx) => {
    const out = await ctx.conn.execScalar<string>(
      'CALL FLEET_INTELLIGENCE.CORE.SET_ACTIVE_REGION(?)',
      [args.region],
    );
    return { message: out == null ? `Active region set to ${args.region}` : String(out) };
  },
});
