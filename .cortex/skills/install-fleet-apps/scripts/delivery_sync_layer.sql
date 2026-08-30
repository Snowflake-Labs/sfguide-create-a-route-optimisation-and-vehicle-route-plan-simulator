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

-- Warehouse the Dynamic Table refreshes on. analytic_layer.sql (installer step
-- 3.5) already creates this, but declaring it here keeps this file self-sufficient
-- so it still works when run standalone or with SKIP_ANALYTIC=1.
CREATE WAREHOUSE IF NOT EXISTS ROUTING_ANALYTICS
  WAREHOUSE_SIZE = 'XSMALL'
  AUTO_SUSPEND = 60
  AUTO_RESUME = TRUE
  INITIALLY_SUSPENDED = TRUE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-delivery-sync","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.DELIVERY_SYNC
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-delivery-sync","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- ---------------------------------------------------------------------
-- 1. Tunable detector parameters (single row). Region-agnostic on purpose:
--    the projection views are already scoped to the active dataset, and the
--    geofence radius is resolved per (vehicle type, site type) from
--    FLEET_INTELLIGENCE.CORE.DIM_VEHICLE_DWELL_SLA.BUFFER_RADIUS_M. Editing a
--    value here re-refreshes the Dynamic Table, so the radius and the gates
--    are demo-tunable without a redeploy.
--
--    MONITORED_SITE_TYPES must cover EVERY LOCATION_TYPE the generator can
--    emit for a site worth notifying about, because the vocabulary is
--    per-preset, not universal (studio/profiles.ts category_map): regional-hgv
--    yields WAREHOUSE / REST_STOP / DESTINATION, urban-ebike yields RESTAURANT,
--    and urban-car falls through to the catch-all LOCATION. The original
--    'WAREHOUSE,STORE,DESTINATION' therefore matched the HGV presets only, and
--    Delivery Sync rendered an empty page for the SanFrancisco seed dataset
--    (4,996 RESTAURANT POIs) and for Europe (8,842 LOCATION POIs) even though
--    both had millions of pings. REST_STOP, DETOUR, IDLE and ADDRESS stay OUT
--    on purpose: a fuel stop or a roadside idle is not a delivery, and adding
--    REST_STOP would silently change the established HGV visit counts.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.DELIVERY_SYNC.PARAMS (
  MONITORED_SITE_TYPES   VARCHAR      DEFAULT 'WAREHOUSE,STORE,DESTINATION,RESTAURANT,LOCATION',
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
SELECT 'WAREHOUSE,STORE,DESTINATION,RESTAURANT,LOCATION', 5, 180, 7200, 2, 900
WHERE NOT EXISTS (SELECT 1 FROM FLEET_INTELLIGENCE.DELIVERY_SYNC.PARAMS);

-- Upgrade already-deployed accounts. The seed above is a no-op wherever the row
-- already exists, so without this an existing install keeps the old HGV-only
-- whitelist forever and re-running this file leaves Delivery Sync blank for the
-- seed and Europe datasets. Scoped to the exact legacy value so a demo-tuned
-- setting is never clobbered.
UPDATE FLEET_INTELLIGENCE.DELIVERY_SYNC.PARAMS
   SET MONITORED_SITE_TYPES = 'WAREHOUSE,STORE,DESTINATION,RESTAURANT,LOCATION',
       UPDATED_AT = CURRENT_TIMESTAMP()
 WHERE MONITORED_SITE_TYPES = 'WAREHOUSE,STORE,DESTINATION';

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
),
-- Site names are NOT unique: the reference NJ day alone has 10 distinct sites
-- called "Extra Space Storage", 8 "Public Storage", 4 "CubeSmart Self Storage".
-- Unqualified, the focus-site dropdown lists several identical entries and "just
-- left Public Storage" does not say which one - the same apparent contradiction
-- as a status disagreeing with the map. Counted over VISITED sites (the exact set
-- every UI surface offers) and region-wide rather than per day, so a site's label
-- does not change as the replay day changes.
dupnames AS (
  SELECT REGION, TRIM(SITE_NAME, '"') AS NM, COUNT(DISTINCT LOCATION_ID) AS N_SITES
  FROM agg
  GROUP BY 1, 2
)
SELECT
  MD5(a.REGION || '|' || a.VEHICLE_ID || '|' || a.LOCATION_ID || '|' || a.EPISODE_NO::VARCHAR) AS VISIT_ID,
  a.REGION, a.VEHICLE_ID, a.VEHICLE_TYPE, a.JOURNEY_ID,
  a.LOCATION_ID AS SITE_ID,
  -- Overture names arrive JSON-quoted; strip for display.
  TRIM(a.SITE_NAME, '"') AS SITE_NAME,
  -- Display label: the bare name when it is unique, otherwise the name plus its
  -- coordinates to 3 dp (~100 m), which is the only disambiguator available
  -- without a locality dataset and is the one a presenter can match against the
  -- map. SITE_ID stays the key everything joins and emits on.
  IFF(d.N_SITES > 1,
      TRIM(a.SITE_NAME, '"') || ' (' || TO_VARCHAR(ROUND(ST_Y(a.SITE_GEOG), 3))
        || ', ' || TO_VARCHAR(ROUND(ST_X(a.SITE_GEOG), 3)) || ')',
      TRIM(a.SITE_NAME, '"')) AS SITE_LABEL,
  a.SITE_TYPE, a.SITE_CATEGORY, a.SITE_GEOG, a.GEOFENCE_RADIUS_M,
  a.EPISODE_NO AS VISIT_SEQ,
  a.ARRIVAL_TS, a.DEPARTURE_TS,
  DATEDIFF('second', a.ARRIVAL_TS, a.DEPARTURE_TS) AS DWELL_SECONDS,
  ROUND(DATEDIFF('second', a.ARRIVAL_TS, a.DEPARTURE_TS) / 60.0, 1) AS DWELL_MINUTES,
  a.STATIONARY_PINGS, a.FENCE_ENTRY_TS, a.FENCE_EXIT_TS, a.FENCE_PINGS,
  a.MAX_SPEED_IN_FENCE, a.CHORD_M, a.SOURCE_STATUS_HINT,
  TO_DATE(a.ARRIVAL_TS) AS SERVICE_DATE
FROM agg a CROSS JOIN prm
LEFT JOIN dupnames d
  ON d.REGION = a.REGION AND d.NM = TRIM(a.SITE_NAME, '"')
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
SELECT VISIT_ID, REGION, VEHICLE_ID, JOURNEY_ID, SITE_ID, SITE_NAME, SITE_LABEL, SITE_TYPE,
       SITE_GEOG, VISIT_SEQ, SERVICE_DATE, SOURCE_STATUS_HINT,
       'ARRIVED' AS EVENT_TYPE, ARRIVAL_TS AS EVENT_TS,
       DWELL_MINUTES, NULL::TIMESTAMP_NTZ AS PRODUCT_READY_TS
