-- =============================================================================
-- sap-fleet-connector : bind_sap_source.sql  (Step 6 - repoint the seam)
-- =============================================================================
-- Repoints FLEET_APP.UNIFIED_FLEET.F_VW_*_SCOPED (and the sibling VW_* views) at
-- the SAP source views. SAP is always-live: honor P_REGION, ignore P_DATASET_ID.
-- FLEET_APP.CORE and SV_FLEET_OPS are NOT touched (see references/binding.md).
-- Reversible: re-run install-fleet-apps packs/fleet/unified_fleet/setup.sql.
-- =============================================================================
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-sap-fleet-connector","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","module":"bind"}}';

-- 1. Register one always-live SAP dataset row (keeps the SA dataset picker + grants happy).
DELETE FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS WHERE DATASET_ID = 'sap-live';
INSERT INTO FLEET_INTELLIGENCE.CORE.DIM_DATASETS
  (DATASET_ID, REGION, VEHICLE_TYPE, LABEL, IS_ACTIVE, CREATED_AT, ROW_COUNTS, NOTES)
SELECT 'sap-live', '{{REGION}}', 'asset', 'SAP live (sap-fleet-connector)',
       TRUE, CURRENT_TIMESTAMP(), NULL, 'sap-fleet-connector';

-- 2. Repoint the scoped seam functions at the SAP source views.
--    Body returns SAP rows filtered by P_REGION; P_DATASET_ID is accepted but ignored.
CREATE OR REPLACE FUNCTION FLEET_APP.UNIFIED_FLEET.F_VW_DIM_FLEET_SCOPED(P_REGION VARCHAR, P_DATASET_ID VARCHAR)
RETURNS TABLE (
  VEHICLE_ID VARCHAR, REGION VARCHAR, VEHICLE_TYPE VARCHAR, ORS_PROFILE VARCHAR, SHIFT_TYPE VARCHAR,
  SHIFT_START_HOUR NUMBER, SHIFT_END_HOUR NUMBER, HOME_LOCATION_ID VARCHAR, DRIVER_PROFILE VARCHAR,
  OPERATING_MODE VARCHAR, BASE_SPEED_KMH FLOAT, BATTERY_RANGE_KM FLOAT, JOB_ID VARCHAR,
  WEIGHT_TONS NUMBER(6,2), HEIGHT_M NUMBER(4,2), LENGTH_M NUMBER(4,2), WIDTH_M NUMBER(4,2),
  AXLELOAD_T NUMBER(4,2), HAZMAT BOOLEAN, VEHICLE_SUBTYPE VARCHAR
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-sap-fleet-connector","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS $$ SELECT * FROM SAP_SOURCE.FLEET.SRC_DIM_FLEET WHERE (P_REGION IS NULL OR REGION = P_REGION) $$;

CREATE OR REPLACE FUNCTION FLEET_APP.UNIFIED_FLEET.F_VW_DIM_POIS_SCOPED(P_REGION VARCHAR, P_DATASET_ID VARCHAR)
RETURNS TABLE (
  LOCATION_ID VARCHAR, REGION VARCHAR, NAME VARCHAR, LOCATION_TYPE VARCHAR, CATEGORY VARCHAR,
  LAT FLOAT, LNG FLOAT, POINT_GEOM GEOGRAPHY, SOURCE VARCHAR, JOB_ID VARCHAR
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-sap-fleet-connector","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS $$ SELECT * FROM SAP_SOURCE.FLEET.SRC_DIM_POIS WHERE (P_REGION IS NULL OR REGION = P_REGION) $$;

CREATE OR REPLACE FUNCTION FLEET_APP.UNIFIED_FLEET.F_VW_FACT_VEHICLE_TELEMETRY_SCOPED(P_REGION VARCHAR, P_DATASET_ID VARCHAR)
RETURNS TABLE (
  TELEMETRY_ID VARCHAR, REGION VARCHAR, VEHICLE_TYPE VARCHAR, VEHICLE_ID VARCHAR, TRIP_ID VARCHAR,
  TS TIMESTAMP_NTZ, LATITUDE FLOAT, LONGITUDE FLOAT, POINT_GEOM GEOGRAPHY, SPEED_KMH FLOAT,
  HEADING_DEG FLOAT, POSTED_SPEED_KMH FLOAT, STATUS VARCHAR, IS_SPEEDING BOOLEAN,
  IS_HOS_VIOLATION BOOLEAN, IS_DETOUR BOOLEAN, GPS_ACCURACY_M FLOAT, LOCATION_ID VARCHAR,
  LOCATION_TYPE VARCHAR, ORS_PROFILE VARCHAR, BATTERY_PCT FLOAT, ODOMETER_KM FLOAT,
  POINT_INDEX NUMBER, JOB_ID VARCHAR
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-sap-fleet-connector","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS $$ SELECT * FROM SAP_SOURCE.FLEET.SRC_FACT_VEHICLE_TELEMETRY WHERE (P_REGION IS NULL OR REGION = P_REGION) $$;

CREATE OR REPLACE FUNCTION FLEET_APP.UNIFIED_FLEET.F_VW_FACT_TRIPS_SCOPED(P_REGION VARCHAR, P_DATASET_ID VARCHAR)
RETURNS TABLE (
  TRIP_ID VARCHAR, VEHICLE_ID VARCHAR, DRIVER_ID VARCHAR, VEHICLE_TYPE VARCHAR, REGION VARCHAR,
  ORIGIN_POI_ID VARCHAR, DESTINATION_POI_ID VARCHAR, ORIGIN_LAT FLOAT, ORIGIN_LON FLOAT,
  ORIGIN GEOGRAPHY, DESTINATION_LAT FLOAT, DESTINATION_LON FLOAT, DESTINATION GEOGRAPHY,
  ROUTE_GEOG GEOGRAPHY, DISTANCE_KM FLOAT, DURATION_MINUTES FLOAT, PLANNED_ROUTE_GEOG GEOGRAPHY,
  PLANNED_DISTANCE_KM FLOAT, IS_DETOUR BOOLEAN, DETOUR_DISTANCE_KM FLOAT, TRIP_START TIMESTAMP_NTZ,
  TRIP_END TIMESTAMP_NTZ, STATUS VARCHAR, ORS_PROFILE VARCHAR, TRIP_KIND VARCHAR, JOB_ID VARCHAR
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-sap-fleet-connector","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS $$ SELECT * FROM SAP_SOURCE.FLEET.SRC_FACT_TRIPS WHERE (P_REGION IS NULL OR REGION = P_REGION) $$;

CREATE OR REPLACE FUNCTION FLEET_APP.UNIFIED_FLEET.F_VW_DIM_TRIP_SCHEDULE_SCOPED(P_REGION VARCHAR, P_DATASET_ID VARCHAR)
RETURNS TABLE (
  SCHEDULE_ID VARCHAR, VEHICLE_ID VARCHAR, DRIVER_ID VARCHAR, VEHICLE_TYPE VARCHAR, REGION VARCHAR,
  TRIP_DATE DATE, TRIP_SEQ NUMBER, ORIGIN_POI_ID VARCHAR, DESTINATION_POI_ID VARCHAR,
  PLANNED_START TIMESTAMP_NTZ, PLANNED_END TIMESTAMP_NTZ, SHIFT_TYPE VARCHAR, ORS_PROFILE VARCHAR,
  DISTANCE_KM FLOAT, DURATION_MINUTES FLOAT, STATUS VARCHAR, JOB_ID VARCHAR
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-sap-fleet-connector","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS $$ SELECT * FROM SAP_SOURCE.FLEET.SRC_DIM_TRIP_SCHEDULE WHERE (P_REGION IS NULL OR REGION = P_REGION) $$;

-- 3. Repoint the sibling pass-through views used by FLEET_OPS paths.
CREATE OR REPLACE VIEW FLEET_APP.UNIFIED_FLEET.VW_DIM_FLEET
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-sap-fleet-connector","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS SELECT * FROM SAP_SOURCE.FLEET.SRC_DIM_FLEET;
CREATE OR REPLACE VIEW FLEET_APP.UNIFIED_FLEET.VW_DIM_POIS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-sap-fleet-connector","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS SELECT * FROM SAP_SOURCE.FLEET.SRC_DIM_POIS;
CREATE OR REPLACE VIEW FLEET_APP.UNIFIED_FLEET.VW_FACT_VEHICLE_TELEMETRY
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-sap-fleet-connector","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS SELECT * FROM SAP_SOURCE.FLEET.SRC_FACT_VEHICLE_TELEMETRY;
CREATE OR REPLACE VIEW FLEET_APP.UNIFIED_FLEET.VW_FACT_TRIPS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-sap-fleet-connector","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS SELECT * FROM SAP_SOURCE.FLEET.SRC_FACT_TRIPS;
CREATE OR REPLACE VIEW FLEET_APP.UNIFIED_FLEET.VW_DIM_TRIP_SCHEDULE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-sap-fleet-connector","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS SELECT * FROM SAP_SOURCE.FLEET.SRC_DIM_TRIP_SCHEDULE;

-- 4. Smoke check (read-only): contract now returns SAP-derived rows.
-- SELECT COUNT(*) FROM FLEET_APP.CORE.VW_DIM_ENTITY;
-- SELECT COUNT(*) FROM FLEET_APP.CORE.VW_FACT_POSITION;
