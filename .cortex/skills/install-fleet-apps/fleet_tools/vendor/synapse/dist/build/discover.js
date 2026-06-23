import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
function isProcDef(v) {
    if (v === null || typeof v !== 'object')
        return false;
    const o = v;
    return typeof o['name'] === 'string'
        && typeof o['args'] === 'object' && o['args'] !== null
        && typeof o['returns'] === 'object' && o['returns'] !== null
        && typeof o['execute'] === 'function';
}
function walkTs(dir, out = []) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory())
            walkTs(full, out);
        else if (ent.isFile() && ent.name.endsWith('.ts') && !ent.name.endsWith('.d.ts') && !ent.name.endsWith('.test.ts')) {
            out.push(full);
        }
    }
    return out;
}
/**
 * Walk `<procsDir>/**\/*.ts`, dynamic-import each module, and collect every
 * exported `ProcDef`. Returns the canonical `procs` registry plus a map
 * from verb name to source path (the bundler needs the latter).
 *
 * Discovery rules:
 *   - The `name` field on the `defineProc` call is canonical (verbs are
 *     keyed by it, not by filename).
 *   - Two files exporting the same verb name is a build error.
 *   - .test.ts and .d.ts files are skipped.
 */
export async function discoverProcs(procsDir) {
    if (!fs.existsSync(procsDir)) {
        throw new Error(`discoverProcs: no such directory ${procsDir}`);
    }
    const files = walkTs(procsDir).sort();
    const procs = {};
    const paths = {};
    for (const file of files) {
        const mod = await import(url.pathToFileURL(file).href);
        for (const exported of Object.values(mod)) {
            if (!isProcDef(exported))
                continue;
            const name = exported.name;
            if (procs[name]) {
                throw new Error(`discoverProcs: duplicate verb name "${name}" in ${file} ` +
                    `and ${paths[name]}`);
            }
            procs[name] = exported;
            paths[name] = file;
        }
    }
    return { procs, paths };
}
//# sourceMappingURL=discover.js.map