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
--    A duty period is generated against EVERY payroll week it touches, so its
--    length is not load-bearing. It used to emit only the begin week plus, when
--    different, the end week, on the stated assumption that the gap threshold
--    kept a duty period well under 7 days. That assumption was false on a
--    long-haul dataset - 75 duty periods over 24h, the longest 215.5h across 9
--    days - and every intermediate week was silently dropped, losing 504 of
--    5,378 paid hours. verify_labor_layer.sql asserts the conservation equality
--    and also reports duty periods long enough to be implausible, which is a
--    DATA quality signal about the source trips rather than a bug here.
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
  CURRENCY_CODE             VARCHAR,
  -- Compliance parameters. Defaults are the VERIFIED regulatory values, not
  -- guesses, and they are configuration because the regime differs by
  -- jurisdiction and by fleet:
  --
  --   DOT_ONDUTY_LIMIT_7D / _8D - 49 CFR 395.3(b): a driver may not drive after
  --     60 hours on duty in 7 consecutive days (carrier not operating every day)
  --     or 70 in 8 (operating every day). This is an HOURS-OF-SERVICE ceiling,
  --     NOT a pay threshold, and it is almost certainly what an operations
  --     director means by "60 hours".
  --
  --   DS_MAX_DRIVE_SHARE / DS_RADIUS_MILES - 49 CFR 395.2 defines a
  --     "driver-salesperson" as one who sells AND delivers, operates entirely
  --     within a 100-mile radius of the reporting point, and devotes NOT MORE
  --     THAN 50 PERCENT of on-duty hours to driving. Both are status-determining:
  --     drift above either and the exemption in 395.1(c) is lost.
  --
  --   GVWR_OT_THRESHOLD_TONNES - the FLSA small-vehicle exception boundary.
  --     10,000 lb = 4.536 tonnes. Under the 13(b)(1) motor carrier exemption
  --     (DOL Fact Sheet #19) drivers for a motor private carrier are exempt from
  --     FLSA overtime, EXCEPT in a workweek where they work on a vehicle at or
  --     below this weight - and then the whole workweek is covered even if
  --     heavier vehicles were also driven.
  DOT_ONDUTY_LIMIT_7D       FLOAT,
  DOT_ONDUTY_LIMIT_8D       FLOAT,
  DS_MAX_DRIVE_SHARE        FLOAT,
  DS_RADIUS_MILES           FLOAT,
  GVWR_OT_THRESHOLD_TONNES  FLOAT
)
COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-labor-overtime","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- The table is created IF NOT EXISTS, so on an account that already has it the
-- compliance columns above are absent. Add them idempotently. A bare
-- ADD COLUMN IF NOT EXISTS + DEFAULT trips Snowflake bug 002028 ("ambiguous
-- column name") when the column already exists, so this uses the same temporary
-- procedure exception-guard as scoped_contract.sql's _ADD_TRIP_KIND_IF_MISSING.
--
-- Safe with respect to the SELECT * wrapper hazard: nothing wraps LABOR_CONFIG
-- (the wrapper views cover the FUNCTIONS, not this table), so widening it cannot
-- invalidate a frozen view column list.
CREATE OR REPLACE PROCEDURE FLEET_APP.LABOR._ADD_COMPLIANCE_COLS_IF_MISSING()
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-labor-overtime","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
EXECUTE AS CALLER
AS
$$
BEGIN
  ALTER TABLE FLEET_APP.LABOR.LABOR_CONFIG ADD COLUMN
    DOT_ONDUTY_LIMIT_7D FLOAT,
    DOT_ONDUTY_LIMIT_8D FLOAT,
    DS_MAX_DRIVE_SHARE FLOAT,
    DS_RADIUS_MILES FLOAT,
    GVWR_OT_THRESHOLD_TONNES FLOAT;
  RETURN 'added';
EXCEPTION
  WHEN OTHER THEN RETURN 'already present';
END;
$$;
CALL FLEET_APP.LABOR._ADD_COMPLIANCE_COLS_IF_MISSING();
DROP PROCEDURE IF EXISTS FLEET_APP.LABOR._ADD_COMPLIANCE_COLS_IF_MISSING();

-- Idempotent seed of the global default row only. Per-region overrides are
-- operator-owned and are never touched by a redeploy.
DELETE FROM FLEET_APP.LABOR.LABOR_CONFIG WHERE REGION = '*' AND VEHICLE_TYPE = '*';
INSERT INTO FLEET_APP.LABOR.LABOR_CONFIG
  (REGION, VEHICLE_TYPE, DUTY_GAP_MINUTES, OT_THRESHOLD_1, OT_THRESHOLD_2, OT_THRESHOLD_3,
   OT_MULTIPLIER, WEEK_START_DOW, CONTRACTED_HOURS_PER_WEEK, HOURLY_RATE_MIN, HOURLY_RATE_MAX,
   TEAM_COUNT, CURRENCY_CODE,
   DOT_ONDUTY_LIMIT_7D, DOT_ONDUTY_LIMIT_8D, DS_MAX_DRIVE_SHARE, DS_RADIUS_MILES,
   GVWR_OT_THRESHOLD_TONNES)
VALUES
  ('*', '*', 240, 40, 50, 60, 1.5, 7, 40, 22.0, 34.0, 8, 'USD',
   60, 70, 0.50, 100, 4.536);

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
           -- Latest end seen so far for this operator, used to strip the part of
           -- this trip that OVERLAPS an earlier one. The generator can assign a
           -- driver two trips at once (measured: 15 negative gaps on UsTexas), and
           -- summing raw durations then counts those minutes twice, which pushed
           -- DRIVE_HOURS above PAID_HOURS in 17 operator-weeks. LAG is not enough
           -- here - the overlapping trip need not be the immediately preceding one.
           MAX(t.TRIP_END) OVER (
             PARTITION BY t.DRIVER_ID ORDER BY t.TRIP_START
             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
           ) AS PRIOR_MAX_END,
           p.GAP_MIN
    FROM trips t, params p
  ),
  seeded AS (
    SELECT f.*,
           -- Driving minutes with the overlapped head removed. With no overlap the
           -- subtrahend is 0 and this is exactly DURATION_MINUTES, so a clean
           -- dataset is unaffected.
           GREATEST(0, f.DURATION_MINUTES
                       - GREATEST(0, DATEDIFF('minute', f.TRIP_START,
                                    LEAST(f.TRIP_END, COALESCE(f.PRIOR_MAX_END, f.TRIP_START))))
           ) AS EFF_DRIVE_MIN,
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
    -- Capped at the duty SPAN. Trip durations are recorded independently of the
    -- span and can marginally exceed it, and DRIVE_SHARE / IDLE_HOURS below were
    -- already clamped for exactly that reason - leaving DRIVE_HOURS itself
    -- unclamped let it exceed PAID_HOURS while the two derived columns looked fine.
    LEAST(ROUND(DATEDIFF('second', MIN(g.TRIP_START), MAX(g.TRIP_END)) / 3600.0, 4),
          ROUND(SUM(g.EFF_DRIVE_MIN) / 60.0, 4))::FLOAT        AS DRIVE_HOURS,
    -- On the clock but not driving.
    GREATEST(0, ROUND(DATEDIFF('second', MIN(g.TRIP_START), MAX(g.TRIP_END)) / 3600.0
                      - SUM(g.EFF_DRIVE_MIN) / 60.0, 4))::FLOAT AS IDLE_HOURS,
    LEAST(1.0, ROUND(DIV0(SUM(g.EFF_DRIVE_MIN) / 60.0,
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
  PROJECTED_OT_HOURS FLOAT, HOURLY_RATE FLOAT, EST_OT_COST FLOAT,
  -- The AVOIDABLE portion. EST_OT_COST is the FULLY LOADED cost of the overtime
  -- hours (hours x rate x multiplier); only the premium above straight time is
  -- incremental, because the straight-time portion would be paid to somebody
  -- regardless. Presenting the loaded figure as "cost of overtime" overstates
  -- the savings opportunity by 3x at a 1.5x multiplier, which is a documented
  -- and common error in labour dashboards.
  EST_OT_PREMIUM FLOAT,
  CURRENCY_CODE VARCHAR,
  -- OT rate with the denominator NAMED. Three variants are in circulation and
  -- they are not interchangeable, so an unlabelled "OT %" tile will be misread.
  OT_PCT_OF_PAID FLOAT, OT_PCT_OF_STRAIGHT FLOAT,
  -- Per-operator-week FTE contribution (paid hours / contracted). Sums to fleet
  -- FTE, so a rising FTE against flat headcount is the structural understaffing
  -- signal rather than a scheduling one.
  FTE_EQUIVALENT FLOAT,
  OT_BAND VARCHAR, OT_THRESHOLD_1 FLOAT, OT_THRESHOLD_2 FLOAT, OT_THRESHOLD_3 FLOAT,
  DRIVE_HOURS FLOAT, DRIVE_SHARE_OF_PAID FLOAT, TRIPS NUMBER, DISTANCE_KM FLOAT,
  KM_PER_PAID_HOUR FLOAT, STOPS_PER_PAID_HOUR FLOAT,
  -- ---------------------------------------------------------------------------
  -- Compliance layer. Which regime actually binds this operator this week.
  -- ---------------------------------------------------------------------------
  -- FLSA overtime eligibility is NOT a static employee attribute. Under the
  -- 13(b)(1) motor carrier exemption a driver for a motor private carrier (which
  -- a bottler distributing its own product is) is exempt from FLSA overtime
  -- entirely - EXCEPT in a workweek where they work on a vehicle of 10,000 lb or
  -- less, and then the whole workweek is covered even if heavier vehicles were
  -- also driven that week. So eligibility is a function of
  -- (operator, workweek, lightest vehicle operated).
  OT_ELIGIBLE_FLSA BOOLEAN, MIN_VEHICLE_TONNES FLOAT,
  -- DOT on-duty hours are a DIFFERENT CLOCK from payroll hours: 49 CFR 395.2
  -- on-duty time includes waiting to be dispatched, inspection, and loading.
  -- Kept in its own columns and deliberately never merged into a paid-hours
  -- tile, because mixing the two gives false compliance comfort. The window is
  -- a rolling 7 consecutive days, not the payroll week.
  DOT_ONDUTY_7D_HOURS FLOAT, DOT_ONDUTY_LIMIT FLOAT, DOT_ONDUTY_PCT FLOAT,
  -- Driver-salesperson status (49 CFR 395.2): sells and delivers, operates
  -- entirely within a radius of the reporting point, and devotes not more than
  -- 50 percent of on-duty hours to driving. Losing either test forfeits the
  -- 395.1(c) exemption from the 60/70-hour rule.
  MAX_RADIUS_MILES FLOAT, DRIVER_SALESPERSON_OK BOOLEAN,
  -- The single readable answer to "what limits this person": FLSA_40, POLICY_50,
  -- DOT_ONDUTY, DS_DRIVE_PCT, DS_RADIUS, or NONE.
  BINDING_CONSTRAINT VARCHAR,
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
    SELECT c.OT_THRESHOLD_1, c.OT_THRESHOLD_2, c.OT_THRESHOLD_3, c.WEEK_START_DOW,
           c.DOT_ONDUTY_LIMIT_7D, c.DS_MAX_DRIVE_SHARE, c.DS_RADIUS_MILES,
           c.GVWR_OT_THRESHOLD_TONNES
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
      COALESCE((SELECT DOT_ONDUTY_LIMIT_7D FROM cfg), 60)      AS DOT_LIMIT,
      COALESCE((SELECT DS_MAX_DRIVE_SHARE FROM cfg), 0.50)     AS DS_DRIVE_MAX,
      COALESCE((SELECT DS_RADIUS_MILES FROM cfg), 100)         AS DS_RADIUS,
      COALESCE((SELECT GVWR_OT_THRESHOLD_TONNES FROM cfg), 4.536) AS GVWR_T,
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
  -- One segment per payroll week the duty period TOUCHES. This used to emit the
  -- begin week plus, when different, the end week - which is correct only while a
  -- duty period spans at most one week boundary. That invariant does not hold:
  -- measured on a long-haul HGV dataset, 75 duty periods exceeded 24h and the
  -- longest ran 215.5h across 9 days, so every intermediate week was dropped and
  -- 504 of 5,378 paid hours (9.4%) vanished between the duty fact and this one.
  -- Generating the weeks instead removes the assumption entirely: hours are
  -- conserved for a duty period of ANY length, and for a period that does touch
  -- only one or two weeks the output is identical to before.
  --
  -- The 60-week ceiling bounds the join; a duty period longer than that would
  -- lose its tail, so verify_labor_layer.sql asserts none comes close.
  wk_offsets AS (
    SELECT SEQ4() AS N FROM TABLE(GENERATOR(ROWCOUNT => 60))
  ),
  segs AS (
    SELECT b.OPERATOR_ID, b.DUTY_PERIOD, b.DRIVE_HOURS, b.PAID_HOURS, b.DUTY_START,
           b.REGION, b.REGION_LABEL, b.VEHICLE_TYPE, b.T1, b.T2, b.T3, b.AS_OF_TS, b.FIRST_TS,
           DATEADD('day', 7 * o.N, b.WK_BEGIN) AS WEEK_START
    FROM bounded b
    JOIN wk_offsets o
      ON DATEADD('day', 7 * o.N, b.WK_BEGIN) <= b.WK_END
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
           PERIOD_BEGIN(c.SEG) AS SEG_BEGIN,
           PERIOD_END(c.SEG)   AS SEG_END
    FROM clipped c
    WHERE c.SEG IS NOT NULL
  ),
  -- Days actually COVERED by each segment, not just the date it starts on.
  -- COUNT(DISTINCT segment-start-date) reported a duty period running from
  -- Saturday evening to Monday morning as ONE day worked, which is how the view
  -- came to show 42.51 paid hours against DAYS_WORKED = 1. A segment is confined
  -- to a single payroll week, so 7 offsets cover every case.
  day_offsets AS (
    SELECT SEQ4() AS N FROM TABLE(GENERATOR(ROWCOUNT => 7))
  ),
  seg_days AS (
    SELECT s.OPERATOR_ID, s.WEEK_START,
           DATEADD('day', d.N, s.SEG_BEGIN::DATE) AS D
    FROM seg_hours s
    JOIN day_offsets d
      ON DATEADD('day', d.N, s.SEG_BEGIN::DATE) <= s.SEG_END::DATE
  ),
  days AS (
    SELECT OPERATOR_ID, WEEK_START, COUNT(DISTINCT D) AS DAYS_WORKED
    FROM seg_days
    GROUP BY OPERATOR_ID, WEEK_START
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
      SUM(SEG_DRIVE_HOURS)         AS DRIVE_HOURS
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
      (w.FIRST_TS > w.WEEK_START::TIMESTAMP_NTZ)                                 AS IS_PARTIAL_S,
      d.DAYS_WORKED
    FROM wk w
    JOIN days d
      ON d.OPERATOR_ID = w.OPERATOR_ID AND d.WEEK_START = w.WEEK_START
  ),
  proj AS (
    SELECT c.*,
           7 - c.DAYS_ELAPSED_C AS DAYS_REMAINING_C,
           -- Clamped at 168, the number of hours a week contains. A run rate taken
           -- over very few elapsed days can otherwise project past what a week even
           -- holds, and a figure above 168 is not a forecast. The clamp is a floor
           -- under nonsense, not a fix: when it binds, look at the input hours.
           ROUND(LEAST(168, IFF(c.IS_CUR,
                     DIV0(c.HOURS_TO_DATE, c.DAYS_ELAPSED_C) * 7,
                     c.HOURS_TO_DATE)), 2) AS PROJ_HOURS
    FROM calc c
  ),
  -- ==========================================================================
  -- Compliance layer
  -- ==========================================================================
  -- Vehicle weight per operator. The FLSA small-vehicle exception turns on the
  -- LIGHTEST vehicle worked in the week: if any vehicle is at or under the
  -- threshold, overtime applies to the WHOLE workweek even though heavier
  -- vehicles were also driven. So MIN, never MAX or AVG.
  veh AS (
    SELECT t.DRIVER_ID AS OPERATOR_ID,
           MIN(f.WEIGHT_TONS) AS MIN_TONNES
    FROM TABLE(FLEET_APP.UNIFIED_FLEET.F_VW_FACT_TRIPS_SCOPED(P_REGION, P_DATASET_ID)) t
    JOIN (
      SELECT VEHICLE_ID, WEIGHT_TONS,
             ROW_NUMBER() OVER (PARTITION BY VEHICLE_ID ORDER BY SHIFT_TYPE) AS RN
      FROM TABLE(FLEET_APP.UNIFIED_FLEET.F_VW_DIM_FLEET_SCOPED(P_REGION, P_DATASET_ID))
    ) f ON f.VEHICLE_ID = t.VEHICLE_ID AND f.RN = 1
    GROUP BY t.DRIVER_ID
  ),
  -- Furthest trip destination from the operator's reporting point, in air miles.
  -- The driver-salesperson definition and the short-haul exception are both
  -- RADIUS tests from the reporting location, not route-distance tests, so this
  -- is a straight-line ST_DISTANCE and deliberately not a road distance.
  home AS (
    SELECT f.VEHICLE_ID, p.POINT_GEOM AS HOME_GEOG
    FROM (
      SELECT VEHICLE_ID, HOME_LOCATION_ID,
             ROW_NUMBER() OVER (PARTITION BY VEHICLE_ID ORDER BY SHIFT_TYPE) AS RN
      FROM TABLE(FLEET_APP.UNIFIED_FLEET.F_VW_DIM_FLEET_SCOPED(P_REGION, P_DATASET_ID))
    ) f
    JOIN TABLE(FLEET_APP.UNIFIED_FLEET.F_VW_DIM_POIS_SCOPED(P_REGION, P_DATASET_ID)) p
      ON p.LOCATION_ID = f.HOME_LOCATION_ID
    WHERE f.RN = 1
  ),
  radius AS (
    SELECT t.DRIVER_ID AS OPERATOR_ID,
           MAX(ST_DISTANCE(h.HOME_GEOG, t.DESTINATION) / 1609.34) AS MAX_MILES
    FROM TABLE(FLEET_APP.UNIFIED_FLEET.F_VW_FACT_TRIPS_SCOPED(P_REGION, P_DATASET_ID)) t
    JOIN home h ON h.VEHICLE_ID = t.VEHICLE_ID
    WHERE t.DESTINATION IS NOT NULL
    GROUP BY t.DRIVER_ID
  ),
  -- Rolling 7-CONSECUTIVE-DAY on-duty total, which is the DOT window and is NOT
  -- the payroll week. Reported per payroll week as the PEAK exposure whose window
  -- ends inside that week, since that is the number that would have triggered a
  -- violation.
  duty_day AS (
    SELECT OPERATOR_ID, DUTY_START::DATE AS D, SUM(PAID_HOURS) AS H
    FROM duty GROUP BY OPERATOR_ID, DUTY_START::DATE
  ),
  duty_roll AS (
    SELECT OPERATOR_ID, D,
           SUM(H) OVER (
             PARTITION BY OPERATOR_ID ORDER BY D
             RANGE BETWEEN INTERVAL '6 days' PRECEDING AND CURRENT ROW
           ) AS ONDUTY_7D
    FROM duty_day
  ),
  dot AS (
    SELECT r.OPERATOR_ID,
           DATEADD('day', -MOD(DAYOFWEEKISO(r.D) - p.DOW + 7, 7), r.D) AS WEEK_START,
           MAX(r.ONDUTY_7D) AS ONDUTY_7D_PEAK
    FROM duty_roll r, params p
    GROUP BY 1, 2
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
    -- Only the premium ABOVE straight time is avoidable: (multiplier - 1), so
    -- 0.5x at a 1.5x rate, not 1.5x. Costing the full loaded rate as "the cost of
    -- overtime" overstates the savings opportunity by 3x.
    ROUND(GREATEST(0, p.PROJ_HOURS - p.T1) * o.HOURLY_RATE * GREATEST(0, o.OT_MULTIPLIER - 1), 2)::FLOAT AS EST_OT_PREMIUM,
    o.CURRENCY_CODE,
    ROUND(DIV0(GREATEST(0, p.HOURS_TO_DATE - p.T1), p.HOURS_TO_DATE), 4)::FLOAT    AS OT_PCT_OF_PAID,
    ROUND(DIV0(GREATEST(0, p.HOURS_TO_DATE - p.T1), LEAST(p.HOURS_TO_DATE, p.T1)), 4)::FLOAT AS OT_PCT_OF_STRAIGHT,
    ROUND(DIV0(p.HOURS_TO_DATE, NULLIF(o.CONTRACTED_HOURS_PER_WEEK, 0)), 4)::FLOAT AS FTE_EQUIVALENT,
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
    -- Compliance -------------------------------------------------------------
    -- The GVWR threshold splits the population into two mutually exclusive
    -- regimes, and almost everything else follows from which side you are on:
    --
    --   LIGHT vehicle (at or under the threshold) - not a commercial motor
    --     vehicle for these purposes. The FLSA small-vehicle exception applies,
    --     so overtime IS owed. DOT hours-of-service and driver-salesperson
    --     status are NOT APPLICABLE and are returned as NULL rather than as a
    --     number, because a computed value here would be pure noise: an e-bike
    --     courier drives ~94% of paid time, which "fails" a 50% driving test
    --     that was never written for them.
    --
    --   CMV (above the threshold) - the FLSA 13(b)(1) motor carrier exemption
    --     applies, so FLSA overtime may not be owed at all, and the binding
    --     limit becomes the DOT on-duty ceiling plus driver-salesperson status.
    --
    -- Failing OPEN on a NULL weight (treating it as light, therefore OT-eligible)
    -- is the safe direction: a missing GVWR must never silently suppress an
    -- overtime obligation.
    COALESCE(v.MIN_TONNES <= pp.GVWR_T, TRUE)          AS OT_ELIGIBLE_FLSA,
    ROUND(v.MIN_TONNES, 3)::FLOAT                      AS MIN_VEHICLE_TONNES,
    IFF(COALESCE(v.MIN_TONNES <= pp.GVWR_T, TRUE), NULL,
        ROUND(COALESCE(dt.ONDUTY_7D_PEAK, 0), 2))::FLOAT AS DOT_ONDUTY_7D_HOURS,
    IFF(COALESCE(v.MIN_TONNES <= pp.GVWR_T, TRUE), NULL, pp.DOT_LIMIT)::FLOAT AS DOT_ONDUTY_LIMIT,
    IFF(COALESCE(v.MIN_TONNES <= pp.GVWR_T, TRUE), NULL,
        ROUND(DIV0(COALESCE(dt.ONDUTY_7D_PEAK, 0), pp.DOT_LIMIT), 4))::FLOAT AS DOT_ONDUTY_PCT,
    ROUND(rd.MAX_MILES, 1)::FLOAT                      AS MAX_RADIUS_MILES,
    -- NULL for a light vehicle (not applicable). For a CMV both tests must hold;
    -- a NULL radius (no routable destinations) fails open on that leg so a data
    -- gap does not read as a compliance breach.
    IFF(COALESCE(v.MIN_TONNES <= pp.GVWR_T, TRUE), NULL,
        (LEAST(1.0, DIV0(p.DRIVE_HOURS, p.HOURS_TO_DATE)) <= pp.DS_DRIVE_MAX
         AND COALESCE(rd.MAX_MILES <= pp.DS_RADIUS, TRUE))) AS DRIVER_SALESPERSON_OK,
    -- Which limit actually binds, evaluated within the applicable regime only.
    -- For a CMV, ordered by severity of consequence: an hours-of-service breach
    -- grounds the driver, and losing driver-salesperson status changes which HOS
    -- regime applies at all. For a light vehicle it is a pay question.
    CASE
      WHEN NOT COALESCE(v.MIN_TONNES <= pp.GVWR_T, TRUE) THEN
        CASE
          WHEN COALESCE(dt.ONDUTY_7D_PEAK, 0) >= pp.DOT_LIMIT                    THEN 'DOT_ONDUTY'
          WHEN LEAST(1.0, DIV0(p.DRIVE_HOURS, p.HOURS_TO_DATE)) > pp.DS_DRIVE_MAX THEN 'DS_DRIVE_PCT'
          WHEN COALESCE(rd.MAX_MILES, 0) > pp.DS_RADIUS                          THEN 'DS_RADIUS'
          ELSE 'NONE'
        END
      WHEN p.PROJ_HOURS >= pp.DOT_LIMIT                                          THEN 'POLICY_60'
      WHEN p.PROJ_HOURS >= p.T2                                                  THEN 'POLICY_50'
      WHEN p.PROJ_HOURS >= p.T1                                                  THEN 'FLSA_40'
      ELSE 'NONE'
    END                                                AS BINDING_CONSTRAINT,
    p.REGION,
    p.REGION_LABEL,
    p.VEHICLE_TYPE
  -- CROSS JOIN, not a comma join. A comma has LOWER precedence than an explicit
  -- JOIN, so `FROM proj p, params pp LEFT JOIN ops o ON o.X = p.X` parses as
  -- `proj p, (params pp LEFT JOIN ops o ...)` and `p` is not in scope inside that
  -- ON clause - it fails with a bare "invalid identifier 'P.OPERATOR_ID'".
  FROM proj p
  CROSS JOIN params pp
  LEFT JOIN ops o      ON o.OPERATOR_ID = p.OPERATOR_ID
  LEFT JOIN trip_wk tw ON tw.OPERATOR_ID = p.OPERATOR_ID AND tw.WEEK_START = p.WEEK_START
  LEFT JOIN veh v      ON v.OPERATOR_ID = p.OPERATOR_ID
  LEFT JOIN radius rd  ON rd.OPERATOR_ID = p.OPERATOR_ID
  LEFT JOIN dot dt     ON dt.OPERATOR_ID = p.OPERATOR_ID AND dt.WEEK_START = p.WEEK_START
$$;

-- ---------------------------------------------------------------------------
-- Global-active wrapper views.
--
-- These are what SV_LABOR binds to: a semantic view cannot pass a scope
-- argument, so it needs a plain relation. Each wrapper resolves the region's
-- ACTIVE dataset (both args NULL), matching the VW_* pattern in
-- scoped_contract.sql. The app itself calls the scoped UDTFs directly so each
-- session keeps its own scope.
--
-- Columns are listed EXPLICITLY rather than SELECT *, for two reasons. A view
-- freezes its column list at creation, so a SELECT * wrapper silently breaks
-- ("declared N columns, but view query produces M") the moment the function
-- signature gains a column - which is exactly what happened to
-- VW_PROPOSAL_DECISIONS and took SV_BACKLOAD_MATCHING (and therefore an entire
-- agent tool) down with it. And VW_LABOR_WEEK must add a surrogate key anyway:
-- the fact is grained by (operator, week) but a semantic view PRIMARY KEY wants
-- one column.
--
-- DUTY_PERIOD is deliberately NOT projected. A semantic view has no use for it:
-- PERIOD cannot be aggregated (SUM/AVG are unsupported and MAX is rejected), and
-- a canonical '[begin, end)' range string is not something anyone filters or
-- groups by in natural language. The typed bounds are exposed instead.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW FLEET_APP.LABOR.VW_LABOR_OPERATOR
  COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-labor-overtime","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
  AS SELECT
       OPERATOR_ID, OPERATOR_LABEL, SHIFT_TYPE, DRIVER_PROFILE, HOME_SITE_ID,
       TEAM_ID, SUPERVISOR_ID, CONTRACTED_HOURS_PER_WEEK, HOURLY_RATE,
       OT_MULTIPLIER, CURRENCY_CODE, REGION, REGION_LABEL, VEHICLE_TYPE
     FROM TABLE(FLEET_APP.LABOR.F_DIM_LABOR_OPERATOR_SCOPED(CAST(NULL AS VARCHAR), CAST(NULL AS VARCHAR)));

CREATE OR REPLACE VIEW FLEET_APP.LABOR.VW_DUTY_PERIOD
  COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-labor-overtime","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
  AS SELECT
       DUTY_ID, OPERATOR_ID, DUTY_SEQ, DUTY_START, DUTY_END,
       PAID_HOURS, DRIVE_HOURS, IDLE_HOURS, DRIVE_SHARE, TRIPS, DISTANCE_KM,
       REGION, REGION_LABEL, VEHICLE_TYPE
     FROM TABLE(FLEET_APP.LABOR.F_FACT_DUTY_PERIOD_SCOPED(CAST(NULL AS VARCHAR), CAST(NULL AS VARCHAR)));

CREATE OR REPLACE VIEW FLEET_APP.LABOR.VW_LABOR_WEEK
  COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-labor-overtime","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
  AS SELECT
       OPERATOR_ID || '|' || TO_VARCHAR(WEEK_START, 'YYYY-MM-DD') AS LABOR_WEEK_ID,
       OPERATOR_ID, WEEK_START, WEEK_END, WEEK_LABEL, TEAM_ID, SUPERVISOR_ID,
       SHIFT_TYPE, DRIVER_PROFILE, HOURS_TO_DATE, DAYS_WORKED, DAYS_ELAPSED,
       DAYS_REMAINING, IS_CURRENT_WEEK, IS_PARTIAL_START, PROJECTED_WEEK_HOURS,
       CONTRACTED_HOURS_PER_WEEK, STRAIGHT_HOURS, OT_HOURS, PROJECTED_OT_HOURS,
       HOURLY_RATE, EST_OT_COST, EST_OT_PREMIUM, CURRENCY_CODE,
       OT_PCT_OF_PAID, OT_PCT_OF_STRAIGHT, FTE_EQUIVALENT, OT_BAND,
       OT_THRESHOLD_1, OT_THRESHOLD_2, OT_THRESHOLD_3,
       DRIVE_HOURS, DRIVE_SHARE_OF_PAID, TRIPS, DISTANCE_KM,
       KM_PER_PAID_HOUR, STOPS_PER_PAID_HOUR,
       OT_ELIGIBLE_FLSA, MIN_VEHICLE_TONNES,
       DOT_ONDUTY_7D_HOURS, DOT_ONDUTY_LIMIT, DOT_ONDUTY_PCT,
       MAX_RADIUS_MILES, DRIVER_SALESPERSON_OK, BINDING_CONSTRAINT,
       REGION, REGION_LABEL, VEHICLE_TYPE
     FROM TABLE(FLEET_APP.LABOR.F_FACT_LABOR_WEEK_SCOPED(CAST(NULL AS VARCHAR), CAST(NULL AS VARCHAR)));

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

GRANT SELECT ON ALL VIEWS IN SCHEMA FLEET_APP.LABOR TO ROLE FLEET_APP_USER;
GRANT SELECT ON ALL VIEWS IN SCHEMA FLEET_APP.LABOR TO ROLE FLEET_APP_OPS;
GRANT SELECT ON ALL VIEWS IN SCHEMA FLEET_APP.LABOR TO ROLE FLEET_APP_ADMIN;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA FLEET_APP.LABOR TO ROLE FLEET_APP_USER;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA FLEET_APP.LABOR TO ROLE FLEET_APP_OPS;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA FLEET_APP.LABOR TO ROLE FLEET_APP_ADMIN;
