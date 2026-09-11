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
-- 4. AN OPERATOR IS (REGION, DRIVER_ID), NEVER DRIVER_ID ALONE.
--    Driver ids are index-derived per region and are therefore REUSED across
--    regions: measured on a two-region account, 100 SanFrancisco ids and 47
--    UsTexas ids yielded only 100 distinct values, meaning every UsTexas driver
--    shared an id with a different SanFrancisco driver. Sessionizing or grouping
--    on the bare id silently fuses two different people into one whenever more
--    than one region is in scope - their trips interleave into duty periods that
--    belong to neither, and ANY_VALUE(REGION) then files the composite under
--    whichever region happens to win. Measured cost before the fix: the unscoped
--    call returned 118 operators and 8,371 paid hours against 147 and 9,299 from
--    the sum of the per-region calls, losing 29 operators and 10% of all hours.
--
--    Nothing failed, which is why this needed a test rather than a review: the
--    app never saw it because the app always passes a region, while SV_LABOR and
--    VW_LABOR_WEEK pass none, so the defect was confined to the AGENT's answers.
--    verify_labor_layer.sql CHECK 16 now asserts that the per-region scoped read
--    returns exactly the weeks, duty periods and operators the unscoped read
--    attributes to that region - a roster-additivity test on COUNTS. Hours are
--    guarded separately: CHECK 1 asserts duty-to-weekly hours conservation within
--    a scope, so a fused grain that inflated hours fails there.
--
--    Vehicle and location ids are globally unique (measured: 150 and 12,978
--    distinct either way), so joins on those keys are deliberately left bare -
--    region-qualifying them would add noise without removing a defect.
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
  GVWR_OT_THRESHOLD_TONNES  FLOAT,
  -- SUBSTANTIVE_DAY_MIN_SHARE - what fraction of a region's MEDIAN daily trip
  --   volume a day must reach to count as a real operating day. It exists because
  --   a generated dataset stops mid-day rather than on a clean boundary, so the
  --   last calendar day carries a taper: measured on this account, SanFrancisco's
  --   final day held 21 trips against a 1,933/day median (1.1%) and UsTexas held
  --   6 against 71 (8.5%). Anchoring the as-of instant on that raw maximum put
  --   the "current week" inside a one-day stub, and since every panel of the
  --   Labour and Overtime view filters IS_CURRENT_WEEK, the whole dashboard
  --   collapsed to the operators who happened to work in the stub - 15 of 47 in
  --   UsTexas. Trimming the taper moves the anchor back to the last real day and
  --   restores the roster, while keeping days remaining above zero so the
  --   projection the view exists to show is still a projection.
  --
  --   It is CONFIGURATION rather than a literal for the same reason the overtime
  --   thresholds are: a fleet whose real volume swings by day of week needs a
  --   looser share than one with flat volume. 0.50 separates cleanly here (the
  --   last real day scores 99.5% and 111.3% of median, the taper 1.1% to 38.0%).
  --   Because half of all days are at or above the median by definition, some day
  --   always qualifies, so this can never trim a dataset down to nothing.
  SUBSTANTIVE_DAY_MIN_SHARE FLOAT
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

-- SUBSTANTIVE_DAY_MIN_SHARE gets its OWN guard rather than joining the ALTER
-- above. That ALTER adds five columns as one statement under a catch-all
-- handler, so on an account that already has the compliance columns it fails as
-- a whole and returns 'already present' - appending a sixth column to it would
-- mean the new column is silently never added on exactly the accounts that need
-- upgrading. One guard per migration wave keeps each one independently
-- idempotent.
CREATE OR REPLACE PROCEDURE FLEET_APP.LABOR._ADD_SUBSTANTIVE_SHARE_IF_MISSING()
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-labor-overtime","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
EXECUTE AS CALLER
AS
$$
BEGIN
  ALTER TABLE FLEET_APP.LABOR.LABOR_CONFIG ADD COLUMN SUBSTANTIVE_DAY_MIN_SHARE FLOAT;
  RETURN 'added';
EXCEPTION
  WHEN OTHER THEN RETURN 'already present';
END;
$$;
CALL FLEET_APP.LABOR._ADD_SUBSTANTIVE_SHARE_IF_MISSING();
DROP PROCEDURE IF EXISTS FLEET_APP.LABOR._ADD_SUBSTANTIVE_SHARE_IF_MISSING();

-- Idempotent seed of the global default row only. Per-region overrides are
-- operator-owned and are never touched by a redeploy.
DELETE FROM FLEET_APP.LABOR.LABOR_CONFIG WHERE REGION = '*' AND VEHICLE_TYPE = '*';
INSERT INTO FLEET_APP.LABOR.LABOR_CONFIG
  (REGION, VEHICLE_TYPE, DUTY_GAP_MINUTES, OT_THRESHOLD_1, OT_THRESHOLD_2, OT_THRESHOLD_3,
   OT_MULTIPLIER, WEEK_START_DOW, CONTRACTED_HOURS_PER_WEEK, HOURLY_RATE_MIN, HOURLY_RATE_MAX,
   TEAM_COUNT, CURRENCY_CODE,
   DOT_ONDUTY_LIMIT_7D, DOT_ONDUTY_LIMIT_8D, DS_MAX_DRIVE_SHARE, DS_RADIUS_MILES,
   GVWR_OT_THRESHOLD_TONNES, SUBSTANTIVE_DAY_MIN_SHARE)
