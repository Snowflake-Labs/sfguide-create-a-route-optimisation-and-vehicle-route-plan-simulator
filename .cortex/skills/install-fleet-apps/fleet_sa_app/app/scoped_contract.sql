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
-- DIM_TRIP_SCHEDULE (region + vehicle scoped). Planned-work grain; powers the
-- neutral dim_plan / fact_work_item / fact_stop (CORE) and the Dispatch board.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION SYNTHETIC_DATASETS.UNIFIED.F_DIM_TRIP_SCHEDULE_SCOPED(P_REGION VARCHAR, P_DATASET_ID VARCHAR)
RETURNS TABLE (
  SCHEDULE_ID VARCHAR, VEHICLE_ID VARCHAR, DRIVER_ID VARCHAR, VEHICLE_TYPE VARCHAR, REGION VARCHAR,
  TRIP_DATE DATE, TRIP_SEQ NUMBER, ORIGIN_POI_ID VARCHAR, DESTINATION_POI_ID VARCHAR,
  PLANNED_START TIMESTAMP_NTZ, PLANNED_END TIMESTAMP_NTZ, SHIFT_TYPE VARCHAR, ORS_PROFILE VARCHAR,
  DISTANCE_KM FLOAT, DURATION_MINUTES FLOAT, STATUS VARCHAR, JOB_ID VARCHAR
)
COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-app-restructure","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  SELECT s.SCHEDULE_ID, s.VEHICLE_ID, s.DRIVER_ID, s.VEHICLE_TYPE, s.REGION,
         s.TRIP_DATE, s.TRIP_SEQ, s.ORIGIN_POI_ID, s.DESTINATION_POI_ID,
         s.PLANNED_START, s.PLANNED_END, s.SHIFT_TYPE, s.ORS_PROFILE,
         s.DISTANCE_KM, s.DURATION_MINUTES, s.STATUS, s.JOB_ID
  FROM SYNTHETIC_DATASETS.UNIFIED.DIM_TRIP_SCHEDULE s
  JOIN FLEET_INTELLIGENCE.CORE.DIM_DATASETS d
    ON d.DATASET_ID = s.JOB_ID AND d.REGION = s.REGION AND d.VEHICLE_TYPE = s.VEHICLE_TYPE
  WHERE (P_REGION IS NULL OR s.REGION = P_REGION)
    AND ( (P_DATASET_ID IS NOT NULL AND d.DATASET_ID = P_DATASET_ID)
          OR (P_DATASET_ID IS NULL AND d.IS_ACTIVE = TRUE) )
$$;

-- ============================================================================
-- Contract-layer scope-arg functions (FLEET_APP.* neutral data contract)
-- ============================================================================
-- The consumer app binds to the NEUTRAL FLEET_APP contract, never to the physical
-- SYNTHETIC_DATASETS source (repo tenet: swappable data seam). The contract views
-- VW_FACT_TRIPS / VW_FACT_VEHICLE_TELEMETRY thinly wrap the global-active
-- V_*_CURRENT views. These contract-layer table functions are the per-session
-- equivalents: they wrap the UNIFIED F_*_SCOPED functions above, so dashboards get
-- per-session scoping WITHOUT reaching past the contract into the physical source.
--
-- Consumer call site:
--   SELECT * FROM TABLE(FLEET_APP.UNIFIED_FLEET.F_VW_FACT_TRIPS_SCOPED(:region, :dataset_id))
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION FLEET_APP.UNIFIED_FLEET.F_VW_FACT_TRIPS_SCOPED(P_REGION VARCHAR, P_DATASET_ID VARCHAR)
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
  SELECT * FROM TABLE(SYNTHETIC_DATASETS.UNIFIED.F_FACT_TRIPS_SCOPED(P_REGION, P_DATASET_ID))
$$;

CREATE OR REPLACE FUNCTION FLEET_APP.UNIFIED_FLEET.F_VW_FACT_VEHICLE_TELEMETRY_SCOPED(P_REGION VARCHAR, P_DATASET_ID VARCHAR)
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
  SELECT * FROM TABLE(SYNTHETIC_DATASETS.UNIFIED.F_FACT_VEHICLE_TELEMETRY_SCOPED(P_REGION, P_DATASET_ID))
$$;

-- ---------------------------------------------------------------------------
-- Grants: the consumer (and OPS/ADMIN) call the contract-layer scope-arg
-- functions through the NEUTRAL FLEET_APP contract. These are owner's-rights
-- SQL UDTFs, so USAGE on the outer function is sufficient -- the inner call into
-- SYNTHETIC_DATASETS.UNIFIED.F_*_SCOPED runs as the function owner. Roles from
-- fleet_sa_app/app/role_binding.sql. Idempotent (re-granting is a no-op).
-- ---------------------------------------------------------------------------
GRANT USAGE ON FUNCTION FLEET_APP.UNIFIED_FLEET.F_VW_FACT_TRIPS_SCOPED(VARCHAR, VARCHAR) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.UNIFIED_FLEET.F_VW_FACT_TRIPS_SCOPED(VARCHAR, VARCHAR) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.UNIFIED_FLEET.F_VW_FACT_TRIPS_SCOPED(VARCHAR, VARCHAR) TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.UNIFIED_FLEET.F_VW_FACT_VEHICLE_TELEMETRY_SCOPED(VARCHAR, VARCHAR) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.UNIFIED_FLEET.F_VW_FACT_VEHICLE_TELEMETRY_SCOPED(VARCHAR, VARCHAR) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.UNIFIED_FLEET.F_VW_FACT_VEHICLE_TELEMETRY_SCOPED(VARCHAR, VARCHAR) TO ROLE FLEET_APP_ADMIN;

-- ---------------------------------------------------------------------------
-- Neutral contract wrappers for POIS + FLEET (consumed by FLEET_OPS intents).
-- Same pattern as the TRIPS/TELEMETRY wrappers above: the FLEET_OPS layer binds
-- to these FLEET_APP.* contract functions, never to SYNTHETIC_DATASETS directly.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION FLEET_APP.UNIFIED_FLEET.F_VW_DIM_POIS_SCOPED(P_REGION VARCHAR, P_DATASET_ID VARCHAR)
RETURNS TABLE (
  LOCATION_ID VARCHAR, REGION VARCHAR, NAME VARCHAR, LOCATION_TYPE VARCHAR, CATEGORY VARCHAR,
  LAT FLOAT, LNG FLOAT, POINT_GEOM GEOGRAPHY, SOURCE VARCHAR, JOB_ID VARCHAR
)
COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-app-restructure","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  SELECT * FROM TABLE(SYNTHETIC_DATASETS.UNIFIED.F_DIM_POIS_SCOPED(P_REGION, P_DATASET_ID))
$$;

CREATE OR REPLACE FUNCTION FLEET_APP.UNIFIED_FLEET.F_VW_DIM_FLEET_SCOPED(P_REGION VARCHAR, P_DATASET_ID VARCHAR)
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
  SELECT * FROM TABLE(SYNTHETIC_DATASETS.UNIFIED.F_DIM_FLEET_SCOPED(P_REGION, P_DATASET_ID))
$$;

GRANT USAGE ON FUNCTION FLEET_APP.UNIFIED_FLEET.F_VW_DIM_POIS_SCOPED(VARCHAR, VARCHAR) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.UNIFIED_FLEET.F_VW_DIM_POIS_SCOPED(VARCHAR, VARCHAR) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.UNIFIED_FLEET.F_VW_DIM_POIS_SCOPED(VARCHAR, VARCHAR) TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.UNIFIED_FLEET.F_VW_DIM_FLEET_SCOPED(VARCHAR, VARCHAR) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.UNIFIED_FLEET.F_VW_DIM_FLEET_SCOPED(VARCHAR, VARCHAR) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.UNIFIED_FLEET.F_VW_DIM_FLEET_SCOPED(VARCHAR, VARCHAR) TO ROLE FLEET_APP_ADMIN;

CREATE OR REPLACE FUNCTION FLEET_APP.UNIFIED_FLEET.F_VW_DIM_TRIP_SCHEDULE_SCOPED(P_REGION VARCHAR, P_DATASET_ID VARCHAR)
RETURNS TABLE (
  SCHEDULE_ID VARCHAR, VEHICLE_ID VARCHAR, DRIVER_ID VARCHAR, VEHICLE_TYPE VARCHAR, REGION VARCHAR,
  TRIP_DATE DATE, TRIP_SEQ NUMBER, ORIGIN_POI_ID VARCHAR, DESTINATION_POI_ID VARCHAR,
  PLANNED_START TIMESTAMP_NTZ, PLANNED_END TIMESTAMP_NTZ, SHIFT_TYPE VARCHAR, ORS_PROFILE VARCHAR,
  DISTANCE_KM FLOAT, DURATION_MINUTES FLOAT, STATUS VARCHAR, JOB_ID VARCHAR
)
COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-app-restructure","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  SELECT * FROM TABLE(SYNTHETIC_DATASETS.UNIFIED.F_DIM_TRIP_SCHEDULE_SCOPED(P_REGION, P_DATASET_ID))
$$;

GRANT USAGE ON FUNCTION FLEET_APP.UNIFIED_FLEET.F_VW_DIM_TRIP_SCHEDULE_SCOPED(VARCHAR, VARCHAR) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.UNIFIED_FLEET.F_VW_DIM_TRIP_SCHEDULE_SCOPED(VARCHAR, VARCHAR) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.UNIFIED_FLEET.F_VW_DIM_TRIP_SCHEDULE_SCOPED(VARCHAR, VARCHAR) TO ROLE FLEET_APP_ADMIN;

