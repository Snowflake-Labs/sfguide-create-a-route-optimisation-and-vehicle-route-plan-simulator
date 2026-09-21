#!/usr/bin/env node
import { register } from 'tsx/esm/api';
import { findAppConfig, loadAppConfig } from '../config.js';
import { runMaterialize } from './materialize.js';
import { runDeploy } from './deploy.js';
import { runPublish } from './publish.js';
import { runInstallList } from './install-list.js';
import { runInstallDiff } from './install-diff.js';
import { runTestE2e } from './test-e2e.js';

// Register tsx as the loader for any .ts/.mts/.cts file imported during this
// CLI run. The config file itself uses TS, and so do all the proc modules
// that `discoverProcs` will dynamic-import. One register() call covers both.
register();

/**
 * `synapse` CLI entry. Subcommands resolve the app's synapse.config.{ts,js}
 * by walking up from cwd unless `--config <path>` is given.
 *
 * Usage:
 *   synapse materialize --account <name>
 *   synapse deploy --account <name>
 *   synapse install:list
 *   synapse install:diff --account <name>
 */

interface CommonFlags { config?: string }

function parseCommon(argv: string[]): { rest: string[]; flags: CommonFlags } {
  const rest: string[] = [];
  const flags: CommonFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--config' && i + 1 < argv.length) { flags.config = argv[++i]!; }
    else if (a.startsWith('--config=')) { flags.config = a.slice('--config='.length); }
    else rest.push(a);
  }
  return { rest, flags };
}

async function main() {
  const argv = process.argv.slice(2);
  const subcommand = argv.shift();
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    printHelp();
    process.exit(subcommand ? 0 : 2);
  }

  const { rest, flags } = parseCommon(argv);

  const configPath = flags.config ? flags.config : findAppConfig();
  if (!configPath) {
    console.error('no synapse.config.{ts,js,mjs} found in cwd or any parent. Pass --config <path>.');
    process.exit(2);
  }
  const app = await loadAppConfig(configPath);

  switch (subcommand) {
    case 'materialize':       return runMaterialize(app, rest);
    case 'deploy':            return runDeploy(app, rest);
    case 'publish':           return runPublish(app, rest);
    case 'install:list':      return runInstallList(app, rest);
    case 'install:diff':      return runInstallDiff(app, rest);
    case 'test:e2e':          return runTestE2e(app, rest);
    default:
      console.error(`unknown subcommand: ${subcommand}`);
      printHelp();
      process.exit(2);
  }
}

function printHelp() {
  console.error(`Usage: synapse <subcommand> [options]

Subcommands:
  materialize --account <name> | --install <path>
      Emit install.sql to apps/_installed/<account>/<app>/.
  deploy --account <name> | --install <path> [--no-publish] [--no-web]
      Run snow sql -f against the materialized install.sql, then publish
      the plugin as a shared Cortex Extension, then deploy the web app
      (if apps/<app>/web/snowflake.yml exists) via 'snow app run' and
      write the resolved endpoint back to CONFIG.app_url. Pass
      --no-publish or --no-web to skip either follow-on step.
  publish --account <name> | --install <path>
      Upload the materialized plugin to the SYNAPSE.COCO.PLUGINS workspace
      and publish it as a shared Cortex Extension (SYNAPSE.COCO.EXT_<APP>).
  install:list
      List every materialized install of this app.
  install:diff --account <name> | --install <path>
      Diff on-disk install.sql against current source.
  test:e2e --account <name> [--target local|sproc] [-- <vitest args>]
      Run the app's tests/e2e suite against a materialized install.

Common options:
  --config <path>     Path to synapse.config.{ts,js,mjs}. Defaults to walking
                      up from cwd until found.
`);
}

await main();