FROM FLEET_INTELLIGENCE.DELIVERY_SYNC.DT_SITE_VISITS
UNION ALL
SELECT VISIT_ID, REGION, VEHICLE_ID, JOURNEY_ID, SITE_ID, SITE_NAME, SITE_LABEL, SITE_TYPE,
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
  v.REGION, v.SERVICE_DATE, v.SITE_ID, v.SITE_NAME, v.SITE_LABEL, v.SITE_TYPE, v.SITE_GEOG,
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
-- 4b. F_SITE_READINESS_ASOF - readiness evaluated AT AN INSTANT.
--     VW_SITE_READINESS above reports the terminal state of each visit, so on
--     historical data every visit is READY and nothing is ever IN_PROGRESS.
--     Replaying a timeline (which is what a demo or an "as of 09:00" question
--     does) needs the state the site was in at that instant:
--       EXPECTED    - as-of is before the vehicle arrived
--       IN_PROGRESS - vehicle on site at the as-of instant
--       READY       - vehicle had already left
--     P_AS_OF NULL means "now".
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION FLEET_INTELLIGENCE.DELIVERY_SYNC.F_SITE_READINESS_ASOF(
  P_REGION VARCHAR, P_AS_OF TIMESTAMP_NTZ)
RETURNS TABLE (REGION VARCHAR, SERVICE_DATE DATE, SITE_ID VARCHAR, SITE_NAME VARCHAR,
               SITE_TYPE VARCHAR, SITE_GEOG GEOGRAPHY, VEHICLE_ID VARCHAR,
               JOURNEY_ID VARCHAR, VISIT_ID VARCHAR, ARRIVAL_TS TIMESTAMP_NTZ,
               DEPARTURE_TS TIMESTAMP_NTZ, DWELL_MINUTES NUMBER(10,1),
               PRODUCT_READY_TS TIMESTAMP_NTZ, SOURCE_STATUS_HINT VARCHAR,
               READINESS_ENUM VARCHAR, MINUTES_SINCE_READY NUMBER(12,1))
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-delivery-sync","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  SELECT
    -- SITE_LABEL, not the raw name: duplicated names would make the readiness
    -- table and the site tooltip ambiguous. Column name unchanged for consumers.
    v.REGION, v.SERVICE_DATE, v.SITE_ID, v.SITE_LABEL AS SITE_NAME, v.SITE_TYPE, v.SITE_GEOG,
    v.VEHICLE_ID, v.JOURNEY_ID, v.VISIT_ID, v.ARRIVAL_TS, v.DEPARTURE_TS,
    v.DWELL_MINUTES, v.DEPARTURE_TS AS PRODUCT_READY_TS, v.SOURCE_STATUS_HINT,
    CASE
      WHEN COALESCE(P_AS_OF, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ) < v.ARRIVAL_TS   THEN 'EXPECTED'
      WHEN COALESCE(P_AS_OF, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ) < v.DEPARTURE_TS THEN 'IN_PROGRESS'
      ELSE 'READY'
    END AS READINESS_ENUM,
    IFF(COALESCE(P_AS_OF, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ) >= v.DEPARTURE_TS,
        ROUND(DATEDIFF('second', v.DEPARTURE_TS,
                       COALESCE(P_AS_OF, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ)) / 60.0, 1),
        NULL)::NUMBER(12,1) AS MINUTES_SINCE_READY
  FROM FLEET_INTELLIGENCE.DELIVERY_SYNC.DT_SITE_VISITS v
  WHERE (P_REGION IS NULL OR v.REGION = P_REGION)
$$;

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
    SELECT GEOJSON, RESPONSE
    FROM TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES(
      P_PROFILE,
      ARRAY_CONSTRUCT(ARRAY_CONSTRUCT((SELECT LNG FROM site), (SELECT LAT FROM site))),
      ARRAY_CONSTRUCT(COALESCE(P_SECONDS, 900)),
      'time',
      P_REGION))
  )
  -- FAIL LOUDLY when the routing engine is down. ISOCHRONES degrades a
  -- suspended engine into a row with GEOJSON = NULL and the reason in
  -- RESPONSE. The map layer drops null geometry silently (layer-compiler
  -- skips falsy geojsonColumn values), so a suspended region used to be
  -- indistinguishable from "this site has no ring" - a blank map with no
  -- explanation. Raising instead routes the request through the app's
  -- existing suspended-engine path: /api/query matches 'service_unreachable'
  -- against SUSPEND_SIGNATURES, reads the region out of the 'ors-service-*'
  -- host, returns a typed 503 and RESUMES the region. So the user gets
  -- "resume triggered, back in N minutes" instead of an empty layer.
  -- The raise is a deliberate TO_GEOGRAPHY parse failure: SQL UDFs cannot
  -- RAISE, and the resulting message carries both strings the detector needs.
  -- CASE is lazy here (verified against a healthy region), so the cast is
  -- only evaluated on the failure branch.
  SELECT s.LOCATION_ID, s.SITE_NAME,
         CASE
           WHEN r.GEOJSON IS NOT NULL THEN r.GEOJSON
           ELSE TO_GEOGRAPHY('ORS ' || COALESCE(r.RESPONSE:error::STRING, 'service_unreachable')
                             || ' host=' || COALESCE(r.RESPONSE:ors_host::STRING, '?'))
         END,
         COALESCE(P_SECONDS, 900)
  FROM site s CROSS JOIN ring r
$$;

