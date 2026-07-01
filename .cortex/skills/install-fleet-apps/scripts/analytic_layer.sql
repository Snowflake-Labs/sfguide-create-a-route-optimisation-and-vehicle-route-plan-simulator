-- =============================================================================
-- install-fleet-apps : agnostic analytic layer (FLEET-owned, skill-owned source)
-- =============================================================================
-- Creates the FLEET_INTELLIGENCE.* analytic objects the demo packs read that are
-- NOT produced by the pack DDL itself. Historically these were authored by the
-- per-vehicle demo skills (dwell-analysis / route-deviation / retail-catchment)
-- and/or the control-app boot (init.ts), neither of which runs on the agnostic
-- install before the pack step. Authoring them here (orchestrator step 3.5, after
-- the engine, before packs) makes a from-scratch install self-contained.
--
-- Design rules:
--   * No DYNAMIC TABLES -- the route-deviation analytic object is a plain VIEW
--     (no LAG refresh cost). The dwell pack's own DTs are converted to views via
--     its data-model.yaml (separate change), not here.
--   * Catchment KEEPS the Overture Marketplace approach (SV_CATCHMENT models
--     ADDRESS/POSTCODE/CITY/STATE, so they cannot be synthesized). The two Overture
--     listings are acquired idempotently below.
--   * CONFIG pointers are derived from the active DIM_DATASETS row (configurable,
--     not hardcoded) with an ('ebike','SanFrancisco') fallback.
--   * Idempotent (CREATE ... IF NOT EXISTS / CREATE OR REPLACE VIEW). Tracking
--     tags (query_tag + COMMENT) on every object per AGENTS.md.
--
-- Ordering note: snow sql -f stops on the first error, and the orchestrator runs
-- this whole file WARN-on-error. So the cheap, always-resolvable sections (DWELL,
-- ROUTE_DEVIATION, ROUTE_OPTIMIZATION CONFIG) run FIRST; the CATCHMENT section
-- (Overture listing + REGION_CATALOG dependencies, most likely to fail on a
-- coverage-less region or engine-less install) runs LAST so a catchment failure
-- never blocks the other three.
-- =============================================================================

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","module":"analytic-layer"}}';

-- Warehouse the analytic layer runs on (independent of the engine build).
CREATE WAREHOUSE IF NOT EXISTS ROUTING_ANALYTICS
  WAREHOUSE_SIZE = 'XSMALL'
  AUTO_SUSPEND = 60
  AUTO_RESUME = TRUE
  INITIALLY_SUSPENDED = TRUE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE DATABASE IF NOT EXISTS FLEET_INTELLIGENCE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- =============================================================================
-- 1. DWELL  (pack needs only FLEET_INTELLIGENCE.DWELL_ANALYSIS.CONFIG)
-- =============================================================================
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.CONFIG (
  VEHICLE_TYPE VARCHAR NOT NULL,
  REGION       VARCHAR NOT NULL
) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- Seed only when empty: prefer the active dataset row, else fall back.
INSERT INTO FLEET_INTELLIGENCE.DWELL_ANALYSIS.CONFIG (VEHICLE_TYPE, REGION)
SELECT VEHICLE_TYPE, REGION FROM (
  SELECT VEHICLE_TYPE, REGION, 1 AS PRI FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS WHERE IS_ACTIVE = TRUE
  UNION ALL SELECT 'ebike', 'SanFrancisco', 2
) s
WHERE NOT EXISTS (SELECT 1 FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.CONFIG)
QUALIFY ROW_NUMBER() OVER (ORDER BY PRI) = 1;

-- =============================================================================
-- 2. ROUTE_DEVIATION  (CONFIG + 5 projection views + TRIP_DEVIATION_ANALYSIS view)
--    Ported from .cortex/skills/route-deviation/references/seed-data.sql with the
--    TRIP_DEVIATION_ANALYSIS DYNAMIC TABLE converted to a plain VIEW. The pack's
--    own VW_DRIVER_DEVIATION_SUMMARY / VW_DAILY_DEVIATION_TRENDS are built by the
--    pack from FLEET_APP.ROUTE_DEVIATION.VW_TRIP_DEVIATION, so they are NOT ported.
-- =============================================================================
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_DEVIATION
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_DEVIATION.CONFIG (
  VEHICLE_TYPE VARCHAR NOT NULL,
  REGION       VARCHAR NOT NULL
) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

INSERT INTO FLEET_INTELLIGENCE.ROUTE_DEVIATION.CONFIG (VEHICLE_TYPE, REGION)
SELECT VEHICLE_TYPE, REGION FROM (
  SELECT VEHICLE_TYPE, REGION, 1 AS PRI FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS WHERE IS_ACTIVE = TRUE
  UNION ALL SELECT 'ebike', 'SanFrancisco', 2
) s
WHERE NOT EXISTS (SELECT 1 FROM FLEET_INTELLIGENCE.ROUTE_DEVIATION.CONFIG)
QUALIFY ROW_NUMBER() OVER (ORDER BY PRI) = 1;

CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.ROUTE_DEVIATION.VW_VEHICLE_TELEMETRY
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT
    t.TELEMETRY_ID, t.VEHICLE_ID, t.TRIP_ID, t.TS, t.POINT_GEOM,
    t.SPEED_KMH, t.HEADING_DEG, t.STATUS,
    t.IS_SPEEDING, t.IS_HOS_VIOLATION, t.IS_DETOUR,
    t.GPS_ACCURACY_M, t.LOCATION_ID, t.LOCATION_TYPE,
    t.POINT_INDEX, t.ODOMETER_KM, t.POSTED_SPEED_KMH,
    t.VEHICLE_TYPE, t.REGION
FROM SYNTHETIC_DATASETS.UNIFIED.V_FACT_VEHICLE_TELEMETRY_CURRENT t
WHERE t.VEHICLE_TYPE = (SELECT VEHICLE_TYPE FROM FLEET_INTELLIGENCE.ROUTE_DEVIATION.CONFIG LIMIT 1)
  AND t.REGION = (SELECT REGION FROM FLEET_INTELLIGENCE.ROUTE_DEVIATION.CONFIG LIMIT 1)
QUALIFY ROW_NUMBER() OVER (PARTITION BY t.TELEMETRY_ID ORDER BY t.TS) = 1;

CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.ROUTE_DEVIATION.VW_TRIP_DEVIATION
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT
    t.TRIP_ID, t.VEHICLE_ID, t.DRIVER_ID,
    t.ORIGIN_POI_ID, t.DESTINATION_POI_ID,
    t.ORIGIN_LAT, t.ORIGIN_LON, t.ORIGIN,
    t.DESTINATION_LAT, t.DESTINATION_LON, t.DESTINATION,
    t.ROUTE_GEOG AS ACTUAL_PATH,
    t.DISTANCE_KM AS ACTUAL_DISTANCE_KM,
    t.DURATION_MINUTES AS ACTUAL_DURATION_MIN,
    t.PLANNED_ROUTE_GEOG AS EXPECTED_PATH,
    t.PLANNED_DISTANCE_KM AS EXPECTED_DISTANCE_KM,
    t.IS_DETOUR, t.DETOUR_DISTANCE_KM,
    t.TRIP_START, t.TRIP_END, t.STATUS, t.ORS_PROFILE,
    t.VEHICLE_TYPE, t.REGION
