/*
 * sql-pipeline.sql — Dwell Analysis Dynamic Table Pipeline
 * Target: FLEET_INTELLIGENCE.DWELL_ANALYSIS
 * Source: SYNTHETIC_DATASETS.UNIFIED (via projection views)
 *
 * IMPORTANT: This pipeline creates Dynamic Tables that the ORS Control App
 * React components query directly. DT names and column names MUST match
 * exactly what the React components expect.
 *
 * React Component -> DT Name -> Required Columns:
 *   DwellOverview.tsx    -> DT_DWELL_ENRICHED    -> SESSION_ID, DWELL_MINUTES, VEHICLE_ID
 *   DwellOverview.tsx    -> DT_DAILY_TRENDS      -> TREND_DATE, TOTAL_SESSIONS, ACTIVE_VEHICLES
 *   DwellOverview.tsx    -> DT_FACILITY_UTILIZATION -> LOCATION_NAME, TOTAL_SESSIONS
 *   FacilityUtilization  -> DT_FACILITY_UTILIZATION -> LOCATION_NAME, FACILITY_TYPE, TOTAL_SESSIONS, AVG_DWELL_MIN, UNIQUE_VEHICLES
 *   SLAAlerts.tsx        -> DT_SLA_ALERTS        -> SLA_STATUS, SESSION_ID, VEHICLE_ID, LOCATION_NAME, DWELL_MINUTES, WARNING_MINUTES, SESSION_START
 *   DriverPerformance    -> DT_DRIVER_DWELL_SUMMARY -> VEHICLE_ID, UNIQUE_LOCATIONS, TOTAL_DWELL_SESSIONS, AVG_SESSION_MIN, SLA_BREACH_COUNT, TOTAL_DWELL_MIN
 *   CongestionMap.tsx    -> DT_H3_CONGESTION     -> H3_CELL_R7, HOUR_BUCKET, SESSION_COUNT, AVG_DWELL_MIN
 *   TripInspector.tsx    -> DT_DWELL_ENRICHED    -> TRIP_ID, VEHICLE_ID, SESSION_START, SESSION_END, DWELL_MINUTES, STATUS, AVG_POINT, LOCATION_NAME
 *   LiveOperations.tsx   -> DT_STATE_CHANGES     -> VEHICLE_ID, STATUS, POINT_GEOM, TS, SPEED_KMH, IS_STATE_CHANGE
 *   LiveOperations.tsx   -> DT_DWELL_ENRICHED    -> VEHICLE_ID, LOCATION_NAME, SESSION_START, DWELL_MINUTES, SESSION_END
 *
 * Prerequisites:
 *   - SYNTHETIC_DATASETS.UNIFIED tables with POINT_GEOM (GEOGRAPHY) column
 *   - build-routing-solution Step 7 (seed data) completed
 *   - CONFIG table with VEHICLE_TYPE='ebike', REGION='SanFrancisco'
 *
 * Execution:
 *   snow sql -f .cortex/skills/dwell-analysis/references/sql-pipeline.sql -c <connection>
 *   OR execute each statement individually via snowflake_sql_execute (workspace)
 *
 * NOTE: VW_TRIP_SCHEDULE references DIM_TRIP_SCHEDULE which does NOT exist in
 * seed data. It is safe to skip — no React component depends on it.
 */

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-dwell-analysis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

--------------------------------------------------------------------
-- Step 1: Infrastructure
--------------------------------------------------------------------
CREATE DATABASE IF NOT EXISTS FLEET_INTELLIGENCE
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-dwell-analysis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-dwell-analysis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- CONFIG
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.CONFIG (
    VEHICLE_TYPE VARCHAR NOT NULL,
    REGION       VARCHAR NOT NULL
)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-dwell-analysis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
MERGE INTO FLEET_INTELLIGENCE.DWELL_ANALYSIS.CONFIG tgt
USING (SELECT 'ebike' AS VEHICLE_TYPE, 'SanFrancisco' AS REGION) src
ON TRUE
WHEN NOT MATCHED THEN INSERT (VEHICLE_TYPE, REGION) VALUES (src.VEHICLE_TYPE, src.REGION)
WHEN MATCHED THEN UPDATE SET VEHICLE_TYPE = src.VEHICLE_TYPE, REGION = src.REGION;

