-- =============================================================================
-- Taxi Fleet Intelligence - Database Setup
-- =============================================================================
-- This script creates the database, schemas, warehouse, and stage needed for
-- the Fleet Intelligence solution.
--
-- Prerequisites:
--   - ACCOUNTADMIN or appropriate privileges
--   - OpenRouteService Native App installed (OPENROUTESERVICE_NATIVE_APP)
-- =============================================================================

-- Create warehouse if not exists
CREATE WAREHOUSE IF NOT EXISTS COMPUTE_WH
    WAREHOUSE_SIZE = 'XSMALL'
    AUTO_SUSPEND = 60
    AUTO_RESUME = TRUE;

USE WAREHOUSE COMPUTE_WH;

-- Create database and schemas
CREATE DATABASE IF NOT EXISTS FLEET_INTELLIGENCE;
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.PUBLIC;
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.ANALYTICS;

USE DATABASE FLEET_INTELLIGENCE;
USE SCHEMA PUBLIC;

-- Create stage for Streamlit files
CREATE STAGE IF NOT EXISTS STREAMLIT_STAGE
    DIRECTORY = (ENABLE = TRUE);

-- =============================================================================
-- VARIABLES TABLE - Configuration settings for the Fleet Intelligence app
-- =============================================================================
CREATE TABLE IF NOT EXISTS VARIABLES (
    ID VARCHAR(100) PRIMARY KEY,
    VALUE VARCHAR(500)
);

-- Insert default variables (only if not exists)
MERGE INTO VARIABLES AS target
USING (SELECT 'location' AS ID, 'San Francisco' AS VALUE) AS source
ON target.ID = source.ID
WHEN NOT MATCHED THEN INSERT (ID, VALUE) VALUES (source.ID, source.VALUE);

-- Grant ORS access (if needed)
-- GRANT USAGE ON DATABASE OPENROUTESERVICE_NATIVE_APP TO ROLE <your_role>;
-- GRANT USAGE ON SCHEMA OPENROUTESERVICE_NATIVE_APP.CORE TO ROLE <your_role>;

SELECT 'Database setup complete' AS STATUS;