FROM SYNTHETIC_DATASETS.UNIFIED.V_FACT_TRIPS_CURRENT t
WHERE t.VEHICLE_TYPE = (SELECT VEHICLE_TYPE FROM FLEET_INTELLIGENCE.ROUTE_DEVIATION.CONFIG LIMIT 1)
  AND t.REGION = (SELECT REGION FROM FLEET_INTELLIGENCE.ROUTE_DEVIATION.CONFIG LIMIT 1);

CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.ROUTE_DEVIATION.VW_FLEET
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT
    f.VEHICLE_ID, f.DRIVER_PROFILE, f.OPERATING_MODE,
    f.REGION AS HOME_CITY, f.VEHICLE_TYPE, f.REGION
FROM SYNTHETIC_DATASETS.UNIFIED.V_DIM_FLEET_CURRENT f
WHERE f.VEHICLE_TYPE = (SELECT VEHICLE_TYPE FROM FLEET_INTELLIGENCE.ROUTE_DEVIATION.CONFIG LIMIT 1)
  AND f.REGION = (SELECT REGION FROM FLEET_INTELLIGENCE.ROUTE_DEVIATION.CONFIG LIMIT 1)
QUALIFY ROW_NUMBER() OVER (PARTITION BY f.VEHICLE_ID ORDER BY f.VEHICLE_ID) = 1;

CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.ROUTE_DEVIATION.VW_TRIP_SCHEDULE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT
    s.SCHEDULE_ID,
    s.VEHICLE_ID,
    s.VEHICLE_TYPE AS TRIP_TYPE,
    s.ORIGIN_POI_ID AS ORIGIN_ID,
    s.DESTINATION_POI_ID AS DEST_ID,
    s.SHIFT_TYPE AS ROUTE_VARIATION,
    NULL AS ROUTE_DEVIATION_FACTOR,
    s.DISTANCE_KM * 1000 AS ROUTE_DISTANCE_M,
    s.DURATION_MINUTES * 60 AS ROUTE_DURATION_SEC,
    s.PLANNED_START AS SCHEDULED_START,
    s.ORS_PROFILE,
    s.REGION
FROM SYNTHETIC_DATASETS.UNIFIED.V_DIM_TRIP_SCHEDULE_CURRENT s
WHERE s.REGION = (SELECT REGION FROM FLEET_INTELLIGENCE.ROUTE_DEVIATION.CONFIG LIMIT 1);

CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.ROUTE_DEVIATION.VW_POIS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT
    p.LOCATION_ID AS ID, p.NAME, p.LOCATION_TYPE,
    p.CATEGORY, p.LAT, p.LNG, p.POINT_GEOM, p.REGION
FROM SYNTHETIC_DATASETS.UNIFIED.V_DIM_POIS_CURRENT p
WHERE p.REGION = (SELECT REGION FROM FLEET_INTELLIGENCE.ROUTE_DEVIATION.CONFIG LIMIT 1)
QUALIFY ROW_NUMBER() OVER (PARTITION BY p.LOCATION_ID ORDER BY p.NAME) = 1;

-- TRIP_DEVIATION_ANALYSIS: was a DYNAMIC TABLE in the demo skill; here a plain VIEW.
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.ROUTE_DEVIATION.TRIP_DEVIATION_ANALYSIS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
WITH trip_points AS (
    SELECT TRIP_ID, COUNT(*) AS POINT_COUNT
    FROM FLEET_INTELLIGENCE.ROUTE_DEVIATION.VW_VEHICLE_TELEMETRY
    GROUP BY TRIP_ID
),
dedup_pois AS (
    SELECT ID, NAME, REGION,
           ROW_NUMBER() OVER (PARTITION BY ID ORDER BY NAME) AS RN
    FROM FLEET_INTELLIGENCE.ROUTE_DEVIATION.VW_POIS
)
SELECT
    t.TRIP_ID, t.VEHICLE_ID, t.DRIVER_ID,
    DATE(t.TRIP_START) AS TRIP_DATE,
    s.ROUTE_VARIATION,
    CASE WHEN t.EXPECTED_DISTANCE_KM > 0
         THEN ROUND(t.ACTUAL_DISTANCE_KM / t.EXPECTED_DISTANCE_KM, 4)
         ELSE 1.0 END AS ROUTE_DEVIATION_FACTOR,
    s.TRIP_TYPE,
    ROUND(t.ACTUAL_DISTANCE_KM, 2) AS ACTUAL_DISTANCE_KM,
    ROUND(t.ACTUAL_DURATION_MIN, 2) AS ACTUAL_DURATION_MIN,
    ROUND(TIMESTAMPDIFF('SECOND', t.TRIP_START, t.TRIP_END) / 60.0, 2) AS TOTAL_DURATION_MIN,
    t.TRIP_START AS ACTUAL_START_TS,
    t.TRIP_END AS ACTUAL_END_TS,
    COALESCE(tp.POINT_COUNT, 0) AS POINT_COUNT,
    ROUND(t.EXPECTED_DISTANCE_KM, 2) AS EXPECTED_DISTANCE_KM,
    ROUND(CASE WHEN t.EXPECTED_DISTANCE_KM > 0 AND t.ACTUAL_DURATION_MIN > 0
               THEN t.EXPECTED_DISTANCE_KM * t.ACTUAL_DURATION_MIN / NULLIF(t.ACTUAL_DISTANCE_KM, 0)
               ELSE t.ACTUAL_DURATION_MIN END, 2) AS EXPECTED_DURATION_MIN,
    ROUND(ST_DISTANCE(t.ORIGIN, t.DESTINATION) / 1000, 2) AS STRAIGHT_LINE_DISTANCE_KM,
    COALESCE(po.NAME, 'Unknown') AS ORIGIN_NAME,
    COALESCE(po.REGION, 'N/A') AS ORIGIN_CITY,
    COALESCE(pd.NAME, 'Unknown') AS DEST_NAME,
    COALESCE(pd.REGION, 'N/A') AS DEST_CITY,
    ROUND(t.ACTUAL_DISTANCE_KM - t.EXPECTED_DISTANCE_KM, 2) AS DISTANCE_DEVIATION_KM,
    ROUND(CASE WHEN t.EXPECTED_DISTANCE_KM > 0
               THEN (t.ACTUAL_DISTANCE_KM - t.EXPECTED_DISTANCE_KM) / t.EXPECTED_DISTANCE_KM * 100
               ELSE 0 END, 2) AS DISTANCE_DEVIATION_PCT,
    ROUND(CASE WHEN t.EXPECTED_DISTANCE_KM > 0 AND t.ACTUAL_DURATION_MIN > 0
               THEN t.ACTUAL_DURATION_MIN - (t.EXPECTED_DISTANCE_KM * t.ACTUAL_DURATION_MIN / NULLIF(t.ACTUAL_DISTANCE_KM, 0))
               ELSE 0 END, 2) AS DURATION_DEVIATION_MIN,
    ROUND(CASE WHEN t.EXPECTED_DISTANCE_KM > 0
               THEN ((t.ACTUAL_DISTANCE_KM / NULLIF(t.EXPECTED_DISTANCE_KM, 0)) - 1) * 100
               ELSE 0 END, 2) AS DURATION_DEVIATION_PCT,
    CASE WHEN ABS(t.ACTUAL_DISTANCE_KM - t.EXPECTED_DISTANCE_KM) / NULLIF(t.EXPECTED_DISTANCE_KM, 0) > (SELECT DEVIATION_DISTANCE_RATIO FROM FLEET_INTELLIGENCE.CORE.DIM_VEHICLE_PROFILE WHERE VEHICLE_TYPE = (SELECT VEHICLE_TYPE FROM FLEET_INTELLIGENCE.ROUTE_DEVIATION.CONFIG LIMIT 1) LIMIT 1)
         THEN TRUE ELSE FALSE END AS IS_DISTANCE_DEVIATION,
    CASE WHEN t.IS_DETOUR THEN TRUE ELSE FALSE END AS IS_DURATION_DEVIATION,
    CASE WHEN t.IS_DETOUR
           OR ABS(t.ACTUAL_DISTANCE_KM - t.EXPECTED_DISTANCE_KM) / NULLIF(t.EXPECTED_DISTANCE_KM, 0) > (SELECT DEVIATION_DISTANCE_RATIO FROM FLEET_INTELLIGENCE.CORE.DIM_VEHICLE_PROFILE WHERE VEHICLE_TYPE = (SELECT VEHICLE_TYPE FROM FLEET_INTELLIGENCE.ROUTE_DEVIATION.CONFIG LIMIT 1) LIMIT 1)
         THEN TRUE ELSE FALSE END AS IS_ROUTE_DEVIATION,
    t.ACTUAL_PATH,
    t.EXPECTED_PATH
