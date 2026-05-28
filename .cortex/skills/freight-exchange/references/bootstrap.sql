-- ============================================================================
-- Freight Exchange (Phase A/B) — Bootstrap (projection views over UNIFIED)
-- ============================================================================
-- Mirrors the DDL embedded in
--   services/ors_control_app/server/lib/init.ts
-- so a greenfield install or audit run can recreate every object without
-- bouncing the SPCS service. The init.ts copy is the source of truth — keep
-- this file in sync when changing column lists.
--
-- Creates:
--   * MARKETPLACE.CONFIG              - single-row (VEHICLE_TYPE, REGION) used
--                                       to filter the projection views to the
--                                       active Data Studio preset. Auto-synced
--                                       by syncRegionRegistryAndConfig +
--                                       /api/regions/active + /api/datasets.
--   * MARKETPLACE.VW_OFFERS           - FACT_FREIGHT_OFFERS filtered by
--                                       CONFIG, joined to DIM_POIS for city
--                                       names, with POSTED_AGE_MIN derived.
--   * MARKETPLACE.VW_PARTNERS         - DIM_PARTNERS filtered by CONFIG,
--                                       with TRUST_BADGE (GREEN/YELLOW/RED).
--   * MARKETPLACE.VW_PARTNER_HISTORY  - FACT_PARTNER_HISTORY filtered by
--                                       CONFIG.
--   * MARKETPLACE.VW_LANE_HISTORY     - rolled-up partner history per lane.
--   * MARKETPLACE.RATE_INDEX          - DYNAMIC TABLE (15-min lag) of weekly
--                                       p25/p50/p75 USD/km by equipment.
--   * MARKETPLACE.VW_OFFER_ENRICHED   - VW_OFFERS LEFT JOIN VW_PARTNERS
--                                       LEFT JOIN RATE_INDEX. The React page
--                                       reads only this view.
-- ============================================================================

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-freight-exchange","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

USE WAREHOUSE ROUTING_ANALYTICS;

CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.MARKETPLACE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-freight-exchange","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

USE SCHEMA FLEET_INTELLIGENCE.MARKETPLACE;

