import { NextRequest, NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { runSql } from '@/server/lib/sql';
import { escapeString } from '@/server/lib/sanitize';
import { log } from '@/server/diagnostics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Region-scoped seed-POI sampling for the Function Tester. POIs in these seed
// tables are confidently routable: V_DIM_POIS_CURRENT is filtered through
// filterRoutablePois at generation time, and ROUTE_OPTIMIZATION.PLACES probes
// clean on the active graph. Returning these as the coordinate pool guarantees
// every sampled point snaps to a road, eliminating the VROOM code-3 (unroutable
// point) -> silent 0-row OPTIMIZATION result. Falls through (ok:false) when a
// region has no seed data so the caller can use Overture/boundary sampling.
const SOURCES: { source: string; sql: (region: string, limit: number) => string; db: string; schema: string }[] = [
  {
    source: 'V_DIM_POIS_CURRENT',
    db: 'SYNTHETIC_DATASETS',
    schema: 'UNIFIED',
    sql: (region, limit) => `
      SELECT LNG AS LON, LAT
      FROM SYNTHETIC_DATASETS.UNIFIED.V_DIM_POIS_CURRENT
      WHERE REGION = '${region}' AND LNG IS NOT NULL AND LAT IS NOT NULL
      ORDER BY RANDOM()
      LIMIT ${limit}`,
  },
  {
    source: 'ROUTE_OPTIMIZATION.PLACES',
    db: 'FLEET_INTELLIGENCE',
    schema: 'ROUTE_OPTIMIZATION',
    sql: (region, limit) => `
      SELECT ST_X(GEOMETRY) AS LON, ST_Y(GEOMETRY) AS LAT
      FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES
      WHERE REGION = '${region}' AND GEOMETRY IS NOT NULL
      ORDER BY RANDOM()
      LIMIT ${limit}`,
  },
];

export const GET = withLogging(async (req: NextRequest) => {
  const sp = new URL(req.url).searchParams;
  const regionParam = (sp.get('region') || '').trim();
  const limit = Math.min(parseInt(sp.get('limit') || '50') || 50, 200);

  if (!regionParam || regionParam === 'default') {
    return NextResponse.json({ ok: false, reason: 'region required' }, { status: 400 });
  }
  const region = escapeString(regionParam);

  for (const src of SOURCES) {
    try {
      const rows = (await runSql(src.sql(region, limit), src.db, src.schema)) as Record<string, unknown>[];
      const points: [number, number][] = (rows || [])
        .filter((r) => r.LON != null && r.LAT != null)
        .map((r) => [+parseFloat(String(r.LON)).toFixed(5), +parseFloat(String(r.LAT)).toFixed(5)] as [number, number])
        .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
      if (points.length > 0) {
        return NextResponse.json({ ok: true, points, source: src.source });
      }
    } catch (e) {
      log('WARN', 'SamplePoiPoints', `${src.source} query failed for region=${regionParam}: ${(e as Error)?.message?.slice(0, 200)}`);
    }
  }

  return NextResponse.json({ ok: false, reason: 'no seed POIs for region' });
});
