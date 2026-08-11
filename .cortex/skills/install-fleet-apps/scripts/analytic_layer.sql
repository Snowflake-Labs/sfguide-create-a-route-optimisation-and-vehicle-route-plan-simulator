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

-- Per-region CATCHMENT builder (factored from the former inline ingest so it can
-- run for ANY region on demand, not just the install region). Builds POIS +
-- CITIES_BY_STATE + REGIONAL_ADDRESSES for P_REGION from the Overture shares.
-- Region-scoped and build-if-missing: returns early if the region already has
-- POIs unless P_FORCE = TRUE. NO ORS calls (pure Snowflake SQL over Overture).
-- Driver: region key + bbox (from that region's DIM_POIS extent, +0.1deg, data-
-- derived) + boundary polygon from REGION_CATALOG + dominant Overture country.
-- Idempotent per region (DELETE-by-region + INSERT) so other regions are kept.
-- Called at install (CONFIG region), from Data Studio region-sync, and from the
-- admin region-switch endpoint.
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.CATCHMENT.BUILD_CATCHMENT(P_REGION VARCHAR, P_FORCE BOOLEAN DEFAULT FALSE)
  RETURNS VARCHAR
  LANGUAGE SQL
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
DECLARE
  n INT DEFAULT 0;
BEGIN
  IF (P_REGION IS NULL) THEN
    RETURN 'no region supplied';
  END IF;
  SELECT COUNT(*) INTO n FROM FLEET_INTELLIGENCE.CATCHMENT.POIS WHERE REGION = :P_REGION;
  IF (n > 0 AND NOT P_FORCE) THEN
    RETURN 'catchment already built for ' || P_REGION || ' (' || n || ' pois); pass force=TRUE to rebuild';
  END IF;

  CREATE OR REPLACE TEMP TABLE FLEET_INTELLIGENCE.CATCHMENT._AL_REGION AS
  WITH active AS (
    SELECT :P_REGION AS REGION
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

  RETURN 'catchment built for ' || P_REGION;
END;
$$;

-- Install-time build for the active CONFIG region (force = TRUE for a clean rebuild).
CALL FLEET_INTELLIGENCE.CATCHMENT.BUILD_CATCHMENT(
  (SELECT REGION FROM FLEET_INTELLIGENCE.CATCHMENT.CONFIG LIMIT 1), TRUE);

-- =============================================================================
-- 5. LOCATION DIAGNOSTICS  (cannibalisation + closure vertical slice)
--    Region-agnostic store-location intelligence built from data already present:
--    a deterministic subset of CATCHMENT.POIS becomes the "store estate" (OWNED +
--    CANDIDATE sites), CATCHMENT.REGIONAL_ADDRESSES is the household proxy (H3 cells).
--    Commercial figures (revenue, EBITDA, HV/Sample/Walkin mix, sqft, rent) are
--    SYNTHETIC and deterministic (HASH-seeded) - a proxy for first-party data.
--
--    LIVE ROUTING (Architecture Tenet 9): this build does NOT precompute isochrones.
--    Drive-time catchments are computed at interaction time by the app views calling
--    OPENROUTESERVICE_APP.CORE.ISOCHRONES live (scalar-subquery args from the selected
--    candidate/closed store). This build only materializes NON-ORS reference data:
--    the estate (STORES), the household grid (HH_CELLS), the synthetic per-store
--    commercials (STORE_FACTS, whose REFERENCE_HH = the store's nearest-store Voronoi
--    territory over HH_CELLS - a data-only count), and the band list (BANDS).
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

-- Drive-time bands (minutes) offered in the app band picker. Isochrones for these
-- bands are computed LIVE by the app (not precomputed here).
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
  REFERENCE_HH     INT,           -- nearest-store Voronoi territory households (data-only, no ORS)
  AVG_SPEND_PER_HH NUMBER(10,2),  -- synthetic
  ANNUAL_REVENUE   NUMBER(18,2),  -- synthetic = REFERENCE_HH * AVG_SPEND_PER_HH
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

-- ZIP/postcode areas: REAL postcode polygons + REAL demographics (US demo only).
-- Reference data (NO ORS): polygons come from the free SFR "U.S. ZIP Code Metadata
-- with Geometry" Marketplace listing (GZTYZ7P39MI) and population/housing/income are
-- rolled up from the free SafeGraph Open Census 2020 CBGs (SAFEGRAPH_OPEN_CENSUS_FREE).
-- The ZIP-by-drive-time drill + choropleth compute isochrones LIVE over these polygons.
-- Populated by BUILD_LOCATION_ZIP_ENRICHMENT (guarded; skipped when the listings are
-- absent or the active region is non-US).
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.LOCATION.ZIP_AREAS (
  REGION        VARCHAR NOT NULL,
  ZIP           VARCHAR,
  STATE         VARCHAR,
  GEOG          GEOGRAPHY,      -- ZIP/ZCTA polygon (SFR geometry listing)
  CENTROID      GEOGRAPHY,
  LAND_SQMI     NUMBER(12,4),
  POPULATION    INT,            -- real, SafeGraph CBG rollup
  HOUSEHOLDS    INT,            -- real, SafeGraph CBG housing-unit rollup
  MEDIAN_INCOME NUMBER(12,0),   -- real, SafeGraph CBG median (approx)
  POP_PER_SQMI  NUMBER(14,2)
) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-location-diagnostics","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- Build procedure: materializes the estate + household grid + synthetic facts for
-- the active region. NO ORS calls (isochrones are computed live by the app views).
-- Owner's rights. Idempotent per region.
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.LOCATION.BUILD_LOCATION_DIAGNOSTICS()
  RETURNS VARCHAR
  LANGUAGE SQL
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-location-diagnostics","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
DECLARE
  rg VARCHAR;
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

  -- 2. Drive-time band list offered by the app picker (isochrones computed LIVE).
  DELETE FROM FLEET_INTELLIGENCE.LOCATION.BANDS;
  INSERT INTO FLEET_INTELLIGENCE.LOCATION.BANDS (BAND_MIN) VALUES (10),(15),(20),(25),(30),(45),(60);

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

  -- 4. Synthetic store facts. REFERENCE_HH = the store's nearest-store Voronoi
  --    territory over HH_CELLS (OWNED stores partition the region; CANDIDATE sites
  --    get a radius-based base purely for a plausible synthetic revenue). Data-only,
  --    no ORS. The live cannibalisation view uses the SAME owned-Voronoi partition,
  --    so captured households are always a subset of REFERENCE_HH (transfer_pct <= 1).
  DELETE FROM FLEET_INTELLIGENCE.LOCATION.STORE_FACTS WHERE REGION = :rg;
  INSERT INTO FLEET_INTELLIGENCE.LOCATION.STORE_FACTS
    (REGION, STORE_ID, POI_NAME, CATEGORY, STORE_ROLE, LON, LAT, REFERENCE_HH,
     AVG_SPEND_PER_HH, ANNUAL_REVENUE, EBITDA_PCT, ANNUAL_EBITDA,
     HV_PCT, SAMPLE_PCT, WALKIN_PCT, HV_REVENUE, SAMPLE_REVENUE, WALKIN_REVENUE,
     SQFT, RENT_PSF, ANNUAL_RENT, RATES_PSF, VALUE_PER_COST)
  WITH owned_terr AS (
    SELECT STORE_ID, SUM(HH) AS REF_HH FROM (
      SELECT c.H3, c.HH, s.STORE_ID,
             ROW_NUMBER() OVER (PARTITION BY c.H3 ORDER BY ST_DISTANCE(c.CENTROID, s.GEOG)) AS rn
      FROM FLEET_INTELLIGENCE.LOCATION.HH_CELLS c
      CROSS JOIN (SELECT STORE_ID, GEOG FROM FLEET_INTELLIGENCE.LOCATION.STORES WHERE REGION = :rg AND STORE_ROLE = 'OWNED') s
      WHERE c.REGION = :rg
    ) WHERE rn = 1 GROUP BY STORE_ID
  ),
  cand_radius AS (
    SELECT s.STORE_ID, SUM(c.HH) AS REF_HH
    FROM FLEET_INTELLIGENCE.LOCATION.STORES s
    JOIN FLEET_INTELLIGENCE.LOCATION.HH_CELLS c
      ON c.REGION = :rg AND ST_DWITHIN(c.CENTROID, s.GEOG, 8000)
    WHERE s.REGION = :rg AND s.STORE_ROLE = 'CANDIDATE'
    GROUP BY s.STORE_ID
  ),
  refhh AS (
    SELECT STORE_ID, REF_HH FROM owned_terr
    UNION ALL SELECT STORE_ID, REF_HH FROM cand_radius
  ),
  base AS (
    SELECT s.STORE_ID, s.POI_NAME, s.CATEGORY, s.STORE_ROLE, s.LON, s.LAT,
           COALESCE(r.REF_HH, 0) AS REFHH,
           35 + MOD(ABS(HASH(s.STORE_ID, 3)), 66)          AS SPEND,
           0.20 + MOD(ABS(HASH(s.STORE_ID, 1)), 16) / 100.0 AS HV,
           0.15 + MOD(ABS(HASH(s.STORE_ID, 2)), 16) / 100.0 AS SAMP,
           0.08 + MOD(ABS(HASH(s.STORE_ID, 4)), 13) / 100.0 AS EBIT,
           3000 + MOD(ABS(HASH(s.STORE_ID, 5)), 6001)       AS SQFT,
           12 + MOD(ABS(HASH(s.STORE_ID, 6)), 29)           AS RENT
    FROM FLEET_INTELLIGENCE.LOCATION.STORES s
    LEFT JOIN refhh r ON r.STORE_ID = s.STORE_ID
    WHERE s.REGION = :rg
  )
  SELECT :rg, STORE_ID, POI_NAME, CATEGORY, STORE_ROLE, LON, LAT, REFHH,
         SPEND,
         REFHH * SPEND                                  AS REVENUE,
         EBIT,
         REFHH * SPEND * EBIT                           AS EBITDA,
         HV, SAMP, (1 - HV - SAMP)                      AS WALKIN,
         REFHH * SPEND * HV                             AS HV_REV,
         REFHH * SPEND * SAMP                           AS SAMPLE_REV,
         REFHH * SPEND * (1 - HV - SAMP)                AS WALKIN_REV,
         SQFT, RENT, SQFT * RENT                        AS ANNUAL_RENT,
         RENT * 0.45                                    AS RATES,
         CASE WHEN SQFT * RENT > 0 THEN (REFHH * SPEND) / (SQFT * RENT) ELSE 0 END AS VALUE_PER_COST
  FROM base;

  RETURN 'LOCATION built for ' || rg || ' (live-routing model; no precomputed isochrones)';
END;
$$;

CALL FLEET_INTELLIGENCE.LOCATION.BUILD_LOCATION_DIAGNOSTICS();

-- ZIP enrichment (US demo only): real ZIP polygons (SFR listing GZTYZ7P39MI) +
-- real population/housing/income rolled up from SafeGraph Open Census CBGs. Guarded
-- with EXCEPTION so a fresh install without the two free listings (or a non-US region)
-- simply skips enrichment instead of failing the whole analytic layer. ZIP_AREAS then
-- stays empty and the ZIP drill/choropleth render nothing (the rest of LOCATION works).
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.LOCATION.BUILD_LOCATION_ZIP_ENRICHMENT()
  RETURNS VARCHAR
  LANGUAGE SQL
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-location-diagnostics","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
DECLARE
  rg VARCHAR;
  n INT DEFAULT 0;
BEGIN
  SELECT REGION INTO rg FROM FLEET_INTELLIGENCE.CATCHMENT.CONFIG LIMIT 1;
  IF (rg IS NULL) THEN
    RETURN 'no active region';
  END IF;
  DELETE FROM FLEET_INTELLIGENCE.LOCATION.ZIP_AREAS WHERE REGION = :rg;
  INSERT INTO FLEET_INTELLIGENCE.LOCATION.ZIP_AREAS
    (REGION, ZIP, STATE, GEOG, CENTROID, LAND_SQMI, POPULATION, HOUSEHOLDS, MEDIAN_INCOME, POP_PER_SQMI)
  WITH rzips AS (
    SELECT DISTINCT POSTCODE AS zip
    FROM FLEET_INTELLIGENCE.CATCHMENT.REGIONAL_ADDRESSES
    WHERE REGION = :rg AND POSTCODE IS NOT NULL
  ),
  zpoly AS (
    SELECT g.ZIP_CODE AS zip, g.STATE AS state, TO_GEOGRAPHY(ST_ASWKT(g.GEOMETRY), TRUE) AS geog
    FROM U_S__ZIP_CODE_METADATA_WITH_GEOMETRY.PUBLIC.ZIP_CODE_GEOMETRY_SHARE g
    JOIN rzips r ON r.zip = g.ZIP_CODE
  ),
  zmeta AS (
    SELECT ZIP_CODE AS zip, LAND_SQ_MILES FROM U_S__ZIP_CODE_METADATA_WITH_GEOMETRY.PUBLIC.ZIP_CODE_META_SHARE
  ),
  cbg AS (
    SELECT ST_CENTROID(TO_GEOGRAPHY(g.GEOMETRY, TRUE)) AS ctr,
           p."B01001e1" AS pop, h."B25001e1" AS hh, i."B19013e1" AS inc
    FROM SAFEGRAPH_OPEN_CENSUS_FREE.PUBLIC."2020_CBG_GEOMETRY_WKT" g
    JOIN SAFEGRAPH_OPEN_CENSUS_FREE.PUBLIC."2020_CBG_B01" p ON p.CENSUS_BLOCK_GROUP = g.CENSUS_BLOCK_GROUP
    JOIN SAFEGRAPH_OPEN_CENSUS_FREE.PUBLIC."2020_CBG_B25" h ON h.CENSUS_BLOCK_GROUP = g.CENSUS_BLOCK_GROUP
    LEFT JOIN SAFEGRAPH_OPEN_CENSUS_FREE.PUBLIC."2020_CBG_B19" i ON i.CENSUS_BLOCK_GROUP = g.CENSUS_BLOCK_GROUP
    WHERE g.STATE IN (SELECT DISTINCT state FROM zpoly)
  ),
  roll AS (
    SELECT zp.zip, ROUND(SUM(c.pop)) AS pop, ROUND(SUM(c.hh)) AS hh, ROUND(MEDIAN(c.inc)) AS inc
    FROM zpoly zp JOIN cbg c ON ST_WITHIN(c.ctr, zp.geog)
    GROUP BY zp.zip
  )
  SELECT :rg, zp.zip, zp.state, zp.geog, ST_CENTROID(zp.geog),
         zm.LAND_SQ_MILES, r.pop, r.hh, r.inc,
         CASE WHEN zm.LAND_SQ_MILES > 0 THEN r.pop / zm.LAND_SQ_MILES END
  FROM zpoly zp
  LEFT JOIN roll r ON r.zip = zp.zip
  LEFT JOIN zmeta zm ON zm.zip = zp.zip;
  SELECT COUNT(*) INTO n FROM FLEET_INTELLIGENCE.LOCATION.ZIP_AREAS WHERE REGION = :rg;
  RETURN 'ZIP enrichment built for ' || rg || ': ' || n || ' ZIP areas';
EXCEPTION
  WHEN OTHER THEN
    RETURN 'ZIP enrichment skipped (listings absent or non-US region): ' || SQLERRM;
END;
$$;

CALL FLEET_INTELLIGENCE.LOCATION.BUILD_LOCATION_ZIP_ENRICHMENT();

-- 5b. FLEET_APP neutral-contract views the SA app reads (consumers never bind to
--     FLEET_INTELLIGENCE directly). Mirrors the generated CATCHMENT pack pattern.
-- NOTE: this analytic layer (step 3.5) runs BEFORE the packs layer (step 4) that
-- normally creates FLEET_APP, so create the DB defensively to keep a first run clean.
CREATE DATABASE IF NOT EXISTS FLEET_APP
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
CREATE SCHEMA IF NOT EXISTS FLEET_APP.LOCATION
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-location-diagnostics","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE OR REPLACE VIEW FLEET_APP.LOCATION.VW_STORES
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-location-diagnostics","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
  AS SELECT * FROM FLEET_INTELLIGENCE.LOCATION.STORES;
CREATE OR REPLACE VIEW FLEET_APP.LOCATION.VW_STORE_FACTS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-location-diagnostics","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
  AS SELECT * FROM FLEET_INTELLIGENCE.LOCATION.STORE_FACTS;
CREATE OR REPLACE VIEW FLEET_APP.LOCATION.VW_HH_CELLS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-location-diagnostics","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
  AS SELECT * FROM FLEET_INTELLIGENCE.LOCATION.HH_CELLS;
CREATE OR REPLACE VIEW FLEET_APP.LOCATION.VW_BANDS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-location-diagnostics","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
  AS SELECT * FROM FLEET_INTELLIGENCE.LOCATION.BANDS;
CREATE OR REPLACE VIEW FLEET_APP.LOCATION.VW_ZIP_AREAS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-location-diagnostics","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
  AS SELECT * FROM FLEET_INTELLIGENCE.LOCATION.ZIP_AREAS;

-- Live ZIP drive-time drill: assigns each region ZIP to the smallest drive-time band
-- whose isochrone (computed LIVE, all bands in one ORS call) contains its centroid,
-- carrying real SafeGraph population/housing. Powers the ZIP-by-drive-time table and
-- the per-band ZIP choropleth. Owner's-rights; app roles get USAGE below.
CREATE OR REPLACE FUNCTION FLEET_APP.LOCATION.LIVE_ZIP_BANDS(P_STORE_ID VARCHAR, P_REGION VARCHAR)
RETURNS TABLE (ZIP VARCHAR, BAND_MIN INT, POPULATION INT, HOUSEHOLDS INT, MEDIAN_INCOME NUMBER(12,0), GEO GEOGRAPHY)
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-location-diagnostics","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH iso AS (
    SELECT (f.value:properties:value::INT)/60 AS band_min,
           TO_GEOGRAPHY(f.value:geometry) AS g
    FROM TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES(
      'driving-car',
      ARRAY_CONSTRUCT(ARRAY_CONSTRUCT(
        (SELECT LON FROM FLEET_INTELLIGENCE.LOCATION.STORES WHERE REGION=P_REGION AND STORE_ID=P_STORE_ID),
        (SELECT LAT FROM FLEET_INTELLIGENCE.LOCATION.STORES WHERE REGION=P_REGION AND STORE_ID=P_STORE_ID))),
      (SELECT ARRAY_AGG(BAND_MIN*60) FROM FLEET_INTELLIGENCE.LOCATION.BANDS),
      'time', P_REGION)) resp,
      LATERAL FLATTEN(input => resp.RESPONSE:features) f
  ),
  z AS (
    SELECT ZIP, POPULATION, HOUSEHOLDS, MEDIAN_INCOME, CENTROID, GEOG
    FROM FLEET_INTELLIGENCE.LOCATION.ZIP_AREAS WHERE REGION = P_REGION
  )
  SELECT z.ZIP, MIN(iso.band_min) AS band_min, ANY_VALUE(z.POPULATION), ANY_VALUE(z.HOUSEHOLDS),
         ANY_VALUE(z.MEDIAN_INCOME), ANY_VALUE(z.GEOG)
  FROM z JOIN iso ON ST_WITHIN(z.CENTROID, iso.g)
  GROUP BY z.ZIP
