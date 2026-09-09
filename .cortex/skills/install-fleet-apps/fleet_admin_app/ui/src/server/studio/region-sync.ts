// REGION_REGISTRY upsert + CONFIG sync helper. Called once at the end of a
// successful generation job to (1) ensure the region exists in
// FLEET_INTELLIGENCE.CORE.REGION_REGISTRY using REGION_CATALOG boundary or
// telemetry-derived bbox, (2) promote the region to active via
// SET_ACTIVE_REGION, and (3) repoint all 6 fleet skills' CONFIG tables to
// the freshly generated (region, vehicleType).

import { log } from '../diagnostics';
import { regionCatalogMatch } from '../lib/region-catalog-match';

type SnowSqlFn = (sql: string, database?: string, schema?: string) => Promise<any[]>;

// The dashboard CONFIG schemas are DISCOVERED, not listed.
//
// There used to be three hardcoded lists in three separately-deployed packages -
// this one carried 8 schemas while the SA app's /api/region and the ops verb
// set_active_context carried 3 - so a region promote moved HALF the account and
// left the rest wherever the last Data Studio run had put it. Measured on
// tib85385: three domains on SanFrancisco, three on Europe, so a cross-domain
// question silently mixed San Francisco e-bikes with European trucks. The lists
// live in different npm packages, so any list-based fix drifts again.
//
// Discovery keys off the SHAPE of the table (a CONFIG table carrying both REGION
// and VEHICLE_TYPE), so a seventh domain is picked up with no code change.
// Schema names come from INFORMATION_SCHEMA and are re-validated against an
// identifier pattern before interpolation.
const CONFIG_DB = 'FLEET_INTELLIGENCE';
const IDENT_RE = /^[A-Z_][A-Z0-9_]*$/;

async function discoverConfigSchemas(snowSql: SnowSqlFn): Promise<string[]> {
  try {
    const rows = await snowSql(
      `SELECT TABLE_SCHEMA
         FROM ${CONFIG_DB}.INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME = 'CONFIG'
          AND COLUMN_NAME IN ('REGION', 'VEHICLE_TYPE')
        GROUP BY TABLE_SCHEMA
       HAVING COUNT(DISTINCT COLUMN_NAME) = 2
        ORDER BY TABLE_SCHEMA`,
    );
    return (rows ?? [])
      .map((r: any) => String(Object.values(r)[0] ?? '').toUpperCase())
      .filter((s: string) => IDENT_RE.test(s))
      .map((s: string) => `${CONFIG_DB}.${s}`);
  } catch (e) {
    log('WARN', 'RegionSync', `CONFIG schema discovery failed: ${(e as Error).message}`);
    return [];
  }
}

