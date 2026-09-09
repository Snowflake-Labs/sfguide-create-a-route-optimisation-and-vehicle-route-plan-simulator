-- ============================================================================
-- FLEET_APP.LABOR - neutral labour and overtime contract
-- ============================================================================
-- Answers "who is approaching an overtime threshold, and what will it cost" from
-- the trip record alone. No timekeeping system is required: paid time is derived
-- from when work actually happened.
--
-- WHY THIS IS DERIVED FROM TRIPS AND NOT FROM A CLOCK FEED
-- There is no driver entity in this stack beyond a DRIVER_ID string - no
-- contracted hours, no pay rate, no team, no supervisor, and no punch records.
-- What DOES exist is an exact record of every trip a driver executed. So paid
-- time is reconstructed from trip execution, and the commercial attributes that
-- turn hours into money are synthesized deterministically (see
-- F_DIM_LABOR_OPERATOR_SCOPED). When a real feed lands, only that one function
-- changes; everything above it is untouched.
--
-- THREE DESIGN DECISIONS THAT ARE LOAD-BEARING
--
-- 1. DUTY PERIODS ARE SESSIONIZED BY GAP, NOT BY CALENDAR DAY.
--    Grouping trips by TRIP_START::DATE is wrong for any shift that crosses
--    midnight: the shift is split at 00:00 and the two halves are then re-merged
--    into whichever calendar date each trip started in. Measured on the
--    SanFrancisco e-bike dataset that put 146 of 633 driver-days over 14 hours,
--    with a maximum span of 24.6 hours - a night-shift artifact, not real work.
--    Sessionizing on a gap threshold instead produced average duty lengths of
--    5.48h / 12.50h / 6.41h against declared shift windows of 10-15, 10-23 and
--    17-23, and dropped 14h+ days to 12.
--
--    The threshold is not a tuned magic number. The measured gap distribution is
--    strongly bimodal: over 16,435 intervals the p90 gap is 0 minutes, there are
--    ZERO gaps between 1h and 8h, and 479 gaps exceed 10h. Any threshold from
--    roughly 2h to 8h produces an identical answer. The same holds for trucks by
--    construction, since an HGV mid-shift break is 45 minutes and overnight rest
--    is 10-11 hours - both far outside the dead zone. Default 240 minutes.
--
-- 2. WEEK ALLOCATION USES THE PERIOD DATA TYPE, BECAUSE CLAMPING LOSES HOURS.
--    Overtime thresholds are weekly, so a duty period that straddles a week
--    boundary must contribute to BOTH weeks. Measured: 28 of 583 duty periods
--    straddle. Clamping each duty period into the week it STARTED in silently
--    dropped 157.7 hours (4753.5 -> 4595.8, 3.3%). Since the whole point of this
--    layer is a threshold alarm, misplaced boundary hours change who gets
--    flagged.
--
--    PERIOD_INTERSECT against a week period splits them exactly, and the result
--    is verifiable: total hours after the split equals total hours before it.
--    That equality is asserted by scripts/verify_labor_layer.sql and is the test
--    that would have caught the 157.7h drop.
--
--    A duty period spans at most one week boundary (it is bounded by the gap
--    threshold, so it cannot approach 7 days), which is why the split below
--    emits at most two rows per duty period rather than cross-joining to a
--    generated week table. INVARIANT: if DUTY_GAP_MINUTES were ever configured
--    large enough to let a duty period span a full week, intermediate weeks
--    would be missed. verify_labor_layer.sql asserts no duty period exceeds 24h.
--
-- 3. NOTHING BRANCHES ON VEHICLE TYPE OR ON A SHIFT LABEL.
--    SHIFT_TYPE is carried as an opaque dimension and never parsed. Three
--    mutually incompatible shift vocabularies already exist in this repo
--    ('10-15'/'10-23'/'17-23' for e-bike, 'Day'/'Night' for HGV, and
--    '6-14'/'14-22'/'22-6' in the contract's own SHIFT_LABEL mapping), so any
--    code that reads meaning out of the string is wrong for two of the three.
--    Overtime thresholds are configuration, not literals, because 40/50/60 is
--    US FLSA and the EU uses a 48-hour average.
--
-- Region scoping: every function carries REGION and REGION_LABEL as ordinary
-- dimensions and filters only on its scope ARGS. No function reads a singleton
-- CONFIG row (see check_region_scoping.py).
--
-- Engine-free: contains no call to OPENROUTESERVICE_APP or ROUTING_PLATFORM, so
-- it installs and returns correct results under --no-engine.
-- ============================================================================

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-labor-overtime","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE SCHEMA IF NOT EXISTS FLEET_APP.LABOR
  COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-labor-overtime","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"neutral-data-contract"}}';