-- NOTE: the vehicle-type parameter catalog contract views
-- (FLEET_APP.UNIFIED_FLEET.VW_VEHICLE_PROFILE / VW_VEHICLE_DWELL_SLA) are owned
-- by the unified_fleet PACK (packs/fleet/unified_fleet), not here. They must be
-- created before the dwell / route_deviation pack DTs that reference them, and
-- scoped_contract.sql is applied AFTER all packs, so the unified_fleet pack
-- (which installs first; those packs depend_on it) is the correct owner.

-- ============================================================================
-- FLEET_OPS - the ONE universal, mode-agnostic analytics layer (R6)
-- ============================================================================
-- A single schema of dataset-scoped UDTFs powering every fleet analytics INTENT
-- (Fleet/Asset Status, Asset Map, Demand Density, Trip Inspection, Operator
-- Performance, Top Origins, Asset Utilization). VEHICLE_TYPE is a DATA DIMENSION
-- carried by the selected dataset (DATASET_ID keys DIM_DATASETS by region+vehicle),
-- so dataset-scoping IS mode-parameterization. These functions:
--   * bind ONLY to the neutral FLEET_APP.UNIFIED_FLEET.F_VW_*_SCOPED contract,
--   * use mode-neutral vocab (OPERATOR_ID, ORIGIN_POI, ASSET attributes),
--   * NEVER branch on VEHICLE_TYPE (no CASE WHEN vehicle_type=...).
-- Adding a new mode (vessel/aircraft) = a new dataset + config; NO new schema/view.
-- Authored here; mirrored into the control-app boot (init.ts ensureScopedDatasetContract).
-- See app/packs/BUSINESS_PROBLEM_TAXONOMY.md.
-- ============================================================================
CREATE SCHEMA IF NOT EXISTS FLEET_APP.FLEET_OPS
  COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-app-restructure","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"fleet-ops-universal-analytics"}}';

-- Base trips (mode-neutral: DRIVER_ID -> OPERATOR_ID). Powers Status / Map / Density.
CREATE OR REPLACE FUNCTION FLEET_APP.FLEET_OPS.F_VW_TRIPS_SCOPED(P_REGION VARCHAR, P_DATASET_ID VARCHAR)
RETURNS TABLE (
  TRIP_ID VARCHAR, VEHICLE_ID VARCHAR, OPERATOR_ID VARCHAR, VEHICLE_TYPE VARCHAR, REGION VARCHAR,
  ORIGIN_POI_ID VARCHAR, DESTINATION_POI_ID VARCHAR, ORIGIN_LAT FLOAT, ORIGIN_LON FLOAT, ORIGIN GEOGRAPHY,
  DESTINATION_LAT FLOAT, DESTINATION_LON FLOAT, DESTINATION GEOGRAPHY, ROUTE_GEOG GEOGRAPHY,
  DISTANCE_KM FLOAT, DURATION_MINUTES FLOAT, IS_DETOUR BOOLEAN, TRIP_START TIMESTAMP_NTZ,
  TRIP_END TIMESTAMP_NTZ, STATUS VARCHAR, JOB_ID VARCHAR
)
COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-app-restructure","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  SELECT TRIP_ID, VEHICLE_ID, DRIVER_ID AS OPERATOR_ID, VEHICLE_TYPE, REGION,
         ORIGIN_POI_ID, DESTINATION_POI_ID, ORIGIN_LAT, ORIGIN_LON, ORIGIN,
         DESTINATION_LAT, DESTINATION_LON, DESTINATION, ROUTE_GEOG,
         DISTANCE_KM, DURATION_MINUTES, IS_DETOUR, TRIP_START, TRIP_END, STATUS, JOB_ID
  FROM TABLE(FLEET_APP.UNIFIED_FLEET.F_VW_FACT_TRIPS_SCOPED(P_REGION, P_DATASET_ID))
$$;

-- Base telemetry (GPS pings + safety flags). Powers Status (safety) / Map / Density.
CREATE OR REPLACE FUNCTION FLEET_APP.FLEET_OPS.F_VW_TELEMETRY_SCOPED(P_REGION VARCHAR, P_DATASET_ID VARCHAR)
RETURNS TABLE (
  TELEMETRY_ID VARCHAR, REGION VARCHAR, VEHICLE_TYPE VARCHAR, VEHICLE_ID VARCHAR, OPERATOR_ID VARCHAR,
  TRIP_ID VARCHAR, TS TIMESTAMP_NTZ, LATITUDE FLOAT, LONGITUDE FLOAT, POINT_GEOM GEOGRAPHY,
  SPEED_KMH FLOAT, HEADING_DEG FLOAT, POSTED_SPEED_KMH FLOAT, STATUS VARCHAR, IS_SPEEDING BOOLEAN,
  IS_HOS_VIOLATION BOOLEAN, IS_DETOUR BOOLEAN, LOCATION_TYPE VARCHAR, JOB_ID VARCHAR
)
COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-app-restructure","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  SELECT TELEMETRY_ID, REGION, VEHICLE_TYPE, VEHICLE_ID, VEHICLE_ID AS OPERATOR_ID,
         TRIP_ID, TS, LATITUDE, LONGITUDE, POINT_GEOM,
         SPEED_KMH, HEADING_DEG, POSTED_SPEED_KMH, STATUS, IS_SPEEDING,
         IS_HOS_VIOLATION, IS_DETOUR, LOCATION_TYPE, JOB_ID
  FROM TABLE(FLEET_APP.UNIFIED_FLEET.F_VW_FACT_VEHICLE_TELEMETRY_SCOPED(P_REGION, P_DATASET_ID))
$$;

-- Trip Inspection: one enriched row per trip (origin/dest names, speed, shift label).
-- Generalized from the retired taxi VW_TRIP_SUMMARY; SHIFT_LABEL maps shift codes
-- (NOT vehicle type) -> human label. Mode-neutral OPERATOR_ID.
CREATE OR REPLACE FUNCTION FLEET_APP.FLEET_OPS.F_VW_TRIP_SUMMARY_SCOPED(P_REGION VARCHAR, P_DATASET_ID VARCHAR)
RETURNS TABLE (
  OPERATOR_ID VARCHAR, TRIP_ID VARCHAR, TRIP_START_TIME TIMESTAMP_NTZ, TRIP_END_TIME TIMESTAMP_NTZ,
  ORIGIN_ADDRESS VARCHAR, DESTINATION_ADDRESS VARCHAR, ROUTE_DURATION_SECS FLOAT, ROUTE_DISTANCE_METERS FLOAT,
  GEOMETRY GEOGRAPHY, ORIGIN GEOGRAPHY, DESTINATION GEOGRAPHY, SHIFT_LABEL VARCHAR,
  REGION VARCHAR, VEHICLE_TYPE VARCHAR, AVERAGE_KMH FLOAT, MAX_KMH FLOAT
)
COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-app-restructure","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH trips AS (
    SELECT * FROM TABLE(FLEET_APP.UNIFIED_FLEET.F_VW_FACT_TRIPS_SCOPED(P_REGION, P_DATASET_ID))
  ),
  tel AS (
    SELECT TRIP_ID, MAX(SPEED_KMH) AS MAX_KMH
    FROM TABLE(FLEET_APP.UNIFIED_FLEET.F_VW_FACT_VEHICLE_TELEMETRY_SCOPED(P_REGION, P_DATASET_ID))
    GROUP BY TRIP_ID
  ),
  pois AS (
    SELECT LOCATION_ID, NAME,
           ROW_NUMBER() OVER (PARTITION BY LOCATION_ID ORDER BY NAME) AS RN
    FROM TABLE(FLEET_APP.UNIFIED_FLEET.F_VW_DIM_POIS_SCOPED(P_REGION, P_DATASET_ID))
  ),
  fleet AS (
    SELECT VEHICLE_ID, SHIFT_TYPE,
           ROW_NUMBER() OVER (PARTITION BY VEHICLE_ID ORDER BY SHIFT_TYPE) AS RN
    FROM TABLE(FLEET_APP.UNIFIED_FLEET.F_VW_DIM_FLEET_SCOPED(P_REGION, P_DATASET_ID))
  )
  SELECT
    t.DRIVER_ID AS OPERATOR_ID,
    t.TRIP_ID,
    t.TRIP_START AS TRIP_START_TIME,
    t.TRIP_END AS TRIP_END_TIME,
    COALESCE(po.NAME, 'Unknown') AS ORIGIN_ADDRESS,
    COALESCE(pd.NAME, 'Unknown') AS DESTINATION_ADDRESS,
    t.DURATION_MINUTES * 60 AS ROUTE_DURATION_SECS,
    t.DISTANCE_KM * 1000 AS ROUTE_DISTANCE_METERS,
    t.ROUTE_GEOG AS GEOMETRY,
    t.ORIGIN,
    t.DESTINATION,
    CASE f.SHIFT_TYPE
      WHEN '6-14' THEN 'Morning'
      WHEN '14-22' THEN 'Afternoon'
      WHEN '22-6' THEN 'Night'
      ELSE f.SHIFT_TYPE
    END AS SHIFT_LABEL,
    t.REGION,
    t.VEHICLE_TYPE,
    CASE WHEN t.DURATION_MINUTES > 0 THEN t.DISTANCE_KM / (t.DURATION_MINUTES / 60) ELSE 0 END AS AVERAGE_KMH,
    ts.MAX_KMH
  FROM trips t
  LEFT JOIN pois po ON t.ORIGIN_POI_ID = po.LOCATION_ID AND po.RN = 1
  LEFT JOIN pois pd ON t.DESTINATION_POI_ID = pd.LOCATION_ID AND pd.RN = 1
  LEFT JOIN fleet f ON t.VEHICLE_ID = f.VEHICLE_ID AND f.RN = 1
  LEFT JOIN tel ts ON t.TRIP_ID = ts.TRIP_ID
