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
) ORDER BY CHK;
