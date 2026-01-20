-- =============================================================================
-- SF Taxi Fleet Intelligence - Driver Locations (Interpolated Points)
-- =============================================================================
-- This script creates the DRIVER_LOCATIONS table by interpolating points
-- along each route geometry. This enables tracking driver positions at
-- different times during their trips.
--
-- For each trip, 15 points are generated (0-14) representing:
--   0: waiting (pre-trip, waiting for fare)
--   1: pickup (passenger boarding)
--   2-12: driving (en route with realistic speed variation)
--   13: dropoff (passenger exiting)
--   14: idle (brief period after dropoff)
--
-- Speed values are assigned based on:
--   - Driver state (waiting, pickup, dropoff = stationary)
--   - Time of day (peak hours have more slow/stopped traffic)
--   - Random variation (simulating traffic lights, junctions)
--
-- Prerequisites:
--   - 05_generate_routes.sql executed
-- =============================================================================

USE DATABASE FLEET_INTELLIGENCE;
USE SCHEMA PUBLIC;
USE WAREHOUSE COMPUTE_WH;

-- Create DRIVER_LOCATIONS with realistic speeds and stationary periods
CREATE OR REPLACE TABLE DRIVER_LOCATIONS AS
WITH 
route_info AS (
    SELECT 
        DRIVER_ID,
        TRIP_ID,
        TRIP_START_TIME,
        TRIP_END_TIME,
        ORIGIN AS PICKUP_LOCATION,
        DESTINATION AS DROPOFF_LOCATION,
        GEOMETRY AS ROUTE,
        ROUTE_DURATION_SECS,
        ROUTE_DISTANCE_METERS,
        SHIFT_TYPE,
        ST_NPOINTS(GEOMETRY)::NUMBER(10,0) AS NUM_POINTS,
        -- Add waiting time before trip (2-8 minutes waiting for fare)
        UNIFORM(120, 480, RANDOM()) AS WAIT_BEFORE_SECS
    FROM DRIVER_ROUTE_GEOMETRIES
    WHERE GEOMETRY IS NOT NULL
),
-- Generate 15 point indices (0-14) for each trip
-- More granular tracking with dedicated states for realism
point_seq AS (
    SELECT SEQ4()::NUMBER(10,0) AS POINT_INDEX FROM TABLE(GENERATOR(ROWCOUNT => 15))
),
-- Cross join routes with point indices and calculate positions
expanded AS (
    SELECT 
        r.DRIVER_ID,
        r.TRIP_ID,
        r.TRIP_START_TIME,
        r.TRIP_END_TIME,
        r.PICKUP_LOCATION,
        r.DROPOFF_LOCATION,
        r.ROUTE,
        r.NUM_POINTS,
        r.ROUTE_DURATION_SECS,
        r.WAIT_BEFORE_SECS,
        p.POINT_INDEX,
        -- Determine driver state based on point index
        CASE 
            WHEN p.POINT_INDEX = 0 THEN 'waiting'      -- Waiting for fare
            WHEN p.POINT_INDEX = 1 THEN 'pickup'       -- At pickup, passenger boarding
            WHEN p.POINT_INDEX BETWEEN 2 AND 12 THEN 'driving'  -- En route
            WHEN p.POINT_INDEX = 13 THEN 'dropoff'     -- At dropoff, passenger exiting
            WHEN p.POINT_INDEX = 14 THEN 'idle'        -- Brief idle after dropoff
        END AS DRIVER_STATE,
        -- Calculate timestamp for this point
        CASE 
            WHEN p.POINT_INDEX = 0 THEN 
                DATEADD('second', -r.WAIT_BEFORE_SECS, r.TRIP_START_TIME)
            WHEN p.POINT_INDEX = 1 THEN 
                r.TRIP_START_TIME
            WHEN p.POINT_INDEX BETWEEN 2 AND 12 THEN
                DATEADD('second', 
                    FLOOR(r.ROUTE_DURATION_SECS * (p.POINT_INDEX - 2) / 10.0)::INT,
                    r.TRIP_START_TIME
                )
            WHEN p.POINT_INDEX = 13 THEN
                r.TRIP_END_TIME
            ELSE
                DATEADD('second', 60, r.TRIP_END_TIME)  -- 1 min after dropoff
        END AS CURR_TIME,
        -- Calculate which geometry point to use (1-based index for ST_POINTN)
        CASE 
            WHEN p.POINT_INDEX IN (0, 1) THEN 1::NUMBER(10,0)  -- At pickup location
            WHEN p.POINT_INDEX IN (13, 14) THEN r.NUM_POINTS   -- At dropoff location
            ELSE GREATEST(1::NUMBER(10,0), LEAST(r.NUM_POINTS, 
                CEIL((p.POINT_INDEX - 2) * r.NUM_POINTS / 10.0)::NUMBER(10,0)))
        END AS GEOM_IDX
    FROM route_info r
    CROSS JOIN point_seq p
)
SELECT 
    TRIP_ID,
    DRIVER_ID,
    TRIP_START_TIME AS PICKUP_TIME,
    TRIP_END_TIME AS DROPOFF_TIME,
    PICKUP_LOCATION,
    DROPOFF_LOCATION,
    ROUTE,
    ST_POINTN(ROUTE, GEOM_IDX::INT) AS POINT_GEOM,
    CURR_TIME,
    POINT_INDEX,
    DRIVER_STATE,
    -- Realistic speed based on driver state and time of day
    CASE 
        -- Stationary states (waiting for fare, picking up, dropping off)
        WHEN DRIVER_STATE = 'waiting' THEN 0
        WHEN DRIVER_STATE = 'pickup' THEN 0
        WHEN DRIVER_STATE = 'dropoff' THEN UNIFORM(0, 3, RANDOM())  -- Slowing to stop
        WHEN DRIVER_STATE = 'idle' THEN 0
        -- Driving states - vary by time of day with realistic distribution
        WHEN DRIVER_STATE = 'driving' THEN
            CASE 
                -- Morning rush (7-9 AM): heavy traffic, frequent stops
                WHEN HOUR(CURR_TIME) BETWEEN 7 AND 9 THEN
                    CASE 
                        WHEN UNIFORM(1, 100, RANDOM()) <= 15 THEN UNIFORM(0, 5, RANDOM())    -- 15% stopped/crawling (traffic, lights)
                        WHEN UNIFORM(1, 100, RANDOM()) <= 35 THEN UNIFORM(5, 15, RANDOM())   -- 20% slow traffic
                        WHEN UNIFORM(1, 100, RANDOM()) <= 70 THEN UNIFORM(15, 30, RANDOM())  -- 35% moderate
                        ELSE UNIFORM(25, 40, RANDOM())                                        -- 30% normal flow
                    END
                -- Evening rush (5-7 PM): heaviest traffic
                WHEN HOUR(CURR_TIME) BETWEEN 17 AND 19 THEN
                    CASE 
                        WHEN UNIFORM(1, 100, RANDOM()) <= 20 THEN UNIFORM(0, 5, RANDOM())    -- 20% stopped/crawling
                        WHEN UNIFORM(1, 100, RANDOM()) <= 40 THEN UNIFORM(5, 15, RANDOM())   -- 20% slow traffic
                        WHEN UNIFORM(1, 100, RANDOM()) <= 75 THEN UNIFORM(15, 30, RANDOM())  -- 35% moderate
                        ELSE UNIFORM(25, 40, RANDOM())                                        -- 25% normal flow
                    END
                -- Late night (12-5 AM): light traffic, mostly fast
                WHEN HOUR(CURR_TIME) BETWEEN 0 AND 5 THEN
                    CASE 
                        WHEN UNIFORM(1, 100, RANDOM()) <= 5 THEN UNIFORM(0, 10, RANDOM())    -- 5% occasional slow (lights)
                        WHEN UNIFORM(1, 100, RANDOM()) <= 20 THEN UNIFORM(20, 35, RANDOM())  -- 15% moderate
                        ELSE UNIFORM(35, 55, RANDOM())                                        -- 80% fast
                    END
                -- Normal hours: typical mixed traffic
                ELSE
                    CASE 
                        WHEN UNIFORM(1, 100, RANDOM()) <= 10 THEN UNIFORM(0, 8, RANDOM())    -- 10% stopped/crawling
                        WHEN UNIFORM(1, 100, RANDOM()) <= 25 THEN UNIFORM(8, 20, RANDOM())   -- 15% slow
                        WHEN UNIFORM(1, 100, RANDOM()) <= 60 THEN UNIFORM(20, 35, RANDOM())  -- 35% moderate
                        ELSE UNIFORM(30, 50, RANDOM())                                        -- 40% normal/fast
                    END
            END
    END AS KMH
