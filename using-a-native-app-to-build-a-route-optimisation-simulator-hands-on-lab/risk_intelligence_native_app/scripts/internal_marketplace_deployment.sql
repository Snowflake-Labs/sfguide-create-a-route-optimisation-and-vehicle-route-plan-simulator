-- Risk Intelligence Native App - Internal Marketplace Deployment
-- Optimized for internal organizational use and distribution

-- ===== INTERNAL MARKETPLACE SETUP =====
USE ROLE ACCOUNTADMIN;

-- Create application package for internal marketplace
CREATE APPLICATION PACKAGE IF NOT EXISTS RISK_INTELLIGENCE_INTERNAL
    COMMENT = 'Risk Intelligence - Internal Marketplace - Flood and Wildfire Risk Assessment';

-- Create version control schema
CREATE SCHEMA IF NOT EXISTS RISK_INTELLIGENCE_INTERNAL.VERSIONS;

-- Create internal distribution stage
CREATE STAGE IF NOT EXISTS RISK_INTELLIGENCE_INTERNAL.INTERNAL_STAGE
    COMMENT = 'Internal distribution stage for Risk Intelligence app';

-- ===== SIMPLIFIED MANIFEST FOR INTERNAL USE =====
-- Create a simplified manifest optimized for internal deployment
CREATE OR REPLACE FILE RISK_INTELLIGENCE_INTERNAL.INTERNAL_STAGE/manifest_internal.yml AS
$$
manifest_version: 1

version:
  name: "1.0.0-internal"
  label: "Risk Intelligence Internal v1.0"
  comment: "Internal marketplace version - Flood and wildfire risk assessment"

artifacts:
  setup_script: setup_internal.sql
  readme: README_internal.md

configuration:
  log_level: INFO
  trace_level: OFF

privileges:
  - CREATE DATABASE
  - CREATE SCHEMA
  - CREATE TABLE
  - CREATE VIEW
  - CREATE STAGE
  - CREATE FILE FORMAT
  - CREATE STREAMLIT
  - USAGE
  - IMPORTED PRIVILEGES

application_roles:
  - name: RISK_USER
    label: "Risk User"
    comment: "Standard user role for risk analysis"
  - name: RISK_ADMIN
    label: "Risk Administrator" 
    comment: "Administrative role for risk intelligence management"

references:
  - consumer_database:
      label: "Risk Intelligence Database"
      description: "Internal risk assessment database"
      privileges:
        - CREATE SCHEMA
        - CREATE TABLE
        - CREATE VIEW
        - CREATE STREAMLIT
        - USAGE
$$;

-- ===== INTERNAL SETUP SCRIPT =====
CREATE OR REPLACE FILE RISK_INTELLIGENCE_INTERNAL.INTERNAL_STAGE/setup_internal.sql AS
$$
-- Risk Intelligence Internal Setup
-- Simplified setup for internal marketplace distribution

-- Create application roles
CREATE APPLICATION ROLE IF NOT EXISTS RISK_USER;
CREATE APPLICATION ROLE IF NOT EXISTS RISK_ADMIN;

-- Create schemas
CREATE SCHEMA IF NOT EXISTS FLOOD_RISK;
CREATE SCHEMA IF NOT EXISTS WILDFIRE_RISK;
CREATE SCHEMA IF NOT EXISTS SHARED_RESOURCES;

-- Create compute resources
CREATE WAREHOUSE IF NOT EXISTS RISK_INTELLIGENCE_WH
    WAREHOUSE_SIZE = 'SMALL'
    AUTO_SUSPEND = 300
    AUTO_RESUME = TRUE
    INITIALLY_SUSPENDED = TRUE
    COMMENT = 'Warehouse for Risk Intelligence Internal App';

-- Grant warehouse usage
GRANT USAGE ON WAREHOUSE RISK_INTELLIGENCE_WH TO APPLICATION ROLE RISK_USER;
GRANT ALL ON WAREHOUSE RISK_INTELLIGENCE_WH TO APPLICATION ROLE RISK_ADMIN;