-- ---------------------------------------------------------------------------
-- LABOR_CONFIG - the policy surface.
--
-- Keyed (REGION, VEHICLE_TYPE) with '*' as a wildcard, so an account can hold a
-- global default plus per-region overrides. The most specific matching row wins.
-- Every consumer resolves through COALESCE against a hardcoded fallback, so an
-- empty table degrades to sane US defaults rather than to NULL arithmetic.
--
-- WEEK_START_DOW is an ISO day number (1 = Monday ... 7 = Sunday) and is applied
-- arithmetically rather than via DATE_TRUNC('week'), because DATE_TRUNC's week
-- boundary depends on the session WEEK_START parameter - which would make the
-- same query return different overtime bands for two users.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FLEET_APP.LABOR.LABOR_CONFIG (
  REGION                    VARCHAR,
  VEHICLE_TYPE              VARCHAR,
  DUTY_GAP_MINUTES          NUMBER,
  OT_THRESHOLD_1            FLOAT,
  OT_THRESHOLD_2            FLOAT,
  OT_THRESHOLD_3            FLOAT,
  OT_MULTIPLIER             FLOAT,
  WEEK_START_DOW            NUMBER,
  CONTRACTED_HOURS_PER_WEEK FLOAT,
  HOURLY_RATE_MIN           FLOAT,
  HOURLY_RATE_MAX           FLOAT,
  TEAM_COUNT                NUMBER,
  CURRENCY_CODE             VARCHAR
)
COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-labor-overtime","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- Idempotent seed of the global default row only. Per-region overrides are
-- operator-owned and are never touched by a redeploy.
DELETE FROM FLEET_APP.LABOR.LABOR_CONFIG WHERE REGION = '*' AND VEHICLE_TYPE = '*';
INSERT INTO FLEET_APP.LABOR.LABOR_CONFIG
  (REGION, VEHICLE_TYPE, DUTY_GAP_MINUTES, OT_THRESHOLD_1, OT_THRESHOLD_2, OT_THRESHOLD_3,
   OT_MULTIPLIER, WEEK_START_DOW, CONTRACTED_HOURS_PER_WEEK, HOURLY_RATE_MIN, HOURLY_RATE_MAX,
   TEAM_COUNT, CURRENCY_CODE)
VALUES
  ('*', '*', 240, 40, 50, 60, 1.5, 7, 40, 22.0, 34.0, 8, 'USD');

