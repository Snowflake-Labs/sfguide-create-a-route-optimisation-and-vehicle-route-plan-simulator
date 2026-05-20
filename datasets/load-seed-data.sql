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

--------------------------------------------------------------------------------
-- 3a-bis. REGION_REGISTRY_V (joins REGION_REGISTRY to REGION_CATALOG so
--          downstream consumers see real region polygons + ISO codes from
--          the shipped boundary snapshot. Falls back to bbox if no catalog
--          row exists yet for a manually-added region.)
--------------------------------------------------------------------------------
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.CORE.REGION_REGISTRY_V
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
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
  ON rc.LOOKUP_NAME = rr.ORS_REGION_KEY
  OR rc.REGION_KEY  = rr.ORS_REGION_KEY;

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
-- 5. FACT_FREIGHT_OFFERS (synthesized from DIM_POIS pairs)
--    300 deterministic offers per region present in DIM_POIS so the
--    backload-matching skill works out of the box. Idempotent: skips regions
--    that already have offers. New presets generated by Data Studio (>=v1.0.199)
--    populate this table natively from engine.generateFreightOffers.
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS SYNTHETIC_DATASETS.UNIFIED.FACT_FREIGHT_OFFERS (
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
  JOB_ID           VARCHAR
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

INSERT INTO SYNTHETIC_DATASETS.UNIFIED.FACT_FREIGHT_OFFERS (
  OFFER_ID, REGION, VEHICLE_TYPE, SOURCE,
  PICKUP_POI_ID, PICKUP_LAT, PICKUP_LON, PICKUP_GEOM,
  DROPOFF_POI_ID, DROPOFF_LAT, DROPOFF_LON, DROPOFF_GEOM,
  PICKUP_FROM_TS, PICKUP_TO_TS, WEIGHT_KG, PRODUCT, PRICE_USD,
  HAZMAT, LISTING_TEXT, POSTED_AT, JOB_ID
)
WITH targets AS (
  SELECT DISTINCT
    p.REGION,
    COALESCE(t.VEHICLE_TYPE, 'ebike') AS VEHICLE_TYPE,
    p.JOB_ID
  FROM SYNTHETIC_DATASETS.UNIFIED.DIM_POIS p
  LEFT JOIN SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS t ON t.JOB_ID = p.JOB_ID
  WHERE p.REGION NOT IN (SELECT DISTINCT REGION FROM SYNTHETIC_DATASETS.UNIFIED.FACT_FREIGHT_OFFERS WHERE REGION IS NOT NULL)
),
pois_numbered AS (
  SELECT p.REGION, p.JOB_ID, p.LOCATION_ID, p.NAME, p.LAT, p.LNG, p.POINT_GEOM,
         ROW_NUMBER() OVER (PARTITION BY p.REGION ORDER BY p.LOCATION_ID) AS RN,
         COUNT(*)   OVER (PARTITION BY p.REGION) AS C
  FROM SYNTHETIC_DATASETS.UNIFIED.DIM_POIS p
  JOIN targets t ON t.REGION = p.REGION
),
seq AS (
  SELECT t.REGION, t.VEHICLE_TYPE, t.JOB_ID, g.S
  FROM targets t
  CROSS JOIN (SELECT SEQ4()+1 AS S FROM TABLE(GENERATOR(ROWCOUNT => 300))) g
),
pairs AS (
  SELECT s.REGION, s.VEHICLE_TYPE, s.JOB_ID, s.S,
         p.LOCATION_ID AS P_ID, p.LNG AS P_LON, p.LAT AS P_LAT, p.POINT_GEOM AS P_GEOM, p.NAME AS P_NAME,
         q.LOCATION_ID AS Q_ID, q.LNG AS Q_LON, q.LAT AS Q_LAT, q.POINT_GEOM AS Q_GEOM, q.NAME AS Q_NAME
  FROM seq s
  JOIN pois_numbered p ON p.REGION = s.REGION AND p.RN = MOD(s.S * 7,  p.C) + 1
  JOIN pois_numbered q ON q.REGION = s.REGION AND q.RN = MOD(s.S * 13 + 5, q.C) + 1
  WHERE p.LOCATION_ID <> q.LOCATION_ID
)
SELECT
  'OFF-' || LPAD(S::VARCHAR, 6, '0')                                                            AS OFFER_ID,
  REGION, VEHICLE_TYPE,
  CASE WHEN LOWER(REGION) LIKE '%germany%' OR LOWER(REGION) LIKE '%europe%'
       THEN DECODE(MOD(S, 4), 0,'TIMOCOM', 1,'WTRANSNET', 2,'TELEROUTE', 3,'B2P')
       ELSE DECODE(MOD(S, 4), 0,'DAT', 1,'TRUCKSTOP', 2,'CONVOY', 3,'UBER_FREIGHT')
  END                                                                                            AS SOURCE,
  P_ID, P_LAT, P_LON, P_GEOM,
  Q_ID, Q_LAT, Q_LON, Q_GEOM,
  DATEADD(MINUTE, MOD(S * 73,  1100) + 60,  CURRENT_TIMESTAMP())                                  AS PICKUP_FROM_TS,
  DATEADD(MINUTE, MOD(S * 73,  1100) + 360, CURRENT_TIMESTAMP())                                  AS PICKUP_TO_TS,
  (800 + MOD(ABS(HASH(P_ID || Q_ID)), 24000))::NUMBER                                             AS WEIGHT_KG,
  DECODE(MOD(S, 6), 0,'Pallets (general)', 1,'Steel coils', 2,'Plastic granulate',
                    3,'Beverages', 4,'Furniture', 5,'Bulk paper')                                 AS PRODUCT,
  (400 + MOD(ABS(HASH(Q_ID || P_ID)), 4000))::NUMBER                                              AS PRICE_USD,
  MOD(S, 13) = 0                                                                                  AS HAZMAT,
  CASE WHEN LOWER(REGION) LIKE '%germany%' OR LOWER(REGION) LIKE '%europe%'
       THEN DECODE(MOD(S, 4), 0,'TIMOCOM', 1,'WTRANSNET', 2,'TELEROUTE', 3,'B2P')
       ELSE DECODE(MOD(S, 4), 0,'DAT', 1,'TRUCKSTOP', 2,'CONVOY', 3,'UBER_FREIGHT')
  END || ' ' || P_NAME || ' -> ' || Q_NAME                                                        AS LISTING_TEXT,
  CURRENT_TIMESTAMP()                                                                             AS POSTED_AT,
  JOB_ID
FROM pairs;


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

SELECT 'Seed data loaded successfully' AS STATUS;