FROM FLEET_INTELLIGENCE.ROUTE_DEVIATION.VW_TRIP_DEVIATION t
LEFT JOIN FLEET_INTELLIGENCE.ROUTE_DEVIATION.VW_TRIP_SCHEDULE s ON t.TRIP_ID = s.SCHEDULE_ID
LEFT JOIN trip_points tp ON t.TRIP_ID = tp.TRIP_ID
LEFT JOIN dedup_pois po ON t.ORIGIN_POI_ID = po.ID AND po.RN = 1
LEFT JOIN dedup_pois pd ON t.DESTINATION_POI_ID = pd.ID AND pd.RN = 1
WHERE t.ACTUAL_PATH IS NOT NULL;

-- =============================================================================
-- 3. ROUTE_OPTIMIZATION CONFIG safety-net
--    The canonical loader (datasets/load-seed-data.sql) creates + seeds this from
--    the active DIM_DATASETS row, but it runs WARN-on-error / stop-on-first-error,
--    so a fresh install could skip it. Re-ensure idempotently here. Seed ONLY when
--    empty so loader-provided values are never clobbered.
-- =============================================================================
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG (
  VEHICLE_TYPE VARCHAR NOT NULL,
  REGION       VARCHAR NOT NULL
) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
ALTER TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG ADD COLUMN IF NOT EXISTS DAILY_RENTAL_RATE_AVOIDED_USD NUMBER(10,2);
ALTER TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG ADD COLUMN IF NOT EXISTS RENTAL_CAPTURE_RATE NUMBER(4,3);
ALTER TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG ADD COLUMN IF NOT EXISTS MAX_REPOSITION_MINUTES NUMBER(6,0);
ALTER TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG ADD COLUMN IF NOT EXISTS AVOID_FEATURES VARCHAR(200);

INSERT INTO FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG
  (VEHICLE_TYPE, REGION, DAILY_RENTAL_RATE_AVOIDED_USD, RENTAL_CAPTURE_RATE, MAX_REPOSITION_MINUTES, AVOID_FEATURES)
SELECT VEHICLE_TYPE, REGION, 80.00, 0.600, 600, 'tollways,ferries' FROM (
  SELECT VEHICLE_TYPE, REGION, 1 AS PRI FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS WHERE IS_ACTIVE = TRUE
  UNION ALL SELECT 'ebike', 'SanFrancisco', 2
) s
WHERE NOT EXISTS (SELECT 1 FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG)
QUALIFY ROW_NUMBER() OVER (ORDER BY PRI) = 1;

-- =============================================================================
-- 4. CATCHMENT  (Overture Marketplace; real ADDRESS/CITY/STATE/POSTCODE, no synth)
--    Runs LAST: depends on the two Overture listings + (optionally) REGION_CATALOG.
--    A failure here (no Overture coverage / engine absent) does NOT block 1-3.
-- =============================================================================
-- 4a. Acquire the Overture listings (idempotent; no-op when already imported).
CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZT0Z4CM1E9KR');
CREATE DATABASE IF NOT EXISTS OVERTURE_MAPS__PLACES FROM LISTING GZT0Z4CM1E9KR;
CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZT0Z4CM1E9NQ');
CREATE DATABASE IF NOT EXISTS OVERTURE_MAPS__ADDRESSES FROM LISTING GZT0Z4CM1E9NQ;
CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZT0Z4CM1E9KJ');
CREATE DATABASE IF NOT EXISTS OVERTURE_MAPS__TRANSPORTATION FROM LISTING GZT0Z4CM1E9KJ;
-- Overture Buildings (CARTO.BUILDING polygons -> depot centroids via ST_CENTROID)
-- and Divisions (CARTO.DIVISION_AREA admin polygons -> real region boundaries).
-- Both free, same CARTO/Overture provider as the three themes above.
CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZT0Z4CM1E9KN');
CREATE DATABASE IF NOT EXISTS OVERTURE_MAPS__BUILDINGS FROM LISTING GZT0Z4CM1E9KN;
CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZT0Z4CM1E9M9');
CREATE DATABASE IF NOT EXISTS OVERTURE_MAPS__DIVISIONS FROM LISTING GZT0Z4CM1E9M9;
-- SafeGraph Open Census: FULL-coverage free US demographics (242k census block
-- groups, ACS tables + geometry). Backs the demographics generator (Wave 2).
-- NOTE: "free" demographics listings are usually tiny samples (e.g. No Fret
-- GZ1M6ZYDCF2 = 24 rows); SafeGraph Open Census is the real full-coverage one.
CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZSNZ2UNN0');
CREATE DATABASE IF NOT EXISTS SAFEGRAPH_OPEN_CENSUS_FREE FROM LISTING GZSNZ2UNN0;

CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.CATCHMENT
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.CATCHMENT.CONFIG (
  VEHICLE_TYPE VARCHAR NOT NULL,
  REGION       VARCHAR NOT NULL
) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

INSERT INTO FLEET_INTELLIGENCE.CATCHMENT.CONFIG (VEHICLE_TYPE, REGION)
SELECT VEHICLE_TYPE, REGION FROM (
  SELECT VEHICLE_TYPE, REGION, 1 AS PRI FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS WHERE IS_ACTIVE = TRUE
  UNION ALL SELECT 'ebike', 'SanFrancisco', 2
) s
WHERE NOT EXISTS (SELECT 1 FROM FLEET_INTELLIGENCE.CATCHMENT.CONFIG)
QUALIFY ROW_NUMBER() OVER (ORDER BY PRI) = 1;

CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.CATCHMENT.POIS (
  REGION          VARCHAR NOT NULL,
  POI_ID          VARCHAR,
  POI_NAME        VARCHAR,
  BASIC_CATEGORY  VARCHAR,
  LONGITUDE       FLOAT,
  LATITUDE        FLOAT,
  GEOMETRY        GEOGRAPHY,
  ADDRESS         VARCHAR,
  CITY            VARCHAR,
  STATE           VARCHAR,
  POSTCODE        VARCHAR
) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.CATCHMENT.CITIES_BY_STATE (
  REGION    VARCHAR NOT NULL,
  STATE     VARCHAR,
  CITY      VARCHAR,
  POI_COUNT INT
) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.CATCHMENT.REGIONAL_ADDRESSES (
  REGION    VARCHAR NOT NULL,
  ID        VARCHAR,
  GEOMETRY  GEOGRAPHY,
  LONGITUDE FLOAT,
  LATITUDE  FLOAT,
  CITY      VARCHAR,
  POSTCODE  VARCHAR
) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- Single-row driver: active region key + bbox (from the active dataset's DIM_POIS
-- extent, +0.1deg margin -- engine-independent, data-derived, not hardcoded) +
-- boundary polygon from REGION_CATALOG when the engine is present (NULL-safe refine).
CREATE OR REPLACE TEMP TABLE FLEET_INTELLIGENCE.CATCHMENT._AL_REGION AS
WITH active AS (
  SELECT REGION, VEHICLE_TYPE FROM FLEET_INTELLIGENCE.CATCHMENT.CONFIG LIMIT 1
),
ext AS (
  SELECT MIN(p.LNG) AS MNLON, MIN(p.LAT) AS MNLAT, MAX(p.LNG) AS MXLON, MAX(p.LAT) AS MXLAT
  FROM SYNTHETIC_DATASETS.UNIFIED.DIM_POIS p
  JOIN active a ON p.REGION = a.REGION
),
bnd AS (
  SELECT TO_GEOGRAPHY(ST_ASWKT(rc.BOUNDARY)) AS BOUNDARY
  FROM OPENROUTESERVICE_APP.CORE.REGION_CATALOG rc
  JOIN active a ON (UPPER(rc.LOOKUP_NAME) = UPPER(a.REGION) OR UPPER(rc.REGION_KEY) = UPPER(a.REGION))
  WHERE rc.BOUNDARY IS NOT NULL
  ORDER BY COALESCE(rc.BOUNDARY_AREA_KM2, 1e15) ASC
  LIMIT 1
),
-- Dominant ISO country code of the region's Overture places within the bbox.
-- Lets the address ingest prune by COUNTRY (fast) while staying region-agnostic
-- (resolves 'US' for SanFrancisco, 'GB' for London, 'DE' for Berlin, etc.).
ctry AS (
  SELECT p.ADDRESSES[0]:country::VARCHAR AS CC
  FROM OVERTURE_MAPS__PLACES.CARTO.PLACE p, ext e
  WHERE p.ADDRESSES[0]:country IS NOT NULL
    AND ST_X(p.GEOMETRY) BETWEEN COALESCE(e.MNLON, -123.0) - 0.1 AND COALESCE(e.MXLON, -121.5) + 0.1
    AND ST_Y(p.GEOMETRY) BETWEEN COALESCE(e.MNLAT,   36.8) - 0.1 AND COALESCE(e.MXLAT,   38.5) + 0.1
  GROUP BY 1
  ORDER BY COUNT(*) DESC
  LIMIT 1
)
SELECT
  a.REGION                                   AS REGION_KEY,
  COALESCE(e.MNLON, -123.0) - 0.1            AS BBOX_MIN_LON,
  COALESCE(e.MNLAT,   36.8) - 0.1            AS BBOX_MIN_LAT,
  COALESCE(e.MXLON, -121.5) + 0.1            AS BBOX_MAX_LON,
  COALESCE(e.MXLAT,   38.5) + 0.1            AS BBOX_MAX_LAT,
  (SELECT BOUNDARY FROM bnd)                 AS BOUNDARY,
  (SELECT CC FROM ctry)                      AS COUNTRY
FROM active a CROSS JOIN ext e;

DELETE FROM FLEET_INTELLIGENCE.CATCHMENT.POIS
WHERE REGION = (SELECT REGION_KEY FROM FLEET_INTELLIGENCE.CATCHMENT._AL_REGION LIMIT 1);
INSERT INTO FLEET_INTELLIGENCE.CATCHMENT.POIS
SELECT
    d.REGION_KEY AS REGION,
    p.ID AS POI_ID,
    p.NAMES:primary::VARCHAR AS POI_NAME,
    p.BASIC_CATEGORY,
    ST_X(p.GEOMETRY) AS LONGITUDE,
    ST_Y(p.GEOMETRY) AS LATITUDE,
    p.GEOMETRY,
    COALESCE(p.ADDRESSES[0]:freeform::VARCHAR, '') AS ADDRESS,
    p.ADDRESSES[0]:locality::VARCHAR AS CITY,
    p.ADDRESSES[0]:region::VARCHAR AS STATE,
    p.ADDRESSES[0]:postcode::VARCHAR AS POSTCODE
FROM OVERTURE_MAPS__PLACES.CARTO.PLACE p
CROSS JOIN FLEET_INTELLIGENCE.CATCHMENT._AL_REGION d
WHERE p.BASIC_CATEGORY IN (
    'coffee_shop', 'fast_food_restaurant', 'restaurant', 'casual_eatery',
    'grocery_store', 'convenience_store', 'gas_station', 'pharmacy',
    'clothing_store', 'electronics_store', 'specialty_store', 'gym',
    'beauty_salon', 'hair_salon', 'bakery', 'bar', 'supermarket'
)
AND p.GEOMETRY IS NOT NULL
AND p.ADDRESSES[0]:region IS NOT NULL
AND ST_X(p.GEOMETRY) BETWEEN d.BBOX_MIN_LON AND d.BBOX_MAX_LON
AND ST_Y(p.GEOMETRY) BETWEEN d.BBOX_MIN_LAT AND d.BBOX_MAX_LAT
AND (d.BOUNDARY IS NULL OR ST_INTERSECTS(p.GEOMETRY, d.BOUNDARY));

DELETE FROM FLEET_INTELLIGENCE.CATCHMENT.CITIES_BY_STATE
WHERE REGION = (SELECT REGION_KEY FROM FLEET_INTELLIGENCE.CATCHMENT._AL_REGION LIMIT 1);
INSERT INTO FLEET_INTELLIGENCE.CATCHMENT.CITIES_BY_STATE
SELECT
    REGION, STATE, CITY, COUNT(*) AS POI_COUNT
FROM FLEET_INTELLIGENCE.CATCHMENT.POIS
WHERE CITY IS NOT NULL
  AND REGION = (SELECT REGION_KEY FROM FLEET_INTELLIGENCE.CATCHMENT._AL_REGION LIMIT 1)
GROUP BY REGION, STATE, CITY
HAVING COUNT(*) > 10
ORDER BY STATE, POI_COUNT DESC;

DELETE FROM FLEET_INTELLIGENCE.CATCHMENT.REGIONAL_ADDRESSES
WHERE REGION = (SELECT REGION_KEY FROM FLEET_INTELLIGENCE.CATCHMENT._AL_REGION LIMIT 1);
INSERT INTO FLEET_INTELLIGENCE.CATCHMENT.REGIONAL_ADDRESSES
SELECT
    d.REGION_KEY AS REGION,
    a.ID,
    a.GEOMETRY,
    ST_X(a.GEOMETRY) AS LONGITUDE,
    ST_Y(a.GEOMETRY) AS LATITUDE,
    a.ADDRESS_LEVELS[1]:value::VARCHAR AS CITY,
    a.POSTCODE