$$;

-- Live owned-store catchments: one ORS call returns every OWNED store's isochrone at
-- the given band (group_index maps back to the STORE_ID-ordered store list). Powers the
-- Site Impact overlap layer ("several isochrones intersection").
CREATE OR REPLACE FUNCTION FLEET_APP.LOCATION.LIVE_OWNED_CATCHMENTS(P_BAND INT, P_REGION VARCHAR)
RETURNS TABLE (STORE_ID VARCHAR, POI_NAME VARCHAR, BAND_MIN INT, GEO GEOGRAPHY)
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-location-diagnostics","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH owned AS (
    SELECT STORE_ID, POI_NAME, ROW_NUMBER() OVER (ORDER BY STORE_ID) - 1 AS grp
    FROM FLEET_INTELLIGENCE.LOCATION.STORES
    WHERE REGION = P_REGION AND STORE_ROLE = 'OWNED'
  ),
  iso AS (
    SELECT f.value:properties:group_index::INT AS grp,
           TO_GEOGRAPHY(f.value:geometry) AS g
    FROM TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES(
      'driving-car',
      (SELECT ARRAY_AGG(ARRAY_CONSTRUCT(LON, LAT)) WITHIN GROUP (ORDER BY STORE_ID)
         FROM FLEET_INTELLIGENCE.LOCATION.STORES WHERE REGION = P_REGION AND STORE_ROLE = 'OWNED'),
      ARRAY_CONSTRUCT(P_BAND * 60),
      'time', P_REGION)) resp,
      LATERAL FLATTEN(input => resp.RESPONSE:features) f
  )
  SELECT o.STORE_ID, o.POI_NAME, P_BAND, i.g
  FROM owned o JOIN iso i ON i.grp = o.grp
$$;

-- Live cannibalisation: ONE ORS call for the selected candidate + band, then the
-- captured households are assigned to their nearest OWNED store (Voronoi) and the
-- transfer math is done server-side. Both the Site Impact metrics cards and the
-- "revenue transfer by existing store" table read from this single function, so
-- the candidate isochrone is computed once per panel instead of being duplicated
-- inline in each query. The ST_WITHIN is evaluated once per cell (in incell)
-- before the cross join. Uses the array + 'time' (seconds) ISOCHRONES overload
-- with LATERAL FLATTEN (same as LIVE_ZIP_BANDS): it returns in ~1s vs ~70s for the
-- 5-arg scalar ISOCHRONES overload, which was the cause of the 60s timeout.
--
-- Finance is user-driven (not synthetic ANNUAL_REVENUE/ANNUAL_EBITDA): the caller
-- supplies annual value per household, EBITDA margin, and capture rate, so:
--   revenue        = captured_hh * P_VALUE_PER_HH * P_CAPTURE_RATE
--   ebitda_transfer= revenue * P_EBITDA_MARGIN
--   home/sample/walk= revenue * per-store interaction split (HV/SAMPLE/WALKIN_PCT)
-- P_EBITDA_MARGIN and P_CAPTURE_RATE are passed as fractions (0..1).
DROP FUNCTION IF EXISTS FLEET_APP.LOCATION.LIVE_CANNIBALISATION(VARCHAR, INT, VARCHAR);
CREATE OR REPLACE FUNCTION FLEET_APP.LOCATION.LIVE_CANNIBALISATION(
  P_CANDIDATE_ID VARCHAR, P_BAND INT, P_REGION VARCHAR,
  P_VALUE_PER_HH FLOAT, P_EBITDA_MARGIN FLOAT, P_CAPTURE_RATE FLOAT)
RETURNS TABLE (STORE_ID VARCHAR, POI_NAME VARCHAR, HOUSEHOLDS INT, TRANSFER_PCT NUMBER(6,1),
               REVENUE NUMBER(18,0), HOME_VISIT NUMBER(18,0), SAMPLE_REV NUMBER(18,0),
               WALK_IN NUMBER(18,0), EBITDA_TRANSFER NUMBER(18,0))
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-location-diagnostics","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH iso AS (
    SELECT TO_GEOGRAPHY(f.value:geometry) AS poly
    FROM TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES(
      'driving-car',
      ARRAY_CONSTRUCT(ARRAY_CONSTRUCT(
        (SELECT LON FROM FLEET_INTELLIGENCE.LOCATION.STORE_FACTS WHERE REGION = P_REGION AND STORE_ID = P_CANDIDATE_ID),
        (SELECT LAT FROM FLEET_INTELLIGENCE.LOCATION.STORE_FACTS WHERE REGION = P_REGION AND STORE_ID = P_CANDIDATE_ID))),
      ARRAY_CONSTRUCT(P_BAND * 60), 'time', P_REGION)) resp,
      LATERAL FLATTEN(input => resp.RESPONSE:features) f
  ),
  owned AS (
    SELECT STORE_ID, POI_NAME, LON, LAT,
           HV_PCT, SAMPLE_PCT, WALKIN_PCT, REFERENCE_HH
    FROM FLEET_INTELLIGENCE.LOCATION.STORE_FACTS
    WHERE REGION = P_REGION AND STORE_ROLE = 'OWNED'
  ),
  incell AS (
    SELECT c.H3, c.HH, c.CENTROID
    FROM FLEET_INTELLIGENCE.LOCATION.HH_CELLS c, iso
    WHERE c.REGION = P_REGION AND iso.poly IS NOT NULL AND ST_WITHIN(c.CENTROID, iso.poly)
  ),
  captured AS (
    SELECT OWN_ID, SUM(HH) AS cap_hh
    FROM (
      SELECT ic.H3, ic.HH, o.STORE_ID AS OWN_ID,
             ROW_NUMBER() OVER (PARTITION BY ic.H3 ORDER BY ST_DISTANCE(ic.CENTROID, ST_MAKEPOINT(o.LON, o.LAT))) rn
      FROM incell ic CROSS JOIN owned o
    ) WHERE rn = 1 GROUP BY OWN_ID
  ),
  calc AS (
    SELECT o.STORE_ID, o.POI_NAME, cap.cap_hh,
           ROUND(100 * cap.cap_hh / NULLIF(o.REFERENCE_HH, 0), 1) AS transfer_pct,
           cap.cap_hh * P_VALUE_PER_HH * P_CAPTURE_RATE AS rev,
           o.HV_PCT, o.SAMPLE_PCT, o.WALKIN_PCT
    FROM captured cap JOIN owned o ON o.STORE_ID = cap.OWN_ID
  )
  SELECT STORE_ID, POI_NAME, cap_hh AS households, transfer_pct,
         ROUND(rev)::NUMBER(18,0) AS revenue,
         ROUND(rev * HV_PCT)::NUMBER(18,0) AS home_visit,
         ROUND(rev * SAMPLE_PCT)::NUMBER(18,0) AS sample_rev,
         ROUND(rev * WALKIN_PCT)::NUMBER(18,0) AS walk_in,
         ROUND(rev * P_EBITDA_MARGIN)::NUMBER(18,0) AS ebitda_transfer
  FROM calc
$$;

-- ===========================================================================
-- Isochrone Overlap Mode (computed ST_INTERSECTION, not visual stacking)
-- ===========================================================================
-- Live overlap geometry for Site Impact: computes the candidate isochrone with
-- ONE ORS call, reuses LIVE_OWNED_CATCHMENTS (a second, multi-location ORS call)
-- for every OWNED store, then ST_INTERSECTIONs the candidate polygon with each
-- owned polygon to produce EXPLICIT overlap geometries. Households (H3 cell
-- centroid containment) and ZIPs (ZIP centroid containment) inside each overlap
-- are attributed and the cannibalisation math is done server-side. Two ORS
-- calls total; nothing is precomputed (Architecture Tenet 9). Region ORS must be
-- RESUMED. Finance is user-driven, mirroring LIVE_CANNIBALISATION:
--   cannibalised_revenue = overlap_hh * P_VALUE_PER_HH * P_CAPTURE_RATE
--   cannibalised_ebitda  = cannibalised_revenue * P_EBITDA_MARGIN
-- P_EBITDA_MARGIN and P_CAPTURE_RATE are fractions (0..1).
CREATE OR REPLACE FUNCTION FLEET_APP.LOCATION.LIVE_OVERLAPS(
  P_CANDIDATE_ID VARCHAR, P_BAND INT, P_REGION VARCHAR,
  P_VALUE_PER_HH FLOAT, P_EBITDA_MARGIN FLOAT, P_CAPTURE_RATE FLOAT)
RETURNS TABLE (OVERLAP_ID VARCHAR, OWNED_STORE_ID VARCHAR, OWNED_STORE VARCHAR, BAND_MIN INT,
               OVERLAP_GEO GEOGRAPHY, OVERLAP_AREA_SQKM NUMBER(14,3), HOUSEHOLDS INT,
               ZIP_COUNT INT, POPULATION INT, CANNIBALISED_REVENUE NUMBER(18,0),
               CANNIBALISED_EBITDA NUMBER(18,0), TRANSFER_PROB NUMBER(6,3), CONFIDENCE NUMBER(6,3))
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-location-diagnostics","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH cand AS (
    SELECT TO_GEOGRAPHY(f.value:geometry) AS poly
    FROM TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES(
      'driving-car',
      ARRAY_CONSTRUCT(ARRAY_CONSTRUCT(
        (SELECT LON FROM FLEET_INTELLIGENCE.LOCATION.STORE_FACTS WHERE REGION = P_REGION AND STORE_ID = P_CANDIDATE_ID),
        (SELECT LAT FROM FLEET_INTELLIGENCE.LOCATION.STORE_FACTS WHERE REGION = P_REGION AND STORE_ID = P_CANDIDATE_ID))),
      ARRAY_CONSTRUCT(P_BAND * 60), 'time', P_REGION)) resp,
      LATERAL FLATTEN(input => resp.RESPONSE:features) f
  ),
  owned AS (
    SELECT STORE_ID, POI_NAME, GEO
    FROM TABLE(FLEET_APP.LOCATION.LIVE_OWNED_CATCHMENTS(P_BAND, P_REGION))
  ),
  facts AS (
    SELECT STORE_ID, REFERENCE_HH
    FROM FLEET_INTELLIGENCE.LOCATION.STORE_FACTS
    WHERE REGION = P_REGION AND STORE_ROLE = 'OWNED'
  ),
  ov AS (
    SELECT o.STORE_ID, o.POI_NAME, ST_INTERSECTION(c.poly, o.GEO) AS g
    FROM cand c CROSS JOIN owned o
    WHERE c.poly IS NOT NULL AND o.GEO IS NOT NULL
  ),
  ovf AS (
    SELECT STORE_ID, POI_NAME, g FROM ov WHERE g IS NOT NULL AND ST_AREA(g) > 0
  ),
  hh AS (
    SELECT ovf.STORE_ID, SUM(c.HH) AS households
    FROM ovf JOIN FLEET_INTELLIGENCE.LOCATION.HH_CELLS c
      ON c.REGION = P_REGION AND ST_WITHIN(c.CENTROID, ovf.g)
    GROUP BY ovf.STORE_ID
  ),
  zp AS (
    SELECT ovf.STORE_ID, COUNT(*) AS zip_count, SUM(z.POPULATION) AS population
    FROM ovf JOIN FLEET_INTELLIGENCE.LOCATION.ZIP_AREAS z
      ON z.REGION = P_REGION AND ST_WITHIN(z.CENTROID, ovf.g)
    GROUP BY ovf.STORE_ID
  )
  SELECT P_CANDIDATE_ID || '~' || ovf.STORE_ID AS overlap_id,
         ovf.STORE_ID AS owned_store_id, ovf.POI_NAME AS owned_store, P_BAND AS band_min,
         ovf.g AS overlap_geo,
         ROUND(ST_AREA(ovf.g) / 1e6, 3)::NUMBER(14,3) AS overlap_area_sqkm,
         COALESCE(hh.households, 0) AS households,
         COALESCE(zp.zip_count, 0) AS zip_count,
         COALESCE(zp.population, 0) AS population,
         ROUND(COALESCE(hh.households, 0) * P_VALUE_PER_HH * P_CAPTURE_RATE)::NUMBER(18,0) AS cannibalised_revenue,
         ROUND(COALESCE(hh.households, 0) * P_VALUE_PER_HH * P_CAPTURE_RATE * P_EBITDA_MARGIN)::NUMBER(18,0) AS cannibalised_ebitda,
         LEAST(1, COALESCE(hh.households, 0) / NULLIF(f.REFERENCE_HH, 0))::NUMBER(6,3) AS transfer_prob,
         ROUND(LEAST(1, COALESCE(zp.zip_count, 0) / 5.0), 3)::NUMBER(6,3) AS confidence
  FROM ovf
  LEFT JOIN hh    ON hh.STORE_ID = ovf.STORE_ID
  LEFT JOIN zp    ON zp.STORE_ID = ovf.STORE_ID
  LEFT JOIN facts f ON f.STORE_ID = ovf.STORE_ID
