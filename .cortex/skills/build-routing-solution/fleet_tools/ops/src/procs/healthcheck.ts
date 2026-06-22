import { defineProc, t } from '@snowflake/synapse';

export const healthcheck = defineProc({
  name: 'healthcheck',
  description:
    'Summarize routing-substrate health: counts CORE routing functions and ' +
    'ROUTING_AGENT TOOL_* procedures, and reports the routing gateway service status. Ops-only.',
  roles: ['ops'],
  args: {},
  returns: {
    ok: t.boolean().describe('True when substrate procs are present.'),
    core_functions: t.number().describe('Count of functions in FLEET_INTELLIGENCE.CORE.'),
    tool_procs: t.number().describe('Count of TOOL_* procedures in FLEET_INTELLIGENCE.ROUTING_AGENT.'),
    gateway_status: t.string().describe('SYSTEM$GET_SERVICE_STATUS for the routing gateway.'),
  },
  execute: async (_args, ctx) => {
    const coreFns = await ctx.conn.execScalar<number>(
      `SELECT COUNT(*) AS n FROM FLEET_INTELLIGENCE.INFORMATION_SCHEMA.FUNCTIONS WHERE FUNCTION_SCHEMA = 'CORE'`,
    );
    const toolProcs = await ctx.conn.execScalar<number>(
      `SELECT COUNT(*) AS n FROM FLEET_INTELLIGENCE.INFORMATION_SCHEMA.PROCEDURES WHERE PROCEDURE_SCHEMA = 'ROUTING_AGENT' AND STARTSWITH(PROCEDURE_NAME, 'TOOL_')`,
    );
    let gateway = '[]';
    try {
      const g = await ctx.conn.execScalar<string>(
        `SELECT SYSTEM$GET_SERVICE_STATUS('OPENROUTESERVICE_APP.CORE.ROUTING_GATEWAY_SERVICE')`,
      );
      gateway = g == null ? '[]' : String(g);
    } catch {
      gateway = '[]';
    }
    const tools = Number(toolProcs ?? 0);
    return {
      ok: tools > 0,
      core_functions: Number(coreFns ?? 0),
      tool_procs: tools,
      gateway_status: gateway,
    };
  },
});
