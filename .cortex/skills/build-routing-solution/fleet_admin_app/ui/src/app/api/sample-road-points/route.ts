import { NextRequest, NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { SF_DATABASE } from '@/server/constants';
import { runSql } from '@/server/lib/sql';
import { sanitizeIdentifier } from '@/server/lib/sanitize';
import { roadPointsCacheKey, roadPointsCacheGet, roadPointsCacheSet } from '@/server/lib/cache';
import { regionCatalogMatch } from '@/server/lib/region-catalog-match';
import { log } from '@/server/diagnostics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Overture-backed bbox sampling for FunctionTester / RegionBuilder.
export const GET = withLogging(async (req: NextRequest) => {
  const sp = new URL(req.url).searchParams;
  const minLat = parseFloat(sp.get('min_lat') || '');
  const maxLat = parseFloat(sp.get('max_lat') || '');
  const minLon = parseFloat(sp.get('min_lon') || '');
  const maxLon = parseFloat(sp.get('max_lon') || '');
  const limit = Math.min(parseInt(sp.get('limit') || '50') || 50, 200);
  const profile = sp.get('profile') || 'driving-car';
  const noCache = sp.get('nocache') === '1';
  const regionParam = sp.get('region') || '';

  if ([minLat, maxLat, minLon, maxLon].some((v) => isNaN(v))) {
    return NextResponse.json({ ok: false, reason: 'min_lat, max_lat, min_lon, max_lon required' }, { status: 400 });
  }
  if (minLat >= maxLat || minLon >= maxLon) {
    return NextResponse.json({ ok: false, reason: 'invalid bbox: min must be < max' }, { status: 400 });
  }

  let safeRegionForBoundary: string | null = null;
  if (regionParam && regionParam !== 'default') {
    try { safeRegionForBoundary = sanitizeIdentifier(regionParam); } catch { safeRegionForBoundary = null; }
  }
  const cacheKey = roadPointsCacheKey(minLat, maxLat, minLon, maxLon, profile) + (safeRegionForBoundary ? `|${safeRegionForBoundary}` : '');
  if (!noCache) {
    const cached = roadPointsCacheGet(cacheKey);
    if (cached) return NextResponse.json({ ok: true, points: cached, cached: true });
  }

  let classFilter: string;
  if (profile === 'driving-hgv') {
    classFilter = `CLASS IN ('motorway','trunk','primary','secondary','tertiary')`;
  } else if (profile.startsWith('driving')) {
    classFilter = `CLASS IN ('motorway','trunk','primary','secondary','tertiary','unclassified','residential','living_street','service')`;
  } else if (profile.startsWith('cycling')) {
    classFilter = `CLASS IN ('motorway','trunk','primary','secondary','tertiary','unclassified','residential','living_street','service','cycleway','path','track')`;
  } else {
    classFilter = `CLASS IN ('primary','secondary','tertiary','unclassified','residential','living_street','service','footway','path','pedestrian','steps','track','cycleway')`;
  }

  const lonSpan = maxLon - minLon;
  const latSpan = maxLat - minLat;
  const tileDeg = Math.max(Math.min(lonSpan, latSpan) / 8, 0.05);

  const mSample = safeRegionForBoundary ? regionCatalogMatch('', `'${safeRegionForBoundary}'`) : null;
  const regionBoundaryCte = mSample
    ? `, region_boundary AS (
        SELECT BOUNDARY FROM ${SF_DATABASE}.CORE.REGION_CATALOG
        WHERE ${mSample.predicate} AND BOUNDARY IS NOT NULL
        ORDER BY ${mSample.rank} LIMIT 1
      )`
    : '';
  const polygonJoin = safeRegionForBoundary ? 'LEFT JOIN region_boundary rb ON TRUE' : '';
  const polygonFilter = safeRegionForBoundary ? 'AND COALESCE(ST_INTERSECTS(ST_STARTPOINT(s.GEOMETRY), rb.BOUNDARY), TRUE)' : '';

  const sql = `
    WITH segments AS (
      SELECT s.GEOMETRY, s.BBOX
      FROM OVERTURE_MAPS__TRANSPORTATION.CARTO.SEGMENT s
      WHERE s.SUBTYPE = 'road'
        AND s.${classFilter}
        AND s.BBOX:xmin <= ${maxLon} AND s.BBOX:xmax >= ${minLon}
        AND s.BBOX:ymin <= ${maxLat} AND s.BBOX:ymax >= ${minLat}
    )${regionBoundaryCte}
    SELECT
      ANY_VALUE(ST_X(ST_STARTPOINT(s.GEOMETRY))) AS LON,
      ANY_VALUE(ST_Y(ST_STARTPOINT(s.GEOMETRY))) AS LAT
    FROM segments s
    ${polygonJoin}
    WHERE 1=1
      ${polygonFilter}
    GROUP BY
      FLOOR((s.BBOX:xmin::FLOAT + s.BBOX:xmax::FLOAT) / 2 / ${tileDeg}),
      FLOOR((s.BBOX:ymin::FLOAT + s.BBOX:ymax::FLOAT) / 2 / ${tileDeg})
    LIMIT ${limit}`;

  const TIMEOUT_MS = 10_000;
  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('sample-road-points query timed out')), TIMEOUT_MS);
  });

  try {
    const rows = (await Promise.race([
      runSql(sql, 'OVERTURE_MAPS__TRANSPORTATION', 'CARTO'),
      timeoutPromise,
    ])) as Record<string, unknown>[];
    if (timer) clearTimeout(timer);
    const points: [number, number][] = (rows || [])
      .filter((r) => r.LON != null && r.LAT != null)
      .filter((r) => {
        const lon = parseFloat(String(r.LON)), lat = parseFloat(String(r.LAT));
        return lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat;
      })
      .map((r) => [+parseFloat(String(r.LON)).toFixed(5), +parseFloat(String(r.LAT)).toFixed(5)] as [number, number]);
    if (points.length > 0) roadPointsCacheSet(cacheKey, points);
    return NextResponse.json({ ok: true, points });
  } catch (e) {
    if (timer) clearTimeout(timer);
    const msg = (e as Error)?.message || '';
    const reason = /timed out/i.test(msg) ? 'timeout' : msg.slice(0, 200) || 'Overture Transportation unavailable';
    log('WARN', 'SampleRoadPoints', `Failed for bbox=[${minLon},${minLat},${maxLon},${maxLat}] profile=${profile}: ${reason}`);
    return NextResponse.json({ ok: false, reason });
  }
});
