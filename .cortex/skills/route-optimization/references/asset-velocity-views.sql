-- Asset Velocity views for Non-Moving Trailer Detection & Action Engine
-- Reuses FLEET_INTELLIGENCE.DWELL_ANALYSIS Dynamic Tables (must be deployed via dwell-analysis skill)
-- Source telemetry must exist in SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY / FACT_TRIPS / DIM_FLEET / DIM_POIS

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-route-optimization","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- 0. Cost-of-idleness configuration row (re-uses existing CONFIG table)
ALTER TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG ADD COLUMN IF NOT EXISTS DAILY_RENTAL_RATE_AVOIDED_USD NUMBER(10,2);
ALTER TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG ADD COLUMN IF NOT EXISTS RENTAL_CAPTURE_RATE NUMBER(4,3);
UPDATE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG
   SET DAILY_RENTAL_RATE_AVOIDED_USD = COALESCE(DAILY_RENTAL_RATE_AVOIDED_USD, 80.00),
       RENTAL_CAPTURE_RATE          = COALESCE(RENTAL_CAPTURE_RATE, 0.600);

-- 1. VW_IDLE_TRAILERS
-- Latest dwell session per HGV vehicle, with idle-duration metrics and dispatcher mapping.
-- Maintenance/damage exception filter: drops sessions where DRIVER_PROFILE = 'OUTLIER' and excludes any STATUS containing MAINTENANCE.
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.VW_IDLE_TRAILERS
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-route-optimization","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
WITH last_session AS (
  SELECT
    e.VEHICLE_ID,
    e.SESSION_ID,
    e.STATUS,
    e.LOCATION_ID,
    e.LOCATION_NAME,
    e.CITY,
    e.FACILITY_TYPE,
    e.LOC_TYPE,
    e.SESSION_START,
    e.SESSION_END,
    e.DWELL_MINUTES,
    e.AVG_POINT,
    e.HOME_BASE_NAME,
    e.OPERATING_MODE,
    e.DRIVER_PROFILE,
    ROW_NUMBER() OVER (PARTITION BY e.VEHICLE_ID ORDER BY e.SESSION_END DESC) AS RN
  FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DWELL_ENRICHED e
  WHERE (e.STATUS LIKE 'DWELL%' OR e.STATUS = 'IDLE')
    AND e.OPERATING_MODE = 'trucking'
    AND COALESCE(UPPER(e.STATUS), '') NOT LIKE '%MAINTENANCE%'
    AND COALESCE(UPPER(e.DRIVER_PROFILE), 'COMPLIANT') <> 'OUTLIER'
),
fleet AS (
  SELECT VEHICLE_ID, REGION, HOME_LOCATION_ID, DRIVER_PROFILE
  FROM SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET
  WHERE VEHICLE_TYPE = 'hgv'
)
SELECT
  ls.VEHICLE_ID,
  f.REGION,
  ls.LOCATION_ID                                                            AS LAST_LOCATION_ID,
  ls.LOCATION_NAME                                                          AS LAST_LOCATION_NAME,
  ls.LOC_TYPE                                                               AS LAST_LOCATION_TYPE,
  ls.AVG_POINT                                                              AS LAST_LOCATION_GEOM,
  ST_X(ls.AVG_POINT)                                                        AS LAST_LNG,
  ST_Y(ls.AVG_POINT)                                                        AS LAST_LAT,
  ls.SESSION_START                                                          AS IDLE_SINCE,
  ls.DWELL_MINUTES                                                          AS IDLE_MINUTES,
  ROUND(ls.DWELL_MINUTES / 60.0, 1)                                         AS IDLE_HOURS,
  ROUND(ls.DWELL_MINUTES / 60.0 / 24.0, 2)                                  AS IDLE_DAYS,
  ls.HOME_BASE_NAME,
  -- Stable, region-aware dispatcher assignment (avoids needing a real EVO mapping table)
  'DISP-' || LPAD(MOD(ABS(HASH(ls.VEHICLE_ID)), 12) + 1, 2, '0')            AS ASSIGNED_DISPATCHER,
  ls.DRIVER_PROFILE
FROM last_session ls
JOIN fleet f ON ls.VEHICLE_ID = f.VEHICLE_ID
WHERE ls.RN = 1;

