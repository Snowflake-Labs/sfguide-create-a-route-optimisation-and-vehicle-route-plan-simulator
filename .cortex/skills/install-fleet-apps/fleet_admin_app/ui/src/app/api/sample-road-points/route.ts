import { NextRequest, NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { SF_DATABASE } from '@/server/constants';
import { runSql } from '@/server/lib/sql';
import { sanitizeIdentifier, escapeString } from '@/server/lib/sanitize';
import {
  roadPointsCacheKey,
  roadPointsCacheGet,
  roadPointsCacheSet,
  anchorCacheKey,
  anchorCacheGet,
  anchorCacheSet,
  type LandAnchor,
} from '@/server/lib/cache';
import { regionCatalogMatch } from '@/server/lib/region-catalog-match';
import {
  ROUTABLE_BOUNDARY_EXACT,
  ROUTABLE_BOUNDARY_FAST,
  ROUTABLE_BOUNDARY_SOURCE_EXPR,
  ensureRoutableBoundaryAsync,
} from '@/server/lib/routable-boundary';
import { log } from '@/server/diagnostics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TIMEOUT_MS = 10_000;

// H3 resolution for the sampling window. A res-4 cell measures about 0.57 deg
// lon by 0.48 deg lat, roughly 50 km across, which comfortably contains the
// widest separation band the sampler asks for (driving: 2-15 km) while still
// being a small enough bbox to prune Overture SEGMENT partitions.
const ANCHOR_H3_RES = 4;
// Fall back one level coarser (about 150 km across) when a cell is too empty.
const ANCHOR_H3_RES_WIDE = 3;
const ANCHOR_COUNT = 20;
// Random draws per anchor query. The land share of a region bbox can be low - the
// US extract bbox is mostly ocean - so oversample generously in ONE pass rather
// than issuing repeat queries. MEASURED: 2000 draws yields ~95 land hits for the
// US clip (4.7% of bbox) and ~292 for the unclipped extract.
const ANCHOR_DRAWS = 2000;
// Below this a cell is treated as too sparse to sample from (rural cells still
// clear it easily: a rural Kansas res-4 cell returned the full 50-point pool).
const MIN_POOL_POINTS = 8;
const MAX_ANCHOR_TRIES = 3;

function classFilterFor(profile: string): string {
  if (profile === 'driving-hgv') {
    return `CLASS IN ('motorway','trunk','primary','secondary','tertiary')`;
  }
  if (profile.startsWith('driving')) {
    return `CLASS IN ('motorway','trunk','primary','secondary','tertiary','unclassified','residential','living_street','service')`;
  }
  if (profile.startsWith('cycling')) {
    return `CLASS IN ('motorway','trunk','primary','secondary','tertiary','unclassified','residential','living_street','service','cycleway','path','track')`;
  }
  return `CLASS IN ('primary','secondary','tertiary','unclassified','residential','living_street','service','footway','path','pedestrian','steps','track','cycleway')`;
}

function withTimeout<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), TIMEOUT_MS);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

/**
 * Draw land anchors for a region and expand each into an H3 cell bbox.
 *
 * Rejection sampling in SQL against the land mask, in a single pass. This is the
 * only query that touches the region polygon, and its result is cached for an
 * hour, so a reshuffle never pays for it.
 */
