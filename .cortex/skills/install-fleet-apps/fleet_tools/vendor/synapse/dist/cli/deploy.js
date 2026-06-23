import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readInstallConfig } from '../build/install.js';
import { resolveTargetDir, parseTargetFlags } from './target.js';
/**
 * Deploy a materialized install:
 *
 *   synapse deploy --account <name>
 *   synapse deploy --install <path>
 *
 * Reads install.json + install.sql from the install dir and runs
 * `snow sql -c <snowCliConn> -f install.sql`. The materialize step has
 * already substituted role names and emitted the USE/SET preamble.
 */
export async function runDeploy(app, argv) {
    const flags = parseTargetFlags(argv);
    const targetDir = resolveTargetDir(app, flags);
    const cfg = readInstallConfig(targetDir);
    const installSql = path.join(targetDir, 'install.sql');
    if (!fs.existsSync(installSql)) {
        console.error(`missing ${installSql} -- run \`synapse materialize\` first`);
        process.exit(2);
    }
    console.log(`deploying ${path.relative(process.cwd(), installSql)} to ${cfg.database}.${cfg.schema} via ${cfg.snowCliConn}`);
    const res = spawnSync('snow', ['sql', '-c', cfg.snowCliConn, '-f', installSql], {
        stdio: 'inherit',
    });
    process.exit(res.status ?? 1);
}
//# sourceMappingURL=deploy.js.map