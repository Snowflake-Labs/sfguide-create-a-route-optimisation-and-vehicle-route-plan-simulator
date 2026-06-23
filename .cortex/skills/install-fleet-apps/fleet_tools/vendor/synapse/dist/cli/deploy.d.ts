import type { ResolvedSynapseAppConfig } from '../config.js';
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
export declare function runDeploy(app: ResolvedSynapseAppConfig, argv: string[]): Promise<void>;
//# sourceMappingURL=deploy.d.ts.map