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
import { createMatrixRouter } from './routes/matrix.js';
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


app.use(createMatrixRouter());

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