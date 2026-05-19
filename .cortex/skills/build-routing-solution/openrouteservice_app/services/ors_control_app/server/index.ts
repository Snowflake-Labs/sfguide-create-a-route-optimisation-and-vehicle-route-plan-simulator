import express from 'express';
import cors from 'cors';
import { config } from 'dotenv';
import { existsSync } from 'fs';
import { join } from 'path';
import { createStudioRouter } from './studio/routes.js';
import { reconcileStaleJobs, setRegionActivatedHandler } from './studio/jobs.js';
import { log, getEntries, clearEntries, getUptimeMs } from './diagnostics.js';
import { IS_SPCS, SF_DATABASE, SF_WAREHOUSE, setWarehouse, CONN, SNOWFLAKE_HOST, DEFAULT_WAREHOUSE } from './constants.js';
import { safeRegionIdent, orsServiceName, orsServiceFqn, isDefaultRegion, currentRegionScalar, DEFAULT_REGION_NAME } from './lib/region.js';
import { sanitizeIdentifier, sanitizeFloat, sanitizeInt, escapeString, getSpcsToken, toIso } from './lib/sanitize.js';
import { snowSqlLocal, snowSqlSpcs, runSql, callProcedure, submitSqlAsync, cancelStatement } from './lib/sql.js';
import { detectWarehouse } from './lib/warehouse.js';
import { waitForOrsGraphReady, getExpectedProfiles, DEFAULT_PROFILES } from './lib/ors.js';
import { roadPointsCacheKey, roadPointsCacheGet, roadPointsCacheSet, formatUptime } from './lib/cache.js';
import { ensureBackloadAndAssetVelocityObjects } from './lib/init.js';
import { createStatusRouter } from './routes/status.js';
import { createServicesRouter } from './routes/services.js';
import { createDiagnosticsRouter } from './routes/diagnostics.js';
import { createSamplingRouter } from './routes/sampling.js';
import { createFleetRouter } from './routes/fleet.js';
import { createMatrixRouter } from './routes/matrix.js';
import { createAgentRouter } from './routes/agent.js';
import { createRegionsRouter } from './routes/regions/index.js';
import { createQueryRouter } from './routes/query.js';
import { createStaticRouter } from './routes/static.js';
import { getActiveRegionOverride, setActiveRegionOverride } from './lib/state.js';

config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));






const APP_VERSION = process.env.APP_VERSION || '0.0.0';

app.use(createStatusRouter(APP_VERSION));
app.use(createServicesRouter());
app.use(createDiagnosticsRouter(APP_VERSION));
app.use(createSamplingRouter());
app.use(createFleetRouter());
app.use(createRegionsRouter());
app.use(createMatrixRouter());
app.use(createAgentRouter());

app.post('/api/backload/seed', async (req, res) => {
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

app.use('/api/studio', createStudioRouter(runSql));

app.use(createQueryRouter());

const distDir = join(import.meta.dirname || '.', '../dist');

app.use(createStaticRouter(distDir));

async function verifySessionUtc(): Promise<void> {
  try {
    const rows = await runSql(`SELECT TO_VARCHAR(CURRENT_TIMESTAMP(),'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM') AS NOW_LTZ, TO_VARCHAR(SYSDATE(),'YYYY-MM-DD"T"HH24:MI:SS.FF3') AS NOW_UTC`);
    const nowLtz: string = rows?.[0]?.NOW_LTZ || '';
    const nowUtc: string = rows?.[0]?.NOW_UTC || '';
    const ok = /\+00:?00$/.test(nowLtz) || /Z$/.test(nowLtz);
    if (!ok) {
      console.error(`[FATAL] Session TZ guard failed. CURRENT_TIMESTAMP=${nowLtz} (expected +00:00). SYSDATE=${nowUtc}.`);
      process.exit(1);
    }
    console.log(`[TZ guard] Session is UTC. CURRENT_TIMESTAMP=${nowLtz} SYSDATE=${nowUtc}`);
  } catch (err: any) {
    console.error(`[FATAL] Session TZ guard query failed: ${err.message?.slice(0, 300)}`);
    process.exit(1);
  }
}

const PORT = parseInt(process.env.PORT || '3001');
detectWarehouse().then(verifySessionUtc).then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ORS Control App server running on port ${PORT} (SPCS: ${IS_SPCS}, WH: ${SF_WAREHOUSE})`);
  });
  reconcileStaleJobs(runSql, 30).catch((e) => {
    log('WARN', 'Studio', `Boot reconcile failed: ${e?.message?.slice(0, 200)}`);
  });

  // Hydrate getActiveRegionOverride() from REGION_REGISTRY so the user's last
  // region selection survives SPCS container restarts. POST /api/regions/active
  // already persists the choice to REGION_REGISTRY.IS_DEFAULT (via the
  // SET_ACTIVE_REGION procedure), but the in-memory override resets to null
  // on every container boot. Read it back here so the next /api/regions call
  // returns the persisted active region instead of falling back to the seeded
  // SanFrancisco default.
  (async () => {
    try {
      const rows = await runSql(
        `SELECT REGION_NAME FROM FLEET_INTELLIGENCE.CORE.REGION_REGISTRY WHERE IS_DEFAULT = TRUE LIMIT 1`,
        'FLEET_INTELLIGENCE', 'CORE',
      );
      const persisted = rows?.[0]?.REGION_NAME;
      if (persisted) {
        setActiveRegionOverride(persisted);
        log('INFO', 'Region', `Hydrated getActiveRegionOverride() from REGION_REGISTRY: ${persisted}`);
      }
    } catch (e: any) {
      log('WARN', 'Region', `getActiveRegionOverride() hydrate failed: ${e?.message?.slice(0, 150)}`);
    }
  })();

  // Wire Data Studio completion -> immediately refresh in-memory override so
  // the freshly generated region appears as active without waiting for the
  // user to click the switcher (or for a container restart to re-hydrate).
  setRegionActivatedHandler((region: string) => {
    if (!region) return;
    setActiveRegionOverride(region);
    log('INFO', 'Region', `Active region updated by Data Studio: ${region}`);
  });

  // Boot-time idempotent init: ensure Backload Matching schema/views and
  // Asset Velocity views exist on every container start. This makes both demos
  // work out-of-the-box on a fresh install without requiring a manual
  // `snow sql -f bootstrap.sql` step.
  (async () => {
    try {
      await ensureBackloadAndAssetVelocityObjects(runSql);
      log('INFO', 'Init', 'Backload Matching + Asset Velocity objects ensured');
    } catch (e: any) {
      log('WARN', 'Init', `Boot init failed: ${e?.message?.slice(0, 200)}`);
    }
  })();
});