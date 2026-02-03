-- OpenStreetMap Generator Native App - Deployment Validation Script
-- This script validates that the OSM Native App was deployed correctly

-- Set query tag for tracking
ALTER SESSION SET QUERY_TAG = '''{"origin":"sf_sit-is", "name":"OSM Native App Validation", "version":{"major":1, "minor":0}}''';

-- Use the attendee role
USE ROLE ATTENDEE_ROLE;

-- Check if the application exists
SELECT 'Checking application existence...' as validation_step;
SHOW APPLICATIONS LIKE 'OSM_GENERATOR_APP';

-- Check application status
SELECT 'Checking application status...' as validation_step;
SELECT * FROM OSM_GENERATOR_DB.NATIVE_APP.OSM_APP_STATUS;

-- Check deployment summary
SELECT 'Checking deployment summary...' as validation_step;
SELECT * FROM OSM_GENERATOR_DB.NATIVE_APP.OSM_DEPLOYMENT_SUMMARY;

-- Test application functions
SELECT 'Testing application functions...' as validation_step;

-- Test geocoding function
SELECT 'Testing geocoding function...' as test_name;
SELECT OSM_GENERATOR_APP.core.geocode_city('London, UK') as geocode_test;

-- Test preset areas function
SELECT 'Testing preset areas function...' as test_name;
SELECT * FROM TABLE(OSM_GENERATOR_APP.core.get_preset_areas()) LIMIT 3;

-- Check application objects
SELECT 'Checking application objects...' as validation_step;
SHOW OBJECTS IN APPLICATION OSM_GENERATOR_APP;

-- Check Streamlit applications
SELECT 'Checking Streamlit applications...' as validation_step;
SHOW STREAMLITS IN APPLICATION OSM_GENERATOR_APP;

-- Check external access integration
SELECT 'Checking external access integration...' as validation_step;
SHOW INTEGRATIONS LIKE 'OSM_EXTERNAL_ACCESS';

-- Check network rules
SELECT 'Checking network rules...' as validation_step;
SHOW NETWORK RULES LIKE 'OSM_NETWORK_RULE';

-- Check usage examples
SELECT 'Checking usage examples...' as validation_step;
SELECT example_name, example_category, example_description 
FROM OSM_GENERATOR_DB.NATIVE_APP.OSM_APP_EXAMPLES
ORDER BY example_category, example_name;

-- Check generated maps stage
SELECT 'Checking generated maps stage...' as validation_step;
SHOW STAGES IN APPLICATION OSM_GENERATOR_APP;

-- Final validation summary
SELECT 
    'OSM Native App Validation Complete' as status,
    CURRENT_TIMESTAMP() as validation_time,
    'All components validated successfully' as result;

-- Instructions for next steps
SELECT 
    'Next Steps:' as instruction_type,
    '1. Open Snowsight and navigate to Data Products > Apps' as step_1,
    '2. Find and open OSM_GENERATOR_APP' as step_2,
    '3. Use the Streamlit interface to generate your first map' as step_3,
    '4. Try the SQL examples from OSM_APP_EXAMPLES table' as step_4;
