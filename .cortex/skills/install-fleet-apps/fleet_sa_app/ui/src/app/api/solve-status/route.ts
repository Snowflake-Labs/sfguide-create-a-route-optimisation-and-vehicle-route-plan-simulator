import { NextResponse } from 'next/server';
import { collectSolve, abandonSolve } from '@/lib/solve-runner';
import { logger } from '@/lib/logger';
import { withLogging } from '@/lib/api-handler';
import { requireUser } from '@/lib/ingress-identity';

// Collect (or abandon) a solve that outlived its request.
//
// A solve is submitted asynchronously and waited on inline for up to 45s. Past
// that the submitting route returns 202 { pending: true, solve_key } and the
// client polls here. Measured server-side, a 100-vehicle / 500-load solve takes
// 168.6s against a synchronous transport that gives up at 60s, so for those the
// only way to return a result at all is to stop holding the request open.
//
// GET  /api/solve-status?key=...  -> 202 running | 200 result | 502 failed | 404
// DELETE /api/solve-status?key=...-> cancel it so it stops holding a warehouse slot

async function handleGet(req: Request) {
  const g = await requireUser(req);
  if (!g.ok) return NextResponse.json({ error: g.reason ?? 'Forbidden' }, { status: g.status });

  const key = new URL(req.url).searchParams.get('key');
  if (!key) return NextResponse.json({ error: 'key is required' }, { status: 400 });

  const out = await collectSolve(key);
  // Unknown key. Distinguished from "running" on purpose: a client polling a key
  // that no longer exists must stop rather than spin forever.
  if (!out) {
    return NextResponse.json({ error: 'unknown solve key', reason: 'UNKNOWN_KEY' }, { status: 404 });
  }
  if (out.status === 'RUNNING') {
    return NextResponse.json({ pending: true, solve_key: key }, { status: 202 });
  }
  if (out.status === 'FAILED') {
    logger.warn('solve-status-failed', { key, error: out.error });
    return NextResponse.json({ error: out.error, solve_key: key }, { status: 502 });
  }
  // Normalise to the SAME shape the inline routes return.
  //
  // This is load-bearing. Both solver routes answer inline with the first column
  // of the first row, JSON-parsed:
  //   /api/tool            -> { ok, verb, result: <parsed proc JSON> }
  //   /api/backload/solve  -> { ok, result: <raw VROOM response> }
  // Returning the raw ROW ARRAY here instead would mean a deferred solve handed
  // the caller `[{ BACKLOAD_SOLVE: "{...}" }]` where the inline path handed it
  // `{ routes: [...] }`. Callers unwrap one level (`result.result`), so the
  // mismatch would not throw - it would silently produce an empty plan, which is
  // exactly the failure mode this whole change exists to remove.
  return NextResponse.json({ ok: true, solve_key: key, result: normaliseRows(out.rows) });
}

/** First column of the first row, JSON-parsed when it is a JSON string. */
function normaliseRows(rows: unknown[]): unknown {
  const first = rows?.[0] as Record<string, unknown> | undefined;
  if (!first) return null;
  const raw = Object.values(first)[0] ?? null;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  return raw;
}

async function handleDelete(req: Request) {
  const g = await requireUser(req);
  if (!g.ok) return NextResponse.json({ error: g.reason ?? 'Forbidden' }, { status: g.status });

  const key = new URL(req.url).searchParams.get('key');
  if (!key) return NextResponse.json({ error: 'key is required' }, { status: 400 });
  await abandonSolve(key);
  return NextResponse.json({ ok: true, cancelled: key });
}

export const GET = withLogging(handleGet);
export const DELETE = withLogging(handleDelete);
