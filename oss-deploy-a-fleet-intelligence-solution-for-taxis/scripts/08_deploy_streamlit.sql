-- =============================================================================
-- Taxi Fleet Intelligence - Streamlit App Deployment
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
CREATE OR REPLACE STREAMLIT TAXI_CONTROL_CENTER
  ROOT_LOCATION = '@FLEET_INTELLIGENCE.PUBLIC.STREAMLIT_STAGE/taxi'
  MAIN_FILE = 'Taxi_Control_Center.py'
  QUERY_WAREHOUSE = COMPUTE_WH
  TITLE = 'Taxi Control Center';

-- Show Streamlit URL
SHOW STREAMLITS LIKE 'TAXI_CONTROL_CENTER';

SELECT 'Streamlit app deployed successfully' AS STATUS;
