// /api/sample-road-points — Overture-backed bbox sampling endpoint that
// FunctionTester / RegionBuilder use to seed routable road origins.

import { Router } from 'express';
import { SF_DATABASE } from '../constants.js';
import { runSql } from '../lib/sql.js';
import { sanitizeIdentifier } from '../lib/sanitize.js';
import { roadPointsCacheKey, roadPointsCacheGet, roadPointsCacheSet } from '../lib/cache.js';
import { log } from '../diagnostics.js';

export function createSamplingRouter(): Router {
  const router = Router();

  // In-process LRU cache for /api/sample-road-points results, keyed by (region bbox + profile).
  // TTL avoids hammering Overture on rapid UI reshuffles. Reshuffle button bypasses via ?nocache=1.
  router.get('/api/sample-road-points', async (req, res) => {
    const minLat = parseFloat(req.query.min_lat as string);
    const maxLat = parseFloat(req.query.max_lat as string);
    const minLon = parseFloat(req.query.min_lon as string);
    const maxLon = parseFloat(req.query.max_lon as string);
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const profile = (req.query.profile as string) || 'driving-car';
    const noCache = req.query.nocache === '1';
    const regionParam = (req.query.region as string) || '';

    if ([minLat, maxLat, minLon, maxLon].some(v => isNaN(v))) {
      return res.status(400).json({ ok: false, reason: 'min_lat, max_lat, min_lon, max_lon required' });
    }
    if (minLat >= maxLat || minLon >= maxLon) {
      return res.status(400).json({ ok: false, reason: 'invalid bbox: min must be < max' });
    }

    // Resolve the region's BOUNDARY polygon (if any) so we can clip road points
    // server-side. For non-rectangular regions like California or Italy, the
    // bbox alone leaks points into Nevada / Adriatic / ocean — ST_WITHIN against
    // REGION_CATALOG.BOUNDARY removes them at the source.
    let safeRegionForBoundary: string | null = null;
    if (regionParam && regionParam !== 'default') {
      try {
        safeRegionForBoundary = sanitizeIdentifier(regionParam);
      } catch {
        safeRegionForBoundary = null;
      }
    }
    const cacheKey = roadPointsCacheKey(minLat, maxLat, minLon, maxLon, profile) + (safeRegionForBoundary ? `|${safeRegionForBoundary}` : '');
    if (!noCache) {
      const cached = roadPointsCacheGet(cacheKey);
      if (cached) {
        return res.json({ ok: true, points: cached, cached: true });
      }
    }

    let classFilter: string;
    if (profile === 'driving-hgv') {
      // HGV is forbidden on residential / living_street / service / track / unclassified
      // by default ORS profile config. Restrict to truck-eligible road classes so
      // ANY_VALUE per tile reliably lands on a routable HGV point (otherwise ORS returns
      // engine error 2010 "Could not find routable point ..." or 3099 for isochrones).
      classFilter = `CLASS IN ('motorway','trunk','primary','secondary','tertiary')`;
    } else if (profile.startsWith('driving')) {
      classFilter = `CLASS IN ('motorway','trunk','primary','secondary','tertiary','unclassified','residential','living_street','service')`;
    } else if (profile.startsWith('cycling')) {
      classFilter = `CLASS IN ('motorway','trunk','primary','secondary','tertiary','unclassified','residential','living_street','service','cycleway','path','track')`;
    } else {
      classFilter = `CLASS IN ('primary','secondary','tertiary','unclassified','residential','living_street','service','footway','path','pedestrian','steps','track','cycleway')`;
    }

    // tileDeg: aim for ~50-100 tiles across the bbox; floor at 0.05 deg so small regions still get spread.
    const lonSpan = maxLon - minLon;
    const latSpan = maxLat - minLat;
    const tileDeg = Math.max(Math.min(lonSpan, latSpan) / 8, 0.05);

    // Polygon clip via CTE + LEFT JOIN + COALESCE.
    //
    // Two correctness invariants:
    //   1. NULL-safe: if the catalog has no row matching this region, rb.BOUNDARY
    //      is NULL on every row and COALESCE(ST_INTERSECTS(..., NULL), TRUE)
    //      preserves the rows (degrades to bbox-only sampling). The previous
    //      scalar-subquery + ST_WITHIN(point, NULL) expression returned NULL
    //      and silently filtered out 100% of road points.
    //   2. LOOKUP_NAME-aware: every other endpoint that joins REGION_CATALOG
    //      uses LOOKUP_NAME as the canonical column. We check it here too so
    //      provisioned regions whose REGION_KEY/REGION_NAME differ from the
    //      ORS_MAP key (e.g. NewYork vs NewYorkUS) still resolve their polygon.
    //
    // bbbike-bbox sources are intentionally INCLUDED — those rows store a valid
    // 5-vertex rectangle BOUNDARY equal to the bbox, so ST_INTERSECTS becomes
    // a no-op for points already inside the bbox. No need to special-case.
    const regionBoundaryCte = safeRegionForBoundary
      ? `, region_boundary AS (
          SELECT BOUNDARY FROM ${SF_DATABASE}.CORE.REGION_CATALOG
          WHERE (UPPER(LOOKUP_NAME) = UPPER('${safeRegionForBoundary}')
                 OR UPPER(REGION_KEY) = UPPER('${safeRegionForBoundary}')
                 OR UPPER(REGION_NAME) = UPPER('${safeRegionForBoundary}'))
            AND BOUNDARY IS NOT NULL
          ORDER BY BOUNDARY_AREA_KM2 ASC
          LIMIT 1
        )`
      : '';
    const polygonJoin = safeRegionForBoundary ? 'LEFT JOIN region_boundary rb ON TRUE' : '';
    const polygonFilter = safeRegionForBoundary
      ? 'AND COALESCE(ST_INTERSECTS(ST_STARTPOINT(s.GEOMETRY), rb.BOUNDARY), TRUE)'
      : '';

    // Filter on numeric BBOX:* scalars (prunable via micro-partitions on the Carto-clustered table)
    // and pick one representative road start point per coarse tile via ANY_VALUE — geographic spread
    // without an expensive ORDER BY RANDOM() over the full filtered set.
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
      const rows = await Promise.race([
        runSql(sql, 'OVERTURE_MAPS__TRANSPORTATION', 'CARTO'),
        timeoutPromise,
      ]) as any[];
      if (timer) clearTimeout(timer);
      const points: [number, number][] = (rows || [])
        .filter((r: any) => r.LON != null && r.LAT != null)
        // Defensive: keep only points actually inside the requested bbox (Overture indexes
        // are based on segment bbox overlap, so a segment can poke outside the requested box).
        .filter((r: any) => {
          const lon = parseFloat(r.LON), lat = parseFloat(r.LAT);
          return lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat;
        })
        .map((r: any) => [+parseFloat(r.LON).toFixed(5), +parseFloat(r.LAT).toFixed(5)] as [number, number]);
      if (points.length > 0) roadPointsCacheSet(cacheKey, points);
      res.json({ ok: true, points });
    } catch (e: any) {
      if (timer) clearTimeout(timer);
      const msg = e?.message || '';
      const reason = /timed out/i.test(msg)
        ? 'timeout'
        : msg.slice(0, 200) || 'Overture Transportation unavailable';
      log('WARN', 'SampleRoadPoints', `Failed for bbox=[${minLon},${minLat},${maxLon},${maxLat}] profile=${profile}: ${reason}`);
      res.json({ ok: false, reason });
    }
  });

  return router;
}
