// Client side of the deferred-solve protocol.
//
// A solver route answers in one of two ways:
//   200 { ok, result }                  - finished inside the 45s inline wait
//   202 { pending, solve_key, poll_url } - still running server-side
//
// This helper hides that split so a caller writes one await and gets a result.
//
// WHY THIS EXISTS: measured server-side, the DEFAULT backload solve takes 38.1s
// and a 100-vehicle / 500-load solve takes 168.6s, while the synchronous
// transport gave up at 60s. This page already allowed 180s (BM_SOLVE_TIMEOUT_MS)
// so the wait was never the client's problem - the server simply could not hold a
// request open that long, because the statement is capped at 80s to stay under
// the ~90s SPCS ingress limit.
//
// Cancellation is real here. When the caller aborts, we DELETE the solve so the
// statement is cancelled in Snowflake and stops holding a warehouse slot;
// previously an aborted client left the solve running to completion unseen.

const POLL_INTERVAL_MS = 2_000;

export interface DeferredSolveResult {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
  /** True when the answer arrived via polling rather than inline. */
  deferred: boolean;
}

/**
 * POST a solve and, if it is deferred, poll until it finishes.
 *
 * `onProgress` is called with elapsed seconds while waiting, so the caller can
 * say "still solving (72s)" instead of appearing hung - a 168s solve with no
 * feedback is indistinguishable from a stuck page.
 */
export async function postSolve(
  url: string,
  payload: unknown,
  signal?: AbortSignal,
  onProgress?: (elapsedSec: number, solveKey: string) => void,
): Promise<DeferredSolveResult> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  const body = (await res.json()) as Record<string, unknown>;

  if (res.status !== 202 || !body?.solve_key) {
    return { ok: res.ok, status: res.status, body, deferred: false };
  }

  const solveKey = String(body.solve_key);
  const pollUrl = `/api/solve-status?key=${encodeURIComponent(solveKey)}`;
  const startedAt = Date.now();

  // Abort must cancel the SERVER-side statement, not just stop listening.
  const onAbort = () => {
    void fetch(pollUrl, { method: 'DELETE', keepalive: true }).catch(() => {});
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  // Hard stop even without a caller signal, so a wedged solve cannot poll
  // forever. Generous relative to the worst measured solve (168.6s).
  const pollDeadline = Date.now() + 300_000;

  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (Date.now() > pollDeadline) {
        void fetch(pollUrl, { method: 'DELETE', keepalive: true }).catch(() => {});
        throw new Error('Solve did not finish within 300s; it has been cancelled.');
      }

      const pr = await fetch(pollUrl, signal ? { signal } : {});
      const pb = (await pr.json()) as Record<string, unknown>;

      // 202 = still running. Anything else is terminal: success, failure, or a
      // 404 for an unknown key (which must stop the loop rather than spin).
      if (pr.status === 202) {
        onProgress?.(Math.round((Date.now() - startedAt) / 1000), solveKey);
        continue;
      }
      return { ok: pr.ok, status: pr.status, body: pb, deferred: true };
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
