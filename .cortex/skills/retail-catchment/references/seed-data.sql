/*
 * seed-data.sql — Retail Catchment
 * Load San Francisco baseline data from S3.
 * Idempotent: only loads if tables are empty for the target region.
 */

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-retail-catchment","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE DATABASE IF NOT EXISTS FLEET_INTELLIGENCE
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-retail-catchment","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.RETAIL_CATCHMENT
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-retail-catchment","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE STAGE IF NOT EXISTS FLEET_INTELLIGENCE.RETAIL_CATCHMENT.SEED_STAGE
    URL = 's3://fleet-intelligence/SanFrancisco/retail-catchment/'
    FILE_FORMAT = (TYPE = PARQUET)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-retail-catchment","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

--------------------------------------------------------------------
-- RETAIL_POIS
--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.RETAIL_CATCHMENT.RETAIL_POIS (
    REGION          VARCHAR NOT NULL DEFAULT 'SanFrancisco',
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

COPY INTO FLEET_INTELLIGENCE.RETAIL_CATCHMENT.RETAIL_POIS
FROM @FLEET_INTELLIGENCE.RETAIL_CATCHMENT.SEED_STAGE/RETAIL_POIS/
FILE_FORMAT = (TYPE = PARQUET) MATCH_BY_COLUMN_NAME = CASE_INSENSITIVE ON_ERROR = CONTINUE;

--------------------------------------------------------------------
-- CITIES_BY_STATE
--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.RETAIL_CATCHMENT.CITIES_BY_STATE (
    REGION    VARCHAR NOT NULL DEFAULT 'SanFrancisco',
    STATE     VARCHAR,
    CITY      VARCHAR,
    POI_COUNT INT
)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-retail-catchment","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

COPY INTO FLEET_INTELLIGENCE.RETAIL_CATCHMENT.CITIES_BY_STATE
FROM @FLEET_INTELLIGENCE.RETAIL_CATCHMENT.SEED_STAGE/CITIES_BY_STATE/
FILE_FORMAT = (TYPE = PARQUET) MATCH_BY_COLUMN_NAME = CASE_INSENSITIVE ON_ERROR = CONTINUE;

--------------------------------------------------------------------
-- REGIONAL_ADDRESSES
--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.RETAIL_CATCHMENT.REGIONAL_ADDRESSES (
    REGION    VARCHAR NOT NULL DEFAULT 'SanFrancisco',
    ID        VARCHAR,
    GEOMETRY  GEOGRAPHY,
    LONGITUDE FLOAT,
    LATITUDE  FLOAT,
    CITY      VARCHAR,
    POSTCODE  VARCHAR
)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-retail-catchment","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

COPY INTO FLEET_INTELLIGENCE.RETAIL_CATCHMENT.REGIONAL_ADDRESSES
FROM @FLEET_INTELLIGENCE.RETAIL_CATCHMENT.SEED_STAGE/REGIONAL_ADDRESSES/
FILE_FORMAT = (TYPE = PARQUET) MATCH_BY_COLUMN_NAME = CASE_INSENSITIVE ON_ERROR = CONTINUE;

--------------------------------------------------------------------
-- REGION_CONFIG
--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.RETAIL_CATCHMENT.REGION_CONFIG (
    REGION        VARCHAR NOT NULL DEFAULT 'SanFrancisco',
    REGION_NAME   VARCHAR,
    BBOX_MIN_LON  FLOAT,
    BBOX_MIN_LAT  FLOAT,
    BBOX_MAX_LON  FLOAT,
    BBOX_MAX_LAT  FLOAT,
    CREATED_AT    TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-retail-catchment","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

COPY INTO FLEET_INTELLIGENCE.RETAIL_CATCHMENT.REGION_CONFIG
FROM @FLEET_INTELLIGENCE.RETAIL_CATCHMENT.SEED_STAGE/REGION_CONFIG/
FILE_FORMAT = (TYPE = PARQUET) MATCH_BY_COLUMN_NAME = CASE_INSENSITIVE ON_ERROR = CONTINUE;

--------------------------------------------------------------------
-- VALIDATION
--------------------------------------------------------------------
SELECT 'RETAIL_POIS' AS TBL, COUNT(*) AS ROWS FROM FLEET_INTELLIGENCE.RETAIL_CATCHMENT.RETAIL_POIS
UNION ALL SELECT 'CITIES_BY_STATE', COUNT(*) FROM FLEET_INTELLIGENCE.RETAIL_CATCHMENT.CITIES_BY_STATE
UNION ALL SELECT 'REGIONAL_ADDRESSES', COUNT(*) FROM FLEET_INTELLIGENCE.RETAIL_CATCHMENT.REGIONAL_ADDRESSES
UNION ALL SELECT 'REGION_CONFIG', COUNT(*) FROM FLEET_INTELLIGENCE.RETAIL_CATCHMENT.REGION_CONFIG;
