-- Performance optimization script for Retail Catchment Demo
-- Creates pre-filtered views and search optimization for fast queries

USE ROLE ACCOUNTADMIN;
USE DATABASE RETAIL_CATCHMENT_DEMO;
USE SCHEMA PUBLIC;
USE WAREHOUSE ROUTING_ANALYTICS;

-- =============================================================================
-- CONFIGURATION: Customize the bounding box for your region
-- =============================================================================
-- Default: San Francisco Bay Area
-- Modify these values to filter data to your area of interest
--
-- Common bounding boxes:
--   San Francisco Bay Area: (-123.0, 36.8, -121.5, 38.5)
--   New York Metro:         (-74.5, 40.4, -73.5, 41.2)
--   Los Angeles:            (-118.8, 33.5, -117.5, 34.5)
--   Chicago:                (-88.5, 41.5, -87.2, 42.2)
--   London:                 (-0.6, 51.2, 0.4, 51.8)
--   Full US (no filter):    (-180, -90, 180, 90)

SET BBOX_MIN_LON = -123.0;  -- Western boundary (longitude)
SET BBOX_MIN_LAT = 36.8;    -- Southern boundary (latitude)
SET BBOX_MAX_LON = -121.5;  -- Eastern boundary (longitude)
SET BBOX_MAX_LAT = 38.5;    -- Northern boundary (latitude)

SET REGION_NAME = 'San Francisco Bay Area';  -- For documentation

-- =============================================================================
-- STEP 1: Create filtered POI table for retail categories within bounding box
-- =============================================================================

CREATE OR REPLACE TABLE RETAIL_POIS AS
SELECT 
    ID AS POI_ID,
    NAMES:primary::VARCHAR AS POI_NAME,
    BASIC_CATEGORY,
    ST_X(GEOMETRY) AS LONGITUDE,
    ST_Y(GEOMETRY) AS LATITUDE,
    GEOMETRY,
    COALESCE(ADDRESSES[0]:freeform::VARCHAR, '') AS ADDRESS,
    ADDRESSES[0]:locality::VARCHAR AS CITY,
    ADDRESSES[0]:region::VARCHAR AS STATE,
    ADDRESSES[0]:postcode::VARCHAR AS POSTCODE
FROM OVERTURE_MAPS__PLACES.CARTO.PLACE
WHERE BASIC_CATEGORY IN (
    'coffee_shop', 'fast_food_restaurant', 'restaurant', 'casual_eatery',
    'grocery_store', 'convenience_store', 'gas_station', 'pharmacy',
    'clothing_store', 'electronics_store', 'specialty_store', 'gym',
    'beauty_salon', 'hair_salon', 'bakery', 'bar', 'supermarket'
)
AND GEOMETRY IS NOT NULL
AND ADDRESSES[0]:region IS NOT NULL
AND ST_X(GEOMETRY) BETWEEN $BBOX_MIN_LON AND $BBOX_MAX_LON
AND ST_Y(GEOMETRY) BETWEEN $BBOX_MIN_LAT AND $BBOX_MAX_LAT;

-- =============================================================================
-- STEP 2: Create pre-aggregated cities table
-- =============================================================================

CREATE OR REPLACE TABLE CITIES_BY_STATE AS
SELECT 
    STATE,
    CITY,
    COUNT(*) AS POI_COUNT
FROM RETAIL_POIS
WHERE CITY IS NOT NULL
GROUP BY STATE, CITY
HAVING COUNT(*) > 10
ORDER BY STATE, POI_COUNT DESC;

-- =============================================================================
-- STEP 3: Create addresses table within bounding box
-- =============================================================================

CREATE OR REPLACE TABLE REGIONAL_ADDRESSES AS
SELECT 
    ID,
    GEOMETRY,
    ST_X(GEOMETRY) AS LONGITUDE,
    ST_Y(GEOMETRY) AS LATITUDE,
    POSTAL_CITY AS CITY,
    POSTCODE
FROM OVERTURE_MAPS__ADDRESSES.CARTO.ADDRESS
WHERE COUNTRY = 'US'
AND GEOMETRY IS NOT NULL
AND ST_X(GEOMETRY) BETWEEN $BBOX_MIN_LON AND $BBOX_MAX_LON
AND ST_Y(GEOMETRY) BETWEEN $BBOX_MIN_LAT AND $BBOX_MAX_LAT;

-- =============================================================================
-- STEP 4: Store configuration for reference
-- =============================================================================

CREATE OR REPLACE TABLE REGION_CONFIG AS
SELECT 
    $REGION_NAME AS REGION_NAME,
    $BBOX_MIN_LON AS BBOX_MIN_LON,
    $BBOX_MIN_LAT AS BBOX_MIN_LAT,
    $BBOX_MAX_LON AS BBOX_MAX_LON,
    $BBOX_MAX_LAT AS BBOX_MAX_LAT,
    CURRENT_TIMESTAMP() AS CREATED_AT;

-- =============================================================================
-- STEP 5: Add Search Optimization to tables
-- =============================================================================

ALTER TABLE RETAIL_POIS ADD SEARCH OPTIMIZATION ON GEO(GEOMETRY);
ALTER TABLE RETAIL_POIS ADD SEARCH OPTIMIZATION ON EQUALITY(STATE, CITY, BASIC_CATEGORY);

ALTER TABLE REGIONAL_ADDRESSES ADD SEARCH OPTIMIZATION ON GEO(GEOMETRY);

ALTER TABLE CITIES_BY_STATE ADD SEARCH OPTIMIZATION ON EQUALITY(STATE);

-- =============================================================================
-- STEP 6: Create clustering on frequently filtered columns
-- =============================================================================

ALTER TABLE RETAIL_POIS CLUSTER BY (STATE, CITY, BASIC_CATEGORY);
ALTER TABLE REGIONAL_ADDRESSES CLUSTER BY (LONGITUDE, LATITUDE);

-- =============================================================================
-- STEP 7: Grant permissions
-- =============================================================================

GRANT SELECT ON TABLE RETAIL_POIS TO ROLE PUBLIC;
GRANT SELECT ON TABLE CITIES_BY_STATE TO ROLE PUBLIC;
GRANT SELECT ON TABLE REGIONAL_ADDRESSES TO ROLE PUBLIC;
GRANT SELECT ON TABLE REGION_CONFIG TO ROLE PUBLIC;

-- =============================================================================
-- Verify results
-- =============================================================================

SELECT '=== REGION CONFIGURATION ===' AS INFO;
SELECT * FROM REGION_CONFIG;

SELECT '=== TABLE ROW COUNTS ===' AS INFO;
SELECT 'RETAIL_POIS' AS TABLE_NAME, COUNT(*) AS ROW_COUNT FROM RETAIL_POIS
UNION ALL
SELECT 'CITIES_BY_STATE', COUNT(*) FROM CITIES_BY_STATE
UNION ALL
SELECT 'REGIONAL_ADDRESSES', COUNT(*) FROM REGIONAL_ADDRESSES;
