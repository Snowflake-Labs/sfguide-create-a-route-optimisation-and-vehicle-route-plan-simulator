import { NextResponse } from 'next/server';
import { query, buildCallArgs } from '@/lib/snowflake';
import { runSolve } from '@/lib/solve-runner';
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
  // Backload matching. These are the seam that keeps the cockpits and the agent on
  // ONE implementation: the same procedures back the MCP tools, so a plan drawn on
  // screen and a plan the agent describes cannot diverge.
  // Arity excludes the trailing IDEMPOTENCY_KEY, as above.
  backload_solve: 6,
  backload_chain_solve: 6,
};

// Verbs that run an optimisation/solve rather than a read. These go to the BATCH
// warehouse. Kept as an explicit set rather than a name heuristic: `*_solve` would
// have missed delivery_optimization / network_optimization / optimize_routes, and
// a heuristic that misses cases silently is how the original misrouting survived.
const SOLVER_VERBS = new Set([
  'optimize_routes',
  'delivery_optimization',
  'network_optimization',
  'evac_seed',
  'evac_solve',
  'backload_solve',
  'backload_chain_solve',
]);

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

  // Placeholders + binds together, so a null argument becomes a literal NULL in
  // the CALL instead of a bound empty string. Binding '' into a numeric verb
  // parameter fails with `Numeric value '' is not recognized` before the
  // procedure runs, which is what killed every Triangle Proposals load.
  const { placeholders, binds } = buildCallArgs([
    ...args.map((a) => (a == null ? null : typeof a === 'number' ? a : String(a))),
    idemKey,
  ]);

  try {
    // Solver verbs run a full VRP inside the procedure. Two separate problems,
    // two separate fixes:
    //
    //  1. STARVATION - a synchronous solve holds a warehouse slot for its whole
    //     duration, and on an X-Small (MAX_CONCURRENCY_LEVEL 8) a few concurrent
    //     solves starved the dashboard reads sharing the interactive warehouse.
    //     Fixed by putting solves on the batch warehouse.
    //  2. THE CEILING - measured server-side, the DEFAULT 20 vehicles / 120 loads
    //     takes 38.1s and 100/500 takes 168.6s, against a synchronous transport
    //     that gives up at 60s and a statement capped at 80s to stay under the
    //     ~90s SPCS ingress limit. Fixed HERE by submitting async and waiting
    //     inline for 45s, so a fast solve still answers in one call and a slow
    //     one returns a key to poll instead of a timeout.
    //
    // Read-only verbs (find_poi, get_directions, compute_isochrone, catchment,
    // ...) stay fully synchronous and interactive: a user or the agent is waiting
    // on a single fast call, and routing them through a solve key would make every
    // cheap lookup a two-request round trip.
    if (SOLVER_VERBS.has(verb)) {
      const outcome = await runSolve(
        verb,
        `CALL ${schema}.${verb}(${placeholders})`,
        binds as (string | number | null)[],
        // The solve key is derived from these, so two callers asking the same
        // question share one solve. idemKey is included because it changes what
        // the procedure does (it engages the synapse replay guard), so two calls
        // that differ only by key must not collide on one cached result.
        { verb, args, schema, idemKey },
        null,
      );
      if (outcome.pending) {
        // 202, not an error. The solve is still running server-side; the caller
        // collects it from /api/solve-status?key=... This is the case that used to
        // surface as "Statement timed out after 60s".
        return NextResponse.json(
          {
            pending: true,
            verb,
            solve_key: outcome.solveKey,
            poll_url: `/api/solve-status?key=${encodeURIComponent(outcome.solveKey)}`,
            message:
              `The ${verb} solve is still running. Poll /api/solve-status with this ` +
              `solve_key to collect the result.`,
          },
          { status: 202 },
        );
      }
      const solverRows = (outcome.rows ?? []) as Record<string, unknown>[];
      const solverRow = solverRows[0];
      const solverRaw = solverRow ? Object.values(solverRow)[0] : null;
      let solverResult: unknown = solverRaw;
      if (typeof solverRaw === 'string') {
        try { solverResult = JSON.parse(solverRaw); } catch { /* leave as string */ }
      }
      // The synapse idempotency guard returns `{replayed: true, result_hash}`
      // with NO payload when a key is reused - it is a double-execution guard,
      // not a result cache. Treating that as a successful solve would render an
      // empty plan and, worse, persist it as this key's result. Verified against
      // a live account: a replayed backload_solve returns exactly
      // {"replayed": true, "result_hash": "08ef79..."}.
      const replayed = solverResult
        && typeof solverResult === 'object'
        && (solverResult as { replayed?: unknown }).replayed === true;
      if (replayed) {
        logger.warn('tool-call-idempotent-replay', { verb, idemKey });
        return NextResponse.json(
          {
            error:
              `${verb} was rejected as a duplicate of an earlier call with the same ` +
              `idempotency_key, so no plan was returned. Retry without ` +
              `idempotency_key, or with a new one, to get a fresh solve.`,
            reason: 'IDEMPOTENT_REPLAY',
            verb,
            result: solverResult,
          },
          { status: 409 },
        );
      }
      const sdet = detectSuspendedInResult(solverResult);
      const sdetRegion = sdet.suspended ? resolveResumeRegion(sdet.region, regionHint) : null;
      if (sdetRegion) {
        const payload = await resumeAndBuildPayload(sdetRegion, sdet.kind, sdet.state);
        return NextResponse.json(payload, { status: 503 });
      }
      return NextResponse.json({ ok: true, verb, result: solverResult, cached: outcome.cached ?? false });
    }

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
