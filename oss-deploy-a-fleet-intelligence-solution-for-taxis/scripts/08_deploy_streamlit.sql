-- =============================================================================
-- SF Taxi Fleet Intelligence - Streamlit App Deployment
-- =============================================================================
-- This script deploys the Streamlit application to Snowflake.
--
-- Prerequisites:
--   - All previous scripts executed
--   - Streamlit files uploaded to stage (use deploy_streamlit.py)
-- =============================================================================

-- Set query tag for tracking
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is","name":"oss-deploy-a-fleet-intelligence-solution-for-taxis","version":{"major":1, "minor":0},"attributes":{"is_quickstart":1, "source":"sql"}}';

USE DATABASE OPENROUTESERVICE_NATIVE_APP;
USE SCHEMA FLEET_INTELLIGENCE_TAXIS;
USE WAREHOUSE COMPUTE_WH;

-- Create the Streamlit app
CREATE OR REPLACE STREAMLIT SF_TAXI_CONTROL_CENTER
  ROOT_LOCATION = '@OPENROUTESERVICE_NATIVE_APP.FLEET_INTELLIGENCE_TAXIS.STREAMLIT_STAGE/sf_taxi'
  MAIN_FILE = 'SF_Taxi_Control_Center.py'
  QUERY_WAREHOUSE = COMPUTE_WH
  TITLE = 'SF Taxi Control Center'
  COMMENT = '{"origin":"sf_sit-is", "name":"oss-deploy-a-fleet-intelligence-solution-for-taxis", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"streamlit"}}';

-- Show Streamlit URL
SHOW STREAMLITS LIKE 'SF_TAXI_CONTROL_CENTER';

SELECT 'Streamlit app deployed successfully' AS STATUS;
