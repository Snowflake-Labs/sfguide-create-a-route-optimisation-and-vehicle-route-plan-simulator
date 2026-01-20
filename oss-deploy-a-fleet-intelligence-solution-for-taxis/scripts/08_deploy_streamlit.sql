-- =============================================================================
-- SF Taxi Fleet Intelligence - Streamlit App Deployment
-- =============================================================================
-- This script deploys the Streamlit application to Snowflake.
--
-- Prerequisites:
--   - All previous scripts executed
--   - Streamlit files uploaded to stage (use deploy_streamlit.py)
-- =============================================================================

USE DATABASE FLEET_INTELLIGENCE;
USE SCHEMA PUBLIC;
USE WAREHOUSE COMPUTE_WH;

-- Create the Streamlit app
CREATE OR REPLACE STREAMLIT SF_TAXI_CONTROL_CENTER
  ROOT_LOCATION = '@FLEET_INTELLIGENCE.PUBLIC.STREAMLIT_STAGE/sf_taxi'
  MAIN_FILE = 'SF_Taxi_Control_Center.py'
  QUERY_WAREHOUSE = COMPUTE_WH
  TITLE = 'SF Taxi Control Center';

-- Show Streamlit URL
SHOW STREAMLITS LIKE 'SF_TAXI_CONTROL_CENTER';

SELECT 'Streamlit app deployed successfully' AS STATUS;