-- ---------------------------------------------------------------------
-- 5b. LIVE_APPROACH_RINGS - the same 15-minute ring, for EVERY site on the
--     service day rather than one focus site.
--
--     WHY THIS EXISTS AT ALL: CORE.ISOCHRONES is tagged "multi-isochrone" and
--     accepts an ARRAY of up to 50 locations, but its body is
--     TO_GEOGRAPHY(resp:features[0]:geometry) - it returns ONLY THE FIRST
--     feature and silently discards the rest. ORS has already computed and
--     returned all N of them in RESPONSE:features, each tagged with
--     properties.group_index giving its position in the locations array. So we
--     read RESPONSE directly and FLATTEN it ourselves. That is not a new trick
--     here: the site_impact candidate-isochrone layer in app-views.json does
--     exactly the same. The shared wrapper is deliberately NOT changed - nine
--     other call sites depend on it returning exactly one row.
--
--     BATCHING: isochrones_maximum_locations = 50, so the sites are split into
--     three fixed batches of 50. That caps this at 150 sites; the busiest day
--     in the NJ dataset has 118, so there is headroom. Ordering by visit count
--     DESC (tie-broken by SITE_ID, so it is deterministic) means that if a day
--     ever exceeds 150 it degrades predictably to the 150 busiest sites rather
--     than to an arbitrary subset. Measured ~4.9s and ~958KB for 118 rings.
--
--     DEGRADES QUIETLY on a suspended engine, unlike LIVE_APPROACH_RING. Same
--     reasoning as LIVE_FLEET_STATUS: the single-site ring on the same map is
--     the designated canary that RAISES, which fires the resume notice and the
--     region resume, so there is nothing to gain from 118 simultaneous raises.
--     (Mechanically it would also need a sentinel row, because FLATTEN over a
--     missing `features` array yields zero rows and an expression-based raise
--     would never be evaluated.)
--
--     P_EXCLUDE_SITE_ID optionally drops one site, for a caller that wants to
--     draw that site's ring separately. The delivery_sync view passes NULL: it
--     draws its strong focus ring OVER the faint one instead, because binding
--     the exclusion to the clicked site would re-run this whole call on every
--     click for a difference nobody can see.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION FLEET_INTELLIGENCE.DELIVERY_SYNC.LIVE_APPROACH_RINGS(
  P_REGION VARCHAR, P_PROFILE VARCHAR, P_SECONDS NUMBER,
  P_SERVICE_DATE DATE, P_EXCLUDE_SITE_ID VARCHAR)
RETURNS TABLE (SITE_ID VARCHAR, SITE_NAME VARCHAR, RING_GEOG GEOGRAPHY, RANGE_SECONDS NUMBER)
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-delivery-sync","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH ranked AS (
    SELECT SITE_ID,
           ANY_VALUE(SITE_NAME) AS SITE_NAME,
           ST_X(ANY_VALUE(SITE_GEOG)) AS LNG,
           ST_Y(ANY_VALUE(SITE_GEOG)) AS LAT,
           ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC, SITE_ID) - 1 AS RN
    FROM FLEET_INTELLIGENCE.DELIVERY_SYNC.DT_SITE_VISITS
    WHERE REGION = P_REGION
      AND SERVICE_DATE = P_SERVICE_DATE
      AND SITE_GEOG IS NOT NULL
      AND SITE_ID <> COALESCE(P_EXCLUDE_SITE_ID, '~none~')
    GROUP BY SITE_ID
  ),
  batched AS (
    SELECT SITE_ID, SITE_NAME, LNG, LAT,
           FLOOR(RN / 50) AS BATCH_NO,
           MOD(RN, 50)    AS LOC_IDX
    FROM ranked
    WHERE RN < 150
  ),
  -- One ORS call per batch. The location arrays are UNCORRELATED scalar
  -- subqueries; a correlated form ("Unsupported subquery type cannot be
  -- evaluated") is why this is three explicit branches rather than a lateral
  -- join over batch numbers.
  b0 AS (
    SELECT 0 AS BATCH_NO, RESPONSE FROM TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES(
      P_PROFILE,
      (SELECT ARRAY_AGG(ARRAY_CONSTRUCT(LNG, LAT)) WITHIN GROUP (ORDER BY LOC_IDX)
         FROM batched WHERE BATCH_NO = 0),
      ARRAY_CONSTRUCT(COALESCE(P_SECONDS, 900)), 'time', P_REGION))
  ),
  b1 AS (
    SELECT 1 AS BATCH_NO, RESPONSE FROM TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES(
      P_PROFILE,
      (SELECT ARRAY_AGG(ARRAY_CONSTRUCT(LNG, LAT)) WITHIN GROUP (ORDER BY LOC_IDX)
         FROM batched WHERE BATCH_NO = 1),
      ARRAY_CONSTRUCT(COALESCE(P_SECONDS, 900)), 'time', P_REGION))
  ),
  b2 AS (
    SELECT 2 AS BATCH_NO, RESPONSE FROM TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES(
      P_PROFILE,
      (SELECT ARRAY_AGG(ARRAY_CONSTRUCT(LNG, LAT)) WITHIN GROUP (ORDER BY LOC_IDX)
         FROM batched WHERE BATCH_NO = 2),
      ARRAY_CONSTRUCT(COALESCE(P_SECONDS, 900)), 'time', P_REGION))
  ),
  responses AS (
    SELECT * FROM b0 UNION ALL SELECT * FROM b1 UNION ALL SELECT * FROM b2
  ),
  -- FLATTEN must live in its own CTE: doing the flatten and the join back to
  -- `batched` in a single step fails with "invalid identifier 'A.BATCH_NO'",
  -- because the outer alias is not in scope alongside the LATERAL.
  features AS (
    SELECT r.BATCH_NO AS BATCH_NO,
           f.value:properties:group_index::INT AS LOC_IDX,
           f.value:geometry AS GEOM
    FROM responses r, LATERAL FLATTEN(input => r.RESPONSE:features) f
  )
  SELECT b.SITE_ID, b.SITE_NAME, TO_GEOGRAPHY(x.GEOM), COALESCE(P_SECONDS, 900)
  FROM features x
  JOIN batched b ON b.BATCH_NO = x.BATCH_NO AND b.LOC_IDX = x.LOC_IDX
  WHERE x.GEOM IS NOT NULL
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
  -- FAIL LOUDLY on a suspended engine, same reasoning as LIVE_APPROACH_RING.
  -- This previously read `WHERE m.R:durations IS NOT NULL`, which turned a dead
  -- routing engine into an empty result set - the inbound table just went blank
  -- with no explanation. A deliberate TO_NUMBER parse failure carries the two
  -- strings /api/query needs ('service_unreachable' and the 'ors-service-*'
  -- host) so the app shows the resume notice instead.
  --
  -- Note this raises ONLY when at least one vehicle row exists: with no
  -- in-flight vehicles the CROSS JOIN yields no rows, the expression is never
  -- evaluated, and an empty result correctly means "nobody inbound" rather
  -- than an outage. A null duration for an INDIVIDUAL vehicle (unroutable
  -- point) still passes through as NULL - only a wholly missing `durations`
  -- array means the engine itself failed.
  SELECT
    o.VEHICLE_ID,
    s.LOCATION_ID,
    s.SITE_NAME,
    CASE
      WHEN m.R:durations IS NOT NULL
        THEN ROUND(m.R:durations[o.IDX][0]::FLOAT / 60.0, 1)::NUMBER(10,1)
      ELSE TO_NUMBER('ORS ' || COALESCE(m.R:error::STRING, 'service_unreachable')
                     || ' host=' || COALESCE(m.R:ors_host::STRING, '?'))
    END                                                             AS MINUTES_OUT,
    ROUND(m.R:distances[o.IDX][0]::FLOAT / 1000.0, 2)::NUMBER(10,2) AS DISTANCE_KM,
    DATEADD('second', m.R:durations[o.IDX][0]::FLOAT::INT, o.TS) AS ETA_TS,
    o.TS,
    o.POINT_GEOM
  FROM ordered o CROSS JOIN mtx m CROSS JOIN site s
