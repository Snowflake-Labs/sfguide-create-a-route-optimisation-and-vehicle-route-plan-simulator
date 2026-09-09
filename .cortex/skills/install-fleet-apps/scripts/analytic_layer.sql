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
--
-- THIS FILE IS ENGINE-FREE BY CONTRACT.
-- Nothing here may reference an OPENROUTESERVICE_APP.CORE routing FUNCTION
-- (ISOCHRONES / MATRIX / MATRIX_TABULAR / DIRECTIONS / OPTIMIZATION / ORS_STATUS)
-- outside a comment or a deferred procedure body. Those live in the sibling
-- scripts/analytic_layer_live_routing.sql, and the 24
--   -- [live-routing UDTFs moved -> analytic_layer_live_routing.sql]
-- markers below are where they were extracted from.
--
-- Why the split exists: a SQL UDTF body resolves at CREATE time, so on an
-- engine-less deployment the first such statement was a hard error. Combined with
-- stop-on-first-error that aborted this file at line 1072 of 2722 and silently
-- discarded ~129 later statements, including the six FLEET_INTELLIGENCE.SOURCING
-- tables, the ten FLEET_APP.SOURCING views and the closing validation SELECT -
-- none of which need the engine. Keeping this file engine-free means an
-- engine-less install now completes it in full.
--
-- Enforced by scripts/check_engine_guards.py (pre-commit). Referencing a routing
-- function here fails that gate; put the statement in the live-routing file.
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
ALTER DATABASE FLEET_INTELLIGENCE SET DATA_RETENTION_TIME_IN_DAYS = 0;

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
  SELECT VEHICLE_TYPE, REGION, 1 AS PRI, CREATED_AT FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS WHERE IS_ACTIVE = TRUE
  UNION ALL SELECT 'ebike', 'SanFrancisco', 2, NULL::TIMESTAMP_LTZ
) s
WHERE NOT EXISTS (SELECT 1 FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.CONFIG)
QUALIFY ROW_NUMBER() OVER (ORDER BY PRI, CREATED_AT DESC NULLS LAST) = 1;

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
  SELECT VEHICLE_TYPE, REGION, 1 AS PRI, CREATED_AT FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS WHERE IS_ACTIVE = TRUE
  UNION ALL SELECT 'ebike', 'SanFrancisco', 2, NULL::TIMESTAMP_LTZ
) s
WHERE NOT EXISTS (SELECT 1 FROM FLEET_INTELLIGENCE.ROUTE_DEVIATION.CONFIG)
QUALIFY ROW_NUMBER() OVER (ORDER BY PRI, CREATED_AT DESC NULLS LAST) = 1;

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
    t.VEHICLE_TYPE, t.REGION,
    FLEET_APP.CORE.REGION_LABEL(t.REGION) AS REGION_LABEL
FROM SYNTHETIC_DATASETS.UNIFIED.V_FACT_TRIPS_CURRENT t;

CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.ROUTE_DEVIATION.VW_FLEET
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT
    f.VEHICLE_ID, f.DRIVER_PROFILE, f.OPERATING_MODE,
    f.REGION AS HOME_CITY, f.VEHICLE_TYPE, f.REGION,
    FLEET_APP.CORE.REGION_LABEL(f.REGION) AS REGION_LABEL
FROM SYNTHETIC_DATASETS.UNIFIED.V_DIM_FLEET_CURRENT f
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
FROM SYNTHETIC_DATASETS.UNIFIED.V_DIM_TRIP_SCHEDULE_CURRENT s;

CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.ROUTE_DEVIATION.VW_POIS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT
    p.LOCATION_ID AS ID, p.NAME, p.LOCATION_TYPE,
    p.CATEGORY, p.LAT, p.LNG, p.POINT_GEOM, p.REGION
FROM SYNTHETIC_DATASETS.UNIFIED.V_DIM_POIS_CURRENT p
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
    -- ORIGIN_CITY / DEST_CITY are the POI's region rendered as a readable label
    -- (they used to emit the raw region KEY, unmatchable against a typed phrase),
    -- falling back to the trip's own region rather than 'N/A' when the POI join
    -- misses.
    FLEET_APP.CORE.REGION_LABEL(COALESCE(po.REGION, t.REGION)) AS ORIGIN_CITY,
    COALESCE(pd.NAME, 'Unknown') AS DEST_NAME,
    FLEET_APP.CORE.REGION_LABEL(COALESCE(pd.REGION, t.REGION)) AS DEST_CITY,
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
    -- Deviation thresholds are resolved from the TRIP's OWN vehicle type, not
    -- from a single CONFIG value. On a multi-region fact a scalar lookup would
    -- apply one asset mode's tolerance to every other mode's trips.
    CASE WHEN ABS(t.ACTUAL_DISTANCE_KM - t.EXPECTED_DISTANCE_KM) / NULLIF(t.EXPECTED_DISTANCE_KM, 0) > vp.DEVIATION_DISTANCE_RATIO
         THEN TRUE ELSE FALSE END AS IS_DISTANCE_DEVIATION,
    CASE WHEN t.IS_DETOUR THEN TRUE ELSE FALSE END AS IS_DURATION_DEVIATION,
    CASE WHEN t.IS_DETOUR
           OR ABS(t.ACTUAL_DISTANCE_KM - t.EXPECTED_DISTANCE_KM) / NULLIF(t.EXPECTED_DISTANCE_KM, 0) > vp.DEVIATION_DISTANCE_RATIO
         THEN TRUE ELSE FALSE END AS IS_ROUTE_DEVIATION,
    t.ACTUAL_PATH,
    t.EXPECTED_PATH,
    -- Carried so the pack layer and the semantic view can filter by region /
    -- asset mode without re-joining the fleet.
    t.REGION,
    FLEET_APP.CORE.REGION_LABEL(t.REGION) AS REGION_LABEL,
    t.VEHICLE_TYPE
