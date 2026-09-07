/**
 * Default DDL for the synapse-canonical audit table.
 *
 * Columns:
 *   id              STRING   PRIMARY KEY  - UUID
 *   at              TIMESTAMP_TZ          - insertion time
 *   verb            STRING                - proc name
 *   actor           STRING                - identity.user (CURRENT_USER())
 *   actor_role      STRING                - identity.role (CURRENT_ROLE())
 *   args_json       VARIANT               - PARSE_JSON of args
 *   outcome         STRING                - 'ok' | 'error' | 'idempotent_replay'
 *   error_code      STRING                - null on ok
 *   error_message   STRING                - null on ok
 *   idempotency_key STRING                - null if not provided
 *   result_hash     STRING                - SHA2(JSON.stringify(result)); null on error
 *   <appIdColumn>   STRING                - optional app-specific row key (e.g. rollout_id)
 */
import { TRACKING_COMMENT } from './tracking.js';

export interface AuditTableDDLOpts {
  /** Default 'verb_attempt'. */
  table?: string;
  /** Optional app-specific row-key column. Default omitted. */
  appIdColumn?: string;
  /** Default true — emit HYBRID TABLE for indexed lookups. Set false for standard table. */
  hybrid?: boolean;
}

export function auditTableDDL(opts: AuditTableDDLOpts = {}): string {
  const table = opts.table ?? 'verb_attempt';
  const hybrid = opts.hybrid !== false;
  const kind = hybrid ? 'HYBRID TABLE' : 'TABLE';
  const extra = opts.appIdColumn ? `,\n    ${opts.appIdColumn}    STRING` : '';
  // LOCAL PATCH (see VENDOR.md): tracking tag required by AGENTS.md on every
  // created object. The materialized install.sql is generated and gitignored, so
  // the tag has to come from the generator rather than be added to the output.
  const track = TRACKING_COMMENT;
  return `CREATE OR REPLACE ${kind} ${table} (
    id              STRING       NOT NULL PRIMARY KEY,
    at              TIMESTAMP_TZ NOT NULL,
    verb            STRING       NOT NULL,
    actor           STRING       NOT NULL,
    actor_role      STRING       NOT NULL,
    args_json       VARIANT,
    outcome         STRING       NOT NULL,
    error_code      STRING,
    error_message   STRING,
    idempotency_key STRING,
    result_hash     STRING${extra}
) COMMENT='${track}';`;
}

export interface ClaimTableDDLOpts {
  /** Default 'verb_claim'. Must match defaultAuditSink({claimTable}). */
  table?: string;
  /** Default true. A standard table CANNOT enforce the PK, so the claim is a no-op there. */
  hybrid?: boolean;
}

/**
 * LOCAL PATCH (see VENDOR.md): idempotency claim table.
 *
 * `checkReplay` in audit.ts is a read-before-write with no transaction, no lock
 * and no unique constraint, so two concurrent calls carrying the same
 * (actor, verb, idempotency_key) both miss the replay check and both run
 * `execute()`. For mutating verbs that is precisely the double-execution
 * idempotency is supposed to prevent.
 *
 * This cannot be fixed with a UNIQUE constraint on `verb_attempt` itself,
 * because that table intentionally holds MULTIPLE rows per key (the original
 * 'ok'/'error' plus one 'idempotent_replay' per repeat). So the claim lives in
 * its own table whose PRIMARY KEY *is* the idempotency triple, and the insert
 * happens BEFORE execute(): the first caller wins, the loser is rejected by the
 * PK and replays or fails instead of re-executing.
 *
 * This only works on a HYBRID TABLE - a standard Snowflake table does not
 * enforce PRIMARY KEY, so the insert would always succeed and the guard would
 * silently do nothing.
 *
 * Retention: rows outlive the replay window (default 24h) and are not pruned on
 * the request path, deliberately - pruning per call would add a statement to
 * every verb. Prune out of band, e.g.
 *   DELETE FROM <claim_table> WHERE claimed_at < DATEADD(day, -7, CURRENT_TIMESTAMP());
 */
export function claimTableDDL(opts: ClaimTableDDLOpts = {}): string {
  const table = opts.table ?? 'verb_claim';
  const hybrid = opts.hybrid !== false;
  const kind = hybrid ? 'HYBRID TABLE' : 'TABLE';
  const track = TRACKING_COMMENT;
  // TIMESTAMP_NTZ, not _TZ: hybrid tables reject TIMESTAMP_TZ in an indexed
  // column, and keeping it index-eligible leaves the retention sweep open to a
  // secondary index later.
  return `CREATE ${kind} IF NOT EXISTS ${table} (
    actor           STRING       NOT NULL,
    verb            STRING       NOT NULL,
    idempotency_key STRING       NOT NULL,
    claimed_at      TIMESTAMP_NTZ NOT NULL,
    PRIMARY KEY (actor, verb, idempotency_key)
) COMMENT='${track}';`;
}
