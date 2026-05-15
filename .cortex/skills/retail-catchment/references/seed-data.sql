/*
 * seed-data.sql — Retail Catchment Analysis
 * Creates schema, CONFIG, and optimized data tables from Overture Maps.
 * Run via: snow sql -f .cortex/skills/retail-catchment/references/seed-data.sql -c <connection>
 *
 * To customize for a different region, change the SET variables below.
 * Common bounding boxes:
 *   San Francisco Bay Area: (-123.0, 36.8, -121.5, 38.5)
 *   New York Metro:         (-74.5, 40.4, -73.5, 41.2)
 *   Los Angeles:            (-118.8, 33.5, -117.5, 34.5)
 *   Chicago:                (-88.5, 41.5, -87.2, 42.2)
 *   London:                 (-0.6, 51.2, 0.4, 51.8)
 */

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-retail-catchment","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

--------------------------------------------------------------------
-- REGION CONFIGURATION (customize these for your region)
--------------------------------------------------------------------
SET REGION_KEY = 'SanFrancisco';
SET BBOX_MIN_LON = -123.0;
SET BBOX_MIN_LAT = 36.8;
SET BBOX_MAX_LON = -121.5;
SET BBOX_MAX_LAT = 38.5;
SET REGION_NAME = 'San Francisco Bay Area';

--------------------------------------------------------------------
-- DATABASE, SCHEMA, WAREHOUSE
--------------------------------------------------------------------
CREATE WAREHOUSE IF NOT EXISTS ROUTING_ANALYTICS
    WAREHOUSE_SIZE = 'XSMALL'
    AUTO_SUSPEND = 60
    AUTO_RESUME = TRUE
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-retail-catchment","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE DATABASE IF NOT EXISTS FLEET_INTELLIGENCE
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-retail-catchment","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.RETAIL_CATCHMENT
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-retail-catchment","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

--------------------------------------------------------------------
-- CONFIG
--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.RETAIL_CATCHMENT.CONFIG (
    VEHICLE_TYPE VARCHAR NOT NULL,
    REGION       VARCHAR NOT NULL
)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-retail-catchment","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
MERGE INTO FLEET_INTELLIGENCE.RETAIL_CATCHMENT.CONFIG tgt
USING (SELECT 'ebike' AS VEHICLE_TYPE, 'SanFrancisco' AS REGION) src
ON TRUE
WHEN NOT MATCHED THEN INSERT (VEHICLE_TYPE, REGION) VALUES (src.VEHICLE_TYPE, src.REGION);

