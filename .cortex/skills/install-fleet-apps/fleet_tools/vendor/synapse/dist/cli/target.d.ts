import type { ResolvedSynapseAppConfig } from '../config.js';
/**
 * Shared `--account <name> | --install <path>` parsing across CLI subcommands.
 * Resolves to the `apps/_installed/<account>/<app>/` directory the subcommand
 * should operate on.
 */
export interface TargetFlags {
    account?: string;
    installPath?: string;
}
export declare function parseTargetFlags(argv: string[]): TargetFlags;
/**
 * Resolve the target install dir from --install or --account.
 * --install wins if both are provided (explicit path always overrides).
 */
export declare function resolveTargetDir(app: ResolvedSynapseAppConfig, flags: TargetFlags): string;
//# sourceMappingURL=target.d.ts.map