$$;

-- Demand Density: H3-r7 hexbin of GPS pings, optional hour filter (P_HOUR NULL = all hours).
CREATE OR REPLACE FUNCTION FLEET_APP.FLEET_OPS.F_VW_H3_DENSITY_SCOPED(P_REGION VARCHAR, P_DATASET_ID VARCHAR, P_HOUR NUMBER)
RETURNS TABLE (
  H3_INDEX VARCHAR, HOUR_OF_DAY NUMBER, PING_COUNT NUMBER, AVG_SPEED_KMH FLOAT
)
COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-app-restructure","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  SELECT H3_POINT_TO_CELL_STRING(POINT_GEOM, 7) AS H3_INDEX,
         EXTRACT(HOUR FROM TS) AS HOUR_OF_DAY,
         COUNT(*) AS PING_COUNT,
         ROUND(AVG(SPEED_KMH), 1) AS AVG_SPEED_KMH
  FROM TABLE(FLEET_APP.UNIFIED_FLEET.F_VW_FACT_VEHICLE_TELEMETRY_SCOPED(P_REGION, P_DATASET_ID))
  WHERE POINT_GEOM IS NOT NULL
    AND (P_HOUR IS NULL OR EXTRACT(HOUR FROM TS) = P_HOUR)
  GROUP BY 1, 2
$$;

-- Operator Performance: per-operator (DRIVER_ID) KPIs, enriched with shift + profile.
CREATE OR REPLACE FUNCTION FLEET_APP.FLEET_OPS.F_VW_OPERATOR_PERF_SCOPED(P_REGION VARCHAR, P_DATASET_ID VARCHAR)
RETURNS TABLE (
  OPERATOR_ID VARCHAR, SHIFT_TYPE VARCHAR, DRIVER_PROFILE VARCHAR, TRIPS NUMBER,
  TOTAL_DISTANCE_KM FLOAT, AVG_DISTANCE_KM FLOAT, AVG_DURATION_MIN FLOAT, AVG_SPEED_KMH FLOAT,
  REGION VARCHAR, VEHICLE_TYPE VARCHAR
)
COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-app-restructure","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH trips AS (
    SELECT * FROM TABLE(FLEET_APP.UNIFIED_FLEET.F_VW_FACT_TRIPS_SCOPED(P_REGION, P_DATASET_ID))
  ),
  fleet AS (
    SELECT VEHICLE_ID, SHIFT_TYPE, DRIVER_PROFILE,
           ROW_NUMBER() OVER (PARTITION BY VEHICLE_ID ORDER BY SHIFT_TYPE) AS RN
    FROM TABLE(FLEET_APP.UNIFIED_FLEET.F_VW_DIM_FLEET_SCOPED(P_REGION, P_DATASET_ID))
  )
  SELECT
    t.DRIVER_ID AS OPERATOR_ID,
    ANY_VALUE(f.SHIFT_TYPE) AS SHIFT_TYPE,
    ANY_VALUE(f.DRIVER_PROFILE) AS DRIVER_PROFILE,
    COUNT(*) AS TRIPS,
    ROUND(SUM(t.DISTANCE_KM), 1) AS TOTAL_DISTANCE_KM,
    ROUND(AVG(t.DISTANCE_KM), 2) AS AVG_DISTANCE_KM,
    ROUND(AVG(t.DURATION_MINUTES), 1) AS AVG_DURATION_MIN,
    ROUND(AVG(CASE WHEN t.DURATION_MINUTES > 0 THEN t.DISTANCE_KM / (t.DURATION_MINUTES / 60) END), 1) AS AVG_SPEED_KMH,
    ANY_VALUE(t.REGION) AS REGION,
    ANY_VALUE(t.VEHICLE_TYPE) AS VEHICLE_TYPE
  FROM trips t
  LEFT JOIN fleet f ON t.VEHICLE_ID = f.VEHICLE_ID AND f.RN = 1
  GROUP BY t.DRIVER_ID
$$;

-- Top Origins: busiest origin POIs by trip volume. Optional LOCATION_TYPE filter
-- (P_LOCATION_TYPE NULL = all types) generalizes the retired food_delivery
-- "restaurants" view into any origin category (depot, warehouse, restaurant, ...).
CREATE OR REPLACE FUNCTION FLEET_APP.FLEET_OPS.F_VW_TOP_ORIGINS_SCOPED(P_REGION VARCHAR, P_DATASET_ID VARCHAR, P_LOCATION_TYPE VARCHAR)
RETURNS TABLE (
  ORIGIN_POI_ID VARCHAR, ORIGIN_NAME VARCHAR, LOCATION_TYPE VARCHAR, LAT FLOAT, LNG FLOAT,
  LOCATION GEOGRAPHY, TOTAL_TRIPS NUMBER, AVG_DURATION_MIN FLOAT, REGION VARCHAR
)
COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-app-restructure","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH pois AS (
    SELECT * FROM TABLE(FLEET_APP.UNIFIED_FLEET.F_VW_DIM_POIS_SCOPED(P_REGION, P_DATASET_ID))
  ),
  trips AS (
    SELECT ORIGIN_POI_ID, TRIP_ID, DURATION_MINUTES
    FROM TABLE(FLEET_APP.UNIFIED_FLEET.F_VW_FACT_TRIPS_SCOPED(P_REGION, P_DATASET_ID))
  )
  SELECT
    p.LOCATION_ID AS ORIGIN_POI_ID,
    p.NAME AS ORIGIN_NAME,
    p.LOCATION_TYPE,
    ANY_VALUE(p.LAT) AS LAT,
    ANY_VALUE(p.LNG) AS LNG,
    ANY_VALUE(p.POINT_GEOM) AS LOCATION,
    COUNT(t.TRIP_ID) AS TOTAL_TRIPS,
    ROUND(AVG(t.DURATION_MINUTES), 1) AS AVG_DURATION_MIN,
    p.REGION
  FROM pois p
  LEFT JOIN trips t ON p.LOCATION_ID = t.ORIGIN_POI_ID
  WHERE (P_LOCATION_TYPE IS NULL OR p.LOCATION_TYPE = P_LOCATION_TYPE)
  GROUP BY p.LOCATION_ID, p.NAME, p.LOCATION_TYPE, p.REGION
$$;

-- Asset Utilization (sparse mode attributes): the optional/sparse attribute set.
-- Columns are the UNION of all mode attributes; modes that lack a given attribute
-- return NULL (HGV dims populated today; vessel draft / aircraft FL added later as
-- new columns, never a new schema). NO branching on VEHICLE_TYPE.
CREATE OR REPLACE FUNCTION FLEET_APP.FLEET_OPS.F_VW_ASSET_ATTRIBUTES_SCOPED(P_REGION VARCHAR, P_DATASET_ID VARCHAR)
RETURNS TABLE (
  VEHICLE_ID VARCHAR, VEHICLE_TYPE VARCHAR, REGION VARCHAR, OPERATING_MODE VARCHAR, VEHICLE_SUBTYPE VARCHAR,
  BASE_SPEED_KMH FLOAT, BATTERY_RANGE_KM FLOAT, WEIGHT_TONS NUMBER, HEIGHT_M NUMBER, LENGTH_M NUMBER,
  WIDTH_M NUMBER, AXLELOAD_T NUMBER, HAZMAT BOOLEAN, SHIFT_TYPE VARCHAR, DRIVER_PROFILE VARCHAR,
  HOME_LOCATION_ID VARCHAR
)
COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-app-restructure","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  SELECT VEHICLE_ID, VEHICLE_TYPE, REGION, OPERATING_MODE, VEHICLE_SUBTYPE,
         BASE_SPEED_KMH, BATTERY_RANGE_KM, WEIGHT_TONS, HEIGHT_M, LENGTH_M,
         WIDTH_M, AXLELOAD_T, HAZMAT, SHIFT_TYPE, DRIVER_PROFILE, HOME_LOCATION_ID
  FROM TABLE(FLEET_APP.UNIFIED_FLEET.F_VW_DIM_FLEET_SCOPED(P_REGION, P_DATASET_ID))
$$;

-- ---------------------------------------------------------------------------
-- Grants: FLEET_OPS schema + UDTFs to the consumer + ops/admin roles.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA FLEET_APP.FLEET_OPS TO ROLE FLEET_APP_USER;
GRANT USAGE ON SCHEMA FLEET_APP.FLEET_OPS TO ROLE FLEET_APP_OPS;
GRANT USAGE ON SCHEMA FLEET_APP.FLEET_OPS TO ROLE FLEET_APP_ADMIN;

