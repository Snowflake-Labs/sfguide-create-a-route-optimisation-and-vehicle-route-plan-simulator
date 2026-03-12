-- =============================================================================
-- Travel Time Matrix — Infrastructure Setup
-- =============================================================================
-- Run this script to configure all infrastructure for at-scale matrix building.
-- Adjust <DB>, <POOL_NAME>, and instance counts to match your environment.
--
-- Reference: 10 ORS instances + 10 clusters = ~1.94B pairs in ~6.5 hours
-- =============================================================================

USE ROLE ACCOUNTADMIN;

-- =============================================================================
-- 0. OSM MAP DATA — Switch from San Francisco (default) to California
-- =============================================================================
-- The ORS native app ships with SanFrancisco.osm.pbf by default.
-- For statewide coverage, use the customize-main/location skill which handles:
--   1. Downloading the OSM extract via Snowflake Notebook (DOWNLOAD_MAP)
--   2. Updating ors-config.yml with the new map path
--   3. Updating service specifications for the new region
--   4. Restarting services and rebuilding graphs
--
-- Run the customize-main skill with:
--   Region: california
--   Map: california-latest.osm.pbf
--   URL: https://download.geofabrik.de/north-america/us/california-latest.osm.pbf
--
-- The ors-config.yml in this skill folder is a reference copy of the California
-- config. The customize-main skill generates and uploads this automatically.
--
-- After the map is loaded and graphs are built (~2-5 min for California),
-- verify ORS is ready before proceeding:
SELECT OPENROUTESERVICE_NATIVE_APP.CORE.ORS_STATUS();

-- Verify the stage has the California files:
LIST @OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SPCS_STAGE/;

-- =============================================================================
-- 1. WAREHOUSES
-- =============================================================================

-- Worker warehouse: XSMALL is sufficient — workers are I/O bound (waiting for
-- ORS), not compute bound. Multi-cluster gives each worker its own cluster.
CREATE OR REPLACE WAREHOUSE ROUTING_ANALYTICS
    WAREHOUSE_SIZE = 'XSMALL'
    MIN_CLUSTER_COUNT = 10
    MAX_CLUSTER_COUNT = 10
    SCALING_POLICY = 'STANDARD'
    AUTO_SUSPEND = 300
    AUTO_RESUME = TRUE;

-- Flatten warehouse: XLARGE for single-query bulk INSERT power.
-- Auto-suspends quickly since it's only used for ~2 min per resolution.
CREATE WAREHOUSE IF NOT EXISTS FLATTEN_WH
    WITH WAREHOUSE_SIZE = 'XLARGE'
    AUTO_SUSPEND = 60
    AUTO_RESUME = TRUE;

-- =============================================================================
-- 2. COMPUTE POOL
-- =============================================================================

-- HIGHMEM_X64_M required for ORS graph loading (~1.3GB California graph).
-- Match node count to desired ORS instance count.
ALTER COMPUTE POOL <POOL_NAME>
    SET MIN_NODES = 10
        MAX_NODES = 10;

-- =============================================================================
-- 3. ORS SERVICES
-- =============================================================================

-- ORS routing engine: one instance per compute pool node.
ALTER SERVICE IF EXISTS OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SERVICE
    SET MIN_INSTANCES = 10
        MAX_INSTANCES = 10;

-- Gateway: MUST match ORS instance count.
-- Gateway at 3 was the bottleneck when ORS had 10 — always keep them equal.
ALTER SERVICE IF EXISTS OPENROUTESERVICE_NATIVE_APP.CORE.ROUTING_GATEWAY_SERVICE
    SET MIN_INSTANCES = 10
        MAX_INSTANCES = 10;

-- VROOM: 1 instance is sufficient for route optimization.
-- Only needed for VRP solving, not matrix building.
ALTER SERVICE IF EXISTS OPENROUTESERVICE_NATIVE_APP.CORE.VROOM_SERVICE
    SET MIN_INSTANCES = 1
        MAX_INSTANCES = 1;

-- =============================================================================
-- 4. VERIFY SERVICES ARE READY
-- =============================================================================

-- Wait ~60s after scaling for ORS to rebuild routing graphs in memory.
-- Check status before launching workers:
SELECT OPENROUTESERVICE_NATIVE_APP.CORE.ORS_STATUS();

SHOW SERVICES IN SCHEMA OPENROUTESERVICE_NATIVE_APP.CORE;

-- Verify: ORS_SERVICE status = RUNNING, current_instances = 10
-- Verify: ROUTING_GATEWAY_SERVICE status = RUNNING, current_instances = 10

-- =============================================================================
-- 5. RAW STAGING + TARGET TABLES
-- =============================================================================

USE DATABASE <DB>;
USE SCHEMA PUBLIC;

-- Raw staging: stores VARIANT payloads from MATRIX_TABULAR
CREATE TABLE IF NOT EXISTS CA_MATRIX_RAW_RES7 (
    SEQ_ID NUMBER, ORIGIN_H3 VARCHAR, DEST_HEX_IDS ARRAY, MATRIX_RESULT VARIANT
);
CREATE TABLE IF NOT EXISTS CA_MATRIX_RAW_RES8 (
    SEQ_ID NUMBER, ORIGIN_H3 VARCHAR, DEST_HEX_IDS ARRAY, MATRIX_RESULT VARIANT
);
CREATE TABLE IF NOT EXISTS CA_MATRIX_RAW_RES9 (
    SEQ_ID NUMBER, ORIGIN_H3 VARCHAR, DEST_HEX_IDS ARRAY, MATRIX_RESULT VARIANT
);

-- Flattened travel time tables: final output
CREATE TABLE IF NOT EXISTS CA_TRAVEL_TIME_RES7 (
    ORIGIN_H3 VARCHAR, DEST_H3 VARCHAR,
    TRAVEL_TIME_SECONDS FLOAT, TRAVEL_DISTANCE_METERS FLOAT
);
CREATE TABLE IF NOT EXISTS CA_TRAVEL_TIME_RES8 (
    ORIGIN_H3 VARCHAR, DEST_H3 VARCHAR,
    TRAVEL_TIME_SECONDS FLOAT, TRAVEL_DISTANCE_METERS FLOAT
);
CREATE TABLE IF NOT EXISTS CA_TRAVEL_TIME_RES9 (
    ORIGIN_H3 VARCHAR, DEST_H3 VARCHAR,
    TRAVEL_TIME_SECONDS FLOAT, TRAVEL_DISTANCE_METERS FLOAT
);

-- =============================================================================
-- 6. SCALE DOWN (run after all resolutions complete)
-- =============================================================================

-- Uncomment and run after matrix building is finished:

-- ALTER WAREHOUSE ROUTING_ANALYTICS SET
--     WAREHOUSE_SIZE = 'XSMALL'
--     MIN_CLUSTER_COUNT = 1
--     MAX_CLUSTER_COUNT = 1;

-- ALTER COMPUTE POOL <POOL_NAME> SET MIN_NODES = 1 MAX_NODES = 1;

-- ALTER SERVICE IF EXISTS OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SERVICE
--     SET MIN_INSTANCES = 1 MAX_INSTANCES = 1;
-- ALTER SERVICE IF EXISTS OPENROUTESERVICE_NATIVE_APP.CORE.ROUTING_GATEWAY_SERVICE
--     SET MIN_INSTANCES = 1 MAX_INSTANCES = 1;

-- ALTER WAREHOUSE FLATTEN_WH SUSPEND;
