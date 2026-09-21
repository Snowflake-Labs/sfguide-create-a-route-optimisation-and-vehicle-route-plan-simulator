-- =====================================================================
-- DATA INVARIANT: a vehicle emits ONE position stream, and every DEPARTED
-- event is evidenced by a physically plausible ping.
-- =====================================================================
-- The static gate (scripts/check_concurrent_streams.py) asserts the CODE keeps
-- its guards. This one asserts the DATA is actually clean, which is a different
-- question: the generator can regress, a dataset can be seeded by an older
-- build, or a preset can be added that reintroduces the overlap. All three are
-- silent - nothing throws, no row is missing, and each surface stays internally
-- consistent while disagreeing with the others.
--
-- Run after any reseed. Non-zero rows in either result is a FAILURE.
--
-- Baselines at the time of the fix (UsTexas 2026-09-01..11):
--   overlapping trip pairs   42 -> 0     (24 vehicles, longest 1,030 min)
--   teleport exit pings      53 -> 0     (max 952 km, one four days later)
-- UnitedStatesOfAmerica was 38 pairs / 20 vehicles; SanFrancisco was already 0,
-- which is why none of this was visible on the seed dataset.

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-delivery-sync","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- ---------------------------------------------------------------------
-- INVARIANT 1 - no vehicle runs two trips at the same time.
--
-- STRICT inequalities on purpose. Adjacent legs share a boundary instant by
-- construction (emitEmptyLeg's end IS the next trip's start), so a non-strict
-- test counts every deadhead->job pair as an "overlap" and reports hundreds of
-- false positives - which is exactly what a first pass at this query did.
-- ---------------------------------------------------------------------
WITH tr AS (
  SELECT REGION, VEHICLE_ID, TRIP_ID, MIN(TS) AS T0, MAX(TS) AS T1
  FROM SYNTHETIC_DATASETS.UNIFIED.V_FACT_VEHICLE_TELEMETRY_CURRENT
  WHERE TRIP_ID IS NOT NULL
  GROUP BY 1, 2, 3
)
SELECT
  'INVARIANT_1_OVERLAPPING_TRIPS' AS INVARIANT,
  a.REGION,
  COUNT(*)                        AS OVERLAPPING_PAIRS,
  COUNT(DISTINCT a.VEHICLE_ID)    AS VEHICLES,
  MAX(DATEDIFF('minute', GREATEST(a.T0, b.T0), LEAST(a.T1, b.T1)))
                                  AS LONGEST_OVERLAP_MIN,
  ANY_VALUE(a.VEHICLE_ID)         AS EXAMPLE_VEHICLE
FROM tr a
JOIN tr b
  ON  b.REGION     = a.REGION
  AND b.VEHICLE_ID = a.VEHICLE_ID
  AND b.TRIP_ID    > a.TRIP_ID
  AND a.T0 < b.T1
  AND b.T0 < a.T1
GROUP BY 1, 2
ORDER BY 2;

-- ---------------------------------------------------------------------
-- INVARIANT 2 - no DEPARTED event is evidenced by an implausible ping.
--
-- Evaluated against the SITE, deliberately coarser than the detector's own gate
-- (which measures from the last in-fence ping at millisecond resolution). This
-- is an independent smell test, not a restatement: a 5 km threshold cannot be
-- satisfied by any real exit from a 100-200 m geofence, so it convicts the
-- cross-stream case without depending on the same expression it is checking.
-- ---------------------------------------------------------------------
WITH v AS (
  SELECT REGION, VEHICLE_ID, SITE_ID, SITE_NAME, SITE_GEOG,
         FENCE_EXIT_TS, EXIT_TS
  FROM FLEET_APP.DELIVERY_SYNC.VW_SITE_VISITS
  WHERE EXIT_TS IS NOT NULL
)
SELECT
  'INVARIANT_2_TELEPORT_EXIT_PINGS' AS INVARIANT,
  v.REGION,
  COUNT(*)                                       AS BAD_DEPARTURES,
  ROUND(MAX(ST_DISTANCE(t.POINT_GEOM, v.SITE_GEOG)) / 1000.0, 1)
                                                 AS WORST_KM,
  MAX(DATEDIFF('second', v.FENCE_EXIT_TS, v.EXIT_TS))
                                                 AS WORST_LAG_S,
  ANY_VALUE(v.VEHICLE_ID)                        AS EXAMPLE_VEHICLE,
  ANY_VALUE(v.SITE_NAME)                         AS EXAMPLE_SITE
FROM v
JOIN SYNTHETIC_DATASETS.UNIFIED.V_FACT_VEHICLE_TELEMETRY_CURRENT t
  ON  t.REGION     = v.REGION
  AND t.VEHICLE_ID = v.VEHICLE_ID
  AND t.TS         = v.EXIT_TS
WHERE ST_DISTANCE(t.POINT_GEOM, v.SITE_GEOG) > 5000
   OR t.TRIP_ID IS NULL AND t.STATUS = 'IDLE'
GROUP BY 1, 2
ORDER BY 2;
