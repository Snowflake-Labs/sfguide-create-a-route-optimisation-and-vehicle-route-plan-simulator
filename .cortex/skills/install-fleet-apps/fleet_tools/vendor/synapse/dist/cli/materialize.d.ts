import type { ResolvedSynapseAppConfig } from '../config.js';
/**
 * Materialize `apps/_installed/<account>/<app>/install.sql` for a given install.
 * Branches on `install.runtime`:
 *   - 'sproc': schema -> seed -> proc DDL (incl. audit table) -> hand grants
 *              -> synapse-emitted GRANT USAGE ON PROCEDURE block
 *   - 'local': schema -> seed -> audit-table DDL -> hand grants
 *              -> synapse-emitted per-(role, table, access) GRANT block
 *              (procs are not deployed; callers run them client-side)
 *
 *   synapse materialize --account <name>
 *   synapse materialize --install <path>
 */
export declare function runMaterialize(app: ResolvedSynapseAppConfig, argv: string[]): Promise<void>;
//# sourceMappingURL=materialize.d.ts.map