FROM expanded;

-- Show location statistics
SELECT 
    COUNT(*) AS TOTAL_LOCATION_POINTS,
    COUNT(DISTINCT DRIVER_ID) AS DRIVERS,
    COUNT(DISTINCT TRIP_ID) AS TRIPS,
    MIN(CURR_TIME) AS EARLIEST_TIME,
    MAX(CURR_TIME) AS LATEST_TIME
FROM DRIVER_LOCATIONS;

-- Show speed distribution by state
SELECT 
    DRIVER_STATE,
    COUNT(*) AS COUNT,
    ROUND(AVG(KMH), 1) AS AVG_SPEED,
    MIN(KMH) AS MIN_SPEED,
    MAX(KMH) AS MAX_SPEED
FROM DRIVER_LOCATIONS
GROUP BY DRIVER_STATE
ORDER BY DRIVER_STATE;

-- Show overall speed distribution
SELECT 
    CASE 
        WHEN KMH = 0 THEN '0 (Stationary)'
        WHEN KMH BETWEEN 1 AND 5 THEN '1-5 (Crawling)'
        WHEN KMH BETWEEN 6 AND 15 THEN '6-15 (Slow)'
        WHEN KMH BETWEEN 16 AND 30 THEN '16-30 (Moderate)'
        WHEN KMH BETWEEN 31 AND 45 THEN '31-45 (Normal)'
        ELSE '46+ (Fast)'
    END AS SPEED_BAND,
    COUNT(*) AS COUNT,
    ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS PCT
FROM DRIVER_LOCATIONS
GROUP BY 1
ORDER BY 1;

SELECT 'Created ' || COUNT(*) || ' driver location points with realistic speed patterns' AS STATUS
FROM DRIVER_LOCATIONS;
