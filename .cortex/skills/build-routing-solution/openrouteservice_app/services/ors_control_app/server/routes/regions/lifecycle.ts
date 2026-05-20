// Region lifecycle endpoints — listing + active region setter.
// /api/regions             GET   merged registry+catalog+telemetry view
// /api/regions/active      GET   currently-marked-default region row
// /api/regions/active      POST  set active region (mutates CONFIGs)

import { Router } from 'express';
import { SF_DATABASE } from '../../constants.js';
import { runSql } from '../../lib/sql.js';
import { escapeString } from '../../lib/sanitize.js';
import { getActiveRegionOverride, setActiveRegionOverride } from '../../lib/state.js';
import { log } from '../../diagnostics.js';

export function createRegionsLifecycleRouter(): Router {
  const router = Router();

  router.get('/api/regions', async (_req, res) => {
    try {
      let regions: any[] = [];
      try {
        regions = await runSql(
          `SELECT rr.REGION_NAME, rr.DISPLAY_NAME, rr.CENTER_LAT, rr.CENTER_LON,
                  rr.BBOX_MIN_LAT, rr.BBOX_MAX_LAT, rr.BBOX_MIN_LON, rr.BBOX_MAX_LON,
                  rr.ZOOM_LEVEL, rr.ORS_REGION_KEY, rr.DATA_SOURCE, rr.IS_DEFAULT,
                  -- Boundary fields from REGION_CATALOG (joined via LOOKUP_NAME).
                  -- Returned as GeoJSON string for direct deck.gl + turf.js use.
                  CAST(ST_ASGEOJSON(rc.BOUNDARY) AS VARCHAR) AS BOUNDARY_GEOJSON,
                  rc.BOUNDARY_SOURCE,
                  rc.BOUNDARY_AREA_KM2,
                  rc.BOUNDARY_BAKED_AT,
                  ST_X(ST_CENTROID(rc.BOUNDARY))::FLOAT AS BOUNDARY_CENTROID_LON,
                  ST_Y(ST_CENTROID(rc.BOUNDARY))::FLOAT AS BOUNDARY_CENTROID_LAT,
                  rc.ISO_COUNTRY_A2,
                  rc.ISO_COUNTRY_A3,
                  rc.ISO_SUBDIVISION
           FROM FLEET_INTELLIGENCE.CORE.REGION_REGISTRY rr
           LEFT JOIN OPENROUTESERVICE_APP.CORE.REGION_CATALOG rc
             ON rc.BOUNDARY IS NOT NULL
            AND (UPPER(rc.LOOKUP_NAME) = UPPER(rr.ORS_REGION_KEY)
                 OR UPPER(rc.REGION_KEY) = UPPER(rr.ORS_REGION_KEY))
           QUALIFY ROW_NUMBER() OVER (PARTITION BY rr.REGION_NAME ORDER BY COALESCE(rc.BOUNDARY_AREA_KM2, 1e15) ASC) = 1
           ORDER BY rr.IS_DEFAULT DESC, rr.PROVISIONED_AT`,
          'FLEET_INTELLIGENCE', 'CORE'
        );
      } catch {}
      const knownNames = new Set(regions.map((r: any) => r.REGION_NAME));
      try {
        const orsMapRows = await runSql(`SELECT REGION, DISPLAY_NAME, MIN_LAT, MAX_LAT, MIN_LON, MAX_LON FROM ${SF_DATABASE}.CORE.REGION_ORS_MAP`);
        for (const row of orsMapRows || []) {
          if (row.REGION && !knownNames.has(row.REGION)) {
            const centerLat = ((row.MIN_LAT || 0) + (row.MAX_LAT || 0)) / 2;
            const centerLon = ((row.MIN_LON || 0) + (row.MAX_LON || 0)) / 2;
            regions.push({
              REGION_NAME: row.REGION,
              DISPLAY_NAME: row.DISPLAY_NAME || row.REGION,
              CENTER_LAT: centerLat, CENTER_LON: centerLon,
              BBOX_MIN_LAT: row.MIN_LAT, BBOX_MAX_LAT: row.MAX_LAT,
              BBOX_MIN_LON: row.MIN_LON, BBOX_MAX_LON: row.MAX_LON,
              ZOOM_LEVEL: 11, ORS_REGION_KEY: row.REGION,
              DATA_SOURCE: 'ORS_REGION', IS_DEFAULT: false,
            });
            knownNames.add(row.REGION);
          }
        }
        // Also include the default ORS stage region (e.g. SanFrancisco) if not already listed
        try {
          const stageRows = await runSql(`LIST @${SF_DATABASE}.CORE.ORS_SPCS_STAGE PATTERN='.*ors-config.*'`);
          for (const row of stageRows || []) {
            const path = row.name || row.NAME || '';
            const match = path.match(/ors_spcs_stage\/([^/]+)\/ors-config/i);
            if (match) {
              const stageRegion = match[1];
              if (!knownNames.has(stageRegion)) {
                const mapRow = (await runSql(`SELECT * FROM ${SF_DATABASE}.CORE.REGION_ORS_MAP WHERE REGION = '${escapeString(stageRegion)}'`).catch(() => []))?.[0];
                regions.unshift({
                  REGION_NAME: stageRegion,
                  DISPLAY_NAME: mapRow?.DISPLAY_NAME || stageRegion,
                  CENTER_LAT: mapRow ? ((mapRow.MIN_LAT || 0) + (mapRow.MAX_LAT || 0)) / 2 : 37.7749,
                  CENTER_LON: mapRow ? ((mapRow.MIN_LON || 0) + (mapRow.MAX_LON || 0)) / 2 : -122.4194,
                  BBOX_MIN_LAT: mapRow?.MIN_LAT ?? 37.700, BBOX_MAX_LAT: mapRow?.MAX_LAT ?? 37.820,
                  BBOX_MIN_LON: mapRow?.MIN_LON ?? -122.520, BBOX_MAX_LON: mapRow?.MAX_LON ?? -122.350,
                  ZOOM_LEVEL: 11, ORS_REGION_KEY: stageRegion,
                  DATA_SOURCE: 'ORS_DEFAULT', IS_DEFAULT: true,
                });
                knownNames.add(stageRegion);
              }
            }
          }
        } catch {}
      } catch {}
      try {
        // For regions that exist only in FACT_VEHICLE_TELEMETRY (e.g. user
        // generated data via Data Studio for a region not yet promoted to
        // REGION_REGISTRY), resolve geometry from REGION_CATALOG when possible
        // (real Geofabrik polygons, baked by build_boundaries.py), otherwise
        // fall back to a centroid/envelope derived from the telemetry itself.
        // This replaces the previous behaviour of returning CENTER_LAT=0,
        // CENTER_LON=0 (null island).
        const synthRows = await runSql(`
          WITH telemetry_regions AS (
            SELECT DISTINCT REGION FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY WHERE REGION IS NOT NULL
          ),
          catalog_match AS (
            SELECT
              t.REGION                                                AS REGION_NAME,
              rc.BOUNDARY                                             AS BOUNDARY,
              COALESCE(rc.LOOKUP_NAME, rc.REGION_KEY, t.REGION)       AS ORS_REGION_KEY
            FROM telemetry_regions t
            LEFT JOIN OPENROUTESERVICE_APP.CORE.REGION_CATALOG rc
              ON rc.BOUNDARY IS NOT NULL
             AND (UPPER(rc.LOOKUP_NAME) = UPPER(t.REGION)
                  OR UPPER(rc.REGION_KEY) = UPPER(t.REGION)
                  OR UPPER(rc.REGION_NAME) = UPPER(t.REGION))
            QUALIFY ROW_NUMBER() OVER (PARTITION BY t.REGION ORDER BY rc.BOUNDARY_AREA_KM2 ASC NULLS LAST) = 1
          ),
          telemetry_hull AS (
            SELECT
              REGION                                                  AS REGION_NAME,
              ST_MAKEPOLYGON(TO_GEOGRAPHY('LINESTRING(' ||
                MIN(LONGITUDE) || ' ' || MIN(LATITUDE) || ',' ||
                MAX(LONGITUDE) || ' ' || MIN(LATITUDE) || ',' ||
                MAX(LONGITUDE) || ' ' || MAX(LATITUDE) || ',' ||
                MIN(LONGITUDE) || ' ' || MAX(LATITUDE) || ',' ||
                MIN(LONGITUDE) || ' ' || MIN(LATITUDE) || ')'))      AS BOUNDARY
            FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY
            WHERE REGION IS NOT NULL
              AND LATITUDE IS NOT NULL AND LONGITUDE IS NOT NULL
            GROUP BY REGION
          ),
          resolved AS (
            SELECT
              c.REGION_NAME,
              COALESCE(c.BOUNDARY, h.BOUNDARY)                          AS BOUNDARY,
              CASE WHEN c.BOUNDARY IS NOT NULL THEN 'catalog' ELSE 'telemetry-bbox' END AS BOUNDARY_SOURCE,
              c.ORS_REGION_KEY
            FROM catalog_match c
            LEFT JOIN telemetry_hull h ON h.REGION_NAME = c.REGION_NAME
          )
          SELECT
            REGION_NAME,
            BOUNDARY_SOURCE,
            ORS_REGION_KEY,
            ST_Y(ST_CENTROID(BOUNDARY))::FLOAT AS CENTER_LAT,
            ST_X(ST_CENTROID(BOUNDARY))::FLOAT AS CENTER_LON,
            ST_YMIN(BOUNDARY)::FLOAT          AS BBOX_MIN_LAT,
            ST_YMAX(BOUNDARY)::FLOAT          AS BBOX_MAX_LAT,
            ST_XMIN(BOUNDARY)::FLOAT          AS BBOX_MIN_LON,
            ST_XMAX(BOUNDARY)::FLOAT          AS BBOX_MAX_LON,
            CAST(ST_ASGEOJSON(BOUNDARY) AS VARCHAR) AS BOUNDARY_GEOJSON
          FROM resolved
        `);
        for (const row of synthRows || []) {
          if (row.REGION_NAME && !knownNames.has(row.REGION_NAME)) {
            regions.push({
              REGION_NAME: row.REGION_NAME,
              DISPLAY_NAME: String(row.REGION_NAME).replace(/([A-Z])/g, ' $1').trim(),
              CENTER_LAT: row.CENTER_LAT ?? 0,
              CENTER_LON: row.CENTER_LON ?? 0,
              BBOX_MIN_LAT: row.BBOX_MIN_LAT ?? null,
              BBOX_MAX_LAT: row.BBOX_MAX_LAT ?? null,
              BBOX_MIN_LON: row.BBOX_MIN_LON ?? null,
              BBOX_MAX_LON: row.BBOX_MAX_LON ?? null,
              ZOOM_LEVEL: 11,
              ORS_REGION_KEY: row.ORS_REGION_KEY ?? null,
              DATA_SOURCE: 'SYNTHETIC',
              IS_DEFAULT: false,
              BOUNDARY_GEOJSON: row.BOUNDARY_GEOJSON ?? null,
              BOUNDARY_SOURCE: row.BOUNDARY_SOURCE ?? null,
            });
            knownNames.add(row.REGION_NAME);
          }
        }
      } catch (e: any) {
        log('WARN', 'Region', `synthetic-region geometry resolve failed: ${e.message?.slice(0, 150)}`);
      }
      if (regions.length === 0) {
        regions = [{
          REGION_NAME: 'SanFrancisco',
          DISPLAY_NAME: 'San Francisco',
          CENTER_LAT: 37.7749, CENTER_LON: -122.4194,
          BBOX_MIN_LAT: 37.700, BBOX_MAX_LAT: 37.820, BBOX_MIN_LON: -122.520, BBOX_MAX_LON: -122.350,
          ZOOM_LEVEL: 11, ORS_REGION_KEY: 'SanFrancisco',
          DATA_SOURCE: 'S3_BASELINE', IS_DEFAULT: true,
        }];
      }
      const defaultActive = regions.find((r: any) => r.IS_DEFAULT === true || r.IS_DEFAULT === 'true')?.REGION_NAME || regions[0]?.REGION_NAME || 'SanFrancisco';
      const active = getActiveRegionOverride() && regions.find((r: any) => r.REGION_NAME === getActiveRegionOverride()) ? getActiveRegionOverride() : defaultActive;
      res.json({ regions, active });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/regions/active', async (_req, res) => {
    try {
      const rows = await runSql(
        `SELECT REGION_NAME, DISPLAY_NAME, CENTER_LAT, CENTER_LON,
                BBOX_MIN_LAT, BBOX_MAX_LAT, BBOX_MIN_LON, BBOX_MAX_LON,
                ZOOM_LEVEL, ORS_REGION_KEY, DATA_SOURCE
         FROM FLEET_INTELLIGENCE.CORE.REGION_REGISTRY
         WHERE IS_DEFAULT = TRUE LIMIT 1`,
        'FLEET_INTELLIGENCE', 'CORE'
      );
      res.json(rows[0] || {
        REGION_NAME: 'SanFrancisco',
        DISPLAY_NAME: 'San Francisco',
        CENTER_LAT: 37.7749,
        CENTER_LON: -122.4194,
        ZOOM_LEVEL: 11,
      });
    } catch {
      res.json({
        REGION_NAME: 'SanFrancisco',
        DISPLAY_NAME: 'San Francisco',
        CENTER_LAT: 37.7749,
        CENTER_LON: -122.4194,
        ZOOM_LEVEL: 11,
      });
    }
  });

  router.post('/api/regions/active', async (req, res) => {
    try {
      const { region } = req.body;
      if (!region) return res.status(400).json({ error: 'region required' });
      try {
        await runSql(
          `CALL FLEET_INTELLIGENCE.CORE.SET_ACTIVE_REGION('${region.replace(/'/g, "''")}')`,
          'FLEET_INTELLIGENCE', 'CORE'
        );
      } catch (e: any) {
        log('WARN', 'Region', `SET_ACTIVE_REGION not available: ${e.message?.slice(0, 100)}`);
      }
      setActiveRegionOverride(region);
      const safeRegion = escapeString(region);
      const CONFIG_SCHEMAS = [
        'FLEET_INTELLIGENCE.DWELL_ANALYSIS',
        'FLEET_INTELLIGENCE.ROUTE_DEVIATION',
        'FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS',
        'FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY',
        'FLEET_INTELLIGENCE.RETAIL_CATCHMENT',
        'FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION',
        'FLEET_INTELLIGENCE.BACKLOAD_MATCHING',
      ];
      for (const schema of CONFIG_SCHEMAS) {
        try {
          await runSql(`UPDATE ${schema}.CONFIG SET REGION = '${safeRegion}'`);
        } catch (e: any) {
          log('WARN', 'CONFIG', `Failed to update ${schema}.CONFIG region: ${e.message}`);
        }
      }
      try {
        await runSql(
          `CALL FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SEED_ROUTE_OPTIMIZATION_REGION('${safeRegion}')`,
          'FLEET_INTELLIGENCE', 'ROUTE_OPTIMIZATION'
        );
      } catch (e: any) {
        log('WARN', 'RouteOpt', `Auto-seed PLACES for ${region}: ${e.message?.slice(0, 200)}`);
      }
      res.json({ ok: true, region });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
