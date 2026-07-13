-- =============================================================================
-- RETIRED (v2). This CA/CO/PA pipeline is superseded by the region-generic v3
-- model: Emergency Response data is now produced by Data Studio
-- (generates_hazard -> FACT_HAZARD_ZONES, generates_anchors -> DIM_ANCHORS) and
-- consumed via the FLEET_APP.EMERGENCY_RESPONSE contract + evac_seed/evac_solve
-- verbs by the FLEET_SA_APP `emergency_response` wizard. STATE_REGION_MAP,
-- V_ZIP_RISK (US ZIP-code share), CARECONNECT_CENTERS (the committed CSV) and
-- ORS_ISOCHRONE_FOR_CENTER below are NOT part of any current install. This file
-- is kept only as historical reference for the retired control-app wizard and is
-- slated for deletion. See emergency-response/SKILL.md (v3) for the live model.
-- =============================================================================
-- =============================================================================
-- Emergency Response -- Evacuation Planning Wizard -- SQL Pipeline (v2.0.0)
-- =============================================================================
-- Single-page, multi-step evacuation planner. Replaces the v1 5-page
-- NWS/IPAWS/synthetic-participant design.
--
-- Workflow backed by this pipeline:
--   Step 1  Pick hazard (flood|wildfire) + state -> color risky ZIPs
--   Step 2  Seed CareConnect centers + Overture participant addresses inside the
--           union of per-center drive-time isochrones
--   Step 3  Per-center vehicle count + capacity (passed at plan time)
--   Step 4  Solve a capacitated multi-depot VRP over participants whose home
--           ZIP risk >= the selected threshold
--
-- Data sources (all free / already shared):
--   * FEMA National Risk Index   (listing GZSTZKU9FH9 -> FEMA_NATIONAL_RISK_INDEX.NRI_SCH.NRI_COUNTIES)
--   * US ZIP metadata + geometry (U_S__ZIP_CODE_METADATA_WITH_GEOMETRY.PUBLIC.*)
--   * Overture Maps addresses    (OVERTURE_MAPS__ADDRESSES.CARTO.ADDRESS)
--   * OPENROUTESERVICE_APP       (install-fleet-apps skill: ISOCHRONES + OPTIMIZATION)
--
-- Every CREATE includes the COMMENT tracking tag per AGENTS.md.
-- =============================================================================

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":2,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- ----------------------------------------------------------------------------
-- Step 0a: Install required Marketplace listing (idempotent)
-- ----------------------------------------------------------------------------
-- FEMA National Risk Index (free). ZIP metadata + Overture addresses are
-- assumed already shared into the account (see SKILL.md prerequisites).
CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZSTZKU9FH9');
CREATE DATABASE IF NOT EXISTS FEMA_NATIONAL_RISK_INDEX FROM LISTING GZSTZKU9FH9;