--------------------------------------------------------------------
-- Step 2: Projection Views
-- CRITICAL: FACT_VEHICLE_TELEMETRY must have POINT_GEOM (GEOGRAPHY).
-- If missing, run: ALTER TABLE ... ADD COLUMN POINT_GEOM GEOGRAPHY;
-- UPDATE ... SET POINT_GEOM = TRY_TO_GEOGRAPHY(POINT_GEOM_WKT);
--------------------------------------------------------------------
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.DWELL_ANALYSIS.VW_VEHICLE_TELEMETRY
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-dwell-analysis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT
    TELEMETRY_ID, VEHICLE_ID, TRIP_ID, TS, STATUS, SPEED_KMH, HEADING_DEG,
    LATITUDE, LONGITUDE, POINT_GEOM, LOCATION_ID, LOCATION_TYPE,
    BATTERY_PCT, ODOMETER_KM, IS_SPEEDING, IS_DETOUR, GPS_ACCURACY_M, REGION
FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY
WHERE VEHICLE_TYPE = (SELECT VEHICLE_TYPE FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.CONFIG LIMIT 1)
  AND REGION = (SELECT REGION FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.CONFIG LIMIT 1);

CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.DWELL_ANALYSIS.VW_TRIP_SUMMARY
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-dwell-analysis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT
    TRIP_ID, VEHICLE_ID, TRIP_START, TRIP_END, ORIGIN, DESTINATION,
    DISTANCE_KM, DURATION_MINUTES, IS_DETOUR, DETOUR_DISTANCE_KM,
    STATUS, REGION
FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS
WHERE VEHICLE_TYPE = (SELECT VEHICLE_TYPE FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.CONFIG LIMIT 1)
  AND REGION = (SELECT REGION FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.CONFIG LIMIT 1);

--------------------------------------------------------------------
-- Step 3: SLA Thresholds
-- WARNING_MINUTES should be set to generate meaningful alerts.
-- For seed data with avg 3.5 min dwell, use tight thresholds.
--------------------------------------------------------------------
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.DWELL_ANALYSIS.SLA_THRESHOLDS (
    LOCATION_TYPE    VARCHAR,
    MAX_DWELL_MINUTES INT,
    WARNING_MINUTES  INT,
    PRIORITY VARCHAR DEFAULT 'MEDIUM'
)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-dwell-analysis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
INSERT INTO FLEET_INTELLIGENCE.DWELL_ANALYSIS.SLA_THRESHOLDS VALUES
('RESTAURANT', 5, 3, 'HIGH'),
('DWELL_ORIGIN', 5, 3, 'HIGH'),
('DWELL_DESTINATION', 5, 3, 'MEDIUM'),
('IDLE', 10, 5, 'LOW');

--------------------------------------------------------------------
-- Step 4: DT Layer 1 - State Changes (for LiveOperations page)
--------------------------------------------------------------------
CREATE OR REPLACE DYNAMIC TABLE FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_STATE_CHANGES
    WAREHOUSE = ROUTING_ANALYTICS
    TARGET_LAG = '10 minutes'
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-dwell-analysis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT
    TELEMETRY_ID, VEHICLE_ID, TRIP_ID, TS, STATUS, SPEED_KMH,
    LATITUDE, LONGITUDE, POINT_GEOM, REGION,
    CASE WHEN STATUS != LAG(STATUS) OVER (PARTITION BY VEHICLE_ID ORDER BY TS) THEN TRUE ELSE FALSE END AS IS_STATE_CHANGE
FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.VW_VEHICLE_TELEMETRY
WHERE POINT_GEOM IS NOT NULL;

