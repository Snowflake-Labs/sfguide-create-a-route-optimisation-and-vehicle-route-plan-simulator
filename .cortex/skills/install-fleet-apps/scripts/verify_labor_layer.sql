-- ============================================================================
-- verify_labor_layer.sql - invariant assertions for FLEET_APP.LABOR
-- ============================================================================
-- Read-only. Every row returned has a STATUS of PASS or FAIL; a FAIL means the
-- labour layer is producing numbers that must not be shown to anyone.
--
-- Usage:
--   snow sql -c <connection> -f scripts/verify_labor_layer.sql \
--     --enable-templating NONE -D "REGION=SanFrancisco"
--
-- Defaults to SanFrancisco when REGION is not supplied.
--
-- WHY THESE SPECIFIC CHECKS
--
-- CHECK 1 is the one that matters most. Overtime thresholds are weekly, so a
-- duty period straddling a week boundary must contribute to BOTH weeks. The
-- obvious implementation - clamp each duty period into the week it started in -
-- compiles, returns rows, and renders a populated dashboard while silently
-- DESTROYING hours. Measured on SanFrancisco e-bike: 28 of 583 duty periods
-- straddle, and clamping dropped 157.7 hours (4753.5 -> 4595.8, 3.3%). Because
-- the alert fires on a weekly threshold, those are precisely the hours that
-- decide who gets flagged. PERIOD_INTERSECT conserves them, and this check is
-- the proof. Tolerance is 0.5h to absorb per-row rounding across ~600 rows, not
-- to absorb a systematic loss - a real regression moves this by tens of hours.
--
-- CHECK 2 guards the ceiling the week generation relies on. The split now emits
-- one row per payroll week a duty period TOUCHES, generated from a 60-row offset
-- table, so a duty period longer than 60 weeks would lose its tail. This replaces
-- an earlier 24h assertion that was written for the old two-segment split: that
-- split was complete only while a duty period could not span a whole week, and it
-- was NOT - a long-haul HGV dataset produced 75 duty periods over 24h, the
-- longest 215.5h, and every intermediate week was dropped, losing 504 of 5,378
-- paid hours. The generation removes the assumption, so the assertion moves to
-- the generator's own bound and long spans become a data-quality signal
-- (CHECK 13) rather than a correctness failure.
--
-- CHECK 3 asserts no operator is on two duty periods at once. Sessionization
-- partitions by operator and orders by start, so overlap indicates either
-- overlapping source trips or a partitioning regression. This is what
-- PERIOD_OVERLAPS is for, and it is cheap because the join is bounded per
-- operator.
--
-- CHECK 4 catches the calendar-day regression specifically. Grouping duty by
-- TRIP_START::DATE instead of by gap put 146 of 633 driver-days over 14 hours
-- with a max span of 24.6h, purely from night shifts wrapping midnight. The
-- signature of that regression is exact and dataset-independent: under date
-- grouping NO duty period can cross midnight. So the check is implication - if
-- any source trip crosses midnight, some duty period must too. An earlier version
-- capped long duty periods at 5% of the population, which reads as a regression on
-- a long-haul fleet where a SINGLE recorded trip runs 42h and no grouping choice
-- could make its duty period shorter.
--
-- CHECK 5 asserts the projection is anchored to the DATASET's latest activity
-- rather than to CURRENT_TIMESTAMP. The data is historical, so against
-- wall-clock time every week is complete, every projection collapses to its
-- actual, and the at-risk leaderboard silently empties. Exactly one week may
-- carry IS_CURRENT_WEEK.
--
-- CHECK 6 asserts the synthesized pay rates land inside their configured band.
-- A hash-derived value outside the band means the derivation drifted from the
-- config, which would make every OT cost figure wrong while still looking
-- plausible.
--
-- CHECK 7 asserts drive hours never exceed paid hours. Paid hours are allocated
-- by period intersection while trips are attributed by start week, so the two
-- can disagree at a boundary; the ratio is capped at 1.0 and this confirms the
-- cap is not hiding a systematic inversion.
--
-- CHECK 8 is the one that protects a savings claim from being wrong by 3x.
-- EST_OT_COST is the fully loaded cost of the overtime hours; only the premium
-- above straight time is avoidable. If a future edit made the premium equal the
-- loaded cost, every "here is what you could save" figure in the demo would
-- triple, and nothing else would look wrong.
--
-- CHECK 9 asserts BINDING_CONSTRAINT is always populated. It is the column that
-- answers "which rule applies to this person", so a NULL is not a cosmetic gap:
-- the exception list would show a named individual with no stated reason, which
-- is exactly the surveillance-without-context failure the view is designed to
-- avoid.
--
-- CHECK 10 asserts the two regimes stay mutually exclusive. DOT hours-of-service
-- and driver-salesperson status are defined for commercial motor vehicles, so on
-- a light-vehicle fleet they must be NULL (not applicable) rather than computed.
-- Applied ungated this produced pure noise: every operator-week "failed" a 50%
-- driving test written for CMVs, because e-bike couriers drive ~94% of paid time.
-- The inverse also matters, so this checks that a CMV fleet DOES get them
-- populated rather than only checking the light case.
--
-- CHECK 11 asserts the FLSA small-vehicle exception uses the LIGHTEST vehicle of
-- the week. The exception covers the WHOLE workweek if any vehicle was at or
-- under 10,000 lb, even when heavier vehicles were also driven, so a MAX or AVG
-- here would silently suppress a real overtime obligation.
--
-- CHECK 12 asserts weight precision survives the contract. The physical column is
-- NUMBER(6,2) but the contract function once declared a bare NUMBER, which is
-- NUMBER(38,0) and TRUNCATED - 0.1 arrived as 0 and a 3.5t van would have arrived
-- as 4. That makes the 4.536t eligibility boundary fuzzy by half a tonne in the
-- one test whose entire purpose is which side of it you are on.
--
-- CHECK 13 and CHECK 14 report DATA quality, not correctness, so they return WARN
-- rather than FAIL and the installer does not block on them. A duty period over
-- 24h and a week whose projection hits the 168h clamp are both real signals -
-- nobody is on the clock for a day straight - but the cause is upstream in the
-- generated trips (48 UsTexas trips are single records longer than 24h, the
-- longest 42.6h), so failing the install would punish this layer for faithfully
-- reporting its input. CHECK 15 asserts DAYS_WORKED counts the days a duty period
-- COVERS: counting only the date each segment STARTED reported 42.51 paid hours
-- against one day worked, an impossibility that reached the dashboard.
--
-- CHECK 16 is the one that matters most after CHECK 1, and it is the only check
-- here that compares two SCOPES rather than inspecting one. Operator and vehicle
-- ids are index-derived per dataset, so DRV-00009 exists in every region. All
-- three functions grouped and partitioned on the id alone, so any call covering
-- more than one dataset MERGED two different people: the operator dimension
-- returned 147 rows for two regions holding 100 + 47, the duty fact interleaved a
-- San Francisco courier's trips with a Texas HGV driver's into one gap-based
-- session (607 real duty periods collapsed to 519, longest span 215.49h -> 96.31h),
-- and the weekly fact SUMMED their hours (256 operator-weeks -> 196, with weeks of
-- 170.05 paid hours). None of the single-scope checks could see it. CHECK 1 in
-- particular cannot: it compares the duty total to the weekly total, and under
-- fusion BOTH are computed from the same regrouped sessions, so the equality held
-- while both sides were wrong. The test is therefore additivity - this region read
-- on its own must return exactly the rows the unscoped read attributes to it.
-- This is also the scope the AGENT uses: VW_LABOR_WEEK and SV_LABOR call these
-- functions with no region argument at all.
--
-- CHECK 17, CHECK 18 and CHECK 19 are arithmetic impossibilities about a payroll
-- week, and they are asserted on the UNSCOPED wrapper views deliberately, because
-- that is where they failed. Per region they all passed; it was the pooled read
-- that produced DAYS_WORKED = 8 in a 7-day week, HOURS_TO_DATE = 170.05 in a week
-- that holds 168, and a PROJECTED_WEEK_HOURS of 168 for an operator who had
-- already worked 170.05 - a forecast that someone will finish the week with fewer
-- hours than they have. CHECK 17 is not merely a tighter CHECK 15: an extra day
-- makes hours-per-day-worked SMALLER, so the off-by-one made CHECK 15 pass MORE
-- comfortably (21.26h against its 24h bound, now exactly 24h). A check that gets
-- looser as the defect worsens cannot guard it. Note DAYS_WORKED may legitimately
-- exceed DAYS_ELAPSED: the as-of anchor is trimmed to the last substantive day, so
-- work in the tapering tail is real work on a day the projection does not count.
-- Measured on 37 rows, so the bound is 7 and not LEAST(7, DAYS_ELAPSED).
--
-- CHECK 20 asserts the two surrogate keys are unique. Both are declared PRIMARY
-- KEY in SV_LABOR and both were built from the operator id alone, so they
-- collided across datasets - silently, because Snowflake does not enforce a
-- primary key on a standard view.
--
-- CHECK 21 to CHECK 24 guard the as-of anchor itself, which nothing above them
-- can see.
--
-- CHECK 21 is the guard for the reported defect. The anchor used to be the raw
-- MAX(DUTY_END), which lands in the taper a generated dataset ends with (21 trips
-- against a 1,933/day median in SanFrancisco, 6 against 71 in UsTexas), so the
-- current week was a one-day stub containing 15 of 47 UsTexas operators and 1 of
-- 100 in SanFrancisco. Every panel of the Labour view filters IS_CURRENT_WEEK, so
-- the whole dashboard collapsed to that population. CHECK 5 could not see it: a
-- stub is still exactly one current week, so CHECK 5 passed the entire time. What
-- was wrong was the current week's POPULATION, which is what CHECK 21 measures.
--
-- CHECK 22 is the arithmetic identity on the projection window. DAYS_REMAINING is
-- rendered as "days left to act", so a break here is a wrong number on screen.
--
-- CHECK 23 is the only check that can see the anchor PARTITIONING. CHECK 16
-- cannot: it compares row counts, and which week is flagged current does not
-- change how many rows exist, so a pooled anchor passes it unchanged. CHECK 21
-- cannot either: it reads the region-scoped call, where there is nothing to pool.
-- CHECK 23 is therefore CHECK 21's roster test applied PER REGION to the UNSCOPED
-- read. Pooling let the freshest region's tail drag every other region's current
-- week with it - measured, an unscoped call reported 15 current-week operators
-- while SanFrancisco called alone reported 100. Vacuous on a single-region
-- account, so it passes there by construction.
--
-- It was first written as "each region's current week IS that region's latest
-- week", which looked equivalent and was wrong: the trim exists precisely to
-- leave a tapering final week NOT flagged current, so that form failed on a
-- correct deployment. Recorded because the wrong form is the intuitive one.
--
-- CHECK 24 re-runs CHECK 1's conservation equality through the four-arg WINDOW
-- overload the app now calls on every panel. The window has to be an overlap test
-- on the duty periods, not a predicate on the input trips: filtering the trips
-- first cuts a shift at the window edge, reporting a fragment as a whole shift and
-- breaking the equality. Asserting it is what stops that regression.
-- ============================================================================

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-labor-overtime","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

