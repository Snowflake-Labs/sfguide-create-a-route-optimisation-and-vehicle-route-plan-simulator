-- Setup script for Retail Catchment Analysis with Carto Overture Maps
-- Prerequisites: 
--   1. OpenRouteService Native App installed
--   2. Carto Overture Maps datasets from Snowflake Marketplace

USE ROLE ACCOUNTADMIN;

-- Set query tag for tracking
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is","name":"oss-retail-catchment-analysis","version":{"major":1, "minor":0},"attributes":{"is_quickstart":1, "source":"sql"}}';

-- Get Carto Overture Maps Places (POI data) from Marketplace
CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZT0Z4CM1E9KR');
CREATE DATABASE IF NOT EXISTS OVERTURE_MAPS__PLACES FROM LISTING GZT0Z4CM1E9KR;

-- Get Carto Overture Maps Addresses from Marketplace
CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZT0Z4CM1E9NQ');
CREATE DATABASE IF NOT EXISTS OVERTURE_MAPS__ADDRESSES FROM LISTING GZT0Z4CM1E9NQ;

-- Create database and schema for the demo
CREATE DATABASE IF NOT EXISTS RETAIL_CATCHMENT_DEMO
    COMMENT = '{"origin":"sf_sit-is", "name":"oss-retail-catchment-analysis", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';
CREATE SCHEMA IF NOT EXISTS RETAIL_CATCHMENT_DEMO.PUBLIC;

USE DATABASE RETAIL_CATCHMENT_DEMO;
USE SCHEMA PUBLIC;

-- Create warehouse if not exists
CREATE WAREHOUSE IF NOT EXISTS ROUTING_ANALYTICS 
    WITH WAREHOUSE_SIZE = 'X-SMALL' 
    AUTO_SUSPEND = 60
    COMMENT = '{"origin":"sf_sit-is", "name":"oss-retail-catchment-analysis", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';

-- Create stage for Streamlit files
CREATE STAGE IF NOT EXISTS STREAMLIT_STAGE
    DIRECTORY = (ENABLE = TRUE)
    ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE');

-- Verify access to Carto Overture Maps data
SELECT COUNT(*) as place_count FROM OVERTURE_MAPS__PLACES.CARTO.PLACE LIMIT 1;
SELECT COUNT(*) as address_count FROM OVERTURE_MAPS__ADDRESSES.CARTO.ADDRESS WHERE COUNTRY = 'US' LIMIT 1;

-- Verify OpenRouteService is available
SHOW APPLICATIONS LIKE '%ROUTE%';