$$;

-- Per-ZIP rows inside each candidate/owned overlap (postcode-in-overlap table +
-- overlap detail drawer ZIP list). Same 2-ORS-call pattern as LIVE_OVERLAPS.
CREATE OR REPLACE FUNCTION FLEET_APP.LOCATION.LIVE_OVERLAP_ZIPS(
  P_CANDIDATE_ID VARCHAR, P_BAND INT, P_REGION VARCHAR)
RETURNS TABLE (OVERLAP_ID VARCHAR, OWNED_STORE_ID VARCHAR, OWNED_STORE VARCHAR,
               ZIP VARCHAR, POPULATION INT, HOUSEHOLDS INT, MEDIAN_INCOME NUMBER(12,0), GEO GEOGRAPHY)
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-location-diagnostics","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH cand AS (
    SELECT TO_GEOGRAPHY(f.value:geometry) AS poly
    FROM TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES(
      'driving-car',
      ARRAY_CONSTRUCT(ARRAY_CONSTRUCT(
        (SELECT LON FROM FLEET_INTELLIGENCE.LOCATION.STORE_FACTS WHERE REGION = P_REGION AND STORE_ID = P_CANDIDATE_ID),
        (SELECT LAT FROM FLEET_INTELLIGENCE.LOCATION.STORE_FACTS WHERE REGION = P_REGION AND STORE_ID = P_CANDIDATE_ID))),
      ARRAY_CONSTRUCT(P_BAND * 60), 'time', P_REGION)) resp,
      LATERAL FLATTEN(input => resp.RESPONSE:features) f
  ),
  owned AS (
    SELECT STORE_ID, POI_NAME, GEO
    FROM TABLE(FLEET_APP.LOCATION.LIVE_OWNED_CATCHMENTS(P_BAND, P_REGION))
  ),
  ov AS (
    SELECT o.STORE_ID, o.POI_NAME, ST_INTERSECTION(c.poly, o.GEO) AS g
    FROM cand c CROSS JOIN owned o
    WHERE c.poly IS NOT NULL AND o.GEO IS NOT NULL
  ),
  ovf AS (
    SELECT STORE_ID, POI_NAME, g FROM ov WHERE g IS NOT NULL AND ST_AREA(g) > 0
  )
  SELECT P_CANDIDATE_ID || '~' || ovf.STORE_ID AS overlap_id, ovf.STORE_ID AS owned_store_id,
         ovf.POI_NAME AS owned_store, z.ZIP, z.POPULATION, z.HOUSEHOLDS, z.MEDIAN_INCOME, z.GEOG AS geo
  FROM ovf JOIN FLEET_INTELLIGENCE.LOCATION.ZIP_AREAS z
    ON z.REGION = P_REGION AND ST_WITHIN(z.CENTROID, ovf.g)
$$;

-- Overlap-intensity surface for the Site Impact map (the "smart" replacement for
-- stacking one semi-transparent intersection polygon per owned store, which
-- compounds into an opaque blob). Instead of N stacked fills, this returns a
-- single per-H3-cell coverage-count surface: for every household cell inside the
-- CANDIDATE isochrone, OVERLAP_COUNT is the number of OWNED store catchments that
-- also cover that cell = the local cannibalisation pressure. Rendered as one
-- deck.gl H3 layer graded light->dark by OVERLAP_COUNT (no alpha stacking).
-- Two ORS calls total (candidate iso + LIVE_OWNED_CATCHMENTS), nothing
-- precomputed (Architecture Tenet 9); the region ORS must be RESUMED.
--   cannibalised_revenue = cell_hh * P_VALUE_PER_HH * P_CAPTURE_RATE * overlap_count
-- P_CAPTURE_RATE is a fraction (0..1). Only cells with overlap_count > 0 (true
-- overlap zones) are returned; greenfield cells inside the candidate iso but in
-- no owned catchment are omitted.
CREATE OR REPLACE FUNCTION FLEET_APP.LOCATION.LIVE_OVERLAP_CELLS(
  P_CANDIDATE_ID VARCHAR, P_BAND INT, P_REGION VARCHAR,
  P_VALUE_PER_HH FLOAT, P_CAPTURE_RATE FLOAT)
RETURNS TABLE (H3 VARCHAR, HOUSEHOLDS INT, OVERLAP_COUNT INT,
               CANNIBALISED_REVENUE NUMBER(18,0), CENTROID GEOGRAPHY)
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-location-diagnostics","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH cand AS (
    SELECT TO_GEOGRAPHY(f.value:geometry) AS poly
    FROM TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES(
      'driving-car',
      ARRAY_CONSTRUCT(ARRAY_CONSTRUCT(
        (SELECT LON FROM FLEET_INTELLIGENCE.LOCATION.STORE_FACTS WHERE REGION = P_REGION AND STORE_ID = P_CANDIDATE_ID),
        (SELECT LAT FROM FLEET_INTELLIGENCE.LOCATION.STORE_FACTS WHERE REGION = P_REGION AND STORE_ID = P_CANDIDATE_ID))),
      ARRAY_CONSTRUCT(P_BAND * 60), 'time', P_REGION)) resp,
      LATERAL FLATTEN(input => resp.RESPONSE:features) f
  ),
  owned AS (
    SELECT STORE_ID, GEO
    FROM TABLE(FLEET_APP.LOCATION.LIVE_OWNED_CATCHMENTS(P_BAND, P_REGION))
    WHERE GEO IS NOT NULL
  ),
  incell AS (
    SELECT c.H3, c.HH, c.CENTROID
    FROM FLEET_INTELLIGENCE.LOCATION.HH_CELLS c, cand
    WHERE c.REGION = P_REGION AND cand.poly IS NOT NULL AND ST_WITHIN(c.CENTROID, cand.poly)
  ),
  cnt AS (
    SELECT ic.H3,
           ANY_VALUE(ic.HH) AS hh,
           ANY_VALUE(ic.CENTROID) AS centroid,
           COUNT(o.STORE_ID) AS overlap_count
    FROM incell ic
    LEFT JOIN owned o ON ST_WITHIN(ic.CENTROID, o.GEO)
    GROUP BY ic.H3
  )
  SELECT H3, hh AS households, overlap_count,
         ROUND(hh * P_VALUE_PER_HH * P_CAPTURE_RATE * overlap_count)::NUMBER(18,0) AS cannibalised_revenue,
         centroid
  FROM cnt
  WHERE overlap_count > 0
$$;

-- Live closure overlap for Closure Impact: intersects the CLOSING store's drive-time
-- catchment with every SURVIVING store's catchment (all catchments from ONE multi-location
-- ORS call via LIVE_OWNED_CATCHMENTS). Each row = the shared area a survivor could inherit.
-- Finance is user-driven (mirrors LIVE_CANNIBALISATION/LIVE_OVERLAPS), not synthetic annuals:
--   retained_revenue = overlap_hh * P_VALUE_PER_HH * P_RETENTION_RATE
--   retained_ebitda  = retained_revenue * P_EBITDA_MARGIN
--   home/sample/walk  = retained_revenue * the CLOSING store's HV/SAMPLE/WALKIN split
-- P_EBITDA_MARGIN and P_RETENTION_RATE are fractions (0..1). This is the geometric overlap
-- view; the existing "gainers" table stays as the nearest-survivor (Voronoi) attribution.
DROP FUNCTION IF EXISTS FLEET_APP.LOCATION.LIVE_CLOSURE_OVERLAPS(VARCHAR, INT, VARCHAR);
CREATE OR REPLACE FUNCTION FLEET_APP.LOCATION.LIVE_CLOSURE_OVERLAPS(
  P_CLOSED_ID VARCHAR, P_BAND INT, P_REGION VARCHAR,
  P_VALUE_PER_HH FLOAT, P_EBITDA_MARGIN FLOAT, P_RETENTION_RATE FLOAT)
RETURNS TABLE (OVERLAP_ID VARCHAR, SURVIVING_STORE_ID VARCHAR, SURVIVING_STORE VARCHAR, BAND_MIN INT,
               OVERLAP_GEO GEOGRAPHY, OVERLAP_AREA_SQKM NUMBER(14,3), HOUSEHOLDS INT, ZIP_COUNT INT,
               POPULATION INT, RETAINED_REVENUE NUMBER(18,0), RETAINED_EBITDA NUMBER(18,0),
               HOME_VISIT NUMBER(18,0), SAMPLE_REV NUMBER(18,0), WALK_IN NUMBER(18,0),
               TRANSFER_PROB NUMBER(6,3), STATUS VARCHAR)
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-location-diagnostics","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH cats AS (
    SELECT STORE_ID, POI_NAME, GEO FROM TABLE(FLEET_APP.LOCATION.LIVE_OWNED_CATCHMENTS(P_BAND, P_REGION))
  ),
  closed_cat AS (SELECT GEO FROM cats WHERE STORE_ID = P_CLOSED_ID),
  cfact AS (
    SELECT HV_PCT, SAMPLE_PCT, WALKIN_PCT
    FROM FLEET_INTELLIGENCE.LOCATION.STORE_FACTS WHERE REGION = P_REGION AND STORE_ID = P_CLOSED_ID
  ),
  tot AS (
    SELECT SUM(c.HH) AS total_hh
    FROM FLEET_INTELLIGENCE.LOCATION.HH_CELLS c, closed_cat
    WHERE c.REGION = P_REGION AND ST_WITHIN(c.CENTROID, closed_cat.GEO)
  ),
  surv AS (SELECT STORE_ID, POI_NAME, GEO FROM cats WHERE STORE_ID <> P_CLOSED_ID),
  ov AS (
    SELECT s.STORE_ID, s.POI_NAME, ST_INTERSECTION(cc.GEO, s.GEO) AS g
    FROM surv s CROSS JOIN closed_cat cc
  ),
  ovf AS (SELECT STORE_ID, POI_NAME, g FROM ov WHERE g IS NOT NULL AND ST_AREA(g) > 0),
  hh AS (
    SELECT ovf.STORE_ID, SUM(c.HH) AS households
    FROM ovf JOIN FLEET_INTELLIGENCE.LOCATION.HH_CELLS c
      ON c.REGION = P_REGION AND ST_WITHIN(c.CENTROID, ovf.g)
    GROUP BY ovf.STORE_ID
  ),
  zp AS (
    SELECT ovf.STORE_ID, COUNT(*) AS zip_count, SUM(z.POPULATION) AS population
    FROM ovf JOIN FLEET_INTELLIGENCE.LOCATION.ZIP_AREAS z
      ON z.REGION = P_REGION AND ST_WITHIN(z.CENTROID, ovf.g)
    GROUP BY ovf.STORE_ID
  )
  SELECT P_CLOSED_ID || '~' || ovf.STORE_ID AS overlap_id, ovf.STORE_ID AS surviving_store_id,
         ovf.POI_NAME AS surviving_store, P_BAND AS band_min, ovf.g AS overlap_geo,
         ROUND(ST_AREA(ovf.g) / 1e6, 3)::NUMBER(14,3) AS overlap_area_sqkm,
         COALESCE(hh.households, 0) AS households, COALESCE(zp.zip_count, 0) AS zip_count,
         COALESCE(zp.population, 0) AS population,
         ROUND(COALESCE(hh.households, 0) * P_VALUE_PER_HH * P_RETENTION_RATE)::NUMBER(18,0) AS retained_revenue,
         ROUND(COALESCE(hh.households, 0) * P_VALUE_PER_HH * P_RETENTION_RATE * P_EBITDA_MARGIN)::NUMBER(18,0) AS retained_ebitda,
         ROUND(COALESCE(hh.households, 0) * P_VALUE_PER_HH * P_RETENTION_RATE * cf.HV_PCT)::NUMBER(18,0) AS home_visit,
         ROUND(COALESCE(hh.households, 0) * P_VALUE_PER_HH * P_RETENTION_RATE * cf.SAMPLE_PCT)::NUMBER(18,0) AS sample_rev,
         ROUND(COALESCE(hh.households, 0) * P_VALUE_PER_HH * P_RETENTION_RATE * cf.WALKIN_PCT)::NUMBER(18,0) AS walk_in,
         LEAST(1, COALESCE(hh.households, 0) / NULLIF(t.total_hh, 0))::NUMBER(6,3) AS transfer_prob,
         'RETAINED' AS status
  FROM ovf
  LEFT JOIN hh ON hh.STORE_ID = ovf.STORE_ID
  LEFT JOIN zp ON zp.STORE_ID = ovf.STORE_ID
  CROSS JOIN cfact cf
  CROSS JOIN tot t
$$;

-- Per-ZIP closure classification: every ZIP whose centroid is inside the closing store's
-- catchment, flagged RETAINED (also inside at least one surviving store's catchment within the
-- band) or AT_RISK (no surviving store reaches it within the band). REVENUE/EBITDA are the
-- user-driven value of each ZIP's households (households * P_VALUE_PER_HH * P_RETENTION_RATE),
-- so the app can SUM(REVENUE) GROUP BY STATUS for retained-vs-at-risk KPIs and a closure risk
-- score. P_EBITDA_MARGIN and P_RETENTION_RATE are fractions (0..1). Feeds the ZIP-in-overlap
-- table + closure detail drawer + the RETAINED/AT_RISK map choropleth.
DROP FUNCTION IF EXISTS FLEET_APP.LOCATION.LIVE_CLOSURE_ZIPS(VARCHAR, INT, VARCHAR);
CREATE OR REPLACE FUNCTION FLEET_APP.LOCATION.LIVE_CLOSURE_ZIPS(
  P_CLOSED_ID VARCHAR, P_BAND INT, P_REGION VARCHAR,
  P_VALUE_PER_HH FLOAT, P_EBITDA_MARGIN FLOAT, P_RETENTION_RATE FLOAT)
