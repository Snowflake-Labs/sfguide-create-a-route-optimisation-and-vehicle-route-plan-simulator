-- ============================================================================
-- Per-session scope-arg data contract (R2.1 of APP_RESTRUCTURE_PLAN)
-- ============================================================================
-- Multi-tenant-safe READ layer. Today the consumer app reads
-- SYNTHETIC_DATASETS.UNIFIED.V_*_CURRENT, which resolve the active dataset via a
-- GLOBAL flag (FLEET_INTELLIGENCE.CORE.DIM_DATASETS.IS_ACTIVE = TRUE). In a shared
-- consumer app that means one user's "switch" changes everyone's view.
--
-- These table functions resolve an EXPLICIT (region, dataset_id) instead, so each
-- session passes its own scope and sees isolated data. They are ADDITIVE: the
-- V_*_CURRENT views remain unchanged for the global default + surfacing-gate probes.
--
-- Contract:
--   F_<TABLE>_SCOPED(P_REGION, P_DATASET_ID)
--     - P_DATASET_ID given  -> rows for exactly that immutable dataset (per-session).
--     - P_DATASET_ID NULL   -> falls back to the region's ACTIVE dataset (back-compat
--                              with current V_*_CURRENT behavior), region-filtered.
--     - P_REGION NULL        -> no region guard (dataset_id alone pins region+vehicle).
--
-- Call site (consumer /api/query, SELECT-only, :param):
--   SELECT * FROM TABLE(SYNTHETIC_DATASETS.UNIFIED.F_FACT_TRIPS_SCOPED(:region, :dataset_id))
--
-- Source of truth: this file. Also mirrored into the control-app boot path
-- (server/lib/init.ts ensureScopedDatasetContract()) so a fresh install creates them.
--
-- Tracking: query_tag set by caller; each function carries the COMMENT tag.
-- ============================================================================

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-app-restructure","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- ---------------------------------------------------------------------------
-- FACT_TRIPS (region + vehicle scoped)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION SYNTHETIC_DATASETS.UNIFIED.F_FACT_TRIPS_SCOPED(P_REGION VARCHAR, P_DATASET_ID VARCHAR)
RETURNS TABLE (
  TRIP_ID VARCHAR, VEHICLE_ID VARCHAR, DRIVER_ID VARCHAR, VEHICLE_TYPE VARCHAR, REGION VARCHAR,
  ORIGIN_POI_ID VARCHAR, DESTINATION_POI_ID VARCHAR, ORIGIN_LAT FLOAT, ORIGIN_LON FLOAT, ORIGIN GEOGRAPHY,
  DESTINATION_LAT FLOAT, DESTINATION_LON FLOAT, DESTINATION GEOGRAPHY, ROUTE_GEOG GEOGRAPHY,
  DISTANCE_KM FLOAT, DURATION_MINUTES FLOAT, PLANNED_ROUTE_GEOG GEOGRAPHY, PLANNED_DISTANCE_KM FLOAT,
  IS_DETOUR BOOLEAN, DETOUR_DISTANCE_KM FLOAT, TRIP_START TIMESTAMP_NTZ, TRIP_END TIMESTAMP_NTZ,
  STATUS VARCHAR, ORS_PROFILE VARCHAR, JOB_ID VARCHAR
)
COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-app-restructure","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  SELECT t.TRIP_ID, t.VEHICLE_ID, t.DRIVER_ID, t.VEHICLE_TYPE, t.REGION,
         t.ORIGIN_POI_ID, t.DESTINATION_POI_ID, t.ORIGIN_LAT, t.ORIGIN_LON, t.ORIGIN,
         t.DESTINATION_LAT, t.DESTINATION_LON, t.DESTINATION, t.ROUTE_GEOG,
         t.DISTANCE_KM, t.DURATION_MINUTES, t.PLANNED_ROUTE_GEOG, t.PLANNED_DISTANCE_KM,
         t.IS_DETOUR, t.DETOUR_DISTANCE_KM, t.TRIP_START, t.TRIP_END,
         t.STATUS, t.ORS_PROFILE, t.JOB_ID
  FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS t
  JOIN FLEET_INTELLIGENCE.CORE.DIM_DATASETS d
    ON d.DATASET_ID = t.JOB_ID AND d.REGION = t.REGION AND d.VEHICLE_TYPE = t.VEHICLE_TYPE
  WHERE (P_REGION IS NULL OR t.REGION = P_REGION)
    AND ( (P_DATASET_ID IS NOT NULL AND d.DATASET_ID = P_DATASET_ID)
          OR (P_DATASET_ID IS NULL AND d.IS_ACTIVE = TRUE) )
