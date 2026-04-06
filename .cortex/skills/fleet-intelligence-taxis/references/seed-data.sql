/*
 * seed-data.sql — Fleet Intelligence Taxis
 * Load San Francisco baseline data from S3.
 * Idempotent: only loads if tables are empty for the target region.
 *
 * After loading, run the view creation DDL from sql-pipeline.md Step 9.
 */

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-taxis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE DATABASE IF NOT EXISTS FLEET_INTELLIGENCE
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-taxis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-taxis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE STAGE IF NOT EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.SEED_STAGE
    URL = 's3://fleet-intelligence/SanFrancisco/fleet-intelligence-taxis/'
    FILE_FORMAT = (TYPE = PARQUET)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-taxis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

--------------------------------------------------------------------
-- CONFIG
--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.CONFIG (
    VEHICLE_TYPE VARCHAR NOT NULL,
    REGION       VARCHAR NOT NULL
)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-taxis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
MERGE INTO FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.CONFIG tgt
USING (SELECT 'ebike' AS VEHICLE_TYPE, 'SanFrancisco' AS REGION) src
ON TRUE
WHEN NOT MATCHED THEN INSERT (VEHICLE_TYPE, REGION)
    VALUES (src.VEHICLE_TYPE, src.REGION);

--------------------------------------------------------------------
-- TAXI_LOCATIONS
--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TAXI_LOCATIONS (
    REGION         VARCHAR NOT NULL DEFAULT 'SanFrancisco',
    LOCATION_ID    VARCHAR,
    POINT_GEOM     GEOGRAPHY,
    NAME           VARCHAR,
    CATEGORY       VARCHAR,
    SOURCE_TYPE    VARCHAR
)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-taxis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

COPY INTO FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TAXI_LOCATIONS
FROM @FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.SEED_STAGE/TAXI_LOCATIONS/
FILE_FORMAT = (TYPE = PARQUET)
MATCH_BY_COLUMN_NAME = CASE_INSENSITIVE
ON_ERROR = CONTINUE;

--------------------------------------------------------------------
-- TAXI_DRIVERS
--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TAXI_DRIVERS (
    REGION                  VARCHAR NOT NULL DEFAULT 'SanFrancisco',
    DRIVER_ID               VARCHAR,
    HOME_LOCATION_ID        VARCHAR,
    SHIFT_TYPE              VARCHAR,
    SHIFT_START_HOUR        INT,
    SHIFT_END_HOUR          INT,
    SHIFT_CROSSES_MIDNIGHT  VARCHAR
)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-taxis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

COPY INTO FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TAXI_DRIVERS
FROM @FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.SEED_STAGE/TAXI_DRIVERS/
FILE_FORMAT = (TYPE = PARQUET)
MATCH_BY_COLUMN_NAME = CASE_INSENSITIVE
ON_ERROR = CONTINUE;

--------------------------------------------------------------------
-- TAXI_LOCATIONS_NUMBERED
--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TAXI_LOCATIONS_NUMBERED (
    REGION      VARCHAR NOT NULL DEFAULT 'SanFrancisco',
    LOCATION_ID VARCHAR,
    POINT_GEOM  GEOGRAPHY,
    NAME        VARCHAR,
    RN          INT
)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-taxis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

COPY INTO FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TAXI_LOCATIONS_NUMBERED
FROM @FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.SEED_STAGE/TAXI_LOCATIONS_NUMBERED/
FILE_FORMAT = (TYPE = PARQUET)
MATCH_BY_COLUMN_NAME = CASE_INSENSITIVE
ON_ERROR = CONTINUE;

--------------------------------------------------------------------
-- DRIVER_TRIPS
--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_TRIPS (
    REGION          VARCHAR NOT NULL DEFAULT 'SanFrancisco',
    TRIP_ID         VARCHAR,
    DRIVER_ID       VARCHAR,
    TRIP_HOUR       INT,
    TRIP_NUMBER     INT,
    SHIFT_TYPE      VARCHAR,
    PICKUP_LOC_ID   INT,
    DROPOFF_LOC_ID  INT
)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-taxis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

COPY INTO FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_TRIPS
FROM @FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.SEED_STAGE/DRIVER_TRIPS/
FILE_FORMAT = (TYPE = PARQUET)
MATCH_BY_COLUMN_NAME = CASE_INSENSITIVE
ON_ERROR = CONTINUE;

