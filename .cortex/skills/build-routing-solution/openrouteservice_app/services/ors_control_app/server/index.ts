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
import { createStatusRouter } from './routes/status.js';
import { createServicesRouter } from './routes/services.js';
import { createDiagnosticsRouter } from './routes/diagnostics.js';
import { createSamplingRouter } from './routes/sampling.js';
import { createFleetRouter } from './routes/fleet.js';
import { createRegionsRouter } from './routes/regions/index.js';
import { createQueryRouter } from './routes/query.js';
import { createStaticRouter } from './routes/static.js';
import { getActiveRegionOverride, setActiveRegionOverride } from './lib/state.js';

config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));



// Idempotent boot-time init for Backload Matching (BACKLOAD_MATCHING schema +
// projection views over UNIFIED) and Asset Velocity (ROUTE_OPTIMIZATION views
// over DWELL_ANALYSIS DTs). Mirrors the contents of:
//   .cortex/skills/backload-matching/references/bootstrap.sql
//   .cortex/skills/route-optimization/references/asset-velocity-views.sql
// so a fresh install of build-routing-solution makes both demos work without
// requiring a manual `snow sql -f` step.
async function ensureBackloadAndAssetVelocityObjects(
  sqlFn: (sql: string, db?: string, schema?: string) => Promise<any[]>,
): Promise<void> {
  const TRACK = `'{"origin":"sf_sit-is-fleet","name":"oss-backload-matching","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}'`;
  const TRACK_RO = `'{"origin":"sf_sit-is-fleet","name":"oss-route-optimization","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}'`;
  const stmts: { sql: string; db?: string; schema?: string }[] = [
    {
      sql: `CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING COMMENT = ${TRACK}`,
      db: 'FLEET_INTELLIGENCE',
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING.CONFIG (
        VEHICLE_TYPE VARCHAR NOT NULL,
        REGION       VARCHAR NOT NULL
      ) COMMENT = ${TRACK}`,
      db: 'FLEET_INTELLIGENCE', schema: 'BACKLOAD_MATCHING',
    },
    {
      sql: `MERGE INTO FLEET_INTELLIGENCE.BACKLOAD_MATCHING.CONFIG tgt
            USING (SELECT 'hgv' AS VEHICLE_TYPE, 'SanFrancisco' AS REGION) src
            ON TRUE
            WHEN NOT MATCHED THEN INSERT (VEHICLE_TYPE, REGION) VALUES (src.VEHICLE_TYPE, src.REGION)`,
      db: 'FLEET_INTELLIGENCE', schema: 'BACKLOAD_MATCHING',
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING.PROPOSAL_DECISIONS (
        DECISION_ID VARCHAR DEFAULT UUID_STRING() PRIMARY KEY,
        TRAILER_ID  VARCHAR,
        OFFER_ID    VARCHAR,
        SOURCE      VARCHAR,
        SCORE       FLOAT,
        EMPTY_KM    FLOAT,
        DECIDED_BY  VARCHAR,
        DECIDED_AT  TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
        RATIONALE   VARCHAR
      ) COMMENT = ${TRACK}`,
      db: 'FLEET_INTELLIGENCE', schema: 'BACKLOAD_MATCHING',
    },
    {
      sql: `CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_TRAILERS
        COMMENT = ${TRACK}
        AS
        WITH last_drop AS (
          SELECT VEHICLE_ID,
                 MAX_BY(DESTINATION_LON, TRIP_END) AS DROPOFF_LON,
                 MAX_BY(DESTINATION_LAT, TRIP_END) AS DROPOFF_LAT,
                 MAX_BY(DESTINATION_POI_ID, TRIP_END) AS DROPOFF_POI_ID,
                 MAX(TRIP_END) AS LAST_TRIP_END
          FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS
          WHERE REGION       = ${currentRegionScalar('BACKLOAD_MATCHING')}
            AND VEHICLE_TYPE = (SELECT VEHICLE_TYPE FROM FLEET_INTELLIGENCE.BACKLOAD_MATCHING.CONFIG LIMIT 1)
          GROUP BY VEHICLE_ID
        ),
        home_anchor AS (
          SELECT AVG(LAT) AS HOME_LAT, AVG(LNG) AS HOME_LON
          FROM SYNTHETIC_DATASETS.UNIFIED.DIM_POIS
          WHERE REGION = ${currentRegionScalar('BACKLOAD_MATCHING')}
        )
        SELECT
          f.VEHICLE_ID                                        AS TRAILER_ID,
          f.REGION                                            AS OPERATING_COUNTRY,
          COALESCE(h.NAME, 'Home Depot')                      AS HOME_DEPOT,
          COALESCE(h.LNG, (SELECT HOME_LON FROM home_anchor)) AS HOME_LON,
          COALESCE(h.LAT, (SELECT HOME_LAT FROM home_anchor)) AS HOME_LAT,
          f.VEHICLE_TYPE                                      AS CURRENT_LOAD,
          COALESCE(d.NAME, 'Drop-off')                        AS DROPOFF_CITY,
          ld.DROPOFF_LON                                      AS DROPOFF_LON,
          ld.DROPOFF_LAT                                      AS DROPOFF_LAT,
          ld.LAST_TRIP_END                                    AS ETA_TS,
          DATEDIFF('minute', CURRENT_TIMESTAMP(), ld.LAST_TRIP_END) AS ETA_MIN,
          'IN_TRANSIT'                                        AS STATUS,
          FALSE                                               AS HAZMAT_CERT,
          COALESCE(NULLIF(f.BATTERY_RANGE_KM, 0), 24000)::NUMBER AS MAX_PAYLOAD_KG
        FROM SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET f
        JOIN last_drop ld ON ld.VEHICLE_ID = f.VEHICLE_ID
        LEFT JOIN SYNTHETIC_DATASETS.UNIFIED.DIM_POIS h ON h.LOCATION_ID = f.HOME_LOCATION_ID
        LEFT JOIN SYNTHETIC_DATASETS.UNIFIED.DIM_POIS d ON d.LOCATION_ID = ld.DROPOFF_POI_ID
        WHERE f.REGION       = ${currentRegionScalar('BACKLOAD_MATCHING')}
          AND f.VEHICLE_TYPE = (SELECT VEHICLE_TYPE FROM FLEET_INTELLIGENCE.BACKLOAD_MATCHING.CONFIG LIMIT 1)`,
      db: 'FLEET_INTELLIGENCE', schema: 'BACKLOAD_MATCHING',
    },
    {
      sql: `CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_INTERNAL_VOLUMES
        COMMENT = ${TRACK}
        AS
        SELECT
          'INT-' || LPAD(ROW_NUMBER() OVER (ORDER BY t.TRIP_START)::VARCHAR, 5, '0') AS ID,
          COALESCE(o.NAME, 'Origin')                                                  AS PICKUP_CITY,
          t.ORIGIN_LON                                                                AS PICKUP_LON,
          t.ORIGIN_LAT                                                                AS PICKUP_LAT,
          COALESCE(d.NAME, 'Destination')                                             AS DROPOFF_CITY,
          t.DESTINATION_LON                                                           AS DROPOFF_LON,
          t.DESTINATION_LAT                                                           AS DROPOFF_LAT,
          t.TRIP_START                                                                AS PICKUP_FROM_TS,
          DATEADD(hour, 4, t.TRIP_START)                                              AS PICKUP_TO_TS,
          (1000 + ABS(HASH(t.TRIP_ID)) % 24000)::NUMBER                               AS WEIGHT_KG,
          'B2B pallets'                                                               AS PRODUCT,
          FALSE                                                                       AS HAZMAT
        FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS t
        LEFT JOIN SYNTHETIC_DATASETS.UNIFIED.DIM_POIS o ON o.LOCATION_ID = t.ORIGIN_POI_ID
        LEFT JOIN SYNTHETIC_DATASETS.UNIFIED.DIM_POIS d ON d.LOCATION_ID = t.DESTINATION_POI_ID
        WHERE t.REGION       = ${currentRegionScalar('BACKLOAD_MATCHING')}
          AND t.VEHICLE_TYPE = (SELECT VEHICLE_TYPE FROM FLEET_INTELLIGENCE.BACKLOAD_MATCHING.CONFIG LIMIT 1)
        QUALIFY ROW_NUMBER() OVER (ORDER BY t.TRIP_START DESC) <= 120`,
      db: 'FLEET_INTELLIGENCE', schema: 'BACKLOAD_MATCHING',
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS SYNTHETIC_DATASETS.UNIFIED.FACT_FREIGHT_OFFERS (
        OFFER_ID VARCHAR, REGION VARCHAR(100), VEHICLE_TYPE VARCHAR(20),
        SOURCE VARCHAR(30),
        PICKUP_POI_ID VARCHAR, PICKUP_LAT FLOAT, PICKUP_LON FLOAT, PICKUP_GEOM GEOGRAPHY,
        DROPOFF_POI_ID VARCHAR, DROPOFF_LAT FLOAT, DROPOFF_LON FLOAT, DROPOFF_GEOM GEOGRAPHY,
        PICKUP_FROM_TS TIMESTAMP_NTZ, PICKUP_TO_TS TIMESTAMP_NTZ,
        WEIGHT_KG NUMBER, PRODUCT VARCHAR, PRICE_USD NUMBER, HAZMAT BOOLEAN,
        LISTING_TEXT VARCHAR, POSTED_AT TIMESTAMP_NTZ,
        JOB_ID VARCHAR
      ) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}'`,
      db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED',
    },
    {
      sql: `CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_EXTERNAL_OFFERS
        COMMENT = ${TRACK}
        AS
        SELECT
          f.OFFER_ID,
          f.SOURCE,
          COALESCE(SUBSTR(f.REGION, 1, 2), 'US')   AS PICKUP_COUNTRY,
          COALESCE(SUBSTR(f.REGION, 1, 2), 'US')   AS DROPOFF_COUNTRY,
          COALESCE(p.NAME, 'Pickup')               AS PICKUP_CITY,
          f.PICKUP_LON,
          f.PICKUP_LAT,
          COALESCE(d.NAME, 'Dropoff')              AS DROPOFF_CITY,
          f.DROPOFF_LON,
          f.DROPOFF_LAT,
          f.PICKUP_FROM_TS,
          f.PICKUP_TO_TS,
          f.WEIGHT_KG,
          f.PRODUCT,
          f.PRICE_USD                              AS PRICE_EUR,
          f.HAZMAT,
          f.LISTING_TEXT
        FROM SYNTHETIC_DATASETS.UNIFIED.FACT_FREIGHT_OFFERS f
        LEFT JOIN SYNTHETIC_DATASETS.UNIFIED.DIM_POIS p ON p.LOCATION_ID = f.PICKUP_POI_ID
        LEFT JOIN SYNTHETIC_DATASETS.UNIFIED.DIM_POIS d ON d.LOCATION_ID = f.DROPOFF_POI_ID
        WHERE f.REGION = ${currentRegionScalar('BACKLOAD_MATCHING')}`,
      db: 'FLEET_INTELLIGENCE', schema: 'BACKLOAD_MATCHING',
    },
    // Asset Velocity views (ROUTE_OPTIMIZATION) — ensure CONFIG has the
    // cost-of-idleness columns then deploy the three vehicle-type-aware views.
    {
      sql: `ALTER TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG ADD COLUMN IF NOT EXISTS DAILY_RENTAL_RATE_AVOIDED_USD NUMBER(10,2)`,
      db: 'FLEET_INTELLIGENCE', schema: 'ROUTE_OPTIMIZATION',
    },
    {
      sql: `ALTER TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG ADD COLUMN IF NOT EXISTS RENTAL_CAPTURE_RATE NUMBER(4,3)`,
      db: 'FLEET_INTELLIGENCE', schema: 'ROUTE_OPTIMIZATION',
    },
    {
      sql: `UPDATE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG
              SET DAILY_RENTAL_RATE_AVOIDED_USD = COALESCE(DAILY_RENTAL_RATE_AVOIDED_USD, 80.00),
                  RENTAL_CAPTURE_RATE          = COALESCE(RENTAL_CAPTURE_RATE, 0.600)`,
      db: 'FLEET_INTELLIGENCE', schema: 'ROUTE_OPTIMIZATION',
    },
    {
      sql: `CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.VW_IDLE_TRAILERS
        COMMENT = ${TRACK_RO}
        AS
        WITH cfg AS (
          SELECT VEHICLE_TYPE, REGION FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG LIMIT 1
        ),
        last_session AS (
          SELECT
            e.VEHICLE_ID, e.SESSION_ID, e.STATUS, e.LOCATION_ID, e.LOCATION_NAME,
            e.CITY, e.FACILITY_TYPE, e.LOC_TYPE, e.SESSION_START, e.SESSION_END,
            e.DWELL_MINUTES, e.AVG_POINT, e.HOME_BASE_NAME, e.OPERATING_MODE,
            e.DRIVER_PROFILE,
            ROW_NUMBER() OVER (PARTITION BY e.VEHICLE_ID ORDER BY e.SESSION_END DESC) AS RN
          FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DWELL_ENRICHED e
          WHERE (e.STATUS LIKE 'DWELL%' OR e.STATUS = 'IDLE')
            AND COALESCE(UPPER(e.STATUS), '') NOT LIKE '%MAINTENANCE%'
            AND COALESCE(UPPER(e.DRIVER_PROFILE), 'COMPLIANT') <> 'OUTLIER'
        ),
        fleet AS (
          SELECT f.VEHICLE_ID, f.REGION, f.HOME_LOCATION_ID, f.DRIVER_PROFILE
          FROM SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET f, cfg
          WHERE f.VEHICLE_TYPE = cfg.VEHICLE_TYPE
            AND f.REGION       = cfg.REGION
        )
        SELECT
          ls.VEHICLE_ID, f.REGION,
          ls.LOCATION_ID                                                            AS LAST_LOCATION_ID,
          ls.LOCATION_NAME                                                          AS LAST_LOCATION_NAME,
          ls.LOC_TYPE                                                               AS LAST_LOCATION_TYPE,
          ls.AVG_POINT                                                              AS LAST_LOCATION_GEOM,
          ST_X(ls.AVG_POINT)                                                        AS LAST_LNG,
          ST_Y(ls.AVG_POINT)                                                        AS LAST_LAT,
          ls.SESSION_START                                                          AS IDLE_SINCE,
          ls.DWELL_MINUTES                                                          AS IDLE_MINUTES,
          ROUND(ls.DWELL_MINUTES / 60.0, 1)                                         AS IDLE_HOURS,
          ROUND(ls.DWELL_MINUTES / 60.0 / 24.0, 2)                                  AS IDLE_DAYS,
          ls.HOME_BASE_NAME,
          'DISP-' || LPAD(MOD(ABS(HASH(ls.VEHICLE_ID)), 12) + 1, 2, '0')            AS ASSIGNED_DISPATCHER,
          ls.DRIVER_PROFILE
        FROM last_session ls
        JOIN fleet f ON ls.VEHICLE_ID = f.VEHICLE_ID
        WHERE ls.RN = 1`,
      db: 'FLEET_INTELLIGENCE', schema: 'ROUTE_OPTIMIZATION',
    },
    {
      sql: `CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.VW_LANE_DEMAND
        COMMENT = ${TRACK_RO}
        AS
        WITH cfg AS (
          SELECT VEHICLE_TYPE, REGION FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG LIMIT 1
        ),
        window_bounds AS (
          SELECT MAX(t.TRIP_START) AS MAX_TS
          FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS t, cfg
          WHERE t.VEHICLE_TYPE = cfg.VEHICLE_TYPE
            AND t.REGION       = cfg.REGION
        ),
        recent_trips AS (
          SELECT t.*
          FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS t, window_bounds w, cfg
          WHERE t.VEHICLE_TYPE = cfg.VEHICLE_TYPE
            AND t.REGION       = cfg.REGION
            AND t.TRIP_START   >= DATEADD('day', -30, w.MAX_TS)
        ),
        flows AS (
          SELECT ORIGIN_POI_ID      AS POI_ID, COUNT(*) AS OUT_CNT, 0 AS IN_CNT FROM recent_trips GROUP BY 1
          UNION ALL
          SELECT DESTINATION_POI_ID AS POI_ID, 0 AS OUT_CNT, COUNT(*) AS IN_CNT FROM recent_trips GROUP BY 1
        ),
        agg AS (
          SELECT POI_ID, SUM(OUT_CNT) AS OUTBOUND, SUM(IN_CNT) AS INBOUND
          FROM flows
          WHERE POI_ID IS NOT NULL
          GROUP BY POI_ID
        )
        SELECT
          p.LOCATION_ID                                       AS TERMINAL_ID,
          p.REGION,
          p.NAME                                              AS TERMINAL_NAME,
          p.LOCATION_TYPE,
          p.POINT_GEOM                                        AS TERMINAL_GEOM,
          p.LAT                                               AS TERMINAL_LAT,
          p.LNG                                               AS TERMINAL_LNG,
          a.OUTBOUND, a.INBOUND,
          (a.OUTBOUND - a.INBOUND)                            AS NET_OUTBOUND_TRIPS,
          GREATEST(0, a.OUTBOUND - a.INBOUND)
            + ROUND(GREATEST(0, a.OUTBOUND - a.INBOUND) * 0.25, 0) AS DEMAND_SCORE
        FROM agg a
        JOIN SYNTHETIC_DATASETS.UNIFIED.DIM_POIS p
          ON p.LOCATION_ID = a.POI_ID
        WHERE p.LOCATION_TYPE IN ('WAREHOUSE','LOGISTICS','DEPOT','TERMINAL','ADDRESS','STORE','RESTAURANT')
          AND (a.OUTBOUND - a.INBOUND) > 0`,
      db: 'FLEET_INTELLIGENCE', schema: 'ROUTE_OPTIMIZATION',
    },
    {
      sql: `CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.VW_TRAILER_COST_OF_IDLENESS
        COMMENT = ${TRACK_RO}
        AS
        SELECT
          t.VEHICLE_ID, t.REGION, t.LAST_LOCATION_NAME, t.LAST_LOCATION_TYPE,
          t.LAST_LNG, t.LAST_LAT, t.LAST_LOCATION_GEOM,
          t.IDLE_SINCE, t.IDLE_MINUTES, t.IDLE_HOURS, t.IDLE_DAYS,
          t.ASSIGNED_DISPATCHER, t.DRIVER_PROFILE,
          c.DAILY_RENTAL_RATE_AVOIDED_USD, c.RENTAL_CAPTURE_RATE,
          ROUND(t.IDLE_DAYS * c.DAILY_RENTAL_RATE_AVOIDED_USD, 2)                            AS COST_OF_IDLENESS_USD,
          ROUND(t.IDLE_DAYS * c.DAILY_RENTAL_RATE_AVOIDED_USD * c.RENTAL_CAPTURE_RATE, 2)    AS PROJECTED_SAVINGS_USD,
          CASE
            WHEN t.IDLE_DAYS >= 14 THEN 'CRITICAL'
            WHEN t.IDLE_DAYS >= 7  THEN 'WARNING'
            WHEN t.IDLE_DAYS >= 3  THEN 'WATCH'
            ELSE 'OK'
          END                                                                                AS IDLE_SEVERITY
        FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.VW_IDLE_TRAILERS t
        CROSS JOIN (SELECT MAX(DAILY_RENTAL_RATE_AVOIDED_USD) AS DAILY_RENTAL_RATE_AVOIDED_USD,
                           MAX(RENTAL_CAPTURE_RATE)          AS RENTAL_CAPTURE_RATE
                    FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG) c`,
      db: 'FLEET_INTELLIGENCE', schema: 'ROUTE_OPTIMIZATION',
    },
  ];
  for (const { sql, db, schema } of stmts) {
    try {
      await sqlFn(sql, db, schema);
    } catch (e: any) {
      // Log and continue — most failures are "schema doesn't exist" on first
      // boot before build-routing-solution finished, which is fine; subsequent
      // boots will succeed.
      log('WARN', 'Init', `boot init step failed: ${e?.message?.slice(0, 200)}`);
    }
  }
}



