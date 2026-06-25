-- =============================================================================
-- Food Delivery Projection Views - Complete SQL Pipeline
-- Target: FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_EBIKE
-- Source: SYNTHETIC_DATASETS.UNIFIED (Data Studio output)
-- =============================================================================
-- This file creates all views needed by the React ORS Control App
-- (Fleet Delivery page: FleetMap + CatchmentPanel).
--
-- Pattern follows dwell-analysis: CONFIG table filters UNIFIED by vehicle type + region.
-- =============================================================================

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-ebike","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- Step 1: Infrastructure
CREATE DATABASE IF NOT EXISTS FLEET_INTELLIGENCE
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-ebike","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
CREATE WAREHOUSE IF NOT EXISTS ROUTING_ANALYTICS
    WAREHOUSE_SIZE = 'XSMALL'
    AUTO_SUSPEND = 60
    AUTO_RESUME = TRUE
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-ebike","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_EBIKE
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-ebike","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- Step 2: CONFIG table (single-row, controls vehicle type + region filtering)
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_EBIKE.CONFIG (
    VEHICLE_TYPE VARCHAR NOT NULL,
    REGION       VARCHAR NOT NULL
);
MERGE INTO FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_EBIKE.CONFIG tgt
USING (SELECT 'ebike' AS VEHICLE_TYPE, 'SanFrancisco' AS REGION) src
ON TRUE
WHEN NOT MATCHED THEN INSERT (VEHICLE_TYPE, REGION) VALUES (src.VEHICLE_TYPE, src.REGION);

ALTER TABLE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_EBIKE.CONFIG SET
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-ebike","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- =============================================================================
-- React ORS Control App Views (Fleet Delivery page)
-- =============================================================================

-- TRIPS: Used by FleetMap.tsx and CatchmentPanel.tsx
-- Columns: TRIP_ID, VEHICLE_ID, ORIGIN_POI_ID, DESTINATION_POI_ID, PICKUP_LOCATION, DROPOFF_LOCATION,
--          DURATION_MINUTES, DISTANCE_KM, GEOMETRY, TRIP_START, TRIP_END, STATUS, REGION
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_EBIKE.TRIPS AS
SELECT
    t.TRIP_ID,
    t.VEHICLE_ID,
    t.ORIGIN_POI_ID,
    t.DESTINATION_POI_ID,
    t.ORIGIN           AS PICKUP_LOCATION,
    t.DESTINATION  AS DROPOFF_LOCATION,
    t.DURATION_MINUTES,
    t.DISTANCE_KM,
    t.ROUTE_GEOG     AS GEOMETRY,
    t.TRIP_START,
    t.TRIP_END,
    t.STATUS,
    t.REGION
FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS t
WHERE t.VEHICLE_TYPE = (SELECT VEHICLE_TYPE FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_EBIKE.CONFIG LIMIT 1)
  AND t.REGION       = (SELECT REGION FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_EBIKE.CONFIG LIMIT 1);

ALTER VIEW FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_EBIKE.TRIPS SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-ebike","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- ORIGINS_ENRICHED: Used by CatchmentPanel.tsx
-- Columns: ORIGIN_POI_ID, ORIGIN_NAME, LOCATION, TRIP_COUNT, AVG_DURATION_MINUTES
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_EBIKE.ORIGINS_ENRICHED AS
SELECT
    p.LOCATION_ID         AS ORIGIN_POI_ID,
    p.NAME                AS ORIGIN_NAME,
    ANY_VALUE(p.POINT_GEOM) AS LOCATION,
    COUNT(t.TRIP_ID)      AS TRIP_COUNT,
    ROUND(AVG(t.DURATION_MINUTES), 1) AS AVG_DURATION_MINUTES,
    p.REGION
FROM SYNTHETIC_DATASETS.UNIFIED.DIM_POIS p
LEFT JOIN SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS t
    ON p.LOCATION_ID = t.ORIGIN_POI_ID
   AND t.VEHICLE_TYPE = (SELECT VEHICLE_TYPE FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_EBIKE.CONFIG LIMIT 1)
   AND t.REGION       = (SELECT REGION FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_EBIKE.CONFIG LIMIT 1)
WHERE p.LOCATION_TYPE = 'RESTAURANT'
  AND p.REGION = (SELECT REGION FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_EBIKE.CONFIG LIMIT 1)
GROUP BY p.LOCATION_ID, p.NAME, p.REGION;

ALTER VIEW FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_EBIKE.ORIGINS_ENRICHED SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-ebike","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- =============================================================================
-- Verification
-- =============================================================================
-- Run after creating all views to verify row counts:
--
-- SELECT 'CONFIG' AS NAME, COUNT(*) AS ROW_CNT FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_EBIKE.CONFIG
-- UNION ALL SELECT 'TRIPS', COUNT(*) FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_EBIKE.TRIPS
-- UNION ALL SELECT 'TRIPS', COUNT(*) FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_EBIKE.TRIPS
-- UNION ALL SELECT 'ORIGINS_ENRICHED', COUNT(*) FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_EBIKE.ORIGINS_ENRICHED;


