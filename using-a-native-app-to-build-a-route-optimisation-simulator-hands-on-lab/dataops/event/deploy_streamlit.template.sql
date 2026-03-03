ALTER SESSION SET QUERY_TAG = '''{"origin":"sf_sit-is", "name":"Fleet Intelligence Lab", "version":{"major":1, "minor":0},"attributes":{"is_quickstart":0, "source":"sql"}}''';

use role {{ env.EVENT_ATTENDEE_ROLE }};

CREATE OR REPLACE SCHEMA {{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }};
CREATE STAGE IF NOT EXISTS {{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_1;

PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/streamlit/routing.py @{{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_1 auto_compress = false overwrite = true;
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/streamlit/environment.yml @{{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_1 auto_compress = false overwrite = true;
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/homepage/docs/stylesheets/extra.css @{{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_1 auto_compress = false overwrite = true;
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/streamlit/streamlit/config.toml @{{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_1/.streamlit/ auto_compress = false overwrite = true;
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/streamlit/logo.svg @{{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_1 auto_compress = false overwrite = true;

CREATE OR REPLACE STREAMLIT {{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}."Route Optimizer Simulator"
    FROM @{{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_1
    MAIN_FILE = 'routing.py'
    QUERY_WAREHOUSE = '{{ env.EVENT_WAREHOUSE }}'
    COMMENT = '{"origin":"sf_sit-is", "name":"Fleet Intelligence Lab", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":0, "source":"streamlit"}}';







CREATE STAGE IF NOT EXISTS {{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_2;

PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/streamlit/NYC_taxis.py @{{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_2 auto_compress = false overwrite = true;
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/streamlit/NYC_heat_map.py @{{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_2/pages/ auto_compress = false overwrite = true;
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/streamlit/environment.yml @{{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_2 auto_compress = false overwrite = true;
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/homepage/docs/stylesheets/extra.css @{{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_2 auto_compress = false overwrite = true;
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/streamlit/streamlit/config.toml @{{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_2/.streamlit/ auto_compress = false overwrite = true;
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/streamlit/logo.svg @{{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_2 auto_compress = false overwrite = true;

CREATE OR REPLACE STREAMLIT {{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}."NYC Taxi Trip Viewer"
    FROM @{{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_2
    MAIN_FILE = 'NYC_taxis.py'
    QUERY_WAREHOUSE = '{{ env.EVENT_WAREHOUSE }}'
    COMMENT = '{"origin":"sf_sit-is", "name":"Fleet Intelligence Lab", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":0, "source":"streamlit"}}';


-- Create stage and deploy NYC Beauty Supply Chain Fleet Optimizer (Simplified Version)
CREATE STAGE IF NOT EXISTS {{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_3;

PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/streamlit/nyc_beauty_routing_simple.py @{{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_3 auto_compress = false overwrite = true;
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/streamlit/environment.yml @{{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_3 auto_compress = false overwrite = true;
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/homepage/docs/stylesheets/extra.css @{{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_3 auto_compress = false overwrite = true;
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/streamlit/streamlit/config.toml @{{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_3/.streamlit/ auto_compress = false overwrite = true;
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/streamlit/logo.svg @{{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_3 auto_compress = false overwrite = true;

CREATE OR REPLACE STREAMLIT {{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}."NYC Beauty Supply Chain Optimizer"
    FROM @{{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_3
    MAIN_FILE = 'nyc_beauty_routing_simple.py'
    QUERY_WAREHOUSE = '{{ env.EVENT_WAREHOUSE }}'
    COMMENT = '{"origin":"sf_sit-is", "name":"Fleet Intelligence Lab", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":0, "source":"streamlit"}}';


-- Create stage and deploy ORS Service Manager
CREATE STAGE IF NOT EXISTS {{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_4;

PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/streamlit/service_manager.py @{{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_4 auto_compress = false overwrite = true;
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/streamlit/pages/function_tester.py @{{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_4/pages/ auto_compress = false overwrite = true;
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/streamlit/environment.yml @{{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_4 auto_compress = false overwrite = true;
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/homepage/docs/stylesheets/extra.css @{{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_4 auto_compress = false overwrite = true;
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/streamlit/streamlit/config.toml @{{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_4/.streamlit/ auto_compress = false overwrite = true;
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/streamlit/logo.svg @{{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_4 auto_compress = false overwrite = true;

CREATE OR REPLACE STREAMLIT {{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}."ORS Service Manager"
    FROM @{{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_4
    MAIN_FILE = 'service_manager.py'
    QUERY_WAREHOUSE = '{{ env.EVENT_WAREHOUSE }}'
    COMMENT = '{"origin":"sf_sit-is", "name":"Fleet Intelligence Lab", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":0, "source":"streamlit"}}';

SELECT 'ORS Service Manager deployed!' as status;

-----STREAMLIT_5
CREATE STAGE IF NOT EXISTS {{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_5;

PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/streamlit/nyc_food_delivery_optimizer.py @{{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_5 auto_compress = false overwrite = true;
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/streamlit/environment.yml @{{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_5 auto_compress = false overwrite = true;
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/homepage/docs/stylesheets/extra.css @{{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_5 auto_compress = false overwrite = true;
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/streamlit/streamlit/config.toml @{{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_5/.streamlit/ auto_compress = false overwrite = true;
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/streamlit/logo.svg @{{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_5 auto_compress = false overwrite = true;

CREATE OR REPLACE STREAMLIT {{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}."NYC Food Delivery Optimizer"
    FROM @{{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_5
    MAIN_FILE = 'nyc_food_delivery_optimizer.py'
    QUERY_WAREHOUSE = '{{ env.EVENT_WAREHOUSE }}'
    COMMENT = '{"origin":"sf_sit-is", "name":"Fleet Intelligence Lab", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":0, "source":"streamlit"}}';

SELECT 'NYC Food Delivery Optimizer deployed!' as status;

-- Create stage and deploy Isochrones Viewer
CREATE STAGE IF NOT EXISTS {{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_ISOCHRONES;

PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/streamlit/isochrones.py @{{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_ISOCHRONES auto_compress = false overwrite = true;
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/streamlit/environment.yml @{{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_ISOCHRONES auto_compress = false overwrite = true;
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/homepage/docs/stylesheets/extra.css @{{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_ISOCHRONES auto_compress = false overwrite = true;
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/streamlit/streamlit/config.toml @{{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_ISOCHRONES/.streamlit/ auto_compress = false overwrite = true;
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/streamlit/logo.svg @{{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_ISOCHRONES auto_compress = false overwrite = true;

CREATE OR REPLACE STREAMLIT {{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}."Retail Catchment Analysis"
    FROM @{{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_ISOCHRONES
    MAIN_FILE = 'isochrones.py'
    QUERY_WAREHOUSE = '{{ env.EVENT_WAREHOUSE }}'
    COMMENT = '{"origin":"sf_sit-is", "name":"Fleet Intelligence Lab", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":0, "source":"streamlit"}}';

SELECT 'Retail Catchment Analysis deployed!' as status;

-- Create stage and deploy Wildfire Risk Assessment (Making People Safer) in WILDFIRES_DB
CREATE DATABASE IF NOT EXISTS WILDFIRES_DB;
CREATE SCHEMA IF NOT EXISTS WILDFIRES_DB.STREAMLIT;
CREATE STAGE IF NOT EXISTS WILDFIRES_DB.STREAMLIT.STREAMLIT_WILDFIRE;

PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/streamlit/streamlit_making_people_safer/app.py @WILDFIRES_DB.STREAMLIT.STREAMLIT_WILDFIRE auto_compress = false overwrite = true;
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/streamlit/streamlit_making_people_safer/environment.yml @WILDFIRES_DB.STREAMLIT.STREAMLIT_WILDFIRE auto_compress = false overwrite = true;
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/streamlit/streamlit_making_people_safer/esri.png @WILDFIRES_DB.STREAMLIT.STREAMLIT_WILDFIRE auto_compress = false overwrite = true;
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/homepage/docs/stylesheets/extra.css @WILDFIRES_DB.STREAMLIT.STREAMLIT_WILDFIRE auto_compress = false overwrite = true;
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/streamlit/streamlit/config.toml @WILDFIRES_DB.STREAMLIT.STREAMLIT_WILDFIRE/.streamlit/ auto_compress = false overwrite = true;
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/streamlit/logo.svg @WILDFIRES_DB.STREAMLIT.STREAMLIT_WILDFIRE auto_compress = false overwrite = true;

CREATE OR REPLACE STREAMLIT WILDFIRES_DB.STREAMLIT."California Wildfire Risk Assessment"
    FROM @WILDFIRES_DB.STREAMLIT.STREAMLIT_WILDFIRE
    MAIN_FILE = 'app.py'
    QUERY_WAREHOUSE = '{{ env.EVENT_WAREHOUSE }}'
    COMMENT = '{"origin":"sf_sit-is", "name":"California Wildfire Risk Assessment - Making People Safer", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":0, "source":"streamlit"}}';

SELECT 'California Wildfire Risk Assessment deployed!' as status;

-- Create stage and deploy UK Flood Risk Areas (single-page app) in UK_STORMS_DB
CREATE DATABASE IF NOT EXISTS UK_STORMS_DB;
CREATE SCHEMA IF NOT EXISTS UK_STORMS_DB.STREAMLIT;
CREATE STAGE IF NOT EXISTS UK_STORMS_DB.STREAMLIT.STREAMLIT_FLOOD_RISK;

PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/streamlit/flood_risk_areas.py @UK_STORMS_DB.STREAMLIT.STREAMLIT_FLOOD_RISK auto_compress = false overwrite = true;
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/streamlit/environment.yml @UK_STORMS_DB.STREAMLIT.STREAMLIT_FLOOD_RISK auto_compress = false overwrite = true;
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/homepage/docs/stylesheets/extra.css @UK_STORMS_DB.STREAMLIT.STREAMLIT_FLOOD_RISK auto_compress = false overwrite = true;
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/streamlit/streamlit/config.toml @UK_STORMS_DB.STREAMLIT.STREAMLIT_FLOOD_RISK/.streamlit/ auto_compress = false overwrite = true;
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/streamlit/logo.svg @UK_STORMS_DB.STREAMLIT.STREAMLIT_FLOOD_RISK auto_compress = false overwrite = true;

CREATE OR REPLACE STREAMLIT UK_STORMS_DB.STREAMLIT."Uk Flood Risk Areas"
    FROM @UK_STORMS_DB.STREAMLIT.STREAMLIT_FLOOD_RISK
    MAIN_FILE = 'flood_risk_areas.py'
    QUERY_WAREHOUSE = '{{ env.EVENT_WAREHOUSE }}'
    COMMENT = '{"origin":"sf_sit-is", "name":"UK Flood Risk Areas - Building Flood Risk Analysis", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":0, "source":"streamlit"}}';

SELECT 'UK Flood Risk Areas deployed!' as status;
