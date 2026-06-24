import { NextResponse } from 'next/server';
import { query } from '@/lib/snowflake';
import { logger } from '@/lib/logger';
import { withLogging } from '@/lib/api-handler';
import { getServerConfig } from '@/lib/server-config';
import { requireOps } from '@/lib/ingress-identity';

// Ops console backend. Calls the OPS-bundle synapse verbs (the ops MCP) in the
// ops schema. Verb + arity are allowlisted; the trailing synapse IDEMPOTENCY_KEY
// is bound from the request (opt-in): a client may send `idempotency_key` to make
// a mutating verb (e.g. service_control) replay-safe within the envelope's 24h
// window; when omitted it binds NULL (no replay check). The same verbs are
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
  service_inventory: 0,
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
  // R3: enforce OPS/ADMIN at the surface via SPCS ingress identity. The app runs
  // as the service identity, so without this a consumer could call ops verbs.
  const g = await requireOps(req);
  if (!g.ok) {
    logger.warn('ops-denied', { user: g.user, roles: g.roles, reason: g.reason });
    return NextResponse.json({ error: g.reason ?? 'Forbidden' }, { status: g.status });
  }

  let body: { verb?: string; args?: unknown[]; idempotency_key?: unknown };
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

  // Opt-in idempotency: bind the client-supplied key (if any) into the trailing
  // synapse IDEMPOTENCY_KEY param; otherwise bind NULL (no replay check).
  const idemKey =
    typeof body.idempotency_key === 'string' && body.idempotency_key.trim()
      ? body.idempotency_key.trim()
      : null;

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
    return NextResponse.json({ ok: true, verb, result });
  } catch (err) {
    logger.error('ops-call', { verb }, err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Ops call failed' }, { status: 500 });
  }
}

export const POST = withLogging(handlePost);
