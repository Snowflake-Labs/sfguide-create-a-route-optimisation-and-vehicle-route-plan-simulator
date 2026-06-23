// /api/fleet-config + /api/datasets — dataset picker and vehicle-type
// switching endpoints. Mutate the per-demo CONFIG tables.

import { Router } from 'express';
import { runSql } from '../lib/sql.js';
import { escapeString } from '../lib/sanitize.js';
import { setActiveRegionOverride } from '../lib/state.js';
import { activateDataset } from '../studio/jobs.js';
import { log } from '../diagnostics.js';

const FLEET_CONFIG_SCHEMAS = [
  'FLEET_INTELLIGENCE.DWELL_ANALYSIS',
  'FLEET_INTELLIGENCE.ROUTE_DEVIATION',
  'FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS',
  'FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY',
  'FLEET_INTELLIGENCE.CATCHMENT',
  'FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION',
];

const ORS_PROFILE_TO_VEHICLE_TYPE: Record<string, string> = {
  'cycling-electric': 'ebike',
  'driving-hgv': 'hgv',
  'driving-car': 'car',
  'cycling-road': 'ebike',
};

const VEHICLE_TYPE_TO_ORS_PROFILE: Record<string, string> = {
  ebike: 'cycling-electric',
  hgv: 'driving-hgv',
  car: 'driving-car',
};

