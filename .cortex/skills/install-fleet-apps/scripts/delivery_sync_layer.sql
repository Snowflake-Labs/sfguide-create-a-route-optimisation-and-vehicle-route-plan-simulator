-- =====================================================================
-- DELIVERY SYNC layer - site arrival / departure / approach notifications
-- =====================================================================
-- Answers the question "when did the vehicle reach the delivery site, and
-- when did it leave?" so a downstream crew (receiving team, merchandiser,
-- yard marshal) is told to move only once the product is actually there.
--
-- Four events per (vehicle, site) visit:
--   APPROACHING     - vehicle crossed INTO the site's live drive-time ring
--   ARRIVED         - vehicle became stationary inside the site geofence
--   UNLOAD_COMPLETE - vehicle stopped being stationary inside the geofence
--                     (this is the one that matters: work starts after unload).
--                     It does NOT mean the vehicle left - it is usually still
--                     parked inside the fence at this instant.
--   DEPARTED        - vehicle was first OBSERVED OUTSIDE the geofence. Emitted
--                     ONLY when that was observed; a visit whose telemetry ends
--                     on site produces no DEPARTED event at all, because no
--                     departure happened as far as this data knows.
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
    -- H3 join key for the containment prefilter (see site_cells below).
    H3_POINT_TO_CELL_STRING(t.POINT_GEOM, 8) AS H3_CELL,
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
-- Each monitored site expanded to its H3 res-8 cell plus the 6 neighbours.
-- This exists PURELY as an equality join key so the containment step below is a
-- hash join instead of a spatial comparison of every ping against every site.
-- It is a prefilter, never the answer: ST_DWITHIN remains the authoritative
-- test, so results are bit-identical with or without this CTE.
--
-- WHY IT IS REQUIRED, NOT AN OPTIMISATION. The monitored estate used to be
-- WAREHOUSE-only, i.e. ~2.3k sites against ~0.8M HGV pings, and the refresh took
-- ~6 minutes. Once RESTAURANT and LOCATION were monitored (without which the
-- ebike and car datasets produce no visits at all), SanFrancisco alone became
-- 1.58M pings x 4,996 sites and a manually triggered FULL refresh ran for over
-- 75 minutes on the XSMALL warehouse without completing - well past the 1 hour
-- TARGET_LAG, so the table could never have kept its lag.
--
-- k = 1 at res 8 is safe for every radius in DIM_VEHICLE_DWELL_SLA (max 200 m,
-- WAREHOUSE): a res-8 cell has an ~461 m edge, so the 7-cell disk clears any
-- point in the centre cell by roughly 400 m in every direction. A future radius
-- above ~400 m would need a coarser resolution or a larger k, otherwise the
-- prefilter would start dropping genuine containments.
site_cells AS (
  SELECT s.*, c.VALUE::VARCHAR AS H3_CELL
  FROM sites s,
       LATERAL FLATTEN(input => H3_GRID_DISK(H3_POINT_TO_CELL_STRING(s.POINT_GEOM, 8), 1)) c
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
  JOIN site_cells s
    ON s.REGION = p.REGION
   AND s.H3_CELL = p.H3_CELL
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
    -- The vehicle's NEXT ping after this episode. SEQ is a per-vehicle monotonic
    -- row number over EVERY ping (see `pts`), and this episode owns a contiguous
    -- SEQ run, so MAX(SEQ)+1 is by construction the first ping that is not part
    -- of it. Resolved to a timestamp in the final SELECT - see EXIT_TS.
    MAX(e.SEQ) + 1              AS EXIT_SEQ,
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
  -- EXIT_TS - the moment the vehicle was first OBSERVED OUTSIDE this geofence,
  -- NULL when that was never observed. This is the only column in the table that
  -- evidences a departure.
  --
  -- WHY IT EXISTS. DEPARTURE_TS is MAX(TS) over the STATIONARY CORE, i.e. the
  -- last ping on which the vehicle was seen not moving - the product-ready
  -- moment. It is NOT evidence of leaving, and the notification feed used to
  -- label it 'DEPARTED'. On UsNewJersey 2026-08-07, across all 134 visits, ZERO
  -- had the vehicle outside the fence at its own DEPARTURE_TS: 107 had the next
  -- ping still inside (real exit a median 85 s later, up to 201 s) and 27 had no
  -- further ping at all. Worked example V-DRI-00023 at Phase III Trucking Inc:
  -- DEPARTURE 05:18:46.008 is the vehicle's LAST ping ever, speed 0, 38.8 m
  -- inside a 200 m fence - so at the 05:20 replay instant the feed announced a
  -- departure while the map correctly showed the dot on the site. Same defect
  -- class as the three fixed before it (two different facts under one label);
  -- the earlier fixes moved the MAP onto the fact it plots, this one moves the
  -- FEED onto the fact it claims.
  --
  -- Deliberately an EQUALITY join on EXIT_SEQ, not a range scan for "first ping
  -- outside the fence after FENCE_EXIT_TS": the ping at MAX(SEQ)+1 is already
  -- the first ping not in this episode, so a range join would cost a full
  -- per-visit telemetry scan for an identical answer. The NOT ST_DWITHIN guard
  -- covers the case where that next ping is STILL inside the fence (7 of the 134
  -- - a sequence gap re-opened the same site as a new episode). Those claim no
  -- exit; the later episode supplies its own.
  IFF(x.TS IS NOT NULL
      AND NOT ST_DWITHIN(x.POINT_GEOM, a.SITE_GEOG, a.GEOFENCE_RADIUS_M),
      x.TS, NULL) AS EXIT_TS,
  a.MAX_SPEED_IN_FENCE, a.CHORD_M, a.SOURCE_STATUS_HINT,
  TO_DATE(a.ARRIVAL_TS) AS SERVICE_DATE
FROM agg a CROSS JOIN prm
LEFT JOIN pts x
  ON x.REGION = a.REGION AND x.VEHICLE_ID = a.VEHICLE_ID AND x.SEQ = a.EXIT_SEQ
LEFT JOIN dupnames d
  ON d.REGION = a.REGION AND d.NM = TRIM(a.SITE_NAME, '"')
-- Per-vehicle minimum stop. PARAMS.MIN_STOP_SECONDS remains the account-wide
-- fallback for a vehicle type absent from the catalog; the catalog value wins
-- when present. A single global 180s (tuned for HGV pass-by rejection) discarded
-- 48% of the seeded ebike dataset's candidate visits, whose configured
-- destination dwell median is 120s - see DIM_VEHICLE_PROFILE.MIN_STOP_SECONDS.
LEFT JOIN FLEET_INTELLIGENCE.CORE.DIM_VEHICLE_PROFILE vp
  ON vp.VEHICLE_TYPE = a.VEHICLE_TYPE
WHERE a.ARRIVAL_TS IS NOT NULL
  AND a.DEPARTURE_TS IS NOT NULL
  AND a.STATIONARY_PINGS >= prm.MIN_STATIONARY_PINGS
  AND DATEDIFF('second', a.ARRIVAL_TS, a.DEPARTURE_TS)
        >= COALESCE(vp.MIN_STOP_SECONDS, prm.MIN_STOP_SECONDS)
  AND DATEDIFF('second', a.FENCE_ENTRY_TS, a.FENCE_EXIT_TS) <= prm.MAX_STOP_SECONDS;

-- ---------------------------------------------------------------------
-- 3. VW_SITE_VISIT_EVENTS - long form, one row per notifiable event.
--
--    THREE event types, each tied to the fact that actually supports it. They
--    map one-to-one onto the live map states, which is the point: the feed and
--    the map can no longer disagree about the same vehicle.
--
--      ARRIVED         @ ARRIVAL_TS    -> map ON_SITE / phase UNLOADING
--      UNLOAD_COMPLETE @ DEPARTURE_TS  -> map ON_SITE / phase UNLOAD_DONE
--      DEPARTED        @ EXIT_TS       -> map JUST_LEFT, then DRIVING
--
--    UNLOAD_COMPLETE was previously called DEPARTED, which was an overclaim:
--    DEPARTURE_TS is the last STATIONARY ping, so the vehicle is still inside
--    the fence at that moment (all 134 visits on the UsNewJersey reference day -
--    see the EXIT_TS note on DT_SITE_VISITS). The feed announced a departure
--    while the map correctly drew the dot on the site.
--
--    DEPARTED is now gated on EXIT_TS IS NOT NULL, so a visit whose telemetry
--    ends on site yields NO departure row (34 of the 134). That is the same
--    honest failure mode LIVE_FLEET_STATUS already takes: say nothing rather
--    than claim a departure that was never observed.
--
--    PRODUCT_READY_TS = DEPARTURE_TS on both post-unload events: the moment
--    follow-on work can start is unload completion, not the vehicle leaving.
--
--    DWELL_MINUTES IS NULL ON ARRIVED. It is the visit's FINAL on-site duration,
--    so printing it on the arrival row leaks hindsight into a replay: at 05:20
--    the "ARRIVED 05:19:00 V-DRI-00062" row claimed 6.9 on-site minutes for a
--    visit one minute old. PRODUCT_READY_TS was already NULL on this arm for
--    exactly this reason; DWELL_MINUTES had been missed.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.DELIVERY_SYNC.VW_SITE_VISIT_EVENTS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-delivery-sync","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT VISIT_ID, REGION, VEHICLE_ID, JOURNEY_ID, SITE_ID, SITE_NAME, SITE_LABEL, SITE_TYPE,
       SITE_GEOG, VISIT_SEQ, SERVICE_DATE, SOURCE_STATUS_HINT,
       'ARRIVED' AS EVENT_TYPE, ARRIVAL_TS AS EVENT_TS,
       NULL::NUMBER(10,1) AS DWELL_MINUTES, NULL::TIMESTAMP_NTZ AS PRODUCT_READY_TS
FROM FLEET_INTELLIGENCE.DELIVERY_SYNC.DT_SITE_VISITS
UNION ALL
SELECT VISIT_ID, REGION, VEHICLE_ID, JOURNEY_ID, SITE_ID, SITE_NAME, SITE_LABEL, SITE_TYPE,
       SITE_GEOG, VISIT_SEQ, SERVICE_DATE, SOURCE_STATUS_HINT,
       'UNLOAD_COMPLETE' AS EVENT_TYPE, DEPARTURE_TS AS EVENT_TS,
       DWELL_MINUTES, DEPARTURE_TS AS PRODUCT_READY_TS
FROM FLEET_INTELLIGENCE.DELIVERY_SYNC.DT_SITE_VISITS
UNION ALL
SELECT VISIT_ID, REGION, VEHICLE_ID, JOURNEY_ID, SITE_ID, SITE_NAME, SITE_LABEL, SITE_TYPE,
       SITE_GEOG, VISIT_SEQ, SERVICE_DATE, SOURCE_STATUS_HINT,
       'DEPARTED' AS EVENT_TYPE, EXIT_TS AS EVENT_TS,
       DWELL_MINUTES, DEPARTURE_TS AS PRODUCT_READY_TS
FROM FLEET_INTELLIGENCE.DELIVERY_SYNC.DT_SITE_VISITS
WHERE EXIT_TS IS NOT NULL;

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
-- 4a. F_IS_DAY_RELEVANT - the SINGLE definition of "this visit belongs to the
--     day being shown, as of this instant".
--
--     SERVICE_DATE is bucketed from ARRIVAL_TS, but a shift here runs about
--     14:00-05:00 UTC, so a visit that arrives before midnight and departs after
--     it carries the PREVIOUS date while still being the vehicle's current
--     activity. LIVE_FLEET_STATUS selects those by wall-clock window, so with a
--     strict `SERVICE_DATE = as_of::DATE` everywhere else the status correctly
--     reported a vehicle ON_SITE / JUST_LEFT at a site that had no marker, no
--     geofence and no ring, because every day-scoped layer had filtered it out.
--     Measured on the SanFrancisco seed: 4 of 56 vehicles at 00:20, and 0 at
--     03:00, 16:00 and 20:10 - the midnight boundary only.
--
--     A SCALAR function, deliberately. The rule was previously spelled out
--     independently in five places (this function's callers, both geofence layers,
--     LIVE_FLEET_STATUS and the invariant) and two of them disagreeing is what
--     produced the defect - so a sixth copy would have been the wrong fix. It
--     cannot be a table function shared via the FROM clause: a SQL UDTF may not
--     call another UDTF in its body, and Snowflake reports that attempt as
--     "Insufficient privileges to operate on Table function", which reads like a
--     grant problem rather than an unsupported nesting.
--
--     The grace window is a PARAMETER, defaulting to PARAMS when NULL. It must be
--     the SAME just-left window the caller used to classify the status: deriving it
--     independently is what left one case behind on the first attempt - the status
--     was called with a 20-minute just-left window while this rule derived 15 from
--     PARAMS, so a vehicle 15.9 minutes gone read JUST_LEFT but fell outside the
--     day set. A literal drifting from a PARAMS value is also how the earlier
--     JUST_LEFT/ring inconsistency arose, hence config as the default rather than a
--     hardcoded constant.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION FLEET_INTELLIGENCE.DELIVERY_SYNC.F_IS_DAY_RELEVANT(
  P_AS_OF TIMESTAMP_NTZ, P_SERVICE_DATE DATE, P_ARRIVAL_TS TIMESTAMP_NTZ,
  P_EXIT_TS TIMESTAMP_NTZ, P_DEPARTURE_TS TIMESTAMP_NTZ, P_GRACE_MIN NUMBER)
RETURNS BOOLEAN
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-delivery-sync","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  P_SERVICE_DATE = COALESCE(P_AS_OF, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ)::DATE
  OR (
    P_ARRIVAL_TS <= COALESCE(P_AS_OF, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ)
    AND COALESCE(P_EXIT_TS, P_DEPARTURE_TS,
                 COALESCE(P_AS_OF, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ))
        >= DATEADD('minute',
                   -1 * COALESCE(P_GRACE_MIN,
                                 (SELECT ROUND(APPROACH_SECONDS / 60.0)
                                  FROM FLEET_INTELLIGENCE.DELIVERY_SYNC.PARAMS
                                  LIMIT 1), 15),
                   COALESCE(P_AS_OF, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ))
  )
$$;

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
               READINESS_ENUM VARCHAR, MINUTES_SINCE_READY NUMBER(12,1),
               GEOFENCE_RADIUS_M NUMBER, IS_DAY_RELEVANT BOOLEAN)
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
        NULL)::NUMBER(12,1) AS MINUTES_SINCE_READY,
    v.GEOFENCE_RADIUS_M,
    -- The one definition, applied here rather than restated: see F_IS_DAY_RELEVANT.
    -- NULL grace: this function has no just-left parameter, so it takes the PARAMS
    -- default. Callers that DO have one must pass it.
    FLEET_INTELLIGENCE.DELIVERY_SYNC.F_IS_DAY_RELEVANT(
      COALESCE(P_AS_OF, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ),
      v.SERVICE_DATE, v.ARRIVAL_TS, v.EXIT_TS, v.DEPARTURE_TS, NULL) AS IS_DAY_RELEVANT
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
-- [live-routing UDTFs moved -> analytic_layer_live_routing.sql]

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
-- [live-routing UDTFs moved -> analytic_layer_live_routing.sql]

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
-- [live-routing UDTFs moved -> analytic_layer_live_routing.sql]

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
-- [live-routing UDTFs moved -> analytic_layer_live_routing.sql]

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

