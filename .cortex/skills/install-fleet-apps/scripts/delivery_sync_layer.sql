-- =====================================================================
-- DELIVERY SYNC layer - site arrival / departure / approach notifications
-- =====================================================================
-- Answers the question "when did the vehicle reach the delivery site, and
-- when did it leave?" so a downstream crew (receiving team, merchandiser,
-- yard marshal) is told to move only once the product is actually there.
--
-- Three events per (vehicle, site) visit:
--   APPROACHING - vehicle crossed INTO the site's live drive-time ring
--   ARRIVED     - vehicle became stationary inside the site geofence
--   DEPARTED    - vehicle stopped being stationary inside the geofence
--                 (this is the one that matters: work starts after unload)
--
-- GEOFENCE EPISODE DETECTION
-- The detector is a port of the runway-crossing episode pattern from
-- Snowflake-Labs/sfguide-aviation-ops-intelligence
-- (.cortex/skills/aviation-installer/derived-analytics/references/04-runway-crossings.md).
-- That query tags each ping with polygon containment, uses LAG/LEAD to find
-- the entry and exit edges, assigns an episode id with a running sum over the
-- entry edges, then filters the EPISODE (not the ping) on plausibility gates.
--
-- Three deliberate adaptations, each of which is load-bearing:
--
--   1. NO CROSS JOIN. The aviation query does `pts CROSS JOIN runways`, which
--      is fine for a handful of runways but explodes against thousands of
--      sites x millions of pings. We inner-join on ST_DWITHIN instead. That
--      breaks the LAG(inside)/LEAD(inside) trick, because an inner join keeps
--      ONLY inside-rows, so `prev_inside` would always be TRUE and no entry
--      edge would ever fire. We therefore give every ping a per-vehicle
--      sequence number and detect a seq DISCONTINUITY: if seq - LAG(seq) > 1
--      the previous ping was outside the geofence. That is exactly equivalent
--      to `prev_inside = FALSE` and costs one window function.
--
--   2. GATES ARE INVERTED. A runway crossing is fast, short and straight
--      (max_speed high, duration <= 300s, chord large). A vehicle DRIVING PAST
--      a site produces that same signature, so inverting those gates is
--      precisely the pass-by rejector. Measured on the reference NJ HGV
--      dataset: 3,582 raw containment episodes in one day collapse to ~158
--      genuine stationary visits, i.e. ~96% of drive-bys rejected.
--
--   3. GATE THE STATIONARY CORE, NOT THE EPISODE. This is the subtle one. A
--      delivery episode BEGINS AND ENDS WHILE MOVING (the vehicle drives into
--      the yard, stops, then drives out), so MAX(speed) over the containment
--      episode is high and an aviation-style `max_speed <= X` gate rejects
--      every real delivery. We therefore define ARRIVAL/DEPARTURE from the
--      stationary sub-window (speed <= STATIONARY_SPEED_KMH) inside the
--      episode. Using the whole-episode max speed instead drops recall from
--      ~62 deliveries/day to 10 - a silent 6x undercount.
--
-- Two further corrections found in validation:
--   - Each ping is assigned to exactly ONE site (nearest). Without this, a
--     single stop inside a cluster of three nearby sites emits three
--     duplicate visits.
--   - The vehicle's own HOME_LOCATION_ID is excluded and episodes are capped
--     at MAX_STOP_SECONDS, so overnight parking is not reported as a delivery.
--
-- Detection is deliberately LABEL-FREE: it uses only geometry, time and
-- speed, never the generator's STATUS column, so it behaves the same on real
-- telemetry. The source status is carried through as SOURCE_STATUS_HINT for
-- filtering/among only, never as a detection input.
--
-- LAYERING
-- The Dynamic Table reads the PHYSICAL dataset-scoped projections
-- (SYNTHETIC_DATASETS.UNIFIED.V_*_CURRENT), mirroring how DWELL_ANALYSIS
-- builds its DTs, because a Dynamic Table cannot read FLEET_APP.CORE.VW_*
-- (those wrap table functions). Consumers bind ONLY to the neutral
-- FLEET_APP.DELIVERY_SYNC.* views authored at the bottom of this file
-- (Architecture Tenet 5).
--
-- Live routing (Architecture Tenet 9): the approach ring and the inbound ETA
-- call ORS at interaction time. Nothing is precomputed or cached.
-- =====================================================================

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-delivery-sync","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.DELIVERY_SYNC
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-delivery-sync","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- ---------------------------------------------------------------------
-- 1. Tunable detector parameters (single row). Region-agnostic on purpose:
--    the projection views are already scoped to the active dataset, and the
--    geofence radius is resolved per (vehicle type, site type) from
--    FLEET_INTELLIGENCE.CORE.DIM_VEHICLE_DWELL_SLA.BUFFER_RADIUS_M. Editing a
--    value here re-refreshes the Dynamic Table, so the radius and the gates
--    are demo-tunable without a redeploy.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.DELIVERY_SYNC.PARAMS (
  MONITORED_SITE_TYPES   VARCHAR      DEFAULT 'WAREHOUSE,STORE,DESTINATION',
  STATIONARY_SPEED_KMH   FLOAT        DEFAULT 5,
  MIN_STOP_SECONDS       NUMBER       DEFAULT 180,
  MAX_STOP_SECONDS       NUMBER       DEFAULT 7200,
  MIN_STATIONARY_PINGS   NUMBER       DEFAULT 2,
  APPROACH_SECONDS       NUMBER       DEFAULT 900,
  UPDATED_AT             TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-delivery-sync","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- Seed exactly one row (idempotent).
INSERT INTO FLEET_INTELLIGENCE.DELIVERY_SYNC.PARAMS
  (MONITORED_SITE_TYPES, STATIONARY_SPEED_KMH, MIN_STOP_SECONDS, MAX_STOP_SECONDS,
   MIN_STATIONARY_PINGS, APPROACH_SECONDS)
SELECT 'WAREHOUSE,STORE,DESTINATION', 5, 180, 7200, 2, 900
WHERE NOT EXISTS (SELECT 1 FROM FLEET_INTELLIGENCE.DELIVERY_SYNC.PARAMS);

-- ---------------------------------------------------------------------
-- 2. DT_SITE_VISITS - one row per (vehicle, site, visit) with a genuine
--    geofence-entry arrival and geofence-exit departure.
-- ---------------------------------------------------------------------
CREATE OR REPLACE DYNAMIC TABLE FLEET_INTELLIGENCE.DELIVERY_SYNC.DT_SITE_VISITS
  TARGET_LAG = '1 hour'
  WAREHOUSE = ROUTING_ANALYTICS
  INITIALIZE = ON_CREATE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-delivery-sync","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
WITH prm AS (
  SELECT MONITORED_SITE_TYPES, STATIONARY_SPEED_KMH, MIN_STOP_SECONDS,
         MAX_STOP_SECONDS, MIN_STATIONARY_PINGS
  FROM FLEET_INTELLIGENCE.DELIVERY_SYNC.PARAMS LIMIT 1
),
-- Every ping, with a per-vehicle monotonic sequence. The sequence is what
-- lets us recover true outside->inside transitions after an inner join
-- (adaptation 1 above).
pts AS (
  SELECT
    t.REGION, t.VEHICLE_ID, t.TRIP_ID, t.TS, t.POINT_GEOM,
    t.LATITUDE, t.LONGITUDE, t.SPEED_KMH, t.STATUS AS SOURCE_STATUS_HINT,
    f.VEHICLE_TYPE, f.HOME_LOCATION_ID,
    ROW_NUMBER() OVER (PARTITION BY t.REGION, t.VEHICLE_ID ORDER BY t.TS) AS SEQ
  FROM SYNTHETIC_DATASETS.UNIFIED.V_FACT_VEHICLE_TELEMETRY_CURRENT t
  JOIN SYNTHETIC_DATASETS.UNIFIED.V_DIM_FLEET_CURRENT f
    ON f.VEHICLE_ID = t.VEHICLE_ID AND f.REGION = t.REGION
),
-- Monitored sites, with the geofence radius resolved per (vehicle type,
-- site type). This is the first consumer of BUFFER_RADIUS_M, which was
-- previously stored but read by nothing.
sites AS (
  SELECT
    p.LOCATION_ID, p.REGION, p.NAME AS SITE_NAME, p.LOCATION_TYPE,
    p.CATEGORY AS SITE_CATEGORY, p.POINT_GEOM,
    sla.VEHICLE_TYPE, sla.BUFFER_RADIUS_M
  FROM SYNTHETIC_DATASETS.UNIFIED.V_DIM_POIS_CURRENT p
  JOIN FLEET_INTELLIGENCE.CORE.DIM_VEHICLE_DWELL_SLA sla
    ON sla.LOCATION_TYPE = p.LOCATION_TYPE
  CROSS JOIN prm
  WHERE ARRAY_CONTAINS(p.LOCATION_TYPE::VARIANT,
                       STRTOK_TO_ARRAY(prm.MONITORED_SITE_TYPES, ','))
),
-- Containment, one site per ping (nearest wins). Home base excluded so
-- overnight parking is never reported as a delivery.
inside AS (
  SELECT
    p.REGION, p.VEHICLE_ID, p.VEHICLE_TYPE, p.TRIP_ID, p.TS, p.SEQ,
    p.LATITUDE, p.LONGITUDE, p.SPEED_KMH, p.SOURCE_STATUS_HINT,
    s.LOCATION_ID, s.SITE_NAME, s.LOCATION_TYPE, s.SITE_CATEGORY,
    s.POINT_GEOM AS SITE_GEOM, s.BUFFER_RADIUS_M
  FROM pts p
  JOIN sites s
    ON s.REGION = p.REGION
   AND s.VEHICLE_TYPE = p.VEHICLE_TYPE
   AND ST_DWITHIN(p.POINT_GEOM, s.POINT_GEOM, s.BUFFER_RADIUS_M)
  WHERE s.LOCATION_ID <> COALESCE(p.HOME_LOCATION_ID, '~none~')
  QUALIFY ROW_NUMBER() OVER (
            PARTITION BY p.REGION, p.VEHICLE_ID, p.SEQ
            ORDER BY ST_DISTANCE(p.POINT_GEOM, s.POINT_GEOM)) = 1
),
-- Entry edge = sequence discontinuity (previous ping was outside).
edged AS (
  SELECT *,
    LAG(SEQ) OVER (PARTITION BY REGION, VEHICLE_ID, LOCATION_ID ORDER BY SEQ) AS PREV_SEQ
  FROM inside
),
-- Running sum over entry edges = visit id. A second visit to the same site
-- later the same day becomes a separate episode rather than one smeared span.
episoded AS (
  SELECT *,
    SUM(IFF(PREV_SEQ IS NULL OR SEQ - PREV_SEQ > 1, 1, 0)) OVER (
      PARTITION BY REGION, VEHICLE_ID, LOCATION_ID
      ORDER BY SEQ ROWS UNBOUNDED PRECEDING) AS EPISODE_NO
  FROM edged
),
-- Collapse to one row per visit. ARRIVAL/DEPARTURE come from the STATIONARY
-- core (adaptation 3); the containment span is kept for diagnostics.
agg AS (
  SELECT
    e.REGION, e.VEHICLE_ID, e.VEHICLE_TYPE, e.LOCATION_ID, e.EPISODE_NO,
    ANY_VALUE(e.SITE_NAME)      AS SITE_NAME,
    ANY_VALUE(e.LOCATION_TYPE)  AS SITE_TYPE,
    ANY_VALUE(e.SITE_CATEGORY)  AS SITE_CATEGORY,
    ANY_VALUE(e.SITE_GEOM)      AS SITE_GEOG,
    ANY_VALUE(e.BUFFER_RADIUS_M) AS GEOFENCE_RADIUS_M,
    MODE(e.TRIP_ID)             AS JOURNEY_ID,
    MIN(IFF(e.SPEED_KMH <= prm.STATIONARY_SPEED_KMH, e.TS, NULL)) AS ARRIVAL_TS,
    MAX(IFF(e.SPEED_KMH <= prm.STATIONARY_SPEED_KMH, e.TS, NULL)) AS DEPARTURE_TS,
    COUNT_IF(e.SPEED_KMH <= prm.STATIONARY_SPEED_KMH)             AS STATIONARY_PINGS,
    MIN(e.TS)                   AS FENCE_ENTRY_TS,
    MAX(e.TS)                   AS FENCE_EXIT_TS,
    COUNT(*)                    AS FENCE_PINGS,
    ROUND(MAX(e.SPEED_KMH), 1)  AS MAX_SPEED_IN_FENCE,
    -- Chord: entry point to exit point. Small for a genuine stop (parked),
    -- large for a pass-by that traversed the circle.
    ROUND(ST_DISTANCE(
      ST_MAKEPOINT(MIN_BY(e.LONGITUDE, e.SEQ), MIN_BY(e.LATITUDE, e.SEQ)),
      ST_MAKEPOINT(MAX_BY(e.LONGITUDE, e.SEQ), MAX_BY(e.LATITUDE, e.SEQ)))) AS CHORD_M,
    -- Source-provided classification. Informational ONLY - never used to
    -- detect the visit. Lets the UI separate deliveries from pickups/idles.
    MODE(IFF(e.SPEED_KMH <= prm.STATIONARY_SPEED_KMH, e.SOURCE_STATUS_HINT, NULL))
      AS SOURCE_STATUS_HINT
  FROM episoded e CROSS JOIN prm
  GROUP BY e.REGION, e.VEHICLE_ID, e.VEHICLE_TYPE, e.LOCATION_ID, e.EPISODE_NO
)
SELECT
  MD5(a.REGION || '|' || a.VEHICLE_ID || '|' || a.LOCATION_ID || '|' || a.EPISODE_NO::VARCHAR) AS VISIT_ID,
  a.REGION, a.VEHICLE_ID, a.VEHICLE_TYPE, a.JOURNEY_ID,
  a.LOCATION_ID AS SITE_ID,
  -- Overture names arrive JSON-quoted; strip for display.
  TRIM(a.SITE_NAME, '"') AS SITE_NAME,
  a.SITE_TYPE, a.SITE_CATEGORY, a.SITE_GEOG, a.GEOFENCE_RADIUS_M,
  a.EPISODE_NO AS VISIT_SEQ,
  a.ARRIVAL_TS, a.DEPARTURE_TS,
  DATEDIFF('second', a.ARRIVAL_TS, a.DEPARTURE_TS) AS DWELL_SECONDS,
  ROUND(DATEDIFF('second', a.ARRIVAL_TS, a.DEPARTURE_TS) / 60.0, 1) AS DWELL_MINUTES,
  a.STATIONARY_PINGS, a.FENCE_ENTRY_TS, a.FENCE_EXIT_TS, a.FENCE_PINGS,
  a.MAX_SPEED_IN_FENCE, a.CHORD_M, a.SOURCE_STATUS_HINT,
  TO_DATE(a.ARRIVAL_TS) AS SERVICE_DATE
FROM agg a CROSS JOIN prm
WHERE a.ARRIVAL_TS IS NOT NULL
  AND a.DEPARTURE_TS IS NOT NULL
  AND a.STATIONARY_PINGS >= prm.MIN_STATIONARY_PINGS
  AND DATEDIFF('second', a.ARRIVAL_TS, a.DEPARTURE_TS) >= prm.MIN_STOP_SECONDS
  AND DATEDIFF('second', a.FENCE_ENTRY_TS, a.FENCE_EXIT_TS) <= prm.MAX_STOP_SECONDS;

-- ---------------------------------------------------------------------
-- 3. VW_SITE_VISIT_EVENTS - long form, one row per notifiable event.
--    ARRIVED and DEPARTED are historical facts from the detector.
--    PRODUCT_READY_TS = DEPARTURE_TS: the moment follow-on work can start.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.DELIVERY_SYNC.VW_SITE_VISIT_EVENTS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-delivery-sync","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT VISIT_ID, REGION, VEHICLE_ID, JOURNEY_ID, SITE_ID, SITE_NAME, SITE_TYPE,
       SITE_GEOG, VISIT_SEQ, SERVICE_DATE, SOURCE_STATUS_HINT,
       'ARRIVED' AS EVENT_TYPE, ARRIVAL_TS AS EVENT_TS,
       DWELL_MINUTES, NULL::TIMESTAMP_NTZ AS PRODUCT_READY_TS
FROM FLEET_INTELLIGENCE.DELIVERY_SYNC.DT_SITE_VISITS
UNION ALL
SELECT VISIT_ID, REGION, VEHICLE_ID, JOURNEY_ID, SITE_ID, SITE_NAME, SITE_TYPE,
       SITE_GEOG, VISIT_SEQ, SERVICE_DATE, SOURCE_STATUS_HINT,
       'DEPARTED' AS EVENT_TYPE, DEPARTURE_TS AS EVENT_TS,
       DWELL_MINUTES, DEPARTURE_TS AS PRODUCT_READY_TS
FROM FLEET_INTELLIGENCE.DELIVERY_SYNC.DT_SITE_VISITS;

-- ---------------------------------------------------------------------
-- 4. VW_SITE_READINESS - current state per site for a service date.
--    READY       - vehicle has left, product is on the floor
--    IN_PROGRESS - vehicle on site, unloading
--    EXPECTED    - a visit is known for the date but has not started
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.DELIVERY_SYNC.VW_SITE_READINESS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-delivery-sync","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT
  v.REGION, v.SERVICE_DATE, v.SITE_ID, v.SITE_NAME, v.SITE_TYPE, v.SITE_GEOG,
  v.VEHICLE_ID, v.JOURNEY_ID, v.VISIT_ID,
  v.ARRIVAL_TS, v.DEPARTURE_TS, v.DWELL_MINUTES,
  v.DEPARTURE_TS AS PRODUCT_READY_TS,
  v.SOURCE_STATUS_HINT,
  CASE
    WHEN v.DEPARTURE_TS IS NOT NULL THEN 'READY'
    WHEN v.ARRIVAL_TS   IS NOT NULL THEN 'IN_PROGRESS'
    ELSE 'EXPECTED'
  END AS READINESS_ENUM
FROM FLEET_INTELLIGENCE.DELIVERY_SYNC.DT_SITE_VISITS v;

-- ---------------------------------------------------------------------
-- 5. LIVE_APPROACH_RING - live drive-time ring around a site.
--    This is the APPROACHING trigger geometry and the map layer source.
--
--    UNIT TRAP: the ARRAY overload of ISOCHRONES takes the range in SECONDS
--    (ORS native), whereas the scalar (lon, lat, n, region) overload takes
--    MINUTES. Both return the same 87.2 km2 ring for Jersey City when given
--    900 and 15 respectively. We use the array overload (it is ~70x faster
--    than the scalar form) and therefore pass SECONDS.
--
--    APPROXIMATION, stated deliberately: an ORS isochrone is computed
--    OUTWARD FROM the site, so it models driving away from it rather than
--    toward it. On one-ways and asymmetric networks the two differ. It is
--    used as a trigger window and a visual, never as a quoted promise - the
--    quoted number comes from LIVE_INBOUND_ETA below.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION FLEET_INTELLIGENCE.DELIVERY_SYNC.LIVE_APPROACH_RING(
  P_REGION VARCHAR, P_PROFILE VARCHAR, P_SITE_ID VARCHAR, P_SECONDS NUMBER)
RETURNS TABLE (SITE_ID VARCHAR, SITE_NAME VARCHAR, RING_GEOG GEOGRAPHY, RANGE_SECONDS NUMBER)
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-delivery-sync","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH site AS (
    SELECT LOCATION_ID, TRIM(NAME, '"') AS SITE_NAME, LNG, LAT
    FROM SYNTHETIC_DATASETS.UNIFIED.V_DIM_POIS_CURRENT
    WHERE REGION = P_REGION AND LOCATION_ID = P_SITE_ID
    LIMIT 1
  ),
  ring AS (
    SELECT GEOJSON
    FROM TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES(
      P_PROFILE,
      ARRAY_CONSTRUCT(ARRAY_CONSTRUCT((SELECT LNG FROM site), (SELECT LAT FROM site))),
      ARRAY_CONSTRUCT(COALESCE(P_SECONDS, 900)),
      'time',
      P_REGION))
  )
  SELECT s.LOCATION_ID, s.SITE_NAME, r.GEOJSON, COALESCE(P_SECONDS, 900)
  FROM site s CROSS JOIN ring r