RETURNS TABLE (ZIP VARCHAR, STATUS VARCHAR, NEAREST_SURVIVOR VARCHAR,
               POPULATION INT, HOUSEHOLDS INT, MEDIAN_INCOME NUMBER(12,0),
               REVENUE NUMBER(18,0), EBITDA NUMBER(18,0), GEO GEOGRAPHY)
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-location-diagnostics","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH cats AS (
    SELECT STORE_ID, POI_NAME, GEO FROM TABLE(FLEET_APP.LOCATION.LIVE_OWNED_CATCHMENTS(P_BAND, P_REGION))
  ),
  closed_cat AS (SELECT GEO FROM cats WHERE STORE_ID = P_CLOSED_ID),
  surv AS (SELECT STORE_ID, POI_NAME, GEO FROM cats WHERE STORE_ID <> P_CLOSED_ID),
  zin AS (
    SELECT z.ZIP, z.POPULATION, z.HOUSEHOLDS, z.MEDIAN_INCOME, z.CENTROID, z.GEOG
    FROM FLEET_INTELLIGENCE.LOCATION.ZIP_AREAS z, closed_cat
    WHERE z.REGION = P_REGION AND ST_WITHIN(z.CENTROID, closed_cat.GEO)
  ),
  zcov AS (
    SELECT zin.ZIP, ANY_VALUE(s.POI_NAME) AS surv_name, COUNT(*) AS n
    FROM zin JOIN surv s ON ST_WITHIN(zin.CENTROID, s.GEO)
    GROUP BY zin.ZIP
  )
  SELECT zin.ZIP,
         CASE WHEN COALESCE(zcov.n, 0) > 0 THEN 'RETAINED' ELSE 'AT_RISK' END AS status,
         zcov.surv_name AS nearest_survivor,
         zin.POPULATION, zin.HOUSEHOLDS, zin.MEDIAN_INCOME,
         ROUND(zin.HOUSEHOLDS * P_VALUE_PER_HH * P_RETENTION_RATE)::NUMBER(18,0) AS revenue,
         ROUND(zin.HOUSEHOLDS * P_VALUE_PER_HH * P_RETENTION_RATE * P_EBITDA_MARGIN)::NUMBER(18,0) AS ebitda,
         zin.GEOG AS geo
  FROM zin LEFT JOIN zcov ON zcov.ZIP = zin.ZIP
$$;

-- Live closure coverage cells for the Closure Impact H3 heatmap (mirrors
-- LIVE_OVERLAP_CELLS - the proven-stable Site Impact pattern). For every H3
-- res-8 household cell whose centroid is inside the CLOSING store's drive-time
-- catchment, count how many SURVIVING store catchments still reach it. This is
-- the closure-risk signal: SURVIVOR_COUNT = 0 -> AT_RISK (leakage), > 0 ->
-- RETAINED. Uses ONLY ST_WITHIN over the pre-rasterized HH_CELLS grid (no
-- ST_INTERSECTION), so it avoids the fragile polygon-intersection path. Two ORS
-- calls total via LIVE_OWNED_CATCHMENTS; region ORS must be RESUMED (Tenet 9).
-- P_RETENTION_RATE is a fraction (0..1). Rendered as a single deck.gl
-- H3HexagonLayer graded by SURVIVOR_COUNT.
CREATE OR REPLACE FUNCTION FLEET_APP.LOCATION.LIVE_CLOSURE_CELLS(
  P_CLOSED_ID VARCHAR, P_BAND INT, P_REGION VARCHAR,
  P_VALUE_PER_HH FLOAT, P_RETENTION_RATE FLOAT)
RETURNS TABLE (H3 VARCHAR, HOUSEHOLDS INT, SURVIVOR_COUNT INT, STATUS VARCHAR,
               NEAREST_SURVIVOR VARCHAR, RETAINED_REVENUE NUMBER(18,0), CENTROID GEOGRAPHY)
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-location-diagnostics","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH cats AS (
    SELECT c.STORE_ID, sf.POI_NAME, sf.LON, sf.LAT, c.GEO
    FROM TABLE(FLEET_APP.LOCATION.LIVE_OWNED_CATCHMENTS(P_BAND, P_REGION)) c
    JOIN FLEET_INTELLIGENCE.LOCATION.STORE_FACTS sf
      ON sf.STORE_ID = c.STORE_ID AND sf.REGION = P_REGION
    WHERE c.GEO IS NOT NULL
  ),
  closed_cat AS (SELECT GEO FROM cats WHERE STORE_ID = P_CLOSED_ID),
  surv AS (SELECT STORE_ID, POI_NAME, LON, LAT, GEO FROM cats WHERE STORE_ID <> P_CLOSED_ID),
  incell AS (
    SELECT c.H3, c.HH, c.CENTROID
    FROM FLEET_INTELLIGENCE.LOCATION.HH_CELLS c, closed_cat
    WHERE c.REGION = P_REGION AND closed_cat.GEO IS NOT NULL AND ST_WITHIN(c.CENTROID, closed_cat.GEO)
  ),
  cov AS (
    SELECT ic.H3,
           ANY_VALUE(ic.HH) AS hh,
           ANY_VALUE(ic.CENTROID) AS centroid,
           COUNT(s.STORE_ID) AS survivor_count,
           MIN_BY(s.POI_NAME, ST_DISTANCE(ic.CENTROID, ST_MAKEPOINT(s.LON, s.LAT))) AS nearest_survivor
    FROM incell ic
    LEFT JOIN surv s ON ST_WITHIN(ic.CENTROID, s.GEO)
    GROUP BY ic.H3
  )
  SELECT H3, hh AS households, survivor_count,
         CASE WHEN survivor_count > 0 THEN 'RETAINED' ELSE 'AT_RISK' END AS status,
         nearest_survivor,
         ROUND(hh * P_VALUE_PER_HH * P_RETENTION_RATE)::NUMBER(18,0) AS retained_revenue,
         centroid
  FROM cov
$$;

-- Closure "gainers" attribution as an owner's-rights UDTF (mirrors the proven
-- LIVE_CANNIBALISATION pattern). Assigns every H3 household cell inside the
-- CLOSING store's catchment to its nearest SURVIVING store (closed store
-- excluded), then rolls up households + user-driven revenue per gaining store.
-- HV/Sample/Walk-in use the CLOSING store's interaction mix (matching the prior
-- inline query's semantics). Moving this off the inline app query removes the
-- fragile caller-side ST_WITHIN-over-raw-isochrone + CROSS JOIN plan that
-- intermittently tripped Snowflake internal error 300010/000603. Region-scoped;
-- P_RETENTION_RATE is a fraction (0..1). Region ORS must be RESUMED (Tenet 9).
CREATE OR REPLACE FUNCTION FLEET_APP.LOCATION.LIVE_CLOSURE_GAINERS(
  P_CLOSED_ID VARCHAR, P_BAND INT, P_REGION VARCHAR,
  P_VALUE_PER_HH FLOAT, P_RETENTION_RATE FLOAT)
RETURNS TABLE (GAIN_ID VARCHAR, GAINING_STORE VARCHAR, HOUSEHOLDS INT, PCT_OF_CLOSED NUMBER(6,1),
               REVENUE NUMBER(18,0), HOME_VISIT NUMBER(18,0), SAMPLE_REV NUMBER(18,0), WALK_IN NUMBER(18,0))
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-location-diagnostics","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH closed_cat AS (
    SELECT GEO FROM TABLE(FLEET_APP.LOCATION.LIVE_OWNED_CATCHMENTS(P_BAND, P_REGION))
    WHERE STORE_ID = P_CLOSED_ID
  ),
  csplit AS (
    SELECT HV_PCT, SAMPLE_PCT, WALKIN_PCT
    FROM FLEET_INTELLIGENCE.LOCATION.STORE_FACTS WHERE REGION = P_REGION AND STORE_ID = P_CLOSED_ID
  ),
  survivors AS (
    SELECT STORE_ID, POI_NAME, LON, LAT
    FROM FLEET_INTELLIGENCE.LOCATION.STORE_FACTS
    WHERE REGION = P_REGION AND STORE_ROLE = 'OWNED' AND STORE_ID <> P_CLOSED_ID
  ),
  incell AS (
    SELECT c.H3, c.HH, c.CENTROID
    FROM FLEET_INTELLIGENCE.LOCATION.HH_CELLS c, closed_cat
    WHERE c.REGION = P_REGION AND closed_cat.GEO IS NOT NULL AND ST_WITHIN(c.CENTROID, closed_cat.GEO)
  ),
  tot AS (SELECT SUM(HH) AS total_in FROM incell),
  assign AS (
    SELECT ic.H3, ic.HH, sv.STORE_ID AS GAIN_ID
    FROM incell ic CROSS JOIN survivors sv
    QUALIFY ROW_NUMBER() OVER (PARTITION BY ic.H3 ORDER BY ST_DISTANCE(ic.CENTROID, ST_MAKEPOINT(sv.LON, sv.LAT)), sv.STORE_ID) = 1
  ),
  agg AS (SELECT GAIN_ID, SUM(HH) AS hh_inh FROM assign GROUP BY 1)
  SELECT a.GAIN_ID AS gain_id, g.POI_NAME AS gaining_store, a.hh_inh AS households,
         ROUND(100 * a.hh_inh / NULLIF((SELECT total_in FROM tot), 0), 1)::NUMBER(6,1) AS pct_of_closed,
         ROUND(a.hh_inh * P_VALUE_PER_HH * P_RETENTION_RATE)::NUMBER(18,0) AS revenue,
         ROUND(a.hh_inh * P_VALUE_PER_HH * P_RETENTION_RATE * cs.HV_PCT)::NUMBER(18,0) AS home_visit,
         ROUND(a.hh_inh * P_VALUE_PER_HH * P_RETENTION_RATE * cs.SAMPLE_PCT)::NUMBER(18,0) AS sample_rev,
         ROUND(a.hh_inh * P_VALUE_PER_HH * P_RETENTION_RATE * cs.WALKIN_PCT)::NUMBER(18,0) AS walk_in
  FROM agg a
  JOIN FLEET_INTELLIGENCE.LOCATION.STORE_FACTS g ON g.STORE_ID = a.GAIN_ID AND g.REGION = P_REGION
  CROSS JOIN csplit cs
  ORDER BY revenue DESC
$$;

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

-- Live ZIP/overlap UDTFs (owner's-rights; consumers only need USAGE).
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_ZIP_BANDS(VARCHAR, VARCHAR) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_ZIP_BANDS(VARCHAR, VARCHAR) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_ZIP_BANDS(VARCHAR, VARCHAR) TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_OWNED_CATCHMENTS(INT, VARCHAR) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_OWNED_CATCHMENTS(INT, VARCHAR) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_OWNED_CATCHMENTS(INT, VARCHAR) TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_CANNIBALISATION(VARCHAR, INT, VARCHAR, FLOAT, FLOAT, FLOAT) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_CANNIBALISATION(VARCHAR, INT, VARCHAR, FLOAT, FLOAT, FLOAT) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_CANNIBALISATION(VARCHAR, INT, VARCHAR, FLOAT, FLOAT, FLOAT) TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_OVERLAPS(VARCHAR, INT, VARCHAR, FLOAT, FLOAT, FLOAT) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_OVERLAPS(VARCHAR, INT, VARCHAR, FLOAT, FLOAT, FLOAT) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_OVERLAPS(VARCHAR, INT, VARCHAR, FLOAT, FLOAT, FLOAT) TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_OVERLAP_ZIPS(VARCHAR, INT, VARCHAR) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_OVERLAP_ZIPS(VARCHAR, INT, VARCHAR) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_OVERLAP_ZIPS(VARCHAR, INT, VARCHAR) TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_OVERLAP_CELLS(VARCHAR, INT, VARCHAR, FLOAT, FLOAT) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_OVERLAP_CELLS(VARCHAR, INT, VARCHAR, FLOAT, FLOAT) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_OVERLAP_CELLS(VARCHAR, INT, VARCHAR, FLOAT, FLOAT) TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_CLOSURE_OVERLAPS(VARCHAR, INT, VARCHAR, FLOAT, FLOAT, FLOAT) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_CLOSURE_OVERLAPS(VARCHAR, INT, VARCHAR, FLOAT, FLOAT, FLOAT) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_CLOSURE_OVERLAPS(VARCHAR, INT, VARCHAR, FLOAT, FLOAT, FLOAT) TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_CLOSURE_ZIPS(VARCHAR, INT, VARCHAR, FLOAT, FLOAT, FLOAT) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_CLOSURE_ZIPS(VARCHAR, INT, VARCHAR, FLOAT, FLOAT, FLOAT) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_CLOSURE_ZIPS(VARCHAR, INT, VARCHAR, FLOAT, FLOAT, FLOAT) TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_CLOSURE_CELLS(VARCHAR, INT, VARCHAR, FLOAT, FLOAT) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_CLOSURE_CELLS(VARCHAR, INT, VARCHAR, FLOAT, FLOAT) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_CLOSURE_CELLS(VARCHAR, INT, VARCHAR, FLOAT, FLOAT) TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_CLOSURE_GAINERS(VARCHAR, INT, VARCHAR, FLOAT, FLOAT) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_CLOSURE_GAINERS(VARCHAR, INT, VARCHAR, FLOAT, FLOAT) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_CLOSURE_GAINERS(VARCHAR, INT, VARCHAR, FLOAT, FLOAT) TO ROLE FLEET_APP_ADMIN;

-- ===========================================================================
-- Point-anchored live catchment (drive-time market analysis)
-- ===========================================================================
-- Powers the redesigned Catchment app view. Unlike the LOCATION.LIVE_* family
-- (keyed by STORE_ID over the store estate), these are keyed by an ARBITRARY
-- point (P_LON/P_LAT), so the view can anchor on any selected POI OR a greenfield
-- map click. Nothing is precomputed (Architecture Tenet 9): each call hits
-- OPENROUTESERVICE_APP.CORE.ISOCHRONES live via the fast array + 'time' (SECONDS)
-- overload with LATERAL FLATTEN (~1s vs ~70s for the 5-arg scalar form). The
-- region's ORS service must be RESUMED. Sociodemographics reuse the SAME real
-- data as Site Impact / Closure Impact: LOCATION.ZIP_AREAS (SafeGraph population /
-- households / median income) - US-only; when absent those metrics are 0 and the
-- Overture venue/address counts still populate. Owner's-rights; consumers need
-- only USAGE. Schema is created defensively (the catchment pack owns it normally).
CREATE SCHEMA IF NOT EXISTS FLEET_APP.CATCHMENT
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- Anchor resolution (all three functions): the drive-time origin is COALESCE(
--   the coords of the named POI (P_POI_NAME) if it exists in the region,
--   the explicit P_LON/P_LAT (greenfield map click),
--   the region's POI centroid (safe default so nothing is ever called with NULL)).
-- Coords are resolved INSIDE the body via scalar subqueries + params (never a
-- CTE column), because Snowflake cannot evaluate a scalar subquery over a CTE as
-- a table-function argument, and ISOCHRONES only accepts literal/scalar-subquery/
-- bind args (not correlated per-row columns).
--
-- One row per drive-time band (cumulative "within X min"): the reachable polygon
-- plus real population/households/median income (household-weighted mean of ZIP
-- medians) and Overture venue + address counts inside it. P_BANDS is an ARRAY of
-- SECONDS (e.g. ARRAY_CONSTRUCT(300,600,900) for 5/10/15 min); ORS returns one
-- nested polygon per band. Feeds the KPI strip, per-band stats table, and the
-- nested-ring map layers.
DROP FUNCTION IF EXISTS FLEET_APP.CATCHMENT.LIVE_CATCHMENT(FLOAT, FLOAT, ARRAY, VARCHAR);
CREATE OR REPLACE FUNCTION FLEET_APP.CATCHMENT.LIVE_CATCHMENT(
  P_POI_NAME VARCHAR, P_LON FLOAT, P_LAT FLOAT, P_BANDS ARRAY, P_REGION VARCHAR)
RETURNS TABLE (BAND_MIN INT, GEO GEOGRAPHY, AREA_SQKM NUMBER(14,3),
               POPULATION INT, HOUSEHOLDS INT, MEDIAN_INCOME NUMBER(12,0),
               VENUES INT, ADDRESSES INT)
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH iso AS (
    SELECT (f.value:properties:value::INT)/60 AS band_min,
           TO_GEOGRAPHY(f.value:geometry) AS poly
    FROM TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES(
      'driving-car',
      ARRAY_CONSTRUCT(ARRAY_CONSTRUCT(
        COALESCE((SELECT LONGITUDE FROM FLEET_INTELLIGENCE.CATCHMENT.POIS WHERE REGION=P_REGION AND POI_NAME=P_POI_NAME ORDER BY 1 LIMIT 1), P_LON, (SELECT AVG(LONGITUDE) FROM FLEET_INTELLIGENCE.CATCHMENT.POIS WHERE REGION=P_REGION)),
        COALESCE((SELECT LATITUDE FROM FLEET_INTELLIGENCE.CATCHMENT.POIS WHERE REGION=P_REGION AND POI_NAME=P_POI_NAME ORDER BY 1 LIMIT 1), P_LAT, (SELECT AVG(LATITUDE) FROM FLEET_INTELLIGENCE.CATCHMENT.POIS WHERE REGION=P_REGION)))),
      P_BANDS, 'time', P_REGION)) resp,
      LATERAL FLATTEN(input => resp.RESPONSE:features) f
  ),
  zip AS (
    SELECT band_min,
           SUM(POPULATION * frac) AS population,
           SUM(HOUSEHOLDS * frac) AS households,
           ROUND(SUM(MEDIAN_INCOME * HOUSEHOLDS * frac) / NULLIF(SUM(HOUSEHOLDS * frac), 0)) AS median_income
    FROM (
      SELECT i.band_min, z.POPULATION, z.HOUSEHOLDS, z.MEDIAN_INCOME,
             LEAST(1, ST_AREA(ST_INTERSECTION(z.GEOG, i.poly)) / NULLIF(ST_AREA(z.GEOG), 0)) AS frac
      FROM iso i JOIN FLEET_INTELLIGENCE.LOCATION.ZIP_AREAS z
        ON z.REGION = P_REGION AND i.poly IS NOT NULL AND ST_INTERSECTS(z.GEOG, i.poly)
    )
    GROUP BY band_min
  ),
  ven AS (
    SELECT i.band_min, COUNT(*) AS venues
    FROM iso i JOIN FLEET_INTELLIGENCE.CATCHMENT.POIS p
      ON p.REGION = P_REGION AND i.poly IS NOT NULL AND ST_WITHIN(p.GEOMETRY, i.poly)
    GROUP BY i.band_min
  ),
  addr AS (
    SELECT i.band_min, COUNT(*) AS addresses
    FROM iso i JOIN FLEET_INTELLIGENCE.CATCHMENT.REGIONAL_ADDRESSES a
      ON a.REGION = P_REGION AND i.poly IS NOT NULL AND ST_WITHIN(a.GEOMETRY, i.poly)
    GROUP BY i.band_min
  )
  SELECT i.band_min, i.poly AS geo,
         ROUND(ST_AREA(i.poly) / 1e6, 3)::NUMBER(14,3) AS area_sqkm,
         ROUND(COALESCE(zip.population, 0))::INT AS population,
         ROUND(COALESCE(zip.households, 0))::INT AS households,
         COALESCE(zip.median_income, 0)::NUMBER(12,0) AS median_income,
         COALESCE(ven.venues, 0) AS venues,
         COALESCE(addr.addresses, 0) AS addresses
  FROM iso i
  LEFT JOIN zip  ON zip.band_min  = i.band_min
  LEFT JOIN ven  ON ven.band_min  = i.band_min
  LEFT JOIN addr ON addr.band_min = i.band_min
  ORDER BY i.band_min
$$;

-- Venue category breakdown within a single band's drive-time polygon.
DROP FUNCTION IF EXISTS FLEET_APP.CATCHMENT.LIVE_CATCHMENT_CATEGORIES(FLOAT, FLOAT, INT, VARCHAR);
CREATE OR REPLACE FUNCTION FLEET_APP.CATCHMENT.LIVE_CATCHMENT_CATEGORIES(
  P_POI_NAME VARCHAR, P_LON FLOAT, P_LAT FLOAT, P_BAND INT, P_REGION VARCHAR)
RETURNS TABLE (BASIC_CATEGORY VARCHAR, VENUES INT)
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH iso AS (
    SELECT TO_GEOGRAPHY(f.value:geometry) AS poly
    FROM TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES(
      'driving-car',
      ARRAY_CONSTRUCT(ARRAY_CONSTRUCT(
        COALESCE((SELECT LONGITUDE FROM FLEET_INTELLIGENCE.CATCHMENT.POIS WHERE REGION=P_REGION AND POI_NAME=P_POI_NAME ORDER BY 1 LIMIT 1), P_LON, (SELECT AVG(LONGITUDE) FROM FLEET_INTELLIGENCE.CATCHMENT.POIS WHERE REGION=P_REGION)),
        COALESCE((SELECT LATITUDE FROM FLEET_INTELLIGENCE.CATCHMENT.POIS WHERE REGION=P_REGION AND POI_NAME=P_POI_NAME ORDER BY 1 LIMIT 1), P_LAT, (SELECT AVG(LATITUDE) FROM FLEET_INTELLIGENCE.CATCHMENT.POIS WHERE REGION=P_REGION)))),
      ARRAY_CONSTRUCT(P_BAND * 60), 'time', P_REGION)) resp,
      LATERAL FLATTEN(input => resp.RESPONSE:features) f
  )
  SELECT p.BASIC_CATEGORY, COUNT(*) AS venues
  FROM iso i JOIN FLEET_INTELLIGENCE.CATCHMENT.POIS p
    ON p.REGION = P_REGION AND p.BASIC_CATEGORY IS NOT NULL
   AND i.poly IS NOT NULL AND ST_WITHIN(p.GEOMETRY, i.poly)
  GROUP BY p.BASIC_CATEGORY
  ORDER BY venues DESC