FROM FLEET_INTELLIGENCE.ROUTE_DEVIATION.VW_TRIP_DEVIATION t
LEFT JOIN FLEET_INTELLIGENCE.CORE.DIM_VEHICLE_PROFILE vp ON vp.VEHICLE_TYPE = t.VEHICLE_TYPE
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
  SELECT VEHICLE_TYPE, REGION, 1 AS PRI, CREATED_AT FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS WHERE IS_ACTIVE = TRUE
  UNION ALL SELECT 'ebike', 'SanFrancisco', 2, NULL::TIMESTAMP_LTZ
) s
WHERE NOT EXISTS (SELECT 1 FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG)
QUALIFY ROW_NUMBER() OVER (ORDER BY PRI, CREATED_AT DESC NULLS LAST) = 1;

-- =============================================================================
-- 3b. BACKLOAD_MATCHING control / reference / audit tables (safety-net)
--     The backload_matching pack's FLEET_APP.BACKLOAD_MATCHING.VW_* views bind to
--     these physical tables. Created + seeded idempotently here so a fresh install
--     never needs a demo skill or app restart to populate them. Seed CONFIG ONLY
--     when empty so a live preset switch (/api/region) is never clobbered.
-- =============================================================================
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING.CONFIG (
  VEHICLE_TYPE VARCHAR NOT NULL,
  REGION       VARCHAR NOT NULL
) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

INSERT INTO FLEET_INTELLIGENCE.BACKLOAD_MATCHING.CONFIG (VEHICLE_TYPE, REGION)
SELECT VEHICLE_TYPE, REGION FROM (
  SELECT VEHICLE_TYPE, REGION, 1 AS PRI, CREATED_AT FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS WHERE IS_ACTIVE = TRUE
  UNION ALL SELECT 'ebike', 'SanFrancisco', 2, NULL::TIMESTAMP_LTZ
) s
WHERE NOT EXISTS (SELECT 1 FROM FLEET_INTELLIGENCE.BACKLOAD_MATCHING.CONFIG)
QUALIFY ROW_NUMBER() OVER (ORDER BY PRI, CREATED_AT DESC NULLS LAST) = 1;

-- Per-vehicle-class capacity / cost / label profile (single source of truth for the page).
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VEHICLE_CLASS_PROFILE (
  VEHICLE_TYPE      VARCHAR PRIMARY KEY,
  ORS_PROFILE       VARCHAR NOT NULL,
  PAYLOAD_KG_TYP    NUMBER  NOT NULL,
  PAYLOAD_KG_MAX    NUMBER  NOT NULL,
  SHIPMENT_KG_MIN   NUMBER  NOT NULL,
  SHIPMENT_KG_MAX   NUMBER  NOT NULL,
  AVG_SPEED_KMH     NUMBER  NOT NULL,
  COST_PER_KM       FLOAT   NOT NULL,
  COST_PER_HR       FLOAT   NOT NULL,
  HOME_RANGE_KM     NUMBER  NOT NULL,
  LABEL_NOUN        VARCHAR NOT NULL
) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

MERGE INTO FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VEHICLE_CLASS_PROFILE tgt
USING (
  SELECT * FROM VALUES
    ('bicycle',    'cycling-regular',     15,    25,    1,    15,  18,  0.05,  8.0,  15, 'bicycle'),
    ('ebike',      'cycling-electric',    25,    40,    2,    25,  22,  0.08, 10.0,  25, 'ebike'),
    ('foot',       'foot-walking',         5,    10,    1,     5,   5,  0.02, 12.0,   5, 'courier'),
    ('motorcycle', 'driving-car',         20,    50,    1,    20,  45,  0.20, 18.0,  80, 'motorcycle'),
    ('car',        'driving-car',        400,   600,   50,   400,  50,  0.30, 22.0,  80, 'car'),
    ('van',        'driving-car',       1500,  3500,  100,  1500,  55,  0.55, 28.0, 150, 'van'),
    ('hgv',        'driving-hgv',      24000, 26000, 1000, 24000,  60,  0.85, 38.0, 200, 'trailer'),
    ('truck',      'driving-hgv',      24000, 26000, 1000, 24000,  60,  0.85, 38.0, 200, 'truck')
  AS v(VEHICLE_TYPE, ORS_PROFILE, PAYLOAD_KG_TYP, PAYLOAD_KG_MAX, SHIPMENT_KG_MIN, SHIPMENT_KG_MAX, AVG_SPEED_KMH, COST_PER_KM, COST_PER_HR, HOME_RANGE_KM, LABEL_NOUN)
) src
ON tgt.VEHICLE_TYPE = src.VEHICLE_TYPE
WHEN NOT MATCHED THEN INSERT (VEHICLE_TYPE, ORS_PROFILE, PAYLOAD_KG_TYP, PAYLOAD_KG_MAX, SHIPMENT_KG_MIN, SHIPMENT_KG_MAX, AVG_SPEED_KMH, COST_PER_KM, COST_PER_HR, HOME_RANGE_KM, LABEL_NOUN)
  VALUES (src.VEHICLE_TYPE, src.ORS_PROFILE, src.PAYLOAD_KG_TYP, src.PAYLOAD_KG_MAX, src.SHIPMENT_KG_MIN, src.SHIPMENT_KG_MAX, src.AVG_SPEED_KMH, src.COST_PER_KM, src.COST_PER_HR, src.HOME_RANGE_KM, src.LABEL_NOUN);

