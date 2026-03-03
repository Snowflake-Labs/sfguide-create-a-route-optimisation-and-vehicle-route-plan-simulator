ALTER SESSION SET QUERY_TAG = '''{"origin":"sf_sit-is", "name":"Fleet Intelligence Lab", "version":{"major":1, "minor":0},"attributes":{"is_quickstart":0, "source":"sql"}}''';

-- Deploy OpenStreetMap Generator Native App
-- This template creates and deploys the OSM Generator Native App with external access integrations

-- Use ACCOUNTADMIN for initial setup (database creation requires elevated privileges)
USE ROLE ACCOUNTADMIN;
USE WAREHOUSE {{ env.EVENT_WAREHOUSE }};

-- Create database for the native app package
CREATE DATABASE IF NOT EXISTS {{ env.OSM_NATIVE_APP_DATABASE }};
CREATE SCHEMA IF NOT EXISTS {{ env.OSM_NATIVE_APP_DATABASE }}.{{ env.OSM_NATIVE_APP_SCHEMA }};

-- Set database context for subsequent operations
USE DATABASE {{ env.OSM_NATIVE_APP_DATABASE }};
USE SCHEMA {{ env.OSM_NATIVE_APP_SCHEMA }};

-- Grant necessary privileges to attendee role
GRANT USAGE ON DATABASE {{ env.OSM_NATIVE_APP_DATABASE }} TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};
GRANT USAGE ON SCHEMA {{ env.OSM_NATIVE_APP_DATABASE }}.{{ env.OSM_NATIVE_APP_SCHEMA }} TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};
GRANT ALL PRIVILEGES ON SCHEMA {{ env.OSM_NATIVE_APP_DATABASE }}.{{ env.OSM_NATIVE_APP_SCHEMA }} TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};

-- Create stage for native app artifacts (drop and recreate to ensure clean state)
DROP STAGE IF EXISTS {{ env.OSM_NATIVE_APP_DATABASE }}.{{ env.OSM_NATIVE_APP_SCHEMA }}.OSM_APP_STAGE;
CREATE STAGE {{ env.OSM_NATIVE_APP_DATABASE }}.{{ env.OSM_NATIVE_APP_SCHEMA }}.OSM_APP_STAGE
    ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE')
    DIRECTORY = (ENABLE = TRUE)
    COMMENT = 'Stage for OpenStreetMap Generator Native App artifacts';

-- Upload native app artifacts
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/map-generator-native-app/app/manifest.yml @{{ env.OSM_NATIVE_APP_DATABASE }}.{{ env.OSM_NATIVE_APP_SCHEMA }}.OSM_APP_STAGE/app/ auto_compress = false overwrite = true;
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/map-generator-native-app/app/setup.sql @{{ env.OSM_NATIVE_APP_DATABASE }}.{{ env.OSM_NATIVE_APP_SCHEMA }}.OSM_APP_STAGE/app/ auto_compress = false overwrite = true;
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/map-generator-native-app/app/README.md @{{ env.OSM_NATIVE_APP_DATABASE }}.{{ env.OSM_NATIVE_APP_SCHEMA }}.OSM_APP_STAGE/app/ auto_compress = false overwrite = true;

-- Upload Streamlit files to app directory structure
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/map-generator-native-app/streamlit/app.py @{{ env.OSM_NATIVE_APP_DATABASE }}.{{ env.OSM_NATIVE_APP_SCHEMA }}.OSM_APP_STAGE/app/streamlit/ auto_compress = false overwrite = true;
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/map-generator-native-app/streamlit/environment.yml @{{ env.OSM_NATIVE_APP_DATABASE }}.{{ env.OSM_NATIVE_APP_SCHEMA }}.OSM_APP_STAGE/app/streamlit/ auto_compress = false overwrite = true;

-- Create external access integration for OpenStreetMap APIs
-- Following the existing pattern from configure_attendee_account.template.sql
CREATE OR REPLACE NETWORK RULE {{ env.OSM_NATIVE_APP_DATABASE }}.{{ env.OSM_NATIVE_APP_SCHEMA }}.osm_network_rule
    MODE = EGRESS
    TYPE = HOST_PORT
    VALUE_LIST = (
        'overpass-api.de:443',
        'nominatim.openstreetmap.org:443',
        'download.geofabrik.de:443',
        'extract.bbbike.org:443'
    )
    COMMENT = 'Network access for OpenStreetMap APIs';

CREATE OR REPLACE EXTERNAL ACCESS INTEGRATION osm_external_access
    ALLOWED_NETWORK_RULES = (osm_network_rule)
    ALLOWED_AUTHENTICATION_SECRETS = ()
    ENABLED = TRUE
    COMMENT = 'External access integration for OpenStreetMap Generator Native App';

-- Simple approach for test instance: Drop and recreate entire application package
DROP APPLICATION PACKAGE IF EXISTS {{ env.OSM_NATIVE_APP_PACKAGE_NAME }};