$$;

-- Competitor / nearby venues inside a band's drive-time polygon (drive-time, not a
-- straight-line buffer). Same category as the anchor when P_CATEGORY is supplied;
-- all venues when it is NULL (greenfield map-click anchor with no category).
DROP FUNCTION IF EXISTS FLEET_APP.CATCHMENT.LIVE_CATCHMENT_COMPETITORS(FLOAT, FLOAT, INT, VARCHAR, VARCHAR);
CREATE OR REPLACE FUNCTION FLEET_APP.CATCHMENT.LIVE_CATCHMENT_COMPETITORS(
  P_POI_NAME VARCHAR, P_LON FLOAT, P_LAT FLOAT, P_BAND INT, P_REGION VARCHAR, P_CATEGORY VARCHAR)
RETURNS TABLE (POI_NAME VARCHAR, BASIC_CATEGORY VARCHAR, LONGITUDE FLOAT, LATITUDE FLOAT)
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH iso AS (
    SELECT TO_GEOGRAPHY(f.value:geometry) AS poly
    FROM TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES(
      'driving-car',
      ARRAY_CONSTRUCT(ARRAY_CONSTRUCT(
        COALESCE((SELECT LONGITUDE FROM FLEET_INTELLIGENCE.CATCHMENT.POIS WHERE REGION=P_REGION AND POI_NAME=P_POI_NAME ORDER BY 1 LIMIT 1), P_LON, (SELECT AVG(LONGITUDE) FROM FLEET_INTELLIGENCE.CATCHMENT.POIS WHERE REGION=P_REGION)),
        COALESCE((SELECT LATITUDE FROM FLEET_INTELLIGENCE.CATCHMENT.POIS WHERE REGION=P_REGION AND POI_NAME=P_POI_NAME ORDER BY 1 LIMIT 1), P_LAT, (SELECT AVG(LATITUDE) FROM FLEET_INTELLIGENCE.CATCHMENT.POIS WHERE REGION=P_REGION)))),
      ARRAY_CONSTRUCT(P_BAND * 60), 'time', P_REGION)) resp,
      LATERAL FLATTEN(input => resp.RESPONSE:features) f
  )
  SELECT p.POI_NAME, p.BASIC_CATEGORY, p.LONGITUDE, p.LATITUDE
  FROM iso i JOIN FLEET_INTELLIGENCE.CATCHMENT.POIS p
    ON p.REGION = P_REGION AND i.poly IS NOT NULL AND ST_WITHIN(p.GEOMETRY, i.poly)
  WHERE (P_CATEGORY IS NULL OR p.BASIC_CATEGORY = P_CATEGORY)
$$;

