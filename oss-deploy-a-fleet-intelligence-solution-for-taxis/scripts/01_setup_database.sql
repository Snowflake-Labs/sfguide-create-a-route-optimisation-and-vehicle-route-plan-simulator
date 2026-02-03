-- =============================================================================
-- SF Taxi Fleet Intelligence - Database Setup
-- =============================================================================
-- This script creates the database, schemas, warehouse, and stage needed for
-- the Fleet Intelligence solution.
--
-- Prerequisites:
--   - ACCOUNTADMIN or appropriate privileges
--   - OpenRouteService Native App installed (OPENROUTESERVICE_NATIVE_APP)
-- =============================================================================

-- Set query tag for tracking
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is","name":"oss-deploy-a-fleet-intelligence-solution-for-taxis","version":{"major":1, "minor":0},"attributes":{"is_quickstart":1, "source":"sql"}}';

-- Create warehouse if not exists
CREATE WAREHOUSE IF NOT EXISTS COMPUTE_WH
    WAREHOUSE_SIZE = 'XSMALL'
    AUTO_SUSPEND = 60
    AUTO_RESUME = TRUE
    COMMENT = '{"origin":"sf_sit-is", "name":"oss-deploy-a-fleet-intelligence-solution-for-taxis", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';

USE WAREHOUSE COMPUTE_WH;

-- Create database and schemas
CREATE DATABASE IF NOT EXISTS FLEET_INTELLIGENCE
    COMMENT = '{"origin":"sf_sit-is", "name":"oss-deploy-a-fleet-intelligence-solution-for-taxis", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.PUBLIC;
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.ANALYTICS;

USE DATABASE FLEET_INTELLIGENCE;
USE SCHEMA PUBLIC;

-- Create stage for Streamlit files
CREATE STAGE IF NOT EXISTS STREAMLIT_STAGE
    DIRECTORY = (ENABLE = TRUE);

-- Grant ORS access (if needed)
-- GRANT USAGE ON DATABASE OPENROUTESERVICE_NATIVE_APP TO ROLE <your_role>;
-- GRANT USAGE ON SCHEMA OPENROUTESERVICE_NATIVE_APP.CORE TO ROLE <your_role>;

SELECT 'Database setup complete' AS STATUS;
