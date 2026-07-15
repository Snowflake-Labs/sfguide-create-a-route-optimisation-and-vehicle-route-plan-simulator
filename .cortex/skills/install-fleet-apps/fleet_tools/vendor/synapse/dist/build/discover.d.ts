import type { ProcDef } from '../defineProc.js';
export interface DiscoveredProcs {
    /** verb name -> ProcDef (the canonical registry shape used by createSynapseRuntime, buildSprocs, etc.) */
    procs: Record<string, ProcDef<string, unknown, unknown>>;
    /** verb name -> absolute path of the file that exported it. Materialize feeds this to the bundler. */
    paths: Record<string, string>;
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
export declare function discoverProcs(procsDir: string): Promise<DiscoveredProcs>;
//# sourceMappingURL=discover.d.ts.map