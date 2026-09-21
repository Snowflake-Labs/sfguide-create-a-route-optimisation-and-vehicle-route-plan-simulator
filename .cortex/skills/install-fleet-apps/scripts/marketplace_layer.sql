-- =============================================================================
-- install-fleet-apps : MARKETPLACE source layer for SV_OFFERS (FLEET-owned)
-- =============================================================================
-- The minimal FLEET_INTELLIGENCE.MARKETPLACE objects that
-- FLEET_INTELLIGENCE.SEMANTIC.SV_OFFERS reads, transitively. Nothing more.
--
-- WHY THIS FILE EXISTS
--
-- SV_OFFERS is created at step 4.5 from semantic_views_marketplace.sql, but
-- these sources were authored ONLY by the admin app's boot init.ts, which does
-- not run until the container starts during step 7. Measured on a clean
-- install: SV_OFFERS was attempted at 13:11 and its sources appeared at 13:30.
-- It failed with "does not exist or not authorized" and the installer mapped
-- that to an expected fresh-install skip, so a pure ordering defect reported as
-- normal behaviour on every run, in an account where the data was present all
-- along (300 offers, 455 lane-history rows).
--
-- Deferring the CONSUMER instead of advancing the SOURCES does not work:
--   * deploy_fleet_admin_app.sh has no readiness wait (no SYSTEM$GET_SERVICE_-
--     STATUS, no sleep, no retry loop) and ALTER SERVICE ... RESUME is async,
--     so the script returns minutes before init.ts has run - a step placed
--     after it races the container boot.
--   * prune_agent_specs.py probes SHOW SEMANTIC VIEWS at step 6 and DELETES the
--     query_offers tool when SV_OFFERS is absent. Anything that creates the view
--     after step 6 leaves the agents permanently missing the tool.
-- So the sources must exist before step 4.5. That is this file.
--
-- ORDERING: run AFTER the packs step (4) and BEFORE the semantic step (4.5).
--   * needs FLEET_APP.CORE.REGION_LABEL, built by the packs
--   * needs SYNTHETIC_DATASETS.UNIFIED.V_{FACT_OFFERS,DIM_POIS,DIM_PARTNERS,
--     FACT_PARTNER_HISTORY}_CURRENT from scripts/projection_views.sql (step 2.5)
--   * needs MARKETPLACE.FACT_OFFER_ROUTES, created by the seed loader (step 2)
--
-- SCOPE: deliberately NOT the whole freight-exchange layer. VW_OFFER_DEADHEAD,
-- VW_LANE_DENSITY, V_FACT_OFFER_ROUTES_CURRENT, FACT_DEADHEAD_MATRIX and
-- DELIVERY_DRAFTS serve the freight-exchange PAGE, which is an excluded
-- industry-vertical surface here. They stay with init.ts and the
-- freight-exchange skill. The installer takes on only what its own semantic
-- view requires, so the agnostic scope is unchanged.
--
-- OWNERSHIP: init.ts remains the RUNTIME owner and recreates these on every
-- boot. Bodies here are kept byte-identical to it (modulo the COMMENT's
-- source":"sql" vs source":"app", which is the same convention
-- projection_views.sql already follows) so the app boot is a no-op rather than
-- a redefinition. scripts/check_marketplace_ddl_parity.py enforces that.
--
-- Idempotent (CREATE OR REPLACE throughout).
-- =============================================================================

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","module":"marketplace-layer"}}';

-- The seed loader (step 2) already creates this schema plus FACT_OFFER_ROUTES
-- and CONFIG. Kept here so this file can also be run standalone.
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.MARKETPLACE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"marketplace"}}';

-- Offers, resolved to POI names for pickup/dropoff. A NULL city is a genuinely
-- unresolved POI, not a placeholder.
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.MARKETPLACE.VW_OFFERS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT
  f.OFFER_ID,
  f.JOB_ID,
  f.SOURCE,
  f.PARTNER_ID,
  p.NAME                                  AS PICKUP_CITY,
  f.PICKUP_LON, f.PICKUP_LAT, f.PICKUP_GEOM,
  d.NAME                                  AS DROPOFF_CITY,
  f.DROPOFF_LON, f.DROPOFF_LAT, f.DROPOFF_GEOM,
  f.PICKUP_FROM_TS, f.PICKUP_TO_TS,
  f.WEIGHT_KG, f.PRODUCT, f.PRICE_USD, f.HAZMAT,
  f.LISTING_TEXT, f.POSTED_AT,
  f.VEHICLE_EQUIPMENT,
  f.DISTANCE_KM, f.PRICE_PER_KM_USD,
  COALESCE(f.STATUS, 'OPEN')              AS STATUS,
  f.REGION,
  FLEET_APP.CORE.REGION_LABEL(f.REGION)   AS REGION_LABEL,
  f.VEHICLE_TYPE,
  DATEDIFF('minute', f.POSTED_AT, CURRENT_TIMESTAMP()) AS POSTED_AGE_MIN
FROM SYNTHETIC_DATASETS.UNIFIED.V_FACT_OFFERS_CURRENT f
LEFT JOIN SYNTHETIC_DATASETS.UNIFIED.V_DIM_POIS_CURRENT p ON p.LOCATION_ID = f.PICKUP_POI_ID
LEFT JOIN SYNTHETIC_DATASETS.UNIFIED.V_DIM_POIS_CURRENT d ON d.LOCATION_ID = f.DROPOFF_POI_ID;

