-- Configure Attendee Account
ALTER SESSION SET QUERY_TAG = '''{"origin":"sf_sit-is", "name":"Fleet Intelligence Lab", "version":{"major":1, "minor":0},"attributes":{"is_quickstart":0, "source":"sql"}}''';

-- Create the warehouse
USE ROLE ACCOUNTADMIN;

ALTER ACCOUNT SET CORTEX_ENABLED_CROSS_REGION = 'ANY_REGION';

create or replace warehouse {{ env.EVENT_WAREHOUSE }}
    AUTO_SUSPEND = 60;
use warehouse {{ env.EVENT_WAREHOUSE }};

SHOW AVAILABLE LISTINGS IS_ORGANIZATION = TRUE;
call SYSTEM$REQUEST_LISTING_AND_WAIT('GZTYZ1US94U', 20);

call SYSTEM$REQUEST_LISTING_AND_WAIT('GZTYZ1US993', 20);

call SYSTEM$REQUEST_LISTING_AND_WAIT('GZTYZ1US98A', 20);

call SYSTEM$REQUEST_LISTING_AND_WAIT('GZTYZDQBOGCV', 20);

CALL SYSTEM$REQUEST_LISTING_AND_WAIT('GZTYZDQBOGE1', 20); -- Enhanced Fleet Management

CALL SYSTEM$REQUEST_LISTING_AND_WAIT('GZTYZ1US94U', 20); --- MAKING PEOPLE SAFER

CALL SYSTEM$REQUEST_LISTING_AND_WAIT('GZTYZ1US939', 20); -- OS_BUILDING_SAMPLE_DATA





----- Disable mandatory MFA -----
USE ROLE ACCOUNTADMIN;

CREATE DATABASE IF NOT EXISTS policy_db;
USE DATABASE policy_db;

CREATE SCHEMA IF NOT EXISTS policies;
USE SCHEMA policies;

CREATE AUTHENTICATION POLICY IF NOT EXISTS event_authentication_policy;

ALTER AUTHENTICATION POLICY event_authentication_policy SET
  MFA_ENROLLMENT=OPTIONAL
  CLIENT_TYPES = ('ALL')
  AUTHENTICATION_METHODS = ('ALL');

EXECUTE IMMEDIATE $$
    BEGIN
        ALTER ACCOUNT SET AUTHENTICATION POLICY event_authentication_policy;
    EXCEPTION
        WHEN STATEMENT_ERROR THEN
            RETURN SQLERRM;
    END;
$$
;
---------------------------------

-- Create the Attendee role if it does not exist
use role SECURITYADMIN;
create role if not exists {{ env.EVENT_ATTENDEE_ROLE }};

-- Ensure account admin can see what {{ env.EVENT_ATTENDEE_ROLE }} can see
grant role {{ env.EVENT_ATTENDEE_ROLE }} to role ACCOUNTADMIN;

-- Grant the necessary priviliges to that role.
use role ACCOUNTADMIN;
grant CREATE DATABASE on account to role {{ env.EVENT_ATTENDEE_ROLE }};
grant CREATE ROLE on account to role {{ env.EVENT_ATTENDEE_ROLE }};
grant CREATE WAREHOUSE on account to role {{ env.EVENT_ATTENDEE_ROLE }};
grant MANAGE GRANTS on account to role {{ env.EVENT_ATTENDEE_ROLE }};
grant CREATE INTEGRATION on account to role {{ env.EVENT_ATTENDEE_ROLE }};
grant CREATE APPLICATION PACKAGE on account to role {{ env.EVENT_ATTENDEE_ROLE }} WITH GRANT OPTION;
grant CREATE APPLICATION on account to role {{ env.EVENT_ATTENDEE_ROLE }};
grant IMPORT SHARE on account to role {{ env.EVENT_ATTENDEE_ROLE }};
GRANT CREATE COMPUTE POOL ON ACCOUNT TO ROLE {{ env.EVENT_ATTENDEE_ROLE }} WITH GRANT OPTION;
grant bind service endpoint on account to role {{ env.EVENT_ATTENDEE_ROLE }};

-- Create the users
use role USERADMIN;
create user if not exists {{ env.EVENT_USER_NAME }}
    PASSWORD = '{{ env.EVENT_USER_PASSWORD }}'
    LOGIN_NAME = {{ env.EVENT_USER_NAME }}
    FIRST_NAME = 'EVENT'
    LAST_NAME = 'USER'
    MUST_CHANGE_PASSWORD = false
    TYPE = PERSON;
create user if not exists {{ env.EVENT_ADMIN_NAME }}
    PASSWORD = '{{ env.EVENT_ADMIN_PASSWORD }}'
    LOGIN_NAME = {{ env.EVENT_ADMIN_NAME }}
    FIRST_NAME = 'EVENT'
    LAST_NAME = 'ADMIN'
    MUST_CHANGE_PASSWORD = false
    TYPE = PERSON;

-- Ensure the user can use the role and warehouse
use role SECURITYADMIN;
grant role {{ env.EVENT_ATTENDEE_ROLE }} to user {{ env.EVENT_USER_NAME }};
grant USAGE on warehouse {{ env.EVENT_WAREHOUSE }} to role {{ env.EVENT_ATTENDEE_ROLE }};

-- Ensure USER and ADMIN can use ACCOUNTADMIN role
grant role ACCOUNTADMIN to user {{ env.EVENT_USER_NAME }};
grant role ACCOUNTADMIN to user {{ env.EVENT_ADMIN_NAME }};

-- Alter the users to set default role and warehouse
use role USERADMIN;
alter user {{ env.EVENT_USER_NAME }} set
    DEFAULT_ROLE = {{ env.EVENT_ATTENDEE_ROLE }}
    DEFAULT_WAREHOUSE = {{ env.EVENT_WAREHOUSE }};
alter user {{ env.EVENT_ADMIN_NAME }} set
    DEFAULT_ROLE = ACCOUNTADMIN
    DEFAULT_WAREHOUSE = {{ env.EVENT_WAREHOUSE }};

-- Alter all PERSON users to MINS_TO_BYPASS_MFA to 1440 every 24hrs
{% raw %}
use role ACCOUNTADMIN;
CREATE OR REPLACE TASK POLICY_DB.POLICIES.MFA_USERS_BYPASS
    SCHEDULE = '23 HOURS'
    USER_TASK_MANAGED_INITIAL_WAREHOUSE_SIZE = 'XSMALL'
    AS
    EXECUTE IMMEDIATE $$
    DECLARE
        user_cursor RESULTSET;
        user_name STRING;
    BEGIN
        user_cursor := (SELECT NAME FROM SNOWFLAKE.ACCOUNT_USAGE.USERS WHERE DELETED_ON IS NULL AND TYPE = 'PERSON');
        FOR user_record IN user_cursor DO
            user_name := user_record.NAME;
            ALTER USER identifier(:user_name) SET MINS_TO_BYPASS_MFA = 1440;
        END FOR;
    END;
    $$;

EXECUTE TASK POLICY_DB.POLICIES.MFA_USERS_BYPASS;
{% endraw %}
alter task POLICY_DB.POLICIES.MFA_USERS_BYPASS resume;

-- Create the database and schemas using {{ env.EVENT_ATTENDEE_ROLE }}
use role {{ env.EVENT_ATTENDEE_ROLE }};

create  database if not exists {{ env.EVENT_DATABASE }};
create  schema if not exists {{ env.EVENT_DATABASE }}.{{ env.EVENT_SCHEMA }};
create  schema if not exists {{ env.EVENT_DATABASE }}.DATA;
create  schema if not exists {{ env.EVENT_DATABASE }}.CORE;


-----add views

CREATE OR REPLACE VIEW {{ env.EVENT_DATABASE }}.{{ env.EVENT_SCHEMA }}.POI_IN_CALIFORNIA AS 
select * from "ORGDATACLOUD$INTERNAL$LOCATION_ANALYTICS_-_MAKING_PEOPLE_SAFER".TELCO_GEOSPATIAL_HANDS_ON_LAB.POI_IN_CALIFORNIA;

