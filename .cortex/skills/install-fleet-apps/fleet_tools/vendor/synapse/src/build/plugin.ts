import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ResolvedSynapseAppConfig } from '../config.js';
import type { ProcDef } from '../defineProc.js';
import type { InstallConfig } from './install.js';
import { bundleMcpServer } from './mcp-server.js';

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
 * App-authored overrides: anything under `apps/<app>/plugin/` is copied
 * verbatim into the emitted plugin dir (`extraFiles`). If the source tree
 * contains `plugin/.claude-plugin/plugin.json`, its keys shallow-merge on
 * top of the framework defaults -- letting an app override `mcpServers`,
 * `description`, etc. without having to restate `name` or `version`.
 *
 * Layout:
 *   <install-dir>/.claude-plugin/plugin.json    (declares the stdio MCP server)
 *   <install-dir>/server.js                     (the MCP stdio server)
 *   <install-dir>/runtime.js                    (verb runtime, written by bundleRuntime)
 *   <install-dir>/skills/                       (copied from apps/<app>/skills/ if present)
 *   <install-dir>/**                            (any extra files from apps/<app>/plugin/)
 */
export async function bundlePlugin(opts: BundlePluginOpts): Promise<void> {
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

  // Framework defaults for plugin.json. Any keys the app supplies at
  // apps/<app>/plugin/.claude-plugin/plugin.json shallow-override these.
  const defaults: Record<string, unknown> = {
    name: pluginName,
    version,
    description: `${install.app} verbs as MCP tools, materialized for ${install.account} (${install.database}.${install.schema}).`,
    mcpServers: {
      mcp: {
        command: 'node',
        args: ['${CLAUDE_PLUGIN_ROOT}/server.js'],
      },
    },
  };
  const override = readPluginJsonOverride(app.appRoot);
  const merged = override ? { ...defaults, ...override } : defaults;

  fs.writeFileSync(
    path.join(pluginJsonDir, 'plugin.json'),
    JSON.stringify(merged, null, 2) + '\n',
    'utf8',
  );

  await bundleMcpServer({
    procs,
    install,
    out: path.join(out, 'server.js'),
    appRoot: app.appRoot,
  });

  // Copy hand-authored skills from apps/<app>/skills/ into the emitted plugin
  // dir. Each skill lives at apps/<app>/skills/<name>/SKILL.md — Claude Code
  // discovers them alongside plugin.json.
  copySkills(path.join(app.appRoot, 'skills'), path.join(out, 'skills'));

  // Copy anything under apps/<app>/plugin/ verbatim, EXCEPT the plugin.json
  // override (already merged above). This lets an app ship arbitrary helper
  // files -- proxy scripts, README, etc. -- alongside skills.
  copyExtraFiles(path.join(app.appRoot, 'plugin'), out);
}

function readPluginJsonOverride(appRoot: string): Record<string, unknown> | null {
  const p = path.join(appRoot, 'plugin', '.claude-plugin', 'plugin.json');
  if (!fs.existsSync(p)) return null;
  const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${p}: expected a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function copyExtraFiles(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  const walk = (from: string, to: string): void => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      // Skip .claude-plugin -- plugin.json is handled via the merge above.
      if (entry.name === '.claude-plugin') continue;
      const s = path.join(from, entry.name);
      const d = path.join(to, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(d, { recursive: true });
        walk(s, d);
      } else if (entry.isFile()) {
        fs.copyFileSync(s, d);
        // Preserve executable bit so shell scripts / .mjs entry points keep +x.
        const mode = fs.statSync(s).mode;
        if (mode & 0o111) fs.chmodSync(d, mode);
      }
    }
  };
  walk(src, dest);
}

function copySkills(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  // Recursive copy of directory contents, files only (skip node_modules-y noise).
  const walk = (from: string, to: string): void => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const s = path.join(from, entry.name);
      const d = path.join(to, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(d, { recursive: true });
        walk(s, d);
      } else if (entry.isFile()) {
        fs.copyFileSync(s, d);
      }
    }
  };
  walk(src, dest);
}