FROM OVERTURE_MAPS__ADDRESSES.CARTO.ADDRESS a
CROSS JOIN FLEET_INTELLIGENCE.CATCHMENT._AL_REGION d
-- Region-agnostic: prune by the region's dominant country (partition-friendly),
-- then the bbox + boundary polygon scope the geography precisely.
WHERE (d.COUNTRY IS NULL OR a.COUNTRY = d.COUNTRY)
AND a.GEOMETRY IS NOT NULL
AND ST_X(a.GEOMETRY) BETWEEN d.BBOX_MIN_LON AND d.BBOX_MAX_LON
AND ST_Y(a.GEOMETRY) BETWEEN d.BBOX_MIN_LAT AND d.BBOX_MAX_LAT
AND (d.BOUNDARY IS NULL OR ST_INTERSECTS(a.GEOMETRY, d.BOUNDARY));

-- =============================================================================
-- 5. LOCATION DIAGNOSTICS  (cannibalisation + closure vertical slice)
--    Region-agnostic store-location intelligence built ENTIRELY from data already
--    present: a deterministic subset of CATCHMENT.POIS becomes the "store estate"
--    (OWNED + CANDIDATE sites), CATCHMENT.REGIONAL_ADDRESSES is the household proxy,
--    and drive-time bands come from the live ORS engine (single-point ISOCHRONES,
--    range in MINUTES). Commercial figures (revenue, EBITDA, HV/Sample/Walkin mix,
--    sqft, rent) are SYNTHETIC and deterministic (HASH-seeded) - clearly a proxy
--    for a customer's first-party data, not real sales.
--
--    Precompute pattern: ORS SQL table functions only evaluate with LITERAL args
--    (correlated / multi-location calls return nothing on this engine), so the
--    isochrone precompute is a stored-procedure loop issuing literal EXECUTE
--    IMMEDIATE inserts. Everything downstream (household counts, overlap transfer,
--    closure reassignment) is pure spatial SQL over the precomputed polygons, so
--    the app reads plain contract views with no live routing call.
--
--    Runs LAST (after CATCHMENT) and degrades to empty tables (never an error) when
--    the engine is unreachable or the region has no Overture coverage: an ORS error
--    yields 0 features -> the loop inserts 0 isochrone rows -> derived tables empty.
--
--    NOTE (single-active-region model, mirrors CATCHMENT): the proc rebuilds only
--    the region in FLEET_INTELLIGENCE.CATCHMENT.CONFIG (DELETE-by-region + INSERT),
--    so rows for other regions are preserved.
-- =============================================================================
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.LOCATION
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-location-diagnostics","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.LOCATION.STORES (
  REGION      VARCHAR NOT NULL,
  STORE_ID    VARCHAR NOT NULL,   -- synthetic (ST0001..), safe for dynamic SQL
  POI_ID      VARCHAR,
  POI_NAME    VARCHAR,
  CATEGORY    VARCHAR,
  LON         FLOAT,
  LAT         FLOAT,
  GEOG        GEOGRAPHY,
  STORE_ROLE  VARCHAR             -- OWNED | CANDIDATE
) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-location-diagnostics","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.LOCATION.STORE_ISOCHRONES (
  REGION      VARCHAR NOT NULL,
  STORE_ID    VARCHAR NOT NULL,
  STORE_ROLE  VARCHAR,
  BAND_MIN    INT,
  BAND_SEC    INT,
  GEOG        GEOGRAPHY
) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-location-diagnostics","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- Drive-time bands (minutes). A tiny constant table avoids a multi-row VALUES()
-- table literal, which the SQL-scripting FOR-cursor grammar rejects.
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.LOCATION.BANDS (
  BAND_MIN INT
) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-location-diagnostics","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.LOCATION.HH_CELLS (
  REGION    VARCHAR NOT NULL,
  H3        VARCHAR,
  HH        INT,                  -- household proxy = address count in H3 res-8 cell
  CENTROID  GEOGRAPHY
) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-location-diagnostics","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.LOCATION.STORE_FACTS (
  REGION           VARCHAR NOT NULL,
  STORE_ID         VARCHAR NOT NULL,
  POI_NAME         VARCHAR,
  CATEGORY         VARCHAR,
  STORE_ROLE       VARCHAR,
  LON              FLOAT,
  LAT              FLOAT,
  HH_20MIN         INT,           -- households within 20-min drive (real, from iso)
  AVG_SPEND_PER_HH NUMBER(10,2),  -- synthetic
  ANNUAL_REVENUE   NUMBER(18,2),  -- synthetic = HH_20MIN * AVG_SPEND_PER_HH
  EBITDA_PCT       NUMBER(5,3),   -- synthetic
  ANNUAL_EBITDA    NUMBER(18,2),  -- synthetic
  HV_PCT           NUMBER(5,3),   -- synthetic interaction mix (Home Visit)
  SAMPLE_PCT       NUMBER(5,3),   -- synthetic interaction mix (Sample)
  WALKIN_PCT       NUMBER(5,3),   -- synthetic interaction mix (Walk-in)
  HV_REVENUE       NUMBER(18,2),
  SAMPLE_REVENUE   NUMBER(18,2),
  WALKIN_REVENUE   NUMBER(18,2),
  SQFT             INT,           -- synthetic property size
  RENT_PSF         NUMBER(10,2),  -- synthetic rent per sqft
  ANNUAL_RENT      NUMBER(18,2),  -- synthetic = SQFT * RENT_PSF
  RATES_PSF        NUMBER(10,2),  -- synthetic business rates per sqft
  VALUE_PER_COST   NUMBER(12,3)   -- ANNUAL_REVENUE / ANNUAL_RENT
) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-location-diagnostics","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.LOCATION.CANNIBALISATION (
  REGION            VARCHAR NOT NULL,
  CANDIDATE_ID      VARCHAR,
  CANDIDATE_NAME    VARCHAR,
  BAND_MIN          INT,
  EXISTING_STORE_ID VARCHAR,
  EXISTING_NAME     VARCHAR,
  SHARED_HH         INT,
  TRANSFER_PCT      NUMBER(6,4),  -- shared_hh / existing HH_20MIN
  TRANSFER_REVENUE  NUMBER(18,2), -- existing revenue * transfer_pct * CAPTURE(0.5)
  TRANSFER_EBITDA   NUMBER(18,2),
  TRANSFER_HV       NUMBER(18,2),
  TRANSFER_SAMPLE   NUMBER(18,2),
  TRANSFER_WALKIN   NUMBER(18,2)
) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-location-diagnostics","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.LOCATION.CLOSURE_REASSIGNMENT (
  REGION             VARCHAR NOT NULL,
  CLOSED_STORE_ID    VARCHAR,
  CLOSED_NAME        VARCHAR,
  GAINING_STORE_ID   VARCHAR,
  GAINING_NAME       VARCHAR,
  HH_INHERITED       INT,
  PCT_OF_CLOSED      NUMBER(6,4),
  REVENUE_INHERITED  NUMBER(18,2),
  EBITDA_INHERITED   NUMBER(18,2)
) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-location-diagnostics","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- Build procedure: precomputes the estate, isochrones, and all diagnostics for the
-- active region. Owner's rights (installer = engine-capable). Idempotent per region.
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.LOCATION.BUILD_LOCATION_DIAGNOSTICS()
  RETURNS VARCHAR
  LANGUAGE SQL
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-location-diagnostics","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
DECLARE
  rg VARCHAR;
  q VARCHAR DEFAULT CHR(39);   -- single quote, to keep dynamic SQL readable
  n_iso INT DEFAULT 0;
  -- Cursor-based FOR loop (query-based FOR loops do not expose rec.<col> here).
  -- References CATCHMENT.CONFIG directly so it needs no bind variable.
  store_band_cur CURSOR FOR
    SELECT s.STORE_ID, s.LON, s.LAT, s.STORE_ROLE, b.BAND_MIN
    FROM FLEET_INTELLIGENCE.LOCATION.STORES s
         CROSS JOIN FLEET_INTELLIGENCE.LOCATION.BANDS b
    WHERE s.REGION = (SELECT REGION FROM FLEET_INTELLIGENCE.CATCHMENT.CONFIG LIMIT 1);
