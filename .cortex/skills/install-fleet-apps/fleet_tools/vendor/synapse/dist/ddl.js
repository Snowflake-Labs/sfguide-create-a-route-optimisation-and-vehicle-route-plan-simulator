export function auditTableDDL(opts = {}) {
    const table = opts.table ?? 'verb_attempt';
    const hybrid = opts.hybrid !== false;
    const kind = hybrid ? 'HYBRID TABLE' : 'TABLE';
    const extra = opts.appIdColumn ? `,\n    ${opts.appIdColumn}    STRING` : '';
    // Tracking tag (AGENTS.md): attribution + routing-solution-cleanup discovery.
    const track = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
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
//# sourceMappingURL=ddl.js.map