import { NextRequest, NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { SF_DATABASE } from '@/server/constants';
import { runSql } from '@/server/lib/sql';
import { sanitizeIdentifier, sanitizeFloat, escapeString } from '@/server/lib/sanitize';
import { regionCatalogMatch } from '@/server/lib/region-catalog-match';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const COST_ESTIMATE_TIMEOUT_MS = 60_000;
const MAX_CONCURRENT_ESTIMATE_QUERIES = 2;
const cc = ((globalThis as unknown as { __fleetAdminEstimateCC?: { n: number } }).__fleetAdminEstimateCC ??= { n: 0 });

export const POST = withLogging(async (req: NextRequest) => {
  try {
    const { region, resolutions, profile, road_filter } = await req.json();
    if (!region || !resolutions) return NextResponse.json({ error: 'region and resolutions required' }, { status: 400 });
    let safeRegion: string;
    try { safeRegion = sanitizeIdentifier(region); } catch { return NextResponse.json({ error: 'Invalid region' }, { status: 400 }); }

    let bbox: Record<string, number> = { MIN_LAT: 37.71, MAX_LAT: 37.81, MIN_LON: -122.51, MAX_LON: -122.37 };
    try {
      const cityRow = await runSql(`SELECT * FROM ${SF_DATABASE}.CORE.REGION_ORS_MAP WHERE REGION = '${escapeString(safeRegion)}'`);
      if (cityRow?.[0]) bbox = cityRow[0];
    } catch {}

    let polygonAreaSqKm: number | null = null;
    let hasPolygon = false;
    const mPoly = regionCatalogMatch('', `'${escapeString(safeRegion)}'`);
    try {
      const polyRow = await runSql(`SELECT BOUNDARY_AREA_KM2 AS AREA FROM ${SF_DATABASE}.CORE.REGION_CATALOG WHERE BOUNDARY IS NOT NULL AND ${mPoly.predicate} ORDER BY ${mPoly.rank} LIMIT 1`);
      if (polyRow?.[0]?.AREA != null) { polygonAreaSqKm = Number(polyRow[0].AREA); hasPolygon = polygonAreaSqKm > 0; }
    } catch {}

    const latSpan = Math.abs(Number(bbox.MAX_LAT) - Number(bbox.MIN_LAT));
    const lonSpan = Math.abs(Number(bbox.MAX_LON) - Number(bbox.MIN_LON));
    const bboxAreaSqKm = latSpan * 111 * lonSpan * 111 * Math.cos(((Number(bbox.MIN_LAT) + Number(bbox.MAX_LAT)) / 2) * Math.PI / 180);
    const areaSqKm = hasPolygon ? polygonAreaSqKm! : bboxAreaSqKm;
    const hexAreaKm2: Record<number, number> = { 5: 252.9, 6: 36.13, 7: 5.16, 8: 0.737, 9: 0.105, 10: 0.015 };
    const pairsPerSecond = 30000, computePoolNodes = 10, computePoolCreditPerNodeHr = 1, warehouseCreditPerHr = 10, flattenCredits = 2, creditPriceDollars = 3;
    const useRoadFilter = road_filter === true;
    const polyExpr = hasPolygon
      ? `(SELECT BOUNDARY FROM ${SF_DATABASE}.CORE.REGION_CATALOG WHERE BOUNDARY IS NOT NULL AND ${mPoly.predicate} ORDER BY ${mPoly.rank} LIMIT 1)`
      : `TO_GEOGRAPHY('POLYGON((${sanitizeFloat(bbox.MIN_LON)} ${sanitizeFloat(bbox.MIN_LAT)},${sanitizeFloat(bbox.MAX_LON)} ${sanitizeFloat(bbox.MIN_LAT)},${sanitizeFloat(bbox.MAX_LON)} ${sanitizeFloat(bbox.MAX_LAT)},${sanitizeFloat(bbox.MIN_LON)} ${sanitizeFloat(bbox.MAX_LAT)},${sanitizeFloat(bbox.MIN_LON)} ${sanitizeFloat(bbox.MIN_LAT)}))')`;

    const computeEstimate = async (resolution: number) => {
      let hexCount = Math.ceil(areaSqKm / (hexAreaKm2[resolution] || 1));
      const hexCountBbox = Math.ceil(bboxAreaSqKm / (hexAreaKm2[resolution] || 1));
      let filteredApplied = false;
      if (useRoadFilter) {
        while (cc.n >= MAX_CONCURRENT_ESTIMATE_QUERIES) await new Promise((r) => setTimeout(r, 200));
        cc.n++;
        try {
          const sampleClause = resolution >= 9 ? 'SAMPLE (20)' : '';
          const scaleFactor = resolution >= 9 ? 5 : 1;
          const sql = `WITH region_geom AS (SELECT ${polyExpr} AS poly), rs AS (
              SELECT s.geometry FROM OVERTURE_MAPS__TRANSPORTATION.CARTO.SEGMENT s ${sampleClause}, region_geom r
              WHERE s.subtype = 'road' AND s.bbox:xmin::FLOAT <= ${sanitizeFloat(bbox.MAX_LON)} AND s.bbox:xmax::FLOAT >= ${sanitizeFloat(bbox.MIN_LON)}
                AND s.bbox:ymin::FLOAT <= ${sanitizeFloat(bbox.MAX_LAT)} AND s.bbox:ymax::FLOAT >= ${sanitizeFloat(bbox.MIN_LAT)} AND ST_INTERSECTS(s.geometry, r.poly))
            SELECT COUNT(DISTINCT c.value) AS CNT FROM rs, TABLE(FLATTEN(H3_COVERAGE_STRINGS(rs.geometry, ${resolution}))) c, region_geom r
            WHERE ST_WITHIN(H3_CELL_TO_POINT(c.value::VARCHAR), r.poly)`;
          const rows = await runSql(sql, 'OVERTURE_MAPS__TRANSPORTATION', 'CARTO');
          const raw = parseInt(rows?.[0]?.CNT || '0');
          if (raw > 0) { hexCount = raw * scaleFactor; filteredApplied = true; }
        } finally { cc.n--; }
      }
      const totalPairs = hexCount * (hexCount - 1);
      const buildTimeSecs = totalPairs / pairsPerSecond;
      const buildTimeHrs = buildTimeSecs / 3600;
      const computePoolCredits = computePoolNodes * computePoolCreditPerNodeHr * buildTimeHrs;
      const warehouseCredits = warehouseCreditPerHr * buildTimeHrs;
      const totalCredits = computePoolCredits + warehouseCredits + flattenCredits;
      return {
        resolution: `RES${resolution}`, hex_count: hexCount, hex_count_bbox: hexCountBbox, road_filter_applied: filteredApplied,
        polygon_applied: hasPolygon, total_pairs: totalPairs, estimated_build_time_minutes: Math.round((buildTimeSecs / 60) * 10) / 10,
        cost_breakdown: {
          compute_pool: { nodes: computePoolNodes, credits: Math.round(computePoolCredits * 10) / 10 },
          warehouse: { type: 'X-Small x10 clusters', credits: Math.round(warehouseCredits * 10) / 10 },
          flatten: { type: 'X-Large', credits: flattenCredits },
          total_credits: Math.round(totalCredits * 10) / 10, estimated_cost_usd: Math.round(totalCredits * creditPriceDollars * 100) / 100,
        },
      };
    };

    const safeResolutions = (resolutions as number[]).filter((r) => r >= 5 && r <= 10);
    const estimatesPromise = Promise.all(safeResolutions.map(computeEstimate));
    const timeoutPromise = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('COST_ESTIMATE_TIMEOUT')), COST_ESTIMATE_TIMEOUT_MS));
    let estimates: Awaited<ReturnType<typeof computeEstimate>>[];
    try {
      estimates = await Promise.race([estimatesPromise, timeoutPromise]);
    } catch (e) {
      if ((e as Error).message === 'COST_ESTIMATE_TIMEOUT') {
        return NextResponse.json({
          region: safeRegion, profile: profile || 'driving-car', road_filter: useRoadFilter, area_sq_km: Math.round(areaSqKm),
          resolutions: safeResolutions.map((r) => ({ resolution: `RES${r}`, hex_count: Math.ceil(areaSqKm / (hexAreaKm2[r] || 1)), hex_count_bbox: Math.ceil(bboxAreaSqKm / (hexAreaKm2[r] || 1)), road_filter_applied: false, polygon_applied: hasPolygon, total_pairs: 0, estimated_build_time_minutes: 0, timed_out: true })),
          error: 'Road-aware cost estimate timed out (>60s). Estimates shown use bbox approximation.', timed_out: true,
        });
      }
      throw e;
    }
    const totalCredits = estimates.reduce((sum, e) => sum + e.cost_breakdown.total_credits, 0);
    return NextResponse.json({
      region: safeRegion, profile: profile || 'driving-car', road_filter: useRoadFilter, area_sq_km: Math.round(areaSqKm), bbox_area_sq_km: Math.round(bboxAreaSqKm),
      polygon_applied: hasPolygon, bbox: { min_lat: bbox.MIN_LAT, max_lat: bbox.MAX_LAT, min_lon: bbox.MIN_LON, max_lon: bbox.MAX_LON },
      resolutions: estimates, total_estimated_credits: Math.round(totalCredits * 10) / 10, total_estimated_cost_usd: Math.round(totalCredits * creditPriceDollars * 100) / 100, credit_price_usd: creditPriceDollars,
      note: useRoadFilter ? 'Road-aware estimate uses actual Overture road segments clipped to the region polygon. Res 9-10 use 20% sampling scaled 5x.' : (hasPolygon ? 'Estimates use the actual region polygon area (REGION_CATALOG.BOUNDARY). Throughput model: 30K pairs/sec on 10-node compute pool.' : 'Estimates based on bbox rectangle area. Throughput model: 30K pairs/sec on 10-node compute pool.'),
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message || 'Internal server error' }, { status: 500 });
  }
});
