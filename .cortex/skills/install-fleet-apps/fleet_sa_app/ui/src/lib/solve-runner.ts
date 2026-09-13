// Submit a solve, wait briefly, then hand back a key if it is still running.
//
// The point of this module is that FAST solves must not become slower or more
// complicated. Measured server-side, the DEFAULT parameters take 38.1s and a
// cached/small solve returns in seconds, so forcing every caller onto a
// submit-then-poll round trip would penalise the common case to serve the tail.
//
// So: submit async, wait up to INLINE_WAIT_MS, and
//   * if it finished  -> return the result inline, exactly as the old sync path
//   * if it is still running -> return { pending: true, solve_key } and let the
//     client poll /api/solve-status
//
// INLINE_WAIT_MS is 45s. It has to sit BELOW the ~90s SPCS ingress limit with
// room for the request's own overhead, and above nothing in particular - 45s
// keeps the 38.1s default case inline (its whole reason for existing) while
// leaving ~45s of headroom before ingress would kill the response.
import {
  submitAsync,
  fetchByHandle,
  cancelHandle,
  type QueryRow,
} from './snowflake';
import { markRunning, markDone, readSolve, solveKey } from './solve-store';
import { logger } from './logger';

export const INLINE_WAIT_MS = 45_000;
const POLL_INTERVAL_MS = 1_500;

export interface SolveOutcome<T = QueryRow> {
  /** Still running. The caller should return 202 with solveKey. */
  pending: boolean;
  solveKey: string;
  rows?: T[];
  /** Set when a previous run of this exact solve already completed. */
  cached?: boolean;
}

/**
 * Run a solve with async submission and a bounded inline wait.
 *
 * `params` must capture everything that changes the answer: it is hashed into the
 * solve key, so two callers with identical params share one solve instead of
 * starting two copies of a 168-second job.
 */
export async function runSolve<T = QueryRow>(
  verb: string,
  sql: string,
  binds: (string | number | null)[],
  params: unknown,
  actor: string | null = null,
): Promise<SolveOutcome<T>> {
  const key = solveKey(verb, params);

  // A completed identical solve is returned immediately. This is the durability
  // payoff: it survives a page reload, a different browser and a container
  // restart, none of which a statement handle does.
  const existing = await readSolve(key);
  if (existing?.status === 'SUCCESS' && existing.result !== null) {
    return { pending: false, solveKey: key, rows: existing.result as T[], cached: true };
  }
  // An in-flight solve started by someone else: adopt its handle rather than
  // launching a duplicate.
  if (existing?.status === 'RUNNING' && existing.handle) {
    const adopted = await waitForHandle<T>(existing.handle, key, verb);
    if (adopted) return adopted;
    return { pending: true, solveKey: key };
  }

  const handle = await submitAsync(sql, binds);
  await markRunning(key, verb, handle, actor, params);

  const done = await waitForHandle<T>(handle, key, verb);
  if (done) return done;

  // Still running past the inline budget. Deliberately NOT cancelled: the whole
  // point is that the statement keeps going server-side while the client polls.
  logger.info('solve-deferred', { verb, solveKey: key, handle, waitedMs: INLINE_WAIT_MS });
  return { pending: true, solveKey: key };
}

/** Poll a handle for up to INLINE_WAIT_MS. null when still running. */
async function waitForHandle<T>(
  handle: string, key: string, verb: string,
): Promise<SolveOutcome<T> | null> {
  const deadline = Date.now() + INLINE_WAIT_MS;
  while (Date.now() < deadline) {
    let out: { status: 'running' } | { rows: T[] };
    try {
      out = await fetchByHandle<T>(handle);
    } catch (err) {
      const msg = (err as Error)?.message ?? 'solve failed';
      await markDone(key, 'FAILED', null, msg);
      throw err;
    }
    if ('rows' in out) {
      await markDone(key, 'SUCCESS', out.rows, null);
      return { pending: false, solveKey: key, rows: out.rows };
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  logger.debug('solve-still-running', { verb, handle });
  return null;
}

/**
 * Collect a deferred solve. Used by /api/solve-status.
 *
 * Reads the durable row first so a caller that never saw the handle (new tab,
 * different user, agent turn) can still collect the result.
 */
export async function collectSolve<T = QueryRow>(
  key: string,
): Promise<{ status: 'RUNNING' } | { status: 'SUCCESS'; rows: T[] } | { status: 'FAILED'; error: string } | null> {
  const row = await readSolve(key);
  if (!row) return null;
  if (row.status === 'SUCCESS') return { status: 'SUCCESS', rows: (row.result ?? []) as T[] };
  if (row.status === 'FAILED') return { status: 'FAILED', error: row.error ?? 'solve failed' };
  if (!row.handle) return { status: 'RUNNING' };

  try {
    const out = await fetchByHandle<T>(row.handle);
    if ('rows' in out) {
      await markDone(key, 'SUCCESS', out.rows, null);
      return { status: 'SUCCESS', rows: out.rows };
    }
    return { status: 'RUNNING' };
  } catch (err) {
    const msg = (err as Error)?.message ?? 'solve failed';
    await markDone(key, 'FAILED', null, msg);
    return { status: 'FAILED', error: msg };
  }
}

/** Abandon a deferred solve so it stops holding a warehouse slot. */
export async function abandonSolve(key: string): Promise<void> {
  const row = await readSolve(key);
  if (row?.handle && row.status === 'RUNNING') {
    await cancelHandle(row.handle);
    await markDone(key, 'FAILED', null, 'cancelled by caller');
  }
}
