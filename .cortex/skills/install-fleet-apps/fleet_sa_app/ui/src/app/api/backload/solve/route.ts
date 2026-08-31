import { NextResponse } from 'next/server';
import { query } from '@/lib/snowflake';
import { logger } from '@/lib/logger';
import { withLogging } from '@/lib/api-handler';
import { requireUser } from '@/lib/ingress-identity';
import { detectOrsSuspended, detectSuspendedInResult } from '@/lib/routing-suspend';
import { resolveResumeRegion, resumeAndBuildPayload } from '@/lib/routing-resume';

// Max serialized challenge size forwarded to the solver. VROOM's own body-parser
// limit is 50mb (for large precomputed matrices), but a matrix-free challenge
// posted from the UI is tiny; cap well under that to reject abusive/oversized
// payloads before they reach the contract.
const MAX_CHALLENGE_BYTES = 2_000_000;

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
  // Solver path: require an authenticated ingress identity (fail-closed when
  // deployed) so the routing engine cannot be driven anonymously.
  const g = await requireUser(req);
  if (!g.ok) {
    logger.warn('backload-solve-denied', { user: g.user, reason: g.reason });
    return NextResponse.json({ error: g.reason ?? 'Forbidden' }, { status: g.status });
  }

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
  const challengeJson = JSON.stringify(challenge);
  if (challengeJson.length > MAX_CHALLENGE_BYTES) {
    return NextResponse.json(
      { error: `challenge too large (${challengeJson.length} bytes, max ${MAX_CHALLENGE_BYTES})` },
      { status: 413 },
    );
  }
  const region =
    typeof body.region === 'string' && body.region.trim() ? body.region.trim() : null;

  try {
    const rows = await query(
      `SELECT ROUTING_PLATFORM.CONTRACT._DISPATCH_OPTIMIZATION(PARSE_JSON(?), ?, NULL) AS RESP`,
      [challengeJson, region],
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
      // Suspended routing engine: the region's ORS/VROOM service is down (DNS
      // failure inside the gateway). Resume it and return a typed, friendly
      // notice instead of the raw connection error.
      const det = detectOrsSuspended(msg);
      const detResult = det.suspended ? det : detectSuspendedInResult(result);
      const resumeRegion = detResult.suspended ? resolveResumeRegion(detResult.region, region) : null;
      if (resumeRegion) {
        const payload = await resumeAndBuildPayload(resumeRegion, detResult.kind, detResult.state);
        return NextResponse.json(payload, { status: 503 });
      }
      // VROOM code 3 aborts the whole solve when a single location cannot be
      // routed (e.g. a point snapped onto a disconnected road component). It
      // names the offending coordinate: "Unfound route(s) from location
      // [lon,lat]". Parse it structurally so the page can drop just that
      // shipment/vehicle and re-solve the remainder instead of failing wholesale.
      let unroutable: { lon: number; lat: number } | undefined;
      const m = /location\s*\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/i.exec(msg);
      if (m) unroutable = { lon: Number(m[1]), lat: Number(m[2]) };
      return NextResponse.json({ error: `solver: ${msg}`, result, unroutable }, { status: 502 });
    }
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : 'Backload solve failed';
    // A suspended ORS/VROOM service can also surface as a thrown SQL/HTTP error.
    const det = detectOrsSuspended(rawMsg);
    const resumeRegion = det.suspended ? resolveResumeRegion(det.region, region) : null;
    if (resumeRegion) {
      const payload = await resumeAndBuildPayload(resumeRegion, det.kind, det.state);
      return NextResponse.json(payload, { status: 503 });
    }
    logger.error('backload-solve', {}, err);
    return NextResponse.json(
      { error: rawMsg },
      { status: 500 },
    );
  }
}

export const POST = withLogging(handlePost);