-- Create shared resources
CREATE STAGE IF NOT EXISTS SHARED_RESOURCES.APP_DATA
    COMMENT = 'Shared data stage for risk intelligence';

CREATE FILE FORMAT IF NOT EXISTS SHARED_RESOURCES.CSV_FORMAT
    TYPE = CSV
    FIELD_DELIMITER = ','
    SKIP_HEADER = 1
    FIELD_OPTIONALLY_ENCLOSED_BY = '"'
    NULL_IF = ('NULL', '\\N', '')
    EMPTY_FIELD_AS_NULL = TRUE;

CREATE FILE FORMAT IF NOT EXISTS SHARED_RESOURCES.JSON_FORMAT
    TYPE = JSON
    STRIP_OUTER_ARRAY = FALSE
    COMPRESSION = AUTO;

-- ===== FLOOD RISK COMPONENTS =====

-- Flood risk tables
CREATE TABLE IF NOT EXISTS FLOOD_RISK.UK_STORMS (
    NAME STRING,
    DATES STRING,
    DESCRIPTION STRING,
    UK_FATALITIES STRING,
    SOURCE STRING,
    NEWS_SUMMARY STRING
);

CREATE TABLE IF NOT EXISTS FLOOD_RISK.FLOOD_AREAS (
    AREA_ID STRING,
    AREA_NAME STRING,
    FLOOD_SOURCE STRING,
    RISK_LEVEL STRING,
    GEOMETRY GEOGRAPHY,
    PROPERTIES VARIANT
);

-- Flood risk Streamlit app
CREATE STREAMLIT IF NOT EXISTS FLOOD_RISK."Flood Risk Dashboard"
    FROM '@SHARED_RESOURCES.APP_DATA'
    MAIN_FILE = 'flood_risk_areas.py'
    QUERY_WAREHOUSE = 'RISK_INTELLIGENCE_WH'
    COMMENT = 'Internal Flood Risk Assessment Dashboard';

-- ===== WILDFIRE RISK COMPONENTS =====

-- Wildfire risk tables (with internal data structure)
CREATE TABLE IF NOT EXISTS WILDFIRE_RISK.FIRE_INCIDENTS (
    INCIDENT_ID STRING,
    FIRE_NAME STRING,
    START_DATE DATE,
    LOCATION STRING,
    ACRES_BURNED NUMBER,
    RISK_SCORE FLOAT,
    GEOMETRY GEOGRAPHY
);

CREATE TABLE IF NOT EXISTS WILDFIRE_RISK.INFRASTRUCTURE_RISK (
    ASSET_ID STRING,
    ASSET_TYPE STRING,
    LATITUDE FLOAT,
    LONGITUDE FLOAT,
    RISK_SCORE FLOAT,
    LAST_ASSESSMENT DATE
);

-- Wildfire risk Streamlit app
CREATE STREAMLIT IF NOT EXISTS WILDFIRE_RISK."Wildfire Risk Dashboard"
    FROM '@SHARED_RESOURCES.APP_DATA'
    MAIN_FILE = 'wildfire_assessment.py'
    QUERY_WAREHOUSE = 'RISK_INTELLIGENCE_WH'
    COMMENT = 'Internal Wildfire Risk Assessment Dashboard';

-- ===== PERMISSIONS =====

-- Grant schema permissions
GRANT USAGE ON SCHEMA FLOOD_RISK TO APPLICATION ROLE RISK_USER;
GRANT USAGE ON SCHEMA WILDFIRE_RISK TO APPLICATION ROLE RISK_USER;
GRANT USAGE ON SCHEMA SHARED_RESOURCES TO APPLICATION ROLE RISK_USER;

GRANT ALL ON SCHEMA FLOOD_RISK TO APPLICATION ROLE RISK_ADMIN;
GRANT ALL ON SCHEMA WILDFIRE_RISK TO APPLICATION ROLE RISK_ADMIN;
GRANT ALL ON SCHEMA SHARED_RESOURCES TO APPLICATION ROLE RISK_ADMIN;

