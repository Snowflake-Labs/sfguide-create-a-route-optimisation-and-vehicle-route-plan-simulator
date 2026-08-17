-- ============================================================================
-- Backload Proposals - cockpit schema (neutral, synthetic-backed)
-- ============================================================================
-- Run AFTER references/bootstrap.sql. bootstrap.sql creates the projection
-- views the cockpit binds to:
--   OPENROUTESERVICE_APP.CORE.VEHICLE_CLASS_PROFILE   (capacity / cost / profile)
--   FLEET_INTELLIGENCE.BACKLOAD_MATCHING.CONFIG       (active VEHICLE_TYPE,REGION)
--   FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_TRAILERS  (idle / returning vehicles)
--   FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_INTERNAL_VOLUMES (own waiting loads)
--   FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_EXTERNAL_OFFERS  (external offers)
--
-- This script adds the industry-neutral "Backload Proposals" cockpit layer:
--   VW_LOADS             union of internal volumes + external offers into ONE
--                        demand pool (IS_INTERNAL flag + priority), pickup /
--                        delivery GEOGRAPHY constructed from the lon/lat cols.
--   MATCH_PARAMS         config-driven constraint framework. Core rows enabled;
--                        future rows pre-seeded disabled so adding a rule is a
--                        row flip, not a code change. Constraints are generalized
--                        to vehicle-class (distance / pickup date / horizon /
--                        weight-fit / hazmat) - no FTL-specific ADR/Thermo/Mega/LDM.
--   VW_CANDIDATES        great-circle prefilter + pickup-date feasibility join
--                        (the pairs the solver considers). Region/profile are NOT
--                        stored here - they come from CONFIG + VEHICLE_CLASS_PROFILE.
--   VW_CANDIDATES_SCORED explainability view: keeps near-miss pairs and exposes
--                        each rule as a boolean + ELIGIBLE, for per-constraint
--                        pass/fail chips and "why not the alternatives".
--   PROPOSALS            generated trailer -> load proposals (working, session
--                        scoped; IS_SAVED flips a row to persist across reloads).
--   FEEDBACK             dispatcher Accept / Reject / Flag with reason code.
--
-- Trailer "empty" semantics on the synthetic model: a vehicle becomes free at
-- its last drop-off (EMPTY = DROPOFF_*, EMPTY_FROM_TS = ETA_TS) and biases back
-- toward its home depot (NEXT_START = HOME_*), so the solver's end location
-- encodes the direction-to-home preference.
--
-- CO-OWNED SOURCE OF TRUTH: the fleet admin app boot init recreates this exact
-- cockpit layer on every container start, in
--   .cortex/skills/install-fleet-apps/fleet_admin_app/ui/src/server/lib/init.ts
--   (ensureBackloadAndAssetVelocityObjects -> the BACKLOAD_MATCHING cockpit block).
-- That is what makes a fresh install work without running this file by hand.
-- Keep the two in lockstep: any change to MATCH_PARAMS / VW_LOADS /
-- VW_TRAILERS_GEO / VW_CANDIDATES / VW_CANDIDATES_SCORED here MUST be mirrored
-- into init.ts (init.ts CREATE-OR-REPLACEs these on boot and will silently
-- overwrite an out-of-band change made only here).
-- ============================================================================

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-backload-matching","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","module":"backload-proposals"}}';

USE WAREHOUSE ROUTING_ANALYTICS;
USE SCHEMA FLEET_INTELLIGENCE.BACKLOAD_MATCHING;