export async function syncRegionRegistryAndConfig(
  region: string,
  vehicleType: string,
  jobId: string,
  snowSql: SnowSqlFn,
): Promise<void> {
  if (!region) return;
  const safeRegion = String(region).replace(/'/g, "''");
  const safeVehicleType = String(vehicleType || 'ebike').replace(/'/g, "''");

  // 1. Upsert REGION_REGISTRY using REGION_CATALOG boundary when available.
  //    The CTEs build a single-row driver with center + bbox derived from the
  //    best available geometry source.
  const mCat = regionCatalogMatch('', `'${safeRegion}'`);
  try {
    const upsertSql = `
      MERGE INTO FLEET_INTELLIGENCE.CORE.REGION_REGISTRY AS tgt
      USING (
        WITH cat AS (
          SELECT
            BOUNDARY                                AS BOUNDARY,
            'catalog'                               AS BOUNDARY_SOURCE,
            COALESCE(LOOKUP_NAME, REGION_KEY, REGION_NAME) AS CAT_LOOKUP
          FROM OPENROUTESERVICE_APP.CORE.REGION_CATALOG
          WHERE BOUNDARY IS NOT NULL
            AND ${mCat.predicate}
          QUALIFY ROW_NUMBER() OVER (ORDER BY ${mCat.rank}) = 1
        ),
        hull AS (
          SELECT
            ST_MAKEPOLYGON(TO_GEOGRAPHY('LINESTRING(' ||
              MIN(LONGITUDE) || ' ' || MIN(LATITUDE) || ',' ||
              MAX(LONGITUDE) || ' ' || MIN(LATITUDE) || ',' ||
              MAX(LONGITUDE) || ' ' || MAX(LATITUDE) || ',' ||
              MIN(LONGITUDE) || ' ' || MAX(LATITUDE) || ',' ||
              MIN(LONGITUDE) || ' ' || MIN(LATITUDE) || ')'))
                                                    AS BOUNDARY,
            'telemetry-bbox'                        AS BOUNDARY_SOURCE,
            NULL                                    AS CAT_LOOKUP
          FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY
          WHERE REGION = '${safeRegion}'
            AND LATITUDE IS NOT NULL AND LONGITUDE IS NOT NULL
          HAVING COUNT(*) > 0
        ),
        picked AS (
          SELECT * FROM cat
          UNION ALL
          SELECT * FROM hull WHERE NOT EXISTS (SELECT 1 FROM cat)
        )
        SELECT
          '${safeRegion}'                                       AS REGION_NAME,
          INITCAP(REGEXP_REPLACE('${safeRegion}', '([a-z])([A-Z])', '\\\\1 \\\\2')) AS DISPLAY_NAME,
          ST_Y(ST_CENTROID(BOUNDARY))::FLOAT                    AS CENTER_LAT,
          ST_X(ST_CENTROID(BOUNDARY))::FLOAT                    AS CENTER_LON,
          ST_CENTROID(BOUNDARY)                                 AS CENTER_POINT,
          ST_YMIN(BOUNDARY)::FLOAT                              AS BBOX_MIN_LAT,
          ST_YMAX(BOUNDARY)::FLOAT                              AS BBOX_MAX_LAT,
          ST_XMIN(BOUNDARY)::FLOAT                              AS BBOX_MIN_LON,
          ST_XMAX(BOUNDARY)::FLOAT                              AS BBOX_MAX_LON,
          ST_ENVELOPE(BOUNDARY)                                 AS BBOX,
          11                                                    AS ZOOM_LEVEL,
          COALESCE(CAT_LOOKUP, '${safeRegion}')                 AS ORS_REGION_KEY,
          'SYNTHETIC'                                           AS DATA_SOURCE,
          BOUNDARY_SOURCE                                       AS BOUNDARY_SOURCE
        FROM picked
      ) AS src
      ON tgt.REGION_NAME = src.REGION_NAME
      WHEN MATCHED THEN UPDATE SET
        DISPLAY_NAME    = COALESCE(tgt.DISPLAY_NAME, src.DISPLAY_NAME),
        CENTER_LAT      = src.CENTER_LAT,
        CENTER_LON      = src.CENTER_LON,
        CENTER_POINT    = src.CENTER_POINT,
        BBOX_MIN_LAT    = src.BBOX_MIN_LAT,
        BBOX_MAX_LAT    = src.BBOX_MAX_LAT,
        BBOX_MIN_LON    = src.BBOX_MIN_LON,
        BBOX_MAX_LON    = src.BBOX_MAX_LON,
        BBOX            = src.BBOX,
        ORS_REGION_KEY  = COALESCE(tgt.ORS_REGION_KEY, src.ORS_REGION_KEY),
        DATA_SOURCE     = COALESCE(tgt.DATA_SOURCE, src.DATA_SOURCE)
      WHEN NOT MATCHED THEN INSERT (
        REGION_NAME, DISPLAY_NAME, CENTER_LAT, CENTER_LON, CENTER_POINT,
        BBOX_MIN_LAT, BBOX_MAX_LAT, BBOX_MIN_LON, BBOX_MAX_LON, BBOX,
        ZOOM_LEVEL, ORS_REGION_KEY, DATA_SOURCE, IS_DEFAULT, PROVISIONED_AT
      ) VALUES (
        src.REGION_NAME, src.DISPLAY_NAME, src.CENTER_LAT, src.CENTER_LON, src.CENTER_POINT,
        src.BBOX_MIN_LAT, src.BBOX_MAX_LAT, src.BBOX_MIN_LON, src.BBOX_MAX_LON, src.BBOX,
        src.ZOOM_LEVEL, src.ORS_REGION_KEY, src.DATA_SOURCE, FALSE, CURRENT_TIMESTAMP()
      )
    `;
    await snowSql(upsertSql, 'FLEET_INTELLIGENCE', 'CORE');
    log('INFO', 'Studio', `Upserted REGION_REGISTRY for ${region}`, { jobId });
  } catch (e: any) {
    log('WARN', 'Studio', `REGION_REGISTRY upsert failed for ${region}: ${e.message?.slice(0, 200)}`, { jobId });
  }

  // 2. Promote the new region to active (flip IS_DEFAULT in REGION_REGISTRY).
  try {
    await snowSql(
      `CALL FLEET_INTELLIGENCE.CORE.SET_ACTIVE_REGION('${safeRegion}')`,
      'FLEET_INTELLIGENCE', 'CORE',
    );
    log('INFO', 'Studio', `Promoted ${region} to active region`, { jobId });
  } catch (e: any) {
    log('WARN', 'Studio', `SET_ACTIVE_REGION failed for ${region}: ${e.message?.slice(0, 200)}`, { jobId });
  }

  // 3. Update EVERY discovered CONFIG table so the app's default context is
  //    consistent across all domains. Since the contract views no longer FILTER
  //    on CONFIG, this is a default-selection hint rather than a data filter -
  //    but leaving the tables disagreeing still gives the app (and an agent
  //    reading the active context) contradictory answers per domain.
  const configSchemas = await discoverConfigSchemas(snowSql);
  for (const schema of configSchemas) {
    try {
      await snowSql(
        `UPDATE ${schema}.CONFIG SET VEHICLE_TYPE='${safeVehicleType}', REGION='${safeRegion}'`,
      );
    } catch (e: any) {
      log('WARN', 'Studio', `CONFIG update failed for ${schema}: ${e.message?.slice(0, 150)}`, { jobId });
    }
  }

  // 4. Build the CATCHMENT layer (Overture POIs/addresses) for this region if it
  //    is not already present, then rebuild the Freight Sourcing estate on top of
  //    it. Both are pure Snowflake SQL (no ORS) and run inside this detached job,
  //    so a multi-second CATCHMENT ingest here does not block any HTTP request.
  //    build-if-missing: BUILD_CATCHMENT returns early when the region already
  //    has POIs, so re-generating an existing region does not re-ingest Overture.
  try {
    await snowSql(
      `CALL FLEET_INTELLIGENCE.CATCHMENT.BUILD_CATCHMENT('${safeRegion}', FALSE)`,
      'FLEET_INTELLIGENCE', 'CATCHMENT',
    );
  } catch (e: any) {
    log('WARN', 'Studio', `BUILD_CATCHMENT failed for ${region}: ${e.message?.slice(0, 200)}`, { jobId });
  }
  try {
    await snowSql(
      `CALL FLEET_INTELLIGENCE.SOURCING.BUILD_SOURCING_DIAGNOSTICS('${safeRegion}')`,
      'FLEET_INTELLIGENCE', 'SOURCING',
    );
  } catch (e: any) {
    log('WARN', 'Studio', `BUILD_SOURCING_DIAGNOSTICS failed for ${region}: ${e.message?.slice(0, 200)}`, { jobId });
  }
}