GRANT USAGE ON FUNCTION FLEET_APP.FLEET_OPS.F_VW_TRIPS_SCOPED(VARCHAR, VARCHAR) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.FLEET_OPS.F_VW_TRIPS_SCOPED(VARCHAR, VARCHAR) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.FLEET_OPS.F_VW_TRIPS_SCOPED(VARCHAR, VARCHAR) TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.FLEET_OPS.F_VW_TELEMETRY_SCOPED(VARCHAR, VARCHAR) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.FLEET_OPS.F_VW_TELEMETRY_SCOPED(VARCHAR, VARCHAR) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.FLEET_OPS.F_VW_TELEMETRY_SCOPED(VARCHAR, VARCHAR) TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.FLEET_OPS.F_VW_TRIP_SUMMARY_SCOPED(VARCHAR, VARCHAR) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.FLEET_OPS.F_VW_TRIP_SUMMARY_SCOPED(VARCHAR, VARCHAR) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.FLEET_OPS.F_VW_TRIP_SUMMARY_SCOPED(VARCHAR, VARCHAR) TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.FLEET_OPS.F_VW_H3_DENSITY_SCOPED(VARCHAR, VARCHAR, NUMBER) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.FLEET_OPS.F_VW_H3_DENSITY_SCOPED(VARCHAR, VARCHAR, NUMBER) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.FLEET_OPS.F_VW_H3_DENSITY_SCOPED(VARCHAR, VARCHAR, NUMBER) TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.FLEET_OPS.F_VW_OPERATOR_PERF_SCOPED(VARCHAR, VARCHAR) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.FLEET_OPS.F_VW_OPERATOR_PERF_SCOPED(VARCHAR, VARCHAR) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.FLEET_OPS.F_VW_OPERATOR_PERF_SCOPED(VARCHAR, VARCHAR) TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.FLEET_OPS.F_VW_TOP_ORIGINS_SCOPED(VARCHAR, VARCHAR, VARCHAR) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.FLEET_OPS.F_VW_TOP_ORIGINS_SCOPED(VARCHAR, VARCHAR, VARCHAR) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.FLEET_OPS.F_VW_TOP_ORIGINS_SCOPED(VARCHAR, VARCHAR, VARCHAR) TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.FLEET_OPS.F_VW_ASSET_ATTRIBUTES_SCOPED(VARCHAR, VARCHAR) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.FLEET_OPS.F_VW_ASSET_ATTRIBUTES_SCOPED(VARCHAR, VARCHAR) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.FLEET_OPS.F_VW_ASSET_ATTRIBUTES_SCOPED(VARCHAR, VARCHAR) TO ROLE FLEET_APP_ADMIN;

-- ---------------------------------------------------------------------------
-- FLEET_OPS global-active VIEWS (thin wrappers over the UDTFs with typed-NULL
-- args -> the region's ACTIVE dataset). Two consumers:
--   1) the surfacing gate / manifest probe (a resolvable FLEET_OPS schema object),
--   2) SV_FLEET_OPS (Cortex Analyst semantic views bind to views, not UDTFs).
-- The dashboards use the per-session F_VW_*_SCOPED UDTFs directly; these views are
-- the agent/global-default equivalent (same single logic source, NULL scope args).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW FLEET_APP.FLEET_OPS.VW_TRIPS
  COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-app-restructure","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
  AS SELECT * FROM TABLE(FLEET_APP.FLEET_OPS.F_VW_TRIPS_SCOPED(CAST(NULL AS VARCHAR), CAST(NULL AS VARCHAR)));

CREATE OR REPLACE VIEW FLEET_APP.FLEET_OPS.VW_TRIP_SUMMARY
  COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-app-restructure","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
  AS SELECT * FROM TABLE(FLEET_APP.FLEET_OPS.F_VW_TRIP_SUMMARY_SCOPED(CAST(NULL AS VARCHAR), CAST(NULL AS VARCHAR)));

CREATE OR REPLACE VIEW FLEET_APP.FLEET_OPS.VW_OPERATOR_PERFORMANCE
  COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-app-restructure","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
  AS SELECT * FROM TABLE(FLEET_APP.FLEET_OPS.F_VW_OPERATOR_PERF_SCOPED(CAST(NULL AS VARCHAR), CAST(NULL AS VARCHAR)));

CREATE OR REPLACE VIEW FLEET_APP.FLEET_OPS.VW_TOP_ORIGINS
  COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-app-restructure","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
  AS SELECT * FROM TABLE(FLEET_APP.FLEET_OPS.F_VW_TOP_ORIGINS_SCOPED(CAST(NULL AS VARCHAR), CAST(NULL AS VARCHAR), CAST(NULL AS VARCHAR)));

CREATE OR REPLACE VIEW FLEET_APP.FLEET_OPS.VW_ASSET_ATTRIBUTES
  COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-app-restructure","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
  AS SELECT * FROM TABLE(FLEET_APP.FLEET_OPS.F_VW_ASSET_ATTRIBUTES_SCOPED(CAST(NULL AS VARCHAR), CAST(NULL AS VARCHAR)));

GRANT SELECT ON ALL VIEWS IN SCHEMA FLEET_APP.FLEET_OPS TO ROLE FLEET_APP_USER;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA FLEET_APP.FLEET_OPS TO ROLE FLEET_APP_USER;
GRANT SELECT ON ALL VIEWS IN SCHEMA FLEET_APP.FLEET_OPS TO ROLE FLEET_APP_OPS;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA FLEET_APP.FLEET_OPS TO ROLE FLEET_APP_OPS;
GRANT SELECT ON ALL VIEWS IN SCHEMA FLEET_APP.FLEET_OPS TO ROLE FLEET_APP_ADMIN;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA FLEET_APP.FLEET_OPS TO ROLE FLEET_APP_ADMIN;

-- ============================================================================
-- FLEET_APP.CORE - the NEUTRAL, industry/vehicle-agnostic data contract (R-agnostic)
-- ============================================================================
-- Implements the agnostic-view report's neutral schema (report section 6.2) as an
-- ADDITIVE aliasing layer: no physical table is renamed. Every entity below is a
-- thin projection over the guaranteed-present FLEET_APP.UNIFIED_FLEET.F_VW_*_SCOPED
-- contract functions, re-expressed in NEUTRAL vocabulary so a domain swap is a
-- config change (labels/units/icons), never a SQL edit:
--   physical            neutral
--   VEHICLE_ID      ->  entity_id        (mobile_asset)
--   DRIVER_ID       ->  operator_id
--   LOCATION_ID     ->  site_id
--   TRIP_ID         ->  journey_id
--   SCHEDULE_ID     ->  plan_id / work_item_id / stop_id
--   telemetry ping  ->  fact_position
--   safety flag     ->  fact_event
-- Same pattern as FLEET_OPS: a scoped UDTF F_<ENTITY>_SCOPED(region, dataset_id)
-- plus a global-active VW_<ENTITY> wrapper (NULL args) for surfacing-gate probes and
-- Cortex Analyst semantic views. Mirrored into the control-app boot (init.ts
-- ensureScopedDatasetContract) for new-deployment-first.
--
-- Scope (Phase 1): the always-present neutral core derived from trips, telemetry,
-- POIs, fleet, and schedule. fact_alert (SLA) and a dwell-backed fact_stop are
-- provided by the dwell pack contract (FLEET_APP.DWELL.*) when installed and are
-- cross-linked, not duplicated here.
-- ============================================================================
CREATE SCHEMA IF NOT EXISTS FLEET_APP.CORE
  COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-agnostic-contract","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"neutral-data-contract"}}';

-- ---------------------------------------------------------------------------
-- dim_metric_definition - neutral KPI vocabulary (report section 3.2). Static seed
-- table: metric_name + display label key + unit + thresholds + direction. The UI
-- config resolver (Phase 2) reads display_label_key/unit_code/thresholds so the
-- same metric renders with domain-appropriate label/units without code edits.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FLEET_APP.CORE.DIM_METRIC_DEFINITION (
  METRIC_NAME VARCHAR, DISPLAY_LABEL_KEY VARCHAR, UNIT_CODE VARCHAR, AGGREGATION_METHOD VARCHAR,
  GOOD_THRESHOLD FLOAT, WARN_THRESHOLD FLOAT, CRITICAL_THRESHOLD FLOAT, HIGHER_IS_BETTER_FLAG BOOLEAN
)
COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-agnostic-contract","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- Idempotent seed (truncate+insert) of the report's canonical neutral KPI set.
DELETE FROM FLEET_APP.CORE.DIM_METRIC_DEFINITION;
INSERT INTO FLEET_APP.CORE.DIM_METRIC_DEFINITION
  (METRIC_NAME, DISPLAY_LABEL_KEY, UNIT_CODE, AGGREGATION_METHOD, GOOD_THRESHOLD, WARN_THRESHOLD, CRITICAL_THRESHOLD, HIGHER_IS_BETTER_FLAG)
