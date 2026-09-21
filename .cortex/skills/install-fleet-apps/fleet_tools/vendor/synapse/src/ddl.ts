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
  // LOCAL PATCH (see VENDOR.md): IF NOT EXISTS, never CREATE OR REPLACE.
  //
  // This table is the ONLY durable record of agent behaviour - which verbs were
  // called, by whom, with what args, and what failed. `npx synapse deploy` runs
  // this DDL on every bundle deploy, and AGENTS.md requires a bundle deploy (then
  // create_agents.sh) after any verb change, so CREATE OR REPLACE truncated the
  // entire history on a ROUTINE cadence.
  //
  // Measured, not theorised: a 35-row audit trail spanning two days of real agent
  // use - including the run_sql calls that proved the governed semantic-view path
  // was being bypassed - was reduced to the 4 rows logged after a redeploy, with
  // no error and nothing to indicate anything had been lost. Any longitudinal
  // question ("is the bypass rate falling?", "which verbs has nobody exercised?")
  // silently reset to a near-empty baseline each time.
  //
  // claimTableDDL below already used IF NOT EXISTS, so this was an inconsistency
  // rather than a deliberate choice. The trade-off is that a future column
  // addition needs an explicit ALTER - correct for an append-only audit log,
  // where losing history is far worse than an occasional migration statement.
  return `CREATE ${kind} IF NOT EXISTS ${table} (
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
 * A HYBRID table is preferred because it ENFORCES the primary key, which is the
 * only thing that can reject two callers claiming the same key at the same
 * instant. A standard Snowflake table does not enforce PRIMARY KEY, so on the
 * accounts that have no hybrid tables (GCP / trial / SnowGov) `claim()` must not
 * rely on a violation being raised - it issues a `WHERE NOT EXISTS` conditional
 * insert and reads the inserted-row count instead, so a repeat claim is still
 * rejected on both table kinds. The residual gap on a standard table is exact
 * simultaneity, not repetition.
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