$$;

-- ---------------------------------------------------------------------
-- 6b. LIVE_FLEET_STATUS - what every vehicle is doing at the replay instant.
--
--     LIVE_INBOUND_ETA answers "who is heading for THIS site". This answers the
--     fleet-wide question the map needs: is each vehicle on a site, has it just
--     left one, is it closing in, or is it simply driving. Statuses:
--
--       ON_SITE     - last known position is INSIDE a monitored site's geofence
--       JUST_LEFT   - departed within P_JUST_LEFT_MIN AND still inside the site's
--                     live drive-time band (P_APPROACH_MIN), i.e. inside the ring
--       APPROACHING - live road ETA to its OWN next site <= P_APPROACH_MIN
--       DRIVING     - en route, but further out than that
--       IDLE        - no further visit today
--
--     JUST_LEFT IS ALSO GATED ON DISTANCE, not on elapsed time alone. The map
--     draws a 15-minute drive-time ring around the focus site, so a red "just
--     left" dot outside that ring reads as a contradiction. It was one: the window
--     was a 20-minute look-back while the ring came from PARAMS.APPROACH_SECONDS
--     (900s), and elapsed minutes are not drive-time minutes anyway - observed on
--     UsNewJersey 2026-08-07 09:00, V-DRI-00052 departed NFI at 08:42:53 (17.1 min
--     earlier) but sat 20.9 ORS-minutes away, because the telemetry drives faster
--     than ORS free-flow. Aligning the two windows narrows that but cannot close
--     it, so the colour now requires the vehicle to still be within the band the
--     ring depicts. Past that it is simply a vehicle heading elsewhere and falls
--     through to APPROACHING / DRIVING / IDLE.
--
--     STRICT PRECEDENCE in that order. Computed as independent flags the ON_SITE
--     and JUST_LEFT sets overlap (a vehicle that left site A can already be
--     sitting at site B), which would double-plot it, so the CASE resolves to
--     exactly one status per vehicle.
--
--     ON_SITE IS A CONTAINMENT TEST, NOT AN UNLOAD WINDOW. This is the fix for a
--     real contradiction on the map: the marker is drawn at `last_pos` (the last
--     ping at or before the instant) while ON_SITE used to be bounded by
--     DT_SITE_VISITS.DEPARTURE_TS, which is MAX(TS) over the STATIONARY CORE -
--     the last ping on which the vehicle was seen not moving. That is the
--     product-ready moment, NOT evidence of leaving, so status and marker were
--     answering different questions. Worked example (UsNewJersey 2026-08-07,
--     V-DRI-00001 at Revolution Rail Co. Cape May): ARRIVAL 05:54:16.982,
--     DEPARTURE 05:57:49.128 - and that departure ping is the vehicle's LAST
--     ping of the day, speed 0, 6 m from the site inside a 200 m geofence. At
--     06:00 the dot sat on the site while the tooltip read "Just left 2.2 min
--     ago". Two buckets on that day's 134 visits: 27 where DEPARTURE_TS is the
--     vehicle's last ping (no exit evidence exists at all, so it read JUST_LEFT
--     for the whole window then IDLE while parked on the site) and 105 where
--     DEPARTURE_TS < FENCE_EXIT_TS (the drive-out tail is still inside the
--     fence). The entry side was mirror-imaged: FENCE_ENTRY_TS precedes
--     ARRIVAL_TS, so the marker was inside the fence while labelled APPROACHING.
--
--     So ON_SITE now asks the positional question about the SAME row the map
--     plots, giving the invariant: the plotted position lies inside the geofence
--     OF A SITE SERVED ON THE SHOWN SERVICE DAY iff STATUS_ENUM = 'ON_SITE'.
--
--     THE DAY SCOPE IS PART OF THE INVARIANT, NOT AN OPTIMISATION. The first
--     version of this containment test joined the whole monitored estate, which
--     on the Malaysia dataset is 2,311 POIs against the 20 sites that day serves
--     - a 115x over-reach. Every other element of the page is day-scoped (grey
--     markers and the readiness table from F_SITE_READINESS_ASOF, the geofence
--     circles from VW_SITE_VISITS, the rings from LIVE_APPROACH_RINGS, the feed
--     from VW_EVENTS, and the "vehicle on site" KPI from
--     COUNT_IF(READINESS_ENUM='IN_PROGRESS')), so an unscoped containment test
--     produces a green "On site now" dot naming a site that appears NOWHERE else
--     on the page and no drawn circle around it. Worked example
--     (MalaysiaSingaporeAndBrunei 2026-08-03 05:40, V-DRI-00008): parked 1.3 m
--     from POI c15dcd77 "J&T Cargo" (5.8333, 102.542), stationary since before
--     05:08, so a 200 m WAREHOUSE fence says inside - but that POI has ZERO
--     visits ever, the vehicle has none that day, and the KPI read 0 on site.
--     All 6 ON_SITE vehicles at that instant were this (4 sites never visited by
--     anyone, 2 served on another day), and none was at its own
--     HOME_LOCATION_ID - the nearest home was 44 km away - so the home-base
--     exclusion cannot see this case. New Jersey 2026-08-07 09:00 had 6 of 10.
--     Accepted consequence: a vehicle genuinely parked in an UNPLANNED yard now
--     reads IDLE rather than ON_SITE. That is the honest answer for this page,
--     because nothing on it knows about that yard; surfacing unplanned stops is
--     a separate feature (its own state plus its own layer), not this status.
--
--     ARRIVAL_TS / DEPARTURE_TS keep their unload semantics and are untouched
--     - readiness
--     (F_SITE_READINESS_ASOF), DWELL_MINUTES, PRODUCT_READY_TS and the
--     notification feed were always correct; only the live map status was
--     overloading them. ON_SITE_PHASE carries the distinction the UI needs:
--     UNLOADING while the instant is still inside the visit window, UNLOAD_DONE
--     once past DEPARTURE_TS (or when no visit window covers the instant).
--
--     Accepted consequence: a vehicle driving OUT of the yard but still inside
--     the fence reads ON_SITE for one ping. That is honest and, crucially, it
--     matches the dot - a speed gate would reintroduce a status that disagrees
--     with the marker, which is the whole defect. Likewise a vehicle whose feed
--     ends on site stays ON_SITE until P_MAX_STALENESS_MIN drops it from the
--     layer entirely, which is the right failure mode: it disappears rather than
--     claiming a departure that was never observed.
--
--     APPROACHING is a LIVE ROAD-TIME threshold, not a radius: one MATRIX_TABULAR
--     call over the en-route subset, origins = vehicle positions ordered by
--     VEHICLE_ID, destinations = the distinct next sites ordered by SITE_ID, and
--     each vehicle reads durations[its origin index][its own next-site index].
--     The ARRAY_AGG ordering MUST match those indices or every ETA silently maps
--     to the wrong site - the same trap as LIVE_INBOUND_ETA. Sized in practice at
--     36 origins x 39 destinations = 1,404 pairs against a matrix_maximum_routes
--     cap of 2,000,000.
--
--     Same staleness guard as LIVE_INBOUND_ETA: a vehicle whose last ping is
--     older than P_MAX_STALENESS_MIN is omitted rather than drawn as live.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION FLEET_INTELLIGENCE.DELIVERY_SYNC.LIVE_FLEET_STATUS(
  P_REGION VARCHAR, P_PROFILE VARCHAR, P_AS_OF TIMESTAMP_NTZ,
  P_APPROACH_MIN NUMBER, P_JUST_LEFT_MIN NUMBER, P_MAX_STALENESS_MIN NUMBER)
