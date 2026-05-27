-- Traffic Calibration -- dynamic tables + calibrated_duration UDF
-- Skill: traffic-calibration (#64)
--
-- Run after build-routing-solution + at least one fleet-intelligence skill
-- have populated FACT_VEHICLE_TELEMETRY for the target region.

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-traffic-calibration","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.TRAFFIC
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-traffic-calibration","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

USE SCHEMA FLEET_INTELLIGENCE.TRAFFIC;

-- ---------------------------------------------------------------------------
-- OBSERVED_TRIPS
--
-- One row per trip with both the observed travel time and the ORS prediction
-- at the trip's start time. Trips with no usable origin/destination, no
-- ORS response, or duration <60s are filtered out -- short trips are
-- dominated by start/stop noise and would bias the speed factor low.
--
-- ROAD_CLASS is bucketed coarsely (highway, arterial, local) using the
-- average reported road class along the trip. Refine in a follow-up if
-- the eval notebook shows residual variance correlated with road type.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE DYNAMIC TABLE FLEET_INTELLIGENCE.TRAFFIC.OBSERVED_TRIPS
    TARGET_LAG = '1 hour'
    WAREHOUSE = ROUTING_ANALYTICS
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-traffic-calibration","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
WITH base AS (
    SELECT
        t.TRIP_ID,
        t.REGION,
        t.VEHICLE_TYPE                          AS PROFILE,
        t.TRIP_START_TIME,
        t.TRIP_END_TIME,
        DATE_PART(hour, t.TRIP_START_TIME)      AS HOUR_OF_DAY,
        DATE_PART(dow,  t.TRIP_START_TIME)      AS DOW,
        ST_X(t.ORIGIN)                          AS ORIG_LON,
        ST_Y(t.ORIGIN)                          AS ORIG_LAT,
        ST_X(t.DESTINATION)                     AS DEST_LON,
        ST_Y(t.DESTINATION)                     AS DEST_LAT,
        t.OBSERVED_DURATION_SEC,
        t.OBSERVED_DISTANCE_M,
        -- Average reported road class along the trip (telemetry includes it
        -- per ping). Bucket into highway / arterial / local.
        CASE
            WHEN AVG(t.AVG_ROAD_CLASS_LEVEL) <= 2 THEN 'highway'
            WHEN AVG(t.AVG_ROAD_CLASS_LEVEL) <= 4 THEN 'arterial'
            ELSE 'local'
        END                                     AS ROAD_CLASS
    FROM SYNTHETIC_DATASETS.UNIFIED.V_FACT_TRIPS_CURRENT t
    WHERE t.TRIP_END_TIME >= DATEADD(day, -14, SYSDATE())
      AND t.OBSERVED_DURATION_SEC >= 60
      AND t.OBSERVED_DISTANCE_M >= 100
    GROUP BY ALL
)
SELECT
    b.*,
    -- One DIRECTIONS call per trip. The Snowflake-side scalar UDF is
    -- batched by the gateway so this is efficient even on 100k+ trips.
    OPENROUTESERVICE_APP.CORE.DIRECTIONS(
        b.PROFILE, b.ORIG_LON, b.ORIG_LAT, b.DEST_LON, b.DEST_LAT, b.REGION
    ):duration::FLOAT AS ORS_PREDICTED_DURATION_SEC,
    -- Observed-to-predicted ratio. NULL when ORS could not route the trip
    -- (no graph, snapping failure, etc.).
    NULLIF(b.OBSERVED_DURATION_SEC, 0) /
        NULLIF(OPENROUTESERVICE_APP.CORE.DIRECTIONS(
            b.PROFILE, b.ORIG_LON, b.ORIG_LAT, b.DEST_LON, b.DEST_LAT, b.REGION
        ):duration::FLOAT, 0)               AS DURATION_RATIO
FROM base b;


-- ---------------------------------------------------------------------------
-- SPEED_FACTORS
--
-- The calibration target. One row per (profile, region, hour_of_day,
-- road_class) with the median DURATION_RATIO and the trip count that
-- contributed. Buckets below CALIBRATION_MIN_TRIPS_PER_BUCKET (default 30)
-- are excluded so the calibration is not anchored to a handful of outlier
-- trips. The CALIBRATED_DURATION UDF falls back to 1.0 for missing
-- buckets, so excluding low-sample buckets is safe.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE DYNAMIC TABLE FLEET_INTELLIGENCE.TRAFFIC.SPEED_FACTORS
    TARGET_LAG = '1 hour'
    WAREHOUSE = ROUTING_ANALYTICS
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-traffic-calibration","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT
    PROFILE,
    REGION,
    HOUR_OF_DAY,
    ROAD_CLASS,
    APPROX_PERCENTILE(DURATION_RATIO, 0.5) AS SPEED_FACTOR,
    COUNT(*)                               AS TRIP_COUNT,
    AVG(DURATION_RATIO)                    AS MEAN_RATIO,
    STDDEV(DURATION_RATIO)                 AS STDDEV_RATIO
FROM FLEET_INTELLIGENCE.TRAFFIC.OBSERVED_TRIPS
WHERE DURATION_RATIO IS NOT NULL
  AND DURATION_RATIO BETWEEN 0.3 AND 3.0   -- drop GPS-error outliers
GROUP BY PROFILE, REGION, HOUR_OF_DAY, ROAD_CLASS
HAVING COUNT(*) >= 30;                     -- CALIBRATION_MIN_TRIPS_PER_BUCKET


-- ---------------------------------------------------------------------------
-- CALIBRATED_DURATION
--
-- Scalar UDF callers use instead of the raw ORS duration. Falls back to
-- the raw duration when no factor is available for the bucket, so
-- downstream demos keep working even if traffic-calibration is not
-- deployed yet.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION FLEET_INTELLIGENCE.TRAFFIC.CALIBRATED_DURATION(
    P_PROFILE     VARCHAR,
    P_RAW_DURATION_SEC FLOAT,
    P_HOUR_OF_DAY INTEGER,
    P_ROAD_CLASS  VARCHAR,
    P_REGION      VARCHAR
)
RETURNS FLOAT
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-traffic-calibration","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
    SELECT P_RAW_DURATION_SEC * COALESCE(
        (SELECT SPEED_FACTOR
           FROM FLEET_INTELLIGENCE.TRAFFIC.SPEED_FACTORS
          WHERE PROFILE     = P_PROFILE
            AND REGION      = P_REGION
            AND HOUR_OF_DAY = P_HOUR_OF_DAY
            AND ROAD_CLASS  = P_ROAD_CLASS),
        1.0
    )
$$;
