import type { AuditBundleConfig } from './build/bundle.js';
/**
 * Per-app config consumed by the synapse CLI (materialize, deploy, ...).
 * Lives at `<app-root>/synapse.config.ts` (or .js/.mjs).
 *
 * Most fields default to the canonical layout
 * (`./src/procs`, `./src/schema`, `./src/seed`, `./src/grants`); apps with a
 * different shape override only what they need.
 */
export interface SynapseAppConfig {
    /** App name. Used as the directory under `apps/_installed/<account>/<app>/`. */
    name: string;
    /** Audit-table config -- required because synapse has no opinion on which table or column. */
    audit: AuditBundleConfig;
    /** procs root. Default: `./src/procs` relative to synapse.config.ts. */
    procsDir?: string;
    /** schema SQL root. Default: `./src/schema`. Optional -- omit if the app has no schema files. */
    schemaDir?: string;
    /** seed SQL root. Default: `./src/seed`. Optional. */
    seedDir?: string;
    /** grants SQL root. Default: `./src/grants`. Optional. */
    grantsDir?: string;
}
/** Resolved form: every dir present (or `null` if intentionally absent), all paths absolute. */
export interface ResolvedSynapseAppConfig {
    name: string;
    audit: AuditBundleConfig;
    /** Directory that contained the synapse.config.* file. */
    appRoot: string;
    procsDir: string;
    schemaDir: string | null;
    seedDir: string | null;
    grantsDir: string | null;
}
/**
 * Identity function with type narrowing. Apps write
 * `export default defineSynapseApp({ ... })` so editor tooling enforces the
 * shape and the CLI gets a reliable schema.
 */
export declare function defineSynapseApp(cfg: SynapseAppConfig): SynapseAppConfig;
/**
 * Resolve a raw config relative to its source file. Optional dirs become
 * absolute paths or null (if missing on disk and no override was given).
 */
export declare function resolveAppConfig(cfg: SynapseAppConfig, configFile: string): ResolvedSynapseAppConfig;
/**
 * Walk up from `startDir` (default cwd) looking for `synapse.config.{ts,js,mjs,cjs}`.
 * Stops at filesystem root. Returns the absolute path or null.
 */
export declare function findAppConfig(startDir?: string): string | null;
/**
 * Load and resolve a config file. Assumes a TS loader (e.g. tsx via
 * `register()`) is already in scope -- the synapse CLI registers tsx
 * globally before invoking this.
 */
export declare function loadAppConfig(configFile: string): Promise<ResolvedSynapseAppConfig>;
//# sourceMappingURL=config.d.ts.map