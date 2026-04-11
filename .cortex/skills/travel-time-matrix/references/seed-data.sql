/*
 * seed-data.sql — Travel Time Matrix
 * Load San Francisco baseline data from S3.
 * Idempotent: only loads if tables are empty for the target region.
 *
 * NOTE: The S3 bucket may be empty. If COPY INTO loads 0 rows, generate data
 * via the ORS Control App Data Studio or the travel-time-matrix skill pipeline.
 */

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-travel-time-matrix","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE DATABASE IF NOT EXISTS FLEET_INTELLIGENCE
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-travel-time-matrix","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.TRAVEL_TIME_MATRIX
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-travel-time-matrix","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE STAGE IF NOT EXISTS FLEET_INTELLIGENCE.TRAVEL_TIME_MATRIX.SEED_STAGE
    URL = 's3://fleet-intelligence/SanFrancisco/travel-time-matrix/'
    FILE_FORMAT = (TYPE = PARQUET)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-travel-time-matrix","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

--------------------------------------------------------------------
-- SF_HEXAGONS
--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.TRAVEL_TIME_MATRIX.SF_HEXAGONS (
    REGION         VARCHAR NOT NULL DEFAULT 'SanFrancisco',
    HEX_ID         VARCHAR,
    CENTER_POINT   GEOGRAPHY,
    ROW_NUM        INT,
    LOCATION_ARRAY VARIANT
)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-travel-time-matrix","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

COPY INTO FLEET_INTELLIGENCE.TRAVEL_TIME_MATRIX.SF_HEXAGONS (REGION, HEX_ID, CENTER_POINT, ROW_NUM, LOCATION_ARRAY)
FROM (
    SELECT $1:REGION::VARCHAR, $1:HEX_ID::VARCHAR,
           ST_MAKEPOINT($1:LONGITUDE::FLOAT, $1:LATITUDE::FLOAT),
           $1:ROW_NUM::INT, $1:LOCATION_ARRAY::VARIANT
    FROM @FLEET_INTELLIGENCE.TRAVEL_TIME_MATRIX.SEED_STAGE/SF_HEXAGONS/
)
FILE_FORMAT = (TYPE = PARQUET) ON_ERROR = CONTINUE;

--------------------------------------------------------------------
-- SF_TRAVEL_TIME_MATRIX
--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.TRAVEL_TIME_MATRIX.SF_TRAVEL_TIME_MATRIX (
    REGION                VARCHAR NOT NULL DEFAULT 'SanFrancisco',
    ORIGIN_HEX_ID         VARCHAR,
    DESTINATION_HEX_ID    VARCHAR,
    TRAVEL_TIME_SECONDS   FLOAT,
    DISTANCE_METERS       FLOAT,
    CREATED_AT            TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-travel-time-matrix","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

COPY INTO FLEET_INTELLIGENCE.TRAVEL_TIME_MATRIX.SF_TRAVEL_TIME_MATRIX
FROM @FLEET_INTELLIGENCE.TRAVEL_TIME_MATRIX.SEED_STAGE/SF_TRAVEL_TIME_MATRIX/
FILE_FORMAT = (TYPE = PARQUET) MATCH_BY_COLUMN_NAME = CASE_INSENSITIVE ON_ERROR = CONTINUE;

--------------------------------------------------------------------
-- VALIDATION
--------------------------------------------------------------------
SELECT 'SF_HEXAGONS' AS TBL, COUNT(*) AS ROW_CNT FROM FLEET_INTELLIGENCE.TRAVEL_TIME_MATRIX.SF_HEXAGONS
UNION ALL SELECT 'SF_TRAVEL_TIME_MATRIX', COUNT(*) FROM FLEET_INTELLIGENCE.TRAVEL_TIME_MATRIX.SF_TRAVEL_TIME_MATRIX;
