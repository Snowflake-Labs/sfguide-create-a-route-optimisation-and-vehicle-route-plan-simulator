import { runEnvelope } from './envelope.js';
export { defaultAuditSink } from '../audit.js';
export { createConn, createConnFromCli } from '../connector.js';
export { auditTableDDL } from '../ddl.js';
export { runEnvelope } from './envelope.js';
export { wireSprocClient } from './sproc-client.js';
/**
 * Local-target runtime. Wraps each registered proc with the shared envelope
 * (validate -> identity -> checkReplay -> execute -> auditOk), running against
 * the supplied async `Conn` and `AuditSink`.
 *
 * Sproc-target uses the same envelope via `@snowflake/synapse/runtime/sproc`.
 */
export function createSynapseRuntime(options) {
    const { connector: conn, procs, audit } = options;
    const result = {};
    for (const procName of Object.keys(procs)) {
        const proc = procs[procName];
        result[procName] = async (rawArgs, callOpts) => {
            const idemKey = callOpts?.idempotency_key ?? null;
            return runEnvelope(proc, rawArgs, idemKey, conn, audit);
        };
    }
    return result;
}
//# sourceMappingURL=index.js.map