-- ----------------------------------------------------------------------------
-- Step 0b: Database + schemas + CONFIG
-- ----------------------------------------------------------------------------
CREATE DATABASE IF NOT EXISTS EMERGENCY_RESPONSE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":2,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE SCHEMA IF NOT EXISTS EMERGENCY_RESPONSE.CONFIG
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":2,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
CREATE SCHEMA IF NOT EXISTS EMERGENCY_RESPONSE.CORE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":2,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
CREATE SCHEMA IF NOT EXISTS EMERGENCY_RESPONSE.PIPELINE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":2,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- State -> ORS region key map. Only DEPLOYED regions can route. Add rows here
-- when more state graphs are provisioned by install-fleet-apps.
CREATE TABLE IF NOT EXISTS EMERGENCY_RESPONSE.CONFIG.STATE_REGION_MAP (
  STATE_CODE   VARCHAR(2) PRIMARY KEY,
  STATE_NAME   VARCHAR,
  ORS_REGION   VARCHAR,        -- LOOKUP_NAME / REGION key understood by ORS
  ENABLED      BOOLEAN
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":2,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

MERGE INTO EMERGENCY_RESPONSE.CONFIG.STATE_REGION_MAP t
USING (SELECT * FROM VALUES
  ('CA','California','UsCalifornia',  TRUE),
  ('CO','Colorado',  'UsColorado',  TRUE),
  ('PA','Pennsylvania','UsPennsylvania', TRUE)
  AS s(STATE_CODE, STATE_NAME, ORS_REGION, ENABLED)) s
ON t.STATE_CODE = s.STATE_CODE
WHEN MATCHED THEN UPDATE SET STATE_NAME=s.STATE_NAME, ORS_REGION=s.ORS_REGION, ENABLED=s.ENABLED
WHEN NOT MATCHED THEN INSERT (STATE_CODE, STATE_NAME, ORS_REGION, ENABLED)
  VALUES (s.STATE_CODE, s.STATE_NAME, s.ORS_REGION, s.ENABLED);

-- ----------------------------------------------------------------------------
-- Step 1: CareConnect centers (loaded from the committed geocoded CSV)
-- ----------------------------------------------------------------------------
-- The CSV ships with the skill at datasets/careconnect_centers_geocoded.csv. The
-- 18 centers lacking coordinates were geocoded once via OpenCage (build-time);
-- the 2 FL centers carry official map-pin coordinates.
CREATE STAGE IF NOT EXISTS EMERGENCY_RESPONSE.CONFIG.SEED_STAGE
  FILE_FORMAT = (TYPE = CSV FIELD_OPTIONALLY_ENCLOSED_BY = '"' SKIP_HEADER = 1)
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":2,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- Upload before running the COPY below (run from repo root):
--   snow stage copy \
--     .cortex/skills/emergency-response/datasets/careconnect_centers_geocoded.csv \
--     @EMERGENCY_RESPONSE.CONFIG.SEED_STAGE/ --overwrite -c <connection>

CREATE TABLE IF NOT EXISTS EMERGENCY_RESPONSE.CORE.CARECONNECT_CENTERS (
  CENTER_ID      VARCHAR PRIMARY KEY,
  CENTER_NAME    VARCHAR,
  STREET_ADDRESS VARCHAR,
  CITY           VARCHAR,
  STATE          VARCHAR(2),
  POSTAL_CODE    VARCHAR,
  LON            FLOAT,
  LAT            FLOAT,
  LOC            GEOGRAPHY,
  GEOCODE_CONF   NUMBER,
  GEOCODE_SOURCE VARCHAR
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":2,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- Idempotent reload (TRUNCATE + COPY with computed CENTER_ID + GEOGRAPHY).
TRUNCATE TABLE EMERGENCY_RESPONSE.CORE.CARECONNECT_CENTERS;
COPY INTO EMERGENCY_RESPONSE.CORE.CARECONNECT_CENTERS
  (CENTER_ID, CENTER_NAME, STREET_ADDRESS, CITY, STATE, POSTAL_CODE, LON, LAT, LOC, GEOCODE_CONF, GEOCODE_SOURCE)
FROM (
  SELECT
    'IC-' || SUBSTR(MD5($1), 1, 8),
    $1, $2, $3, $4, $5,
    $6::FLOAT, $7::FLOAT,
    ST_MAKEPOINT($6::FLOAT, $7::FLOAT),
    $8::NUMBER, $9
  FROM @EMERGENCY_RESPONSE.CONFIG.SEED_STAGE/careconnect_centers_geocoded.csv
)
ON_ERROR = 'ABORT_STATEMENT';

-- ----------------------------------------------------------------------------
-- Step 2: Per-ZIP hazard risk (FEMA NRI county risk joined to ZIP via county FIPS)
-- ----------------------------------------------------------------------------
-- Risk is published at county granularity; every ZIP in a county inherits the
-- county rating. Flood = the higher of riverine (RFLD) and coastal (CFLD).
-- Ordinal scale 1..5 (Very Low..Very High); 0 = No Rating/Insufficient/N.A.
CREATE OR REPLACE VIEW EMERGENCY_RESPONSE.PIPELINE.V_ZIP_RISK
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":2,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
WITH rate AS (
  -- rating text -> ordinal helper, applied via JOINs below
  SELECT * FROM VALUES
    ('Very Low',1),('Relatively Low',2),('Relatively Moderate',3),
    ('Relatively High',4),('Very High',5)
    AS r(LABEL, LVL)
)
SELECT
  m.ZIP_CODE,
  m.STATE,
  m.COUNTY,
  n.STCOFIPS,
  g.GEOMETRY                                            AS ZIP_GEOMETRY,
  -- Wildfire
  n.WFIR_RISKR                                          AS WILDFIRE_LABEL,
  COALESCE(wf.LVL, 0)                                   AS WILDFIRE_LEVEL,
  -- Flood = max(riverine, coastal)
  CASE WHEN COALESCE(rf.LVL,0) >= COALESCE(cf.LVL,0)
       THEN n.RFLD_RISKR ELSE n.CFLD_RISKR END          AS FLOOD_LABEL,
  GREATEST(COALESCE(rf.LVL,0), COALESCE(cf.LVL,0))      AS FLOOD_LEVEL
FROM U_S__ZIP_CODE_METADATA_WITH_GEOMETRY.PUBLIC.ZIP_CODE_META_SHARE m
JOIN U_S__ZIP_CODE_METADATA_WITH_GEOMETRY.PUBLIC.ZIP_CODE_GEOMETRY_SHARE g
  ON g.ZIP_CODE = m.ZIP_CODE
JOIN FEMA_NATIONAL_RISK_INDEX.NRI_SCH.NRI_COUNTIES n
  ON n.STCOFIPS = m.FIPS
LEFT JOIN rate wf ON wf.LABEL = n.WFIR_RISKR
LEFT JOIN rate rf ON rf.LABEL = n.RFLD_RISKR
LEFT JOIN rate cf ON cf.LABEL = n.CFLD_RISKR;

-- ----------------------------------------------------------------------------
-- Step 3: ORS isochrone wrapper (reused from v1)
-- ----------------------------------------------------------------------------
-- The wizard is fully client-driven: the React page issues read-only SELECTs
-- via /api/query for every step (risk ZIPs; the seed query returns the
-- isochrone union + a uniform participant sample in one statement; the VRP is
-- a multi-trip pickup VROOM solve). No scenario state is persisted server-side
-- -- seeded participants live in React state between steps and are embedded
-- into the VROOM challenge at plan time, exactly like RouteOptimization /
-- AssetVelocity / BackloadMatching.
-- Thin wrapper over the ISOCHRONES table function so the seed step can union
-- per-center drive-time polygons in plain SQL. NOTE: the ORS ISOCHRONES table
-- function takes its range argument in MINUTES (it converts to seconds and
-- enforces an 18000s / 300-min guardrail internally).
CREATE OR REPLACE FUNCTION EMERGENCY_RESPONSE.CORE.ORS_ISOCHRONE_FOR_CENTER(
  CENTER_LOC GEOGRAPHY,
  RANGE_MINUTES NUMBER,
  REGION_NAME VARCHAR
)
RETURNS GEOGRAPHY
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":2,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  (SELECT GEOJSON
   FROM TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES(
     'driving-car',
     ST_X(CENTER_LOC)::FLOAT,
     ST_Y(CENTER_LOC)::FLOAT,
     RANGE_MINUTES,
     REGION_NAME
   ))
   LIMIT 1)
