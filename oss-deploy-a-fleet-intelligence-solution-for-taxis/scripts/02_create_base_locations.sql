-- =============================================================================
-- Taxi Fleet Intelligence - Base Locations Data
-- =============================================================================
-- This script creates the TAXI_LOCATIONS table from Overture Maps data
-- containing POIs and addresses for the target city.
--
-- IMPORTANT: Modify the bounding box coordinates below to match your target city.
-- See the skill documentation for coordinates for common cities.
--
-- Prerequisites:
--   - 01_setup_database.sql executed
--   - Access to OVERTURE_MAPS__PLACES and OVERTURE_MAPS__ADDRESSES shares
-- =============================================================================

USE DATABASE FLEET_INTELLIGENCE;
USE SCHEMA PUBLIC;
USE WAREHOUSE COMPUTE_WH;

-- =============================================================================
-- CONFIGURE YOUR CITY BOUNDING BOX HERE
-- =============================================================================
-- Default: San Francisco
-- Format: ST_X = Longitude, ST_Y = Latitude
--
-- Common cities (uncomment the one you want):
--
-- SAN FRANCISCO (default):
--   ST_X BETWEEN -122.52 AND -122.35
--   ST_Y BETWEEN 37.70 AND 37.82
--
-- NEW YORK:
--   ST_X BETWEEN -74.05 AND -73.90
--   ST_Y BETWEEN 40.65 AND 40.85
--
-- LONDON:
--   ST_X BETWEEN -0.20 AND 0.05
--   ST_Y BETWEEN 51.45 AND 51.55
--
-- PARIS:
--   ST_X BETWEEN 2.25 AND 2.42
--   ST_Y BETWEEN 48.82 AND 48.90
--
-- See skill documentation for more cities or custom coordinates.
-- =============================================================================

-- Create base locations table from Overture Maps
CREATE OR REPLACE TABLE TAXI_LOCATIONS AS

-- POIs from Overture Maps Places
SELECT 
    ID AS LOCATION_ID,
    GEOMETRY AS POINT_GEOM,
    NAMES:primary::STRING AS NAME,
    CATEGORIES:primary::STRING AS CATEGORY,
    'poi' AS SOURCE_TYPE
FROM OVERTURE_MAPS__PLACES.CARTO.PLACE
WHERE 
    -- City bounding box (modify these coordinates for your city)
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
    -- City bounding box (modify these coordinates for your city)
    ST_X(GEOMETRY) BETWEEN -122.52 AND -122.35
    AND ST_Y(GEOMETRY) BETWEEN 37.70 AND 37.82
    AND STREET IS NOT NULL;

-- Show results
SELECT 
    SOURCE_TYPE,
    COUNT(*) AS LOCATION_COUNT
FROM TAXI_LOCATIONS
GROUP BY SOURCE_TYPE;

SELECT 'Base locations created: ' || COUNT(*) || ' total locations' AS STATUS
FROM TAXI_LOCATIONS;
