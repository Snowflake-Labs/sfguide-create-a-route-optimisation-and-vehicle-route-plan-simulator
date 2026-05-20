-- ============================================================================
-- Backload Matching Engine - Bootstrap (projection views over UNIFIED)
-- ============================================================================
-- Replaces the obsolete load-demo-data.sql + tools/gen_demo_data.py codegen.
--
-- This script creates:
--   * BACKLOAD_MATCHING.CONFIG       - single-row (VEHICLE_TYPE, REGION) used to
--                                       filter the projection views to the
--                                       active Data Studio preset. Auto-updated
--                                       by Data Studio's syncRegionRegistryAndConfig
--                                       and by /api/regions/active.
--   * BACKLOAD_MATCHING.VW_TRAILERS  - DIM_FLEET joined to last drop-off from
--                                       FACT_TRIPS, filtered by CONFIG.
--   * BACKLOAD_MATCHING.VW_INTERNAL_VOLUMES
--                                    - 120 most-recent FACT_TRIPS as "waiting
--                                       internal volumes", filtered by CONFIG.
--   * BACKLOAD_MATCHING.VW_EXTERNAL_OFFERS
--                                    - FACT_FREIGHT_OFFERS filtered by CONFIG.
--   * BACKLOAD_MATCHING.PROPOSAL_DECISIONS - real table, write-back target.
-- ============================================================================

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-backload-matching","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

USE WAREHOUSE ROUTING_ANALYTICS;

CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-backload-matching","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

USE SCHEMA FLEET_INTELLIGENCE.BACKLOAD_MATCHING;

