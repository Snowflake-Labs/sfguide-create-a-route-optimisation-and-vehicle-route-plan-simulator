-- Fleet Intelligence Solution for SF Taxis - Data Setup
-- This script creates synthetic SF taxi fleet data with 80 drivers and shift patterns
-- Peak hours have more active drivers, but 24-hour coverage is maintained

ALTER SESSION SET QUERY_TAG = '{"origin":"sf_sit-is", "name":"Fleet Intelligence Lab", "version":{"major":1, "minor":1},"attributes":{"is_quickstart":0, "source":"sql"}}';

USE ROLE ACCOUNTADMIN;

-- Create warehouse if needed
CREATE WAREHOUSE IF NOT EXISTS DEFAULT_WH
    AUTO_SUSPEND = 60
    AUTO_RESUME = TRUE
    WAREHOUSE_SIZE = 'XSMALL';

USE WAREHOUSE DEFAULT_WH;

-- Enable Cortex cross-region if needed
ALTER ACCOUNT SET CORTEX_ENABLED_CROSS_REGION = 'ANY_REGION';

-------------------------------------------------------------
-- OPENROUTESERVICE_NATIVE_APP.FLEET_INTELLIGENCE_TAXIS SCHEMA SETUP
-------------------------------------------------------------

USE DATABASE OPENROUTESERVICE_NATIVE_APP;
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE_TAXIS;
USE SCHEMA FLEET_INTELLIGENCE_TAXIS;

-------------------------------------------------------------
-- STEP 1: Generate SF Addresses using Cortex AI
-------------------------------------------------------------

CREATE OR REPLACE TABLE SF_ADDRESSES AS
SELECT 
    ROW_NUMBER() OVER (ORDER BY value:address) AS ADDRESS_ID,
    value:address::TEXT AS ADDRESS,
    value:street::TEXT AS STREET,
    value:neighborhood::TEXT AS NEIGHBORHOOD,
    value:latitude::FLOAT AS LATITUDE,
    value:longitude::FLOAT AS LONGITUDE,
    TO_GEOGRAPHY(CONCAT('POINT(', value:longitude::TEXT, ' ', value:latitude::TEXT, ')')) AS LOCATION
FROM (
    SELECT AI_COMPLETE(
        model => 'claude-4-sonnet',
        prompt => 'Generate 150 realistic San Francisco addresses across different neighborhoods including Downtown, SOMA, Mission, Castro, Marina, North Beach, Chinatown, Financial District, Nob Hill, and Richmond. Include a mix of residential addresses, hotels, restaurants, and commercial locations. Latitude should be between 37.70 and 37.82, longitude between -122.52 and -122.35.',
        response_format => {
            'type': 'json',
            'schema': {
                'type': 'object',
                'properties': {
                    'addresses': {
                        'type': 'array',
                        'items': {
                            'type': 'object',
                            'properties': {
                                'address': {'type': 'string'},
                                'street': {'type': 'string'},
                                'neighborhood': {'type': 'string'},
                                'latitude': {'type': 'number'},
                                'longitude': {'type': 'number'}
                            },
                            'required': ['address', 'street', 'neighborhood', 'latitude', 'longitude']
                        }
                    }
                }
            }
        }
    ):addresses AS addresses
), LATERAL FLATTEN(input => addresses);

-------------------------------------------------------------
-- STEP 2: Generate 80 Drivers with Shift Patterns
-- Shift distribution ensures 24-hour coverage with peak hour staffing
-------------------------------------------------------------

