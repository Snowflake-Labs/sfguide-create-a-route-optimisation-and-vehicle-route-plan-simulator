-- =============================================================================
-- Emergency Response Intelligence -- SQL Pipeline (v1.0.0)
-- =============================================================================
-- This file is the authoritative end-to-end deployment for the
-- emergency-response skill. Verified working against:
--   * Snowflake Public Data Free       (listing GZTSZ290BV255 -> SNOWFLAKE_PUBLIC_DATA_FREE.PUBLIC_DATA_FREE)
--   * kipi.ai FEMA National Risk Index (listing GZSTZKU9FH9   -> FEMA_NATIONAL_RISK_INDEX.NRI_SCH)
--   * OPENROUTESERVICE_APP             (build-routing-solution skill)
-- All CREATE statements include the COMMENT tracking tag per AGENTS.md.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- Set query_tag (hard requirement per AGENTS.md)
-- ----------------------------------------------------------------------------
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- ----------------------------------------------------------------------------
-- Step 0a: Install required Marketplace listings (idempotent)
-- ----------------------------------------------------------------------------
CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZTSZ290BV255');
CREATE DATABASE IF NOT EXISTS SNOWFLAKE_PUBLIC_DATA_FREE FROM LISTING GZTSZ290BV255;

CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZSTZKU9FH9');
CREATE DATABASE IF NOT EXISTS FEMA_NATIONAL_RISK_INDEX FROM LISTING GZSTZKU9FH9;