-- Dispatcher decision write-back audit (the Backload Matching page writes here via /api/write).
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING.PROPOSAL_DECISIONS (
  DECISION_ID     VARCHAR DEFAULT UUID_STRING() PRIMARY KEY,
  TRAILER_ID      VARCHAR,
  OFFER_ID        VARCHAR,
  SOURCE          VARCHAR,
  SCORE           FLOAT,
  EMPTY_KM        FLOAT,
  NET_BENEFIT_USD FLOAT,
  DECIDED_BY      VARCHAR,
  DECIDED_AT      TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
  RATIONALE       VARCHAR
) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- Backload matching parameters - controls solver behaviour, display thresholds,
-- and cascade logic. The admin app's init.ts also creates + MERGE-seeds this table
-- at boot, but the pack's setup.sql runs BEFORE any app boot, so a fresh install
-- needs the table here or the pack's VW_MATCH_PARAMS view fails to compile.
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING.MATCH_PARAMS (
  PARAM_KEY    VARCHAR       NOT NULL,
  PARAM_VALUE  VARCHAR,
  PARAM_TYPE   VARCHAR(16)   DEFAULT 'string',
  CATEGORY     VARCHAR(16)   DEFAULT 'core',
  ENABLED      BOOLEAN       DEFAULT TRUE,
  DESCRIPTION  VARCHAR,
  UPDATED_AT   TIMESTAMP_NTZ DEFAULT SYSDATE(),
  CONSTRAINT PK_MATCH_PARAMS PRIMARY KEY (PARAM_KEY)
) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

