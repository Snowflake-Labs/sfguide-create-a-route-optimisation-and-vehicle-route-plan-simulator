/**
 * The materialization config that lives at
 * `apps/_installed/<account>/<app>/install.json`. One per (account, app)
 * pair; uniquely determines a deployable install.sql.
 *
 * The materialize step reads it and writes install.sql alongside;
 * the deploy step reads it to know which warehouse/db/schema to USE
 * and which snow CLI connection to dispatch through.
 */
/**
 * Where the verbs run. Drives both grant generation and the e2e target.
 *
 *   - 'sproc':  procs are deployed as EXECUTE AS OWNER stored procedures;
 *               callers `CALL` them. install.sql includes proc DDL and
 *               GRANT USAGE ON PROCEDURE blocks. Caller roles need no
 *               direct DML on tables -- procs run as owner.
 *   - 'local':  procs run client-side (in the caller's Node process, e.g.
 *               a thick-client app). install.sql excludes proc DDL; instead
 *               it emits per-(role, table, access) GRANTs synthesized from
 *               each verb's `refs` declaration so caller roles can do the
 *               direct DML the procs would have done server-side.
 */
export type InstallRuntime = 'sproc' | 'local';
export interface InstallConfig {
    /** App name. Must match the directory name under apps/. */
    app: string;
    /** Snowflake account identifier. Used as the directory name under _installed/. */
    account: string;
    /**
     * Where the procs run. Determines which grants get emitted and which
     * e2e target `synapse test:e2e` runs. Defaults to 'sproc' if absent
     * (matches the slice-3 behavior for backward-compat).
     */
    runtime?: InstallRuntime;
    warehouse: string;
    database: string;
    schema: string;
    /** The `snow` CLI connection name passed to `snow sql -c`. */
    snowCliConn: string;
    /**
     * Logical-role -> actual-Snowflake-role mapping. Every logical role
     * referenced by a verb's `roles: [...]` or by a hand-written grants file
     * must have a binding here, or materialize emits a warning and the SET
     * line is omitted (deploy will then fail loudly on the unbound IDENTIFIER).
     */
    roles: Record<string, string>;
    /**
     * If true, materialize strips every GRANT statement from install.sql.
     * Useful when deploying to a schema where the deploying principal already
     * owns everything and per-role grants would be no-ops.
     */
    skipGrants?: boolean;
    /**
     * Name of the Snowflake-managed MCP SERVER object that materialize
     * registers in sproc mode (alongside the proc DDL). Defaults to
     * `<app>_mcp` if omitted. Ignored in local runtime.
     */
    mcpServerName?: string;
    /**
     * Snowflake account hostname used to build the MCP-server endpoint URL
     * (`https://<accountUrl>/api/v2/databases/.../schemas/.../mcp-servers/...`)
     * in the emitted .claude-plugin/plugin.json. Per Snowflake guidance, use
     * hyphens (e.g. `my-org-my-account.snowflakecomputing.com`), not the
     * underscore-bearing locator form. Required in sproc mode; ignored in
     * local runtime.
     */
    accountUrl?: string;
    /** ISO timestamp of the most recent materialize run. Auto-set by materialize.ts. */
    materializedAt?: string;
    /** Source revision the install was materialized from (e.g. "git:abc123"). */
    materializedFrom?: string;
}
export declare function readInstallConfig(installDir: string): InstallConfig;
/** Read the runtime, defaulting to 'sproc' when absent. */
export declare function installRuntime(cfg: InstallConfig): InstallRuntime;
export declare function writeInstallConfig(installDir: string, cfg: InstallConfig): void;
/**
 * Resolve `apps/_installed/<account>/<app>/` from a workspace root.
 * Doesn't check for existence; callers that need that should test fs themselves.
 */
export declare function installDir(workspaceRoot: string, account: string, app: string): string;
//# sourceMappingURL=install.d.ts.map