$$;

-- =============================================================================
-- Step 5: Drop retired v1 objects (NWS / IPAWS / synthetic participants)
-- =============================================================================
-- Safe to run repeatedly. These belonged to the v1 5-page design and are no
-- longer referenced by the wizard.
DROP DYNAMIC TABLE IF EXISTS EMERGENCY_RESPONSE.PIPELINE.STG_NWS_ACTIVE_ALERTS;
DROP DYNAMIC TABLE IF EXISTS EMERGENCY_RESPONSE.PIPELINE.STG_PARTICIPANT_VULNERABILITY;
DROP DYNAMIC TABLE IF EXISTS EMERGENCY_RESPONSE.PIPELINE.FACT_IMPACTED_PARTICIPANTS;
DROP DYNAMIC TABLE IF EXISTS EMERGENCY_RESPONSE.PIPELINE.FACT_HAZARD_HISTORY_H3;
DROP FUNCTION IF EXISTS EMERGENCY_RESPONSE.CORE.ORS_OPTIMIZATION_AVOIDING(ARRAY, ARRAY, GEOGRAPHY, VARCHAR);
DROP PROCEDURE IF EXISTS EMERGENCY_RESPONSE.CORE.GENERATE_CARECONNECT_DATASET(VARCHAR);
DROP PROCEDURE IF EXISTS EMERGENCY_RESPONSE.CORE.EXPORT_IMPACTED_CSV(VARCHAR);
DROP SCHEMA IF EXISTS EMERGENCY_RESPONSE.SOURCE;

-- =============================================================================
-- Verification (manual)
-- =============================================================================
-- SELECT COUNT(*) FROM EMERGENCY_RESPONSE.CORE.CARECONNECT_CENTERS;          -- 20
-- SELECT WILDFIRE_LEVEL, COUNT(*) FROM EMERGENCY_RESPONSE.PIPELINE.V_ZIP_RISK WHERE STATE='CO' GROUP BY 1 ORDER BY 1;
-- SELECT FLOOD_LEVEL,    COUNT(*) FROM EMERGENCY_RESPONSE.PIPELINE.V_ZIP_RISK WHERE STATE='CO' GROUP BY 1 ORDER BY 1;
-- =============================================================================
