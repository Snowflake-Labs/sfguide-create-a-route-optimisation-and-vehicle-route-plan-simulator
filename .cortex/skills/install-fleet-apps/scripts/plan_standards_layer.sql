-- =====================================================================
-- PLAN STANDARDS layer - route-plan standardization and planner variance
-- =====================================================================
-- Answers "are all our planners building routes the same way, and what does
-- the variation cost us?" - the question a distributor asks when it has dozens
-- of route planners working to a written standard that is not consistently
-- followed.
--
-- WHY THIS LAYER EXISTS
-- The app already had the AUTOMATION half of route planning (the Route
-- Optimization Simulator solves a live VRP inside Snowflake) and the EXECUTION
-- half (Plan-vs-Actual scores how closely a DRIVER followed the plan). Nothing
-- scored the PLANNER who wrote it, so "our planners build routes differently"
-- had no screen and no number.
--
-- GRAIN, AND WHY IT IS NOT THE SOURCE GRAIN
-- FLEET_APP.CORE.VW_DIM_PLAN is ONE ROW PER LEG - measured, 16,535 rows and
-- 16,535 distinct PLAN_IDs on SanFrancisco. A route plan is therefore the set
-- of legs sharing (REGION, ENTITY_ID, PLAN_DATE), ordered by SEQUENCE_NUM.
-- Measured route shape per region:
--
--   SanFrancisco            589 routes, 28.1 stops, 113.2 km, 7.55 h, SD 46.4 km
--   UnitedStatesOfAmerica   380 routes,  1.3 stops, 889.0 km, 28.1 h
--   UsTexas                 131 routes,  1.6 stops, 729.6 km, 22.1 h
--
-- Only SanFrancisco is multi-stop route-planning shaped. The other two are
-- long-haul single legs and will read as near-perfect compliance against an
-- urban stop band, which is why STANDARDS is keyed BY REGION rather than being
-- one global row, and why the view's caveats say so out loud.
--
-- THREE MEASURED DATA TRAPS, each of which silently corrupts a number
--
--   1. VW_DIM_SITE IS NOT UNIQUE ON SITE_ID. 22,798 rows, 22,315 distinct
--      SITE_IDs: 483 ids appear in more than one region. Joining a leg to its
--      site on SITE_ID ALONE fans the leg set out - measured, the USA leg count
--      goes from 500 to 624, so every SUM over it (planned km, planned hours)
--      silently inflates by ~25% while the query still succeeds. Join on
--      SITE_ID *and* REGION, which IS unique (22,798 = 22,798).
--
--   2. SEQUENCE_NUM IS NOT UNIQUE WITHIN A ROUTE. 17 SanFrancisco vehicle-days
--      carry a duplicate sequence number. Deduping silently would drop real
--      planned work from the distance and hour totals, so the duplicate is
--      REMOVED from the measures (one leg per sequence position) AND reported
--      as SEQ_CONFLICTS / IS_SEQUENCE_BREACH. A plan whose stop order is
--      ambiguous is itself a standards failure - that is the honest reading,
--      and it is the one a planner can act on.
--
--   3. ONLY ~86% OF LEGS RESOLVE TO A SITE GEOMETRY (SanFrancisco: 14,222 of
--      16,535 destinations). The territory check is therefore computed over the
--      legs that DO resolve and publishes GEOCODED_STOPS beside STOPS, so a
--      route is never reported compliant merely because its stops could not be
--      located. A route with no geocoded stop at all gets a NULL territory
--      distance, and NULL is deliberately NOT treated as compliant.
--
-- PLANNER ATTRIBUTION
-- The source data has no planner column. Rather than invent a new synthetic
-- attribute, this layer reuses the dispatcher assignment the app ALREADY shows
-- on Asset Velocity - the same hash over the vehicle id that
-- FLEET_APP.ROUTE_OPTIMIZATION.VW_IDLE_TRAILERS.ASSIGNED_DISPATCHER uses.
-- Verified identical on 218 of 218 rows of that view, so a planner named here
-- is the same person named there and the two screens cannot disagree.
--
-- PLAN RELEASE TIME IS DERIVED, NOT INVENTED
-- There is no "plan published" timestamp anywhere in the source. Rather than
-- fabricate one, release time is FIRST_DEPARTURE_TS minus a configurable lead
-- time: the latest moment a plan could have been released and still have the
-- vehicle leave on time. That is a bound on the real release time, not a
-- measurement of it, and it is labelled as such everywhere it surfaces.
--
-- REGION SCOPING
-- Every view here carries REGION and REGION_LABEL through as ordinary
-- dimensions and filters on NOTHING. STANDARDS is keyed by region with a '*'
-- fallback row, so it is a parameter join and not a singleton pin - it has no
-- ability to make a region structurally invisible.
--
-- ENGINE DEPENDENCE
-- This file is ENGINE-FREE and must stay that way: it reads only the FLEET_APP
-- contract. The live optimizer comparison that prices the cost of a
-- non-standard plan lives in scripts/analytic_layer_live_routing.sql, because a
-- LANGUAGE SQL body calling OPENROUTESERVICE_APP.CORE.* resolves at CREATE time
-- and would abort this whole file on a --no-engine install.
-- =====================================================================

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-plan-standards","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE SCHEMA IF NOT EXISTS FLEET_APP.PLAN_STANDARDS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-plan-standards","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- ---------------------------------------------------------------------
-- 1. STANDARDS - the written planning standard, as data.
-- ---------------------------------------------------------------------
-- Keyed BY REGION with a '*' default row. This is deliberately NOT the
-- one-row-per-schema CONFIG shape: that shape holds a single REGION value and
-- consumers filter on it, which makes every other loaded region structurally
-- invisible while the view still returns rows. Here the region is a JOIN KEY
-- with a documented fallback, so an unseeded region gets the default standard
-- instead of getting erased.
--
-- Editable at runtime on purpose: a planning manager tightening the shift cap
-- is the whole point, and the app's sliders bind the same numbers per query so
-- a presenter can move a threshold and watch compliance move.
CREATE TABLE IF NOT EXISTS FLEET_APP.PLAN_STANDARDS.STANDARDS (
  REGION                        VARCHAR       NOT NULL,
  STANDARD_LABEL                VARCHAR,
  MIN_STOPS                     NUMBER,
  MAX_STOPS                     NUMBER,
  MAX_SHIFT_HOURS               FLOAT,
  MAX_KM_PER_STOP               FLOAT,
  MAX_TERRITORY_KM              FLOAT,
  WAREHOUSE_SESSION_START_HOUR  NUMBER,
  PLAN_LEAD_TIME_MINUTES        NUMBER,
  COST_PER_KM_USD               FLOAT,
  COST_PER_HOUR_USD             FLOAT
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-plan-standards","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- Idempotent seed. MERGE rather than INSERT so a re-run does not duplicate the
-- default row and does not clobber a threshold an operator has since tuned.
MERGE INTO FLEET_APP.PLAN_STANDARDS.STANDARDS t
USING (
  SELECT * FROM VALUES
    -- Fallback for any region not named below.
    ('*',                      'Default urban distribution standard',
      15, 40,  9.0, 8.0,  60.0, 5, 180, 1.10, 48.00),
    -- Urban multi-drop: the only region with genuinely route-shaped plans.
    ('SanFrancisco',           'Metro multi-drop standard',
      15, 40,  9.0, 8.0,  40.0, 5, 180, 1.10, 48.00),
    -- Long-haul: a stop band and a metro territory radius are meaningless here,
    -- so the bands are widened to the long-haul reality rather than left to
    -- report a fake breach on every route.
    ('UnitedStatesOfAmerica',  'Long-haul line-haul standard',
      1,  6,  32.0, 900.0, 4000.0, 4, 240, 1.45, 52.00),
    ('UsTexas',                'Regional line-haul standard',
      1,  6,  26.0, 700.0, 1200.0, 4, 240, 1.45, 52.00)
  AS s (REGION, STANDARD_LABEL, MIN_STOPS, MAX_STOPS, MAX_SHIFT_HOURS,
        MAX_KM_PER_STOP, MAX_TERRITORY_KM, WAREHOUSE_SESSION_START_HOUR,
        PLAN_LEAD_TIME_MINUTES, COST_PER_KM_USD, COST_PER_HOUR_USD)
) s
ON t.REGION = s.REGION
WHEN NOT MATCHED THEN INSERT
  (REGION, STANDARD_LABEL, MIN_STOPS, MAX_STOPS, MAX_SHIFT_HOURS, MAX_KM_PER_STOP,
   MAX_TERRITORY_KM, WAREHOUSE_SESSION_START_HOUR, PLAN_LEAD_TIME_MINUTES,
   COST_PER_KM_USD, COST_PER_HOUR_USD)
  VALUES (s.REGION, s.STANDARD_LABEL, s.MIN_STOPS, s.MAX_STOPS, s.MAX_SHIFT_HOURS,
          s.MAX_KM_PER_STOP, s.MAX_TERRITORY_KM, s.WAREHOUSE_SESSION_START_HOUR,
          s.PLAN_LEAD_TIME_MINUTES, s.COST_PER_KM_USD, s.COST_PER_HOUR_USD);

-- Resolved standard per region: the region's own row where it has one, the '*'
-- row otherwise. Exposed as a view so consumers never reimplement the fallback.
CREATE OR REPLACE VIEW FLEET_APP.PLAN_STANDARDS.VW_STANDARDS_CONFIG
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-plan-standards","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
  AS
SELECT
  r.REGION,
  FLEET_APP.CORE.REGION_LABEL(r.REGION)                          AS REGION_LABEL,
  COALESCE(o.STANDARD_LABEL, d.STANDARD_LABEL)                   AS STANDARD_LABEL,
  COALESCE(o.MIN_STOPS, d.MIN_STOPS)                             AS MIN_STOPS,
  COALESCE(o.MAX_STOPS, d.MAX_STOPS)                             AS MAX_STOPS,
  COALESCE(o.MAX_SHIFT_HOURS, d.MAX_SHIFT_HOURS)                 AS MAX_SHIFT_HOURS,
  COALESCE(o.MAX_KM_PER_STOP, d.MAX_KM_PER_STOP)                 AS MAX_KM_PER_STOP,
  COALESCE(o.MAX_TERRITORY_KM, d.MAX_TERRITORY_KM)               AS MAX_TERRITORY_KM,
  COALESCE(o.WAREHOUSE_SESSION_START_HOUR, d.WAREHOUSE_SESSION_START_HOUR)
                                                                 AS WAREHOUSE_SESSION_START_HOUR,
  COALESCE(o.PLAN_LEAD_TIME_MINUTES, d.PLAN_LEAD_TIME_MINUTES)   AS PLAN_LEAD_TIME_MINUTES,
  COALESCE(o.COST_PER_KM_USD, d.COST_PER_KM_USD)                 AS COST_PER_KM_USD,
  COALESCE(o.COST_PER_HOUR_USD, d.COST_PER_HOUR_USD)             AS COST_PER_HOUR_USD,
  (o.REGION IS NOT NULL)                                         AS IS_REGION_SPECIFIC
FROM (SELECT DISTINCT REGION FROM FLEET_APP.CORE.VW_DIM_PLAN) r
LEFT JOIN FLEET_APP.PLAN_STANDARDS.STANDARDS o ON o.REGION = r.REGION
CROSS JOIN (SELECT * FROM FLEET_APP.PLAN_STANDARDS.STANDARDS WHERE REGION = '*') d;

-- ---------------------------------------------------------------------
-- 2. VW_ROUTE_STOPS - the ordered stop list of every planned route.
-- ---------------------------------------------------------------------
-- Feeds the map, the drill-down table, and the live optimizer re-solve (which
-- needs the stop COORDINATES, so this is the only place they are resolved).
--
-- The site join carries REGION as well as SITE_ID. Trap 1 above: SITE_ID alone
-- is not unique across regions and fanned the USA leg count from 500 to 624.
CREATE OR REPLACE VIEW FLEET_APP.PLAN_STANDARDS.VW_ROUTE_STOPS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-plan-standards","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
  AS
WITH sites AS (
  -- Collapse to one row per (SITE_ID, REGION), which IS the unique key.
  SELECT SITE_ID, REGION,
         ANY_VALUE(SITE_LABEL) AS SITE_LABEL,
         ANY_VALUE(SITE_TYPE)  AS SITE_TYPE,
         ANY_VALUE(SITE_GEOG)  AS SITE_GEOG
  FROM FLEET_APP.CORE.VW_DIM_SITE
  GROUP BY SITE_ID, REGION
),
legs AS (
  -- One leg per sequence position. Trap 2: a duplicate SEQUENCE_NUM makes the
  -- stop order ambiguous, so the extra leg is excluded from the measures and
  -- counted as a breach in VW_ROUTE_PLAN instead of being silently absorbed.
  SELECT p.REGION, p.ENTITY_ID, p.PLAN_DATE, p.PLAN_ID, p.SEQUENCE_NUM,
         p.OPERATOR_ID, p.ORIGIN_SITE_ID, p.DESTINATION_SITE_ID,
         p.PLANNED_START_TS, p.PLANNED_END_TS,
         p.PLANNED_DISTANCE_VALUE, p.PLANNED_DURATION_SEC
  FROM FLEET_APP.CORE.VW_DIM_PLAN p
  QUALIFY ROW_NUMBER() OVER (
            PARTITION BY p.REGION, p.ENTITY_ID, p.PLAN_DATE, p.SEQUENCE_NUM
            ORDER BY p.PLANNED_START_TS NULLS LAST, p.PLAN_ID) = 1
)
SELECT
  l.REGION,
  FLEET_APP.CORE.REGION_LABEL(l.REGION)                             AS REGION_LABEL,
  l.ENTITY_ID                                                       AS VEHICLE_ID,
  l.PLAN_DATE,
  'DISP-' || LPAD(MOD(ABS(HASH(l.ENTITY_ID)), 12) + 1, 2, '0')      AS PLANNER_ID,
  l.PLAN_ID,
  l.SEQUENCE_NUM                                                    AS STOP_SEQ,
  l.OPERATOR_ID,
  l.DESTINATION_SITE_ID                                             AS SITE_ID,
  ds.SITE_LABEL,
  ds.SITE_TYPE,
  ds.SITE_GEOG,
  ST_X(ds.SITE_GEOG)                                                AS STOP_LNG,
  ST_Y(ds.SITE_GEOG)                                                AS STOP_LAT,
  l.PLANNED_START_TS,
  l.PLANNED_END_TS,
  ROUND(l.PLANNED_DISTANCE_VALUE, 2)                                AS LEG_KM,
  ROUND(l.PLANNED_DURATION_SEC / 60.0, 2)                           AS LEG_MINUTES
FROM legs l
LEFT JOIN sites ds
  ON ds.SITE_ID = l.DESTINATION_SITE_ID AND ds.REGION = l.REGION;

-- ---------------------------------------------------------------------
-- 3. VW_ROUTE_PLAN - one row per planned route, scored against the standard.
-- ---------------------------------------------------------------------
-- The five standards are independent booleans rather than one blended score, so
-- a planner is told WHICH rule they broke. A blended number cannot be actioned.
--
-- Every IS_*_BREACH is written so that a NULL measure is NOT a pass: a route
-- whose stops could not be geocoded must not be reported as respecting a
-- territory limit nobody could evaluate.
CREATE OR REPLACE VIEW FLEET_APP.PLAN_STANDARDS.VW_ROUTE_PLAN
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-plan-standards","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
  AS
WITH raw_legs AS (
  SELECT REGION, ENTITY_ID, PLAN_DATE, SEQUENCE_NUM
  FROM FLEET_APP.CORE.VW_DIM_PLAN
),
seq_health AS (
  -- Counted on the RAW legs, before the dedupe in VW_ROUTE_STOPS removes them.
  SELECT REGION, ENTITY_ID, PLAN_DATE,
         COUNT(*) - COUNT(DISTINCT SEQUENCE_NUM) AS SEQ_CONFLICTS
  FROM raw_legs
  GROUP BY REGION, ENTITY_ID, PLAN_DATE
),
depots AS (
  SELECT f.VEHICLE_ID, f.REGION, f.HOME_LOCATION_ID,
         ANY_VALUE(s.SITE_LABEL) AS DEPOT_NAME,
         ANY_VALUE(s.SITE_GEOG)  AS DEPOT_GEOG
  FROM FLEET_APP.ROUTE_OPTIMIZATION.VW_FLEET_CURRENT f
  LEFT JOIN FLEET_APP.CORE.VW_DIM_SITE s
    ON s.SITE_ID = f.HOME_LOCATION_ID AND s.REGION = f.REGION
  GROUP BY f.VEHICLE_ID, f.REGION, f.HOME_LOCATION_ID
),
agg AS (
  SELECT
    st.REGION, st.REGION_LABEL, st.VEHICLE_ID, st.PLAN_DATE, st.PLANNER_ID,
    COUNT(*)                                            AS STOPS,
    COUNT(st.SITE_GEOG)                                 AS GEOCODED_STOPS,
    COUNT(DISTINCT st.SITE_ID)                           AS UNIQUE_SITES,
    ROUND(SUM(st.LEG_KM), 2)                            AS PLAN_KM,
    ROUND(SUM(st.LEG_MINUTES) / 60.0, 2)                AS PLAN_HOURS,
    MIN(st.PLANNED_START_TS)                            AS FIRST_DEPARTURE_TS,
    MAX(st.PLANNED_END_TS)                              AS LAST_ARRIVAL_TS,
    ST_COLLECT(st.SITE_GEOG)                            AS STOPS_GEOM,
    ANY_VALUE(st.OPERATOR_ID)                           AS OPERATOR_ID
  FROM FLEET_APP.PLAN_STANDARDS.VW_ROUTE_STOPS st
  GROUP BY st.REGION, st.REGION_LABEL, st.VEHICLE_ID, st.PLAN_DATE, st.PLANNER_ID
),
spread AS (
  -- Territory reach: the furthest planned stop from the vehicle's own depot.
  -- Computed only over geocoded stops; a route with none yields NULL, which the
  -- breach expression below refuses to read as compliant.
  SELECT st.REGION, st.VEHICLE_ID, st.PLAN_DATE,
         ROUND(MAX(ST_DISTANCE(st.SITE_GEOG, d.DEPOT_GEOG)) / 1000.0, 2)
           AS MAX_STOP_FROM_DEPOT_KM
  FROM FLEET_APP.PLAN_STANDARDS.VW_ROUTE_STOPS st
  JOIN depots d ON d.VEHICLE_ID = st.VEHICLE_ID AND d.REGION = st.REGION
  WHERE st.SITE_GEOG IS NOT NULL AND d.DEPOT_GEOG IS NOT NULL
  GROUP BY st.REGION, st.VEHICLE_ID, st.PLAN_DATE
),
scored AS (
  SELECT
    a.REGION, a.REGION_LABEL, a.VEHICLE_ID, a.PLAN_DATE, a.PLANNER_ID,
    'Planner ' || SUBSTR(a.PLANNER_ID, 6, 2)            AS PLANNER_LABEL,
    a.OPERATOR_ID,
    d.HOME_LOCATION_ID                                  AS DEPOT_ID,
    d.DEPOT_NAME,
    ST_X(d.DEPOT_GEOG)                                  AS DEPOT_LNG,
    ST_Y(d.DEPOT_GEOG)                                  AS DEPOT_LAT,
    a.STOPS, a.GEOCODED_STOPS, a.UNIQUE_SITES,
    a.PLAN_KM, a.PLAN_HOURS,
    ROUND(DIV0(a.PLAN_KM, a.STOPS), 2)                  AS KM_PER_STOP,
    ROUND(DIV0(a.PLAN_HOURS * 60.0, a.STOPS), 2)        AS MINUTES_PER_STOP,
    a.FIRST_DEPARTURE_TS, a.LAST_ARRIVAL_TS,
    -- SERVICE_DATE is the day the vehicle actually rolls, derived from the first
    -- planned departure - NOT from PLAN_DATE. MEASURED: on SanFrancisco,
    -- PLAN_DATE sits 40 to 41 days BEFORE PLANNED_START_TS, while on
    -- UnitedStatesOfAmerica and UsTexas the offset is exactly 0. PLAN_DATE is
    -- the source's planning-cycle key and is a sound route GRAIN (each route has
    -- exactly one, and 98 SanFrancisco routes legitimately straddle midnight),
    -- but it is NOT the operational day. A warehouse session clock anchored on it
    -- reported every SanFrancisco depot BLOCKED by an average of 57,917 minutes,
    -- which is the 40-day offset and not a planning failure.
    DATE(a.FIRST_DEPARTURE_TS)                          AS SERVICE_DATE,
    a.STOPS_GEOM,
    ST_CENTROID(a.STOPS_GEOM)                           AS ROUTE_CENTROID,
    sp.MAX_STOP_FROM_DEPOT_KM,
    COALESCE(sh.SEQ_CONFLICTS, 0)                       AS SEQ_CONFLICTS,
    -- Latest release that still gets the vehicle out on time. A BOUND on the
    -- real release moment, which the source does not record.
    DATEADD('minute', -1 * c.PLAN_LEAD_TIME_MINUTES, a.FIRST_DEPARTURE_TS)
                                                        AS PLAN_RELEASE_TS,
    DATEADD('hour', c.WAREHOUSE_SESSION_START_HOUR,
            DATE(a.FIRST_DEPARTURE_TS)::TIMESTAMP_NTZ)
                                                        AS SESSION_START_TS,
    c.STANDARD_LABEL, c.MIN_STOPS, c.MAX_STOPS, c.MAX_SHIFT_HOURS,
    c.MAX_KM_PER_STOP, c.MAX_TERRITORY_KM,
    c.WAREHOUSE_SESSION_START_HOUR, c.PLAN_LEAD_TIME_MINUTES,
    c.COST_PER_KM_USD, c.COST_PER_HOUR_USD
  FROM agg a
  LEFT JOIN spread sp
    ON sp.REGION = a.REGION AND sp.VEHICLE_ID = a.VEHICLE_ID AND sp.PLAN_DATE = a.PLAN_DATE
  LEFT JOIN seq_health sh
    ON sh.REGION = a.REGION AND sh.ENTITY_ID = a.VEHICLE_ID AND sh.PLAN_DATE = a.PLAN_DATE
  LEFT JOIN depots d
    ON d.VEHICLE_ID = a.VEHICLE_ID AND d.REGION = a.REGION
  JOIN FLEET_APP.PLAN_STANDARDS.VW_STANDARDS_CONFIG c ON c.REGION = a.REGION
)
SELECT
  s.*,
  (s.STOPS < s.MIN_STOPS OR s.STOPS > s.MAX_STOPS)          AS IS_STOP_BAND_BREACH,
  (s.PLAN_HOURS > s.MAX_SHIFT_HOURS)                        AS IS_SHIFT_BREACH,
  (s.KM_PER_STOP > s.MAX_KM_PER_STOP)                       AS IS_DENSITY_BREACH,
  -- NOT NULL-tolerant on purpose: an unmeasurable territory is not a pass.
  (s.MAX_STOP_FROM_DEPOT_KM IS NULL
     OR s.MAX_STOP_FROM_DEPOT_KM > s.MAX_TERRITORY_KM)      AS IS_TERRITORY_BREACH,
  (s.SEQ_CONFLICTS > 0)                                     AS IS_SEQUENCE_BREACH,
  (CASE WHEN s.STOPS < s.MIN_STOPS OR s.STOPS > s.MAX_STOPS THEN 1 ELSE 0 END
   + CASE WHEN s.PLAN_HOURS > s.MAX_SHIFT_HOURS THEN 1 ELSE 0 END
   + CASE WHEN s.KM_PER_STOP > s.MAX_KM_PER_STOP THEN 1 ELSE 0 END
   + CASE WHEN s.MAX_STOP_FROM_DEPOT_KM IS NULL
               OR s.MAX_STOP_FROM_DEPOT_KM > s.MAX_TERRITORY_KM THEN 1 ELSE 0 END
   + CASE WHEN s.SEQ_CONFLICTS > 0 THEN 1 ELSE 0 END)       AS BREACH_COUNT,
  ROUND(100.0 * (5
   - (CASE WHEN s.STOPS < s.MIN_STOPS OR s.STOPS > s.MAX_STOPS THEN 1 ELSE 0 END
      + CASE WHEN s.PLAN_HOURS > s.MAX_SHIFT_HOURS THEN 1 ELSE 0 END
      + CASE WHEN s.KM_PER_STOP > s.MAX_KM_PER_STOP THEN 1 ELSE 0 END
      + CASE WHEN s.MAX_STOP_FROM_DEPOT_KM IS NULL
                  OR s.MAX_STOP_FROM_DEPOT_KM > s.MAX_TERRITORY_KM THEN 1 ELSE 0 END
      + CASE WHEN s.SEQ_CONFLICTS > 0 THEN 1 ELSE 0 END)) / 5.0, 2)
                                                            AS COMPLIANCE_SCORE,
  -- Minutes the plan was released AFTER the warehouse wanted to start building
  -- sessions. GREATEST(0, ...) because an early release is not negative lateness.
  GREATEST(0, DATEDIFF('minute', s.SESSION_START_TS, s.PLAN_RELEASE_TS))
                                                            AS RELEASE_MINUTES_LATE,
  (s.PLAN_RELEASE_TS > s.SESSION_START_TS)                  AS IS_RELEASE_LATE