-- Vehicle-aware threshold reference table (Issue #33)
-- Drives SLA, geofence, and deviation behaviour based on the active VEHICLE_TYPE.
-- LOCATION_TYPE = '*' holds vehicle-level globals (deviation %, speed factor, H3 resolution).
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.RETAIL_CATCHMENT.VEHICLE_THRESHOLDS (
    VEHICLE_TYPE        VARCHAR NOT NULL,
    LOCATION_TYPE       VARCHAR NOT NULL,
    SLA_WARNING_MIN     NUMBER,
    SLA_CRITICAL_MIN    NUMBER,
    GEOFENCE_RADIUS_M   NUMBER,
    DEVIATION_PCT       NUMBER(5,2),
    SPEED_LIMIT_FACTOR  NUMBER(3,2),
    H3_RESOLUTION       NUMBER(2),
    PRIMARY KEY (VEHICLE_TYPE, LOCATION_TYPE)
)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-retail-catchment","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
MERGE INTO FLEET_INTELLIGENCE.RETAIL_CATCHMENT.VEHICLE_THRESHOLDS tgt
USING (
    SELECT column1 AS VEHICLE_TYPE, column2 AS LOCATION_TYPE,
           column3 AS SLA_WARNING_MIN, column4 AS SLA_CRITICAL_MIN,
           column5 AS GEOFENCE_RADIUS_M, column6 AS DEVIATION_PCT,
           column7 AS SPEED_LIMIT_FACTOR, column8 AS H3_RESOLUTION
    FROM VALUES
      ('car',      'WAREHOUSE',    8, 20, 150, NULL, NULL, NULL),
      ('car',      'DESTINATION',  5, 15,  80, NULL, NULL, NULL),
      ('car',      'REST_STOP',   10, 25, 120, NULL, NULL, NULL),
      ('car',      'STORE',        3, 10,  80, NULL, NULL, NULL),
      ('car',      'DETOUR',       3,  8,  80, NULL, NULL, NULL),
      ('car',      '*',         NULL, NULL, NULL, 15.00, 1.10, 8),
      ('ebike',    'WAREHOUSE',    5, 12,  80, NULL, NULL, NULL),
      ('ebike',    'DESTINATION',  3,  8,  50, NULL, NULL, NULL),
      ('ebike',    'REST_STOP',    5, 15,  60, NULL, NULL, NULL),
      ('ebike',    'STORE',        2,  6,  40, NULL, NULL, NULL),
      ('ebike',    'DETOUR',       2,  5,  50, NULL, NULL, NULL),
      ('ebike',    '*',         NULL, NULL, NULL, 25.00, 1.05, 9),
      ('hgv',      'WAREHOUSE',   30, 90, 300, NULL, NULL, NULL),
      ('hgv',      'DESTINATION', 20, 60, 200, NULL, NULL, NULL),
      ('hgv',      'REST_STOP',   45, 90, 250, NULL, NULL, NULL),
      ('hgv',      'STORE',       15, 45, 200, NULL, NULL, NULL),
      ('hgv',      'DETOUR',       5, 15, 200, NULL, NULL, NULL),
      ('hgv',      '*',         NULL, NULL, NULL, 10.00, 1.05, 7),
      ('escooter', 'WAREHOUSE',    4, 10,  60, NULL, NULL, NULL),
      ('escooter', 'DESTINATION',  2,  6,  40, NULL, NULL, NULL),
      ('escooter', 'REST_STOP',    4, 12,  50, NULL, NULL, NULL),
      ('escooter', 'STORE',        2,  5,  30, NULL, NULL, NULL),
      ('escooter', 'DETOUR',       2,  4,  40, NULL, NULL, NULL),
      ('escooter', '*',         NULL, NULL, NULL, 30.00, 1.05, 10)
) src
ON tgt.VEHICLE_TYPE = src.VEHICLE_TYPE AND tgt.LOCATION_TYPE = src.LOCATION_TYPE
WHEN NOT MATCHED THEN INSERT (VEHICLE_TYPE, LOCATION_TYPE, SLA_WARNING_MIN, SLA_CRITICAL_MIN, GEOFENCE_RADIUS_M, DEVIATION_PCT, SPEED_LIMIT_FACTOR, H3_RESOLUTION)
    VALUES (src.VEHICLE_TYPE, src.LOCATION_TYPE, src.SLA_WARNING_MIN, src.SLA_CRITICAL_MIN, src.GEOFENCE_RADIUS_M, src.DEVIATION_PCT, src.SPEED_LIMIT_FACTOR, src.H3_RESOLUTION);



--------------------------------------------------------------------
-- RETAIL_POIS
--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.RETAIL_CATCHMENT.RETAIL_POIS (
    REGION          VARCHAR NOT NULL,
    POI_ID          VARCHAR,
    POI_NAME        VARCHAR,
    BASIC_CATEGORY  VARCHAR,
    LONGITUDE       FLOAT,
    LATITUDE        FLOAT,
    GEOMETRY        GEOGRAPHY,
    ADDRESS         VARCHAR,
    CITY            VARCHAR,
    STATE           VARCHAR,
    POSTCODE        VARCHAR
)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-retail-catchment","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

DELETE FROM FLEET_INTELLIGENCE.RETAIL_CATCHMENT.RETAIL_POIS WHERE REGION = $REGION_KEY;
INSERT INTO FLEET_INTELLIGENCE.RETAIL_CATCHMENT.RETAIL_POIS
SELECT
    $REGION_KEY AS REGION,
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

--------------------------------------------------------------------
-- CITIES_BY_STATE
--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.RETAIL_CATCHMENT.CITIES_BY_STATE (
    REGION    VARCHAR NOT NULL,
    STATE     VARCHAR,
    CITY      VARCHAR,
    POI_COUNT INT
)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-retail-catchment","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

DELETE FROM FLEET_INTELLIGENCE.RETAIL_CATCHMENT.CITIES_BY_STATE WHERE REGION = $REGION_KEY;
INSERT INTO FLEET_INTELLIGENCE.RETAIL_CATCHMENT.CITIES_BY_STATE
SELECT
    $REGION_KEY AS REGION,
    STATE,
    CITY,
    COUNT(*) AS POI_COUNT
FROM FLEET_INTELLIGENCE.RETAIL_CATCHMENT.RETAIL_POIS
WHERE CITY IS NOT NULL AND REGION = $REGION_KEY
GROUP BY STATE, CITY
HAVING COUNT(*) > 10
ORDER BY STATE, POI_COUNT DESC;

--------------------------------------------------------------------
-- REGIONAL_ADDRESSES
--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.RETAIL_CATCHMENT.REGIONAL_ADDRESSES (
    REGION    VARCHAR NOT NULL,
    ID        VARCHAR,
    GEOMETRY  GEOGRAPHY,
    LONGITUDE FLOAT,
    LATITUDE  FLOAT,
    CITY      VARCHAR,
    POSTCODE  VARCHAR
)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-retail-catchment","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

DELETE FROM FLEET_INTELLIGENCE.RETAIL_CATCHMENT.REGIONAL_ADDRESSES WHERE REGION = $REGION_KEY;
INSERT INTO FLEET_INTELLIGENCE.RETAIL_CATCHMENT.REGIONAL_ADDRESSES
SELECT
    $REGION_KEY AS REGION,
    ID,
    GEOMETRY,
    ST_X(GEOMETRY) AS LONGITUDE,
    ST_Y(GEOMETRY) AS LATITUDE,
    ADDRESS_LEVELS[1]:value::VARCHAR AS CITY,
    POSTCODE
FROM OVERTURE_MAPS__ADDRESSES.CARTO.ADDRESS
WHERE COUNTRY = 'US'
AND GEOMETRY IS NOT NULL
AND ST_X(GEOMETRY) BETWEEN $BBOX_MIN_LON AND $BBOX_MAX_LON
AND ST_Y(GEOMETRY) BETWEEN $BBOX_MIN_LAT AND $BBOX_MAX_LAT;

--------------------------------------------------------------------
-- REGION_CONFIG
--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.RETAIL_CATCHMENT.REGION_CONFIG (
    REGION        VARCHAR NOT NULL,
    REGION_NAME   VARCHAR,
    BBOX_MIN_LON  FLOAT,
    BBOX_MIN_LAT  FLOAT,
    BBOX_MAX_LON  FLOAT,
    BBOX_MAX_LAT  FLOAT,
    CREATED_AT    TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-retail-catchment","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

DELETE FROM FLEET_INTELLIGENCE.RETAIL_CATCHMENT.REGION_CONFIG WHERE REGION = $REGION_KEY;
INSERT INTO FLEET_INTELLIGENCE.RETAIL_CATCHMENT.REGION_CONFIG
SELECT
    $REGION_KEY AS REGION,
    $REGION_NAME AS REGION_NAME,
    $BBOX_MIN_LON AS BBOX_MIN_LON,
    $BBOX_MIN_LAT AS BBOX_MIN_LAT,
    $BBOX_MAX_LON AS BBOX_MAX_LON,
    $BBOX_MAX_LAT AS BBOX_MAX_LAT,
    CURRENT_TIMESTAMP() AS CREATED_AT;

--------------------------------------------------------------------
-- SEARCH OPTIMIZATION & CLUSTERING
--------------------------------------------------------------------
ALTER TABLE FLEET_INTELLIGENCE.RETAIL_CATCHMENT.RETAIL_POIS ADD SEARCH OPTIMIZATION ON EQUALITY(STATE, CITY, BASIC_CATEGORY);
ALTER TABLE FLEET_INTELLIGENCE.RETAIL_CATCHMENT.REGIONAL_ADDRESSES ADD SEARCH OPTIMIZATION ON GEO(GEOMETRY);
ALTER TABLE FLEET_INTELLIGENCE.RETAIL_CATCHMENT.CITIES_BY_STATE ADD SEARCH OPTIMIZATION ON EQUALITY(STATE);

ALTER TABLE FLEET_INTELLIGENCE.RETAIL_CATCHMENT.RETAIL_POIS CLUSTER BY (STATE, CITY, BASIC_CATEGORY);
ALTER TABLE FLEET_INTELLIGENCE.RETAIL_CATCHMENT.REGIONAL_ADDRESSES CLUSTER BY (LONGITUDE, LATITUDE);



--------------------------------------------------------------------
-- VALIDATION
--------------------------------------------------------------------
SELECT 'CONFIG' AS TABLE_NAME, COUNT(*) AS ROW_COUNT FROM FLEET_INTELLIGENCE.RETAIL_CATCHMENT.CONFIG
UNION ALL
SELECT 'RETAIL_POIS', COUNT(*) FROM FLEET_INTELLIGENCE.RETAIL_CATCHMENT.RETAIL_POIS
UNION ALL
SELECT 'CITIES_BY_STATE', COUNT(*) FROM FLEET_INTELLIGENCE.RETAIL_CATCHMENT.CITIES_BY_STATE
UNION ALL
SELECT 'REGIONAL_ADDRESSES', COUNT(*) FROM FLEET_INTELLIGENCE.RETAIL_CATCHMENT.REGIONAL_ADDRESSES
UNION ALL
SELECT 'REGION_CONFIG', COUNT(*) FROM FLEET_INTELLIGENCE.RETAIL_CATCHMENT.REGION_CONFIG;
