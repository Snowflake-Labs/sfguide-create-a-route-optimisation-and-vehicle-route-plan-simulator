import type { ResolvedSynapseAppConfig } from '../config.js';
import type { ProcDef } from '../defineProc.js';
import type { InstallConfig } from './install.js';
export interface BundlePluginOpts {
    /** App config. */
    app: ResolvedSynapseAppConfig;
    /** install.json (drives plugin name + description). */
    install: InstallConfig;
    /** Discovered verb registry (procs + paths from discoverProcs). */
    procs: Record<string, ProcDef<string, unknown, unknown>>;
    /** Where the materialized plugin tree should land (typically <targetDir>/plugin). */
    out: string;
}
/**
 * Emit a Claude plugin into the install dir alongside install.sql + runtime.js.
 *
 * Both runtimes use the same stdio MCP plugin shape -- Claude Code spawns
 * server.js, which loads the sibling runtime.js. The two runtimes differ
 * only in what runtime.js does internally:
 *   sproc -> issues `CALL <verb>(...)` against the deployed sprocs.
 *   local -> runs the verb in-process via direct DML.
 *
 * In sproc mode there's also a Snowflake-managed MCP server registered
 * by install.sql (CREATE MCP SERVER ...). It's exposed for non-Claude-Code
 * clients (Cortex Agents, third-party agents over OAuth); plugin.json
 * deliberately does NOT point at it -- the local stdio path avoids the
 * per-call OAuth bearer dance.
 *
 * Layout:
 *   <install-dir>/.claude-plugin/plugin.json    (declares the stdio MCP server)
 *   <install-dir>/server.js                     (the MCP stdio server)
 *   <install-dir>/runtime.js                    (verb runtime, written by bundleRuntime)
 */
export declare function bundlePlugin(opts: BundlePluginOpts): Promise<void>;
//# sourceMappingURL=plugin.d.ts.map