-- ----------------------------------------------------------------------------
-- 1. MATCH_PARAMS - config-driven constraint framework (neutral)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS MATCH_PARAMS (
  PARAM_KEY    VARCHAR       NOT NULL,
  PARAM_VALUE  VARCHAR,
  PARAM_TYPE   VARCHAR(16)   DEFAULT 'string',   -- string|number|bool
  CATEGORY     VARCHAR(16)   DEFAULT 'core',     -- core|future
  ENABLED      BOOLEAN       DEFAULT TRUE,
  DESCRIPTION  VARCHAR,
  UPDATED_AT   TIMESTAMP_NTZ DEFAULT SYSDATE(),
  CONSTRAINT PK_MATCH_PARAMS PRIMARY KEY (PARAM_KEY)
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-backload-matching","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

MERGE INTO MATCH_PARAMS tgt USING (
  SELECT * FROM VALUES
    -- key                        value    type      category  enabled  description
    ('MAX_EMPTY_KM',              '100',   'number', 'core',   TRUE,  'Max distance from where a vehicle becomes free to a load pickup (km).'),
    ('ENFORCE_PICKUP_DATE',       'true',  'bool',   'core',   TRUE,  'Vehicle must be free in time for the load pickup window.'),
    ('PICKUP_DATE_SLACK_HRS',     '0',     'number', 'core',   TRUE,  'Hours of slack allowed past the requested pickup window.'),
    ('MAX_PICKUP_HORIZON_DAYS',   '7',     'number', 'core',   TRUE,  'Only consider loads with a pickup within N days of the vehicle free time.'),
    ('DISTANCE_BASIS',            'road',  'string', 'core',   TRUE,  'road = ORS driving distance (needs the region graph); great_circle = straight-line. Falls back to great_circle if ORS is unavailable.'),
    ('PREFILTER_BUFFER_PCT',      '40',    'number', 'core',   TRUE,  'Great-circle prefilter radius = MAX_EMPTY_KM * (1 + pct/100), so road detours are not pruned before ORS refinement.'),
    ('MAX_PROPOSALS_PER_TRAILER', '3',     'number', 'core',   TRUE,  'How many ranked load proposals to keep per vehicle.'),
    ('INTERNAL_PRIORITY',         '100',   'number', 'core',   TRUE,  'VROOM priority applied to internal (own) waiting loads. Higher = internal-first.'),
    ('EXTERNAL_PRIORITY',         '10',    'number', 'core',   TRUE,  'VROOM priority applied to external freight-exchange offers.'),
    ('COST_PER_EMPTY_KM',         '1.20',  'number', 'core',   TRUE,  'Cost per empty km, for the savings KPI.'),
    ('IDLE_COST_PER_DAY',         '650',   'number', 'core',   TRUE,  'Standing-day cost, for the savings KPI.'),
    ('REVENUE_PER_LOADED_KM',     '1.10',  'number', 'core',   TRUE,  'ASSUMPTION (not from source data): benchmark revenue per loaded km, to translate recovered loaded km into a value figure. Label clearly in UI.'),
    -- ---- capability / fit constraints (generalized to vehicle-class) ----
    ('ENFORCE_WEIGHT_FIT',        'true',  'bool',   'core',   TRUE,  'Reject pairs where vehicle MAX_PAYLOAD_KG < load WEIGHT_KG + WEIGHT_FIT_MARGIN_KG.'),
    ('WEIGHT_FIT_MARGIN_KG',      '0',     'number', 'core',   TRUE,  'Safety margin (kg) added to load weight when checking ENFORCE_WEIGHT_FIT.'),
    ('REQUIRE_HAZMAT_CERT',       'true',  'bool',   'core',   TRUE,  'Hazmat loads must go on a hazmat-certified vehicle.'),
    -- ---- VRP optimizer (per-load VROOM respecting delivery + return + window) ----
    ('MAX_CANDIDATE_TRUCKS',      '8',     'number', 'core',   TRUE,  'Per load, how many nearest free vehicles (great-circle) to hand the VROOM solver. Lower = faster road solves.'),
    ('MAX_TRUCKS_PER_ORDER',      '3',     'number', 'core',   TRUE,  'How many ranked vehicle recommendations to keep per load in VRP mode.'),
    ('VRP_CONCURRENCY',           '4',     'number', 'core',   TRUE,  'Per-load best fit (road): how many loads to solve in parallel per chunk.'),
    ('PICKUP_WINDOW_HRS',         '12',    'number', 'core',   TRUE,  'Plus/minus tolerance (hours) around the requested pickup time.'),
    -- ---- fleet-wide 1:1 solve (connected-component clustering + per-cluster VROOM) ----
    ('CLUSTER_CAP',               '250',   'number', 'core',   TRUE,  'Max stops (vehicles + 2*loads) per VROOM cluster before a dense component is spatially sub-split.'),
    -- ---- profit-max backhaul plan (consolidate multiple loads per vehicle) ----
    ('BPMP_MAX_STOPS',            '4',     'number', 'core',   TRUE,  'Max loads consolidated onto one vehicle in the profit-max backhaul plan. Each load = pickup + delivery (2 VROOM tasks).'),
    ('BPMP_MAX_DEADHEAD_KM',      '250',   'number', 'core',   TRUE,  'Hard cap on a vehicle total DEADHEAD (empty) km across the whole return tour. The loaded haul is revenue-bearing and is NOT capped here.'),
    ('BPMP_MAX_RETURN_KM',        '3000',  'number', 'core',   TRUE,  'Loose total-distance safety guard on a vehicle whole return tour (empty + loaded + onward) in km.'),
    ('BPMP_PRIORITY_SCALE',       '25',    'number', 'core',   TRUE,  'Revenue->priority divisor: shipment priority = clamp(round(loaded-km revenue / scale), 1..100).'),
    ('BPMP_SOLVER',               'vroom', 'string', 'core',   TRUE,  'vroom = VROOM road solve (falls back to greedy if unreachable); greedy = solver-free greedy multi-stop builder.'),
    -- ---- future constraints (disabled until enabled by the dispatcher) ----
    ('TRADELANE_INCLUDE',         '',      'string', 'future', FALSE, 'Comma list of allowed pickup->delivery country lanes.'),
    ('TRADELANE_EXCLUDE',         '',      'string', 'future', FALSE, 'Comma list of forbidden country lanes.'),
    ('RETURN_TO_HOME_REGION',     'false', 'bool',   'future', FALSE, 'Prefer loads that route the vehicle back toward its home depot (triangle trips).')
  AS v(PARAM_KEY, PARAM_VALUE, PARAM_TYPE, CATEGORY, ENABLED, DESCRIPTION)
) src
ON tgt.PARAM_KEY = src.PARAM_KEY
WHEN NOT MATCHED THEN INSERT (PARAM_KEY, PARAM_VALUE, PARAM_TYPE, CATEGORY, ENABLED, DESCRIPTION)
  VALUES (src.PARAM_KEY, src.PARAM_VALUE, src.PARAM_TYPE, src.CATEGORY, src.ENABLED, src.DESCRIPTION);

-- ----------------------------------------------------------------------------
-- 2. PROPOSALS - generated vehicle -> load proposals (working + saved)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS PROPOSALS (
  PROPOSAL_ID          VARCHAR       NOT NULL,
  TRAILER_ID           VARCHAR       NOT NULL,
  LOAD_ID              VARCHAR       NOT NULL,
  IS_INTERNAL          BOOLEAN,
  SOURCE               VARCHAR,
  GREAT_CIRCLE_KM      FLOAT,
  EMPTY_KM             FLOAT,
  EMPTY_DRIVE_MIN      FLOAT,
  DISTANCE_BASIS       VARCHAR(32),                -- empty_only | great_circle | road | vrp_road | vrp_great_circle | fleet_vrp | fleet_great_circle | bpmp
  PICKUP_SLACK_HRS     FLOAT,
  EMPTY_FROM_TS        TIMESTAMP_NTZ,
  REQUESTED_PICKUP_TS  TIMESTAMP_NTZ,
  LOADED_KM            FLOAT,                      -- pickup -> delivery (the paying leg)
  NEXT_START_KM        FLOAT,                      -- delivery -> vehicle next-start (home)
  BASELINE_DEADHEAD_KM FLOAT,                      -- empty -> next-start (the trip the vehicle would drive anyway)
  DETOUR_KM            FLOAT,                      -- TOTAL_KM - LOADED_KM - BASELINE_DEADHEAD_KM
  TOTAL_KM             FLOAT,                      -- empty -> pickup -> delivery -> next-start
  TOTAL_DRIVE_MIN      FLOAT,
  FEASIBLE             BOOLEAN,
  RANK_IN_TRAILER      NUMBER,
  STOP_SEQ             NUMBER,                     -- BPMP multi-stop tour position (1-based); NULL for 1:1 strategies
  SCORE                FLOAT,
  RATIONALE            VARCHAR,
  IS_SAVED             BOOLEAN       DEFAULT FALSE,
  SESSION_ID           VARCHAR,                    -- per-browser-tab isolation key
  GENERATED_AT         TIMESTAMP_NTZ DEFAULT SYSDATE(),
  CONSTRAINT PK_PROPOSALS PRIMARY KEY (PROPOSAL_ID)
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-backload-matching","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- ----------------------------------------------------------------------------
-- 3. FEEDBACK - dispatcher Accept / Reject / Flag (human-in-the-loop)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FEEDBACK (
  FEEDBACK_ID      VARCHAR       NOT NULL,
  PROPOSAL_ID      VARCHAR,
  TRAILER_ID       VARCHAR,
  LOAD_ID          VARCHAR,
  ACTION           VARCHAR(16),                    -- ACCEPT | REJECT | FLAG
  REASON_CODE      VARCHAR,
  COMMENT          VARCHAR,
  DISPATCHER_ROLE  VARCHAR,
  SESSION_ID       VARCHAR,
  CREATED_AT       TIMESTAMP_NTZ DEFAULT SYSDATE(),
  CONSTRAINT PK_FEEDBACK PRIMARY KEY (FEEDBACK_ID)
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-backload-matching","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- ============================================================================
-- Views. Drop dependents before recreate (column-count invariant).
-- ============================================================================
DROP VIEW IF EXISTS VW_CANDIDATES_SCORED;
DROP VIEW IF EXISTS VW_CANDIDATES;
DROP VIEW IF EXISTS VW_LOADS;

-- ----------------------------------------------------------------------------
-- 4. VW_LOADS - internal volumes + external offers as ONE demand pool.
--    Geoms constructed from lon/lat (longitude first). IS_INTERNAL drives the
--    solver priority; PRICE_USD is NULL for internal loads.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW VW_LOADS
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-backload-matching","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT
  iv.ID                                                AS LOAD_ID,
  TRUE                                                 AS IS_INTERNAL,
  'INTERNAL'                                           AS SOURCE,
  iv.PICKUP_CITY,
  iv.PICKUP_LON,
  iv.PICKUP_LAT,
  ST_MAKEPOINT(iv.PICKUP_LON, iv.PICKUP_LAT)           AS PICKUP_GEOM,
  iv.DROPOFF_CITY                                      AS DELIVERY_CITY,
  iv.DROPOFF_LON                                       AS DELIVERY_LON,
  iv.DROPOFF_LAT                                       AS DELIVERY_LAT,
  ST_MAKEPOINT(iv.DROPOFF_LON, iv.DROPOFF_LAT)         AS DELIVERY_GEOM,
  iv.PICKUP_FROM_TS                                    AS REQUESTED_PICKUP_TS,
  iv.PICKUP_TO_TS                                      AS LATEST_PICKUP_TS,
  iv.WEIGHT_KG,
  iv.PRODUCT,
  iv.HAZMAT,
  NULL::NUMBER                                         AS PRICE_USD,
  ST_DISTANCE(ST_MAKEPOINT(iv.PICKUP_LON, iv.PICKUP_LAT),
              ST_MAKEPOINT(iv.DROPOFF_LON, iv.DROPOFF_LAT)) / 1000.0 AS APPROX_DISTANCE_KM,
  'Internal load: ' || iv.PICKUP_CITY || ' -> ' || iv.DROPOFF_CITY AS LISTING_TEXT
FROM VW_INTERNAL_VOLUMES iv
WHERE iv.PICKUP_LON IS NOT NULL AND iv.PICKUP_LAT IS NOT NULL
UNION ALL
SELECT
  eo.OFFER_ID                                          AS LOAD_ID,
  FALSE                                                AS IS_INTERNAL,
  eo.SOURCE,
  eo.PICKUP_CITY,
  eo.PICKUP_LON,
  eo.PICKUP_LAT,
  ST_MAKEPOINT(eo.PICKUP_LON, eo.PICKUP_LAT)           AS PICKUP_GEOM,
  eo.DROPOFF_CITY                                      AS DELIVERY_CITY,
  eo.DROPOFF_LON                                       AS DELIVERY_LON,
  eo.DROPOFF_LAT                                       AS DELIVERY_LAT,
  ST_MAKEPOINT(eo.DROPOFF_LON, eo.DROPOFF_LAT)         AS DELIVERY_GEOM,
  eo.PICKUP_FROM_TS                                    AS REQUESTED_PICKUP_TS,
  eo.PICKUP_TO_TS                                      AS LATEST_PICKUP_TS,
  eo.WEIGHT_KG,
  eo.PRODUCT,
  eo.HAZMAT,
  eo.PRICE_EUR                                         AS PRICE_USD,
  ST_DISTANCE(ST_MAKEPOINT(eo.PICKUP_LON, eo.PICKUP_LAT),
              ST_MAKEPOINT(eo.DROPOFF_LON, eo.DROPOFF_LAT)) / 1000.0 AS APPROX_DISTANCE_KM,
  eo.LISTING_TEXT
FROM VW_EXTERNAL_OFFERS eo
WHERE eo.PICKUP_LON IS NOT NULL AND eo.PICKUP_LAT IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 5. VW_TRAILERS_GEO - trailer free-point + return(home) geometry for matching.
--    EMPTY   = last drop-off (where the vehicle becomes free).
--    NEXT_START = home depot (return-to-home bias for the solver end location).
--    EMPTY_FROM_TS is anchored to "now - 0..12h" (deterministic per TRAILER_ID)
--    so the free-time sits in the same live window as the load pickups (bootstrap
--    anchors internal/external pickups at "now + 30..1160 min"). Without this the
--    synthetic drop-off timestamps are ~weeks old and every pair fails the pickup
--    horizon. LAST_DROPOFF_TS keeps the real drop-off time for display.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW VW_TRAILERS_GEO
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-backload-matching","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT
  t.TRAILER_ID,
  t.OPERATING_COUNTRY,
  t.HOME_DEPOT,
  t.HOME_LON,
  t.HOME_LAT,
  t.DROPOFF_CITY                              AS EMPTY_CITY,
  t.DROPOFF_LON                               AS EMPTY_LON,
  t.DROPOFF_LAT                               AS EMPTY_LAT,
  ST_MAKEPOINT(t.DROPOFF_LON, t.DROPOFF_LAT)  AS EMPTY_GEOM,
  DATEADD('minute', -1 * MOD(ABS(HASH(t.TRAILER_ID)), 720), CURRENT_TIMESTAMP()) AS EMPTY_FROM_TS,
  t.ETA_TS                                    AS LAST_DROPOFF_TS,
  ST_MAKEPOINT(t.HOME_LON, t.HOME_LAT)        AS NEXT_START_GEOM,
  t.HOME_LON                                  AS NEXT_START_LON,
  t.HOME_LAT                                  AS NEXT_START_LAT,
  t.HOME_DEPOT                                AS NEXT_START_LOCATION_TEXT,
  t.MAX_PAYLOAD_KG,
  t.HAZMAT_CERT,
  t.EV_RANGE_KM
FROM VW_TRAILERS t
WHERE t.DROPOFF_LON IS NOT NULL AND t.DROPOFF_LAT IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 6. VW_CANDIDATES - great-circle prefilter + pickup-date feasibility, gated by
--    the ENABLED MATCH_PARAMS rows. The solver reads pairs from here.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW VW_CANDIDATES
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-backload-matching","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
WITH p AS (
  SELECT
    MAX(IFF(PARAM_KEY='MAX_EMPTY_KM',            TRY_TO_DOUBLE(PARAM_VALUE), NULL)) AS MAX_EMPTY_KM,
    MAX(IFF(PARAM_KEY='PREFILTER_BUFFER_PCT',    TRY_TO_DOUBLE(PARAM_VALUE), NULL)) AS BUFFER_PCT,
    MAX(IFF(PARAM_KEY='PICKUP_DATE_SLACK_HRS',   TRY_TO_DOUBLE(PARAM_VALUE), NULL)) AS SLACK_HRS,
    MAX(IFF(PARAM_KEY='MAX_PICKUP_HORIZON_DAYS', TRY_TO_DOUBLE(PARAM_VALUE), NULL)) AS HORIZON_DAYS,
    MAX(IFF(PARAM_KEY='ENFORCE_PICKUP_DATE',     LOWER(PARAM_VALUE)='true', NULL))  AS ENFORCE_DATE,
    MAX(IFF(PARAM_KEY='ENFORCE_WEIGHT_FIT'  AND ENABLED, LOWER(PARAM_VALUE)='true', FALSE)) AS ENF_WEIGHT,
    MAX(IFF(PARAM_KEY='WEIGHT_FIT_MARGIN_KG',TRY_TO_DOUBLE(PARAM_VALUE), 0))                AS WEIGHT_MARGIN,
    MAX(IFF(PARAM_KEY='REQUIRE_HAZMAT_CERT' AND ENABLED, LOWER(PARAM_VALUE)='true', FALSE)) AS REQ_HAZMAT
  FROM MATCH_PARAMS
)
SELECT
  t.TRAILER_ID,
  l.LOAD_ID,
  l.IS_INTERNAL,
  l.SOURCE,
  t.EMPTY_GEOM, t.EMPTY_LAT, t.EMPTY_LON, t.EMPTY_CITY, t.OPERATING_COUNTRY,
  t.EMPTY_FROM_TS, t.MAX_PAYLOAD_KG, t.HAZMAT_CERT,
  t.NEXT_START_GEOM, t.NEXT_START_LAT, t.NEXT_START_LON, t.NEXT_START_LOCATION_TEXT,
  l.PICKUP_GEOM, l.PICKUP_LAT, l.PICKUP_LON, l.PICKUP_CITY,
  l.DELIVERY_GEOM, l.DELIVERY_LAT, l.DELIVERY_LON, l.DELIVERY_CITY,
  l.REQUESTED_PICKUP_TS, l.WEIGHT_KG, l.HAZMAT, l.PRICE_USD, l.PRODUCT, l.APPROX_DISTANCE_KM,
  ST_DISTANCE(t.EMPTY_GEOM, l.PICKUP_GEOM) / 1000.0 AS GREAT_CIRCLE_KM,
  DATEDIFF('minute', t.EMPTY_FROM_TS, l.REQUESTED_PICKUP_TS) / 60.0 AS PICKUP_SLACK_HRS
FROM VW_TRAILERS_GEO t
JOIN p ON TRUE
JOIN VW_LOADS l
  ON ST_DWITHIN(t.EMPTY_GEOM, l.PICKUP_GEOM, p.MAX_EMPTY_KM * (1 + p.BUFFER_PCT/100.0) * 1000)
 AND (NOT p.ENFORCE_DATE
      OR t.EMPTY_FROM_TS <= DATEADD('hour', p.SLACK_HRS, l.REQUESTED_PICKUP_TS))
 AND l.REQUESTED_PICKUP_TS <= DATEADD('day', p.HORIZON_DAYS, t.EMPTY_FROM_TS)
 AND (NOT p.ENF_WEIGHT  OR COALESCE(t.MAX_PAYLOAD_KG, 1e12) >= COALESCE(l.WEIGHT_KG, 0) + p.WEIGHT_MARGIN)
 AND (NOT p.REQ_HAZMAT  OR NOT COALESCE(l.HAZMAT, FALSE) OR COALESCE(t.HAZMAT_CERT, FALSE));

-- ----------------------------------------------------------------------------
-- 7. VW_CANDIDATES_SCORED - explainability. Keeps near-miss pairs (3x radius
--    prefilter) and exposes each rule as a boolean + ELIGIBLE.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW VW_CANDIDATES_SCORED
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-backload-matching","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
WITH p AS (
  SELECT
    MAX(IFF(PARAM_KEY='MAX_EMPTY_KM',            TRY_TO_DOUBLE(PARAM_VALUE), NULL)) AS MAX_EMPTY_KM,
    MAX(IFF(PARAM_KEY='PICKUP_DATE_SLACK_HRS',   TRY_TO_DOUBLE(PARAM_VALUE), NULL)) AS SLACK_HRS,
    MAX(IFF(PARAM_KEY='MAX_PICKUP_HORIZON_DAYS', TRY_TO_DOUBLE(PARAM_VALUE), NULL)) AS HORIZON_DAYS,
    MAX(IFF(PARAM_KEY='ENFORCE_PICKUP_DATE',     LOWER(PARAM_VALUE)='true', NULL))  AS ENFORCE_DATE,
    MAX(IFF(PARAM_KEY='ENFORCE_WEIGHT_FIT'  AND ENABLED, LOWER(PARAM_VALUE)='true', FALSE)) AS ENF_WEIGHT,
    MAX(IFF(PARAM_KEY='WEIGHT_FIT_MARGIN_KG',TRY_TO_DOUBLE(PARAM_VALUE), 0))                AS WEIGHT_MARGIN,
    MAX(IFF(PARAM_KEY='REQUIRE_HAZMAT_CERT' AND ENABLED, LOWER(PARAM_VALUE)='true', FALSE)) AS REQ_HAZMAT
  FROM MATCH_PARAMS
)
SELECT
  t.TRAILER_ID, l.LOAD_ID, l.IS_INTERNAL, l.SOURCE,
  t.EMPTY_CITY, t.OPERATING_COUNTRY, t.MAX_PAYLOAD_KG, t.HAZMAT_CERT,
  l.PICKUP_CITY, l.DELIVERY_CITY, l.PICKUP_LAT, l.PICKUP_LON, l.DELIVERY_LAT, l.DELIVERY_LON,
  l.REQUESTED_PICKUP_TS, t.EMPTY_FROM_TS, l.WEIGHT_KG, l.HAZMAT,
  ST_DISTANCE(t.EMPTY_GEOM, l.PICKUP_GEOM) / 1000.0 AS GREAT_CIRCLE_KM,
  DATEDIFF('minute', t.EMPTY_FROM_TS, l.REQUESTED_PICKUP_TS) / 60.0 AS PICKUP_SLACK_HRS,
  (ST_DISTANCE(t.EMPTY_GEOM, l.PICKUP_GEOM) / 1000.0) <= p.MAX_EMPTY_KM AS DIST_CHECK,
  (NOT p.ENFORCE_DATE OR t.EMPTY_FROM_TS <= DATEADD('hour', p.SLACK_HRS, l.REQUESTED_PICKUP_TS)) AS TIME_CHECK,
  (l.REQUESTED_PICKUP_TS <= DATEADD('day', p.HORIZON_DAYS, t.EMPTY_FROM_TS)) AS HORIZON_CHECK,
  (NOT p.ENF_WEIGHT OR COALESCE(t.MAX_PAYLOAD_KG, 1e12) >= COALESCE(l.WEIGHT_KG, 0) + p.WEIGHT_MARGIN) AS CAP_CHECK,
  (NOT p.REQ_HAZMAT OR NOT COALESCE(l.HAZMAT, FALSE) OR COALESCE(t.HAZMAT_CERT, FALSE)) AS HAZMAT_CHECK,
  ( ((ST_DISTANCE(t.EMPTY_GEOM, l.PICKUP_GEOM) / 1000.0) <= p.MAX_EMPTY_KM)
    AND (NOT p.ENFORCE_DATE OR t.EMPTY_FROM_TS <= DATEADD('hour', p.SLACK_HRS, l.REQUESTED_PICKUP_TS))
    AND (l.REQUESTED_PICKUP_TS <= DATEADD('day', p.HORIZON_DAYS, t.EMPTY_FROM_TS))
    AND (NOT p.ENF_WEIGHT OR COALESCE(t.MAX_PAYLOAD_KG, 1e12) >= COALESCE(l.WEIGHT_KG, 0) + p.WEIGHT_MARGIN)
    AND (NOT p.REQ_HAZMAT OR NOT COALESCE(l.HAZMAT, FALSE) OR COALESCE(t.HAZMAT_CERT, FALSE))
  ) AS ELIGIBLE
FROM VW_TRAILERS_GEO t
JOIN p ON TRUE
JOIN VW_LOADS l
  ON ST_DWITHIN(t.EMPTY_GEOM, l.PICKUP_GEOM, p.MAX_EMPTY_KM * 3 * 1000);

-- ----------------------------------------------------------------------------
-- 8. Sanity report
-- ----------------------------------------------------------------------------
SELECT 'MATCH_PARAMS'         AS object, COUNT(*) AS n FROM MATCH_PARAMS
UNION ALL SELECT 'VW_LOADS',            COUNT(*) FROM VW_LOADS
UNION ALL SELECT 'VW_TRAILERS_GEO',     COUNT(*) FROM VW_TRAILERS_GEO
UNION ALL SELECT 'VW_CANDIDATES',       COUNT(*) FROM VW_CANDIDATES
UNION ALL SELECT 'VW_CANDIDATES_SCORED',COUNT(*) FROM VW_CANDIDATES_SCORED
ORDER BY 1;

-- End of proposals-schema.sql