VALUES
  ('*', '*', 240, 40, 50, 60, 1.5, 7, 40, 22.0, 34.0, 8, 'USD',
   60, 70, 0.50, 100, 4.536, 0.50);

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
    SELECT VEHICLE_ID, REGION, VEHICLE_TYPE, SHIFT_TYPE, DRIVER_PROFILE, HOME_LOCATION_ID,
           ROW_NUMBER() OVER (
             PARTITION BY REGION, VEHICLE_TYPE, VEHICLE_ID ORDER BY SHIFT_TYPE
           ) AS RN
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
  -- The operator's grain is (REGION, VEHICLE_TYPE, OPERATOR_ID), not OPERATOR_ID.
  -- Vehicle and driver ids are index-derived per dataset, so DRV-00009 and its
  -- vehicle exist in every region; grouping on the id alone merged two different
  -- people into one row and then picked one of their regions with ANY_VALUE.
  ops AS (
    SELECT
      t.REGION,
      t.VEHICLE_TYPE,
      t.DRIVER_ID                        AS OPERATOR_ID,
      ANY_VALUE(f.SHIFT_TYPE)            AS SHIFT_TYPE,
      ANY_VALUE(f.DRIVER_PROFILE)        AS DRIVER_PROFILE,
      ANY_VALUE(f.HOME_LOCATION_ID)      AS HOME_SITE_ID
    FROM trips t
    LEFT JOIN fleet f
      ON t.VEHICLE_ID = f.VEHICLE_ID
     AND EQUAL_NULL(f.REGION, t.REGION)
     AND EQUAL_NULL(f.VEHICLE_TYPE, t.VEHICLE_TYPE)
     AND f.RN = 1
    GROUP BY t.REGION, t.VEHICLE_TYPE, t.DRIVER_ID
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
--
-- P_FROM / P_TO are the analysis window (inclusive dates, either may be NULL for
-- unbounded) fed by the app's global date-range picker. Sessionization runs over
-- the FULL scope and the window is applied to the RESULT as an overlap test, not
-- as a predicate on the input trips. Filtering the trips first would cut a duty
-- period at the window edge and report a fragment of a shift as a whole shift -
-- a driver who started at 22:00 on the last selected day would appear to have
-- worked two hours. Overlap semantics mean a duty period straddling either edge
-- is returned whole, which is also what keeps the hour-conservation equality in
-- verify_labor_layer.sql true under a narrowed window.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION FLEET_APP.LABOR.F_FACT_DUTY_PERIOD_SCOPED(
  P_REGION VARCHAR, P_DATASET_ID VARCHAR, P_FROM DATE, P_TO DATE)
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
  -- SESSIONIZATION IS PER (REGION, VEHICLE_TYPE, OPERATOR). Operator ids are
  -- index-derived per dataset, so DRV-00009 exists in EVERY region, and
  -- partitioning by DRIVER_ID alone fuses two different people the moment the
  -- scope covers more than one dataset. That is not a rounding error: with both
  -- args NULL the trips of a San Francisco courier and a Texas HGV driver
  -- interleave into one gap-based session, so 607 real duty periods collapsed to
  -- 519 and the longest span fell from 215.49h to 96.31h - the sessionization
  -- itself changes, which is why the hours-conservation check cannot see it (it
  -- compares two equally regrouped totals). (REGION, VEHICLE_TYPE) is the key
  -- because DIM_DATASETS keys an ACTIVE dataset on exactly that pair, so a region
  -- may legitimately carry two populations at once.
  flagged AS (
    SELECT t.*,
           LAG(t.TRIP_END) OVER (
             PARTITION BY t.REGION, t.VEHICLE_TYPE, t.DRIVER_ID ORDER BY t.TRIP_START
           ) AS PREV_END,
           -- Latest end seen so far for this operator, used to strip the part of
           -- this trip that OVERLAPS an earlier one. The generator can assign a
           -- driver two trips at once (measured: 15 negative gaps on UsTexas), and
           -- summing raw durations then counts those minutes twice, which pushed
           -- DRIVE_HOURS above PAID_HOURS in 17 operator-weeks. LAG is not enough
           -- here - the overlapping trip need not be the immediately preceding one.
           MAX(t.TRIP_END) OVER (
             PARTITION BY t.REGION, t.VEHICLE_TYPE, t.DRIVER_ID ORDER BY t.TRIP_START
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
             PARTITION BY s.REGION, s.VEHICLE_TYPE, s.DRIVER_ID ORDER BY s.TRIP_START
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           ) AS DUTY_SEQ
    FROM seeded s
  )
  SELECT
    -- Region and vehicle type belong in the key: DUTY_ID is the PRIMARY KEY of
    -- the duty table in SV_LABOR, and DRIVER_ID|DUTY_SEQ is not unique across
    -- datasets that share operator ids.
    g.REGION || '|' || g.VEHICLE_TYPE || '|' || g.DRIVER_ID
      || '|' || TO_VARCHAR(g.DUTY_SEQ)                    AS DUTY_ID,
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
    g.REGION                                               AS REGION,
    FLEET_APP.CORE.REGION_LABEL(g.REGION)                  AS REGION_LABEL,
    g.VEHICLE_TYPE                                         AS VEHICLE_TYPE
  FROM grouped g
  GROUP BY g.REGION, g.VEHICLE_TYPE, g.DRIVER_ID, g.DUTY_SEQ
  -- Overlap test, applied AFTER the aggregate so the duty period is intact:
  -- keep it when it ends at or after the window start and begins before the
  -- window end. P_TO is an inclusive DATE, so the exclusive upper bound is the
  -- following midnight.
  HAVING (P_FROM IS NULL OR MAX(g.TRIP_END)   >= P_FROM::TIMESTAMP_NTZ)
     AND (P_TO   IS NULL OR MIN(g.TRIP_START) <  DATEADD('day', 1, P_TO)::TIMESTAMP_NTZ)
$$;

-- Two-arg overload: the whole dataset, unbounded. Retained because the wrapper
-- views, SV_LABOR, the overtime alert and every existing caller bind to this
-- signature, and because the agent has no date picker to read a window from.
-- SELECT * is correct HERE, unlike in a view: a UDTF's RETURNS TABLE is declared
-- explicitly, so a column added to the four-arg form and not to this one is a
-- hard error at CREATE time during install rather than a silent drift.
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
  SELECT * FROM TABLE(FLEET_APP.LABOR.F_FACT_DUTY_PERIOD_SCOPED(
    P_REGION, P_DATASET_ID, CAST(NULL AS DATE), CAST(NULL AS DATE)))
$$;

-- ---------------------------------------------------------------------------
-- F_FACT_LABOR_WEEK_SCOPED - per operator per payroll week, with a projection.
--
-- WEEK ALLOCATION. Each duty period is intersected with the payroll week(s) it
-- touches - one segment per week TOUCHED, generated from an offset table, so a
-- duty period of any length conserves its hours. PERIOD_INTERSECT is guaranteed
-- non-NULL for each emitted week because the period demonstrably overlaps it.
--
-- THE GRAIN IS (REGION, VEHICLE_TYPE, OPERATOR_ID, WEEK_START). Operator ids are
-- index-derived per dataset, so DRV-00009 exists in every region and the region
-- keys are NOT decoration - drop them from the grain and two different people are
-- summed into one row.
--
-- PROJECTION. "Now" is derived from the DATASET, not from CURRENT_TIMESTAMP:
-- the data is historical, so against wall-clock time every week would be
-- complete and the projection would be dead. For the week containing that as-of
-- instant, hours are extrapolated by linear daily run rate (hours so far / days
-- elapsed * 7). Completed weeks project to their actual. This is the "it is
-- Tuesday, who will pass 60 by Friday" number.
--
-- THE AS-OF INSTANT IS PER REGION AND IS TRIMMED, AND BOTH HALVES ARE LOAD-BEARING.
-- It used to be a single unpartitioned MAX(DUTY_END) over everything in scope,
-- which failed in two independent ways at once.
--
--   Trimming. A generated dataset stops mid-day, so its last calendar day is a
--   taper rather than a full day of work - 21 trips against a 1,933/day median
--   in SanFrancisco, 6 against 71 in UsTexas. The raw maximum therefore landed
--   inside a one-day stub, and because every panel of the Labour and Overtime
--   view filters IS_CURRENT_WEEK, the dashboard showed only the operators who
--   happened to work in that stub: 15 of 47. Note the symmetric case at the
--   START of a dataset was already guarded by IS_PARTIAL_S below, whose comment
--   explains that an unlabelled truncated week "reads as a fleet-wide drop in
--   hours" - the same defect at the other end went unguarded. The anchor is now
--   the last day whose trip volume reaches SUBSTANTIVE_DAY_MIN_SHARE of that
--   region's median daily volume.
--
--   Partitioning. Because MAX was unpartitioned, the freshest region set the
--   anchor for every region. Measured on a two-region account: called with no
--   region the current-week headcount was 15, while SanFrancisco called on its
--   own returned 100 - the UsTexas tail had pushed the shared anchor into a week
--   where SanFrancisco had almost no activity, pruning it out. That matters most
--   on the agent path, since SV_LABOR and VW_LABOR_WEEK read this function with
--   no region argument at all.
--
-- P_FROM / P_TO are the app's global date-range picker (inclusive dates, either
-- may be NULL). They CLAMP the trimmed per-region bound rather than replacing
-- it, so narrowing the range moves the current week earlier and the trim still
-- protects the unbounded default that the agent and the alert use.
--
-- TRIPS and DISTANCE are attributed to the week containing TRIP_START, which is
-- exact and keeps trip counts integral, whereas PAID_HOURS is allocated by
-- intersection. For a duty period straddling midnight on the week boundary the
-- two can disagree slightly, so DRIVE_SHARE_OF_PAID is capped at 1.0.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION FLEET_APP.LABOR.F_FACT_LABOR_WEEK_SCOPED(
  P_REGION VARCHAR, P_DATASET_ID VARCHAR, P_FROM DATE, P_TO DATE)