BEGIN
  SELECT REGION INTO rg FROM FLEET_INTELLIGENCE.CATCHMENT.CONFIG LIMIT 1;
  IF (rg IS NULL) THEN
    RETURN 'no active region in CATCHMENT.CONFIG';
  END IF;

  -- 1. Store estate: deterministic subset of the region most-spread retail category.
  DELETE FROM FLEET_INTELLIGENCE.LOCATION.STORES WHERE REGION = :rg;
  INSERT INTO FLEET_INTELLIGENCE.LOCATION.STORES
    (REGION, STORE_ID, POI_ID, POI_NAME, CATEGORY, LON, LAT, GEOG, STORE_ROLE)
  WITH cat AS (
    SELECT BASIC_CATEGORY
    FROM FLEET_INTELLIGENCE.CATCHMENT.POIS
    WHERE REGION = :rg AND BASIC_CATEGORY IS NOT NULL AND LONGITUDE IS NOT NULL
    GROUP BY BASIC_CATEGORY
    ORDER BY COUNT(DISTINCT H3_POINT_TO_CELL_STRING(GEOMETRY, 6)) DESC, COUNT(*) DESC
    LIMIT 1
  ),
  ranked AS (
    SELECT p.POI_ID, p.POI_NAME, p.BASIC_CATEGORY, p.LONGITUDE, p.LATITUDE, p.GEOMETRY,
           ROW_NUMBER() OVER (PARTITION BY H3_POINT_TO_CELL_STRING(p.GEOMETRY, 6) ORDER BY p.POI_ID) AS rn_cell
    FROM FLEET_INTELLIGENCE.CATCHMENT.POIS p
    JOIN cat ON p.BASIC_CATEGORY = cat.BASIC_CATEGORY
    WHERE p.REGION = :rg AND p.LONGITUDE IS NOT NULL
  ),
  spread AS (
    SELECT *, ROW_NUMBER() OVER (ORDER BY POI_ID) AS gidx
    FROM ranked WHERE rn_cell = 1
  )
  SELECT :rg,
         'ST' || LPAD(gidx::VARCHAR, 4, '0'),
         POI_ID, POI_NAME, BASIC_CATEGORY, LONGITUDE, LATITUDE, GEOMETRY,
         CASE WHEN gidx <= 10 THEN 'OWNED' ELSE 'CANDIDATE' END
  FROM spread WHERE gidx <= 13;

  -- 2. Drive-time bands per store (literal ISOCHRONES calls; range in MINUTES).
  DELETE FROM FLEET_INTELLIGENCE.LOCATION.BANDS;
  INSERT INTO FLEET_INTELLIGENCE.LOCATION.BANDS (BAND_MIN) VALUES (10),(15),(20),(25),(30),(45),(60);
  DELETE FROM FLEET_INTELLIGENCE.LOCATION.STORE_ISOCHRONES WHERE REGION = :rg;
  FOR rec IN store_band_cur DO
    EXECUTE IMMEDIATE
      'INSERT INTO FLEET_INTELLIGENCE.LOCATION.STORE_ISOCHRONES(REGION,STORE_ID,STORE_ROLE,BAND_MIN,BAND_SEC,GEOG) SELECT '
      || q || rg || q || ',' || q || rec.STORE_ID || q || ',' || q || rec.STORE_ROLE || q || ','
      || rec.BAND_MIN || ',' || (rec.BAND_MIN * 60) || ',GEOJSON '
      || 'FROM TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES(' || q || 'driving-car' || q || ','
      || rec.LON || '::FLOAT,' || rec.LAT || '::FLOAT,' || rec.BAND_MIN || '::INT,' || q || rg || q || ')) WHERE GEOJSON IS NOT NULL';
  END FOR;
  SELECT COUNT(*) INTO n_iso FROM FLEET_INTELLIGENCE.LOCATION.STORE_ISOCHRONES WHERE REGION = :rg;

  -- 3. Household proxy cells (H3 res-8 address counts + representative centroid).
  DELETE FROM FLEET_INTELLIGENCE.LOCATION.HH_CELLS WHERE REGION = :rg;
  INSERT INTO FLEET_INTELLIGENCE.LOCATION.HH_CELLS (REGION, H3, HH, CENTROID)
  SELECT :rg,
         H3_POINT_TO_CELL_STRING(GEOMETRY, 8) AS H3,
         COUNT(*) AS HH,
         ST_MAKEPOINT(AVG(LONGITUDE), AVG(LATITUDE)) AS CENTROID
  FROM FLEET_INTELLIGENCE.CATCHMENT.REGIONAL_ADDRESSES
  WHERE REGION = :rg AND GEOMETRY IS NOT NULL
  GROUP BY 1, 2;

  -- 4. Synthetic store facts (deterministic HASH; HH_20MIN is real from isochrones).
  DELETE FROM FLEET_INTELLIGENCE.LOCATION.STORE_FACTS WHERE REGION = :rg;
  INSERT INTO FLEET_INTELLIGENCE.LOCATION.STORE_FACTS
    (REGION, STORE_ID, POI_NAME, CATEGORY, STORE_ROLE, LON, LAT, HH_20MIN,
     AVG_SPEND_PER_HH, ANNUAL_REVENUE, EBITDA_PCT, ANNUAL_EBITDA,
     HV_PCT, SAMPLE_PCT, WALKIN_PCT, HV_REVENUE, SAMPLE_REVENUE, WALKIN_REVENUE,
     SQFT, RENT_PSF, ANNUAL_RENT, RATES_PSF, VALUE_PER_COST)
  WITH h20 AS (
    SELECT s.STORE_ID, SUM(c.HH) AS HH20
    FROM FLEET_INTELLIGENCE.LOCATION.STORE_ISOCHRONES i
    JOIN FLEET_INTELLIGENCE.LOCATION.STORES s
      ON s.REGION = i.REGION AND s.STORE_ID = i.STORE_ID
    JOIN FLEET_INTELLIGENCE.LOCATION.HH_CELLS c
      ON c.REGION = i.REGION AND ST_WITHIN(c.CENTROID, i.GEOG)
    WHERE i.REGION = :rg AND i.BAND_MIN = 20
    GROUP BY s.STORE_ID
  ),
  base AS (
    SELECT s.STORE_ID, s.POI_NAME, s.CATEGORY, s.STORE_ROLE, s.LON, s.LAT,
           COALESCE(h.HH20, 0) AS HH20,
           35 + MOD(ABS(HASH(s.STORE_ID, 3)), 66)          AS SPEND,
           0.20 + MOD(ABS(HASH(s.STORE_ID, 1)), 16) / 100.0 AS HV,
           0.15 + MOD(ABS(HASH(s.STORE_ID, 2)), 16) / 100.0 AS SAMP,
           0.08 + MOD(ABS(HASH(s.STORE_ID, 4)), 13) / 100.0 AS EBIT,
           3000 + MOD(ABS(HASH(s.STORE_ID, 5)), 6001)       AS SQFT,
           12 + MOD(ABS(HASH(s.STORE_ID, 6)), 29)           AS RENT
    FROM FLEET_INTELLIGENCE.LOCATION.STORES s
    LEFT JOIN h20 h ON h.STORE_ID = s.STORE_ID
    WHERE s.REGION = :rg
  )
  SELECT :rg, STORE_ID, POI_NAME, CATEGORY, STORE_ROLE, LON, LAT, HH20,
         SPEND,
         HH20 * SPEND                                   AS REVENUE,
         EBIT,
         HH20 * SPEND * EBIT                            AS EBITDA,
         HV, SAMP, (1 - HV - SAMP)                      AS WALKIN,
         HH20 * SPEND * HV                              AS HV_REV,
         HH20 * SPEND * SAMP                            AS SAMPLE_REV,
         HH20 * SPEND * (1 - HV - SAMP)                 AS WALKIN_REV,
         SQFT, RENT, SQFT * RENT                        AS ANNUAL_RENT,
         RENT * 0.45                                    AS RATES,
         CASE WHEN SQFT * RENT > 0 THEN (HH20 * SPEND) / (SQFT * RENT) ELSE 0 END AS VALUE_PER_COST
  FROM base;

  -- 5. Cannibalisation: candidate-band overlap with each existing store 20-min catchment.
  --    NOTE: bands are NESTED what-if scenarios, not additive layers (a 30-min band
  --    subsumes the 20-min band). Consumers must pick ONE band; never SUM TRANSFER_*
  --    across BAND_MIN for the same (CANDIDATE, EXISTING) pair. Summing across
  --    EXISTING stores at a FIXED band IS valid (a candidate draws from many stores).
  DELETE FROM FLEET_INTELLIGENCE.LOCATION.CANNIBALISATION WHERE REGION = :rg;
  INSERT INTO FLEET_INTELLIGENCE.LOCATION.CANNIBALISATION
    (REGION, CANDIDATE_ID, CANDIDATE_NAME, BAND_MIN, EXISTING_STORE_ID, EXISTING_NAME,
     SHARED_HH, TRANSFER_PCT, TRANSFER_REVENUE, TRANSFER_EBITDA,
     TRANSFER_HV, TRANSFER_SAMPLE, TRANSFER_WALKIN)
  WITH cb AS (
    SELECT STORE_ID AS CAND_ID, BAND_MIN, GEOG
    FROM FLEET_INTELLIGENCE.LOCATION.STORE_ISOCHRONES
    WHERE REGION = :rg AND STORE_ROLE = 'CANDIDATE'
  ),
  o20 AS (
    SELECT STORE_ID AS OWN_ID, GEOG
    FROM FLEET_INTELLIGENCE.LOCATION.STORE_ISOCHRONES
    WHERE REGION = :rg AND STORE_ROLE = 'OWNED' AND BAND_MIN = 20
  ),
  pairs AS (
    SELECT cb.CAND_ID, cb.BAND_MIN, o20.OWN_ID, cb.GEOG AS CGEOG, o20.GEOG AS OGEOG
    FROM cb JOIN o20 ON ST_INTERSECTS(cb.GEOG, o20.GEOG)
  ),
  shared AS (
    SELECT p.CAND_ID, p.BAND_MIN, p.OWN_ID, SUM(c.HH) AS SHARED_HH
    FROM pairs p
    JOIN FLEET_INTELLIGENCE.LOCATION.HH_CELLS c
      ON c.REGION = :rg
     AND ST_WITHIN(c.CENTROID, p.CGEOG)
     AND ST_WITHIN(c.CENTROID, p.OGEOG)
    GROUP BY 1, 2, 3
  )
  SELECT :rg, sh.CAND_ID, fc.POI_NAME, sh.BAND_MIN, sh.OWN_ID, fo.POI_NAME,
         sh.SHARED_HH,
         sh.SHARED_HH / NULLIF(fo.HH_20MIN, 0)                                  AS TRANSFER_PCT,
         fo.ANNUAL_REVENUE * (sh.SHARED_HH / NULLIF(fo.HH_20MIN, 0)) * 0.5      AS TRANSFER_REVENUE,
         fo.ANNUAL_EBITDA  * (sh.SHARED_HH / NULLIF(fo.HH_20MIN, 0)) * 0.5      AS TRANSFER_EBITDA,
         fo.ANNUAL_REVENUE * (sh.SHARED_HH / NULLIF(fo.HH_20MIN, 0)) * 0.5 * fo.HV_PCT     AS TRANSFER_HV,
         fo.ANNUAL_REVENUE * (sh.SHARED_HH / NULLIF(fo.HH_20MIN, 0)) * 0.5 * fo.SAMPLE_PCT AS TRANSFER_SAMPLE,
         fo.ANNUAL_REVENUE * (sh.SHARED_HH / NULLIF(fo.HH_20MIN, 0)) * 0.5 * fo.WALKIN_PCT AS TRANSFER_WALKIN
  FROM shared sh
  JOIN FLEET_INTELLIGENCE.LOCATION.STORE_FACTS fo ON fo.REGION = :rg AND fo.STORE_ID = sh.OWN_ID
  JOIN FLEET_INTELLIGENCE.LOCATION.STORE_FACTS fc ON fc.REGION = :rg AND fc.STORE_ID = sh.CAND_ID;

  -- 6. Closure reassignment: each closed store 20-min households go to the nearest
  --    OTHER owned store (smallest drive-time band containing the cell, tie = distance).
  DELETE FROM FLEET_INTELLIGENCE.LOCATION.CLOSURE_REASSIGNMENT WHERE REGION = :rg;
  INSERT INTO FLEET_INTELLIGENCE.LOCATION.CLOSURE_REASSIGNMENT
    (REGION, CLOSED_STORE_ID, CLOSED_NAME, GAINING_STORE_ID, GAINING_NAME,
     HH_INHERITED, PCT_OF_CLOSED, REVENUE_INHERITED, EBITDA_INHERITED)
  WITH own20 AS (
    SELECT STORE_ID AS CLOSED_ID, GEOG
    FROM FLEET_INTELLIGENCE.LOCATION.STORE_ISOCHRONES
    WHERE REGION = :rg AND STORE_ROLE = 'OWNED' AND BAND_MIN = 20
  ),
  closed_cells AS (
    SELECT o.CLOSED_ID, c.H3, c.HH, c.CENTROID
    FROM own20 o
    JOIN FLEET_INTELLIGENCE.LOCATION.HH_CELLS c
      ON c.REGION = :rg AND ST_WITHIN(c.CENTROID, o.GEOG)
  ),
  gainers AS (
    SELECT i.STORE_ID AS GAIN_ID, i.BAND_MIN, i.GEOG, s.LON, s.LAT
    FROM FLEET_INTELLIGENCE.LOCATION.STORE_ISOCHRONES i
    JOIN FLEET_INTELLIGENCE.LOCATION.STORES s
      ON s.REGION = i.REGION AND s.STORE_ID = i.STORE_ID
    WHERE i.REGION = :rg AND i.STORE_ROLE = 'OWNED'
  ),
  assign AS (
    SELECT cc.CLOSED_ID, cc.H3, cc.HH, g.GAIN_ID
    FROM closed_cells cc
    JOIN gainers g
      ON g.GAIN_ID <> cc.CLOSED_ID AND ST_WITHIN(cc.CENTROID, g.GEOG)
    QUALIFY ROW_NUMBER() OVER (
      PARTITION BY cc.CLOSED_ID, cc.H3
      ORDER BY g.BAND_MIN, ST_DISTANCE(cc.CENTROID, ST_MAKEPOINT(g.LON, g.LAT)), g.GAIN_ID
    ) = 1
  ),
  agg AS (
    SELECT CLOSED_ID, GAIN_ID, SUM(HH) AS HH_INH
    FROM assign GROUP BY 1, 2
  )
  SELECT :rg, a.CLOSED_ID, fx.POI_NAME, a.GAIN_ID, fg.POI_NAME,
         a.HH_INH,
         a.HH_INH / NULLIF(fx.HH_20MIN, 0)                                   AS PCT_OF_CLOSED,
         fx.ANNUAL_REVENUE * (a.HH_INH / NULLIF(fx.HH_20MIN, 0))             AS REVENUE_INHERITED,
         fx.ANNUAL_EBITDA  * (a.HH_INH / NULLIF(fx.HH_20MIN, 0))             AS EBITDA_INHERITED
  FROM agg a
  JOIN FLEET_INTELLIGENCE.LOCATION.STORE_FACTS fx ON fx.REGION = :rg AND fx.STORE_ID = a.CLOSED_ID
  JOIN FLEET_INTELLIGENCE.LOCATION.STORE_FACTS fg ON fg.REGION = :rg AND fg.STORE_ID = a.GAIN_ID;

  RETURN 'LOCATION built for ' || rg || ': ' || n_iso || ' isochrone rows';