-- ----------------------------------------------------------------------------
-- 1. CONFIG (active preset filter)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS CONFIG (
  VEHICLE_TYPE VARCHAR NOT NULL,
  REGION       VARCHAR NOT NULL
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-backload-matching","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

MERGE INTO CONFIG tgt
USING (
  -- Data-driven default: pick the (region, vehicle_type) tuple with the most
  -- synthetic rows so the views populate against whatever preset is loaded.
  -- No hardcoded city/vehicle. Rank by FACT_TRIPS first, fall back to DIM_FLEET.
  --
  -- Update semantics:
  --   * WHEN NOT MATCHED -> seed CONFIG (greenfield install).
  --   * WHEN MATCHED AND the existing tuple has 0 matching FACT_TRIPS rows ->
  --     reconcile (heals stale installs where the old hardcoded `hgv`/`California`
  --     default was previously seeded, or where Data Studio sync hasn't caught up).
  --   * Otherwise leave CONFIG alone, so user picks via /api/regions/active and
  --     syncRegionRegistryAndConfig are never overwritten.
  WITH counts AS (
    SELECT t.VEHICLE_TYPE, t.REGION, COUNT(*) AS n
    FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS t
    WHERE t.VEHICLE_TYPE IS NOT NULL AND t.REGION IS NOT NULL
    GROUP BY 1, 2
    UNION ALL
    SELECT f.VEHICLE_TYPE, f.REGION, COUNT(*) AS n
    FROM SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET f
    WHERE f.VEHICLE_TYPE IS NOT NULL AND f.REGION IS NOT NULL
    GROUP BY 1, 2
  ),
  ranked AS (
    SELECT VEHICLE_TYPE, REGION, SUM(n) AS total_rows
    FROM counts
    GROUP BY 1, 2
    QUALIFY ROW_NUMBER() OVER (ORDER BY SUM(n) DESC) = 1
  )
  SELECT VEHICLE_TYPE, REGION FROM ranked
) src
ON TRUE
WHEN MATCHED AND NOT EXISTS (
  SELECT 1 FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS ft
  WHERE ft.VEHICLE_TYPE = tgt.VEHICLE_TYPE AND ft.REGION = tgt.REGION
)
  THEN UPDATE SET tgt.VEHICLE_TYPE = src.VEHICLE_TYPE, tgt.REGION = src.REGION
WHEN NOT MATCHED THEN INSERT (VEHICLE_TYPE, REGION) VALUES (src.VEHICLE_TYPE, src.REGION);

-- ----------------------------------------------------------------------------
-- 2. PROPOSAL_DECISIONS (write-back; real table)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS PROPOSAL_DECISIONS (
  DECISION_ID VARCHAR DEFAULT UUID_STRING() PRIMARY KEY,
  TRAILER_ID  VARCHAR,
  OFFER_ID    VARCHAR,
  SOURCE      VARCHAR,
  SCORE       FLOAT,
  EMPTY_KM    FLOAT,
  DECIDED_BY  VARCHAR,
  DECIDED_AT  TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
  RATIONALE   VARCHAR
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-backload-matching","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- ----------------------------------------------------------------------------
-- 3. VW_TRAILERS - DIM_FLEET filtered by CONFIG, joined to last trip drop-off
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW VW_TRAILERS AS
WITH last_drop AS (
  SELECT VEHICLE_ID,
         MAX_BY(DESTINATION_LON, TRIP_END) AS DROPOFF_LON,
         MAX_BY(DESTINATION_LAT, TRIP_END) AS DROPOFF_LAT,
         MAX_BY(DESTINATION_POI_ID, TRIP_END) AS DROPOFF_POI_ID,
         MAX(TRIP_END) AS LAST_TRIP_END
  FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS
  WHERE REGION       = (SELECT REGION       FROM FLEET_INTELLIGENCE.BACKLOAD_MATCHING.CONFIG LIMIT 1)
    AND VEHICLE_TYPE = (SELECT VEHICLE_TYPE FROM FLEET_INTELLIGENCE.BACKLOAD_MATCHING.CONFIG LIMIT 1)
  GROUP BY VEHICLE_ID
),
home_anchor AS (
  SELECT AVG(LAT) AS HOME_LAT, AVG(LNG) AS HOME_LON
  FROM SYNTHETIC_DATASETS.UNIFIED.DIM_POIS
  WHERE REGION = (SELECT REGION FROM FLEET_INTELLIGENCE.BACKLOAD_MATCHING.CONFIG LIMIT 1)
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
WHERE f.REGION       = (SELECT REGION       FROM FLEET_INTELLIGENCE.BACKLOAD_MATCHING.CONFIG LIMIT 1)
  AND f.VEHICLE_TYPE = (SELECT VEHICLE_TYPE FROM FLEET_INTELLIGENCE.BACKLOAD_MATCHING.CONFIG LIMIT 1);

-- ----------------------------------------------------------------------------
-- 4. VW_INTERNAL_VOLUMES - recent FACT_TRIPS rebranded as "internal waiting loads"
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW VW_INTERNAL_VOLUMES AS
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
WHERE t.REGION       = (SELECT REGION       FROM FLEET_INTELLIGENCE.BACKLOAD_MATCHING.CONFIG LIMIT 1)
  AND t.VEHICLE_TYPE = (SELECT VEHICLE_TYPE FROM FLEET_INTELLIGENCE.BACKLOAD_MATCHING.CONFIG LIMIT 1)
QUALIFY ROW_NUMBER() OVER (ORDER BY t.TRIP_START DESC) <= 120;

-- ----------------------------------------------------------------------------
-- 4b. Ensure FACT_FREIGHT_OFFERS exists and is populated for the active region.
--     Inlined from references/backfill-freight-offers.sql so any preset (default
--     SanFrancisco included) gets offers without a separate manual step. Both
--     the CREATE TABLE and the INSERT are idempotent — the INSERT skips regions
--     that already have offers, so re-running this script is safe.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS SYNTHETIC_DATASETS.UNIFIED.FACT_FREIGHT_OFFERS (
  OFFER_ID         VARCHAR,
  REGION           VARCHAR(100),
  VEHICLE_TYPE     VARCHAR(20),
  SOURCE           VARCHAR(30),
  PICKUP_POI_ID    VARCHAR,
  PICKUP_LAT       FLOAT,
  PICKUP_LON       FLOAT,
  PICKUP_GEOM      GEOGRAPHY,
  DROPOFF_POI_ID   VARCHAR,
  DROPOFF_LAT      FLOAT,
  DROPOFF_LON      FLOAT,
  DROPOFF_GEOM     GEOGRAPHY,
  PICKUP_FROM_TS   TIMESTAMP_NTZ,
  PICKUP_TO_TS     TIMESTAMP_NTZ,
  WEIGHT_KG        NUMBER,
  PRODUCT          VARCHAR,
  PRICE_USD        NUMBER,
  HAZMAT           BOOLEAN,
  LISTING_TEXT     VARCHAR,
  POSTED_AT        TIMESTAMP_NTZ,
  JOB_ID           VARCHAR
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

INSERT INTO SYNTHETIC_DATASETS.UNIFIED.FACT_FREIGHT_OFFERS (
  OFFER_ID, REGION, VEHICLE_TYPE, SOURCE,
  PICKUP_POI_ID, PICKUP_LAT, PICKUP_LON, PICKUP_GEOM,
  DROPOFF_POI_ID, DROPOFF_LAT, DROPOFF_LON, DROPOFF_GEOM,
  PICKUP_FROM_TS, PICKUP_TO_TS, WEIGHT_KG, PRODUCT, PRICE_USD,
  HAZMAT, LISTING_TEXT, POSTED_AT, JOB_ID
)
WITH targets AS (
  SELECT DISTINCT
    p.REGION,
    COALESCE(t.VEHICLE_TYPE, 'hgv') AS VEHICLE_TYPE,
    p.JOB_ID
  FROM SYNTHETIC_DATASETS.UNIFIED.DIM_POIS p
  LEFT JOIN SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS t
    ON t.JOB_ID = p.JOB_ID
  WHERE p.REGION NOT IN (SELECT DISTINCT REGION FROM SYNTHETIC_DATASETS.UNIFIED.FACT_FREIGHT_OFFERS WHERE REGION IS NOT NULL)
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
  'OFF-' || LPAD(S::VARCHAR, 6, '0')                                                            AS OFFER_ID,
  REGION,
  VEHICLE_TYPE,
  CASE WHEN LOWER(REGION) LIKE '%germany%' OR LOWER(REGION) LIKE '%europe%'
       THEN DECODE(MOD(S, 4), 0,'TIMOCOM', 1,'WTRANSNET', 2,'TELEROUTE', 3,'B2P')
       ELSE DECODE(MOD(S, 4), 0,'DAT', 1,'TRUCKSTOP', 2,'CONVOY', 3,'UBER_FREIGHT')
  END                                                                                            AS SOURCE,
  P_ID                                                                                           AS PICKUP_POI_ID,
  P_LAT                                                                                          AS PICKUP_LAT,
  P_LON                                                                                          AS PICKUP_LON,
  P_GEOM                                                                                         AS PICKUP_GEOM,
  Q_ID                                                                                           AS DROPOFF_POI_ID,
  Q_LAT                                                                                          AS DROPOFF_LAT,
  Q_LON                                                                                          AS DROPOFF_LON,
  Q_GEOM                                                                                         AS DROPOFF_GEOM,
  DATEADD(MINUTE, MOD(S * 73,  1100) + 60,  CURRENT_TIMESTAMP())                                  AS PICKUP_FROM_TS,
  DATEADD(MINUTE, MOD(S * 73,  1100) + 360, CURRENT_TIMESTAMP())                                  AS PICKUP_TO_TS,
  (800 + MOD(ABS(HASH(P_ID || Q_ID)), 24000))::NUMBER                                             AS WEIGHT_KG,
  DECODE(MOD(S, 6), 0,'Pallets (general)', 1,'Steel coils', 2,'Plastic granulate',
                    3,'Beverages', 4,'Furniture', 5,'Bulk paper')                                 AS PRODUCT,
  (400 + MOD(ABS(HASH(Q_ID || P_ID)), 4000))::NUMBER                                              AS PRICE_USD,
  MOD(S, 13) = 0                                                                                  AS HAZMAT,
  CASE WHEN LOWER(REGION) LIKE '%germany%' OR LOWER(REGION) LIKE '%europe%'
       THEN DECODE(MOD(S, 4), 0,'TIMOCOM', 1,'WTRANSNET', 2,'TELEROUTE', 3,'B2P')
       ELSE DECODE(MOD(S, 4), 0,'DAT', 1,'TRUCKSTOP', 2,'CONVOY', 3,'UBER_FREIGHT')
  END || ' ' || P_NAME || ' -> ' || Q_NAME                                                        AS LISTING_TEXT,
  CURRENT_TIMESTAMP()                                                                             AS POSTED_AT,
  JOB_ID
FROM pairs;

-- ----------------------------------------------------------------------------
-- 5. VW_EXTERNAL_OFFERS - FACT_FREIGHT_OFFERS filtered by CONFIG
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW VW_EXTERNAL_OFFERS AS
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
  f.PRICE_USD                              AS PRICE_EUR,  -- back-compat alias for the React component
  f.HAZMAT,
  f.LISTING_TEXT
FROM SYNTHETIC_DATASETS.UNIFIED.FACT_FREIGHT_OFFERS f
LEFT JOIN SYNTHETIC_DATASETS.UNIFIED.DIM_POIS p ON p.LOCATION_ID = f.PICKUP_POI_ID
LEFT JOIN SYNTHETIC_DATASETS.UNIFIED.DIM_POIS d ON d.LOCATION_ID = f.DROPOFF_POI_ID
WHERE f.REGION = (SELECT REGION FROM FLEET_INTELLIGENCE.BACKLOAD_MATCHING.CONFIG LIMIT 1);

-- ----------------------------------------------------------------------------
-- 6. Sanity + active-preset notice
-- ----------------------------------------------------------------------------
-- The first result-set is the per-object row count. The second result-set is a
-- single-row "STATUS" notice that surfaces when the active preset produces an
-- empty trailer or internal-volume projection (friction-log F2: greenfield SF
-- /ebike installs return 0 trailers because the bootstrap CONFIG resolves to
-- whatever the highest-row preset is, even if it has no DIM_FLEET rows). The
-- notice tells the operator how to switch presets so the demo populates.
SELECT 'CONFIG'              AS object, COUNT(*) AS n FROM CONFIG
UNION ALL SELECT 'VW_TRAILERS',         COUNT(*) FROM VW_TRAILERS
UNION ALL SELECT 'VW_INTERNAL_VOLUMES', COUNT(*) FROM VW_INTERNAL_VOLUMES
UNION ALL SELECT 'VW_EXTERNAL_OFFERS',  COUNT(*) FROM VW_EXTERNAL_OFFERS
ORDER BY 1;

WITH cfg AS (
  SELECT VEHICLE_TYPE, REGION FROM CONFIG LIMIT 1
), counts AS (
  SELECT
    (SELECT COUNT(*) FROM VW_TRAILERS)         AS trailers,
    (SELECT COUNT(*) FROM VW_INTERNAL_VOLUMES) AS internal_volumes,
    (SELECT COUNT(*) FROM VW_EXTERNAL_OFFERS)  AS external_offers
)
SELECT
  CASE
    WHEN c.trailers = 0 OR c.internal_volumes = 0
      THEN 'WARNING: backload-matching trailer/internal-volume views are EMPTY '
        || 'for the active preset (VEHICLE_TYPE=' || cfg.VEHICLE_TYPE
        || ', REGION=' || cfg.REGION || '). The demo expects HGV trips '
        || '(typically REGION=Germany, VEHICLE_TYPE=hgv). Either: (a) generate '
        || 'an HGV preset via Data Studio in the ORS Control App; or (b) run '
        || 'POST /api/regions/active to switch the active region. The page will '
        || 'render an empty state until trailer rows appear.'
    ELSE 'OK: backload-matching populated for VEHICLE_TYPE=' || cfg.VEHICLE_TYPE
        || ', REGION=' || cfg.REGION
        || ' (trailers=' || c.trailers
        || ', internal=' || c.internal_volumes
        || ', external=' || c.external_offers || ')'
  END AS STATUS
FROM cfg, counts c;
