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
//
// The pool is ANCHORED to a single H3 cell rather than drawn region-wide.
// Region-wide is unusable on a continental region: 50 POIs over the USA sit
// hundreds of km apart, no pair lands in the sampler's separation band (2-15 km
// for driving), and samplePointNear then falls through to "nearest pool points"
// - which paired a POI on Maui with one in Boise. Those two are 3,400 km apart
// with no road between them, so ORS searched the whole US graph until SPCS
// ingress cut the connection and returned a plain-text timeout body.
//
// Measured on UnitedStatesOfAmerica (9,892 POIs): a region-wide pool spans
// 8,165 km, and only 73% of POIs have ANY neighbour in the 2-15 km ring, so
// picking a random anchor is not enough - the anchor's neighbourhood has to be
// dense enough to populate the ring. Anchoring on a cell that holds >= 3 POIs
// with a bbox diagonal >= minKm satisfies that, and a single cell physically
// cannot span two landmasses, so the cross-component pair disappears as a side
// effect rather than needing its own connectivity probe.

// Approximate H3 cell diameter in km (2x average edge length). Used to pick the
// finest resolution whose cell can still contain a maxKm separation - finer
// cells mean a tighter, more local pool.
const H3_DIAMETER_KM: [number, number][] = [
  [4, 45],
  [5, 17],
  [6, 6.4],
  [7, 2.4],
  [8, 0.9],
];

function pickResolution(maxKm: number): number {
  // Finest (highest) resolution whose cell diameter still covers maxKm.
  let chosen = H3_DIAMETER_KM[0][0];
  for (const [res, diamKm] of H3_DIAMETER_KM) {
    if (diamKm >= maxKm) chosen = res;
  }
  return chosen;
}

interface Source {
  source: string;
  db: string;
  schema: string;
  // Must project LON, LAT for the given region.
  base: (region: string) => string;
}

const SOURCES: Source[] = [
  {
    source: 'V_DIM_POIS_CURRENT',
    db: 'SYNTHETIC_DATASETS',
    schema: 'UNIFIED',
    base: (region) => `
      SELECT LNG AS LON, LAT AS LAT
      FROM SYNTHETIC_DATASETS.UNIFIED.V_DIM_POIS_CURRENT
      WHERE REGION = '${region}' AND LNG IS NOT NULL AND LAT IS NOT NULL`,
  },
  {
    source: 'ROUTE_OPTIMIZATION.PLACES',
    db: 'FLEET_INTELLIGENCE',
    schema: 'ROUTE_OPTIMIZATION',
    base: (region) => `
      SELECT ST_X(GEOMETRY) AS LON, ST_Y(GEOMETRY) AS LAT
      FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES
      WHERE REGION = '${region}' AND GEOMETRY IS NOT NULL`,
  },
];

// Anchor on one H3 cell that is dense enough to populate the separation ring.
//
// The `pick` CTE is ordered by RANDOM(), so it MUST be referenced exactly once.
// Referencing a RANDOM()-ordered CTE from several scalar subqueries re-evaluates
// it per reference and draws a DIFFERENT row each time - measured: pairing one
// draw's longitude with another draw's latitude produced a point in open water
// and a silent 0-row result. Keeping it to a single JOIN keeps the anchor stable.
function anchoredSql(src: Source, region: string, limit: number, res: number, minM: number): string {
  return `
    WITH base AS (
      SELECT LON, LAT, H3_LATLNG_TO_CELL_STRING(LAT, LON, ${res}) AS CELL
      FROM (${src.base(region)})
    ), cells AS (
      SELECT CELL, COUNT(*) AS N,
             ST_DISTANCE(ST_MAKEPOINT(MIN(LON), MIN(LAT)),
                         ST_MAKEPOINT(MAX(LON), MAX(LAT))) AS SPREAD_M
      FROM base GROUP BY CELL
    ), pick AS (
      SELECT CELL FROM cells
      WHERE N >= 3 AND SPREAD_M >= ${minM}
      ORDER BY RANDOM() LIMIT 1
    )
    SELECT b.LON AS LON, b.LAT AS LAT
    FROM base b JOIN pick p ON b.CELL = p.CELL
    ORDER BY RANDOM()
    LIMIT ${limit}`;
}