CREATE OR REPLACE TABLE DRIVERS AS
WITH shift_patterns AS (
    -- Define shift patterns for 24-hour coverage with peak hour staffing
    -- Graveyard: 22:00-06:00 (8 drivers) - overnight coverage
    -- Early:     04:00-12:00 (18 drivers) - early morning + morning rush start
    -- Morning:   06:00-14:00 (22 drivers) - full morning rush coverage
    -- Day:       11:00-19:00 (18 drivers) - midday + evening rush start  
    -- Evening:   15:00-23:00 (14 drivers) - afternoon + evening rush
    SELECT 1 AS shift_id, 'Graveyard' AS shift_name, 22 AS shift_start, 30 AS shift_end, 8 AS driver_count UNION ALL  -- 30=6AM next day
    SELECT 2, 'Early', 4, 12, 18 UNION ALL
    SELECT 3, 'Morning', 6, 14, 22 UNION ALL
    SELECT 4, 'Day', 11, 19, 18 UNION ALL
    SELECT 5, 'Evening', 15, 23, 14
),
driver_assignments AS (
    SELECT 
        sp.shift_id,
        sp.shift_name,
        sp.shift_start,
        CASE WHEN sp.shift_end > 24 THEN sp.shift_end - 24 ELSE sp.shift_end END AS shift_end,
        sp.shift_end > 24 AS crosses_midnight,
        ROW_NUMBER() OVER (ORDER BY sp.shift_id, seq.seq) AS driver_num
    FROM shift_patterns sp
    CROSS JOIN (SELECT SEQ4() + 1 AS seq FROM TABLE(GENERATOR(ROWCOUNT => 25))) seq
    WHERE seq.seq <= sp.driver_count
)
SELECT 
    'D-' || LPAD(driver_num::TEXT, 4, '0') AS DRIVER_ID,
    AI_COMPLETE('mistral-large2', 'Generate a random first and last name for a San Francisco taxi driver. Return only the name, nothing else.')::TEXT AS DRIVER_NAME,
    shift_name AS SHIFT_TYPE,
    shift_start AS SHIFT_START_HOUR,
    shift_end AS SHIFT_END_HOUR,
    crosses_midnight AS SHIFT_CROSSES_MIDNIGHT
FROM driver_assignments
ORDER BY driver_num;

-------------------------------------------------------------
-- STEP 3: Generate Trips with Routes (more trips for 80 drivers)
-------------------------------------------------------------

CREATE OR REPLACE TABLE TRIPS AS
WITH trip_data AS (
    SELECT 
        'T' || LPAD(ROW_NUMBER() OVER (ORDER BY RANDOM())::TEXT, 6, '0') AS TRIP_ID,
        o.ADDRESS_ID AS ORIGIN_ADDRESS_ID,
        o.ADDRESS AS ORIGIN_ADDRESS,
        o.STREET AS ORIGIN_STREET,
        o.LATITUDE AS ORIGIN_LAT,
        o.LONGITUDE AS ORIGIN_LON,
        o.LOCATION AS ORIGIN,
        d.ADDRESS_ID AS DEST_ADDRESS_ID,
        d.ADDRESS AS DESTINATION_ADDRESS,
        d.STREET AS DESTINATION_STREET,
        d.LATITUDE AS DEST_LAT,
        d.LONGITUDE AS DEST_LON,
        d.LOCATION AS DESTINATION,
        DATEADD('minute', UNIFORM(0, 1440, RANDOM()), CURRENT_DATE()) AS PICKUP_TIME,
        UNIFORM(5, 45, RANDOM()) AS TRIP_DURATION_MINS
    FROM SF_ADDRESSES o
    CROSS JOIN SF_ADDRESSES d
    WHERE o.ADDRESS_ID != d.ADDRESS_ID
    ORDER BY RANDOM()
    LIMIT 800  -- 4x more trips for 4x more drivers
)
SELECT 
    TRIP_ID,
    ORIGIN_ADDRESS_ID,
    ORIGIN_ADDRESS,
    ORIGIN_STREET,
    ORIGIN_LAT,
    ORIGIN_LON,
    ORIGIN,
    DEST_ADDRESS_ID,
    DESTINATION_ADDRESS,
    DESTINATION_STREET,
    DEST_LAT,
    DEST_LON,
    DESTINATION,
    PICKUP_TIME,
    DATEADD('minute', TRIP_DURATION_MINS, PICKUP_TIME) AS DROPOFF_TIME,
    TRIP_DURATION_MINS,
    ST_DISTANCE(ORIGIN, DESTINATION) AS DISTANCE_METERS,
    ST_MAKELINE(ORIGIN, DESTINATION) AS GEOMETRY