/** Hybrid preset profile: GENERATION_JOBS → VEHICLE_CLASS_PROFILE → legacy map. */
async function resolveOrsProfile(
  vehicleType: string,
  activeDatasetId: string | null,
): Promise<string> {
  if (activeDatasetId) {
    try {
      const rows = await runSql(
        `SELECT j.ORS_PROFILE
           FROM FLEET_INTELLIGENCE.CORE.GENERATION_JOBS j
          WHERE j.JOB_ID = '${escapeString(activeDatasetId)}'
          LIMIT 1`,
        'FLEET_INTELLIGENCE', 'CORE',
      );
      const fromJob = (rows[0] as any)?.ORS_PROFILE;
      if (fromJob) return String(fromJob);
    } catch {}
  }
  try {
    const rows = await runSql(
      `SELECT ORS_PROFILE FROM OPENROUTESERVICE_APP.CORE.VEHICLE_CLASS_PROFILE
        WHERE VEHICLE_TYPE = '${escapeString(vehicleType)}' LIMIT 1`,
      'OPENROUTESERVICE_APP', 'CORE',
    );
    const fromClass = (rows[0] as any)?.ORS_PROFILE;
    if (fromClass) return String(fromClass);
  } catch {}
  return VEHICLE_TYPE_TO_ORS_PROFILE[vehicleType] || 'driving-car';
}

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
      let activeDatasetId: string | null = null;
      try {
        const dsRows = await runSql(
          `SELECT DATASET_ID FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS
           WHERE REGION = '${escapeString(region)}' AND VEHICLE_TYPE = '${escapeString(vehicleType)}'
             AND IS_ACTIVE = TRUE LIMIT 1`,
          'FLEET_INTELLIGENCE', 'CORE',
        );
        if (dsRows?.[0]) activeDatasetId = (dsRows[0] as any).DATASET_ID;
      } catch {}
      let availableTypes: string[] = [];
      let datasetPairs: { vehicleType: string; region: string }[] = [];
      try {
        const rows = await runSql('SELECT DISTINCT VEHICLE_TYPE, REGION FROM SYNTHETIC_DATASETS.UNIFIED.V_FACT_TRIPS_CURRENT ORDER BY VEHICLE_TYPE, REGION');
        datasetPairs = rows.map((r: any) => ({ vehicleType: r.VEHICLE_TYPE, region: r.REGION })).filter((p: any) => p.vehicleType && p.region);
        availableTypes = [...new Set(datasetPairs.map(p => p.vehicleType))];
      } catch {}
      if (vehicleType && !availableTypes.includes(vehicleType)) availableTypes.push(vehicleType);
      if (availableTypes.length === 0) availableTypes = [vehicleType];
      const orsProfile = await resolveOrsProfile(vehicleType, activeDatasetId);
      res.json({ vehicleType, region, orsProfile, availableTypes, datasetPairs, activeDatasetId });
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
          COALESCE(rr.DISPLAY_NAME, j.REGION) AS REGION_DISPLAY,
          COALESCE(d.IS_ACTIVE, FALSE) AS DATASET_IS_ACTIVE,
          (SELECT COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET f
           WHERE f.JOB_ID = j.JOB_ID) AS FLEET_ROW_COUNT
        FROM FLEET_INTELLIGENCE.CORE.GENERATION_JOBS j
        LEFT JOIN FLEET_INTELLIGENCE.CORE.REGION_REGISTRY rr ON rr.REGION_NAME = j.REGION
        LEFT JOIN FLEET_INTELLIGENCE.CORE.DIM_DATASETS d ON d.DATASET_ID = j.JOB_ID
        WHERE j.STATUS IN ('COMPLETED', 'STOPPED')
          AND j.TRIPS_GENERATED > 0
        ORDER BY j.COMPLETED_AT DESC
      `, 'FLEET_INTELLIGENCE', 'CORE');

      const datasets = (rows || []).map((r: any) => {
        const vehicleType = r.CFG_VEHICLE_TYPE || ORS_PROFILE_TO_VEHICLE_TYPE[r.ORS_PROFILE] || 'car';
        // isActive is derived from DIM_DATASETS.IS_ACTIVE, NOT from
        // a region+vehicle equality check, so at most ONE dataset per
        // (region, vehicle) shows the Active badge — the one whose
        // JOB_ID matches the current DIM_DATASETS row with IS_ACTIVE=TRUE.
        const fleetRowCount = Number(r.FLEET_ROW_COUNT ?? 0);
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
          isActive: r.DATASET_IS_ACTIVE === true || r.DATASET_IS_ACTIVE === 'true',
          fleetRowCount,
          isAvailable: fleetRowCount > 0,
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
      const { jobId, region: bodyRegion, vehicleType: bodyVt } = req.body || {};
      let region = bodyRegion as string | undefined;
      let vehicleType = bodyVt as string | undefined;

      // Per-dataset path: jobId provided. Resolve scope from DIM_DATASETS
      // and atomically flip IS_ACTIVE for that (region, vehicle) so the
      // V_*_CURRENT views immediately project the picked dataset.
      if (jobId) {
        try {
          const result = await activateDataset(runSql, String(jobId));
          region = result.region;
          vehicleType = result.vehicleType;
        } catch (e: any) {
          if (e.code === 'DATASET_EMPTY') {
            return res.status(409).json({
              code: 'DATASET_EMPTY',
              error: e.message,
              region: e.region,
              vehicleType: e.vehicleType,
            });
          }
          if (e.code === 'BOOT_INCOMPLETE') {
            return res.status(503).json({ code: 'BOOT_INCOMPLETE', error: e.message });
          }
          // Fallback: if DIM_DATASETS row is missing (legacy backfill miss),
          // create one from GENERATION_JOBS so this and future picks work.
          if (/not found/i.test(e.message || '')) {
            const rows = await runSql(
              `SELECT j.REGION, j.ORS_PROFILE, j.CONFIG:vehicleType::STRING AS CFG_VT
               FROM FLEET_INTELLIGENCE.CORE.GENERATION_JOBS j
               WHERE j.JOB_ID = '${escapeString(String(jobId))}' LIMIT 1`,
              'FLEET_INTELLIGENCE', 'CORE',
            );
            if (!rows.length) {
              return res.status(404).json({ error: `Job ${jobId} not found` });
            }
            const row = rows[0] as any;
            const vt = row.CFG_VT || ORS_PROFILE_TO_VEHICLE_TYPE[row.ORS_PROFILE] || 'car';
            const fleetProbe = await runSql(
              `SELECT COUNT(*) AS N FROM SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET
               WHERE JOB_ID = '${escapeString(String(jobId))}'`,
              'SYNTHETIC_DATASETS', 'UNIFIED',
            );
            if (Number((fleetProbe[0] as any)?.N ?? 0) === 0) {
              return res.status(409).json({
                code: 'DATASET_EMPTY',
                error: `Dataset ${jobId} has 0 rows in DIM_FLEET; re-run Data Studio.`,
                region: row.REGION,
                vehicleType: vt,
              });
            }
            // Insert a DIM_DATASETS row and mark active in scope.
            await runSql(
              `UPDATE FLEET_INTELLIGENCE.CORE.DIM_DATASETS
               SET IS_ACTIVE = FALSE
               WHERE REGION = '${escapeString(row.REGION)}'
                 AND VEHICLE_TYPE = '${escapeString(vt)}' AND IS_ACTIVE = TRUE`,
              'FLEET_INTELLIGENCE', 'CORE',
            );
            await runSql(
              `INSERT INTO FLEET_INTELLIGENCE.CORE.DIM_DATASETS
                 (DATASET_ID, REGION, VEHICLE_TYPE, LABEL, IS_ACTIVE)
               SELECT '${escapeString(String(jobId))}', '${escapeString(row.REGION)}',
                      '${escapeString(vt)}',
                      'recovered @ ' || TO_VARCHAR(CURRENT_TIMESTAMP, 'YYYY-MM-DD HH24:MI'),
                      TRUE`,
              'FLEET_INTELLIGENCE', 'CORE',
            );
            region = row.REGION;
            vehicleType = vt;
          } else {
            throw e;
          }
        }
      } else if (!region || !vehicleType) {
        return res.status(400).json({ error: 'jobId or (region+vehicleType) required' });
      }

      const safeRegion = escapeString(region!);
      const safeVehicleType = escapeString(vehicleType!);

      // 1. Flip IS_DEFAULT in REGION_REGISTRY (best-effort).
      try {
        await runSql(
          `CALL FLEET_INTELLIGENCE.CORE.SET_ACTIVE_REGION('${safeRegion}')`,
          'FLEET_INTELLIGENCE', 'CORE'
        );
      } catch (e: any) {
        log('WARN', 'Datasets', `SET_ACTIVE_REGION not available: ${e.message?.slice(0, 100)}`);
      }
      setActiveRegionOverride(region!);

      // 2. Update VEHICLE_TYPE + REGION on every demo CONFIG. We use the
      // union of the two schema lists (BACKLOAD_MATCHING is in CONFIG_SCHEMAS
      // but not FLEET_CONFIG_SCHEMAS).
      const ALL_CONFIG_SCHEMAS = [
        'FLEET_INTELLIGENCE.DWELL_ANALYSIS',
        'FLEET_INTELLIGENCE.ROUTE_DEVIATION',
        'FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS',
        'FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY',
        'FLEET_INTELLIGENCE.CATCHMENT',
        'FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION',
        'FLEET_INTELLIGENCE.BACKLOAD_MATCHING',
        'FLEET_INTELLIGENCE.MARKETPLACE',
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

      res.json({ ok: true, region, vehicleType, jobId: jobId ?? null });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/backload/seed', async (req, res) => {
    res.status(410).json({
      status: 'deprecated',
      error:
        'Backload seed endpoint is deprecated. Run Data Studio for the active preset to populate freight offers, fleet, and POIs.',
    });
  });


  return router;
}
