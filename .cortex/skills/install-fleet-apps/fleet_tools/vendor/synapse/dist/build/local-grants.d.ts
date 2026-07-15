import type { ProcDef } from '../defineProc.js';
export interface BuildLocalGrantsOpts {
    procs: Array<ProcDef<string, unknown, unknown>>;
    out: string;
    /** Custom role->target rendering. Default: `ROLE IDENTIFIER($<role>_role)`. */
    roleTarget?: (logicalRole: string) => string;
}
/**
 * For installs running in `local` runtime mode: emit per-(role, table, access)
 * GRANT statements rolled up across every verb's `roles × refs`. Each role
 * gets the union of permissions every verb it can call needs.
 *
 * Output is grouped by role then by object for legibility:
 *
 *   -- role: user
 *   GRANT SELECT, UPDATE ON TABLE rollout TO ROLE IDENTIFIER($user_role);
 *   GRANT INSERT ON TABLE rollout_event  TO ROLE IDENTIFIER($user_role);
 *
 * Procs without `refs` contribute nothing; procs without `roles` contribute
 * nothing. (sproc-runtime installs use `buildGrants` instead -- this file
 * is for thick-client / local-runtime grant emission.)
 */
export declare function buildLocalGrants(opts: BuildLocalGrantsOpts): Promise<void>;
//# sourceMappingURL=local-grants.d.ts.map