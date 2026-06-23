import type { ProcDef } from '../defineProc.js';
import type { AuditBundleConfig } from './bundle.js';
import type { InstallConfig, InstallRuntime } from './install.js';
export interface BundleRuntimeOpts {
    /** Verb name -> (proc, source-file-path). */
    procs: Record<string, {
        proc: ProcDef<string, unknown, unknown>;
        modulePath: string;
    }>;
    /** Audit table config (matches what materialize uses elsewhere). */
    audit: AuditBundleConfig;
    /** install.json -- baked into the generated file as connection defaults. */
    install: InstallConfig;
    /** Where the install lives (resolved version of `runtime`, default 'sproc'). */
    runtime: InstallRuntime;
    /** App root -- used to resolve verb module paths. */
    appRoot: string;
    /** Output path for the bundled JS. */
    out: string;
}
/**
 * Emit a self-contained `runtime.js` alongside install.sql. Consumers can do:
 *
 *   import { approve_rollout, ensureConnection } from './runtime.js';
 *   await approve_rollout(args, { idempotency_key: '...' });
 *
 * The first verb call (or an explicit `ensureConnection()`) opens the
 * Snowflake connection using the install's snowCliConn (resolved natively
 * by snowflake-sdk against ~/.snowflake/connections.toml). USE WAREHOUSE /
 * DATABASE / SCHEMA / ROLE is applied from install.json.
 *
 * In `runtime: 'sproc'` mode the verbs CALL the deployed sproc; in
 * `runtime: 'local'` mode they run the envelope in-process. Either way the
 * consumer-facing API is identical.
 */
export declare function bundleRuntime(opts: BundleRuntimeOpts): Promise<void>;
//# sourceMappingURL=runtime-js.d.ts.map