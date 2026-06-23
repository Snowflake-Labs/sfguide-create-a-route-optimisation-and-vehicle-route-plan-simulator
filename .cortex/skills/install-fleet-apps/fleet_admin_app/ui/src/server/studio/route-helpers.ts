// Shared helpers for the studio route handlers (ported from ors_control_app
// server/studio/routes.ts module scope). Used by /api/studio/generate.
import { log } from '@/server/diagnostics';
import { normalizeRegion } from '@/server/lib/region';
import { regionCatalogMatch } from '@/server/lib/region-catalog-match';

type SnowSqlFn = (sql: string, database?: string, schema?: string) => Promise<Record<string, unknown>[]>;
export type Bbox = { min_lat: number; max_lat: number; min_lng: number; max_lng: number };

export async function resolveRegionBbox(region: string, snowSql: SnowSqlFn): Promise<Bbox> {
  const safeRegion = region.replace(/'/g, "''");
  const mJoin = regionCatalogMatch('rc', 'rr.ORS_REGION_KEY');
  const regionRows = await snowSql(
    `SELECT COALESCE(rr.BBOX_MIN_LAT, rc.MIN_LAT) AS BBOX_MIN_LAT,
            COALESCE(rr.BBOX_MAX_LAT, rc.MAX_LAT) AS BBOX_MAX_LAT,
            COALESCE(rr.BBOX_MIN_LON, rc.MIN_LON) AS BBOX_MIN_LON,
            COALESCE(rr.BBOX_MAX_LON, rc.MAX_LON) AS BBOX_MAX_LON
     FROM FLEET_INTELLIGENCE.CORE.REGION_REGISTRY rr
     LEFT JOIN OPENROUTESERVICE_APP.CORE.REGION_CATALOG rc ON ${mJoin.predicate}
     WHERE rr.REGION_NAME='${safeRegion}'
     QUALIFY ROW_NUMBER() OVER (ORDER BY ${mJoin.rank}) = 1`,
    'FLEET_INTELLIGENCE', 'CORE',
  ).catch(() => [] as Record<string, unknown>[]);
  let bbox: Bbox | null = regionRows.length ? {
    min_lat: Number(regionRows[0].BBOX_MIN_LAT), max_lat: Number(regionRows[0].BBOX_MAX_LAT),
    min_lng: Number(regionRows[0].BBOX_MIN_LON), max_lng: Number(regionRows[0].BBOX_MAX_LON),
  } : null;
  if (!bbox || [bbox.min_lat, bbox.max_lat, bbox.min_lng, bbox.max_lng].some((v) => v == null || Number.isNaN(v))) {
    const mCatOnly = regionCatalogMatch('', `'${safeRegion}'`);
    const catalogOnly = await snowSql(
      `SELECT MIN_LAT, MAX_LAT, MIN_LON, MAX_LON FROM OPENROUTESERVICE_APP.CORE.REGION_CATALOG
       WHERE ${mCatOnly.predicate} QUALIFY ROW_NUMBER() OVER (ORDER BY ${mCatOnly.rank}) = 1`,
      'OPENROUTESERVICE_APP', 'CORE',
    ).catch(() => [] as Record<string, unknown>[]);
    if (catalogOnly.length) {
      bbox = { min_lat: Number(catalogOnly[0].MIN_LAT), max_lat: Number(catalogOnly[0].MAX_LAT), min_lng: Number(catalogOnly[0].MIN_LON), max_lng: Number(catalogOnly[0].MAX_LON) };
    }
  }
  if (!bbox || [bbox.min_lat, bbox.max_lat, bbox.min_lng, bbox.max_lng].some((v) => v == null || Number.isNaN(v))) {
    throw new Error(`No bbox registered for region '${region}'. Add it to FLEET_INTELLIGENCE.CORE.REGION_REGISTRY (or OPENROUTESERVICE_APP.CORE.REGION_CATALOG) before generating data.`);
  }
  return bbox;
}

export async function resolveRegionAreaKm2(region: string, snowSql: SnowSqlFn): Promise<number | null> {
  const safe = region.replace(/'/g, "''");
  try {
    const mArea = regionCatalogMatch('', `'${safe}'`);
    const rows = await snowSql(
      `SELECT BOUNDARY_AREA_KM2 FROM OPENROUTESERVICE_APP.CORE.REGION_CATALOG
       WHERE ${mArea.predicate} QUALIFY ROW_NUMBER() OVER (ORDER BY ${mArea.rank}) = 1`,
      'OPENROUTESERVICE_APP', 'CORE',
    );
    if (rows.length && rows[0].BOUNDARY_AREA_KM2 != null) {
      const v = Number(rows[0].BOUNDARY_AREA_KM2);
      return Number.isFinite(v) && v > 0 ? v : null;
    }
  } catch (e) {
    log('WARN', 'Studio', `BOUNDARY_AREA_KM2 lookup failed for '${region}': ${(e as Error).message?.slice(0, 200)}`);
  }
  return null;
}

export async function checkOrsReadiness(snowSql: SnowSqlFn, orsProfile: string, region: string): Promise<{ ready: boolean; error?: string }> {
  try {
    const resolvedRegion = normalizeRegion(region);
    const sql = `SELECT TO_VARCHAR(OPENROUTESERVICE_APP.CORE.ORS_STATUS('${resolvedRegion.replace(/'/g, "''")}')) AS STATUS`;
    const rows = await snowSql(sql);
    const raw = rows[0]?.STATUS;
    const status = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!status?.service_ready) {
      return { ready: false, error: `ORS service for region "${region}" is not running (suspended or starting up). Resume it from the Service Lifecycle page or the Region Builder before generating.` };
    }
    const profiles = Object.keys(status.profiles || {});
    if (!profiles.includes(orsProfile)) {
      return { ready: false, error: `ORS profile "${orsProfile}" is not built for region "${region}". Available profiles: ${profiles.join(', ') || 'none'}. Build the graph for this profile first.` };
    }
  } catch (e) {
    return { ready: false, error: `Cannot reach ORS service for region "${region}": ${(e as Error).message?.slice(0, 120)}. The app may not be installed.` };
  }
  return { ready: true };
}