-- ---------------------------------------------------------------------------
-- F_DIM_LABOR_OPERATOR_SCOPED - the driver, with the commercial attributes the
-- fleet model does not carry.
--
-- THIS IS THE SEAM. Contracted hours, hourly rate, team and supervisor do not
-- exist anywhere in the generated data, so they are synthesized here from a
-- stable HASH of the driver id: reproducible across re-runs, no generator
-- change, and no new table to keep in sync. Replace the body of this ONE
-- function with a join to a real HR or timekeeping feed and every view, semantic
-- view and alert above it keeps working unchanged.
--
-- TEAM_ID is derived from the driver's HOME_LOCATION_ID (their depot) rather
-- than from the driver id, so a team is a place and the team rollup answers
-- "which depot is generating the overtime". It is hashed into TEAM_COUNT buckets
-- because home locations are not depots in every preset - the e-bike fleet homes
-- 100 vehicles on 100 restaurants, which would otherwise yield 100 teams of one.
--
-- Shift resolution copies the defensive ROW_NUMBER() ... RN = 1 pattern used by
-- the other operator views: DIM_FLEET has no DRIVER_ID, so driver-to-shift is
-- always a two-hop join through the vehicle.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION FLEET_APP.LABOR.F_DIM_LABOR_OPERATOR_SCOPED(P_REGION VARCHAR, P_DATASET_ID VARCHAR)
RETURNS TABLE (
  OPERATOR_ID VARCHAR, OPERATOR_LABEL VARCHAR, SHIFT_TYPE VARCHAR, DRIVER_PROFILE VARCHAR,
  HOME_SITE_ID VARCHAR, TEAM_ID VARCHAR, SUPERVISOR_ID VARCHAR,
  CONTRACTED_HOURS_PER_WEEK FLOAT, HOURLY_RATE FLOAT, OT_MULTIPLIER FLOAT, CURRENCY_CODE VARCHAR,
  REGION VARCHAR, REGION_LABEL VARCHAR, VEHICLE_TYPE VARCHAR
)
COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-labor-overtime","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH trips AS (
    SELECT DRIVER_ID, VEHICLE_ID, REGION, VEHICLE_TYPE
    FROM TABLE(FLEET_APP.UNIFIED_FLEET.F_VW_FACT_TRIPS_SCOPED(P_REGION, P_DATASET_ID))
  ),
  fleet AS (
    SELECT VEHICLE_ID, SHIFT_TYPE, DRIVER_PROFILE, HOME_LOCATION_ID,
           ROW_NUMBER() OVER (PARTITION BY VEHICLE_ID ORDER BY SHIFT_TYPE) AS RN
    FROM TABLE(FLEET_APP.UNIFIED_FLEET.F_VW_DIM_FLEET_SCOPED(P_REGION, P_DATASET_ID))
  ),
  scope AS (
    SELECT ANY_VALUE(REGION) AS RG, ANY_VALUE(VEHICLE_TYPE) AS VT FROM trips
  ),
  cfg AS (
    SELECT c.CONTRACTED_HOURS_PER_WEEK, c.HOURLY_RATE_MIN, c.HOURLY_RATE_MAX,
           c.OT_MULTIPLIER, c.TEAM_COUNT, c.CURRENCY_CODE
    FROM FLEET_APP.LABOR.LABOR_CONFIG c, scope s
    WHERE (c.REGION = s.RG OR c.REGION = '*')
      AND (c.VEHICLE_TYPE = s.VT OR c.VEHICLE_TYPE = '*')
    QUALIFY ROW_NUMBER() OVER (
      ORDER BY IFF(c.REGION = '*', 1, 0) + IFF(c.VEHICLE_TYPE = '*', 1, 0)
    ) = 1
  ),
  params AS (
    SELECT
      COALESCE((SELECT CONTRACTED_HOURS_PER_WEEK FROM cfg), 40)  AS CONTRACTED_HOURS,
      COALESCE((SELECT HOURLY_RATE_MIN FROM cfg), 22.0)          AS RATE_MIN,
      COALESCE((SELECT HOURLY_RATE_MAX FROM cfg), 34.0)          AS RATE_MAX,
      COALESCE((SELECT OT_MULTIPLIER FROM cfg), 1.5)             AS OT_MULT,
      COALESCE((SELECT TEAM_COUNT FROM cfg), 8)                  AS TEAM_N,
      COALESCE((SELECT CURRENCY_CODE FROM cfg), 'USD')           AS CCY
  ),
  ops AS (
    SELECT
      t.DRIVER_ID                        AS OPERATOR_ID,
      ANY_VALUE(f.SHIFT_TYPE)            AS SHIFT_TYPE,
      ANY_VALUE(f.DRIVER_PROFILE)        AS DRIVER_PROFILE,
      ANY_VALUE(f.HOME_LOCATION_ID)      AS HOME_SITE_ID,
      ANY_VALUE(t.REGION)                AS REGION,
      ANY_VALUE(t.VEHICLE_TYPE)          AS VEHICLE_TYPE
    FROM trips t
    LEFT JOIN fleet f ON t.VEHICLE_ID = f.VEHICLE_ID AND f.RN = 1
    GROUP BY t.DRIVER_ID
  )
  SELECT
    o.OPERATOR_ID,
    o.OPERATOR_ID AS OPERATOR_LABEL,
    o.SHIFT_TYPE,
    o.DRIVER_PROFILE,
    o.HOME_SITE_ID,
    'TEAM-' || LPAD(TO_VARCHAR(MOD(ABS(HASH(COALESCE(o.HOME_SITE_ID, o.OPERATOR_ID))), p.TEAM_N) + 1), 2, '0') AS TEAM_ID,
    'SUP-'  || LPAD(TO_VARCHAR(MOD(ABS(HASH(COALESCE(o.HOME_SITE_ID, o.OPERATOR_ID))), p.TEAM_N) + 1), 2, '0') AS SUPERVISOR_ID,
    p.CONTRACTED_HOURS::FLOAT AS CONTRACTED_HOURS_PER_WEEK,
    -- Stable pseudo-random rate in [RATE_MIN, RATE_MAX], 2dp. Hash salted so it
    -- is independent of the team bucket above (same input, different derivation).
    ROUND(p.RATE_MIN + (MOD(ABS(HASH(o.OPERATOR_ID || '|rate')), 10000) / 10000.0) * (p.RATE_MAX - p.RATE_MIN), 2)::FLOAT AS HOURLY_RATE,
    p.OT_MULT::FLOAT AS OT_MULTIPLIER,
    p.CCY     AS CURRENCY_CODE,
    o.REGION,
    FLEET_APP.CORE.REGION_LABEL(o.REGION) AS REGION_LABEL,
    o.VEHICLE_TYPE
  FROM ops o, params p
$$;