-- Both of these are SELECT *, which in Snowflake is resolved and FROZEN at
-- creation time. A new column on DT_SITE_VISITS (e.g. EXIT_TS) therefore does
-- NOT appear here until the view is recreated - and VW_EVENTS then references a
-- column its own source view cannot see. When hot-patching a live install, run
-- the DT, then VW_SITE_VISIT_EVENTS, then these two, in that order.
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
-- Scalar passthrough for the shared day-relevance rule, so a view query can apply
-- exactly the same predicate the functions do instead of restating it.
CREATE OR REPLACE FUNCTION FLEET_APP.DELIVERY_SYNC.F_IS_DAY_RELEVANT(
  P_AS_OF TIMESTAMP_NTZ, P_SERVICE_DATE DATE, P_ARRIVAL_TS TIMESTAMP_NTZ,
  P_EXIT_TS TIMESTAMP_NTZ, P_DEPARTURE_TS TIMESTAMP_NTZ, P_GRACE_MIN NUMBER)
RETURNS BOOLEAN
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-delivery-sync","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  FLEET_INTELLIGENCE.DELIVERY_SYNC.F_IS_DAY_RELEVANT(
    P_AS_OF, P_SERVICE_DATE, P_ARRIVAL_TS, P_EXIT_TS, P_DEPARTURE_TS, P_GRACE_MIN)
