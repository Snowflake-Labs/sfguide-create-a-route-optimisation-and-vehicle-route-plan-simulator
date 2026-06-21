import { NextResponse } from 'next/server';
import { query, run } from '@/lib/snowflake';
import { logger } from '@/lib/logger';
import { withLogging } from '@/lib/api-handler';

// Hybrid region/vehicle context endpoint (Step 2A).
//
// The SA contextBar drives a client-side `:param` (context.region / context.vehicle_type)
// that auto-refetches dependent dashboard views. This endpoint is the SERVER-SIDE half of
// the "Hybrid" decision: it writes the per-schema CONFIG(REGION, VEHICLE_TYPE) single-row
// table so that projection views reading `(SELECT REGION FROM CONFIG LIMIT 1)` and the
// routing tool layer observe the SAME active region/vehicle as the dashboards.
//
// Schema names cannot be parameter-bound (they are identifiers), so every target schema is
// validated against an allowlist before interpolation. Values ARE bound.

const DB = 'FLEET_INTELLIGENCE';

// Schemas whose CONFIG table carries REGION + VEHICLE_TYPE columns. Override with
// FLEET_CONFIG_SCHEMAS (comma-separated). Default targets the dashboards shipped in Step 2.
const ALLOWED_SCHEMAS = (process.env.FLEET_CONFIG_SCHEMAS ??
  'DWELL_ANALYSIS,ROUTE_DEVIATION,ROUTE_OPTIMIZATION')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

const IDENT = /^[A-Z_][A-Z0-9_]*$/;

function resolveSchemas(requested?: string[]): string[] {
  if (!requested || requested.length === 0) return [ALLOWED_SCHEMAS[0]];
  const out: string[] = [];
  for (const raw of requested) {
    const s = String(raw).trim().toUpperCase();
    if (IDENT.test(s) && ALLOWED_SCHEMAS.includes(s)) out.push(s);
  }
  return out.length > 0 ? out : [ALLOWED_SCHEMAS[0]];
}

async function handleGet() {
  const schema = ALLOWED_SCHEMAS[0];
  try {
    const rows = await query<{ REGION: string; VEHICLE_TYPE: string }>(
      `SELECT REGION, VEHICLE_TYPE FROM ${DB}.${schema}.CONFIG LIMIT 1`,
    );
    const row = rows[0] ?? { REGION: null, VEHICLE_TYPE: null };
    return NextResponse.json({ schema, region: row.REGION, vehicle_type: row.VEHICLE_TYPE });
  } catch (err) {
    logger.error('region-get', { schema }, err);
    return NextResponse.json({ error: 'Failed to read active region' }, { status: 500 });
  }
}

async function handlePost(req: Request) {
  let body: { region?: string; vehicle_type?: string; schemas?: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const region = typeof body.region === 'string' && body.region.length > 0 ? body.region : undefined;
  const vehicleType =
    typeof body.vehicle_type === 'string' && body.vehicle_type.length > 0 ? body.vehicle_type : undefined;

  if (!region && !vehicleType) {
    return NextResponse.json({ error: 'Provide region and/or vehicle_type' }, { status: 400 });
  }

  const sets: string[] = [];
  const binds: (string | number | null)[] = [];
  if (region) {
    sets.push('REGION = ?');
    binds.push(region);
  }
  if (vehicleType) {
    sets.push('VEHICLE_TYPE = ?');
    binds.push(vehicleType);
  }

  const schemas = resolveSchemas(body.schemas);
  const updated: Record<string, number> = {};
  try {
    for (const schema of schemas) {
      const n = await run(`UPDATE ${DB}.${schema}.CONFIG SET ${sets.join(', ')}`, binds);
      updated[schema] = n;
    }
    return NextResponse.json({ ok: true, region: region ?? null, vehicle_type: vehicleType ?? null, updated });
  } catch (err) {
    logger.error('region-set', { schemas, region, vehicleType }, err);
    return NextResponse.json({ error: 'Failed to set active region' }, { status: 500 });
  }
}

export const GET = withLogging(handleGet);
export const POST = withLogging(handlePost);