RETURNS TABLE (VEHICLE_ID VARCHAR, STATUS_ENUM VARCHAR, SITE_ID VARCHAR,
               SITE_NAME VARCHAR, MINUTES_OUT NUMBER(10,1), DISTANCE_KM NUMBER(10,2),
               ETA_TS TIMESTAMP_NTZ, MINUTES_SINCE_LEFT NUMBER(12,1),
               POSITION_TS TIMESTAMP_NTZ, VEHICLE_GEOG GEOGRAPHY,
               ON_SITE_PHASE VARCHAR, MINUTES_BACK_TO_SITE NUMBER(10,1))
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-delivery-sync","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH prm AS (
    SELECT MONITORED_SITE_TYPES
    FROM FLEET_INTELLIGENCE.DELIVERY_SYNC.PARAMS LIMIT 1
  ),
  last_pos AS (
    SELECT VEHICLE_ID, TS, LATITUDE, LONGITUDE, POINT_GEOM
    FROM SYNTHETIC_DATASETS.UNIFIED.V_FACT_VEHICLE_TELEMETRY_CURRENT
    WHERE REGION = P_REGION
      AND TS <= COALESCE(P_AS_OF, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ)
      AND TS >= DATEADD('minute', -1 * COALESCE(P_MAX_STALENESS_MIN, 20),
                        COALESCE(P_AS_OF, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ))
    QUALIFY ROW_NUMBER() OVER (PARTITION BY VEHICLE_ID ORDER BY TS DESC) = 1
  ),
  -- The monitored-site set with the geofence radius resolved per (vehicle type,
  -- site type). Deliberately mirrors the `sites` CTE of DT_SITE_VISITS verbatim
  -- so the radius used to CLASSIFY a live position cannot drift from the radius
  -- used to DETECT the visit. This is the whole estate (2,311 POIs on the
  -- Malaysia dataset) and is used ONLY for the radius - the site set that may
  -- be reported is `day_sites` below.
  sites AS (
    SELECT p.LOCATION_ID, p.REGION, p.POINT_GEOM,
           sla.VEHICLE_TYPE, sla.BUFFER_RADIUS_M
    FROM SYNTHETIC_DATASETS.UNIFIED.V_DIM_POIS_CURRENT p
    JOIN FLEET_INTELLIGENCE.CORE.DIM_VEHICLE_DWELL_SLA sla
      ON sla.LOCATION_TYPE = p.LOCATION_TYPE
    CROSS JOIN prm
    WHERE p.REGION = P_REGION
      AND ARRAY_CONTAINS(p.LOCATION_TYPE::VARIANT,
                         STRTOK_TO_ARRAY(prm.MONITORED_SITE_TYPES, ','))
  ),
  -- The sites the SHOWN SERVICE DAY actually serves - the same set the grey
  -- markers, the geofence circles and the approach rings are drawn from. The
  -- containment test MUST intersect this: see the header note, an unscoped
  -- containment test names POIs that appear nowhere else on the page.
  -- SITE_LABEL (not the raw POI name) for parity with `visit_now` / `just_left`.
  day_sites AS (
    SELECT SITE_ID, ANY_VALUE(SITE_LABEL) AS SITE_NAME
    FROM FLEET_INTELLIGENCE.DELIVERY_SYNC.DT_SITE_VISITS
    WHERE REGION = P_REGION
      AND SERVICE_DATE = COALESCE(P_AS_OF, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ)::DATE
      AND SITE_GEOG IS NOT NULL
    GROUP BY SITE_ID
  ),
  -- CONTAINMENT: the plotted position is inside the geofence of a site served
  -- on the shown service day. Nearest site wins (a stop inside a cluster of
  -- nearby sites must not resolve to several), and the vehicle's own home base
  -- is excluded exactly as the detector excludes it, so overnight parking is
  -- never reported as on site.
  at_site AS (
    SELECT p.VEHICLE_ID, s.LOCATION_ID AS SITE_ID, ds.SITE_NAME
    FROM last_pos p
    JOIN SYNTHETIC_DATASETS.UNIFIED.V_DIM_FLEET_CURRENT f
      ON f.VEHICLE_ID = p.VEHICLE_ID AND f.REGION = P_REGION
    JOIN sites s
      ON s.VEHICLE_TYPE = f.VEHICLE_TYPE
     AND ST_DWITHIN(p.POINT_GEOM, s.POINT_GEOM, s.BUFFER_RADIUS_M)
    JOIN day_sites ds ON ds.SITE_ID = s.LOCATION_ID
    WHERE s.LOCATION_ID <> COALESCE(f.HOME_LOCATION_ID, '~none~')
    QUALIFY ROW_NUMBER() OVER (
              PARTITION BY p.VEHICLE_ID
              ORDER BY ST_DISTANCE(p.POINT_GEOM, s.POINT_GEOM)) = 1
  ),
  -- Inside a detected visit window. Kept as a SECOND source rather than being
  -- replaced: it keeps ON_SITE alive across a momentarily missing ping (a gap
  -- that puts `last_pos` outside the fence mid-visit) and it is what tells the
  -- UI the unload is still in progress.
  -- SITE_NAME is the DT's disambiguated SITE_LABEL, not the raw name: site names
  -- repeat (10 x "Extra Space Storage" on the reference day), so "just left
  -- <name>" would not identify which one. The column keeps the name SITE_NAME so
  -- the semantic view and the agent tool need no change.
  visit_now AS (
    SELECT VEHICLE_ID, ANY_VALUE(SITE_ID) AS SITE_ID, ANY_VALUE(SITE_LABEL) AS SITE_NAME
    FROM FLEET_INTELLIGENCE.DELIVERY_SYNC.DT_SITE_VISITS
    WHERE REGION = P_REGION
      AND COALESCE(P_AS_OF, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ) >= ARRIVAL_TS
      AND COALESCE(P_AS_OF, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ) <  DEPARTURE_TS
    GROUP BY VEHICLE_ID
  ),
  -- Union of the two, one row per vehicle. The visit window is preferred (PREF
  -- 1) because it names the site the unload belongs to and carries the
  -- UNLOADING phase; containment supplies the rest, phased UNLOAD_DONE.
  on_site_src AS (
    SELECT VEHICLE_ID, SITE_ID, SITE_NAME, 'UNLOADING'   AS ON_SITE_PHASE, 1 AS PREF
    FROM visit_now
    UNION ALL
    SELECT VEHICLE_ID, SITE_ID, SITE_NAME, 'UNLOAD_DONE' AS ON_SITE_PHASE, 2 AS PREF
    FROM at_site
  ),
  on_site AS (
    SELECT VEHICLE_ID, SITE_ID, SITE_NAME, ON_SITE_PHASE
    FROM on_site_src
    QUALIFY ROW_NUMBER() OVER (PARTITION BY VEHICLE_ID ORDER BY PREF) = 1
  ),
  -- Most recent departure inside the just-left window.
  just_left AS (
    SELECT VEHICLE_ID, SITE_ID, SITE_LABEL AS SITE_NAME, SITE_GEOG, DEPARTURE_TS
    FROM FLEET_INTELLIGENCE.DELIVERY_SYNC.DT_SITE_VISITS
    WHERE REGION = P_REGION
      AND DEPARTURE_TS <= COALESCE(P_AS_OF, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ)
      AND DEPARTURE_TS >= DATEADD('minute', -1 * COALESCE(P_JUST_LEFT_MIN, 20),
                                  COALESCE(P_AS_OF, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ))
    QUALIFY ROW_NUMBER() OVER (PARTITION BY VEHICLE_ID ORDER BY DEPARTURE_TS DESC) = 1
  ),
  -- The next visit still ahead of the instant, ON THE SAME SERVICE DAY.
  --
  -- SERVICE_DATE is load-bearing, not decoration. Without it `ARRIVAL_TS > as_of`
  -- means "the next visit EVER", so a vehicle idle today is reported en route to
  -- a site it serves days later - and because the ring layers ARE day-scoped
  -- (LIVE_APPROACH_RINGS filters SERVICE_DATE), that site has no isochrone on the
  -- day being viewed. Observed on Malaysia at 2026-08-03 09:00: a vehicle parked
  -- exactly on its 2026-08-09 site matrixed to 0 min / 0 km, cleared the 15-min
  -- gate and rendered APPROACHING with no ring anywhere near it, while 17 of 21
  -- "en route" vehicles were driving to another day's site (one 619 min / 762 km
  -- out). New Jersey masked it: a dense day gives most vehicles a real same-day
  -- stop, so only 6 of 40 were wrong.
  --
  -- P_AS_OF::DATE IS the page's resolved service day - the view builds the
  -- instant as DATEADD('minute', :as_of_minute, SD) with as_of_minute in 0..1430,
  -- so it never crosses midnight. INVARIANT: this function must answer for the
  -- one service day the rings, readiness and feed are showing, or a vehicle can
  -- be classified against a site that has no ring. `on_site` and `just_left` need
  -- no such filter - they are inherently same-day (an arrival/departure window
  -- straddling the instant, and a 20-minute look-back).
  --
  -- SITE_GEOG IS NOT NULL mirrors the rings CTE and protects the MATRIX call:
  -- `dests` feeds ST_X(G)/ST_Y(G) into the destination array, where a NULL geog
  -- would inject a NULL coordinate.
  next_site AS (
    SELECT VEHICLE_ID, SITE_ID, SITE_LABEL AS SITE_NAME, SITE_GEOG
    FROM FLEET_INTELLIGENCE.DELIVERY_SYNC.DT_SITE_VISITS
    WHERE REGION = P_REGION
      AND SERVICE_DATE = COALESCE(P_AS_OF, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ)::DATE
      AND SITE_GEOG IS NOT NULL
      AND ARRIVAL_TS > COALESCE(P_AS_OF, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ)
    QUALIFY ROW_NUMBER() OVER (PARTITION BY VEHICLE_ID ORDER BY ARRIVAL_TS) = 1
  ),
  -- Every vehicle that needs a live measurement: not on a site, and either
  -- heading somewhere (next-site ETA) or freshly departed (drive time BACK to the
  -- site it left, which is what gates the JUST_LEFT colour). Written as LEFT JOINs
  -- rather than three correlated EXISTS because correlated subqueries over CTEs in
  -- this function are a known source of "Unsupported subquery type cannot be
  -- evaluated".
  --
  -- This list is used TWICE - as matrix origins (vehicle -> next site) and as
  -- matrix destinations (left site -> vehicle) - and both uses keep the SAME
  -- ORDER BY VID, so a vehicle's destination index is simply its origin index
  -- offset by the number of next-site destinations. That is the whole reason the
  -- reverse direction costs no extra ORS call.
  veh_origins AS (
    SELECT VID, LON, LAT, ROW_NUMBER() OVER (ORDER BY VID) - 1 AS OI
    FROM (
      SELECT DISTINCT p.VEHICLE_ID AS VID, p.LONGITUDE AS LON, p.LATITUDE AS LAT
      FROM last_pos p
      LEFT JOIN on_site   o ON o.VEHICLE_ID = p.VEHICLE_ID
      LEFT JOIN next_site n ON n.VEHICLE_ID = p.VEHICLE_ID
      LEFT JOIN just_left j ON j.VEHICLE_ID = p.VEHICLE_ID
      WHERE o.VEHICLE_ID IS NULL
        AND (n.VEHICLE_ID IS NOT NULL OR j.VEHICLE_ID IS NOT NULL)
    )
  ),
  enroute AS (
    SELECT v.VID, v.OI, n.SITE_ID AS SID
    FROM veh_origins v JOIN next_site n ON n.VEHICLE_ID = v.VID
  ),
  dests AS (
    SELECT n.SITE_ID AS SID, ANY_VALUE(n.SITE_GEOG) AS G,
           ROW_NUMBER() OVER (ORDER BY n.SITE_ID) - 1 AS DI
    FROM next_site n JOIN veh_origins v ON v.VID = n.VEHICLE_ID
    GROUP BY n.SITE_ID
  ),
  -- The sites just-left vehicles came from, as ADDITIONAL matrix origins. The
  -- direction matters: LIVE_APPROACH_RING computes its isochrone OUTWARD FROM the
  -- site, so the only measurement that agrees with the ring the user is looking at
  -- is site -> vehicle. Measuring vehicle -> site would be the inbound direction
  -- and would disagree with the drawn polygon on asymmetric networks.
  left_origins AS (
    SELECT j.SITE_ID AS SID, ANY_VALUE(j.SITE_GEOG) AS G,
           ROW_NUMBER() OVER (ORDER BY j.SITE_ID) - 1 AS LOI
    FROM just_left j JOIN veh_origins v ON v.VID = j.VEHICLE_ID
    WHERE j.SITE_GEOG IS NOT NULL
    GROUP BY j.SITE_ID
  ),
  left_pairs AS (
    SELECT v.VID, v.OI, j.SITE_ID AS SID
    FROM veh_origins v
    JOIN just_left j ON j.VEHICLE_ID = v.VID
    WHERE j.SITE_GEOG IS NOT NULL
  ),
  -- DELIBERATELY DEGRADES, unlike LIVE_APPROACH_RING and LIVE_INBOUND_ETA which
  -- raise when the engine is down. Those two exist only to show ORS output, so
  -- an outage leaves them nothing to say. This function is different: vehicle
  -- positions and ON_SITE / JUST_LEFT / IDLE all come from Snowflake data and
  -- stay correct without routing. Raising here would blank the whole vehicles
  -- layer over a missing sub-status. So a dead engine costs only APPROACHING
  -- (those vehicles read DRIVING, the honest fallback), and the ring layer on
  -- the same map raises anyway - so the suspended banner still tells the user.
  -- ONE call, two directions. Origins = [vehicles ordered by VID | just-left sites
  -- ordered by SITE_ID]; destinations = [next sites ordered by SITE_ID | the SAME
  -- vehicles ordered by VID]. So durations[vehicle_i][site_j] is the outbound ETA
  -- and durations[n_veh + site_k][n_dest + vehicle_i] is the drive time back from
  -- the site vehicle i just left. Sized ~44 x 83 = 3.6k pairs on the reference day
  -- against a matrix_maximum_routes cap of 2,000,000.
  --
  -- The ARRAY_CAT halves MUST stay in the same order as the index expressions or
  -- every reading silently lands on the wrong pair - the standing trap in this
  -- function, now with two more ordered lists. COALESCE guards the empty halves
  -- (no just-left vehicles, or none with a next site).
  mtx AS (
    SELECT OPENROUTESERVICE_APP.CORE.MATRIX_TABULAR(
             P_PROFILE,
             ARRAY_CAT(
               COALESCE((SELECT ARRAY_AGG(ARRAY_CONSTRUCT(LON, LAT)) WITHIN GROUP (ORDER BY OI) FROM veh_origins), ARRAY_CONSTRUCT()),
               COALESCE((SELECT ARRAY_AGG(ARRAY_CONSTRUCT(ST_X(G), ST_Y(G))) WITHIN GROUP (ORDER BY LOI) FROM left_origins), ARRAY_CONSTRUCT())),
             ARRAY_CAT(
               COALESCE((SELECT ARRAY_AGG(ARRAY_CONSTRUCT(ST_X(G), ST_Y(G))) WITHIN GROUP (ORDER BY DI) FROM dests), ARRAY_CONSTRUCT()),
               COALESCE((SELECT ARRAY_AGG(ARRAY_CONSTRUCT(LON, LAT)) WITHIN GROUP (ORDER BY OI) FROM veh_origins), ARRAY_CONSTRUCT())),
             P_REGION) AS R
  ),
  offsets AS (
    SELECT (SELECT COUNT(*) FROM veh_origins) AS N_VEH,
           (SELECT COUNT(*) FROM dests)       AS N_DEST
  ),
  eta AS (
    SELECT e.VID,
           ROUND(m.R:durations[e.OI][d.DI]::FLOAT / 60.0, 1)   AS MINS,
           ROUND(m.R:distances[e.OI][d.DI]::FLOAT / 1000.0, 2) AS KM
    FROM enroute e JOIN dests d ON d.SID = e.SID CROSS JOIN mtx m
  ),
  -- Drive time back from the site the vehicle just left. NULL when the engine is
  -- down or the pair is unroutable, which deliberately falls back to the old
  -- time-only JUST_LEFT decision rather than recolouring or dropping the vehicle.
  back AS (
    SELECT lp.VID,
           ROUND(m.R:durations[o.N_VEH + lo.LOI][o.N_DEST + lp.OI]::FLOAT / 60.0, 1) AS MINS
    FROM left_pairs lp
    JOIN left_origins lo ON lo.SID = lp.SID
    CROSS JOIN mtx m CROSS JOIN offsets o
  ),
  -- One row per vehicle with the status decision made ONCE. Repeating the
  -- just-left predicate in the projection would let the status and the
  -- MINUTES_SINCE_LEFT / MINUTES_OUT gating drift apart, which is exactly the
  -- defect class this function keeps producing.
  resolved AS (
    SELECT
      p.VEHICLE_ID, p.TS, p.POINT_GEOM,
      o.SITE_ID AS O_SITE, o.SITE_NAME AS O_NAME, o.ON_SITE_PHASE,
      j.SITE_ID AS J_SITE, j.SITE_NAME AS J_NAME, j.DEPARTURE_TS,
      n.SITE_ID AS N_SITE, n.SITE_NAME AS N_NAME,
      e2.MINS AS OUT_MINS, e2.KM AS OUT_KM, b.MINS AS BACK_MINS,
      (o.VEHICLE_ID IS NOT NULL) AS IS_ON_SITE,
      (n.VEHICLE_ID IS NOT NULL) AS HAS_NEXT,
      (o.VEHICLE_ID IS NULL
       AND j.VEHICLE_ID IS NOT NULL
       AND (b.MINS IS NULL OR b.MINS <= COALESCE(P_APPROACH_MIN, 15))) AS IS_JUST_LEFT
    FROM last_pos p
    LEFT JOIN on_site   o  ON o.VEHICLE_ID  = p.VEHICLE_ID
    LEFT JOIN just_left j  ON j.VEHICLE_ID  = p.VEHICLE_ID
    LEFT JOIN next_site n  ON n.VEHICLE_ID  = p.VEHICLE_ID
    LEFT JOIN eta       e2 ON e2.VID        = p.VEHICLE_ID
    LEFT JOIN back      b  ON b.VID         = p.VEHICLE_ID
  )
  SELECT
    r.VEHICLE_ID,
    CASE
      WHEN r.IS_ON_SITE     THEN 'ON_SITE'
      WHEN r.IS_JUST_LEFT   THEN 'JUST_LEFT'
      WHEN NOT r.HAS_NEXT   THEN 'IDLE'
      WHEN r.OUT_MINS IS NOT NULL
       AND r.OUT_MINS <= COALESCE(P_APPROACH_MIN, 15) THEN 'APPROACHING'
      ELSE 'DRIVING'
    END AS STATUS_ENUM,
    -- Name the site the status is ABOUT: where it is, where it just left (only
    -- while that is still the status), else where it is heading. A vehicle that
    -- departed but is already beyond the band is named by its NEXT site, because
    -- that is what its status is now about.
    COALESCE(r.O_SITE, IFF(r.IS_JUST_LEFT, r.J_SITE, NULL), r.N_SITE) AS SITE_ID,
    COALESCE(r.O_NAME, IFF(r.IS_JUST_LEFT, r.J_NAME, NULL), r.N_NAME) AS SITE_NAME,
    IFF(NOT r.IS_ON_SITE AND NOT r.IS_JUST_LEFT, r.OUT_MINS, NULL)::NUMBER(10,1) AS MINUTES_OUT,
    IFF(NOT r.IS_ON_SITE AND NOT r.IS_JUST_LEFT, r.OUT_KM, NULL)::NUMBER(10,2)   AS DISTANCE_KM,
    IFF(NOT r.IS_ON_SITE AND NOT r.IS_JUST_LEFT AND r.OUT_MINS IS NOT NULL,
        DATEADD('second', (r.OUT_MINS * 60)::INT,
                COALESCE(P_AS_OF, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ)), NULL) AS ETA_TS,
    -- Gated on the RESOLVED status, not on the presence of a departure row: a
    -- vehicle standing inside a geofence usually ALSO has a closed visit inside
    -- the just-left window (the case the containment test rescues), and a vehicle
    -- that departed but is already beyond the band is no longer 'just left'.
    -- Reporting "left N minutes ago" on either would put the contradiction
    -- straight back into the tooltip and the agent's grounding.
    IFF(r.IS_JUST_LEFT,
        ROUND(DATEDIFF('second', r.DEPARTURE_TS,
                       COALESCE(P_AS_OF, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ)) / 60.0, 1),
        NULL)::NUMBER(12,1) AS MINUTES_SINCE_LEFT,
    r.TS,
    r.POINT_GEOM,
    r.ON_SITE_PHASE,
    IFF(r.IS_JUST_LEFT, r.BACK_MINS, NULL)::NUMBER(10,1) AS MINUTES_BACK_TO_SITE
  FROM resolved r
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
CREATE OR REPLACE FUNCTION FLEET_APP.DELIVERY_SYNC.F_SITE_READINESS_ASOF(
  P_REGION VARCHAR, P_AS_OF TIMESTAMP_NTZ)