CREATE OR REPLACE VIEW {{ env.EVENT_DATABASE }}.{{ env.EVENT_SCHEMA }}.POI_IN_CALIFORNIA
AS 
select * from "ORGDATACLOUD$INTERNAL$LOCATION_ANALYTICS_-_MAKING_PEOPLE_SAFER".TELCO_GEOSPATIAL_HANDS_ON_LAB.POI_IN_CALIFORNIA;


CREATE OR REPLACE VIEW {{ env.EVENT_DATABASE }}.{{ env.EVENT_SCHEMA }}.CUSTOMER_LOYALITY_WITH_BUILDING_INFO
AS
select * from "ORGDATACLOUD$INTERNAL$LOCATION_ANALYTICS_-_MAKING_PEOPLE_SAFER".TELCO_GEOSPATIAL_HANDS_ON_LAB.POI_IN_CALIFORNIA;




-----below is the script for using the external api.  Note you will need to alter the secret afterwards.
USE SCHEMA {{env.EVENT_DATABASE}}.CORE;

CREATE SECRET IF NOT EXISTS {{ env.EVENT_DATABASE }}.CORE.ROUTING_TOKEN
  TYPE = GENERIC_STRING
  SECRET_STRING = '<replace with your secret token>'
  COMMENT = 'token for routing hands on lab';

CREATE OR REPLACE NETWORK RULE {{ env.EVENT_DATABASE }}.CORE.open_route_api
    MODE = EGRESS
  TYPE = HOST_PORT
  VALUE_LIST = ('api.openrouteservice.org');

CREATE OR REPLACE EXTERNAL ACCESS INTEGRATION open_route_integration
    ALLOWED_NETWORK_RULES = (open_route_api)
    ALLOWED_AUTHENTICATION_SECRETS = all
    ENABLED = true;


CREATE OR REPLACE FUNCTION {{ env.EVENT_DATABASE }}.CORE.DIRECTIONS (method varchar, jstart array, jend array)
RETURNS VARIANT
language python
runtime_version = 3.10
handler = 'get_directions'
external_access_integrations = (OPEN_ROUTE_INTEGRATION)
PACKAGES = ('snowflake-snowpark-python','requests')
SECRETS = ('cred' = CORE.ROUTING_TOKEN )

AS
$$
import requests
import _snowflake
def get_directions(method,jstart,jend):
    request = f'''https://api.openrouteservice.org/v2/directions/{method}'''
    key = _snowflake.get_generic_secret_string('cred')

    PARAMS = {'api_key':key,
            'start':f'{jstart[0]},{jstart[1]}', 'end':f'{jend[0]},{jend[1]}'}

    r = requests.get(url = request, params = PARAMS)
    response = r.json()
    
    return response
$$;

CREATE OR REPLACE FUNCTION {{ env.EVENT_DATABASE }}.CORE.DIRECTIONS (method varchar, locations variant)
RETURNS VARIANT
language python
runtime_version = 3.9
handler = 'get_directions'
external_access_integrations = (OPEN_ROUTE_INTEGRATION)
PACKAGES = ('snowflake-snowpark-python','requests')
SECRETS = ('cred' = CORE.ROUTING_TOKEN )

AS
$$
import requests
import _snowflake
import json

def get_directions(method,locations):
    request_directions = f'''https://api.openrouteservice.org/v2/directions/{method}/geojson'''
    key = _snowflake.get_generic_secret_string('cred')

    HEADERS = { 'Accept': 'application/json, application/geo+json, application/gpx+xml, img/png; charset=utf-8',
               'Authorization':key,
               'Content-Type': 'application/json; charset=utf-8'}

    body = locations

    r = requests.post(url = request_directions,json = body, headers=HEADERS)
    response = r.json()
    
    return response

    $$;

CREATE OR REPLACE FUNCTION {{ env.EVENT_DATABASE }}.CORE.OPTIMIZATION (jobs array, vehicles array)
RETURNS VARIANT
language python
runtime_version = 3.9
handler = 'get_optimization'
external_access_integrations = (OPEN_ROUTE_INTEGRATION)
PACKAGES = ('snowflake-snowpark-python','requests')
SECRETS = ('cred' = CORE.ROUTING_TOKEN )

AS
$$
import requests
import _snowflake
def get_optimization(jobs,vehicles):
    request_optimization = f'''https://api.openrouteservice.org/optimization'''
    key = _snowflake.get_generic_secret_string('cred')
    HEADERS = { 'Accept': 'application/json, application/geo+json, application/gpx+xml, img/png; charset=utf-8',
               'Authorization':key,
               'Content-Type': 'application/json; charset=utf-8'}

    body = {"jobs":jobs,"vehicles":vehicles}

    r = requests.post(url = request_optimization,json = body, headers=HEADERS)
    response = r.json()
    
    return response
$$;

CREATE OR REPLACE FUNCTION {{ env.EVENT_DATABASE }}.CORE.ISOCHRONES(method string, lon float, lat float, range int)
RETURNS VARIANT
language python
runtime_version = 3.9
handler = 'get_isochrone'
external_access_integrations = (OPEN_ROUTE_INTEGRATION)
PACKAGES = ('snowflake-snowpark-python','requests')
SECRETS = ('cred' = CORE.ROUTING_TOKEN )

AS
$$
import requests
import _snowflake
def get_isochrone(method,lon,lat,range):
    request_isochrone = f'''https://api.openrouteservice.org/v2/isochrones/{method}'''
    key = _snowflake.get_generic_secret_string('cred')
    HEADERS = { 'Accept': 'application/json, application/geo+json, application/gpx+xml, img/png; charset=utf-8',
               'Authorization':key,
               'Content-Type': 'application/json; charset=utf-8'}

    body = {'locations':[[lon,lat]],
                    'range':[range*60],
                    'location_type':'start',
                    'range_type':'time',
                    'smoothing':10}

    r = requests.post(url = request_isochrone,json = body, headers=HEADERS)
    response = r.json()
    
    return response
$$;

create or replace view {{ env.EVENT_DATABASE }}.DATA.DRIVER_LOCATIONS(
	TRIP_ID COMMENT 'Unique identifier for each trip taken by a driver.',
    DRIVER_ID COMMENT 'Unique identifier for the taxi driver.',
	PICKUP_TIME COMMENT 'The timestamp representing the pick-up time for a delivery or service event.',
	DROPOFF_TIME COMMENT 'The time when a vehicle dropoff occurred.',
	PICKUP_LOCATION COMMENT 'The geographic coordinates representing the pickup location for a driver.',
	DROPOFF_LOCATION COMMENT 'The geographic coordinates representing the drop-off location for a vehicle in the routing simulation.',
	ROUTE COMMENT 'A column holding data of type GeographyType representing the route taken by a driver.',
	POINT_GEOM COMMENT 'The column holds data of type GeographyType representing the geographic location of the driver.',
	POINT_TIME COMMENT 'Timestamps representing the corresponding points in time for the driver location data.'
) COMMENT='The table contains records of vehicle pick-up and drop-off locations, along with associated trip information and geometries. Each record represents a single location and includes the trip identifier, pick-up and drop-off times, pick-up and drop-off coordinates, and the corresponding point index and geometry.'
 as 

select * from 

ORGDATACLOUD$INTERNAL$NEWYORK_CITY_TAXIS.FLEET_MANAGEMENT.NY_TAXI_RIDES_ROUTES_RAW;



create or replace view {{ env.EVENT_DATABASE }}.DATA.NY_TAXI_ROUTE_PLANS(
    DRIVER_ID COMMENT 'The Unique ID of the Driver',
	TRIP_ID COMMENT 'Unique identifier for each taxi trip.',
	PICKUP_TIME COMMENT 'The time when the taxi picked up a passenger.',
	PICKUP_LOCATION COMMENT 'The column holds data representing the geographic coordinates of taxi pickup locations.',
	DROPOFF_LOCATION COMMENT 'The geographic coordinates representing the taxi drop-off location.',
	DROPOFF_TIME COMMENT 'The time when the taxi dropped off its passenger.',
	ROUTE COMMENT 'A column holding data of type GeographyType representing the taxi route.'
) as SELECT * FROM
ORGDATACLOUD$INTERNAL$NEWYORK_CITY_TAXIS.FLEET_MANAGEMENT.NY_TAXI_ROUTE_PLANS;