-- Grants (owner's-rights UDTFs; consumers only need USAGE).
GRANT USAGE ON FUNCTION FLEET_APP.CATCHMENT.LIVE_CATCHMENT(VARCHAR, FLOAT, FLOAT, ARRAY, VARCHAR) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.CATCHMENT.LIVE_CATCHMENT(VARCHAR, FLOAT, FLOAT, ARRAY, VARCHAR) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.CATCHMENT.LIVE_CATCHMENT(VARCHAR, FLOAT, FLOAT, ARRAY, VARCHAR) TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.CATCHMENT.LIVE_CATCHMENT_CATEGORIES(VARCHAR, FLOAT, FLOAT, INT, VARCHAR) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.CATCHMENT.LIVE_CATCHMENT_CATEGORIES(VARCHAR, FLOAT, FLOAT, INT, VARCHAR) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.CATCHMENT.LIVE_CATCHMENT_CATEGORIES(VARCHAR, FLOAT, FLOAT, INT, VARCHAR) TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.CATCHMENT.LIVE_CATCHMENT_COMPETITORS(VARCHAR, FLOAT, FLOAT, INT, VARCHAR, VARCHAR) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.CATCHMENT.LIVE_CATCHMENT_COMPETITORS(VARCHAR, FLOAT, FLOAT, INT, VARCHAR, VARCHAR) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.CATCHMENT.LIVE_CATCHMENT_COMPETITORS(VARCHAR, FLOAT, FLOAT, INT, VARCHAR, VARCHAR) TO ROLE FLEET_APP_ADMIN;

-- =============================================================================
-- 6. FREIGHT SOURCING OPTIMIZER  (plant-to-customer "location swaps")
--    Region-agnostic sourcing intelligence built from data already present:
--    a deterministic subset of CATCHMENT.POIS becomes the "plant estate" and a
--    second, disjoint subset becomes the "customer" demand points. Product
--    capability per plant, per-customer annual truckloads / current source, and
--    the freight rate model are SYNTHETIC and deterministic (HASH-seeded) - a
--    proxy for first-party sourcing data. NO Data Studio / UNIFIED change.
--
--    LIVE ROUTING (Architecture Tenet 9): this build does NOT precompute any
--    drive-time matrix. Plant x customer road distance/duration is computed at
--    interaction time by FLEET_APP.SOURCING.LIVE_SOURCING_LANES calling
--    OPENROUTESERVICE_APP.CORE.MATRIX_TABULAR live (one call, all plant origins x
--    all customer destinations). This build only materializes NON-ORS reference
--    data: the plant estate (PLANTS), the customers (CUSTOMERS), the synthetic
--    plant capability/cost (PLANT_FACTS), per-customer demand + a data-only
--    nearest-capable-plant baseline (CUSTOMER_DEMAND), and the rate model
--    (FREIGHT_RATE). The current-source baseline uses straight-line nearest so
--    the live road-distance optimizer has something to beat.
--
--    NOTE (single-active-region model, mirrors CATCHMENT/LOCATION): the proc
--    rebuilds only the region in FLEET_INTELLIGENCE.CATCHMENT.CONFIG
--    (DELETE-by-region + INSERT), so rows for other regions are preserved. Every
--    plant and customer sits inside ONE provisioned region's ORS graph, which is
--    the requirement for the live MATRIX_TABULAR call.
-- =============================================================================
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.SOURCING
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-freight-sourcing","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.SOURCING.PLANTS (
  REGION      VARCHAR NOT NULL,
  PLANT_ID    VARCHAR NOT NULL,   -- synthetic (PL0001..), safe for dynamic SQL
  POI_ID      VARCHAR,
  PLANT_NAME  VARCHAR,
  CATEGORY    VARCHAR,
  LON         FLOAT,
  LAT         FLOAT,
  GEOG        GEOGRAPHY
) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-freight-sourcing","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.SOURCING.CUSTOMERS (
  REGION        VARCHAR NOT NULL,
  CUSTOMER_ID   VARCHAR NOT NULL,  -- synthetic (CU0001..)
  POI_ID        VARCHAR,
  CUSTOMER_NAME VARCHAR,
  LON           FLOAT,
  LAT           FLOAT,
  GEOG          GEOGRAPHY
) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-freight-sourcing","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- Synthetic plant capability + cost. PRODUCT_CAPABILITY is the set of glass
-- products the plant can make (every plant makes FLOAT; even-indexed plants make
-- COATED, odd-indexed make MIRROR, every 3rd makes LAMINATED) so any customer
-- product always has at least one capable plant when >= 2 plants exist.
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.SOURCING.PLANT_FACTS (
  REGION               VARCHAR NOT NULL,
  PLANT_ID             VARCHAR NOT NULL,
  PLANT_NAME           VARCHAR,
  PRODUCT_CAPABILITY   ARRAY,          -- synthetic: e.g. ['FLOAT','COATED']
  PRODUCTION_COST_PER_TON NUMBER(10,2),-- synthetic
  ANNUAL_CAPACITY_TONS INT             -- synthetic
) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-freight-sourcing","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- Per-customer demand + a DATA-ONLY current-source baseline (nearest capable
-- plant by straight-line distance). The live optimizer recomputes cheapest
-- source using road distance, which may differ - that gap is the saving.
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.SOURCING.CUSTOMER_DEMAND (
  REGION            VARCHAR NOT NULL,
  CUSTOMER_ID       VARCHAR NOT NULL,
  PRODUCT           VARCHAR,           -- FLOAT | COATED | MIRROR
  ANNUAL_TRUCKLOADS INT,               -- synthetic
  TONS_PER_LOAD     INT,               -- synthetic
  CURRENT_PLANT_ID  VARCHAR            -- data-only nearest capable plant (baseline)
) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-freight-sourcing","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- Freight rate model (one row per region), overridable by the app sliders.
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.SOURCING.FREIGHT_RATE (
  REGION           VARCHAR NOT NULL,
  RATE_PER_KM      NUMBER(10,4),       -- USD per km per load
  RATE_PER_TON_KM  NUMBER(10,4)        -- USD per ton-km
) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-freight-sourcing","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- Mixed-product order basket per customer (Phase 2: product-mix / inter-plant
-- transfer). One or more product lines per customer, each with tons. Powers the
-- consolidate-at-a-hub vs ship-direct tradeoff. HASH-seeded, synthetic.
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.SOURCING.ORDER_MIX (
  REGION      VARCHAR NOT NULL,
  CUSTOMER_ID VARCHAR NOT NULL,
  PRODUCT     VARCHAR,            -- FLOAT | COATED | MIRROR
  TONS        INT                 -- synthetic tons for this product line
) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-freight-sourcing","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- Build procedure: materializes the plant estate + customers + synthetic facts
-- for the active region. NO ORS calls (the matrix is computed live by the app).
-- Owner's rights. Idempotent per region.
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.SOURCING.BUILD_SOURCING_DIAGNOSTICS(P_REGION VARCHAR DEFAULT NULL)
  RETURNS VARCHAR
  LANGUAGE SQL
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-freight-sourcing","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
DECLARE
  rg VARCHAR;
BEGIN
  -- Region resolution: explicit arg wins (region-sync / admin switch pass it);
  -- otherwise fall back to the single active CATCHMENT.CONFIG region (install path).
  IF (P_REGION IS NOT NULL) THEN
    rg := P_REGION;
  ELSE
    SELECT REGION INTO rg FROM FLEET_INTELLIGENCE.CATCHMENT.CONFIG LIMIT 1;
  END IF;
  IF (rg IS NULL) THEN
    RETURN 'no region (arg NULL and no active CATCHMENT.CONFIG)';
  END IF;

  -- 1. Plant estate: deterministic subset of the region most-spread category,
  --    one plant per H3 res-6 cell (widely separated), first 6.
  DELETE FROM FLEET_INTELLIGENCE.SOURCING.PLANTS WHERE REGION = :rg;
  INSERT INTO FLEET_INTELLIGENCE.SOURCING.PLANTS
    (REGION, PLANT_ID, POI_ID, PLANT_NAME, CATEGORY, LON, LAT, GEOG)
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
         'PL' || LPAD(gidx::VARCHAR, 4, '0'),
         POI_ID, 'Plant ' || POI_NAME, BASIC_CATEGORY, LONGITUDE, LATITUDE, GEOMETRY
  FROM spread WHERE gidx <= 6;

  -- 2. Customers: same category, one per finer H3 res-7 cell, EXCLUDING the POIs
  --    already chosen as plants, first 30.
  DELETE FROM FLEET_INTELLIGENCE.SOURCING.CUSTOMERS WHERE REGION = :rg;
  INSERT INTO FLEET_INTELLIGENCE.SOURCING.CUSTOMERS
    (REGION, CUSTOMER_ID, POI_ID, CUSTOMER_NAME, LON, LAT, GEOG)
  WITH cat AS (
    SELECT BASIC_CATEGORY
    FROM FLEET_INTELLIGENCE.CATCHMENT.POIS
    WHERE REGION = :rg AND BASIC_CATEGORY IS NOT NULL AND LONGITUDE IS NOT NULL
    GROUP BY BASIC_CATEGORY
    ORDER BY COUNT(DISTINCT H3_POINT_TO_CELL_STRING(GEOMETRY, 6)) DESC, COUNT(*) DESC
    LIMIT 1
  ),
  ranked AS (
    SELECT p.POI_ID, p.POI_NAME, p.LONGITUDE, p.LATITUDE, p.GEOMETRY,
           ROW_NUMBER() OVER (PARTITION BY H3_POINT_TO_CELL_STRING(p.GEOMETRY, 7) ORDER BY p.POI_ID) AS rn_cell
    FROM FLEET_INTELLIGENCE.CATCHMENT.POIS p
    JOIN cat ON p.BASIC_CATEGORY = cat.BASIC_CATEGORY
    WHERE p.REGION = :rg AND p.LONGITUDE IS NOT NULL
      AND p.POI_ID NOT IN (SELECT POI_ID FROM FLEET_INTELLIGENCE.SOURCING.PLANTS WHERE REGION = :rg AND POI_ID IS NOT NULL)
  ),
  spread AS (
    SELECT *, ROW_NUMBER() OVER (ORDER BY POI_ID) AS cidx
    FROM ranked WHERE rn_cell = 1
  )
  SELECT :rg,
         'CU' || LPAD(cidx::VARCHAR, 4, '0'),
         POI_ID, POI_NAME, LONGITUDE, LATITUDE, GEOMETRY
  FROM spread WHERE cidx <= 30;

  -- 3. Freight rate model (seeded defaults; app sliders override at query time).
  DELETE FROM FLEET_INTELLIGENCE.SOURCING.FREIGHT_RATE WHERE REGION = :rg;
  INSERT INTO FLEET_INTELLIGENCE.SOURCING.FREIGHT_RATE (REGION, RATE_PER_KM, RATE_PER_TON_KM)
    VALUES (:rg, 1.50, 0.05);

  -- 4. Synthetic plant capability + cost (HASH-seeded, deterministic per PLANT_ID).
  DELETE FROM FLEET_INTELLIGENCE.SOURCING.PLANT_FACTS WHERE REGION = :rg;
  INSERT INTO FLEET_INTELLIGENCE.SOURCING.PLANT_FACTS
    (REGION, PLANT_ID, PLANT_NAME, PRODUCT_CAPABILITY, PRODUCTION_COST_PER_TON, ANNUAL_CAPACITY_TONS)
  WITH base AS (
    SELECT PLANT_ID, PLANT_NAME, TRY_TO_NUMBER(SUBSTR(PLANT_ID, 3)) AS gidx
    FROM FLEET_INTELLIGENCE.SOURCING.PLANTS WHERE REGION = :rg
  )
  SELECT :rg, PLANT_ID, PLANT_NAME,
         ARRAY_CONSTRUCT_COMPACT(
           'FLOAT',
           CASE WHEN MOD(gidx, 2) = 0 THEN 'COATED' END,
           CASE WHEN MOD(gidx, 2) = 1 THEN 'MIRROR' END,
           CASE WHEN MOD(gidx, 3) = 0 THEN 'LAMINATED' END
         ) AS PRODUCT_CAPABILITY,
         (280 + MOD(ABS(HASH(PLANT_ID, 7)), 121))::NUMBER(10,2) AS PRODUCTION_COST_PER_TON,
         50000 + MOD(ABS(HASH(PLANT_ID, 8)), 150001)            AS ANNUAL_CAPACITY_TONS
  FROM base;

  -- 5. Per-customer demand + data-only nearest-capable-plant baseline.
  DELETE FROM FLEET_INTELLIGENCE.SOURCING.CUSTOMER_DEMAND WHERE REGION = :rg;
  INSERT INTO FLEET_INTELLIGENCE.SOURCING.CUSTOMER_DEMAND
    (REGION, CUSTOMER_ID, PRODUCT, ANNUAL_TRUCKLOADS, TONS_PER_LOAD, CURRENT_PLANT_ID)
  WITH cust AS (
    SELECT c.CUSTOMER_ID, c.GEOG,
           CASE MOD(ABS(HASH(c.CUSTOMER_ID, 1)), 3)
             WHEN 0 THEN 'FLOAT' WHEN 1 THEN 'COATED' ELSE 'MIRROR' END AS product,
           50 + MOD(ABS(HASH(c.CUSTOMER_ID, 2)), 450) AS annual_truckloads,
           20 + MOD(ABS(HASH(c.CUSTOMER_ID, 3)), 6)   AS tons_per_load
    FROM FLEET_INTELLIGENCE.SOURCING.CUSTOMERS c
    WHERE c.REGION = :rg
  ),
  capable AS (
    SELECT cu.CUSTOMER_ID, cu.product, cu.annual_truckloads, cu.tons_per_load, pl.PLANT_ID,
           ROW_NUMBER() OVER (PARTITION BY cu.CUSTOMER_ID ORDER BY ST_DISTANCE(cu.GEOG, pl.GEOG)) AS rn
    FROM cust cu
    JOIN FLEET_INTELLIGENCE.SOURCING.PLANTS pl ON pl.REGION = :rg
    JOIN FLEET_INTELLIGENCE.SOURCING.PLANT_FACTS pf
      ON pf.REGION = :rg AND pf.PLANT_ID = pl.PLANT_ID
     AND ARRAY_CONTAINS(cu.product::VARIANT, pf.PRODUCT_CAPABILITY)
  )
  SELECT :rg, CUSTOMER_ID, product, annual_truckloads, tons_per_load, PLANT_ID
  FROM capable WHERE rn = 1;

  -- 6. Mixed-product order basket (1-3 lines/customer). Always the primary
  --    product (same HASH as CUSTOMER_DEMAND.PRODUCT), plus each other product
  --    included on a HASH coin-flip. Tons HASH-seeded per (customer, product).
  DELETE FROM FLEET_INTELLIGENCE.SOURCING.ORDER_MIX WHERE REGION = :rg;
  INSERT INTO FLEET_INTELLIGENCE.SOURCING.ORDER_MIX (REGION, CUSTOMER_ID, PRODUCT, TONS)
  WITH prods AS (
    SELECT 'FLOAT' AS product, 0 AS pk
    UNION ALL SELECT 'COATED', 1
    UNION ALL SELECT 'MIRROR', 2
  ),
  cust AS (
    SELECT CUSTOMER_ID,
           CASE MOD(ABS(HASH(CUSTOMER_ID, 1)), 3)
             WHEN 0 THEN 'FLOAT' WHEN 1 THEN 'COATED' ELSE 'MIRROR' END AS primary_product
    FROM FLEET_INTELLIGENCE.SOURCING.CUSTOMERS WHERE REGION = :rg
  )
  SELECT :rg, c.CUSTOMER_ID, p.product,
         8 + MOD(ABS(HASH(c.CUSTOMER_ID, p.pk, 9)), 15) AS tons
  FROM cust c CROSS JOIN prods p
  WHERE p.product = c.primary_product
     OR MOD(ABS(HASH(c.CUSTOMER_ID, p.pk, 10)), 2) = 0;

  RETURN 'SOURCING built for ' || rg || ' (live-routing model; no precomputed matrix)';
END;
$$;

CALL FLEET_INTELLIGENCE.SOURCING.BUILD_SOURCING_DIAGNOSTICS();

-- 6b. FLEET_APP neutral-contract views + LIVE UDTFs (consumers never bind to
--     FLEET_INTELLIGENCE directly). Mirrors the LOCATION seam.
CREATE SCHEMA IF NOT EXISTS FLEET_APP.SOURCING
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-freight-sourcing","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE OR REPLACE VIEW FLEET_APP.SOURCING.VW_PLANTS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-freight-sourcing","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
  AS SELECT * FROM FLEET_INTELLIGENCE.SOURCING.PLANTS;
CREATE OR REPLACE VIEW FLEET_APP.SOURCING.VW_CUSTOMERS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-freight-sourcing","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
  AS SELECT * FROM FLEET_INTELLIGENCE.SOURCING.CUSTOMERS;
CREATE OR REPLACE VIEW FLEET_APP.SOURCING.VW_PLANT_FACTS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-freight-sourcing","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
  AS SELECT * FROM FLEET_INTELLIGENCE.SOURCING.PLANT_FACTS;
CREATE OR REPLACE VIEW FLEET_APP.SOURCING.VW_CUSTOMER_DEMAND
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-freight-sourcing","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
  AS SELECT * FROM FLEET_INTELLIGENCE.SOURCING.CUSTOMER_DEMAND;
CREATE OR REPLACE VIEW FLEET_APP.SOURCING.VW_FREIGHT_RATE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-freight-sourcing","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
  AS SELECT * FROM FLEET_INTELLIGENCE.SOURCING.FREIGHT_RATE;
CREATE OR REPLACE VIEW FLEET_APP.SOURCING.VW_ORDER_MIX
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-freight-sourcing","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
  AS SELECT * FROM FLEET_INTELLIGENCE.SOURCING.ORDER_MIX;
-- Active-region pointer for the app: the single region the SOURCING estate was
-- built for. Reflects CATCHMENT.CONFIG, which region creation (Data Studio
-- region-sync) and region switch (admin regions/active) both update, and which
-- BUILD_SOURCING_DIAGNOSTICS builds against - so the sourcing views always
-- resolve to the same region their data was built for. Owner's-rights ownership
-- chain (ACCOUNTADMIN owns both) lets FLEET_APP roles read it via the view grant.
CREATE OR REPLACE VIEW FLEET_APP.SOURCING.VW_ACTIVE_REGION
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-freight-sourcing","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
  AS SELECT REGION FROM FLEET_INTELLIGENCE.CATCHMENT.CONFIG LIMIT 1;

-- Estate-only facts view for the semantic view (SV_SOURCING). Current annual
-- freight here is a DATA-ONLY straight-line estimate (no ORS), suitable for the
-- semantic layer; precise, road-distance swap analysis is done live in the app.
CREATE OR REPLACE VIEW FLEET_APP.SOURCING.VW_SOURCING_FACTS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-freight-sourcing","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
  AS
  SELECT d.REGION, d.CUSTOMER_ID, c.CUSTOMER_NAME, d.PRODUCT,
         d.ANNUAL_TRUCKLOADS, d.TONS_PER_LOAD, d.CURRENT_PLANT_ID,
         p.PLANT_NAME AS CURRENT_PLANT,
         ROUND(ST_DISTANCE(c.GEOG, p.GEOG) / 1000.0, 2) AS CURRENT_DISTANCE_KM,
         ROUND(d.ANNUAL_TRUCKLOADS
               * (ST_DISTANCE(c.GEOG, p.GEOG) / 1000.0)
               * (fr.RATE_PER_KM + d.TONS_PER_LOAD * fr.RATE_PER_TON_KM), 0)::NUMBER(18,0) AS CURRENT_ANNUAL_FREIGHT
  FROM FLEET_INTELLIGENCE.SOURCING.CUSTOMER_DEMAND d
  JOIN FLEET_INTELLIGENCE.SOURCING.CUSTOMERS c ON c.REGION = d.REGION AND c.CUSTOMER_ID = d.CUSTOMER_ID
  JOIN FLEET_INTELLIGENCE.SOURCING.PLANTS p ON p.REGION = d.REGION AND p.PLANT_ID = d.CURRENT_PLANT_ID
  JOIN FLEET_INTELLIGENCE.SOURCING.FREIGHT_RATE fr ON fr.REGION = d.REGION;

-- Live sourcing lanes: ONE ORS call computes the full plant x customer road
-- distance/duration matrix (MATRIX_TABULAR: origins = all plant coords ordered
-- by PLANT_ID, destinations = all customer coords ordered by CUSTOMER_ID). The
-- response is a VARIANT with durations[i][j] (seconds) and distances[i][j]
-- (meters); indices align to the ordered plant/customer rows. Freight cost per
-- the customer's truckload = distance_km * rate_per_km + tons * distance_km *
-- rate_per_ton_km. Nothing precomputed (Architecture Tenet 9); region ORS must
-- be RESUMED. Owner's-rights; consumers only need USAGE.
CREATE OR REPLACE FUNCTION FLEET_APP.SOURCING.LIVE_SOURCING_LANES(
  P_REGION VARCHAR, P_PROFILE VARCHAR, P_RATE_PER_KM FLOAT, P_RATE_PER_TON_KM FLOAT)
RETURNS TABLE (PLANT_ID VARCHAR, PLANT_NAME VARCHAR, CUSTOMER_ID VARCHAR, CUSTOMER_NAME VARCHAR,
               DISTANCE_KM NUMBER(14,2), DURATION_MIN NUMBER(14,1), TONS INT,
               FREIGHT_COST NUMBER(18,2), PLANT_GEOG GEOGRAPHY, CUSTOMER_GEOG GEOGRAPHY)
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-freight-sourcing","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH mtx AS (
    SELECT OPENROUTESERVICE_APP.CORE.MATRIX_TABULAR(
      P_PROFILE,
      (SELECT ARRAY_AGG(ARRAY_CONSTRUCT(LON, LAT)) WITHIN GROUP (ORDER BY PLANT_ID)
         FROM FLEET_INTELLIGENCE.SOURCING.PLANTS WHERE REGION = P_REGION),
      (SELECT ARRAY_AGG(ARRAY_CONSTRUCT(LON, LAT)) WITHIN GROUP (ORDER BY CUSTOMER_ID)
         FROM FLEET_INTELLIGENCE.SOURCING.CUSTOMERS WHERE REGION = P_REGION),
      P_REGION) AS m
  ),
  p AS (
    SELECT PLANT_ID, PLANT_NAME, GEOG, ROW_NUMBER() OVER (ORDER BY PLANT_ID) - 1 AS pi
    FROM FLEET_INTELLIGENCE.SOURCING.PLANTS WHERE REGION = P_REGION
  ),
  c AS (
    SELECT CUSTOMER_ID, CUSTOMER_NAME, GEOG, ROW_NUMBER() OVER (ORDER BY CUSTOMER_ID) - 1 AS ci
    FROM FLEET_INTELLIGENCE.SOURCING.CUSTOMERS WHERE REGION = P_REGION
  ),
  d AS (
    SELECT CUSTOMER_ID, TONS_PER_LOAD
    FROM FLEET_INTELLIGENCE.SOURCING.CUSTOMER_DEMAND WHERE REGION = P_REGION
  )
  SELECT p.PLANT_ID, p.PLANT_NAME, c.CUSTOMER_ID, c.CUSTOMER_NAME,
         ROUND((mtx.m:distances[p.pi][c.ci]::FLOAT) / 1000.0, 2)::NUMBER(14,2) AS distance_km,
         ROUND((mtx.m:durations[p.pi][c.ci]::FLOAT) / 60.0, 1)::NUMBER(14,1) AS duration_min,
         COALESCE(d.TONS_PER_LOAD, 22) AS tons,
         ROUND((mtx.m:distances[p.pi][c.ci]::FLOAT) / 1000.0 * P_RATE_PER_KM
               + COALESCE(d.TONS_PER_LOAD, 22) * (mtx.m:distances[p.pi][c.ci]::FLOAT) / 1000.0 * P_RATE_PER_TON_KM
              )::NUMBER(18,2) AS freight_cost,
         p.GEOG AS plant_geog, c.GEOG AS customer_geog
  FROM mtx, p CROSS JOIN c
  LEFT JOIN d ON d.CUSTOMER_ID = c.CUSTOMER_ID
  WHERE mtx.m:distances[p.pi][c.ci] IS NOT NULL
$$;

-- Live location swap: for each customer, restrict lanes to product-capable
-- plants, pick the cheapest, compare to the data-only current source, and
-- annualize the per-load saving by ANNUAL_TRUCKLOADS. Builds on the single
-- MATRIX_TABULAR call inside LIVE_SOURCING_LANES. P_PRODUCT_FILTER is optional
-- (NULL = all products). Owner's-rights; consumers only need USAGE.
CREATE OR REPLACE FUNCTION FLEET_APP.SOURCING.LIVE_LOCATION_SWAP(
  P_REGION VARCHAR, P_PROFILE VARCHAR, P_RATE_PER_KM FLOAT, P_RATE_PER_TON_KM FLOAT,
  P_PRODUCT_FILTER VARCHAR)
RETURNS TABLE (CUSTOMER_ID VARCHAR, CUSTOMER_NAME VARCHAR, PRODUCT VARCHAR, ANNUAL_TRUCKLOADS INT,
               CURRENT_PLANT VARCHAR, CURRENT_COST_PER_LOAD NUMBER(18,2),
               BEST_PLANT VARCHAR, BEST_COST_PER_LOAD NUMBER(18,2),
               SAVINGS_PER_LOAD NUMBER(18,2), ANNUAL_SAVINGS NUMBER(18,0),
               CURRENT_PLANT_GEOG GEOGRAPHY, BEST_PLANT_GEOG GEOGRAPHY, CUSTOMER_GEOG GEOGRAPHY)
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-freight-sourcing","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH lanes AS (
    SELECT * FROM TABLE(FLEET_APP.SOURCING.LIVE_SOURCING_LANES(P_REGION, P_PROFILE, P_RATE_PER_KM, P_RATE_PER_TON_KM))
  ),
  dem AS (
    SELECT CUSTOMER_ID, PRODUCT, ANNUAL_TRUCKLOADS, CURRENT_PLANT_ID
    FROM FLEET_INTELLIGENCE.SOURCING.CUSTOMER_DEMAND
    WHERE REGION = P_REGION
      AND (P_PRODUCT_FILTER IS NULL OR PRODUCT = P_PRODUCT_FILTER)
  ),
  capable AS (
    SELECT l.PLANT_ID, l.PLANT_NAME, l.CUSTOMER_ID, l.CUSTOMER_NAME, l.FREIGHT_COST,
           l.PLANT_GEOG, l.CUSTOMER_GEOG,
           d.PRODUCT, d.ANNUAL_TRUCKLOADS, d.CURRENT_PLANT_ID
    FROM lanes l
    JOIN dem d ON d.CUSTOMER_ID = l.CUSTOMER_ID
    JOIN FLEET_INTELLIGENCE.SOURCING.PLANT_FACTS pf
      ON pf.REGION = P_REGION AND pf.PLANT_ID = l.PLANT_ID
     AND ARRAY_CONTAINS(d.PRODUCT::VARIANT, pf.PRODUCT_CAPABILITY)
  ),
  best AS (
    -- Pick the cheapest capable plant as ONE atomic row (name + geog + cost from
    -- the same winning row), deterministic on a cost tie via PLANT_ID.
    SELECT CUSTOMER_ID, PLANT_NAME AS best_plant, PLANT_GEOG AS best_plant_geog,
           FREIGHT_COST AS best_cost
    FROM capable
    QUALIFY ROW_NUMBER() OVER (PARTITION BY CUSTOMER_ID ORDER BY FREIGHT_COST, PLANT_ID) = 1
  ),
  cur AS (
    SELECT CUSTOMER_ID, CUSTOMER_NAME, PRODUCT, ANNUAL_TRUCKLOADS,
           PLANT_NAME AS current_plant, FREIGHT_COST AS current_cost,
           CUSTOMER_GEOG, PLANT_GEOG AS current_plant_geog
    FROM capable
    WHERE PLANT_ID = CURRENT_PLANT_ID
  )
  SELECT cur.CUSTOMER_ID, cur.CUSTOMER_NAME, cur.PRODUCT, cur.ANNUAL_TRUCKLOADS,
         cur.current_plant, ROUND(cur.current_cost, 2)::NUMBER(18,2) AS current_cost_per_load,
         b.best_plant, ROUND(b.best_cost, 2)::NUMBER(18,2) AS best_cost_per_load,
         ROUND(cur.current_cost - b.best_cost, 2)::NUMBER(18,2) AS savings_per_load,
         ROUND((cur.current_cost - b.best_cost) * cur.ANNUAL_TRUCKLOADS, 0)::NUMBER(18,0) AS annual_savings,
         cur.current_plant_geog, b.best_plant_geog, cur.CUSTOMER_GEOG
  FROM cur JOIN best b ON b.CUSTOMER_ID = cur.CUSTOMER_ID
  ORDER BY annual_savings DESC
$$;

-- ===========================================================================
-- Phase 2: product-mix / inter-plant transfer (consolidate vs ship direct)
-- ===========================================================================
-- Live plant-to-plant road matrix (ONE MATRIX_TABULAR call, plants as both
-- origins and destinations). Used for the inter-plant transfer legs. Diagonal
-- (plant to itself) is 0. Same VARIANT distances[i][j] indexing + ARRAY_AGG
-- ordering alignment as LIVE_SOURCING_LANES. Nothing precomputed (Tenet 9).
CREATE OR REPLACE FUNCTION FLEET_APP.SOURCING.LIVE_PLANT_MATRIX(
  P_REGION VARCHAR, P_PROFILE VARCHAR)
RETURNS TABLE (FROM_PLANT_ID VARCHAR, FROM_PLANT VARCHAR, TO_PLANT_ID VARCHAR, TO_PLANT VARCHAR,
               DISTANCE_KM NUMBER(14,2), DURATION_MIN NUMBER(14,1),
               FROM_GEOG GEOGRAPHY, TO_GEOG GEOGRAPHY)
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-freight-sourcing","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH mtx AS (
    SELECT OPENROUTESERVICE_APP.CORE.MATRIX_TABULAR(
      P_PROFILE,
      (SELECT ARRAY_AGG(ARRAY_CONSTRUCT(LON, LAT)) WITHIN GROUP (ORDER BY PLANT_ID)
         FROM FLEET_INTELLIGENCE.SOURCING.PLANTS WHERE REGION = P_REGION),
      (SELECT ARRAY_AGG(ARRAY_CONSTRUCT(LON, LAT)) WITHIN GROUP (ORDER BY PLANT_ID)
         FROM FLEET_INTELLIGENCE.SOURCING.PLANTS WHERE REGION = P_REGION),
      P_REGION) AS m
  ),
  a AS (
    SELECT PLANT_ID, PLANT_NAME, GEOG, ROW_NUMBER() OVER (ORDER BY PLANT_ID) - 1 AS ai
    FROM FLEET_INTELLIGENCE.SOURCING.PLANTS WHERE REGION = P_REGION
  ),
  b AS (
    SELECT PLANT_ID, PLANT_NAME, GEOG, ROW_NUMBER() OVER (ORDER BY PLANT_ID) - 1 AS bi
    FROM FLEET_INTELLIGENCE.SOURCING.PLANTS WHERE REGION = P_REGION
  )
  SELECT a.PLANT_ID, a.PLANT_NAME, b.PLANT_ID, b.PLANT_NAME,
         ROUND((mtx.m:distances[a.ai][b.bi]::FLOAT) / 1000.0, 2)::NUMBER(14,2) AS distance_km,
         ROUND((mtx.m:durations[a.ai][b.bi]::FLOAT) / 60.0, 1)::NUMBER(14,1) AS duration_min,
         a.GEOG, b.GEOG
  FROM mtx, a CROSS JOIN b
  WHERE mtx.m:distances[a.ai][b.bi] IS NOT NULL
$$;

-- Live product-mix tradeoff per customer order (basket of product lines):
--   Option B (SHIP DIRECT): each line from its cheapest capable plant direct to
--     the customer -> cost_multi_plant = sum over lines of min direct freight.
--   Option A (CONSOLIDATE): pick a hub plant, transfer the products the hub
--     cannot make in from the nearest capable plant (+ handling per ton), then
--     ship ONE consolidated load hub->customer. cost_consolidated = min over
--     hubs of (transfer_in + outbound). Because transfer cost is monotonic in
--     road distance, the cheapest transfer source = the nearest capable plant,
--     and a hub that itself makes the product appears as a distance-0 source
--     (so no transfer / no handling for that line).
-- freight(a,b,tons) = dist_km*rate_per_km + tons*dist_km*rate_per_ton_km.
-- Uses LIVE_SOURCING_LANES (plant->customer distances) + LIVE_PLANT_MATRIX
-- (plant->plant distances); two live ORS calls, nothing precomputed. Customers
-- whose order cannot be fully covered (an unreachable required leg) are dropped.
-- P_CUSTOMER_ID optional (NULL = all customers).
CREATE OR REPLACE FUNCTION FLEET_APP.SOURCING.LIVE_MIX_TRADEOFF(
  P_REGION VARCHAR, P_PROFILE VARCHAR, P_RATE_PER_KM FLOAT, P_RATE_PER_TON_KM FLOAT,
  P_HANDLING_PER_TON FLOAT, P_CUSTOMER_ID VARCHAR)
RETURNS TABLE (CUSTOMER_ID VARCHAR, CUSTOMER_NAME VARCHAR, PRODUCT_LINES INT, TOTAL_TONS INT,
               COST_MULTI_PLANT NUMBER(18,2), COST_CONSOLIDATED NUMBER(18,2), BEST_HUB VARCHAR,
               HANDLING_COST NUMBER(18,2), SAVINGS NUMBER(18,2), RECOMMENDATION VARCHAR,
               CUSTOMER_GEOG GEOGRAPHY, BEST_HUB_GEOG GEOGRAPHY)
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-freight-sourcing","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH pc AS (
    SELECT PLANT_ID, CUSTOMER_ID, DISTANCE_KM
    FROM TABLE(FLEET_APP.SOURCING.LIVE_SOURCING_LANES(P_REGION, P_PROFILE, P_RATE_PER_KM, P_RATE_PER_TON_KM))
  ),
  pp AS (
    SELECT FROM_PLANT_ID, TO_PLANT_ID, DISTANCE_KM
    FROM TABLE(FLEET_APP.SOURCING.LIVE_PLANT_MATRIX(P_REGION, P_PROFILE))
  ),
  orders AS (
    SELECT CUSTOMER_ID, PRODUCT, TONS
    FROM FLEET_INTELLIGENCE.SOURCING.ORDER_MIX
    WHERE REGION = P_REGION AND (P_CUSTOMER_ID IS NULL OR CUSTOMER_ID = P_CUSTOMER_ID)
  ),
  plant_products AS (
    SELECT pf.PLANT_ID, f.value::VARCHAR AS PRODUCT
    FROM FLEET_INTELLIGENCE.SOURCING.PLANT_FACTS pf,
         LATERAL FLATTEN(input => pf.PRODUCT_CAPABILITY) f
    WHERE pf.REGION = P_REGION
  ),
  lines AS (SELECT CUSTOMER_ID, COUNT(*) AS product_lines FROM orders GROUP BY CUSTOMER_ID),
  ct AS (SELECT CUSTOMER_ID, SUM(TONS) AS total_tons FROM orders GROUP BY CUSTOMER_ID),
  custname AS (SELECT CUSTOMER_ID, CUSTOMER_NAME, GEOG FROM FLEET_INTELLIGENCE.SOURCING.CUSTOMERS WHERE REGION = P_REGION),
  hubs AS (SELECT PLANT_ID, PLANT_NAME, GEOG FROM FLEET_INTELLIGENCE.SOURCING.PLANTS WHERE REGION = P_REGION),
  -- per (hub, product): min road distance from a capable source plant (0 when the hub itself makes it)
  transfer_basis AS (
    SELECT pp.TO_PLANT_ID AS hub_id, cpp.PRODUCT, MIN(pp.DISTANCE_KM) AS min_dist
    FROM pp JOIN plant_products cpp ON cpp.PLANT_ID = pp.FROM_PLANT_ID
    GROUP BY pp.TO_PLANT_ID, cpp.PRODUCT
  ),
  transfer_line AS (
    SELECT o.CUSTOMER_ID, tb.hub_id, o.PRODUCT, o.TONS, tb.min_dist,
           CASE WHEN tb.min_dist > 0
                THEN tb.min_dist * P_RATE_PER_KM + o.TONS * tb.min_dist * P_RATE_PER_TON_KM + P_HANDLING_PER_TON * o.TONS
                ELSE 0 END AS line_transfer_cost
    FROM orders o
    JOIN transfer_basis tb ON tb.PRODUCT = o.PRODUCT
  ),
  transfer_in AS (
    SELECT CUSTOMER_ID, hub_id,
           SUM(line_transfer_cost) AS transfer_cost,
           SUM(CASE WHEN min_dist > 0 THEN P_HANDLING_PER_TON * TONS ELSE 0 END) AS handling_cost,
           COUNT(*) AS covered_lines
    FROM transfer_line GROUP BY CUSTOMER_ID, hub_id
  ),
  optionA AS (
    SELECT ti.CUSTOMER_ID, ti.hub_id, ti.handling_cost,
           ti.transfer_cost + (pc.DISTANCE_KM * P_RATE_PER_KM + ct.total_tons * pc.DISTANCE_KM * P_RATE_PER_TON_KM) AS cost_a
    FROM transfer_in ti
    JOIN ct ON ct.CUSTOMER_ID = ti.CUSTOMER_ID
    JOIN lines ln ON ln.CUSTOMER_ID = ti.CUSTOMER_ID AND ti.covered_lines = ln.product_lines
    JOIN pc ON pc.PLANT_ID = ti.hub_id AND pc.CUSTOMER_ID = ti.CUSTOMER_ID
  ),
  bestA AS (
    SELECT CUSTOMER_ID, hub_id AS best_hub_id, cost_a AS cost_consolidated, handling_cost
    FROM optionA
    QUALIFY ROW_NUMBER() OVER (PARTITION BY CUSTOMER_ID ORDER BY cost_a, hub_id) = 1
  ),
  lineB AS (
    SELECT o.CUSTOMER_ID, o.PRODUCT, o.TONS,
           MIN(pc.DISTANCE_KM * P_RATE_PER_KM + o.TONS * pc.DISTANCE_KM * P_RATE_PER_TON_KM) AS line_direct_cost
    FROM orders o
    JOIN plant_products cpp ON cpp.PRODUCT = o.PRODUCT
    JOIN pc ON pc.PLANT_ID = cpp.PLANT_ID AND pc.CUSTOMER_ID = o.CUSTOMER_ID
    GROUP BY o.CUSTOMER_ID, o.PRODUCT, o.TONS
  ),
  costB AS (
    SELECT CUSTOMER_ID, SUM(line_direct_cost) AS cost_multi, COUNT(*) AS covered_lines
    FROM lineB GROUP BY CUSTOMER_ID
  ),
  -- Feasible direct plan = every line has a direct lane (covers the whole basket).
  costB_ok AS (
    SELECT cb.CUSTOMER_ID, cb.cost_multi
    FROM costB cb JOIN lines ln ON ln.CUSTOMER_ID = cb.CUSTOMER_ID
    WHERE cb.covered_lines = ln.product_lines
  ),
  -- Customer spine: keep a customer if EITHER plan is feasible (bestA already
  -- requires a fully-covering hub; costB_ok requires a full direct plan). This
  -- surfaces consolidation-only and direct-only customers instead of dropping
  -- them (they show a NULL cost on the infeasible side).
  spine AS (
    SELECT CUSTOMER_ID FROM bestA
    UNION
    SELECT CUSTOMER_ID FROM costB_ok
  )
  SELECT cn.CUSTOMER_ID, cn.CUSTOMER_NAME, ln.product_lines, ct.total_tons,
         ROUND(cb.cost_multi, 2)::NUMBER(18,2) AS cost_multi_plant,
         ROUND(ba.cost_consolidated, 2)::NUMBER(18,2) AS cost_consolidated,
         hb.PLANT_NAME AS best_hub,
         ROUND(ba.handling_cost, 2)::NUMBER(18,2) AS handling_cost,
         ROUND(cb.cost_multi - ba.cost_consolidated, 2)::NUMBER(18,2) AS savings,
         CASE
           WHEN ba.CUSTOMER_ID IS NULL THEN 'SHIP DIRECT'
           WHEN cb.CUSTOMER_ID IS NULL THEN 'CONSOLIDATE'
           WHEN cb.cost_multi - ba.cost_consolidated > 0 THEN 'CONSOLIDATE'
           ELSE 'SHIP DIRECT'
         END AS recommendation,
         cn.GEOG AS customer_geog, hb.GEOG AS best_hub_geog
  FROM spine s
  JOIN custname cn ON cn.CUSTOMER_ID = s.CUSTOMER_ID
  JOIN lines ln ON ln.CUSTOMER_ID = s.CUSTOMER_ID
  JOIN ct ON ct.CUSTOMER_ID = s.CUSTOMER_ID
  LEFT JOIN bestA ba ON ba.CUSTOMER_ID = s.CUSTOMER_ID
  LEFT JOIN costB_ok cb ON cb.CUSTOMER_ID = s.CUSTOMER_ID
  LEFT JOIN hubs hb ON hb.PLANT_ID = ba.best_hub_id
  ORDER BY savings DESC NULLS LAST
$$;

-- Live flow legs for ONE customer's order, for the map: the CONSOLIDATE plan
-- (transfer-in legs from the nearest capable source into the best hub, plus the
-- consolidated outbound leg hub->customer) and the SHIP DIRECT plan (each line
-- from its nearest capable plant direct to the customer). LEG_KIND in
-- ('TRANSFER','OUTBOUND','DIRECT'). Recomputes the best hub the same way as
-- LIVE_MIX_TRADEOFF. Two live ORS calls; region ORS must be RESUMED.
CREATE OR REPLACE FUNCTION FLEET_APP.SOURCING.LIVE_MIX_FLOWS(
  P_REGION VARCHAR, P_PROFILE VARCHAR, P_RATE_PER_KM FLOAT, P_RATE_PER_TON_KM FLOAT,
  P_HANDLING_PER_TON FLOAT, P_CUSTOMER_ID VARCHAR)
RETURNS TABLE (LEG_KIND VARCHAR, PRODUCT VARCHAR, TONS INT,
               FROM_LON FLOAT, FROM_LAT FLOAT, TO_LON FLOAT, TO_LAT FLOAT)
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-freight-sourcing","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH pc AS (
    SELECT PLANT_ID, CUSTOMER_ID, DISTANCE_KM
    FROM TABLE(FLEET_APP.SOURCING.LIVE_SOURCING_LANES(P_REGION, P_PROFILE, P_RATE_PER_KM, P_RATE_PER_TON_KM))
    WHERE CUSTOMER_ID = P_CUSTOMER_ID
  ),
  pp AS (
    SELECT FROM_PLANT_ID, TO_PLANT_ID, DISTANCE_KM
    FROM TABLE(FLEET_APP.SOURCING.LIVE_PLANT_MATRIX(P_REGION, P_PROFILE))
  ),
  orders AS (
    SELECT PRODUCT, TONS FROM FLEET_INTELLIGENCE.SOURCING.ORDER_MIX
    WHERE REGION = P_REGION AND CUSTOMER_ID = P_CUSTOMER_ID
  ),
  plant_products AS (
    SELECT pf.PLANT_ID, f.value::VARCHAR AS PRODUCT
    FROM FLEET_INTELLIGENCE.SOURCING.PLANT_FACTS pf,
         LATERAL FLATTEN(input => pf.PRODUCT_CAPABILITY) f
    WHERE pf.REGION = P_REGION
  ),
  total AS (SELECT SUM(TONS) AS tt, COUNT(*) AS nlines FROM orders),
  custrow AS (SELECT GEOG FROM FLEET_INTELLIGENCE.SOURCING.CUSTOMERS WHERE REGION = P_REGION AND CUSTOMER_ID = P_CUSTOMER_ID),
  plants AS (SELECT PLANT_ID, GEOG FROM FLEET_INTELLIGENCE.SOURCING.PLANTS WHERE REGION = P_REGION),
  -- recompute the best hub (mirror of LIVE_MIX_TRADEOFF option A)
  transfer_basis AS (
    SELECT pp.TO_PLANT_ID AS hub_id, cpp.PRODUCT, MIN(pp.DISTANCE_KM) AS min_dist
    FROM pp JOIN plant_products cpp ON cpp.PLANT_ID = pp.FROM_PLANT_ID
    GROUP BY pp.TO_PLANT_ID, cpp.PRODUCT
  ),
  transfer_line AS (
    SELECT tb.hub_id, o.PRODUCT, o.TONS, tb.min_dist,
           CASE WHEN tb.min_dist > 0
                THEN tb.min_dist * P_RATE_PER_KM + o.TONS * tb.min_dist * P_RATE_PER_TON_KM + P_HANDLING_PER_TON * o.TONS
                ELSE 0 END AS line_transfer_cost
    FROM orders o JOIN transfer_basis tb ON tb.PRODUCT = o.PRODUCT
  ),
  optionA AS (
    SELECT tl.hub_id,
           SUM(tl.line_transfer_cost) + (pc.DISTANCE_KM * P_RATE_PER_KM + total.tt * pc.DISTANCE_KM * P_RATE_PER_TON_KM) AS cost_a
    FROM transfer_line tl
    JOIN pc ON pc.PLANT_ID = tl.hub_id
    CROSS JOIN total
    GROUP BY tl.hub_id, pc.DISTANCE_KM, total.tt
    HAVING COUNT(*) = (SELECT nlines FROM total)
  ),
  best AS (
    SELECT hub_id FROM optionA QUALIFY ROW_NUMBER() OVER (ORDER BY cost_a, hub_id) = 1
  ),
  -- nearest capable source plant for each product into the best hub
  src AS (
    SELECT o.PRODUCT, o.TONS, b.hub_id, pp.FROM_PLANT_ID AS src_id, pp.DISTANCE_KM AS d
    FROM orders o
    CROSS JOIN best b
    JOIN plant_products cpp ON cpp.PRODUCT = o.PRODUCT
    JOIN pp ON pp.FROM_PLANT_ID = cpp.PLANT_ID AND pp.TO_PLANT_ID = b.hub_id
    QUALIFY ROW_NUMBER() OVER (PARTITION BY o.PRODUCT ORDER BY pp.DISTANCE_KM, pp.FROM_PLANT_ID) = 1
  ),
  -- nearest capable plant direct to the customer for each product
  direct AS (
    SELECT o.PRODUCT, o.TONS, cpp.PLANT_ID AS src_id
    FROM orders o
    JOIN plant_products cpp ON cpp.PRODUCT = o.PRODUCT
    JOIN pc ON pc.PLANT_ID = cpp.PLANT_ID
    QUALIFY ROW_NUMBER() OVER (PARTITION BY o.PRODUCT ORDER BY pc.DISTANCE_KM, cpp.PLANT_ID) = 1
  )
  SELECT 'TRANSFER' AS leg_kind, src.PRODUCT, src.TONS,
         ST_X(sp.GEOG) AS from_lon, ST_Y(sp.GEOG) AS from_lat,
         ST_X(hp.GEOG) AS to_lon, ST_Y(hp.GEOG) AS to_lat
  FROM src
  JOIN plants sp ON sp.PLANT_ID = src.src_id
  JOIN plants hp ON hp.PLANT_ID = src.hub_id
  WHERE src.d > 0
  UNION ALL
  SELECT 'OUTBOUND', NULL, (SELECT tt FROM total),
         ST_X(hp.GEOG), ST_Y(hp.GEOG), ST_X(cu.GEOG), ST_Y(cu.GEOG)
  FROM best b JOIN plants hp ON hp.PLANT_ID = b.hub_id CROSS JOIN custrow cu
  UNION ALL
  SELECT 'DIRECT', d.PRODUCT, d.TONS,
         ST_X(sp.GEOG), ST_Y(sp.GEOG), ST_X(cu.GEOG), ST_Y(cu.GEOG)
  FROM direct d JOIN plants sp ON sp.PLANT_ID = d.src_id CROSS JOIN custrow cu
$$;

-- Grants (additive; guarded so a role-less install does not error the file).
GRANT USAGE ON SCHEMA FLEET_APP.SOURCING TO ROLE FLEET_APP_USER;
GRANT SELECT ON ALL VIEWS IN SCHEMA FLEET_APP.SOURCING TO ROLE FLEET_APP_USER;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA FLEET_APP.SOURCING TO ROLE FLEET_APP_USER;
GRANT USAGE ON SCHEMA FLEET_APP.SOURCING TO ROLE FLEET_APP_OPS;
GRANT SELECT ON ALL VIEWS IN SCHEMA FLEET_APP.SOURCING TO ROLE FLEET_APP_OPS;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA FLEET_APP.SOURCING TO ROLE FLEET_APP_OPS;
GRANT USAGE ON SCHEMA FLEET_APP.SOURCING TO ROLE FLEET_APP_ADMIN;
GRANT SELECT ON ALL VIEWS IN SCHEMA FLEET_APP.SOURCING TO ROLE FLEET_APP_ADMIN;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA FLEET_APP.SOURCING TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.SOURCING.LIVE_SOURCING_LANES(VARCHAR, VARCHAR, FLOAT, FLOAT) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.SOURCING.LIVE_SOURCING_LANES(VARCHAR, VARCHAR, FLOAT, FLOAT) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.SOURCING.LIVE_SOURCING_LANES(VARCHAR, VARCHAR, FLOAT, FLOAT) TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.SOURCING.LIVE_LOCATION_SWAP(VARCHAR, VARCHAR, FLOAT, FLOAT, VARCHAR) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.SOURCING.LIVE_LOCATION_SWAP(VARCHAR, VARCHAR, FLOAT, FLOAT, VARCHAR) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.SOURCING.LIVE_LOCATION_SWAP(VARCHAR, VARCHAR, FLOAT, FLOAT, VARCHAR) TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.SOURCING.LIVE_PLANT_MATRIX(VARCHAR, VARCHAR) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.SOURCING.LIVE_PLANT_MATRIX(VARCHAR, VARCHAR) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.SOURCING.LIVE_PLANT_MATRIX(VARCHAR, VARCHAR) TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.SOURCING.LIVE_MIX_TRADEOFF(VARCHAR, VARCHAR, FLOAT, FLOAT, FLOAT, VARCHAR) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.SOURCING.LIVE_MIX_TRADEOFF(VARCHAR, VARCHAR, FLOAT, FLOAT, FLOAT, VARCHAR) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.SOURCING.LIVE_MIX_TRADEOFF(VARCHAR, VARCHAR, FLOAT, FLOAT, FLOAT, VARCHAR) TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.SOURCING.LIVE_MIX_FLOWS(VARCHAR, VARCHAR, FLOAT, FLOAT, FLOAT, VARCHAR) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.SOURCING.LIVE_MIX_FLOWS(VARCHAR, VARCHAR, FLOAT, FLOAT, FLOAT, VARCHAR) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.SOURCING.LIVE_MIX_FLOWS(VARCHAR, VARCHAR, FLOAT, FLOAT, FLOAT, VARCHAR) TO ROLE FLEET_APP_ADMIN;

-- Validation summary (last statement; non-fatal).
SELECT 'DWELL.CONFIG' AS OBJ, COUNT(*) AS N FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.CONFIG
UNION ALL SELECT 'ROUTE_DEVIATION.CONFIG', COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_DEVIATION.CONFIG
UNION ALL SELECT 'ROUTE_DEVIATION.TRIP_DEVIATION_ANALYSIS', COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_DEVIATION.TRIP_DEVIATION_ANALYSIS
UNION ALL SELECT 'ROUTE_OPTIMIZATION.CONFIG', COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG
UNION ALL SELECT 'CATCHMENT.POIS', COUNT(*) FROM FLEET_INTELLIGENCE.CATCHMENT.POIS
UNION ALL SELECT 'CATCHMENT.CITIES_BY_STATE', COUNT(*) FROM FLEET_INTELLIGENCE.CATCHMENT.CITIES_BY_STATE
UNION ALL SELECT 'CATCHMENT.REGIONAL_ADDRESSES', COUNT(*) FROM FLEET_INTELLIGENCE.CATCHMENT.REGIONAL_ADDRESSES
UNION ALL SELECT 'LOCATION.STORES', COUNT(*) FROM FLEET_INTELLIGENCE.LOCATION.STORES
UNION ALL SELECT 'LOCATION.HH_CELLS', COUNT(*) FROM FLEET_INTELLIGENCE.LOCATION.HH_CELLS
UNION ALL SELECT 'LOCATION.STORE_FACTS', COUNT(*) FROM FLEET_INTELLIGENCE.LOCATION.STORE_FACTS
UNION ALL SELECT 'SOURCING.PLANTS', COUNT(*) FROM FLEET_INTELLIGENCE.SOURCING.PLANTS
UNION ALL SELECT 'SOURCING.CUSTOMERS', COUNT(*) FROM FLEET_INTELLIGENCE.SOURCING.CUSTOMERS
UNION ALL SELECT 'SOURCING.CUSTOMER_DEMAND', COUNT(*) FROM FLEET_INTELLIGENCE.SOURCING.CUSTOMER_DEMAND
UNION ALL SELECT 'SOURCING.ORDER_MIX', COUNT(*) FROM FLEET_INTELLIGENCE.SOURCING.ORDER_MIX;
