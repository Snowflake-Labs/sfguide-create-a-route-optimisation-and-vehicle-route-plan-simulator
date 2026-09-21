import * as path from 'node:path';
import * as fs from 'node:fs';
import type { ResolvedSynapseAppConfig } from '../config.js';
import { installDir } from '../build/install.js';

/**
 * Shared `--account <name> | --install <path>` parsing across CLI subcommands.
 * Resolves to the `apps/_installed/<account>/<app>/` directory the subcommand
 * should operate on.
 */

export interface TargetFlags {
  account?: string;
  installPath?: string;
}

export function parseTargetFlags(argv: string[]): TargetFlags {
  const out: TargetFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--account' && i + 1 < argv.length) { out.account = argv[++i]!; }
    else if (a.startsWith('--account=')) { out.account = a.slice('--account='.length); }
    else if (a === '--install' && i + 1 < argv.length) { out.installPath = argv[++i]!; }
    else if (a.startsWith('--install=')) { out.installPath = a.slice('--install='.length); }
  }
  return out;
}

/**
 * Resolve the target install dir from --install or --account.
 * --install wins if both are provided (explicit path always overrides).
 */
export function resolveTargetDir(app: ResolvedSynapseAppConfig, flags: TargetFlags): string {
  if (flags.installPath) {
    const abs = path.resolve(flags.installPath);
    if (!fs.existsSync(path.join(abs, 'install.json'))) {
      console.error(`--install=${abs} but no install.json there`);
      process.exit(2);
    }
    return abs;
  }
  if (flags.account) {
    // Walk up from app root until we find apps/_installed -- the app may be
    // nested arbitrarily deep inside the workspace.
    let cur = app.appRoot;
    while (true) {
      const candidate = path.join(cur, 'apps', '_installed');
      if (fs.existsSync(candidate)) {
        return installDir(cur, flags.account, app.name);
      }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    console.error(`could not locate apps/_installed/ -- pass --install <path> instead`);
    process.exit(2);
  }
  console.error('one of --account <name> or --install <path> required');
  process.exit(2);
}