CREATE table if not exists {{ env.EVENT_DATABASE }}.DATA.NEW_YORK_DATA AS

SELECT * FROM ORGDATACLOUD$INTERNAL$NEWYORK_CITY_TAXIS.FLEET_MANAGEMENT.NEW_YORK_DATA;

ALTER TABLE {{ env.EVENT_DATABASE }}.DATA.NEW_YORK_DATA ADD SEARCH OPTIMIZATION ON GEO(GEOMETRY);


CREATE OR REPLACE VIEW {{ env.EVENT_DATABASE }}.DATA.NEW_YORK_ADDRESSES AS
SELECT * FROM ORGDATACLOUD$INTERNAL$NEWYORK_CITY_TAXIS.FLEET_MANAGEMENT.NEW_YORK_ADDRESSES;




CREATE TABLE IF NOT EXISTS {{ env.EVENT_DATABASE }}.DATA.PLACES as 

select 

any_value(GEOMETRY) GEOMETRY,

PHONES:list[0]['element']::text PHONES,
CATEGORIES:primary::text CATEGORY,
NAMES:primary::text NAME,
ADDRESSES:list[0]['element'] ADDRESS,

array_agg(value:element) as ALTERNATE 

from

(SELECT PHONES,CATEGORIES,NAMES,ADDRESSES,GEOMETRY,

categories:alternate:list AS LIST

from {{ env.EVENT_DATABASE }}.DATA.NEW_YORK_DATA), 

--where CATEGORIES:primary is not null),
LATERAL FLATTEN(LIST) GROUP BY ALL;

ALTER TABLE {{ env.EVENT_DATABASE }}.DATA.places ADD SEARCH OPTIMIZATION ON EQUALITY(ALTERNATE);
ALTER TABLE {{ env.EVENT_DATABASE }}.DATA.places ADD SEARCH OPTIMIZATION ON GEO(GEOMETRY);



---- job templates can be modified to tailor the demo.

CREATE OR REPLACE TABLE {{ env.EVENT_DATABASE }}.DATA.JOB_TEMPLATE (

ID INT AUTOINCREMENT PRIMARY KEY,
slot_start INT NOT NULL,
slot_end INT,
skills INT,
product STRING,
status STRING DEFAULT 'active'

);


INSERT INTO {{ env.EVENT_DATABASE }}.DATA.JOB_TEMPLATE (slot_start, slot_end, skills, product, status) VALUES
(9, 10, 1, 'pa', 'active'),
(11, 15, 2, 'pb', 'active'),
(16, 18, 2, 'pb', 'active'),
(11, 13, 3, 'pc', 'active'),
(7, 16, 3, 'pc', 'active'),
(10, 15, 2, 'pa', 'active'),
(10, 15, 2, 'pa', 'active'),
(7, 16, 1, 'pa', 'active'),
(9, 18, 2, 'pb', 'active'),
(13, 18, 2, 'pb', 'active'),
(13, 18, 2, 'pb', 'active'),
(13, 18, 1, 'pa', 'active'),
(13, 18, 1, 'pa', 'active'),
(13, 18, 1, 'pa', 'active'),
(13, 18, 3, 'pc', 'active'),
(11, 15, 2, 'pb', 'active'),
(16, 18, 2, 'pb', 'active'),
(11, 13, 1, 'pa', 'active'),
(7, 16, 1, 'pa', 'active'),
(10, 15, 2, 'pb', 'active'),
(10, 15, 2, 'pb', 'active'),
(7, 16, 1, 'pa', 'active'),
(9, 18, 2, 'pb', 'active'),
(13, 18, 2, 'pb', 'active'),
(13, 18, 2, 'pb', 'active'),
(13, 18, 1, 'pa', 'active'),
(13, 18, 1, 'pa', 'active'),
(13, 18, 1, 'pa', 'active'),
(13, 18, 3, 'pc', 'active');

SELECT DISTINCT CATEGORY FROM (
select DISTINCT VALUE::TEXT CATEGORY FROM {{ env.EVENT_DATABASE }}.DATA.PLACES, LATERAL FLATTEN (ALTERNATE)

UNION 

SELECT DISTINCT CATEGORY FROM {{ env.EVENT_DATABASE }}.DATA.PLACES) WHERE SEARCH((CATEGORY),'food');


CREATE OR REPLACE TABLE {{ env.EVENT_DATABASE }}.DATA.LOOKUP (
    INDUSTRY STRING,
    PA STRING,
    PB STRING,
    PC STRING,
    IND ARRAY,
    IND2 ARRAY,
    CTYPE ARRAY,
    STYPE ARRAY
);

INSERT INTO {{ env.EVENT_DATABASE }}.DATA.LOOKUP (INDUSTRY, PA, PB, PC, IND,IND2, CTYPE, STYPE) 
SELECT
    'healthcare', 
    'flammable', 
    'sharps', 
    'temperature-controlled', 
    ARRAY_CONSTRUCT('hospital health pharmaceutical drug healthcare pharmacy surgical'), 
    ARRAY_CONSTRUCT('supplies warehouse depot distribution wholesaler distributors'), 
    ARRAY_CONSTRUCT('hospital', 'family_practice', 'dentist','pharmacy'), 
    ARRAY_CONSTRUCT('Can handle potentially explosive goods', 'Can handle instruments that could be used as weapons', 'Has a fridge')
UNION ALL
SELECT
    'Food', 
    'Fresh Food Order', 
    'Frozen Food Order', 
    'Non Perishable Food Order', 
    ARRAY_CONSTRUCT('food vegatables meat vegatable'),
    ARRAY_CONSTRUCT('wholesaler warehouse factory processing distribution distributors'), 
    ARRAY_CONSTRUCT('supermarket', 'restaurant', 'butcher_shop'), 
    ARRAY_CONSTRUCT('Can deliver Fresh Food', 'Has a Fridge', 'Premium Delivery')
UNION ALL
SELECT
    'Cosmetics', 
    'Hair Products', 
    'Electronic Goods', 
    'Make-up', 
    ARRAY_CONSTRUCT('hair cosmetics make-up beauty'),
    ARRAY_CONSTRUCT('wholesaler warehouse factory supplies distribution distributors'), 
    ARRAY_CONSTRUCT('supermarket', 'outlet', 'fashion'), 
    ARRAY_CONSTRUCT('Can deliver Fresh Food', 'Has a Fridge', 'Premium Delivery');


-----FLEET_INTELLIGENCE_STANDING_TABLES

-- Clean up old database if it exists
DROP DATABASE IF EXISTS FLEET_MANAGEMENT;

CREATE DATABASE IF NOT EXISTS FLEET_INTELLIGENCE;
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.ANALYTICS;

-- Create view in FLEET_INTELLIGENCE schema for Streamlit app compatibility
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.PUBLIC.NEW_YORK_ADDRESSES AS
SELECT * FROM {{ env.EVENT_DATABASE }}.DATA.NEW_YORK_ADDRESSES;


USE DATABASE FLEET_INTELLIGENCE;
USE SCHEMA ANALYTICS;

CREATE OR REPLACE TABLE DRIVER_LOCATIONS AS

SELECT * FROM

ORGDATACLOUD$INTERNAL$FLEET_MANAGEMENT.ANALYTICS.DRIVER_LOCATIONS;

CREATE TABLE IF NOT EXISTS ROUTE_NAMES AS

SELECT * FROM

ORGDATACLOUD$INTERNAL$FLEET_MANAGEMENT.ANALYTICS.ROUTE_NAMES;

CREATE TABLE IF NOT EXISTS TRIPS AS

SELECT * FROM

ORGDATACLOUD$INTERNAL$FLEET_MANAGEMENT.ANALYTICS.TRIPS;

CREATE TABLE IF NOT EXISTS TRIPS_ASSIGNED_TO_DRIVERS AS

