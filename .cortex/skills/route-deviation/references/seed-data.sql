/*
 * seed-data.sql — Route Deviation
 * Creates projection views over SYNTHETIC_DATASETS.UNIFIED for the
 * Route Deviation dashboard in the ORS Control App.
 *
 * Prerequisites:
 *   - SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS with GEOGRAPHY columns (ORIGIN, DESTINATION, ROUTE_GEOG, PLANNED_ROUTE_GEOG)
 *   - SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY with POINT_GEOM (GEOGRAPHY)
 *   - SYNTHETIC_DATASETS.UNIFIED.DIM_POIS
 *   - CONFIG table with VEHICLE_TYPE='ebike', REGION='SanFrancisco'
 *
 * React Component -> Object -> Required Columns:
 *   DeviationDashboard -> TRIP_DEVIATION_ANALYSIS -> TRIP_ID, DISTANCE_DEVIATION_PCT, DRIVER_ID
 *   DeviationDashboard -> DAILY_DEVIATION_TRENDS -> TRIP_DATE, TOTAL_TRIPS, DEVIATION_RATE_PCT
 *   DeviationDashboard -> DRIVER_DEVIATION_SUMMARY -> DRIVER_ID, TOTAL_TRIPS, AVG_DISTANCE_DEVIATION_PCT, AVG_DURATION_DEVIATION_PCT
 *   RouteComparison -> TRIP_DEVIATION_ANALYSIS -> ACTUAL_PATH (GEOGRAPHY), EXPECTED_PATH (GEOGRAPHY), ORIGIN_NAME, DEST_NAME
 *   RouteInspector -> VW_VEHICLE_TELEMETRY -> POINT_GEOM (GEOGRAPHY), SPEED_KMH, IS_DETOUR, IS_SPEEDING, GPS_ACCURACY_M, POSTED_SPEED_KMH
 *   RouteInspector -> TRIP_DEVIATION_ANALYSIS -> VEHICLE_ID, TRIP_DATE, DISTANCE_DEVIATION_PCT, POINT_COUNT
 *
 * Usage:
 *   snow sql -f .cortex/skills/route-deviation/references/seed-data.sql -c <connection>
 */

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-route-deviation","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

--------------------------------------------------------------------
-- Infrastructure
--------------------------------------------------------------------
CREATE DATABASE IF NOT EXISTS FLEET_INTELLIGENCE
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-route-deviation","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_DEVIATION
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-route-deviation","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- CONFIG
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_DEVIATION.CONFIG (
    VEHICLE_TYPE VARCHAR NOT NULL,
    REGION       VARCHAR NOT NULL
)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-route-deviation","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
MERGE INTO FLEET_INTELLIGENCE.ROUTE_DEVIATION.CONFIG tgt
USING (SELECT 'ebike' AS VEHICLE_TYPE, 'SanFrancisco' AS REGION) src
ON TRUE
WHEN NOT MATCHED THEN INSERT (VEHICLE_TYPE, REGION) VALUES (src.VEHICLE_TYPE, src.REGION)
WHEN MATCHED THEN UPDATE SET VEHICLE_TYPE = src.VEHICLE_TYPE, REGION = src.REGION;

--------------------------------------------------------------------
-- VW_VEHICLE_TELEMETRY (RouteInspector GPS points)
-- CRITICAL: Must have POINT_GEOM (GEOGRAPHY) column
--------------------------------------------------------------------
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.ROUTE_DEVIATION.VW_VEHICLE_TELEMETRY
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-route-deviation","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT
    TELEMETRY_ID, VEHICLE_ID, TRIP_ID, TS, STATUS, SPEED_KMH, HEADING_DEG,
    LATITUDE, LONGITUDE, POINT_GEOM, LOCATION_ID, LOCATION_TYPE,
    BATTERY_PCT, ODOMETER_KM, IS_SPEEDING, IS_DETOUR, GPS_ACCURACY_M,
    POSTED_SPEED_KMH, REGION
FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY
WHERE VEHICLE_TYPE = (SELECT VEHICLE_TYPE FROM FLEET_INTELLIGENCE.ROUTE_DEVIATION.CONFIG LIMIT 1)
  AND REGION = (SELECT REGION FROM FLEET_INTELLIGENCE.ROUTE_DEVIATION.CONFIG LIMIT 1);

