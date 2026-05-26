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

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

USE WAREHOUSE ROUTING_ANALYTICS;

--------------------------------------------------------------------------------
-- Stage & File Format
--------------------------------------------------------------------------------
CREATE STAGE IF NOT EXISTS OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE FILE FORMAT IF NOT EXISTS OPENROUTESERVICE_APP.CORE.PARQUET_FF
  TYPE = PARQUET
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

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
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

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
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

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
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

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
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

TRUNCATE TABLE IF EXISTS SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET;

COPY INTO SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET
FROM @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/synthetic_ebikes/dim_fleet_
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
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

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
  FROM @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/synthetic_ebikes/dim_pois_
)
FILE_FORMAT = (TYPE = PARQUET)
PURGE = FALSE
FORCE = TRUE;

-- 2e. DIM_TRIP_SCHEDULE (empty, create for schema only)
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
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

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
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

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
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

TRUNCATE TABLE IF EXISTS FLEET_INTELLIGENCE.CORE.GENERATION_JOBS;

INSERT INTO FLEET_INTELLIGENCE.CORE.GENERATION_JOBS
  (JOB_ID, PRESET_ID, PRESET_NAME, REGION, ORS_PROFILE, NUM_VEHICLES, START_DATE, END_DATE, STATUS, POINTS_GENERATED, TRIPS_GENERATED, STARTED_AT, COMPLETED_AT, ERROR_MESSAGE, CONFIG)
SELECT
  REPLACE(UUID_STRING(), '-', '') || '-seed',
  '',
  'E-Bike Couriers',
  'SanFrancisco',
  'cycling-electric',
  50,
  DATEADD('day', -7, CURRENT_DATE()),
  DATEADD('day', -1, CURRENT_DATE()),
  'COMPLETED',
  472869,
  6008,
  DATEADD('hour', -2, CURRENT_TIMESTAMP()),
  DATEADD('minute', -5, CURRENT_TIMESTAMP()),
  NULL,
  PARSE_JSON('{"vehicleType":"ebike","orsProfile":"cycling-electric","numVehicles":50,"days":7,"tripsPerDay":{"min":15,"max":35},"region":"SanFrancisco","source":"seed-data"}');

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
SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

--------------------------------------------------------------------------------
-- 3d. REGION_CATALOG (pre-seeded Geofabrik + BBBike catalog)
--     Skips if catalog already has data.
--------------------------------------------------------------------------------
CALL OPENROUTESERVICE_APP.CORE.LOAD_SEED_CATALOG(
  '@OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE'
);

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


--------------------------------------------------------------------------------
-- 6. Travel Time Matrix (pre-computed SanFrancisco cycling-electric RES8)
--    178 H3 hexagons, 29,402 travel-time pairs.
--------------------------------------------------------------------------------
CALL OPENROUTESERVICE_APP.CORE.LOAD_SEED_MATRIX(
  '@OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE',
  'SanFrancisco',
  'cycling-electric',
  'RES8'
);

--------------------------------------------------------------------------------
-- 7. Agent Playground Demo Data
--    SF Health Demographics (55 neighborhoods), Drug Formulary (25 drugs),
--    Top Pharmacies (6), Pharma Jobs (30 delivery stops).
--    These are needed for the Agent Playground catchment/supply chain scenarios.
--------------------------------------------------------------------------------

