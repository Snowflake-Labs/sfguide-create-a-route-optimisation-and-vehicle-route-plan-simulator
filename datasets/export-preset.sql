--------------------------------------------------------------------------------
-- export-preset.sql
-- Export a Data Studio preset's rows from SYNTHETIC_DATASETS.UNIFIED to
-- @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/synthetic_ebikes/ as parquet.
--
-- Usage:
--   1. Set JOB_ID below to the completed GENERATION_JOBS.JOB_ID
--   2. snow sql -c fleet_test_evals -f datasets/export-preset.sql
--   3. snow stage copy @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/synthetic_ebikes/ \
--        datasets/synthetic_ebikes/ -c fleet_test_evals --recursive
--------------------------------------------------------------------------------

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

USE WAREHOUSE ROUTING_ANALYTICS;

SET JOB_ID = '38faa5fc-ed43-4259-98f1-91b99f18c527';

CREATE STAGE IF NOT EXISTS OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

--------------------------------------------------------------------------------
-- FACT_VEHICLE_TELEMETRY
--------------------------------------------------------------------------------
COPY INTO @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/synthetic_ebikes/fact_vehicle_telemetry/
FROM (
  SELECT
    TELEMETRY_ID, REGION, VEHICLE_TYPE, VEHICLE_ID, TRIP_ID, TS,
    LATITUDE, LONGITUDE,
    ST_ASWKT(POINT_GEOM) AS POINT_GEOM_WKT,
    SPEED_KMH, HEADING_DEG, POSTED_SPEED_KMH, STATUS,
    IS_SPEEDING, IS_HOS_VIOLATION, IS_DETOUR, GPS_ACCURACY_M,
    LOCATION_ID, LOCATION_TYPE, ORS_PROFILE, BATTERY_PCT, ODOMETER_KM,
    POINT_INDEX, JOB_ID
  FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY
  WHERE JOB_ID = $JOB_ID
)
FILE_FORMAT = (TYPE = PARQUET COMPRESSION = SNAPPY)
HEADER = TRUE
OVERWRITE = TRUE
MAX_FILE_SIZE = 134217728;

--------------------------------------------------------------------------------
-- FACT_TRIPS
--------------------------------------------------------------------------------
COPY INTO @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/synthetic_ebikes/fact_trips/
FROM (
  SELECT
    TRIP_ID, VEHICLE_ID, DRIVER_ID, VEHICLE_TYPE, REGION,
    ORIGIN_POI_ID, DESTINATION_POI_ID,
    ORIGIN_LAT, ORIGIN_LON,
    ST_ASWKT(ORIGIN) AS ORIGIN_WKT,
    DESTINATION_LAT, DESTINATION_LON,
    ST_ASWKT(DESTINATION) AS DESTINATION_WKT,
    ST_ASWKT(ROUTE_GEOG) AS ROUTE_GEOG_WKT,
    DISTANCE_KM, DURATION_MINUTES,
    ST_ASWKT(PLANNED_ROUTE_GEOG) AS PLANNED_ROUTE_GEOG_WKT,
    PLANNED_DISTANCE_KM, IS_DETOUR, DETOUR_DISTANCE_KM,
    TRIP_START, TRIP_END, STATUS, ORS_PROFILE, JOB_ID
  FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS
  WHERE JOB_ID = $JOB_ID
)
FILE_FORMAT = (TYPE = PARQUET COMPRESSION = SNAPPY)
HEADER = TRUE
OVERWRITE = TRUE
MAX_FILE_SIZE = 134217728;

--------------------------------------------------------------------------------
-- DIM_FLEET (no GEOGRAPHY)
--------------------------------------------------------------------------------
COPY INTO @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/synthetic_ebikes/dim_fleet/
FROM (
  SELECT *
  FROM SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET
  WHERE JOB_ID = $JOB_ID
)
FILE_FORMAT = (TYPE = PARQUET COMPRESSION = SNAPPY)
HEADER = TRUE
OVERWRITE = TRUE;

--------------------------------------------------------------------------------
-- DIM_POIS
--------------------------------------------------------------------------------
COPY INTO @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/synthetic_ebikes/dim_pois/
FROM (
  SELECT
    LOCATION_ID, REGION, NAME, LOCATION_TYPE, CATEGORY, LAT, LNG,
    ST_ASWKT(POINT_GEOM) AS POINT_GEOM_WKT,
    SOURCE, JOB_ID
  FROM SYNTHETIC_DATASETS.UNIFIED.DIM_POIS
  WHERE JOB_ID = $JOB_ID
)
FILE_FORMAT = (TYPE = PARQUET COMPRESSION = SNAPPY)
HEADER = TRUE
OVERWRITE = TRUE;