-- Carrier partners with a derived trust badge.
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.MARKETPLACE.VW_PARTNERS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT PARTNER_ID, NAME, COUNTRY,
       REGION,
       FLEET_APP.CORE.REGION_LABEL(REGION) AS REGION_LABEL,
       VEHICLE_TYPE,
       CREDIT_SCORE, PAYMENT_DAYS_AVG, KYC_STATUS,
       BLACKLIST_FLAG, FOUNDED_YEAR,
       CASE
         WHEN BLACKLIST_FLAG THEN 'RED'
         WHEN CREDIT_SCORE < 40 OR KYC_STATUS = 'REJECTED' THEN 'RED'
         WHEN CREDIT_SCORE < 70 OR KYC_STATUS = 'PENDING' THEN 'YELLOW'
         ELSE 'GREEN'
       END AS TRUST_BADGE
FROM SYNTHETIC_DATASETS.UNIFIED.V_DIM_PARTNERS_CURRENT;

-- Per-shipment partner outcomes. VW_LANE_HISTORY aggregates this.
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.MARKETPLACE.VW_PARTNER_HISTORY
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT PARTNER_ID, ORIGIN_COUNTRY, DEST_COUNTRY,
       REGION,
       FLEET_APP.CORE.REGION_LABEL(REGION) AS REGION_LABEL,
       VEHICLE_TYPE,
       VEHICLE_EQUIPMENT, SHIPPED_AT, COST_PER_KM, OUTCOME
FROM SYNTHETIC_DATASETS.UNIFIED.V_FACT_PARTNER_HISTORY_CURRENT;

-- SV_OFFERS source 2 of 2: partner reliability per lane.
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.MARKETPLACE.VW_LANE_HISTORY
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT
  PARTNER_ID, ORIGIN_COUNTRY, DEST_COUNTRY, VEHICLE_EQUIPMENT,
  COUNT(*)                                                AS SHIPMENTS,
  SUM(CASE WHEN OUTCOME = 'DELIVERED' THEN 1 ELSE 0 END)  AS ON_TIME,
  SUM(CASE WHEN OUTCOME = 'LATE' THEN 1 ELSE 0 END)       AS LATE_CNT,
  SUM(CASE WHEN OUTCOME = 'DAMAGED' THEN 1 ELSE 0 END)    AS DAMAGED_CNT,
  ROUND(AVG(COST_PER_KM), 2)                              AS AVG_COST_PER_KM
FROM FLEET_INTELLIGENCE.MARKETPLACE.VW_PARTNER_HISTORY
GROUP BY 1,2,3,4;

-- Weekly market-rate percentiles. Reads the PHYSICAL FACT_OFFERS, not the
-- dataset-scoped projection, so the benchmark spans every loaded dataset.
-- Hourly lag matches the repo's cost guardrail for dynamic tables.
CREATE OR REPLACE DYNAMIC TABLE FLEET_INTELLIGENCE.MARKETPLACE.RATE_INDEX
  TARGET_LAG = '1 hour'
  WAREHOUSE = ROUTING_ANALYTICS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
WITH base AS (
  SELECT
    VEHICLE_EQUIPMENT,
    DATE_TRUNC('week', POSTED_AT)        AS WEEK,
    PRICE_PER_KM_USD
  FROM SYNTHETIC_DATASETS.UNIFIED.FACT_OFFERS
  WHERE PRICE_PER_KM_USD IS NOT NULL
    AND VEHICLE_EQUIPMENT IS NOT NULL
)
SELECT
  VEHICLE_EQUIPMENT, WEEK,
  COUNT(*)                                              AS SAMPLES,
  ROUND(APPROX_PERCENTILE(PRICE_PER_KM_USD, 0.25), 2)   AS P25_USD_PER_KM,
  ROUND(APPROX_PERCENTILE(PRICE_PER_KM_USD, 0.50), 2)   AS P50_USD_PER_KM,
  ROUND(APPROX_PERCENTILE(PRICE_PER_KM_USD, 0.75), 2)   AS P75_USD_PER_KM
FROM base
GROUP BY 1, 2;

-- SV_OFFERS source 1 of 2: offers joined to partner trust, the market-rate
-- benchmark, and any ORS-routed road distance already computed.
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.MARKETPLACE.VW_OFFER_ENRICHED
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
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
  FROM FLEET_INTELLIGENCE.MARKETPLACE.VW_OFFERS o
  LEFT JOIN FLEET_INTELLIGENCE.MARKETPLACE.VW_PARTNERS p ON p.PARTNER_ID = o.PARTNER_ID
  LEFT JOIN FLEET_INTELLIGENCE.MARKETPLACE.RATE_INDEX ri
    ON ri.VEHICLE_EQUIPMENT = o.VEHICLE_EQUIPMENT
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
LEFT JOIN FLEET_INTELLIGENCE.MARKETPLACE.FACT_OFFER_ROUTES fr
  ON fr.OFFER_ID = e.OFFER_ID AND fr.JOB_ID = e.JOB_ID;
