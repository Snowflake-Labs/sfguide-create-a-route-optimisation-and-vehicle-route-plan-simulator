-- =============================================================================
-- SF Taxi Fleet Intelligence - Base Locations Data
-- =============================================================================
-- This script creates the SF_TAXI_LOCATIONS table from Overture Maps data
-- containing POIs and addresses for San Francisco.
--
-- Prerequisites:
--   - 01_setup_database.sql executed
--   - Access to OVERTURE_MAPS__PLACES and OVERTURE_MAPS__ADDRESSES shares
-- =============================================================================

USE DATABASE OPENROUTESERVICE_NATIVE_APP;
USE SCHEMA FLEET_INTELLIGENCE_TAXIS;
USE WAREHOUSE COMPUTE_WH;

-- Create base locations table from Overture Maps
CREATE OR REPLACE TABLE SF_TAXI_LOCATIONS AS

-- POIs from Overture Maps Places
SELECT 
    ID AS LOCATION_ID,
    GEOMETRY AS POINT_GEOM,
    NAMES:primary::STRING AS NAME,
    CATEGORIES:primary::STRING AS CATEGORY,
    'poi' AS SOURCE_TYPE
FROM OVERTURE_MAPS__PLACES.CARTO.PLACE
WHERE 
    -- San Francisco bounding box
    ST_X(GEOMETRY) BETWEEN -122.52 AND -122.35
    AND ST_Y(GEOMETRY) BETWEEN 37.70 AND 37.82
    AND NAMES:primary IS NOT NULL

UNION ALL

-- Addresses from Overture Maps Addresses
SELECT 
    ID AS LOCATION_ID,
    GEOMETRY AS POINT_GEOM,
    COALESCE(
        ADDRESS_LEVELS[0]:value::STRING || ' ' || STREET,
        STREET
    ) AS NAME,
    'address' AS CATEGORY,
    'address' AS SOURCE_TYPE
FROM OVERTURE_MAPS__ADDRESSES.CARTO.ADDRESS
WHERE 
    -- San Francisco bounding box
    ST_X(GEOMETRY) BETWEEN -122.52 AND -122.35
    AND ST_Y(GEOMETRY) BETWEEN 37.70 AND 37.82
    AND STREET IS NOT NULL;

-- Show results
SELECT 
    SOURCE_TYPE,
    COUNT(*) AS LOCATION_COUNT
FROM SF_TAXI_LOCATIONS
GROUP BY SOURCE_TYPE;

SELECT 'Base locations created: ' || COUNT(*) || ' total locations' AS STATUS
FROM SF_TAXI_LOCATIONS;
