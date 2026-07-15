import { NextRequest, NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { SF_DATABASE } from '@/server/constants';
import { runSql } from '@/server/lib/sql';
import { sanitizeIdentifier } from '@/server/lib/sanitize';
import { requireOps } from '@/lib/ingress-identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LIMIT_BOUNDS: Record<string, [number, number]> = {
  maximum_distance: [1000, 100000000],
  maximum_distance_dynamic_weights: [1000, 100000000],
  maximum_distance_avoid_areas: [1000, 100000000],
  maximum_distance_alternative_routes: [1000, 100000000],
  maximum_distance_round_trip_routes: [1000, 100000000],
  maximum_visited_nodes: [10000, 1000000000],
  maximum_waypoints: [2, 100000],
  maximum_snapping_radius: [10, 100000],
  matrix_maximum_routes: [100, 100000000],
  matrix_maximum_visited_nodes: [10000, 1000000000],
  isochrones_maximum_locations: [1, 100],
  isochrones_maximum_intervals: [1, 100],
  isochrones_maximum_range_distance: [1000, 100000000],
  isochrones_maximum_range_time: [60, 86400],
};

function validateLimits(input: Record<string, unknown> | null): { clean: Record<string, number>; errors: string[] } {
  const clean: Record<string, number> = {};
  const errors: string[] = [];
  if (!input || typeof input !== 'object') return { clean, errors: ['limits object required'] };
  for (const [key, bounds] of Object.entries(LIMIT_BOUNDS)) {
    if (input[key] == null) continue;
    const n = Math.round(Number(input[key]));
    if (!Number.isFinite(n)) { errors.push(`${key}: not a number`); continue; }
    const [min, max] = bounds;
    if (n < min || n > max) { errors.push(`${key}: ${n} out of range [${min}, ${max}]`); continue; }
    clean[key] = n;
  }
  return { clean, errors };
}

export const GET = withLogging(async (_req, ctx?: unknown) => {
  const { params } = ctx as { params: Promise<{ region: string }> };
  const { region: raw } = await params;
  try {
    const region = sanitizeIdentifier(raw);
    let defaults: Record<string, number> = {};
    let overrides: Record<string, number> = {};
    try {
      const rows = await runSql(
        `SELECT ${SF_DATABASE}.CORE.ORS_LIMIT_DEFAULTS()::STRING AS DEFAULTS,
                (SELECT LIMITS::STRING FROM ${SF_DATABASE}.CORE.REGION_ORS_LIMITS WHERE UPPER(REGION) = UPPER('${region}') LIMIT 1) AS OVERRIDES`,
      );
      defaults = rows?.[0]?.DEFAULTS ? JSON.parse(rows[0].DEFAULTS) : {};
      overrides = rows?.[0]?.OVERRIDES ? JSON.parse(rows[0].OVERRIDES) : {};
    } catch {
      const rows = await runSql(`SELECT ${SF_DATABASE}.CORE.ORS_LIMIT_DEFAULTS()::STRING AS DEFAULTS`);
      defaults = rows?.[0]?.DEFAULTS ? JSON.parse(rows[0].DEFAULTS) : {};
    }
    return NextResponse.json({ region, defaults, overrides, effective: { ...defaults, ...overrides }, bounds: LIMIT_BOUNDS });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
});

export const PUT = withLogging(async (req: NextRequest, ctx?: unknown) => {
  const gate = await requireOps(req);
  if (!gate.ok) return NextResponse.json({ status: 'error', error: gate.reason || 'Forbidden' }, { status: gate.status });
  const { params } = ctx as { params: Promise<{ region: string }> };
  const { region: raw } = await params;
  try {
    const region = sanitizeIdentifier(raw);
    const body = await req.json();
    const { clean, errors } = validateLimits(body?.limits ?? body);
    if (errors.length) return NextResponse.json({ status: 'error', errors }, { status: 400 });
    const json = JSON.stringify(clean);
    const rows = await runSql(`CALL ${SF_DATABASE}.CORE.APPLY_ORS_LIMITS('${region}', '${json}')`);
    const raw2 = rows?.[0]?.[Object.keys(rows[0] || {})[0]] || '{}';
    const parsed = typeof raw2 === 'string' ? JSON.parse(raw2) : raw2;
    if (parsed.status === 'error') return NextResponse.json(parsed, { status: 400 });
    return NextResponse.json(parsed);
  } catch (err) {
    return NextResponse.json({ status: 'error', error: (err as Error).message }, { status: 500 });
  }
});