FROM scored s;

-- ---------------------------------------------------------------------
-- 4. VW_PLANNER_SCORECARD - the league table.
-- ---------------------------------------------------------------------
-- Two different things are measured, and conflating them is the mistake this
-- view exists to avoid. COMPLIANCE_PCT is "does this planner follow the
-- standard". SD_KM_PER_STOP is "does this planner plan the same way twice" -
-- the actual complaint when 45 planners each have their own method. A planner
-- can score well on the first and badly on the second, and that planner is the
-- one whose routes nobody else can pick up.
CREATE OR REPLACE VIEW FLEET_APP.PLAN_STANDARDS.VW_PLANNER_SCORECARD
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-plan-standards","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
  AS
SELECT
  REGION,
  REGION_LABEL,
  PLANNER_ID,
  PLANNER_LABEL,
  COUNT(*)                                              AS ROUTES,
  COUNT(DISTINCT VEHICLE_ID)                            AS VEHICLES,
  COUNT(DISTINCT PLAN_DATE)                             AS PLAN_DAYS,
  ROUND(AVG(STOPS), 2)                                  AS AVG_STOPS,
  ROUND(AVG(PLAN_KM), 2)                                AS AVG_PLAN_KM,
  ROUND(AVG(PLAN_HOURS), 2)                             AS AVG_PLAN_HOURS,
  ROUND(AVG(KM_PER_STOP), 2)                            AS AVG_KM_PER_STOP,
  -- The consistency measure. A planner with a high mean is expensive; a planner
  -- with a high SD is unpredictable, which is the harder problem to manage.
  ROUND(STDDEV(KM_PER_STOP), 2)                         AS SD_KM_PER_STOP,
  ROUND(100.0 * DIV0(COUNT_IF(BREACH_COUNT = 0), COUNT(*)), 2)
                                                        AS COMPLIANCE_PCT,
  ROUND(AVG(COMPLIANCE_SCORE), 2)                       AS AVG_COMPLIANCE_SCORE,
  COUNT_IF(IS_STOP_BAND_BREACH)                         AS STOP_BAND_BREACHES,
  COUNT_IF(IS_SHIFT_BREACH)                             AS SHIFT_BREACHES,
  COUNT_IF(IS_DENSITY_BREACH)                           AS DENSITY_BREACHES,
  COUNT_IF(IS_TERRITORY_BREACH)                         AS TERRITORY_BREACHES,
  COUNT_IF(IS_SEQUENCE_BREACH)                          AS SEQUENCE_BREACHES,
  COUNT_IF(IS_RELEASE_LATE)                             AS LATE_RELEASES,
  ROUND(AVG(RELEASE_MINUTES_LATE), 2)                   AS AVG_RELEASE_MINUTES_LATE,
  -- Excess km against the BEST planner in the same region, priced. This is a
  -- peer benchmark, not an optimizer result: it says "this planner's routes cost
  -- more per stop than a colleague's on the same road network", which needs no
  -- engine call. The optimizer comparison is the separate, honest road-distance
  -- number produced by F_ROUTE_RESOLVE_GAP on one selected route.
  -- BEST_KM_PER_STOP is already constant within a region (it is a window MIN
  -- over the per-planner rates), so ANY_VALUE is the correct reducer here. A
  -- nested aggregate-over-window would not compile.
  --
  -- Both sides are RATIO-OF-SUMS. The first version compared this planner's
  -- ratio-of-sums against the best planner's MEAN-OF-RATIOS, which are not the
  -- same statistic on unequal route sizes: it returned -60.15 excess km for the
  -- planner who WAS the regional best, i.e. a planner beating a benchmark that
  -- was supposed to be their own performance.
  ROUND(SUM(PLAN_KM) - SUM(STOPS) * ANY_VALUE(BEST_KM_PER_STOP), 2)
                                                        AS EXCESS_KM_VS_BEST_PEER
