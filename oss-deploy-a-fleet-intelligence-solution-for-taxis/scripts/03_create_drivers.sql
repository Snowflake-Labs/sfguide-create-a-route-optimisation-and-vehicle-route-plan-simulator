-- =============================================================================
-- SF Taxi Fleet Intelligence - Driver Generation
-- =============================================================================
-- This script creates 80 taxi drivers with shift patterns designed for
-- 24-hour coverage with peak hour staffing.
--
-- Shift Distribution:
--   - Morning (06:00-14:00): 22 drivers - Full morning rush coverage
--   - Early (04:00-12:00): 18 drivers - Early morning + morning rush start
--   - Day (11:00-19:00): 18 drivers - Midday + evening rush start
--   - Evening (15:00-23:00): 14 drivers - Afternoon + evening rush
--   - Graveyard (22:00-06:00): 8 drivers - Overnight coverage
--
-- Prerequisites:
--   - 01_setup_database.sql executed
--   - 02_create_base_locations.sql executed
-- =============================================================================

USE DATABASE OPENROUTESERVICE_NATIVE_APP;
USE SCHEMA FLEET_INTELLIGENCE_TAXIS;
USE WAREHOUSE COMPUTE_WH;

-- Create TAXI_DRIVERS table with shift patterns
CREATE OR REPLACE TABLE TAXI_DRIVERS AS
WITH shift_patterns AS (
    -- Define shift patterns for 24-hour coverage with peak hour staffing
    SELECT 1 AS shift_id, 'Graveyard' AS shift_name, 22 AS shift_start, 6 AS shift_end, 8 AS driver_count UNION ALL
    SELECT 2, 'Early', 4, 12, 18 UNION ALL
    SELECT 3, 'Morning', 6, 14, 22 UNION ALL
    SELECT 4, 'Day', 11, 19, 18 UNION ALL
    SELECT 5, 'Evening', 15, 23, 14
),
driver_assignments AS (
    SELECT 
        ROW_NUMBER() OVER (ORDER BY sp.shift_id, seq.seq) AS driver_num,
        sp.shift_name AS shift_type,
        sp.shift_start AS shift_start_hour,
        sp.shift_end AS shift_end_hour,
        CASE WHEN sp.shift_start > sp.shift_end THEN 'True' ELSE 'False' END AS shift_crosses_midnight
    FROM shift_patterns sp
    CROSS JOIN (SELECT SEQ4() + 1 AS seq FROM TABLE(GENERATOR(ROWCOUNT => 22))) seq
    WHERE seq.seq <= sp.driver_count
),
home_locations AS (
    SELECT 
        LOCATION_ID,
        ROW_NUMBER() OVER (ORDER BY RANDOM()) AS rn
    FROM SF_TAXI_LOCATIONS
    WHERE SOURCE_TYPE = 'address'
    LIMIT 100
)
SELECT 
    'D-' || LPAD(da.driver_num::STRING, 4, '0') AS DRIVER_ID,
    hl.LOCATION_ID AS HOME_LOCATION_ID,
    da.shift_type AS SHIFT_TYPE,
    da.shift_start_hour AS SHIFT_START_HOUR,
    da.shift_end_hour AS SHIFT_END_HOUR,
    da.shift_crosses_midnight AS SHIFT_CROSSES_MIDNIGHT
FROM driver_assignments da
JOIN home_locations hl ON da.driver_num = hl.rn;

-- Create DRIVERS table (display-friendly version)
CREATE OR REPLACE TABLE DRIVERS AS
SELECT 
    DRIVER_ID,
    'Driver ' || DRIVER_ID AS DRIVER_NAME,
    SHIFT_TYPE,
    SHIFT_START_HOUR,
    SHIFT_END_HOUR,
    SHIFT_CROSSES_MIDNIGHT
FROM TAXI_DRIVERS;

-- Show shift distribution
SELECT 
    SHIFT_TYPE,
    COUNT(*) AS NUM_DRIVERS,
    MIN(SHIFT_START_HOUR) || ':00 - ' || MIN(SHIFT_END_HOUR) || ':00' AS SHIFT_HOURS
FROM TAXI_DRIVERS
GROUP BY SHIFT_TYPE
ORDER BY NUM_DRIVERS DESC;

SELECT 'Created ' || COUNT(*) || ' drivers with shift patterns' AS STATUS
FROM TAXI_DRIVERS;
