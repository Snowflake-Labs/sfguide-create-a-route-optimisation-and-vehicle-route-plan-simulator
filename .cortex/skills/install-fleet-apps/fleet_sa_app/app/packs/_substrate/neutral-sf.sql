-- =============================================================================
-- Neutral SF substrate - zero-copy relabeling of the San Francisco synthetic
-- dataset into domain-agnostic entities (LOCATIONS / MOVEMENTS / ASSETS).
-- =============================================================================
-- WHY: proves the data layer is not fleet-bound. Both the neutral STARTER pack
-- and (later) the fleet pack can map from ONE neutral substrate. The neutrality
-- lives HERE (a first-class substrate), not inline in each pack's mapping.
--
-- SOURCE: SYNTHETIC_DATASETS.UNIFIED.* filtered to REGION='SanFrancisco'
--   (the "San Francisco E-Bike 50" dataset: DIM_POIS 4998, FACT_TRIPS 11693,
--    DIM_FLEET 50, FACT_VEHICLE_TELEMETRY 518535).
-- FORM: zero-copy VIEWS (always fresh, no storage duplication). No fleet
--   vocabulary (vehicle/driver/trailer/HGV) survives into the column names;
--   data VALUES (e.g. ASSET_CLASS='ebike') are unchanged.
--
-- Apply: snow sql -c fleet_test_evals -f neutral-sf.sql
-- =============================================================================
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-starter-substrate","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE SCHEMA IF NOT EXISTS SYNTHETIC_DATASETS.NEUTRAL
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","attributes":{"component":"neutral-substrate"}}';

-- LOCATIONS <- DIM_POIS (already neutral; pass the neutral columns through).
CREATE OR REPLACE VIEW SYNTHETIC_DATASETS.NEUTRAL.LOCATIONS
  COMMENT = 'Neutral places of interest (SF slice). Source: DIM_POIS.'
AS
SELECT
  LOCATION_ID,
  NAME,
  CATEGORY,
  LOCATION_TYPE,
  LAT,
  LNG,
  POINT_GEOM
FROM SYNTHETIC_DATASETS.UNIFIED.DIM_POIS
WHERE REGION = 'SanFrancisco';

-- ASSETS <- DIM_FLEET (relabel vehicle -> asset; drop routing/driver vocab).
CREATE OR REPLACE VIEW SYNTHETIC_DATASETS.NEUTRAL.ASSETS
  COMMENT = 'Neutral movable assets (SF slice). Source: DIM_FLEET.'
AS
SELECT
  VEHICLE_ID        AS ASSET_ID,
  VEHICLE_TYPE      AS ASSET_CLASS,
  HOME_LOCATION_ID,
  OPERATING_MODE,
  BASE_SPEED_KMH,
  BATTERY_RANGE_KM  AS RANGE_KM
FROM SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET
WHERE REGION = 'SanFrancisco';

-- MOVEMENTS <- FACT_TRIPS (relabel trip -> movement; drop vehicle/driver/profile/detour).
CREATE OR REPLACE VIEW SYNTHETIC_DATASETS.NEUTRAL.MOVEMENTS
  COMMENT = 'Neutral origin->destination movements (SF slice). Source: FACT_TRIPS.'
AS
SELECT
  TRIP_ID             AS MOVEMENT_ID,
  VEHICLE_ID          AS ASSET_ID,
  ORIGIN_POI_ID       AS ORIGIN_ID,
  DESTINATION_POI_ID  AS DESTINATION_ID,
  ORIGIN              AS ORIGIN_GEO,
  DESTINATION         AS DESTINATION_GEO,
  ROUTE_GEOG          AS ROUTE_GEO,
  DISTANCE_KM,
  DURATION_MINUTES,
  TRIP_START          AS STARTED_AT,
  TRIP_END            AS ENDED_AT,
  STATUS
FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS
WHERE REGION = 'SanFrancisco';

-- Grants (additive; roles from fleet_sa_app/app/role_binding.sql).
GRANT USAGE ON DATABASE SYNTHETIC_DATASETS TO ROLE FLEET_APP_USER;
GRANT USAGE ON SCHEMA SYNTHETIC_DATASETS.NEUTRAL TO ROLE FLEET_APP_USER;
GRANT SELECT ON ALL VIEWS IN SCHEMA SYNTHETIC_DATASETS.NEUTRAL TO ROLE FLEET_APP_USER;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA SYNTHETIC_DATASETS.NEUTRAL TO ROLE FLEET_APP_USER;
GRANT USAGE ON SCHEMA SYNTHETIC_DATASETS.NEUTRAL TO ROLE FLEET_APP_OPS;
GRANT SELECT ON ALL VIEWS IN SCHEMA SYNTHETIC_DATASETS.NEUTRAL TO ROLE FLEET_APP_OPS;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA SYNTHETIC_DATASETS.NEUTRAL TO ROLE FLEET_APP_OPS;
GRANT USAGE ON SCHEMA SYNTHETIC_DATASETS.NEUTRAL TO ROLE FLEET_APP_ADMIN;
GRANT SELECT ON ALL VIEWS IN SCHEMA SYNTHETIC_DATASETS.NEUTRAL TO ROLE FLEET_APP_ADMIN;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA SYNTHETIC_DATASETS.NEUTRAL TO ROLE FLEET_APP_ADMIN;
