import * as path from 'node:path';
import * as url from 'node:url';
import * as fs from 'node:fs';
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
export function defineSynapseApp(cfg: SynapseAppConfig): SynapseAppConfig {
  return cfg;
}

/**
 * Resolve a raw config relative to its source file. Optional dirs become
 * absolute paths or null (if missing on disk and no override was given).
 */
export function resolveAppConfig(
  cfg: SynapseAppConfig, configFile: string,
): ResolvedSynapseAppConfig {
  const appRoot = path.dirname(configFile);
  const resolveDir = (rel: string | undefined, dflt: string, allowMissing: boolean): string | null => {
    if (rel) return path.resolve(appRoot, rel);
    const fallback = path.resolve(appRoot, dflt);
    if (fs.existsSync(fallback)) return fallback;
    if (allowMissing) return null;
    return fallback;  // procsDir is required to exist; caller errors at use-site
  };
  return {
    name: cfg.name,
    audit: cfg.audit,
    appRoot,
    procsDir:  resolveDir(cfg.procsDir,  'src/procs',  false)!,
    schemaDir: resolveDir(cfg.schemaDir, 'src/schema', true),
    seedDir:   resolveDir(cfg.seedDir,   'src/seed',   true),
    grantsDir: resolveDir(cfg.grantsDir, 'src/grants', true),
  };
}

/**
 * Walk up from `startDir` (default cwd) looking for `synapse.config.{ts,js,mjs,cjs}`.
 * Stops at filesystem root. Returns the absolute path or null.
 */
export function findAppConfig(startDir?: string): string | null {
  const exts = ['ts', 'mts', 'js', 'mjs', 'cjs'];
  let dir = path.resolve(startDir ?? process.cwd());
  while (true) {
    for (const ext of exts) {
      const candidate = path.join(dir, `synapse.config.${ext}`);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Load and resolve a config file. Assumes a TS loader (e.g. tsx via
 * `register()`) is already in scope -- the synapse CLI registers tsx
 * globally before invoking this.
 */
export async function loadAppConfig(configFile: string): Promise<ResolvedSynapseAppConfig> {
  const mod = await import(url.pathToFileURL(configFile).href) as { default?: unknown };
  const cfg = mod.default;
  if (!cfg || typeof cfg !== 'object') {
    throw new Error(`${configFile}: default export is missing or not an object`);
  }
  return resolveAppConfig(cfg as SynapseAppConfig, configFile);
}
