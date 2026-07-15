import { NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { SF_DATABASE } from '@/server/constants';
import { runSql } from '@/server/lib/sql';
import { escapeString } from '@/server/lib/sanitize';
import { getActiveRegionOverride } from '@/server/lib/state';
import { regionCatalogMatch } from '@/server/lib/region-catalog-match';
import { log } from '@/server/diagnostics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Faithful port of ors_control_app server/routes/regions/lifecycle.ts GET /api/regions.
export const GET = withLogging(async () => {
  try {
    let regions: Record<string, unknown>[] = [];
    try {
      const mReg = regionCatalogMatch('rc', 'rr.ORS_REGION_KEY');
      regions = await runSql(
        `SELECT rr.REGION_NAME, rr.DISPLAY_NAME, rr.CENTER_LAT, rr.CENTER_LON,
                rr.BBOX_MIN_LAT, rr.BBOX_MAX_LAT, rr.BBOX_MIN_LON, rr.BBOX_MAX_LON,
                rr.ZOOM_LEVEL, rr.ORS_REGION_KEY, rr.DATA_SOURCE, rr.IS_DEFAULT,
                CAST(ST_ASGEOJSON(rc.BOUNDARY) AS VARCHAR) AS BOUNDARY_GEOJSON,
                rc.BOUNDARY_SOURCE, rc.BOUNDARY_AREA_KM2, rc.BOUNDARY_BAKED_AT,
                ST_X(ST_CENTROID(rc.BOUNDARY))::FLOAT AS BOUNDARY_CENTROID_LON,
                ST_Y(ST_CENTROID(rc.BOUNDARY))::FLOAT AS BOUNDARY_CENTROID_LAT,
                rc.ISO_COUNTRY_A2, rc.ISO_COUNTRY_A3, rc.ISO_SUBDIVISION
         FROM FLEET_INTELLIGENCE.CORE.REGION_REGISTRY rr
         LEFT JOIN OPENROUTESERVICE_APP.CORE.REGION_CATALOG rc
           ON rc.BOUNDARY IS NOT NULL AND ${mReg.predicate}
         QUALIFY ROW_NUMBER() OVER (PARTITION BY rr.REGION_NAME ORDER BY ${mReg.rank}) = 1
         ORDER BY rr.IS_DEFAULT DESC, rr.PROVISIONED_AT`,
        'FLEET_INTELLIGENCE', 'CORE',
      );
    } catch {}
    const knownNames = new Set(regions.map((r) => r.REGION_NAME));
    try {
      const orsMapRows = await runSql(`SELECT REGION, DISPLAY_NAME, MIN_LAT, MAX_LAT, MIN_LON, MAX_LON FROM ${SF_DATABASE}.CORE.REGION_ORS_MAP`);
      for (const row of orsMapRows || []) {
        if (row.REGION && !knownNames.has(row.REGION)) {
          const centerLat = ((Number(row.MIN_LAT) || 0) + (Number(row.MAX_LAT) || 0)) / 2;
          const centerLon = ((Number(row.MIN_LON) || 0) + (Number(row.MAX_LON) || 0)) / 2;
          regions.push({
            REGION_NAME: row.REGION, DISPLAY_NAME: row.DISPLAY_NAME || row.REGION,
            CENTER_LAT: centerLat, CENTER_LON: centerLon,
            BBOX_MIN_LAT: row.MIN_LAT, BBOX_MAX_LAT: row.MAX_LAT, BBOX_MIN_LON: row.MIN_LON, BBOX_MAX_LON: row.MAX_LON,
            ZOOM_LEVEL: 11, ORS_REGION_KEY: row.REGION, DATA_SOURCE: 'ORS_REGION', IS_DEFAULT: false,
          });
          knownNames.add(row.REGION);
        }
      }
      try {
        const stageRows = await runSql(`LIST @${SF_DATABASE}.CORE.ORS_SPCS_STAGE PATTERN='.*ors-config.*'`);
        for (const row of stageRows || []) {
          const path = String(row.name || row.NAME || '');
          const match = path.match(/ors_spcs_stage\/([^/]+)\/ors-config/i);
          if (match) {
            const stageRegion = match[1];
            if (!knownNames.has(stageRegion)) {
              const mapRow = (await runSql(`SELECT * FROM ${SF_DATABASE}.CORE.REGION_ORS_MAP WHERE REGION = '${escapeString(stageRegion)}'`).catch(() => []))?.[0];
              regions.unshift({
                REGION_NAME: stageRegion, DISPLAY_NAME: mapRow?.DISPLAY_NAME || stageRegion,
                CENTER_LAT: mapRow ? ((Number(mapRow.MIN_LAT) || 0) + (Number(mapRow.MAX_LAT) || 0)) / 2 : 37.7749,
                CENTER_LON: mapRow ? ((Number(mapRow.MIN_LON) || 0) + (Number(mapRow.MAX_LON) || 0)) / 2 : -122.4194,
                BBOX_MIN_LAT: mapRow?.MIN_LAT ?? 37.700, BBOX_MAX_LAT: mapRow?.MAX_LAT ?? 37.820,
                BBOX_MIN_LON: mapRow?.MIN_LON ?? -122.520, BBOX_MAX_LON: mapRow?.MAX_LON ?? -122.350,
                ZOOM_LEVEL: 11, ORS_REGION_KEY: stageRegion, DATA_SOURCE: 'ORS_DEFAULT', IS_DEFAULT: true,
              });
              knownNames.add(stageRegion);
            }
          }
        }
      } catch {}
    } catch {}
    if (regions.length === 0) {
      regions = [{
        REGION_NAME: 'SanFrancisco', DISPLAY_NAME: 'San Francisco',
        CENTER_LAT: 37.7749, CENTER_LON: -122.4194,
        BBOX_MIN_LAT: 37.700, BBOX_MAX_LAT: 37.820, BBOX_MIN_LON: -122.520, BBOX_MAX_LON: -122.350,
        ZOOM_LEVEL: 11, ORS_REGION_KEY: 'SanFrancisco', DATA_SOURCE: 'S3_BASELINE', IS_DEFAULT: true,
      }];
    }
    const defaultActive = regions.find((r) => r.IS_DEFAULT === true || r.IS_DEFAULT === 'true')?.REGION_NAME || regions[0]?.REGION_NAME || 'SanFrancisco';
    const override = getActiveRegionOverride();
    const active = override && regions.find((r) => r.REGION_NAME === override) ? override : defaultActive;
    return NextResponse.json({ regions, active });
  } catch (err) {
    log('ERROR', 'Region', `/api/regions error: ${(err as Error).message?.slice(0, 200)}`);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
});
