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
);`;
}