RETURNS TABLE (REGION VARCHAR, SERVICE_DATE DATE, SITE_ID VARCHAR, SITE_NAME VARCHAR,
               SITE_TYPE VARCHAR, SITE_GEOG GEOGRAPHY, VEHICLE_ID VARCHAR,
               JOURNEY_ID VARCHAR, VISIT_ID VARCHAR, ARRIVAL_TS TIMESTAMP_NTZ,
               DEPARTURE_TS TIMESTAMP_NTZ, DWELL_MINUTES NUMBER(10,1),
               PRODUCT_READY_TS TIMESTAMP_NTZ, SOURCE_STATUS_HINT VARCHAR,
               READINESS_ENUM VARCHAR, MINUTES_SINCE_READY NUMBER(12,1))
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-delivery-sync","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  SELECT * FROM TABLE(FLEET_INTELLIGENCE.DELIVERY_SYNC.F_SITE_READINESS_ASOF(
    P_REGION, P_AS_OF))
$$;

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

CREATE OR REPLACE FUNCTION FLEET_APP.DELIVERY_SYNC.LIVE_APPROACH_RINGS(
  P_REGION VARCHAR, P_PROFILE VARCHAR, P_SECONDS NUMBER,
  P_SERVICE_DATE DATE, P_EXCLUDE_SITE_ID VARCHAR)