const APP_VERSION = process.env.APP_VERSION || '0.0.0';

app.use(createStatusRouter(APP_VERSION));
app.use(createServicesRouter());
app.use(createDiagnosticsRouter(APP_VERSION));
app.use(createSamplingRouter());
app.use(createFleetRouter());
app.use(createRegionsRouter());

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

app.get('/api/matrix/regions', async (_req, res) => {
  try {
    const orsRegions = await runSql(`SELECT * FROM ${SF_DATABASE}.CORE.REGION_ORS_MAP`);
    // Bulk-fetch boundary areas from REGION_CATALOG so we can match each
    // ORS region to its actual polygon area (used by the matrix builder
    // fast-estimate so it matches BUILD_HEXAGONS output, not bbox).
    const catalogAreas: Record<string, number> = {};
    try {
      const rows = await runSql(
        `SELECT UPPER(REGION_KEY) AS K1, UPPER(LOOKUP_NAME) AS K2, BOUNDARY_AREA_KM2 AS A
         FROM ${SF_DATABASE}.CORE.REGION_CATALOG
         WHERE BOUNDARY IS NOT NULL AND BOUNDARY_AREA_KM2 > 0`
      );
      for (const r of rows || []) {
        const a = Number(r.A);
        if (r.K1) catalogAreas[r.K1] = a;
        if (r.K2 && !catalogAreas[r.K2]) catalogAreas[r.K2] = a;
      }
    } catch {}
    const regions: any[] = [];

    for (const c of orsRegions) {
      const safeRegion = sanitizeIdentifier(c.REGION || '');
      let serviceStatus = 'NOT_FOUND';
      try {
        const rows = await runSql(`SHOW SERVICES LIKE '${orsServiceName(safeRegion)}' IN SCHEMA ${SF_DATABASE}.CORE`);
        serviceStatus = rows?.[0]?.status || 'NOT_FOUND';
      } catch {}

      const upperRegion = (c.REGION || '').toUpperCase();
      const boundaryAreaKm2 = catalogAreas[upperRegion] ?? null;

      regions.push({
        region: c.REGION, label: c.DISPLAY_NAME || c.REGION,
        bounds: { minLat: Number(c.MIN_LAT), maxLat: Number(c.MAX_LAT), minLon: Number(c.MIN_LON), maxLon: Number(c.MAX_LON) },
        boundaryAreaKm2,
        serviceStatus, serviceExists: serviceStatus !== 'NOT_FOUND',
        matrixFunctionExists: true, directionsFunctionExists: true,
        ready: serviceStatus === 'RUNNING' || serviceStatus === 'SUSPENDED',
        provisioned: true,
        matrixFn: `${SF_DATABASE}.CORE.MATRIX_TABULAR`,
        labels: [c.DISPLAY_NAME || c.REGION],
      });
    }

    let mainStatus = 'NOT_FOUND';
    try {
      // v1.1.0: legacy bare ORS_SERVICE was renamed to ORS_SERVICE_SANFRANCISCO.
      const rows = await runSql(`SHOW SERVICES LIKE 'ORS_SERVICE_SANFRANCISCO' IN SCHEMA ${SF_DATABASE}.CORE`);
      mainStatus = rows?.[0]?.status || 'NOT_FOUND';
    } catch {}
    if (mainStatus !== 'NOT_FOUND') {
      let defaultRegion = 'DEFAULT';
      let defaultLabel = 'Default ORS';
      let defaultBounds = { minLat: 37.71, maxLat: 37.81, minLon: -122.51, maxLon: -122.37 };
      try {
        const stageRows = await runSql(`LIST @${SF_DATABASE}.CORE.ORS_SPCS_STAGE PATTERN='.*ors-config.*'`);
        const knownRegions = new Set(orsRegions.map((c: any) => (c.REGION || '').toUpperCase()));
        for (const row of stageRows || []) {
          const path = row.name || row.NAME || '';
          const match = path.match(/ors_spcs_stage\/([^/]+)\/ors-config/i);
          if (match) {
            const stageRegion = match[1];
            if (!knownRegions.has(stageRegion.toUpperCase())) {
              defaultRegion = stageRegion;
              defaultLabel = stageRegion.replace(/([a-z])([A-Z])/g, '$1 $2');
              break;
            }
          }
        }
      } catch {}
      try {
        const regionRow = await runSql(`SELECT * FROM ${SF_DATABASE}.CORE.REGION_ORS_MAP WHERE REGION = '${escapeString(defaultRegion)}'`);
        if (regionRow?.[0]) {
          defaultLabel = regionRow[0].DISPLAY_NAME || defaultLabel;
          defaultBounds = { minLat: Number(regionRow[0].MIN_LAT), maxLat: Number(regionRow[0].MAX_LAT), minLon: Number(regionRow[0].MIN_LON), maxLon: Number(regionRow[0].MAX_LON) };
        }
      } catch {}
      regions.unshift({
        region: defaultRegion, label: `${defaultLabel} (Default)`,
        bounds: defaultBounds,
        boundaryAreaKm2: catalogAreas[defaultRegion.toUpperCase()] ?? null,
        serviceStatus: mainStatus, serviceExists: true,
        matrixFunctionExists: true, directionsFunctionExists: true,
        ready: mainStatus === 'RUNNING' || mainStatus === 'SUSPENDED',
        provisioned: true,
        matrixFn: `${SF_DATABASE}.CORE.MATRIX_TABULAR`,
        labels: [defaultLabel],
        isDefault: true,
      });
    }

    res.json({ regions });
  } catch (err: any) {
    res.json({ regions: [], error: err.message });
  }
});

