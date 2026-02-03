-- Risk Intelligence Native App Deployment Script
-- This script creates and deploys the Risk Intelligence Native App

-- Set up the deployment environment
USE ROLE ACCOUNTADMIN;

-- Create application package
CREATE APPLICATION PACKAGE IF NOT EXISTS RISK_INTELLIGENCE_PACKAGE
    COMMENT = 'Risk Intelligence - Comprehensive flood and wildfire risk assessment platform';

-- Create stage for application files
CREATE STAGE IF NOT EXISTS RISK_INTELLIGENCE_PACKAGE.APP_STAGE
    COMMENT = 'Stage for Risk Intelligence Native App files';

-- Upload application files to stage
-- Note: These PUT commands would need to be executed from a client with file access

-- Upload manifest and setup files
PUT file://manifest.yml @RISK_INTELLIGENCE_PACKAGE.APP_STAGE auto_compress=false overwrite=true;
PUT file://README.md @RISK_INTELLIGENCE_PACKAGE.APP_STAGE auto_compress=false overwrite=true;
PUT file://src/setup.sql @RISK_INTELLIGENCE_PACKAGE.APP_STAGE/src/ auto_compress=false overwrite=true;

-- Upload Streamlit applications
PUT file://streamlit/flood_risk_areas.py @RISK_INTELLIGENCE_PACKAGE.APP_STAGE/streamlit/ auto_compress=false overwrite=true;
PUT file://streamlit/wildfire_assessment.py @RISK_INTELLIGENCE_PACKAGE.APP_STAGE/streamlit/ auto_compress=false overwrite=true;
PUT file://streamlit/environment.yml @RISK_INTELLIGENCE_PACKAGE.APP_STAGE/streamlit/ auto_compress=false overwrite=true;
PUT file://streamlit/extra.css @RISK_INTELLIGENCE_PACKAGE.APP_STAGE/streamlit/ auto_compress=false overwrite=true;
PUT file://streamlit/logo.svg @RISK_INTELLIGENCE_PACKAGE.APP_STAGE/streamlit/ auto_compress=false overwrite=true;

-- Upload data files
PUT file://data/uk_storms.csv @RISK_INTELLIGENCE_PACKAGE.APP_STAGE/data/ auto_compress=false overwrite=true;
PUT file://data/Flood_Risk_Areas.geojson @RISK_INTELLIGENCE_PACKAGE.APP_STAGE/data/ auto_compress=false overwrite=true;
PUT file://data/fws_historic_warnings.csv @RISK_INTELLIGENCE_PACKAGE.APP_STAGE/data/ auto_compress=false overwrite=true;

-- Create the application package version
ALTER APPLICATION PACKAGE RISK_INTELLIGENCE_PACKAGE 
    ADD VERSION v1_0 USING '@RISK_INTELLIGENCE_PACKAGE.APP_STAGE';

-- Set the default version
ALTER APPLICATION PACKAGE RISK_INTELLIGENCE_PACKAGE 
    SET DEFAULT RELEASE DIRECTIVE VERSION = v1_0 PATCH = 0;

-- Grant usage on the application package (for testing)
GRANT USAGE ON APPLICATION PACKAGE RISK_INTELLIGENCE_PACKAGE TO ROLE SYSADMIN;

-- Create a test application instance
CREATE APPLICATION IF NOT EXISTS RISK_INTELLIGENCE_TEST
    FROM APPLICATION PACKAGE RISK_INTELLIGENCE_PACKAGE
    USING VERSION v1_0
    COMMENT = 'Test instance of Risk Intelligence Native App';

-- Grant application roles for testing
GRANT APPLICATION ROLE RISK_INTELLIGENCE_TEST.RISK_ANALYST TO ROLE SYSADMIN;
GRANT APPLICATION ROLE RISK_INTELLIGENCE_TEST.RISK_ADMIN TO ROLE SYSADMIN;

-- Load sample data
CALL RISK_INTELLIGENCE_TEST.CORE.LOAD_SAMPLE_DATA();

-- Verify installation
SELECT 
    app_name,
    version,
    description,
    installed_at,
    installed_by
FROM RISK_INTELLIGENCE_TEST.CORE.APPLICATION_INFO;

-- List available Streamlit applications
SHOW STREAMLITS IN APPLICATION RISK_INTELLIGENCE_TEST;

-- Display deployment summary
SELECT 'Risk Intelligence Native App deployed successfully!' AS STATUS,
       'Access Streamlit apps through Snowflake UI' AS NEXT_STEPS,
       'RISK_INTELLIGENCE_TEST.FLOOD_RISK."UK Flood Risk Assessment"' AS FLOOD_APP,
       'RISK_INTELLIGENCE_TEST.WILDFIRE_RISK."California Wildfire Risk Assessment"' AS WILDFIRE_APP;