-- 2. VW_LANE_DEMAND
-- Net outbound trips per origin terminal over the most recent 30 days of trips found in FACT_TRIPS.
-- A high NET_OUTBOUND_TRIPS value means the terminal is currently *short* on trailers - exactly the place
-- to reposition a ghost trailer to.
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.VW_LANE_DEMAND
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-route-optimization","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
WITH window_bounds AS (
  SELECT MAX(TRIP_START) AS MAX_TS FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS WHERE VEHICLE_TYPE = 'hgv'
),
recent_trips AS (
  SELECT t.*
  FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS t, window_bounds w
  WHERE t.VEHICLE_TYPE = 'hgv'
    AND t.TRIP_START >= DATEADD('day', -30, w.MAX_TS)
),
flows AS (
  SELECT ORIGIN_POI_ID      AS POI_ID, COUNT(*) AS OUT_CNT, 0 AS IN_CNT FROM recent_trips GROUP BY 1
  UNION ALL
  SELECT DESTINATION_POI_ID AS POI_ID, 0 AS OUT_CNT, COUNT(*) AS IN_CNT FROM recent_trips GROUP BY 1
),
agg AS (
  SELECT POI_ID, SUM(OUT_CNT) AS OUTBOUND, SUM(IN_CNT) AS INBOUND
  FROM flows
  WHERE POI_ID IS NOT NULL
  GROUP BY POI_ID
)
SELECT
  p.LOCATION_ID                                       AS TERMINAL_ID,
  p.REGION,
  p.NAME                                              AS TERMINAL_NAME,
  p.LOCATION_TYPE,
  p.POINT_GEOM                                        AS TERMINAL_GEOM,
  p.LAT                                               AS TERMINAL_LAT,
  p.LNG                                               AS TERMINAL_LNG,
  a.OUTBOUND,
  a.INBOUND,
  (a.OUTBOUND - a.INBOUND)                            AS NET_OUTBOUND_TRIPS,
  -- Demand score = net outbound trips, clipped to 0+, scaled by inbound deficit
  GREATEST(0, a.OUTBOUND - a.INBOUND)
    + ROUND(GREATEST(0, a.OUTBOUND - a.INBOUND) * 0.25, 0) AS DEMAND_SCORE
FROM agg a
JOIN SYNTHETIC_DATASETS.UNIFIED.DIM_POIS p
  ON p.LOCATION_ID = a.POI_ID
WHERE p.LOCATION_TYPE IN ('WAREHOUSE','LOGISTICS','DEPOT','TERMINAL','ADDRESS','STORE','RESTAURANT')
  AND (a.OUTBOUND - a.INBOUND) > 0;

-- 3. VW_TRAILER_COST_OF_IDLENESS
-- Per-trailer cost of idleness using configurable rate, plus the projected weekly-savings number used by the
-- "Projected Rental Savings" KPI card.
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.VW_TRAILER_COST_OF_IDLENESS
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-route-optimization","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT
  t.VEHICLE_ID,
  t.REGION,
  t.LAST_LOCATION_NAME,
  t.LAST_LOCATION_TYPE,
  t.LAST_LNG,
  t.LAST_LAT,
  t.LAST_LOCATION_GEOM,
  t.IDLE_SINCE,
  t.IDLE_MINUTES,
  t.IDLE_HOURS,
  t.IDLE_DAYS,
  t.ASSIGNED_DISPATCHER,
  t.DRIVER_PROFILE,
  c.DAILY_RENTAL_RATE_AVOIDED_USD,
  c.RENTAL_CAPTURE_RATE,
  ROUND(t.IDLE_DAYS * c.DAILY_RENTAL_RATE_AVOIDED_USD, 2)                            AS COST_OF_IDLENESS_USD,
  ROUND(t.IDLE_DAYS * c.DAILY_RENTAL_RATE_AVOIDED_USD * c.RENTAL_CAPTURE_RATE, 2)    AS PROJECTED_SAVINGS_USD,
  CASE
    WHEN t.IDLE_DAYS >= 14 THEN 'CRITICAL'
    WHEN t.IDLE_DAYS >= 7  THEN 'WARNING'
    WHEN t.IDLE_DAYS >= 3  THEN 'WATCH'
    ELSE 'OK'
  END                                                                                AS IDLE_SEVERITY
FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.VW_IDLE_TRAILERS t
CROSS JOIN (SELECT MAX(DAILY_RENTAL_RATE_AVOIDED_USD) AS DAILY_RENTAL_RATE_AVOIDED_USD,
                   MAX(RENTAL_CAPTURE_RATE)          AS RENTAL_CAPTURE_RATE
            FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG) c;

-- 4. Verification
-- These should each return a non-zero row count once dwell-analysis DTs are populated.
SELECT 'VW_IDLE_TRAILERS' AS V, COUNT(*) AS CNT FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.VW_IDLE_TRAILERS
UNION ALL
SELECT 'VW_LANE_DEMAND',         COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.VW_LANE_DEMAND
UNION ALL
SELECT 'VW_TRAILER_COST_OF_IDLENESS', COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.VW_TRAILER_COST_OF_IDLENESS;