app.get('/api/matrix/road-filter-available', async (_req, res) => {
  try {
    await runSql('SELECT 1 FROM OVERTURE_MAPS__TRANSPORTATION.CARTO.SEGMENT LIMIT 1',
                 'OVERTURE_MAPS__TRANSPORTATION', 'CARTO');
    res.json({ available: true });
  } catch (e: any) {
    res.json({
      available: false,
      reason: 'OVERTURE_MAPS__TRANSPORTATION not accessible. Install from Snowflake Marketplace (CARTO provider) and grant IMPORTED PRIVILEGES.',
      detail: e.message?.slice(0, 200),
    });
  }
});

const COST_ESTIMATE_TIMEOUT_MS = 60_000;
const MAX_CONCURRENT_ESTIMATE_QUERIES = 2;
let activeEstimateQueries = 0;

app.post('/api/matrix/cost-estimate', async (req, res) => {
  try {
    const { region, resolutions, profile, road_filter } = req.body;
    if (!region || !resolutions) return res.status(400).json({ error: 'region and resolutions required' });

    let safeRegion: string;
    try { safeRegion = sanitizeIdentifier(region); }
    catch { return res.status(400).json({ error: 'Invalid region' }); }

    let bbox = { MIN_LAT: 37.71, MAX_LAT: 37.81, MIN_LON: -122.51, MAX_LON: -122.37 };
    try {
      const cityRow = await runSql(`SELECT * FROM ${SF_DATABASE}.CORE.REGION_ORS_MAP WHERE REGION = '${escapeString(safeRegion)}'`);
      if (cityRow?.[0]) bbox = cityRow[0];
    } catch {}

    // Polygon-aware area: prefer REGION_CATALOG.BOUNDARY_AREA_KM2 over the
    // bbox rectangle so estimates match what BUILD_HEXAGONS will actually
    // produce (California bbox = ~580k km^2 but real polygon = ~424k km^2).
    let polygonAreaSqKm: number | null = null;
    let hasPolygon = false;
    try {
      const polyRow = await runSql(
        `SELECT BOUNDARY_AREA_KM2 AS AREA
         FROM ${SF_DATABASE}.CORE.REGION_CATALOG
         WHERE BOUNDARY IS NOT NULL
           AND (UPPER(LOOKUP_NAME) = UPPER('${escapeString(safeRegion)}')
                OR UPPER(REGION_KEY) = UPPER('${escapeString(safeRegion)}'))
         ORDER BY BOUNDARY_AREA_KM2 ASC LIMIT 1`
      );
      if (polyRow?.[0]?.AREA != null) {
        polygonAreaSqKm = Number(polyRow[0].AREA);
        hasPolygon = polygonAreaSqKm > 0;
      }
    } catch {}

    const latSpan = Math.abs(Number(bbox.MAX_LAT) - Number(bbox.MIN_LAT));
    const lonSpan = Math.abs(Number(bbox.MAX_LON) - Number(bbox.MIN_LON));
    const bboxAreaSqKm = latSpan * 111 * lonSpan * 111 * Math.cos(((Number(bbox.MIN_LAT) + Number(bbox.MAX_LAT)) / 2) * Math.PI / 180);
    const areaSqKm = hasPolygon ? polygonAreaSqKm! : bboxAreaSqKm;

    const hexAreaKm2: Record<number, number> = { 5: 252.9, 6: 36.13, 7: 5.16, 8: 0.737, 9: 0.105, 10: 0.015 };
    const pairsPerSecond = 30000;
    const computePoolNodes = 10;
    const computePoolCreditPerNodeHr = 1;
    const warehouseCreditPerHr = 10;
    const flattenCredits = 2;
    const creditPriceDollars = 3;
    const useRoadFilter = road_filter === true;

    // Polygon SQL fragment used by the road-aware estimator. When a catalog
    // polygon exists we use it for both ST_INTERSECTS (road segment filter)
    // AND ST_WITHIN (final cell-centroid clip), exactly matching
    // BUILD_HEXAGONS_ROAD_AWARE. Otherwise fall back to bbox rectangle.
    const polyExpr = hasPolygon
      ? `(SELECT BOUNDARY FROM ${SF_DATABASE}.CORE.REGION_CATALOG
         WHERE BOUNDARY IS NOT NULL
           AND (UPPER(LOOKUP_NAME) = UPPER('${escapeString(safeRegion)}')
                OR UPPER(REGION_KEY) = UPPER('${escapeString(safeRegion)}'))
         ORDER BY BOUNDARY_AREA_KM2 ASC LIMIT 1)`
      : `TO_GEOGRAPHY('POLYGON((${sanitizeFloat(bbox.MIN_LON)} ${sanitizeFloat(bbox.MIN_LAT)},${sanitizeFloat(bbox.MAX_LON)} ${sanitizeFloat(bbox.MIN_LAT)},${sanitizeFloat(bbox.MAX_LON)} ${sanitizeFloat(bbox.MAX_LAT)},${sanitizeFloat(bbox.MIN_LON)} ${sanitizeFloat(bbox.MAX_LAT)},${sanitizeFloat(bbox.MIN_LON)} ${sanitizeFloat(bbox.MIN_LAT)}))')`;

    const computeEstimate = async (resolution: number) => {
      let hexCount = Math.ceil(areaSqKm / (hexAreaKm2[resolution] || 1));
      const hexCountBbox = Math.ceil(bboxAreaSqKm / (hexAreaKm2[resolution] || 1));
      let filteredApplied = false;

      if (useRoadFilter) {
        while (activeEstimateQueries >= MAX_CONCURRENT_ESTIMATE_QUERIES) {
          await new Promise(r => setTimeout(r, 200));
        }
        activeEstimateQueries++;
        try {
          const sampleClause = resolution >= 9 ? 'SAMPLE (20)' : '';
          const scaleFactor = resolution >= 9 ? 5 : 1;
          const sql = `
            WITH region_geom AS (
              SELECT ${polyExpr} AS poly
            ),
            rs AS (
              SELECT s.geometry FROM OVERTURE_MAPS__TRANSPORTATION.CARTO.SEGMENT s ${sampleClause}, region_geom r
              WHERE s.subtype = 'road'
                AND s.bbox:xmin::FLOAT <= ${sanitizeFloat(bbox.MAX_LON)} AND s.bbox:xmax::FLOAT >= ${sanitizeFloat(bbox.MIN_LON)}
                AND s.bbox:ymin::FLOAT <= ${sanitizeFloat(bbox.MAX_LAT)} AND s.bbox:ymax::FLOAT >= ${sanitizeFloat(bbox.MIN_LAT)}
                AND ST_INTERSECTS(s.geometry, r.poly)
            )
            SELECT COUNT(DISTINCT c.value) AS CNT
            FROM rs, TABLE(FLATTEN(H3_COVERAGE_STRINGS(rs.geometry, ${resolution}))) c, region_geom r
            WHERE ST_WITHIN(H3_CELL_TO_POINT(c.value::VARCHAR), r.poly)`;
          const rows = await runSql(sql, 'OVERTURE_MAPS__TRANSPORTATION', 'CARTO');
          const raw = parseInt(rows?.[0]?.CNT || '0');
          if (raw > 0) {
            hexCount = raw * scaleFactor;
            filteredApplied = true;
          }
        } finally {
          activeEstimateQueries--;
        }
      }

      const totalPairs = hexCount * (hexCount - 1);
      const buildTimeSecs = totalPairs / pairsPerSecond;
      const buildTimeHrs = buildTimeSecs / 3600;

      const computePoolCredits = computePoolNodes * computePoolCreditPerNodeHr * buildTimeHrs;
      const warehouseCredits = warehouseCreditPerHr * buildTimeHrs;
      const totalCredits = computePoolCredits + warehouseCredits + flattenCredits;
      const estimatedCostDollars = totalCredits * creditPriceDollars;

      return {
        resolution: `RES${resolution}`,
        hex_count: hexCount,
        hex_count_bbox: hexCountBbox,
        road_filter_applied: filteredApplied,
        polygon_applied: hasPolygon,
        total_pairs: totalPairs,
        estimated_build_time_minutes: Math.round(buildTimeSecs / 60 * 10) / 10,
        cost_breakdown: {
          compute_pool: { nodes: computePoolNodes, credits: Math.round(computePoolCredits * 10) / 10 },
          warehouse: { type: 'X-Small x10 clusters', credits: Math.round(warehouseCredits * 10) / 10 },
          flatten: { type: 'X-Large', credits: flattenCredits },
          total_credits: Math.round(totalCredits * 10) / 10,
          estimated_cost_usd: Math.round(estimatedCostDollars * 100) / 100,
        },
      };
    };

    const safeResolutions = (resolutions as number[]).filter((r) => r >= 5 && r <= 10);

    const estimatesPromise = Promise.all(safeResolutions.map(computeEstimate));
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('COST_ESTIMATE_TIMEOUT')), COST_ESTIMATE_TIMEOUT_MS)
    );

    let estimates: Awaited<ReturnType<typeof computeEstimate>>[];
    try {
      estimates = await Promise.race([estimatesPromise, timeoutPromise]);
    } catch (e: any) {
      if (e.message === 'COST_ESTIMATE_TIMEOUT') {
        return res.json({
          region: safeRegion,
          profile: profile || 'driving-car',
          road_filter: useRoadFilter,
          area_sq_km: Math.round(areaSqKm),
          resolutions: safeResolutions.map((r) => ({
            resolution: `RES${r}`,
            hex_count: Math.ceil(areaSqKm / (hexAreaKm2[r] || 1)),
            hex_count_bbox: Math.ceil(bboxAreaSqKm / (hexAreaKm2[r] || 1)),
            road_filter_applied: false,
            polygon_applied: hasPolygon,
            total_pairs: 0,
            estimated_build_time_minutes: 0,
            timed_out: true,
          })),
          error: 'Road-aware cost estimate timed out (>60s). The Overture query is too expensive for this region/resolution combination. Estimates shown use bbox approximation.',
          timed_out: true,
        });
      }
      throw e;
    }

    const totalCredits = estimates.reduce((sum, e) => sum + e.cost_breakdown.total_credits, 0);
    res.json({
      region: safeRegion,
      profile: profile || 'driving-car',
      road_filter: useRoadFilter,
      area_sq_km: Math.round(areaSqKm),
      bbox_area_sq_km: Math.round(bboxAreaSqKm),
      polygon_applied: hasPolygon,
      bbox: { min_lat: bbox.MIN_LAT, max_lat: bbox.MAX_LAT, min_lon: bbox.MIN_LON, max_lon: bbox.MAX_LON },
      resolutions: estimates,
      total_estimated_credits: Math.round(totalCredits * 10) / 10,
      total_estimated_cost_usd: Math.round(totalCredits * creditPriceDollars * 100) / 100,
      credit_price_usd: creditPriceDollars,
      note: useRoadFilter
        ? 'Road-aware estimate uses actual Overture road segments clipped to the region polygon. Res 9-10 use 20% sampling scaled 5x.'
        : (hasPolygon
            ? 'Estimates use the actual region polygon area (REGION_CATALOG.BOUNDARY). Throughput model: 30K pairs/sec on 10-node compute pool.'
            : 'Estimates based on bbox rectangle area (no REGION_CATALOG polygon match). Throughput model: 30K pairs/sec on 10-node compute pool.'),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

app.get('/api/matrix/existing', async (req, res) => {
  try {
    const region = req.query.region as string;
    const profile = (req.query.profile as string) || 'driving-car';
    const safeRegion = region ? sanitizeIdentifier(region) : 'SAN_FRANCISCO';
    const safeProfile = profile.replace(/-/g, '_').toUpperCase();
    const prefix = `${safeRegion}_${safeProfile}`;
    const counts: Record<string, number> = {};
    for (const r of [5, 6, 7, 8, 9, 10]) {
      try {
        const rows = await runSql(`SELECT COUNT(*) AS CNT FROM ${SF_DATABASE}.TRAVEL_MATRIX.${prefix}_MATRIX_RES${r}`);
        const cnt = parseInt(rows?.[0]?.CNT || '0');
        if (cnt > 0) counts[`RES${r}`] = cnt;
      } catch {}
    }
    res.json(counts);
  } catch (err: any) {
    res.json({});
  }
});

app.post('/api/matrix/build', async (req, res) => {
  const { region, resolutions, profile: reqProfile, road_filter, force } = req.body;
  if (!region || !resolutions) return res.status(400).json({ error: 'region and resolutions required' });
  const profile = reqProfile || 'driving-car';
  const roadFilter = road_filter === true;

  let safeRegion: string;
  try {
    safeRegion = sanitizeIdentifier(region);
  } catch (err: any) {
    return res.status(400).json({ error: `Invalid region: ${err.message}` });
  }
  const safeResolutions = (resolutions as number[]).filter((r) => r >= 5 && r <= 10);
  if (safeResolutions.length === 0) return res.status(400).json({ error: 'resolutions must be between 5 and 10' });
  const safeProfile = escapeString(profile);
  const safeProfileUpper = profile.replace(/-/g, '_').toUpperCase();

  try {
    const preflightWarnings: string[] = [];
    for (const resolution of safeResolutions) {
      const listTable = `${SF_DATABASE}.TRAVEL_MATRIX.${safeRegion.toUpperCase()}_${safeProfileUpper}_LIST_RES${resolution}`;
      let hexCount = 0;
      try {
        const rows = await runSql(`SELECT COUNT(*) AS CNT FROM ${listTable}`);
        hexCount = parseInt(rows?.[0]?.CNT || '0');
      } catch {
        continue;
      }
      const impliedPairs = hexCount * (hexCount - 1);
      if (impliedPairs > 10_000_000_000 && !force) {
        return res.status(422).json({
          error: `Region too large for RES${resolution}: ${hexCount.toLocaleString()} hexagons implies ${(impliedPairs / 1e9).toFixed(1)}B pairs. Split the region or use a coarser resolution. Pass force:true to override.`,
          hex_count: hexCount,
          implied_pairs: impliedPairs,
          resolution,
          requires_force: true,
        });
      }
      if (impliedPairs > 625_000_000) {
        preflightWarnings.push(`RES${resolution}: ${hexCount.toLocaleString()} hexagons (${(impliedPairs / 1e9).toFixed(1)}B pairs) — recommend XLARGE warehouse`);
      } else if (impliedPairs > 25_000_000) {
        preflightWarnings.push(`RES${resolution}: ${hexCount.toLocaleString()} hexagons (${(impliedPairs / 1e6).toFixed(0)}M pairs) — recommend LARGE warehouse`);
      }
    }

    let bbox = { MIN_LAT: 37.71, MAX_LAT: 37.81, MIN_LON: -122.51, MAX_LON: -122.37 };
    try {
      const cityRow = await runSql(`SELECT * FROM ${SF_DATABASE}.CORE.REGION_ORS_MAP WHERE REGION = '${escapeString(safeRegion)}'`);
      if (cityRow?.[0]) bbox = cityRow[0];
    } catch {}

    let matrixFn = `${SF_DATABASE}.CORE.MATRIX_TABULAR`;
    if (safeRegion && safeRegion.toUpperCase() !== 'DEFAULT' && safeRegion.toUpperCase() !== 'SANFRANCISCO') {
      matrixFn = `${SF_DATABASE}.CORE.MATRIX_TABULAR_W`;
    }

    const jobs: { job_id: string; resolution: number }[] = [];
    const regionDb = safeRegion;

    const insertValues = safeResolutions.map((resolution, i) => {
      const jobId = `${safeRegion.toUpperCase()}_${profile.replace(/-/g, '_')}_RES${resolution}_${Date.now() + i}`.toUpperCase();
      jobs.push({ job_id: jobId, resolution });
      return `('${escapeString(jobId)}', '${escapeString(regionDb)}', '${safeProfile}', 'RES${resolution}', 'PENDING', 'NOT_STARTED')`;
    });
    await runSql(`INSERT INTO ${SF_DATABASE}.TRAVEL_MATRIX.MATRIX_BUILD_JOBS (JOB_ID, REGION, PROFILE, RESOLUTION, STATUS, STAGE) VALUES ${insertValues.join(', ')}`);

    res.json({
      status: 'launched',
      jobs,
      ...(preflightWarnings.length > 0 ? { warning: preflightWarnings.join('; ') } : {}),
    });

    (async () => {
      for (const { job_id: jobId, resolution } of jobs) {
        try {
          const callSql = `CALL ${SF_DATABASE}.CORE.BUILD_MATRIX_JOB_WRAPPER('${escapeString(jobId)}', 'RES${resolution}', ${sanitizeFloat(bbox.MIN_LAT)}, ${sanitizeFloat(bbox.MAX_LAT)}, ${sanitizeFloat(bbox.MIN_LON)}, ${sanitizeFloat(bbox.MAX_LON)}, '${escapeString(matrixFn)}', '${escapeString(regionDb)}', '${safeProfile}', ${roadFilter ? 'TRUE' : 'FALSE'})`;
          const handle = await submitSqlAsync(callSql);
          await runSql(`UPDATE ${SF_DATABASE}.TRAVEL_MATRIX.MATRIX_BUILD_JOBS SET STATEMENT_HANDLE = '${escapeString(handle)}' WHERE JOB_ID = '${escapeString(jobId)}'`);
          let jobStatus = 'RUNNING';
          while (jobStatus === 'RUNNING' || jobStatus === 'PENDING') {
            await new Promise(r => setTimeout(r, 10000));
            try {
              const rows = await runSql(`SELECT STATUS FROM ${SF_DATABASE}.TRAVEL_MATRIX.MATRIX_BUILD_JOBS WHERE JOB_ID = '${escapeString(jobId)}'`);
              jobStatus = rows?.[0]?.STATUS || 'UNKNOWN';
            } catch { break; }
          }
        } catch (e: any) {
          console.error(`[matrix/build] async launch error for ${jobId}: ${e.message}`);
        }
      }
    })().catch(() => {});
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

app.get('/api/matrix/status', async (req, res) => {
  try {
    let jobs: any[] = [];
    try {
      const rows = await runSql(
        `SELECT JOB_ID, REGION, PROFILE, RESOLUTION, STATUS, STAGE,
                HEXAGONS, WORK_QUEUE_ROWS, RAW_ROWS, MATRIX_ROWS,
                PCT_COMPLETE, ERROR_MSG, STATEMENT_HANDLE,
                TO_VARCHAR(CREATED_AT,   'YYYY-MM-DD"T"HH24:MI:SS.FF3') || 'Z' AS CREATED_AT,
                TO_VARCHAR(STARTED_AT,   'YYYY-MM-DD"T"HH24:MI:SS.FF3') || 'Z' AS STARTED_AT,
                TO_VARCHAR(COMPLETED_AT, 'YYYY-MM-DD"T"HH24:MI:SS.FF3') || 'Z' AS COMPLETED_AT
         FROM ${SF_DATABASE}.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
         ORDER BY CREATED_AT DESC LIMIT 50`
      );
      jobs = (rows || []).map((r: any) => ({
        job_id: r.JOB_ID,
        region: r.REGION,
        profile: r.PROFILE,
        resolution: r.RESOLUTION,
        status: r.STATUS,
        stage: r.STAGE,
        hexagons: Number(r.HEXAGONS) || 0,
        work_queue_rows: Number(r.WORK_QUEUE_ROWS) || 0,
        raw_rows: Number(r.RAW_ROWS) || 0,
        matrix_rows: Number(r.MATRIX_ROWS) || 0,
        pct_complete: Number(r.PCT_COMPLETE) || 0,
        error_msg: r.ERROR_MSG,
        statement_handle: r.STATEMENT_HANDLE,
        created_at: toIso(r.CREATED_AT),
        started_at: toIso(r.STARTED_AT),
        completed_at: toIso(r.COMPLETED_AT),
      }));

      // Live progress: BUILD_MATRIX_JOB_WRAPPER only updates RAW_ROWS / PCT_COMPLETE
      // at the very end of the procedure, leaving the UI at 0% for the entire
      // BUILDING stage. Compute live counts from the MATRIX_RAW table directly.
      await Promise.all(
        jobs
          .filter((j) => j.stage === 'BUILDING' && j.work_queue_rows > 0)
          .map(async (j) => {
            const safeProfile = String(j.profile || '').toUpperCase().replace(/-/g, '_');
            const safeRegion = String(j.region || '').toUpperCase();
            const rawTable = `${SF_DATABASE}.TRAVEL_MATRIX.${safeRegion}_${safeProfile}_MATRIX_RAW_${j.resolution}`;
            try {
              const liveRows = await runSql(`SELECT COUNT(*) AS C FROM ${rawTable}`);
              const c = Number(liveRows?.[0]?.C) || 0;
              j.raw_rows = c;
              j.pct_complete = Math.min(100, Math.round((c * 100) / j.work_queue_rows));
            } catch {
              // raw table may not exist yet; leave fallback values
            }
          })
      );
    } catch {}
    res.json({ jobs });
  } catch (err: any) {
    res.json({ jobs: [], error: err.message });
  }
});

app.get('/api/matrix/inventory', async (_req, res) => {
  try {
    let roadFilterMap: Record<string, boolean> = {};
    try {
      const rfRows = await runSql(
        `SELECT REGION, PROFILE, RESOLUTION, ROAD_FILTER AS RF
         FROM (
           SELECT REGION, PROFILE, RESOLUTION, ROAD_FILTER,
                  ROW_NUMBER() OVER (PARTITION BY REGION, PROFILE, RESOLUTION ORDER BY COMPLETED_AT DESC NULLS LAST) AS RN
           FROM ${SF_DATABASE}.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
           WHERE STATUS = 'COMPLETE'
         ) WHERE RN = 1`
      );
      for (const r of rfRows || []) {
        const key = `${(r.REGION || '').toUpperCase()}_${(r.PROFILE || '').replace(/-/g, '_').toUpperCase()}_${r.RESOLUTION}`;
        roadFilterMap[key] = r.RF === true || r.RF === 'true';
      }
    } catch {}
    let inventory: any[] = [];
    try {
      const rows = await runSql(
        `SELECT TABLE_NAME, ROW_COUNT, BYTES,
                TO_VARCHAR(CREATED::TIMESTAMP_LTZ, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM') AS CREATED
         FROM ${SF_DATABASE}.INFORMATION_SCHEMA.TABLES
         WHERE TABLE_SCHEMA = 'TRAVEL_MATRIX'
           AND TABLE_NAME LIKE '%_MATRIX_RES%'
           AND ROW_COUNT > 0
         ORDER BY CREATED DESC`
      );
      inventory = (rows || []).map((t: any) => {
        const name = (t.TABLE_NAME || '').toUpperCase();
        const parts = name.match(/^(.+?)_(DRIVING_CAR|DRIVING_HGV|CYCLING_ROAD|CYCLING_REGULAR|CYCLING_ELECTRIC|FOOT_WALKING|FOOT_HIKING|WHEELCHAIR)_MATRIX_(RES\d+)$/);
        if (!parts) return null;
        const tableRegion = parts[1];
        const region = tableRegion.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()).replace(/ /g, '');
        const profileName = parts[2].toLowerCase().replace(/_/g, '-');
        const resolution = parts[3];
        const lookupKey = `${tableRegion}_${parts[2]}_${resolution}`;
        return { region, table_region: tableRegion, profile: profileName, resolution, row_count: parseInt(t.ROW_COUNT || '0'), bytes: parseInt(t.BYTES || '0'), created: t.CREATED || '', table_name: name, execution_time_secs: 0, road_filter: roadFilterMap[lookupKey] === true };
      }).filter(Boolean);
    } catch {}
    res.json({ inventory });
  } catch (err: any) {
    res.json({ inventory: [], error: err.message });
  }
});

app.delete('/api/matrix/:region/:profile/:resolution', async (req, res) => {
  try {
    const safeRegion = sanitizeIdentifier(req.params.region);
    const safeProfile = escapeString(req.params.profile);
    const safeRes = sanitizeIdentifier(req.params.resolution);
    const tablePrefix = `${SF_DATABASE}.TRAVEL_MATRIX.${safeRegion}_${safeProfile.toUpperCase().replace(/-/g,'_')}_`;
    const tables = [`${tablePrefix}MATRIX_${safeRes}`, `${tablePrefix}MATRIX_RAW_${safeRes}`, `${tablePrefix}WORK_QUEUE_${safeRes}`, `${tablePrefix}LIST_${safeRes}`];
    let droppedCount = 0;
    for (const t of tables) {
      try {
        const checkRows = await runSql(`SELECT 1 FROM ${SF_DATABASE}.INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = 'TRAVEL_MATRIX' AND TABLE_NAME = '${t.split('.').pop()}'`);
        if (checkRows && checkRows.length > 0) {
          await runSql(`DROP TABLE IF EXISTS ${t}`);
          droppedCount++;
        }
      } catch {}
    }
    await runSql(`DELETE FROM ${SF_DATABASE}.TRAVEL_MATRIX.MATRIX_BUILD_JOBS WHERE REGION = '${escapeString(req.params.region)}' AND PROFILE = '${safeProfile}' AND RESOLUTION = '${escapeString(safeRes)}'`);
    res.json({ status: droppedCount > 0 ? 'ok' : 'not_found', dropped_count: droppedCount });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/matrix/:region/:profile/:resolution/restore', async (req, res) => {
  try {
    const safeRegion = sanitizeIdentifier(req.params.region);
    const safeProfile = escapeString(req.params.profile);
    const safeRes = sanitizeIdentifier(req.params.resolution);
    const offsetSecs = sanitizeInt(req.body.offset_seconds || 300);
    const result = await callProcedure(`RESTORE_MATRIX_DATA('${safeRegion}', '${safeProfile}', '${safeRes}', ${offsetSecs})`);
    const parsed = JSON.parse(result || '{}');
    res.json(parsed);
  } catch (err: any) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

app.post('/api/matrix/cancel', async (req, res) => {
  try {
    const { job_id } = req.body;
    if (!job_id) return res.status(400).json({ error: 'job_id required' });
    const result = await callProcedure(`CANCEL_MATRIX_BUILD('${escapeString(job_id)}')`);
    const parsed = JSON.parse(result || '{}');
    if (parsed.statement_handle) {
      await cancelStatement(parsed.statement_handle);
    }
    res.json({ status: 'cancelled', result: parsed });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

const VIEWER_PROFILE_PATTERNS = ['DRIVING_CAR', 'DRIVING_HGV', 'CYCLING_REGULAR', 'CYCLING_ROAD', 'CYCLING_MOUNTAIN', 'CYCLING_ELECTRIC', 'FOOT_WALKING', 'FOOT_HIKING', 'WHEELCHAIR'];

function parseViewerTableName(name: string): { region: string; profile: string; resolution: string } | null {
  for (const profile of VIEWER_PROFILE_PATTERNS) {
    const pattern = new RegExp(`^(.+?)_${profile}_MATRIX_(RES\\d+)$`);
    const match = name.match(pattern);
    if (match) {
      return { region: match[1], profile: profile.toLowerCase().replace(/_/g, '-'), resolution: match[2] };
    }
  }
  return null;
}

let viewerInventoryCache: { tables: any[]; ts: number } = { tables: [], ts: 0 };
const VIEWER_CACHE_TTL = 60000;

async function getViewerInventory(): Promise<any[]> {
  if (Date.now() - viewerInventoryCache.ts < VIEWER_CACHE_TTL && viewerInventoryCache.tables.length > 0) {
    return viewerInventoryCache.tables;
  }
  const rows = await runSql(`
    SELECT TABLE_NAME, ROW_COUNT, BYTES
    FROM ${SF_DATABASE}.INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = 'TRAVEL_MATRIX'
      AND TABLE_NAME LIKE '%\\_MATRIX\\_%' ESCAPE '\\\\'
      AND TABLE_NAME NOT LIKE '%\\_MATRIX\\_RAW\\_%' ESCAPE '\\\\'
      AND TABLE_NAME NOT LIKE '%\\_LIST\\_%' ESCAPE '\\\\'
      AND TABLE_NAME NOT LIKE '%\\_WORK\\_QUEUE\\_%' ESCAPE '\\\\'
      AND TABLE_NAME != 'MATRIX_BUILD_JOBS'
    ORDER BY TABLE_NAME
  `);
  let roadFilterMap: Record<string, boolean> = {};
  try {
    const jobRows = await runSql(
      `SELECT REGION, PROFILE, RESOLUTION, ROAD_FILTER AS RF
       FROM (
         SELECT REGION, PROFILE, RESOLUTION, ROAD_FILTER,
                ROW_NUMBER() OVER (PARTITION BY REGION, PROFILE, RESOLUTION ORDER BY COMPLETED_AT DESC NULLS LAST) AS RN
         FROM ${SF_DATABASE}.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
         WHERE STATUS = 'COMPLETE'
       ) WHERE RN = 1`
    );
    for (const r of jobRows || []) {
      const key = `${(r.REGION || '').toUpperCase()}_${(r.PROFILE || '').replace(/-/g, '_').toUpperCase()}_${r.RESOLUTION}`;
      roadFilterMap[key] = r.RF === true || r.RF === 'true';
    }
  } catch {}
  const tables = rows.map((r: any) => {
    const parsed = parseViewerTableName(r.TABLE_NAME);
    if (!parsed) return null;
    const lookupKey = `${(parsed.region || '').toUpperCase()}_${(parsed.profile || '').replace(/-/g, '_').toUpperCase()}_${parsed.resolution}`;
    return {
      ...parsed,
      row_count: parseInt(r.ROW_COUNT || '0'),
      bytes: parseInt(r.BYTES || '0'),
      table_name: r.TABLE_NAME,
      full_table: `${SF_DATABASE}.TRAVEL_MATRIX.${r.TABLE_NAME}`,
      road_filter: roadFilterMap[lookupKey] === true,
    };
  }).filter(Boolean);
  viewerInventoryCache = { tables, ts: Date.now() };
  return tables;
}

function validateViewerTable(tableName: string): string | null {
  const tables = viewerInventoryCache.tables;
  const found = tables.find((t: any) => t.full_table === tableName || t.table_name === tableName);
  if (found) return found.full_table;
  if (/^[A-Z0-9_]+\.[A-Z0-9_]+\.[A-Z0-9_]+$/i.test(tableName)) {
    const parsed = parseViewerTableName(tableName.split('.').pop()!);
    if (parsed) return tableName;
  }
  return null;
}

app.get('/api/matrix/viewer-inventory', async (_req, res) => {
  try {
    const tables = await getViewerInventory();
    res.json({ tables });
  } catch (err: any) {
    res.json({ tables: [], error: err.message });
  }
});

app.get('/api/matrix/random-origin', async (req, res) => {
  try {
    const tableParam = req.query.table as string;
    if (!tableParam) return res.status(400).json({ error: 'table parameter required' });
    await getViewerInventory();
    const table = validateViewerTable(tableParam);
    if (!table) return res.status(400).json({ error: 'Invalid table name' });
    const [[originRow], [maxRow]] = await Promise.all([
      runSql(`SELECT ORIGIN_H3 FROM (SELECT ORIGIN_H3, COUNT(*) AS CNT FROM ${table} GROUP BY ORIGIN_H3 ORDER BY CNT DESC LIMIT 10) ORDER BY RANDOM() LIMIT 1`),
      runSql(`SELECT MAX(TRAVEL_TIME_SECONDS) AS GLOBAL_MAX FROM ${table}`),
    ]);
    const hex = originRow?.ORIGIN_H3;
    if (!hex) return res.json({ error: 'No data in table' });
    const latLon = await runSql(
      `SELECT ST_Y(H3_CELL_TO_POINT('${hex}')) AS LAT, ST_X(H3_CELL_TO_POINT('${hex}')) AS LON`
    );
    res.json({
      origin_hex: hex,
      origin_lat: Number(latLon[0]?.LAT || 0),
      origin_lon: Number(latLon[0]?.LON || 0),
      global_max_time_secs: Number(maxRow?.GLOBAL_MAX || 0),
    });
  } catch (err: any) {
    console.error('Random-origin error:', err.message);
    res.json({ error: err.message });
  }
});

app.get('/api/matrix/all-hexes', async (req, res) => {
  try {
    const tableParam = req.query.table as string;
    if (!tableParam) return res.status(400).json({ error: 'table parameter required' });
    await getViewerInventory();
    const table = validateViewerTable(tableParam);
    if (!table) return res.status(400).json({ error: 'Invalid table name' });
    const rows = await runSql(`SELECT DISTINCT ORIGIN_H3 AS HEX_ID FROM ${table}`);
    res.json({ hexes: rows.map((r: any) => r.HEX_ID) });
  } catch (err: any) {
    console.error('All-hexes error:', err.message);
    res.json({ hexes: [] });
  }
});

app.get('/api/matrix/reachability', async (req, res) => {
  try {
    const tableParam = req.query.table as string;
    const origin = req.query.origin as string;
    if (!tableParam || !origin) return res.status(400).json({ error: 'table and origin required' });
    await getViewerInventory();
    const table = validateViewerTable(tableParam);
    if (!table) return res.status(400).json({ error: 'Invalid table name' });
    const safeOrigin = origin.replace(/[^a-fA-F0-9]/g, '');
    const maxTimeSecs = req.query.max_time ? Number(req.query.max_time) : null;
    const timeFilter = maxTimeSecs ? `AND TRAVEL_TIME_SECONDS <= ${maxTimeSecs}` : '';
    const rows = await runSql(`
      SELECT
        DEST_H3 AS HEX_ID,
        TRAVEL_TIME_SECONDS,
        TRAVEL_DISTANCE_METERS
      FROM ${table}
      WHERE ORIGIN_H3 = '${safeOrigin}'
        AND TRAVEL_TIME_SECONDS IS NOT NULL
        ${timeFilter}
    `);
    const originLatLon = await runSql(
      `SELECT ST_Y(H3_CELL_TO_POINT('${safeOrigin}')) AS LAT, ST_X(H3_CELL_TO_POINT('${safeOrigin}')) AS LON`
    );
    res.json({
      destinations: rows,
      origin_lat: Number(originLatLon[0]?.LAT || 0),
      origin_lon: Number(originLatLon[0]?.LON || 0),
    });
  } catch (err: any) {
    console.error('Reachability error:', err.message);
    res.json({ destinations: [], origin_lat: 0, origin_lon: 0 });
  }
});

app.get('/api/matrix/ring-stats', async (req, res) => {
  try {
    const tableParam = req.query.table as string;
    const origin = req.query.origin as string;
    if (!tableParam || !origin) return res.status(400).json({ error: 'table and origin required' });
    await getViewerInventory();
    const table = validateViewerTable(tableParam);
    if (!table) return res.status(400).json({ error: 'Invalid table name' });
    const safeOrigin = origin.replace(/[^a-fA-F0-9]/g, '');
    const rows = await runSql(`
      SELECT
        H3_GRID_DISTANCE('${safeOrigin}', DEST_H3) AS RING,
        COUNT(*) AS HEX_COUNT,
        ROUND(MIN(TRAVEL_TIME_SECONDS) / 60, 1) AS MIN_MINS,
        ROUND(AVG(TRAVEL_TIME_SECONDS) / 60, 1) AS AVG_MINS,
        ROUND(MAX(TRAVEL_TIME_SECONDS) / 60, 1) AS MAX_MINS,
        ROUND(AVG(TRAVEL_DISTANCE_METERS) / 1000, 2) AS AVG_KM
      FROM ${table}
      WHERE ORIGIN_H3 = '${safeOrigin}'
      GROUP BY RING
      HAVING RING IS NOT NULL
      ORDER BY RING
    `);
    res.json({ rings: rows });
  } catch (err: any) {
    console.error('Ring-stats error:', err.message);
    res.json({ rings: [] });
  }
});

const TOOL_PROCEDURE_MAP: Record<string, { identifier: string; params: string[] }> = {
  tool_directions: {
    identifier: 'FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_DIRECTIONS',
    params: ['locations_description', 'profile'],
  },
  tool_isochrone: {
    identifier: 'FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ISOCHRONE',
    params: ['location_description', 'range_minutes', 'profile'],
  },
  tool_optimization: {
    identifier: 'FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ROUTE_OPTIMIZATION',
    params: ['jobs_description', 'num_vehicles', 'profile'],
  },
  tool_poi: {
    identifier: '__local__',
    params: ['location_description', 'category', 'range_minutes', 'profile'],
  },
};

const POI_CATEGORY_MAP: Record<string, string[]> = {
  restaurant: ['restaurant', 'fast_food_restaurant', 'casual_eatery', 'fine_dining_restaurant', 'pizzaria', 'chicken_restaurant', 'sandwich_shop', 'sushi_restaurant', 'seafood_restaurant', 'steak_house', 'burger_restaurant'],
  cafe: ['cafe', 'coffee_shop', 'bakery', 'tea_house'],
  bar: ['bar', 'pub', 'nightclub', 'lounge'],
  hotel: ['hotel', 'motel', 'hostel', 'bed_and_breakfast'],
  shop: ['shopping_mall', 'convenience_store', 'supermarket', 'department_store', 'clothing_store'],
  hospital: ['hospital', 'medical_clinic', 'pharmacy', 'dentist'],
  school: ['school', 'university', 'college', 'kindergarten'],
  park: ['park', 'playground', 'sports_complex', 'golf_course'],
  gas_station: ['gas_station', 'charging_station'],
  parking: ['parking', 'parking_garage'],
};

async function executeToolPoi(input: Record<string, any>): Promise<any> {
  const { location_description, category, range_minutes, profile } = input;
  const cats = POI_CATEGORY_MAP[String(category || 'restaurant').toLowerCase()] || POI_CATEGORY_MAP['restaurant'];
  const isoResult = await executeToolLocally('tool_isochrone', { location_description, range_minutes: range_minutes ?? 10, profile });
  if (isoResult?.status === 'FAILED' || isoResult?.error) return isoResult;
  const geometry = isoResult?.geometry;
  if (!geometry) return { error: 'Isochrone returned no geometry', status: 'FAILED' };
  const catFilter = cats.map((c: string) => `'${c}'`).join(',');
  const geojsonStr = JSON.stringify(geometry).replace(/'/g, "''");
  const sql = `
    SELECT NAMES::VARIANT:primary::STRING AS NAME,
           BASIC_CATEGORY AS CATEGORY,
           ST_Y(GEOMETRY) AS LAT,
           ST_X(GEOMETRY) AS LNG
    FROM OVERTURE_MAPS__PLACES.CARTO.PLACE
    WHERE ST_WITHIN(GEOMETRY, TO_GEOGRAPHY('${geojsonStr}'))
      AND BASIC_CATEGORY IN (${catFilter})
    LIMIT 200`;
  try {
    const rows = await runSql(sql, 'OVERTURE_MAPS__PLACES', 'CARTO');
    const poi_list = (rows || []).map((r: any) => ({
      name: r.NAME || 'Unknown',
      category: r.CATEGORY || category,
      lat: Number(r.LAT),
      lng: Number(r.LNG),
    }));
    return { ...isoResult, poi_list, poi_count: poi_list.length };
  } catch (e: any) {
    return { ...isoResult, poi_list: [], poi_count: 0, poi_error: e.message?.slice(0, 200) };
  }
}

const ROUTING_SYSTEM_PROMPT = `You are a routing agent powered by OpenRouteService. You help users with:
1. Driving/cycling/walking directions between locations
2. Reachability analysis (isochrones) - areas reachable within X minutes
3. Multi-stop delivery route optimization
4. Finding points of interest (restaurants, cafes, bars, hotels, shops, etc.) within a reachable area

You have access to four tools. To call a tool, respond with EXACTLY this JSON format and NOTHING else:
{"tool_call": {"name": "TOOL_NAME", "input": {PARAMS}}}

Available tools:
1. tool_directions - Get directions between locations
   Input: {"locations_description": "string describing start/end/waypoints (required)", "profile": "string (default: driving-car)"}
2. tool_isochrone - Get area reachable within specified minutes from a location
   Input: {"location_description": "string describing the center location (required)", "range_minutes": number (required), "profile": "string (default: driving-car)"}
3. tool_optimization - Optimize delivery/pickup routes for multiple stops with one or more vehicles
   Input: {"jobs_description": "string describing all delivery/pickup locations including the depot/start address (required)", "num_vehicles": number (default: 1), "profile": "string (default: driving-car)"}
4. tool_poi - Find points of interest within a reachable area from a location. Use when user asks to show/find specific place types within a travel time (e.g. "restaurants within 10 min drive").
   Input: {"location_description": "string describing the center location (required)", "category": "one of: restaurant, cafe, bar, hotel, shop, hospital, school, park, gas_station, parking (required)", "range_minutes": number (required), "profile": "string (default: driving-car)"}

Transport profiles available: driving-car, cycling-electric (use for ANY cycling/bike request), driving-hgv (trucks only)

CRITICAL RULES:
1. ALWAYS call the appropriate tool for ANY routing question. NEVER answer from general knowledge.
2. When you need to call a tool, respond ONLY with the JSON tool_call object. No other text.
3. After receiving tool results, format them clearly: distances in km, durations in minutes.
4. If a tool returns an error, report it clearly. Do NOT retry with a different profile.
5. NEVER fabricate routing data.
6. Use tool_poi (NOT tool_isochrone) when the user asks to find/show specific place types within a travel time.
7. ONLY use these exact profile strings: driving-car, cycling-electric, driving-hgv. Never use cycling-regular, cycling-road, foot-walking or any other variant.`;

const AGENT_PROFILE_ALIASES: Record<string, string> = {
  'bike': 'cycling-electric', 'bicycle': 'cycling-electric', 'cycling': 'cycling-electric',
  'cycle': 'cycling-electric', 'cycling-regular': 'cycling-electric', 'cycling-road': 'cycling-electric',
  'cycling-mountain': 'cycling-electric', 'foot-walking': 'driving-car', 'walk': 'driving-car',
  'walking': 'driving-car', 'foot': 'driving-car', 'car': 'driving-car',
  'drive': 'driving-car', 'driving': 'driving-car', 'truck': 'driving-hgv', 'hgv': 'driving-hgv',
};
const AGENT_VALID_PROFILES = new Set(['driving-car', 'driving-hgv', 'cycling-electric']);

function normalizeAgentProfile(profile: string | undefined): string {
  if (!profile) return 'driving-car';
  const lower = profile.toLowerCase().trim();
  if (AGENT_VALID_PROFILES.has(lower)) return lower;
  return AGENT_PROFILE_ALIASES[lower] || 'driving-car';
}

function escAgentSql(val: any): string {
  if (val === undefined || val === null) return "''";
  return "'" + String(val).replace(/'/g, "''") + "'";
}

async function executeToolLocally(toolName: string, input: Record<string, any>): Promise<any> {
  if (toolName === 'tool_poi') return executeToolPoi(input);
  const mapping = TOOL_PROCEDURE_MAP[toolName];
  if (!mapping || mapping.identifier === '__local__') return { error: `Unknown tool: ${toolName}`, status: 'FAILED' };
  const args = mapping.params.map(p => {
    let val = input[p];
    if (p === 'profile') val = normalizeAgentProfile(val as string);
    if (val === undefined || val === null) return 'DEFAULT';
    if (typeof val === 'number') return String(val);
    return escAgentSql(val);
  });
  const sql = `CALL ${mapping.identifier}(${args.join(', ')})`;
  try {
    const rows = await runSql(sql, 'FLEET_INTELLIGENCE', 'ROUTING_AGENT');
    const result = rows?.[0];
    if (result) {
      const firstVal = Object.values(result)[0];
      if (typeof firstVal === 'string') {
        try { return JSON.parse(firstVal); } catch { return firstVal; }
      }
      return firstVal;
    }
    return { error: 'No result from tool execution', status: 'FAILED' };
  } catch (err: any) {
    return { error: `Tool execution failed: ${err.message}`, status: 'FAILED' };
  }
}

function escAgentSqlStr(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/[\x00-\x1f]/g, ' ');
}

const AGENT_MODELS = ['claude-sonnet-4-5', 'mistral-large2'];
let agentModel = AGENT_MODELS[0];

async function callCortexCompleteStreaming(
  messages: Array<{role: string; content: string}>,
  onToken: (text: string) => void,
): Promise<string> {
  const token = getSpcsToken();
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    'X-Snowflake-Authorization-Token-Type': 'OAUTH',
  };
  const body = JSON.stringify({
    model: agentModel,
    messages,
    stream: true,
    max_tokens: 4096,
    temperature: 0,
  });
  const url = `https://${SNOWFLAKE_HOST}/api/v2/cortex/inference:complete`;
  console.log(`[Agent] Streaming CORTEX.COMPLETE model=${agentModel}, msgCount=${messages.length}`);
  const startMs = Date.now();
  const res = await fetch(url, { method: 'POST', headers, body });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Cortex streaming API ${res.status}: ${errText.slice(0, 300)}`);
  }
  const reader = res.body?.getReader();
  if (!reader) throw new Error('No readable body from Cortex streaming response');
  const decoder = new TextDecoder();
  let fullText = '';
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data);
        const text = parsed.choices?.[0]?.delta?.content || '';
        if (text) { fullText += text; onToken(text); }
      } catch {}
    }
  }
  console.log(`[Agent] Streaming completed in ${Date.now() - startMs}ms, length=${fullText.length}`);
  if (!fullText) throw new Error('Cortex streaming returned empty response');
  return fullText;
}

async function callCortexComplete(messages: Array<{role: string; content: string}>): Promise<string> {
  const msgArray = messages.map(m => {
    return `{'role':'${m.role}','content':'${escAgentSqlStr(m.content)}'}`;
  }).join(',');
  const sql = `SELECT SNOWFLAKE.CORTEX.COMPLETE('${agentModel}', [${msgArray}], {'max_tokens':4096,'temperature':0}) as RESPONSE`;
  console.log(`[Agent] Calling CORTEX.COMPLETE with model=${agentModel}, msgCount=${messages.length}, sqlLen=${sql.length}`);
  const startMs = Date.now();
  let rows: any[];
  try {
    rows = await runSql(sql, 'FLEET_INTELLIGENCE', 'ROUTING_AGENT');
  } catch (err: any) {
    console.error(`[Agent] CORTEX.COMPLETE failed (${Date.now() - startMs}ms): ${err.message}`);
    if (agentModel === AGENT_MODELS[0] && AGENT_MODELS.length > 1) {
      console.log(`[Agent] Retrying with fallback model ${AGENT_MODELS[1]}`);
      agentModel = AGENT_MODELS[1];
      const retrySql = sql.replace(AGENT_MODELS[0], agentModel);
      rows = await runSql(retrySql, 'FLEET_INTELLIGENCE', 'ROUTING_AGENT');
    } else {
      throw err;
    }
  }
  console.log(`[Agent] CORTEX.COMPLETE returned in ${Date.now() - startMs}ms`);
  if (!rows || rows.length === 0) throw new Error('No response from CORTEX.COMPLETE');
  const raw = rows[0].RESPONSE || rows[0][Object.keys(rows[0])[0]] || '';
  let content = '';
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    content = parsed.choices?.[0]?.messages || parsed.choices?.[0]?.message?.content || '';
  } catch {
    content = String(raw);
  }
  if (!content) {
    console.error(`[Agent] Empty content from CORTEX.COMPLETE. Raw: ${JSON.stringify(raw).slice(0, 500)}`);
    throw new Error('Empty response from LLM');
  }
  return content.trim();
}

function findMatchingBrace(s: string): number {
  let depth = 0; let inStr = false; let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function parseToolCall(text: string): { name: string; input: Record<string, any> } | null {
  try {
    const match = text.match(/\{\s*"tool_call"\s*:/s);
    if (!match) return null;
    const jsonStr = text.slice(text.indexOf('{'));
    const braceEnd = findMatchingBrace(jsonStr);
    if (braceEnd < 0) return null;
    const parsed = JSON.parse(jsonStr.slice(0, braceEnd + 1));
    if (parsed.tool_call?.name && TOOL_PROCEDURE_MAP[parsed.tool_call.name]) {
      return { name: parsed.tool_call.name, input: parsed.tool_call.input || {} };
    }
  } catch {}
  return null;
}

async function callCortexAgentWithToolLoop(
  message: string, threadId?: string, parentMessageId?: string,
  onProgress?: (data: { step: string; detail?: string }) => void,
  onToken?: (text: string) => void,
): Promise<any> {
  if (!IS_SPCS) throw new Error('Cortex Agent is only available in SPCS mode');
  console.log(`[Agent] Starting tool loop for: "${message.slice(0, 100)}"`);
  const messages: Array<{role: string; content: string}> = [
    { role: 'system', content: ROUTING_SYSTEM_PROMPT },
    { role: 'user', content: message },
  ];
  const maxIterations = 5;
  const allToolResults: any[] = [];
  let toolsExecuted = false;

  for (let iter = 0; iter < maxIterations; iter++) {
    onProgress?.({ step: 'calling_llm', detail: iter === 0 ? 'Thinking...' : `Processing (step ${iter + 1})` });

    if (toolsExecuted && onToken) {
      onProgress?.({ step: 'formatting', detail: 'Generating response...' });
      try {
        const streamedText = await callCortexCompleteStreaming(messages, onToken);
        return { role: 'assistant', content: [{ type: 'text', text: streamedText }], _toolResults: allToolResults };
      } catch (streamErr: any) {
        console.warn(`[Agent] Streaming failed, falling back to blocking: ${streamErr.message}`);
        const fallback = await callCortexComplete(messages);
        onToken(fallback);
        return { role: 'assistant', content: [{ type: 'text', text: fallback }], _toolResults: allToolResults };
      }
    }

    const response = await callCortexComplete(messages);
    console.log(`[Agent] LLM response (iter ${iter}): ${response.slice(0, 200)}`);
    const toolCall = parseToolCall(response);

    if (!toolCall) {
      console.log(`[Agent] No tool call found, returning text response`);
      if (onToken) onToken(response);
      return { role: 'assistant', content: [{ type: 'text', text: response }], _toolResults: allToolResults };
    }

    const toolLabel = toolCall.name.replace('tool_', '');
    onProgress?.({ step: 'executing_tool', detail: toolLabel });
    console.log(`[Agent] Executing tool: ${toolCall.name}`);
    messages.push({ role: 'assistant', content: response });
    const toolResult = await executeToolLocally(toolCall.name, toolCall.input);
    allToolResults.push(toolResult);
    toolsExecuted = true;
    const resultStr = JSON.stringify(toolResult).slice(0, 30000);
    messages.push({ role: 'user', content: `Tool result from ${toolCall.name}:\n${resultStr}\n\nNow provide your final answer based on this data. Format distances in km and durations in minutes. Be concise.` });
  }
  return { role: 'assistant', content: [{ type: 'text', text: 'I was unable to complete the request after multiple attempts.' }], _toolResults: allToolResults };
}

function sendSseEvent(res: any, event: string, data: any) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

app.post('/api/agent/chat', async (req, res) => {
  const { message, thread_id, parent_message_id } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  try {
    const onProgress = (data: { step: string; detail?: string }) => { sendSseEvent(res, 'progress', data); };
    const onToken = (text: string) => { res.write(`event: token\ndata: ${JSON.stringify({ text })}\n\n`); };
    const agentResult = await callCortexAgentWithToolLoop(message, thread_id, parent_message_id, onProgress, onToken);
    const content = agentResult?.content || [];
    let msg = '';
    let geometry: any = null;
    const toolResults: any[] = agentResult?._toolResults || [];
    for (const item of content) { if (item.type === 'text') msg += (msg ? '\n' : '') + item.text; }
    for (const tr of toolResults) { if (tr && typeof tr === 'object' && tr.geometry && !geometry) geometry = tr.geometry; }
    if (!msg) msg = agentResult?.message || 'No response from agent';
    const response: any = { message: msg, tool_results: toolResults };
    if (geometry) response.geometry = geometry;
    if (agentResult?.metadata?.thread_id) response.thread_id = agentResult.metadata.thread_id;
    if (agentResult?.metadata?.message_id) response.message_id = agentResult.metadata.message_id;
    sendSseEvent(res, 'result', response);
    res.end();
  } catch (err: any) {
    console.error(`[Agent] Chat endpoint error: ${err.message}`);
    sendSseEvent(res, 'error', { error: err.message || 'Unknown agent error' });
    res.end();
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