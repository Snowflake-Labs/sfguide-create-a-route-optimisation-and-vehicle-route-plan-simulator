import type { Conn } from "./connector.js";
export interface Identity {
    user: string;
    role: string;
}
export type Outcome = "ok" | "error" | "idempotent_replay";
/**
 * Framework-canonical audit row. App-specific row keys go in `app_id`
 * (e.g. param-rollout's `rollout_id`).
 */
export interface AuditEvent {
    verb: string;
    actor: string;
    actor_role: string;
    args: unknown;
    outcome: Outcome;
    idempotency_key: string | null;
    app_id: string | null;
    error_code: string | null;
    error_message: string | null;
    /** Result for ok; ignored for error. Hashed to result_hash on insert. */
    result: unknown;
    /** result_hash from the original row, for idempotent_replay outcomes. */
    replayed_from: string | null;
}
export interface ReplayHit {
    replayed: true;
    result_hash: string | null;
    outcome: "ok" | "error";
    error_code: string | null;
    error_message: string | null;
}
/**
 * What the runtime calls into to record an attempt. Apps that need a different
 * audit schema implement this interface themselves; the default sink ships in this
 * file as `defaultAuditSink`.
 */
export interface AuditSink {
    identity(conn: Conn): Promise<Identity>;
    checkReplay(conn: Conn, ident: Identity, verb: string, idemKey: string | null, args: unknown): Promise<ReplayHit | null>;
    recordOk(conn: Conn, event: AuditEvent): Promise<void>;
    recordError(conn: Conn, event: AuditEvent): Promise<void>;
}
export interface DefaultAuditSinkOpts {
    /** Audit table name. Must match auditTableDDL({table}). */
    table: string;
    /** Optional column for an app-specific row key (e.g. 'rollout_id'). */
    appIdField?: string;
    /** Extracts app_id from args. Required if appIdField is set. */
    appIdFromArgs?: (args: unknown) => string | null;
    /** Default 24. */
    idempotencyWindowHours?: number;
}
/**
 * Default sink that writes to a synapse-canonical audit table. Schema must match
 * the output of `auditTableDDL({table, appIdColumn})`.
 */
export declare function defaultAuditSink(opts: DefaultAuditSinkOpts): AuditSink;
//# sourceMappingURL=audit.d.ts.map