-- ---------------------------------------------------------------------------
-- F_FACT_DUTY_PERIOD_SCOPED - one row per continuous stretch of work.
--
-- A duty period is a maximal run of a driver's trips with no gap longer than
-- DUTY_GAP_MINUTES. DUTY_PERIOD is a PERIOD(TIMESTAMP_NTZ) so downstream week
-- allocation can use PERIOD_INTERSECT; DUTY_START / DUTY_END / DUTY_HOURS are
-- projected alongside it because drivers serialize PERIOD as text (so the app
-- cannot compute on it) and because there is no PERIOD duration function.
--
-- PAID_HOURS is the duty SPAN, not the sum of trip durations. A driver waiting
-- between two stops is on the clock, so the span is both the simpler rule and
-- the more accurate one. DRIVE_HOURS is kept separately so the gap between them
-- is visible as utilization rather than hidden.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION FLEET_APP.LABOR.F_FACT_DUTY_PERIOD_SCOPED(P_REGION VARCHAR, P_DATASET_ID VARCHAR)
RETURNS TABLE (
  DUTY_ID VARCHAR, OPERATOR_ID VARCHAR, DUTY_SEQ NUMBER,
  DUTY_PERIOD PERIOD(TIMESTAMP_NTZ), DUTY_START TIMESTAMP_NTZ, DUTY_END TIMESTAMP_NTZ,
  PAID_HOURS FLOAT, DRIVE_HOURS FLOAT, IDLE_HOURS FLOAT, DRIVE_SHARE FLOAT,
  TRIPS NUMBER, DISTANCE_KM FLOAT,
  REGION VARCHAR, REGION_LABEL VARCHAR, VEHICLE_TYPE VARCHAR
)
COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-labor-overtime","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH trips AS (
    SELECT DRIVER_ID, TRIP_START, TRIP_END, DURATION_MINUTES, DISTANCE_KM, REGION, VEHICLE_TYPE
    FROM TABLE(FLEET_APP.UNIFIED_FLEET.F_VW_FACT_TRIPS_SCOPED(P_REGION, P_DATASET_ID))
    WHERE TRIP_START IS NOT NULL AND TRIP_END IS NOT NULL AND TRIP_END > TRIP_START
  ),
  scope AS (
    SELECT ANY_VALUE(REGION) AS RG, ANY_VALUE(VEHICLE_TYPE) AS VT FROM trips
  ),
  cfg AS (
    SELECT c.DUTY_GAP_MINUTES
    FROM FLEET_APP.LABOR.LABOR_CONFIG c, scope s
    WHERE (c.REGION = s.RG OR c.REGION = '*')
      AND (c.VEHICLE_TYPE = s.VT OR c.VEHICLE_TYPE = '*')
    QUALIFY ROW_NUMBER() OVER (
      ORDER BY IFF(c.REGION = '*', 1, 0) + IFF(c.VEHICLE_TYPE = '*', 1, 0)
    ) = 1
  ),
  params AS (
    SELECT COALESCE((SELECT DUTY_GAP_MINUTES FROM cfg), 240) AS GAP_MIN
  ),
  flagged AS (
    SELECT t.*,
           LAG(t.TRIP_END) OVER (PARTITION BY t.DRIVER_ID ORDER BY t.TRIP_START) AS PREV_END,
           p.GAP_MIN
    FROM trips t, params p
  ),
  seeded AS (
    SELECT f.*,
           IFF(f.PREV_END IS NULL
               OR DATEDIFF('minute', f.PREV_END, f.TRIP_START) > f.GAP_MIN, 1, 0) AS NEW_DUTY
    FROM flagged f
  ),
  grouped AS (
    SELECT s.*,
           SUM(s.NEW_DUTY) OVER (
             PARTITION BY s.DRIVER_ID ORDER BY s.TRIP_START
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           ) AS DUTY_SEQ
    FROM seeded s
  )
  SELECT
    g.DRIVER_ID || '|' || TO_VARCHAR(g.DUTY_SEQ)          AS DUTY_ID,
    g.DRIVER_ID                                           AS OPERATOR_ID,
    g.DUTY_SEQ,
    PERIOD_CONSTRUCT(MIN(g.TRIP_START), MAX(g.TRIP_END))   AS DUTY_PERIOD,
    MIN(g.TRIP_START)                                      AS DUTY_START,
    MAX(g.TRIP_END)                                        AS DUTY_END,
    ROUND(DATEDIFF('second', MIN(g.TRIP_START), MAX(g.TRIP_END)) / 3600.0, 4)::FLOAT AS PAID_HOURS,
    ROUND(SUM(g.DURATION_MINUTES) / 60.0, 4)::FLOAT        AS DRIVE_HOURS,
    -- On the clock but not driving. Floored at 0 because trip durations are
    -- recorded independently of the span and can marginally exceed it.
    GREATEST(0, ROUND(DATEDIFF('second', MIN(g.TRIP_START), MAX(g.TRIP_END)) / 3600.0
                      - SUM(g.DURATION_MINUTES) / 60.0, 4))::FLOAT AS IDLE_HOURS,
    LEAST(1.0, ROUND(DIV0(SUM(g.DURATION_MINUTES) / 60.0,
                          DATEDIFF('second', MIN(g.TRIP_START), MAX(g.TRIP_END)) / 3600.0), 4))::FLOAT AS DRIVE_SHARE,
    COUNT(*)                                               AS TRIPS,
    ROUND(SUM(g.DISTANCE_KM), 2)::FLOAT                    AS DISTANCE_KM,
    ANY_VALUE(g.REGION)                                    AS REGION,
    FLEET_APP.CORE.REGION_LABEL(ANY_VALUE(g.REGION))       AS REGION_LABEL,
    ANY_VALUE(g.VEHICLE_TYPE)                              AS VEHICLE_TYPE
  FROM grouped g
  GROUP BY g.DRIVER_ID, g.DUTY_SEQ