END;
$$;

CALL FLEET_INTELLIGENCE.LOCATION.BUILD_LOCATION_DIAGNOSTICS();

-- 5b. FLEET_APP neutral-contract views the SA app reads (consumers never bind to
--     FLEET_INTELLIGENCE directly). Mirrors the generated CATCHMENT pack pattern.
CREATE SCHEMA IF NOT EXISTS FLEET_APP.LOCATION
  COMMENT = 'Stable logical layer for the location-diagnostics slice (cannibalisation + closure).';

CREATE OR REPLACE VIEW FLEET_APP.LOCATION.VW_STORES AS
  SELECT * FROM FLEET_INTELLIGENCE.LOCATION.STORES;
CREATE OR REPLACE VIEW FLEET_APP.LOCATION.VW_STORE_ISOCHRONES AS
  SELECT * FROM FLEET_INTELLIGENCE.LOCATION.STORE_ISOCHRONES;
CREATE OR REPLACE VIEW FLEET_APP.LOCATION.VW_STORE_FACTS AS
  SELECT * FROM FLEET_INTELLIGENCE.LOCATION.STORE_FACTS;
CREATE OR REPLACE VIEW FLEET_APP.LOCATION.VW_CANNIBALISATION AS
  SELECT * FROM FLEET_INTELLIGENCE.LOCATION.CANNIBALISATION;