async function fetchLandAnchors(region: string, res: number): Promise<LandAnchor[]> {
  const m = regionCatalogMatch('', `'${escapeString(region)}'`);
  const sql = `
    WITH b AS (
      SELECT ${ROUTABLE_BOUNDARY_EXACT} AS G, MIN_LON, MAX_LON, MIN_LAT, MAX_LAT
      FROM ${SF_DATABASE}.CORE.REGION_CATALOG
      WHERE ${m.predicate} AND BOUNDARY IS NOT NULL
      ORDER BY ${m.rank} LIMIT 1
    ), cand AS (
      SELECT
        b.MIN_LON + UNIFORM(0::FLOAT, 1::FLOAT, RANDOM()) * (b.MAX_LON - b.MIN_LON) AS LON,
        b.MIN_LAT + UNIFORM(0::FLOAT, 1::FLOAT, RANDOM()) * (b.MAX_LAT - b.MIN_LAT) AS LAT,
        b.G
      FROM b, TABLE(GENERATOR(ROWCOUNT => ${ANCHOR_DRAWS}))
    ), hits AS (
      SELECT LON, LAT, H3_LATLNG_TO_CELL(LAT, LON, ${res}) AS CELL
      FROM cand
      WHERE ST_INTERSECTS(ST_POINT(LON, LAT), G)
    )
    SELECT ANY_VALUE(LON) AS LON, ANY_VALUE(LAT) AS LAT, TO_VARCHAR(CELL) AS CELL,
           ST_XMIN(H3_CELL_TO_BOUNDARY(CELL)) AS MIN_LON,
           ST_XMAX(H3_CELL_TO_BOUNDARY(CELL)) AS MAX_LON,
           ST_YMIN(H3_CELL_TO_BOUNDARY(CELL)) AS MIN_LAT,
           ST_YMAX(H3_CELL_TO_BOUNDARY(CELL)) AS MAX_LAT
    FROM hits
    GROUP BY CELL
    LIMIT ${ANCHOR_COUNT}`;
  const rows = (await withTimeout(runSql(sql), 'land-anchor query')) as Record<string, unknown>[];
  return (rows || [])
    .filter((r) => r.CELL != null && r.MIN_LON != null && r.MAX_LON != null)
    .map((r) => ({
      lon: parseFloat(String(r.LON)),
      lat: parseFloat(String(r.LAT)),
      cell: String(r.CELL),
      min_lon: parseFloat(String(r.MIN_LON)),
      max_lon: parseFloat(String(r.MAX_LON)),
      min_lat: parseFloat(String(r.MIN_LAT)),
      max_lat: parseFloat(String(r.MAX_LAT)),
    }));
}

/**
 * Road-segment start points inside one window, clipped to the land mask.
 *
 * `region` is optional so an explicit-bbox caller (Region Builder previewing a
 * bbox that has no catalog row yet) keeps working. When it IS supplied the clip
 * is REQUIRED, not best-effort - see the note on the filter below.
 */
async function fetchPointsInWindow(
  win: { min_lon: number; max_lon: number; min_lat: number; max_lat: number },
  profile: string,
  limit: number,
  region: string | null,
): Promise<[number, number][]> {
  const lonSpan = win.max_lon - win.min_lon;
  const latSpan = win.max_lat - win.min_lat;
  // De-cluster within the window. The old constant divisor was applied to the
  // REGION span, which for a continental region produced 8-degree tiles and a
  // pool whose points were ~800 km apart - further apart than any separation
  // band the sampler asks for, so every pair was rejected.
  const tileDeg = Math.max(Math.min(lonSpan, latSpan) / 8, 0.005);

  let boundaryCte = '';
  let boundaryJoin = '';
  let boundaryFilter = '';
  if (region) {
    const m = regionCatalogMatch('', `'${escapeString(region)}'`);
    boundaryCte = `, region_boundary AS (
        SELECT ${ROUTABLE_BOUNDARY_FAST} AS BOUNDARY
        FROM ${SF_DATABASE}.CORE.REGION_CATALOG
        WHERE ${m.predicate} AND BOUNDARY IS NOT NULL
        ORDER BY ${m.rank} LIMIT 1
      )`;
    boundaryJoin = 'LEFT JOIN region_boundary rb ON TRUE';
    // Fail CLOSED. This was COALESCE(ST_INTERSECTS(...), TRUE), which meant a
    // region with no catalog row silently passed every segment in the bbox - the
    // exact unclipped behaviour the caller asked to avoid, reported as success.
    //
    // Decimated mask, not the exact one: this predicate is evaluated PER SEGMENT,
    // and MEASURED on one cell that is 2.7 s exact against 1.2 s decimated. The
    // anchor is already known to be inside the land mask, so all this filter still
    // has to do is drop roads across a nearby border that fall in the same cell -
    // a job a 500 m-tolerance outline does just as well.
    boundaryFilter = `AND rb.BOUNDARY IS NOT NULL
      AND ST_INTERSECTS(ST_STARTPOINT(s.GEOMETRY), rb.BOUNDARY)`;
  }

  const sql = `
    WITH segments AS (
      SELECT s.GEOMETRY, s.BBOX
      FROM OVERTURE_MAPS__TRANSPORTATION.CARTO.SEGMENT s
      WHERE s.SUBTYPE = 'road'
        AND s.${classFilterFor(profile)}
        AND s.BBOX:xmin <= ${win.max_lon} AND s.BBOX:xmax >= ${win.min_lon}
        AND s.BBOX:ymin <= ${win.max_lat} AND s.BBOX:ymax >= ${win.min_lat}
    )${boundaryCte}
    SELECT
      ANY_VALUE(ST_X(ST_STARTPOINT(s.GEOMETRY))) AS LON,
      ANY_VALUE(ST_Y(ST_STARTPOINT(s.GEOMETRY))) AS LAT
    FROM segments s
    ${boundaryJoin}
    WHERE 1=1
      ${boundaryFilter}
    GROUP BY
      FLOOR((s.BBOX:xmin::FLOAT + s.BBOX:xmax::FLOAT) / 2 / ${tileDeg}),
      FLOOR((s.BBOX:ymin::FLOAT + s.BBOX:ymax::FLOAT) / 2 / ${tileDeg})
    LIMIT ${limit}`;

  const rows = (await withTimeout(
    runSql(sql, 'OVERTURE_MAPS__TRANSPORTATION', 'CARTO'),
    'sample-road-points query',
  )) as Record<string, unknown>[];
  return (rows || [])
    .filter((r) => r.LON != null && r.LAT != null)
    .map((r) => [parseFloat(String(r.LON)), parseFloat(String(r.LAT))] as [number, number])
    .filter(([lon, lat]) =>
      lon >= win.min_lon && lon <= win.max_lon && lat >= win.min_lat && lat <= win.max_lat)
    .map(([lon, lat]) => [+lon.toFixed(5), +lat.toFixed(5)] as [number, number]);
}