-- Grant table permissions
GRANT SELECT ON ALL TABLES IN SCHEMA FLOOD_RISK TO APPLICATION ROLE RISK_USER;
GRANT SELECT ON ALL TABLES IN SCHEMA WILDFIRE_RISK TO APPLICATION ROLE RISK_USER;

GRANT ALL ON ALL TABLES IN SCHEMA FLOOD_RISK TO APPLICATION ROLE RISK_ADMIN;
GRANT ALL ON ALL TABLES IN SCHEMA WILDFIRE_RISK TO APPLICATION ROLE RISK_ADMIN;

-- Grant Streamlit permissions
GRANT USAGE ON STREAMLIT FLOOD_RISK."Flood Risk Dashboard" TO APPLICATION ROLE RISK_USER;
GRANT USAGE ON STREAMLIT WILDFIRE_RISK."Wildfire Risk Dashboard" TO APPLICATION ROLE RISK_USER;

-- Create data loading procedure for internal use
CREATE OR REPLACE PROCEDURE SHARED_RESOURCES.LOAD_INTERNAL_DATA()
RETURNS STRING
LANGUAGE SQL
AS
BEGIN
    -- Load sample flood data
    INSERT INTO FLOOD_RISK.UK_STORMS VALUES
        ('Storm Ciara', '2020-02-08 to 2020-02-10', 'Major winter storm', '8', 'Met Office', 'Widespread flooding'),
        ('Storm Dennis', '2020-02-15 to 2020-02-17', 'Second major storm in February', '5', 'Met Office', 'Record rainfall');
    
    -- Load sample wildfire data
    INSERT INTO WILDFIRE_RISK.FIRE_INCIDENTS VALUES
        ('CA-2023-001', 'Sample Fire', '2023-08-15', 'California', 5000, 0.85, NULL),
        ('CA-2023-002', 'Test Incident', '2023-09-01', 'California', 1200, 0.65, NULL);
    
    RETURN 'Internal sample data loaded successfully';
END;

GRANT USAGE ON PROCEDURE SHARED_RESOURCES.LOAD_INTERNAL_DATA() TO APPLICATION ROLE RISK_ADMIN;
$$;

-- ===== INTERNAL README =====
CREATE OR REPLACE FILE RISK_INTELLIGENCE_INTERNAL.INTERNAL_STAGE/README_internal.md AS
$$
# Risk Intelligence - Internal Marketplace

## Overview
Internal organizational deployment of the Risk Intelligence platform for flood and wildfire risk assessment.

## Features
- **Flood Risk Assessment**: UK flood risk analysis and monitoring
- **Wildfire Risk Assessment**: California wildfire risk evaluation
- **Internal Data Integration**: Optimized for organizational data sources
- **Simplified Deployment**: Streamlined for internal use

## Installation for Internal Users

### 1. Install Application
```sql
CREATE APPLICATION RISK_INTELLIGENCE 
FROM APPLICATION PACKAGE RISK_INTELLIGENCE_INTERNAL;
```

### 2. Assign User Roles
```sql
-- For standard users
GRANT APPLICATION ROLE RISK_INTELLIGENCE.RISK_USER TO ROLE <user_role>;

-- For administrators
GRANT APPLICATION ROLE RISK_INTELLIGENCE.RISK_ADMIN TO ROLE <admin_role>;
```

### 3. Load Initial Data
```sql
CALL RISK_INTELLIGENCE.SHARED_RESOURCES.LOAD_INTERNAL_DATA();
```

### 4. Access Dashboards
- Flood Risk: Navigate to `RISK_INTELLIGENCE.FLOOD_RISK."Flood Risk Dashboard"`
- Wildfire Risk: Navigate to `RISK_INTELLIGENCE.WILDFIRE_RISK."Wildfire Risk Dashboard"`

## Internal Support
Contact your internal IT team or data platform administrators for:
- Installation assistance
- Data integration questions
- Performance optimization
- Access management

## Data Sources
This internal version is configured to work with:
- Internal organizational risk data
- Approved external data sources
- Marketplace data (where licensed)
- Historical incident databases