FROM (
  SELECT r.*,
         MIN(r.PEER_KM_PER_STOP) OVER (PARTITION BY r.REGION) AS BEST_KM_PER_STOP
  FROM (
    SELECT p.*,
           DIV0(SUM(p.PLAN_KM) OVER (PARTITION BY p.REGION, p.PLANNER_ID),
                SUM(p.STOPS)   OVER (PARTITION BY p.REGION, p.PLANNER_ID))
             AS PEER_KM_PER_STOP
    FROM FLEET_APP.PLAN_STANDARDS.VW_ROUTE_PLAN p
  ) r
) z
GROUP BY REGION, REGION_LABEL, PLANNER_ID, PLANNER_LABEL;

-- ---------------------------------------------------------------------
-- 5. VW_WAREHOUSE_READINESS - when can the warehouse start building?
-- ---------------------------------------------------------------------
-- The warehouse cannot start picking a depot's sessions until the LAST route
-- for that depot is released, so the blocking metric is the MAX release time
-- per depot-day, not the average. Reporting the average here would make a depot
-- held up by one late plan look ready.
--
-- Keyed on SERVICE_DATE (the day the vehicles roll), NOT PLAN_DATE. On
-- SanFrancisco those differ by 40 days, and PLAN_DATE made every depot look
-- blocked by six weeks.
CREATE OR REPLACE VIEW FLEET_APP.PLAN_STANDARDS.VW_WAREHOUSE_READINESS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-plan-standards","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
  AS
