import type { ProcDef } from '../defineProc.js';
/**
 * Bundle a `ProcDef` into a self-contained JS string suitable for a Snowflake
 * stored procedure body.
 *
 * Pipeline:
 *   1. Generate a synthetic entry that imports the verb + the framework's
 *      sproc-target runtime entry (`runProcSproc`).
 *   2. esbuild bundles, lowering async/await to generators + `__async` helper.
 *      A custom resolver plugin handles `@snowflake/synapse/...` specifiers
 *      so the bundler works regardless of where the proc module lives.
 *   3. AST pass: parse the bundle, locate the top-level `__async` helper
 *      declaration, replace its body with the synchronous generator driver.
 *      Verifies that EITHER no `__async(` invocations exist (no async source)
 *      OR the helper is found and replaced — never the silent middle case.
 *   4. Replace `__SYNAPSE_AUDIT_TABLE__` / `__SYNAPSE_APP_ID_FIELD__` placeholders.
 *   5. Inject `_n` and append the args-capture suffix that calls `__synapse.__synapseEntry`.
 *   6. Lint: no `require(`, no `process.env`, no `import.meta`, no top-level
 *      `import`, no top-level `await`.
 */
/** Audit-config substituted into the bundled body at build time. */
export interface AuditBundleConfig {
    /** Audit table name (e.g. 'verb_attempt'). */
    table: string;
    /** App-specific row-key column name (e.g. 'rollout_id'). Optional. */
    appIdField?: string;
}
/** A single proc to bundle: the registered ProcDef + where to find its source. */
export interface ProcBuildInput {
    /** The registered proc — used for the DDL signature. */
    proc: ProcDef<string, unknown, unknown>;
    /** Absolute path to the TS file that exports the proc. */
    procModulePath: string;
    /** Export name to import from `procModulePath`. Defaults to `proc.name`. */
    exportName?: string;
}
/** Bundle a single proc into a sproc-ready JS body string. */
export declare function bundleProc(input: ProcBuildInput, audit: AuditBundleConfig): Promise<string>;
//# sourceMappingURL=bundle.d.ts.map