RETURNS TABLE (SITE_ID VARCHAR, SITE_NAME VARCHAR, RING_GEOG GEOGRAPHY, RANGE_SECONDS NUMBER)
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-delivery-sync","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  SELECT * FROM TABLE(FLEET_INTELLIGENCE.DELIVERY_SYNC.LIVE_APPROACH_RINGS(
    P_REGION, P_PROFILE, P_SECONDS, P_SERVICE_DATE, P_EXCLUDE_SITE_ID))
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

CREATE OR REPLACE FUNCTION FLEET_APP.DELIVERY_SYNC.LIVE_FLEET_STATUS(
  P_REGION VARCHAR, P_PROFILE VARCHAR, P_AS_OF TIMESTAMP_NTZ,
  P_APPROACH_MIN NUMBER, P_JUST_LEFT_MIN NUMBER, P_MAX_STALENESS_MIN NUMBER)
RETURNS TABLE (VEHICLE_ID VARCHAR, STATUS_ENUM VARCHAR, SITE_ID VARCHAR,
               SITE_NAME VARCHAR, MINUTES_OUT NUMBER(10,1), DISTANCE_KM NUMBER(10,2),
               ETA_TS TIMESTAMP_NTZ, MINUTES_SINCE_LEFT NUMBER(12,1),
               POSITION_TS TIMESTAMP_NTZ, VEHICLE_GEOG GEOGRAPHY,
               ON_SITE_PHASE VARCHAR, MINUTES_BACK_TO_SITE NUMBER(10,1))
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-delivery-sync","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  SELECT * FROM TABLE(FLEET_INTELLIGENCE.DELIVERY_SYNC.LIVE_FLEET_STATUS(
    P_REGION, P_PROFILE, P_AS_OF, P_APPROACH_MIN, P_JUST_LEFT_MIN, P_MAX_STALENESS_MIN))
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