## Compliance
Ensure compliance with organizational:
- Data governance policies
- Security requirements
- Access control standards
- Audit and monitoring requirements
$$;

-- ===== DEPLOYMENT COMMANDS =====

-- Upload application files (these would be run from client with file access)
-- PUT file://streamlit/flood_risk_areas.py @RISK_INTELLIGENCE_INTERNAL.INTERNAL_STAGE/streamlit/;
-- PUT file://streamlit/wildfire_assessment.py @RISK_INTELLIGENCE_INTERNAL.INTERNAL_STAGE/streamlit/;
-- PUT file://streamlit/environment.yml @RISK_INTELLIGENCE_INTERNAL.INTERNAL_STAGE/streamlit/;
-- PUT file://streamlit/extra.css @RISK_INTELLIGENCE_INTERNAL.INTERNAL_STAGE/streamlit/;
-- PUT file://streamlit/logo.svg @RISK_INTELLIGENCE_INTERNAL.INTERNAL_STAGE/streamlit/;

-- Create application package version
ALTER APPLICATION PACKAGE RISK_INTELLIGENCE_INTERNAL 
    ADD VERSION v1_0_internal USING '@RISK_INTELLIGENCE_INTERNAL.INTERNAL_STAGE'
    COMMENT = 'Internal marketplace version 1.0';

-- Set as default version
ALTER APPLICATION PACKAGE RISK_INTELLIGENCE_INTERNAL 
    SET DEFAULT RELEASE DIRECTIVE VERSION = v1_0_internal PATCH = 0;

-- ===== INTERNAL DISTRIBUTION SETUP =====

-- Create role for internal app distribution
CREATE ROLE IF NOT EXISTS RISK_INTELLIGENCE_DISTRIBUTOR
    COMMENT = 'Role for managing internal Risk Intelligence app distribution';

-- Grant necessary privileges for internal distribution
GRANT USAGE ON APPLICATION PACKAGE RISK_INTELLIGENCE_INTERNAL TO ROLE RISK_INTELLIGENCE_DISTRIBUTOR;
GRANT CREATE APPLICATION ON ACCOUNT TO ROLE RISK_INTELLIGENCE_DISTRIBUTOR;

-- Create procedure for automated internal deployment
CREATE OR REPLACE PROCEDURE RISK_INTELLIGENCE_INTERNAL.VERSIONS.DEPLOY_TO_INTERNAL_USER(USER_ROLE STRING)
RETURNS STRING
LANGUAGE SQL
AS
$$
DECLARE
    app_name STRING DEFAULT 'RISK_INTELLIGENCE_' || REPLACE(USER_ROLE, ' ', '_');
BEGIN
    -- Create application for user
    EXECUTE IMMEDIATE 'CREATE APPLICATION IF NOT EXISTS ' || app_name || 
        ' FROM APPLICATION PACKAGE RISK_INTELLIGENCE_INTERNAL';
    
    -- Grant user role
    EXECUTE IMMEDIATE 'GRANT APPLICATION ROLE ' || app_name || '.RISK_USER TO ROLE ' || USER_ROLE;
    
    -- Load initial data
    EXECUTE IMMEDIATE 'CALL ' || app_name || '.SHARED_RESOURCES.LOAD_INTERNAL_DATA()';
    
    RETURN 'Risk Intelligence deployed for role: ' || USER_ROLE || ' as application: ' || app_name;
END;
$$;

-- Grant execution on deployment procedure
GRANT USAGE ON PROCEDURE RISK_INTELLIGENCE_INTERNAL.VERSIONS.DEPLOY_TO_INTERNAL_USER(STRING) 
    TO ROLE RISK_INTELLIGENCE_DISTRIBUTOR;

-- ===== VERIFICATION =====

SELECT 'Risk Intelligence Internal Marketplace Setup Complete!' AS STATUS,
       'Use RISK_INTELLIGENCE_INTERNAL package for internal distribution' AS PACKAGE_NAME,
       'Call DEPLOY_TO_INTERNAL_USER() procedure for automated deployment' AS DEPLOYMENT_METHOD;
