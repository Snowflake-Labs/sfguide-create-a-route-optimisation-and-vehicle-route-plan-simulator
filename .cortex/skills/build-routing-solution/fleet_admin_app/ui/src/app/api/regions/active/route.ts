import { NextRequest, NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { runSql } from '@/server/lib/sql';
import { escapeString } from '@/server/lib/sanitize';
import { getActiveRegionOverride, setActiveRegionOverride } from '@/server/lib/state';
import { log } from '@/server/diagnostics';
import { requireOps } from '@/lib/ingress-identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FALLBACK = { REGION_NAME: 'SanFrancisco', DISPLAY_NAME: 'San Francisco', CENTER_LAT: 37.7749, CENTER_LON: -122.4194, ZOOM_LEVEL: 11 };

export const GET = withLogging(async () => {
  try {
    const rows = await runSql(
      `SELECT REGION_NAME, DISPLAY_NAME, CENTER_LAT, CENTER_LON,
              BBOX_MIN_LAT, BBOX_MAX_LAT, BBOX_MIN_LON, BBOX_MAX_LON,
              ZOOM_LEVEL, ORS_REGION_KEY, DATA_SOURCE
       FROM FLEET_INTELLIGENCE.CORE.REGION_REGISTRY WHERE IS_DEFAULT = TRUE LIMIT 1`,
      'FLEET_INTELLIGENCE', 'CORE',
    );
    return NextResponse.json(rows[0] || FALLBACK);
  } catch {
    return NextResponse.json(FALLBACK);
  }
});

// Global default-region promotion = a WRITE; demoted to OPS (R4). Per-session
// region selection is a consumer concern and does NOT hit this route.
const CONFIG_SCHEMAS = [
  'FLEET_INTELLIGENCE.DWELL_ANALYSIS', 'FLEET_INTELLIGENCE.ROUTE_DEVIATION',
  'FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS', 'FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY',
  'FLEET_INTELLIGENCE.RETAIL_CATCHMENT', 'FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION',
  'FLEET_INTELLIGENCE.BACKLOAD_MATCHING', 'FLEET_INTELLIGENCE.MARKETPLACE',
];

export const POST = withLogging(async (req: NextRequest) => {
  const gate = await requireOps(req);
  if (!gate.ok) return NextResponse.json({ error: gate.reason || 'Forbidden' }, { status: gate.status });
  try {
    const { region } = await req.json();
    if (!region) return NextResponse.json({ error: 'region required' }, { status: 400 });
    try {
      await runSql(`CALL FLEET_INTELLIGENCE.CORE.SET_ACTIVE_REGION('${escapeString(region)}')`, 'FLEET_INTELLIGENCE', 'CORE');
    } catch (e) {
      log('WARN', 'Region', `SET_ACTIVE_REGION not available: ${(e as Error).message?.slice(0, 100)}`);
    }
    setActiveRegionOverride(region);
    const safeRegion = escapeString(region);
    for (const schema of CONFIG_SCHEMAS) {
      try {
        await runSql(`UPDATE ${schema}.CONFIG SET REGION = '${safeRegion}'`);
      } catch (e) {
        log('WARN', 'CONFIG', `Failed to update ${schema}.CONFIG region: ${(e as Error).message}`);
      }
    }
    runSql(`CALL FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SEED_ROUTE_OPTIMIZATION_REGION('${safeRegion}')`, 'FLEET_INTELLIGENCE', 'ROUTE_OPTIMIZATION')
      .catch((e: Error) => log('WARN', 'RouteOpt', `Auto-seed PLACES for ${region}: ${e.message?.slice(0, 200)}`));
    return NextResponse.json({ ok: true, region });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
});
