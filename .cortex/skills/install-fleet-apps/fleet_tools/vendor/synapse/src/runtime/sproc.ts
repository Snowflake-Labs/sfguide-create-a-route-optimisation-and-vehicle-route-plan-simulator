import type { Conn } from '../connector.js';
import type { ProcDef } from '../defineProc.js';
import { runEnvelope } from './envelope.js';
import { defaultAuditSink } from '../audit.js';

/**
 * Sproc-target runtime entry. Bundled into every emitted sproc body by the
 * synapse build step (`@snowflake/synapse/build`).
 *
 * Inside a Snowflake JS proc body, `snowflake.execute({sqlText, binds})` is a
 * synchronous global. The shared `Conn` interface returns `Promise<R> | R`, so
 * the same envelope code (`runEnvelope`) runs in both targets — locally awaiting
 * Promises, in-sproc reading values directly through the syncRun driver injected
 * by the bundler.
 *
 * `_n` and `__SYNAPSE_AUDIT_TABLE__` / `__SYNAPSE_APP_ID_FIELD__` are placeholders
 * substituted at bundle time — they do NOT exist as TS-resolvable identifiers in
 * this source. The bundler injects `_n` as a top-level helper before the IIFE,
 * and replaces the audit-config string-literal placeholders with the build's
 * configured values.
 */

// Snowflake's JS proc runtime exposes `snowflake.execute` and `_n` as globals
// in the bundle output. These declarations satisfy the TS compiler at build
// time; the actual runtime values come from the sproc environment / bundler.
declare const snowflake: {
  execute(opts: { sqlText: string; binds?: unknown[] }): {
    next(): boolean;
    getColumnCount(): number;
    getColumnName(i: number): string;
    getColumnValue(i: number): unknown;
  };
};
declare const _n: (v: unknown) => unknown;

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
function coerceCell(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    const o = v as { epoch?: unknown; fraction?: unknown };
    if (typeof o.epoch === 'number' && typeof o.fraction === 'number') {
      const ms = o.epoch * 1000 + Math.floor(o.fraction / 1e6);
      return new Date(ms).toISOString();
    }
  }
  return v;
}

function makeSyncConn(): Conn {
  return {
    exec<R = Record<string, unknown>>(sql: string, binds?: unknown[]): R[] {
      const rs = snowflake.execute({ sqlText: sql, binds: (binds || []).map(_n) });
      const rows: Record<string, unknown>[] = [];
      while (rs.next()) {
        const row: Record<string, unknown> = {};
        const n = rs.getColumnCount();
        for (let i = 1; i <= n; i++) {
          row[rs.getColumnName(i)] = coerceCell(rs.getColumnValue(i));
        }
        rows.push(row);
      }
      return rows as unknown as R[];
    },
    execRow<R = Record<string, unknown>>(sql: string, binds?: unknown[]): R | null {
      const rs = snowflake.execute({ sqlText: sql, binds: (binds || []).map(_n) });
      if (!rs.next()) return null;
      const row: Record<string, unknown> = {};
      const n = rs.getColumnCount();
      for (let i = 1; i <= n; i++) {
        row[rs.getColumnName(i)] = coerceCell(rs.getColumnValue(i));
      }
      return row as unknown as R;
    },
    execScalar<T = unknown>(sql: string, binds?: unknown[]): T | null {
      const rs = snowflake.execute({ sqlText: sql, binds: (binds || []).map(_n) });
      if (!rs.next()) return null;
      return coerceCell(rs.getColumnValue(1)) as unknown as T;
    },
    close(): void { /* no-op inside a sproc */ },
  };
}

/**
 * Drives the shared envelope synchronously in a sproc body. The bundler swaps
 * TypeScript's `__awaiter` for a synchronous generator driver, so the
 * `Promise<...>` return from `runEnvelope` resolves to its inner value at the
 * call site.
 */
export function runProcSproc<TArgs, TReturns>(
  proc: ProcDef<string, TArgs, TReturns>,
  args: unknown,
  idempotencyKey: string | null,
): TReturns | { replayed: true; result_hash: string | null } {
  const conn = makeSyncConn();
  // The placeholders are replaced at bundle time. After substitution:
  //   __SYNAPSE_AUDIT_TABLE__   -> e.g. 'verb_attempt'
  //   __SYNAPSE_APP_ID_FIELD__  -> e.g. 'rollout_id' or '' (empty when no app_id)
  const auditTable: string = '__SYNAPSE_AUDIT_TABLE__';
  const appIdFieldRaw: string = '__SYNAPSE_APP_ID_FIELD__';
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
          appIdFromArgs: function (a: unknown): string | null {
            if (a === null) return null;
            if (typeof a !== 'object') return null;
            const v = (a as Record<string, unknown>)[appIdFieldRaw];
            if (typeof v === 'string') return v;
            return null;
          },
        }
      : {}),
  });
  // The cast: at runtime under the syncRun driver this returns the value
  // directly. TypeScript can't model that without a separate sync envelope.
  return runEnvelope(proc, args, idempotencyKey, conn, audit) as never;
}
