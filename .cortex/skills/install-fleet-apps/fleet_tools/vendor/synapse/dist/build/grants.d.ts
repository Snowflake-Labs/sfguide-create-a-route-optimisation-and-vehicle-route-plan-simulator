import type { ProcDef } from '../defineProc.js';
export interface BuildGrantsOpts {
    /**
     * Procs to emit grants for. Each proc's `roles` field decides which logical
     * roles get `GRANT USAGE ON PROCEDURE`. Procs with no `roles` are skipped.
     */
    procs: Array<ProcDef<string, unknown, unknown>>;
    /** Output file path. Parent dirs are created if missing. */
    out: string;
    /**
     * How to render a logical role as a target. Default appends `_role` and
     * wraps in `IDENTIFIER($...)`, so logical role `admin` -> `ROLE
     * IDENTIFIER($admin_role)`. Operators set `$admin_role` ahead of running
     * install.sql to point at their actual Snowflake role.
     */
    roleTarget?: (logicalRole: string) => string;
    /**
     * SQL block to prepend (e.g. `SET admin_role = 'PARAM_ROLLOUT_ADMIN';`).
     * Lets the build-script wire in default mappings without forcing operators
     * to set them by hand.
     */
    preamble?: string;
    /**
     * If set, emit `GRANT USAGE ON MCP SERVER <name>` for every role that has
     * at least one proc grant. Required so non-admin roles can connect to the
     * Snowflake-managed MCP server registered alongside the procs in sproc
     * mode. Per-tool RBAC is still enforced by the proc-level GRANTs above.
     */
    mcpServerName?: string;
}
/**
 * Generate per-role `GRANT USAGE ON PROCEDURE` blocks from a registry. Output
 * is grouped by logical role for legibility; each block lists procs sorted by
 * name. Roles map to actual Snowflake roles via `IDENTIFIER($<role>_role)` —
 * operators set those vars before running install.sql.
 */
export declare function buildGrants(opts: BuildGrantsOpts): Promise<void>;
//# sourceMappingURL=grants.d.ts.map