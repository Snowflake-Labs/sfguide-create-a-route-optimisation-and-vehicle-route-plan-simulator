import type { ProcDef } from '../defineProc.js';
import type { InstallConfig } from './install.js';
export interface BundleMcpServerOpts {
    /** Verb name -> ProcDef. Source paths aren't needed here -- we import the
     *  pre-bundled runtime.js sibling at server load time. */
    procs: Record<string, ProcDef<string, unknown, unknown>>;
    /** install.json (drives plugin/server identity). */
    install: InstallConfig;
    /** Where the materialized server.cjs should land. */
    out: string;
    /** App root -- the entry needs to resolve @modelcontextprotocol/sdk from
     *  somewhere with node_modules. */
    appRoot: string;
}
/**
 * Emit a self-contained MCP stdio server alongside runtime.js. The server
 * registers one tool per verb with a JSON-Schema-typed inputSchema; the
 * handler delegates to the sibling runtime.js which manages the singleton
 * Snowflake connection.
 */
export declare function bundleMcpServer(opts: BundleMcpServerOpts): Promise<void>;
//# sourceMappingURL=mcp-server.d.ts.map