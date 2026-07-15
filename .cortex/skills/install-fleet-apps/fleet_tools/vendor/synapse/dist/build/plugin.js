import * as fs from 'node:fs';
import * as path from 'node:path';
import { bundleMcpServer } from './mcp-server.js';
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
export async function bundlePlugin(opts) {
    const { app, install, procs, out } = opts;
    // Plugin name is just the app -- the per-account marketplace gives the
    // namespacing (e.g. `param-rollout@snowhouse-remote`). Including the
    // account in the plugin name doubles up and pushes Claude Code's
    // namespaced tool names past the 64-char limit.
    const pluginName = install.app;
    const version = install.materializedFrom?.replace(/^git:/, '').slice(0, 12) ?? '0.0.0';
    fs.mkdirSync(out, { recursive: true });
    const pluginJsonDir = path.join(out, '.claude-plugin');
    fs.mkdirSync(pluginJsonDir, { recursive: true });
    fs.writeFileSync(path.join(pluginJsonDir, 'plugin.json'), JSON.stringify({
        name: pluginName,
        version,
        description: `${install.app} verbs as MCP tools, materialized for ${install.account} (${install.database}.${install.schema}).`,
        mcpServers: {
            mcp: {
                command: 'node',
                args: ['${CLAUDE_PLUGIN_ROOT}/server.js'],
            },
        },
    }, null, 2) + '\n', 'utf8');
    await bundleMcpServer({
        procs,
        install,
        out: path.join(out, 'server.js'),
        appRoot: app.appRoot,
    });
}
//# sourceMappingURL=plugin.js.map