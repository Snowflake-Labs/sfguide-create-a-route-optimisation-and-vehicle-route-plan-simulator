import { type ProcBuildInput, type AuditBundleConfig } from './bundle.js';
export interface BuildSprocsOpts {
    /**
     * Procs to build. Each entry has the proc ref (for DDL) and an absolute
     * path to its TS source file (for the bundler).
     */
    procs: ProcBuildInput[];
    /** Output file path. Parent dirs are created if missing. */
    out: string;
    /** Audit table config — must match what the local target uses at runtime. */
    audit: AuditBundleConfig;
    /** Default `{ hybrid: true }`. */
    schema?: {
        hybrid?: boolean;
    };
}
/**
 * Build a flat `install.sql` containing the audit-table DDL plus one
 * `CREATE OR REPLACE PROCEDURE` per proc. Operator deploys via
 * `snow sql -c <conn> -f <out>`.
 */
export declare function buildSprocs(opts: BuildSprocsOpts): Promise<void>;
//# sourceMappingURL=install-sql.d.ts.map