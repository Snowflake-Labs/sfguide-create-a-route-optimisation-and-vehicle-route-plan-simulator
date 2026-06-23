import { runEnvelope } from './envelope.js';
import { defaultAuditSink } from '../audit.js';
/**
 * Coerce Snowflake's "rich" column representations into the JS primitives
 * the verb schemas expect. Mirrors `coerceCell` in connector.ts -- the
 * thick-client path does this in snowflake-sdk land; here we do it inside
 * the sproc body since `snowflake.execute` returns the same shapes.
 *
 * - TIMESTAMP_TZ: yields `{epoch, fraction, timezone}` objects (epoch in
 *   seconds, fraction in ns). Lift to ISO 8601 string.
 * - Date: TIMESTAMP_NTZ / DATE come back as native Date. Lift to ISO string.
 *
 * Verbs declare timestamp-typed return fields as `t.string()`; without this
 * coercion the envelope's return-shape validator rejects the rich object.
 */
function coerceCell(v) {
    if (v === null || v === undefined)
        return v;
    if (v instanceof Date)
        return v.toISOString();
    if (typeof v === 'object') {
        const o = v;
        if (typeof o.epoch === 'number' && typeof o.fraction === 'number') {
            const ms = o.epoch * 1000 + Math.floor(o.fraction / 1e6);
            return new Date(ms).toISOString();
        }
    }
    return v;
}
function makeSyncConn() {
    return {
        exec(sql, binds) {
            const rs = snowflake.execute({ sqlText: sql, binds: (binds || []).map(_n) });
            const rows = [];
            while (rs.next()) {
                const row = {};
                const n = rs.getColumnCount();
                for (let i = 1; i <= n; i++) {
                    row[rs.getColumnName(i)] = coerceCell(rs.getColumnValue(i));
                }
                rows.push(row);
            }
            return rows;
        },
        execRow(sql, binds) {
            const rs = snowflake.execute({ sqlText: sql, binds: (binds || []).map(_n) });
            if (!rs.next())
                return null;
            const row = {};
            const n = rs.getColumnCount();
            for (let i = 1; i <= n; i++) {
                row[rs.getColumnName(i)] = coerceCell(rs.getColumnValue(i));
            }
            return row;
        },
        execScalar(sql, binds) {
            const rs = snowflake.execute({ sqlText: sql, binds: (binds || []).map(_n) });
            if (!rs.next())
                return null;
            return coerceCell(rs.getColumnValue(1));
        },
        close() { },
    };
}
/**
 * Drives the shared envelope synchronously in a sproc body. The bundler swaps
 * TypeScript's `__awaiter` for a synchronous generator driver, so the
 * `Promise<...>` return from `runEnvelope` resolves to its inner value at the
 * call site.
 */
export function runProcSproc(proc, args, idempotencyKey) {
    const conn = makeSyncConn();
    // The placeholders are replaced at bundle time. After substitution:
    //   __SYNAPSE_AUDIT_TABLE__   -> e.g. 'verb_attempt'
    //   __SYNAPSE_APP_ID_FIELD__  -> e.g. 'rollout_id' or '' (empty when no app_id)
    const auditTable = '__SYNAPSE_AUDIT_TABLE__';
    const appIdFieldRaw = '__SYNAPSE_APP_ID_FIELD__';
    // The bundler post-processor replaces audit-config placeholders with their
    // configured values; an empty appIdField means "no app_id column".
    const audit = defaultAuditSink({
        table: auditTable,
        ...(appIdFieldRaw.length > 0
            ? {
                appIdField: appIdFieldRaw,
                // Default extraction: read the matching property off the args object.
                // Apps that need transformed values can override by implementing
                // their own AuditSink — but the common case is just `args[appIdField]`.
                appIdFromArgs: function (a) {
                    if (a === null)
                        return null;
                    if (typeof a !== 'object')
                        return null;
                    const v = a[appIdFieldRaw];
                    if (typeof v === 'string')
                        return v;
                    return null;
                },
            }
            : {}),
    });
    // The cast: at runtime under the syncRun driver this returns the value
    // directly. TypeScript can't model that without a separate sync envelope.
    return runEnvelope(proc, args, idempotencyKey, conn, audit);
}
//# sourceMappingURL=sproc.js.map