$$;

-- ---------------------------------------------------------------------
-- 6. LIVE_INBOUND_ETA - live road ETA from each in-flight vehicle to the
--    site it is heading for. This supplies the NUMBER in the notification
--    ("arriving in ~12 min"); a containment ring can only say in/out.
--
--    ONE MATRIX_TABULAR call covers all vehicles: origins = vehicle last
--    known positions ordered by VEHICLE_ID, destinations = the single site.
--    durations[i][0] is seconds, distances[i][0] is metres. Ordering of the
--    ARRAY_AGG must match the row ordering used to index back in - hence the
--    explicit ORDER BY in both places.
--
--    STALENESS GUARD: P_MAX_STALENESS_MIN drops vehicles whose most recent
--    ping is older than the window. Without it, "last position at or before
--    the as-of instant" happily returns a vehicle parked since yesterday and
--    reports a confident ETA computed from a day-old location.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION FLEET_INTELLIGENCE.DELIVERY_SYNC.LIVE_INBOUND_ETA(
  P_REGION VARCHAR, P_PROFILE VARCHAR, P_SITE_ID VARCHAR, P_AS_OF TIMESTAMP_NTZ,
  P_MAX_STALENESS_MIN NUMBER)
RETURNS TABLE (VEHICLE_ID VARCHAR, SITE_ID VARCHAR, SITE_NAME VARCHAR,
               MINUTES_OUT NUMBER(10,1), DISTANCE_KM NUMBER(10,2),
               ETA_TS TIMESTAMP_NTZ, POSITION_TS TIMESTAMP_NTZ,
               VEHICLE_GEOG GEOGRAPHY)
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-delivery-sync","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH site AS (
    SELECT LOCATION_ID, TRIM(NAME, '"') AS SITE_NAME, LNG, LAT
    FROM SYNTHETIC_DATASETS.UNIFIED.V_DIM_POIS_CURRENT
    WHERE REGION = P_REGION AND LOCATION_ID = P_SITE_ID
    LIMIT 1
  ),
  -- Last known position per vehicle at or before the as-of instant, dropping
  -- vehicles whose position is too old to be actionable.
  last_pos AS (
    SELECT VEHICLE_ID, TS, LATITUDE, LONGITUDE, POINT_GEOM
    FROM SYNTHETIC_DATASETS.UNIFIED.V_FACT_VEHICLE_TELEMETRY_CURRENT
    WHERE REGION = P_REGION
      AND TS <= COALESCE(P_AS_OF, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ)
      AND TS >= DATEADD('minute', -1 * COALESCE(P_MAX_STALENESS_MIN, 15),
                        COALESCE(P_AS_OF, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ))
    QUALIFY ROW_NUMBER() OVER (PARTITION BY VEHICLE_ID ORDER BY TS DESC) = 1
  ),
  ordered AS (
    SELECT VEHICLE_ID, TS, POINT_GEOM, LONGITUDE, LATITUDE,
           ROW_NUMBER() OVER (ORDER BY VEHICLE_ID) - 1 AS IDX
    FROM last_pos
  ),
  mtx AS (
    SELECT OPENROUTESERVICE_APP.CORE.MATRIX_TABULAR(
             P_PROFILE,
             (SELECT ARRAY_AGG(ARRAY_CONSTRUCT(LONGITUDE, LATITUDE))
                       WITHIN GROUP (ORDER BY VEHICLE_ID) FROM ordered),
             ARRAY_CONSTRUCT(ARRAY_CONSTRUCT((SELECT LNG FROM site), (SELECT LAT FROM site))),
             P_REGION) AS R
  )
  SELECT
    o.VEHICLE_ID,
    s.LOCATION_ID,
    s.SITE_NAME,
    ROUND(m.R:durations[o.IDX][0]::FLOAT / 60.0, 1)::NUMBER(10,1)   AS MINUTES_OUT,
    ROUND(m.R:distances[o.IDX][0]::FLOAT / 1000.0, 2)::NUMBER(10,2) AS DISTANCE_KM,
    DATEADD('second', m.R:durations[o.IDX][0]::FLOAT::INT, o.TS) AS ETA_TS,
    o.TS,
    o.POINT_GEOM
  FROM ordered o CROSS JOIN mtx m CROSS JOIN site s
  WHERE m.R:durations IS NOT NULL
