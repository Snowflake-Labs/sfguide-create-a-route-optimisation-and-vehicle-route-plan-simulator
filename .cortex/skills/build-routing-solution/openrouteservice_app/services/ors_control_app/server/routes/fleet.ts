// /api/fleet-config + /api/datasets — dataset picker and vehicle-type
// switching endpoints. Mutate the per-demo CONFIG tables.

import { Router } from 'express';
import { runSql } from '../lib/sql.js';
import { escapeString } from '../lib/sanitize.js';
import { setActiveRegionOverride } from '../lib/state.js';
import { ensureBackloadAndAssetVelocityObjects } from '../lib/init.js';
import { log } from '../diagnostics.js';

const FLEET_CONFIG_SCHEMAS = [
  'FLEET_INTELLIGENCE.DWELL_ANALYSIS',
  'FLEET_INTELLIGENCE.ROUTE_DEVIATION',
  'FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS',
  'FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY',
  'FLEET_INTELLIGENCE.RETAIL_CATCHMENT',
  'FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION',
];

const ORS_PROFILE_TO_VEHICLE_TYPE: Record<string, string> = {
  'cycling-electric': 'ebike',
  'driving-hgv': 'hgv',
  'driving-car': 'car',
  'cycling-road': 'ebike',
};

export function createFleetRouter(): Router {
  const router = Router();

  router.get('/api/fleet-config', async (_req, res) => {
    try {
      let vehicleType = 'ebike';
      let region = 'SanFrancisco';
      try {
        const rows = await runSql('SELECT VEHICLE_TYPE, REGION FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.CONFIG LIMIT 1');
        if (rows?.[0]) {
          vehicleType = rows[0].VEHICLE_TYPE || vehicleType;
          region = rows[0].REGION || region;
        }
      } catch {}
      let availableTypes: string[] = [];
      let datasetPairs: { vehicleType: string; region: string }[] = [];
      try {
        const rows = await runSql('SELECT DISTINCT VEHICLE_TYPE, REGION FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS ORDER BY VEHICLE_TYPE, REGION');
        datasetPairs = rows.map((r: any) => ({ vehicleType: r.VEHICLE_TYPE, region: r.REGION })).filter((p: any) => p.vehicleType && p.region);
        availableTypes = [...new Set(datasetPairs.map(p => p.vehicleType))];
      } catch {}
      if (vehicleType && !availableTypes.includes(vehicleType)) availableTypes.push(vehicleType);
      if (availableTypes.length === 0) availableTypes = [vehicleType];
      res.json({ vehicleType, region, availableTypes, datasetPairs });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/fleet-config/vehicle-type', async (req, res) => {
    try {
      const { vehicleType } = req.body;
      if (!vehicleType) return res.status(400).json({ error: 'vehicleType required' });
      const safeType = escapeString(vehicleType);
      for (const schema of FLEET_CONFIG_SCHEMAS) {
        try {
          await runSql(`UPDATE ${schema}.CONFIG SET VEHICLE_TYPE = '${safeType}'`);
        } catch (e: any) {
          log('WARN', 'CONFIG', `Failed to update ${schema}.CONFIG vehicleType: ${e.message}`);
        }
      }
      res.json({ ok: true, vehicleType });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /api/datasets — list completed Data Studio generation jobs as a single
  // unified dataset list. Used by the DatasetPicker header dropdown to replace
  // the separate region + vehicle-type switchers.
  // ---------------------------------------------------------------------------
  router.get('/api/datasets', async (_req, res) => {
    try {
      let currentRegion = 'SanFrancisco';
      let currentVehicleType = 'ebike';
      try {
        const cfgRows = await runSql('SELECT VEHICLE_TYPE, REGION FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.CONFIG LIMIT 1');
        if (cfgRows?.[0]) {
          currentRegion = cfgRows[0].REGION || currentRegion;
          currentVehicleType = cfgRows[0].VEHICLE_TYPE || currentVehicleType;
        }
      } catch {}

      const rows = await runSql(`
        SELECT
          j.JOB_ID,
          j.PRESET_NAME,
          j.REGION,
          j.ORS_PROFILE,
          j.STATUS,
          j.TRIPS_GENERATED AS TRIP_COUNT,
          j.POINTS_GENERATED AS POINT_COUNT,
          j.COMPLETED_AT,
          j.CONFIG:vehicleType::STRING AS CFG_VEHICLE_TYPE,
          COALESCE(rr.DISPLAY_NAME, j.REGION) AS REGION_DISPLAY
        FROM FLEET_INTELLIGENCE.CORE.GENERATION_JOBS j
        LEFT JOIN FLEET_INTELLIGENCE.CORE.REGION_REGISTRY rr ON rr.REGION_NAME = j.REGION
        WHERE j.STATUS IN ('COMPLETED', 'STOPPED')
          AND j.TRIPS_GENERATED > 0
        ORDER BY j.COMPLETED_AT DESC
      `, 'FLEET_INTELLIGENCE', 'CORE');

      const datasets = (rows || []).map((r: any) => {
        const vehicleType = r.CFG_VEHICLE_TYPE || ORS_PROFILE_TO_VEHICLE_TYPE[r.ORS_PROFILE] || 'car';
        return {
          jobId: r.JOB_ID,
          presetName: r.PRESET_NAME || `${r.REGION} ${r.ORS_PROFILE}`,
          region: r.REGION,
          regionDisplay: r.REGION_DISPLAY || r.REGION,
          orsProfile: r.ORS_PROFILE,
          vehicleType,
          tripCount: r.TRIP_COUNT ?? 0,
          pointCount: r.POINT_COUNT ?? 0,
          completedAt: r.COMPLETED_AT,
          isActive: r.REGION === currentRegion && vehicleType === currentVehicleType,
        };
      });

      res.json({ datasets, currentRegion, currentVehicleType });
    } catch (err: any) {
      res.status(500).json({ error: err.message, datasets: [] });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /api/datasets/activate — atomically activate a (region, vehicleType)
  // pair selected from the DatasetPicker. Updates VEHICLE_TYPE and REGION on
  // all 6 demo CONFIG tables in ONE server round-trip BEFORE returning, so
  // that when the React UI subsequently flips its state and remounts demo
  // components, the projection views (which read REGION/VEHICLE_TYPE via
  // `(SELECT ... FROM CONFIG LIMIT 1)`) already reflect the new selection.
  // This eliminates the race condition where demo components remount and
  // query CONFIG before /api/regions/active had time to write the new region.
  // ---------------------------------------------------------------------------
  router.post('/api/datasets/activate', async (req, res) => {
    try {
      const { region, vehicleType } = req.body || {};
      if (!region || !vehicleType) {
        return res.status(400).json({ error: 'region and vehicleType required' });
      }
      const safeRegion = escapeString(region);
      const safeVehicleType = escapeString(vehicleType);

      // 1. Flip IS_DEFAULT in REGION_REGISTRY (best-effort).
      try {
        await runSql(
          `CALL FLEET_INTELLIGENCE.CORE.SET_ACTIVE_REGION('${safeRegion}')`,
          'FLEET_INTELLIGENCE', 'CORE'
        );
      } catch (e: any) {
        log('WARN', 'Datasets', `SET_ACTIVE_REGION not available: ${e.message?.slice(0, 100)}`);
      }
      setActiveRegionOverride(region);

      // 2. Update VEHICLE_TYPE + REGION on every demo CONFIG. We use the
      // union of the two schema lists (BACKLOAD_MATCHING is in CONFIG_SCHEMAS
      // but not FLEET_CONFIG_SCHEMAS).
      const ALL_CONFIG_SCHEMAS = [
        'FLEET_INTELLIGENCE.DWELL_ANALYSIS',
        'FLEET_INTELLIGENCE.ROUTE_DEVIATION',
        'FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS',
        'FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY',
        'FLEET_INTELLIGENCE.RETAIL_CATCHMENT',
        'FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION',
        'FLEET_INTELLIGENCE.BACKLOAD_MATCHING',
      ];
      for (const schema of ALL_CONFIG_SCHEMAS) {
        try {
          await runSql(
            `UPDATE ${schema}.CONFIG SET VEHICLE_TYPE = '${safeVehicleType}', REGION = '${safeRegion}'`
          );
        } catch (e: any) {
          log('WARN', 'Datasets', `Failed to update ${schema}.CONFIG: ${e.message?.slice(0, 200)}`);
        }
      }

      // 3. Auto-seed PLACES for ROUTE_OPTIMIZATION (best-effort, mirrors
      // /api/regions/active behaviour).
      try {
        await runSql(
          `CALL FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SEED_ROUTE_OPTIMIZATION_REGION('${safeRegion}')`,
          'FLEET_INTELLIGENCE', 'ROUTE_OPTIMIZATION'
        );
      } catch (e: any) {
        log('WARN', 'Datasets', `Auto-seed PLACES for ${region}: ${e.message?.slice(0, 200)}`);
      }

      res.json({ ok: true, region, vehicleType });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/backload/seed', async (req, res) => {
    try {
      const region = String(req.body?.region || '').replace(/'/g, "''");
      if (!region) return res.status(400).json({ error: 'region required' });
      const vtRows = await runSql(
        `SELECT VEHICLE_TYPE FROM SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET
         WHERE REGION = '${region}' GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1`,
        'SYNTHETIC_DATASETS', 'UNIFIED',
      );
      const vt = String((vtRows[0] as any)?.VEHICLE_TYPE || 'hgv').replace(/'/g, "''");
      await ensureBackloadAndAssetVelocityObjects(runSql);
      await runSql(
        `UPDATE FLEET_INTELLIGENCE.BACKLOAD_MATCHING.CONFIG SET REGION = '${region}', VEHICLE_TYPE = '${vt}'`,
        'FLEET_INTELLIGENCE', 'BACKLOAD_MATCHING',
      );
      await runSql(
        `UPDATE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG SET REGION = '${region}', VEHICLE_TYPE = '${vt}'`,
        'FLEET_INTELLIGENCE', 'ROUTE_OPTIMIZATION',
      );
      await runSql(
        `INSERT INTO SYNTHETIC_DATASETS.UNIFIED.FACT_FREIGHT_OFFERS (
           OFFER_ID, REGION, VEHICLE_TYPE, SOURCE,
           PICKUP_POI_ID, PICKUP_LAT, PICKUP_LON, PICKUP_GEOM,
           DROPOFF_POI_ID, DROPOFF_LAT, DROPOFF_LON, DROPOFF_GEOM,
           PICKUP_FROM_TS, PICKUP_TO_TS, WEIGHT_KG, PRODUCT, PRICE_USD,
           HAZMAT, LISTING_TEXT, POSTED_AT, JOB_ID
         )
         WITH targets AS (
           SELECT DISTINCT
             p.REGION,
             COALESCE(t.VEHICLE_TYPE, '${vt}') AS VEHICLE_TYPE,
             p.JOB_ID
           FROM SYNTHETIC_DATASETS.UNIFIED.DIM_POIS p
           LEFT JOIN SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS t ON t.JOB_ID = p.JOB_ID
           WHERE p.REGION = '${region}'
             AND p.REGION NOT IN (SELECT DISTINCT REGION FROM SYNTHETIC_DATASETS.UNIFIED.FACT_FREIGHT_OFFERS WHERE REGION IS NOT NULL)
         ),
         pois_numbered AS (
           SELECT p.REGION, p.JOB_ID, p.LOCATION_ID, p.NAME, p.LAT, p.LNG, p.POINT_GEOM,
                  ROW_NUMBER() OVER (PARTITION BY p.REGION ORDER BY p.LOCATION_ID) AS RN,
                  COUNT(*)   OVER (PARTITION BY p.REGION) AS C
           FROM SYNTHETIC_DATASETS.UNIFIED.DIM_POIS p
           JOIN targets t ON t.REGION = p.REGION
         ),
         seq AS (
           SELECT t.REGION, t.VEHICLE_TYPE, t.JOB_ID, g.S
           FROM targets t
           CROSS JOIN (SELECT SEQ4()+1 AS S FROM TABLE(GENERATOR(ROWCOUNT => 300))) g
         ),
         pairs AS (
           SELECT s.REGION, s.VEHICLE_TYPE, s.JOB_ID, s.S,
                  p.LOCATION_ID AS P_ID, p.LNG AS P_LON, p.LAT AS P_LAT, p.POINT_GEOM AS P_GEOM, p.NAME AS P_NAME, p.C AS C,
                  q.LOCATION_ID AS Q_ID, q.LNG AS Q_LON, q.LAT AS Q_LAT, q.POINT_GEOM AS Q_GEOM, q.NAME AS Q_NAME
           FROM seq s
           JOIN pois_numbered p ON p.REGION = s.REGION AND p.RN = MOD(s.S * 7,  p.C) + 1
           JOIN pois_numbered q ON q.REGION = s.REGION AND q.RN = MOD(s.S * 13 + 5, q.C) + 1
           WHERE p.LOCATION_ID <> q.LOCATION_ID
         )
         SELECT
           'OFF-' || LPAD(S::VARCHAR, 6, '0') AS OFFER_ID,
           REGION, VEHICLE_TYPE,
           CASE WHEN LOWER(REGION) LIKE '%germany%' OR LOWER(REGION) LIKE '%europe%'
                THEN DECODE(MOD(S, 4), 0,'TIMOCOM', 1,'WTRANSNET', 2,'TELEROUTE', 3,'B2P')
                ELSE DECODE(MOD(S, 4), 0,'DAT', 1,'TRUCKSTOP', 2,'CONVOY', 3,'UBER_FREIGHT')
           END AS SOURCE,
           P_ID, P_LAT, P_LON, P_GEOM,
           Q_ID, Q_LAT, Q_LON, Q_GEOM,
           DATEADD(MINUTE, MOD(S * 73,  1100) + 60,  CURRENT_TIMESTAMP())  AS PICKUP_FROM_TS,
           DATEADD(MINUTE, MOD(S * 73,  1100) + 360, CURRENT_TIMESTAMP())  AS PICKUP_TO_TS,
           (800 + MOD(ABS(HASH(P_ID || Q_ID)), 24000))::NUMBER             AS WEIGHT_KG,
           DECODE(MOD(S, 6), 0,'Pallets (general)', 1,'Steel coils', 2,'Plastic granulate',
                             3,'Beverages', 4,'Furniture', 5,'Bulk paper')  AS PRODUCT,
           (400 + MOD(ABS(HASH(Q_ID || P_ID)), 4000))::NUMBER              AS PRICE_USD,
           MOD(S, 13) = 0                                                   AS HAZMAT,
           CASE WHEN LOWER(REGION) LIKE '%germany%' OR LOWER(REGION) LIKE '%europe%'
                THEN DECODE(MOD(S, 4), 0,'TIMOCOM', 1,'WTRANSNET', 2,'TELEROUTE', 3,'B2P')
                ELSE DECODE(MOD(S, 4), 0,'DAT', 1,'TRUCKSTOP', 2,'CONVOY', 3,'UBER_FREIGHT')
           END || ' ' || P_NAME || ' -> ' || Q_NAME                         AS LISTING_TEXT,
           CURRENT_TIMESTAMP()                                              AS POSTED_AT,
           JOB_ID
         FROM pairs`,
        'SYNTHETIC_DATASETS', 'UNIFIED',
      );
      const counts = await runSql(
        `SELECT
           (SELECT COUNT(*) FROM FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_TRAILERS) AS TRAILERS,
           (SELECT COUNT(*) FROM FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_INTERNAL_VOLUMES) AS INTERNAL_VOLUMES,
           (SELECT COUNT(*) FROM FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_EXTERNAL_OFFERS) AS EXTERNAL_OFFERS`,
        'FLEET_INTELLIGENCE', 'BACKLOAD_MATCHING',
      );
      res.json({ status: 'ok', region, vehicleType: vt, counts: counts[0] || {} });
    } catch (err: any) {
      log('ERROR', 'Backload', `seed failed: ${err.message?.slice(0, 300)}`);
      res.status(500).json({ status: 'error', error: err.message });
    }
  });


  return router;
}