RETURNS TABLE (
  OPERATOR_ID VARCHAR, WEEK_START DATE, WEEK_END DATE, WEEK_LABEL VARCHAR,
  TEAM_ID VARCHAR, SUPERVISOR_ID VARCHAR, SHIFT_TYPE VARCHAR, DRIVER_PROFILE VARCHAR,
  HOURS_TO_DATE FLOAT, DAYS_WORKED NUMBER, DAYS_ELAPSED NUMBER, DAYS_REMAINING NUMBER,
  IS_CURRENT_WEEK BOOLEAN, IS_PARTIAL_START BOOLEAN, IS_PARTIAL_END BOOLEAN, PROJECTED_WEEK_HOURS FLOAT,
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
    SELECT * FROM TABLE(FLEET_APP.LABOR.F_FACT_DUTY_PERIOD_SCOPED(P_REGION, P_DATASET_ID, P_FROM, P_TO))
  ),
  ops AS (
    SELECT * FROM TABLE(FLEET_APP.LABOR.F_DIM_LABOR_OPERATOR_SCOPED(P_REGION, P_DATASET_ID))
  ),
  trips AS (
    SELECT DRIVER_ID, REGION, VEHICLE_TYPE, TRIP_START, DISTANCE_KM, DURATION_MINUTES
    FROM TABLE(FLEET_APP.UNIFIED_FLEET.F_VW_FACT_TRIPS_SCOPED(P_REGION, P_DATASET_ID))
    WHERE TRIP_START IS NOT NULL
      AND (P_FROM IS NULL OR TRIP_START >= P_FROM::TIMESTAMP_NTZ)
      AND (P_TO   IS NULL OR TRIP_START <  DATEADD('day', 1, P_TO)::TIMESTAMP_NTZ)
  ),
  -- Distinct scope pairs actually present in the data. Config is resolved PER
  -- (region, vehicle_type), NOT once for the whole call.
  scopes AS (
    SELECT DISTINCT REGION AS RG, VEHICLE_TYPE AS VT FROM duty
  ),
  -- Thresholds, the payroll week-start day, the DOT on-duty ceiling, the
  -- driver-salesperson limits and the GVWR boundary are JURISDICTION config: US
  -- FLSA is 40h weekly, the EU uses a 48h average. The old resolver collapsed the
  -- whole scope to ONE row via ANY_VALUE(region), so the moment a region-specific
  -- LABOR_CONFIG row existed, one region's rules silently applied to every region.
  -- Inert while only the '*'/'*' row exists, but it defeated the table's entire
  -- purpose. Resolve one row per scope pair, taking the MOST SPECIFIC matching row
  -- (an exact region+type match beats a wildcard). LEFT JOIN so a pair with no
  -- matching row still yields a row and COALESCEs to the defaults below - a region
  -- can never lose its config and drop out of the joins that consume params.
  cfg AS (
    SELECT s.RG, s.VT,
           c.OT_THRESHOLD_1, c.OT_THRESHOLD_2, c.OT_THRESHOLD_3, c.WEEK_START_DOW,
           c.DOT_ONDUTY_LIMIT_7D, c.DS_MAX_DRIVE_SHARE, c.DS_RADIUS_MILES,
           c.GVWR_OT_THRESHOLD_TONNES, c.SUBSTANTIVE_DAY_MIN_SHARE
    FROM scopes s
    LEFT JOIN FLEET_APP.LABOR.LABOR_CONFIG c
      ON (c.REGION = s.RG OR c.REGION = '*')
     AND (c.VEHICLE_TYPE = s.VT OR c.VEHICLE_TYPE = '*')
    QUALIFY ROW_NUMBER() OVER (
      PARTITION BY s.RG, s.VT
      ORDER BY IFF(c.REGION = '*', 1, 0) + IFF(c.VEHICLE_TYPE = '*', 1, 0)
    ) = 1
  ),
  -- One resolved row per scope pair, defaults applied. Carries RG/VT so every
  -- consumer joins on its own region and vehicle type rather than CROSS JOINing a
  -- single global row.
  params AS (
    SELECT RG, VT,
      COALESCE(OT_THRESHOLD_1, 40) AS T1,
      COALESCE(OT_THRESHOLD_2, 50) AS T2,
      COALESCE(OT_THRESHOLD_3, 60) AS T3,
      COALESCE(WEEK_START_DOW, 7)  AS DOW,
      COALESCE(DOT_ONDUTY_LIMIT_7D, 60)      AS DOT_LIMIT,
      COALESCE(DS_MAX_DRIVE_SHARE, 0.50)     AS DS_DRIVE_MAX,
      COALESCE(DS_RADIUS_MILES, 100)         AS DS_RADIUS,
      COALESCE(GVWR_OT_THRESHOLD_TONNES, 4.536) AS GVWR_T,
      COALESCE(SUBSTANTIVE_DAY_MIN_SHARE, 0.50) AS MIN_SHARE
    FROM cfg
  ),
  -- MIN_SHARE at region grain for the as-of trim below, which is region-only.
  -- MIN() collapses the unlikely case of two vehicle types in one region to a
  -- single value; MIN_SHARE is a dataset-tapering knob, not a per-vehicle law.
  region_min_share AS (
    SELECT RG AS REGION, MIN(MIN_SHARE) AS MIN_SHARE FROM params GROUP BY RG
  ),
  -- ==========================================================================
  -- Per-region as-of anchor
  -- ==========================================================================
  -- Daily trip volume per region, read over the FULL scope and deliberately NOT
  -- through the window-filtered `trips` CTE above: the substantive bound is a
  -- property of the DATASET, and P_TO then clamps it. Reading a filtered input
  -- would make the trim self-referential - a narrowed range would redefine its
  -- own median and could trim again inside the user's selection.
  day_act AS (
    SELECT REGION, TRIP_START::DATE AS D, COUNT(*) AS TRIPS
    FROM TABLE(FLEET_APP.UNIFIED_FLEET.F_VW_FACT_TRIPS_SCOPED(P_REGION, P_DATASET_ID))
    WHERE TRIP_START IS NOT NULL
    GROUP BY 1, 2
  ),
  -- Last day per region that looks like a real operating day. At least half of a
  -- region's days are at or above its own median by definition, so with any
  -- MIN_SHARE at or below 1.0 this always yields a row per region and can never
  -- empty a region out.
  substantive AS (
    SELECT r.REGION, MAX(D) AS LAST_SUBSTANTIVE_D
    FROM (
      SELECT REGION, D, TRIPS, MEDIAN(TRIPS) OVER (PARTITION BY REGION) AS MED_TRIPS
      FROM day_act
    ) r
    JOIN region_min_share ms ON EQUAL_NULL(ms.REGION, r.REGION)
    WHERE r.TRIPS >= r.MED_TRIPS * ms.MIN_SHARE
    GROUP BY r.REGION
  ),
  region_span AS (
    SELECT REGION, MIN(DUTY_START) AS FIRST_DUTY_TS, MAX(DUTY_END) AS LAST_DUTY_TS
    FROM duty
    GROUP BY REGION
  ),
  -- The trimmed bound expressed as the LAST INSTANT of the substantive day
  -- (23:59:59), not the following midnight. AS_OF_TS::DATE drives DAYS_ELAPSED,
  -- so rounding up to midnight would credit the week with an extra elapsed day
  -- and understate every projection by a seventh. Falls back to the raw duty
  -- maximum if a region somehow has duty but no trip days, so a region can never
  -- lose its anchor and disappear.
  region_avail AS (
    SELECT r.REGION,
           COALESCE(
             DATEADD('second', -1, DATEADD('day', 1, s.LAST_SUBSTANTIVE_D))::TIMESTAMP_NTZ,
             r.LAST_DUTY_TS
           ) AS AVAIL_TS,
           r.FIRST_DUTY_TS
    FROM region_span r
    LEFT JOIN substantive s ON EQUAL_NULL(s.REGION, r.REGION)
  ),
  -- EQUAL_NULL rather than = on the join below, and here: REGION is carried
  -- through ANY_VALUE() aggregates upstream, so a NULL region would silently
  -- drop every one of its rows out of an equality join rather than failing.
  region_window AS (
    SELECT REGION,
           LEAST(AVAIL_TS,
                 COALESCE(DATEADD('second', -1, DATEADD('day', 1, P_TO))::TIMESTAMP_NTZ,
                          AVAIL_TS)) AS AS_OF_TS,
           GREATEST(FIRST_DUTY_TS,
                    COALESCE(P_FROM::TIMESTAMP_NTZ, FIRST_DUTY_TS)) AS FIRST_TS
    FROM region_avail
  ),
  -- Week start for an instant, computed arithmetically so it does not depend on
  -- the session WEEK_START parameter.
  bounded AS (
    SELECT d.*,
           p.T1, p.T2, p.T3, p.DOW, rw.AS_OF_TS, rw.FIRST_TS,
           DATEADD('day', -MOD(DAYOFWEEKISO(d.DUTY_START) - p.DOW + 7, 7), d.DUTY_START::DATE) AS WK_BEGIN,
           DATEADD('day', -MOD(DAYOFWEEKISO(d.DUTY_END)   - p.DOW + 7, 7), d.DUTY_END::DATE)   AS WK_END
    -- params is now per (region, vehicle_type), so JOIN on the scope keys rather
    -- than CROSS JOIN a single global row. Explicit JOIN, never a comma: a comma
    -- has LOWER precedence than an explicit JOIN, so `FROM duty d, params p JOIN
    -- region_window rw ON ...` parses as `duty d, (params p JOIN region_window rw
    -- ...)` and `d` is not in scope inside that ON clause.
    FROM duty d
    JOIN params p
      ON EQUAL_NULL(p.RG, d.REGION) AND EQUAL_NULL(p.VT, d.VEHICLE_TYPE)
    JOIN region_window rw ON EQUAL_NULL(rw.REGION, d.REGION)
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
  --
  -- SEG_END is the EXCLUSIVE end of the intersect with [WEEK_START, WEEK_START+7),
  -- so for a segment covering the whole week it is midnight on the FOLLOWING
  -- Sunday - a day the operator did not work. Bounding on `SEG_END::DATE`
  -- therefore counted 8 days in a 7-day week and reported DAYS_WORKED above
  -- DAYS_ELAPSED, an impossibility that reached the dashboard on 5 UsTexas
  -- operator-weeks. Bound on the last instant INSIDE the segment instead. The
  -- GREATEST keeps a zero-length segment (a duty period whose intersect with the
  -- week is a single instant) on its own date rather than the day before.
  day_offsets AS (
    SELECT SEQ4() AS N FROM TABLE(GENERATOR(ROWCOUNT => 7))
  ),
  seg_days AS (
    SELECT s.OPERATOR_ID, s.REGION, s.VEHICLE_TYPE, s.WEEK_START,
           DATEADD('day', d.N, s.SEG_BEGIN::DATE) AS D
    FROM seg_hours s
    JOIN day_offsets d
      ON DATEADD('day', d.N, s.SEG_BEGIN::DATE)
         <= GREATEST(s.SEG_BEGIN::DATE, DATEADD('second', -1, s.SEG_END)::DATE)
  ),
  days AS (
    SELECT OPERATOR_ID, REGION, VEHICLE_TYPE, WEEK_START, COUNT(DISTINCT D) AS DAYS_WORKED
    FROM seg_days
    GROUP BY OPERATOR_ID, REGION, VEHICLE_TYPE, WEEK_START
  ),
  -- The weekly grain is (REGION, VEHICLE_TYPE, OPERATOR_ID, WEEK_START). Leaving
  -- region out did not merely mislabel a row: it SUMMED the hours of two different
  -- people who share an index-derived operator id, so a call with no region
  -- returned 196 operator-weeks where the two regions hold 256, and produced weeks
  -- of 170.05 paid hours - more than a week contains.
  wk AS (
    SELECT
      OPERATOR_ID, REGION, VEHICLE_TYPE, WEEK_START,
      -- Functionally dependent on REGION, so it needs no group key of its own.
      ANY_VALUE(REGION_LABEL) AS REGION_LABEL,
      ANY_VALUE(T1) AS T1, ANY_VALUE(T2) AS T2, ANY_VALUE(T3) AS T3,
      ANY_VALUE(AS_OF_TS) AS AS_OF_TS,
      ANY_VALUE(FIRST_TS) AS FIRST_TS,
      SUM(SEG_HOURS)               AS HOURS_TO_DATE,
      SUM(SEG_DRIVE_HOURS)         AS DRIVE_HOURS
    FROM seg_hours
    GROUP BY OPERATOR_ID, REGION, VEHICLE_TYPE, WEEK_START
  ),
  -- Trips attributed to the week containing TRIP_START: exact, integral counts.
  trip_wk AS (
    SELECT t.DRIVER_ID AS OPERATOR_ID, t.REGION, t.VEHICLE_TYPE,
           DATEADD('day', -MOD(DAYOFWEEKISO(t.TRIP_START) - p.DOW + 7, 7), t.TRIP_START::DATE) AS WEEK_START,
           COUNT(*) AS TRIPS,
           SUM(t.DISTANCE_KM) AS DISTANCE_KM
    FROM trips t, params p
    GROUP BY 1, 2, 3, 4
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
      -- The whole week lies PAST the region's trimmed as-of anchor: it is the
      -- tapering tail of the dataset (a handful of trips on the last calendar day
      -- before the data stops), not a real operating week. This is the symmetric
      -- twin of IS_PARTIAL_S above - the START-of-dataset case was guarded, the
      -- END-of-dataset case was not - and it reached the dashboard: a UsTexas week
      -- of 15 rows past the anchor made the trend chart (which filters
      -- NOT IS_PARTIAL_START) read as overtime collapsing from 52,825 to 30, and
      -- made the projection assert those operators finish the week on ~16 hours.
      -- Such a week is NOT current and NOT partial-start, so it needs its own flag;
      -- consumers that plot a week-over-week series must exclude it exactly as they
      -- exclude a partial-start week.
      (w.WEEK_START::TIMESTAMP_NTZ > w.AS_OF_TS)                                 AS IS_PARTIAL_E,
      d.DAYS_WORKED
    FROM wk w
    JOIN days d
      ON d.OPERATOR_ID = w.OPERATOR_ID AND d.WEEK_START = w.WEEK_START
     AND EQUAL_NULL(d.REGION, w.REGION)
     AND EQUAL_NULL(d.VEHICLE_TYPE, w.VEHICLE_TYPE)
  ),
  proj AS (
    SELECT c.*,
           7 - c.DAYS_ELAPSED_C AS DAYS_REMAINING_C,
           -- Clamped at 168, the number of hours a week contains. A run rate taken
           -- over very few elapsed days can otherwise project past what a week even
           -- holds, and a figure above 168 is not a forecast. The clamp is a floor
           -- under nonsense, not a fix: when it binds, look at the input hours.
           --
           -- GREATEST(HOURS_TO_DATE, ...) because a clamp with no floor can put the
           -- forecast BELOW the hours already worked: with the pre-fix region
           -- fusion an operator-week held 170.05 hours and this column reported a
           -- projection of 168, i.e. a prediction that someone will end the week
           -- with fewer hours than they have. The floor makes that impossible
           -- regardless of how the input hours arise.
           ROUND(GREATEST(c.HOURS_TO_DATE,
                          LEAST(168, IFF(c.IS_CUR,
                            DIV0(c.HOURS_TO_DATE, c.DAYS_ELAPSED_C) * 7,
                            c.HOURS_TO_DATE))), 2) AS PROJ_HOURS
    FROM calc c
  ),
  -- ==========================================================================
  -- Compliance layer
  -- ==========================================================================
  -- Vehicle weight per operator. The FLSA small-vehicle exception turns on the
  -- LIGHTEST vehicle worked in the week: if any vehicle is at or under the
  -- threshold, overtime applies to the WHOLE workweek even though heavier
  -- vehicles were also driven. So MIN, never MAX or AVG.
  --
  -- Deliberately read over the FULL scope and NOT through the window-filtered
  -- `trips` CTE. This and `radius` below are operator ATTRIBUTES - which vehicle
  -- class a person works and how far they range - so narrowing the date picker to
  -- a week must not flip somebody's FLSA regime merely because they happened not
  -- to take the light van in that week. (Both are already coarser than the law,
  -- which scopes the test to the workweek; that pre-existing grain simplification
  -- is unchanged here rather than compounded by the window.)
  veh AS (
    SELECT t.DRIVER_ID AS OPERATOR_ID, t.REGION, t.VEHICLE_TYPE,
           MIN(f.WEIGHT_TONS) AS MIN_TONNES
    FROM TABLE(FLEET_APP.UNIFIED_FLEET.F_VW_FACT_TRIPS_SCOPED(P_REGION, P_DATASET_ID)) t
    JOIN (
      SELECT VEHICLE_ID, REGION, VEHICLE_TYPE, WEIGHT_TONS,
             ROW_NUMBER() OVER (
               PARTITION BY REGION, VEHICLE_TYPE, VEHICLE_ID ORDER BY SHIFT_TYPE
             ) AS RN
      FROM TABLE(FLEET_APP.UNIFIED_FLEET.F_VW_DIM_FLEET_SCOPED(P_REGION, P_DATASET_ID))
    ) f ON f.VEHICLE_ID = t.VEHICLE_ID
       AND EQUAL_NULL(f.REGION, t.REGION)
       AND EQUAL_NULL(f.VEHICLE_TYPE, t.VEHICLE_TYPE)
       AND f.RN = 1
    GROUP BY t.DRIVER_ID, t.REGION, t.VEHICLE_TYPE
  ),
  -- Furthest trip destination from the operator's reporting point, in air miles.
  -- The driver-salesperson definition and the short-haul exception are both
  -- RADIUS tests from the reporting location, not route-distance tests, so this
  -- is a straight-line ST_DISTANCE and deliberately not a road distance.
  home AS (
    SELECT f.VEHICLE_ID, f.REGION, f.VEHICLE_TYPE, p.POINT_GEOM AS HOME_GEOG
    FROM (
      SELECT VEHICLE_ID, REGION, VEHICLE_TYPE, HOME_LOCATION_ID,
             ROW_NUMBER() OVER (
               PARTITION BY REGION, VEHICLE_TYPE, VEHICLE_ID ORDER BY SHIFT_TYPE
             ) AS RN
      FROM TABLE(FLEET_APP.UNIFIED_FLEET.F_VW_DIM_FLEET_SCOPED(P_REGION, P_DATASET_ID))
    ) f
    JOIN TABLE(FLEET_APP.UNIFIED_FLEET.F_VW_DIM_POIS_SCOPED(P_REGION, P_DATASET_ID)) p
      ON p.LOCATION_ID = f.HOME_LOCATION_ID
     AND EQUAL_NULL(p.REGION, f.REGION)
    WHERE f.RN = 1
  ),
  radius AS (
    SELECT t.DRIVER_ID AS OPERATOR_ID, t.REGION, t.VEHICLE_TYPE,
           MAX(ST_DISTANCE(h.HOME_GEOG, t.DESTINATION) / 1609.34) AS MAX_MILES
    FROM TABLE(FLEET_APP.UNIFIED_FLEET.F_VW_FACT_TRIPS_SCOPED(P_REGION, P_DATASET_ID)) t
    JOIN home h ON h.VEHICLE_ID = t.VEHICLE_ID
               AND EQUAL_NULL(h.REGION, t.REGION)
               AND EQUAL_NULL(h.VEHICLE_TYPE, t.VEHICLE_TYPE)
    WHERE t.DESTINATION IS NOT NULL
    GROUP BY t.DRIVER_ID, t.REGION, t.VEHICLE_TYPE
  ),
  -- Rolling 7-CONSECUTIVE-DAY on-duty total, which is the DOT window and is NOT
  -- the payroll week. Reported per payroll week as the PEAK exposure whose window
  -- ends inside that week, since that is the number that would have triggered a
  -- violation.
  duty_day AS (
    SELECT OPERATOR_ID, REGION, VEHICLE_TYPE, DUTY_START::DATE AS D, SUM(PAID_HOURS) AS H
    FROM duty GROUP BY OPERATOR_ID, REGION, VEHICLE_TYPE, DUTY_START::DATE
  ),
  duty_roll AS (
    SELECT OPERATOR_ID, REGION, VEHICLE_TYPE, D,
           SUM(H) OVER (
             PARTITION BY REGION, VEHICLE_TYPE, OPERATOR_ID ORDER BY D
             RANGE BETWEEN INTERVAL '6 days' PRECEDING AND CURRENT ROW
           ) AS ONDUTY_7D
    FROM duty_day
  ),
  dot AS (
    SELECT r.OPERATOR_ID, r.REGION, r.VEHICLE_TYPE,
           DATEADD('day', -MOD(DAYOFWEEKISO(r.D) - p.DOW + 7, 7), r.D) AS WEEK_START,
           MAX(r.ONDUTY_7D) AS ONDUTY_7D_PEAK
    FROM duty_roll r, params p
    GROUP BY 1, 2, 3, 4
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
    p.IS_PARTIAL_E                                     AS IS_PARTIAL_END,
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
  -- params is per (region, vehicle_type), so it JOINs on the scope keys. Explicit
  -- JOIN, not a comma: a comma has LOWER precedence than an explicit
  -- JOIN, so `FROM proj p, params pp LEFT JOIN ops o ON o.X = p.X` parses as
  -- `proj p, (params pp LEFT JOIN ops o ...)` and `p` is not in scope inside that
  -- ON clause - it fails with a bare "invalid identifier 'P.OPERATOR_ID'".
  -- Every join below carries REGION and VEHICLE_TYPE, because an operator id is
  -- unique only WITHIN a dataset. Without them a two-region scope fans out: one
  -- weekly row would match the ops, veh, radius and dot rows of BOTH regions.
  -- EQUAL_NULL rather than =, consistent with the region joins above, so a NULL
  -- region cannot silently drop rows out of an equality join.
  FROM proj p
  JOIN params pp
    ON EQUAL_NULL(pp.RG, p.REGION) AND EQUAL_NULL(pp.VT, p.VEHICLE_TYPE)
  LEFT JOIN ops o      ON o.OPERATOR_ID = p.OPERATOR_ID
                      AND EQUAL_NULL(o.REGION, p.REGION)
                      AND EQUAL_NULL(o.VEHICLE_TYPE, p.VEHICLE_TYPE)
  LEFT JOIN trip_wk tw ON tw.OPERATOR_ID = p.OPERATOR_ID AND tw.WEEK_START = p.WEEK_START
                      AND EQUAL_NULL(tw.REGION, p.REGION)
                      AND EQUAL_NULL(tw.VEHICLE_TYPE, p.VEHICLE_TYPE)
  LEFT JOIN veh v      ON v.OPERATOR_ID = p.OPERATOR_ID
                      AND EQUAL_NULL(v.REGION, p.REGION)
                      AND EQUAL_NULL(v.VEHICLE_TYPE, p.VEHICLE_TYPE)
  LEFT JOIN radius rd  ON rd.OPERATOR_ID = p.OPERATOR_ID
                      AND EQUAL_NULL(rd.REGION, p.REGION)
                      AND EQUAL_NULL(rd.VEHICLE_TYPE, p.VEHICLE_TYPE)
  LEFT JOIN dot dt     ON dt.OPERATOR_ID = p.OPERATOR_ID AND dt.WEEK_START = p.WEEK_START
                      AND EQUAL_NULL(dt.REGION, p.REGION)
                      AND EQUAL_NULL(dt.VEHICLE_TYPE, p.VEHICLE_TYPE)
$$;

-- Two-arg overload: the whole dataset, unbounded. See the note on the duty-period
-- overload above for why the signature is kept and why SELECT * is safe here.
-- This is the form VW_LABOR_WEEK, SV_LABOR and the overtime alert bind to, so it
-- is also the form the AGENT sees - which is precisely why the per-region trim
-- lives inside the function rather than in the app's query. A fix applied only
-- at the panel would have left the agent answering with one region's tail.
CREATE OR REPLACE FUNCTION FLEET_APP.LABOR.F_FACT_LABOR_WEEK_SCOPED(P_REGION VARCHAR, P_DATASET_ID VARCHAR)
RETURNS TABLE (
  OPERATOR_ID VARCHAR, WEEK_START DATE, WEEK_END DATE, WEEK_LABEL VARCHAR,
  TEAM_ID VARCHAR, SUPERVISOR_ID VARCHAR, SHIFT_TYPE VARCHAR, DRIVER_PROFILE VARCHAR,
  HOURS_TO_DATE FLOAT, DAYS_WORKED NUMBER, DAYS_ELAPSED NUMBER, DAYS_REMAINING NUMBER,
  IS_CURRENT_WEEK BOOLEAN, IS_PARTIAL_START BOOLEAN, IS_PARTIAL_END BOOLEAN, PROJECTED_WEEK_HOURS FLOAT,
  CONTRACTED_HOURS_PER_WEEK FLOAT, STRAIGHT_HOURS FLOAT, OT_HOURS FLOAT,
  PROJECTED_OT_HOURS FLOAT, HOURLY_RATE FLOAT, EST_OT_COST FLOAT,
  EST_OT_PREMIUM FLOAT,
  CURRENCY_CODE VARCHAR,
  OT_PCT_OF_PAID FLOAT, OT_PCT_OF_STRAIGHT FLOAT,
  FTE_EQUIVALENT FLOAT,
  OT_BAND VARCHAR, OT_THRESHOLD_1 FLOAT, OT_THRESHOLD_2 FLOAT, OT_THRESHOLD_3 FLOAT,
  DRIVE_HOURS FLOAT, DRIVE_SHARE_OF_PAID FLOAT, TRIPS NUMBER, DISTANCE_KM FLOAT,
  KM_PER_PAID_HOUR FLOAT, STOPS_PER_PAID_HOUR FLOAT,
  OT_ELIGIBLE_FLSA BOOLEAN, MIN_VEHICLE_TONNES FLOAT,
  DOT_ONDUTY_7D_HOURS FLOAT, DOT_ONDUTY_LIMIT FLOAT, DOT_ONDUTY_PCT FLOAT,
  MAX_RADIUS_MILES FLOAT, DRIVER_SALESPERSON_OK BOOLEAN,
  BINDING_CONSTRAINT VARCHAR,
  REGION VARCHAR, REGION_LABEL VARCHAR, VEHICLE_TYPE VARCHAR
)
COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-labor-overtime","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  SELECT * FROM TABLE(FLEET_APP.LABOR.F_FACT_LABOR_WEEK_SCOPED(
    P_REGION, P_DATASET_ID, CAST(NULL AS DATE), CAST(NULL AS DATE)))
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
       -- REGION and VEHICLE_TYPE are part of the key: this is SV_LABOR's PRIMARY
       -- KEY and operator ids repeat across datasets, so operator|week collides.
       REGION || '|' || VEHICLE_TYPE || '|' || OPERATOR_ID
         || '|' || TO_VARCHAR(WEEK_START, 'YYYY-MM-DD') AS LABOR_WEEK_ID,
       OPERATOR_ID, WEEK_START, WEEK_END, WEEK_LABEL, TEAM_ID, SUPERVISOR_ID,
       SHIFT_TYPE, DRIVER_PROFILE, HOURS_TO_DATE, DAYS_WORKED, DAYS_ELAPSED,
       DAYS_REMAINING, IS_CURRENT_WEEK, IS_PARTIAL_START, IS_PARTIAL_END, PROJECTED_WEEK_HOURS,
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

-- The four-arg window overloads need their OWN grants: a grant is per signature,
-- so granting the two-arg form leaves the form the app actually calls unusable.
GRANT USAGE ON FUNCTION FLEET_APP.LABOR.F_FACT_DUTY_PERIOD_SCOPED(VARCHAR, VARCHAR, DATE, DATE) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.LABOR.F_FACT_DUTY_PERIOD_SCOPED(VARCHAR, VARCHAR, DATE, DATE) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.LABOR.F_FACT_DUTY_PERIOD_SCOPED(VARCHAR, VARCHAR, DATE, DATE) TO ROLE FLEET_APP_ADMIN;

GRANT USAGE ON FUNCTION FLEET_APP.LABOR.F_FACT_LABOR_WEEK_SCOPED(VARCHAR, VARCHAR) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.LABOR.F_FACT_LABOR_WEEK_SCOPED(VARCHAR, VARCHAR) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.LABOR.F_FACT_LABOR_WEEK_SCOPED(VARCHAR, VARCHAR) TO ROLE FLEET_APP_ADMIN;

GRANT USAGE ON FUNCTION FLEET_APP.LABOR.F_FACT_LABOR_WEEK_SCOPED(VARCHAR, VARCHAR, DATE, DATE) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.LABOR.F_FACT_LABOR_WEEK_SCOPED(VARCHAR, VARCHAR, DATE, DATE) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.LABOR.F_FACT_LABOR_WEEK_SCOPED(VARCHAR, VARCHAR, DATE, DATE) TO ROLE FLEET_APP_ADMIN;

GRANT SELECT ON ALL VIEWS IN SCHEMA FLEET_APP.LABOR TO ROLE FLEET_APP_USER;
GRANT SELECT ON ALL VIEWS IN SCHEMA FLEET_APP.LABOR TO ROLE FLEET_APP_OPS;
GRANT SELECT ON ALL VIEWS IN SCHEMA FLEET_APP.LABOR TO ROLE FLEET_APP_ADMIN;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA FLEET_APP.LABOR TO ROLE FLEET_APP_USER;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA FLEET_APP.LABOR TO ROLE FLEET_APP_OPS;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA FLEET_APP.LABOR TO ROLE FLEET_APP_ADMIN;