function regionWideSql(src: Source, region: string, limit: number): string {
  return `SELECT LON, LAT FROM (${src.base(region)}) ORDER BY RANDOM() LIMIT ${limit}`;
}

function toPoints(rows: Record<string, unknown>[]): [number, number][] {
  return (rows || [])
    .filter((r) => r.LON != null && r.LAT != null)
    .map((r) => [+parseFloat(String(r.LON)).toFixed(5), +parseFloat(String(r.LAT)).toFixed(5)] as [number, number])
    .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
}

const DEG_TO_KM_LAT = 111.32;

// Bounding box of the pool, widened so it cannot squeeze the sampler's band.
//
// samplePoints derives maxSpan = min(width, height) * 0.6 from this box and
// caps maxKm with it. An anchored pool can be only a few km across, which would
// cap driving maxKm BELOW minKm (2 km) and make the band unsatisfiable - the
// window has to leave at least minSpanKm of room in both axes. Still far more
// local than the region bbox, which for the USA is -180..180 by 15.9..73.
function bboxOf(points: [number, number][], minSpanKm: number) {
  const lons = points.map((p) => p[0]);
  const lats = points.map((p) => p[1]);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const kmPerDegLon = 111.32 * Math.cos((midLat * Math.PI) / 180);
  const padTo = (min: number, max: number, kmPerDeg: number) => {
    const needDeg = minSpanKm / Math.max(kmPerDeg, 1e-6);
    const haveDeg = max - min;
    const pad = Math.max(0, (needDeg - haveDeg) / 2);
    return [min - pad, max + pad] as const;
  };
  const [minLon, maxLon] = padTo(Math.min(...lons), Math.max(...lons), kmPerDegLon);
  const [minLat, maxLat] = padTo(Math.min(...lats), Math.max(...lats), DEG_TO_KM_LAT);
  return { min_lon: minLon, max_lon: maxLon, min_lat: minLat, max_lat: maxLat };
}

export const GET = withLogging(async (req: NextRequest) => {
  const sp = new URL(req.url).searchParams;
  const regionParam = (sp.get('region') || '').trim();
  const limit = Math.min(parseInt(sp.get('limit') || '50') || 50, 200);

  // Separation band the sampler will apply, in km. Numerically clamped before
  // interpolation - these land in SQL text, same as `limit`.
  const rawMax = parseFloat(sp.get('max_km') || '');
  const rawMin = parseFloat(sp.get('min_km') || '');
  const maxKm = Number.isFinite(rawMax) ? Math.min(Math.max(rawMax, 0.1), 500) : 15;
  const minKm = Number.isFinite(rawMin) ? Math.min(Math.max(rawMin, 0), maxKm) : 2;

  if (!regionParam || regionParam === 'default') {
    return NextResponse.json({ ok: false, reason: 'region required' }, { status: 400 });
  }
  const region = escapeString(regionParam);
  const res = pickResolution(maxKm);
  const minM = Math.round(minKm * 1000);

  for (const src of SOURCES) {
    // Anchored first. Fall through to region-wide only when the region has no
    // cell dense enough (a genuinely sparse or tiny region), so a thin region
    // still gets a pool instead of an empty result.
    for (const mode of ['anchored', 'region'] as const) {
      const sql = mode === 'anchored'
        ? anchoredSql(src, region, limit, res, minM)
        : regionWideSql(src, region, limit);
      try {
        const rows = (await runSql(sql, src.db, src.schema)) as Record<string, unknown>[];
        const points = toPoints(rows);
        if (points.length >= 2) {
          return NextResponse.json({
            ok: true,
            points,
            source: src.source,
            anchored: mode === 'anchored',
            resolution: mode === 'anchored' ? res : null,
            anchorBBox: mode === 'anchored' ? bboxOf(points, maxKm / 0.6) : null,
          });
        }
      } catch (e) {
        log('WARN', 'SamplePoiPoints', `${src.source} ${mode} query failed for region=${regionParam}: ${(e as Error)?.message?.slice(0, 200)}`);
      }
    }
  }

  return NextResponse.json({ ok: false, reason: 'no seed POIs for region' });
});
