-- =============================================================================
-- SF Taxi Fleet Intelligence - Database Setup
-- =============================================================================
-- This script creates the schema, warehouse, and stage needed for
-- the Fleet Intelligence solution within OPENROUTESERVICE_NATIVE_APP database.
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

-- Create schema within existing OPENROUTESERVICE_NATIVE_APP database
USE DATABASE OPENROUTESERVICE_NATIVE_APP;
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE_TAXIS
    COMMENT = '{"origin":"sf_sit-is", "name":"oss-deploy-a-fleet-intelligence-solution-for-taxis", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';

USE SCHEMA FLEET_INTELLIGENCE_TAXIS;

-- Create stage for Streamlit files
CREATE STAGE IF NOT EXISTS STREAMLIT_STAGE
    DIRECTORY = (ENABLE = TRUE);

SELECT 'Database setup complete' AS STATUS;