CREATE APPLICATION PACKAGE {{ env.OSM_NATIVE_APP_PACKAGE_NAME }}
    COMMENT = 'OpenStreetMap Generator Native App Package';

-- Add version (use REGISTER since release channels are enabled by default)
ALTER APPLICATION PACKAGE {{ env.OSM_NATIVE_APP_PACKAGE_NAME }}
    REGISTER VERSION {{ env.OSM_NATIVE_APP_VERSION }}
    USING '@{{ env.OSM_NATIVE_APP_DATABASE }}.{{ env.OSM_NATIVE_APP_SCHEMA }}.OSM_APP_STAGE/app/';

-- Grant usage on application package to attendee role
GRANT USAGE ON APPLICATION PACKAGE {{ env.OSM_NATIVE_APP_PACKAGE_NAME }} TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};

-- Create application instance  
-- Drop and recreate application for test instance simplicity
DROP APPLICATION IF EXISTS {{ env.OSM_NATIVE_APP_NAME }};

-- Create application
CREATE APPLICATION {{ env.OSM_NATIVE_APP_NAME }}
    FROM APPLICATION PACKAGE {{ env.OSM_NATIVE_APP_PACKAGE_NAME }}
    USING VERSION {{ env.OSM_NATIVE_APP_VERSION }}
    AUTHORIZE_TELEMETRY_EVENT_SHARING = TRUE
    COMMENT = 'OpenStreetMap Generator Application';

-- Grant warehouse usage for Streamlit
GRANT USAGE ON WAREHOUSE {{ env.EVENT_WAREHOUSE }} 
    TO APPLICATION {{ env.OSM_NATIVE_APP_NAME }};

-- Bind the external access integration reference
-- Use SYSTEM$REFERENCE to create a reference object, then pass to the callback
-- Scope must be PERSISTENT for external access integrations
EXECUTE IMMEDIATE $$
DECLARE
    ref_alias STRING;
BEGIN
    -- Create a reference to the external access integration (scope: PERSISTENT)
    ref_alias := (SELECT SYSTEM$REFERENCE('EXTERNAL ACCESS INTEGRATION', 'OSM_EXTERNAL_ACCESS', 'PERSISTENT'));
    -- Bind it using the register callback
    CALL {{ env.OSM_NATIVE_APP_NAME }}.core.register_single_callback('external_access_integration_ref', 'ADD', :ref_alias);
    RETURN 'Reference bound successfully';
END;
$$;

-- Now trigger the grant_callback to create the real OSM functions
CALL {{ env.OSM_NATIVE_APP_NAME }}.core.grant_callback(ARRAY_CONSTRUCT());

-- Application deployed with placeholder functions
-- Users can upgrade to real OpenStreetMap APIs via the Streamlit interface
-- after the external access integration reference is bound

-- Create convenience view for application status
CREATE OR REPLACE VIEW {{ env.OSM_NATIVE_APP_DATABASE }}.{{ env.OSM_NATIVE_APP_SCHEMA }}.OSM_APP_STATUS AS
SELECT 
    '{{ env.OSM_NATIVE_APP_NAME }}' as APPLICATION_NAME,
    '{{ env.OSM_NATIVE_APP_VERSION }}' as VERSION,
    CURRENT_TIMESTAMP() as DEPLOYMENT_TIME,
    'DEPLOYED' as STATUS,
    'OpenStreetMap Generator Native App deployed successfully' as MESSAGE;

-- Grant access to the status view
GRANT SELECT ON VIEW {{ env.OSM_NATIVE_APP_DATABASE }}.{{ env.OSM_NATIVE_APP_SCHEMA }}.OSM_APP_STATUS 
    TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};

-- Create sample data and test the application
USE APPLICATION {{ env.OSM_NATIVE_APP_NAME }};

-- Test geocoding function
SELECT 'Testing geocoding function...' as test_step;
SELECT core.geocode_city('London, UK') as london_geocode_test;

-- Test preset areas function
SELECT 'Testing preset areas function...' as test_step;
SELECT * FROM TABLE(core.get_preset_areas()) LIMIT 3;

-- Show application objects
SELECT 'Listing application objects...' as test_step;
SHOW OBJECTS IN APPLICATION {{ env.OSM_NATIVE_APP_NAME }};

-- Show Streamlit apps
SELECT 'Listing Streamlit applications...' as test_step;
SHOW STREAMLITS IN APPLICATION {{ env.OSM_NATIVE_APP_NAME }};

-- Return to original role
USE ROLE {{ env.EVENT_ATTENDEE_ROLE }};

-- Create documentation table with usage examples
CREATE OR REPLACE TABLE {{ env.OSM_NATIVE_APP_DATABASE }}.{{ env.OSM_NATIVE_APP_SCHEMA }}.OSM_APP_EXAMPLES (
    example_id NUMBER AUTOINCREMENT,
    example_name STRING,
    example_description STRING,
    example_sql STRING,
    example_category STRING
);

