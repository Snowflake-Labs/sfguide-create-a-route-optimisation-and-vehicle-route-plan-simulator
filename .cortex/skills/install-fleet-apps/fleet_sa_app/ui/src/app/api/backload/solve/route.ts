import { NextResponse } from 'next/server';
import { query } from '@/lib/snowflake';
import { logger } from '@/lib/logger';
import { withLogging } from '@/lib/api-handler';

// Backload Matching solver endpoint.
//
// The Backload Matching page builds a bespoke VROOM challenge (idle trailers as
// vehicles with multi-dim capacity / skills / max_travel_time, internal loads +
// external offers as shipments with amount / priority) and posts it here. We call
// the neutral routing seam ROUTING_PLATFORM.CONTRACT._DISPATCH_OPTIMIZATION - the
// RAW scalar form that returns the full VROOM response as a VARIANT. This avoids
// the TVF OPTIMIZATION() "0-row trap" (its LATERAL FLATTEN(resp:routes) yields no
// rows when a solve returns zero routes or a structured error), and it keeps the
// page on the engine-agnostic contract (Tenet 1) rather than touching the engine
// schema directly. The challenge is passed as a bound PARSE_JSON literal so free
// text / large payloads never break SQL parsing.
//
// Body: { challenge: <VROOM challenge object>, region?: string }
// Returns: { ok: true, result: <raw VROOM response> } | { error }

async function handlePost(req: Request) {
  let body: { challenge?: unknown; region?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const challenge = body.challenge;
  if (!challenge || typeof challenge !== 'object') {
    return NextResponse.json({ error: 'challenge (VROOM object) is required' }, { status: 400 });
  }
  const region =
    typeof body.region === 'string' && body.region.trim() ? body.region.trim() : null;

  try {
    const rows = await query(
      `SELECT ROUTING_PLATFORM.CONTRACT._DISPATCH_OPTIMIZATION(PARSE_JSON(?), ?, NULL) AS RESP`,
      [JSON.stringify(challenge), region],
    );
    const raw = rows[0] ? (Object.values(rows[0])[0] as unknown) : null;
    let result: unknown = raw;
    if (typeof raw === 'string') {
      try { result = JSON.parse(raw); } catch { /* leave as string */ }
    }
    // Surface a solver-side failure (e.g. VROOM unreachable, unroutable point)
    // as a 502 so the page can show the reason instead of an empty plan.
    const errObj = result as { error?: unknown; message?: unknown } | null;
    if (errObj && typeof errObj === 'object' && 'error' in errObj && errObj.error) {
      const msg = typeof errObj.message === 'string' ? errObj.message : String(errObj.error);
      return NextResponse.json({ error: `solver: ${msg}`, result }, { status: 502 });
    }
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    logger.error('backload-solve', {}, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Backload solve failed' },
      { status: 500 },
    );
  }
}

export const POST = withLogging(handlePost);