VALUES
  ('idle_duration','metric.idle_duration','sec','avg',900,1800,3600,FALSE),
  ('dwell_duration','metric.dwell_duration','sec','avg',1800,3600,7200,FALSE),
  ('service_duration','metric.service_duration','sec','avg',NULL,NULL,NULL,FALSE),
  ('wait_duration','metric.wait_duration','sec','avg',600,1800,3600,FALSE),
  ('utilization_pct','metric.utilization_pct','pct','avg',0.85,0.65,0.50,TRUE),
  ('availability_pct','metric.availability_pct','pct','avg',0.90,0.75,0.60,TRUE),
  ('on_time_pct','metric.on_time_pct','pct','avg',0.95,0.85,0.75,TRUE),
  ('eta_variance','metric.eta_variance','sec','avg',300,900,1800,FALSE),
  ('route_adherence_pct','metric.route_adherence_pct','pct','avg',0.95,0.85,0.70,TRUE),
  ('deviation_distance','metric.deviation_distance','m','sum',500,2000,5000,FALSE),
  ('empty_distance_pct','metric.empty_distance_pct','pct','avg',0.15,0.30,0.45,FALSE),
  ('events_per_100_units','metric.events_per_100_units','count','avg',1,3,5,FALSE),
  ('cost_per_unit','metric.cost_per_unit','currency','avg',NULL,NULL,NULL,FALSE),
  ('detention_cost','metric.detention_cost','currency','sum',NULL,NULL,NULL,FALSE),
  ('site_throughput','metric.site_throughput','count','sum',NULL,NULL,NULL,TRUE),
  ('turn_time','metric.turn_time','sec','avg',1800,3600,7200,FALSE),
  ('health_open_issue_count','metric.health_open_issue_count','count','sum',0,2,5,FALSE),
  ('safety_score','metric.safety_score','score','avg',80,60,40,TRUE),
  ('tracking_quality_pct','metric.tracking_quality_pct','pct','avg',0.95,0.85,0.70,TRUE);

-- ---------------------------------------------------------------------------
-- dim_entity (mobile_asset) <- DIM_FLEET. capacity_json unions sparse mode attrs.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION FLEET_APP.CORE.F_DIM_ENTITY_SCOPED(P_REGION VARCHAR, P_DATASET_ID VARCHAR)
RETURNS TABLE (
  ENTITY_ID VARCHAR, ENTITY_TYPE VARCHAR, ENTITY_LABEL VARCHAR, ENTITY_GROUP_ID VARCHAR,
  CAPACITY_JSON VARIANT, HOME_SITE_ID VARCHAR, STATUS_ENUM VARCHAR, ICON_KEY VARCHAR, REGION VARCHAR
)
COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-agnostic-contract","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  SELECT VEHICLE_ID AS ENTITY_ID, VEHICLE_TYPE AS ENTITY_TYPE, VEHICLE_ID AS ENTITY_LABEL,
         OPERATING_MODE AS ENTITY_GROUP_ID,
         OBJECT_CONSTRUCT('weight_tons', WEIGHT_TONS, 'height_m', HEIGHT_M, 'length_m', LENGTH_M,
                          'width_m', WIDTH_M, 'axleload_t', AXLELOAD_T, 'battery_range_km', BATTERY_RANGE_KM,
                          'hazmat', HAZMAT, 'subtype', VEHICLE_SUBTYPE)::VARIANT AS CAPACITY_JSON,
         HOME_LOCATION_ID AS HOME_SITE_ID,
         CAST(NULL AS VARCHAR) AS STATUS_ENUM,
         VEHICLE_TYPE AS ICON_KEY,
         REGION
  FROM TABLE(FLEET_APP.UNIFIED_FLEET.F_VW_DIM_FLEET_SCOPED(P_REGION, P_DATASET_ID))
$$;

-- ---------------------------------------------------------------------------
-- dim_operator <- distinct operators on trips, enriched with fleet profile.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION FLEET_APP.CORE.F_DIM_OPERATOR_SCOPED(P_REGION VARCHAR, P_DATASET_ID VARCHAR)
RETURNS TABLE (
  OPERATOR_ID VARCHAR, OPERATOR_TYPE VARCHAR, OPERATOR_LABEL VARCHAR, TEAM_ID VARCHAR,
  HOME_SITE_ID VARCHAR, REGION VARCHAR
)
COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-agnostic-contract","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH t AS (
    SELECT DRIVER_ID, VEHICLE_ID, REGION,
           ROW_NUMBER() OVER (PARTITION BY DRIVER_ID ORDER BY TRIP_START) AS RN
    FROM TABLE(FLEET_APP.UNIFIED_FLEET.F_VW_FACT_TRIPS_SCOPED(P_REGION, P_DATASET_ID))
  ),
  f AS (
    SELECT VEHICLE_ID, DRIVER_PROFILE, HOME_LOCATION_ID,
           ROW_NUMBER() OVER (PARTITION BY VEHICLE_ID ORDER BY DRIVER_PROFILE) AS RN
    FROM TABLE(FLEET_APP.UNIFIED_FLEET.F_VW_DIM_FLEET_SCOPED(P_REGION, P_DATASET_ID))
  )
  SELECT t.DRIVER_ID AS OPERATOR_ID,
         ANY_VALUE(f.DRIVER_PROFILE) AS OPERATOR_TYPE,
         t.DRIVER_ID AS OPERATOR_LABEL,
         CAST(NULL AS VARCHAR) AS TEAM_ID,
         ANY_VALUE(f.HOME_LOCATION_ID) AS HOME_SITE_ID,
         ANY_VALUE(t.REGION) AS REGION
  FROM t
  LEFT JOIN f ON t.VEHICLE_ID = f.VEHICLE_ID AND f.RN = 1
  WHERE t.RN = 1
  GROUP BY t.DRIVER_ID
$$;

-- ---------------------------------------------------------------------------
-- dim_site <- DIM_POIS. geofence_geog NULL (point POIs); category preserved.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION FLEET_APP.CORE.F_DIM_SITE_SCOPED(P_REGION VARCHAR, P_DATASET_ID VARCHAR)
RETURNS TABLE (
  SITE_ID VARCHAR, SITE_TYPE VARCHAR, SITE_LABEL VARCHAR, SITE_CATEGORY VARCHAR,
  SITE_GEOG GEOGRAPHY, GEOFENCE_GEOG GEOGRAPHY, REGION VARCHAR
)
COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-agnostic-contract","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  SELECT LOCATION_ID AS SITE_ID, LOCATION_TYPE AS SITE_TYPE, NAME AS SITE_LABEL, CATEGORY AS SITE_CATEGORY,
         POINT_GEOM AS SITE_GEOG, TO_GEOGRAPHY(NULL) AS GEOFENCE_GEOG, REGION
  FROM TABLE(FLEET_APP.UNIFIED_FLEET.F_VW_DIM_POIS_SCOPED(P_REGION, P_DATASET_ID))
$$;

-- ---------------------------------------------------------------------------
-- dim_plan <- DIM_TRIP_SCHEDULE. Planned movement for plan-vs-actual + dispatch.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION FLEET_APP.CORE.F_DIM_PLAN_SCOPED(P_REGION VARCHAR, P_DATASET_ID VARCHAR)
RETURNS TABLE (
  PLAN_ID VARCHAR, PLAN_TYPE VARCHAR, PLAN_LABEL VARCHAR, ENTITY_ID VARCHAR, OPERATOR_ID VARCHAR,
  ORIGIN_SITE_ID VARCHAR, DESTINATION_SITE_ID VARCHAR, PLANNED_START_TS TIMESTAMP_NTZ,
  PLANNED_END_TS TIMESTAMP_NTZ, PLANNED_DISTANCE_VALUE FLOAT, PLANNED_DURATION_SEC FLOAT,
  PLAN_DATE DATE, SEQUENCE_NUM NUMBER, STATUS_ENUM VARCHAR, REGION VARCHAR
)
COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-agnostic-contract","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  SELECT SCHEDULE_ID AS PLAN_ID, 'route_plan' AS PLAN_TYPE, SCHEDULE_ID AS PLAN_LABEL,
         VEHICLE_ID AS ENTITY_ID, DRIVER_ID AS OPERATOR_ID,
         ORIGIN_POI_ID AS ORIGIN_SITE_ID, DESTINATION_POI_ID AS DESTINATION_SITE_ID,
         PLANNED_START AS PLANNED_START_TS, PLANNED_END AS PLANNED_END_TS,
         DISTANCE_KM AS PLANNED_DISTANCE_VALUE, DURATION_MINUTES * 60 AS PLANNED_DURATION_SEC,
         TRIP_DATE AS PLAN_DATE, TRIP_SEQ AS SEQUENCE_NUM, STATUS AS STATUS_ENUM, REGION
  FROM TABLE(FLEET_APP.UNIFIED_FLEET.F_VW_DIM_TRIP_SCHEDULE_SCOPED(P_REGION, P_DATASET_ID))
$$;

-- ---------------------------------------------------------------------------
-- fact_journey <- FACT_TRIPS. Actual + planned path for plan-vs-actual.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION FLEET_APP.CORE.F_FACT_JOURNEY_SCOPED(P_REGION VARCHAR, P_DATASET_ID VARCHAR)
RETURNS TABLE (
  JOURNEY_ID VARCHAR, ENTITY_ID VARCHAR, OPERATOR_ID VARCHAR, ENTITY_TYPE VARCHAR,
  ORIGIN_SITE_ID VARCHAR, DESTINATION_SITE_ID VARCHAR, START_TS TIMESTAMP_NTZ, END_TS TIMESTAMP_NTZ,
  ACTUAL_PATH_GEOG GEOGRAPHY, PLANNED_PATH_GEOG GEOGRAPHY, ORIGIN GEOGRAPHY, DESTINATION GEOGRAPHY,
  STATUS_ENUM VARCHAR, DISTANCE_VALUE FLOAT, PLANNED_DISTANCE_VALUE FLOAT, DURATION_SEC FLOAT,
  IS_DEVIATION BOOLEAN, DEVIATION_DISTANCE_VALUE FLOAT, REGION VARCHAR
)
COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-agnostic-contract","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  SELECT TRIP_ID AS JOURNEY_ID, VEHICLE_ID AS ENTITY_ID, DRIVER_ID AS OPERATOR_ID, VEHICLE_TYPE AS ENTITY_TYPE,
         ORIGIN_POI_ID AS ORIGIN_SITE_ID, DESTINATION_POI_ID AS DESTINATION_SITE_ID,
         TRIP_START AS START_TS, TRIP_END AS END_TS,
         ROUTE_GEOG AS ACTUAL_PATH_GEOG, PLANNED_ROUTE_GEOG AS PLANNED_PATH_GEOG, ORIGIN, DESTINATION,
         STATUS AS STATUS_ENUM, DISTANCE_KM AS DISTANCE_VALUE, PLANNED_DISTANCE_KM AS PLANNED_DISTANCE_VALUE,
         DURATION_MINUTES * 60 AS DURATION_SEC,
         IS_DETOUR AS IS_DEVIATION, DETOUR_DISTANCE_KM AS DEVIATION_DISTANCE_VALUE, REGION
  FROM TABLE(FLEET_APP.UNIFIED_FLEET.F_VW_FACT_TRIPS_SCOPED(P_REGION, P_DATASET_ID))
