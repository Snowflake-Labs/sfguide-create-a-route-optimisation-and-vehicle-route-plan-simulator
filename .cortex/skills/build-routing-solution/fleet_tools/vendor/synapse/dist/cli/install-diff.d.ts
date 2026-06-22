import type { ResolvedSynapseAppConfig } from '../config.js';
/**
 * Diff the on-disk install.sql against what would be emitted from current source.
 *
 *   synapse install:diff --account <name>
 *   synapse install:diff --install <path>
 *
 * Re-runs materialize into a temp dir (does NOT touch the real install.json),
 * then runs `diff -u`. Exits 0 if identical, 1 if different, 2 on error.
 */
export declare function runInstallDiff(app: ResolvedSynapseAppConfig, argv: string[]): Promise<void>;
//# sourceMappingURL=install-diff.d.ts.map