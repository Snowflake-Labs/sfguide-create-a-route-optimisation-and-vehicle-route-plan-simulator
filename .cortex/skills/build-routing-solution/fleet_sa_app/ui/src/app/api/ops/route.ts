import { NextResponse } from 'next/server';
import { query } from '@/lib/snowflake';
import { logger } from '@/lib/logger';
import { withLogging } from '@/lib/api-handler';

// Ops console backend. Calls the OPS-bundle synapse verbs (FLEET_OPS_MCP) in
// FLEET_INTELLIGENCE.SYNAPSE_OPS. Verb + arity are allowlisted; a trailing NULL
// idempotency key is appended (synapse procs end with IDEMPOTENCY_KEY). The same
// verbs are reachable by the role-gated FLEET_OPS_AGENT; this route powers the
// in-app Ops console. Access is gated by the app/service role (FLEET_APP_OPS in
// production, Phase 3E).

const SCHEMA = 'FLEET_INTELLIGENCE.SYNAPSE_OPS';

// verb -> number of business args (excluding the trailing IDEMPOTENCY_KEY).
const VERBS: Record<string, number> = {
  set_active_region: 1,
  service_control: 2,
  service_status: 1,
  healthcheck: 0,
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
    logger.error('ops-call', { verb }, err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Ops call failed' }, { status: 500 });
  }
}

export const POST = withLogging(handlePost);