$$;

-- ---------------------------------------------------------------------------
-- FACT_VEHICLE_TELEMETRY (region + vehicle scoped)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION SYNTHETIC_DATASETS.UNIFIED.F_FACT_VEHICLE_TELEMETRY_SCOPED(P_REGION VARCHAR, P_DATASET_ID VARCHAR)
RETURNS TABLE (
  TELEMETRY_ID VARCHAR, REGION VARCHAR, VEHICLE_TYPE VARCHAR, VEHICLE_ID VARCHAR, TRIP_ID VARCHAR,
  TS TIMESTAMP_NTZ, LATITUDE FLOAT, LONGITUDE FLOAT, POINT_GEOM GEOGRAPHY, SPEED_KMH FLOAT,
  HEADING_DEG FLOAT, POSTED_SPEED_KMH FLOAT, STATUS VARCHAR, IS_SPEEDING BOOLEAN, IS_HOS_VIOLATION BOOLEAN,
  IS_DETOUR BOOLEAN, GPS_ACCURACY_M FLOAT, LOCATION_ID VARCHAR, LOCATION_TYPE VARCHAR, ORS_PROFILE VARCHAR,
  BATTERY_PCT FLOAT, ODOMETER_KM FLOAT, POINT_INDEX NUMBER, JOB_ID VARCHAR
)
COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-app-restructure","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  SELECT t.TELEMETRY_ID, t.REGION, t.VEHICLE_TYPE, t.VEHICLE_ID, t.TRIP_ID,
         t.TS, t.LATITUDE, t.LONGITUDE, t.POINT_GEOM, t.SPEED_KMH,
         t.HEADING_DEG, t.POSTED_SPEED_KMH, t.STATUS, t.IS_SPEEDING, t.IS_HOS_VIOLATION,
         t.IS_DETOUR, t.GPS_ACCURACY_M, t.LOCATION_ID, t.LOCATION_TYPE, t.ORS_PROFILE,
         t.BATTERY_PCT, t.ODOMETER_KM, t.POINT_INDEX, t.JOB_ID
  FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY t
  JOIN FLEET_INTELLIGENCE.CORE.DIM_DATASETS d
    ON d.DATASET_ID = t.JOB_ID AND d.REGION = t.REGION AND d.VEHICLE_TYPE = t.VEHICLE_TYPE
  WHERE (P_REGION IS NULL OR t.REGION = P_REGION)
    AND ( (P_DATASET_ID IS NOT NULL AND d.DATASET_ID = P_DATASET_ID)
          OR (P_DATASET_ID IS NULL AND d.IS_ACTIVE = TRUE) )
$$;

