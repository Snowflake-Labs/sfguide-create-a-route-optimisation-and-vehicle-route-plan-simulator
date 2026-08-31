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
  checkReplay(
    conn: Conn,
    ident: Identity,
    verb: string,
    idemKey: string | null,
    args: unknown,
  ): Promise<ReplayHit | null>;
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
export function defaultAuditSink(opts: DefaultAuditSinkOpts): AuditSink {
  const table = opts.table;
  const appIdCol = opts.appIdField;
  const appIdFrom = opts.appIdFromArgs ?? (() => null);
  const windowH = opts.idempotencyWindowHours ?? 24;

  return {
    async identity(conn) {
      const row = await conn.execRow<{ U: string; R: string }>(
        "SELECT CURRENT_USER() AS u, CURRENT_ROLE() AS r",
        [],
      );
      if (!row) return { user: "UNKNOWN", role: "UNKNOWN" };
      return { user: row.U, role: row.R };
    },

    async checkReplay(conn, ident, verb, idemKey, args) {
      if (!idemKey) return null;
      const prior = await conn.execRow<{
        OUTCOME: string;
        ERROR_CODE: string | null;
        ERROR_MESSAGE: string | null;
        RESULT_HASH: string | null;
      }>(
        `SELECT outcome, error_code, error_message, result_hash
         FROM ${table}
         WHERE actor = ? AND verb = ? AND idempotency_key = ?
           AND outcome IN ('ok','error')
           AND at > DATEADD(hour, -?, CURRENT_TIMESTAMP())
         ORDER BY at DESC LIMIT 1`,
        [ident.user, verb, idemKey, windowH],
      );
      if (!prior) return null;

      const appId = appIdCol ? appIdFrom(args) : null;
      const cols = appIdCol
        ? `(id, at, verb, actor, actor_role, args_json, outcome, error_code, error_message, idempotency_key, result_hash, ${appIdCol})`
        : `(id, at, verb, actor, actor_role, args_json, outcome, error_code, error_message, idempotency_key, result_hash)`;
      const sel = appIdCol
        ? `SELECT UUID_STRING(), CURRENT_TIMESTAMP(), ?, ?, ?, PARSE_JSON(?), 'idempotent_replay', ?, ?, ?, ?, ?`
        : `SELECT UUID_STRING(), CURRENT_TIMESTAMP(), ?, ?, ?, PARSE_JSON(?), 'idempotent_replay', ?, ?, ?, ?`;
      const binds: unknown[] = [
        verb,
        ident.user,
        ident.role,
        JSON.stringify(args ?? {}),
        prior.ERROR_CODE,
        prior.ERROR_MESSAGE,
        idemKey,
        prior.RESULT_HASH,
      ];
      if (appIdCol) binds.push(appId);
      await conn.exec(`INSERT INTO ${table}${cols} ${sel}`, binds);

      return {
        replayed: true,
        result_hash: prior.RESULT_HASH,
        outcome: prior.OUTCOME === "error" ? "error" : "ok",
        error_code: prior.ERROR_CODE,
        error_message: prior.ERROR_MESSAGE,
      };
    },

    async recordOk(conn, event) {
      const hash = await conn.execScalar<string>("SELECT SHA2(?)", [
        JSON.stringify(event.result),
      ]);
      const appId = appIdCol ? appIdFrom(event.args) : null;
      const cols = appIdCol
        ? `(id, at, verb, actor, actor_role, args_json, outcome, idempotency_key, result_hash, ${appIdCol})`
        : `(id, at, verb, actor, actor_role, args_json, outcome, idempotency_key, result_hash)`;
      const sel = appIdCol
        ? `SELECT UUID_STRING(), CURRENT_TIMESTAMP(), ?, ?, ?, PARSE_JSON(?), 'ok', ?, ?, ?`
        : `SELECT UUID_STRING(), CURRENT_TIMESTAMP(), ?, ?, ?, PARSE_JSON(?), 'ok', ?, ?`;
      const binds: unknown[] = [
        event.verb,
        event.actor,
        event.actor_role,
        JSON.stringify(event.args ?? {}),
        event.idempotency_key,
        hash,
      ];
      if (appIdCol) binds.push(appId);
      await conn.exec(`INSERT INTO ${table}${cols} ${sel}`, binds);
    },

    async recordError(conn, event) {
      const appId = appIdCol ? appIdFrom(event.args) : null;
      const cols = appIdCol
        ? `(id, at, verb, actor, actor_role, args_json, outcome, error_code, error_message, idempotency_key, ${appIdCol})`
        : `(id, at, verb, actor, actor_role, args_json, outcome, error_code, error_message, idempotency_key)`;
      const sel = appIdCol
        ? `SELECT UUID_STRING(), CURRENT_TIMESTAMP(), ?, ?, ?, PARSE_JSON(?), 'error', ?, ?, ?, ?`
        : `SELECT UUID_STRING(), CURRENT_TIMESTAMP(), ?, ?, ?, PARSE_JSON(?), 'error', ?, ?, ?`;
      const binds: unknown[] = [
        event.verb,
        event.actor,
        event.actor_role,
        JSON.stringify(event.args ?? {}),
        event.error_code,
        event.error_message ?? "",
        event.idempotency_key,
      ];
      if (appIdCol) binds.push(appId);
      await conn.exec(`INSERT INTO ${table}${cols} ${sel}`, binds);
    },
  };
}