MERGE INTO FLEET_INTELLIGENCE.BACKLOAD_MATCHING.MATCH_PARAMS tgt USING (
  SELECT * FROM VALUES
    ('MAX_EMPTY_KM',              '100',   'number', 'core',   TRUE,  'Max distance from where a vehicle becomes free to a load pickup (km).'),
    ('ENFORCE_PICKUP_DATE',       'true',  'bool',   'core',   TRUE,  'Vehicle must be free in time for the load pickup window.'),
    ('PICKUP_DATE_SLACK_HRS',     '0',     'number', 'core',   TRUE,  'Hours of slack allowed past the requested pickup window.'),
    ('MAX_PICKUP_HORIZON_DAYS',   '7',     'number', 'core',   TRUE,  'Only consider loads with a pickup within N days of the vehicle free time.'),
    ('DISTANCE_BASIS',            'road',  'string', 'core',   TRUE,  'road = ORS driving distance; great_circle = straight-line.'),
    ('PREFILTER_BUFFER_PCT',      '40',    'number', 'core',   TRUE,  'Great-circle prefilter radius = MAX_EMPTY_KM * (1 + pct/100).'),
    ('MAX_PROPOSALS_PER_TRAILER', '5',     'number', 'core',   TRUE,  'How many ranked load proposals to keep per vehicle.'),
    ('INTERNAL_PRIORITY',         '100',   'number', 'core',   TRUE,  'VROOM priority applied to internal (own) waiting loads.'),
    ('EXTERNAL_PRIORITY',         '10',    'number', 'core',   TRUE,  'VROOM priority applied to external freight-exchange offers.'),
    ('COST_PER_EMPTY_KM',         '1.20',  'number', 'core',   TRUE,  'Cost per empty km, for the savings KPI.'),
    ('IDLE_COST_PER_DAY',         '650',   'number', 'core',   TRUE,  'Standing-day cost, for the savings KPI.'),
    ('REVENUE_PER_LOADED_KM',     '1.10',  'number', 'core',   TRUE,  'Benchmark revenue per loaded km.'),
    ('ENFORCE_WEIGHT_FIT',        'true',  'bool',   'core',   TRUE,  'Reject pairs where vehicle MAX_PAYLOAD_KG < load WEIGHT_KG + WEIGHT_FIT_MARGIN_KG.'),
    ('WEIGHT_FIT_MARGIN_KG',      '0',     'number', 'core',   TRUE,  'Safety margin (kg) added to load weight when checking ENFORCE_WEIGHT_FIT.'),
    ('REQUIRE_HAZMAT_CERT',       'true',  'bool',   'core',   TRUE,  'Hazmat loads must go on a hazmat-certified vehicle.'),
    ('MAX_CANDIDATE_TRUCKS',      '50',    'number', 'core',   TRUE,  'Per load, how many nearest free vehicles to hand the VROOM solver.'),
    ('MAX_TRUCKS_PER_ORDER',      '3',     'number', 'core',   TRUE,  'How many ranked vehicle recommendations to keep per load in VRP mode.'),
    ('VRP_CONCURRENCY',           '4',     'number', 'core',   TRUE,  'Per-load best fit: how many loads to solve in parallel per chunk.'),
    ('PICKUP_WINDOW_HRS',         '12',    'number', 'core',   TRUE,  'Plus/minus tolerance (hours) around the requested pickup time.'),
    ('CLUSTER_CAP',               '600',   'number', 'core',   TRUE,  'Max stops per VROOM cluster before a dense component is spatially sub-split.'),
    ('BPMP_MAX_STOPS',            '4',     'number', 'core',   TRUE,  'Max loads consolidated onto one vehicle in the profit-max backhaul plan.'),
    ('BPMP_MAX_DEADHEAD_KM',      '250',   'number', 'core',   TRUE,  'Hard cap on a vehicle total DEADHEAD (empty) km across the whole return tour.'),
    ('BPMP_MAX_RETURN_KM',        '3000',  'number', 'core',   TRUE,  'Loose total-distance safety guard on a vehicle whole return tour (km).'),
    ('BPMP_PRIORITY_SCALE',       '25',    'number', 'core',   TRUE,  'Revenue->priority divisor.'),
    ('BPMP_SOLVER',               'vroom', 'string', 'core',   TRUE,  'vroom = VROOM road solve; greedy = solver-free greedy builder.'),
    ('PLANNING_LEAD_DAYS',        '4',     'number', 'core',   TRUE,  'Shipment lead time (days).'),
    ('INTERNAL_POOL_CAP',         '5000',  'number', 'core',   TRUE,  'ABSOLUTE ceiling on own waiting loads exposed as internal demand. A safety valve only - the pool is normally sized by INTERNAL_LOADS_PER_TRAILER.'),
    ('INTERNAL_LOADS_PER_TRAILER','4',     'number', 'core',   TRUE,  'Waiting internal loads per idle trailer. Sizes the internal pool relative to the fleet so it means the same thing in every region, instead of the pool being whatever INTERNAL_POOL_CAP happens to truncate to.'),
    ('TRIANGLE_ENABLED',          'true',  'bool',   'core',   TRUE,  'Enable chained two-hop matching.'),
    ('TRIANGLE_MAX_LEGS',         '2',     'number', 'core',   TRUE,  'Loaded legs per chain.'),
    ('TRIANGLE_MIN_PROGRESS_PCT', '5',     'number', 'core',   TRUE,  'Leg 1 must close at least this pct of the great-circle gap to the target.'),
    ('TRIANGLE_MIN_PROGRESS_RATIO','1.0',   'number', 'core',   TRUE,  'Leg 1 must return at least this many km of progress per empty km.'),
    ('TRIANGLE_MAX_LEG1_DETOUR_KM','400',  'number', 'core',   TRUE,  'Hard cap on how far leg 1 may leave the direct corridor (km).'),
    ('TRIANGLE_MAX_TOTAL_EMPTY_KM','250',  'number', 'core',   TRUE,  'Cap on total empty km across the whole chain.'),
    ('TRIANGLE_LEG1_OPTIONS',     '12',    'number', 'core',   TRUE,  'Top N leg-1 loads kept per vehicle before the self-join.'),
    ('MAX_TRIANGLES_PER_TRAILER', '5',     'number', 'core',   TRUE,  'How many ranked chains to keep per vehicle.'),
    ('TARGET_MODE',               'home_depot','string','core', TRUE,  'home_depot = chain toward the vehicle home depot; dispatcher_choice = chain toward a supplied target.'),
    ('TARGET_RADIUS_KM',          '250',   'number', 'core',   TRUE,  'Leg 2 must deliver within this distance of the target (km).'),
    ('CASCADE_GRADE_THRESHOLD',   '70',    'number', 'core',   TRUE,  'Composite score at which the internal-first cascade stops widening.'),
    ('ENFORCE_EQUIPMENT_FIT',     'false', 'bool',   'core',   TRUE,  'Reject pairs whose load requires equipment the vehicle does not carry.'),
    ('EQUIPMENT_STRICT',          'false', 'bool',   'core',   TRUE,  'true = a load with no stated equipment requirement still needs an exact match.'),
    ('TRADELANE_INCLUDE',         '',      'string', 'future', FALSE, 'Comma list of allowed pickup->delivery country lanes.'),
    ('TRADELANE_EXCLUDE',         '',      'string', 'future', FALSE, 'Comma list of forbidden country lanes.'),
    ('RETURN_TO_HOME_REGION',     'true',  'bool',   'core',   TRUE,  'Score loads by the progress they make toward the target region.')
  AS v(PARAM_KEY, PARAM_VALUE, PARAM_TYPE, CATEGORY, ENABLED, DESCRIPTION)
) src
ON tgt.PARAM_KEY = src.PARAM_KEY
WHEN NOT MATCHED THEN INSERT (PARAM_KEY, PARAM_VALUE, PARAM_TYPE, CATEGORY, ENABLED, DESCRIPTION)
  VALUES (src.PARAM_KEY, src.PARAM_VALUE, src.PARAM_TYPE, src.CATEGORY, src.ENABLED, src.DESCRIPTION);

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
  SELECT VEHICLE_TYPE, REGION, 1 AS PRI, CREATED_AT FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS WHERE IS_ACTIVE = TRUE
  UNION ALL SELECT 'ebike', 'SanFrancisco', 2, NULL::TIMESTAMP_LTZ
) s
WHERE NOT EXISTS (SELECT 1 FROM FLEET_INTELLIGENCE.CATCHMENT.CONFIG)
QUALIFY ROW_NUMBER() OVER (ORDER BY PRI, CREATED_AT DESC NULLS LAST) = 1;

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
--
-- GUARDED, and the guard is load-bearing. This is the ONLY statement in this file
-- that depends on the five Overture Marketplace listings acquired above, which is
-- the most likely thing to fail on a brand-new account (listing availability,
-- ORGDATACLOUD access, region). Because `snow sql -f` is stop-on-first-error, an
-- unguarded failure here abandoned the remaining ~1,400 lines of this file - the
-- LOCATION diagnostics, the ZIP enrichment, the SOURCING diagnostics and the
-- FLEET_APP.SOURCING views - so one missing listing silently emptied five views
-- that have nothing to do with Overture. Catchment is allowed to fail alone.
EXECUTE IMMEDIATE $$
BEGIN
  CALL FLEET_INTELLIGENCE.CATCHMENT.BUILD_CATCHMENT(
    (SELECT REGION FROM FLEET_INTELLIGENCE.CATCHMENT.CONFIG LIMIT 1), TRUE);
  RETURN 'catchment built';