// Overture-backed road-point sampling for FunctionTester / RegionBuilder.
//
// Two modes:
//   - anchored (a `region` is given): pick a cached land anchor, expand it to one
//     H3 cell, and sample roads inside that cell. Points are on land AND on the
//     road graph, and the SEGMENT scan is a single cell rather than the region.
//   - explicit bbox (no `region`): unchanged behaviour, for callers previewing a
//     bbox that has no catalog row yet.
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
  // Rotates the anchor on Reshuffle. Same seed the client sampler uses, so a
  // reshuffle moves the window and a re-render does not.
  const nonce = parseInt(sp.get('nonce') || '0') || 0;

  let region: string | null = null;
  if (regionParam && regionParam !== 'default') {
    try { region = sanitizeIdentifier(regionParam); } catch { region = null; }
  }

  const haveBBox = ![minLat, maxLat, minLon, maxLon].some((v) => isNaN(v));
  if (!region && !haveBBox) {
    return NextResponse.json(
      { ok: false, reason: 'region, or min_lat/max_lat/min_lon/max_lon, required' },
      { status: 400 },
    );
  }
  if (haveBBox && (minLat >= maxLat || minLon >= maxLon)) {
    return NextResponse.json({ ok: false, reason: 'invalid bbox: min must be < max' }, { status: 400 });
  }

  // ---- explicit-bbox mode: unchanged ----------------------------------------
  if (!region) {
    const key = roadPointsCacheKey(minLat, maxLat, minLon, maxLon, profile);
    if (!noCache) {
      const cached = roadPointsCacheGet(key);
      if (cached) return NextResponse.json({ ok: true, points: cached, cached: true });
    }
    try {
      const points = await fetchPointsInWindow(
        { min_lon: minLon, max_lon: maxLon, min_lat: minLat, max_lat: maxLat },
        profile, limit, null,
      );
      if (points.length > 0) roadPointsCacheSet(key, points);
      return NextResponse.json({ ok: true, points });
    } catch (e) {
      const msg = (e as Error)?.message || '';
      const reason = /timed out/i.test(msg) ? 'timeout' : msg.slice(0, 200) || 'Overture Transportation unavailable';
      log('WARN', 'SampleRoadPoints', `Failed for bbox=[${minLon},${minLat},${maxLon},${maxLat}] profile=${profile}: ${reason}`);
      return NextResponse.json({ ok: false, reason });
    }
  }

  // ---- anchored mode -------------------------------------------------------
  let boundarySource: 'routable' | 'extract' = 'extract';
  try {
    const m = regionCatalogMatch('', `'${escapeString(region)}'`);
    const rows = await runSql(
      `SELECT ${ROUTABLE_BOUNDARY_SOURCE_EXPR} AS SRC FROM ${SF_DATABASE}.CORE.REGION_CATALOG
       WHERE ${m.predicate} AND BOUNDARY IS NOT NULL ORDER BY ${m.rank} LIMIT 1`,
    );
    if (rows?.[0]?.SRC === 'routable') boundarySource = 'routable';
  } catch { /* treat as extract; the anchor query COALESCEs anyway */ }
  // Bake for next time. Never awaited - the clip is a continental intersection.
  if (boundarySource === 'extract') ensureRoutableBoundaryAsync(region);

  try {
    const aKey = anchorCacheKey(region, boundarySource);
    let anchors = noCache ? null : anchorCacheGet(aKey);
    if (!anchors || anchors.length === 0) {
      anchors = await fetchLandAnchors(region, ANCHOR_H3_RES);
      if (anchors.length > 0) anchorCacheSet(aKey, anchors);
    }
    if (anchors.length === 0) {
      return NextResponse.json({ ok: false, reason: 'no land anchors for region', boundarySource });
    }

    // Walk consecutive anchors from the nonce so a sparse cell advances instead
    // of returning an unusable pool. Deterministic in the nonce, so the same
    // reshuffle reproduces the same window.
    let attempts = 0;
    let lastPoints: [number, number][] = [];
    let lastAnchor: LandAnchor = anchors[0];
    for (; attempts < Math.min(MAX_ANCHOR_TRIES, anchors.length); attempts++) {
      const anchor = anchors[(Math.abs(nonce) + attempts) % anchors.length];
      lastAnchor = anchor;
      const pKey = `${region}|${boundarySource}|${profile}|${anchor.cell}`;
      const cached = noCache ? null : roadPointsCacheGet(pKey);
      const points = cached ?? (await fetchPointsInWindow(anchor, profile, limit, region));
      if (!cached && points.length > 0) roadPointsCacheSet(pKey, points);
      lastPoints = points;
      if (points.length >= MIN_POOL_POINTS) {
        return NextResponse.json({
          ok: true, points, cached: !!cached, boundarySource,
          anchorCell: anchor.cell, anchorAttempts: attempts + 1,
          anchorBBox: {
            min_lat: anchor.min_lat, max_lat: anchor.max_lat,
            min_lon: anchor.min_lon, max_lon: anchor.max_lon,
          },
        });
      }
    }

    // Every tried cell was sparse. Widen once to the coarser resolution, which
    // covers roughly 7x the area, before giving up.
    const wide = await fetchLandAnchors(region, ANCHOR_H3_RES_WIDE);
    if (wide.length > 0) {
      const anchor = wide[Math.abs(nonce) % wide.length];
      const points = await fetchPointsInWindow(anchor, profile, limit, region);
      if (points.length > 0) {
        return NextResponse.json({
          ok: true, points, boundarySource,
          anchorCell: anchor.cell, anchorAttempts: attempts + 1, anchorWidened: true,
          anchorBBox: {
            min_lat: anchor.min_lat, max_lat: anchor.max_lat,
            min_lon: anchor.min_lon, max_lon: anchor.max_lon,
          },
        });
      }
    }

    // Return the sparse pool rather than nothing, but hand back anchorBBox so the
    // client samples geometrically inside a LAND window instead of the region
    // bbox, which for the US is -180..180 and mostly ocean.
    return NextResponse.json({
      ok: lastPoints.length > 0,
      points: lastPoints,
      reason: lastPoints.length > 0 ? undefined : 'no road points in sampled land cells',
      boundarySource,
      anchorCell: lastAnchor.cell,
      anchorAttempts: attempts,
      anchorSparse: true,
      anchorBBox: {
        min_lat: lastAnchor.min_lat, max_lat: lastAnchor.max_lat,
        min_lon: lastAnchor.min_lon, max_lon: lastAnchor.max_lon,
      },
    });
  } catch (e) {
    const msg = (e as Error)?.message || '';
    const reason = /timed out/i.test(msg) ? 'timeout' : msg.slice(0, 200) || 'Overture Transportation unavailable';
    log('WARN', 'SampleRoadPoints', `Failed for region=${region} profile=${profile}: ${reason}`);
    return NextResponse.json({ ok: false, reason, boundarySource });
  }
});