$$;

CREATE OR REPLACE FUNCTION FLEET_APP.DELIVERY_SYNC.F_SITE_READINESS_ASOF(
  P_REGION VARCHAR, P_AS_OF TIMESTAMP_NTZ)
RETURNS TABLE (REGION VARCHAR, SERVICE_DATE DATE, SITE_ID VARCHAR, SITE_NAME VARCHAR,
               SITE_TYPE VARCHAR, SITE_GEOG GEOGRAPHY, VEHICLE_ID VARCHAR,
               JOURNEY_ID VARCHAR, VISIT_ID VARCHAR, ARRIVAL_TS TIMESTAMP_NTZ,
               DEPARTURE_TS TIMESTAMP_NTZ, DWELL_MINUTES NUMBER(10,1),
               PRODUCT_READY_TS TIMESTAMP_NTZ, SOURCE_STATUS_HINT VARCHAR,
               READINESS_ENUM VARCHAR, MINUTES_SINCE_READY NUMBER(12,1),
               GEOFENCE_RADIUS_M NUMBER, IS_DAY_RELEVANT BOOLEAN)
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-delivery-sync","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  SELECT * FROM TABLE(FLEET_INTELLIGENCE.DELIVERY_SYNC.F_SITE_READINESS_ASOF(
    P_REGION, P_AS_OF))
$$;

-- [live-routing UDTFs moved -> analytic_layer_live_routing.sql]

-- [live-routing UDTFs moved -> analytic_layer_live_routing.sql]

-- [live-routing UDTFs moved -> analytic_layer_live_routing.sql]

-- [live-routing UDTFs moved -> analytic_layer_live_routing.sql]

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
