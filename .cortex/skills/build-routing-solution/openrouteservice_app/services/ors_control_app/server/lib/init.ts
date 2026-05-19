// Boot-time idempotent init for Backload Matching (BACKLOAD_MATCHING schema +
// projection views over UNIFIED) and Asset Velocity (ROUTE_OPTIMIZATION views
// over DWELL_ANALYSIS DTs). Mirrors the contents of:
//   .cortex/skills/backload-matching/references/bootstrap.sql
//   .cortex/skills/route-optimization/references/asset-velocity-views.sql
// so a fresh install of build-routing-solution makes both demos work without
// requiring a manual `snow sql -f` step.

import { currentRegionScalar } from './region.js';
import { log } from '../diagnostics.js';

export async function ensureBackloadAndAssetVelocityObjects(
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
