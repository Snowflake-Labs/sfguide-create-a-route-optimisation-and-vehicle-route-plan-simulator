-- =============================================================================
-- Travel Time Matrix — Infrastructure Setup
-- =============================================================================
-- Parameterized setup for any region. Replace the variables below.
--
-- Scaling guide:
--   City (~50K origins):    INSTANCES=3,  CLUSTERS=3,  WORKERS=3
--   Metro (~200K origins):  INSTANCES=5,  CLUSTERS=5,  WORKERS=5
--   State (~10M origins):   INSTANCES=10, CLUSTERS=10, WORKERS=10
--   Country (~50M origins): INSTANCES=20, CLUSTERS=20, WORKERS=20
-- =============================================================================

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-travel-time-matrix","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

USE ROLE ACCOUNTADMIN;

-- =============================================================================
-- VARIABLES — Set these for your region
-- =============================================================================
SET P_REGION = 'SF';                  -- Short identifier (used in table names)
SET P_DB = 'FLEET_INTELLIGENCE';             -- Target database
SET P_ORS_APP = 'OPENROUTESERVICE_NATIVE_APP';
SET P_INSTANCES = 3;                  -- ORS + gateway instance count
SET P_CLUSTERS = 3;                   -- Warehouse cluster count
SET P_POOL_NAME = 'ORS_COMPUTE_POOL'; -- Compute pool name

-- =============================================================================
-- 0. OSM MAP DATA
-- =============================================================================
-- Use the routing-customization/location skill to:
--   1. Download the OSM extract via Snowflake Notebook (DOWNLOAD_MAP)
--   2. Update ors-config.yml with the new map path
--   3. Restart services and rebuild graphs
--
-- After the map is loaded and graphs are built, verify:
-- SELECT <P_ORS_APP>.CORE.ORS_STATUS();

-- =============================================================================
-- 1. WAREHOUSES
-- =============================================================================

CREATE OR REPLACE WAREHOUSE ROUTING_ANALYTICS
    WAREHOUSE_SIZE = 'XSMALL'
    MIN_CLUSTER_COUNT = 1
    MAX_CLUSTER_COUNT = $P_CLUSTERS
    SCALING_POLICY = 'STANDARD'
    AUTO_SUSPEND = 300
    AUTO_RESUME = TRUE
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-travel-time-matrix","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE WAREHOUSE IF NOT EXISTS FLATTEN_WH
    WITH WAREHOUSE_SIZE = 'XLARGE'
    AUTO_SUSPEND = 60
    AUTO_RESUME = TRUE
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-travel-time-matrix","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- =============================================================================
-- 2. COMPUTE POOL
-- =============================================================================

ALTER COMPUTE POOL IDENTIFIER($P_POOL_NAME)
    SET MIN_NODES = $P_INSTANCES
        MAX_NODES = $P_INSTANCES;

-- =============================================================================
-- 3. ORS SERVICES
-- =============================================================================

-- ORS + gateway must have matching instance counts
ALTER SERVICE IF EXISTS IDENTIFIER($P_ORS_APP || '.CORE.ORS_SERVICE')
    SET MIN_INSTANCES = $P_INSTANCES
        MAX_INSTANCES = $P_INSTANCES;

ALTER SERVICE IF EXISTS IDENTIFIER($P_ORS_APP || '.CORE.ROUTING_GATEWAY_SERVICE')
    SET MIN_INSTANCES = $P_INSTANCES
        MAX_INSTANCES = $P_INSTANCES;

-- =============================================================================
-- 4. VERIFY SERVICES ARE READY
-- =============================================================================

-- Wait ~60s after scaling for ORS to rebuild routing graphs in memory.
-- SELECT IDENTIFIER($P_ORS_APP || '.CORE.ORS_STATUS')();

-- =============================================================================
-- 5. RAW STAGING + TARGET TABLES
-- =============================================================================
-- Tables are created dynamically by the procedures.
-- Naming convention: <P_REGION>_MATRIX_RAW_RES<N>, <P_REGION>_TRAVEL_TIME_RES<N>
-- e.g., SF_MATRIX_RAW_RES9, CA_MATRIX_RAW_RES7, UK_MATRIX_RAW_RES6

-- =============================================================================
-- 6. SCALE DOWN (run after all resolutions complete)
-- =============================================================================

-- ALTER WAREHOUSE ROUTING_ANALYTICS SET
--     WAREHOUSE_SIZE = 'XSMALL'
--     MIN_CLUSTER_COUNT = 1
--     MAX_CLUSTER_COUNT = 1;

-- ALTER COMPUTE POOL IDENTIFIER($P_POOL_NAME) SET MIN_NODES = 1 MAX_NODES = 1;

-- ALTER SERVICE IF EXISTS IDENTIFIER($P_ORS_APP || '.CORE.ORS_SERVICE')
--     SET MIN_INSTANCES = 1 MAX_INSTANCES = 1;
-- ALTER SERVICE IF EXISTS IDENTIFIER($P_ORS_APP || '.CORE.ROUTING_GATEWAY_SERVICE')
--     SET MIN_INSTANCES = 1 MAX_INSTANCES = 1;

-- ALTER WAREHOUSE FLATTEN_WH SUSPEND;