--------------------------------------------------------------------------------
-- FACT_OFFERS
--------------------------------------------------------------------------------
COPY INTO @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/synthetic_ebikes/fact_offers/
FROM (
  SELECT
    OFFER_ID, REGION, VEHICLE_TYPE, SOURCE,
    PICKUP_POI_ID, PICKUP_LAT, PICKUP_LON,
    ST_ASWKT(PICKUP_GEOM) AS PICKUP_GEOM_WKT,
    DROPOFF_POI_ID, DROPOFF_LAT, DROPOFF_LON,
    ST_ASWKT(DROPOFF_GEOM) AS DROPOFF_GEOM_WKT,
    PICKUP_FROM_TS, PICKUP_TO_TS, WEIGHT_KG, PRODUCT, PRICE_USD, HAZMAT,
    LISTING_TEXT, POSTED_AT, JOB_ID,
    VEHICLE_EQUIPMENT, DISTANCE_KM, PRICE_PER_KM_USD, PARTNER_ID, STATUS
  FROM SYNTHETIC_DATASETS.UNIFIED.FACT_OFFERS
  WHERE JOB_ID = $JOB_ID
)
FILE_FORMAT = (TYPE = PARQUET COMPRESSION = SNAPPY)
HEADER = TRUE
OVERWRITE = TRUE;

--------------------------------------------------------------------------------
-- DIM_PARTNERS
--------------------------------------------------------------------------------
COPY INTO @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/synthetic_ebikes/dim_partners/
FROM (
  SELECT *
  FROM SYNTHETIC_DATASETS.UNIFIED.DIM_PARTNERS
  WHERE JOB_ID = $JOB_ID
)
FILE_FORMAT = (TYPE = PARQUET COMPRESSION = SNAPPY)
HEADER = TRUE
OVERWRITE = TRUE;

--------------------------------------------------------------------------------
-- FACT_PARTNER_HISTORY
--------------------------------------------------------------------------------
COPY INTO @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/synthetic_ebikes/fact_partner_history/
FROM (
  SELECT *
  FROM SYNTHETIC_DATASETS.UNIFIED.FACT_PARTNER_HISTORY
  WHERE JOB_ID = $JOB_ID
)
FILE_FORMAT = (TYPE = PARQUET COMPRESSION = SNAPPY)
HEADER = TRUE
OVERWRITE = TRUE;

--------------------------------------------------------------------------------
-- DIM_TRIP_SCHEDULE
--------------------------------------------------------------------------------
COPY INTO @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/synthetic_ebikes/dim_trip_schedule/
FROM (
  SELECT *
  FROM SYNTHETIC_DATASETS.UNIFIED.DIM_TRIP_SCHEDULE
  WHERE JOB_ID = $JOB_ID
)
FILE_FORMAT = (TYPE = PARQUET COMPRESSION = SNAPPY)
HEADER = TRUE
OVERWRITE = TRUE;

--------------------------------------------------------------------------------
-- PLACES (GEOMETRY=GEOGRAPHY, ADDRESS/ALTERNATE=VARIANT)
--------------------------------------------------------------------------------
COPY INTO @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/synthetic_ebikes/places/
FROM (
  SELECT
    REGION,
    ST_ASWKT(GEOMETRY) AS GEOMETRY_WKT,
    PHONES,
    CATEGORY,
    NAME,
    TO_JSON(ADDRESS) AS ADDRESS_JSON,
    TO_JSON(ALTERNATE) AS ALTERNATE_JSON,
    JOB_ID
  FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES
  WHERE JOB_ID = $JOB_ID
)
FILE_FORMAT = (TYPE = PARQUET COMPRESSION = SNAPPY)
HEADER = TRUE
OVERWRITE = TRUE;

--------------------------------------------------------------------------------
-- LOOKUP (ARRAY columns -> JSON strings)
--------------------------------------------------------------------------------
COPY INTO @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/synthetic_ebikes/lookup/
FROM (
  SELECT
    REGION,
    INDUSTRY,
    PA,
    PB,
    PC,
    TO_JSON(IND) AS IND_JSON,
    TO_JSON(IND2) AS IND2_JSON,
    TO_JSON(CTYPE) AS CTYPE_JSON,
    TO_JSON(STYPE) AS STYPE_JSON,
    SOURCE_TABLE,
    TO_JSON(DEPOT_CTYPE) AS DEPOT_CTYPE_JSON,
    DEPOT_LABEL,
    JOB_ID
  FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP
  WHERE JOB_ID = $JOB_ID
)
FILE_FORMAT = (TYPE = PARQUET COMPRESSION = SNAPPY)
HEADER = TRUE
OVERWRITE = TRUE;