--------------------------------------------------------------------
-- Step 5: DT Layer 1 - Dwell Event Detection
-- Groups consecutive dwell points into sessions
--------------------------------------------------------------------
CREATE OR REPLACE DYNAMIC TABLE FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DWELL_EVENTS
    WAREHOUSE = ROUTING_ANALYTICS
    TARGET_LAG = '10 minutes'
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-dwell-analysis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT
    VEHICLE_ID || '-' || TRIP_ID || '-' || LOCATION_ID AS SESSION_ID,
    VEHICLE_ID,
    TRIP_ID,
    LOCATION_ID,
    LOCATION_TYPE,
    ANY_VALUE(STATUS) AS STATUS,
    MIN(TS) AS DWELL_START,
    MAX(TS) AS DWELL_END,
    DATEDIFF('MINUTE', MIN(TS), MAX(TS)) AS DWELL_MINUTES,
    COUNT(*) AS POINT_COUNT,
    ST_CENTROID(ST_COLLECT(POINT_GEOM)) AS DWELL_CENTER,
    AVG(LATITUDE) AS CENTER_LAT,
    AVG(LONGITUDE) AS CENTER_LNG,
    REGION
FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.VW_VEHICLE_TELEMETRY
WHERE STATUS IN ('DWELL_ORIGIN', 'DWELL_DESTINATION', 'IDLE')
  AND LOCATION_ID IS NOT NULL
GROUP BY VEHICLE_ID, TRIP_ID, LOCATION_ID, LOCATION_TYPE, REGION;

--------------------------------------------------------------------
-- Step 6: DT Layer 2 - Enriched Dwell (joins POI names)
-- CRITICAL COLUMNS: SESSION_START, SESSION_END, STATUS, AVG_POINT
-- TripInspector queries: WHERE STATUS LIKE 'DWELL%'
-- TripInspector detail: ST_X(AVG_POINT), ST_Y(AVG_POINT)
--------------------------------------------------------------------
CREATE OR REPLACE DYNAMIC TABLE FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DWELL_ENRICHED
    WAREHOUSE = ROUTING_ANALYTICS
    TARGET_LAG = '10 minutes'
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-dwell-analysis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT
    d.SESSION_ID, d.VEHICLE_ID, d.TRIP_ID, d.LOCATION_ID, d.LOCATION_TYPE,
    COALESCE(TRIM(p.NAME, '"'), 'Unknown') AS LOCATION_NAME,
    COALESCE(p.CATEGORY, d.LOCATION_TYPE) AS CATEGORY,
    d.DWELL_START AS SESSION_START,
    d.DWELL_END AS SESSION_END,
    d.DWELL_MINUTES, d.POINT_COUNT,
    d.DWELL_CENTER,
    d.DWELL_CENTER AS AVG_POINT,
    d.CENTER_LAT, d.CENTER_LNG, d.REGION,
    d.STATUS
FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DWELL_EVENTS d
LEFT JOIN SYNTHETIC_DATASETS.UNIFIED.DIM_POIS p ON d.LOCATION_ID = p.LOCATION_ID;

--------------------------------------------------------------------
-- Step 7: DT Layer 3 - H3 Congestion Heatmap
-- CongestionMap queries: H3_CELL_R7, HOUR_BUCKET, SESSION_COUNT, AVG_DWELL_MIN
--------------------------------------------------------------------
CREATE OR REPLACE DYNAMIC TABLE FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_H3_CONGESTION
    WAREHOUSE = ROUTING_ANALYTICS
    TARGET_LAG = '10 minutes'
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-dwell-analysis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT
    H3_POINT_TO_CELL_STRING(DWELL_CENTER, 7) AS H3_CELL_R7,
    DATE_TRUNC('HOUR', SESSION_START) AS HOUR_BUCKET,
    COUNT(DISTINCT SESSION_ID) AS SESSION_COUNT,
    ROUND(AVG(DWELL_MINUTES), 1) AS AVG_DWELL_MIN,
    COUNT(DISTINCT VEHICLE_ID) AS UNIQUE_VEHICLES,
    REGION
FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DWELL_ENRICHED
WHERE DWELL_CENTER IS NOT NULL
GROUP BY H3_POINT_TO_CELL_STRING(DWELL_CENTER, 7), DATE_TRUNC('HOUR', SESSION_START), REGION;

