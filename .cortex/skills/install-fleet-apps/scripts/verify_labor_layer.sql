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
-- CHECK 2 guards the sessionization bound that CHECK 1's implementation relies
-- on. The week split emits at most two rows per duty period (begin week, and end
-- week when different), which is complete ONLY while a duty period cannot span a
-- whole week. That holds because duty periods are bounded by DUTY_GAP_MINUTES,
-- but a misconfigured gap (say 20160 minutes) would silently produce duty
-- periods spanning several weeks whose intermediate weeks are dropped. 24h is
-- the assertion because no legitimate duty period approaches it.
--
-- CHECK 3 asserts no operator is on two duty periods at once. Sessionization
-- partitions by operator and orders by start, so overlap indicates either
-- overlapping source trips or a partitioning regression. This is what
-- PERIOD_OVERLAPS is for, and it is cheap because the join is bounded per
-- operator.
--
-- CHECK 4 catches the calendar-day regression specifically. Grouping duty by
-- TRIP_START::DATE instead of by gap put 146 of 633 driver-days over 14 hours
-- with a max span of 24.6h, purely from night shifts wrapping midnight. If
-- someone "simplifies" the sessionization back to a date grouping, the count of
-- long duty periods jumps and this check fails.
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
-- ============================================================================

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-labor-overtime","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

SET REGION = COALESCE('<% REGION %>', 'SanFrancisco');

WITH duty AS (
  SELECT * FROM TABLE(FLEET_APP.LABOR.F_FACT_DUTY_PERIOD_SCOPED($REGION, NULL::VARCHAR))
),
wk AS (
  SELECT * FROM TABLE(FLEET_APP.LABOR.F_FACT_LABOR_WEEK_SCOPED($REGION, NULL::VARCHAR))
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
)
SELECT * FROM (
  SELECT 1 AS CHK, 'hours conserved across week split' AS ASSERTION,
         TO_VARCHAR(ROUND((SELECT SUM(PAID_HOURS) FROM duty), 2)) || 'h duty vs '
           || TO_VARCHAR(ROUND((SELECT SUM(HOURS_TO_DATE) FROM wk), 2)) || 'h weekly' AS OBSERVED,
         IFF(ABS((SELECT SUM(PAID_HOURS) FROM duty)
                 - (SELECT SUM(HOURS_TO_DATE) FROM wk)) <= 0.5, 'PASS', 'FAIL') AS STATUS
  UNION ALL
  SELECT 2, 'no duty period spans a week (split completeness bound)',
         TO_VARCHAR((SELECT COUNT(*) FROM duty WHERE PAID_HOURS > 24)) || ' over 24h, max '
           || TO_VARCHAR(ROUND((SELECT MAX(PAID_HOURS) FROM duty), 2)) || 'h',
         IFF((SELECT COUNT(*) FROM duty WHERE PAID_HOURS > 24) = 0, 'PASS', 'FAIL')
  UNION ALL
  SELECT 3, 'no operator on two duty periods at once',
         TO_VARCHAR((SELECT N FROM overlaps)) || ' overlapping pairs',
         IFF((SELECT N FROM overlaps) = 0, 'PASS', 'FAIL')
  UNION ALL
  SELECT 4, 'sessionized by gap, not calendar day',
         TO_VARCHAR((SELECT COUNT(*) FROM duty WHERE PAID_HOURS > 16)) || ' of '
           || TO_VARCHAR((SELECT COUNT(*) FROM duty)) || ' duty periods over 16h',
         IFF((SELECT COUNT(*) FROM duty WHERE PAID_HOURS > 16)
             <= 0.05 * GREATEST(1, (SELECT COUNT(*) FROM duty)), 'PASS', 'FAIL')
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
) ORDER BY CHK;
