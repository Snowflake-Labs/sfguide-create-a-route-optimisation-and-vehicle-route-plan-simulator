-- =============================================================================
-- SF Taxi Fleet Intelligence - Route Generation with OpenRouteService
-- =============================================================================
-- This script generates actual road routes using the OpenRouteService Native
-- App DIRECTIONS function. Routes follow real SF roads rather than straight
-- lines.
--
-- WARNING: This script makes many ORS API calls and may take several minutes
-- to complete depending on the number of trips.
--
-- Prerequisites:
--   - 04_create_trips.sql executed
--   - OpenRouteService Native App installed and accessible
-- =============================================================================

USE DATABASE FLEET_INTELLIGENCE;
USE SCHEMA PUBLIC;
USE WAREHOUSE COMPUTE_WH;

-- Generate ORS routes for all trips
-- This calls the DIRECTIONS function for each trip to get real road routes
CREATE OR REPLACE TABLE DRIVER_ROUTES AS
SELECT 
    DRIVER_ID,
    TRIP_ID,
    TRIP_HOUR,
    TRIP_NUMBER,
    SHIFT_TYPE,
    PICKUP_GEOM,
    PICKUP_NAME,
    DROPOFF_GEOM,
    DROPOFF_NAME,
    OPENROUTESERVICE_NATIVE_APP.CORE.DIRECTIONS(
        'driving-car',
        ARRAY_CONSTRUCT(ST_X(PICKUP_GEOM), ST_Y(PICKUP_GEOM)),
        ARRAY_CONSTRUCT(ST_X(DROPOFF_GEOM), ST_Y(DROPOFF_GEOM))
    ) AS ROUTE_RESPONSE
FROM DRIVER_TRIPS_WITH_COORDS;

-- Parse the ORS route responses to extract geometry and metrics
CREATE OR REPLACE TABLE DRIVER_ROUTES_PARSED AS
SELECT 
    DRIVER_ID,
    TRIP_ID,
    TRIP_HOUR,
    TRIP_NUMBER,
    SHIFT_TYPE,
    PICKUP_GEOM AS ORIGIN,
    PICKUP_NAME AS ORIGIN_ADDRESS,
    DROPOFF_GEOM AS DESTINATION,
    DROPOFF_NAME AS DESTINATION_ADDRESS,
    TRY_TO_GEOGRAPHY(PARSE_JSON(ROUTE_RESPONSE):features[0]:geometry) AS ROUTE_GEOMETRY,
    PARSE_JSON(ROUTE_RESPONSE):features[0]:properties:summary:distance::FLOAT AS ROUTE_DISTANCE_METERS,
    PARSE_JSON(ROUTE_RESPONSE):features[0]:properties:summary:duration::FLOAT AS ROUTE_DURATION_SECS
FROM DRIVER_ROUTES
WHERE ROUTE_RESPONSE IS NOT NULL;

-- Create route geometries with trip timing
-- Trips are scheduled sequentially within each driver's shift
CREATE OR REPLACE TABLE DRIVER_ROUTE_GEOMETRIES AS
WITH trip_timing AS (
    SELECT 
        *,
        ROW_NUMBER() OVER (PARTITION BY DRIVER_ID ORDER BY TRIP_HOUR, TRIP_NUMBER) AS DRIVER_TRIP_SEQ
    FROM DRIVER_ROUTES_PARSED
    WHERE ROUTE_GEOMETRY IS NOT NULL
),
cumulative_timing AS (
    SELECT 
        t.*,
        -- Calculate cumulative time offset (previous trips + 3 min break between trips)
        SUM(COALESCE(ROUTE_DURATION_SECS, 0) + 180) OVER (
            PARTITION BY DRIVER_ID 
            ORDER BY DRIVER_TRIP_SEQ 
            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
        ) AS TIME_OFFSET_SECS
    FROM trip_timing t
)
SELECT 
    DRIVER_ID,
    TRIP_ID,
    DATEADD('second', COALESCE(TIME_OFFSET_SECS, 0), 
        DATEADD('hour', TRIP_HOUR, '2015-06-24'::TIMESTAMP_NTZ)
    ) AS TRIP_START_TIME,
    DATEADD('second', COALESCE(TIME_OFFSET_SECS, 0) + ROUTE_DURATION_SECS, 
        DATEADD('hour', TRIP_HOUR, '2015-06-24'::TIMESTAMP_NTZ)
    ) AS TRIP_END_TIME,
    ORIGIN_ADDRESS,
    DESTINATION_ADDRESS,
    ROUTE_DURATION_SECS,
    ROUTE_DISTANCE_METERS,
    ROUTE_GEOMETRY AS GEOMETRY,
    ORIGIN,
    DESTINATION,
    SHIFT_TYPE
FROM cumulative_timing;

-- Show route statistics
SELECT 
    COUNT(*) AS TOTAL_ROUTES,
    COUNT(DISTINCT DRIVER_ID) AS DRIVERS,
    ROUND(AVG(ROUTE_DISTANCE_METERS)/1000, 2) AS AVG_DISTANCE_KM,
    ROUND(AVG(ROUTE_DURATION_SECS)/60, 1) AS AVG_DURATION_MINS,
    ROUND(SUM(ROUTE_DISTANCE_METERS)/1000, 0) AS TOTAL_DISTANCE_KM
FROM DRIVER_ROUTE_GEOMETRIES;

SELECT 'Generated ' || COUNT(*) || ' ORS routes' AS STATUS
FROM DRIVER_ROUTE_GEOMETRIES;
