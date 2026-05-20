-- ============================================================================
-- Backload Matching - Backfill FACT_FREIGHT_OFFERS for existing presets
-- ============================================================================
-- One-shot script to populate SYNTHETIC_DATASETS.UNIFIED.FACT_FREIGHT_OFFERS
-- for any preset (region) that already has DIM_POIS rows but no offers.
--
-- New presets generated AFTER deploying the v1.0.199 control app will get
-- offers automatically from server/studio/engine.generateFreightOffers; this
-- file is only needed once, on existing accounts where Data Studio jobs
-- already ran without the new step.
--
-- Idempotent: skips regions that already have rows in FACT_FREIGHT_OFFERS.
-- ============================================================================

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-backload-matching","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

USE WAREHOUSE ROUTING_ANALYTICS;

-- Make sure the table exists (no-op if already created by control app v1.0.199+)
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

-- Backfill: 300 offers per (region, vehicle_type, job_id) combination missing them.
INSERT INTO SYNTHETIC_DATASETS.UNIFIED.FACT_FREIGHT_OFFERS (
  OFFER_ID, REGION, VEHICLE_TYPE, SOURCE,
  PICKUP_POI_ID, PICKUP_LAT, PICKUP_LON, PICKUP_GEOM,
  DROPOFF_POI_ID, DROPOFF_LAT, DROPOFF_LON, DROPOFF_GEOM,
  PICKUP_FROM_TS, PICKUP_TO_TS, WEIGHT_KG, PRODUCT, PRICE_USD,
  HAZMAT, LISTING_TEXT, POSTED_AT, JOB_ID
)
WITH targets AS (
  -- DIM_POIS does not carry VEHICLE_TYPE; pull it from FACT_TRIPS for the same JOB_ID.
  -- Fallback to first vehicle_type row if no trip yet (e.g. POI-only preset).
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

SELECT REGION, COUNT(*) AS N_OFFERS
FROM SYNTHETIC_DATASETS.UNIFIED.FACT_FREIGHT_OFFERS
GROUP BY 1 ORDER BY 1;
