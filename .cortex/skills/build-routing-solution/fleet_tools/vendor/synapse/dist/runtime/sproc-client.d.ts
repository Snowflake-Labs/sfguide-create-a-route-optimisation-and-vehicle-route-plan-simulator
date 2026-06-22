import type { Conn } from '../connector.js';
import type { ProcDef } from '../defineProc.js';
import type { Runtime } from './index.js';
/**
 * Build a client-side runtime that dispatches verb calls to deployed sprocs
 * via `CALL <verb>(?, ?, ...)`. Same shape as `createSynapseRuntime` but the
 * envelope (validate / identity / audit) lives inside Snowflake — we just
 * shuttle args in and unwrap the OBJECT result on the way out.
 *
 * The args passed in must already be the canonical argument record (matching
 * `proc.args`); they're fed into the CALL in the order Snowflake expects:
 * the proc's declared arg list, then the framework-injected `IDEMPOTENCY_KEY`.
 *
 * Snowflake returns a JS proc's OBJECT/VARIANT result wrapped in a
 * single-row resultset under a column named after the proc (uppercased).
 * Sometimes the connector hands it back as a parsed object; sometimes as a
 * JSON string. We tolerate both.
 */
export declare function wireSprocClient<P extends Record<string, ProcDef<string, any, any>>>(conn: Conn, procs: P): Runtime<P>;
//# sourceMappingURL=sproc-client.d.ts.map