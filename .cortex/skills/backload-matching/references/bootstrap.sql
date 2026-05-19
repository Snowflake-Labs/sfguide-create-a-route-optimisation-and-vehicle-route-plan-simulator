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
USING (SELECT 'hgv' AS VEHICLE_TYPE, 'California' AS REGION) src
ON TRUE
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
-- 6. Sanity
-- ----------------------------------------------------------------------------
SELECT 'CONFIG'              AS object, COUNT(*) AS n FROM CONFIG
UNION ALL SELECT 'VW_TRAILERS',         COUNT(*) FROM VW_TRAILERS
UNION ALL SELECT 'VW_INTERNAL_VOLUMES', COUNT(*) FROM VW_INTERNAL_VOLUMES
UNION ALL SELECT 'VW_EXTERNAL_OFFERS',  COUNT(*) FROM VW_EXTERNAL_OFFERS
ORDER BY 1;