$$;

-- ---------------------------------------------------------------------------
-- fact_position <- FACT_VEHICLE_TELEMETRY. Raw movement track (journey replay).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION FLEET_APP.CORE.F_FACT_POSITION_SCOPED(P_REGION VARCHAR, P_DATASET_ID VARCHAR)
RETURNS TABLE (
  POSITION_ID VARCHAR, ENTITY_ID VARCHAR, JOURNEY_ID VARCHAR, TS TIMESTAMP_NTZ,
  LOCATION_GEOG GEOGRAPHY, H3_CELL VARCHAR, SPEED_VALUE FLOAT, HEADING_VALUE FLOAT,
  MOTION_STATUS_ENUM VARCHAR, DATA_QUALITY_ENUM VARCHAR, SOURCE_SYSTEM VARCHAR, REGION VARCHAR,
  POSTED_SPEED_VALUE FLOAT, IS_SPEEDING BOOLEAN
)
COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-agnostic-contract","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  SELECT TELEMETRY_ID AS POSITION_ID, VEHICLE_ID AS ENTITY_ID, TRIP_ID AS JOURNEY_ID, TS,
         POINT_GEOM AS LOCATION_GEOG,
         CASE WHEN POINT_GEOM IS NOT NULL THEN H3_POINT_TO_CELL_STRING(POINT_GEOM, 8) END AS H3_CELL,
         SPEED_KMH AS SPEED_VALUE, HEADING_DEG AS HEADING_VALUE, STATUS AS MOTION_STATUS_ENUM,
         CASE WHEN GPS_ACCURACY_M IS NULL THEN NULL WHEN GPS_ACCURACY_M <= 15 THEN 'good'
              WHEN GPS_ACCURACY_M <= 50 THEN 'fair' ELSE 'poor' END AS DATA_QUALITY_ENUM,
         'synthetic' AS SOURCE_SYSTEM, REGION,
         POSTED_SPEED_KMH AS POSTED_SPEED_VALUE, IS_SPEEDING
  FROM TABLE(FLEET_APP.UNIFIED_FLEET.F_VW_FACT_VEHICLE_TELEMETRY_SCOPED(P_REGION, P_DATASET_ID))
$$;

-- ---------------------------------------------------------------------------
-- fact_event <- discrete safety/compliance events derived from telemetry flags.
-- One neutral event row per raised flag (speeding | hos_violation | detour).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION FLEET_APP.CORE.F_FACT_EVENT_SCOPED(P_REGION VARCHAR, P_DATASET_ID VARCHAR)
RETURNS TABLE (
  EVENT_ID VARCHAR, EVENT_TYPE VARCHAR, EVENT_TS TIMESTAMP_NTZ, ENTITY_ID VARCHAR, JOURNEY_ID VARCHAR,
  LOCATION_GEOG GEOGRAPHY, H3_CELL VARCHAR, SEVERITY_ENUM VARCHAR, METRIC_NAME VARCHAR,
  METRIC_VALUE FLOAT, REGION VARCHAR
)
COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-agnostic-contract","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH tel AS (
    SELECT * FROM TABLE(FLEET_APP.UNIFIED_FLEET.F_VW_FACT_VEHICLE_TELEMETRY_SCOPED(P_REGION, P_DATASET_ID))
  )
  SELECT TELEMETRY_ID || '-spd' AS EVENT_ID, 'speeding' AS EVENT_TYPE, TS AS EVENT_TS,
         VEHICLE_ID AS ENTITY_ID, TRIP_ID AS JOURNEY_ID, POINT_GEOM AS LOCATION_GEOG,
         CASE WHEN POINT_GEOM IS NOT NULL THEN H3_POINT_TO_CELL_STRING(POINT_GEOM, 8) END AS H3_CELL,
         CASE WHEN SPEED_KMH - POSTED_SPEED_KMH > 20 THEN 'high'
              WHEN SPEED_KMH - POSTED_SPEED_KMH > 10 THEN 'medium' ELSE 'low' END AS SEVERITY_ENUM,
         'speed_over_limit_kmh' AS METRIC_NAME, SPEED_KMH - POSTED_SPEED_KMH AS METRIC_VALUE, REGION
  FROM tel WHERE IS_SPEEDING = TRUE
  UNION ALL
  SELECT TELEMETRY_ID || '-hos', 'hos_violation', TS, VEHICLE_ID, TRIP_ID, POINT_GEOM,
         CASE WHEN POINT_GEOM IS NOT NULL THEN H3_POINT_TO_CELL_STRING(POINT_GEOM, 8) END,
         'high', 'hos_violation', 1, REGION
  FROM tel WHERE IS_HOS_VIOLATION = TRUE
  UNION ALL
  SELECT TELEMETRY_ID || '-dtr', 'detour', TS, VEHICLE_ID, TRIP_ID, POINT_GEOM,
         CASE WHEN POINT_GEOM IS NOT NULL THEN H3_POINT_TO_CELL_STRING(POINT_GEOM, 8) END,
         'medium', 'detour', 1, REGION
  FROM tel WHERE IS_DETOUR = TRUE
$$;

-- ---------------------------------------------------------------------------
-- fact_area_metric <- H3 + hour aggregation of telemetry (space-time density).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION FLEET_APP.CORE.F_FACT_AREA_METRIC_SCOPED(P_REGION VARCHAR, P_DATASET_ID VARCHAR, P_H3_RES NUMBER)
RETURNS TABLE (
  H3_CELL VARCHAR, TS_BUCKET NUMBER, METRIC_NAME VARCHAR, METRIC_VALUE FLOAT,
  EVENT_COUNT NUMBER, UNIQUE_ENTITY_COUNT NUMBER, REGION VARCHAR
)
COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-agnostic-contract","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  SELECT H3_POINT_TO_CELL_STRING(POINT_GEOM, COALESCE(P_H3_RES, 7)) AS H3_CELL,
         EXTRACT(HOUR FROM TS) AS TS_BUCKET, 'ping_count' AS METRIC_NAME, COUNT(*)::FLOAT AS METRIC_VALUE,
         COUNT(*) AS EVENT_COUNT, COUNT(DISTINCT VEHICLE_ID) AS UNIQUE_ENTITY_COUNT, ANY_VALUE(REGION) AS REGION
  FROM TABLE(FLEET_APP.UNIFIED_FLEET.F_VW_FACT_VEHICLE_TELEMETRY_SCOPED(P_REGION, P_DATASET_ID))
  WHERE POINT_GEOM IS NOT NULL
  GROUP BY 1, 2
$$;

-- ---------------------------------------------------------------------------
-- fact_work_item <- DIM_TRIP_SCHEDULE. Planned assignable units (dispatch board).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION FLEET_APP.CORE.F_FACT_WORK_ITEM_SCOPED(P_REGION VARCHAR, P_DATASET_ID VARCHAR)
RETURNS TABLE (
  WORK_ITEM_ID VARCHAR, WORK_ITEM_TYPE VARCHAR, ENTITY_ID VARCHAR, OPERATOR_ID VARCHAR,
  ORIGIN_SITE_ID VARCHAR, DESTINATION_SITE_ID VARCHAR, REQUESTED_START_TS TIMESTAMP_NTZ,
  REQUESTED_END_TS TIMESTAMP_NTZ, SEQUENCE_NUM NUMBER, STATUS_ENUM VARCHAR, REGION VARCHAR
)
COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-agnostic-contract","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  SELECT SCHEDULE_ID AS WORK_ITEM_ID, 'scheduled_trip' AS WORK_ITEM_TYPE, VEHICLE_ID AS ENTITY_ID,
         DRIVER_ID AS OPERATOR_ID, ORIGIN_POI_ID AS ORIGIN_SITE_ID, DESTINATION_POI_ID AS DESTINATION_SITE_ID,
         PLANNED_START AS REQUESTED_START_TS, PLANNED_END AS REQUESTED_END_TS, TRIP_SEQ AS SEQUENCE_NUM,
         STATUS AS STATUS_ENUM, REGION
  FROM TABLE(FLEET_APP.UNIFIED_FLEET.F_VW_DIM_TRIP_SCHEDULE_SCOPED(P_REGION, P_DATASET_ID))
$$;

