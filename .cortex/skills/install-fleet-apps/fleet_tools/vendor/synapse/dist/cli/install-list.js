import * as fs from 'node:fs';
import * as path from 'node:path';
import { readInstallConfig } from '../build/install.js';
/**
 * List every materialized install of this app under apps/_installed/.
 *
 *   synapse install:list
 */
export async function runInstallList(app, _argv) {
    // Walk up from app root to find apps/_installed.
    let workspaceRoot = app.appRoot;
    while (true) {
        if (fs.existsSync(path.join(workspaceRoot, 'apps', '_installed')))
            break;
        const parent = path.dirname(workspaceRoot);
        if (parent === workspaceRoot) {
            console.log('(no apps/_installed/ found above app root)');
            return;
        }
        workspaceRoot = parent;
    }
    const installedRoot = path.join(workspaceRoot, 'apps', '_installed');
    const accounts = fs.readdirSync(installedRoot)
        .filter(name => fs.statSync(path.join(installedRoot, name)).isDirectory())
        .sort();
    const installs = [];
    for (const account of accounts) {
        const dir = path.join(installedRoot, account, app.name);
        if (!fs.existsSync(path.join(dir, 'install.json')))
            continue;
        installs.push({ account, dir, cfg: readInstallConfig(dir) });
    }
    if (installs.length === 0) {
        console.log(`(no ${app.name} installs)`);
        return;
    }
    for (const i of installs) {
        console.log(`${i.account}/${app.name}`);
        console.log(`  target:        ${i.cfg.database}.${i.cfg.schema} via ${i.cfg.snowCliConn} (${i.cfg.warehouse})`);
        const roles = Object.entries(i.cfg.roles).map(([k, v]) => `${k}=${v}`).join(', ');
        console.log(`  roles:         ${roles}`);
        console.log(`  materialized:  ${i.cfg.materializedAt ?? '(never)'} ${i.cfg.materializedFrom ?? ''}`);
        console.log(`  install.sql:   ${fs.existsSync(path.join(i.dir, 'install.sql')) ? 'present' : 'MISSING'}`);
    }
}
//# sourceMappingURL=install-list.js.map