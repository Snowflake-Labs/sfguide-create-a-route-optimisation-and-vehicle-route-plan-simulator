import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readInstallConfig, installRuntime } from '../build/install.js';
import { resolveTargetDir, parseTargetFlags } from './target.js';
/**
 * Run the app's e2e test suite against a materialized install. Resolves
 * --account / --install to an apps/_installed/<account>/<app>/ directory,
 * exports it as SYNAPSE_INSTALL, then execs vitest from the app root.
 *
 * The e2e target (sproc vs local) comes from install.json's `runtime` field
 * -- mode determines target, no --target flag.
 *
 *   synapse test:e2e --account snowhouse
 *   synapse test:e2e --install apps/_installed/snowhouse/param-rollout
 *
 * Any extra flags after `--` pass through to vitest:
 *   synapse test:e2e --account snowhouse -- --reporter=verbose
 */
export async function runTestE2e(app, argv) {
    const sepIdx = argv.indexOf('--');
    const ours = sepIdx >= 0 ? argv.slice(0, sepIdx) : argv;
    const passthrough = sepIdx >= 0 ? argv.slice(sepIdx + 1) : [];
    const flags = parseTargetFlags(ours);
    const targetDir = resolveTargetDir(app, flags);
    const cfg = readInstallConfig(targetDir);
    const runtime = installRuntime(cfg);
    const env = {
        ...process.env,
        SYNAPSE_INSTALL: targetDir,
        SYNAPSE_E2E_TARGET: runtime,
    };
    const args = ['exec', 'vitest', 'run', '--dir', 'tests/e2e', ...passthrough];
    console.log(`running e2e against ${path.relative(process.cwd(), targetDir)} (runtime=${runtime})`);
    const res = spawnSync('pnpm', args, {
        cwd: app.appRoot,
        stdio: 'inherit',
        env,
    });
    process.exit(res.status ?? 1);
}
//# sourceMappingURL=test-e2e.js.map