import { defineProc, t } from '@snowflake/synapse';

// NOTE: the routing service functions live in OPENROUTESERVICE_APP.CORE (the
// engine database), NOT FLEET_INTELLIGENCE.CORE. Counting the latter always
// returned 0 on a healthy install - see check_substrate for the same fix.
export const healthcheck = defineProc({
  name: 'healthcheck',
  description:
    'Summarize routing-substrate health: counts the ORS engine CORE routing functions ' +
    '(OPENROUTESERVICE_APP.CORE) and the ROUTING_TOOLS TOOL_* procedures, and reports ' +
    'the routing gateway service status. Ops-only.',
  roles: ['ops'],
  args: {},
  returns: {
    ok: t.boolean().describe('True when BOTH the CORE routing functions and the TOOL_* procedures are present.'),
    core_functions: t.number().describe('Count of routing functions in OPENROUTESERVICE_APP.CORE.'),
    tool_procs: t.number().describe('Count of TOOL_* procedures in FLEET_INTELLIGENCE.ROUTING_TOOLS.'),
    gateway_status: t.string().describe('SYSTEM$GET_SERVICE_STATUS for the routing gateway.'),
  },
  execute: async (_args, ctx) => {
    const coreFns = await ctx.conn.execScalar<number>(
      `SELECT COUNT(*) AS n FROM OPENROUTESERVICE_APP.INFORMATION_SCHEMA.FUNCTIONS WHERE FUNCTION_SCHEMA = 'CORE'`,
    );
    const toolProcs = await ctx.conn.execScalar<number>(
      `SELECT COUNT(*) AS n FROM FLEET_INTELLIGENCE.INFORMATION_SCHEMA.PROCEDURES WHERE PROCEDURE_SCHEMA = 'ROUTING_TOOLS' AND STARTSWITH(PROCEDURE_NAME, 'TOOL_')`,
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
    const core = Number(coreFns ?? 0);
    return {
      ok: core > 0 && tools > 0,
      core_functions: core,
      tool_procs: tools,
      gateway_status: gateway,
    };
  },
});