$$;

-- ---------------------------------------------------------------------------
-- F_FACT_LABOR_WEEK_SCOPED - per operator per payroll week, with a projection.
--
-- WEEK ALLOCATION. Each duty period is intersected with the payroll week(s) it
-- touches. A duty period is bounded by the gap threshold so it can span at most
-- one week boundary, which is why this emits the begin-week row plus - only when
-- the end falls in a different week - an end-week row, rather than cross-joining
-- to a generated week table. PERIOD_INTERSECT is guaranteed non-NULL for both
-- because the period demonstrably overlaps both weeks.
--
-- PROJECTION. "Now" is the latest activity in the DATASET, not
-- CURRENT_TIMESTAMP: the data is historical, so against wall-clock time every
-- week would be complete and the projection would be dead. For the week
-- containing that as-of instant, hours are extrapolated by linear daily run
-- rate (hours so far / days elapsed * 7). Completed weeks project to their
-- actual. This is the "it is Tuesday, who will pass 60 by Friday" number.
--
-- TRIPS and DISTANCE are attributed to the week containing TRIP_START, which is
-- exact and keeps trip counts integral, whereas PAID_HOURS is allocated by
-- intersection. For a duty period straddling midnight on the week boundary the
-- two can disagree slightly, so DRIVE_SHARE_OF_PAID is capped at 1.0.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION FLEET_APP.LABOR.F_FACT_LABOR_WEEK_SCOPED(P_REGION VARCHAR, P_DATASET_ID VARCHAR)
RETURNS TABLE (
  OPERATOR_ID VARCHAR, WEEK_START DATE, WEEK_END DATE, WEEK_LABEL VARCHAR,
  TEAM_ID VARCHAR, SUPERVISOR_ID VARCHAR, SHIFT_TYPE VARCHAR, DRIVER_PROFILE VARCHAR,
  HOURS_TO_DATE FLOAT, DAYS_WORKED NUMBER, DAYS_ELAPSED NUMBER, DAYS_REMAINING NUMBER,
  IS_CURRENT_WEEK BOOLEAN, IS_PARTIAL_START BOOLEAN, PROJECTED_WEEK_HOURS FLOAT,
  CONTRACTED_HOURS_PER_WEEK FLOAT, STRAIGHT_HOURS FLOAT, OT_HOURS FLOAT,
  PROJECTED_OT_HOURS FLOAT, HOURLY_RATE FLOAT, EST_OT_COST FLOAT, CURRENCY_CODE VARCHAR,
  OT_BAND VARCHAR, OT_THRESHOLD_1 FLOAT, OT_THRESHOLD_2 FLOAT, OT_THRESHOLD_3 FLOAT,
  DRIVE_HOURS FLOAT, DRIVE_SHARE_OF_PAID FLOAT, TRIPS NUMBER, DISTANCE_KM FLOAT,
  KM_PER_PAID_HOUR FLOAT, STOPS_PER_PAID_HOUR FLOAT,
  REGION VARCHAR, REGION_LABEL VARCHAR, VEHICLE_TYPE VARCHAR
)
COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-labor-overtime","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH duty AS (
    SELECT * FROM TABLE(FLEET_APP.LABOR.F_FACT_DUTY_PERIOD_SCOPED(P_REGION, P_DATASET_ID))
  ),
  ops AS (
    SELECT * FROM TABLE(FLEET_APP.LABOR.F_DIM_LABOR_OPERATOR_SCOPED(P_REGION, P_DATASET_ID))
  ),
  trips AS (
    SELECT DRIVER_ID, TRIP_START, DISTANCE_KM, DURATION_MINUTES
    FROM TABLE(FLEET_APP.UNIFIED_FLEET.F_VW_FACT_TRIPS_SCOPED(P_REGION, P_DATASET_ID))
    WHERE TRIP_START IS NOT NULL
  ),
  scope AS (
    SELECT ANY_VALUE(REGION) AS RG, ANY_VALUE(VEHICLE_TYPE) AS VT FROM duty
  ),
  cfg AS (
    SELECT c.OT_THRESHOLD_1, c.OT_THRESHOLD_2, c.OT_THRESHOLD_3, c.WEEK_START_DOW
    FROM FLEET_APP.LABOR.LABOR_CONFIG c, scope s
    WHERE (c.REGION = s.RG OR c.REGION = '*')
      AND (c.VEHICLE_TYPE = s.VT OR c.VEHICLE_TYPE = '*')
    QUALIFY ROW_NUMBER() OVER (
      ORDER BY IFF(c.REGION = '*', 1, 0) + IFF(c.VEHICLE_TYPE = '*', 1, 0)
    ) = 1
  ),
  params AS (
    SELECT
      COALESCE((SELECT OT_THRESHOLD_1 FROM cfg), 40) AS T1,
      COALESCE((SELECT OT_THRESHOLD_2 FROM cfg), 50) AS T2,
      COALESCE((SELECT OT_THRESHOLD_3 FROM cfg), 60) AS T3,
      COALESCE((SELECT WEEK_START_DOW FROM cfg), 7)  AS DOW,
      (SELECT MAX(DUTY_END) FROM duty)               AS AS_OF_TS,
      (SELECT MIN(DUTY_START) FROM duty)             AS FIRST_TS
  ),
  -- Week start for an instant, computed arithmetically so it does not depend on
  -- the session WEEK_START parameter.
  bounded AS (
    SELECT d.*,
           p.T1, p.T2, p.T3, p.DOW, p.AS_OF_TS, p.FIRST_TS,
           DATEADD('day', -MOD(DAYOFWEEKISO(d.DUTY_START) - p.DOW + 7, 7), d.DUTY_START::DATE) AS WK_BEGIN,
           DATEADD('day', -MOD(DAYOFWEEKISO(d.DUTY_END)   - p.DOW + 7, 7), d.DUTY_END::DATE)   AS WK_END
    FROM duty d, params p
  ),
  -- At most two segments per duty period: the begin week always, the end week
  -- only when it differs. Emitting both and intersecting is what conserves hours.
  segs AS (
    SELECT b.OPERATOR_ID, b.DUTY_PERIOD, b.DRIVE_HOURS, b.PAID_HOURS, b.DUTY_START,
           b.REGION, b.REGION_LABEL, b.VEHICLE_TYPE, b.T1, b.T2, b.T3, b.AS_OF_TS, b.FIRST_TS,
           b.WK_BEGIN AS WEEK_START
    FROM bounded b
    UNION ALL
    SELECT b.OPERATOR_ID, b.DUTY_PERIOD, b.DRIVE_HOURS, b.PAID_HOURS, b.DUTY_START,
           b.REGION, b.REGION_LABEL, b.VEHICLE_TYPE, b.T1, b.T2, b.T3, b.AS_OF_TS, b.FIRST_TS,
           b.WK_END AS WEEK_START
    FROM bounded b
    WHERE b.WK_END <> b.WK_BEGIN
  ),
  clipped AS (
    SELECT s.*,
           PERIOD_INTERSECT(
             s.DUTY_PERIOD,
             PERIOD_CONSTRUCT(s.WEEK_START::TIMESTAMP_NTZ,
                              DATEADD('day', 7, s.WEEK_START)::TIMESTAMP_NTZ)
           ) AS SEG
    FROM segs s
  ),
  seg_hours AS (
    SELECT c.OPERATOR_ID, c.WEEK_START, c.REGION, c.REGION_LABEL, c.VEHICLE_TYPE,
           c.T1, c.T2, c.T3, c.AS_OF_TS, c.FIRST_TS,
           DATEDIFF('second', PERIOD_BEGIN(c.SEG), PERIOD_END(c.SEG)) / 3600.0 AS SEG_HOURS,
           -- Drive hours follow the segment's share of the duty span, so a split
           -- duty period does not double-count driving.
           c.DRIVE_HOURS * DIV0(DATEDIFF('second', PERIOD_BEGIN(c.SEG), PERIOD_END(c.SEG)) / 3600.0,
                                c.PAID_HOURS) AS SEG_DRIVE_HOURS,
           PERIOD_BEGIN(c.SEG)::DATE AS SEG_DAY
    FROM clipped c
    WHERE c.SEG IS NOT NULL
  ),
  wk AS (
    SELECT
      OPERATOR_ID, WEEK_START,
      ANY_VALUE(REGION) AS REGION, ANY_VALUE(REGION_LABEL) AS REGION_LABEL,
      ANY_VALUE(VEHICLE_TYPE) AS VEHICLE_TYPE,
      ANY_VALUE(T1) AS T1, ANY_VALUE(T2) AS T2, ANY_VALUE(T3) AS T3,
      ANY_VALUE(AS_OF_TS) AS AS_OF_TS,
      ANY_VALUE(FIRST_TS) AS FIRST_TS,
      SUM(SEG_HOURS)               AS HOURS_TO_DATE,
      SUM(SEG_DRIVE_HOURS)         AS DRIVE_HOURS,
      COUNT(DISTINCT SEG_DAY)      AS DAYS_WORKED
    FROM seg_hours
    GROUP BY OPERATOR_ID, WEEK_START
  ),
  -- Trips attributed to the week containing TRIP_START: exact, integral counts.
  trip_wk AS (
    SELECT t.DRIVER_ID AS OPERATOR_ID,
           DATEADD('day', -MOD(DAYOFWEEKISO(t.TRIP_START) - p.DOW + 7, 7), t.TRIP_START::DATE) AS WEEK_START,
           COUNT(*) AS TRIPS,
           SUM(t.DISTANCE_KM) AS DISTANCE_KM
    FROM trips t, params p
    GROUP BY 1, 2
  ),
  calc AS (
    SELECT
      w.*,
      DATEADD('day', 6, w.WEEK_START)                          AS WEEK_END_D,
      DATEADD('day', 7, w.WEEK_START)::TIMESTAMP_NTZ            AS WEEK_END_TS,
      -- Days of the week that have actually happened as at the dataset's as-of
      -- instant, clamped into 1..7 so a completed week projects to its actual.
      LEAST(7, GREATEST(1, DATEDIFF('day', w.WEEK_START, w.AS_OF_TS::DATE) + 1)) AS DAYS_ELAPSED_C,
      (w.AS_OF_TS >= w.WEEK_START::TIMESTAMP_NTZ
       AND w.AS_OF_TS < DATEADD('day', 7, w.WEEK_START)::TIMESTAMP_NTZ)          AS IS_CUR,
      -- The dataset STARTS inside this week, so the week is truncated at its
      -- beginning rather than its end. Such a week is NOT projectable (there is
      -- no earlier activity to extrapolate from) and its totals are legitimately
      -- low, so it must be labelled rather than silently compared against a full
      -- week. Without this the first week of any dataset reads as a fleet-wide
      -- drop in hours.
      (w.FIRST_TS > w.WEEK_START::TIMESTAMP_NTZ)                                 AS IS_PARTIAL_S
    FROM wk w
  ),
  proj AS (
    SELECT c.*,
           7 - c.DAYS_ELAPSED_C AS DAYS_REMAINING_C,
           ROUND(IFF(c.IS_CUR,
                     DIV0(c.HOURS_TO_DATE, c.DAYS_ELAPSED_C) * 7,
                     c.HOURS_TO_DATE), 2) AS PROJ_HOURS
    FROM calc c
  )
  SELECT
    p.OPERATOR_ID,
    p.WEEK_START,
    p.WEEK_END_D                                       AS WEEK_END,
    TO_VARCHAR(p.WEEK_START, 'YYYY-MM-DD')             AS WEEK_LABEL,
    o.TEAM_ID,
    o.SUPERVISOR_ID,
    o.SHIFT_TYPE,
    o.DRIVER_PROFILE,
    ROUND(p.HOURS_TO_DATE, 2)::FLOAT                   AS HOURS_TO_DATE,
    p.DAYS_WORKED,
    p.DAYS_ELAPSED_C                                   AS DAYS_ELAPSED,
    p.DAYS_REMAINING_C                                 AS DAYS_REMAINING,
    p.IS_CUR                                           AS IS_CURRENT_WEEK,
    p.IS_PARTIAL_S                                     AS IS_PARTIAL_START,
    p.PROJ_HOURS::FLOAT                                AS PROJECTED_WEEK_HOURS,
    o.CONTRACTED_HOURS_PER_WEEK,
    ROUND(LEAST(p.HOURS_TO_DATE, p.T1), 2)::FLOAT      AS STRAIGHT_HOURS,
    ROUND(GREATEST(0, p.HOURS_TO_DATE - p.T1), 2)::FLOAT AS OT_HOURS,
    ROUND(GREATEST(0, p.PROJ_HOURS - p.T1), 2)::FLOAT  AS PROJECTED_OT_HOURS,
    o.HOURLY_RATE,
    ROUND(GREATEST(0, p.PROJ_HOURS - p.T1) * o.HOURLY_RATE * o.OT_MULTIPLIER, 2)::FLOAT AS EST_OT_COST,
    o.CURRENCY_CODE,
    -- Bands are named for their meaning, not for a threshold value, because the
    -- thresholds are jurisdiction-specific configuration.
    CASE
      WHEN p.PROJ_HOURS >= p.T3 THEN 'BREACH'
      WHEN p.PROJ_HOURS >= p.T2 THEN 'AT_RISK'
      WHEN p.PROJ_HOURS >= p.T1 THEN 'OVERTIME'
      ELSE 'UNDER_CONTRACT'
    END                                                AS OT_BAND,
    p.T1::FLOAT AS OT_THRESHOLD_1, p.T2::FLOAT AS OT_THRESHOLD_2, p.T3::FLOAT AS OT_THRESHOLD_3,
    ROUND(p.DRIVE_HOURS, 2)::FLOAT                     AS DRIVE_HOURS,
    LEAST(1.0, ROUND(DIV0(p.DRIVE_HOURS, p.HOURS_TO_DATE), 4))::FLOAT AS DRIVE_SHARE_OF_PAID,
    COALESCE(tw.TRIPS, 0)                              AS TRIPS,
    ROUND(COALESCE(tw.DISTANCE_KM, 0), 2)::FLOAT       AS DISTANCE_KM,
    ROUND(DIV0(COALESCE(tw.DISTANCE_KM, 0), p.HOURS_TO_DATE), 2)::FLOAT AS KM_PER_PAID_HOUR,
    ROUND(DIV0(COALESCE(tw.TRIPS, 0), p.HOURS_TO_DATE), 2)::FLOAT       AS STOPS_PER_PAID_HOUR,
    p.REGION,
    p.REGION_LABEL,
    p.VEHICLE_TYPE
  FROM proj p
  LEFT JOIN ops o     ON o.OPERATOR_ID = p.OPERATOR_ID
  LEFT JOIN trip_wk tw ON tw.OPERATOR_ID = p.OPERATOR_ID AND tw.WEEK_START = p.WEEK_START