-- ----------------------------------------------------------------------------
-- 1. CONFIG (active preset filter)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS CONFIG (
  VEHICLE_TYPE VARCHAR NOT NULL,
  REGION       VARCHAR NOT NULL
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-freight-exchange","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

MERGE INTO CONFIG tgt
USING (SELECT 'hgv' AS VEHICLE_TYPE, 'SanFrancisco' AS REGION) src
  ON TRUE
WHEN NOT MATCHED THEN INSERT (VEHICLE_TYPE, REGION) VALUES (src.VEHICLE_TYPE, src.REGION);

-- ----------------------------------------------------------------------------
-- 2. Idempotent ALTERs on FACT_FREIGHT_OFFERS for older deployments
-- ----------------------------------------------------------------------------
ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.FACT_FREIGHT_OFFERS ADD COLUMN IF NOT EXISTS EQUIPMENT VARCHAR(20);
ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.FACT_FREIGHT_OFFERS ADD COLUMN IF NOT EXISTS ADR_CLASS VARCHAR(8);
ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.FACT_FREIGHT_OFFERS ADD COLUMN IF NOT EXISTS LDM FLOAT;
ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.FACT_FREIGHT_OFFERS ADD COLUMN IF NOT EXISTS DISTANCE_KM FLOAT;
ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.FACT_FREIGHT_OFFERS ADD COLUMN IF NOT EXISTS PRICE_PER_KM_USD FLOAT;
ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.FACT_FREIGHT_OFFERS ADD COLUMN IF NOT EXISTS PARTNER_ID VARCHAR;
ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.FACT_FREIGHT_OFFERS ADD COLUMN IF NOT EXISTS STATUS VARCHAR(20);

-- ----------------------------------------------------------------------------
-- 3. DIM_PARTNERS + FACT_PARTNER_HISTORY (created by Data Studio engine, but
--    we materialize the DDL here for fresh installs / audit reruns)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS SYNTHETIC_DATASETS.UNIFIED.DIM_PARTNERS (
  PARTNER_ID VARCHAR, REGION VARCHAR(100), VEHICLE_TYPE VARCHAR(20),
  NAME VARCHAR, COUNTRY VARCHAR(4),
  CREDIT_SCORE NUMBER, PAYMENT_DAYS_AVG NUMBER, KYC_STATUS VARCHAR(20),
  BLACKLIST_FLAG BOOLEAN, FOUNDED_YEAR NUMBER,
  JOB_ID VARCHAR
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE TABLE IF NOT EXISTS SYNTHETIC_DATASETS.UNIFIED.FACT_PARTNER_HISTORY (
  PARTNER_ID VARCHAR, REGION VARCHAR(100), VEHICLE_TYPE VARCHAR(20),
  ORIGIN_COUNTRY VARCHAR(4), DEST_COUNTRY VARCHAR(4),
  EQUIPMENT VARCHAR(20),
  SHIPPED_AT TIMESTAMP_NTZ, EUR_PER_KM FLOAT,
  OUTCOME VARCHAR(20),
  JOB_ID VARCHAR
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- ----------------------------------------------------------------------------
-- 4. Projection views
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW VW_OFFERS
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-freight-exchange","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT
  f.OFFER_ID,
  f.SOURCE,
  f.PARTNER_ID,
  COALESCE(p.NAME, 'Pickup')  AS PICKUP_CITY,
  f.PICKUP_LON, f.PICKUP_LAT, f.PICKUP_GEOM,
  COALESCE(d.NAME, 'Dropoff') AS DROPOFF_CITY,
  f.DROPOFF_LON, f.DROPOFF_LAT, f.DROPOFF_GEOM,
  f.PICKUP_FROM_TS, f.PICKUP_TO_TS,
  f.WEIGHT_KG, f.PRODUCT, f.PRICE_USD, f.HAZMAT,
  f.LISTING_TEXT, f.POSTED_AT,
  f.EQUIPMENT, f.ADR_CLASS, f.LDM,
  f.DISTANCE_KM, f.PRICE_PER_KM_USD,
  COALESCE(f.STATUS, 'OPEN')  AS STATUS,
  DATEDIFF('minute', f.POSTED_AT, CURRENT_TIMESTAMP()) AS POSTED_AGE_MIN
FROM SYNTHETIC_DATASETS.UNIFIED.FACT_FREIGHT_OFFERS f
LEFT JOIN SYNTHETIC_DATASETS.UNIFIED.DIM_POIS p ON p.LOCATION_ID = f.PICKUP_POI_ID
LEFT JOIN SYNTHETIC_DATASETS.UNIFIED.DIM_POIS d ON d.LOCATION_ID = f.DROPOFF_POI_ID
WHERE f.REGION = (SELECT REGION FROM CONFIG LIMIT 1)
  AND f.VEHICLE_TYPE = (SELECT VEHICLE_TYPE FROM CONFIG LIMIT 1);

CREATE OR REPLACE VIEW VW_PARTNERS
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-freight-exchange","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
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
FROM SYNTHETIC_DATASETS.UNIFIED.DIM_PARTNERS
WHERE REGION = (SELECT REGION FROM CONFIG LIMIT 1)
  AND VEHICLE_TYPE = (SELECT VEHICLE_TYPE FROM CONFIG LIMIT 1);

CREATE OR REPLACE VIEW VW_PARTNER_HISTORY
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-freight-exchange","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT PARTNER_ID, ORIGIN_COUNTRY, DEST_COUNTRY,
       EQUIPMENT, SHIPPED_AT, EUR_PER_KM, OUTCOME
FROM SYNTHETIC_DATASETS.UNIFIED.FACT_PARTNER_HISTORY
WHERE REGION = (SELECT REGION FROM CONFIG LIMIT 1)
  AND VEHICLE_TYPE = (SELECT VEHICLE_TYPE FROM CONFIG LIMIT 1);

CREATE OR REPLACE VIEW VW_LANE_HISTORY
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-freight-exchange","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT
  PARTNER_ID, ORIGIN_COUNTRY, DEST_COUNTRY, EQUIPMENT,
  COUNT(*)                                                AS SHIPMENTS,
  SUM(CASE WHEN OUTCOME = 'DELIVERED' THEN 1 ELSE 0 END)  AS ON_TIME,
  SUM(CASE WHEN OUTCOME = 'LATE' THEN 1 ELSE 0 END)       AS LATE_CNT,
  SUM(CASE WHEN OUTCOME = 'DAMAGED' THEN 1 ELSE 0 END)    AS DAMAGED_CNT,
  ROUND(AVG(EUR_PER_KM), 2)                               AS AVG_EUR_PER_KM
FROM VW_PARTNER_HISTORY
GROUP BY 1,2,3,4;

-- ----------------------------------------------------------------------------
-- 5. RATE_INDEX (Dynamic Table, weekly p25/p50/p75 USD/km by equipment)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE DYNAMIC TABLE RATE_INDEX
TARGET_LAG = '15 minutes'
WAREHOUSE = ROUTING_ANALYTICS
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-freight-exchange","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
WITH base AS (
  SELECT
    EQUIPMENT,
    DATE_TRUNC('week', POSTED_AT) AS WEEK,
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
GROUP BY 1, 2;

-- ----------------------------------------------------------------------------
-- 5b. FACT_OFFER_ROUTES (ORS DIRECTIONS cache; required by VW_OFFER_ENRICHED)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FACT_OFFER_ROUTES (
  OFFER_ID     VARCHAR    NOT NULL,
  ROAD_KM      FLOAT,
  ROAD_MIN     FLOAT,
  GEOMETRY     VARCHAR,
  PROFILE      VARCHAR(20),
  COMPUTED_AT  TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
  CONSTRAINT PK_FACT_OFFER_ROUTES PRIMARY KEY (OFFER_ID)
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-freight-exchange","version":{"major":1,"minor":1},"attributes":{"is_quickstart":1,"source":"sql","phase":"E1"}}';

-- ----------------------------------------------------------------------------
-- 6. VW_OFFER_ENRICHED (denormalized view the React page reads)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW VW_OFFER_ENRICHED
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-freight-exchange","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
WITH e AS (
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
  FROM VW_OFFERS o
  LEFT JOIN VW_PARTNERS p ON p.PARTNER_ID = o.PARTNER_ID
  LEFT JOIN RATE_INDEX ri
    ON ri.EQUIPMENT = o.EQUIPMENT
   AND ri.WEEK = DATE_TRUNC('week', o.POSTED_AT)
)
SELECT
  e.*,
  fr.ROAD_KM,
  fr.ROAD_MIN,
  fr.GEOMETRY     AS ROUTE_GEOMETRY,
  fr.PROFILE      AS ROUTE_PROFILE,
  fr.COMPUTED_AT  AS ROUTE_COMPUTED_AT,
  CASE WHEN fr.ROAD_KM IS NOT NULL AND e.PRICE_USD IS NOT NULL AND fr.ROAD_KM > 0
       THEN e.PRICE_USD / fr.ROAD_KM
       ELSE e.PRICE_PER_KM_USD
  END AS PRICE_PER_ROAD_KM_USD,
  CASE WHEN fr.ROAD_KM IS NULL THEN 'PENDING_ROUTE'
       WHEN fr.ROAD_KM > e.DISTANCE_KM * 1.6 THEN 'DETOUR_HEAVY'
       WHEN fr.ROAD_KM > e.DISTANCE_KM * 1.3 THEN 'DETOUR_MODERATE'
       ELSE 'DIRECT'
  END AS ROUTE_DETOUR_BADGE
FROM e
LEFT JOIN FACT_OFFER_ROUTES fr USING (OFFER_ID);