SELECT * FROM

ORGDATACLOUD$INTERNAL$FLEET_MANAGEMENT.ANALYTICS.TRIPS_ASSIGNED_TO_DRIVERS;


CREATE TABLE IF NOT EXISTS TRIP_ROUTE_PLAN AS

SELECT * FROM

ORGDATACLOUD$INTERNAL$FLEET_MANAGEMENT.ANALYTICS.TRIP_ROUTE_PLAN;

CREATE TABLE IF NOT EXISTS TRIP_SUMMARY AS

SELECT * FROM

ORGDATACLOUD$INTERNAL$FLEET_MANAGEMENT.ANALYTICS.TRIP_SUMMARY;


-- Enhanced Fleet Management Views - NYC Beauty Supply Chain
-- Connect to the enhanced fleet intelligence listing data via ORGDATACLOUD$INTERNAL

CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.PUBLIC;
USE SCHEMA FLEET_INTELLIGENCE.PUBLIC;

-- NYC Beauty Supply Chain Depot Locations with Building Footprints
CREATE OR REPLACE VIEW NYC_BEAUTY_DEPOTS AS
SELECT * FROM "ORGDATACLOUD$INTERNAL$ENHANCED_FLEET_MANAGEMENT_-_NYC_BEAUTY_SUPPLY_CHAINV2".PUBLIC.NYC_BEAUTY_DEPOTS;

-- NYC Beauty Supply Chain Vehicle Fleet with Optimization Arrays (optimized view - only optimization columns)
CREATE OR REPLACE VIEW NYC_BEAUTY_FLEET AS  
SELECT 
    VEHICLE_ID,
    DEPOT_ID,
    DEPOT_NAME,
    VEHICLE_TYPE,
    START_LONGITUDE,
    START_LATITUDE,
    END_LONGITUDE,
    END_LATITUDE,
    OPTIMIZATION_SKILLS,
    OPTIMIZATION_CAPACITY,
    OPTIMIZATION_START_COORDS,
    OPTIMIZATION_END_COORDS,
    OPTIMIZATION_TIME_WINDOW,
    CREATED_DATE
FROM "ORGDATACLOUD$INTERNAL$ENHANCED_FLEET_MANAGEMENT_-_NYC_BEAUTY_SUPPLY_CHAINV2".PUBLIC.NYC_BEAUTY_FLEET;

-- NYC Beauty Supply Chain Delivery Jobs for Route Optimization (optimized view - only optimization columns)
CREATE OR REPLACE VIEW NYC_BEAUTY_DELIVERY_JOBS AS
SELECT 
    JOB_ID,
    ORDER_DATE,
    DELIVERY_DATE,
    CUSTOMER_NAME,
    DELIVERY_ADDRESS,
    DELIVERY_LONGITUDE,
    DELIVERY_LATITUDE,
    DELIVERY_GEOMETRY,
    PRODUCT_TYPE,
    OPTIMIZATION_JOB_ID,
    OPTIMIZATION_CAPACITY,
    OPTIMIZATION_SKILLS,
    OPTIMIZATION_TIME_WINDOW,
    OPTIMIZATION_LOCATION,
    CREATED_TIMESTAMP
FROM "ORGDATACLOUD$INTERNAL$ENHANCED_FLEET_MANAGEMENT_-_NYC_BEAUTY_SUPPLY_CHAINV2".PUBLIC.NYC_BEAUTY_DELIVERY_JOBS;

-- Enhanced NEW_YORK_ADDRESSES view (updated from enhanced listing)
CREATE OR REPLACE VIEW NEW_YORK_ADDRESSES AS
SELECT * FROM "ORGDATACLOUD$INTERNAL$ENHANCED_FLEET_MANAGEMENT_-_NYC_BEAUTY_SUPPLY_CHAINV2".PUBLIC.NEW_YORK_ADDRESSES;

-- Enhanced DRIVER_LOCATIONS view (updated from enhanced listing) 
CREATE OR REPLACE VIEW DRIVER_LOCATIONS AS
SELECT * FROM "ORGDATACLOUD$INTERNAL$ENHANCED_FLEET_MANAGEMENT_-_NYC_BEAUTY_SUPPLY_CHAINV2".PUBLIC.DRIVER_LOCATIONS;

-- Grant access to attendee role for new enhanced fleet intelligence data
GRANT IMPORTED PRIVILEGES ON DATABASE "ORGDATACLOUD$INTERNAL$ENHANCED_FLEET_MANAGEMENT_-_NYC_BEAUTY_SUPPLY_CHAINV2" TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};
GRANT USAGE ON SCHEMA FLEET_INTELLIGENCE.PUBLIC TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};
GRANT SELECT ON VIEW FLEET_INTELLIGENCE.PUBLIC.NYC_BEAUTY_DEPOTS TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};
GRANT SELECT ON VIEW FLEET_INTELLIGENCE.PUBLIC.NYC_BEAUTY_FLEET TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};
GRANT SELECT ON VIEW FLEET_INTELLIGENCE.PUBLIC.NYC_BEAUTY_DELIVERY_JOBS TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};
GRANT SELECT ON VIEW FLEET_INTELLIGENCE.PUBLIC.NEW_YORK_ADDRESSES TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};
GRANT SELECT ON VIEW FLEET_INTELLIGENCE.PUBLIC.DRIVER_LOCATIONS TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};



-- Create food delivery views for attendee access
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.PUBLIC.NYC_FOOD_DEPOTS AS
SELECT * FROM "ORGDATACLOUD$INTERNAL$ENHANCED_FLEET_MANAGEMENT_-_NYC_BEAUTY_SUPPLY_CHAINV2".PUBLIC.NYC_FOOD_DEPOTS;

CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.PUBLIC.NYC_FOOD_FLEET AS  
SELECT * FROM "ORGDATACLOUD$INTERNAL$ENHANCED_FLEET_MANAGEMENT_-_NYC_BEAUTY_SUPPLY_CHAINV2".PUBLIC.NYC_FOOD_FLEET;

CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.PUBLIC.NYC_FOOD_DELIVERY_JOBS AS
SELECT * FROM "ORGDATACLOUD$INTERNAL$ENHANCED_FLEET_MANAGEMENT_-_NYC_BEAUTY_SUPPLY_CHAINV2".PUBLIC.NYC_FOOD_DELIVERY_JOBS;

-- Create NYC Retail Stores table for catchment analysis
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.PUBLIC.NYC_RETAIL_STORES (
    STORE_ID NUMBER(38,0),
    RETAILER VARCHAR(50),
    STORE_NAME VARCHAR(200), 
    ADDRESS VARCHAR(300),
    BOROUGH VARCHAR(50),
    NEIGHBORHOOD VARCHAR(100),
    LATITUDE FLOAT,
    LONGITUDE FLOAT,
    LOCATION GEOGRAPHY,
    STORE_TYPE VARCHAR(100),
    DAILY_FOOTFALL NUMBER(38,0)
);

