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
  const TRACK_FX = `'{"origin":"sf_sit-is-fleet","name":"oss-freight-exchange","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}'`;
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
          FROM SYNTHETIC_DATASETS.UNIFIED.V_FACT_TRIPS_CURRENT
          WHERE REGION       = ${currentRegionScalar('BACKLOAD_MATCHING')}
            AND VEHICLE_TYPE = (SELECT VEHICLE_TYPE FROM FLEET_INTELLIGENCE.BACKLOAD_MATCHING.CONFIG LIMIT 1)
          GROUP BY VEHICLE_ID
        ),
        home_anchor AS (
          SELECT AVG(LAT) AS HOME_LAT, AVG(LNG) AS HOME_LON
          FROM SYNTHETIC_DATASETS.UNIFIED.V_DIM_POIS_CURRENT
          WHERE REGION = ${currentRegionScalar('BACKLOAD_MATCHING')}
        ),
        -- Collapse DIM_POIS to one row per LOCATION_ID. The base table can have
        -- multiple rows per LOCATION_ID (POI name variants, regen overlap),
        -- which would otherwise multiply trailer rows via the LEFT JOINs below
        -- and cause VROOM to receive the same TRAILER_ID as multiple vehicles.
        poi AS (
          SELECT LOCATION_ID,
                 ANY_VALUE(NAME) AS NAME,
                 ANY_VALUE(LAT)  AS LAT,
                 ANY_VALUE(LNG)  AS LNG
          FROM SYNTHETIC_DATASETS.UNIFIED.V_DIM_POIS_CURRENT
          WHERE REGION = ${currentRegionScalar('BACKLOAD_MATCHING')}
          GROUP BY LOCATION_ID
        ),
        -- Collapse DIM_FLEET to one row per VEHICLE_ID for the same reason
        -- (the synthetic dataset can carry duplicate fleet rows).
        fleet AS (
          SELECT VEHICLE_ID,
                 ANY_VALUE(REGION)             AS REGION,
                 ANY_VALUE(VEHICLE_TYPE)       AS VEHICLE_TYPE,
                 ANY_VALUE(HOME_LOCATION_ID)   AS HOME_LOCATION_ID,
                 ANY_VALUE(BATTERY_RANGE_KM)   AS BATTERY_RANGE_KM
          FROM SYNTHETIC_DATASETS.UNIFIED.V_DIM_FLEET_CURRENT
          WHERE REGION       = ${currentRegionScalar('BACKLOAD_MATCHING')}
            AND VEHICLE_TYPE = (SELECT VEHICLE_TYPE FROM FLEET_INTELLIGENCE.BACKLOAD_MATCHING.CONFIG LIMIT 1)
          GROUP BY VEHICLE_ID
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
        FROM fleet f
        JOIN last_drop ld ON ld.VEHICLE_ID = f.VEHICLE_ID
        LEFT JOIN poi h ON h.LOCATION_ID = f.HOME_LOCATION_ID
        LEFT JOIN poi d ON d.LOCATION_ID = ld.DROPOFF_POI_ID`,
      db: 'FLEET_INTELLIGENCE', schema: 'BACKLOAD_MATCHING',
    },
    {
      sql: `CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_INTERNAL_VOLUMES
        COMMENT = ${TRACK}
        AS
        WITH poi AS (
          -- Same pre-aggregation as VW_EXTERNAL_OFFERS / VW_TRAILERS:
          -- DIM_POIS may have multiple rows per LOCATION_ID after Studio
          -- re-runs, which would otherwise multiply trip rows here.
          SELECT LOCATION_ID,
                 ANY_VALUE(NAME) AS NAME
          FROM SYNTHETIC_DATASETS.UNIFIED.V_DIM_POIS_CURRENT
          WHERE REGION = ${currentRegionScalar('BACKLOAD_MATCHING')}
          GROUP BY LOCATION_ID
        ),
        trips AS (
          -- Defence-in-depth: even though FACT_TRIPS uses random TRIP_IDs
          -- per Studio run (so source dedupe is normally a no-op), keep
          -- one row per TRIP_ID so a future regression cannot multiply
          -- VROOM shipments under different INT-NNNNN ids.
          SELECT t.TRIP_ID,
                 t.TRIP_START,
                 t.ORIGIN_LON, t.ORIGIN_LAT,
                 t.DESTINATION_LON, t.DESTINATION_LAT,
                 t.ORIGIN_POI_ID, t.DESTINATION_POI_ID
          FROM SYNTHETIC_DATASETS.UNIFIED.V_FACT_TRIPS_CURRENT t
          WHERE t.REGION       = ${currentRegionScalar('BACKLOAD_MATCHING')}
            AND t.VEHICLE_TYPE = (SELECT VEHICLE_TYPE FROM FLEET_INTELLIGENCE.BACKLOAD_MATCHING.CONFIG LIMIT 1)
          QUALIFY ROW_NUMBER() OVER (PARTITION BY t.TRIP_ID ORDER BY t.TRIP_START DESC) = 1
        )
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
        FROM trips t
        LEFT JOIN poi o ON o.LOCATION_ID = t.ORIGIN_POI_ID
        LEFT JOIN poi d ON d.LOCATION_ID = t.DESTINATION_POI_ID
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
        WITH poi AS (
          -- Collapse DIM_POIS to one row per LOCATION_ID. Re-running Data
          -- Studio for the same region used to compound rows, so the LEFT
          -- JOINs below would multiply offers; pre-aggregating here makes
          -- the view robust to that.
          SELECT LOCATION_ID,
                 ANY_VALUE(NAME) AS NAME
          FROM SYNTHETIC_DATASETS.UNIFIED.V_DIM_POIS_CURRENT
          WHERE REGION = ${currentRegionScalar('BACKLOAD_MATCHING')}
          GROUP BY LOCATION_ID
        ),
        offers AS (
          -- Dedupe FACT_FREIGHT_OFFERS by OFFER_ID. The seed pipeline can
          -- accumulate multiple rows per OFFER_ID across runs; keep the
          -- newest by POSTED_AT (and PICKUP_FROM_TS as tiebreaker).
          SELECT *
          FROM SYNTHETIC_DATASETS.UNIFIED.V_FACT_FREIGHT_OFFERS_CURRENT
          WHERE REGION = ${currentRegionScalar('BACKLOAD_MATCHING')}
          QUALIFY ROW_NUMBER() OVER (
            PARTITION BY OFFER_ID
            ORDER BY POSTED_AT DESC NULLS LAST, PICKUP_FROM_TS DESC NULLS LAST
          ) = 1
        )
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
        FROM offers f
        LEFT JOIN poi p ON p.LOCATION_ID = f.PICKUP_POI_ID
        LEFT JOIN poi d ON d.LOCATION_ID = f.DROPOFF_POI_ID`,
      db: 'FLEET_INTELLIGENCE', schema: 'BACKLOAD_MATCHING',
    },
    // ---------------------------------------------------------------
    // Card F: AVOID_ZONES — seeded with two real EU low-emission zones
    // (Berlin, Munich) and a sample construction zone. The Backload UI
    // sends the polygons to ORS via vehicle.profile_options.avoid_polygons.
    // ---------------------------------------------------------------
    {
      sql: `CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING.AVOID_ZONES (
        ZONE_ID   VARCHAR PRIMARY KEY,
        NAME      VARCHAR,
        CATEGORY  VARCHAR,
        POLYGON   GEOGRAPHY,
        CREATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
      ) COMMENT = ${TRACK}`,
      db: 'FLEET_INTELLIGENCE', schema: 'BACKLOAD_MATCHING',
    },
    {
      sql: `MERGE INTO FLEET_INTELLIGENCE.BACKLOAD_MATCHING.AVOID_ZONES tgt
        USING (
          SELECT 'BERLIN_LEZ' AS ZONE_ID,
                 'Berlin Umweltzone (LEZ)' AS NAME,
                 'low-emission-zone' AS CATEGORY,
                 TO_GEOGRAPHY('POLYGON((13.310 52.475, 13.450 52.475, 13.450 52.555, 13.310 52.555, 13.310 52.475))') AS POLYGON
          UNION ALL
          SELECT 'MUNICH_LEZ',
                 'München Umweltzone (LEZ)',
                 'low-emission-zone',
                 TO_GEOGRAPHY('POLYGON((11.530 48.110, 11.620 48.110, 11.620 48.180, 11.530 48.180, 11.530 48.110))')
          UNION ALL
          SELECT 'SAMPLE_CONSTRUCTION',
                 'Sample construction zone',
                 'construction',
                 TO_GEOGRAPHY('POLYGON((11.560 48.140, 11.580 48.140, 11.580 48.150, 11.560 48.150, 11.560 48.140))')
        ) src ON tgt.ZONE_ID = src.ZONE_ID
        WHEN NOT MATCHED THEN INSERT (ZONE_ID, NAME, CATEGORY, POLYGON)
                              VALUES (src.ZONE_ID, src.NAME, src.CATEGORY, src.POLYGON)`,
      db: 'FLEET_INTELLIGENCE', schema: 'BACKLOAD_MATCHING',
    },
    // Best-effort: extend PROPOSAL_DECISIONS with NET_BENEFIT_EUR for
    // older deployments that pre-date the economics column.
    {
      sql: `ALTER TABLE FLEET_INTELLIGENCE.BACKLOAD_MATCHING.PROPOSAL_DECISIONS
              ADD COLUMN IF NOT EXISTS NET_BENEFIT_EUR FLOAT`,
      db: 'FLEET_INTELLIGENCE', schema: 'BACKLOAD_MATCHING',
    },
    // Asset Velocity views (ROUTE_OPTIMIZATION) — ensure CONFIG has the
    // cost-of-idleness columns then deploy the four vehicle-type-aware views.
    //
    // IMPORTANT: This block is the SOURCE OF TRUTH for the views the React
    // page reads (it runs on every container start and CREATE OR REPLACEs them).
    // Keep it in sync with .cortex/skills/route-optimization/references/asset-velocity-views.sql.
    {
      sql: `ALTER TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG ADD COLUMN IF NOT EXISTS DAILY_RENTAL_RATE_AVOIDED_USD NUMBER(10,2)`,
      db: 'FLEET_INTELLIGENCE', schema: 'ROUTE_OPTIMIZATION',
    },
    {
      sql: `ALTER TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG ADD COLUMN IF NOT EXISTS RENTAL_CAPTURE_RATE NUMBER(4,3)`,
      db: 'FLEET_INTELLIGENCE', schema: 'ROUTE_OPTIMIZATION',
    },
    // v1.1 smart-reposition columns: shift cap (drives matrix gate +
    // isochrone range + VROOM time_window) and ORS avoid_features.
    {
      sql: `ALTER TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG ADD COLUMN IF NOT EXISTS MAX_REPOSITION_MINUTES NUMBER(6,0)`,
      db: 'FLEET_INTELLIGENCE', schema: 'ROUTE_OPTIMIZATION',
    },
    {
      sql: `ALTER TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG ADD COLUMN IF NOT EXISTS AVOID_FEATURES VARCHAR(200)`,
      db: 'FLEET_INTELLIGENCE', schema: 'ROUTE_OPTIMIZATION',
    },
    {
      sql: `UPDATE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG
              SET DAILY_RENTAL_RATE_AVOIDED_USD = COALESCE(DAILY_RENTAL_RATE_AVOIDED_USD, 80.00),
                  RENTAL_CAPTURE_RATE          = COALESCE(RENTAL_CAPTURE_RATE, 0.600),
                  MAX_REPOSITION_MINUTES       = COALESCE(MAX_REPOSITION_MINUTES, 600),
                  AVOID_FEATURES               = COALESCE(AVOID_FEATURES, 'tollways,ferries')`,
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
          FROM SYNTHETIC_DATASETS.UNIFIED.V_DIM_FLEET_CURRENT f, cfg
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
          FROM SYNTHETIC_DATASETS.UNIFIED.V_FACT_TRIPS_CURRENT t, cfg
          WHERE t.VEHICLE_TYPE = cfg.VEHICLE_TYPE
            AND t.REGION       = cfg.REGION
        ),
        recent_trips AS (
          SELECT t.*
          FROM SYNTHETIC_DATASETS.UNIFIED.V_FACT_TRIPS_CURRENT t, window_bounds w, cfg
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
        JOIN SYNTHETIC_DATASETS.UNIFIED.V_DIM_POIS_CURRENT p
          ON p.LOCATION_ID = a.POI_ID
        WHERE p.LOCATION_TYPE IN ('WAREHOUSE','LOGISTICS','DEPOT','TERMINAL','ADDRESS','STORE','RESTAURANT')
          AND (a.OUTBOUND - a.INBOUND) > 0`,
      db: 'FLEET_INTELLIGENCE', schema: 'ROUTE_OPTIMIZATION',
    },
    {
      sql: `CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.VW_FLEET_HGV_PROFILE
        COMMENT = ${TRACK_RO}
        AS
        WITH cfg AS (
          SELECT REGION, VEHICLE_TYPE FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG LIMIT 1
        ),
        filtered AS (
          SELECT f.*, MOD(ABS(HASH(f.VEHICLE_ID)), 100) AS BKT
          FROM SYNTHETIC_DATASETS.UNIFIED.V_DIM_FLEET_CURRENT f, cfg
          WHERE f.REGION = cfg.REGION AND f.VEHICLE_TYPE = cfg.VEHICLE_TYPE
          QUALIFY ROW_NUMBER() OVER (PARTITION BY f.VEHICLE_ID ORDER BY f.JOB_ID DESC NULLS LAST) = 1
        )
        SELECT
          f.VEHICLE_ID, f.REGION, f.VEHICLE_TYPE, f.ORS_PROFILE, f.OPERATING_MODE,
          CASE
            WHEN f.OPERATING_MODE <> 'trucking' THEN NULL
            WHEN f.BKT <  60 THEN 'DRY'
            WHEN f.BKT <  85 THEN 'REEFER'
            WHEN f.BKT <  97 THEN 'FLAT'
            ELSE 'TANKER'
          END AS VEHICLE_SUBTYPE,
          CASE WHEN f.OPERATING_MODE = 'trucking' AND f.BKT = 99 THEN TRUE ELSE FALSE END AS HAZMAT,
          CASE WHEN f.OPERATING_MODE = 'trucking'
               THEN ROUND(38 + (MOD(ABS(HASH(f.VEHICLE_ID || '_w')), 600) / 100.0), 2)
               ELSE 2.0 END AS WEIGHT_TONS,
          CASE WHEN f.OPERATING_MODE = 'trucking' THEN 4.00 ELSE 2.00 END AS HEIGHT_M,
          CASE WHEN f.OPERATING_MODE = 'trucking' THEN 16.50 ELSE 4.50 END AS LENGTH_M,
          CASE WHEN f.OPERATING_MODE = 'trucking' THEN 2.55 ELSE 1.85 END AS WIDTH_M,
          CASE WHEN f.OPERATING_MODE = 'trucking' THEN 11.50 ELSE 1.20 END AS AXLELOAD_T
        FROM filtered f`,
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
          c.MAX_REPOSITION_MINUTES, c.AVOID_FEATURES,
          hgv.VEHICLE_SUBTYPE, hgv.HAZMAT, hgv.WEIGHT_TONS, hgv.HEIGHT_M,
          hgv.LENGTH_M, hgv.WIDTH_M, hgv.AXLELOAD_T, hgv.ORS_PROFILE,
          ROUND(t.IDLE_DAYS * c.DAILY_RENTAL_RATE_AVOIDED_USD, 2)                            AS COST_OF_IDLENESS_USD,
          ROUND(t.IDLE_DAYS * c.DAILY_RENTAL_RATE_AVOIDED_USD * c.RENTAL_CAPTURE_RATE, 2)    AS PROJECTED_SAVINGS_USD,
          CASE
            WHEN t.IDLE_DAYS >= 14 THEN 'CRITICAL'
            WHEN t.IDLE_DAYS >= 7  THEN 'WARNING'
            WHEN t.IDLE_DAYS >= 3  THEN 'WATCH'
            ELSE 'OK'
          END                                                                                AS IDLE_SEVERITY
        FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.VW_IDLE_TRAILERS t
        LEFT JOIN FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.VW_FLEET_HGV_PROFILE hgv
          ON hgv.VEHICLE_ID = t.VEHICLE_ID
        CROSS JOIN (SELECT MAX(DAILY_RENTAL_RATE_AVOIDED_USD) AS DAILY_RENTAL_RATE_AVOIDED_USD,
                           MAX(RENTAL_CAPTURE_RATE)          AS RENTAL_CAPTURE_RATE,
                           MAX(MAX_REPOSITION_MINUTES)       AS MAX_REPOSITION_MINUTES,
                           MAX(AVOID_FEATURES)               AS AVOID_FEATURES
                    FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG) c`,
      db: 'FLEET_INTELLIGENCE', schema: 'ROUTE_OPTIMIZATION',
    },
    // ---------------------------------------------------------------
    // Freight Exchange (Phase A/B): MARKETPLACE schema + projection views
    // over SYNTHETIC_DATASETS.UNIFIED.{FACT_FREIGHT_OFFERS, DIM_PARTNERS,
    // FACT_PARTNER_HISTORY} filtered by MARKETPLACE.CONFIG. Also creates a
    // RATE_INDEX dynamic table at 15-minute lag and a denormalized
    // VW_OFFER_ENRICHED that the React page reads.
    // ---------------------------------------------------------------
    {
      sql: `CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.MARKETPLACE COMMENT = ${TRACK_FX}`,
      db: 'FLEET_INTELLIGENCE',
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.MARKETPLACE.CONFIG (
        VEHICLE_TYPE VARCHAR NOT NULL,
        REGION       VARCHAR NOT NULL
      ) COMMENT = ${TRACK_FX}`,
      db: 'FLEET_INTELLIGENCE', schema: 'MARKETPLACE',
    },
    {
      sql: `MERGE INTO FLEET_INTELLIGENCE.MARKETPLACE.CONFIG tgt
            USING (SELECT 'hgv' AS VEHICLE_TYPE, 'SanFrancisco' AS REGION) src
            ON TRUE
            WHEN NOT MATCHED THEN INSERT (VEHICLE_TYPE, REGION) VALUES (src.VEHICLE_TYPE, src.REGION)`,
      db: 'FLEET_INTELLIGENCE', schema: 'MARKETPLACE',
    },
    // Idempotent ALTERs in case the page is deployed against an older
    // FACT_FREIGHT_OFFERS that pre-dates the Phase-A enrichment columns.
    {
      sql: `ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.FACT_FREIGHT_OFFERS ADD COLUMN IF NOT EXISTS EQUIPMENT VARCHAR(20)`,
      db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED',
    },
    {
      sql: `ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.FACT_FREIGHT_OFFERS ADD COLUMN IF NOT EXISTS ADR_CLASS VARCHAR(8)`,
      db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED',
    },
    {
      sql: `ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.FACT_FREIGHT_OFFERS ADD COLUMN IF NOT EXISTS LDM FLOAT`,
      db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED',
    },
    {
      sql: `ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.FACT_FREIGHT_OFFERS ADD COLUMN IF NOT EXISTS DISTANCE_KM FLOAT`,
      db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED',
    },
    {
      sql: `ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.FACT_FREIGHT_OFFERS ADD COLUMN IF NOT EXISTS PRICE_PER_KM_USD FLOAT`,
      db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED',
    },
    {
      sql: `ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.FACT_FREIGHT_OFFERS ADD COLUMN IF NOT EXISTS PARTNER_ID VARCHAR`,
      db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED',
    },
    {
      sql: `ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.FACT_FREIGHT_OFFERS ADD COLUMN IF NOT EXISTS STATUS VARCHAR(20)`,
      db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED',
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS SYNTHETIC_DATASETS.UNIFIED.DIM_PARTNERS (
        PARTNER_ID VARCHAR, REGION VARCHAR(100), VEHICLE_TYPE VARCHAR(20),
        NAME VARCHAR, COUNTRY VARCHAR(4),
        CREDIT_SCORE NUMBER, PAYMENT_DAYS_AVG NUMBER, KYC_STATUS VARCHAR(20),
        BLACKLIST_FLAG BOOLEAN, FOUNDED_YEAR NUMBER,
        JOB_ID VARCHAR
      ) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}'`,
      db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED',
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS SYNTHETIC_DATASETS.UNIFIED.FACT_PARTNER_HISTORY (
        PARTNER_ID VARCHAR, REGION VARCHAR(100), VEHICLE_TYPE VARCHAR(20),
        ORIGIN_COUNTRY VARCHAR(4), DEST_COUNTRY VARCHAR(4),
        EQUIPMENT VARCHAR(20),
        SHIPPED_AT TIMESTAMP_NTZ, EUR_PER_KM FLOAT,
        OUTCOME VARCHAR(20),
        JOB_ID VARCHAR
      ) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}'`,
      db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED',
    },
    // -----------------------------------------------------------------
    // Dataset-versioning projection views ("CURRENT" = active dataset only)
    // -----------------------------------------------------------------
    // These views filter each base table to rows whose JOB_ID matches the
    // currently-active dataset for their (REGION, VEHICLE_TYPE) per
    // FLEET_INTELLIGENCE.CORE.DIM_DATASETS. Downstream consumers should
    // ALWAYS read from V_*_CURRENT (not the base table) so old datasets
    // remain queryable by JOB_ID without polluting the active view.
    //
    // DIM_POIS has no VEHICLE_TYPE column — a POI dataset is identified
    // purely by (REGION, JOB_ID). Joining on JOB_ID = DATASET_ID with
    // IS_ACTIVE = TRUE returns POIs from any active dataset whose JOB_ID
    // matches, which is exactly what we want when multiple vehicle types
    // are active in the same region.
    {
      sql: `CREATE OR REPLACE VIEW SYNTHETIC_DATASETS.UNIFIED.V_DIM_FLEET_CURRENT
        COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}'
        AS
        SELECT f.*
        FROM SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET f
        JOIN FLEET_INTELLIGENCE.CORE.DIM_DATASETS d
          ON d.DATASET_ID = f.JOB_ID
         AND d.REGION = f.REGION
         AND d.VEHICLE_TYPE = f.VEHICLE_TYPE
         AND d.IS_ACTIVE = TRUE`,
      db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED',
    },
    {
      sql: `CREATE OR REPLACE VIEW SYNTHETIC_DATASETS.UNIFIED.V_DIM_POIS_CURRENT
        COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}'
        AS
        SELECT p.*
        FROM SYNTHETIC_DATASETS.UNIFIED.DIM_POIS p
        JOIN FLEET_INTELLIGENCE.CORE.DIM_DATASETS d
          ON d.DATASET_ID = p.JOB_ID
         AND d.REGION = p.REGION
         AND d.IS_ACTIVE = TRUE`,
      db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED',
    },
    {
      sql: `CREATE OR REPLACE VIEW SYNTHETIC_DATASETS.UNIFIED.V_FACT_FREIGHT_OFFERS_CURRENT
        COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}'
        AS
        SELECT f.*
        FROM SYNTHETIC_DATASETS.UNIFIED.FACT_FREIGHT_OFFERS f
        JOIN FLEET_INTELLIGENCE.CORE.DIM_DATASETS d
          ON d.DATASET_ID = f.JOB_ID
         AND d.REGION = f.REGION
         AND d.VEHICLE_TYPE = f.VEHICLE_TYPE
         AND d.IS_ACTIVE = TRUE`,
      db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED',
    },
    {
      sql: `CREATE OR REPLACE VIEW SYNTHETIC_DATASETS.UNIFIED.V_DIM_PARTNERS_CURRENT
        COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}'
        AS
        SELECT p.*
        FROM SYNTHETIC_DATASETS.UNIFIED.DIM_PARTNERS p
        JOIN FLEET_INTELLIGENCE.CORE.DIM_DATASETS d
          ON d.DATASET_ID = p.JOB_ID
         AND d.REGION = p.REGION
         AND d.VEHICLE_TYPE = p.VEHICLE_TYPE
         AND d.IS_ACTIVE = TRUE`,
      db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED',
    },
    {
      sql: `CREATE OR REPLACE VIEW SYNTHETIC_DATASETS.UNIFIED.V_FACT_PARTNER_HISTORY_CURRENT
        COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}'
        AS
        SELECT h.*
        FROM SYNTHETIC_DATASETS.UNIFIED.FACT_PARTNER_HISTORY h
        JOIN FLEET_INTELLIGENCE.CORE.DIM_DATASETS d
          ON d.DATASET_ID = h.JOB_ID
         AND d.REGION = h.REGION
         AND d.VEHICLE_TYPE = h.VEHICLE_TYPE
         AND d.IS_ACTIVE = TRUE`,
      db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED',
    },
    {
      sql: `CREATE OR REPLACE VIEW SYNTHETIC_DATASETS.UNIFIED.V_FACT_TRIPS_CURRENT
        COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}'
        AS
        SELECT t.*
        FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS t
        JOIN FLEET_INTELLIGENCE.CORE.DIM_DATASETS d
          ON d.DATASET_ID = t.JOB_ID
         AND d.REGION = t.REGION
         AND d.VEHICLE_TYPE = t.VEHICLE_TYPE
         AND d.IS_ACTIVE = TRUE`,
      db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED',
    },
    {
      sql: `CREATE OR REPLACE VIEW SYNTHETIC_DATASETS.UNIFIED.V_FACT_VEHICLE_TELEMETRY_CURRENT
        COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}'
        AS
        SELECT t.*
        FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY t
        JOIN FLEET_INTELLIGENCE.CORE.DIM_DATASETS d
          ON d.DATASET_ID = t.JOB_ID
         AND d.REGION = t.REGION
         AND d.VEHICLE_TYPE = t.VEHICLE_TYPE
         AND d.IS_ACTIVE = TRUE`,
      db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED',
    },
    {
      sql: `CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.MARKETPLACE.VW_OFFERS
        COMMENT = ${TRACK_FX}
        AS
        SELECT
          f.OFFER_ID,
          f.SOURCE,
          f.PARTNER_ID,
          COALESCE(p.NAME, 'Pickup')              AS PICKUP_CITY,
          f.PICKUP_LON, f.PICKUP_LAT, f.PICKUP_GEOM,
          COALESCE(d.NAME, 'Dropoff')             AS DROPOFF_CITY,
          f.DROPOFF_LON, f.DROPOFF_LAT, f.DROPOFF_GEOM,
          f.PICKUP_FROM_TS, f.PICKUP_TO_TS,
          f.WEIGHT_KG, f.PRODUCT, f.PRICE_USD, f.HAZMAT,
          f.LISTING_TEXT, f.POSTED_AT,
          f.EQUIPMENT, f.ADR_CLASS, f.LDM,
          f.DISTANCE_KM, f.PRICE_PER_KM_USD,
          COALESCE(f.STATUS, 'OPEN')              AS STATUS,
          DATEDIFF('minute', f.POSTED_AT, CURRENT_TIMESTAMP()) AS POSTED_AGE_MIN
        FROM SYNTHETIC_DATASETS.UNIFIED.V_FACT_FREIGHT_OFFERS_CURRENT f
        LEFT JOIN SYNTHETIC_DATASETS.UNIFIED.V_DIM_POIS_CURRENT p ON p.LOCATION_ID = f.PICKUP_POI_ID
        LEFT JOIN SYNTHETIC_DATASETS.UNIFIED.V_DIM_POIS_CURRENT d ON d.LOCATION_ID = f.DROPOFF_POI_ID
        WHERE f.REGION = (SELECT REGION FROM FLEET_INTELLIGENCE.MARKETPLACE.CONFIG LIMIT 1)
          AND f.VEHICLE_TYPE = (SELECT VEHICLE_TYPE FROM FLEET_INTELLIGENCE.MARKETPLACE.CONFIG LIMIT 1)`,
      db: 'FLEET_INTELLIGENCE', schema: 'MARKETPLACE',
    },
    {
      sql: `CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.MARKETPLACE.VW_PARTNERS
        COMMENT = ${TRACK_FX}
        AS
        SELECT PARTNER_ID, NAME, COUNTRY,
               CREDIT_SCORE, PAYMENT_DAYS_AVG, KYC_STATUS,
               BLACKLIST_FLAG, FOUNDED_YEAR,
               CASE
                 WHEN BLACKLIST_FLAG THEN 'RED'
                 WHEN CREDIT_SCORE < 40 OR KYC_STATUS = 'REJECTED' THEN 'RED'
                 WHEN CREDIT_SCORE < 70 OR KYC_STATUS = 'PENDING' THEN 'YELLOW'
                 ELSE 'GREEN'
               END AS TRUST_BADGE
        FROM SYNTHETIC_DATASETS.UNIFIED.V_DIM_PARTNERS_CURRENT
        WHERE REGION = (SELECT REGION FROM FLEET_INTELLIGENCE.MARKETPLACE.CONFIG LIMIT 1)
          AND VEHICLE_TYPE = (SELECT VEHICLE_TYPE FROM FLEET_INTELLIGENCE.MARKETPLACE.CONFIG LIMIT 1)`,
      db: 'FLEET_INTELLIGENCE', schema: 'MARKETPLACE',
    },
    {
      sql: `CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.MARKETPLACE.VW_PARTNER_HISTORY
        COMMENT = ${TRACK_FX}
        AS
        SELECT PARTNER_ID, ORIGIN_COUNTRY, DEST_COUNTRY,
               EQUIPMENT, SHIPPED_AT, EUR_PER_KM, OUTCOME
        FROM SYNTHETIC_DATASETS.UNIFIED.V_FACT_PARTNER_HISTORY_CURRENT
        WHERE REGION = (SELECT REGION FROM FLEET_INTELLIGENCE.MARKETPLACE.CONFIG LIMIT 1)
          AND VEHICLE_TYPE = (SELECT VEHICLE_TYPE FROM FLEET_INTELLIGENCE.MARKETPLACE.CONFIG LIMIT 1)`,
      db: 'FLEET_INTELLIGENCE', schema: 'MARKETPLACE',
    },
    {
      sql: `CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.MARKETPLACE.VW_LANE_HISTORY
        COMMENT = ${TRACK_FX}
        AS
        SELECT
          PARTNER_ID, ORIGIN_COUNTRY, DEST_COUNTRY, EQUIPMENT,
          COUNT(*)                                                AS SHIPMENTS,
          SUM(CASE WHEN OUTCOME = 'DELIVERED' THEN 1 ELSE 0 END)  AS ON_TIME,
          SUM(CASE WHEN OUTCOME = 'LATE' THEN 1 ELSE 0 END)       AS LATE_CNT,
          SUM(CASE WHEN OUTCOME = 'DAMAGED' THEN 1 ELSE 0 END)    AS DAMAGED_CNT,
          ROUND(AVG(EUR_PER_KM), 2)                               AS AVG_EUR_PER_KM
        FROM FLEET_INTELLIGENCE.MARKETPLACE.VW_PARTNER_HISTORY
        GROUP BY 1,2,3,4`,
      db: 'FLEET_INTELLIGENCE', schema: 'MARKETPLACE',
    },
    {
      sql: `CREATE OR REPLACE DYNAMIC TABLE FLEET_INTELLIGENCE.MARKETPLACE.RATE_INDEX
        TARGET_LAG = '15 minutes'
        WAREHOUSE = ROUTING_ANALYTICS
        COMMENT = ${TRACK_FX}
        AS
        WITH base AS (
          SELECT
            EQUIPMENT,
            DATE_TRUNC('week', POSTED_AT)        AS WEEK,
            PRICE_PER_KM_USD
          FROM SYNTHETIC_DATASETS.UNIFIED.FACT_FREIGHT_OFFERS
          WHERE PRICE_PER_KM_USD IS NOT NULL
            AND EQUIPMENT IS NOT NULL
        )
        SELECT
          EQUIPMENT, WEEK,
          COUNT(*)                                              AS SAMPLES,
          ROUND(APPROX_PERCENTILE(PRICE_PER_KM_USD, 0.25), 2)   AS P25_USD_PER_KM,
          ROUND(APPROX_PERCENTILE(PRICE_PER_KM_USD, 0.50), 2)   AS P50_USD_PER_KM,
          ROUND(APPROX_PERCENTILE(PRICE_PER_KM_USD, 0.75), 2)   AS P75_USD_PER_KM
        FROM base
        GROUP BY 1, 2`,
      db: 'FLEET_INTELLIGENCE', schema: 'MARKETPLACE',
    },
    {
      sql: `CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.MARKETPLACE.VW_OFFER_ENRICHED
        COMMENT = ${TRACK_FX}
        AS
        SELECT
          o.*,
          p.NAME             AS PARTNER_NAME,
          p.COUNTRY          AS PARTNER_COUNTRY,
          p.CREDIT_SCORE     AS PARTNER_CREDIT_SCORE,
          p.PAYMENT_DAYS_AVG AS PARTNER_PAYMENT_DAYS,
          p.KYC_STATUS       AS PARTNER_KYC,
          p.BLACKLIST_FLAG   AS PARTNER_BLACKLIST,
          p.TRUST_BADGE      AS TRUST_BADGE,
          ri.P25_USD_PER_KM  AS MARKET_P25,
          ri.P50_USD_PER_KM  AS MARKET_P50,
          ri.P75_USD_PER_KM  AS MARKET_P75,
          CASE
            WHEN ri.P50_USD_PER_KM IS NULL OR o.PRICE_PER_KM_USD IS NULL THEN NULL
            ELSE ROUND((o.PRICE_PER_KM_USD - ri.P50_USD_PER_KM) / ri.P50_USD_PER_KM * 100, 1)
          END AS PRICE_DELTA_PCT,
          CASE
            WHEN ri.P50_USD_PER_KM IS NULL OR o.PRICE_PER_KM_USD IS NULL THEN 'UNKNOWN'
            WHEN ABS((o.PRICE_PER_KM_USD - ri.P50_USD_PER_KM) / ri.P50_USD_PER_KM) <= 0.05 THEN 'AT_MARKET'
            WHEN o.PRICE_PER_KM_USD < ri.P50_USD_PER_KM THEN 'BELOW_MARKET'
            ELSE 'ABOVE_MARKET'
          END AS MARKET_BADGE
        FROM FLEET_INTELLIGENCE.MARKETPLACE.VW_OFFERS o
        LEFT JOIN FLEET_INTELLIGENCE.MARKETPLACE.VW_PARTNERS p ON p.PARTNER_ID = o.PARTNER_ID
        LEFT JOIN FLEET_INTELLIGENCE.MARKETPLACE.RATE_INDEX ri
          ON ri.EQUIPMENT = o.EQUIPMENT
         AND ri.WEEK = DATE_TRUNC('week', o.POSTED_AT)`,
      db: 'FLEET_INTELLIGENCE', schema: 'MARKETPLACE',
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