$$;

-- ---------------------------------------------------------------------
-- 7. DELIVERY_EVENT_LOG - fire-once notification ledger.
--    The MERGE key includes VISIT_ID (which embeds the episode number), so
--    re-running the task cannot double-notify, and a genuine second visit to
--    the same site on the same day is still notified separately.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.DELIVERY_SYNC.DELIVERY_EVENT_LOG (
  VISIT_ID       VARCHAR,
  EVENT_TYPE     VARCHAR,
  REGION         VARCHAR,
  VEHICLE_ID     VARCHAR,
  SITE_ID        VARCHAR,
  SITE_NAME      VARCHAR,
  EVENT_TS       TIMESTAMP_NTZ,
  DWELL_MINUTES  NUMBER(10,1),
  NOTIFIED_AT    TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-delivery-sync","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- Created SUSPENDED for cost (mirrors DWELL_ANALYSIS.LOG_SLA_ALERTS). Resume
-- for a rehearsal/demo, suspend afterwards.
CREATE OR REPLACE TASK FLEET_INTELLIGENCE.DELIVERY_SYNC.LOG_DELIVERY_EVENTS
  WAREHOUSE = ROUTING_ANALYTICS
  SCHEDULE = '5 MINUTE'
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-delivery-sync","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
MERGE INTO FLEET_INTELLIGENCE.DELIVERY_SYNC.DELIVERY_EVENT_LOG t
USING (
  SELECT VISIT_ID, EVENT_TYPE, REGION, VEHICLE_ID, SITE_ID, SITE_NAME,
         EVENT_TS, DWELL_MINUTES
  FROM FLEET_INTELLIGENCE.DELIVERY_SYNC.VW_SITE_VISIT_EVENTS
  WHERE EVENT_TS IS NOT NULL
) s
ON t.VISIT_ID = s.VISIT_ID AND t.EVENT_TYPE = s.EVENT_TYPE
WHEN NOT MATCHED THEN INSERT
  (VISIT_ID, EVENT_TYPE, REGION, VEHICLE_ID, SITE_ID, SITE_NAME, EVENT_TS, DWELL_MINUTES)
  VALUES (s.VISIT_ID, s.EVENT_TYPE, s.REGION, s.VEHICLE_ID, s.SITE_ID, s.SITE_NAME,
          s.EVENT_TS, s.DWELL_MINUTES);

ALTER TASK FLEET_INTELLIGENCE.DELIVERY_SYNC.LOG_DELIVERY_EVENTS SUSPEND;

-- =====================================================================
-- 8. FLEET_APP.DELIVERY_SYNC - neutral contract. Consumers (app views,
--    semantic view, agent verbs) bind here and NEVER to FLEET_INTELLIGENCE.
-- =====================================================================
CREATE SCHEMA IF NOT EXISTS FLEET_APP.DELIVERY_SYNC
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-delivery-sync","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE OR REPLACE VIEW FLEET_APP.DELIVERY_SYNC.VW_SITE_VISITS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-delivery-sync","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
  AS SELECT * FROM FLEET_INTELLIGENCE.DELIVERY_SYNC.DT_SITE_VISITS;

CREATE OR REPLACE VIEW FLEET_APP.DELIVERY_SYNC.VW_EVENTS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-delivery-sync","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
  AS SELECT * FROM FLEET_INTELLIGENCE.DELIVERY_SYNC.VW_SITE_VISIT_EVENTS;

CREATE OR REPLACE VIEW FLEET_APP.DELIVERY_SYNC.VW_SITE_READINESS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-delivery-sync","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
  AS SELECT * FROM FLEET_INTELLIGENCE.DELIVERY_SYNC.VW_SITE_READINESS;

CREATE OR REPLACE VIEW FLEET_APP.DELIVERY_SYNC.VW_EVENT_LOG
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-delivery-sync","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
  AS SELECT * FROM FLEET_INTELLIGENCE.DELIVERY_SYNC.DELIVERY_EVENT_LOG;

-- Active region + ORS profile pointer, so app views and the agent can resolve
-- the live-routing arguments without hardcoding a region.
CREATE OR REPLACE VIEW FLEET_APP.DELIVERY_SYNC.VW_ACTIVE_SCOPE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-delivery-sync","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
  AS
  SELECT d.REGION, d.VEHICLE_TYPE, ANY_VALUE(f.ORS_PROFILE) AS ORS_PROFILE,
         ANY_VALUE(p.APPROACH_SECONDS) AS APPROACH_SECONDS
  FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS d
  LEFT JOIN SYNTHETIC_DATASETS.UNIFIED.V_DIM_FLEET_CURRENT f
    ON f.REGION = d.REGION
  CROSS JOIN FLEET_INTELLIGENCE.DELIVERY_SYNC.PARAMS p
  WHERE d.IS_ACTIVE = TRUE
  GROUP BY d.REGION, d.VEHICLE_TYPE;

-- Live UDTF passthroughs so the app never references FLEET_INTELLIGENCE.
CREATE OR REPLACE FUNCTION FLEET_APP.DELIVERY_SYNC.LIVE_APPROACH_RING(
  P_REGION VARCHAR, P_PROFILE VARCHAR, P_SITE_ID VARCHAR, P_SECONDS NUMBER)
RETURNS TABLE (SITE_ID VARCHAR, SITE_NAME VARCHAR, RING_GEOG GEOGRAPHY, RANGE_SECONDS NUMBER)
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-delivery-sync","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  SELECT * FROM TABLE(FLEET_INTELLIGENCE.DELIVERY_SYNC.LIVE_APPROACH_RING(
    P_REGION, P_PROFILE, P_SITE_ID, P_SECONDS))
$$;

CREATE OR REPLACE FUNCTION FLEET_APP.DELIVERY_SYNC.LIVE_INBOUND_ETA(
  P_REGION VARCHAR, P_PROFILE VARCHAR, P_SITE_ID VARCHAR, P_AS_OF TIMESTAMP_NTZ,
  P_MAX_STALENESS_MIN NUMBER)
RETURNS TABLE (VEHICLE_ID VARCHAR, SITE_ID VARCHAR, SITE_NAME VARCHAR,
               MINUTES_OUT NUMBER(10,1), DISTANCE_KM NUMBER(10,2),
               ETA_TS TIMESTAMP_NTZ, POSITION_TS TIMESTAMP_NTZ,
               VEHICLE_GEOG GEOGRAPHY)
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-delivery-sync","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  SELECT * FROM TABLE(FLEET_INTELLIGENCE.DELIVERY_SYNC.LIVE_INBOUND_ETA(
    P_REGION, P_PROFILE, P_SITE_ID, P_AS_OF, P_MAX_STALENESS_MIN))
$$;

-- ---------------------------------------------------------------------
-- 9. Grants (mirrors the SOURCING / LOCATION seams)
-- ---------------------------------------------------------------------
GRANT USAGE ON SCHEMA FLEET_APP.DELIVERY_SYNC TO ROLE FLEET_APP_USER;
GRANT SELECT ON ALL VIEWS IN SCHEMA FLEET_APP.DELIVERY_SYNC TO ROLE FLEET_APP_USER;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA FLEET_APP.DELIVERY_SYNC TO ROLE FLEET_APP_USER;
GRANT USAGE ON ALL FUNCTIONS IN SCHEMA FLEET_APP.DELIVERY_SYNC TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUTURE FUNCTIONS IN SCHEMA FLEET_APP.DELIVERY_SYNC TO ROLE FLEET_APP_USER;

GRANT USAGE ON SCHEMA FLEET_APP.DELIVERY_SYNC TO ROLE FLEET_APP_OPS;
GRANT SELECT ON ALL VIEWS IN SCHEMA FLEET_APP.DELIVERY_SYNC TO ROLE FLEET_APP_OPS;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA FLEET_APP.DELIVERY_SYNC TO ROLE FLEET_APP_OPS;
GRANT USAGE ON ALL FUNCTIONS IN SCHEMA FLEET_APP.DELIVERY_SYNC TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUTURE FUNCTIONS IN SCHEMA FLEET_APP.DELIVERY_SYNC TO ROLE FLEET_APP_OPS;

GRANT USAGE ON SCHEMA FLEET_APP.DELIVERY_SYNC TO ROLE FLEET_APP_ADMIN;
GRANT SELECT ON ALL VIEWS IN SCHEMA FLEET_APP.DELIVERY_SYNC TO ROLE FLEET_APP_ADMIN;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA FLEET_APP.DELIVERY_SYNC TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON ALL FUNCTIONS IN SCHEMA FLEET_APP.DELIVERY_SYNC TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUTURE FUNCTIONS IN SCHEMA FLEET_APP.DELIVERY_SYNC TO ROLE FLEET_APP_ADMIN;
