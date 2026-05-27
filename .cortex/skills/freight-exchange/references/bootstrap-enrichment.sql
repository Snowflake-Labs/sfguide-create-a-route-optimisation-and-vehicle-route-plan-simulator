-- =====================================================================
-- Freight Exchange Phase E1+ Enrichment Bootstrap
-- =====================================================================
-- Adds ORS road-routing + VROOM optimisation enrichment objects on top
-- of the existing Phase A/B Freight Exchange schema.
--
-- Pre-reqs:
--   - build-routing-solution deployed (OPENROUTESERVICE_APP database)
--   - freight-exchange Phase A/B bootstrap.sql already run
--   - backload-matching deployed (provides VW_TRAILERS, PROPOSAL_DECISIONS)
--
-- Idempotent: safe to re-run.
-- =====================================================================

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-freight-exchange","version":{"major":1,"minor":1},"attributes":{"is_quickstart":1,"source":"sql","phase":"enrichment"}}';

-- =====================================================================
-- Schema migration: PROPOSAL_DECISIONS
-- =====================================================================
-- Adds discriminator columns so Freight Exchange decisions can share
-- the audit table that backload-matching writes to.

ALTER TABLE FLEET_INTELLIGENCE.BACKLOAD_MATCHING.PROPOSAL_DECISIONS
  ADD COLUMN IF NOT EXISTS SOURCE_PAGE VARCHAR(40)
    COMMENT 'BACKLOAD_MATCHING | FREIGHT_EXCHANGE — origin page that recorded the decision';
ALTER TABLE FLEET_INTELLIGENCE.BACKLOAD_MATCHING.PROPOSAL_DECISIONS
  ADD COLUMN IF NOT EXISTS DECISION_TYPE VARCHAR(40)
    COMMENT 'SINGLE | ROUND_TRIP | BUNDLE — kind of decision';
ALTER TABLE FLEET_INTELLIGENCE.BACKLOAD_MATCHING.PROPOSAL_DECISIONS
  ADD COLUMN IF NOT EXISTS BUNDLE_ID VARCHAR
    COMMENT 'NULL except for BUNDLE rows that share a multi-offer solve';

UPDATE FLEET_INTELLIGENCE.BACKLOAD_MATCHING.PROPOSAL_DECISIONS
SET SOURCE_PAGE  = COALESCE(SOURCE_PAGE,  'BACKLOAD_MATCHING'),
    DECISION_TYPE = COALESCE(DECISION_TYPE, 'SINGLE')
WHERE SOURCE_PAGE IS NULL OR DECISION_TYPE IS NULL;

-- =====================================================================
-- Phase E1: ORS road km / min cache + ETA-to-pickup
-- =====================================================================
-- FACT_OFFER_ROUTES caches DIRECTIONS results so the page reads stay
-- one query and ORS is called only on a periodic refresh (not on every
-- page load). The actual call is performed by the ors_control_app
-- server (Express route /api/fx/refresh-routes).

CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.MARKETPLACE.FACT_OFFER_ROUTES (
  OFFER_ID     VARCHAR    NOT NULL,
  ROAD_KM      FLOAT,
  ROAD_MIN     FLOAT,
  GEOMETRY     VARCHAR        COMMENT 'GeoJSON LineString from ORS DIRECTIONS (parsed by parseRouteGeometry in the React app)',
  PROFILE      VARCHAR(20)    COMMENT 'driving-hgv | driving-car (set by Phase E6)',
  COMPUTED_AT  TIMESTAMP_NTZ  DEFAULT CURRENT_TIMESTAMP(),
  CONSTRAINT PK_FACT_OFFER_ROUTES PRIMARY KEY (OFFER_ID)
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-freight-exchange","version":{"major":1,"minor":1},"attributes":{"is_quickstart":1,"source":"sql","phase":"E1"}}';

-- VW_OFFER_ENRICHED_V2 layers cached road-km on top of haversine.
-- Page reads should switch to this view; legacy VW_OFFER_ENRICHED is
-- kept untouched so Phase A/B keeps working until UI is migrated.
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.MARKETPLACE.VW_OFFER_ENRICHED_V2
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-freight-exchange","version":{"major":1,"minor":1},"attributes":{"is_quickstart":1,"source":"sql","phase":"E1"}}'
AS
SELECT
  e.*,
  fr.ROAD_KM,
  fr.ROAD_MIN,
  fr.GEOMETRY  AS ROUTE_GEOMETRY,
  fr.PROFILE   AS ROUTE_PROFILE,
  fr.COMPUTED_AT AS ROUTE_COMPUTED_AT,
  CASE WHEN fr.ROAD_KM IS NOT NULL AND e.PRICE_USD IS NOT NULL AND fr.ROAD_KM > 0
       THEN e.PRICE_USD / fr.ROAD_KM
       ELSE e.PRICE_PER_KM_USD
  END AS PRICE_PER_ROAD_KM_USD,
  CASE WHEN fr.ROAD_KM IS NULL THEN 'PENDING_ROUTE'
       WHEN fr.ROAD_KM > e.DISTANCE_KM * 1.6 THEN 'DETOUR_HEAVY'
       WHEN fr.ROAD_KM > e.DISTANCE_KM * 1.3 THEN 'DETOUR_MODERATE'
       ELSE 'DIRECT'
  END AS ROUTE_DETOUR_BADGE
FROM FLEET_INTELLIGENCE.MARKETPLACE.VW_OFFER_ENRICHED e
LEFT JOIN FLEET_INTELLIGENCE.MARKETPLACE.FACT_OFFER_ROUTES fr USING (OFFER_ID);

-- =====================================================================
-- Phase E3: Deadhead matrix (idle trailer last-drop -> offer pickup)
-- =====================================================================
-- Reuses VW_TRAILERS from backload-matching. The page joins
-- VW_OFFER_DEADHEAD when a trailer is selected to surface the
-- DEADHEAD_KM column + best-trailer badge.

CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.MARKETPLACE.FACT_DEADHEAD_MATRIX (
  TRAILER_ID   VARCHAR NOT NULL,
  OFFER_ID     VARCHAR NOT NULL,
  ROAD_KM      FLOAT,
  ROAD_MIN     FLOAT,
  COMPUTED_AT  TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
  CONSTRAINT PK_FACT_DEADHEAD_MATRIX PRIMARY KEY (TRAILER_ID, OFFER_ID)
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-freight-exchange","version":{"major":1,"minor":1},"attributes":{"is_quickstart":1,"source":"sql","phase":"E3"}}';

CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.MARKETPLACE.VW_OFFER_DEADHEAD
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-freight-exchange","version":{"major":1,"minor":1},"attributes":{"is_quickstart":1,"source":"sql","phase":"E3"}}'
AS
WITH ranked AS (
  SELECT
    dm.OFFER_ID,
    dm.TRAILER_ID,
    dm.ROAD_KM   AS DEADHEAD_KM,
    dm.ROAD_MIN  AS DEADHEAD_MIN,
    dm.COMPUTED_AT,
    ROW_NUMBER() OVER (PARTITION BY dm.OFFER_ID ORDER BY dm.ROAD_KM ASC) AS BEST_RANK
  FROM FLEET_INTELLIGENCE.MARKETPLACE.FACT_DEADHEAD_MATRIX dm
)
SELECT
  o.OFFER_ID,
  o.PARTNER_ID,
  o.PICKUP_CITY,
  o.DROPOFF_CITY,
  o.PRICE_USD,
  r.TRAILER_ID         AS BEST_TRAILER_ID,
  r.DEADHEAD_KM        AS BEST_DEADHEAD_KM,
  r.DEADHEAD_MIN       AS BEST_DEADHEAD_MIN,
  r.COMPUTED_AT        AS BEST_COMPUTED_AT
FROM FLEET_INTELLIGENCE.MARKETPLACE.VW_OFFER_ENRICHED o
LEFT JOIN ranked r
  ON r.OFFER_ID = o.OFFER_ID AND r.BEST_RANK = 1;

-- =====================================================================
-- Phase E7: Lane density heatmap
-- =====================================================================
-- H3 res-5 hexagon density of historical partner lanes for the active
-- preset. Used by the page heatmap layer.

CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.MARKETPLACE.VW_LANE_DENSITY
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-freight-exchange","version":{"major":1,"minor":1},"attributes":{"is_quickstart":1,"source":"sql","phase":"E7"}}'
AS
WITH lane_midpoints AS (
  SELECT
    h.PARTNER_ID,
    h.EQUIPMENT,
    h.SHIPPED_AT,
    -- Synthetic mid-point: average pickup+dropoff lon/lat per offer where
    -- known; otherwise project off origin/dest country centroid.
    -- Real production swaps in route polyline midpoints from FACT_OFFER_ROUTES.
    o.PICKUP_LON, o.PICKUP_LAT,
    o.DROPOFF_LON, o.DROPOFF_LAT
  FROM FLEET_INTELLIGENCE.MARKETPLACE.VW_PARTNER_HISTORY h
  LEFT JOIN FLEET_INTELLIGENCE.MARKETPLACE.VW_OFFERS o
    ON o.PARTNER_ID = h.PARTNER_ID
)
SELECT
  H3_POINT_TO_CELL_STRING(
    ST_MAKEPOINT((PICKUP_LON + DROPOFF_LON) / 2, (PICKUP_LAT + DROPOFF_LAT) / 2),
    5
  ) AS H3_CELL,
  EQUIPMENT,
  COUNT(*) AS SHIPMENT_COUNT
FROM lane_midpoints
WHERE PICKUP_LON IS NOT NULL AND DROPOFF_LON IS NOT NULL
GROUP BY 1, 2;

-- =====================================================================
-- Phase E8: Cortex negotiation drafts
-- =====================================================================
-- Persists Cortex Complete drafts for audit + future fine-tuning.

CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.MARKETPLACE.OFFER_DRAFTS (
  DRAFT_ID         VARCHAR DEFAULT UUID_STRING() NOT NULL,
  OFFER_ID         VARCHAR NOT NULL,
  DISPATCHER_ID    VARCHAR,
  DRAFT_TEXT       VARCHAR,
  SUGGESTED_USD    FLOAT,
  PROMPT_CONTEXT   VARIANT,
  MODEL            VARCHAR(60),
  CREATED_AT       TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
  ACCEPTED         BOOLEAN DEFAULT FALSE,
  CONSTRAINT PK_OFFER_DRAFTS PRIMARY KEY (DRAFT_ID)
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-freight-exchange","version":{"major":1,"minor":1},"attributes":{"is_quickstart":1,"source":"sql","phase":"E8"}}';

-- =====================================================================
-- Cleanup (run in reverse order)
-- =====================================================================
-- DROP TABLE IF EXISTS FLEET_INTELLIGENCE.MARKETPLACE.OFFER_DRAFTS;
-- DROP VIEW  IF EXISTS FLEET_INTELLIGENCE.MARKETPLACE.VW_LANE_DENSITY;
-- DROP VIEW  IF EXISTS FLEET_INTELLIGENCE.MARKETPLACE.VW_OFFER_DEADHEAD;
-- DROP TABLE IF EXISTS FLEET_INTELLIGENCE.MARKETPLACE.FACT_DEADHEAD_MATRIX;
-- DROP VIEW  IF EXISTS FLEET_INTELLIGENCE.MARKETPLACE.VW_OFFER_ENRICHED_V2;
-- DROP TABLE IF EXISTS FLEET_INTELLIGENCE.MARKETPLACE.FACT_OFFER_ROUTES;
-- The PROPOSAL_DECISIONS schema additions are not dropped automatically
-- because backload-matching also reads the new columns.
