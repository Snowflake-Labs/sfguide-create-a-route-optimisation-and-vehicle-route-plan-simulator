import { defineProc, t } from '@snowflake/synapse';

export const check_substrate = defineProc({
  name: 'check_substrate',
  description:
    'Verify the routing substrate is present: counts the CORE routing functions ' +
    'and the ROUTING_AGENT TOOL_* procedures the User bundle wraps. Admin-only.',
  roles: ['admin'],
  args: {},
  returns: {
    ok: t.boolean().describe('True when the expected substrate objects are present.'),
    core_functions: t.number().describe('Count of functions in FLEET_INTELLIGENCE.CORE.'),
    tool_procs: t.number().describe('Count of TOOL_* procedures in FLEET_INTELLIGENCE.ROUTING_AGENT.'),
  },
  execute: async (_args, ctx) => {
    const coreFns = await ctx.conn.execScalar<number>(
      `SELECT COUNT(*) AS n FROM FLEET_INTELLIGENCE.INFORMATION_SCHEMA.FUNCTIONS WHERE FUNCTION_SCHEMA = 'CORE'`,
    );
    const toolProcs = await ctx.conn.execScalar<number>(
      `SELECT COUNT(*) AS n FROM FLEET_INTELLIGENCE.INFORMATION_SCHEMA.PROCEDURES WHERE PROCEDURE_SCHEMA = 'ROUTING_AGENT' AND STARTSWITH(PROCEDURE_NAME, 'TOOL_')`,
    );
    const core = Number(coreFns ?? 0);
    const tools = Number(toolProcs ?? 0);
    return { ok: tools > 0, core_functions: core, tool_procs: tools };
  },
});