-- Insert realistic NYC retail store data
INSERT INTO FLEET_INTELLIGENCE.PUBLIC.NYC_RETAIL_STORES
SELECT 1, 'Target', 'Target Manhattan East River', '517 E 117th St, New York, NY 10029', 'Manhattan', 'East Harlem', 40.7962, -73.9421, TO_GEOGRAPHY('POINT(-73.9421 40.7962)'), 'Big Box Retail', 2850
UNION ALL SELECT 2, 'Target', 'Target Herald Square', '1200 Broadway, New York, NY 10001', 'Manhattan', 'Midtown', 40.7505, -73.9882, TO_GEOGRAPHY('POINT(-73.9882 40.7505)'), 'Big Box Retail', 3200
UNION ALL SELECT 3, 'Best Buy', 'Best Buy Union Square', '52 E 14th St, New York, NY 10003', 'Manhattan', 'Union Square', 40.7357, -73.9910, TO_GEOGRAPHY('POINT(-73.9910 40.7357)'), 'Electronics', 1850
UNION ALL SELECT 4, 'Best Buy', 'Best Buy Chelsea', '60 W 23rd St, New York, NY 10010', 'Manhattan', 'Chelsea', 40.7431, -73.9925, TO_GEOGRAPHY('POINT(-73.9925 40.7431)'), 'Electronics', 1650
UNION ALL SELECT 5, 'CVS', 'CVS Broadway', '1628 Broadway, New York, NY 10019', 'Manhattan', 'Midtown', 40.7614, -73.9842, TO_GEOGRAPHY('POINT(-73.9842 40.7614)'), 'Pharmacy', 950
UNION ALL SELECT 6, 'CVS', 'CVS East Village', '338 E 14th St, New York, NY 10003', 'Manhattan', 'East Village', 40.7311, -73.9851, TO_GEOGRAPHY('POINT(-73.9851 40.7311)'), 'Pharmacy', 750
UNION ALL SELECT 7, 'Walgreens', 'Walgreens Times Square', '1498 Broadway, New York, NY 10036', 'Manhattan', 'Times Square', 40.7589, -73.9851, TO_GEOGRAPHY('POINT(-73.9851 40.7589)'), 'Pharmacy', 1200
UNION ALL SELECT 8, 'Walgreens', 'Walgreens SoHo', '300 Broadway, New York, NY 10007', 'Manhattan', 'SoHo', 40.7142, -74.0064, TO_GEOGRAPHY('POINT(-74.0064 40.7142)'), 'Pharmacy', 850
UNION ALL SELECT 9, 'Home Depot', 'Home Depot Manhattan', '40 W 23rd St, New York, NY 10010', 'Manhattan', 'Chelsea', 40.7425, -73.9927, TO_GEOGRAPHY('POINT(-73.9927 40.7425)'), 'Home Improvement', 1450
UNION ALL SELECT 10, 'Home Depot', 'Home Depot Brooklyn', '900 3rd Ave, Brooklyn, NY 11232', 'Brooklyn', 'Gowanus', 40.6698, -73.9977, TO_GEOGRAPHY('POINT(-73.9977 40.6698)'), 'Home Improvement', 1650
UNION ALL SELECT 11, 'Staples', 'Staples Midtown East', '1075 Avenue of the Americas, New York, NY 10018', 'Manhattan', 'Midtown East', 40.7505, -73.9820, TO_GEOGRAPHY('POINT(-73.9820 40.7505)'), 'Office Supplies', 650
UNION ALL SELECT 12, 'Staples', 'Staples Financial District', '105 Duane St, New York, NY 10007', 'Manhattan', 'Financial District', 40.7155, -74.0087, TO_GEOGRAPHY('POINT(-74.0087 40.7155)'), 'Office Supplies', 550;

-- Grant permissions for food delivery views
GRANT IMPORTED PRIVILEGES ON DATABASE "ORGDATACLOUD$INTERNAL$ENHANCED_FLEET_MANAGEMENT_-_NYC_BEAUTY_SUPPLY_CHAINV2" TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};
GRANT SELECT ON VIEW FLEET_INTELLIGENCE.PUBLIC.NYC_FOOD_DEPOTS TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};
GRANT SELECT ON VIEW FLEET_INTELLIGENCE.PUBLIC.NYC_FOOD_FLEET TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};
GRANT SELECT ON VIEW FLEET_INTELLIGENCE.PUBLIC.NYC_FOOD_DELIVERY_JOBS TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};

-- Grant permissions for retail stores table and addresses view
GRANT SELECT ON TABLE FLEET_INTELLIGENCE.PUBLIC.NYC_RETAIL_STORES TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};
GRANT SELECT ON VIEW FLEET_INTELLIGENCE.PUBLIC.NEW_YORK_ADDRESSES TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};


-- Create UK_STORMS_DB database first before creating views
create database if not exists UK_STORMS_DB;
create schema if not exists UK_STORMS_DB.PUBLIC;

-- Ordnance Survey Building Sample Data (via ORGDATACLOUD$INTERNAL)
GRANT IMPORTED PRIVILEGES ON DATABASE ORGDATACLOUD$INTERNAL$OS_BUILDING_SAMPLE_DATA TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};

CREATE OR REPLACE VIEW UK_STORMS_DB.PUBLIC.OS_BUILDINGS AS
SELECT *
FROM ORGDATACLOUD$INTERNAL$OS_BUILDING_SAMPLE_DATA.ORDNANCE_SURVEY_SAMPLE_DATA.PRS_BUILDING_TBL_V2;

-- OS Open Built Up Areas (explicit dataset path provided)
GRANT IMPORTED PRIVILEGES ON DATABASE ORGDATACLOUD$INTERNAL$OS_BUILDING_SAMPLE_DATA TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};

CREATE OR REPLACE VIEW UK_STORMS_DB.PUBLIC.OS_BUILT_UP_AREAS AS
SELECT *
FROM "ORGDATACLOUD$INTERNAL$OS_BUILDING_SAMPLE_DATA".ORDNANCE_SURVEY_SAMPLE_DATA.OS_OPEN_BUILT_UP_AREAS;

-- Additional OS sample datasets (streets, addresses, hydro, watercourse)
GRANT IMPORTED PRIVILEGES ON DATABASE ORGDATACLOUD$INTERNAL$OS_BUILDING_SAMPLE_DATA TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};

CREATE OR REPLACE VIEW UK_STORMS_DB.PUBLIC.OS_STREETS AS
SELECT *
FROM "ORGDATACLOUD$INTERNAL$OS_BUILDING_SAMPLE_DATA".ORDNANCE_SURVEY_SAMPLE_DATA.STREETS;

CREATE OR REPLACE VIEW UK_STORMS_DB.PUBLIC.OS_UK_ADDRESSES AS
SELECT *
FROM "ORGDATACLOUD$INTERNAL$OS_BUILDING_SAMPLE_DATA".ORDNANCE_SURVEY_SAMPLE_DATA.UK_ADDRESSES;

CREATE OR REPLACE VIEW UK_STORMS_DB.PUBLIC.OS_UK_HYDRO_NODE AS
SELECT *
FROM "ORGDATACLOUD$INTERNAL$OS_BUILDING_SAMPLE_DATA".ORDNANCE_SURVEY_SAMPLE_DATA.UK_HYDRO_NODE;

CREATE OR REPLACE VIEW UK_STORMS_DB.PUBLIC.OS_UK_WATERCOURSE_LINK AS
SELECT *
FROM "ORGDATACLOUD$INTERNAL$OS_BUILDING_SAMPLE_DATA".ORDNANCE_SURVEY_SAMPLE_DATA.UK_WATERCOURSE_LINK;


----- UK Storms and Flood Risk Areas Loaders -----
use role {{ env.EVENT_ATTENDEE_ROLE }};
use warehouse {{ env.EVENT_WAREHOUSE }};

-- Use existing UK_STORMS_DB database (created earlier in script)
use database UK_STORMS_DB;
use schema PUBLIC;

-- Create UK_STORMS table first
create or replace table UK_STORMS (
  NAME string,
  DATES string,
  DESCRIPTION string,
  UK_FATALITIES string,
  SOURCE string,
  NEWS_SUMMARY string
);

-- Create file format for UK storms CSV data
create or replace file format CSV_UK_STORMS
  type = csv
  field_delimiter = ','
  skip_header = 1
  field_optionally_enclosed_by = '"'
  encoding = 'UTF8'
  null_if = ('\\N','NULL')
  empty_field_as_null = false
  trim_space = false
  error_on_column_count_mismatch = false
  replace_invalid_characters = true
  multi_line = true;

-- Create database for wildfire risk assessment data
create database if not exists WILDFIRES_DB;
use database WILDFIRES_DB;
create schema if not exists PUBLIC;
use schema PUBLIC;

-- Grant access to Location Analytics / Making People Safer marketplace data
GRANT IMPORTED PRIVILEGES ON DATABASE "ORGDATACLOUD$INTERNAL$LOCATION_ANALYTICS_-_MAKING_PEOPLE_SAFER" TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};

