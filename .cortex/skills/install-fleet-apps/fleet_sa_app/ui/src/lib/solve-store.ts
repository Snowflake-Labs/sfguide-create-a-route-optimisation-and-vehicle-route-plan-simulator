// Durable store for long-running solve results.
//
// WHY THIS EXISTS
// ---------------
// Solves routinely outlive what a single HTTP request can wait for. Measured
// server-side (`ensemble`, SanFrancisco, TOTAL_ELAPSED_TIME):
//
//   20 vehicles / 120 loads (the DEFAULTS) ...  38.1s
//   40 / 200 ................................   54.8s
//   60 / 300 ................................   78.8s
//   100 / 300 ...............................   89.2s
//   100 / 500 ...............................  168.6s
//
// The synchronous transport gives up at 60s, the statement is capped at 80s, and
// that cap exists to stay under the ~90s SPCS ingress limit. So the DEFAULT
// configuration already consumes 63% of the budget, and anything beyond roughly
// 40 vehicles / 200 loads cannot return synchronously at all.
//
// WHY A TABLE RATHER THAN JUST THE STATEMENT HANDLE
// ------------------------------------------------
// A handle is session state. Hold results only in the handle and a reopened tab,
// a second dispatcher looking at the same region, or a later agent turn cannot
// collect a solve it did not itself start. Keying on a solve key makes the
// result addressable by anyone who knows the key.
//
// WHY NOT REUSE THE VERB AUDIT TABLE
// ----------------------------------
// `verb_attempt` looks like a result cache and is not one: it stores only a
// `result_hash`, and an idempotent replay returns exactly
// `{"replayed": true, "result_hash": "..."}` - verified against a live account.
// It is a double-execution GUARD. Retrying a slow solve with the same
// idempotency key therefore returns a hash and no routes, which is a real
// latent bug in any client that retries by key.
//
// DEGRADED MODE
// -------------
// Every function here is best-effort. On a fresh install the admin app's boot
// DDL may not have run yet, so the table can be absent; when that happens the
// caller must still be able to solve, just without cross-session recovery. So
// failures are swallowed and reported via the return value rather than thrown.
import { queryBatch } from './snowflake';
import { logger } from './logger';

export const SOLVE_RESULTS_TABLE = 'FLEET_INTELLIGENCE.CORE.SOLVE_RESULTS';

export type SolveStatus = 'RUNNING' | 'SUCCESS' | 'FAILED';

export interface SolveRow {
  status: SolveStatus;
  handle: string | null;
  result: unknown;
  error: string | null;
}

/**
 * Deterministic solve key. Same verb + same arguments => same key, so a client
 * that resubmits an identical solve joins the in-flight one instead of starting
 * a second copy of a 168-second job.
 *
 * FNV-1a rather than crypto: this only needs to be stable and well-spread, and
 * it must run in any runtime without pulling node:crypto into an edge bundle.
 */
export function solveKey(verb: string, params: unknown): string {
  const s = `${verb}:${JSON.stringify(params ?? null)}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    h1 ^= s.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= s.charCodeAt(s.length - 1 - i);
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return `${verb}_${h1.toString(36)}${h2.toString(36)}`;
}

function sqlStr(v: string | null): string {
  if (v === null) return 'NULL';
  return `'${v.replace(/'/g, "''")}'`;
}

/** Record a submitted solve as RUNNING. Returns false if the store is unusable. */
export async function markRunning(
  key: string, verb: string, handle: string, actor: string | null, params: unknown,
): Promise<boolean> {
  try {
    // MERGE, not INSERT: a resubmitted identical solve must adopt the new handle
    // rather than fail on the primary key and lose the ability to be collected.
    await queryBatch(
      `MERGE INTO ${SOLVE_RESULTS_TABLE} t
         USING (SELECT ${sqlStr(key)} AS SOLVE_KEY) s
         ON t.SOLVE_KEY = s.SOLVE_KEY
       WHEN MATCHED THEN UPDATE SET
         STATUS = 'RUNNING', STATEMENT_HANDLE = ${sqlStr(handle)},
         RESULT = NULL, ERROR_MESSAGE = NULL,
         SUBMITTED_AT = CURRENT_TIMESTAMP(), COMPLETED_AT = NULL
       WHEN NOT MATCHED THEN INSERT
         (SOLVE_KEY, VERB, STATEMENT_HANDLE, STATUS, ACTOR, PARAMS_JSON, SUBMITTED_AT)
         VALUES (${sqlStr(key)}, ${sqlStr(verb)}, ${sqlStr(handle)}, 'RUNNING',
                 ${sqlStr(actor)}, PARSE_JSON(${sqlStr(JSON.stringify(params ?? null))}),
                 CURRENT_TIMESTAMP())`,
    );
    return true;
  } catch (err) {
    // Degraded, not fatal: the solve still runs and the caller can still poll by
    // handle within this session. Logged so a missing table is visible.
    logger.warn('solve-store-mark-running-failed', { key, verb, error: (err as Error)?.message });
    return false;
  }
}

/** Record a terminal outcome. */
export async function markDone(
  key: string, status: 'SUCCESS' | 'FAILED', result: unknown, error: string | null,
): Promise<void> {
  try {
    const resultJson = status === 'SUCCESS' ? JSON.stringify(result ?? null) : null;
    await queryBatch(
      `UPDATE ${SOLVE_RESULTS_TABLE}
          SET STATUS = ${sqlStr(status)},
              RESULT = ${resultJson === null ? 'NULL' : `PARSE_JSON(${sqlStr(resultJson)})`},
              ERROR_MESSAGE = ${sqlStr(error)},
              COMPLETED_AT = CURRENT_TIMESTAMP()
        WHERE SOLVE_KEY = ${sqlStr(key)}`,
    );
  } catch (err) {
    logger.warn('solve-store-mark-done-failed', { key, status, error: (err as Error)?.message });
  }
}

/** Read a solve by key. null when unknown or the store is unusable. */
export async function readSolve(key: string): Promise<SolveRow | null> {
  try {
    const rows = await queryBatch<Record<string, unknown>>(
      `SELECT STATUS, STATEMENT_HANDLE, ERROR_MESSAGE, TO_JSON(RESULT) AS RESULT_JSON
         FROM ${SOLVE_RESULTS_TABLE} WHERE SOLVE_KEY = ${sqlStr(key)}`,
    );
    if (!rows.length) return null;
    const r = rows[0];
    let result: unknown = null;
    const rj = r.RESULT_JSON;
    if (typeof rj === 'string' && rj) {
      try { result = JSON.parse(rj); } catch { result = null; }
    }
    return {
      status: String(r.STATUS ?? 'RUNNING') as SolveStatus,
      handle: (r.STATEMENT_HANDLE as string) ?? null,
      result,
      error: (r.ERROR_MESSAGE as string) ?? null,
    };
  } catch (err) {
    logger.warn('solve-store-read-failed', { key, error: (err as Error)?.message });
    return null;
  }
}