SELECT
  REGION,
  REGION_LABEL,
  SERVICE_DATE,
  DEPOT_ID,
  COALESCE(DEPOT_NAME, 'Depot ' || DEPOT_ID)            AS DEPOT_NAME,
  ANY_VALUE(DEPOT_LNG)                                  AS DEPOT_LNG,
  ANY_VALUE(DEPOT_LAT)                                  AS DEPOT_LAT,
  COUNT(*)                                              AS ROUTES,
  COUNT(DISTINCT PLANNER_ID)                            AS PLANNERS,
  SUM(STOPS)                                            AS STOPS,
  MIN(PLAN_RELEASE_TS)                                  AS FIRST_RELEASE_TS,
  -- The blocking moment: nothing can be built until the last plan lands.
  MAX(PLAN_RELEASE_TS)                                  AS LAST_RELEASE_TS,
  ANY_VALUE(SESSION_START_TS)                           AS SESSION_START_TS,
  -- SIGNED on purpose: negative means the last plan was released BEFORE the
  -- warehouse wanted to start building, which is the good case and is worth
  -- seeing as a magnitude. READINESS_STATUS carries the verdict, and
  -- VW_ROUTE_PLAN.RELEASE_MINUTES_LATE is the clamped-at-zero form.
  ROUND(DATEDIFF('minute', ANY_VALUE(SESSION_START_TS), MAX(PLAN_RELEASE_TS)), 2)
                                                        AS BUILD_START_DELAY_MIN,
  COUNT_IF(IS_RELEASE_LATE)                             AS LATE_ROUTES,
  ROUND(100.0 * DIV0(COUNT_IF(IS_RELEASE_LATE), COUNT(*)), 2)
                                                        AS LATE_ROUTE_PCT,
  CASE
    WHEN MAX(PLAN_RELEASE_TS) <= ANY_VALUE(SESSION_START_TS)            THEN 'ON_TIME'
    WHEN DATEDIFF('minute', ANY_VALUE(SESSION_START_TS),
                  MAX(PLAN_RELEASE_TS)) <= 60                            THEN 'AT_RISK'
    ELSE 'BLOCKED'
  END                                                   AS READINESS_STATUS