-- Create wildfire-related tables/views from the Making People Safer marketplace data
CREATE OR REPLACE VIEW WILDFIRES_DB.PUBLIC.CUSTOMER_LOYALTY_DETAILS AS 
select * from "ORGDATACLOUD$INTERNAL$LOCATION_ANALYTICS_-_MAKING_PEOPLE_SAFER".TELCO_GEOSPATIAL_HANDS_ON_LAB.CUSTOMER_LOYALITY_DETAILS;

CREATE OR REPLACE VIEW WILDFIRES_DB.PUBLIC.CELL_TOWERS_WITH_COMPLETED_RISK_SCORE AS 
select * from "ORGDATACLOUD$INTERNAL$LOCATION_ANALYTICS_-_MAKING_PEOPLE_SAFER".TELCO_GEOSPATIAL_HANDS_ON_LAB.CELL_TOWERS_WITH_RISK_SCORE;

CREATE OR REPLACE VIEW WILDFIRES_DB.PUBLIC.CALIFORNIA_FIRE_PERIMITER AS
select * from "ORGDATACLOUD$INTERNAL$LOCATION_ANALYTICS_-_MAKING_PEOPLE_SAFER".TELCO_GEOSPATIAL_HANDS_ON_LAB.CALIFORNIA_FIRE_PERIMITER;

-- Grant permissions to ATTENDEE_ROLE for WILDFIRES_DB
GRANT USAGE ON DATABASE WILDFIRES_DB TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};
GRANT USAGE ON SCHEMA WILDFIRES_DB.PUBLIC TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};
GRANT CREATE VIEW ON SCHEMA WILDFIRES_DB.PUBLIC TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};
GRANT CREATE TABLE ON SCHEMA WILDFIRES_DB.PUBLIC TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};
GRANT SELECT ON VIEW WILDFIRES_DB.PUBLIC.CUSTOMER_LOYALTY_DETAILS TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};
GRANT SELECT ON VIEW WILDFIRES_DB.PUBLIC.CELL_TOWERS_WITH_COMPLETED_RISK_SCORE TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};
GRANT SELECT ON VIEW WILDFIRES_DB.PUBLIC.CALIFORNIA_FIRE_PERIMITER TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};

-- Grant permissions to ATTENDEE_ROLE for UK_STORMS_DB  
GRANT USAGE ON DATABASE UK_STORMS_DB TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};
GRANT USAGE ON SCHEMA UK_STORMS_DB.PUBLIC TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};
GRANT CREATE VIEW ON SCHEMA UK_STORMS_DB.PUBLIC TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};
GRANT CREATE TABLE ON SCHEMA UK_STORMS_DB.PUBLIC TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};
GRANT SELECT ON VIEW UK_STORMS_DB.PUBLIC.OS_BUILDINGS TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};
GRANT SELECT ON VIEW UK_STORMS_DB.PUBLIC.OS_BUILT_UP_AREAS TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};
GRANT SELECT ON VIEW UK_STORMS_DB.PUBLIC.OS_STREETS TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};
GRANT SELECT ON VIEW UK_STORMS_DB.PUBLIC.OS_UK_ADDRESSES TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};
GRANT SELECT ON VIEW UK_STORMS_DB.PUBLIC.OS_UK_HYDRO_NODE TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};
GRANT SELECT ON VIEW UK_STORMS_DB.PUBLIC.OS_UK_WATERCOURSE_LINK TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};

-- Switch back to UK_STORMS_DB for flood risk data loading
use database UK_STORMS_DB;
use schema PUBLIC;

-- Create file format for GeoJSON flood risk data
create or replace file format GEOJSON_FORMAT
  type = json
  strip_outer_array = false
  compression = auto;

-- Stage for flood risk data
create or replace stage FLOOD_RISK_STAGE;

create or replace transient table FLOOD_RISK_RAW (RAW variant);

create or replace table FLOOD_RISK_AREAS (
  FEATURE variant,
  PROPERTIES variant,
  GEOMETRY variant,
  GEOG geography
);

create or replace table FWS_HISTORIC_WARNINGS (
  AREA_NAME string,
  EVENT_TS timestamp,
  SEVERITY string,
  MESSAGE string,
  CREATED_DATE string,
  MODIFIED_DATE string
);

-- Load UK storms CSV via table stage
put file:///{{ env.CI_PROJECT_DIR}}/uk_storms/uk_storms.csv @%UK_STORMS auto_compress=false;
copy into UK_STORMS
  from @%UK_STORMS
  files = ('uk_storms.csv')
  file_format = (format_name = CSV_UK_STORMS)
  on_error = 'continue'
  force = true;

-- Load FWS Historic Warnings CSV
put file:///{{ env.CI_PROJECT_DIR}}/uk_storms/historic/fws_historic_warnings.csv @%FWS_HISTORIC_WARNINGS auto_compress=false;
copy into FWS_HISTORIC_WARNINGS
  from @%FWS_HISTORIC_WARNINGS
  files = ('fws_historic_warnings.csv')
  file_format = (format_name = CSV_UK_STORMS)
  on_error = 'continue'
  force = true;

-- Load Flood Risk Areas GeoJSON
put file:///{{ env.CI_PROJECT_DIR}}/uk_storms/flood_risk/Flood_Risk_Areas.geojson @FLOOD_RISK_STAGE auto_compress=false;
copy into FLOOD_RISK_RAW
  from @FLOOD_RISK_STAGE
  files = ('Flood_Risk_Areas.geojson')
  file_format = (format_name = GEOJSON_FORMAT)
  on_error = 'abort_statement'
  force = true;

-- Insert one row per feature into final table
insert overwrite into FLOOD_RISK_AREAS (FEATURE, PROPERTIES, GEOMETRY, GEOG)
select
  feature as FEATURE,
  feature:properties as PROPERTIES,
  feature:geometry as GEOMETRY,
  TO_GEOGRAPHY(
    ST_TRANSFORM(
      ST_SETSRID(TO_GEOMETRY(feature:geometry), 27700),
      4326
    )
  ) as GEOG
from FLOOD_RISK_RAW,
  lateral flatten(input => RAW:features) f,
  lateral (select f.value as feature);

-- Flattened view for Streamlit: expose properties as columns
create or replace view FLOOD_RISK_AREAS_VIEW (
  FRA_ID COMMENT 'Unique identifier of the Flood Risk Area.',
  FRA_NAME COMMENT 'Name/label of the Flood Risk Area.',
  FRR_CYCLE COMMENT 'Flood Risk Regulations cycle identifier (assessment/planning period).',
  FLOOD_SOURCE COMMENT 'Primary source of flood risk (e.g., river, sea, surface water).',
  GEOMETRY COMMENT 'Original GeoJSON geometry (VARIANT) of the area.',
  GEOG COMMENT 'GEOGRAPHY conversion of geometry for spatial queries and mapping.'
)
COMMENT = 'Flattened properties and geometry for UK Flood Risk Areas for Streamlit use.'
as
select 
  PROPERTIES:fra_id::string          as FRA_ID,
  PROPERTIES:fra_name::string        as FRA_NAME,
  PROPERTIES:frr_cycle::string       as FRR_CYCLE,
  PROPERTIES:flood_source::string    as FLOOD_SOURCE,
  GEOMETRY                           as GEOMETRY,
  GEOG                                as GEOG
from FLOOD_RISK_AREAS;

-- Heuristic historic warning match: normalize names, token-match, and aggregate
create or replace view FRA_CLEAN as
select
  FRA_ID,
  FRA_NAME,
  regexp_replace(upper(FRA_NAME),'[^A-Z0-9 ]+',' ') as NAME_CLEAN
from FLOOD_RISK_AREAS_VIEW;

create or replace view FWS_CLEAN as
select
  AREA_NAME,
  EVENT_TS,
  regexp_replace(upper(AREA_NAME),'[^A-Z0-9 ]+',' ') as NAME_CLEAN
from FWS_HISTORIC_WARNINGS
where AREA_NAME is not null;

create or replace view FRA_TOK as
select FRA_ID, FRA_NAME, upper(value) as TOKEN
from FRA_CLEAN, lateral split_to_table(NAME_CLEAN,' ') t
where length(value) >= 3;

