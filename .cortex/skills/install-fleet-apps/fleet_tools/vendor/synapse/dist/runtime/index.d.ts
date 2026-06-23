import type { Conn } from '../connector.js';
import type { AuditSink } from '../audit.js';
import type { ProcDef } from '../defineProc.js';
export type { Conn } from '../connector.js';
export type { AuditSink, AuditEvent, Identity, Outcome, ReplayHit, DefaultAuditSinkOpts } from '../audit.js';
export { defaultAuditSink } from '../audit.js';
export type { ConnConfig } from '../connector.js';
export { createConn, createConnFromCli } from '../connector.js';
export { auditTableDDL } from '../ddl.js';
export type { AuditTableDDLOpts } from '../ddl.js';
export { runEnvelope } from './envelope.js';
export { wireSprocClient } from './sproc-client.js';
export interface CallOptions {
    idempotency_key?: string | null;
}
export type ProcCall<TArgs, TReturns> = (args: TArgs, opts?: CallOptions) => Promise<TReturns | {
    replayed: true;
    result_hash: string | null;
}>;
export type Runtime<P extends Record<string, ProcDef<string, any, any>>> = {
    [K in keyof P]: P[K] extends ProcDef<string, infer A, infer R> ? ProcCall<A, R> : never;
};
export interface RuntimeOptions<P extends Record<string, ProcDef<string, any, any>>> {
    connector: Conn;
    procs: P;
    audit: AuditSink;
}
/**
 * Local-target runtime. Wraps each registered proc with the shared envelope
 * (validate -> identity -> checkReplay -> execute -> auditOk), running against
 * the supplied async `Conn` and `AuditSink`.
 *
 * Sproc-target uses the same envelope via `@snowflake/synapse/runtime/sproc`.
 */
export declare function createSynapseRuntime<P extends Record<string, ProcDef<string, any, any>>>(options: RuntimeOptions<P>): Runtime<P>;
//# sourceMappingURL=index.d.ts.map