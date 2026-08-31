--------------------------------------------------------------------------------
-- load-seed-data.sql
-- Pre-loads Intro page routes, synthetic SF ebike data, and metadata
-- so the ORS Control App is fully populated on first launch.
--
-- Prerequisites:
--   - OPENROUTESERVICE_APP database exists
--   - SYNTHETIC_DATASETS.UNIFIED schema exists (created in Step 6)
--   - FLEET_INTELLIGENCE.CORE schema exists (created in Step 6)
--   - Parquet files uploaded to @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE
--
-- Usage:
--   snow stage copy datasets/ @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/ --overwrite
--   snow sql -f datasets/load-seed-data.sql
--------------------------------------------------------------------------------

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

USE WAREHOUSE ROUTING_ANALYTICS;

-- Data Studio preset exported via datasets/export-preset.sql. SEED_JOB_ID is
-- derived AFTER the parquet is loaded (from the JOB_ID carried in the data
-- itself), so this loader is correct for ANY exported dataset with no literal
-- to edit. The initial value is a placeholder only; it is reassigned below.
SET SEED_JOB_ID = '';

--------------------------------------------------------------------------------
-- Stage & File Format
--------------------------------------------------------------------------------
CREATE STAGE IF NOT EXISTS OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE FILE FORMAT IF NOT EXISTS OPENROUTESERVICE_APP.CORE.PARQUET_FF
  TYPE = PARQUET
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