--------------------------------------------------------------------
-- Step 8: DT Layer 3 - SLA Alerts
-- SLAAlerts queries: SLA_STATUS, SESSION_ID, VEHICLE_ID, LOCATION_NAME,
--                    DWELL_MINUTES, WARNING_MINUTES, SESSION_START
--------------------------------------------------------------------
CREATE OR REPLACE DYNAMIC TABLE FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_SLA_ALERTS
    WAREHOUSE = ROUTING_ANALYTICS
    TARGET_LAG = '10 minutes'
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-dwell-analysis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT
    d.SESSION_ID, d.VEHICLE_ID, d.TRIP_ID, d.LOCATION_NAME, d.LOCATION_TYPE,
    d.SESSION_START, d.SESSION_END, d.DWELL_MINUTES,
    s.MAX_DWELL_MINUTES AS SLA_LIMIT,
    s.WARNING_MINUTES,
    CASE
        WHEN d.DWELL_MINUTES > s.MAX_DWELL_MINUTES * 2 THEN 'CRITICAL'
        WHEN d.DWELL_MINUTES > s.MAX_DWELL_MINUTES THEN 'WARNING'
        WHEN d.DWELL_MINUTES > s.WARNING_MINUTES THEN 'INFO'
    END AS SLA_STATUS,
    d.CENTER_LAT, d.CENTER_LNG, d.REGION
FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DWELL_ENRICHED d
JOIN FLEET_INTELLIGENCE.DWELL_ANALYSIS.SLA_THRESHOLDS s ON d.LOCATION_TYPE = s.LOCATION_TYPE
WHERE d.DWELL_MINUTES > s.WARNING_MINUTES;

--------------------------------------------------------------------
-- Step 9: DT Layer 3 - Facility Utilization
-- FacilityUtilization queries: LOCATION_NAME, FACILITY_TYPE,
--   TOTAL_SESSIONS, AVG_DWELL_MIN, UNIQUE_VEHICLES
--------------------------------------------------------------------
CREATE OR REPLACE DYNAMIC TABLE FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_FACILITY_UTILIZATION
    WAREHOUSE = ROUTING_ANALYTICS
    TARGET_LAG = '10 minutes'
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-dwell-analysis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT
    LOCATION_ID, LOCATION_NAME,
    CATEGORY AS FACILITY_TYPE,
    COUNT(DISTINCT SESSION_ID) AS TOTAL_SESSIONS,
    COUNT(DISTINCT VEHICLE_ID) AS UNIQUE_VEHICLES,
    ROUND(AVG(DWELL_MINUTES), 1) AS AVG_DWELL_MIN,
    ROUND(MAX(DWELL_MINUTES), 1) AS MAX_DWELL_MIN,
    MIN(SESSION_START) AS FIRST_VISIT,
    MAX(SESSION_END) AS LAST_VISIT,
    CENTER_LAT, CENTER_LNG, REGION
FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DWELL_ENRICHED
GROUP BY LOCATION_ID, LOCATION_NAME, CATEGORY, CENTER_LAT, CENTER_LNG, REGION;

--------------------------------------------------------------------
-- Step 10: DT Layer 3 - Driver Dwell Summary
-- DriverPerformance queries: VEHICLE_ID, UNIQUE_LOCATIONS,
--   TOTAL_DWELL_SESSIONS, AVG_SESSION_MIN, SLA_BREACH_COUNT, TOTAL_DWELL_MIN
--------------------------------------------------------------------
CREATE OR REPLACE DYNAMIC TABLE FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DRIVER_DWELL_SUMMARY
    WAREHOUSE = ROUTING_ANALYTICS
    TARGET_LAG = '10 minutes'
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-dwell-analysis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT
    d.VEHICLE_ID,
    COUNT(DISTINCT d.LOCATION_ID) AS UNIQUE_LOCATIONS,
    COUNT(DISTINCT d.SESSION_ID) AS TOTAL_DWELL_SESSIONS,
    ROUND(AVG(d.DWELL_MINUTES), 1) AS AVG_SESSION_MIN,
    ROUND(SUM(d.DWELL_MINUTES), 0) AS TOTAL_DWELL_MIN,
    COALESCE(SUM(CASE WHEN a.SLA_STATUS IN ('CRITICAL', 'WARNING') THEN 1 ELSE 0 END), 0) AS SLA_BREACH_COUNT,
    d.REGION
FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DWELL_ENRICHED d
LEFT JOIN FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_SLA_ALERTS a ON d.SESSION_ID = a.SESSION_ID
GROUP BY d.VEHICLE_ID, d.REGION;

--------------------------------------------------------------------
-- Step 11: DT Layer 3 - Daily Trends
-- DwellOverview queries: TREND_DATE, TOTAL_SESSIONS, ACTIVE_VEHICLES
--------------------------------------------------------------------
CREATE OR REPLACE DYNAMIC TABLE FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DAILY_TRENDS
    WAREHOUSE = ROUTING_ANALYTICS
    TARGET_LAG = '10 minutes'
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-dwell-analysis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT
    DATE_TRUNC('DAY', SESSION_START) AS TREND_DATE,
    COUNT(DISTINCT SESSION_ID) AS TOTAL_SESSIONS,
    COUNT(DISTINCT VEHICLE_ID) AS ACTIVE_VEHICLES,
    ROUND(AVG(DWELL_MINUTES), 1) AS AVG_DWELL_MINUTES,
    ROUND(MAX(DWELL_MINUTES), 1) AS MAX_DWELL_MINUTES,
    SUM(CASE WHEN DWELL_MINUTES <= 5 THEN 1 ELSE 0 END) AS SLA_COMPLIANT,
    COUNT(*) AS TOTAL_DWELLS
FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DWELL_ENRICHED
GROUP BY DATE_TRUNC('DAY', SESSION_START);

--------------------------------------------------------------------
-- Step 12: Verification
--------------------------------------------------------------------
-- SELECT 'DT_STATE_CHANGES' AS DT, COUNT(*) AS CNT FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_STATE_CHANGES
-- UNION ALL SELECT 'DT_DWELL_EVENTS', COUNT(*) FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DWELL_EVENTS
-- UNION ALL SELECT 'DT_DWELL_ENRICHED', COUNT(*) FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DWELL_ENRICHED
-- UNION ALL SELECT 'DT_H3_CONGESTION', COUNT(*) FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_H3_CONGESTION
-- UNION ALL SELECT 'DT_SLA_ALERTS', COUNT(*) FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_SLA_ALERTS
-- UNION ALL SELECT 'DT_FACILITY_UTILIZATION', COUNT(*) FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_FACILITY_UTILIZATION
-- UNION ALL SELECT 'DT_DRIVER_DWELL_SUMMARY', COUNT(*) FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DRIVER_DWELL_SUMMARY
-- UNION ALL SELECT 'DT_DAILY_TRENDS', COUNT(*) FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DAILY_TRENDS;
--
-- Expected (with SF seed data):
--   DT_STATE_CHANGES:       ~470K
--   DT_DWELL_EVENTS:        ~12K
--   DT_DWELL_ENRICHED:      ~12K
--   DT_H3_CONGESTION:       ~1.5K
--   DT_SLA_ALERTS:          ~3K (depends on SLA thresholds)
--   DT_FACILITY_UTILIZATION: ~12K
--   DT_DRIVER_DWELL_SUMMARY: 50
--   DT_DAILY_TRENDS:        7

--------------------------------------------------------------------
-- Step FINAL: Force Refresh (MANDATORY after creation)
-- DTs with TARGET_LAG do NOT auto-populate. Must refresh explicitly.
--------------------------------------------------------------------
ALTER DYNAMIC TABLE FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_STATE_CHANGES REFRESH;
ALTER DYNAMIC TABLE FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DWELL_EVENTS REFRESH;
ALTER DYNAMIC TABLE FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DWELL_ENRICHED REFRESH;
ALTER DYNAMIC TABLE FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_H3_CONGESTION REFRESH;
ALTER DYNAMIC TABLE FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_SLA_ALERTS REFRESH;
ALTER DYNAMIC TABLE FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_FACILITY_UTILIZATION REFRESH;
ALTER DYNAMIC TABLE FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DRIVER_DWELL_SUMMARY REFRESH;
ALTER DYNAMIC TABLE FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DAILY_TRENDS REFRESH;
