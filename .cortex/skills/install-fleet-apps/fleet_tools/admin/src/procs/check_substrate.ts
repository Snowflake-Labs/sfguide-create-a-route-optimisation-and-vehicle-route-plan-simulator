import { defineProc, t } from '@snowflake/synapse';

// The routing service functions live in OPENROUTESERVICE_APP.CORE (the engine
// database), NOT in FLEET_INTELLIGENCE.CORE. An earlier version counted
// FLEET_INTELLIGENCE.CORE, which holds only procedures/tables, so it always
// reported 0 CORE functions on a perfectly healthy install and the agent told
// users to re-run the installer. `ok` now reflects BOTH counts (it previously
// ignored core_functions, producing the contradictory "ok but 0 functions"
// response the agent then tried to reconcile in prose), and `notes` gives the
// agent an authored sentence to quote instead of improvising a diagnosis.
export const check_substrate = defineProc({
  name: 'check_substrate',
  description:
    'Verify the routing substrate is present: counts the ORS engine CORE routing ' +
    'functions (OPENROUTESERVICE_APP.CORE), the ROUTING_TOOLS TOOL_* procedures the ' +
    'User bundle wraps, the provisioned routing regions, and the analytic semantic ' +
    'views. Returns a ready-to-quote notes summary. Read-only. Admin-only.',
  roles: ['admin'],
  args: {},
  returns: {
    ok: t.boolean().describe('True only when BOTH the CORE routing functions and the TOOL_* procedures are present.'),
    core_functions: t
      .number()
      .describe('Count of routing functions in OPENROUTESERVICE_APP.CORE (the engine database).'),
    tool_procs: t.number().describe('Count of TOOL_* procedures in FLEET_INTELLIGENCE.ROUTING_TOOLS.'),
    provisioned_regions: t.number().describe('Count of provisioned routing regions in the region map.'),
    semantic_views: t.number().describe('Count of Cortex Analyst semantic views in FLEET_INTELLIGENCE.SEMANTIC.'),
    notes: t
      .string()
      .describe('One-line human summary of substrate state. Quote this verbatim rather than inferring a diagnosis.'),
  },
  execute: async (_args, ctx) => {
    const num = async (sql: string): Promise<number> => {
      try {
        const v = await ctx.conn.execScalar<number>(sql);
        return Number(v ?? 0);
      } catch {
        // A missing database/schema means the component is absent, which is a
        // count of 0 - not a verb failure. Reporting 0 keeps the diagnosis in
        // `notes` instead of surfacing a raw SQL error to the agent.
        return 0;
      }
    };

    const core = await num(
      `SELECT COUNT(*) AS n FROM OPENROUTESERVICE_APP.INFORMATION_SCHEMA.FUNCTIONS WHERE FUNCTION_SCHEMA = 'CORE'`,
    );
    const tools = await num(
      `SELECT COUNT(*) AS n FROM FLEET_INTELLIGENCE.INFORMATION_SCHEMA.PROCEDURES WHERE PROCEDURE_SCHEMA = 'ROUTING_TOOLS' AND STARTSWITH(PROCEDURE_NAME, 'TOOL_')`,
    );
    const regions = await num(`SELECT COUNT(*) AS n FROM OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP`);
    // Semantic views are NOT in INFORMATION_SCHEMA.VIEWS - they have their own
    // INFORMATION_SCHEMA.SEMANTIC_VIEWS (columns CATALOG/SCHEMA/NAME). Counting
    // VIEWS returned 0 on a full 8-SV install, the same class of confidently
    // wrong zero this verb exists to stop reporting.
    const svs = await num(
      `SELECT COUNT(*) AS n FROM FLEET_INTELLIGENCE.INFORMATION_SCHEMA.SEMANTIC_VIEWS WHERE "SCHEMA" = 'SEMANTIC'`,
    );

    const ok = core > 0 && tools > 0;
    const missing: string[] = [];
    if (core === 0) missing.push('OPENROUTESERVICE_APP.CORE routing functions');
    if (tools === 0) missing.push('FLEET_INTELLIGENCE.ROUTING_TOOLS TOOL_* procedures');
    const notes = ok
      ? `Routing substrate is installed: ${core} CORE routing functions, ${tools} TOOL_* procedures, ` +
        `${regions} provisioned region(s), ${svs} semantic view(s). No installer action needed.`
      : `Routing substrate is INCOMPLETE - missing: ${missing.join(' and ')}. Re-run the installer.`;

    return {
      ok,
      core_functions: core,
      tool_procs: tools,
      provisioned_regions: regions,
      semantic_views: svs,
      notes,
    };
  },
});