$$;

-- ---------------------------------------------------------------------------
-- Grants. Read-only analytics, so all three app roles get USAGE.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA FLEET_APP.LABOR TO ROLE FLEET_APP_USER;
GRANT USAGE ON SCHEMA FLEET_APP.LABOR TO ROLE FLEET_APP_OPS;
GRANT USAGE ON SCHEMA FLEET_APP.LABOR TO ROLE FLEET_APP_ADMIN;

GRANT SELECT ON TABLE FLEET_APP.LABOR.LABOR_CONFIG TO ROLE FLEET_APP_USER;
GRANT SELECT ON TABLE FLEET_APP.LABOR.LABOR_CONFIG TO ROLE FLEET_APP_OPS;
GRANT SELECT ON TABLE FLEET_APP.LABOR.LABOR_CONFIG TO ROLE FLEET_APP_ADMIN;

GRANT USAGE ON FUNCTION FLEET_APP.LABOR.F_DIM_LABOR_OPERATOR_SCOPED(VARCHAR, VARCHAR) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.LABOR.F_DIM_LABOR_OPERATOR_SCOPED(VARCHAR, VARCHAR) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.LABOR.F_DIM_LABOR_OPERATOR_SCOPED(VARCHAR, VARCHAR) TO ROLE FLEET_APP_ADMIN;

GRANT USAGE ON FUNCTION FLEET_APP.LABOR.F_FACT_DUTY_PERIOD_SCOPED(VARCHAR, VARCHAR) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.LABOR.F_FACT_DUTY_PERIOD_SCOPED(VARCHAR, VARCHAR) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.LABOR.F_FACT_DUTY_PERIOD_SCOPED(VARCHAR, VARCHAR) TO ROLE FLEET_APP_ADMIN;

GRANT USAGE ON FUNCTION FLEET_APP.LABOR.F_FACT_LABOR_WEEK_SCOPED(VARCHAR, VARCHAR) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.LABOR.F_FACT_LABOR_WEEK_SCOPED(VARCHAR, VARCHAR) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.LABOR.F_FACT_LABOR_WEEK_SCOPED(VARCHAR, VARCHAR) TO ROLE FLEET_APP_ADMIN;
