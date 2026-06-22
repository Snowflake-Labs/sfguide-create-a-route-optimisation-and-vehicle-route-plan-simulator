import { NextResponse } from 'next/server';
import { query } from '@/lib/snowflake';
import { logger } from '@/lib/logger';
import { withLogging } from '@/lib/api-handler';

// Calls a User-bundle synapse routing proc (FLEET_USER_MCP verbs) for the Tier-3
// showcase pages (VRP simulator, Emergency wizard). The agent uses the same
// procs via FLEET_USER_MCP; these pages call them directly with explicit args.
// Verb + arity are allowlisted; a trailing NULL idempotency key is appended.

const SCHEMA = 'FLEET_INTELLIGENCE.SYNAPSE_USER';

// verb -> number of business args (excluding the trailing IDEMPOTENCY_KEY).
const VERBS: Record<string, number> = {
  optimize_routes: 5,
  compute_isochrone: 3,
  get_directions: 2,
  find_poi: 5,
  pharma_catchment: 3,
  pharma_optimization: 1,
  supply_chain: 1,
};

async function handlePost(req: Request) {
  let body: { verb?: string; args?: unknown[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const verb = String(body.verb ?? '');
  if (!(verb in VERBS)) {
    return NextResponse.json({ error: `Unknown verb: ${verb}` }, { status: 400 });
  }
  const arity = VERBS[verb]!;
  const args = Array.isArray(body.args) ? body.args : [];
  if (args.length !== arity) {
    return NextResponse.json({ error: `${verb} expects ${arity} args, got ${args.length}` }, { status: 400 });
  }

  // Build placeholders: business args + trailing NULL idempotency key.
  const placeholders = [...args.map(() => '?'), 'NULL'].join(', ');
  const binds = args.map((a) => (a == null ? null : typeof a === 'number' ? a : String(a)));

  try {
    const rows = await query(`CALL ${SCHEMA}.${verb}(${placeholders})`, binds as (string | number | null)[]);
    const row = rows[0] as Record<string, unknown> | undefined;
    const raw = row ? Object.values(row)[0] : null;
    let result: unknown = raw;
    if (typeof raw === 'string') {
      try { result = JSON.parse(raw); } catch { /* leave as string */ }
    }
    return NextResponse.json({ ok: true, verb, result });
  } catch (err) {
    logger.error('tool-call', { verb }, err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Tool call failed' }, { status: 500 });
  }
}

export const POST = withLogging(handlePost);
