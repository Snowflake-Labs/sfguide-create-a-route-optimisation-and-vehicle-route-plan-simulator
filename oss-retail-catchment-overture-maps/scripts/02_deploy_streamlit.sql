-- Deploy the Retail Catchment Analysis Streamlit App
-- Run this after 01_setup_database.sql

USE ROLE ACCOUNTADMIN;
USE DATABASE RETAIL_CATCHMENT_DEMO;
USE SCHEMA PUBLIC;

-- Create a stage for the Streamlit app
CREATE STAGE IF NOT EXISTS STREAMLIT_STAGE
    DIRECTORY = (ENABLE = TRUE)
    ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE');

-- Upload the Streamlit files using snowsql or UI:
-- PUT file://Streamlit/retail_catchment.py @STREAMLIT_STAGE AUTO_COMPRESS=FALSE OVERWRITE=TRUE;
-- PUT file://Streamlit/environment.yml @STREAMLIT_STAGE AUTO_COMPRESS=FALSE OVERWRITE=TRUE;
-- PUT file://Streamlit/extra.css @STREAMLIT_STAGE AUTO_COMPRESS=FALSE OVERWRITE=TRUE;
-- PUT file://Streamlit/logo.svg @STREAMLIT_STAGE AUTO_COMPRESS=FALSE OVERWRITE=TRUE;
-- PUT file://Streamlit/config.toml @STREAMLIT_STAGE AUTO_COMPRESS=FALSE OVERWRITE=TRUE;

-- Create the Streamlit app
CREATE OR REPLACE STREAMLIT RETAIL_CATCHMENT_APP
    ROOT_LOCATION = '@RETAIL_CATCHMENT_DEMO.PUBLIC.STREAMLIT_STAGE'
    MAIN_FILE = 'retail_catchment.py'
    QUERY_WAREHOUSE = 'COMPUTE_WH'
    TITLE = 'Retail Catchment Analysis - Overture Maps';

-- Grant access to the app
GRANT USAGE ON STREAMLIT RETAIL_CATCHMENT_APP TO ROLE PUBLIC;

-- Show the app URL
SHOW STREAMLITS LIKE 'RETAIL_CATCHMENT_APP';
