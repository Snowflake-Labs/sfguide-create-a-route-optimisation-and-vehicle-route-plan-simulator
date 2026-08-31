import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ResolvedSynapseAppConfig } from '../config.js';
import { readInstallConfig } from '../build/install.js';
import { resolveTargetDir, parseTargetFlags } from './target.js';

/**
 * Publish a materialized plugin as a shared Cortex Extension.
 *
 *   synapse publish --account <name>
 *   synapse publish --install <path>
 *
 * Two-stage sequence:
 *   1. PUT every file in the plugin dir into the shared workspace at
 *      `snow://workspace/SYNAPSE.COCO.PLUGINS/versions/live/<app>/...`.
 *   2. CREATE/ALTER a Cortex Extension `SYNAPSE.COCO.EXT_<APP>` and COPY FILES
 *      from the workspace subdir into `snow://cortex_extension/<fqn>/versions/live/`.
 *   3. COMMIT, GRANT READ TO PUBLIC, SET DISCOVERABLE.
 *
 * Uses the app's `snowCliConn` for all snow sql calls -- the connection must
 * have write access to `SYNAPSE.COCO.PLUGINS` and CREATE CORTEX EXTENSION
 * privileges on `SYNAPSE.COCO`.
 *
 * Idempotent: reruns replace the live version's files (REMOVE + PUT + COPY)
 * so the published extension is always an exact mirror of what's on disk.
 */
export async function runPublish(app: ResolvedSynapseAppConfig, argv: string[]): Promise<void> {
  const flags = parseTargetFlags(argv);
  const targetDir = resolveTargetDir(app, flags);
  const cfg = readInstallConfig(targetDir);

  const pluginPath = cfg.pluginPath ?? '.';
  const pluginRoot = path.join(targetDir, pluginPath);
  if (!fs.existsSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'))) {
    console.error(`missing .claude-plugin/plugin.json under ${pluginRoot} — run \`synapse materialize\` first`);
    process.exit(2);
  }

  const appName = cfg.app;
  const appIdent = appName.replace(/-/g, '_').toUpperCase();
  const wsSchema = 'SYNAPSE.COCO';
  const wsName = 'PLUGINS';
  const wsPath = `snow://workspace/${wsSchema}.${wsName}/versions/live/${appName}`;
  const extFqn = `${wsSchema}.EXT_${appIdent}`;
  const extPath = `snow://cortex_extension/${extFqn}/versions/live`;
  const syncTag = `SYNC_${Date.now()}`;

  // Enumerate every file under pluginRoot, sorted for deterministic order.
  // Skip node_modules and dotfiles (except `.claude-plugin/` which we want).
  const files = collectFiles(pluginRoot);
  if (files.length === 0) {
    console.error(`no files to publish under ${pluginRoot}`);
    process.exit(2);
  }

  // Read description from the plugin manifest so the extension COMMENT matches.
  const manifest = JSON.parse(
    fs.readFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8'),
  ) as { description?: string };
  const description = manifest.description ?? `${appName} — published from ${cfg.account}`;

  console.log(`publishing ${appName} (${files.length} files) via ${cfg.snowCliConn}`);
  console.log(`  workspace: ${wsPath}`);
  console.log(`  extension: ${extFqn} (${syncTag})`);

  // Stage 1: PUT files into the workspace. Serial (as snowtasks' publish-ce
  // does) -- snow doesn't parallelize PUT the way `snow stage copy` does, and
  // per-file ordering is fine at this scale (~30 files per app).
  const putStmts: string[] = [];
  for (const rel of files) {
    const localAbs = path.join(pluginRoot, rel);
    const wsFileDir = `${wsPath}/${path.posix.dirname(rel)}`;
    putStmts.push(
      `PUT 'file://${sqlLit(localAbs)}' '${wsFileDir === `${wsPath}/.` ? wsPath : wsFileDir}/' AUTO_COMPRESS = FALSE OVERWRITE = TRUE;`,
    );
  }

  // Stage 2: create/alter extension, open a live version, clear inherited
  // files, COPY FILES per file from the workspace subdir, commit.
  const copyStmts: string[] = [];
  for (const rel of files) {
    const relDir = path.posix.dirname(rel);
    const fileName = path.posix.basename(rel);
    const wsFileDir = relDir === '.' ? wsPath : `${wsPath}/${relDir}`;
    const extFileDir = relDir === '.' ? extPath : `${extPath}/${relDir}`;
    copyStmts.push(
      `COPY FILES INTO '${extFileDir}/' FROM '${wsFileDir}/' FILES = ('${sqlLit(fileName)}');`,
    );
  }

  const descLit = sqlLit(description);
  const sql = [
    // Stage the workspace bytes first.
    ...putStmts,
    // Create/replace the extension shell.
    `CREATE CORTEX EXTENSION IF NOT EXISTS ${extFqn} TYPE = 'PLUGIN' COMMENT = '${descLit}';`,
    `ALTER CORTEX EXTENSION ${extFqn} SET COMMENT = '${descLit}';`,
    `ALTER CORTEX EXTENSION ${extFqn} ADD LIVE VERSION ${syncTag} FROM LAST;`,
    // Purge inherited files so the version is an exact mirror of what we copy below.
    `REMOVE '${extPath}/';`,
    ...copyStmts,
    `ALTER CORTEX EXTENSION ${extFqn} COMMIT;`,
    `GRANT READ ON CORTEX EXTENSION ${extFqn} TO ROLE PUBLIC;`,
    `ALTER CORTEX EXTENSION ${extFqn} SET DISCOVERABLE = TRUE;`,
  ].join('\n');

  // Write to a tempfile and run in one snow sql session so ADD LIVE VERSION +
  // COPY FILES + COMMIT all share the same sync window. If any statement in
  // the sync window fails, ABORT so the pending version doesn't linger.
  const sqlFile = path.join(targetDir, `.synapse-publish-${syncTag}.sql`);
  fs.writeFileSync(sqlFile, sql, 'utf8');
  try {
    const res = spawnSync('snow', [
      'sql',
      '-c', cfg.snowCliConn,
      '-f', sqlFile,
      '--enable-templating', 'NONE',
    ], { stdio: 'inherit' });
    if (res.status !== 0) {
      console.error(`publish failed — aborting pending version ${syncTag}`);
      spawnSync('snow', [
        'sql', '-c', cfg.snowCliConn,
        '-q', `ALTER CORTEX EXTENSION ${extFqn} ABORT`,
        '--enable-templating', 'NONE',
      ], { stdio: 'inherit' });
      process.exit(res.status ?? 1);
    }
  } finally {
    try { fs.unlinkSync(sqlFile); } catch { /* ignore */ }
  }

  // The `live` alias only resolves once someone points an alias at a
  // committed version explicitly (which is a manual step on the consumer/
  // publisher side and outside this CLI's scope). The `last` alias always
  // resolves to the newest committed version, so that's the URL consumers
  // should read from immediately after publish.
  const readPath = `snow://cortex_extension/${extFqn}/versions/last`;
  console.log(`published ${extFqn}`);
  console.log(`  share URI: ${readPath}/`);
}

function collectFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, relPrefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      // Skip node_modules; include .claude-plugin (dot-prefixed but load-bearing).
      if (entry.name === 'node_modules') continue;
      if (entry.name.startsWith('.') && entry.name !== '.claude-plugin') continue;
      const abs = path.join(dir, entry.name);
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  walk(root, '');
  return out.sort();
}

/** Escape a value for a single-quoted SQL literal. */
function sqlLit(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "''");
}