-- ---------------------------------------------------------------------------
-- fact_stop <- planned stop grain from DIM_TRIP_SCHEDULE (always present). A
-- richer dwell-backed fact_stop (arrival/departure/dwell/service/wait) is provided
-- by the dwell pack (FLEET_APP.DWELL.VW_DWELL_SESSIONS) when installed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION FLEET_APP.CORE.F_FACT_STOP_SCOPED(P_REGION VARCHAR, P_DATASET_ID VARCHAR)
RETURNS TABLE (
  STOP_ID VARCHAR, JOURNEY_ID VARCHAR, ENTITY_ID VARCHAR, SITE_ID VARCHAR, ARRIVAL_TS TIMESTAMP_NTZ,
  DEPARTURE_TS TIMESTAMP_NTZ, DWELL_DURATION_SEC FLOAT, WAIT_DURATION_SEC FLOAT, SERVICE_DURATION_SEC FLOAT,
  SEQUENCE_NUM NUMBER, SLA_STATUS_ENUM VARCHAR, STOP_GRAIN VARCHAR, REGION VARCHAR
)
COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-agnostic-contract","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  SELECT SCHEDULE_ID || '-dest' AS STOP_ID, CAST(NULL AS VARCHAR) AS JOURNEY_ID, VEHICLE_ID AS ENTITY_ID,
         DESTINATION_POI_ID AS SITE_ID, PLANNED_END AS ARRIVAL_TS, CAST(NULL AS TIMESTAMP_NTZ) AS DEPARTURE_TS,
         CAST(NULL AS FLOAT) AS DWELL_DURATION_SEC, CAST(NULL AS FLOAT) AS WAIT_DURATION_SEC,
         CAST(NULL AS FLOAT) AS SERVICE_DURATION_SEC, TRIP_SEQ AS SEQUENCE_NUM,
         CAST(NULL AS VARCHAR) AS SLA_STATUS_ENUM, 'planned' AS STOP_GRAIN, REGION
  FROM TABLE(FLEET_APP.UNIFIED_FLEET.F_VW_DIM_TRIP_SCHEDULE_SCOPED(P_REGION, P_DATASET_ID))
$$;

-- ---------------------------------------------------------------------------
-- Global-active VIEWS (NULL scope) over each neutral UDTF: surfacing-gate probes
-- + Cortex Analyst semantic views. Dashboards use the F_*_SCOPED UDTFs per-session.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW FLEET_APP.CORE.VW_DIM_ENTITY
  COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-agnostic-contract","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
  AS SELECT * FROM TABLE(FLEET_APP.CORE.F_DIM_ENTITY_SCOPED(CAST(NULL AS VARCHAR), CAST(NULL AS VARCHAR)));
CREATE OR REPLACE VIEW FLEET_APP.CORE.VW_DIM_OPERATOR
  COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-agnostic-contract","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
  AS SELECT * FROM TABLE(FLEET_APP.CORE.F_DIM_OPERATOR_SCOPED(CAST(NULL AS VARCHAR), CAST(NULL AS VARCHAR)));
CREATE OR REPLACE VIEW FLEET_APP.CORE.VW_DIM_SITE
  COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-agnostic-contract","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
  AS SELECT * FROM TABLE(FLEET_APP.CORE.F_DIM_SITE_SCOPED(CAST(NULL AS VARCHAR), CAST(NULL AS VARCHAR)));
CREATE OR REPLACE VIEW FLEET_APP.CORE.VW_DIM_PLAN
  COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-agnostic-contract","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
  AS SELECT * FROM TABLE(FLEET_APP.CORE.F_DIM_PLAN_SCOPED(CAST(NULL AS VARCHAR), CAST(NULL AS VARCHAR)));
CREATE OR REPLACE VIEW FLEET_APP.CORE.VW_FACT_JOURNEY
  COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-agnostic-contract","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
  AS SELECT * FROM TABLE(FLEET_APP.CORE.F_FACT_JOURNEY_SCOPED(CAST(NULL AS VARCHAR), CAST(NULL AS VARCHAR)));
CREATE OR REPLACE VIEW FLEET_APP.CORE.VW_FACT_POSITION
  COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-agnostic-contract","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
  AS SELECT * FROM TABLE(FLEET_APP.CORE.F_FACT_POSITION_SCOPED(CAST(NULL AS VARCHAR), CAST(NULL AS VARCHAR)));
CREATE OR REPLACE VIEW FLEET_APP.CORE.VW_FACT_EVENT
  COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-agnostic-contract","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
  AS SELECT * FROM TABLE(FLEET_APP.CORE.F_FACT_EVENT_SCOPED(CAST(NULL AS VARCHAR), CAST(NULL AS VARCHAR)));
CREATE OR REPLACE VIEW FLEET_APP.CORE.VW_FACT_AREA_METRIC
  COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-agnostic-contract","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
  AS SELECT * FROM TABLE(FLEET_APP.CORE.F_FACT_AREA_METRIC_SCOPED(CAST(NULL AS VARCHAR), CAST(NULL AS VARCHAR), CAST(NULL AS NUMBER)));
CREATE OR REPLACE VIEW FLEET_APP.CORE.VW_FACT_WORK_ITEM
  COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-agnostic-contract","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
  AS SELECT * FROM TABLE(FLEET_APP.CORE.F_FACT_WORK_ITEM_SCOPED(CAST(NULL AS VARCHAR), CAST(NULL AS VARCHAR)));
CREATE OR REPLACE VIEW FLEET_APP.CORE.VW_FACT_STOP
  COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-agnostic-contract","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
  AS SELECT * FROM TABLE(FLEET_APP.CORE.F_FACT_STOP_SCOPED(CAST(NULL AS VARCHAR), CAST(NULL AS VARCHAR)));

-- ---------------------------------------------------------------------------
-- Grants: neutral CORE contract to the consumer + ops/admin roles.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA FLEET_APP.CORE TO ROLE FLEET_APP_USER;
GRANT USAGE ON SCHEMA FLEET_APP.CORE TO ROLE FLEET_APP_OPS;
GRANT USAGE ON SCHEMA FLEET_APP.CORE TO ROLE FLEET_APP_ADMIN;
GRANT SELECT ON ALL TABLES IN SCHEMA FLEET_APP.CORE TO ROLE FLEET_APP_USER;
GRANT SELECT ON ALL TABLES IN SCHEMA FLEET_APP.CORE TO ROLE FLEET_APP_OPS;
GRANT SELECT ON ALL TABLES IN SCHEMA FLEET_APP.CORE TO ROLE FLEET_APP_ADMIN;
GRANT SELECT ON FUTURE TABLES IN SCHEMA FLEET_APP.CORE TO ROLE FLEET_APP_USER;
GRANT SELECT ON FUTURE TABLES IN SCHEMA FLEET_APP.CORE TO ROLE FLEET_APP_OPS;
GRANT SELECT ON FUTURE TABLES IN SCHEMA FLEET_APP.CORE TO ROLE FLEET_APP_ADMIN;
GRANT SELECT ON ALL VIEWS IN SCHEMA FLEET_APP.CORE TO ROLE FLEET_APP_USER;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA FLEET_APP.CORE TO ROLE FLEET_APP_USER;
GRANT SELECT ON ALL VIEWS IN SCHEMA FLEET_APP.CORE TO ROLE FLEET_APP_OPS;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA FLEET_APP.CORE TO ROLE FLEET_APP_OPS;
GRANT SELECT ON ALL VIEWS IN SCHEMA FLEET_APP.CORE TO ROLE FLEET_APP_ADMIN;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA FLEET_APP.CORE TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON ALL FUNCTIONS IN SCHEMA FLEET_APP.CORE TO ROLE FLEET_APP_USER;
GRANT USAGE ON ALL FUNCTIONS IN SCHEMA FLEET_APP.CORE TO ROLE FLEET_APP_OPS;
GRANT USAGE ON ALL FUNCTIONS IN SCHEMA FLEET_APP.CORE TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUTURE FUNCTIONS IN SCHEMA FLEET_APP.CORE TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUTURE FUNCTIONS IN SCHEMA FLEET_APP.CORE TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUTURE FUNCTIONS IN SCHEMA FLEET_APP.CORE TO ROLE FLEET_APP_ADMIN;

-- ============================================================================
-- FLEET_APP.EMERGENCY_RESPONSE - region-generic evacuation-planning contract
-- ============================================================================
-- Region-scoped, dataset-versioned hazard + care-center contract powering the
-- generic Emergency Response wizard. Replaces the CA/CO/PA-locked
-- EMERGENCY_RESPONSE.PIPELINE.V_ZIP_RISK (ZIP-share) + CORE.CARECONNECT_CENTERS
-- (CSV) with data produced by Data Studio (generates_hazard + generates_anchors)
-- for WHATEVER region is active. Hazard is a procedural sub-county H3 hexagon
-- grid (worldwide); care centers are Overture health anchors.
-- Same scope contract as FLEET_OPS: F_VW_*_SCOPED(P_REGION,P_DATASET_ID) +
-- global-active VW_* wrappers (NULL args). Source of truth: this file.
-- ============================================================================
CREATE SCHEMA IF NOT EXISTS FLEET_APP.EMERGENCY_RESPONSE
  COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":2,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"emergency-response-contract"}}';