--------------------------------------------------------------------------------
-- 1. INTRO_TRIPS (Intro page)
--------------------------------------------------------------------------------
CREATE OR REPLACE TABLE OPENROUTESERVICE_APP.CORE.INTRO_TRIPS (
  TRIP_ID NUMBER(18,0),
  O_LNG FLOAT,
  O_LAT FLOAT,
  D_LNG FLOAT,
  D_LAT FLOAT,
  ORIGIN GEOGRAPHY,
  DESTINATION GEOGRAPHY,
  DISTANCE_M FLOAT,
  DURATION_S FLOAT,
  ROUTE_GEOJSON OBJECT,
  ROUTE_GEOG GEOGRAPHY
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

COPY INTO OPENROUTESERVICE_APP.CORE.INTRO_TRIPS
FROM (
  SELECT
    $1:TRIP_ID::NUMBER(18,0),
    $1:O_LNG::FLOAT,
    $1:O_LAT::FLOAT,
    $1:D_LNG::FLOAT,
    $1:D_LAT::FLOAT,
    TRY_TO_GEOGRAPHY($1:ORIGIN_WKT::VARCHAR),
    TRY_TO_GEOGRAPHY($1:DESTINATION_WKT::VARCHAR),
    $1:DISTANCE_M::FLOAT,
    $1:DURATION_S::FLOAT,
    TRY_PARSE_JSON($1:ROUTE_GEOJSON::VARCHAR)::OBJECT,
    TRY_TO_GEOGRAPHY($1:ROUTE_GEOG_WKT::VARCHAR)
  FROM @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/intro/
)
FILE_FORMAT = (TYPE = PARQUET)
PURGE = FALSE
FORCE = TRUE;

--------------------------------------------------------------------------------
-- 2. SYNTHETIC_DATASETS.UNIFIED tables (ebike data)
--------------------------------------------------------------------------------

-- 2a. FACT_VEHICLE_TELEMETRY
CREATE TABLE IF NOT EXISTS SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY (
  TELEMETRY_ID VARCHAR,
  REGION VARCHAR(100),
  VEHICLE_TYPE VARCHAR(20),
  VEHICLE_ID VARCHAR,
  TRIP_ID VARCHAR,
  TS TIMESTAMP_NTZ,
  LATITUDE FLOAT,
  LONGITUDE FLOAT,
  POINT_GEOM GEOGRAPHY,
  SPEED_KMH FLOAT,
  HEADING_DEG FLOAT,
  POSTED_SPEED_KMH FLOAT,
  STATUS VARCHAR(30),
  IS_SPEEDING BOOLEAN,
  IS_HOS_VIOLATION BOOLEAN,
  IS_DETOUR BOOLEAN,
  GPS_ACCURACY_M FLOAT,
  LOCATION_ID VARCHAR,
  LOCATION_TYPE VARCHAR(30),
  ORS_PROFILE VARCHAR(30),
  BATTERY_PCT FLOAT,
  ODOMETER_KM FLOAT,
  POINT_INDEX INT,
  JOB_ID VARCHAR
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

TRUNCATE TABLE IF EXISTS SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY;

COPY INTO SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY
FROM (
  SELECT
    $1:TELEMETRY_ID::VARCHAR,
    $1:REGION::VARCHAR,
    $1:VEHICLE_TYPE::VARCHAR,
    $1:VEHICLE_ID::VARCHAR,
    $1:TRIP_ID::VARCHAR,
    $1:TS::TIMESTAMP_NTZ,
    $1:LATITUDE::FLOAT,
    $1:LONGITUDE::FLOAT,
    TRY_TO_GEOGRAPHY($1:POINT_GEOM_WKT::VARCHAR),
    $1:SPEED_KMH::FLOAT,
    $1:HEADING_DEG::FLOAT,
    $1:POSTED_SPEED_KMH::FLOAT,
    $1:STATUS::VARCHAR,
    $1:IS_SPEEDING::BOOLEAN,
    $1:IS_HOS_VIOLATION::BOOLEAN,
    $1:IS_DETOUR::BOOLEAN,
    $1:GPS_ACCURACY_M::FLOAT,
    $1:LOCATION_ID::VARCHAR,
    $1:LOCATION_TYPE::VARCHAR,
    $1:ORS_PROFILE::VARCHAR,
    $1:BATTERY_PCT::FLOAT,
    $1:ODOMETER_KM::FLOAT,
    $1:POINT_INDEX::INT,
    $1:JOB_ID::VARCHAR
  FROM @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/synthetic_ebikes/fact_vehicle_telemetry/
)
FILE_FORMAT = (TYPE = PARQUET)
PURGE = FALSE
FORCE = TRUE;

-- 2b. FACT_TRIPS (GEOGRAPHY exported as WKT)
CREATE TABLE IF NOT EXISTS SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS (
  TRIP_ID VARCHAR,
  VEHICLE_ID VARCHAR,
  DRIVER_ID VARCHAR,
  VEHICLE_TYPE VARCHAR(20),
  REGION VARCHAR(100),
  ORIGIN_POI_ID VARCHAR,
  DESTINATION_POI_ID VARCHAR,
  ORIGIN_LAT FLOAT,
  ORIGIN_LON FLOAT,
  ORIGIN GEOGRAPHY,
  DESTINATION_LAT FLOAT,
  DESTINATION_LON FLOAT,
  DESTINATION GEOGRAPHY,
  ROUTE_GEOG GEOGRAPHY,
  DISTANCE_KM FLOAT,
  DURATION_MINUTES FLOAT,
  PLANNED_ROUTE_GEOG GEOGRAPHY,
  PLANNED_DISTANCE_KM FLOAT,
  IS_DETOUR BOOLEAN,
  DETOUR_DISTANCE_KM FLOAT,
  TRIP_START TIMESTAMP_NTZ,
  TRIP_END TIMESTAMP_NTZ,
  STATUS VARCHAR(20),
  ORS_PROFILE VARCHAR(30),
  JOB_ID VARCHAR
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

TRUNCATE TABLE IF EXISTS SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS;

COPY INTO SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS
FROM (
  SELECT
    $1:TRIP_ID::VARCHAR,
    $1:VEHICLE_ID::VARCHAR,
    $1:DRIVER_ID::VARCHAR,
    $1:VEHICLE_TYPE::VARCHAR,
    $1:REGION::VARCHAR,
    $1:ORIGIN_POI_ID::VARCHAR,
    $1:DESTINATION_POI_ID::VARCHAR,
    $1:ORIGIN_LAT::FLOAT,
    $1:ORIGIN_LON::FLOAT,
    TRY_TO_GEOGRAPHY($1:ORIGIN_WKT::VARCHAR),
    $1:DESTINATION_LAT::FLOAT,
    $1:DESTINATION_LON::FLOAT,
    TRY_TO_GEOGRAPHY($1:DESTINATION_WKT::VARCHAR),
    TRY_TO_GEOGRAPHY($1:ROUTE_GEOG_WKT::VARCHAR),
    $1:DISTANCE_KM::FLOAT,
    $1:DURATION_MINUTES::FLOAT,
    TRY_TO_GEOGRAPHY($1:PLANNED_ROUTE_GEOG_WKT::VARCHAR),
    $1:PLANNED_DISTANCE_KM::FLOAT,
    $1:IS_DETOUR::BOOLEAN,
    $1:DETOUR_DISTANCE_KM::FLOAT,
    $1:TRIP_START::TIMESTAMP_NTZ,
    $1:TRIP_END::TIMESTAMP_NTZ,
    $1:STATUS::VARCHAR,
    $1:ORS_PROFILE::VARCHAR,
    $1:JOB_ID::VARCHAR
  FROM @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/synthetic_ebikes/fact_trips/
)
FILE_FORMAT = (TYPE = PARQUET)
PURGE = FALSE
FORCE = TRUE;

-- 2c. DIM_FLEET
CREATE TABLE IF NOT EXISTS SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET (
  VEHICLE_ID VARCHAR,
  REGION VARCHAR(100),
  VEHICLE_TYPE VARCHAR(20),
  ORS_PROFILE VARCHAR(30),
  SHIFT_TYPE VARCHAR(30),
  SHIFT_START_HOUR INT,
  SHIFT_END_HOUR INT,
  HOME_LOCATION_ID VARCHAR,
  DRIVER_PROFILE VARCHAR(20),
  OPERATING_MODE VARCHAR(30),
  BASE_SPEED_KMH FLOAT,
  BATTERY_RANGE_KM FLOAT,
  JOB_ID VARCHAR
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

TRUNCATE TABLE IF EXISTS SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET;

COPY INTO SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET
FROM @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/synthetic_ebikes/dim_fleet/
FILE_FORMAT = (TYPE = PARQUET)
MATCH_BY_COLUMN_NAME = CASE_INSENSITIVE
PURGE = FALSE
FORCE = TRUE;

-- 2d. DIM_POIS (GEOGRAPHY exported as WKT)
CREATE TABLE IF NOT EXISTS SYNTHETIC_DATASETS.UNIFIED.DIM_POIS (
  LOCATION_ID VARCHAR,
  REGION VARCHAR(100),
  NAME VARCHAR,
  LOCATION_TYPE VARCHAR(30),
  CATEGORY VARCHAR(50),
  LAT FLOAT,
  LNG FLOAT,
  POINT_GEOM GEOGRAPHY,
  SOURCE VARCHAR(20),
  JOB_ID VARCHAR
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

TRUNCATE TABLE IF EXISTS SYNTHETIC_DATASETS.UNIFIED.DIM_POIS;

COPY INTO SYNTHETIC_DATASETS.UNIFIED.DIM_POIS
FROM (
  SELECT
    $1:LOCATION_ID::VARCHAR,
    $1:REGION::VARCHAR,
    $1:NAME::VARCHAR,
    $1:LOCATION_TYPE::VARCHAR,
    $1:CATEGORY::VARCHAR,
    $1:LAT::FLOAT,
    $1:LNG::FLOAT,
    TRY_TO_GEOGRAPHY($1:POINT_GEOM_WKT::VARCHAR),
    $1:SOURCE::VARCHAR,
    $1:JOB_ID::VARCHAR
  FROM @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/synthetic_ebikes/dim_pois/
)
FILE_FORMAT = (TYPE = PARQUET)
PURGE = FALSE
FORCE = TRUE;

-- 2e. FACT_OFFERS (Studio-generated, vehicle-agnostic offers)
CREATE TABLE IF NOT EXISTS SYNTHETIC_DATASETS.UNIFIED.FACT_OFFERS (
  OFFER_ID         VARCHAR,
  REGION           VARCHAR(100),
  VEHICLE_TYPE     VARCHAR(20),
  SOURCE           VARCHAR(30),
  PICKUP_POI_ID    VARCHAR,
  PICKUP_LAT       FLOAT,
  PICKUP_LON       FLOAT,
  PICKUP_GEOM      GEOGRAPHY,
  DROPOFF_POI_ID   VARCHAR,
  DROPOFF_LAT      FLOAT,
  DROPOFF_LON      FLOAT,
  DROPOFF_GEOM     GEOGRAPHY,
  PICKUP_FROM_TS   TIMESTAMP_NTZ,
  PICKUP_TO_TS     TIMESTAMP_NTZ,
  WEIGHT_KG        NUMBER,
  PRODUCT          VARCHAR,
  PRICE_USD        NUMBER,
  HAZMAT           BOOLEAN,
  LISTING_TEXT     VARCHAR,
  POSTED_AT        TIMESTAMP_NTZ,
  JOB_ID           VARCHAR,
  VEHICLE_EQUIPMENT VARCHAR(30),
  DISTANCE_KM      FLOAT,
  PRICE_PER_KM_USD FLOAT,
  PARTNER_ID       VARCHAR,
  STATUS           VARCHAR(20)
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.FACT_OFFERS ADD COLUMN IF NOT EXISTS VEHICLE_EQUIPMENT VARCHAR(30);
ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.FACT_OFFERS ADD COLUMN IF NOT EXISTS DISTANCE_KM FLOAT;
ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.FACT_OFFERS ADD COLUMN IF NOT EXISTS PRICE_PER_KM_USD FLOAT;
ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.FACT_OFFERS ADD COLUMN IF NOT EXISTS PARTNER_ID VARCHAR;
ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.FACT_OFFERS ADD COLUMN IF NOT EXISTS STATUS VARCHAR(20);

TRUNCATE TABLE IF EXISTS SYNTHETIC_DATASETS.UNIFIED.FACT_OFFERS;

COPY INTO SYNTHETIC_DATASETS.UNIFIED.FACT_OFFERS
FROM (
  SELECT
    $1:OFFER_ID::VARCHAR,
    $1:REGION::VARCHAR,
    $1:VEHICLE_TYPE::VARCHAR,
    $1:SOURCE::VARCHAR,
    $1:PICKUP_POI_ID::VARCHAR,
    $1:PICKUP_LAT::FLOAT,
    $1:PICKUP_LON::FLOAT,
    TRY_TO_GEOGRAPHY($1:PICKUP_GEOM_WKT::VARCHAR),
    $1:DROPOFF_POI_ID::VARCHAR,
    $1:DROPOFF_LAT::FLOAT,
    $1:DROPOFF_LON::FLOAT,
    TRY_TO_GEOGRAPHY($1:DROPOFF_GEOM_WKT::VARCHAR),
    $1:PICKUP_FROM_TS::TIMESTAMP_NTZ,
    $1:PICKUP_TO_TS::TIMESTAMP_NTZ,
    $1:WEIGHT_KG::NUMBER,
    $1:PRODUCT::VARCHAR,
    $1:PRICE_USD::NUMBER,
    $1:HAZMAT::BOOLEAN,
    $1:LISTING_TEXT::VARCHAR,
    $1:POSTED_AT::TIMESTAMP_NTZ,
    $1:JOB_ID::VARCHAR,
    $1:VEHICLE_EQUIPMENT::VARCHAR,
    $1:DISTANCE_KM::FLOAT,
    $1:PRICE_PER_KM_USD::FLOAT,
    $1:PARTNER_ID::VARCHAR,
    $1:STATUS::VARCHAR
  FROM @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/synthetic_ebikes/fact_offers/
)
FILE_FORMAT = (TYPE = PARQUET)
PURGE = FALSE
FORCE = TRUE;

-- 2f. DIM_PARTNERS
CREATE TABLE IF NOT EXISTS SYNTHETIC_DATASETS.UNIFIED.DIM_PARTNERS (
  PARTNER_ID VARCHAR,
  REGION VARCHAR(100),
  VEHICLE_TYPE VARCHAR(20),
  NAME VARCHAR,
  COUNTRY VARCHAR(4),
  CREDIT_SCORE NUMBER,
  PAYMENT_DAYS_AVG NUMBER,
  KYC_STATUS VARCHAR(20),
  BLACKLIST_FLAG BOOLEAN,
  FOUNDED_YEAR NUMBER,
  JOB_ID VARCHAR
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

TRUNCATE TABLE IF EXISTS SYNTHETIC_DATASETS.UNIFIED.DIM_PARTNERS;

COPY INTO SYNTHETIC_DATASETS.UNIFIED.DIM_PARTNERS
FROM @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/synthetic_ebikes/dim_partners/
FILE_FORMAT = (TYPE = PARQUET)
MATCH_BY_COLUMN_NAME = CASE_INSENSITIVE
PURGE = FALSE
FORCE = TRUE;

-- 2g. FACT_PARTNER_HISTORY
CREATE TABLE IF NOT EXISTS SYNTHETIC_DATASETS.UNIFIED.FACT_PARTNER_HISTORY (
  PARTNER_ID VARCHAR,
  REGION VARCHAR(100),
  VEHICLE_TYPE VARCHAR(20),
  ORIGIN_COUNTRY VARCHAR(4),
  DEST_COUNTRY VARCHAR(4),
  VEHICLE_EQUIPMENT VARCHAR(30),
  SHIPPED_AT TIMESTAMP_NTZ,
  COST_PER_KM FLOAT,
  OUTCOME VARCHAR(20),
  JOB_ID VARCHAR
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

TRUNCATE TABLE IF EXISTS SYNTHETIC_DATASETS.UNIFIED.FACT_PARTNER_HISTORY;

COPY INTO SYNTHETIC_DATASETS.UNIFIED.FACT_PARTNER_HISTORY
FROM @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/synthetic_ebikes/fact_partner_history/
FILE_FORMAT = (TYPE = PARQUET)
MATCH_BY_COLUMN_NAME = CASE_INSENSITIVE
PURGE = FALSE
FORCE = TRUE;

-- 2h. DIM_TRIP_SCHEDULE
CREATE TABLE IF NOT EXISTS SYNTHETIC_DATASETS.UNIFIED.DIM_TRIP_SCHEDULE (
  SCHEDULE_ID VARCHAR,
  VEHICLE_ID VARCHAR,
  DRIVER_ID VARCHAR,
  VEHICLE_TYPE VARCHAR(20),
  REGION VARCHAR(100),
  TRIP_DATE DATE,
  TRIP_SEQ INT,
  ORIGIN_POI_ID VARCHAR,
  DESTINATION_POI_ID VARCHAR,
  PLANNED_START TIMESTAMP_NTZ,
  PLANNED_END TIMESTAMP_NTZ,
  SHIFT_TYPE VARCHAR(30),
  ORS_PROFILE VARCHAR(30),
  DISTANCE_KM FLOAT,
  DURATION_MINUTES FLOAT,
  STATUS VARCHAR(20),
  JOB_ID VARCHAR
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

TRUNCATE TABLE IF EXISTS SYNTHETIC_DATASETS.UNIFIED.DIM_TRIP_SCHEDULE;

COPY INTO SYNTHETIC_DATASETS.UNIFIED.DIM_TRIP_SCHEDULE
FROM @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/synthetic_ebikes/dim_trip_schedule/
FILE_FORMAT = (TYPE = PARQUET)
MATCH_BY_COLUMN_NAME = CASE_INSENSITIVE
PURGE = FALSE
FORCE = TRUE;

-- 2h-1. DIM_ANCHORS (universal-generation; GEOGRAPHY exported as WKT)
CREATE TABLE IF NOT EXISTS SYNTHETIC_DATASETS.UNIFIED.DIM_ANCHORS (
  ANCHOR_ID VARCHAR, REGION VARCHAR(100), ANCHOR_TYPE VARCHAR(40),
  NAME VARCHAR, CATEGORY VARCHAR(60),
  LAT FLOAT, LNG FLOAT, GEOM GEOGRAPHY,
  ADDRESS VARCHAR, CITY VARCHAR, STATE VARCHAR, POSTCODE VARCHAR,
  SOURCE VARCHAR(40), JOB_ID VARCHAR
) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
TRUNCATE TABLE IF EXISTS SYNTHETIC_DATASETS.UNIFIED.DIM_ANCHORS;
COPY INTO SYNTHETIC_DATASETS.UNIFIED.DIM_ANCHORS
FROM (
  SELECT
    $1:ANCHOR_ID::VARCHAR, $1:REGION::VARCHAR, $1:ANCHOR_TYPE::VARCHAR,
    $1:NAME::VARCHAR, $1:CATEGORY::VARCHAR, $1:LAT::FLOAT, $1:LNG::FLOAT,
    TRY_TO_GEOGRAPHY($1:GEOM_WKT::VARCHAR),
    $1:ADDRESS::VARCHAR, $1:CITY::VARCHAR, $1:STATE::VARCHAR, $1:POSTCODE::VARCHAR,
    $1:SOURCE::VARCHAR, $1:JOB_ID::VARCHAR
  FROM @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/synthetic_ebikes/dim_anchors/
)
FILE_FORMAT = (TYPE = PARQUET)
PURGE = FALSE
FORCE = TRUE;

-- 2h-1b. DIM_PARTICIPANTS (universal-generation; GEOGRAPHY exported as WKT)
CREATE TABLE IF NOT EXISTS SYNTHETIC_DATASETS.UNIFIED.DIM_PARTICIPANTS (
  PARTICIPANT_ID VARCHAR, REGION VARCHAR(100),
  LAT FLOAT, LNG FLOAT, GEOM GEOGRAPHY,
  ADDRESS VARCHAR, CITY VARCHAR, STATE VARCHAR, POSTCODE VARCHAR,
  NEAREST_ANCHOR_ID VARCHAR, SOURCE VARCHAR(40), JOB_ID VARCHAR
) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
TRUNCATE TABLE IF EXISTS SYNTHETIC_DATASETS.UNIFIED.DIM_PARTICIPANTS;
COPY INTO SYNTHETIC_DATASETS.UNIFIED.DIM_PARTICIPANTS
FROM (
  SELECT
    $1:PARTICIPANT_ID::VARCHAR, $1:REGION::VARCHAR, $1:LAT::FLOAT, $1:LNG::FLOAT,
    TRY_TO_GEOGRAPHY($1:GEOM_WKT::VARCHAR),
    $1:ADDRESS::VARCHAR, $1:CITY::VARCHAR, $1:STATE::VARCHAR, $1:POSTCODE::VARCHAR,
    $1:NEAREST_ANCHOR_ID::VARCHAR, $1:SOURCE::VARCHAR, $1:JOB_ID::VARCHAR
  FROM @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/synthetic_ebikes/dim_participants/
)
FILE_FORMAT = (TYPE = PARQUET)
PURGE = FALSE
FORCE = TRUE;

-- 2h-2. FACT_HAZARD_ZONES (universal-generation; GEOGRAPHY exported as WKT)
CREATE TABLE IF NOT EXISTS SYNTHETIC_DATASETS.UNIFIED.FACT_HAZARD_ZONES (
  ZONE_ID VARCHAR, REGION VARCHAR(100), STATE VARCHAR, COUNTY VARCHAR, FIPS VARCHAR(10),
  HAZARD_TYPE VARCHAR(40), RISK_SCORE FLOAT, RISK_RATING VARCHAR(40), RISK_LEVEL INT,
  GEOM GEOGRAPHY, SOURCE VARCHAR(40), JOB_ID VARCHAR
) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
TRUNCATE TABLE IF EXISTS SYNTHETIC_DATASETS.UNIFIED.FACT_HAZARD_ZONES;
COPY INTO SYNTHETIC_DATASETS.UNIFIED.FACT_HAZARD_ZONES
FROM (
  SELECT
    $1:ZONE_ID::VARCHAR, $1:REGION::VARCHAR, $1:STATE::VARCHAR, $1:COUNTY::VARCHAR, $1:FIPS::VARCHAR,
    $1:HAZARD_TYPE::VARCHAR, $1:RISK_SCORE::FLOAT, $1:RISK_RATING::VARCHAR, $1:RISK_LEVEL::INT,
    TRY_TO_GEOGRAPHY($1:GEOM_WKT::VARCHAR),
    $1:SOURCE::VARCHAR, $1:JOB_ID::VARCHAR
  FROM @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/synthetic_ebikes/fact_hazard_zones/
)
FILE_FORMAT = (TYPE = PARQUET)
PURGE = FALSE
FORCE = TRUE;

-- 2h-3. DIM_AREA_DEMOGRAPHICS (universal-generation; GEOGRAPHY exported as WKT)
CREATE TABLE IF NOT EXISTS SYNTHETIC_DATASETS.UNIFIED.DIM_AREA_DEMOGRAPHICS (
  AREA_ID VARCHAR, REGION VARCHAR(100), AREA_TYPE VARCHAR(20),
  STATE_FIPS VARCHAR(4), COUNTY_FIPS VARCHAR(8),
  LAT FLOAT, LNG FLOAT, GEOM GEOGRAPHY,
  TOTAL_POPULATION NUMBER, MEDIAN_AGE FLOAT, MEDIAN_HOUSEHOLD_INCOME NUMBER,
  POP_ELDERLY NUMBER, POP_CHILDREN NUMBER, POPULATION_DENSITY FLOAT,
  SOURCE VARCHAR(40), JOB_ID VARCHAR
) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
TRUNCATE TABLE IF EXISTS SYNTHETIC_DATASETS.UNIFIED.DIM_AREA_DEMOGRAPHICS;
COPY INTO SYNTHETIC_DATASETS.UNIFIED.DIM_AREA_DEMOGRAPHICS
FROM (
  SELECT
    $1:AREA_ID::VARCHAR, $1:REGION::VARCHAR, $1:AREA_TYPE::VARCHAR,
    $1:STATE_FIPS::VARCHAR, $1:COUNTY_FIPS::VARCHAR, $1:LAT::FLOAT, $1:LNG::FLOAT,
    TRY_TO_GEOGRAPHY($1:GEOM_WKT::VARCHAR),
    $1:TOTAL_POPULATION::NUMBER, $1:MEDIAN_AGE::FLOAT, $1:MEDIAN_HOUSEHOLD_INCOME::NUMBER,
    $1:POP_ELDERLY::NUMBER, $1:POP_CHILDREN::NUMBER, $1:POPULATION_DENSITY::FLOAT,
    $1:SOURCE::VARCHAR, $1:JOB_ID::VARCHAR
  FROM @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/synthetic_ebikes/dim_area_demographics/
)
FILE_FORMAT = (TYPE = PARQUET)
PURGE = FALSE
FORCE = TRUE;

-- 2h-4. DIM_DEMAND_CATALOG (universal-generation; no GEOGRAPHY)
CREATE TABLE IF NOT EXISTS SYNTHETIC_DATASETS.UNIFIED.DIM_DEMAND_CATALOG (
  ITEM_ID VARCHAR, REGION VARCHAR(100), CATEGORY VARCHAR(60),
  DEMAND_TIER INT, TIER_LABEL VARCHAR(40), HANDLING VARCHAR(60), JOB_ID VARCHAR
) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
TRUNCATE TABLE IF EXISTS SYNTHETIC_DATASETS.UNIFIED.DIM_DEMAND_CATALOG;
COPY INTO SYNTHETIC_DATASETS.UNIFIED.DIM_DEMAND_CATALOG
FROM @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/synthetic_ebikes/dim_demand_catalog/
FILE_FORMAT = (TYPE = PARQUET)
MATCH_BY_COLUMN_NAME = CASE_INSENSITIVE
PURGE = FALSE
FORCE = TRUE;

-- 2i. ROUTE_OPTIMIZATION.PLACES (JOB_ID column; idempotent before control-app boot)
ALTER TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES
  ADD COLUMN IF NOT EXISTS JOB_ID VARCHAR;

DELETE FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES WHERE REGION = 'SanFrancisco';

COPY INTO FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES
FROM (
  SELECT
    $1:REGION::VARCHAR,
    TRY_TO_GEOGRAPHY($1:GEOMETRY_WKT::VARCHAR),
    $1:PHONES::VARCHAR,
    $1:CATEGORY::VARCHAR,
    $1:NAME::VARCHAR,
    TRY_PARSE_JSON($1:ADDRESS_JSON::VARCHAR)::VARIANT,
    TRY_PARSE_JSON($1:ALTERNATE_JSON::VARCHAR)::VARIANT,
    $1:JOB_ID::VARCHAR
  FROM @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/synthetic_ebikes/places/
)
FILE_FORMAT = (TYPE = PARQUET)
PURGE = FALSE
FORCE = TRUE;

-- 2j. ROUTE_OPTIMIZATION.LOOKUP
ALTER TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP
  ADD COLUMN IF NOT EXISTS JOB_ID VARCHAR;

DELETE FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP WHERE REGION = 'SanFrancisco';

COPY INTO FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP
FROM (
  SELECT
    $1:REGION::VARCHAR,
    $1:INDUSTRY::VARCHAR,
    $1:PA::VARCHAR,
    $1:PB::VARCHAR,
    $1:PC::VARCHAR,
    TRY_PARSE_JSON($1:IND_JSON::VARCHAR)::ARRAY,
    TRY_PARSE_JSON($1:IND2_JSON::VARCHAR)::ARRAY,
    TRY_PARSE_JSON($1:CTYPE_JSON::VARCHAR)::ARRAY,
    TRY_PARSE_JSON($1:STYPE_JSON::VARCHAR)::ARRAY,
    $1:SOURCE_TABLE::VARCHAR,
    TRY_PARSE_JSON($1:DEPOT_CTYPE_JSON::VARCHAR)::ARRAY,
    $1:DEPOT_LABEL::VARCHAR,
    $1:JOB_ID::VARCHAR
  FROM @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/synthetic_ebikes/lookup/
)
FILE_FORMAT = (TYPE = PARQUET)
PURGE = FALSE
FORCE = TRUE;

-- 2k. MARKETPLACE.FACT_OFFER_ROUTES (pre-computed delivery routes)
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.MARKETPLACE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.MARKETPLACE.FACT_OFFER_ROUTES (
  OFFER_ID     VARCHAR    NOT NULL,
  ROAD_KM      FLOAT,
  ROAD_MIN     FLOAT,
  GEOMETRY     VARCHAR,
  PROFILE      VARCHAR(20),
  COMPUTED_AT  TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
  JOB_ID       VARCHAR,
  CONSTRAINT PK_FACT_OFFER_ROUTES PRIMARY KEY (OFFER_ID)
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

TRUNCATE TABLE IF EXISTS FLEET_INTELLIGENCE.MARKETPLACE.FACT_OFFER_ROUTES;

COPY INTO FLEET_INTELLIGENCE.MARKETPLACE.FACT_OFFER_ROUTES
FROM @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/synthetic_ebikes/fact_offer_routes/
FILE_FORMAT = (TYPE = PARQUET)
MATCH_BY_COLUMN_NAME = CASE_INSENSITIVE
PURGE = FALSE
FORCE = TRUE;

--------------------------------------------------------------------------------
-- 3. Metadata tables (FLEET_INTELLIGENCE.CORE)
--------------------------------------------------------------------------------

-- 3a. REGION_REGISTRY
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.CORE.REGION_REGISTRY (
  REGION_NAME VARCHAR NOT NULL,
  DISPLAY_NAME VARCHAR NOT NULL,
  CENTER_LAT FLOAT NOT NULL,
  CENTER_LON FLOAT NOT NULL,
  CENTER_POINT GEOGRAPHY,
  BBOX_MIN_LAT FLOAT,
  BBOX_MAX_LAT FLOAT,
  BBOX_MIN_LON FLOAT,
  BBOX_MAX_LON FLOAT,
  BBOX GEOGRAPHY,
  ZOOM_LEVEL INT DEFAULT 11,
  ORS_REGION_KEY VARCHAR,
  DATA_SOURCE VARCHAR NOT NULL,
  IS_DEFAULT BOOLEAN DEFAULT FALSE,
  PROVISIONED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
  PRIMARY KEY (REGION_NAME)
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

TRUNCATE TABLE IF EXISTS FLEET_INTELLIGENCE.CORE.REGION_REGISTRY;

COPY INTO FLEET_INTELLIGENCE.CORE.REGION_REGISTRY
FROM (
  SELECT
    $1:REGION_NAME::VARCHAR,
    $1:DISPLAY_NAME::VARCHAR,
    $1:CENTER_LAT::FLOAT,
    $1:CENTER_LON::FLOAT,
    TRY_TO_GEOGRAPHY($1:CENTER_POINT_WKT::VARCHAR),
    $1:BBOX_MIN_LAT::FLOAT,
    $1:BBOX_MAX_LAT::FLOAT,
    $1:BBOX_MIN_LON::FLOAT,
    $1:BBOX_MAX_LON::FLOAT,
    TRY_TO_GEOGRAPHY($1:BBOX_WKT::VARCHAR),
    $1:ZOOM_LEVEL::INT,
    $1:ORS_REGION_KEY::VARCHAR,
    $1:DATA_SOURCE::VARCHAR,
    $1:IS_DEFAULT::BOOLEAN,
    $1:PROVISIONED_AT::TIMESTAMP_NTZ
  FROM @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/metadata/region_registry
)
FILE_FORMAT = (TYPE = PARQUET)
PURGE = FALSE
FORCE = TRUE;

--------------------------------------------------------------------------------
-- 3a-bis. REGION_REGISTRY_V (joins REGION_REGISTRY to REGION_CATALOG so
--          downstream consumers see real region polygons + ISO codes from
--          the shipped boundary snapshot. Falls back to bbox if no catalog
--          row exists yet for a manually-added region.)
--------------------------------------------------------------------------------
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.CORE.REGION_REGISTRY_V
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT
  rr.REGION_NAME,
  rr.DISPLAY_NAME,
  rr.CENTER_LAT,
  rr.CENTER_LON,
  rr.CENTER_POINT,
  rr.BBOX_MIN_LAT,
  rr.BBOX_MAX_LAT,
  rr.BBOX_MIN_LON,
  rr.BBOX_MAX_LON,
  rr.BBOX,
  rr.ZOOM_LEVEL,
  rr.ORS_REGION_KEY,
  rr.DATA_SOURCE,
  rr.IS_DEFAULT,
  rr.PROVISIONED_AT,
  COALESCE(rc.BOUNDARY, rr.BBOX)                  AS BOUNDARY,
  COALESCE(rc.BOUNDARY_SOURCE, 'bbox-fallback')   AS BOUNDARY_SOURCE,
  rc.BOUNDARY_VERTICES,
  rc.BOUNDARY_AREA_KM2,
  rc.BOUNDARY_BAKED_AT,
  rc.ISO_COUNTRY_A2,
  rc.ISO_COUNTRY_A3,
  rc.ISO_SUBDIVISION,
  rc.UN_M49,
  rc.LOOKUP_NAME       AS CATALOG_LOOKUP_NAME,
  rc.HIERARCHY         AS CATALOG_HIERARCHY,
  rc.CONTINENT         AS CATALOG_CONTINENT,
  rc.COUNTRY           AS CATALOG_COUNTRY
FROM FLEET_INTELLIGENCE.CORE.REGION_REGISTRY rr
LEFT JOIN OPENROUTESERVICE_APP.CORE.REGION_CATALOG rc
  ON UPPER(rc.REGION_KEY)  = UPPER(rr.ORS_REGION_KEY)
  OR UPPER(rc.LOOKUP_NAME)  = UPPER(rr.ORS_REGION_KEY)
  OR UPPER(rc.REGION_NAME)  = UPPER(rr.ORS_REGION_KEY)
-- REGION_CATALOG holds same-name rows (e.g. country "Mexico" vs the natural-earth
-- state "México", both LOOKUP_NAME='Mexico'). Resolve to ONE row per region:
-- exact REGION_KEY match first (unique, authoritative for every deployed region),
-- then exact LOOKUP_NAME / REGION_NAME, then broader admin LEVEL and larger area.
-- Without this a bare LEFT JOIN fans out to multiple rows per region and picks an
-- arbitrary (often the wrong, smaller) BOUNDARY. Mirrors the application helper
-- server/lib/region-catalog-match.ts.
QUALIFY ROW_NUMBER() OVER (
  PARTITION BY rr.REGION_NAME
  ORDER BY
    CASE WHEN UPPER(rc.REGION_KEY)  = UPPER(rr.ORS_REGION_KEY) THEN 0
         WHEN UPPER(rc.LOOKUP_NAME) = UPPER(rr.ORS_REGION_KEY) THEN 1 ELSE 2 END,
    CASE rc.LEVEL WHEN 'continent' THEN 0 WHEN 'country' THEN 1
         WHEN 'sub-region' THEN 2 WHEN 'sub-sub-region' THEN 3 ELSE 4 END,
    COALESCE(rc.BOUNDARY_AREA_KM2, 0) DESC
) = 1;

-- 3b. GENERATION_JOBS
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.CORE.GENERATION_JOBS (
  JOB_ID VARCHAR,
  PRESET_ID VARCHAR,
  PRESET_NAME VARCHAR,
  REGION VARCHAR(100),
  ORS_PROFILE VARCHAR(30),
  NUM_VEHICLES INT,
  START_DATE DATE,
  END_DATE DATE,
  STATUS VARCHAR(20),
  POINTS_GENERATED INT DEFAULT 0,
  TRIPS_GENERATED INT DEFAULT 0,
  STARTED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
  COMPLETED_AT TIMESTAMP_NTZ,
  ERROR_MESSAGE VARCHAR,
  CONFIG VARIANT
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- 3a-ter. DIM_DATASETS (active dataset registry for V_*_CURRENT views)
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.CORE.DIM_DATASETS (
  DATASET_ID    VARCHAR,
  REGION        VARCHAR(100),
  VEHICLE_TYPE  VARCHAR(20),
  LABEL         VARCHAR,
  IS_ACTIVE     BOOLEAN DEFAULT TRUE,
  CREATED_AT    TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
  ROW_COUNTS    VARIANT,
  NOTES         VARCHAR
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- Derive the seed dataset identity + scope from the data just loaded (the
-- parquet carries JOB_ID/REGION/VEHICLE_TYPE per row). After the TRUNCATE+COPY
-- above, DIM_FLEET holds exactly the seed dataset, so these are unambiguous.
-- This keeps the loader correct for whatever dataset export-preset.sql produced.
SET SEED_JOB_ID       = (SELECT MAX(JOB_ID)       FROM SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET);
SET SEED_REGION       = (SELECT MAX(REGION)       FROM SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET WHERE JOB_ID = $SEED_JOB_ID);
SET SEED_VEHICLE_TYPE = (SELECT MAX(VEHICLE_TYPE) FROM SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET WHERE JOB_ID = $SEED_JOB_ID);
SET SEED_PROFILE      = (SELECT MAX(ORS_PROFILE)  FROM SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET WHERE JOB_ID = $SEED_JOB_ID);
SET SEED_NUM_VEHICLES = (SELECT COUNT(*)          FROM SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET WHERE JOB_ID = $SEED_JOB_ID);
SET SEED_START        = (SELECT MIN(TS)::DATE FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY WHERE JOB_ID = $SEED_JOB_ID);
SET SEED_END          = (SELECT MAX(TS)::DATE FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY WHERE JOB_ID = $SEED_JOB_ID);

TRUNCATE TABLE IF EXISTS FLEET_INTELLIGENCE.CORE.DIM_DATASETS;

INSERT INTO FLEET_INTELLIGENCE.CORE.DIM_DATASETS
  (DATASET_ID, REGION, VEHICLE_TYPE, LABEL, IS_ACTIVE, CREATED_AT, ROW_COUNTS, NOTES)
SELECT
  $SEED_JOB_ID,
  $SEED_REGION,
  $SEED_VEHICLE_TYPE,
  'Seed dataset (' || $SEED_REGION || ' / ' || $SEED_VEHICLE_TYPE || ')',
  TRUE,
  CURRENT_TIMESTAMP(),
  OBJECT_CONSTRUCT(
    'fleet',         (SELECT COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET             WHERE JOB_ID = $SEED_JOB_ID),
    'pois',          (SELECT COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.DIM_POIS              WHERE JOB_ID = $SEED_JOB_ID),
    'trips',         (SELECT COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS            WHERE JOB_ID = $SEED_JOB_ID),
    'telemetry',     (SELECT COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY WHERE JOB_ID = $SEED_JOB_ID),
    'offers',        (SELECT COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.FACT_OFFERS           WHERE JOB_ID = $SEED_JOB_ID),
    'partners',      (SELECT COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.DIM_PARTNERS          WHERE JOB_ID = $SEED_JOB_ID),
    'history',       (SELECT COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.FACT_PARTNER_HISTORY  WHERE JOB_ID = $SEED_JOB_ID),
    'trip_schedule', (SELECT COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.DIM_TRIP_SCHEDULE     WHERE JOB_ID = $SEED_JOB_ID),
    'places',        (SELECT COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES     WHERE JOB_ID = $SEED_JOB_ID),
    'lookup',        (SELECT COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP     WHERE JOB_ID = $SEED_JOB_ID),
    'routes',        (SELECT COUNT(*) FROM FLEET_INTELLIGENCE.MARKETPLACE.FACT_OFFER_ROUTES WHERE JOB_ID = $SEED_JOB_ID),
    'anchors',       (SELECT COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.DIM_ANCHORS           WHERE JOB_ID = $SEED_JOB_ID),
    'demographics',  (SELECT COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.DIM_AREA_DEMOGRAPHICS WHERE JOB_ID = $SEED_JOB_ID),
    'hazard',        (SELECT COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.FACT_HAZARD_ZONES     WHERE JOB_ID = $SEED_JOB_ID),
    'demand',        (SELECT COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.DIM_DEMAND_CATALOG    WHERE JOB_ID = $SEED_JOB_ID),
    'participants',  (SELECT COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.DIM_PARTICIPANTS      WHERE JOB_ID = $SEED_JOB_ID)
  ),
  'Seed dataset from Data Studio preset (loaded by load-seed-data.sql)';

TRUNCATE TABLE IF EXISTS FLEET_INTELLIGENCE.CORE.GENERATION_JOBS;

INSERT INTO FLEET_INTELLIGENCE.CORE.GENERATION_JOBS
  (JOB_ID, PRESET_ID, PRESET_NAME, REGION, ORS_PROFILE, NUM_VEHICLES, START_DATE, END_DATE, STATUS, POINTS_GENERATED, TRIPS_GENERATED, STARTED_AT, COMPLETED_AT, ERROR_MESSAGE, CONFIG)
SELECT
  $SEED_JOB_ID,
  '',
  'Seed: ' || $SEED_REGION || ' ' || $SEED_VEHICLE_TYPE,
  $SEED_REGION,
  $SEED_PROFILE,
  $SEED_NUM_VEHICLES,
  $SEED_START,
  $SEED_END,
  'COMPLETED',
  (SELECT COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY WHERE JOB_ID = $SEED_JOB_ID),
  (SELECT COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS WHERE JOB_ID = $SEED_JOB_ID),
  DATEADD('hour', -2, CURRENT_TIMESTAMP()),
  DATEADD('minute', -5, CURRENT_TIMESTAMP()),
  NULL,
  OBJECT_CONSTRUCT(
    'vehicleType', $SEED_VEHICLE_TYPE,
    'orsProfile',  $SEED_PROFILE,
    'numVehicles', $SEED_NUM_VEHICLES,
    'region',      $SEED_REGION,
    'source',      'seed-data'
  )
;

--------------------------------------------------------------------------------
-- 3c. SET_ACTIVE_REGION procedure
--     Called by ORS Control App server on region switch.
--------------------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.CORE.SET_ACTIVE_REGION(
    P_REGION VARCHAR
)
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
BEGIN
    UPDATE FLEET_INTELLIGENCE.CORE.REGION_REGISTRY SET IS_DEFAULT = FALSE WHERE IS_DEFAULT = TRUE;
    UPDATE FLEET_INTELLIGENCE.CORE.REGION_REGISTRY SET IS_DEFAULT = TRUE WHERE REGION_NAME = :P_REGION;
    RETURN 'Active region set to ' || P_REGION;
END;
$$;

ALTER PROCEDURE IF EXISTS FLEET_INTELLIGENCE.CORE.SET_ACTIVE_REGION(VARCHAR)
SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

--------------------------------------------------------------------------------
-- 3d. REGION_CATALOG (pre-seeded Geofabrik + BBBike catalog)
--     Skips if catalog already has data.
--------------------------------------------------------------------------------
-- Guarded: install-fleet-apps runs this loader in its data step (step 2), BEFORE
-- the engine module (03_region_management) that creates LOAD_SEED_CATALOG. A bare
-- CALL there aborts with "Unknown user-defined function ... LOAD_SEED_CATALOG"
-- and bubbles up as the "canonical loader reported errors" WARN. Install step 3.4
-- re-seeds the catalog once the engine is present, so here we CALL only when the
-- proc already exists (engine-first path) and silently skip otherwise. Zero WARN
-- on a fresh install; unchanged behaviour when the engine is already deployed.
EXECUTE IMMEDIATE $$
BEGIN
  CALL OPENROUTESERVICE_APP.CORE.LOAD_SEED_CATALOG('@OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE');
  RETURN 'region catalog seeded';
EXCEPTION
  WHEN OTHER THEN
    RETURN 'LOAD_SEED_CATALOG not present yet; region catalog seeded later (install step 3.4)';
END;
$$;

--------------------------------------------------------------------------------
-- 4. Offset timestamps so data looks freshly generated
--------------------------------------------------------------------------------

-- Telemetry: shift all TS so the latest = ~5 minutes ago
SET TS_OFFSET = (
  SELECT TIMESTAMPDIFF('SECOND',
    (SELECT MAX(TS) FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY),
    DATEADD('minute', -5, CURRENT_TIMESTAMP()))
);

UPDATE SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY
SET TS = DATEADD('SECOND', $TS_OFFSET, TS);

-- Trips: shift TRIP_START and TRIP_END by the same offset
UPDATE SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS
SET TRIP_START = DATEADD('SECOND', $TS_OFFSET, TRIP_START),
    TRIP_END   = DATEADD('SECOND', $TS_OFFSET, TRIP_END);

-- Planned schedule: shift onto the same window as the ACTUALS it is compared
-- against. This was missed, and the miss is invisible until someone opens the
-- page: the baked plan sat at 2026-06-01..06-08 while the shifted telemetry and
-- trips sat at 2026-08-24..08-31, roughly 84 days apart. Because the context
-- bar's date range is derived FROM THE DATA (trips), the window can never
-- overlap the plan, so every work-item panel filtered on REQUESTED_START_TS
-- returned nothing - the Dispatch / Execution board rendered an empty job list
-- and an empty resource chart, and its KPI card showed 0/0/0/0 rather than
-- erroring, because COUNT(*) over no rows is still one row. Same failure mode
-- the FACT_OFFERS shift below already documents.
--
-- Anchored on MAX(TRIP_START) rather than on $TS_OFFSET so plan and actual stay
-- aligned with each other (plan_vs_actual_performance compares them), and so
-- re-running this loader is a no-op instead of shifting a second time.
--
-- COALESCE to 0 is load-bearing, not defensive noise. If either table is
-- unexpectedly empty its MAX is NULL, the offset is NULL, and
-- DATEADD('SECOND', NULL, PLANNED_START) returns NULL - which would blank all
-- 13,721 planned timestamps and destroy the plan outright, strictly worse than
-- the misalignment this block exists to fix. It would also be SILENT: the
-- installer downgrades a loader error to a WARN and continues, so the only
-- symptom would be an empty Dispatch board again. With 0 the UPDATE is a no-op.
SET SCHED_TS_OFFSET = (
  SELECT COALESCE(TIMESTAMPDIFF('SECOND',
    (SELECT MAX(PLANNED_START) FROM SYNTHETIC_DATASETS.UNIFIED.DIM_TRIP_SCHEDULE),
    (SELECT MAX(TRIP_START)    FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS)), 0)
);

UPDATE SYNTHETIC_DATASETS.UNIFIED.DIM_TRIP_SCHEDULE
SET PLANNED_START = DATEADD('SECOND', $SCHED_TS_OFFSET, PLANNED_START),
    PLANNED_END   = DATEADD('SECOND', $SCHED_TS_OFFSET, PLANNED_END);

-- Freight offers: shift so the newest offer = now. The Freight Exchange page
-- defaults to a 24h "max age" filter; without this every seeded offer ages out
-- and the grid renders 0/300.
SET OFFER_TS_OFFSET = (
  SELECT TIMESTAMPDIFF('SECOND',
    (SELECT MAX(POSTED_AT) FROM SYNTHETIC_DATASETS.UNIFIED.FACT_OFFERS),
    CURRENT_TIMESTAMP())
);

UPDATE SYNTHETIC_DATASETS.UNIFIED.FACT_OFFERS
SET POSTED_AT      = DATEADD('SECOND', $OFFER_TS_OFFSET, POSTED_AT),
    PICKUP_FROM_TS = DATEADD('SECOND', $OFFER_TS_OFFSET, PICKUP_FROM_TS),
    PICKUP_TO_TS   = DATEADD('SECOND', $OFFER_TS_OFFSET, PICKUP_TO_TS);

--------------------------------------------------------------------------------
-- 5. Travel Time Matrix (pre-computed SanFrancisco cycling-electric RES8)
--    178 H3 hexagons, 29,402 travel-time pairs.
--------------------------------------------------------------------------------
-- Guarded for the same reason as LOAD_SEED_CATALOG above: on a fresh
-- install-fleet-apps run this loader executes BEFORE the engine module
-- (06_matrix_ops) that creates LOAD_SEED_MATRIX, so a bare CALL aborts with
-- "Unknown user-defined function ... LOAD_SEED_MATRIX" and bubbles up as the
-- "canonical loader reported errors" WARN. Skip silently when the proc is
-- absent; install step 3.4 re-seeds the matrix once the engine is present.
-- The engine-first path (proc already present) still loads the matrix inline.
EXECUTE IMMEDIATE $$
BEGIN
  CALL OPENROUTESERVICE_APP.CORE.LOAD_SEED_MATRIX('@OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE', 'SanFrancisco', 'cycling-electric', 'RES8');
  RETURN 'seed travel-time matrix loaded';
EXCEPTION
  WHEN OTHER THEN
    RETURN 'LOAD_SEED_MATRIX not present yet; seed matrix loaded later (install step 3.4)';
END;
$$;

--------------------------------------------------------------------------------
-- 6. Anchor the active-preset CONFIG pointers (Asset Velocity + Freight Exchange)
--------------------------------------------------------------------------------
-- Both pages read projection views gated by a single-row CONFIG pointer:
--   * FLEET_INTELLIGENCE.MARKETPLACE.CONFIG        -> Offers (VW_OFFER_ENRICHED)
--   * FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG -> Asset Velocity (VW_IDLE_VEHICLES, etc.)
-- The control-app's init.ts recreates the views + MERGEs MARKETPLACE.CONFIG on
-- every boot, but a fresh install boots (Step 6) BEFORE this seed loader runs
-- (Step 7), so at boot it derives from an empty UNIFIED and leaves both pointers
-- empty -> both pages render 0 rows. init.ts also never INSERTs the
-- ROUTE_OPTIMIZATION.CONFIG row at all. We anchor both pointers here, derived
-- from the active DIM_DATASETS row (configurable, not hardcoded), so the pages
-- prefill on the next boot regardless of which demo skills are deployed.
-- Idempotent and conflict-free with init.ts: its boot MERGE re-affirms the same
-- row (self-heal arm skipped because offers exist) and its cost UPDATE uses
-- COALESCE, preserving the values seeded below.

-- 6a. MARKETPLACE.CONFIG (guards in case init.ts has not created them yet)
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.MARKETPLACE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.MARKETPLACE.CONFIG (
  VEHICLE_TYPE VARCHAR NOT NULL,
  REGION       VARCHAR NOT NULL
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

DELETE FROM FLEET_INTELLIGENCE.MARKETPLACE.CONFIG;
INSERT INTO FLEET_INTELLIGENCE.MARKETPLACE.CONFIG (VEHICLE_TYPE, REGION)
SELECT VEHICLE_TYPE, REGION
FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS
WHERE IS_ACTIVE = TRUE
LIMIT 1;

-- 6b. ROUTE_OPTIMIZATION.CONFIG (guards + cost columns; init.ts is the source of
-- truth for these column defaults -- see init.ts ~lines 425-443. Keep in sync.)
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG (
  VEHICLE_TYPE VARCHAR NOT NULL,
  REGION       VARCHAR NOT NULL
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

ALTER TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG ADD COLUMN IF NOT EXISTS DAILY_RENTAL_RATE_AVOIDED_USD NUMBER(10,2);
ALTER TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG ADD COLUMN IF NOT EXISTS RENTAL_CAPTURE_RATE NUMBER(4,3);
ALTER TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG ADD COLUMN IF NOT EXISTS MAX_REPOSITION_MINUTES NUMBER(6,0);
ALTER TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG ADD COLUMN IF NOT EXISTS AVOID_FEATURES VARCHAR(200);

DELETE FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG;
INSERT INTO FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG
  (VEHICLE_TYPE, REGION, DAILY_RENTAL_RATE_AVOIDED_USD, RENTAL_CAPTURE_RATE, MAX_REPOSITION_MINUTES, AVOID_FEATURES)
SELECT VEHICLE_TYPE, REGION, 80.00, 0.600, 600, 'tollways,ferries'
FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS
WHERE IS_ACTIVE = TRUE
LIMIT 1;

SELECT 'Seed data loaded successfully' AS STATUS;