--------------------------------------------------------------------------------
-- FACT_OFFER_ROUTES
--------------------------------------------------------------------------------
COPY INTO @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/synthetic_ebikes/fact_offer_routes/
FROM (
  SELECT *
  FROM FLEET_INTELLIGENCE.MARKETPLACE.FACT_OFFER_ROUTES
  WHERE JOB_ID = $JOB_ID
)
FILE_FORMAT = (TYPE = PARQUET COMPRESSION = SNAPPY)
HEADER = TRUE
OVERWRITE = TRUE;

--------------------------------------------------------------------------------
-- DIM_ANCHORS (universal-generation; GEOM=GEOGRAPHY)
--------------------------------------------------------------------------------
COPY INTO @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/synthetic_ebikes/dim_anchors/
FROM (
  SELECT
    ANCHOR_ID, REGION, ANCHOR_TYPE, NAME, CATEGORY, LAT, LNG,
    ST_ASWKT(GEOM) AS GEOM_WKT,
    ADDRESS, CITY, STATE, POSTCODE, SOURCE, JOB_ID
  FROM SYNTHETIC_DATASETS.UNIFIED.DIM_ANCHORS
  WHERE JOB_ID = $JOB_ID
)
FILE_FORMAT = (TYPE = PARQUET COMPRESSION = SNAPPY)
HEADER = TRUE
OVERWRITE = TRUE;

--------------------------------------------------------------------------------
-- FACT_HAZARD_ZONES (universal-generation; GEOM=GEOGRAPHY)
--------------------------------------------------------------------------------
COPY INTO @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/synthetic_ebikes/fact_hazard_zones/
FROM (
  SELECT
    ZONE_ID, REGION, STATE, COUNTY, FIPS, HAZARD_TYPE, RISK_SCORE, RISK_RATING, RISK_LEVEL,
    ST_ASWKT(GEOM) AS GEOM_WKT,
    SOURCE, JOB_ID
  FROM SYNTHETIC_DATASETS.UNIFIED.FACT_HAZARD_ZONES
  WHERE JOB_ID = $JOB_ID
)
FILE_FORMAT = (TYPE = PARQUET COMPRESSION = SNAPPY)
HEADER = TRUE
OVERWRITE = TRUE;

--------------------------------------------------------------------------------
-- DIM_AREA_DEMOGRAPHICS (universal-generation; GEOM=GEOGRAPHY)
--------------------------------------------------------------------------------
COPY INTO @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/synthetic_ebikes/dim_area_demographics/
FROM (
  SELECT
    AREA_ID, REGION, AREA_TYPE, STATE_FIPS, COUNTY_FIPS, LAT, LNG,
    ST_ASWKT(GEOM) AS GEOM_WKT,
    TOTAL_POPULATION, MEDIAN_AGE, MEDIAN_HOUSEHOLD_INCOME,
    POP_ELDERLY, POP_CHILDREN, POPULATION_DENSITY, SOURCE, JOB_ID
  FROM SYNTHETIC_DATASETS.UNIFIED.DIM_AREA_DEMOGRAPHICS
  WHERE JOB_ID = $JOB_ID
)
FILE_FORMAT = (TYPE = PARQUET COMPRESSION = SNAPPY)
HEADER = TRUE
OVERWRITE = TRUE;

--------------------------------------------------------------------------------
-- DIM_DEMAND_CATALOG (universal-generation; no GEOGRAPHY)
--------------------------------------------------------------------------------
COPY INTO @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/synthetic_ebikes/dim_demand_catalog/
FROM (
  SELECT *
  FROM SYNTHETIC_DATASETS.UNIFIED.DIM_DEMAND_CATALOG
  WHERE JOB_ID = $JOB_ID
)
FILE_FORMAT = (TYPE = PARQUET COMPRESSION = SNAPPY)
HEADER = TRUE
OVERWRITE = TRUE;

--------------------------------------------------------------------------------
-- DIM_PARTICIPANTS (universal-generation; GEOM=GEOGRAPHY)
--------------------------------------------------------------------------------
COPY INTO @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/synthetic_ebikes/dim_participants/
FROM (
  SELECT
    PARTICIPANT_ID, REGION, LAT, LNG,
    ST_ASWKT(GEOM) AS GEOM_WKT,
    ADDRESS, CITY, STATE, POSTCODE, NEAREST_ANCHOR_ID, SOURCE, JOB_ID
  FROM SYNTHETIC_DATASETS.UNIFIED.DIM_PARTICIPANTS
  WHERE JOB_ID = $JOB_ID
)
FILE_FORMAT = (TYPE = PARQUET COMPRESSION = SNAPPY)
HEADER = TRUE
OVERWRITE = TRUE;

SELECT 'Export complete for JOB_ID=' || $JOB_ID AS STATUS;
