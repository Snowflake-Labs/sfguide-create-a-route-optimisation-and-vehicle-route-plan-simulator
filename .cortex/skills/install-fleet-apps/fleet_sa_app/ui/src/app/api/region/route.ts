import { NextResponse } from 'next/server';
import { query } from '@/lib/snowflake';
import { logger } from '@/lib/logger';
import { withLogging } from '@/lib/api-handler';
import { getServerConfig } from '@/lib/server-config';
import { requireOps } from '@/lib/ingress-identity';

// Hybrid context endpoint (Step 2A, genericized in Step 4A).
//
// The contextBar drives a client-side `:param` (context.<fieldId>) that
// auto-refetches dependent dashboard views. This endpoint is the SERVER-SIDE
// half of the "Hybrid" decision: it writes the per-schema CONFIG single-row
// table so projection views reading `(SELECT <col> FROM CONFIG LIMIT 1)` and
// the routing tool layer observe the SAME active context as the dashboards.
//
// What used to be hardcoded (DB = FLEET_INTELLIGENCE, columns REGION /
// VEHICLE_TYPE) is now config-driven: the database + schema allowlist come
// from app-config.json `region`, and the context column set is derived from
// the `contextBar` entries that carry a `configColumn`. The fleet literals
// below are the fallback when config is absent.
//
// Schema + column names cannot be parameter-bound (they are identifiers), so
// each is validated against a strict regex (and schemas against an allowlist)
// before interpolation. Values ARE bound.

const DEFAULT_DB = 'FLEET_INTELLIGENCE';
const DEFAULT_SCHEMAS = ['DWELL_ANALYSIS', 'ROUTE_DEVIATION', 'ROUTE_OPTIMIZATION'];
// Used only when config has no contextBar with configColumns.
const DEFAULT_CONTEXT_COLUMNS: Record<string, string> = {
  region: 'REGION',
  vehicle_type: 'VEHICLE_TYPE',
};

const IDENT = /^[A-Z_][A-Z0-9_]*$/;

interface ResolvedRegion {
  db: string;
  schemas: string[];
  // contextBar field id -> CONFIG column name (uppercased).
  contextColumns: Record<string, string>;
}

function resolveRegion(): ResolvedRegion {
  const cfg = getServerConfig();

  const db = cfg.region?.database ?? DEFAULT_DB;

  // Schema allowlist: env override (neutral name + back-compat alias) wins,
  // then config, then the fleet default.
  const envSchemas = process.env.CONTEXT_CONFIG_SCHEMAS ?? process.env.FLEET_CONFIG_SCHEMAS;
  const rawSchemas = envSchemas ? envSchemas.split(',') : cfg.region?.schemas ?? DEFAULT_SCHEMAS;
  const schemas = rawSchemas.map((s) => s.trim().toUpperCase()).filter((s) => IDENT.test(s));

  // Context columns from contextBar entries that declare a configColumn.
  const contextColumns: Record<string, string> = {};
  for (const f of cfg.contextBar ?? []) {
    if (f.configColumn && IDENT.test(f.configColumn.toUpperCase())) {
      contextColumns[f.id] = f.configColumn.toUpperCase();
    }
  }

  return {
    db,
    schemas: schemas.length > 0 ? schemas : DEFAULT_SCHEMAS,
    contextColumns: Object.keys(contextColumns).length > 0 ? contextColumns : DEFAULT_CONTEXT_COLUMNS,
  };
}

const DEFAULT_OPS_SCHEMA = 'FLEET_INTELLIGENCE.SYNAPSE_OPS';
// Verb name (in the ops schema) is fixed; only region/vehicle_type are bound.
const VERB = 'set_active_context';

async function handleGet() {
  const cfg = resolveRegion();
  const schema = cfg.schemas[0];
  const fields = Object.entries(cfg.contextColumns); // [fieldId, COLUMN]
  const cols = fields.map(([, col]) => col).join(', ');
  try {
    const rows = await query<Record<string, string>>(`SELECT ${cols} FROM ${cfg.db}.${schema}.CONFIG LIMIT 1`);
    const row = rows[0] ?? {};
    const context: Record<string, string | null> = {};
    for (const [fieldId, col] of fields) {
      context[fieldId] = row[col] ?? null;
    }
    // Legacy top-level keys for any existing consumer.
    return NextResponse.json({
      schema,
      context,
      region: context.region ?? null,
      vehicle_type: context.vehicle_type ?? null,
    });
  } catch (err) {
    logger.error('region-get', { schema }, err);
    return NextResponse.json({ error: 'Failed to read active context' }, { status: 500 });
  }
}

// POST promotes the SHARED per-schema CONFIG (the GLOBAL active scope). As of R3/R4
// this is an OPS/ADMIN-only "promote active scope" action — consumers do per-session
// selection via the contextBar (which no longer calls this) + scope-arg functions.
//
// The mutation now flows through the audited synapse verb set_active_context
// (Tenet 7) instead of a raw UPDATE: the verb writes the CONFIG tables inside the
// envelope (recorded in VERB_ATTEMPT) and rejects an unprovisioned region. Only
// region / vehicle_type are accepted (the two real contextBar config columns);
// the verb owns the dashboard-schema fan-out.
async function handlePost(req: Request) {
  const g = await requireOps(req);
  if (!g.ok) {
    logger.warn('region-set-denied', { user: g.user, roles: g.roles, reason: g.reason });
    return NextResponse.json({ error: g.reason ?? 'Forbidden' }, { status: g.status });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const region = typeof body.region === 'string' && body.region.trim() ? body.region.trim() : null;
  const vehicleType =
    typeof body.vehicle_type === 'string' && body.vehicle_type.trim() ? body.vehicle_type.trim() : null;

  if (!region && !vehicleType) {
    return NextResponse.json({ error: 'Provide at least one context value (region, vehicle_type)' }, { status: 400 });
  }

  // Optional client-supplied idempotency key (opt-in replay safety; A1 pattern).
  const idemKey =
    typeof body.idempotency_key === 'string' && body.idempotency_key.trim() ? body.idempotency_key.trim() : null;

  const opsSchema = getServerConfig().ops?.schema ?? DEFAULT_OPS_SCHEMA;
  try {
    // CALL <opsSchema>.set_active_context(region, vehicle_type, IDEMPOTENCY_KEY)
    const rows = await query(`CALL ${opsSchema}.${VERB}(?, ?, ?)`, [region, vehicleType, idemKey]);
    const raw = rows[0] ? Object.values(rows[0] as Record<string, unknown>)[0] : null;
    let result: unknown = raw;
    if (typeof raw === 'string') {
      try {
        result = JSON.parse(raw);
      } catch {
        /* leave as string */
      }
    }
    const r = (result ?? {}) as { applied?: Record<string, string>; updated?: Record<string, number> };
    return NextResponse.json({ ok: true, applied: r.applied ?? {}, updated: r.updated ?? {} });
  } catch (err) {
    logger.error('region-set', { region, vehicleType }, err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed to set active context' }, { status: 500 });
  }
}

export const GET = withLogging(handleGet);
export const POST = withLogging(handlePost);