FROM FLEET_APP.PLAN_STANDARDS.VW_ROUTE_PLAN
WHERE DEPOT_ID IS NOT NULL
GROUP BY REGION, REGION_LABEL, SERVICE_DATE, DEPOT_ID, DEPOT_NAME;

-- ---------------------------------------------------------------------
-- 6. Grants (mirrors the DELIVERY_SYNC / SOURCING / LOCATION seams)
-- ---------------------------------------------------------------------
GRANT USAGE ON SCHEMA FLEET_APP.PLAN_STANDARDS TO ROLE FLEET_APP_USER;
GRANT SELECT ON ALL VIEWS IN SCHEMA FLEET_APP.PLAN_STANDARDS TO ROLE FLEET_APP_USER;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA FLEET_APP.PLAN_STANDARDS TO ROLE FLEET_APP_USER;
GRANT SELECT ON ALL TABLES IN SCHEMA FLEET_APP.PLAN_STANDARDS TO ROLE FLEET_APP_USER;
GRANT SELECT ON FUTURE TABLES IN SCHEMA FLEET_APP.PLAN_STANDARDS TO ROLE FLEET_APP_USER;
GRANT USAGE ON ALL FUNCTIONS IN SCHEMA FLEET_APP.PLAN_STANDARDS TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUTURE FUNCTIONS IN SCHEMA FLEET_APP.PLAN_STANDARDS TO ROLE FLEET_APP_USER;