INSERT INTO {{ env.OSM_NATIVE_APP_DATABASE }}.{{ env.OSM_NATIVE_APP_SCHEMA }}.OSM_APP_EXAMPLES 
    (example_name, example_description, example_sql, example_category)
VALUES
    ('Generate Map by City', 
     'Generate a map for London, UK using city name geocoding',
     'CALL {{ env.OSM_NATIVE_APP_NAME }}.core.generate_map(''city'', PARSE_JSON(''{"city_name": "London, UK", "output_filename": "london.osm"}''));',
     'Basic Usage'),
     
    ('Generate Map by Coordinates', 
     'Generate a map using specific bounding box coordinates for Manhattan',
     'CALL {{ env.OSM_NATIVE_APP_NAME }}.core.generate_map(''bbox'', PARSE_JSON(''{"bbox": "-74.0479,40.7128,-73.9441,40.7831", "output_filename": "manhattan.osm"}''));',
     'Basic Usage'),
     
    ('View Generation History', 
     'Check the history of all map generations with metrics',
     'SELECT * FROM {{ env.OSM_NATIVE_APP_NAME }}.core.map_generation_history ORDER BY request_timestamp DESC;',
     'Monitoring'),
     
    ('Get Preset Areas', 
     'List all available preset areas with coordinates',
     'SELECT * FROM TABLE({{ env.OSM_NATIVE_APP_NAME }}.core.get_preset_areas());',
     'Reference'),
     
    ('Geocode City Name', 
     'Convert a city name to coordinates and bounding box',
     'SELECT {{ env.OSM_NATIVE_APP_NAME }}.core.geocode_city(''Paris, France'') as geocode_result;',
     'Utilities'),
     
    ('List Generated Files', 
     'Show all generated map files in the application stage',
     'LIST @{{ env.OSM_NATIVE_APP_NAME }}.core.generated_maps;',
     'File Management'),
     
    ('Download Generated Map', 
     'Download a generated map file to local system',
     'GET @{{ env.OSM_NATIVE_APP_NAME }}.core.generated_maps/london.osm file:///local/path/;',
     'File Management'),
     
    ('Application Status', 
     'Check the deployment status and version of the native app',
     'SELECT * FROM {{ env.OSM_NATIVE_APP_DATABASE }}.{{ env.OSM_NATIVE_APP_SCHEMA }}.OSM_APP_STATUS;',
     'Monitoring');

-- Grant access to examples table
GRANT SELECT ON TABLE {{ env.OSM_NATIVE_APP_DATABASE }}.{{ env.OSM_NATIVE_APP_SCHEMA }}.OSM_APP_EXAMPLES 
    TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};

-- Create a summary view of the deployment
CREATE OR REPLACE VIEW {{ env.OSM_NATIVE_APP_DATABASE }}.{{ env.OSM_NATIVE_APP_SCHEMA }}.OSM_DEPLOYMENT_SUMMARY AS
SELECT 
    'OpenStreetMap Generator Native App' as component,
    '{{ env.OSM_NATIVE_APP_NAME }}' as application_name,
    '{{ env.OSM_NATIVE_APP_VERSION }}' as version,
    '{{ env.OSM_NATIVE_APP_DATABASE }}.{{ env.OSM_NATIVE_APP_SCHEMA }}' as schema_location,
    'DEPLOYED' as status,
    CURRENT_TIMESTAMP() as deployment_timestamp,
    'Generate custom OpenStreetMap files for any location worldwide' as description,
    OBJECT_CONSTRUCT(
        'streamlit_app', '{{ env.OSM_NATIVE_APP_NAME }}.core.map_generator_app',
        'external_access', '{{ env.OSM_NATIVE_APP_DATABASE }}.{{ env.OSM_NATIVE_APP_SCHEMA }}.OSM_EXTERNAL_ACCESS',
        'network_rule', '{{ env.OSM_NATIVE_APP_DATABASE }}.{{ env.OSM_NATIVE_APP_SCHEMA }}.OSM_NETWORK_RULE',
        'examples_table', '{{ env.OSM_NATIVE_APP_DATABASE }}.{{ env.OSM_NATIVE_APP_SCHEMA }}.OSM_APP_EXAMPLES'
    ) as configuration;

-- Grant access to summary view
GRANT SELECT ON VIEW {{ env.OSM_NATIVE_APP_DATABASE }}.{{ env.OSM_NATIVE_APP_SCHEMA }}.OSM_DEPLOYMENT_SUMMARY 
    TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};

-- Final status message
SELECT 
    'OpenStreetMap Generator Native App deployed successfully!' as status,
    '{{ env.OSM_NATIVE_APP_NAME }}' as application_name,
    '{{ env.OSM_NATIVE_APP_VERSION }}' as version,
    'Access via Snowsight > Data Products > Apps' as access_instructions,
    'Use the Streamlit interface to generate custom maps' as usage_instructions;

-- Show deployment summary
SELECT * FROM {{ env.OSM_NATIVE_APP_DATABASE }}.{{ env.OSM_NATIVE_APP_SCHEMA }}.OSM_DEPLOYMENT_SUMMARY;
