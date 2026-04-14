/*
 * seed-data.sql — Dwell Analysis
 * Creates projection views over SYNTHETIC_DATASETS.UNIFIED tables,
 * computes GEOFENCE_POLYGONS from views, and inserts SLA_THRESHOLDS inline.
 * Dynamic Tables must be created separately (see sql-pipeline.sql Steps 5-13).
 * Source data is loaded by build-routing-solution Step 8 (datasets/ seed).
 * No S3 external stages — all data comes from UNIFIED.
 */

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-dwell-analysis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE DATABASE IF NOT EXISTS FLEET_INTELLIGENCE
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-dwell-analysis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-dwell-analysis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

--------------------------------------------------------------------
-- CONFIG
--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.CONFIG (
    VEHICLE_TYPE VARCHAR NOT NULL,
    REGION       VARCHAR NOT NULL
)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-dwell-analysis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
MERGE INTO FLEET_INTELLIGENCE.DWELL_ANALYSIS.CONFIG tgt
USING (SELECT 'ebike' AS VEHICLE_TYPE, 'SanFrancisco' AS REGION) src
ON TRUE
WHEN NOT MATCHED THEN INSERT (VEHICLE_TYPE, REGION) VALUES (src.VEHICLE_TYPE, src.REGION);

--------------------------------------------------------------------
-- PROJECTION VIEWS
--------------------------------------------------------------------
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.DWELL_ANALYSIS.VW_VEHICLE_TELEMETRY
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-dwell-analysis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT
    t.TELEMETRY_ID, t.VEHICLE_ID, t.TRIP_ID, t.TS,
    t.SPEED_KMH, t.HEADING_DEG, t.GPS_ACCURACY_M,
    CASE
        WHEN t.STATUS = 'DWELL_ORIGIN' AND t.LOCATION_TYPE IN ('WAREHOUSE', 'LOGISTICS') THEN 'DWELL_WAREHOUSE'
        WHEN t.STATUS = 'DWELL_ORIGIN' AND t.LOCATION_TYPE IN ('RESTAURANT', 'STORE', 'ADDRESS') THEN 'DWELL_STORE'
        WHEN t.STATUS = 'DWELL_ORIGIN' THEN 'DWELL_DESTINATION'
        WHEN t.STATUS = 'DWELL_REST' THEN 'DWELL_REST_STOP'
        WHEN t.STATUS = 'DWELL_RECHARGE' THEN 'DWELL_REST_STOP'
        WHEN t.STATUS = 'DWELL_DETOUR' THEN 'DWELL_DETOUR'
        ELSE t.STATUS
    END AS STATUS,
    t.IS_SPEEDING, t.IS_HOS_VIOLATION, t.IS_DETOUR,
    t.LOCATION_ID, t.LOCATION_TYPE, t.POINT_INDEX, t.ODOMETER_KM,
    t.POINT_GEOM, t.VEHICLE_TYPE, t.REGION
FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY t
WHERE t.VEHICLE_TYPE = (SELECT VEHICLE_TYPE FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.CONFIG LIMIT 1)
  AND t.REGION = (SELECT REGION FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.CONFIG LIMIT 1)
QUALIFY ROW_NUMBER() OVER (PARTITION BY t.TELEMETRY_ID ORDER BY t.TS) = 1;

CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.DWELL_ANALYSIS.VW_VEHICLE_FLEET
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-dwell-analysis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT
    f.VEHICLE_ID, f.HOME_LOCATION_ID AS HOME_BASE_ID,
    f.DRIVER_PROFILE, f.OPERATING_MODE, f.SHIFT_TYPE, f.BASE_SPEED_KMH,
    f.VEHICLE_TYPE, f.REGION, f.REGION AS HOME_BASE_NAME
FROM SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET f
WHERE f.VEHICLE_TYPE = (SELECT VEHICLE_TYPE FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.CONFIG LIMIT 1)
  AND f.REGION = (SELECT REGION FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.CONFIG LIMIT 1)
QUALIFY ROW_NUMBER() OVER (PARTITION BY f.VEHICLE_ID ORDER BY f.VEHICLE_ID) = 1;

CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.DWELL_ANALYSIS.VW_DESTINATIONS
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-dwell-analysis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT
    p.LOCATION_ID AS ID, p.NAME, p.LOCATION_TYPE,
    p.CATEGORY AS BASIC_CATEGORY, p.REGION AS CITY,
    p.POINT_GEOM AS GEOMETRY, p.REGION
