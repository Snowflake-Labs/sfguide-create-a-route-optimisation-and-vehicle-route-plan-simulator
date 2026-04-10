/*
 * seed-data.sql — Dwell Analysis
 * Load San Francisco baseline data from S3.
 * Only loads GEOFENCE_POLYGONS, SLA_THRESHOLDS, and CONFIG (static config).
 * Dynamic Tables must be created via DDL after seed loading (see sql-pipeline.sql).
 * Source telemetry data comes from SYNTHETIC_DATASETS.UNIFIED via projection views.
 */

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-dwell-analysis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE DATABASE IF NOT EXISTS FLEET_INTELLIGENCE
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-dwell-analysis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-dwell-analysis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE STAGE IF NOT EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.SEED_STAGE
    URL = 's3://fleet-intelligence/SanFrancisco/dwell-analysis/'
    FILE_FORMAT = (TYPE = PARQUET)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-dwell-analysis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

--------------------------------------------------------------------
-- CONFIG
--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.CONFIG (
    VEHICLE_TYPE VARCHAR NOT NULL,
    REGION       VARCHAR NOT NULL
)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-dwell-analysis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
MERGE INTO FLEET_INTELLIGENCE.DWELL_ANALYSIS.CONFIG tgt
USING (SELECT 'ebike' AS VEHICLE_TYPE, 'SanFrancisco' AS REGION) src
ON TRUE
WHEN NOT MATCHED THEN INSERT (VEHICLE_TYPE, REGION) VALUES (src.VEHICLE_TYPE, src.REGION);

--------------------------------------------------------------------
-- GEOFENCE_POLYGONS
--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.GEOFENCE_POLYGONS (
    REGION          VARCHAR NOT NULL DEFAULT 'SanFrancisco',
    LOCATION_ID     VARCHAR,
    NAME            VARCHAR,
    LOCATION_TYPE   VARCHAR,
    SOURCE          VARCHAR,
    CENTER_POINT    GEOGRAPHY,
    BUFFER_RADIUS_M FLOAT
)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-dwell-analysis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

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
)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-dwell-analysis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

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
-- POST-SEED DDL: Dynamic Tables
-- Run the DT creation statements from sql-pipeline.sql Steps 5-13
-- after ensuring source data exists in SYNTHETIC_DATASETS.UNIFIED.
-- These cannot be pre-baked as they are live refresh objects.
--------------------------------------------------------------------

--------------------------------------------------------------------
-- VALIDATION
--------------------------------------------------------------------
SELECT 'GEOFENCE_POLYGONS' AS TBL, COUNT(*) AS ROW_CNT FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.GEOFENCE_POLYGONS
UNION ALL SELECT 'SLA_THRESHOLDS', COUNT(*) FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.SLA_THRESHOLDS;