--------------------------------------------------------------------
-- DRIVER_TRIPS_WITH_COORDS
--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_TRIPS_WITH_COORDS (
    REGION          VARCHAR NOT NULL DEFAULT 'SanFrancisco',
    TRIP_ID         VARCHAR,
    DRIVER_ID       VARCHAR,
    TRIP_HOUR       INT,
    TRIP_NUMBER     INT,
    SHIFT_TYPE      VARCHAR,
    PICKUP_GEOM     GEOGRAPHY,
    PICKUP_NAME     VARCHAR,
    DROPOFF_GEOM    GEOGRAPHY,
    DROPOFF_NAME    VARCHAR
)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-taxis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

COPY INTO FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_TRIPS_WITH_COORDS
FROM @FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.SEED_STAGE/DRIVER_TRIPS_WITH_COORDS/
FILE_FORMAT = (TYPE = PARQUET)
MATCH_BY_COLUMN_NAME = CASE_INSENSITIVE
ON_ERROR = CONTINUE;

--------------------------------------------------------------------
-- DRIVER_ROUTES
--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_ROUTES (
    REGION           VARCHAR NOT NULL DEFAULT 'SanFrancisco',
    DRIVER_ID        VARCHAR,
    TRIP_ID          VARCHAR,
    TRIP_HOUR        INT,
    TRIP_NUMBER      INT,
    SHIFT_TYPE       VARCHAR,
    PICKUP_GEOM      GEOGRAPHY,
    PICKUP_NAME      VARCHAR,
    DROPOFF_GEOM     GEOGRAPHY,
    DROPOFF_NAME     VARCHAR,
    ROUTE_RESPONSE   VARIANT
)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-taxis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

COPY INTO FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_ROUTES
FROM @FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.SEED_STAGE/DRIVER_ROUTES/
FILE_FORMAT = (TYPE = PARQUET)
MATCH_BY_COLUMN_NAME = CASE_INSENSITIVE
ON_ERROR = CONTINUE;

--------------------------------------------------------------------
-- DRIVER_ROUTES_PARSED
--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_ROUTES_PARSED (
    REGION                VARCHAR NOT NULL DEFAULT 'SanFrancisco',
    DRIVER_ID             VARCHAR,
    TRIP_ID               VARCHAR,
    TRIP_HOUR             INT,
    TRIP_NUMBER           INT,
    SHIFT_TYPE            VARCHAR,
    ORIGIN                GEOGRAPHY,
    ORIGIN_ADDRESS        VARCHAR,
    DESTINATION           GEOGRAPHY,
    DESTINATION_ADDRESS   VARCHAR,
    ROUTE_GEOMETRY        GEOGRAPHY,
    ROUTE_DISTANCE_METERS FLOAT,
    ROUTE_DURATION_SECS   FLOAT
)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-taxis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

COPY INTO FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_ROUTES_PARSED
FROM @FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.SEED_STAGE/DRIVER_ROUTES_PARSED/
FILE_FORMAT = (TYPE = PARQUET)
MATCH_BY_COLUMN_NAME = CASE_INSENSITIVE
ON_ERROR = CONTINUE;

--------------------------------------------------------------------
-- DRIVER_ROUTE_GEOMETRIES
--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_ROUTE_GEOMETRIES (
    REGION                VARCHAR NOT NULL DEFAULT 'SanFrancisco',
    DRIVER_ID             VARCHAR,
    TRIP_ID               VARCHAR,
    TRIP_START_TIME        TIMESTAMP_NTZ,
    TRIP_END_TIME          TIMESTAMP_NTZ,
    ORIGIN_ADDRESS        VARCHAR,
    DESTINATION_ADDRESS   VARCHAR,
    ROUTE_DURATION_SECS   FLOAT,
    ROUTE_DISTANCE_METERS FLOAT,
    GEOMETRY              GEOGRAPHY,
    ORIGIN                GEOGRAPHY,
    DESTINATION           GEOGRAPHY,
    SHIFT_TYPE            VARCHAR
)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-taxis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

COPY INTO FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_ROUTE_GEOMETRIES
FROM @FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.SEED_STAGE/DRIVER_ROUTE_GEOMETRIES/
FILE_FORMAT = (TYPE = PARQUET)
MATCH_BY_COLUMN_NAME = CASE_INSENSITIVE
ON_ERROR = CONTINUE;

--------------------------------------------------------------------
-- DRIVER_LOCATIONS
--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_LOCATIONS (
    REGION           VARCHAR NOT NULL DEFAULT 'SanFrancisco',
    TRIP_ID          VARCHAR,
    DRIVER_ID        VARCHAR,
    PICKUP_TIME      TIMESTAMP_NTZ,
    DROPOFF_TIME     TIMESTAMP_NTZ,
    PICKUP_LOCATION  GEOGRAPHY,
    DROPOFF_LOCATION GEOGRAPHY,
    ROUTE            GEOGRAPHY,
    POINT_GEOM       GEOGRAPHY,
    CURR_TIME        TIMESTAMP_NTZ,
    POINT_INDEX      INT,
    DRIVER_STATE     VARCHAR,
    KMH              FLOAT
)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-taxis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

