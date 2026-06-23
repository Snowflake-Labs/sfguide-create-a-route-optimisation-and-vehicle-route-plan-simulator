export function auditTableDDL(opts = {}) {
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
//# sourceMappingURL=ddl.js.map