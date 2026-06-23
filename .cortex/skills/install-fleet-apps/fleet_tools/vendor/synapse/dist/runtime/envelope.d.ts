import type { Conn } from '../connector.js';
import type { AuditSink } from '../audit.js';
import type { ProcDef } from '../defineProc.js';
export declare function runEnvelope<TArgs, TReturns>(proc: ProcDef<string, TArgs, TReturns>, rawArgs: unknown, idempotencyKey: string | null, conn: Conn, audit: AuditSink): Promise<TReturns | {
    replayed: true;
    result_hash: string | null;
}>;
//# sourceMappingURL=envelope.d.ts.map