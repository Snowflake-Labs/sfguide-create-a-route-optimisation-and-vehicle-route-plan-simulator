import { defineProc, t } from '@snowflake/synapse';

export const set_active_region = defineProc({
  name: 'set_active_region',
  description:
    'Set the active routing region (updates the server-side CONFIG used by the ' +
    'routing substrate and projection views). Ops-only operation.',
  roles: ['ops'],
  args: {
    region: t.string({ min: 1, max: 80 }).describe('Region name to activate (e.g. "Europe").'),
  },
  returns: {
    message: t.string().describe('Confirmation message from the substrate.'),
  },
  execute: async (args, ctx) => {
    const out = await ctx.conn.execScalar<string>(
      'CALL FLEET_INTELLIGENCE.CORE.SET_ACTIVE_REGION(?)',
      [args.region],
    );
    return { message: out == null ? `Active region set to ${args.region}` : String(out) };
  },
});