-- 7a. SF_HEALTH_DEMOGRAPHICS (55 SF neighborhoods with morbidity + deprivation data)
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_HEALTH_DEMOGRAPHICS (
  DEMO_ID NUMBER, NEIGHBORHOOD VARCHAR, LATITUDE FLOAT, LONGITUDE FLOAT,
  TOTAL_POPULATION NUMBER, PCT_ELDERLY FLOAT, PCT_CHILDREN FLOAT,
  DIABETES_PCT FLOAT, HYPERTENSION_PCT FLOAT, CARDIOVASCULAR_PCT FLOAT,
  RESPIRATORY_PCT FLOAT, MOBILITY_ISSUES_PCT FLOAT,
  INCOME_BRACKET VARCHAR, CAR_OWNERSHIP_PCT FLOAT, TRANSIT_ACCESS NUMBER
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

TRUNCATE TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_HEALTH_DEMOGRAPHICS;

INSERT INTO FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_HEALTH_DEMOGRAPHICS VALUES
(1,'Tenderloin',37.7840,-122.4141,28000,12.1,8.4,24.2,44.1,18.3,22.7,31.2,'LOW',15.2,9),
(2,'SoMa North',37.7795,-122.4005,22000,9.8,6.2,19.4,38.7,15.1,19.8,25.4,'LOW',22.1,9),
(3,'SoMa South',37.7741,-122.4003,18000,10.2,5.9,17.8,36.2,14.2,18.3,24.1,'LOW',24.3,8),
(4,'Bayview North',37.7407,-122.3903,24000,16.4,14.2,22.1,42.3,17.6,20.1,28.7,'LOW',18.4,7),
(5,'Bayview South',37.7283,-122.3876,19000,18.2,15.8,23.4,44.7,19.2,21.8,30.1,'LOW',16.7,6),
(6,'Excelsior',37.7222,-122.4374,31000,17.9,13.6,20.8,40.1,16.4,18.9,27.3,'LOW',28.4,7),
(7,'Visitacion Valley',37.7143,-122.4112,22000,19.1,16.3,22.7,43.2,18.1,20.4,29.8,'LOW',25.1,6),
(8,'Outer Mission',37.7248,-122.4295,26000,16.7,14.1,21.3,41.8,17.2,19.6,28.4,'LOW',30.2,7),
(9,'Portola',37.7272,-122.4149,17000,17.4,13.9,20.6,39.8,15.9,18.4,26.9,'LOW',27.3,6),
(10,'Ingleside',37.7262,-122.4529,20000,16.2,13.2,19.8,38.7,15.4,17.8,25.7,'LOW',29.1,7),
(11,'Mission Dolores',37.7601,-122.4259,29000,13.4,10.8,16.2,34.7,13.1,16.4,20.3,'MEDIUM',32.4,8),
(12,'Mission District',37.7503,-122.4194,34000,12.8,11.4,17.4,36.2,14.2,17.8,22.1,'MEDIUM',35.7,8),
(13,'Chinatown',37.7941,-122.4070,14000,22.3,9.1,18.9,37.4,16.3,15.2,27.8,'MEDIUM',19.2,9),
(14,'Western Addition',37.7791,-122.4300,21000,14.2,10.2,15.8,33.4,12.7,15.9,19.7,'MEDIUM',28.3,8),
(15,'Fillmore',37.7823,-122.4360,18000,13.7,9.8,15.4,32.8,12.3,15.4,19.1,'MEDIUM',30.4,8),
(16,'Lower Haight',37.7718,-122.4306,16000,11.2,8.4,13.7,29.8,11.2,14.1,17.3,'MEDIUM',37.2,8),
(17,'Civic Center',37.7793,-122.4177,12000,15.8,7.2,18.1,35.7,14.8,17.2,23.4,'LOW',21.3,9),
(18,'Glen Park',37.7343,-122.4338,14000,15.4,12.7,14.2,30.3,11.8,13.7,17.8,'MEDIUM',52.4,7),
(19,'Bernal Heights',37.7424,-122.4156,19000,13.2,11.6,14.8,31.2,12.1,14.3,18.2,'MEDIUM',41.7,7),
(20,'Dogpatch',37.7587,-122.3890,11000,9.4,7.8,12.3,27.4,10.4,13.2,15.4,'MEDIUM',44.2,7),
(21,'Outer Sunset West',37.7463,-122.5041,28000,18.7,12.4,15.1,31.8,12.4,14.2,19.3,'MEDIUM',48.7,6),
(22,'Outer Sunset East',37.7522,-122.4877,26000,17.4,11.8,14.7,30.4,11.8,13.7,18.4,'MEDIUM',51.2,6),
(23,'Inner Sunset',37.7634,-122.4695,22000,14.8,10.2,12.4,27.8,10.7,12.8,16.2,'MEDIUM',54.8,7),
(24,'Outer Richmond West',37.7803,-122.5012,24000,19.2,11.6,14.3,30.7,11.6,13.1,18.7,'MEDIUM',46.3,7),
(25,'Outer Richmond East',37.7819,-122.4787,22000,18.4,11.2,13.8,29.4,11.2,12.7,17.9,'MEDIUM',49.4,7),
(26,'Inner Richmond',37.7817,-122.4632,20000,16.2,10.8,12.7,27.6,10.4,12.2,16.4,'MEDIUM',56.1,8),
(27,'Castro',37.7616,-122.4350,16000,12.4,5.6,11.2,25.3,9.8,11.7,14.3,'HIGH',62.4,8),
(28,'Noe Valley',37.7507,-122.4334,18000,11.8,14.2,10.4,23.7,9.2,10.8,13.1,'HIGH',67.8,7),
(29,'Upper Market',37.7682,-122.4413,14000,11.1,6.2,10.8,24.2,9.4,11.2,13.7,'HIGH',64.3,8),
(30,'Eureka Valley',37.7571,-122.4289,12000,12.7,7.4,11.7,25.8,10.1,12.1,15.2,'HIGH',59.7,8),
(31,'Marina',37.8010,-122.4354,22000,8.4,6.2,7.4,18.3,7.1,8.4,9.2,'HIGH',71.4,8),
(32,'Pacific Heights',37.7925,-122.4357,20000,12.8,8.4,8.2,19.7,7.8,9.1,10.4,'HIGH',68.9,8),
(33,'Cow Hollow',37.7976,-122.4290,14000,7.8,5.4,6.8,17.4,6.4,7.8,8.4,'HIGH',74.2,8),
(34,'Nob Hill',37.7928,-122.4146,18000,16.4,6.8,9.8,22.4,8.7,10.4,12.8,'HIGH',52.3,9),
(35,'Russian Hill',37.7987,-122.4192,16000,13.2,7.2,8.7,20.1,7.9,9.4,11.3,'HIGH',63.7,9),
(36,'Hayes Valley',37.7762,-122.4261,14000,10.4,7.8,9.4,21.7,8.2,10.1,12.4,'HIGH',69.8,8),
(37,'Duboce Triangle',37.7698,-122.4317,10000,9.8,6.4,8.8,20.3,7.6,9.2,11.1,'HIGH',72.3,8),
(38,'Cole Valley',37.7679,-122.4482,12000,12.1,9.6,9.2,21.2,8.1,9.8,11.8,'HIGH',65.4,8),
(39,'FiDi / Financial',37.7937,-122.3995,8000,8.2,4.1,7.8,19.2,7.2,8.7,9.8,'HIGH',28.4,9),
(40,'North Beach',37.7989,-122.4094,14000,15.4,7.8,10.2,22.8,8.9,10.7,13.2,'HIGH',58.2,9),
(41,'Presidio Heights',37.7880,-122.4521,12000,14.8,10.2,7.8,18.7,7.1,8.2,9.8,'HIGH',72.8,7),
(42,'Laurel Heights',37.7845,-122.4524,10000,16.2,8.4,8.4,20.1,7.8,9.1,10.7,'HIGH',68.4,7),
(43,'Anza Vista',37.7808,-122.4444,11000,14.4,9.2,9.1,21.4,8.2,9.7,11.4,'HIGH',64.7,8),
(44,'NOPA',37.7748,-122.4421,16000,11.2,8.8,10.4,23.1,8.9,10.8,12.7,'MEDIUM',55.3,8),
(45,'Haight-Ashbury',37.7692,-122.4481,18000,10.8,7.4,11.8,24.7,9.4,11.4,13.8,'MEDIUM',48.2,8),
(46,'Twin Peaks',37.7531,-122.4483,8000,18.4,7.2,11.4,24.1,9.2,10.8,14.2,'HIGH',71.2,6),
(47,'Diamond Heights',37.7429,-122.4428,10000,17.8,9.8,12.7,26.3,10.1,11.7,15.4,'HIGH',66.8,6),
(48,'Forest Hill',37.7478,-122.4594,9000,19.2,11.4,11.2,24.8,9.7,11.2,14.8,'HIGH',73.4,6),
(49,'West Portal',37.7395,-122.4642,14000,17.4,13.8,12.4,26.7,10.4,12.1,15.8,'HIGH',69.2,7),
(50,'Sunset District Central',37.7573,-122.4912,32000,16.8,14.2,13.8,28.4,11.1,13.2,17.1,'MEDIUM',52.8,6),
(51,'Parkside',37.7437,-122.4781,22000,18.2,13.4,14.2,29.1,11.4,13.4,17.8,'MEDIUM',55.4,6),
(52,'Lakeshore',37.7287,-122.4843,16000,17.8,12.8,13.4,27.8,10.8,12.8,16.4,'MEDIUM',49.7,6),
(53,'Oceanview',37.7178,-122.4572,18000,16.4,14.7,18.2,36.4,14.8,16.7,22.3,'LOW',32.1,6),
(54,'Crocker-Amazon',37.7105,-122.4361,20000,15.8,15.2,19.7,38.1,15.7,17.8,24.1,'LOW',34.8,6),
(55,'Hunters Point',37.7295,-122.3731,16000,14.2,16.8,24.8,46.2,20.1,22.4,32.4,'LOW',14.8,5);

-- 7b. SF_TOP_PHARMACIES (6 key SF pharmacy locations)
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_TOP_PHARMACIES (
  PHARMACY_ID INT, NAME VARCHAR, ADDRESS VARCHAR, LATITUDE FLOAT, LONGITUDE FLOAT, CHAIN VARCHAR, SPECIALTIES VARCHAR
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

TRUNCATE TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_TOP_PHARMACIES;

INSERT INTO FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_TOP_PHARMACIES VALUES
(1,'Walgreens Castro','498 Castro Street',37.7609,-122.4350,'Walgreens','HIV/PrEP, Immunizations'),
(2,'CVS Geary','2676 Geary Boulevard',37.7828,-122.4449,'CVS','Diabetes Management, MinuteClinic'),
(3,'Walgreens Mission','2690 Mission Street',37.7544,-122.4188,'Walgreens','Spanish-Speaking Staff'),
(4,'Rite Aid Clement','801 Clement Street',37.7831,-122.4651,'Rite Aid','Senior Services, Home Delivery'),
(5,'Walgreens Divisadero','2141 Divisadero Street',37.7880,-122.4397,'Walgreens','Compounding, Specialty'),
(6,'CVS Van Ness','1000 Van Ness Avenue',37.7853,-122.4222,'CVS','24-Hour, Specialty Infusion');

-- 7c. SF_DRUG_FORMULARY (25 drugs across 5 conditions)
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_DRUG_FORMULARY (
  DRUG_ID INT, DRUG_NAME VARCHAR, CONDITION VARCHAR, STORAGE_TYPE VARCHAR, SCHEDULE VARCHAR, DAILY_DOSE_UNITS FLOAT, MONTHLY_COST_USD FLOAT
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

TRUNCATE TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_DRUG_FORMULARY;

INSERT INTO FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_DRUG_FORMULARY VALUES
(1,'Metformin','Diabetes','Standard','None',2,15),(2,'Insulin Glargine','Diabetes','Cold Chain','None',1,320),
(3,'Sitagliptin','Diabetes','Standard','None',1,420),(4,'Empagliflozin','Diabetes','Standard','None',1,550),
(5,'Dulaglutide','Diabetes','Cold Chain','None',0.25,850),(6,'Lisinopril','Hypertension','Standard','None',1,12),
(7,'Amlodipine','Hypertension','Standard','None',1,18),(8,'Losartan','Hypertension','Standard','None',1,22),
(9,'Hydrochlorothiazide','Hypertension','Standard','None',1,8),(10,'Metoprolol','Hypertension','Standard','None',2,15),
(11,'Atorvastatin','Cardiovascular','Standard','None',1,14),(12,'Clopidogrel','Cardiovascular','Standard','None',1,28),
(13,'Warfarin','Cardiovascular','Standard','Schedule V',1,18),(14,'Apixaban','Cardiovascular','Standard','None',2,480),
(15,'Rosuvastatin','Cardiovascular','Standard','None',1,22),(16,'Albuterol','Respiratory','Standard','None',4,35),
(17,'Fluticasone','Respiratory','Standard','None',2,185),(18,'Montelukast','Respiratory','Standard','None',1,155),
(19,'Tiotropium','Respiratory','Standard','None',1,420),(20,'Budesonide/Formoterol','Respiratory','Standard','None',2,380),
(21,'Oxycodone','Pain','Standard','Schedule II',3,45),(22,'Gabapentin','Pain','Standard','Schedule V',3,28),
(23,'Tramadol','Pain','Standard','Schedule IV',3,35),(24,'Celecoxib','Pain','Standard','None',1,220),
(25,'Diazepam','Anxiety','Standard','Schedule IV',2,12);

-- 7d. SF_PHARMA_JOBS (30 pre-geocoded delivery stops for pharma optimization)
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_PHARMA_JOBS (
  JOB_ID INT, PHARMACY_NAME VARCHAR, ADDRESS VARCHAR, LATITUDE FLOAT, LONGITUDE FLOAT, SKILL INT, PRODUCT_TYPE VARCHAR, TIME_WINDOW_START INT, TIME_WINDOW_END INT
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

TRUNCATE TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_PHARMA_JOBS;

INSERT INTO FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_PHARMA_JOBS VALUES
(1,'Walgreens Castro','498 Castro St',37.7609,-122.4350,1,'Cold Chain',28800,36000),
(2,'Walgreens Castro','498 Castro St',37.7609,-122.4350,2,'Controlled',28800,36000),
(3,'Walgreens Castro','498 Castro St',37.7609,-122.4350,3,'Standard',28800,43200),
(4,'Walgreens Castro','498 Castro St',37.7609,-122.4350,3,'Standard',28800,43200),
(5,'Walgreens Castro','498 Castro St',37.7609,-122.4350,1,'Cold Chain',36000,43200),
(6,'CVS Geary','2676 Geary Blvd',37.7828,-122.4449,1,'Cold Chain',28800,36000),
(7,'CVS Geary','2676 Geary Blvd',37.7828,-122.4449,3,'Standard',28800,43200),
(8,'CVS Geary','2676 Geary Blvd',37.7828,-122.4449,3,'Standard',28800,43200),
(9,'CVS Geary','2676 Geary Blvd',37.7828,-122.4449,2,'Controlled',36000,43200),
(10,'CVS Geary','2676 Geary Blvd',37.7828,-122.4449,1,'Cold Chain',36000,43200),
(11,'Walgreens Mission','2690 Mission St',37.7544,-122.4188,1,'Cold Chain',28800,36000),
(12,'Walgreens Mission','2690 Mission St',37.7544,-122.4188,3,'Standard',28800,43200),
(13,'Walgreens Mission','2690 Mission St',37.7544,-122.4188,3,'Standard',36000,43200),
(14,'Walgreens Mission','2690 Mission St',37.7544,-122.4188,2,'Controlled',28800,36000),
(15,'Walgreens Mission','2690 Mission St',37.7544,-122.4188,3,'Standard',36000,50400),
(16,'Rite Aid Clement','801 Clement St',37.7831,-122.4651,1,'Cold Chain',28800,36000),
(17,'Rite Aid Clement','801 Clement St',37.7831,-122.4651,3,'Standard',28800,43200),
(18,'Rite Aid Clement','801 Clement St',37.7831,-122.4651,3,'Standard',28800,43200),
(19,'Rite Aid Clement','801 Clement St',37.7831,-122.4651,2,'Controlled',36000,43200),
(20,'Rite Aid Clement','801 Clement St',37.7831,-122.4651,1,'Cold Chain',36000,50400),
(21,'Walgreens Divisadero','2141 Divisadero St',37.7880,-122.4397,1,'Cold Chain',28800,36000),
(22,'Walgreens Divisadero','2141 Divisadero St',37.7880,-122.4397,3,'Standard',28800,43200),
(23,'Walgreens Divisadero','2141 Divisadero St',37.7880,-122.4397,2,'Controlled',28800,36000),
(24,'Walgreens Divisadero','2141 Divisadero St',37.7880,-122.4397,3,'Standard',36000,43200),
(25,'Walgreens Divisadero','2141 Divisadero St',37.7880,-122.4397,1,'Cold Chain',36000,50400),
(26,'CVS Van Ness','1000 Van Ness Ave',37.7853,-122.4222,1,'Cold Chain',28800,36000),
(27,'CVS Van Ness','1000 Van Ness Ave',37.7853,-122.4222,3,'Standard',28800,43200),
(28,'CVS Van Ness','1000 Van Ness Ave',37.7853,-122.4222,3,'Standard',28800,43200),
(29,'CVS Van Ness','1000 Van Ness Ave',37.7853,-122.4222,2,'Controlled',36000,43200),
(30,'CVS Van Ness','1000 Van Ness Ave',37.7853,-122.4222,1,'Cold Chain',36000,50400);

SELECT 'Seed data loaded successfully (including agent playground demo data)' AS STATUS;
