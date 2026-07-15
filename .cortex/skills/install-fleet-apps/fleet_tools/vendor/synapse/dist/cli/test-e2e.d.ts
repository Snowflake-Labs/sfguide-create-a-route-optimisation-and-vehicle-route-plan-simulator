import type { ResolvedSynapseAppConfig } from '../config.js';
/**
 * Run the app's e2e test suite against a materialized install. Resolves
 * --account / --install to an apps/_installed/<account>/<app>/ directory,
 * exports it as SYNAPSE_INSTALL, then execs vitest from the app root.
 *
 * The e2e target (sproc vs local) comes from install.json's `runtime` field
 * -- mode determines target, no --target flag.
 *
 *   synapse test:e2e --account snowhouse
 *   synapse test:e2e --install apps/_installed/snowhouse/param-rollout
 *
 * Any extra flags after `--` pass through to vitest:
 *   synapse test:e2e --account snowhouse -- --reporter=verbose
 */
export declare function runTestE2e(app: ResolvedSynapseAppConfig, argv: string[]): Promise<void>;
//# sourceMappingURL=test-e2e.d.ts.map