--------------------------------------------------------------------
-- TRIP_DEVIATION_ANALYSIS (core deviation view)
-- CRITICAL: ACTUAL_PATH and EXPECTED_PATH must be GEOGRAPHY
-- RouteComparison uses ST_ASGEOJSON(ACTUAL_PATH):coordinates
--------------------------------------------------------------------
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.ROUTE_DEVIATION.TRIP_DEVIATION_ANALYSIS
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-route-deviation","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT
    t.TRIP_ID,
    t.VEHICLE_ID,
    t.VEHICLE_ID AS DRIVER_ID,
    DATE_TRUNC('DAY', t.TRIP_START) AS TRIP_DATE,
    t.ROUTE_GEOG AS ACTUAL_PATH,
    t.PLANNED_ROUTE_GEOG AS EXPECTED_PATH,
    t.DISTANCE_KM AS ACTUAL_DISTANCE_KM,
    t.PLANNED_DISTANCE_KM AS EXPECTED_DISTANCE_KM,
    CASE WHEN t.PLANNED_DISTANCE_KM > 0
         THEN ROUND(ABS(t.DISTANCE_KM - t.PLANNED_DISTANCE_KM) * 100.0 / t.PLANNED_DISTANCE_KM, 1)
         ELSE 0 END AS DISTANCE_DEVIATION_PCT,
    CASE WHEN t.DURATION_MINUTES > 0
         THEN ROUND(ABS(t.DURATION_MINUTES - (t.PLANNED_DISTANCE_KM / NULLIF(t.DISTANCE_KM, 0) * t.DURATION_MINUTES)) * 100.0 / t.DURATION_MINUTES, 1)
         ELSE 0 END AS DURATION_DEVIATION_PCT,
    COALESCE(po.NAME, 'Unknown') AS ORIGIN_NAME,
    COALESCE(pd.NAME, 'Unknown') AS DEST_NAME,
    t.IS_DETOUR,
    t.DETOUR_DISTANCE_KM,
    tel.POINT_COUNT,
    t.REGION
FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS t
LEFT JOIN SYNTHETIC_DATASETS.UNIFIED.DIM_POIS po ON t.ORIGIN_POI_ID = po.LOCATION_ID
LEFT JOIN SYNTHETIC_DATASETS.UNIFIED.DIM_POIS pd ON t.DESTINATION_POI_ID = pd.LOCATION_ID
LEFT JOIN (SELECT TRIP_ID, COUNT(*) AS POINT_COUNT FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY GROUP BY TRIP_ID) tel ON t.TRIP_ID = tel.TRIP_ID
WHERE t.VEHICLE_TYPE = (SELECT VEHICLE_TYPE FROM FLEET_INTELLIGENCE.ROUTE_DEVIATION.CONFIG LIMIT 1)
  AND t.REGION = (SELECT REGION FROM FLEET_INTELLIGENCE.ROUTE_DEVIATION.CONFIG LIMIT 1);

--------------------------------------------------------------------
-- DAILY_DEVIATION_TRENDS (DeviationDashboard trend chart)
--------------------------------------------------------------------
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.ROUTE_DEVIATION.DAILY_DEVIATION_TRENDS
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-route-deviation","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT
    TRIP_DATE,
    COUNT(*) AS TOTAL_TRIPS,
    ROUND(AVG(DISTANCE_DEVIATION_PCT), 1) AS AVG_DEVIATION_PCT,
    ROUND(SUM(CASE WHEN DISTANCE_DEVIATION_PCT > 10 THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0), 1) AS DEVIATION_RATE_PCT,
    SUM(CASE WHEN IS_DETOUR THEN 1 ELSE 0 END) AS DETOUR_COUNT
FROM FLEET_INTELLIGENCE.ROUTE_DEVIATION.TRIP_DEVIATION_ANALYSIS
GROUP BY TRIP_DATE;

--------------------------------------------------------------------
-- DRIVER_DEVIATION_SUMMARY (DeviationDashboard top deviators)
--------------------------------------------------------------------
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.ROUTE_DEVIATION.DRIVER_DEVIATION_SUMMARY
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-route-deviation","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT
    DRIVER_ID,
    COUNT(*) AS TOTAL_TRIPS,
    ROUND(AVG(DISTANCE_DEVIATION_PCT), 1) AS AVG_DISTANCE_DEVIATION_PCT,
    ROUND(AVG(DURATION_DEVIATION_PCT), 1) AS AVG_DURATION_DEVIATION_PCT,
    SUM(CASE WHEN IS_DETOUR THEN 1 ELSE 0 END) AS DETOUR_COUNT,
    ROUND(SUM(CASE WHEN IS_DETOUR THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0), 1) AS DETOUR_RATE_PCT
FROM FLEET_INTELLIGENCE.ROUTE_DEVIATION.TRIP_DEVIATION_ANALYSIS
GROUP BY DRIVER_ID;

--------------------------------------------------------------------
-- Verification
--------------------------------------------------------------------
-- SELECT 'TRIP_DEVIATION_ANALYSIS' AS OBJ, COUNT(*) AS CNT FROM FLEET_INTELLIGENCE.ROUTE_DEVIATION.TRIP_DEVIATION_ANALYSIS
-- UNION ALL SELECT 'DAILY_DEVIATION_TRENDS', COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_DEVIATION.DAILY_DEVIATION_TRENDS
-- UNION ALL SELECT 'DRIVER_DEVIATION_SUMMARY', COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_DEVIATION.DRIVER_DEVIATION_SUMMARY
-- UNION ALL SELECT 'VW_VEHICLE_TELEMETRY', COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_DEVIATION.VW_VEHICLE_TELEMETRY;
--
-- Expected (SF seed data): TRIP_DEVIATION ~6K, DAILY_TRENDS 7, DRIVER_SUMMARY 50, TELEMETRY ~470K