-- ---------------------------------------------------------------------------
-- DIM_POIS (region scoped only -- no VEHICLE_TYPE column / join)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION SYNTHETIC_DATASETS.UNIFIED.F_DIM_POIS_SCOPED(P_REGION VARCHAR, P_DATASET_ID VARCHAR)
RETURNS TABLE (
  LOCATION_ID VARCHAR, REGION VARCHAR, NAME VARCHAR, LOCATION_TYPE VARCHAR, CATEGORY VARCHAR,
  LAT FLOAT, LNG FLOAT, POINT_GEOM GEOGRAPHY, SOURCE VARCHAR, JOB_ID VARCHAR
)
COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-app-restructure","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  SELECT p.LOCATION_ID, p.REGION, p.NAME, p.LOCATION_TYPE, p.CATEGORY,
         p.LAT, p.LNG, p.POINT_GEOM, p.SOURCE, p.JOB_ID
  FROM SYNTHETIC_DATASETS.UNIFIED.DIM_POIS p
  JOIN FLEET_INTELLIGENCE.CORE.DIM_DATASETS d
    ON d.DATASET_ID = p.JOB_ID AND d.REGION = p.REGION
  WHERE (P_REGION IS NULL OR p.REGION = P_REGION)
    AND ( (P_DATASET_ID IS NOT NULL AND d.DATASET_ID = P_DATASET_ID)
          OR (P_DATASET_ID IS NULL AND d.IS_ACTIVE = TRUE) )
$$;

-- ---------------------------------------------------------------------------
-- DIM_FLEET (region + vehicle scoped). NOTE: live column order skips dropped
-- ordinals 14-16; HGV columns (17-23) come AFTER JOB_ID (13). Explicit column
-- list below matches the live table order exactly.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION SYNTHETIC_DATASETS.UNIFIED.F_DIM_FLEET_SCOPED(P_REGION VARCHAR, P_DATASET_ID VARCHAR)
RETURNS TABLE (
  VEHICLE_ID VARCHAR, REGION VARCHAR, VEHICLE_TYPE VARCHAR, ORS_PROFILE VARCHAR, SHIFT_TYPE VARCHAR,
  SHIFT_START_HOUR NUMBER, SHIFT_END_HOUR NUMBER, HOME_LOCATION_ID VARCHAR, DRIVER_PROFILE VARCHAR,
  OPERATING_MODE VARCHAR, BASE_SPEED_KMH FLOAT, BATTERY_RANGE_KM FLOAT, JOB_ID VARCHAR,
  WEIGHT_TONS NUMBER, HEIGHT_M NUMBER, LENGTH_M NUMBER, WIDTH_M NUMBER, AXLELOAD_T NUMBER,
  HAZMAT BOOLEAN, VEHICLE_SUBTYPE VARCHAR
)
COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-app-restructure","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  SELECT f.VEHICLE_ID, f.REGION, f.VEHICLE_TYPE, f.ORS_PROFILE, f.SHIFT_TYPE,
         f.SHIFT_START_HOUR, f.SHIFT_END_HOUR, f.HOME_LOCATION_ID, f.DRIVER_PROFILE,
         f.OPERATING_MODE, f.BASE_SPEED_KMH, f.BATTERY_RANGE_KM, f.JOB_ID,
         f.WEIGHT_TONS, f.HEIGHT_M, f.LENGTH_M, f.WIDTH_M, f.AXLELOAD_T,
         f.HAZMAT, f.VEHICLE_SUBTYPE
  FROM SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET f
  JOIN FLEET_INTELLIGENCE.CORE.DIM_DATASETS d
    ON d.DATASET_ID = f.JOB_ID AND d.REGION = f.REGION AND d.VEHICLE_TYPE = f.VEHICLE_TYPE
  WHERE (P_REGION IS NULL OR f.REGION = P_REGION)
    AND ( (P_DATASET_ID IS NOT NULL AND d.DATASET_ID = P_DATASET_ID)
          OR (P_DATASET_ID IS NULL AND d.IS_ACTIVE = TRUE) )
$$;

-- ---------------------------------------------------------------------------
-- TODO (R2 follow-on, same pattern): the remaining V_*_CURRENT-backed tables
--   F_DIM_TRIP_SCHEDULE_SCOPED, F_FACT_FREIGHT_OFFERS_SCOPED, F_DIM_PARTNERS_SCOPED,
--   F_FACT_PARTNER_HISTORY_SCOPED, plus app-scoped V_PLACES_CURRENT (ROUTE_OPTIMIZATION)
--   and V_FACT_OFFER_ROUTES_CURRENT (MARKETPLACE) when those packs are wired (R6).
-- ---------------------------------------------------------------------------