GRANT USAGE ON SCHEMA FLEET_APP.PLAN_STANDARDS TO ROLE FLEET_APP_OPS;
GRANT SELECT ON ALL VIEWS IN SCHEMA FLEET_APP.PLAN_STANDARDS TO ROLE FLEET_APP_OPS;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA FLEET_APP.PLAN_STANDARDS TO ROLE FLEET_APP_OPS;
GRANT SELECT ON ALL TABLES IN SCHEMA FLEET_APP.PLAN_STANDARDS TO ROLE FLEET_APP_OPS;
GRANT SELECT ON FUTURE TABLES IN SCHEMA FLEET_APP.PLAN_STANDARDS TO ROLE FLEET_APP_OPS;
GRANT USAGE ON ALL FUNCTIONS IN SCHEMA FLEET_APP.PLAN_STANDARDS TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUTURE FUNCTIONS IN SCHEMA FLEET_APP.PLAN_STANDARDS TO ROLE FLEET_APP_OPS;

GRANT USAGE ON SCHEMA FLEET_APP.PLAN_STANDARDS TO ROLE FLEET_APP_ADMIN;
GRANT SELECT ON ALL VIEWS IN SCHEMA FLEET_APP.PLAN_STANDARDS TO ROLE FLEET_APP_ADMIN;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA FLEET_APP.PLAN_STANDARDS TO ROLE FLEET_APP_ADMIN;
GRANT SELECT ON ALL TABLES IN SCHEMA FLEET_APP.PLAN_STANDARDS TO ROLE FLEET_APP_ADMIN;
GRANT SELECT ON FUTURE TABLES IN SCHEMA FLEET_APP.PLAN_STANDARDS TO ROLE FLEET_APP_ADMIN;
-- The standard itself is editable by ADMIN only: a threshold change re-scores
-- every planner, so it is a governed act rather than a user preference.
GRANT INSERT, UPDATE, DELETE ON FLEET_APP.PLAN_STANDARDS.STANDARDS TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON ALL FUNCTIONS IN SCHEMA FLEET_APP.PLAN_STANDARDS TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUTURE FUNCTIONS IN SCHEMA FLEET_APP.PLAN_STANDARDS TO ROLE FLEET_APP_ADMIN;

-- ---------------------------------------------------------------------
-- 7. Validation - report the shape rather than assert one region's numbers.
-- ---------------------------------------------------------------------
SELECT 'PLAN_STANDARDS' AS LAYER,
       REGION,
       COUNT(*)                                  AS ROUTES,
       SUM(STOPS)                                AS STOPS,
       ROUND(AVG(COMPLIANCE_SCORE), 2)           AS AVG_COMPLIANCE,
       COUNT_IF(IS_SEQUENCE_BREACH)              AS SEQ_CONFLICT_ROUTES,
       COUNT_IF(GEOCODED_STOPS = 0)              AS ROUTES_WITH_NO_GEOCODED_STOP
FROM FLEET_APP.PLAN_STANDARDS.VW_ROUTE_PLAN
GROUP BY REGION
ORDER BY REGION;
