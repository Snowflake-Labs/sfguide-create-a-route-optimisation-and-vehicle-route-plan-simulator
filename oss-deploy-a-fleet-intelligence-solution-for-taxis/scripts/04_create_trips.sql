-- =============================================================================
-- SF Taxi Fleet Intelligence - Trip Generation
-- =============================================================================
-- This script generates trips for each driver with varied trip counts based
-- on shift type. Busier shifts (Morning, Day) get more trips than quieter
-- shifts (Graveyard).
--
-- Trip Count Ranges by Shift:
--   - Morning: 14-22 trips (busiest)
--   - Day: 12-20 trips
--   - Early: 10-18 trips
--   - Evening: 10-16 trips
--   - Graveyard: 6-12 trips (quietest)
--
-- Prerequisites:
--   - 03_create_drivers.sql executed
-- =============================================================================

USE DATABASE OPENROUTESERVICE_NATIVE_APP;
USE SCHEMA FLEET_INTELLIGENCE_TAXIS;
USE WAREHOUSE COMPUTE_WH;

-- Create DRIVER_TRIPS with varied trip counts per driver
CREATE OR REPLACE TABLE DRIVER_TRIPS AS
WITH 
-- Determine number of trips per driver (varied by shift type)
driver_trip_counts AS (
    SELECT 
        d.DRIVER_ID,
        d.SHIFT_TYPE,
        d.SHIFT_START_HOUR,
        d.SHIFT_END_HOUR,
        d.SHIFT_CROSSES_MIDNIGHT,
        -- Base trips on shift type + random variation
        CASE d.SHIFT_TYPE
            WHEN 'Morning' THEN UNIFORM(14, 22, RANDOM())
            WHEN 'Day' THEN UNIFORM(12, 20, RANDOM())
            WHEN 'Early' THEN UNIFORM(10, 18, RANDOM())
            WHEN 'Evening' THEN UNIFORM(10, 16, RANDOM())
            WHEN 'Graveyard' THEN UNIFORM(6, 12, RANDOM())
        END AS NUM_TRIPS
    FROM TAXI_DRIVERS d
),
-- Generate trip sequence for each driver
trip_sequence AS (
    SELECT 
        d.DRIVER_ID,
        d.SHIFT_TYPE,
        d.SHIFT_START_HOUR,
        d.SHIFT_END_HOUR,
        d.SHIFT_CROSSES_MIDNIGHT,
        d.NUM_TRIPS,
        ROW_NUMBER() OVER (PARTITION BY d.DRIVER_ID ORDER BY RANDOM()) AS TRIP_NUMBER
    FROM driver_trip_counts d
    CROSS JOIN TABLE(GENERATOR(ROWCOUNT => 25)) g
    QUALIFY TRIP_NUMBER <= d.NUM_TRIPS
),
-- Calculate trip hours spread across shift
trips_with_hours AS (
    SELECT 
        ts.*,
        CASE 
            WHEN ts.SHIFT_CROSSES_MIDNIGHT = 'True' THEN
                MOD(ts.SHIFT_START_HOUR + FLOOR((ts.TRIP_NUMBER - 1) * 8.0 / ts.NUM_TRIPS) + UNIFORM(0, 1, RANDOM()), 24)
            ELSE
                ts.SHIFT_START_HOUR + FLOOR((ts.TRIP_NUMBER - 1) * (ts.SHIFT_END_HOUR - ts.SHIFT_START_HOUR) / ts.NUM_TRIPS) + UNIFORM(0, 1, RANDOM())
        END AS TRIP_HOUR
    FROM trip_sequence ts
),
-- Sample locations with row numbers
locations AS (
    SELECT 
        LOCATION_ID,
        POINT_GEOM,
        NAME,
        ROW_NUMBER() OVER (ORDER BY RANDOM()) AS rn
    FROM SF_TAXI_LOCATIONS
    WHERE NAME IS NOT NULL AND LENGTH(NAME) > 3
)
SELECT 
    MD5(t.DRIVER_ID || '-' || t.TRIP_NUMBER || '-' || RANDOM()) AS TRIP_ID,
    t.DRIVER_ID,
    t.TRIP_HOUR::INT AS TRIP_HOUR,
    t.TRIP_NUMBER::INT AS TRIP_NUMBER,
    t.SHIFT_TYPE,
    MOD(ABS(HASH(t.DRIVER_ID || t.TRIP_NUMBER || 'P')), (SELECT COUNT(*) FROM locations)) + 1 AS PICKUP_LOC_ID,
    MOD(ABS(HASH(t.DRIVER_ID || t.TRIP_NUMBER || 'D')), (SELECT COUNT(*) FROM locations)) + 1 AS DROPOFF_LOC_ID
FROM trips_with_hours t;

-- Create DRIVER_TRIPS_WITH_COORDS with actual pickup/dropoff locations
CREATE OR REPLACE TABLE DRIVER_TRIPS_WITH_COORDS AS
WITH locations AS (
    SELECT 
        LOCATION_ID,
        POINT_GEOM,
        NAME,
        ROW_NUMBER() OVER (ORDER BY RANDOM()) AS rn
    FROM SF_TAXI_LOCATIONS
    WHERE NAME IS NOT NULL AND LENGTH(NAME) > 3
),
pickup AS (
    SELECT LOCATION_ID, POINT_GEOM, NAME, rn FROM locations
),
dropoff AS (
    SELECT LOCATION_ID, POINT_GEOM, NAME, rn FROM locations
)
SELECT 
    t.TRIP_ID,
    t.DRIVER_ID,
    t.TRIP_HOUR,
    t.TRIP_NUMBER,
    t.SHIFT_TYPE,
    p.POINT_GEOM AS PICKUP_GEOM,
    p.NAME AS PICKUP_NAME,
    d.POINT_GEOM AS DROPOFF_GEOM,
    d.NAME AS DROPOFF_NAME
FROM DRIVER_TRIPS t
JOIN pickup p ON t.PICKUP_LOC_ID = p.rn
JOIN dropoff d ON t.DROPOFF_LOC_ID = d.rn;

-- Show trip distribution
SELECT 
    SHIFT_TYPE,
    COUNT(DISTINCT DRIVER_ID) AS DRIVERS,
    MIN(trips) AS MIN_TRIPS,
    MAX(trips) AS MAX_TRIPS,
    AVG(trips)::INT AS AVG_TRIPS
FROM (
    SELECT DRIVER_ID, SHIFT_TYPE, COUNT(*) AS trips
    FROM DRIVER_TRIPS
    GROUP BY DRIVER_ID, SHIFT_TYPE
)
GROUP BY SHIFT_TYPE
ORDER BY AVG_TRIPS DESC;

SELECT 'Created ' || COUNT(*) || ' trips for ' || COUNT(DISTINCT DRIVER_ID) || ' drivers' AS STATUS
FROM DRIVER_TRIPS_WITH_COORDS;
