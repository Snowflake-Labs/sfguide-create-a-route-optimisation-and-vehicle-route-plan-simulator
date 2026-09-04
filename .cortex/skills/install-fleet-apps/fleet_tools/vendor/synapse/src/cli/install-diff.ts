import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ResolvedSynapseAppConfig } from '../config.js';
import { readInstallConfig } from '../build/install.js';
import { resolveTargetDir, parseTargetFlags } from './target.js';
import { runMaterialize } from './materialize.js';

/**
 * Diff the on-disk install.sql against what would be emitted from current source.
 *
 *   synapse install:diff --account <name>
 *   synapse install:diff --install <path>
 *
 * Re-runs materialize into a temp dir (does NOT touch the real install.json),
 * then runs `diff -u`. Exits 0 if identical, 1 if different, 2 on error.
 */
export async function runInstallDiff(app: ResolvedSynapseAppConfig, argv: string[]): Promise<void> {
  const flags = parseTargetFlags(argv);
  const targetDir = resolveTargetDir(app, flags);
  const cfg = readInstallConfig(targetDir);
  const onDiskSql = path.join(targetDir, 'install.sql');
  if (!fs.existsSync(onDiskSql)) {
    console.error(`no install.sql at ${onDiskSql} -- run materialize first`);
    process.exit(2);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-diff-'));
  try {
    fs.writeFileSync(path.join(tmp, 'install.json'), JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    // Silence materialize's log output; we only care about the diff.
    const origLog = console.log;
    console.log = () => {};
    try {
      await runMaterialize(app, ['--install', tmp]);
    } finally {
      console.log = origLog;
    }

    const tmpSql = path.join(tmp, 'install.sql');
    const diffRes = spawnSync('diff', ['-u', onDiskSql, tmpSql], { stdio: 'inherit' });
    process.exit(diffRes.status ?? 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