EXCEPTION
  WHEN OTHER THEN
    RETURN 'WARN: BUILD_CATCHMENT failed (Overture listings unavailable?); '
        || 'the catchment view will be empty, everything downstream of this '
        || 'point still builds. Detail: ' || SQLERRM;
END;
$$;

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

-- Guarded for the same reason as BUILD_CATCHMENT above: these builders read the
-- Overture-derived CATCHMENT tables, so they fail when catchment failed. Letting
-- that abort the file would also take out the SOURCING section 1,100 lines below,
-- which shares no dependency with either.
EXECUTE IMMEDIATE $$
BEGIN
  CALL FLEET_INTELLIGENCE.LOCATION.BUILD_LOCATION_DIAGNOSTICS();
  RETURN 'location diagnostics built';
EXCEPTION
  WHEN OTHER THEN
    RETURN 'WARN: BUILD_LOCATION_DIAGNOSTICS failed; site_impact / closure_impact '
        || 'will be empty. Detail: ' || SQLERRM;
END;
$$;

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

EXECUTE IMMEDIATE $$
BEGIN
  CALL FLEET_INTELLIGENCE.LOCATION.BUILD_LOCATION_ZIP_ENRICHMENT();
  RETURN 'location zip enrichment built';
EXCEPTION
  WHEN OTHER THEN
    RETURN 'WARN: BUILD_LOCATION_ZIP_ENRICHMENT failed; the ZIP choropleth and the '
        || 'at-risk rollups will be empty. Detail: ' || SQLERRM;
END;
$$;

-- 5b. FLEET_APP neutral-contract views the SA app reads (consumers never bind to
--     FLEET_INTELLIGENCE directly). Mirrors the generated CATCHMENT pack pattern.
-- NOTE: this analytic layer (step 3.5) runs BEFORE the packs layer (step 4) that
-- normally creates FLEET_APP, so create the DB defensively to keep a first run clean.
CREATE DATABASE IF NOT EXISTS FLEET_APP
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
ALTER DATABASE FLEET_APP SET DATA_RETENTION_TIME_IN_DAYS = 0;
CREATE SCHEMA IF NOT EXISTS FLEET_APP.CORE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
CREATE SCHEMA IF NOT EXISTS FLEET_APP.LOCATION
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-location-diagnostics","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- ===========================================================================
-- SUSPENDED-ENGINE GUARDS (shared by every live-ORS function)
-- ===========================================================================
-- An ORS wrapper does NOT throw when its region's service is suspended: it
-- returns a row whose payload is NULL and whose response carries the reason
--   {"error":"service_unreachable", "ors_host":"ors-service-<region>", ...}
-- Consumers that filter the NULL away (IS NOT NULL, or an inner join on
-- group_index) therefore turn an outage into an EMPTY RESULT SET, and the app
-- renders a blank panel that is indistinguishable from "there is no data here".
--
-- The app already handles a raised error: /api/query matches the message
-- against its suspend signatures (which include 'service_unreachable'), pulls
-- the region out of the 'ors-service-<region>' token, RESUMES that region, and
-- returns a typed 503 that the UI renders as "engine starting, retry in ~N min".
-- So the correct behavior everywhere is to FAIL LOUDLY with a message carrying
-- those two strings.
--
-- SQL UDFs cannot RAISE, so a deliberate cast failure carries the payload:
--   TO_BOOLEAN('ORS service_unreachable host=ors-service-europe')
--     -> "Boolean value 'ORS service_unreachable host=ors-service-europe' is
--         not recognized"
-- The CASE is LAZY, so a healthy region never evaluates the cast and pays
-- nothing.
--
-- Use the shape-specific helper for the call being guarded, because the guard
-- has to sit on an expression the query CANNOT prune:
--   ISOCHRONES + LATERAL FLATTEN -> ORS_FEATURES(resp.RESPONSE) as the FLATTEN
--     input (no features => no rows, so a WHERE guard would never be reached)
--   MATRIX_TABULAR               -> ORS_MATRIX(...) wrapping the call in the
--     CTE, so every downstream reference to the VARIANT forces evaluation
--   anything else                -> ORS_OK(response) in a WHERE predicate
CREATE OR REPLACE FUNCTION FLEET_APP.CORE.ORS_OK(P_RESPONSE VARIANT)
RETURNS BOOLEAN
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  CASE
    WHEN P_RESPONSE IS NOT NULL AND P_RESPONSE:error IS NULL THEN TRUE
    ELSE TO_BOOLEAN('ORS ' || COALESCE(P_RESPONSE:error::STRING, 'service_unreachable')
                    || ' host=' || COALESCE(P_RESPONSE:ors_host::STRING, '?'))
  END
