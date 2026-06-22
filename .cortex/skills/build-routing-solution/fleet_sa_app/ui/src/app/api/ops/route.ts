import { NextResponse } from 'next/server';
import { query } from '@/lib/snowflake';
import { logger } from '@/lib/logger';
import { withLogging } from '@/lib/api-handler';
import { getServerConfig } from '@/lib/server-config';

// Ops console backend. Calls the OPS-bundle synapse verbs (the ops MCP) in the
// ops schema. Verb + arity are allowlisted; a trailing NULL idempotency key is
// appended (synapse procs end with IDEMPOTENCY_KEY). The same verbs are
// reachable by the role-gated ops agent; this route powers the in-app Ops
// console. The schema + verb allowlist come from app-config.json `ops` (env
// APP_CONFIG); the fleet literals below are the fallback when absent. Access is
// gated by the app/service role (FLEET_APP_OPS in production, Phase 3E).

const DEFAULT_SCHEMA = 'FLEET_INTELLIGENCE.SYNAPSE_OPS';

// verb -> number of business args (excluding the trailing IDEMPOTENCY_KEY).
const DEFAULT_VERBS: Record<string, number> = {
  set_active_region: 1,
  service_control: 2,
  service_status: 1,
  healthcheck: 0,
};

function resolveOps(): { schema: string; verbs: Record<string, number> } {
  const cfg = getServerConfig().ops;
  return {
    schema: cfg?.schema ?? DEFAULT_SCHEMA,
    verbs: cfg?.verbs ?? DEFAULT_VERBS,
  };
}

async function handlePost(req: Request) {
  let body: { verb?: string; args?: unknown[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const verb = String(body.verb ?? '');
  const { schema, verbs } = resolveOps();
  if (!(verb in verbs)) {
    return NextResponse.json({ error: `Unknown verb: ${verb}` }, { status: 400 });
  }
  const arity = verbs[verb]!;
  const args = Array.isArray(body.args) ? body.args : [];
  if (args.length !== arity) {
    return NextResponse.json({ error: `${verb} expects ${arity} args, got ${args.length}` }, { status: 400 });
  }

  const placeholders = [...args.map(() => '?'), 'NULL'].join(', ');
  const binds = args.map((a) => (a == null ? null : typeof a === 'number' ? a : String(a)));

  try {
    const rows = await query(`CALL ${schema}.${verb}(${placeholders})`, binds as (string | number | null)[]);
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