create or replace view FWS_TOK as
select AREA_NAME, EVENT_TS, upper(value) as TOKEN
from FWS_CLEAN, lateral split_to_table(NAME_CLEAN,' ') t
where length(value) >= 3;

create or replace view FWS_TOKEN_COUNTS_VW as
select AREA_NAME, count(distinct TOKEN) as FWS_TOKEN_COUNT
from FWS_TOK
group by AREA_NAME;

create or replace view FRA_TOKEN_COUNTS_VW as
select FRA_ID, count(distinct TOKEN) as FRA_TOKEN_COUNT
from FRA_TOK
group by FRA_ID;

create or replace view MATCH_SCORES_VW as
select
  w.AREA_NAME,
  f.FRA_ID,
  any_value(f.FRA_NAME) as FRA_NAME,
  count(distinct w.TOKEN) as COMMON_TOKENS,
  ws.FWS_TOKEN_COUNT,
  fs.FRA_TOKEN_COUNT
from (select AREA_NAME, TOKEN from FWS_TOK group by AREA_NAME, TOKEN) w
join (select FRA_ID, FRA_NAME, TOKEN from FRA_TOK group by FRA_ID, FRA_NAME, TOKEN) f
  on w.TOKEN = f.TOKEN
join FWS_TOKEN_COUNTS_VW ws on ws.AREA_NAME = w.AREA_NAME
join FRA_TOKEN_COUNTS_VW fs on fs.FRA_ID = f.FRA_ID
group by w.AREA_NAME, f.FRA_ID, ws.FWS_TOKEN_COUNT, fs.FRA_TOKEN_COUNT;

create or replace view BEST_MATCH as
select
  AREA_NAME,
  FRA_ID,
  FRA_NAME,
  COMMON_TOKENS,
  FWS_TOKEN_COUNT,
  FRA_TOKEN_COUNT,
  COMMON_TOKENS / nullif(least(FWS_TOKEN_COUNT, FRA_TOKEN_COUNT),0) as SCORE,
  row_number() over(partition by AREA_NAME order by COMMON_TOKENS desc, SCORE desc, FRA_TOKEN_COUNT desc) as RN
from MATCH_SCORES_VW
where COMMON_TOKENS >= 1;

create or replace view FRA_FWS_HISTORY_GUESS as
select
  b.FRA_ID,
  b.FRA_NAME,
  count(*) as WARN_COUNT,
  min(w.EVENT_TS) as FIRST_WARN_TS,
  max(w.EVENT_TS) as LAST_WARN_TS,
  sum(case when w.EVENT_TS >= dateadd(year,-5,current_timestamp()) then 1 else 0 end) as WARN_COUNT_5Y
from FWS_CLEAN w
join BEST_MATCH b on w.AREA_NAME = b.AREA_NAME and b.RN = 1
group by b.FRA_ID, b.FRA_NAME;

-- Create final flood warning summary view (alias for FRA_FWS_HISTORY_GUESS)
create or replace view FWS_FINAL as
select * from FRA_FWS_HISTORY_GUESS;

-- Grant permissions to ATTENDEE_ROLE for UK_STORMS_DB tables
GRANT SELECT ON TABLE UK_STORMS_DB.PUBLIC.UK_STORMS TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};
GRANT SELECT ON TABLE UK_STORMS_DB.PUBLIC.FLOOD_RISK_AREAS TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};
GRANT SELECT ON TABLE UK_STORMS_DB.PUBLIC.FWS_HISTORIC_WARNINGS TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};
GRANT SELECT ON VIEW UK_STORMS_DB.PUBLIC.FWS_CLEAN TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};
GRANT SELECT ON VIEW UK_STORMS_DB.PUBLIC.BEST_MATCH TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};
GRANT SELECT ON VIEW UK_STORMS_DB.PUBLIC.FWS_FINAL TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};

----- Risk Intelligence Native App Package Setup -----
-- Note: Risk Intelligence Package creation temporarily disabled to resolve pipeline issues
-- The package can be deployed separately if needed
-- Focusing on core route optimization functionality

-- Create manifest.yml for the native app (TEMPORARILY DISABLED)
-- CREATE OR REPLACE FILE APP_SRC.APP_STAGE/manifest.yml AS
/*
$$
manifest_version: 1

version:
  name: "1.0.0"
  label: "Risk Intelligence v1.0"
  comment: "Comprehensive risk assessment platform for flood and wildfire analysis"

artifacts:
  setup_script: src/setup.sql
  readme: README.md

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
  - name: RISK_ANALYST
    label: "Risk Analyst"
    comment: "Role for users performing risk analysis"
  - name: RISK_ADMIN
    label: "Risk Administrator" 
    comment: "Administrative role for managing risk intelligence app"

references:
  - consumer_database:
      label: "Risk Intelligence Database"
      description: "Main database for risk assessment data and analytics"
      privileges:
        - CREATE SCHEMA
        - CREATE TABLE
        - CREATE VIEW
        - CREATE STREAMLIT
        - USAGE
$$;
*/

