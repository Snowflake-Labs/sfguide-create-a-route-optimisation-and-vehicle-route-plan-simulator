import { NextResponse } from 'next/server';
import { query } from '@/lib/snowflake';
import { logger } from '@/lib/logger';
import { withLogging } from '@/lib/api-handler';
import { getServerConfig } from '@/lib/server-config';
import { detectOrsSuspended, detectSuspendedInResult } from '@/lib/routing-suspend';
import { resolveResumeRegion, resumeAndBuildPayload } from '@/lib/routing-resume';

// Calls a User-bundle synapse routing proc (the routing MCP verbs) for the
// Tier-3 showcase pages (VRP simulator, Emergency wizard). The agent uses the
// same procs via its MCP server; these pages call them directly with explicit
// args. Verb + arity are allowlisted; the trailing synapse IDEMPOTENCY_KEY is
// bound from the request (opt-in): a client may send `idempotency_key` to make
// a call replay-safe (the envelope returns the prior result within a 24h window
// instead of re-executing). When omitted it binds NULL (no replay check), so
// behavior is unchanged for callers that do not opt in. The schema + verb
// allowlist come from app-config.json `tools` (env APP_CONFIG); the fleet
// literals below are the fallback when absent.

const DEFAULT_SCHEMA = 'FLEET_INTELLIGENCE.SYNAPSE_USER';

// verb -> number of business args (excluding the trailing IDEMPOTENCY_KEY).
const DEFAULT_VERBS: Record<string, number> = {
  optimize_routes: 5,
  compute_isochrone: 3,
  get_directions: 2,
  find_poi: 5,
  catchment: 3,
  delivery_optimization: 1,
  network_optimization: 1,
  evac_seed: 4,
  evac_solve: 2,
};

function resolveTools(): { schema: string; verbs: Record<string, number> } {
  const cfg = getServerConfig().tools;
  return {
    schema: cfg?.schema ?? DEFAULT_SCHEMA,
    verbs: cfg?.verbs ?? DEFAULT_VERBS,
  };
}

async function handlePost(req: Request) {
  let body: { verb?: string; args?: unknown[]; idempotency_key?: unknown; region?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const verb = String(body.verb ?? '');
  const regionHint =
    typeof body.region === 'string' && body.region.trim() ? body.region.trim() : null;
  const { schema, verbs } = resolveTools();
  if (!(verb in verbs)) {
    return NextResponse.json({ error: `Unknown verb: ${verb}` }, { status: 400 });
  }
  const arity = verbs[verb]!;
  const args = Array.isArray(body.args) ? body.args : [];
  if (args.length !== arity) {
    return NextResponse.json({ error: `${verb} expects ${arity} args, got ${args.length}` }, { status: 400 });
  }

  // Opt-in idempotency: bind the client-supplied key (if any) into the trailing
  // synapse IDEMPOTENCY_KEY param; otherwise bind NULL (no replay check).
  const idemKey =
    typeof body.idempotency_key === 'string' && body.idempotency_key.trim()
      ? body.idempotency_key.trim()
      : null;

  // Build placeholders: business args + trailing idempotency key (bound, not literal).
  const placeholders = [...args.map(() => '?'), '?'].join(', ');
  const binds = [
    ...args.map((a) => (a == null ? null : typeof a === 'number' ? a : String(a))),
    idemKey,
  ];

  try {
    const rows = await query(`CALL ${schema}.${verb}(${placeholders})`, binds as (string | number | null)[]);
    const row = rows[0] as Record<string, unknown> | undefined;
    const raw = row ? Object.values(row)[0] : null;
    let result: unknown = raw;
    if (typeof raw === 'string') {
      try { result = JSON.parse(raw); } catch { /* leave as string */ }
    }
    // A routing verb may succeed at the SQL level but return a typed
    // "OPTIMIZATION_UNAVAILABLE" result when the region's ORS/VROOM service is
    // suspended. Resume it and return the friendly notice instead of the raw shape.
    const det = detectSuspendedInResult(result);
    const detRegion = det.suspended ? resolveResumeRegion(det.region, regionHint) : null;
    if (detRegion) {
      const payload = await resumeAndBuildPayload(detRegion, det.kind, det.state);
      return NextResponse.json(payload, { status: 503 });
    }
    return NextResponse.json({ ok: true, verb, result });
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : 'Tool call failed';
    const det = detectOrsSuspended(rawMsg);
    const resumeRegion = det.suspended ? resolveResumeRegion(det.region, regionHint) : null;
    if (resumeRegion) {
      const payload = await resumeAndBuildPayload(resumeRegion, det.kind, det.state);
      return NextResponse.json(payload, { status: 503 });
    }
    logger.error('tool-call', { verb }, err);
    return NextResponse.json({ error: rawMsg }, { status: 500 });
  }
}

export const POST = withLogging(handlePost);
