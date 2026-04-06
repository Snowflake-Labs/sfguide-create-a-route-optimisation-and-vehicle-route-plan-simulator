/*
 * seed-data.sql — Route Optimization
 * Load San Francisco baseline data from S3.
 * Idempotent: only loads if tables are empty for the target region.
 */

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-route-optimization","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE DATABASE IF NOT EXISTS FLEET_INTELLIGENCE
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-route-optimization","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-route-optimization","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE STAGE IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SEED_STAGE
    URL = 's3://fleet-intelligence/SanFrancisco/route-optimization/'
    FILE_FORMAT = (TYPE = PARQUET)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-route-optimization","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

--------------------------------------------------------------------
-- PLACES (Overture Maps POIs materialized)
--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES (
    REGION    VARCHAR NOT NULL DEFAULT 'SanFrancisco',
    NAME      VARCHAR,
    CATEGORY  VARCHAR,
    GEOMETRY  GEOGRAPHY,
    ADDRESS   VARCHAR,
    CITY      VARCHAR,
    STATE     VARCHAR,
    POSTCODE  VARCHAR
)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-route-optimization","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

COPY INTO FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES
FROM @FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SEED_STAGE/PLACES/
FILE_FORMAT = (TYPE = PARQUET) MATCH_BY_COLUMN_NAME = CASE_INSENSITIVE ON_ERROR = CONTINUE;

--------------------------------------------------------------------
-- LOOKUP (industry parameter lookup)
--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP (
    REGION   VARCHAR NOT NULL DEFAULT 'SanFrancisco',
    INDUSTRY VARCHAR,
    PA       VARCHAR,
    PB       VARCHAR,
    PC       VARCHAR
)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-route-optimization","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

COPY INTO FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP
FROM @FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SEED_STAGE/LOOKUP/
FILE_FORMAT = (TYPE = PARQUET) MATCH_BY_COLUMN_NAME = CASE_INSENSITIVE ON_ERROR = CONTINUE;

--------------------------------------------------------------------
-- JOB_TEMPLATE (VRP job templates)
--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.JOB_TEMPLATE (
    REGION      VARCHAR NOT NULL DEFAULT 'SanFrancisco',
    ID          INT,
    SLOT_START  VARCHAR,
    SLOT_END    VARCHAR,
    SKILLS      VARCHAR,
    PRODUCT     VARCHAR,
    STATUS      VARCHAR
)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-route-optimization","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

COPY INTO FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.JOB_TEMPLATE
FROM @FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SEED_STAGE/JOB_TEMPLATE/
FILE_FORMAT = (TYPE = PARQUET) MATCH_BY_COLUMN_NAME = CASE_INSENSITIVE ON_ERROR = CONTINUE;

--------------------------------------------------------------------
-- VALIDATION
--------------------------------------------------------------------
SELECT 'PLACES' AS TBL, COUNT(*) AS ROWS FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES
UNION ALL SELECT 'LOOKUP', COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP
UNION ALL SELECT 'JOB_TEMPLATE', COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.JOB_TEMPLATE;
