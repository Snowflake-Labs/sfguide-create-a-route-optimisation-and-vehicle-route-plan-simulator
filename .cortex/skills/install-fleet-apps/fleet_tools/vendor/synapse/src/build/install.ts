import * as fs from 'node:fs';
import * as path from 'node:path';

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
   * Arbitrary install-time SET variables. Each key becomes a `SET <key> =
   * '<value>';` line in the install.sql preamble. Use for things that aren't
   * a Snowflake role — e.g. warehouse names (`task_warehouse`), service role
   * names referenced by ownership transfers (`service_role`), or any other
   * install-specific identifier that hand-written schema/grants SQL wants to
   * reference via `IDENTIFIER($<key>)`.
   *
   * Values are inlined as-is; the framework escapes single quotes.
   */
  variables?: Record<string, string>;
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
  /**
   * Subdirectory (relative to the materialize target) where the Claude Code
   * plugin content is emitted -- `.claude-plugin/`, `skills/`, and anything
   * copied from `apps/<app>/plugin/`. Defaults to `"."` (flat: plugin content
   * lives next to synapse artifacts). Set to `"plugin"` to nest the plugin
   * under a subdir, keeping install.sql / runtime.js / server.js / package.json
   * at the materialize root separate from what Claude Code loads.
   *
   * When set, the marketplace `source` for this app should point at
   * `<target>/<pluginPath>` (e.g. `./mtg-intelligence/plugin`), not the
   * materialize target itself.
   */
  pluginPath?: string;
  /** ISO timestamp of the most recent materialize run. Auto-set by materialize.ts. */
  materializedAt?: string;
  /** Source revision the install was materialized from (e.g. "git:abc123"). */
  materializedFrom?: string;
}

export function readInstallConfig(installDir: string): InstallConfig {
  const file = path.join(installDir, 'install.json');
  if (!fs.existsSync(file)) {
    throw new Error(`no install.json at ${file}`);
  }
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8')) as InstallConfig;
  for (const k of ['app', 'account', 'warehouse', 'database', 'schema', 'snowCliConn'] as const) {
    if (typeof cfg[k] !== 'string' || !cfg[k]) {
      throw new Error(`install.json at ${file}: missing or empty "${k}"`);
    }
  }
  if (!cfg.roles || typeof cfg.roles !== 'object') {
    throw new Error(`install.json at ${file}: missing "roles" object`);
  }
  if (cfg.runtime !== undefined && cfg.runtime !== 'sproc' && cfg.runtime !== 'local') {
    throw new Error(`install.json at ${file}: runtime must be 'sproc' or 'local', got ${JSON.stringify(cfg.runtime)}`);
  }
  return cfg;
}

/** Read the runtime, defaulting to 'sproc' when absent. */
export function installRuntime(cfg: InstallConfig): InstallRuntime {
  return cfg.runtime ?? 'sproc';
}

export function writeInstallConfig(installDir: string, cfg: InstallConfig): void {
  fs.mkdirSync(installDir, { recursive: true });
  const file = path.join(installDir, 'install.json');
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

/**
 * Resolve `apps/_installed/<account>/<app>/` from a workspace root.
 * Doesn't check for existence; callers that need that should test fs themselves.
 */
export function installDir(workspaceRoot: string, account: string, app: string): string {
  return path.join(workspaceRoot, 'apps', '_installed', account, app);
}
