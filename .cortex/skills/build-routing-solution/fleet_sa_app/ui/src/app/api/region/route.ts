import { NextResponse } from 'next/server';
import { query, run } from '@/lib/snowflake';
import { logger } from '@/lib/logger';
import { withLogging } from '@/lib/api-handler';
import { getServerConfig } from '@/lib/server-config';

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

function resolveSchemas(cfg: ResolvedRegion, requested?: string[]): string[] {
  if (!requested || requested.length === 0) return [cfg.schemas[0]];
  const out: string[] = [];
  for (const raw of requested) {
    const s = String(raw).trim().toUpperCase();
    if (IDENT.test(s) && cfg.schemas.includes(s)) out.push(s);
  }
  return out.length > 0 ? out : [cfg.schemas[0]];
}

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

async function handlePost(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const cfg = resolveRegion();

  // Build SET pairs for any body key matching a known contextBar field id with
  // a non-empty string value. (`schemas` is a control key, not a context value.)
  const sets: string[] = [];
  const binds: (string | number | null)[] = [];
  const applied: Record<string, string> = {};
  for (const [fieldId, col] of Object.entries(cfg.contextColumns)) {
    const v = body[fieldId];
    if (typeof v === 'string' && v.length > 0) {
      sets.push(`${col} = ?`);
      binds.push(v);
      applied[fieldId] = v;
    }
  }

  if (sets.length === 0) {
    return NextResponse.json(
      { error: `Provide at least one context value (${Object.keys(cfg.contextColumns).join(', ')})` },
      { status: 400 },
    );
  }

  const schemas = resolveSchemas(cfg, Array.isArray(body.schemas) ? (body.schemas as string[]) : undefined);
  const updated: Record<string, number> = {};
  try {
    for (const schema of schemas) {
      const n = await run(`UPDATE ${cfg.db}.${schema}.CONFIG SET ${sets.join(', ')}`, binds);
      updated[schema] = n;
    }
    return NextResponse.json({ ok: true, applied, updated });
  } catch (err) {
    logger.error('region-set', { schemas, applied }, err);
    return NextResponse.json({ error: 'Failed to set active context' }, { status: 500 });
  }
}

export const GET = withLogging(handleGet);
export const POST = withLogging(handlePost);