FROM trip_data;

-------------------------------------------------------------
-- STEP 4: Create Route Names
-------------------------------------------------------------

CREATE OR REPLACE TABLE ROUTE_NAMES AS
SELECT 
    TRIP_ID,
    ORIGIN_STREET || ' to ' || DESTINATION_STREET AS TRIP_NAME
FROM TRIPS;

-------------------------------------------------------------
-- STEP 5: Assign Trips to Drivers Based on Shift Patterns
-- Trips are assigned to drivers who are on-shift at pickup time
-------------------------------------------------------------

CREATE OR REPLACE TABLE TRIPS_ASSIGNED_TO_DRIVERS AS
WITH trip_hours AS (
    SELECT 
        t.*,
        HOUR(t.PICKUP_TIME) AS TRIP_HOUR
    FROM TRIPS t
),
-- Find drivers who are on shift for each trip
eligible_drivers AS (
    SELECT 
        th.*,
        d.DRIVER_ID,
        d.DRIVER_NAME,
        d.SHIFT_TYPE,
        d.SHIFT_START_HOUR,
        d.SHIFT_END_HOUR,
        d.SHIFT_CROSSES_MIDNIGHT
    FROM trip_hours th
    CROSS JOIN DRIVERS d
    WHERE 
        -- Normal shift (doesn't cross midnight)
        (NOT d.SHIFT_CROSSES_MIDNIGHT AND th.TRIP_HOUR >= d.SHIFT_START_HOUR AND th.TRIP_HOUR < d.SHIFT_END_HOUR)
        OR
        -- Shift that crosses midnight (e.g., 18:00 - 02:00)
        (d.SHIFT_CROSSES_MIDNIGHT AND (th.TRIP_HOUR >= d.SHIFT_START_HOUR OR th.TRIP_HOUR < d.SHIFT_END_HOUR))
),
-- Randomly assign one driver per trip from eligible drivers
ranked_assignments AS (
    SELECT 
        *,
        ROW_NUMBER() OVER (PARTITION BY TRIP_ID ORDER BY RANDOM()) AS rn
    FROM eligible_drivers
)
SELECT 
    TRIP_ID,
    ORIGIN_ADDRESS_ID,
    ORIGIN_ADDRESS,
    ORIGIN_STREET,
    ORIGIN_LAT,
    ORIGIN_LON,
    ORIGIN,
    DEST_ADDRESS_ID,
    DESTINATION_ADDRESS,
    DESTINATION_STREET,
    DEST_LAT,
    DEST_LON,
    DESTINATION,
    PICKUP_TIME,
    DROPOFF_TIME,
    TRIP_DURATION_MINS,
    DISTANCE_METERS,
    GEOMETRY,
    DRIVER_ID,
    DRIVER_NAME,
    SHIFT_TYPE
FROM ranked_assignments
WHERE rn = 1;

-------------------------------------------------------------
-- STEP 6: Generate Driver Locations (simulated GPS points)
-- Each driver has minute-by-minute tracking during their shift
-------------------------------------------------------------

CREATE OR REPLACE TABLE DRIVER_LOCATIONS AS
WITH 
-- Generate all minutes in 24 hours
all_minutes AS (
    SELECT 
        SEQ4() AS MINUTE_OF_DAY,
        DATEADD('minute', SEQ4(), DATE_TRUNC('day', CURRENT_TIMESTAMP())) AS CURR_TIME
    FROM TABLE(GENERATOR(ROWCOUNT => 1440))
),
-- Get driver shift info
driver_shifts AS (
    SELECT 
        DRIVER_ID,
        DRIVER_NAME,
        SHIFT_START_HOUR,
        SHIFT_END_HOUR,
        SHIFT_CROSSES_MIDNIGHT
    FROM DRIVERS
),
-- Join drivers with all minutes to get their on-shift times
driver_minutes AS (
    SELECT 
        ds.DRIVER_ID,
        am.CURR_TIME,
        am.MINUTE_OF_DAY,
        HOUR(am.CURR_TIME) AS CURR_HOUR,
        ds.SHIFT_START_HOUR,
        ds.SHIFT_END_HOUR,
        ds.SHIFT_CROSSES_MIDNIGHT,
        CASE 
            WHEN NOT ds.SHIFT_CROSSES_MIDNIGHT 
                THEN HOUR(am.CURR_TIME) >= ds.SHIFT_START_HOUR AND HOUR(am.CURR_TIME) < ds.SHIFT_END_HOUR
            ELSE HOUR(am.CURR_TIME) >= ds.SHIFT_START_HOUR OR HOUR(am.CURR_TIME) < ds.SHIFT_END_HOUR
        END AS IS_ON_SHIFT
    FROM driver_shifts ds
    CROSS JOIN all_minutes am
),
-- Get trips for interpolation
trip_points AS (
    SELECT 
        t.TRIP_ID,
        t.DRIVER_ID,
        t.PICKUP_TIME,
        t.DROPOFF_TIME,
        t.ORIGIN,
        t.DESTINATION,
        t.GEOMETRY AS ROUTE,
        t.ORIGIN AS PICKUP_LOCATION,
        t.DESTINATION AS DROPOFF_LOCATION,
        t.ORIGIN_LAT,
        t.ORIGIN_LON,
        t.DEST_LAT,
        t.DEST_LON,
        -- Generate points along the trip timeline
        s.INDEX AS POINT_INDEX,
        DATEADD('second', 
            (DATEDIFF('second', t.PICKUP_TIME, t.DROPOFF_TIME) * s.INDEX / 10)::INT, 
            t.PICKUP_TIME
        ) AS POINT_TIME,
        -- Interpolate position (simple linear interpolation)
        ST_MAKEPOINT(
            t.ORIGIN_LON + (t.DEST_LON - t.ORIGIN_LON) * (s.INDEX / 10.0),
            t.ORIGIN_LAT + (t.DEST_LAT - t.ORIGIN_LAT) * (s.INDEX / 10.0)
        ) AS POINT_GEOM
    FROM TRIPS_ASSIGNED_TO_DRIVERS t
    CROSS JOIN (SELECT SEQ4() AS INDEX FROM TABLE(GENERATOR(ROWCOUNT => 11))) s
)
SELECT 
    TRIP_ID,
    DRIVER_ID,
    PICKUP_TIME,
    DROPOFF_TIME,
    PICKUP_LOCATION,
    DROPOFF_LOCATION,
    ROUTE,
    POINT_GEOM,
    POINT_TIME AS CURR_TIME,
    POINT_INDEX,
    -- Simulate speed (km/h) with variation based on time of day
    CASE 
        WHEN HOUR(POINT_TIME) BETWEEN 7 AND 9 THEN UNIFORM(10, 30, RANDOM())  -- Morning rush - slower
        WHEN HOUR(POINT_TIME) BETWEEN 17 AND 19 THEN UNIFORM(10, 30, RANDOM())  -- Evening rush - slower
        WHEN HOUR(POINT_TIME) BETWEEN 0 AND 5 THEN UNIFORM(35, 55, RANDOM())  -- Late night - faster
        ELSE UNIFORM(20, 45, RANDOM())  -- Normal traffic
    END + UNIFORM(-5, 5, RANDOM()) AS KMH
FROM trip_points;

-------------------------------------------------------------
-- STEP 7: Create Trip Route Plan (with ORS directions if available)
-------------------------------------------------------------

CREATE OR REPLACE TABLE TRIP_ROUTE_PLAN AS
SELECT 
    t.TRIP_ID,
    t.DRIVER_ID,
    t.ORIGIN_ADDRESS,
    t.ORIGIN_STREET,
    t.DESTINATION_ADDRESS,
    t.DESTINATION_STREET,
    t.PICKUP_TIME,
    t.DROPOFF_TIME,
    t.ORIGIN,
    t.DESTINATION,
    t.GEOMETRY,
    t.DISTANCE_METERS,
    t.SHIFT_TYPE,
    -- Create a simple route object structure
    OBJECT_CONSTRUCT(
        'features', ARRAY_CONSTRUCT(
            OBJECT_CONSTRUCT(
                'properties', OBJECT_CONSTRUCT(
                    'summary', OBJECT_CONSTRUCT(
                        'distance', t.DISTANCE_METERS,
                        'duration', t.TRIP_DURATION_MINS * 60
                    )
                )
            )
        )
    ) AS ROUTE
FROM TRIPS_ASSIGNED_TO_DRIVERS t;

-------------------------------------------------------------
-- STEP 8: Create Trip Summary with statistics
-------------------------------------------------------------

CREATE OR REPLACE TABLE TRIP_SUMMARY AS
SELECT 
    t.TRIP_ID,
    t.DRIVER_ID,
    t.ORIGIN,
    t.DESTINATION,
    t.ORIGIN_ADDRESS,
    t.DESTINATION_ADDRESS,
    t.PICKUP_TIME,
    t.DROPOFF_TIME AS ACTUAL_DROPOFF_TIME,
    t.GEOMETRY,
    t.DISTANCE_METERS,
    t.SHIFT_TYPE,
    AVG(dl.KMH) AS AVERAGE_KMH,
    MAX(dl.KMH) AS MAX_KMH,
    -- Nearest POI placeholders
    'SF Landmark' AS ORIGIN_NEAREST_POI,
    'SF Destination' AS DESTINATION_NEAREST_POI
FROM TRIPS_ASSIGNED_TO_DRIVERS t
LEFT JOIN DRIVER_LOCATIONS dl ON t.TRIP_ID = dl.TRIP_ID
GROUP BY ALL;

-------------------------------------------------------------
-- STEP 9: Create Driver Activity Summary (hourly active drivers)
-------------------------------------------------------------

CREATE OR REPLACE TABLE DRIVER_ACTIVITY_HOURLY AS
WITH hours AS (
    SELECT SEQ4() AS HOUR_OF_DAY FROM TABLE(GENERATOR(ROWCOUNT => 24))
),
driver_hours AS (
    SELECT 
        h.HOUR_OF_DAY,
        d.DRIVER_ID,
        d.SHIFT_TYPE,
        CASE 
            WHEN NOT d.SHIFT_CROSSES_MIDNIGHT 
                THEN h.HOUR_OF_DAY >= d.SHIFT_START_HOUR AND h.HOUR_OF_DAY < d.SHIFT_END_HOUR
            ELSE h.HOUR_OF_DAY >= d.SHIFT_START_HOUR OR h.HOUR_OF_DAY < d.SHIFT_END_HOUR
        END AS IS_ON_SHIFT
    FROM hours h
    CROSS JOIN DRIVERS d
)
SELECT 
    HOUR_OF_DAY,
    COUNT(CASE WHEN IS_ON_SHIFT THEN 1 END) AS ACTIVE_DRIVERS,
    COUNT(CASE WHEN IS_ON_SHIFT AND SHIFT_TYPE = 'Night' THEN 1 END) AS NIGHT_SHIFT_DRIVERS,
    COUNT(CASE WHEN IS_ON_SHIFT AND SHIFT_TYPE = 'Morning' THEN 1 END) AS MORNING_SHIFT_DRIVERS,
    COUNT(CASE WHEN IS_ON_SHIFT AND SHIFT_TYPE = 'Day' THEN 1 END) AS DAY_SHIFT_DRIVERS,
    COUNT(CASE WHEN IS_ON_SHIFT AND SHIFT_TYPE = 'Evening' THEN 1 END) AS EVENING_SHIFT_DRIVERS,
    COUNT(CASE WHEN IS_ON_SHIFT AND SHIFT_TYPE = 'Late' THEN 1 END) AS LATE_SHIFT_DRIVERS
FROM driver_hours
GROUP BY HOUR_OF_DAY
ORDER BY HOUR_OF_DAY;

-------------------------------------------------------------
-- STEP 10: Create views for compatibility
-------------------------------------------------------------

CREATE OR REPLACE VIEW SF_ADDRESSES_V AS
SELECT * FROM OPENROUTESERVICE_NATIVE_APP.FLEET_INTELLIGENCE_TAXIS.SF_ADDRESSES;

CREATE OR REPLACE VIEW DRIVERS_V AS
SELECT * FROM OPENROUTESERVICE_NATIVE_APP.FLEET_INTELLIGENCE_TAXIS.DRIVERS;

CREATE OR REPLACE VIEW DRIVER_LOCATIONS_V AS
SELECT * FROM OPENROUTESERVICE_NATIVE_APP.FLEET_INTELLIGENCE_TAXIS.DRIVER_LOCATIONS;

CREATE OR REPLACE VIEW DRIVER_ACTIVITY_HOURLY_V AS
SELECT * FROM OPENROUTESERVICE_NATIVE_APP.FLEET_INTELLIGENCE_TAXIS.DRIVER_ACTIVITY_HOURLY;

-------------------------------------------------------------
-- VERIFICATION: Check data was created
-------------------------------------------------------------

SELECT 'SF_ADDRESSES' AS TABLE_NAME, COUNT(*) AS ROW_COUNT FROM OPENROUTESERVICE_NATIVE_APP.FLEET_INTELLIGENCE_TAXIS.SF_ADDRESSES
UNION ALL SELECT 'DRIVERS', COUNT(*) FROM OPENROUTESERVICE_NATIVE_APP.FLEET_INTELLIGENCE_TAXIS.DRIVERS
UNION ALL SELECT 'TRIPS', COUNT(*) FROM OPENROUTESERVICE_NATIVE_APP.FLEET_INTELLIGENCE_TAXIS.TRIPS
UNION ALL SELECT 'ROUTE_NAMES', COUNT(*) FROM OPENROUTESERVICE_NATIVE_APP.FLEET_INTELLIGENCE_TAXIS.ROUTE_NAMES
UNION ALL SELECT 'TRIPS_ASSIGNED_TO_DRIVERS', COUNT(*) FROM OPENROUTESERVICE_NATIVE_APP.FLEET_INTELLIGENCE_TAXIS.TRIPS_ASSIGNED_TO_DRIVERS
UNION ALL SELECT 'DRIVER_LOCATIONS', COUNT(*) FROM OPENROUTESERVICE_NATIVE_APP.FLEET_INTELLIGENCE_TAXIS.DRIVER_LOCATIONS
UNION ALL SELECT 'TRIP_ROUTE_PLAN', COUNT(*) FROM OPENROUTESERVICE_NATIVE_APP.FLEET_INTELLIGENCE_TAXIS.TRIP_ROUTE_PLAN
UNION ALL SELECT 'TRIP_SUMMARY', COUNT(*) FROM OPENROUTESERVICE_NATIVE_APP.FLEET_INTELLIGENCE_TAXIS.TRIP_SUMMARY
UNION ALL SELECT 'DRIVER_ACTIVITY_HOURLY', COUNT(*) FROM OPENROUTESERVICE_NATIVE_APP.FLEET_INTELLIGENCE_TAXIS.DRIVER_ACTIVITY_HOURLY;

-- Show driver distribution by shift
SELECT 
    SHIFT_TYPE,
    COUNT(*) AS DRIVER_COUNT,
    MIN(SHIFT_START_HOUR) || ':00 - ' || MIN(SHIFT_END_HOUR) || ':00' AS SHIFT_HOURS
FROM OPENROUTESERVICE_NATIVE_APP.FLEET_INTELLIGENCE_TAXIS.DRIVERS
GROUP BY SHIFT_TYPE
ORDER BY MIN(SHIFT_START_HOUR);

-- Show hourly driver coverage (peak hours should have more drivers)
SELECT * FROM OPENROUTESERVICE_NATIVE_APP.FLEET_INTELLIGENCE_TAXIS.DRIVER_ACTIVITY_HOURLY ORDER BY HOUR_OF_DAY;

SELECT 'Setup complete! Fleet Intelligence data has been created with 80 drivers and shift patterns.' AS STATUS;