-- Per-cell hazard, pivoted to one row per H3 hexagon (wildfire/flood/composite)
-- with the hexagon polygon as GeoJSON for the choropleth. FACT_HAZARD_ZONES is
-- region-keyed (no VEHICLE_TYPE), so the dataset join mirrors DIM_POIS.
CREATE OR REPLACE FUNCTION FLEET_APP.EMERGENCY_RESPONSE.F_VW_HAZARD_ZONES_SCOPED(P_REGION VARCHAR, P_DATASET_ID VARCHAR)
RETURNS TABLE (
  REGION VARCHAR, STATE VARCHAR, COUNTY VARCHAR, FIPS VARCHAR, GEOJSON VARCHAR,
  WILDFIRE_LEVEL NUMBER, WILDFIRE_LABEL VARCHAR, FLOOD_LEVEL NUMBER, FLOOD_LABEL VARCHAR,
  COMPOSITE_SCORE FLOAT, COMPOSITE_RATING VARCHAR
)
COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":2,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  SELECT h.REGION,
         ANY_VALUE(h.STATE)  AS STATE,
         ANY_VALUE(h.COUNTY) AS COUNTY,
         ANY_VALUE(h.FIPS)   AS FIPS,
         ANY_VALUE(ST_ASGEOJSON(h.GEOM))::STRING AS GEOJSON,
         MAX(CASE WHEN h.HAZARD_TYPE='WILDFIRE'  THEN h.RISK_LEVEL  END) AS WILDFIRE_LEVEL,
         MAX(CASE WHEN h.HAZARD_TYPE='WILDFIRE'  THEN h.RISK_RATING END) AS WILDFIRE_LABEL,
         MAX(CASE WHEN h.HAZARD_TYPE='FLOOD'     THEN h.RISK_LEVEL  END) AS FLOOD_LEVEL,
         MAX(CASE WHEN h.HAZARD_TYPE='FLOOD'     THEN h.RISK_RATING END) AS FLOOD_LABEL,
         MAX(CASE WHEN h.HAZARD_TYPE='COMPOSITE' THEN h.RISK_SCORE  END) AS COMPOSITE_SCORE,
         MAX(CASE WHEN h.HAZARD_TYPE='COMPOSITE' THEN h.RISK_RATING END) AS COMPOSITE_RATING
  FROM SYNTHETIC_DATASETS.UNIFIED.FACT_HAZARD_ZONES h
  JOIN FLEET_INTELLIGENCE.CORE.DIM_DATASETS d
    ON d.DATASET_ID = h.JOB_ID AND d.REGION = h.REGION
  WHERE (P_REGION IS NULL OR h.REGION = P_REGION)
    AND ( (P_DATASET_ID IS NOT NULL AND d.DATASET_ID = P_DATASET_ID)
          OR (P_DATASET_ID IS NULL AND d.IS_ACTIVE = TRUE) )
  -- Per-zone key = ZONE_ID minus the hazard suffix. Works for both the procedural
  -- H3 grid (ZONE_ID = '<h3>-WILDFIRE') and legacy county data ('<fips>-WILDFIRE').
  GROUP BY h.REGION, SPLIT_PART(h.ZONE_ID,'-',1)
$$;

-- Care centers = Overture health anchors for the active region/dataset. Column
-- names mirror the retired CARECONNECT_CENTERS so the wizard maps cleanly.
CREATE OR REPLACE FUNCTION FLEET_APP.EMERGENCY_RESPONSE.F_VW_CARE_CENTERS_SCOPED(P_REGION VARCHAR, P_DATASET_ID VARCHAR)
RETURNS TABLE (
  CENTER_ID VARCHAR, CENTER_NAME VARCHAR, REGION VARCHAR, CATEGORY VARCHAR,
  LON FLOAT, LAT FLOAT, LOC GEOGRAPHY, ADDRESS VARCHAR, CITY VARCHAR, STATE VARCHAR, POSTAL_CODE VARCHAR
)
COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":2,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  SELECT a.ANCHOR_ID, a.NAME, a.REGION, a.CATEGORY,
         a.LNG, a.LAT, a.GEOM, a.ADDRESS, a.CITY, a.STATE, a.POSTCODE
  FROM SYNTHETIC_DATASETS.UNIFIED.DIM_ANCHORS a
  JOIN FLEET_INTELLIGENCE.CORE.DIM_DATASETS d
    ON d.DATASET_ID = a.JOB_ID AND d.REGION = a.REGION
  WHERE a.ANCHOR_TYPE = 'HEALTH_FACILITY'
    AND (P_REGION IS NULL OR a.REGION = P_REGION)
    AND ( (P_DATASET_ID IS NOT NULL AND d.DATASET_ID = P_DATASET_ID)
          OR (P_DATASET_ID IS NULL AND d.IS_ACTIVE = TRUE) )
$$;

-- Global-active views (NULL scope args) - surfacing-gate probe + agent default.
CREATE OR REPLACE VIEW FLEET_APP.EMERGENCY_RESPONSE.VW_HAZARD_ZONES
  COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":2,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
  AS SELECT * FROM TABLE(FLEET_APP.EMERGENCY_RESPONSE.F_VW_HAZARD_ZONES_SCOPED(CAST(NULL AS VARCHAR), CAST(NULL AS VARCHAR)));
CREATE OR REPLACE VIEW FLEET_APP.EMERGENCY_RESPONSE.VW_CARE_CENTERS
  COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":2,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
  AS SELECT * FROM TABLE(FLEET_APP.EMERGENCY_RESPONSE.F_VW_CARE_CENTERS_SCOPED(CAST(NULL AS VARCHAR), CAST(NULL AS VARCHAR)));

-- Participants: the raw 50km Overture-address sample generated by Data Studio
-- around the HEALTH_FACILITY anchors. The wizard's isochrone step filters this.
CREATE OR REPLACE FUNCTION FLEET_APP.EMERGENCY_RESPONSE.F_VW_PARTICIPANTS_SCOPED(P_REGION VARCHAR, P_DATASET_ID VARCHAR)
RETURNS TABLE (
  PARTICIPANT_ID VARCHAR, REGION VARCHAR,
  LON FLOAT, LAT FLOAT, LOC GEOGRAPHY,
  ADDRESS VARCHAR, CITY VARCHAR, STATE VARCHAR, POSTAL_CODE VARCHAR,
  NEAREST_CENTER_ID VARCHAR
)
COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":2,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  SELECT p.PARTICIPANT_ID, p.REGION,
         p.LNG, p.LAT, p.GEOM, p.ADDRESS, p.CITY, p.STATE, p.POSTCODE,
         p.NEAREST_ANCHOR_ID
  FROM SYNTHETIC_DATASETS.UNIFIED.DIM_PARTICIPANTS p
  JOIN FLEET_INTELLIGENCE.CORE.DIM_DATASETS d
    ON d.DATASET_ID = p.JOB_ID AND d.REGION = p.REGION
  WHERE (P_REGION IS NULL OR p.REGION = P_REGION)
    AND ( (P_DATASET_ID IS NOT NULL AND d.DATASET_ID = P_DATASET_ID)
          OR (P_DATASET_ID IS NULL AND d.IS_ACTIVE = TRUE) )
$$;

CREATE OR REPLACE VIEW FLEET_APP.EMERGENCY_RESPONSE.VW_PARTICIPANTS
  COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":2,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
  AS SELECT * FROM TABLE(FLEET_APP.EMERGENCY_RESPONSE.F_VW_PARTICIPANTS_SCOPED(CAST(NULL AS VARCHAR), CAST(NULL AS VARCHAR)));

-- Grants: EMERGENCY_RESPONSE schema + UDTFs + views to consumer/ops/admin roles.
GRANT USAGE ON SCHEMA FLEET_APP.EMERGENCY_RESPONSE TO ROLE FLEET_APP_USER;
GRANT USAGE ON SCHEMA FLEET_APP.EMERGENCY_RESPONSE TO ROLE FLEET_APP_OPS;
GRANT USAGE ON SCHEMA FLEET_APP.EMERGENCY_RESPONSE TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON ALL FUNCTIONS IN SCHEMA FLEET_APP.EMERGENCY_RESPONSE TO ROLE FLEET_APP_USER;
GRANT USAGE ON ALL FUNCTIONS IN SCHEMA FLEET_APP.EMERGENCY_RESPONSE TO ROLE FLEET_APP_OPS;
GRANT USAGE ON ALL FUNCTIONS IN SCHEMA FLEET_APP.EMERGENCY_RESPONSE TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUTURE FUNCTIONS IN SCHEMA FLEET_APP.EMERGENCY_RESPONSE TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUTURE FUNCTIONS IN SCHEMA FLEET_APP.EMERGENCY_RESPONSE TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUTURE FUNCTIONS IN SCHEMA FLEET_APP.EMERGENCY_RESPONSE TO ROLE FLEET_APP_ADMIN;
GRANT SELECT ON ALL VIEWS IN SCHEMA FLEET_APP.EMERGENCY_RESPONSE TO ROLE FLEET_APP_USER;
GRANT SELECT ON ALL VIEWS IN SCHEMA FLEET_APP.EMERGENCY_RESPONSE TO ROLE FLEET_APP_OPS;
GRANT SELECT ON ALL VIEWS IN SCHEMA FLEET_APP.EMERGENCY_RESPONSE TO ROLE FLEET_APP_ADMIN;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA FLEET_APP.EMERGENCY_RESPONSE TO ROLE FLEET_APP_USER;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA FLEET_APP.EMERGENCY_RESPONSE TO ROLE FLEET_APP_OPS;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA FLEET_APP.EMERGENCY_RESPONSE TO ROLE FLEET_APP_ADMIN;