$$;

-- Region key -> human-readable label. The region keys this repo uses are
-- CamelCase identifiers ('SanFrancisco', 'NewYork', 'Europe'), so a consumer
-- filtering on the literal phrase a person types ('San Francisco') matched
-- NOTHING - which is how a dwell question about San Francisco was answered
-- "there is no San Francisco data" while 15,091 San Francisco sessions were
-- sitting in the view. Every contract view that exposes a region now also
-- exposes REGION_LABEL, and the semantic views carry it as a `city` dimension
-- with synonyms, so Cortex Analyst can resolve the spoken form.
--
-- Deliberately derived from the key rather than read from
-- OPENROUTESERVICE_APP.CORE.REGION_CATALOG.REGION_NAME, for two reasons:
--   1. This file is engine-FREE (check_engine_guards.py). A VIEW or UDF body
--      resolves its references at CREATE time, so touching the engine database
--      here would hard-fail every `--no-engine` install and, because
--      `snow sql -f` stops at the first error, would abandon every statement
--      below it in this file.
--   2. REGION_NAME is not reliably a display name anyway - measured on
--      tib85385 it holds 'us/new-jersey' for UsNewJersey (a Geofabrik slug,
--      worse than the derived 'Us New Jersey'), against 5 of 7 sampled keys
--      where the derivation matches the catalog exactly.
-- Idempotent and dependency-free: safe on any install mode.
CREATE OR REPLACE FUNCTION FLEET_APP.CORE.REGION_LABEL(P_REGION VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  TRIM(REGEXP_REPLACE(COALESCE(P_REGION, ''), '([a-z0-9])([A-Z])', '\\1 \\2'))
$$;

-- Region -> ORS profile. Every live-routing view below used to hardcode
-- 'driving-car', which is only correct when the region's graph happens to have
-- that profile built. A region is provisioned for its dataset's vehicle type, so
-- an HGV region builds ONLY driving-hgv and an e-bike region builds
-- cycling-electric - and ORS answers a request for an unbuilt profile with
-- {"code":3003,"message":"Parameter 'profile' has incorrect value of 'unknown'"},
-- which the ORS_FEATURES guard turns into a cast failure. Result: catchment,
-- site_impact, closure_impact, sourcing_optimizer and mix_sourcing all failed
-- outright on every HGV region (96 failing area-executions across 4 regions in
-- the validate_app_views baseline), while passing on a car region - which is why
-- it was never noticed.
--
-- Resolved from data, not from a live ORS_STATUS call, so it costs nothing and
-- works while the service is suspended: the active dataset's VEHICLE_TYPE maps
-- through DIM_VEHICLE_PROFILE to exactly the profile that region's graph was
-- built for. Falls back to driving-car for a region with no active dataset.
CREATE OR REPLACE VIEW FLEET_APP.CORE.VW_REGION_PROFILE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT d.REGION,
       COALESCE(vp.ORS_PROFILE, 'driving-car') AS ORS_PROFILE
FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS d
LEFT JOIN FLEET_INTELLIGENCE.CORE.DIM_VEHICLE_PROFILE vp
  ON vp.VEHICLE_TYPE = d.VEHICLE_TYPE
WHERE d.IS_ACTIVE;

-- FLATTEN input for the ISOCHRONES response. Returns the features array when the
-- call succeeded; raises (carrying the suspend tokens) when it did not. A missing
-- `features` array is treated as a failure: ORS always returns features for a
-- request it actually served.
CREATE OR REPLACE FUNCTION FLEET_APP.CORE.ORS_FEATURES(P_RESPONSE VARIANT)
RETURNS ARRAY
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  CASE
    WHEN P_RESPONSE:features IS NOT NULL THEN P_RESPONSE:features::ARRAY
    ELSE TO_ARRAY(TO_BOOLEAN('ORS ' || COALESCE(P_RESPONSE:error::STRING, 'service_unreachable')
                             || ' host=' || COALESCE(P_RESPONSE:ors_host::STRING, '?')))
  END
$$;

-- Pass-through guard for a MATRIX_TABULAR VARIANT: returns the response verbatim
-- when it holds a matrix, raises otherwise. Wrap the MATRIX_TABULAR call itself so
-- the guard cannot be pruned or short-circuited by an adjacent IS NOT NULL filter.
CREATE OR REPLACE FUNCTION FLEET_APP.CORE.ORS_MATRIX(P_RESPONSE VARIANT)
RETURNS VARIANT
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  CASE
    WHEN P_RESPONSE:distances IS NOT NULL OR P_RESPONSE:durations IS NOT NULL THEN P_RESPONSE
    ELSE TO_VARIANT(TO_BOOLEAN('ORS ' || COALESCE(P_RESPONSE:error::STRING, 'service_unreachable')
                               || ' host=' || COALESCE(P_RESPONSE:ors_host::STRING, '?')))
  END
$$;

-- Grants for the guards (additive; roles from fleet_sa_app/app/role_binding.sql).
GRANT USAGE ON SCHEMA FLEET_APP.CORE TO ROLE FLEET_APP_USER;
GRANT USAGE ON SCHEMA FLEET_APP.CORE TO ROLE FLEET_APP_OPS;
GRANT USAGE ON SCHEMA FLEET_APP.CORE TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.CORE.ORS_OK(VARIANT) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.CORE.ORS_OK(VARIANT) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.CORE.ORS_OK(VARIANT) TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.CORE.ORS_FEATURES(VARIANT) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.CORE.ORS_FEATURES(VARIANT) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.CORE.ORS_FEATURES(VARIANT) TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.CORE.ORS_MATRIX(VARIANT) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.CORE.ORS_MATRIX(VARIANT) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.CORE.ORS_MATRIX(VARIANT) TO ROLE FLEET_APP_ADMIN;

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

-- [live-routing UDTFs moved -> analytic_layer_live_routing.sql]

-- [live-routing UDTFs moved -> analytic_layer_live_routing.sql]

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
-- [live-routing UDTFs moved -> analytic_layer_live_routing.sql]

-- ===========================================================================
-- Isochrone Overlap Mode (computed ST_INTERSECTION, not visual stacking)
-- ===========================================================================
-- [live-routing UDTFs moved -> analytic_layer_live_routing.sql]

-- [live-routing UDTFs moved -> analytic_layer_live_routing.sql]

-- [live-routing UDTFs moved -> analytic_layer_live_routing.sql]

-- [live-routing UDTFs moved -> analytic_layer_live_routing.sql]

-- [live-routing UDTFs moved -> analytic_layer_live_routing.sql]

-- [live-routing UDTFs moved -> analytic_layer_live_routing.sql]

-- [live-routing UDTFs moved -> analytic_layer_live_routing.sql]

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

-- [live-routing UDTFs moved -> analytic_layer_live_routing.sql]

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
-- [live-routing UDTFs moved -> analytic_layer_live_routing.sql]

-- [live-routing UDTFs moved -> analytic_layer_live_routing.sql]

-- [live-routing UDTFs moved -> analytic_layer_live_routing.sql]

-- [live-routing UDTFs moved -> analytic_layer_live_routing.sql]

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

EXECUTE IMMEDIATE $$
BEGIN
  CALL FLEET_INTELLIGENCE.SOURCING.BUILD_SOURCING_DIAGNOSTICS();
  RETURN 'sourcing diagnostics built';
EXCEPTION
  WHEN OTHER THEN
    RETURN 'WARN: BUILD_SOURCING_DIAGNOSTICS failed; sourcing_optimizer / '
        || 'mix_sourcing will be empty. Detail: ' || SQLERRM;
END;
$$;

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

-- The sourcing region's ORS profile, already resolved to ONE flat row.
--
-- Joins only, deliberately: the app passes this into a table function, and a UDTF
-- argument may be a literal, a bind or a scalar subquery but NOT a scalar subquery
-- that itself contains scalar subqueries. Views are inlined, so building this from
-- nested `(SELECT ...)` expressions pushed the nesting into the caller and
-- reproduced "Unsupported subquery type cannot be evaluated". Keep it join-shaped.
CREATE OR REPLACE VIEW FLEET_APP.SOURCING.VW_ACTIVE_PROFILE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-freight-sourcing","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
  AS
SELECT COALESCE(vp.ORS_PROFILE, 'driving-car') AS ORS_PROFILE
FROM FLEET_INTELLIGENCE.CATCHMENT.CONFIG c
LEFT JOIN FLEET_INTELLIGENCE.CORE.DIM_DATASETS d
  ON d.REGION = c.REGION AND d.IS_ACTIVE
LEFT JOIN FLEET_INTELLIGENCE.CORE.DIM_VEHICLE_PROFILE vp
  ON vp.VEHICLE_TYPE = d.VEHICLE_TYPE
LIMIT 1;

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

-- [live-routing UDTFs moved -> analytic_layer_live_routing.sql]

-- [live-routing UDTFs moved -> analytic_layer_live_routing.sql]

-- ===========================================================================
-- Phase 2: product-mix / inter-plant transfer (consolidate vs ship direct)
-- ===========================================================================
-- [live-routing UDTFs moved -> analytic_layer_live_routing.sql]

-- [live-routing UDTFs moved -> analytic_layer_live_routing.sql]

-- [live-routing UDTFs moved -> analytic_layer_live_routing.sql]

-- ===========================================================================
-- Road-based lane geometry (batched live DIRECTIONS)
-- ===========================================================================
-- The swap/mix maps default to straight O-D arcs. These two owner's-rights
-- UDTFs return the ACTUAL road route per lane so the map can draw road-based
-- paths instead of arcs. DIRECTIONS is a TABLE function, so it supports a
-- per-row LATERAL invocation (implicit CROSS JOIN) - this batches N routings
-- into ONE set-based statement (one SQL round-trip for the app), while still
-- calling ORS live per lane (Tenet 9, nothing precomputed). Consumers only
-- need USAGE here; the ORS grant lives with the function owner.

-- [live-routing UDTFs moved -> analytic_layer_live_routing.sql]

-- [live-routing UDTFs moved -> analytic_layer_live_routing.sql]

-- [live-routing UDTFs moved -> analytic_layer_live_routing.sql]

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
-- [live-routing UDTFs moved -> analytic_layer_live_routing.sql]

-- =============================================================================
-- CONFIG realignment (runs on EVERY install, not just a fresh one)
-- =============================================================================
-- The per-domain CONFIG seeds above are all `WHERE NOT EXISTS`, so they cannot
-- correct a row that already exists. That was fine while a single writer owned
-- them, but three writers with three different schema lists left real accounts
-- split: measured on tib85385, DWELL_ANALYSIS / ROUTE_DEVIATION /
-- ROUTE_OPTIMIZATION pointed at ebike/SanFrancisco while CATCHMENT / MARKETPLACE
-- / BACKLOAD_MATCHING pointed at hgv/Europe. A reinstall did NOT repair it.
--
-- Since the contract views no longer FILTER on CONFIG, a split no longer hides
-- data - but it still gives the app's context bar, and any agent asking "what is
-- the active context", a different answer per domain. This aligns every
-- discovered CONFIG table to ONE dataset: the newest active row in DIM_DATASETS.
--
-- Discovery matches the app writers exactly (a CONFIG table carrying both REGION
-- and VEHICLE_TYPE), so a seventh domain is realigned with no edit here, and a
-- table that does not exist on this install (MARKETPLACE.CONFIG is created by
-- the freight-exchange bootstrap, which is optional) is simply not found.
--
-- Idempotent and safe to re-run. Per-statement exception handling so a locked or
-- oddly-shaped table degrades to a skip rather than aborting the file - which
-- matters because `snow sql -f` stops at the first error and would abandon the
-- validation summary below.
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.CORE.REALIGN_DASHBOARD_CONFIG()
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
EXECUTE AS CALLER
AS
$$
DECLARE
  c_schemas CURSOR FOR
    SELECT TABLE_SCHEMA AS S
      FROM FLEET_INTELLIGENCE.INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_NAME = 'CONFIG'
       AND COLUMN_NAME IN ('REGION', 'VEHICLE_TYPE')
     GROUP BY TABLE_SCHEMA
    HAVING COUNT(DISTINCT COLUMN_NAME) = 2
     ORDER BY TABLE_SCHEMA;
  v_region  VARCHAR;
  v_vt      VARCHAR;
  v_done    INT DEFAULT 0;
  v_skipped INT DEFAULT 0;
BEGIN
  -- Newest ACTIVE dataset wins. Deterministic, unlike the seeds' original
  -- ORDER BY PRI which tied whenever two datasets were active at once.
  SELECT REGION, VEHICLE_TYPE INTO v_region, v_vt
    FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS
   WHERE IS_ACTIVE = TRUE
   ORDER BY CREATED_AT DESC NULLS LAST
   LIMIT 1;
  IF (v_region IS NULL) THEN
    RETURN 'SKIPPED: no active dataset in DIM_DATASETS';
  END IF;
  FOR r IN c_schemas DO
    LET sch VARCHAR := r.S;
    BEGIN
      EXECUTE IMMEDIATE 'UPDATE FLEET_INTELLIGENCE.' || sch
        || '.CONFIG SET REGION = ''' || REPLACE(v_region, '''', '''''')
        || ''', VEHICLE_TYPE = ''' || REPLACE(v_vt, '''', '''''') || '''';
      v_done := v_done + 1;
    EXCEPTION
      WHEN OTHER THEN v_skipped := v_skipped + 1;
    END;
  END FOR;
  RETURN 'aligned ' || v_done || ' CONFIG table(s) to ' || v_region || '/' || v_vt
      || IFF(v_skipped > 0, ' (' || v_skipped || ' skipped)', '');
END;
$$;

CALL FLEET_INTELLIGENCE.CORE.REALIGN_DASHBOARD_CONFIG();

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
