/*
 * seed-data.sql — Dwell Analysis
 * Load San Francisco baseline source data from S3.
 * Only loads GEOFENCE_POLYGONS and SLA_THRESHOLDS (static config).
 * Dynamic Tables must be created via DDL after seed loading (see sql-pipeline.sql).
 * Source telemetry data is loaded by the route-deviation seed loader
 * into SYNTHETIC_DATASETS.FLEET_INTELLIGENCE.
 */

CREATE DATABASE IF NOT EXISTS FLEET_INTELLIGENCE;
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS;

CREATE STAGE IF NOT EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.SEED_STAGE
    URL = 's3://fleet-intelligence/SanFrancisco/dwell-analysis/'
    FILE_FORMAT = (TYPE = PARQUET);

--------------------------------------------------------------------
-- GEOFENCE_POLYGONS
--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.GEOFENCE_POLYGONS (
    REGION          VARCHAR NOT NULL DEFAULT 'SanFrancisco',
    LOCATION_ID     VARCHAR,
    NAME            VARCHAR,
    LOCATION_TYPE   VARCHAR,
    SOURCE          VARCHAR,
    LAT             FLOAT,
    LNG             FLOAT,
    CENTER_POINT    GEOGRAPHY,
    BUFFER_RADIUS_M FLOAT
);

COPY INTO FLEET_INTELLIGENCE.DWELL_ANALYSIS.GEOFENCE_POLYGONS
FROM @FLEET_INTELLIGENCE.DWELL_ANALYSIS.SEED_STAGE/GEOFENCE_POLYGONS/
FILE_FORMAT = (TYPE = PARQUET) MATCH_BY_COLUMN_NAME = CASE_INSENSITIVE ON_ERROR = CONTINUE;

--------------------------------------------------------------------
-- SLA_THRESHOLDS
--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.SLA_THRESHOLDS (
    REGION           VARCHAR NOT NULL DEFAULT 'SanFrancisco',
    LOCATION_TYPE    VARCHAR,
    WARNING_MINUTES  NUMBER,
    CRITICAL_MINUTES NUMBER
);

INSERT INTO FLEET_INTELLIGENCE.DWELL_ANALYSIS.SLA_THRESHOLDS (REGION, LOCATION_TYPE, WARNING_MINUTES, CRITICAL_MINUTES)
SELECT 'SanFrancisco', column1, column2, column3
FROM VALUES
    ('WAREHOUSE',   60, 120),
    ('DESTINATION', 30,  60),
    ('REST_STOP',   45,  90),
    ('STORE',       20,  45),
    ('DETOUR',      15,  30)
WHERE NOT EXISTS (
    SELECT 1 FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.SLA_THRESHOLDS
    WHERE REGION = 'SanFrancisco'
);

--------------------------------------------------------------------
-- POST-SEED: Source telemetry for Dynamic Tables
-- The dwell-analysis DTs source from SYNTHETIC_DATASETS.FLEET_INTELLIGENCE.
-- That data is loaded by the synthetic-datasets-generator S3 loader.
-- Load it here if not already present:
--------------------------------------------------------------------
CREATE DATABASE IF NOT EXISTS SYNTHETIC_DATASETS;
CREATE SCHEMA IF NOT EXISTS SYNTHETIC_DATASETS.FLEET_INTELLIGENCE;

CREATE STAGE IF NOT EXISTS SYNTHETIC_DATASETS.FLEET_INTELLIGENCE.DWELL_SEED_STAGE
    URL = 's3://fleet-intelligence/SanFrancisco/synthetic-datasets/'
    FILE_FORMAT = (TYPE = PARQUET);

CREATE TABLE IF NOT EXISTS SYNTHETIC_DATASETS.FLEET_INTELLIGENCE.FACT_TRUCK_TELEMETRY (
    REGION           VARCHAR NOT NULL DEFAULT 'SanFrancisco',
    TELEMETRY_ID     VARCHAR,
    TRUCK_ID         VARCHAR,
    TRIP_ID          VARCHAR,
    TS               TIMESTAMP_NTZ,
    LATITUDE         FLOAT,
    LONGITUDE        FLOAT,
    SPEED_KMH        FLOAT,
    HEADING_DEG      FLOAT,
    POSTED_SPEED_KMH FLOAT,
    GPS_ACCURACY_M   FLOAT,
    STATUS           VARCHAR,
    LOCATION_ID      VARCHAR,
    LOCATION_TYPE    VARCHAR,
    IS_DETOUR        BOOLEAN,
    IS_SPEEDING      BOOLEAN,
    IS_HOS_VIOLATION BOOLEAN
);

CREATE TABLE IF NOT EXISTS SYNTHETIC_DATASETS.FLEET_INTELLIGENCE.TRUCK_FLEET (
    REGION         VARCHAR NOT NULL DEFAULT 'SanFrancisco',
    TRUCK_ID       VARCHAR,
    TRUCK_TYPE     VARCHAR,
    HOME_BASE_ID   VARCHAR,
    HOME_BASE_NAME VARCHAR,
    HOME_CITY      VARCHAR,
    DRIVER_ID      VARCHAR,
    DRIVER_PROFILE VARCHAR
);

CREATE TABLE IF NOT EXISTS SYNTHETIC_DATASETS.FLEET_INTELLIGENCE.GERMANY_DESTINATIONS (
    REGION        VARCHAR NOT NULL DEFAULT 'SanFrancisco',
    LOCATION_ID   VARCHAR,
    NAME          VARCHAR,
    CITY          VARCHAR,
    LOCATION_TYPE VARCHAR,
    LATITUDE      FLOAT,
    LONGITUDE     FLOAT,
    GEOMETRY      GEOGRAPHY
);

CREATE TABLE IF NOT EXISTS SYNTHETIC_DATASETS.FLEET_INTELLIGENCE.GERMANY_REST_STOPS (
    REGION        VARCHAR NOT NULL DEFAULT 'SanFrancisco',
    LOCATION_ID   VARCHAR,
    NAME          VARCHAR,
    CITY          VARCHAR,
    LOCATION_TYPE VARCHAR,
    LATITUDE      FLOAT,
    LONGITUDE     FLOAT,
    GEOMETRY      GEOGRAPHY
);

--------------------------------------------------------------------
-- POST-SEED DDL: Dynamic Tables
-- Run the DT creation statements from sql-pipeline.sql Steps 4-12
-- after ensuring source data is loaded.
-- These cannot be pre-baked as they are live refresh objects.
--------------------------------------------------------------------

--------------------------------------------------------------------
-- VALIDATION
--------------------------------------------------------------------
SELECT 'GEOFENCE_POLYGONS' AS TBL, COUNT(*) AS ROWS FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.GEOFENCE_POLYGONS
UNION ALL SELECT 'SLA_THRESHOLDS', COUNT(*) FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.SLA_THRESHOLDS;
