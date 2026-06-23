import * as fs from 'node:fs';
import * as path from 'node:path';
export function readInstallConfig(installDir) {
    const file = path.join(installDir, 'install.json');
    if (!fs.existsSync(file)) {
        throw new Error(`no install.json at ${file}`);
    }
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const k of ['app', 'account', 'warehouse', 'database', 'schema', 'snowCliConn']) {
        if (typeof cfg[k] !== 'string' || !cfg[k]) {
            throw new Error(`install.json at ${file}: missing or empty "${k}"`);
        }
    }
    if (!cfg.roles || typeof cfg.roles !== 'object') {
        throw new Error(`install.json at ${file}: missing "roles" object`);
    }
    if (cfg.runtime !== undefined && cfg.runtime !== 'sproc' && cfg.runtime !== 'local') {
        throw new Error(`install.json at ${file}: runtime must be 'sproc' or 'local', got ${JSON.stringify(cfg.runtime)}`);
    }
    return cfg;
}
/** Read the runtime, defaulting to 'sproc' when absent. */
export function installRuntime(cfg) {
    return cfg.runtime ?? 'sproc';
}
export function writeInstallConfig(installDir, cfg) {
    fs.mkdirSync(installDir, { recursive: true });
    const file = path.join(installDir, 'install.json');
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}
/**
 * Resolve `apps/_installed/<account>/<app>/` from a workspace root.
 * Doesn't check for existence; callers that need that should test fs themselves.
 */
export function installDir(workspaceRoot, account, app) {
    return path.join(workspaceRoot, 'apps', '_installed', account, app);
}
//# sourceMappingURL=install.js.map