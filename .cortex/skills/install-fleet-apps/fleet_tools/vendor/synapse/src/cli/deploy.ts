import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ResolvedSynapseAppConfig } from '../config.js';
import { readInstallConfig } from '../build/install.js';
import { resolveTargetDir, parseTargetFlags } from './target.js';
import { runPublish } from './publish.js';

/**
 * Deploy a materialized install:
 *
 *   synapse deploy --account <name>
 *   synapse deploy --install <path>
 *   synapse deploy --account <name> --no-publish
 *   synapse deploy --account <name> --no-web
 *
 * Reads install.json + install.sql from the install dir and runs
 * `snow sql -c <snowCliConn> -f install.sql`. The materialize step has
 * already substituted role names and emitted the USE/SET preamble.
 *
 * After a successful SQL deploy, automatically:
 *   - Runs `synapse publish` to upload the plugin bundle to
 *     SYNAPSE.COCO.PLUGINS and refresh the shared Cortex Extension.
 *   - If `apps/<app>/web/snowflake.yml` exists, runs `snow app run` from
 *     that dir, resolves the deployed service endpoint via
 *     `snow app open --print-only`, and writes the URL back to the app's
 *     CONFIG table (row keyed on `app_url`).
 *
 * Flags:
 *   --no-publish  skip the Cortex Extension publish step.
 *   --no-web      skip the web-app deploy step.
 */
export async function runDeploy(app: ResolvedSynapseAppConfig, argv: string[]): Promise<void> {
  const noPublish = argv.includes('--no-publish');
  const noWeb = argv.includes('--no-web');
  // Strip our own flags before passing rest to target parsing / publish.
  const forwardArgv = argv.filter(a => a !== '--no-publish' && a !== '--no-web');
  const flags = parseTargetFlags(forwardArgv);
  const targetDir = resolveTargetDir(app, flags);
  const cfg = readInstallConfig(targetDir);
  const installSql = path.join(targetDir, 'install.sql');
  if (!fs.existsSync(installSql)) {
    console.error(`missing ${installSql} -- run \`synapse materialize\` first`);
    process.exit(2);
  }

  console.log(`deploying ${path.relative(process.cwd(), installSql)} to ${cfg.database}.${cfg.schema} via ${cfg.snowCliConn}`);
  // --enable-templating NONE: bundled proc bodies routinely contain characters
  // snow's default LEGACY/STANDARD template renderer chokes on (e.g. `&nbsp;` in
  // HTML strings, `&&` in JS). We have no need for client-side substitution —
  // the framework has already inlined every $-variable via SET at the top of
  // install.sql. Disabling templating is what "just run this SQL" means.
  const res = spawnSync('snow', [
    'sql',
    '-c', cfg.snowCliConn,
    '-f', installSql,
    '--enable-templating', 'NONE',
  ], {
    stdio: 'inherit',
  });
  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }

  if (!noPublish) {
    console.log('');
    await runPublish(app, forwardArgv);
  } else {
    console.log('skipping publish (--no-publish)');
  }

  if (!noWeb) {
    const webDir = path.join(app.appRoot, 'web');
    const webYml = path.join(webDir, 'snowflake.yml');
    if (fs.existsSync(webYml)) {
      console.log('');
      deployWebApp(webDir, cfg.snowCliConn, cfg.database, cfg.schema);
    }
  } else {
    console.log('skipping web deploy (--no-web)');
  }
}

/**
 * Deploy the `web/` snowflake-app, then write the resolved endpoint URL
 * back to the app's CONFIG table. Non-fatal on either failure -- the SQL
 * install has already succeeded, so we only warn (not exit) if the web
 * side has trouble; that lets a broken web build coexist with a working
 * proc surface.
 */
function deployWebApp(webDir: string, conn: string, database: string, schema: string): void {
  console.log(`deploying web app from ${path.relative(process.cwd(), webDir)} via ${conn}`);
  // `snow app deploy` for snowflake-app entities (upload -> build -> deploy).
  // `snow app run` is Native-App-only; different code path, would refuse
  // with "only available for Native App projects".
  const run = spawnSync('snow', ['app', 'deploy', '--connection', conn], {
    stdio: 'inherit',
    cwd: webDir,
  });
  if (run.status !== 0) {
    console.warn(`web-app deploy failed (exit ${run.status}); leaving CONFIG.app_url unchanged`);
    return;
  }

  const open = spawnSync('snow', ['app', 'open', '--print-only', '--connection', conn], {
    encoding: 'utf8',
    cwd: webDir,
  });
  if (open.status !== 0) {
    console.warn(`snow app open --print-only failed: ${open.stderr?.trim() ?? ''}`);
    return;
  }
  const url = extractFirstUrl(open.stdout ?? '');
  if (!url) {
    console.warn('snow app open printed no https:// URL; leaving CONFIG.app_url unchanged');
    return;
  }

  console.log(`setting ${database}.${schema}.CONFIG.app_url = ${url}`);
  const set = spawnSync('snow', [
    'sql', '-c', conn, '-q',
    `UPDATE ${database}.${schema}.CONFIG SET VALUE = '${url}', UPDATED_AT = CURRENT_TIMESTAMP() WHERE KEY = 'app_url'`,
    '--enable-templating', 'NONE',
  ], { stdio: 'inherit' });
  if (set.status !== 0) {
    console.warn('failed to update CONFIG.app_url; the app is deployed but the row wasn\'t written');
  }
}

/** Grab the first https:// URL out of a snow-cli output string. */
function extractFirstUrl(s: string): string | null {
  const m = /https:\/\/\S+/.exec(s);
  return m ? m[0] : null;
}