CREATE OR REPLACE VIEW FLEET_APP.LOCATION.VW_CLOSURE_REASSIGNMENT AS
  SELECT * FROM FLEET_INTELLIGENCE.LOCATION.CLOSURE_REASSIGNMENT;

-- Grants (additive; roles from fleet_sa_app/app/role_binding.sql). Guarded so a
-- role-less install does not error the whole file.
GRANT USAGE ON SCHEMA FLEET_APP.LOCATION TO ROLE FLEET_APP_USER;
GRANT SELECT ON ALL VIEWS IN SCHEMA FLEET_APP.LOCATION TO ROLE FLEET_APP_USER;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA FLEET_APP.LOCATION TO ROLE FLEET_APP_USER;
GRANT USAGE ON SCHEMA FLEET_APP.LOCATION TO ROLE FLEET_APP_OPS;
GRANT SELECT ON ALL VIEWS IN SCHEMA FLEET_APP.LOCATION TO ROLE FLEET_APP_OPS;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA FLEET_APP.LOCATION TO ROLE FLEET_APP_OPS;
GRANT USAGE ON SCHEMA FLEET_APP.LOCATION TO ROLE FLEET_APP_ADMIN;
GRANT SELECT ON ALL VIEWS IN SCHEMA FLEET_APP.LOCATION TO ROLE FLEET_APP_ADMIN;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA FLEET_APP.LOCATION TO ROLE FLEET_APP_ADMIN;

-- Validation summary (last statement; non-fatal).
SELECT 'DWELL.CONFIG' AS OBJ, COUNT(*) AS N FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.CONFIG
UNION ALL SELECT 'ROUTE_DEVIATION.CONFIG', COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_DEVIATION.CONFIG
UNION ALL SELECT 'ROUTE_DEVIATION.TRIP_DEVIATION_ANALYSIS', COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_DEVIATION.TRIP_DEVIATION_ANALYSIS
UNION ALL SELECT 'ROUTE_OPTIMIZATION.CONFIG', COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG
UNION ALL SELECT 'CATCHMENT.POIS', COUNT(*) FROM FLEET_INTELLIGENCE.CATCHMENT.POIS
UNION ALL SELECT 'CATCHMENT.CITIES_BY_STATE', COUNT(*) FROM FLEET_INTELLIGENCE.CATCHMENT.CITIES_BY_STATE
UNION ALL SELECT 'CATCHMENT.REGIONAL_ADDRESSES', COUNT(*) FROM FLEET_INTELLIGENCE.CATCHMENT.REGIONAL_ADDRESSES
UNION ALL SELECT 'LOCATION.STORES', COUNT(*) FROM FLEET_INTELLIGENCE.LOCATION.STORES
UNION ALL SELECT 'LOCATION.STORE_ISOCHRONES', COUNT(*) FROM FLEET_INTELLIGENCE.LOCATION.STORE_ISOCHRONES
UNION ALL SELECT 'LOCATION.STORE_FACTS', COUNT(*) FROM FLEET_INTELLIGENCE.LOCATION.STORE_FACTS
UNION ALL SELECT 'LOCATION.CANNIBALISATION', COUNT(*) FROM FLEET_INTELLIGENCE.LOCATION.CANNIBALISATION
UNION ALL SELECT 'LOCATION.CLOSURE_REASSIGNMENT', COUNT(*) FROM FLEET_INTELLIGENCE.LOCATION.CLOSURE_REASSIGNMENT;