-- ----------------------------------------------------------------------------
-- Step 0: Database + schemas + CONFIG
-- ----------------------------------------------------------------------------
CREATE DATABASE IF NOT EXISTS EMERGENCY_RESPONSE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE SCHEMA IF NOT EXISTS EMERGENCY_RESPONSE.CONFIG
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
CREATE SCHEMA IF NOT EXISTS EMERGENCY_RESPONSE.SOURCE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
CREATE SCHEMA IF NOT EXISTS EMERGENCY_RESPONSE.CORE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
CREATE SCHEMA IF NOT EXISTS EMERGENCY_RESPONSE.PIPELINE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE TABLE IF NOT EXISTS EMERGENCY_RESPONSE.CONFIG.PARAMS (
  PARAM_NAME  VARCHAR PRIMARY KEY,
  PARAM_VALUE VARCHAR
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

MERGE INTO EMERGENCY_RESPONSE.CONFIG.PARAMS t
USING (SELECT * FROM VALUES
  ('REGION','SanFrancisco'),
  ('NUM_PARTICIPANTS','5000'),
  ('NUM_STAFF','300'),
  ('NUM_CENTERS','12'),
  ('NUM_DRIVERS','40'),
  ('VULNERABILITY_WEIGHTING','0.5'),
  ('TARGET_LAG','5 minutes'),
  ('H3_RESOLUTION_HISTORY','7')
  AS s(PARAM_NAME, PARAM_VALUE)) s
ON t.PARAM_NAME = s.PARAM_NAME
WHEN NOT MATCHED THEN INSERT (PARAM_NAME, PARAM_VALUE) VALUES (s.PARAM_NAME, s.PARAM_VALUE);

-- ----------------------------------------------------------------------------
-- Step 0c: IPAWS seed stage (holds the bundled SF-clipped parquet)
-- ----------------------------------------------------------------------------
-- The seed parquet `assets/ipaws_sf.parquet` ships with the skill. It is built
-- one-time on the developer machine by `scripts/build_ipaws_sf_seed.py` and
-- committed to the repo so the install needs zero runtime API access.
CREATE STAGE IF NOT EXISTS EMERGENCY_RESPONSE.SOURCE.IPAWS_SEED_STAGE
  FILE_FORMAT = (TYPE = PARQUET)
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- ----------------------------------------------------------------------------
-- Step 0d: Upload the seed parquet (run from repo root before invoking SQL)
-- ----------------------------------------------------------------------------
-- The install runner uploads the bundled parquet via Snow CLI before running
-- Step 0f. Equivalent commands (pick one):
--
--   snow stage copy \
--     .cortex/skills/emergency-response/assets/ipaws_sf.parquet \
--     @EMERGENCY_RESPONSE.SOURCE.IPAWS_SEED_STAGE/ \
--     --overwrite -c <connection>
--
-- Or from a Snowflake Workspace:
--
--   COPY FILES INTO @EMERGENCY_RESPONSE.SOURCE.IPAWS_SEED_STAGE/
--   FROM 'snow://workspace/USER$.PUBLIC."<workspace-name>"/versions/live/.cortex/skills/emergency-response/assets/'
--   FILES=('ipaws_sf.parquet');

-- ----------------------------------------------------------------------------
-- Step 0e: IPAWS_SF target table (GEOGRAPHY-first per AGENTS.md geo conventions)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE TABLE EMERGENCY_RESPONSE.SOURCE.IPAWS_SF (
  ALERT_ID         VARCHAR,
  SENT_AT          TIMESTAMP_TZ,
  STATUS           VARCHAR,
  MSG_TYPE         VARCHAR,
  SCOPE            VARCHAR,
  SENDER           VARCHAR,
  EVENT            VARCHAR,
  SEVERITY         VARCHAR,
  URGENCY          VARCHAR,
  CERTAINTY        VARCHAR,
  HEADLINE         VARCHAR,
  EFFECTIVE_AT     TIMESTAMP_TZ,
  EXPIRES_AT       TIMESTAMP_TZ,
  SEARCH_GEOMETRY  GEOGRAPHY
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- ----------------------------------------------------------------------------
-- Step 0f: Load the bundled parquet into IPAWS_SF (idempotent: TRUNCATE+COPY)
-- ----------------------------------------------------------------------------
TRUNCATE TABLE EMERGENCY_RESPONSE.SOURCE.IPAWS_SF;

COPY INTO EMERGENCY_RESPONSE.SOURCE.IPAWS_SF
  (ALERT_ID, SENT_AT, STATUS, MSG_TYPE, SCOPE, SENDER, EVENT, SEVERITY,
   URGENCY, CERTAINTY, HEADLINE, EFFECTIVE_AT, EXPIRES_AT, SEARCH_GEOMETRY)
FROM (
  SELECT
    $1:alert_id::VARCHAR,
    $1:sent_at::TIMESTAMP_TZ,
    $1:status::VARCHAR,
    $1:msg_type::VARCHAR,
    $1:scope::VARCHAR,
    $1:sender::VARCHAR,
    $1:event::VARCHAR,
    $1:severity::VARCHAR,
    $1:urgency::VARCHAR,
    $1:certainty::VARCHAR,
    $1:headline::VARCHAR,
    $1:effective_at::TIMESTAMP_TZ,
    $1:expires_at::TIMESTAMP_TZ,
    TRY_TO_GEOGRAPHY($1:search_geometry_geojson::VARCHAR)
  FROM @EMERGENCY_RESPONSE.SOURCE.IPAWS_SEED_STAGE/ipaws_sf.parquet
)
ON_ERROR = 'CONTINUE';

-- ----------------------------------------------------------------------------
-- Step 1-4: Source re-mapping views over Marketplace data
-- ----------------------------------------------------------------------------
-- NWS alerts: real table is NWS_WEATHER_ALERT_EVENTS; geometry comes from
-- GEOGRAPHY_CHARACTERISTICS joined on COUNTY_GEO_ID with relationship_type='coordinates_geojson'.
CREATE OR REPLACE VIEW EMERGENCY_RESPONSE.SOURCE.V_NWS_ALERTS_ACTIVE
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
WITH region AS (
  SELECT BOUNDARY
  FROM OPENROUTESERVICE_APP.CORE.REGION_CATALOG rc
  JOIN EMERGENCY_RESPONSE.CONFIG.PARAMS p ON p.PARAM_NAME = 'REGION'
  WHERE UPPER(rc.LOOKUP_NAME) = UPPER(p.PARAM_VALUE)
     OR UPPER(rc.REGION_KEY)  = UPPER(p.PARAM_VALUE)
  LIMIT 1
)
SELECT
  a.NWS_ALERT_ID                       AS alert_id,
  a.EVENT_TYPE                         AS event_type,
  a.EVENT_SEVERITY                     AS severity,
  a.EVENT_URGENCY                      AS urgency,
  a.EVENT_CERTAINTY                    AS certainty,
  a.ALERT_TITLE                        AS headline,
  a.ALERT_DESCRIPTION                  AS description,
  a.ALERT_INSTRUCTION                  AS instruction,
  a.EFFECTIVE_TIMESTAMP                AS effective_time,
  a.EXPIRATION_TIMESTAMP               AS expires_time,
  TRY_TO_GEOGRAPHY(gc.value)           AS boundary,
  ARRAY_CONSTRUCT(a.COUNTY_GEO_ID)     AS affected_geo_ids
FROM SNOWFLAKE_PUBLIC_DATA_FREE.PUBLIC_DATA_FREE.NWS_WEATHER_ALERT_EVENTS a
LEFT JOIN SNOWFLAKE_PUBLIC_DATA_FREE.PUBLIC_DATA_FREE.GEOGRAPHY_CHARACTERISTICS gc
  ON gc.GEO_ID = a.COUNTY_GEO_ID
 AND gc.RELATIONSHIP_TYPE = 'coordinates_geojson'
CROSS JOIN region r
WHERE a.EXPIRATION_TIMESTAMP > CURRENT_TIMESTAMP()
  AND a.EVENT_SEVERITY IN ('Extreme','Severe','Moderate')
  AND TRY_TO_GEOGRAPHY(gc.value) IS NOT NULL
  AND ST_INTERSECTS(TRY_TO_GEOGRAPHY(gc.value), r.BOUNDARY);

-- FEMA disaster declarations: areas (county-level) live in a separate table.
CREATE OR REPLACE VIEW EMERGENCY_RESPONSE.SOURCE.V_FEMA_DISASTERS_RECENT
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT
  d.DISASTER_ID                        AS disaster_number,
  d.DISASTER_DECLARATION_NAME          AS declaration_title,
  d.DISASTER_TYPE                      AS incident_type,
  d.DISASTER_DECLARATION_DATE          AS declaration_date,
  d.DISASTER_BEGIN_DATE                AS incident_begin_date,
  d.DISASTER_END_DATE                  AS incident_end_date,
  da.STATE_GEO_ID                      AS state_code,
  da.COUNTY_GEO_ID                     AS county_geo_id
FROM SNOWFLAKE_PUBLIC_DATA_FREE.PUBLIC_DATA_FREE.FEMA_DISASTER_DECLARATION_INDEX d
LEFT JOIN SNOWFLAKE_PUBLIC_DATA_FREE.PUBLIC_DATA_FREE.FEMA_DISASTER_DECLARATION_AREAS_INDEX da
  ON d.DISASTER_ID = da.DISASTER_ID
WHERE d.DISASTER_DECLARATION_DATE >= DATEADD(YEAR, -5, CURRENT_DATE());

-- FEMA National Risk Index: census-tract-level risk + social vulnerability for
-- the 6 perils that matter to Innovage. TRACTFIPS is NUMBER in the source.
CREATE OR REPLACE VIEW EMERGENCY_RESPONSE.SOURCE.V_FEMA_NRI_TRACTS
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT
  TRACTFIPS                AS tract_fips,
  STATE,
  COUNTY,
  SOVI_SCORE,
  SOVI_RATNG,
  RESL_SCORE,
  RISK_SCORE  AS overall_risk_score,
  HRCN_RISKS  AS hurricane_risk,
  RFLD_RISKS  AS riverine_flood_risk,
  CFLD_RISKS  AS coastal_flood_risk,
  WFIR_RISKS  AS wildfire_risk,
  TRND_RISKS  AS tornado_risk,
  ISTM_RISKS  AS ice_storm_risk,
  SWND_RISKS  AS strong_wind_risk,
  POPULATION
FROM FEMA_NATIONAL_RISK_INDEX.NRI_SCH.NRI_CENSUSTRACTS;

-- ACS vulnerability stub. Phase 2 will join American Community Survey
-- disability + age 65+ percentages -- ACS variable_name strings are heavily
-- templated and need careful pattern-matching work. v1.0.0 returns empty.
CREATE OR REPLACE VIEW EMERGENCY_RESPONSE.SOURCE.V_ACS_VULNERABLE_POP_TRACTS
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT CAST(NULL AS VARCHAR) AS tract_fips,
       CAST(NULL AS FLOAT)   AS pct_disability,
       CAST(NULL AS FLOAT)   AS pct_age_65_plus
WHERE 1 = 0;

-- Offline fallback when no live alert covers the region.
CREATE TABLE IF NOT EXISTS EMERGENCY_RESPONSE.SOURCE.MOCK_ALERTS (
  alert_id        VARCHAR PRIMARY KEY,
  event_type      VARCHAR,
  severity        VARCHAR,
  urgency         VARCHAR,
  certainty       VARCHAR,
  headline        VARCHAR,
  description     VARCHAR,
  instruction     VARCHAR,
  effective_time  TIMESTAMP_NTZ,
  expires_time    TIMESTAMP_NTZ,
  boundary        GEOGRAPHY,
  affected_geo_ids ARRAY
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- Default mock SF wildfire scenario (so Pages 2-4 always have data to show).
INSERT INTO EMERGENCY_RESPONSE.SOURCE.MOCK_ALERTS
  (alert_id, event_type, severity, urgency, certainty, headline, description, instruction,
   effective_time, expires_time, boundary, affected_geo_ids)
SELECT
  'MOCK-CA-WILDFIRE-001',
  'Red Flag Warning',
  'Severe',
  'Immediate',
  'Likely',
  'Red Flag Warning issued for the Bay Area',
  'Critical fire weather conditions expected in the East Bay Hills. Strong offshore winds and low humidity create extreme wildfire potential.',
  'Avoid all outdoor burning. Evacuate immediately if directed by local authorities.',
  CURRENT_TIMESTAMP(),
  DATEADD(HOUR, 24, CURRENT_TIMESTAMP()),
  TO_GEOGRAPHY('POLYGON((-122.50 37.80, -122.38 37.80, -122.36 37.72, -122.45 37.70, -122.50 37.80))'),
  ARRAY_CONSTRUCT('06075')
WHERE NOT EXISTS (SELECT 1 FROM EMERGENCY_RESPONSE.SOURCE.MOCK_ALERTS WHERE alert_id = 'MOCK-CA-WILDFIRE-001');

-- ----------------------------------------------------------------------------
-- Step 4a: SF-clipped IPAWS view (consumed by both live and historical DTs)
-- ----------------------------------------------------------------------------
-- Re-shapes IPAWS_SF rows into the same column set that V_NWS_ALERTS_ACTIVE
-- uses for the live UNION in STG_NWS_ACTIVE_ALERTS, plus retains the original
-- columns for the historical heatmap. The parquet is already SF-clipped at
-- authoring time, so no additional ST_INTERSECTS is needed here.
CREATE OR REPLACE VIEW EMERGENCY_RESPONSE.SOURCE.V_IPAWS_SF
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT
  ALERT_ID                                  AS alert_id,
  EVENT                                     AS event_type,
  SEVERITY                                  AS severity,
  URGENCY                                   AS urgency,
  CERTAINTY                                 AS certainty,
  HEADLINE                                  AS headline,
  CAST(NULL AS VARCHAR)                     AS description,
  CAST(NULL AS VARCHAR)                     AS instruction,
  EFFECTIVE_AT::TIMESTAMP_NTZ               AS effective_time,
  EXPIRES_AT::TIMESTAMP_NTZ                 AS expires_time,
  SEARCH_GEOMETRY                           AS boundary,
  ARRAY_CONSTRUCT()                         AS affected_geo_ids,
  SENT_AT                                   AS sent_at,
  SENDER                                    AS sender,
  MSG_TYPE                                  AS msg_type,
  STATUS                                    AS status
FROM EMERGENCY_RESPONSE.SOURCE.IPAWS_SF
WHERE SEARCH_GEOMETRY IS NOT NULL;

-- ----------------------------------------------------------------------------
-- Step 5: CORE entity tables (GEOGRAPHY-first per AGENTS.md geo conventions)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS EMERGENCY_RESPONSE.CORE.PARTICIPANTS (
  PARTICIPANT_ID    VARCHAR PRIMARY KEY,
  FULL_NAME         VARCHAR,
  ADDRESS_LINE      VARCHAR,
  CITY              VARCHAR,
  STATE             VARCHAR,
  ZIP               VARCHAR,
  TRACT_FIPS        VARCHAR,
  HOME_LOC          GEOGRAPHY,
  H3_RES8           VARCHAR,
  FRAILTY_SCORE     NUMBER(5,2),
  REQUIRES_LIFT     BOOLEAN,
  PRIMARY_LANGUAGE  VARCHAR
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE TABLE IF NOT EXISTS EMERGENCY_RESPONSE.CORE.STAFF (
  STAFF_ID    VARCHAR PRIMARY KEY,
  FULL_NAME   VARCHAR,
  ROLE        VARCHAR,
  HOME_LOC    GEOGRAPHY,
  H3_RES8     VARCHAR,
  CENTER_ID   VARCHAR
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE TABLE IF NOT EXISTS EMERGENCY_RESPONSE.CORE.CENTERS (
  CENTER_ID    VARCHAR PRIMARY KEY,
  CENTER_NAME  VARCHAR,
  ADDRESS_LINE VARCHAR,
  LOC          GEOGRAPHY,
  CAPACITY     NUMBER,
  HAS_GENERATOR BOOLEAN,
  IS_SHELTER   BOOLEAN
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE TABLE IF NOT EXISTS EMERGENCY_RESPONSE.CORE.DRIVERS (
  DRIVER_ID     VARCHAR PRIMARY KEY,
  FULL_NAME     VARCHAR,
  STATUS        VARCHAR,
  CURRENT_LOC   GEOGRAPHY,
  VEHICLE_TYPE  VARCHAR,
  HAS_LIFT      BOOLEAN,
  CAPACITY      NUMBER
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- ----------------------------------------------------------------------------
-- Step 6: Synthetic data generator
-- ----------------------------------------------------------------------------
-- Stored procedure that populates the four entity tables. Uses NAD addresses
-- inside the active region BOUNDARY. Idempotent (TRUNCATE first).
CREATE OR REPLACE PROCEDURE EMERGENCY_RESPONSE.CORE.GENERATE_INNOVAGE_DATASET(REGION_NAME VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
DECLARE
  num_p INT DEFAULT (SELECT PARAM_VALUE::INT FROM EMERGENCY_RESPONSE.CONFIG.PARAMS WHERE PARAM_NAME='NUM_PARTICIPANTS');
  num_s INT DEFAULT (SELECT PARAM_VALUE::INT FROM EMERGENCY_RESPONSE.CONFIG.PARAMS WHERE PARAM_NAME='NUM_STAFF');
  num_c INT DEFAULT (SELECT PARAM_VALUE::INT FROM EMERGENCY_RESPONSE.CONFIG.PARAMS WHERE PARAM_NAME='NUM_CENTERS');
  num_d INT DEFAULT (SELECT PARAM_VALUE::INT FROM EMERGENCY_RESPONSE.CONFIG.PARAMS WHERE PARAM_NAME='NUM_DRIVERS');
BEGIN
  TRUNCATE TABLE EMERGENCY_RESPONSE.CORE.PARTICIPANTS;
  TRUNCATE TABLE EMERGENCY_RESPONSE.CORE.STAFF;
  TRUNCATE TABLE EMERGENCY_RESPONSE.CORE.CENTERS;
  TRUNCATE TABLE EMERGENCY_RESPONSE.CORE.DRIVERS;

  -- Centers first so STAFF can reference them.
  INSERT INTO EMERGENCY_RESPONSE.CORE.CENTERS
    (CENTER_ID, CENTER_NAME, ADDRESS_LINE, LOC, CAPACITY, HAS_GENERATOR, IS_SHELTER)
  WITH region AS (
    SELECT BOUNDARY FROM OPENROUTESERVICE_APP.CORE.REGION_CATALOG
    WHERE UPPER(LOOKUP_NAME)=UPPER(:REGION_NAME) OR UPPER(REGION_KEY)=UPPER(:REGION_NAME) LIMIT 1
  ),
  candidate AS (
    SELECT
      a.NUMBER||' '||a.STREET||' '||COALESCE(a.STREET_TYPE,'') AS address_line,
      ST_MAKEPOINT(a.LONGITUDE, a.LATITUDE) AS loc,
      ROW_NUMBER() OVER (ORDER BY RANDOM()) AS rn
    FROM SNOWFLAKE_PUBLIC_DATA_FREE.PUBLIC_DATA_FREE.US_ADDRESSES a, region r
    WHERE a.LATITUDE IS NOT NULL AND a.LONGITUDE IS NOT NULL
      AND ST_WITHIN(ST_MAKEPOINT(a.LONGITUDE, a.LATITUDE), r.BOUNDARY)
  )
  SELECT
    'C-'||LPAD(rn::VARCHAR, 3, '0'),
    'Innovage Center '||rn::VARCHAR,
    address_line, loc,
    UNIFORM(60, 200, RANDOM())::NUMBER,
    UNIFORM(0, 1, RANDOM()) > 0.4,
    UNIFORM(0, 1, RANDOM()) > 0.7
  FROM candidate WHERE rn <= :num_c;

  -- Participants.
  INSERT INTO EMERGENCY_RESPONSE.CORE.PARTICIPANTS
    (PARTICIPANT_ID, FULL_NAME, ADDRESS_LINE, CITY, STATE, ZIP, TRACT_FIPS, HOME_LOC, H3_RES8,
     FRAILTY_SCORE, REQUIRES_LIFT, PRIMARY_LANGUAGE)
  WITH region AS (
    SELECT BOUNDARY FROM OPENROUTESERVICE_APP.CORE.REGION_CATALOG
    WHERE UPPER(LOOKUP_NAME)=UPPER(:REGION_NAME) OR UPPER(REGION_KEY)=UPPER(:REGION_NAME) LIMIT 1
  ),
  candidate AS (
    SELECT
      a.NUMBER||' '||a.STREET||' '||COALESCE(a.STREET_TYPE,'') AS address_line,
      a.CITY, a.STATE, a.ZIP,
      ST_MAKEPOINT(a.LONGITUDE, a.LATITUDE) AS home_loc,
      ROW_NUMBER() OVER (ORDER BY RANDOM()) AS rn
    FROM SNOWFLAKE_PUBLIC_DATA_FREE.PUBLIC_DATA_FREE.US_ADDRESSES a, region r
    WHERE a.LATITUDE IS NOT NULL AND a.LONGITUDE IS NOT NULL
      AND ST_WITHIN(ST_MAKEPOINT(a.LONGITUDE, a.LATITUDE), r.BOUNDARY)
  )
  SELECT
    'P-'||LPAD(rn::VARCHAR, 6, '0'),
    'Participant '||rn::VARCHAR,
    address_line, city, state, zip,
    NULL,                                          -- TRACT_FIPS Phase 2
    home_loc,
    H3_POINT_TO_CELL_STRING(home_loc, 8),
    UNIFORM(40, 95, RANDOM())::NUMBER(5,2),
    UNIFORM(0, 1, RANDOM()) > 0.85,
    CASE UNIFORM(1, 4, RANDOM())
      WHEN 1 THEN 'English' WHEN 2 THEN 'Spanish'
      WHEN 3 THEN 'Mandarin' ELSE 'Vietnamese' END
  FROM candidate WHERE rn <= :num_p;

  -- Staff (use ARRAY_AGG of center IDs to dodge "Unsupported subquery" error).
  INSERT INTO EMERGENCY_RESPONSE.CORE.STAFF (STAFF_ID, FULL_NAME, ROLE, HOME_LOC, H3_RES8, CENTER_ID)
  WITH region AS (
    SELECT BOUNDARY FROM OPENROUTESERVICE_APP.CORE.REGION_CATALOG
    WHERE UPPER(LOOKUP_NAME)=UPPER(:REGION_NAME) OR UPPER(REGION_KEY)=UPPER(:REGION_NAME) LIMIT 1
  ), center_arr AS (
    SELECT ARRAY_AGG(CENTER_ID) WITHIN GROUP (ORDER BY CENTER_ID) AS arr,
           COUNT(*) AS cnt
    FROM EMERGENCY_RESPONSE.CORE.CENTERS
  ), candidate AS (
    SELECT
      ST_MAKEPOINT(a.LONGITUDE, a.LATITUDE) AS home_loc,
      ROW_NUMBER() OVER (ORDER BY RANDOM()) AS rn
    FROM SNOWFLAKE_PUBLIC_DATA_FREE.PUBLIC_DATA_FREE.US_ADDRESSES a, region r
    WHERE a.LATITUDE IS NOT NULL AND a.LONGITUDE IS NOT NULL
      AND ST_WITHIN(ST_MAKEPOINT(a.LONGITUDE, a.LATITUDE), r.BOUNDARY)
  )
  SELECT
    'S-'||LPAD(c.rn::VARCHAR, 4, '0'),
    'Staff '||c.rn::VARCHAR,
    CASE UNIFORM(1, 5, RANDOM())
      WHEN 1 THEN 'Nurse' WHEN 2 THEN 'Aide' WHEN 3 THEN 'Driver'
      WHEN 4 THEN 'Coordinator' ELSE 'Therapist' END,
    c.home_loc,
    H3_POINT_TO_CELL_STRING(c.home_loc, 8),
    ca.arr[MOD(c.rn::INT, ca.cnt)]::VARCHAR
  FROM candidate c CROSS JOIN center_arr ca
  WHERE c.rn <= :num_s;

  -- Drivers.
  INSERT INTO EMERGENCY_RESPONSE.CORE.DRIVERS (DRIVER_ID, FULL_NAME, STATUS, CURRENT_LOC, VEHICLE_TYPE, HAS_LIFT, CAPACITY)
  WITH region AS (
    SELECT BOUNDARY FROM OPENROUTESERVICE_APP.CORE.REGION_CATALOG
    WHERE UPPER(LOOKUP_NAME)=UPPER(:REGION_NAME) OR UPPER(REGION_KEY)=UPPER(:REGION_NAME) LIMIT 1
  ), candidate AS (
    SELECT
      ST_MAKEPOINT(a.LONGITUDE, a.LATITUDE) AS loc,
      ROW_NUMBER() OVER (ORDER BY RANDOM()) AS rn
    FROM SNOWFLAKE_PUBLIC_DATA_FREE.PUBLIC_DATA_FREE.US_ADDRESSES a, region r
    WHERE a.LATITUDE IS NOT NULL AND a.LONGITUDE IS NOT NULL
      AND ST_WITHIN(ST_MAKEPOINT(a.LONGITUDE, a.LATITUDE), r.BOUNDARY)
  )
  SELECT
    'D-'||LPAD(rn::VARCHAR, 3, '0'),
    'Driver '||rn::VARCHAR,
    CASE WHEN UNIFORM(0, 1, RANDOM()) > 0.3 THEN 'ON_SHIFT' ELSE 'OFF_SHIFT' END,
    loc,
    CASE UNIFORM(1, 3, RANDOM()) WHEN 1 THEN 'van' WHEN 2 THEN 'sedan' ELSE 'paratransit' END,
    UNIFORM(0, 1, RANDOM()) > 0.5,
    UNIFORM(3, 8, RANDOM())::NUMBER
  FROM candidate WHERE rn <= :num_d;

  RETURN 'Generated dataset for region: '||:REGION_NAME;
END;
$$;

-- Run the generator for the configured region:
CALL EMERGENCY_RESPONSE.CORE.GENERATE_INNOVAGE_DATASET(
  (SELECT PARAM_VALUE FROM EMERGENCY_RESPONSE.CONFIG.PARAMS WHERE PARAM_NAME='REGION')
);

-- ----------------------------------------------------------------------------
-- Step 7: ORS wrapper UDFs
-- ----------------------------------------------------------------------------
-- ORS_ISOCHRONE_FOR_CENTER -- thin wrapper over ISOCHRONES table function.
-- The wrapped TABLE function cannot be embedded in Dynamic Tables, so this
-- UDF is invoked from server/routes/emergency.ts (Page 3 Reachability)
-- and on-demand from analytics queries.
CREATE OR REPLACE FUNCTION EMERGENCY_RESPONSE.CORE.ORS_ISOCHRONE_FOR_CENTER(
  CENTER_LOC GEOGRAPHY,
  RANGE_SECONDS NUMBER,
  REGION_NAME VARCHAR
)
RETURNS GEOGRAPHY
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  (SELECT GEOJSON
   FROM TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES(
     'driving-car',
     ST_X(CENTER_LOC)::FLOAT,
     ST_Y(CENTER_LOC)::FLOAT,
     RANGE_SECONDS,
     REGION_NAME
   ))
   LIMIT 1)
$$;

-- ORS_OPTIMIZATION_AVOIDING -- VRP solver with avoid_polygons. The
-- avoid_polygons argument is the live NWS alert geometry, which makes
-- generated routes physically detour around the hazard. Called by Page 4
-- Dispatch on-demand.
CREATE OR REPLACE FUNCTION EMERGENCY_RESPONSE.CORE.ORS_OPTIMIZATION_AVOIDING(
  JOBS ARRAY,
  VEHICLES ARRAY,
  ALERT_BOUNDARY GEOGRAPHY,
  REGION_NAME VARCHAR
)
RETURNS VARIANT
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  (SELECT RESPONSE
   FROM TABLE(OPENROUTESERVICE_APP.CORE.OPTIMIZATION(
     OBJECT_CONSTRUCT(
       'jobs',           JOBS,
       'vehicles',       VEHICLES,
       'options',        OBJECT_CONSTRUCT('g', TRUE),
       'avoid_polygons', TO_VARIANT(ST_ASGEOJSON(ALERT_BOUNDARY))
     )::VARIANT,
     REGION_NAME
   ))
   LIMIT 1)
$$;

-- ----------------------------------------------------------------------------
-- Step 8-13: Dynamic Tables in PIPELINE
-- ----------------------------------------------------------------------------
-- TARGET_LAG = 5 min for inputs (so impact is detected fast).
-- FACT_REACHABILITY_BY_CENTER and FACT_DISPATCH_PLAN are computed on-demand
-- by the React server (server/routes/emergency.ts) because Snowflake Dynamic
-- Tables cannot embed table-valued ORS functions.

CREATE OR REPLACE DYNAMIC TABLE EMERGENCY_RESPONSE.PIPELINE.STG_NWS_ACTIVE_ALERTS
  TARGET_LAG = '5 minutes'
  WAREHOUSE  = ROUTING_ANALYTICS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT
  alert_id, event_type, severity, urgency, certainty,
  headline, description, instruction,
  effective_time, expires_time,
  boundary,
  affected_geo_ids,
  CASE severity
    WHEN 'Extreme'  THEN 4
    WHEN 'Severe'   THEN 3
    WHEN 'Moderate' THEN 2
    ELSE 1
  END AS severity_rank
FROM EMERGENCY_RESPONSE.SOURCE.V_NWS_ALERTS_ACTIVE
UNION ALL
SELECT
  alert_id, event_type, severity, urgency, certainty,
  headline, description, instruction,
  effective_time, expires_time,
  boundary, affected_geo_ids,
  CASE severity
    WHEN 'Extreme'  THEN 4 WHEN 'Severe' THEN 3
    WHEN 'Moderate' THEN 2 ELSE 1 END
FROM EMERGENCY_RESPONSE.SOURCE.MOCK_ALERTS
UNION ALL
-- Live IPAWS layer: surface IPAWS-originated alerts (AMBER, civil emergency,
-- non-NWS weather) that are still in their effective window. The seed parquet
-- is SF-clipped at authoring time so no extra spatial filter is needed here.
SELECT
  alert_id, event_type, severity, urgency, certainty,
  headline, description, instruction,
  effective_time, expires_time,
  boundary, affected_geo_ids,
  CASE severity
    WHEN 'Extreme'  THEN 4 WHEN 'Severe' THEN 3
    WHEN 'Moderate' THEN 2 ELSE 1 END
FROM EMERGENCY_RESPONSE.SOURCE.V_IPAWS_SF
WHERE expires_time IS NOT NULL
  AND expires_time > CURRENT_TIMESTAMP();

-- v1.0.0: TRACT_FIPS for synthetic participants is NULL pending Phase 2 reverse
-- geocoding. The NRI join therefore matches nothing and SOVI_SCORE falls back
-- to 50 (mid-vulnerability). Composite score reduces to FRAILTY_SCORE-driven.
CREATE OR REPLACE DYNAMIC TABLE EMERGENCY_RESPONSE.PIPELINE.STG_PARTICIPANT_VULNERABILITY
  TARGET_LAG = '5 minutes'
  WAREHOUSE  = ROUTING_ANALYTICS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
WITH w AS (
  SELECT PARAM_VALUE::FLOAT AS w FROM EMERGENCY_RESPONSE.CONFIG.PARAMS WHERE PARAM_NAME='VULNERABILITY_WEIGHTING'
)
SELECT
  p.PARTICIPANT_ID,
  p.HOME_LOC,
  p.TRACT_FIPS,
  p.FRAILTY_SCORE,
  p.REQUIRES_LIFT,
  COALESCE(nri.SOVI_SCORE, 50)         AS sovi_score,
  CAST(NULL AS FLOAT)                  AS pct_age_65_plus,
  CAST(NULL AS FLOAT)                  AS pct_disability,
  ROUND(
    (SELECT w FROM w) * COALESCE(nri.SOVI_SCORE, 50)
    + (1 - (SELECT w FROM w)) * p.FRAILTY_SCORE, 2
  ) AS composite_vulnerability
FROM EMERGENCY_RESPONSE.CORE.PARTICIPANTS p
LEFT JOIN EMERGENCY_RESPONSE.SOURCE.V_FEMA_NRI_TRACTS nri
  ON TRY_CAST(p.TRACT_FIPS AS NUMBER) = TRY_CAST(nri.tract_fips AS NUMBER);

CREATE OR REPLACE DYNAMIC TABLE EMERGENCY_RESPONSE.PIPELINE.FACT_IMPACTED_PARTICIPANTS
  TARGET_LAG = '5 minutes'
  WAREHOUSE  = ROUTING_ANALYTICS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT
  a.alert_id,
  a.event_type,
  a.severity,
  v.PARTICIPANT_ID,
  v.HOME_LOC,
  v.composite_vulnerability,
  v.REQUIRES_LIFT,
  ST_DISTANCE(v.HOME_LOC, ST_CENTROID(a.boundary)) / 1609.34 AS miles_from_alert_centroid,
  CURRENT_TIMESTAMP() AS detected_at
FROM EMERGENCY_RESPONSE.PIPELINE.STG_NWS_ACTIVE_ALERTS  a
JOIN EMERGENCY_RESPONSE.PIPELINE.STG_PARTICIPANT_VULNERABILITY v
  ON ST_WITHIN(v.HOME_LOC, a.boundary);

CREATE OR REPLACE DYNAMIC TABLE EMERGENCY_RESPONSE.PIPELINE.FACT_HAZARD_HISTORY_H3
  TARGET_LAG = '24 hours'
  WAREHOUSE  = ROUTING_ANALYTICS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
WITH res AS (
  SELECT PARAM_VALUE::INT AS r FROM EMERGENCY_RESPONSE.CONFIG.PARAMS WHERE PARAM_NAME='H3_RESOLUTION_HISTORY'
), county_h3 AS (
  SELECT
    geo.geo_id AS county_geo_id,
    H3_POINT_TO_CELL_STRING(ST_CENTROID(TRY_TO_GEOGRAPHY(chars.value)), (SELECT r FROM res)) AS h3_cell
  FROM SNOWFLAKE_PUBLIC_DATA_FREE.PUBLIC_DATA_FREE.GEOGRAPHY_INDEX geo
  JOIN SNOWFLAKE_PUBLIC_DATA_FREE.PUBLIC_DATA_FREE.GEOGRAPHY_CHARACTERISTICS chars
    ON geo.geo_id = chars.geo_id AND chars.relationship_type = 'coordinates_geojson'
  WHERE geo.level = 'County'
)
SELECT
  ch.h3_cell,
  d.incident_type,
  COUNT(*)                                  AS event_count,
  MAX(d.declaration_date)                   AS most_recent_event,
  COUNT(DISTINCT d.disaster_number)         AS unique_disasters
FROM EMERGENCY_RESPONSE.SOURCE.V_FEMA_DISASTERS_RECENT d
JOIN county_h3 ch ON ch.county_geo_id = d.county_geo_id
GROUP BY ch.h3_cell, d.incident_type
UNION ALL
-- Historical IPAWS layer: H3-aggregate every IPAWS alert centroid that the
-- seed parquet contains (already SF-clipped at authoring time).
SELECT
  H3_POINT_TO_CELL_STRING(ST_CENTROID(SEARCH_GEOMETRY), (SELECT r FROM res)) AS h3_cell,
  COALESCE(NULLIF(EVENT,''),'IPAWS Alert')              AS incident_type,
  COUNT(*)                                              AS event_count,
  MAX(SENT_AT)::DATE                                    AS most_recent_event,
  COUNT(DISTINCT ALERT_ID)                              AS unique_disasters
FROM EMERGENCY_RESPONSE.SOURCE.IPAWS_SF
WHERE SEARCH_GEOMETRY IS NOT NULL
GROUP BY 1, 2;

-- ----------------------------------------------------------------------------
-- Step 14: CSV export procedure (replaces Tyler's manual ArcGIS spreadsheet)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE EMERGENCY_RESPONSE.CORE.EXPORT_IMPACTED_CSV(ALERT_ID VARCHAR)
RETURNS TABLE (
  PARTICIPANT_ID VARCHAR,
  ADDRESS VARCHAR,
  COMPOSITE_VULNERABILITY NUMBER(5,2),
  REQUIRES_LIFT BOOLEAN,
  MILES_FROM_HAZARD FLOAT
)
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  DECLARE res RESULTSET;
  BEGIN
    res := (
      SELECT
        f.PARTICIPANT_ID,
        p.ADDRESS_LINE||', '||p.CITY||', '||p.STATE||' '||p.ZIP,
        f.composite_vulnerability,
        f.REQUIRES_LIFT,
        f.miles_from_alert_centroid
      FROM EMERGENCY_RESPONSE.PIPELINE.FACT_IMPACTED_PARTICIPANTS f
      JOIN EMERGENCY_RESPONSE.CORE.PARTICIPANTS p USING (PARTICIPANT_ID)
      WHERE f.alert_id = :ALERT_ID
      ORDER BY f.composite_vulnerability DESC, f.miles_from_alert_centroid ASC
    );
    RETURN TABLE(res);
  END;
$$;

-- =============================================================================
-- Step 15: Install-time verification (raises if the IPAWS seed didn't load)
-- =============================================================================
-- Run this immediately after the COPY INTO above. If it raises, the parquet
-- was not uploaded to @EMERGENCY_RESPONSE.SOURCE.IPAWS_SEED_STAGE -- re-run
-- the snow stage copy command from Step 0d and re-execute Step 0f.
EXECUTE IMMEDIATE
$$
BEGIN
  LET ipaws_rows INT := (SELECT COUNT(*) FROM EMERGENCY_RESPONSE.SOURCE.IPAWS_SF);
  IF (ipaws_rows = 0) THEN
    RAISE STATEMENT_ERROR;
  END IF;
  RETURN 'IPAWS_SF rows: ' || ipaws_rows::VARCHAR;
END;
$$;

-- =============================================================================
-- Verification queries (manual)
-- =============================================================================
-- SELECT 'IPAWS_SF',                    COUNT(*) FROM EMERGENCY_RESPONSE.SOURCE.IPAWS_SF
-- UNION ALL SELECT 'STG_NWS_ACTIVE_ALERTS',      COUNT(*) FROM EMERGENCY_RESPONSE.PIPELINE.STG_NWS_ACTIVE_ALERTS
-- UNION ALL SELECT 'FACT_IMPACTED_PARTICIPANTS', COUNT(*) FROM EMERGENCY_RESPONSE.PIPELINE.FACT_IMPACTED_PARTICIPANTS
-- UNION ALL SELECT 'FACT_HAZARD_HISTORY_H3',     COUNT(*) FROM EMERGENCY_RESPONSE.PIPELINE.FACT_HAZARD_HISTORY_H3
-- UNION ALL SELECT 'CORE.PARTICIPANTS',          COUNT(*) FROM EMERGENCY_RESPONSE.CORE.PARTICIPANTS;
-- =============================================================================