SET REGION = COALESCE('<% REGION %>', 'SanFrancisco');

-- Window for CHECK 24: this region's own last 14 days of activity. Derived from
-- the data rather than hardcoded, so the range is genuinely narrower than the
-- dataset on any account and the check does not silently degenerate into a repeat
-- of the unbounded CHECK 1.
SET WIN_TO = (SELECT MAX(TRIP_START)::DATE
              FROM TABLE(FLEET_APP.UNIFIED_FLEET.F_VW_FACT_TRIPS_SCOPED($REGION, NULL::VARCHAR)));
SET WIN_FROM = DATEADD('day', -13, $WIN_TO);

WITH duty AS (
  SELECT * FROM TABLE(FLEET_APP.LABOR.F_FACT_DUTY_PERIOD_SCOPED($REGION, NULL::VARCHAR))
),
wk AS (
  SELECT * FROM TABLE(FLEET_APP.LABOR.F_FACT_LABOR_WEEK_SCOPED($REGION, NULL::VARCHAR))
),
-- The UNSCOPED reads, which are what VW_LABOR_WEEK, VW_DUTY_PERIOD and therefore
-- SV_LABOR and every agent question actually go through. Kept separate from `wk`
-- because the defects CHECK 16 to CHECK 19 guard appeared ONLY when more than one
-- dataset was in scope, so asserting on the region-scoped read alone passed while
-- the agent path was wrong.
wk_all AS (
  SELECT * FROM FLEET_APP.LABOR.VW_LABOR_WEEK
),
duty_all AS (
  SELECT * FROM FLEET_APP.LABOR.VW_DUTY_PERIOD
),
op_all AS (
  SELECT * FROM FLEET_APP.LABOR.VW_LABOR_OPERATOR
),
cfg AS (
  SELECT COALESCE(MAX(HOURLY_RATE_MIN), 22.0) AS RMIN,
         COALESCE(MAX(GVWR_OT_THRESHOLD_TONNES), 4.536) AS GVWR_T,
         COALESCE(MAX(HOURLY_RATE_MAX), 34.0) AS RMAX
  FROM FLEET_APP.LABOR.LABOR_CONFIG
  WHERE REGION = '*' AND VEHICLE_TYPE = '*'
),
overlaps AS (
  SELECT COUNT(*) AS N
  FROM duty a
  JOIN duty b
    ON a.OPERATOR_ID = b.OPERATOR_ID
   AND a.DUTY_SEQ < b.DUTY_SEQ
   AND PERIOD_OVERLAPS(a.DUTY_PERIOD, b.DUTY_PERIOD)
),
-- Midnight crossing, in the source trips and in the duty periods. A date-grouped
-- sessionization cannot produce a duty period that crosses midnight, so trips
-- crossing with zero duty periods crossing is the exact regression signature.
midnight AS (
  SELECT
    (SELECT COUNT(*) FROM TABLE(FLEET_APP.UNIFIED_FLEET.F_VW_FACT_TRIPS_SCOPED($REGION, NULL::VARCHAR))
       WHERE TRIP_START IS NOT NULL AND TRIP_END IS NOT NULL
         AND TRIP_START::DATE <> TRIP_END::DATE) AS TRIPS_X,
    (SELECT COUNT(*) FROM duty WHERE DUTY_START::DATE <> DUTY_END::DATE) AS DUTY_X
)
SELECT * FROM (
  SELECT 1 AS CHK, 'hours conserved across week split' AS ASSERTION,
         TO_VARCHAR(ROUND((SELECT SUM(PAID_HOURS) FROM duty), 2)) || 'h duty vs '
           || TO_VARCHAR(ROUND((SELECT SUM(HOURS_TO_DATE) FROM wk), 2)) || 'h weekly' AS OBSERVED,
         IFF(ABS((SELECT SUM(PAID_HOURS) FROM duty)
                 - (SELECT SUM(HOURS_TO_DATE) FROM wk)) <= 0.5, 'PASS', 'FAIL') AS STATUS
  UNION ALL
  SELECT 2, 'duty periods stay inside the week-generation ceiling',
         TO_VARCHAR((SELECT MAX(DATEDIFF('day', DUTY_START, DUTY_END)) FROM duty))
           || ' day max span (ceiling 420 = 60 weeks)',
         IFF(COALESCE((SELECT MAX(DATEDIFF('day', DUTY_START, DUTY_END)) FROM duty), 0) < 420,
             'PASS', 'FAIL')
  UNION ALL
  SELECT 3, 'no operator on two duty periods at once',
         TO_VARCHAR((SELECT N FROM overlaps)) || ' overlapping pairs',
         IFF((SELECT N FROM overlaps) = 0, 'PASS', 'FAIL')
  UNION ALL
  SELECT 4, 'sessionized by gap, not calendar day',
         TO_VARCHAR((SELECT TRIPS_X FROM midnight)) || ' trips cross midnight, '
           || TO_VARCHAR((SELECT DUTY_X FROM midnight)) || ' duty periods cross',
         IFF((SELECT TRIPS_X FROM midnight) = 0 OR (SELECT DUTY_X FROM midnight) > 0,
             'PASS', 'FAIL')
  UNION ALL
  SELECT 5, 'projection anchored to dataset as-of, not wall clock',
         TO_VARCHAR((SELECT COUNT(DISTINCT WEEK_START) FROM wk WHERE IS_CURRENT_WEEK))
           || ' current week(s) of '
           || TO_VARCHAR((SELECT COUNT(DISTINCT WEEK_START) FROM wk)),
         IFF((SELECT COUNT(DISTINCT WEEK_START) FROM wk WHERE IS_CURRENT_WEEK) = 1, 'PASS', 'FAIL')
  UNION ALL
  SELECT 6, 'synthesized pay rates inside configured band',
         TO_VARCHAR((SELECT COUNT(*) FROM wk, cfg
                     WHERE HOURLY_RATE < cfg.RMIN OR HOURLY_RATE > cfg.RMAX)) || ' out of band',
         IFF((SELECT COUNT(*) FROM wk, cfg
              WHERE HOURLY_RATE < cfg.RMIN OR HOURLY_RATE > cfg.RMAX) = 0, 'PASS', 'FAIL')
  UNION ALL
  SELECT 7, 'drive hours never exceed paid hours',
         TO_VARCHAR((SELECT COUNT(*) FROM wk WHERE DRIVE_HOURS > HOURS_TO_DATE + 0.01))
           || ' weeks inverted',
         IFF((SELECT COUNT(*) FROM wk WHERE DRIVE_HOURS > HOURS_TO_DATE + 0.01) = 0, 'PASS', 'FAIL')
  UNION ALL
  SELECT 8, 'OT premium is below loaded cost (avoidable vs total)',
         TO_VARCHAR((SELECT COUNT(*) FROM wk WHERE PROJECTED_OT_HOURS > 0
                       AND EST_OT_PREMIUM >= EST_OT_COST)) || ' rows not below, ratio '
           || TO_VARCHAR(ROUND((SELECT DIV0(SUM(EST_OT_COST), SUM(EST_OT_PREMIUM)) FROM wk), 2)),
         IFF((SELECT COUNT(*) FROM wk WHERE PROJECTED_OT_HOURS > 0
                AND EST_OT_PREMIUM >= EST_OT_COST) = 0, 'PASS', 'FAIL')
  UNION ALL
  SELECT 9, 'binding constraint always populated',
         TO_VARCHAR((SELECT COUNT(*) FROM wk WHERE BINDING_CONSTRAINT IS NULL)) || ' null of '
           || TO_VARCHAR((SELECT COUNT(*) FROM wk)),
         IFF((SELECT COUNT(*) FROM wk WHERE BINDING_CONSTRAINT IS NULL) = 0, 'PASS', 'FAIL')
  UNION ALL
  -- Mutually exclusive regimes, checked in BOTH directions: a light-vehicle row
  -- must have the CMV-only columns NULL, and a CMV row must have them populated.
  SELECT 10, 'DOT and driver-salesperson apply to CMVs only',
         TO_VARCHAR((SELECT COUNT(*) FROM wk WHERE OT_ELIGIBLE_FLSA AND DOT_ONDUTY_7D_HOURS IS NOT NULL))
           || ' light rows with DOT set, '
           || TO_VARCHAR((SELECT COUNT(*) FROM wk WHERE NOT OT_ELIGIBLE_FLSA AND DOT_ONDUTY_7D_HOURS IS NULL))
           || ' CMV rows missing DOT',
         IFF((SELECT COUNT(*) FROM wk WHERE OT_ELIGIBLE_FLSA AND DOT_ONDUTY_7D_HOURS IS NOT NULL) = 0
             AND (SELECT COUNT(*) FROM wk WHERE NOT OT_ELIGIBLE_FLSA AND DOT_ONDUTY_7D_HOURS IS NULL) = 0,
             'PASS', 'FAIL')
  UNION ALL
  -- Eligibility must follow the LIGHTEST vehicle, so no row may be marked exempt
  -- while its recorded minimum weight is at or under the threshold.
  SELECT 11, 'FLSA eligibility follows the lightest vehicle',
         TO_VARCHAR((SELECT COUNT(*) FROM wk, cfg
                     WHERE NOT OT_ELIGIBLE_FLSA AND MIN_VEHICLE_TONNES <= cfg.GVWR_T))
           || ' exempt rows at or under the threshold',
         IFF((SELECT COUNT(*) FROM wk, cfg
              WHERE NOT OT_ELIGIBLE_FLSA AND MIN_VEHICLE_TONNES <= cfg.GVWR_T) = 0, 'PASS', 'FAIL')
  UNION ALL
  -- A bare NUMBER declaration in the contract truncates NUMBER(6,2) to integer,
  -- which would make every sub-tonne weight 0 and shift a 3.5t van to 4t.
  SELECT 12, 'vehicle weight precision survives the contract',
         'min ' || TO_VARCHAR((SELECT MIN(MIN_VEHICLE_TONNES) FROM wk))
           || ', fractional rows '
           || TO_VARCHAR((SELECT COUNT(*) FROM wk WHERE MIN_VEHICLE_TONNES <> ROUND(MIN_VEHICLE_TONNES, 0))),
         IFF((SELECT COUNT(*) FROM wk WHERE MIN_VEHICLE_TONNES IS NOT NULL) = 0
             OR (SELECT MIN(MIN_VEHICLE_TONNES) FROM wk) > 0, 'PASS', 'FAIL')
  UNION ALL
  -- WARN, not FAIL: the cause is upstream in the generated trips, and this layer
  -- reporting it faithfully is correct behaviour.
  SELECT 13, 'duty spans are physically plausible (data quality)',
         TO_VARCHAR((SELECT COUNT(*) FROM duty WHERE PAID_HOURS > 24)) || ' of '
           || TO_VARCHAR((SELECT COUNT(*) FROM duty)) || ' duty periods over 24h, max '
           || TO_VARCHAR(ROUND(COALESCE((SELECT MAX(PAID_HOURS) FROM duty), 0), 2)) || 'h',
         IFF((SELECT COUNT(*) FROM duty WHERE PAID_HOURS > 24) = 0, 'PASS', 'WARN')
  UNION ALL
  SELECT 14, 'no week projection hits the 168h clamp (data quality)',
         TO_VARCHAR((SELECT COUNT(*) FROM wk WHERE PROJECTED_WEEK_HOURS >= 168)) || ' clamped of '
           || TO_VARCHAR((SELECT COUNT(*) FROM wk)),
         IFF((SELECT COUNT(*) FROM wk WHERE PROJECTED_WEEK_HOURS >= 168) = 0, 'PASS', 'WARN')
  UNION ALL
  -- Days worked must count days COVERED, so paid hours per day worked cannot
  -- exceed 24. Counting only each segment's START date reported 42.51h against
  -- one day worked.
  SELECT 15, 'days worked counts days covered, not start dates',
         'max ' || TO_VARCHAR(ROUND(COALESCE((SELECT MAX(DIV0(HOURS_TO_DATE, DAYS_WORKED)) FROM wk), 0), 2))
           || 'h per day worked',
         IFF(COALESCE((SELECT MAX(DIV0(HOURS_TO_DATE, DAYS_WORKED)) FROM wk), 0) <= 24.01,
             'PASS', 'FAIL')
  UNION ALL
  -- Additivity across scopes. This region read on its own must return exactly the
  -- rows the unscoped read attributes to it; anything less means the unscoped read
  -- merged operators that share an index-derived id across datasets.
  SELECT 16, 'operator identity survives a multi-dataset scope',
         'week ' || TO_VARCHAR((SELECT COUNT(*) FROM wk)) || '/'
           || TO_VARCHAR((SELECT COUNT(*) FROM wk_all WHERE REGION = $REGION))
           || ', duty ' || TO_VARCHAR((SELECT COUNT(*) FROM duty))
           || '/' || TO_VARCHAR((SELECT COUNT(*) FROM duty_all WHERE REGION = $REGION))
           || ', operators ' || TO_VARCHAR((SELECT COUNT(*) FROM TABLE(FLEET_APP.LABOR.F_DIM_LABOR_OPERATOR_SCOPED($REGION, NULL::VARCHAR))))
           || '/' || TO_VARCHAR((SELECT COUNT(*) FROM op_all WHERE REGION = $REGION))
           || ' (scoped/unscoped)',
         IFF((SELECT COUNT(*) FROM wk)   = (SELECT COUNT(*) FROM wk_all   WHERE REGION = $REGION)
             AND (SELECT COUNT(*) FROM duty) = (SELECT COUNT(*) FROM duty_all WHERE REGION = $REGION)
             AND (SELECT COUNT(*) FROM TABLE(FLEET_APP.LABOR.F_DIM_LABOR_OPERATOR_SCOPED($REGION, NULL::VARCHAR)))
                 = (SELECT COUNT(*) FROM op_all WHERE REGION = $REGION),
             'PASS', 'FAIL')
  UNION ALL
  -- A payroll week has 7 days. Asserted on the unscoped read, where the fused
  -- grain produced 8, and bounded at 7 rather than at DAYS_ELAPSED because the
  -- trimmed as-of anchor makes DAYS_WORKED > DAYS_ELAPSED legitimate.
  SELECT 17, 'days worked fits inside a payroll week',
         TO_VARCHAR((SELECT COUNT(*) FROM wk_all WHERE DAYS_WORKED NOT BETWEEN 1 AND 7))
           || ' rows outside 1..7, max '
           || TO_VARCHAR(COALESCE((SELECT MAX(DAYS_WORKED) FROM wk_all), 0)),
         IFF((SELECT COUNT(*) FROM wk_all WHERE DAYS_WORKED NOT BETWEEN 1 AND 7) = 0, 'PASS', 'FAIL')
  UNION ALL
  SELECT 18, 'paid hours fit inside a payroll week',
         TO_VARCHAR((SELECT COUNT(*) FROM wk_all WHERE HOURS_TO_DATE > 168.01))
           || ' rows over 168h, max '
           || TO_VARCHAR(ROUND(COALESCE((SELECT MAX(HOURS_TO_DATE) FROM wk_all), 0), 2)) || 'h',
         IFF((SELECT COUNT(*) FROM wk_all WHERE HOURS_TO_DATE > 168.01) = 0, 'PASS', 'FAIL')
  UNION ALL
  -- A forecast below the hours already worked is not a forecast.
  SELECT 19, 'projection is never below hours already worked',
         TO_VARCHAR((SELECT COUNT(*) FROM wk_all WHERE PROJECTED_WEEK_HOURS < HOURS_TO_DATE - 0.01))
           || ' rows projected below actual',
         IFF((SELECT COUNT(*) FROM wk_all WHERE PROJECTED_WEEK_HOURS < HOURS_TO_DATE - 0.01) = 0,
             'PASS', 'FAIL')
  UNION ALL
  -- Both keys are declared PRIMARY KEY in SV_LABOR, and a view does not enforce
  -- one, so a collision across datasets is silent.
  SELECT 20, 'semantic-view primary keys are unique',
         TO_VARCHAR((SELECT COUNT(*) - COUNT(DISTINCT LABOR_WEEK_ID) FROM wk_all))
           || ' duplicate week keys, '
           || TO_VARCHAR((SELECT COUNT(*) - COUNT(DISTINCT DUTY_ID) FROM duty_all))
           || ' duplicate duty keys',
         IFF((SELECT COUNT(*) - COUNT(DISTINCT LABOR_WEEK_ID) FROM wk_all) = 0
             AND (SELECT COUNT(*) - COUNT(DISTINCT DUTY_ID) FROM duty_all) = 0,
             'PASS', 'FAIL')
  UNION ALL
  -- The guard for the reported defect: the current week must hold a plausible
  -- ROSTER, not merely exist. CHECK 5 asserts exactly one current week and passed
  -- throughout, because a one-day stub is still exactly one week - it was the
  -- stub's POPULATION that was wrong. Bounded at 60% rather than 100% because a
  -- genuine mid-week snapshot legitimately misses people rostered off; a stub, by
  -- contrast, held a few percent.
  SELECT 21, 'current week holds a plausible share of the roster',
         TO_VARCHAR((SELECT COUNT(DISTINCT OPERATOR_ID) FROM wk WHERE IS_CURRENT_WEEK))
           || ' of ' || TO_VARCHAR((SELECT COUNT(DISTINCT OPERATOR_ID) FROM wk))
           || ' operators in the current week',
         IFF((SELECT COUNT(DISTINCT OPERATOR_ID) FROM wk WHERE IS_CURRENT_WEEK)
             >= 0.6 * (SELECT COUNT(DISTINCT OPERATOR_ID) FROM wk), 'PASS', 'FAIL')
  UNION ALL
  -- Arithmetic identity on the projection window. DAYS_REMAINING is rendered as
  -- "days left to act", so a break here is a wrong number on screen.
  SELECT 22, 'days elapsed and remaining partition the week',
         TO_VARCHAR((SELECT COUNT(*) FROM wk_all
                     WHERE DAYS_ELAPSED NOT BETWEEN 1 AND 7
                        OR DAYS_REMAINING <> 7 - DAYS_ELAPSED)) || ' rows inconsistent',
         IFF((SELECT COUNT(*) FROM wk_all
              WHERE DAYS_ELAPSED NOT BETWEEN 1 AND 7
                 OR DAYS_REMAINING <> 7 - DAYS_ELAPSED) = 0, 'PASS', 'FAIL')
  UNION ALL
  -- The only check that can see the anchor PARTITIONING, and CHECK 21 cannot:
  -- CHECK 21 reads the region-SCOPED call, where there is only one region and so
  -- nothing to pool. This is CHECK 21's roster test applied PER REGION to the
  -- UNSCOPED read, which is the scope the agent uses.
  --
  -- Under a single pooled anchor the freshest region's tail set the current week
  -- for every region, so a region whose activity ended earlier had its current
  -- week land in a week it had barely worked: measured, SanFrancisco held 1 of its
  -- 100 operators in the pooled current week while returning 100 when called on
  -- its own. Any region falling below the roster share is therefore the pooling
  -- signature. Vacuous on a single-region account, so it passes there.
  --
  -- Deliberately NOT asserted as "the current week is the region's latest week":
  -- that formulation looked equivalent and is wrong, because the trim exists
  -- precisely to leave a tapering final week NOT flagged current. It failed on a
  -- correct deployment before being restated.
  SELECT 23, 'as-of anchor is resolved per region, not pooled',
         TO_VARCHAR((SELECT COUNT(DISTINCT REGION) FROM wk_all)) || ' region(s), '
           || TO_VARCHAR((SELECT COUNT(*) FROM (
                SELECT REGION FROM wk_all GROUP BY REGION
                HAVING COUNT(DISTINCT IFF(IS_CURRENT_WEEK, WEEK_START, NULL)) <> 1
                    OR COUNT(DISTINCT IFF(IS_CURRENT_WEEK, OPERATOR_ID, NULL))
                       < 0.6 * COUNT(DISTINCT OPERATOR_ID)
              ))) || ' with a thin or ambiguous current week',
         IFF((SELECT COUNT(DISTINCT REGION) FROM wk_all) < 2
             OR (SELECT COUNT(*) FROM (
                   SELECT REGION FROM wk_all GROUP BY REGION
                   HAVING COUNT(DISTINCT IFF(IS_CURRENT_WEEK, WEEK_START, NULL)) <> 1
                       OR COUNT(DISTINCT IFF(IS_CURRENT_WEEK, OPERATOR_ID, NULL))
                          < 0.6 * COUNT(DISTINCT OPERATOR_ID)
                 )) = 0,
             'PASS', 'FAIL')
  UNION ALL
  -- CHECK 1's conservation equality re-run through the four-arg WINDOW overload
  -- the app calls on every panel. The window must be an overlap test on the duty
  -- periods, not a predicate on the input trips: filtering trips first cuts a
  -- shift at the window edge and the two sides stop agreeing.
  SELECT 24, 'hours conserved under a narrowed date range',
         TO_VARCHAR(ROUND(COALESCE((SELECT SUM(PAID_HOURS) FROM TABLE(FLEET_APP.LABOR.F_FACT_DUTY_PERIOD_SCOPED(
                            $REGION, NULL::VARCHAR, $WIN_FROM, $WIN_TO))), 0), 2)) || 'h duty vs '
           || TO_VARCHAR(ROUND(COALESCE((SELECT SUM(HOURS_TO_DATE) FROM TABLE(FLEET_APP.LABOR.F_FACT_LABOR_WEEK_SCOPED(
                            $REGION, NULL::VARCHAR, $WIN_FROM, $WIN_TO))), 0), 2)) || 'h weekly over '
           || TO_VARCHAR($WIN_FROM) || '..' || TO_VARCHAR($WIN_TO),
         IFF(ABS(COALESCE((SELECT SUM(PAID_HOURS) FROM TABLE(FLEET_APP.LABOR.F_FACT_DUTY_PERIOD_SCOPED(
                            $REGION, NULL::VARCHAR, $WIN_FROM, $WIN_TO))), 0)
                 - COALESCE((SELECT SUM(HOURS_TO_DATE) FROM TABLE(FLEET_APP.LABOR.F_FACT_LABOR_WEEK_SCOPED(
                            $REGION, NULL::VARCHAR, $WIN_FROM, $WIN_TO))), 0)) <= 0.5,
             'PASS', 'FAIL')
) ORDER BY CHK;