COPY INTO FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_LOCATIONS
FROM @FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.SEED_STAGE/DRIVER_LOCATIONS/
FILE_FORMAT = (TYPE = PARQUET)
MATCH_BY_COLUMN_NAME = CASE_INSENSITIVE
ON_ERROR = CONTINUE;

--------------------------------------------------------------------
-- POST-SEED DDL: Analytics Views
--------------------------------------------------------------------
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_LOCATIONS_V
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-taxis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT TRIP_ID, DRIVER_ID, PICKUP_TIME, DROPOFF_TIME, PICKUP_LOCATION, DROPOFF_LOCATION,
    ROUTE, POINT_GEOM, ST_X(POINT_GEOM) AS LON, ST_Y(POINT_GEOM) AS LAT,
    CURR_TIME, CURR_TIME AS POINT_TIME, POINT_INDEX, DRIVER_STATE, KMH, REGION
FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_LOCATIONS;

CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TRIPS_ASSIGNED_TO_DRIVERS
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-taxis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT DRIVER_ID, TRIP_ID, GEOMETRY, ORIGIN, DESTINATION, ORIGIN_ADDRESS, DESTINATION_ADDRESS,
    TRIP_START_TIME AS PICKUP_TIME, TRIP_END_TIME AS DROPOFF_TIME, REGION
FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_ROUTE_GEOMETRIES;

CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.ROUTE_NAMES
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-taxis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT TRIP_ID, ORIGIN_ADDRESS || ' -> ' || DESTINATION_ADDRESS AS TRIP_NAME, REGION
FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_ROUTE_GEOMETRIES;

CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TRIP_ROUTE_PLAN
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-taxis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT rg.TRIP_ID, rg.DRIVER_ID, rg.ORIGIN_ADDRESS, rg.ORIGIN_ADDRESS AS ORIGIN_STREET,
    rg.DESTINATION_ADDRESS, rg.DESTINATION_ADDRESS AS DESTINATION_STREET,
    rg.TRIP_START_TIME AS PICKUP_TIME, rg.TRIP_END_TIME AS DROPOFF_TIME,
    rg.ORIGIN, rg.DESTINATION, rg.GEOMETRY, rg.ROUTE_DISTANCE_METERS AS DISTANCE_METERS,
    rg.SHIFT_TYPE, rg.REGION,
    OBJECT_CONSTRUCT('features', ARRAY_CONSTRUCT(OBJECT_CONSTRUCT('properties', OBJECT_CONSTRUCT(
        'summary', OBJECT_CONSTRUCT('distance', rg.ROUTE_DISTANCE_METERS, 'duration', rg.ROUTE_DURATION_SECS)
    )))) AS ROUTE
FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_ROUTE_GEOMETRIES rg;

CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TRIP_SUMMARY
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-taxis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
WITH trip_stats AS (
    SELECT TRIP_ID, AVG(KMH) AS AVERAGE_KMH, MAX(KMH) AS MAX_KMH
    FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_LOCATIONS
    GROUP BY TRIP_ID
)
SELECT rg.*, ts.AVERAGE_KMH, ts.MAX_KMH
FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_ROUTE_GEOMETRIES rg
LEFT JOIN trip_stats ts ON rg.TRIP_ID = ts.TRIP_ID;

--------------------------------------------------------------------
-- VALIDATION
--------------------------------------------------------------------
SELECT 'TAXI_LOCATIONS' AS TBL, COUNT(*) AS ROWS FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TAXI_LOCATIONS
UNION ALL SELECT 'TAXI_DRIVERS', COUNT(*) FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TAXI_DRIVERS
UNION ALL SELECT 'DRIVER_TRIPS', COUNT(*) FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_TRIPS
UNION ALL SELECT 'DRIVER_ROUTE_GEOMETRIES', COUNT(*) FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_ROUTE_GEOMETRIES
UNION ALL SELECT 'DRIVER_LOCATIONS', COUNT(*) FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_LOCATIONS
UNION ALL SELECT 'TRIP_SUMMARY', COUNT(*) FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TRIP_SUMMARY;

--------------------------------------------------------------------
-- GRANT ACCESS TO NATIVE APP
--------------------------------------------------------------------
GRANT SELECT ON ALL VIEWS IN SCHEMA FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS TO APPLICATION OPENROUTESERVICE_NATIVE_APP;
GRANT SELECT ON ALL TABLES IN SCHEMA FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS TO APPLICATION OPENROUTESERVICE_NATIVE_APP;