FROM SYNTHETIC_DATASETS.UNIFIED.DIM_POIS p
WHERE p.LOCATION_TYPE NOT IN ('REST_STOP')
  AND p.REGION = (SELECT REGION FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.CONFIG LIMIT 1)
QUALIFY ROW_NUMBER() OVER (PARTITION BY p.LOCATION_ID ORDER BY p.NAME) = 1;

CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.DWELL_ANALYSIS.VW_REST_STOPS
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-dwell-analysis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT
    p.LOCATION_ID AS REST_STOP_ID, p.NAME,
    p.CATEGORY AS REST_TYPE, p.POINT_GEOM AS CENTER_POINT, p.REGION
FROM SYNTHETIC_DATASETS.UNIFIED.DIM_POIS p
WHERE p.LOCATION_TYPE = 'REST_STOP'
  AND p.REGION = (SELECT REGION FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.CONFIG LIMIT 1)
QUALIFY ROW_NUMBER() OVER (PARTITION BY p.LOCATION_ID ORDER BY p.NAME) = 1;

CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.DWELL_ANALYSIS.VW_TRIP_SCHEDULE
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-dwell-analysis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT
    s.SCHEDULE_ID, s.VEHICLE_ID,
    s.VEHICLE_TYPE AS TRIP_TYPE,
    s.ORIGIN_POI_ID AS ORIGIN_ID,
    s.DESTINATION_POI_ID AS DEST_ID,
    s.SHIFT_TYPE AS ROUTE_VARIATION,
    NULL AS ROUTE_DEVIATION_FACTOR,
    s.DISTANCE_KM * 1000 AS ROUTE_DISTANCE_M,
    s.DURATION_MINUTES * 60 AS ROUTE_DURATION_SEC,
    s.PLANNED_START AS SCHEDULED_START,
    s.ORS_PROFILE, s.REGION
FROM SYNTHETIC_DATASETS.UNIFIED.DIM_TRIP_SCHEDULE s
WHERE s.REGION = (SELECT REGION FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.CONFIG LIMIT 1);

--------------------------------------------------------------------
-- GEOFENCE_POLYGONS (computed from views)
--------------------------------------------------------------------
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.DWELL_ANALYSIS.GEOFENCE_POLYGONS
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-dwell-analysis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT
    ID AS LOCATION_ID, NAME, LOCATION_TYPE, 'DESTINATION' AS SOURCE,
    GEOMETRY AS CENTER_POINT,
    IFF(LOCATION_TYPE = 'WAREHOUSE', 200, 100) AS BUFFER_RADIUS_M
FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.VW_DESTINATIONS
UNION ALL
SELECT
    REST_STOP_ID, NAME, REST_TYPE, 'REST_STOP',
    CENTER_POINT,
    150 AS BUFFER_RADIUS_M
FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.VW_REST_STOPS;

--------------------------------------------------------------------
-- SLA_THRESHOLDS
--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.SLA_THRESHOLDS (
    LOCATION_TYPE    VARCHAR,
    WARNING_MINUTES  NUMBER,
    CRITICAL_MINUTES NUMBER
)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-dwell-analysis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
INSERT INTO FLEET_INTELLIGENCE.DWELL_ANALYSIS.SLA_THRESHOLDS
    (LOCATION_TYPE, WARNING_MINUTES, CRITICAL_MINUTES)
SELECT column1, column2, column3 FROM VALUES
    ('WAREHOUSE', 5, 15),
    ('DESTINATION', 3, 10),
    ('REST_STOP', 5, 12),
    ('STORE', 2, 8),
    ('DETOUR', 2, 5)
WHERE NOT EXISTS (
    SELECT 1 FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.SLA_THRESHOLDS
);

--------------------------------------------------------------------
-- VALIDATION
--------------------------------------------------------------------
SELECT 'CONFIG' AS TBL, COUNT(*) AS ROW_CNT FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.CONFIG
UNION ALL SELECT 'VW_VEHICLE_TELEMETRY', COUNT(*) FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.VW_VEHICLE_TELEMETRY
UNION ALL SELECT 'VW_DESTINATIONS', COUNT(*) FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.VW_DESTINATIONS
UNION ALL SELECT 'GEOFENCE_POLYGONS', COUNT(*) FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.GEOFENCE_POLYGONS
UNION ALL SELECT 'SLA_THRESHOLDS', COUNT(*) FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.SLA_THRESHOLDS;


