import type { ProcDef } from '../defineProc.js';
import type { InstallConfig } from './install.js';
export interface BuildMcpServerSqlOpts {
    /** Verbs to register as `GENERIC` / `procedure` tools. */
    procs: Array<ProcDef<string, unknown, unknown>>;
    /** Install config -- supplies database, schema, warehouse. */
    install: InstallConfig;
    /** App name. Used as the default server-name suffix. */
    app: string;
}
/**
 * Resolve the MCP server's object name. Defaults to `<app>_mcp` (with any
 * `-` in the app name replaced by `_`, since Snowflake unquoted identifiers
 * disallow hyphens) when `install.mcpServerName` is unset. Server lives in
 * the same db.schema as the procs (Snowflake binds it to the current schema
 * at CREATE time, which materialize.ts already sets via `USE SCHEMA`).
 */
export declare function resolveMcpServerName(opts: BuildMcpServerSqlOpts): string;
/**
 * Emit a single `CREATE OR REPLACE MCP SERVER ... FROM SPECIFICATION $$ ... $$;`
 * statement that registers every verb as a `GENERIC` / `procedure` tool.
 *
 * Called from `materialize` in sproc mode only -- after the proc DDL has been
 * appended to install.sql, before the grants block. Snowflake validates
 * tool identifiers at CREATE time, so the procs must already be in place.
 *
 * Spec shape mirrors the Snowflake docs example:
 * https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-agents-mcp
 */
export declare function buildMcpServerSql(opts: BuildMcpServerSqlOpts): string;
//# sourceMappingURL=mcp-server-sql.d.ts.map