-- Create setup.sql for the native app (TEMPORARILY DISABLED)
-- CREATE OR REPLACE FILE APP_SRC.APP_STAGE/src/setup.sql AS
/*
$$
-- Risk Intelligence Native App Setup Script
CREATE APPLICATION ROLE IF NOT EXISTS RISK_ANALYST;
CREATE APPLICATION ROLE IF NOT EXISTS RISK_ADMIN;

-- Create application warehouse
CREATE WAREHOUSE IF NOT EXISTS RISK_INTELLIGENCE_WH
    WAREHOUSE_SIZE = 'SMALL'
    AUTO_SUSPEND = 300
    AUTO_RESUME = TRUE
    INITIALLY_SUSPENDED = TRUE
    COMMENT = 'Warehouse for Risk Intelligence Native App';

-- Create schemas
CREATE SCHEMA IF NOT EXISTS FLOOD_RISK;
CREATE SCHEMA IF NOT EXISTS WILDFIRE_RISK;
CREATE SCHEMA IF NOT EXISTS SHARED_RESOURCES;

-- Grant warehouse usage
GRANT USAGE ON WAREHOUSE RISK_INTELLIGENCE_WH TO APPLICATION ROLE RISK_ANALYST;
GRANT ALL ON WAREHOUSE RISK_INTELLIGENCE_WH TO APPLICATION ROLE RISK_ADMIN;

-- Grant schema permissions
GRANT USAGE ON SCHEMA FLOOD_RISK TO APPLICATION ROLE RISK_ANALYST;
GRANT USAGE ON SCHEMA WILDFIRE_RISK TO APPLICATION ROLE RISK_ANALYST;
GRANT USAGE ON SCHEMA SHARED_RESOURCES TO APPLICATION ROLE RISK_ANALYST;

GRANT ALL ON SCHEMA FLOOD_RISK TO APPLICATION ROLE RISK_ADMIN;
GRANT ALL ON SCHEMA WILDFIRE_RISK TO APPLICATION ROLE RISK_ADMIN;
GRANT ALL ON SCHEMA SHARED_RESOURCES TO APPLICATION ROLE RISK_ADMIN;

-- Create shared resources
CREATE STAGE IF NOT EXISTS SHARED_RESOURCES.APP_DATA;
CREATE FILE FORMAT IF NOT EXISTS SHARED_RESOURCES.CSV_FORMAT
    TYPE = CSV FIELD_DELIMITER = ',' SKIP_HEADER = 1 
    FIELD_OPTIONALLY_ENCLOSED_BY = '"' NULL_IF = ('NULL', '\\N', '') EMPTY_FIELD_AS_NULL = TRUE;
CREATE FILE FORMAT IF NOT EXISTS SHARED_RESOURCES.JSON_FORMAT
    TYPE = JSON STRIP_OUTER_ARRAY = FALSE COMPRESSION = AUTO;

-- Create flood risk tables with data from existing UK_STORMS_DB
CREATE TABLE IF NOT EXISTS FLOOD_RISK.UK_STORMS AS 
SELECT * FROM UK_STORMS_DB.PUBLIC.UK_STORMS;

CREATE TABLE IF NOT EXISTS FLOOD_RISK.FLOOD_AREAS AS
SELECT 
    PROPERTIES:fra_id::STRING AS AREA_ID,
    PROPERTIES:fra_name::STRING AS AREA_NAME,
    PROPERTIES:flood_source::STRING AS FLOOD_SOURCE,
    CASE 
        WHEN PROPERTIES:flood_source::STRING = 'river' THEN 'High'
        WHEN PROPERTIES:flood_source::STRING = 'sea' THEN 'Medium' 
        ELSE 'Low' 
    END AS RISK_LEVEL,
    GEOG AS GEOMETRY,
    PROPERTIES
FROM UK_STORMS_DB.PUBLIC.FLOOD_RISK_AREAS;

CREATE TABLE IF NOT EXISTS FLOOD_RISK.HISTORIC_WARNINGS AS
SELECT * FROM UK_STORMS_DB.PUBLIC.FWS_HISTORIC_WARNINGS;

-- Create wildfire risk tables with data from existing WILDFIRES_DB
CREATE TABLE IF NOT EXISTS WILDFIRE_RISK.CUSTOMER_DETAILS AS
SELECT * FROM WILDFIRES_DB.PUBLIC.CUSTOMER_LOYALTY_DETAILS;

CREATE TABLE IF NOT EXISTS WILDFIRE_RISK.INFRASTRUCTURE_RISK AS
SELECT * FROM WILDFIRES_DB.PUBLIC.CELL_TOWERS_WITH_COMPLETED_RISK_SCORE;

CREATE TABLE IF NOT EXISTS WILDFIRE_RISK.FIRE_PERIMETERS AS
SELECT * FROM WILDFIRES_DB.PUBLIC.CALIFORNIA_FIRE_PERIMITER;

-- Create Streamlit applications
CREATE STREAMLIT IF NOT EXISTS FLOOD_RISK."UK Flood Risk Assessment"
    FROM '@SHARED_RESOURCES.APP_DATA'
    MAIN_FILE = 'flood_risk_areas.py'
    QUERY_WAREHOUSE = 'RISK_INTELLIGENCE_WH'
    COMMENT = 'UK Flood Risk Assessment - Risk Intelligence Native App';

CREATE STREAMLIT IF NOT EXISTS WILDFIRE_RISK."California Wildfire Risk Assessment"
    FROM '@SHARED_RESOURCES.APP_DATA'
    MAIN_FILE = 'wildfire_assessment.py'
    QUERY_WAREHOUSE = 'RISK_INTELLIGENCE_WH'
    COMMENT = 'California Wildfire Risk Assessment - Risk Intelligence Native App';

-- Grant table permissions
GRANT SELECT ON ALL TABLES IN SCHEMA FLOOD_RISK TO APPLICATION ROLE RISK_ANALYST;
GRANT SELECT ON ALL TABLES IN SCHEMA WILDFIRE_RISK TO APPLICATION ROLE RISK_ANALYST;
GRANT ALL ON ALL TABLES IN SCHEMA FLOOD_RISK TO APPLICATION ROLE RISK_ADMIN;
GRANT ALL ON ALL TABLES IN SCHEMA WILDFIRE_RISK TO APPLICATION ROLE RISK_ADMIN;

-- Grant Streamlit permissions
GRANT USAGE ON STREAMLIT FLOOD_RISK."UK Flood Risk Assessment" TO APPLICATION ROLE RISK_ANALYST;
GRANT USAGE ON STREAMLIT WILDFIRE_RISK."California Wildfire Risk Assessment" TO APPLICATION ROLE RISK_ANALYST;

-- Create application info view
CREATE VIEW IF NOT EXISTS SHARED_RESOURCES.APPLICATION_INFO AS
SELECT 
    'Risk Intelligence' AS APP_NAME,
    '1.0.0' AS VERSION,
    'Comprehensive risk assessment platform for flood and wildfire analysis' AS DESCRIPTION,
    CURRENT_TIMESTAMP() AS INSTALLED_AT,
    CURRENT_USER() AS INSTALLED_BY;
$$;
*/

-- Create README.md for the native app (TEMPORARILY DISABLED)
-- CREATE OR REPLACE FILE APP_SRC.APP_STAGE/README.md AS
/*
$$
# Risk Intelligence Native App

## Overview
Comprehensive risk assessment platform combining flood and wildfire risk analysis capabilities.

## Features
- **UK Flood Risk Assessment**: Interactive flood risk analysis and monitoring
- **California Wildfire Risk Assessment**: Wildfire risk evaluation and infrastructure analysis
- **Integrated Data Sources**: Combines multiple risk data sources for comprehensive analysis
- **Interactive Dashboards**: User-friendly Streamlit interfaces for risk visualization

## Installation
```sql
CREATE APPLICATION RISK_INTELLIGENCE 
FROM APPLICATION PACKAGE RISK_INTELLIGENCE_PACKAGE;

GRANT APPLICATION ROLE RISK_INTELLIGENCE.RISK_ANALYST TO ROLE <your_role>;
```

## Access Applications
- UK Flood Risk: RISK_INTELLIGENCE.FLOOD_RISK."UK Flood Risk Assessment"
- California Wildfire Risk: RISK_INTELLIGENCE.WILDFIRE_RISK."California Wildfire Risk Assessment"

## Support
This application integrates with existing organizational risk data and provides comprehensive analysis capabilities for informed decision-making.
$$;
*/

-- Upload Streamlit application files to the stage
-- Note: These PUT commands reference the existing streamlit files from the deployment
-- PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/streamlit/flood_risk_areas.py @APP_SRC.APP_STAGE/streamlit/ auto_compress = false overwrite = true;
-- PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/streamlit/streamlit_making_people_safer/app.py @APP_SRC.APP_STAGE/streamlit/wildfire_assessment.py auto_compress = false overwrite = true;
-- PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/streamlit/environment.yml @APP_SRC.APP_STAGE/streamlit/ auto_compress = false overwrite = true;
-- PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/homepage/docs/stylesheets/extra.css @APP_SRC.APP_STAGE/streamlit/ auto_compress = false overwrite = true;
-- PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/streamlit/logo.svg @APP_SRC.APP_STAGE/streamlit/ auto_compress = false overwrite = true;

-- Create application package version (TEMPORARILY DISABLED)
-- ALTER APPLICATION PACKAGE RISK_INTELLIGENCE_PACKAGE 
--     ADD VERSION v1_0 USING '@APP_SRC.APP_STAGE'
--     COMMENT = 'Risk Intelligence v1.0 - Flood and Wildfire Risk Assessment';

-- Return to account context
USE ROLE ACCOUNTADMIN;
USE WAREHOUSE {{ env.EVENT_WAREHOUSE }};

-- Set default version (TEMPORARILY DISABLED)
-- ALTER APPLICATION PACKAGE RISK_INTELLIGENCE_PACKAGE 
--     SET DEFAULT RELEASE DIRECTIVE VERSION = v1_0 PATCH = 0;

-- Grant usage on application package to attendee role (TEMPORARILY DISABLED)
-- GRANT USAGE ON APPLICATION PACKAGE RISK_INTELLIGENCE_PACKAGE TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};

-- Create a sample application instance for demonstration (TEMPORARILY DISABLED)
-- CREATE APPLICATION IF NOT EXISTS RISK_INTELLIGENCE_DEMO
--     FROM APPLICATION PACKAGE RISK_INTELLIGENCE_PACKAGE
--     COMMENT = 'Demo instance of Risk Intelligence Native App';

-- Grant application roles to attendee (TEMPORARILY DISABLED)
-- GRANT APPLICATION ROLE RISK_INTELLIGENCE_DEMO.RISK_ANALYST TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};
-- GRANT APPLICATION ROLE RISK_INTELLIGENCE_DEMO.RISK_ADMIN TO ROLE {{ env.EVENT_ATTENDEE_ROLE }};

SELECT 'Risk Intelligence Native App Package deployment temporarily disabled' AS STATUS,
       'Focusing on core route optimization features' AS MESSAGE,
       'Risk Intelligence can be deployed separately if needed' AS NOTE;
