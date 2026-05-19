// /api/fleet-config + /api/datasets — dataset picker and vehicle-type
// switching endpoints. Mutate the per-demo CONFIG tables.

import { Router } from 'express';
import { runSql } from '../lib/sql.js';
import { escapeString } from '../lib/sanitize.js';
import { setActiveRegionOverride } from '../lib/state.js';
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

  return router;
}
