-- =============================================================================
-- analytic_layer_live_routing.sql - the LIVE-ROUTING half of the analytic layer
-- =============================================================================
-- WHY THIS FILE IS SEPARATE
--
-- Every statement here creates a `LANGUAGE SQL` UDTF whose body calls an
-- OPENROUTESERVICE_APP.CORE routing function (ISOCHRONES / MATRIX_TABULAR /
-- DIRECTIONS). Snowflake resolves a SQL UDTF body at CREATE time, so on a
-- deployment without the routing engine these statements are a hard error, not a
-- runtime one.
--
-- They used to live in analytic_layer.sql. Because `snow sql -f` is
-- stop-on-first-error, the first of them (LIVE_ZIP_BANDS) aborted that file at
-- line 1072 of 2722 and silently discarded ~129 later statements - including the
-- six FLEET_INTELLIGENCE.SOURCING tables, the ten FLEET_APP.SOURCING views and
-- the closing validation SELECT, none of which need the engine at all. The
-- installer reported only "dependent views will be empty", which understated a
-- deployment missing whole schemas.
--
-- They CANNOT be wrapped in the EXECUTE IMMEDIATE / BEGIN / EXCEPTION idiom used
-- elsewhere in analytic_layer.sql: these statements carry dollar-quoted function
-- bodies, and Snowflake dollar-quotes do not nest, so the wrapper would terminate
-- on the body's own opening delimiter. Splitting the file is therefore the only
-- correct fix, which is why this file exists.
--
-- ORDER: run analytic_layer.sql FIRST. This file depends on objects it creates -
-- the FLEET_APP.LOCATION / CATCHMENT / SOURCING schemas, their base views, and
-- the FLEET_APP.CORE.ORS_OK / ORS_FEATURES / ORS_MATRIX suspended-engine guards.
--
-- Guarded by scripts/check_engine_guards.py: any new engine-dependent CREATE
-- added to analytic_layer.sql instead of here will fail the pre-commit gate.
-- =============================================================================
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","module":"analytic-layer-live-routing"}}';

-- Live ZIP drive-time drill: assigns each region ZIP to the smallest drive-time band
-- whose isochrone (computed LIVE, all bands in one ORS call) contains its centroid,
-- carrying real SafeGraph population/housing. Powers the ZIP-by-drive-time table and
-- the per-band ZIP choropleth. Owner's-rights; app roles get USAGE below.
CREATE OR REPLACE FUNCTION FLEET_APP.LOCATION.LIVE_ZIP_BANDS(P_STORE_ID VARCHAR, P_REGION VARCHAR)
RETURNS TABLE (ZIP VARCHAR, BAND_MIN INT, POPULATION INT, HOUSEHOLDS INT, MEDIAN_INCOME NUMBER(12,0), GEO GEOGRAPHY)
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-location-diagnostics","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH iso AS (
    SELECT (f.value:properties:value::INT)/60 AS band_min,
           TO_GEOGRAPHY(f.value:geometry) AS g
    FROM TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES(
      -- Region-resolved, never hardcoded: see FLEET_APP.CORE.VW_REGION_PROFILE.
      COALESCE((SELECT ORS_PROFILE FROM FLEET_APP.CORE.VW_REGION_PROFILE
                 WHERE REGION = P_REGION LIMIT 1), 'driving-car'),
      ARRAY_CONSTRUCT(ARRAY_CONSTRUCT(
        (SELECT LON FROM FLEET_INTELLIGENCE.LOCATION.STORES WHERE REGION=P_REGION AND STORE_ID=P_STORE_ID),
        (SELECT LAT FROM FLEET_INTELLIGENCE.LOCATION.STORES WHERE REGION=P_REGION AND STORE_ID=P_STORE_ID))),
      (SELECT ARRAY_AGG(BAND_MIN*60) FROM FLEET_INTELLIGENCE.LOCATION.BANDS),
      'time', P_REGION)) resp,
      -- ORS_FEATURES = the suspended-engine guard: raises instead of yielding
      -- zero rows when the region's ORS service is down (see FLEET_APP.CORE).
      LATERAL FLATTEN(input => FLEET_APP.CORE.ORS_FEATURES(resp.RESPONSE)) f
  ),
  z AS (
    SELECT ZIP, POPULATION, HOUSEHOLDS, MEDIAN_INCOME, CENTROID, GEOG
    FROM FLEET_INTELLIGENCE.LOCATION.ZIP_AREAS WHERE REGION = P_REGION
  )
  SELECT z.ZIP, MIN(iso.band_min) AS band_min, ANY_VALUE(z.POPULATION), ANY_VALUE(z.HOUSEHOLDS),
         ANY_VALUE(z.MEDIAN_INCOME), ANY_VALUE(z.GEOG)
  FROM z JOIN iso ON ST_WITHIN(z.CENTROID, iso.g)
  GROUP BY z.ZIP
$$;

-- Live owned-store catchments: one ORS call returns every OWNED store's isochrone at
-- the given band (group_index maps back to the STORE_ID-ordered store list). Powers the
-- Site Impact overlap layer ("several isochrones intersection").
CREATE OR REPLACE FUNCTION FLEET_APP.LOCATION.LIVE_OWNED_CATCHMENTS(P_BAND INT, P_REGION VARCHAR)
RETURNS TABLE (STORE_ID VARCHAR, POI_NAME VARCHAR, BAND_MIN INT, GEO GEOGRAPHY)
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-location-diagnostics","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH owned AS (
    SELECT STORE_ID, POI_NAME, ROW_NUMBER() OVER (ORDER BY STORE_ID) - 1 AS grp
    FROM FLEET_INTELLIGENCE.LOCATION.STORES
    WHERE REGION = P_REGION AND STORE_ROLE = 'OWNED'
  ),
  iso AS (
    SELECT f.value:properties:group_index::INT AS grp,
           TO_GEOGRAPHY(f.value:geometry) AS g
    FROM TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES(
      -- Region-resolved, never hardcoded: see FLEET_APP.CORE.VW_REGION_PROFILE.
      COALESCE((SELECT ORS_PROFILE FROM FLEET_APP.CORE.VW_REGION_PROFILE
                 WHERE REGION = P_REGION LIMIT 1), 'driving-car'),
      (SELECT ARRAY_AGG(ARRAY_CONSTRUCT(LON, LAT)) WITHIN GROUP (ORDER BY STORE_ID)
         FROM FLEET_INTELLIGENCE.LOCATION.STORES WHERE REGION = P_REGION AND STORE_ROLE = 'OWNED'),
      ARRAY_CONSTRUCT(P_BAND * 60),
      'time', P_REGION)) resp,
      -- ORS_FEATURES = the suspended-engine guard: raises instead of yielding
      -- zero rows when the region's ORS service is down (see FLEET_APP.CORE).
      LATERAL FLATTEN(input => FLEET_APP.CORE.ORS_FEATURES(resp.RESPONSE)) f
  )
  SELECT o.STORE_ID, o.POI_NAME, P_BAND, i.g
  FROM owned o JOIN iso i ON i.grp = o.grp
$$;

-- Candidate drive-time polygon, isolated in its own UDTF.
--
-- It exists as a separate function rather than an inline CTE because embedding the
-- ISOCHRONES table function in LIVE_HUFF_ALLOCATION's body made CREATE FUNCTION
-- fail with "Insufficient privileges to operate on Table function
-- OPENROUTESERVICE_APP.CORE.ISOCHRONES" - reproducibly, under ACCOUNTADMIN, with
-- LITERAL arguments, and with the CTE referenced only once, while the very same
-- call compiles happily inside LIVE_OVERLAPS. Nesting a UDTF is a construct this
-- layer already relies on (LIVE_CANNIBALISATION nests LIVE_HUFF_ALLOCATION), so the
-- polygon is produced here and consumed there.
CREATE OR REPLACE FUNCTION FLEET_APP.LOCATION.LIVE_CANDIDATE_ISO(
  P_CANDIDATE_ID VARCHAR, P_BAND INT, P_REGION VARCHAR)
RETURNS TABLE (POLY GEOGRAPHY)
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-location-diagnostics","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  SELECT TO_GEOGRAPHY(f.value:geometry) AS poly
  FROM TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES(
    COALESCE((SELECT ORS_PROFILE FROM FLEET_APP.CORE.VW_REGION_PROFILE
               WHERE REGION = P_REGION LIMIT 1), 'driving-car'),
    ARRAY_CONSTRUCT(ARRAY_CONSTRUCT(
      (SELECT LON FROM FLEET_INTELLIGENCE.LOCATION.STORE_FACTS
        WHERE REGION = P_REGION AND STORE_ID = P_CANDIDATE_ID),
      (SELECT LAT FROM FLEET_INTELLIGENCE.LOCATION.STORE_FACTS
        WHERE REGION = P_REGION AND STORE_ID = P_CANDIDATE_ID))),
    ARRAY_CONSTRUCT(P_BAND * 60), 'time', P_REGION)) resp,
    -- ORS_FEATURES = suspended-engine guard: raises rather than yielding 0 rows.
    LATERAL FLATTEN(input => FLEET_APP.CORE.ORS_FEATURES(resp.RESPONSE)) f
$$;

-- =============================================================================
-- LIVE_HUFF_ALLOCATION - the shared demand-allocation engine for Site Impact.
--
-- WHY THIS EXISTS. The previous model assigned each household cell to exactly ONE
-- owned store, chosen by STRAIGHT-LINE ST_DISTANCE. Two things were wrong with
-- that, and both were invisible on screen:
--   1. Membership was drive-time (the isochrone) while allocation was crow-flies,
--      so a store on the far side of a bay or a motorway won households it cannot
--      actually serve. The view contradicted its own premise.
--   2. Winner-takes-all. A household 5 minutes from store A and 6 minutes from B
--      gave 100% to A and nothing to B. Real trade areas are probabilistic and
--      overlap, which is exactly what a retail property team expects to see.
-- SQFT was already stored per store and fed nothing but rent, so store size had no
-- influence on demand at all - a 9,000 sqft store pulled like a 3,000 sqft one.
--
-- WHAT IT DOES. A Huff gravity model. For each anchor cell the pull of a store is
--     w = ATTRACTIVENESS / drive_minutes ^ BETA
-- and the store's share of that cell's households is its w over the sum of w
-- across the whole choice set. BETA is the distance-decay exponent (2.0 is the
-- conventional retail value): higher BETA means households are less willing to
-- travel, so demand concentrates on nearby stores.
--
-- It returns TWO shares per (anchor, store):
--   SHARE_BEFORE - the allocation with the candidate absent (today's world)
--   SHARE_AFTER  - the allocation with the candidate present
-- The difference IS the transfer, per store, signed. That decomposition is the
-- whole point: it cannot be expressed in a winner-takes-all model, and it is what
-- lets the caller split the candidate's captured demand into revenue taken from
-- OUR estate (cannibalisation) versus revenue taken from COMPETITORS (net new).
-- Because shares sum to 1 both before and after, the losses sum EXACTLY to the
-- candidate's gain - an invariant worth asserting rather than trusting.
--
-- CHOICE SET. Owned stores + competitors + the ONE candidate being evaluated. The
-- other candidate sites are deliberately excluded: they do not exist in either
-- world, and including them would silently dilute every share.
--
-- BAND SEMANTICS. P_BAND scopes WHICH ANCHORS are in play (those the candidate can
-- reach within the band) and does NOT truncate the choice set inside them. A
-- household 40 minutes from an owned store still has that store as an option;
-- clipping the denominator to the band would inflate the candidate's share. Decay
-- handles remoteness, which is what decay is for.
--
-- COST. Exactly ONE ORS matrix call (Architecture Tenet 9: live, never cached).
-- Two mechanisms bound that call so region size cannot break it, and both are
-- load-bearing rather than tuning:
--   * an ADMISSIBLE straight-line prefilter (a cell further than the band could
--     reach at 130 km/h cannot be in the band, because straight-line distance is a
--     lower bound on road distance), and
--   * an ADAPTIVE anchor resolution - the finest H3 level that still fits the
--     routing gateway's cap on the SIZE OF THE LOCATIONS ARRAY.
--
-- The binding limit is LOCATIONS, not O-D pairs, and getting that wrong is the
-- trap here. The ORS engine itself is configured wide open in this repo (matrix
-- maximum_routes = 2,000,000, so ~1414 x 1414), but the GATEWAY pre-rejects on
-- ORS_GUARDRAIL_MATRIX_MAX_LOCATIONS before the engine is ever called, returning
-- `request_too_large`. A pair-based budget therefore passes its own arithmetic and
-- still fails: 522 anchors x 25 stores is a mere 13,050 pairs but 547 locations.
-- The cap this stack ships is 1500 (routing-gateway-service.yaml), verified live on
-- the deployed service; the 200 in routing_service.py is only the bare-process
-- fallback for a gateway started without that env var. Budget is anchors + stores
-- <= 1400, which leaves headroom under 1500 and keeps native res 8 for a 20-minute
-- band even on a state-sized region (measured UsTexas: 901 + 23 = 924 locations).
-- ANCHOR_RES is returned so a caller can see how coarse the answer had to be; a
-- low value means the band is wide relative to how spread the households are.
-- =============================================================================
CREATE OR REPLACE FUNCTION FLEET_APP.LOCATION.LIVE_HUFF_ALLOCATION(
  P_CANDIDATE_ID VARCHAR, P_BAND INT, P_REGION VARCHAR, P_BETA FLOAT)
RETURNS TABLE (ANCHOR_H3 VARCHAR, ANCHOR_RES INT, STORE_ID VARCHAR, STORE_ROLE VARCHAR,
               DRIVE_MIN NUMBER(14,1), HH INT,
               SHARE_BEFORE NUMBER(12,8), SHARE_AFTER NUMBER(12,8))
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-location-diagnostics","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH cand AS (
    SELECT ST_MAKEPOINT(LON, LAT) AS g
    FROM FLEET_INTELLIGENCE.LOCATION.STORE_FACTS
    WHERE REGION = P_REGION AND STORE_ID = P_CANDIDATE_ID
  ),
  stores AS (
    -- The choice set is NOT distance-pruned, and that is deliberate. Dropping
    -- "far" stores to buy anchor budget looks safe because a store 400 km away
    -- carries Huff weight ~ 1/400^beta - but Huff shares are RELATIVE. Measured on
    -- UsTexas, where the estate is ~300 km apart, pruning at 3x the band reach left
    -- the candidate ALONE in the choice set: captured stayed 2,183 households while
    -- cannibalised and net_new both collapsed to 0, breaking
    -- captured = cannibalised + net_new outright. In a sparse network the distant
    -- stores are not negligible, they are the ONLY incumbents and hold the whole
    -- before-world. Keep every store; buy resolution by coarsening anchors instead.
    SELECT s.STORE_ID, s.STORE_ROLE, COALESCE(s.ATTRACTIVENESS, 1.0) AS ATTR,
           ROW_NUMBER() OVER (ORDER BY s.STORE_ID) - 1 AS si
    FROM FLEET_INTELLIGENCE.LOCATION.STORE_FACTS s
    WHERE s.REGION = P_REGION
      AND (s.STORE_ROLE IN ('OWNED', 'COMPETITOR') OR s.STORE_ID = P_CANDIDATE_ID)
  ),
  nstores AS (SELECT COUNT(*) AS n FROM stores),
  -- Admissible speed ceiling for the ACTIVE PROFILE, bounding the prefilter below.
  -- One figure cannot serve every profile: 130 km/h is right for a lorry and absurd
  -- for an e-bike, where it inflated a 10-minute band into a 21.7 km radius.
  spd AS (
    SELECT CASE
             WHEN p LIKE 'foot%' OR p LIKE 'wheelchair%' THEN 8000.0
             WHEN p LIKE 'cycling%'                      THEN 35000.0
             ELSE 130000.0
           END AS mph
    FROM (SELECT COALESCE((SELECT ORS_PROFILE FROM FLEET_APP.CORE.VW_REGION_PROFILE
                            WHERE REGION = P_REGION LIMIT 1), 'driving-car') AS p)
  ),
  near AS (
    -- ADMISSIBLE prefilter, not an approximation: straight-line distance is a lower
    -- bound on road distance, so a cell beyond band_minutes at the profile's speed
    -- ceiling cannot be inside the band. Without it the matrix is sized by the
    -- REGION, which is fatal for a state - measured 76,335 res-7 cells for UsTexas
    -- against 87 for the SanFrancisco metro.
    --
    -- The isochrone would be the exact filter (points inside it are routable BY
    -- CONSTRUCTION, which also cures the unroutable-source abort below) but it
    -- CANNOT be used here: feeding ISOCHRONES output into the argument of the
    -- MATRIX_TABULAR call in the same body fails at CREATE with a misleading
    -- "Insufficient privileges to operate on Table function ... ISOCHRONES",
    -- reproducibly under ACCOUNTADMIN, with literal arguments, with the CTE
    -- referenced once, and even with the isochrone extracted into its own UDTF
    -- (which gets inlined). Chaining two ORS table functions that way is the
    -- construct that breaks, so the bound stays geometric.
    --
    -- HH >= 3 is the routability guard that replaces it. ONE unroutable source
    -- aborts the whole ORS matrix as an opaque `all_chunks_failed`, and the offenders
    -- are near-empty cells whose centroid - the mean of a handful of addresses -
    -- can land somewhere the profile's graph cannot snap (open water in a coastal
    -- region). Cells this small are also demand-irrelevant; the households dropped
    -- are reported by the caller's own totals, so the cost is visible rather than
    -- hidden.
    SELECT c.H3, c.HH, c.CENTROID
    FROM FLEET_INTELLIGENCE.LOCATION.HH_CELLS c, cand, spd
    WHERE c.REGION = P_REGION AND c.HH >= 3
      AND ST_DWITHIN(c.CENTROID, cand.g, P_BAND * (spd.mph / 60.0))
  ),
  counts AS (
    -- All five candidate resolutions counted in ONE pass over `near`. This is not a
    -- micro-optimisation: `near` wraps the ORS isochrone table function, and the
    -- earlier five-branch UNION ALL referenced it five times, which made CREATE
    -- FUNCTION fail outright with a misleading "Insufficient privileges to operate
    -- on Table function ISOCHRONES" - reproducible with LITERAL arguments and under
    -- ACCOUNTADMIN, so it is repeated expansion of a table function, not a grant.
    SELECT COUNT(DISTINCT H3_CELL_TO_PARENT(H3, 8)) AS n8,
           COUNT(DISTINCT H3_CELL_TO_PARENT(H3, 7)) AS n7,
           COUNT(DISTINCT H3_CELL_TO_PARENT(H3, 6)) AS n6,
           COUNT(DISTINCT H3_CELL_TO_PARENT(H3, 5)) AS n5,
           COUNT(DISTINCT H3_CELL_TO_PARENT(H3, 4)) AS n4
    FROM near
  ),
  -- Per-region matrix pair ceiling. This CANNOT be a single constant, because it is
  -- the region's own ors-config `matrix.maximum_routes` and regions on one account
  -- genuinely differ: measured here, UsTexas accepted 901 x 25 = 22,525 pairs while
  -- SanFrancisco failed at 300 x 13 = 3,900 and succeeded at 150 x 13 = 1,950 - the
  -- signature of a region still on the STOCK 2500 default. Hard-coding the generous
  -- value breaks SanFrancisco with an opaque `all_chunks_failed`; hard-coding the
  -- safe one drops UsTexas to H3 res 5 and throws away resolution it can afford.
  -- So read OPENROUTESERVICE_APP.CORE.REGION_ORS_LIMITS (the table the admin app's
  -- routing-limits panel already owns) and fall back to the SAFE value when the
  -- region has no recorded limit, since guessing high fails closed.
  cap AS (
    SELECT COALESCE(
             (SELECT TRY_TO_NUMBER(TO_VARCHAR(LIMITS:matrix_maximum_routes))
                FROM OPENROUTESERVICE_APP.CORE.REGION_ORS_LIMITS
               WHERE UPPER(REGION) = UPPER(P_REGION) LIMIT 1),
             2400) AS maxpairs
  ),
  chosen AS (
    -- Finest resolution satisfying BOTH caps: the region's engine pair ceiling and
    -- the gateway's ORS_GUARDRAIL_MATRIX_MAX_LOCATIONS (1500 in
    -- routing-gateway-service.yaml), which pre-rejects on the SIZE OF THE LOCATIONS
    -- ARRAY before the engine is reached. Different units, and either alone lets the
    -- call fail: 522 anchors x 25 stores is only 13,050 pairs but 547 locations.
    SELECT CASE
             WHEN c.n8 > 0 AND c.n8 * s.n <= p.maxpairs * 0.96 AND c.n8 + s.n <= 1400 THEN 8
             WHEN c.n7 > 0 AND c.n7 * s.n <= p.maxpairs * 0.96 AND c.n7 + s.n <= 1400 THEN 7
             WHEN c.n6 > 0 AND c.n6 * s.n <= p.maxpairs * 0.96 AND c.n6 + s.n <= 1400 THEN 6
             WHEN c.n5 > 0 AND c.n5 * s.n <= p.maxpairs * 0.96 AND c.n5 + s.n <= 1400 THEN 5
             ELSE 4
           END AS res
    FROM counts c CROSS JOIN nstores s CROSS JOIN cap p
  ),
  anchors AS (
    -- Household-WEIGHTED centroid: a coarse anchor spans dense core and empty land,
    -- and the geometric centre would measure drive time to a field nobody lives in.
    SELECT H3_CELL_TO_PARENT(n.H3, ch.res) AS ANCHOR_H3,
           ANY_VALUE(ch.res) AS res,
           SUM(n.HH) AS HH,
           ST_MAKEPOINT(SUM(ST_X(n.CENTROID) * n.HH) / NULLIF(SUM(n.HH), 0),
                        SUM(ST_Y(n.CENTROID) * n.HH) / NULLIF(SUM(n.HH), 0)) AS CENTROID
    FROM near n CROSS JOIN chosen ch
    GROUP BY 1
  ),
  -- SNAP each anchor to a REAL ADDRESS: the address inside the anchor nearest to its
  -- household-weighted centre. This is the root-cause fix for the unroutable-source
  -- abort. HH_CELLS.CENTROID is the arithmetic MEAN of the addresses in a cell, and a
  -- mean is not itself a place - across a bay, a park or a river bend it lands in
  -- water, where no profile's graph can snap it, and ONE such source aborts the whole
  -- ORS matrix as an opaque `all_chunks_failed`. Rolling up to a coarser anchor makes
  -- it worse, since the mean is taken over a wider, emptier area. An actual address is
  -- on land and adjacent to a road by construction. Non-ORS, so it does not chain two
  -- table functions (see the note in `near`).
  anchor_pts AS (
    SELECT a.ANCHOR_H3, a.res, a.HH,
           ST_MAKEPOINT(ra.LONGITUDE, ra.LATITUDE) AS CENTROID
    FROM anchors a
    JOIN FLEET_INTELLIGENCE.CATCHMENT.REGIONAL_ADDRESSES ra
      ON ra.REGION = P_REGION AND ra.GEOMETRY IS NOT NULL
     AND H3_CELL_TO_PARENT(H3_POINT_TO_CELL_STRING(ra.GEOMETRY, 8), a.res) = a.ANCHOR_H3
    QUALIFY ROW_NUMBER() OVER (PARTITION BY a.ANCHOR_H3
                               ORDER BY ST_DISTANCE(ST_MAKEPOINT(ra.LONGITUDE, ra.LATITUDE),
                                                    a.CENTROID)) = 1
  ),
  anchors_i AS (
    SELECT ANCHOR_H3, res, HH, CENTROID,
           ROW_NUMBER() OVER (ORDER BY ANCHOR_H3) - 1 AS ai
    FROM anchor_pts
  ),
  mtx AS (
    -- ORS_MATRIX = suspended-engine guard (see FLEET_APP.CORE): raises instead of
    -- letting the `durations IS NOT NULL` filter below quietly return no rows,
    -- which would render an empty panel indistinguishable from "no impact".
    -- Both coordinate arrays are aggregated from the SAME CTEs that assign the
    -- positional indexes, deliberately: the matrix is addressed purely by position,
    -- so a re-stated filter that drifted would silently attach every drive time to
    -- the wrong store with nothing to error on.
    SELECT FLEET_APP.CORE.ORS_MATRIX(OPENROUTESERVICE_APP.CORE.MATRIX_TABULAR(
      COALESCE((SELECT ORS_PROFILE FROM FLEET_APP.CORE.VW_REGION_PROFILE
                 WHERE REGION = P_REGION LIMIT 1), 'driving-car'),
      (SELECT ARRAY_AGG(ARRAY_CONSTRUCT(ST_X(CENTROID), ST_Y(CENTROID)))
                WITHIN GROUP (ORDER BY ai) FROM anchors_i),
      (SELECT ARRAY_AGG(ARRAY_CONSTRUCT(LON, LAT)) WITHIN GROUP (ORDER BY s.si)
         FROM stores s JOIN FLEET_INTELLIGENCE.LOCATION.STORE_FACTS f
           ON f.REGION = P_REGION AND f.STORE_ID = s.STORE_ID),
      P_REGION)) AS m
  ),
  pairs AS (
    SELECT a.ANCHOR_H3, a.res, a.HH, s.STORE_ID, s.STORE_ROLE, s.ATTR,
           (mtx.m:durations[a.ai][s.si]::FLOAT) / 60.0 AS drive_min
    FROM mtx, anchors_i a CROSS JOIN stores s
  ),
  valid AS (
    -- Unreachable pairs are dropped HERE, before any normalisation. Dropping them
    -- afterwards would leave the surviving shares in an anchor summing to less
    -- than 1, understating every store silently rather than failing.
    -- GREATEST(drive_min, 1.0) guards the divide-by-zero when an anchor centroid
    -- lands on a store: 0 ^ -beta is infinity, which poisons the whole SUM().
    SELECT ANCHOR_H3, res, HH, STORE_ID, STORE_ROLE, drive_min,
           ATTR / POWER(GREATEST(drive_min, 1.0), P_BETA) AS w
    FROM pairs
    WHERE drive_min IS NOT NULL
  ),
  scope AS (
    -- Band membership is decided by the ENGINE's drive time, not by the geometric
    -- prefilter above (which is only an outer bound).
    SELECT DISTINCT ANCHOR_H3 FROM valid
    WHERE STORE_ID = P_CANDIDATE_ID AND drive_min <= P_BAND
  ),
  inscope AS (
    SELECT v.* FROM valid v JOIN scope sc ON sc.ANCHOR_H3 = v.ANCHOR_H3
  ),
  norm AS (
    SELECT ANCHOR_H3, res, HH, STORE_ID, STORE_ROLE, drive_min,
           w / NULLIF(SUM(w) OVER (PARTITION BY ANCHOR_H3), 0) AS share_after,
           IFF(STORE_ID = P_CANDIDATE_ID, 0,
               w / NULLIF(SUM(IFF(STORE_ID = P_CANDIDATE_ID, 0, w))
                            OVER (PARTITION BY ANCHOR_H3), 0)) AS share_before
    FROM inscope
  )
  SELECT ANCHOR_H3, res::INT AS anchor_res, STORE_ID, STORE_ROLE,
         ROUND(drive_min, 1)::NUMBER(14,1) AS drive_min, HH,
         share_before::NUMBER(12,8), share_after::NUMBER(12,8)
  FROM norm
$$;

-- Finance is user-driven (not synthetic ANNUAL_REVENUE/ANNUAL_EBITDA): the caller
-- supplies annual value per household, EBITDA margin, and capture rate, so:
--   revenue        = transferred_hh * P_VALUE_PER_HH * P_CAPTURE_RATE
--   ebitda_transfer= revenue * P_EBITDA_MARGIN
--   home/sample/walk= revenue * per-store interaction split (HV/SAMPLE/WALKIN_PCT)
-- P_EBITDA_MARGIN and P_CAPTURE_RATE are passed as fractions (0..1).
--
-- HOUSEHOLDS is now the DEMAND THE CANDIDATE TAKES FROM THIS STORE - a Huff share
-- difference (see LIVE_HUFF_ALLOCATION) - not "cells whose centroid is nearest to
-- this store". Two consequences worth stating before anyone reads the table:
--   * Many MORE owned stores now appear, each with a smaller number. Previously
--     only nearest-neighbour stores could ever show a loss; a real gravity model
--     spreads a little transfer across the estate, which is what it should do.
--   * P_CAPTURE_RATE is no longer the model. The share of a household's spend that
--     moves is derived from drive time and store size; the slider is now a
--     calibration multiplier on top of it.
-- TRANSFER_PCT is each store's SHARE OF THE TOTAL TRANSFER - how the loss is
-- distributed across the estate - and the rows sum to 100. It is deliberately not
-- a per-store loss intensity, because in a gravity model that quantity carries
-- almost no information: share_after / share_before collapses to
-- base_w / (base_w + candidate_w), which is IDENTICAL for every incumbent in a
-- given anchor. Measured, it printed 99.5 on all ten stores at once - a column that
-- looks broken while being arithmetically correct. Distribution is also the
-- question being asked here, since the table exists to identify WHICH store bears
-- the hit. A percentage of store turnover is not available at all: the honest
-- denominator would be the store's own revenue, which for the owned estate is
-- itself synthetic.
DROP FUNCTION IF EXISTS FLEET_APP.LOCATION.LIVE_CANNIBALISATION(VARCHAR, INT, VARCHAR);
CREATE OR REPLACE FUNCTION FLEET_APP.LOCATION.LIVE_CANNIBALISATION(
  P_CANDIDATE_ID VARCHAR, P_BAND INT, P_REGION VARCHAR,
  P_VALUE_PER_HH FLOAT, P_EBITDA_MARGIN FLOAT, P_CAPTURE_RATE FLOAT, P_BETA FLOAT)
RETURNS TABLE (STORE_ID VARCHAR, POI_NAME VARCHAR, HOUSEHOLDS INT, TRANSFER_PCT NUMBER(6,1),
               REVENUE NUMBER(18,0), HOME_VISIT NUMBER(18,0), SAMPLE_REV NUMBER(18,0),
               WALK_IN NUMBER(18,0), EBITDA_TRANSFER NUMBER(18,0))
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-location-diagnostics","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH alloc AS (
    SELECT * FROM TABLE(FLEET_APP.LOCATION.LIVE_HUFF_ALLOCATION(
      P_CANDIDATE_ID, P_BAND, P_REGION, P_BETA))
    WHERE STORE_ROLE = 'OWNED'
  ),
  agg AS (
    SELECT STORE_ID, SUM(HH * (SHARE_BEFORE - SHARE_AFTER)) AS lost_hh
    FROM alloc
    GROUP BY STORE_ID
  ),
  facts AS (
    SELECT STORE_ID, POI_NAME, HV_PCT, SAMPLE_PCT, WALKIN_PCT
    FROM FLEET_INTELLIGENCE.LOCATION.STORE_FACTS
    WHERE REGION = P_REGION AND STORE_ROLE = 'OWNED'
  ),
  calc AS (
    SELECT a.STORE_ID, f.POI_NAME, a.lost_hh,
           a.lost_hh * P_VALUE_PER_HH * P_CAPTURE_RATE AS rev,
           f.HV_PCT, f.SAMPLE_PCT, f.WALKIN_PCT
    FROM agg a JOIN facts f ON f.STORE_ID = a.STORE_ID
    -- A store can gain a sliver when the candidate reshapes a shared anchor; only
    -- genuine losses belong in a cannibalisation table.
    WHERE a.lost_hh > 0
  ),
  money AS (
    -- WALK_IN is the RESIDUAL, not its own rounded product. Rounding the three
    -- interaction splits independently left them failing to sum to REVENUE on 3 of
    -- 10 rows - visible on screen, and exactly the arithmetic a reader spot-checks.
    SELECT STORE_ID, POI_NAME, lost_hh, rev,
           SUM(lost_hh) OVER () AS all_lost,
           ROUND(rev * HV_PCT)     AS hv,
           ROUND(rev * SAMPLE_PCT) AS sm
    FROM calc
  )
  SELECT STORE_ID, POI_NAME, ROUND(lost_hh)::INT AS households,
         ROUND(100 * lost_hh / NULLIF(all_lost, 0), 1)::NUMBER(6,1) AS transfer_pct,
         ROUND(rev)::NUMBER(18,0) AS revenue,
         hv::NUMBER(18,0) AS home_visit,
         sm::NUMBER(18,0) AS sample_rev,
         (ROUND(rev) - hv - sm)::NUMBER(18,0) AS walk_in,
         ROUND(rev * P_EBITDA_MARGIN)::NUMBER(18,0) AS ebitda_transfer
  FROM money
$$;

-- Arity overload keeping the pre-Huff 6-arg signature alive at the conventional
-- retail decay of 2.0, so any caller not passing BETA (a saved query, an agent's
-- semantic-view tool, an older app image) keeps working instead of failing to
-- resolve. Overloading rather than defaulting is deliberate: a DEFAULT on a
-- trailing arg makes the two forms ambiguous and needs an explicit DROP to replace.
CREATE OR REPLACE FUNCTION FLEET_APP.LOCATION.LIVE_CANNIBALISATION(
  P_CANDIDATE_ID VARCHAR, P_BAND INT, P_REGION VARCHAR,
  P_VALUE_PER_HH FLOAT, P_EBITDA_MARGIN FLOAT, P_CAPTURE_RATE FLOAT)
RETURNS TABLE (STORE_ID VARCHAR, POI_NAME VARCHAR, HOUSEHOLDS INT, TRANSFER_PCT NUMBER(6,1),
               REVENUE NUMBER(18,0), HOME_VISIT NUMBER(18,0), SAMPLE_REV NUMBER(18,0),
               WALK_IN NUMBER(18,0), EBITDA_TRANSFER NUMBER(18,0))
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-location-diagnostics","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  SELECT * FROM TABLE(FLEET_APP.LOCATION.LIVE_CANNIBALISATION(
    P_CANDIDATE_ID, P_BAND, P_REGION, P_VALUE_PER_HH, P_EBITDA_MARGIN,
    P_CAPTURE_RATE, 2.0::FLOAT))
$$;

-- =============================================================================
-- LIVE_SITE_VERDICT - the number a site decision actually turns on.
--
-- Cannibalisation on its own cannot answer "should we open this?". A site that
-- takes 1M from our own estate and 1M from competitors is a completely different
-- proposition from one that takes 2M from our own estate, and until now the view
-- could not tell them apart - because there were no competitors in the model, so
-- 100% of a candidate's demand was cannibalisation BY CONSTRUCTION.
--
-- Splitting the candidate's captured demand by the ROLE it was taken from gives:
--   CANNIBALISED   - taken from our OWNED estate (a transfer, not growth)
--   NET_NEW        - taken from COMPETITOR stores (genuine incremental demand)
--   captured       = cannibalised + net_new, exactly, because Huff shares sum to 1
--                    before and after, so every loss is someone's gain.
-- PAYBACK_YEARS deliberately divides occupancy cost by NET NEW EBITDA, not total
-- EBITDA: charging the site for profit merely moved from a store we already own
-- would be double-counting, and is the standard way a property team is misled.
--
-- ONE ROW PER CANDIDATE, from ONE ORS matrix call. Evaluating every candidate in a
-- single call is not just an optimisation - it is the only way this works. ORS SQL
-- functions accept literal, bind or scalar-subquery arguments but NOT a correlated
-- per-row column, so `FROM candidates c, TABLE(f(c.STORE_ID))` cannot be used to
-- build a league table over a per-candidate function. Instead every candidate is
-- priced against the SAME shared base pull, which is also more correct: each
-- candidate is evaluated against a world where the other candidates do not exist.
--
-- ONE ROW, for ONE candidate, from ONE ORS matrix call.
--
-- It is deliberately per-candidate rather than a whole league table in one call,
-- and that was settled by measurement rather than taste. Pricing every candidate
-- together needs the UNION of their neighbourhoods in a single locations array,
-- and measured on UsTexas that shared grid collapsed to H3 res 5, leaving ONE
-- anchor inside a 20-minute band per candidate - a 47,000-household trade area
-- represented by a single point. Coarsening does not merely blur the answer there,
-- it DELETES the trade area. Per-candidate keeps the native res-8 grid.
--
-- To rank candidates, call this once per candidate and UNION the rows. Do NOT try
-- to lateral-join it against the candidate list: ORS SQL functions accept literal,
-- bind or scalar-subquery arguments but NOT a correlated per-row column, so
-- `FROM candidates c, TABLE(LIVE_SITE_VERDICT(c.STORE_ID, ...))` fails to evaluate.
--
-- Anchor sizing and the 200-location gateway cap: see LIVE_HUFF_ALLOCATION.
-- Live, never cached (Tenet 9).
-- =============================================================================
CREATE OR REPLACE FUNCTION FLEET_APP.LOCATION.LIVE_SITE_VERDICT(
  P_CANDIDATE_ID VARCHAR, P_BAND INT, P_REGION VARCHAR, P_VALUE_PER_HH FLOAT,
  P_EBITDA_MARGIN FLOAT, P_CAPTURE_RATE FLOAT, P_BETA FLOAT)
RETURNS TABLE (CANDIDATE_ID VARCHAR, POI_NAME VARCHAR, CAPTURED_HH INT,
               CANNIBALISED_HH INT, NET_NEW_HH INT, CANNIBALISATION_RATE_PCT NUMBER(6,1),
               CAPTURED_REVENUE NUMBER(18,0), CANNIBALISED_REVENUE NUMBER(18,0),
               NET_NEW_REVENUE NUMBER(18,0), NET_NEW_EBITDA NUMBER(18,0),
               ANNUAL_OCCUPANCY_COST NUMBER(18,0), PAYBACK_YEARS NUMBER(10,2),
               STORES_IMPACTED INT, ANCHORS_IN_BAND INT, ANCHOR_RES INT)
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-location-diagnostics","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH alloc AS (
    -- Reuses the SAME allocation the transfer table reads, so the headline KPIs and
    -- the per-store rows can never disagree - and the whole verdict costs the one
    -- ORS matrix call that allocation already makes.
    SELECT * FROM TABLE(FLEET_APP.LOCATION.LIVE_HUFF_ALLOCATION(
      P_CANDIDATE_ID, P_BAND, P_REGION, P_BETA))
  ),
  per_store AS (
    SELECT STORE_ID, STORE_ROLE,
           SUM(HH * (SHARE_BEFORE - SHARE_AFTER)) AS lost_hh,
           SUM(HH * SHARE_AFTER)                  AS gained_hh
    FROM alloc
    GROUP BY STORE_ID, STORE_ROLE
  ),
  tot AS (
    SELECT
      -- The candidate's own row carries SHARE_BEFORE = 0, so its SHARE_AFTER mass
      -- IS the demand it captures.
      COALESCE(SUM(IFF(STORE_ROLE = 'CANDIDATE', gained_hh, 0)), 0) AS captured_hh,
      COALESCE(SUM(IFF(STORE_ROLE = 'OWNED', GREATEST(lost_hh, 0), 0)), 0) AS cann_hh,
      COALESCE(SUM(IFF(STORE_ROLE = 'COMPETITOR', GREATEST(lost_hh, 0), 0)), 0) AS net_hh,
      COALESCE(SUM(IFF(STORE_ROLE = 'OWNED' AND lost_hh > 0, 1, 0)), 0) AS owned_hit
    FROM per_store
  ),
  grid AS (
    SELECT COUNT(DISTINCT ANCHOR_H3) AS anchors_in_band, MIN(ANCHOR_RES) AS res
    FROM alloc
  ),
  f AS (
    SELECT STORE_ID, POI_NAME,
           COALESCE(ANNUAL_RENT, 0) + COALESCE(RATES_PSF, 0) * COALESCE(SQFT, 0) AS occ
    FROM FLEET_INTELLIGENCE.LOCATION.STORE_FACTS
    WHERE REGION = P_REGION AND STORE_ID = P_CANDIDATE_ID
  )
  SELECT f.STORE_ID AS candidate_id, f.POI_NAME,
         ROUND(t.captured_hh)::INT, ROUND(t.cann_hh)::INT,
         -- NET_NEW_HH is the RESIDUAL of the two rounded figures, so the identity
         -- captured = cannibalised + net_new holds exactly in the numbers a reader
         -- sees. Rounding all three independently left it off by 1 on three of four
         -- bands - arithmetically trivial, but this is the decomposition the whole
         -- view argues from, so it must add up on screen.
         (ROUND(t.captured_hh) - ROUND(t.cann_hh))::INT,
         ROUND(100 * t.cann_hh / NULLIF(t.captured_hh, 0), 1)::NUMBER(6,1) AS cannibalisation_rate_pct,
         ROUND(t.captured_hh * P_VALUE_PER_HH * P_CAPTURE_RATE)::NUMBER(18,0) AS captured_revenue,
         ROUND(t.cann_hh    * P_VALUE_PER_HH * P_CAPTURE_RATE)::NUMBER(18,0) AS cannibalised_revenue,
         ROUND(t.net_hh     * P_VALUE_PER_HH * P_CAPTURE_RATE)::NUMBER(18,0) AS net_new_revenue,
         ROUND(t.net_hh * P_VALUE_PER_HH * P_CAPTURE_RATE * P_EBITDA_MARGIN)::NUMBER(18,0) AS net_new_ebitda,
         ROUND(f.occ)::NUMBER(18,0) AS annual_occupancy_cost,
         ROUND(f.occ / NULLIF(t.net_hh * P_VALUE_PER_HH * P_CAPTURE_RATE * P_EBITDA_MARGIN, 0),
               2)::NUMBER(10,2) AS payback_years,
         t.owned_hit::INT AS stores_impacted,
         g.anchors_in_band::INT, g.res::INT AS anchor_res
  FROM f CROSS JOIN tot t CROSS JOIN grid g
$$;

-- Live overlap geometry for Site Impact: computes the candidate isochrone with
-- ONE ORS call, reuses LIVE_OWNED_CATCHMENTS (a second, multi-location ORS call)
-- for every OWNED store, then ST_INTERSECTIONs the candidate polygon with each
-- owned polygon to produce EXPLICIT overlap geometries. Households (H3 cell
-- centroid containment) and ZIPs (ZIP centroid containment) inside each overlap
-- are attributed and the cannibalisation math is done server-side. Two ORS
-- calls total; nothing is precomputed (Architecture Tenet 9). Region ORS must be
-- RESUMED. Finance is user-driven, mirroring LIVE_CANNIBALISATION:
--   cannibalised_revenue = overlap_hh * P_VALUE_PER_HH * P_CAPTURE_RATE
--   cannibalised_ebitda  = cannibalised_revenue * P_EBITDA_MARGIN
-- P_EBITDA_MARGIN and P_CAPTURE_RATE are fractions (0..1).
CREATE OR REPLACE FUNCTION FLEET_APP.LOCATION.LIVE_OVERLAPS(
  P_CANDIDATE_ID VARCHAR, P_BAND INT, P_REGION VARCHAR,
  P_VALUE_PER_HH FLOAT, P_EBITDA_MARGIN FLOAT, P_CAPTURE_RATE FLOAT)
RETURNS TABLE (OVERLAP_ID VARCHAR, OWNED_STORE_ID VARCHAR, OWNED_STORE VARCHAR, BAND_MIN INT,
               OVERLAP_GEO GEOGRAPHY, OVERLAP_AREA_SQKM NUMBER(14,3), HOUSEHOLDS INT,
               ZIP_COUNT INT, POPULATION INT, CANNIBALISED_REVENUE NUMBER(18,0),
               CANNIBALISED_EBITDA NUMBER(18,0), TRANSFER_PROB NUMBER(6,3), CONFIDENCE NUMBER(6,3))
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-location-diagnostics","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH cand AS (
    SELECT TO_GEOGRAPHY(f.value:geometry) AS poly
    FROM TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES(
      -- Region-resolved, never hardcoded: see FLEET_APP.CORE.VW_REGION_PROFILE.
      COALESCE((SELECT ORS_PROFILE FROM FLEET_APP.CORE.VW_REGION_PROFILE
                 WHERE REGION = P_REGION LIMIT 1), 'driving-car'),
      ARRAY_CONSTRUCT(ARRAY_CONSTRUCT(
        (SELECT LON FROM FLEET_INTELLIGENCE.LOCATION.STORE_FACTS WHERE REGION = P_REGION AND STORE_ID = P_CANDIDATE_ID),
        (SELECT LAT FROM FLEET_INTELLIGENCE.LOCATION.STORE_FACTS WHERE REGION = P_REGION AND STORE_ID = P_CANDIDATE_ID))),
      ARRAY_CONSTRUCT(P_BAND * 60), 'time', P_REGION)) resp,
      -- ORS_FEATURES = the suspended-engine guard: raises instead of yielding
      -- zero rows when the region's ORS service is down (see FLEET_APP.CORE).
      LATERAL FLATTEN(input => FLEET_APP.CORE.ORS_FEATURES(resp.RESPONSE)) f
  ),
  owned AS (
    SELECT STORE_ID, POI_NAME, GEO
    FROM TABLE(FLEET_APP.LOCATION.LIVE_OWNED_CATCHMENTS(P_BAND, P_REGION))
  ),
  facts AS (
    SELECT STORE_ID, REFERENCE_HH
    FROM FLEET_INTELLIGENCE.LOCATION.STORE_FACTS
    WHERE REGION = P_REGION AND STORE_ROLE = 'OWNED'
  ),
  ov AS (
    SELECT o.STORE_ID, o.POI_NAME, ST_INTERSECTION(c.poly, o.GEO) AS g
    FROM cand c CROSS JOIN owned o
    WHERE c.poly IS NOT NULL AND o.GEO IS NOT NULL
  ),
  ovf AS (
    SELECT STORE_ID, POI_NAME, g FROM ov WHERE g IS NOT NULL AND ST_AREA(g) > 0
  ),
  hh AS (
    SELECT ovf.STORE_ID, SUM(c.HH) AS households
    FROM ovf JOIN FLEET_INTELLIGENCE.LOCATION.HH_CELLS c
      ON c.REGION = P_REGION AND ST_WITHIN(c.CENTROID, ovf.g)
    GROUP BY ovf.STORE_ID
  ),
  zp AS (
    SELECT ovf.STORE_ID, COUNT(*) AS zip_count, SUM(z.POPULATION) AS population
    FROM ovf JOIN FLEET_INTELLIGENCE.LOCATION.ZIP_AREAS z
      ON z.REGION = P_REGION AND ST_WITHIN(z.CENTROID, ovf.g)
    GROUP BY ovf.STORE_ID
  ),
  -- Households inside the overlap that ALSO fall within an attributed postcode
  -- polygon: the numerator of the CONFIDENCE measure below.
  hc AS (
    SELECT ovf.STORE_ID, SUM(c.HH) AS covered_hh
    FROM ovf
    JOIN FLEET_INTELLIGENCE.LOCATION.HH_CELLS c
      ON c.REGION = P_REGION AND ST_WITHIN(c.CENTROID, ovf.g)
    JOIN FLEET_INTELLIGENCE.LOCATION.ZIP_AREAS z
      ON z.REGION = P_REGION AND ST_WITHIN(c.CENTROID, z.GEOG)
    GROUP BY ovf.STORE_ID
  ),
  zt AS (
    SELECT COUNT(*) AS n FROM FLEET_INTELLIGENCE.LOCATION.ZIP_AREAS
    WHERE REGION = P_REGION
  )
  SELECT P_CANDIDATE_ID || '~' || ovf.STORE_ID AS overlap_id,
         ovf.STORE_ID AS owned_store_id, ovf.POI_NAME AS owned_store, P_BAND AS band_min,
         ovf.g AS overlap_geo,
         ROUND(ST_AREA(ovf.g) / 1e6, 3)::NUMBER(14,3) AS overlap_area_sqkm,
         COALESCE(hh.households, 0) AS households,
         COALESCE(zp.zip_count, 0) AS zip_count,
         COALESCE(zp.population, 0) AS population,
         ROUND(COALESCE(hh.households, 0) * P_VALUE_PER_HH * P_CAPTURE_RATE)::NUMBER(18,0) AS cannibalised_revenue,
         ROUND(COALESCE(hh.households, 0) * P_VALUE_PER_HH * P_CAPTURE_RATE * P_EBITDA_MARGIN)::NUMBER(18,0) AS cannibalised_ebitda,
         LEAST(1, COALESCE(hh.households, 0) / NULLIF(f.REFERENCE_HH, 0))::NUMBER(6,3) AS transfer_prob,
         -- Formerly LEAST(1, zip_count / 5.0): an arbitrary constant labelled
         -- "confidence" that rose with the SIZE of the overlap, so a big overlap
         -- always looked trustworthy regardless of evidence. This is the real
         -- thing - the share of the overlap's households that sit inside a
         -- postcode we could actually attribute demographics to. NULL when the
         -- region has no ZIP_AREAS at all (non-US), because absence of evidence
         -- must not read as high confidence.
         IFF(zt.n = 0, NULL,
             ROUND(COALESCE(hc.covered_hh, 0)
                   / NULLIF(COALESCE(hh.households, 0), 0), 3))::NUMBER(6,3) AS confidence
  FROM ovf
  LEFT JOIN hh    ON hh.STORE_ID = ovf.STORE_ID
  LEFT JOIN zp    ON zp.STORE_ID = ovf.STORE_ID
  LEFT JOIN hc    ON hc.STORE_ID = ovf.STORE_ID
  LEFT JOIN facts f ON f.STORE_ID = ovf.STORE_ID
  CROSS JOIN zt
$$;

-- Per-ZIP rows inside each candidate/owned overlap (postcode-in-overlap table +
-- overlap detail drawer ZIP list). Same 2-ORS-call pattern as LIVE_OVERLAPS.
CREATE OR REPLACE FUNCTION FLEET_APP.LOCATION.LIVE_OVERLAP_ZIPS(
  P_CANDIDATE_ID VARCHAR, P_BAND INT, P_REGION VARCHAR)
RETURNS TABLE (OVERLAP_ID VARCHAR, OWNED_STORE_ID VARCHAR, OWNED_STORE VARCHAR,
               ZIP VARCHAR, POPULATION INT, HOUSEHOLDS INT, MEDIAN_INCOME NUMBER(12,0), GEO GEOGRAPHY)
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-location-diagnostics","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH cand AS (
    SELECT TO_GEOGRAPHY(f.value:geometry) AS poly
    FROM TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES(
      -- Region-resolved, never hardcoded: see FLEET_APP.CORE.VW_REGION_PROFILE.
      COALESCE((SELECT ORS_PROFILE FROM FLEET_APP.CORE.VW_REGION_PROFILE
                 WHERE REGION = P_REGION LIMIT 1), 'driving-car'),
      ARRAY_CONSTRUCT(ARRAY_CONSTRUCT(
        (SELECT LON FROM FLEET_INTELLIGENCE.LOCATION.STORE_FACTS WHERE REGION = P_REGION AND STORE_ID = P_CANDIDATE_ID),
        (SELECT LAT FROM FLEET_INTELLIGENCE.LOCATION.STORE_FACTS WHERE REGION = P_REGION AND STORE_ID = P_CANDIDATE_ID))),
      ARRAY_CONSTRUCT(P_BAND * 60), 'time', P_REGION)) resp,
      -- ORS_FEATURES = the suspended-engine guard: raises instead of yielding
      -- zero rows when the region's ORS service is down (see FLEET_APP.CORE).
      LATERAL FLATTEN(input => FLEET_APP.CORE.ORS_FEATURES(resp.RESPONSE)) f
  ),
  owned AS (
    SELECT STORE_ID, POI_NAME, GEO
    FROM TABLE(FLEET_APP.LOCATION.LIVE_OWNED_CATCHMENTS(P_BAND, P_REGION))
  ),
  ov AS (
    SELECT o.STORE_ID, o.POI_NAME, ST_INTERSECTION(c.poly, o.GEO) AS g
    FROM cand c CROSS JOIN owned o
    WHERE c.poly IS NOT NULL AND o.GEO IS NOT NULL
  ),
  ovf AS (
    SELECT STORE_ID, POI_NAME, g FROM ov WHERE g IS NOT NULL AND ST_AREA(g) > 0
  )
  SELECT P_CANDIDATE_ID || '~' || ovf.STORE_ID AS overlap_id, ovf.STORE_ID AS owned_store_id,
         ovf.POI_NAME AS owned_store, z.ZIP, z.POPULATION, z.HOUSEHOLDS, z.MEDIAN_INCOME, z.GEOG AS geo
  FROM ovf JOIN FLEET_INTELLIGENCE.LOCATION.ZIP_AREAS z
    ON z.REGION = P_REGION AND ST_WITHIN(z.CENTROID, ovf.g)
$$;

-- Overlap-intensity surface for the Site Impact map (the "smart" replacement for
-- stacking one semi-transparent intersection polygon per owned store, which
-- compounds into an opaque blob). Instead of N stacked fills, this returns a
-- single per-H3-cell coverage-count surface: for every household cell inside the
-- CANDIDATE isochrone, OVERLAP_COUNT is the number of OWNED store catchments that
-- also cover that cell = the local cannibalisation pressure. Rendered as one
-- deck.gl H3 layer graded light->dark by OVERLAP_COUNT (no alpha stacking).
-- Two ORS calls total (candidate iso + LIVE_OWNED_CATCHMENTS), nothing
-- precomputed (Architecture Tenet 9); the region ORS must be RESUMED.
--   cannibalised_revenue = cell_hh * P_VALUE_PER_HH * P_CAPTURE_RATE * overlap_count
-- P_CAPTURE_RATE is a fraction (0..1). Only cells with overlap_count > 0 (true
-- overlap zones) are returned; greenfield cells inside the candidate iso but in
-- no owned catchment are omitted.
CREATE OR REPLACE FUNCTION FLEET_APP.LOCATION.LIVE_OVERLAP_CELLS(
  P_CANDIDATE_ID VARCHAR, P_BAND INT, P_REGION VARCHAR,
  P_VALUE_PER_HH FLOAT, P_CAPTURE_RATE FLOAT)
RETURNS TABLE (H3 VARCHAR, HOUSEHOLDS INT, OVERLAP_COUNT INT,
               CANNIBALISED_REVENUE NUMBER(18,0), CENTROID GEOGRAPHY)
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-location-diagnostics","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH cand AS (
    SELECT TO_GEOGRAPHY(f.value:geometry) AS poly
    FROM TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES(
      -- Region-resolved, never hardcoded: see FLEET_APP.CORE.VW_REGION_PROFILE.
      COALESCE((SELECT ORS_PROFILE FROM FLEET_APP.CORE.VW_REGION_PROFILE
                 WHERE REGION = P_REGION LIMIT 1), 'driving-car'),
      ARRAY_CONSTRUCT(ARRAY_CONSTRUCT(
        (SELECT LON FROM FLEET_INTELLIGENCE.LOCATION.STORE_FACTS WHERE REGION = P_REGION AND STORE_ID = P_CANDIDATE_ID),
        (SELECT LAT FROM FLEET_INTELLIGENCE.LOCATION.STORE_FACTS WHERE REGION = P_REGION AND STORE_ID = P_CANDIDATE_ID))),
      ARRAY_CONSTRUCT(P_BAND * 60), 'time', P_REGION)) resp,
      -- ORS_FEATURES = the suspended-engine guard: raises instead of yielding
      -- zero rows when the region's ORS service is down (see FLEET_APP.CORE).
      LATERAL FLATTEN(input => FLEET_APP.CORE.ORS_FEATURES(resp.RESPONSE)) f
  ),
  owned AS (
    SELECT STORE_ID, GEO
    FROM TABLE(FLEET_APP.LOCATION.LIVE_OWNED_CATCHMENTS(P_BAND, P_REGION))
    WHERE GEO IS NOT NULL
  ),
  incell AS (
    SELECT c.H3, c.HH, c.CENTROID
    FROM FLEET_INTELLIGENCE.LOCATION.HH_CELLS c, cand
    WHERE c.REGION = P_REGION AND cand.poly IS NOT NULL AND ST_WITHIN(c.CENTROID, cand.poly)
  ),
  cnt AS (
    SELECT ic.H3,
           ANY_VALUE(ic.HH) AS hh,
           ANY_VALUE(ic.CENTROID) AS centroid,
           COUNT(o.STORE_ID) AS overlap_count
    FROM incell ic
    LEFT JOIN owned o ON ST_WITHIN(ic.CENTROID, o.GEO)
    GROUP BY ic.H3
  )
  SELECT H3, hh AS households, overlap_count,
         ROUND(hh * P_VALUE_PER_HH * P_CAPTURE_RATE * overlap_count)::NUMBER(18,0) AS cannibalised_revenue,
         centroid
  FROM cnt
  WHERE overlap_count > 0
$$;

-- Live closure overlap for Closure Impact: intersects the CLOSING store's drive-time
-- catchment with every SURVIVING store's catchment (all catchments from ONE multi-location
-- ORS call via LIVE_OWNED_CATCHMENTS). Each row = the shared area a survivor could inherit.
-- Finance is user-driven (mirrors LIVE_CANNIBALISATION/LIVE_OVERLAPS), not synthetic annuals:
--   retained_revenue = overlap_hh * P_VALUE_PER_HH * P_RETENTION_RATE
--   retained_ebitda  = retained_revenue * P_EBITDA_MARGIN
--   home/sample/walk  = retained_revenue * the CLOSING store's HV/SAMPLE/WALKIN split
-- P_EBITDA_MARGIN and P_RETENTION_RATE are fractions (0..1). This is the geometric overlap
-- view; the existing "gainers" table stays as the nearest-survivor (Voronoi) attribution.
DROP FUNCTION IF EXISTS FLEET_APP.LOCATION.LIVE_CLOSURE_OVERLAPS(VARCHAR, INT, VARCHAR);
CREATE OR REPLACE FUNCTION FLEET_APP.LOCATION.LIVE_CLOSURE_OVERLAPS(
  P_CLOSED_ID VARCHAR, P_BAND INT, P_REGION VARCHAR,
  P_VALUE_PER_HH FLOAT, P_EBITDA_MARGIN FLOAT, P_RETENTION_RATE FLOAT)
RETURNS TABLE (OVERLAP_ID VARCHAR, SURVIVING_STORE_ID VARCHAR, SURVIVING_STORE VARCHAR, BAND_MIN INT,
               OVERLAP_GEO GEOGRAPHY, OVERLAP_AREA_SQKM NUMBER(14,3), HOUSEHOLDS INT, ZIP_COUNT INT,
               POPULATION INT, RETAINED_REVENUE NUMBER(18,0), RETAINED_EBITDA NUMBER(18,0),
               HOME_VISIT NUMBER(18,0), SAMPLE_REV NUMBER(18,0), WALK_IN NUMBER(18,0),
               TRANSFER_PROB NUMBER(6,3), STATUS VARCHAR)
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-location-diagnostics","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH cats AS (
    SELECT STORE_ID, POI_NAME, GEO FROM TABLE(FLEET_APP.LOCATION.LIVE_OWNED_CATCHMENTS(P_BAND, P_REGION))
  ),
  closed_cat AS (SELECT GEO FROM cats WHERE STORE_ID = P_CLOSED_ID),
  cfact AS (
    SELECT HV_PCT, SAMPLE_PCT, WALKIN_PCT
    FROM FLEET_INTELLIGENCE.LOCATION.STORE_FACTS WHERE REGION = P_REGION AND STORE_ID = P_CLOSED_ID
  ),
  tot AS (
    SELECT SUM(c.HH) AS total_hh
    FROM FLEET_INTELLIGENCE.LOCATION.HH_CELLS c, closed_cat
    WHERE c.REGION = P_REGION AND ST_WITHIN(c.CENTROID, closed_cat.GEO)
  ),
  surv AS (SELECT STORE_ID, POI_NAME, GEO FROM cats WHERE STORE_ID <> P_CLOSED_ID),
  ov AS (
    SELECT s.STORE_ID, s.POI_NAME, ST_INTERSECTION(cc.GEO, s.GEO) AS g
    FROM surv s CROSS JOIN closed_cat cc
  ),
  ovf AS (SELECT STORE_ID, POI_NAME, g FROM ov WHERE g IS NOT NULL AND ST_AREA(g) > 0),
  hh AS (
    SELECT ovf.STORE_ID, SUM(c.HH) AS households
    FROM ovf JOIN FLEET_INTELLIGENCE.LOCATION.HH_CELLS c
      ON c.REGION = P_REGION AND ST_WITHIN(c.CENTROID, ovf.g)
    GROUP BY ovf.STORE_ID
  ),
  zp AS (
    SELECT ovf.STORE_ID, COUNT(*) AS zip_count, SUM(z.POPULATION) AS population
    FROM ovf JOIN FLEET_INTELLIGENCE.LOCATION.ZIP_AREAS z
      ON z.REGION = P_REGION AND ST_WITHIN(z.CENTROID, ovf.g)
    GROUP BY ovf.STORE_ID
  )
  SELECT P_CLOSED_ID || '~' || ovf.STORE_ID AS overlap_id, ovf.STORE_ID AS surviving_store_id,
         ovf.POI_NAME AS surviving_store, P_BAND AS band_min, ovf.g AS overlap_geo,
         ROUND(ST_AREA(ovf.g) / 1e6, 3)::NUMBER(14,3) AS overlap_area_sqkm,
         COALESCE(hh.households, 0) AS households, COALESCE(zp.zip_count, 0) AS zip_count,
         COALESCE(zp.population, 0) AS population,
         ROUND(COALESCE(hh.households, 0) * P_VALUE_PER_HH * P_RETENTION_RATE)::NUMBER(18,0) AS retained_revenue,
         ROUND(COALESCE(hh.households, 0) * P_VALUE_PER_HH * P_RETENTION_RATE * P_EBITDA_MARGIN)::NUMBER(18,0) AS retained_ebitda,
         ROUND(COALESCE(hh.households, 0) * P_VALUE_PER_HH * P_RETENTION_RATE * cf.HV_PCT)::NUMBER(18,0) AS home_visit,
         ROUND(COALESCE(hh.households, 0) * P_VALUE_PER_HH * P_RETENTION_RATE * cf.SAMPLE_PCT)::NUMBER(18,0) AS sample_rev,
         ROUND(COALESCE(hh.households, 0) * P_VALUE_PER_HH * P_RETENTION_RATE * cf.WALKIN_PCT)::NUMBER(18,0) AS walk_in,
         LEAST(1, COALESCE(hh.households, 0) / NULLIF(t.total_hh, 0))::NUMBER(6,3) AS transfer_prob,
         'RETAINED' AS status
  FROM ovf
  LEFT JOIN hh ON hh.STORE_ID = ovf.STORE_ID
  LEFT JOIN zp ON zp.STORE_ID = ovf.STORE_ID
  CROSS JOIN cfact cf
  CROSS JOIN tot t
$$;

-- Per-ZIP closure classification: every ZIP whose centroid is inside the closing store's
-- catchment, flagged RETAINED (also inside at least one surviving store's catchment within the
-- band) or AT_RISK (no surviving store reaches it within the band). REVENUE/EBITDA are the
-- user-driven value of each ZIP's households (households * P_VALUE_PER_HH * P_RETENTION_RATE),
-- so the app can SUM(REVENUE) GROUP BY STATUS for retained-vs-at-risk KPIs and a closure risk
-- score. P_EBITDA_MARGIN and P_RETENTION_RATE are fractions (0..1). Feeds the ZIP-in-overlap
-- table + closure detail drawer + the RETAINED/AT_RISK map choropleth.
DROP FUNCTION IF EXISTS FLEET_APP.LOCATION.LIVE_CLOSURE_ZIPS(VARCHAR, INT, VARCHAR);
CREATE OR REPLACE FUNCTION FLEET_APP.LOCATION.LIVE_CLOSURE_ZIPS(
  P_CLOSED_ID VARCHAR, P_BAND INT, P_REGION VARCHAR,
  P_VALUE_PER_HH FLOAT, P_EBITDA_MARGIN FLOAT, P_RETENTION_RATE FLOAT)
RETURNS TABLE (ZIP VARCHAR, STATUS VARCHAR, NEAREST_SURVIVOR VARCHAR,
               POPULATION INT, HOUSEHOLDS INT, MEDIAN_INCOME NUMBER(12,0),
               REVENUE NUMBER(18,0), EBITDA NUMBER(18,0), GEO GEOGRAPHY)
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-location-diagnostics","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH cats AS (
    SELECT STORE_ID, POI_NAME, GEO FROM TABLE(FLEET_APP.LOCATION.LIVE_OWNED_CATCHMENTS(P_BAND, P_REGION))
  ),
  closed_cat AS (SELECT GEO FROM cats WHERE STORE_ID = P_CLOSED_ID),
  surv AS (SELECT STORE_ID, POI_NAME, GEO FROM cats WHERE STORE_ID <> P_CLOSED_ID),
  zin AS (
    SELECT z.ZIP, z.POPULATION, z.HOUSEHOLDS, z.MEDIAN_INCOME, z.CENTROID, z.GEOG
    FROM FLEET_INTELLIGENCE.LOCATION.ZIP_AREAS z, closed_cat
    WHERE z.REGION = P_REGION AND ST_WITHIN(z.CENTROID, closed_cat.GEO)
  ),
  zcov AS (
    SELECT zin.ZIP, ANY_VALUE(s.POI_NAME) AS surv_name, COUNT(*) AS n
    FROM zin JOIN surv s ON ST_WITHIN(zin.CENTROID, s.GEO)
    GROUP BY zin.ZIP
  )
  SELECT zin.ZIP,
         CASE WHEN COALESCE(zcov.n, 0) > 0 THEN 'RETAINED' ELSE 'AT_RISK' END AS status,
         zcov.surv_name AS nearest_survivor,
         zin.POPULATION, zin.HOUSEHOLDS, zin.MEDIAN_INCOME,
         ROUND(zin.HOUSEHOLDS * P_VALUE_PER_HH * P_RETENTION_RATE)::NUMBER(18,0) AS revenue,
         ROUND(zin.HOUSEHOLDS * P_VALUE_PER_HH * P_RETENTION_RATE * P_EBITDA_MARGIN)::NUMBER(18,0) AS ebitda,
         zin.GEOG AS geo
  FROM zin LEFT JOIN zcov ON zcov.ZIP = zin.ZIP
$$;

-- Live closure coverage cells for the Closure Impact H3 heatmap (mirrors
-- LIVE_OVERLAP_CELLS - the proven-stable Site Impact pattern). For every H3
-- res-8 household cell whose centroid is inside the CLOSING store's drive-time
-- catchment, count how many SURVIVING store catchments still reach it. This is
-- the closure-risk signal: SURVIVOR_COUNT = 0 -> AT_RISK (leakage), > 0 ->
-- RETAINED. Uses ONLY ST_WITHIN over the pre-rasterized HH_CELLS grid (no
-- ST_INTERSECTION), so it avoids the fragile polygon-intersection path. Two ORS
-- calls total via LIVE_OWNED_CATCHMENTS; region ORS must be RESUMED (Tenet 9).
-- P_RETENTION_RATE is a fraction (0..1). Rendered as a single deck.gl
-- H3HexagonLayer graded by SURVIVOR_COUNT.
CREATE OR REPLACE FUNCTION FLEET_APP.LOCATION.LIVE_CLOSURE_CELLS(
  P_CLOSED_ID VARCHAR, P_BAND INT, P_REGION VARCHAR,
  P_VALUE_PER_HH FLOAT, P_RETENTION_RATE FLOAT)
RETURNS TABLE (H3 VARCHAR, HOUSEHOLDS INT, SURVIVOR_COUNT INT, STATUS VARCHAR,
               NEAREST_SURVIVOR VARCHAR, RETAINED_REVENUE NUMBER(18,0), CENTROID GEOGRAPHY)
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-location-diagnostics","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH cats AS (
    SELECT c.STORE_ID, sf.POI_NAME, sf.LON, sf.LAT, c.GEO
    FROM TABLE(FLEET_APP.LOCATION.LIVE_OWNED_CATCHMENTS(P_BAND, P_REGION)) c
    JOIN FLEET_INTELLIGENCE.LOCATION.STORE_FACTS sf
      ON sf.STORE_ID = c.STORE_ID AND sf.REGION = P_REGION
    WHERE c.GEO IS NOT NULL
  ),
  closed_cat AS (SELECT GEO FROM cats WHERE STORE_ID = P_CLOSED_ID),
  surv AS (SELECT STORE_ID, POI_NAME, LON, LAT, GEO FROM cats WHERE STORE_ID <> P_CLOSED_ID),
  incell AS (
    SELECT c.H3, c.HH, c.CENTROID
    FROM FLEET_INTELLIGENCE.LOCATION.HH_CELLS c, closed_cat
    WHERE c.REGION = P_REGION AND closed_cat.GEO IS NOT NULL AND ST_WITHIN(c.CENTROID, closed_cat.GEO)
  ),
  cov AS (
    SELECT ic.H3,
           ANY_VALUE(ic.HH) AS hh,
           ANY_VALUE(ic.CENTROID) AS centroid,
           COUNT(s.STORE_ID) AS survivor_count,
           MIN_BY(s.POI_NAME, ST_DISTANCE(ic.CENTROID, ST_MAKEPOINT(s.LON, s.LAT))) AS nearest_survivor
    FROM incell ic
    LEFT JOIN surv s ON ST_WITHIN(ic.CENTROID, s.GEO)
    GROUP BY ic.H3
  )
  SELECT H3, hh AS households, survivor_count,
         CASE WHEN survivor_count > 0 THEN 'RETAINED' ELSE 'AT_RISK' END AS status,
         nearest_survivor,
         ROUND(hh * P_VALUE_PER_HH * P_RETENTION_RATE)::NUMBER(18,0) AS retained_revenue,
         centroid
  FROM cov
$$;

-- Closure "gainers" attribution as an owner's-rights UDTF (mirrors the proven
-- LIVE_CANNIBALISATION pattern). Assigns every H3 household cell inside the
-- CLOSING store's catchment to its nearest SURVIVING store (closed store
-- excluded), then rolls up households + user-driven revenue per gaining store.
-- HV/Sample/Walk-in use the CLOSING store's interaction mix (matching the prior
-- inline query's semantics). Moving this off the inline app query removes the
-- fragile caller-side ST_WITHIN-over-raw-isochrone + CROSS JOIN plan that
-- intermittently tripped Snowflake internal error 300010/000603. Region-scoped;
-- P_RETENTION_RATE is a fraction (0..1). Region ORS must be RESUMED (Tenet 9).
CREATE OR REPLACE FUNCTION FLEET_APP.LOCATION.LIVE_CLOSURE_GAINERS(
  P_CLOSED_ID VARCHAR, P_BAND INT, P_REGION VARCHAR,
  P_VALUE_PER_HH FLOAT, P_RETENTION_RATE FLOAT)
RETURNS TABLE (GAIN_ID VARCHAR, GAINING_STORE VARCHAR, HOUSEHOLDS INT, PCT_OF_CLOSED NUMBER(6,1),
               REVENUE NUMBER(18,0), HOME_VISIT NUMBER(18,0), SAMPLE_REV NUMBER(18,0), WALK_IN NUMBER(18,0))
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-location-diagnostics","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH closed_cat AS (
    SELECT GEO FROM TABLE(FLEET_APP.LOCATION.LIVE_OWNED_CATCHMENTS(P_BAND, P_REGION))
    WHERE STORE_ID = P_CLOSED_ID
  ),
  csplit AS (
    SELECT HV_PCT, SAMPLE_PCT, WALKIN_PCT
    FROM FLEET_INTELLIGENCE.LOCATION.STORE_FACTS WHERE REGION = P_REGION AND STORE_ID = P_CLOSED_ID
  ),
  survivors AS (
    SELECT STORE_ID, POI_NAME, LON, LAT
    FROM FLEET_INTELLIGENCE.LOCATION.STORE_FACTS
    WHERE REGION = P_REGION AND STORE_ROLE = 'OWNED' AND STORE_ID <> P_CLOSED_ID
  ),
  incell AS (
    SELECT c.H3, c.HH, c.CENTROID
    FROM FLEET_INTELLIGENCE.LOCATION.HH_CELLS c, closed_cat
    WHERE c.REGION = P_REGION AND closed_cat.GEO IS NOT NULL AND ST_WITHIN(c.CENTROID, closed_cat.GEO)
  ),
  tot AS (SELECT SUM(HH) AS total_in FROM incell),
  assign AS (
    SELECT ic.H3, ic.HH, sv.STORE_ID AS GAIN_ID
    FROM incell ic CROSS JOIN survivors sv
    QUALIFY ROW_NUMBER() OVER (PARTITION BY ic.H3 ORDER BY ST_DISTANCE(ic.CENTROID, ST_MAKEPOINT(sv.LON, sv.LAT)), sv.STORE_ID) = 1
  ),
  agg AS (SELECT GAIN_ID, SUM(HH) AS hh_inh FROM assign GROUP BY 1)
  SELECT a.GAIN_ID AS gain_id, g.POI_NAME AS gaining_store, a.hh_inh AS households,
         ROUND(100 * a.hh_inh / NULLIF((SELECT total_in FROM tot), 0), 1)::NUMBER(6,1) AS pct_of_closed,
         ROUND(a.hh_inh * P_VALUE_PER_HH * P_RETENTION_RATE)::NUMBER(18,0) AS revenue,
         ROUND(a.hh_inh * P_VALUE_PER_HH * P_RETENTION_RATE * cs.HV_PCT)::NUMBER(18,0) AS home_visit,
         ROUND(a.hh_inh * P_VALUE_PER_HH * P_RETENTION_RATE * cs.SAMPLE_PCT)::NUMBER(18,0) AS sample_rev,
         ROUND(a.hh_inh * P_VALUE_PER_HH * P_RETENTION_RATE * cs.WALKIN_PCT)::NUMBER(18,0) AS walk_in
  FROM agg a
  JOIN FLEET_INTELLIGENCE.LOCATION.STORE_FACTS g ON g.STORE_ID = a.GAIN_ID AND g.REGION = P_REGION
  CROSS JOIN csplit cs
  ORDER BY revenue DESC
$$;

-- Live ZIP/overlap UDTFs (owner's-rights; consumers only need USAGE).
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_ZIP_BANDS(VARCHAR, VARCHAR) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_ZIP_BANDS(VARCHAR, VARCHAR) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_ZIP_BANDS(VARCHAR, VARCHAR) TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_OWNED_CATCHMENTS(INT, VARCHAR) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_OWNED_CATCHMENTS(INT, VARCHAR) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_OWNED_CATCHMENTS(INT, VARCHAR) TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_CANNIBALISATION(VARCHAR, INT, VARCHAR, FLOAT, FLOAT, FLOAT) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_CANNIBALISATION(VARCHAR, INT, VARCHAR, FLOAT, FLOAT, FLOAT) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_CANNIBALISATION(VARCHAR, INT, VARCHAR, FLOAT, FLOAT, FLOAT) TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_CANNIBALISATION(VARCHAR, INT, VARCHAR, FLOAT, FLOAT, FLOAT, FLOAT) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_CANNIBALISATION(VARCHAR, INT, VARCHAR, FLOAT, FLOAT, FLOAT, FLOAT) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_CANNIBALISATION(VARCHAR, INT, VARCHAR, FLOAT, FLOAT, FLOAT, FLOAT) TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_HUFF_ALLOCATION(VARCHAR, INT, VARCHAR, FLOAT) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_HUFF_ALLOCATION(VARCHAR, INT, VARCHAR, FLOAT) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_HUFF_ALLOCATION(VARCHAR, INT, VARCHAR, FLOAT) TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_SITE_VERDICT(VARCHAR, INT, VARCHAR, FLOAT, FLOAT, FLOAT, FLOAT) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_SITE_VERDICT(VARCHAR, INT, VARCHAR, FLOAT, FLOAT, FLOAT, FLOAT) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_SITE_VERDICT(VARCHAR, INT, VARCHAR, FLOAT, FLOAT, FLOAT, FLOAT) TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_OVERLAPS(VARCHAR, INT, VARCHAR, FLOAT, FLOAT, FLOAT) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_OVERLAPS(VARCHAR, INT, VARCHAR, FLOAT, FLOAT, FLOAT) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_OVERLAPS(VARCHAR, INT, VARCHAR, FLOAT, FLOAT, FLOAT) TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_OVERLAP_ZIPS(VARCHAR, INT, VARCHAR) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_OVERLAP_ZIPS(VARCHAR, INT, VARCHAR) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_OVERLAP_ZIPS(VARCHAR, INT, VARCHAR) TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_OVERLAP_CELLS(VARCHAR, INT, VARCHAR, FLOAT, FLOAT) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_OVERLAP_CELLS(VARCHAR, INT, VARCHAR, FLOAT, FLOAT) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_OVERLAP_CELLS(VARCHAR, INT, VARCHAR, FLOAT, FLOAT) TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_CLOSURE_OVERLAPS(VARCHAR, INT, VARCHAR, FLOAT, FLOAT, FLOAT) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_CLOSURE_OVERLAPS(VARCHAR, INT, VARCHAR, FLOAT, FLOAT, FLOAT) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_CLOSURE_OVERLAPS(VARCHAR, INT, VARCHAR, FLOAT, FLOAT, FLOAT) TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_CLOSURE_ZIPS(VARCHAR, INT, VARCHAR, FLOAT, FLOAT, FLOAT) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_CLOSURE_ZIPS(VARCHAR, INT, VARCHAR, FLOAT, FLOAT, FLOAT) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_CLOSURE_ZIPS(VARCHAR, INT, VARCHAR, FLOAT, FLOAT, FLOAT) TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_CLOSURE_CELLS(VARCHAR, INT, VARCHAR, FLOAT, FLOAT) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_CLOSURE_CELLS(VARCHAR, INT, VARCHAR, FLOAT, FLOAT) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_CLOSURE_CELLS(VARCHAR, INT, VARCHAR, FLOAT, FLOAT) TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_CLOSURE_GAINERS(VARCHAR, INT, VARCHAR, FLOAT, FLOAT) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_CLOSURE_GAINERS(VARCHAR, INT, VARCHAR, FLOAT, FLOAT) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.LOCATION.LIVE_CLOSURE_GAINERS(VARCHAR, INT, VARCHAR, FLOAT, FLOAT) TO ROLE FLEET_APP_ADMIN;

-- One row per drive-time band (cumulative "within X min"): the reachable polygon
-- plus real population/households/median income (household-weighted mean of ZIP
-- medians) and Overture venue + address counts inside it. P_BANDS is an ARRAY of
-- SECONDS (e.g. ARRAY_CONSTRUCT(300,600,900) for 5/10/15 min); ORS returns one
-- nested polygon per band. Feeds the KPI strip, per-band stats table, and the
-- nested-ring map layers.
DROP FUNCTION IF EXISTS FLEET_APP.CATCHMENT.LIVE_CATCHMENT(FLOAT, FLOAT, ARRAY, VARCHAR);
CREATE OR REPLACE FUNCTION FLEET_APP.CATCHMENT.LIVE_CATCHMENT(
  P_POI_NAME VARCHAR, P_LON FLOAT, P_LAT FLOAT, P_BANDS ARRAY, P_REGION VARCHAR)
RETURNS TABLE (BAND_MIN INT, GEO GEOGRAPHY, AREA_SQKM NUMBER(14,3),
               POPULATION INT, HOUSEHOLDS INT, MEDIAN_INCOME NUMBER(12,0),
               VENUES INT, ADDRESSES INT)
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH iso AS (
    SELECT (f.value:properties:value::INT)/60 AS band_min,
           TO_GEOGRAPHY(f.value:geometry) AS poly
    FROM TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES(
      -- Region-resolved, never hardcoded: see FLEET_APP.CORE.VW_REGION_PROFILE.
      COALESCE((SELECT ORS_PROFILE FROM FLEET_APP.CORE.VW_REGION_PROFILE
                 WHERE REGION = P_REGION LIMIT 1), 'driving-car'),
      ARRAY_CONSTRUCT(ARRAY_CONSTRUCT(
        COALESCE((SELECT LONGITUDE FROM FLEET_INTELLIGENCE.CATCHMENT.POIS WHERE REGION=P_REGION AND POI_NAME=P_POI_NAME ORDER BY 1 LIMIT 1), P_LON, (SELECT AVG(LONGITUDE) FROM FLEET_INTELLIGENCE.CATCHMENT.POIS WHERE REGION=P_REGION)),
        COALESCE((SELECT LATITUDE FROM FLEET_INTELLIGENCE.CATCHMENT.POIS WHERE REGION=P_REGION AND POI_NAME=P_POI_NAME ORDER BY 1 LIMIT 1), P_LAT, (SELECT AVG(LATITUDE) FROM FLEET_INTELLIGENCE.CATCHMENT.POIS WHERE REGION=P_REGION)))),
      P_BANDS, 'time', P_REGION)) resp,
      -- ORS_FEATURES = the suspended-engine guard: raises instead of yielding
      -- zero rows when the region's ORS service is down (see FLEET_APP.CORE).
      LATERAL FLATTEN(input => FLEET_APP.CORE.ORS_FEATURES(resp.RESPONSE)) f
  ),
  zip AS (
    SELECT band_min,
           SUM(POPULATION * frac) AS population,
           SUM(HOUSEHOLDS * frac) AS households,
           ROUND(SUM(MEDIAN_INCOME * HOUSEHOLDS * frac) / NULLIF(SUM(HOUSEHOLDS * frac), 0)) AS median_income
    FROM (
      SELECT i.band_min, z.POPULATION, z.HOUSEHOLDS, z.MEDIAN_INCOME,
             LEAST(1, ST_AREA(ST_INTERSECTION(z.GEOG, i.poly)) / NULLIF(ST_AREA(z.GEOG), 0)) AS frac
      FROM iso i JOIN FLEET_INTELLIGENCE.LOCATION.ZIP_AREAS z
        ON z.REGION = P_REGION AND i.poly IS NOT NULL AND ST_INTERSECTS(z.GEOG, i.poly)
    )
    GROUP BY band_min
  ),
  ven AS (
    SELECT i.band_min, COUNT(*) AS venues
    FROM iso i JOIN FLEET_INTELLIGENCE.CATCHMENT.POIS p
      ON p.REGION = P_REGION AND i.poly IS NOT NULL AND ST_WITHIN(p.GEOMETRY, i.poly)
    GROUP BY i.band_min
  ),
  addr AS (
    SELECT i.band_min, COUNT(*) AS addresses
    FROM iso i JOIN FLEET_INTELLIGENCE.CATCHMENT.REGIONAL_ADDRESSES a
      ON a.REGION = P_REGION AND i.poly IS NOT NULL AND ST_WITHIN(a.GEOMETRY, i.poly)
    GROUP BY i.band_min
  )
  SELECT i.band_min, i.poly AS geo,
         ROUND(ST_AREA(i.poly) / 1e6, 3)::NUMBER(14,3) AS area_sqkm,
         ROUND(COALESCE(zip.population, 0))::INT AS population,
         ROUND(COALESCE(zip.households, 0))::INT AS households,
         COALESCE(zip.median_income, 0)::NUMBER(12,0) AS median_income,
         COALESCE(ven.venues, 0) AS venues,
         COALESCE(addr.addresses, 0) AS addresses
  FROM iso i
  LEFT JOIN zip  ON zip.band_min  = i.band_min
  LEFT JOIN ven  ON ven.band_min  = i.band_min
  LEFT JOIN addr ON addr.band_min = i.band_min
  ORDER BY i.band_min
$$;

-- Venue category breakdown within a single band's drive-time polygon.
DROP FUNCTION IF EXISTS FLEET_APP.CATCHMENT.LIVE_CATCHMENT_CATEGORIES(FLOAT, FLOAT, INT, VARCHAR);
CREATE OR REPLACE FUNCTION FLEET_APP.CATCHMENT.LIVE_CATCHMENT_CATEGORIES(
  P_POI_NAME VARCHAR, P_LON FLOAT, P_LAT FLOAT, P_BAND INT, P_REGION VARCHAR)
RETURNS TABLE (BASIC_CATEGORY VARCHAR, VENUES INT)
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH iso AS (
    SELECT TO_GEOGRAPHY(f.value:geometry) AS poly
    FROM TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES(
      -- Region-resolved, never hardcoded: see FLEET_APP.CORE.VW_REGION_PROFILE.
      COALESCE((SELECT ORS_PROFILE FROM FLEET_APP.CORE.VW_REGION_PROFILE
                 WHERE REGION = P_REGION LIMIT 1), 'driving-car'),
      ARRAY_CONSTRUCT(ARRAY_CONSTRUCT(
        COALESCE((SELECT LONGITUDE FROM FLEET_INTELLIGENCE.CATCHMENT.POIS WHERE REGION=P_REGION AND POI_NAME=P_POI_NAME ORDER BY 1 LIMIT 1), P_LON, (SELECT AVG(LONGITUDE) FROM FLEET_INTELLIGENCE.CATCHMENT.POIS WHERE REGION=P_REGION)),
        COALESCE((SELECT LATITUDE FROM FLEET_INTELLIGENCE.CATCHMENT.POIS WHERE REGION=P_REGION AND POI_NAME=P_POI_NAME ORDER BY 1 LIMIT 1), P_LAT, (SELECT AVG(LATITUDE) FROM FLEET_INTELLIGENCE.CATCHMENT.POIS WHERE REGION=P_REGION)))),
      ARRAY_CONSTRUCT(P_BAND * 60), 'time', P_REGION)) resp,
      -- ORS_FEATURES = the suspended-engine guard: raises instead of yielding
      -- zero rows when the region's ORS service is down (see FLEET_APP.CORE).
      LATERAL FLATTEN(input => FLEET_APP.CORE.ORS_FEATURES(resp.RESPONSE)) f
  )
  SELECT p.BASIC_CATEGORY, COUNT(*) AS venues
  FROM iso i JOIN FLEET_INTELLIGENCE.CATCHMENT.POIS p
    ON p.REGION = P_REGION AND p.BASIC_CATEGORY IS NOT NULL
   AND i.poly IS NOT NULL AND ST_WITHIN(p.GEOMETRY, i.poly)
  GROUP BY p.BASIC_CATEGORY
  ORDER BY venues DESC
$$;

-- Competitor / nearby venues inside a band's drive-time polygon (drive-time, not a
-- straight-line buffer). Same category as the anchor when P_CATEGORY is supplied;
-- all venues when it is NULL (greenfield map-click anchor with no category).
DROP FUNCTION IF EXISTS FLEET_APP.CATCHMENT.LIVE_CATCHMENT_COMPETITORS(FLOAT, FLOAT, INT, VARCHAR, VARCHAR);
CREATE OR REPLACE FUNCTION FLEET_APP.CATCHMENT.LIVE_CATCHMENT_COMPETITORS(
  P_POI_NAME VARCHAR, P_LON FLOAT, P_LAT FLOAT, P_BAND INT, P_REGION VARCHAR, P_CATEGORY VARCHAR)
RETURNS TABLE (POI_NAME VARCHAR, BASIC_CATEGORY VARCHAR, LONGITUDE FLOAT, LATITUDE FLOAT)
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH iso AS (
    SELECT TO_GEOGRAPHY(f.value:geometry) AS poly
    FROM TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES(
      -- Region-resolved, never hardcoded: see FLEET_APP.CORE.VW_REGION_PROFILE.
      COALESCE((SELECT ORS_PROFILE FROM FLEET_APP.CORE.VW_REGION_PROFILE
                 WHERE REGION = P_REGION LIMIT 1), 'driving-car'),
      ARRAY_CONSTRUCT(ARRAY_CONSTRUCT(
        COALESCE((SELECT LONGITUDE FROM FLEET_INTELLIGENCE.CATCHMENT.POIS WHERE REGION=P_REGION AND POI_NAME=P_POI_NAME ORDER BY 1 LIMIT 1), P_LON, (SELECT AVG(LONGITUDE) FROM FLEET_INTELLIGENCE.CATCHMENT.POIS WHERE REGION=P_REGION)),
        COALESCE((SELECT LATITUDE FROM FLEET_INTELLIGENCE.CATCHMENT.POIS WHERE REGION=P_REGION AND POI_NAME=P_POI_NAME ORDER BY 1 LIMIT 1), P_LAT, (SELECT AVG(LATITUDE) FROM FLEET_INTELLIGENCE.CATCHMENT.POIS WHERE REGION=P_REGION)))),
      ARRAY_CONSTRUCT(P_BAND * 60), 'time', P_REGION)) resp,
      -- ORS_FEATURES = the suspended-engine guard: raises instead of yielding
      -- zero rows when the region's ORS service is down (see FLEET_APP.CORE).
      LATERAL FLATTEN(input => FLEET_APP.CORE.ORS_FEATURES(resp.RESPONSE)) f
  )
  SELECT p.POI_NAME, p.BASIC_CATEGORY, p.LONGITUDE, p.LATITUDE
  FROM iso i JOIN FLEET_INTELLIGENCE.CATCHMENT.POIS p
    ON p.REGION = P_REGION AND i.poly IS NOT NULL AND ST_WITHIN(p.GEOMETRY, i.poly)
  WHERE (P_CATEGORY IS NULL OR p.BASIC_CATEGORY = P_CATEGORY)
$$;

-- Grants (owner's-rights UDTFs; consumers only need USAGE).
GRANT USAGE ON FUNCTION FLEET_APP.CATCHMENT.LIVE_CATCHMENT(VARCHAR, FLOAT, FLOAT, ARRAY, VARCHAR) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.CATCHMENT.LIVE_CATCHMENT(VARCHAR, FLOAT, FLOAT, ARRAY, VARCHAR) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.CATCHMENT.LIVE_CATCHMENT(VARCHAR, FLOAT, FLOAT, ARRAY, VARCHAR) TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.CATCHMENT.LIVE_CATCHMENT_CATEGORIES(VARCHAR, FLOAT, FLOAT, INT, VARCHAR) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.CATCHMENT.LIVE_CATCHMENT_CATEGORIES(VARCHAR, FLOAT, FLOAT, INT, VARCHAR) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.CATCHMENT.LIVE_CATCHMENT_CATEGORIES(VARCHAR, FLOAT, FLOAT, INT, VARCHAR) TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.CATCHMENT.LIVE_CATCHMENT_COMPETITORS(VARCHAR, FLOAT, FLOAT, INT, VARCHAR, VARCHAR) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.CATCHMENT.LIVE_CATCHMENT_COMPETITORS(VARCHAR, FLOAT, FLOAT, INT, VARCHAR, VARCHAR) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.CATCHMENT.LIVE_CATCHMENT_COMPETITORS(VARCHAR, FLOAT, FLOAT, INT, VARCHAR, VARCHAR) TO ROLE FLEET_APP_ADMIN;

-- Live sourcing lanes: ONE ORS call computes the full plant x customer road
-- distance/duration matrix (MATRIX_TABULAR: origins = all plant coords ordered
-- by PLANT_ID, destinations = all customer coords ordered by CUSTOMER_ID). The
-- response is a VARIANT with durations[i][j] (seconds) and distances[i][j]
-- (meters); indices align to the ordered plant/customer rows. Freight cost per
-- the customer's truckload = distance_km * rate_per_km + tons * distance_km *
-- rate_per_ton_km. Nothing precomputed (Architecture Tenet 9); region ORS must
-- be RESUMED. Owner's-rights; consumers only need USAGE.
CREATE OR REPLACE FUNCTION FLEET_APP.SOURCING.LIVE_SOURCING_LANES(
  P_REGION VARCHAR, P_PROFILE VARCHAR, P_RATE_PER_KM FLOAT, P_RATE_PER_TON_KM FLOAT)
RETURNS TABLE (PLANT_ID VARCHAR, PLANT_NAME VARCHAR, CUSTOMER_ID VARCHAR, CUSTOMER_NAME VARCHAR,
               DISTANCE_KM NUMBER(14,2), DURATION_MIN NUMBER(14,1), TONS INT,
               FREIGHT_COST NUMBER(18,2), PLANT_GEOG GEOGRAPHY, CUSTOMER_GEOG GEOGRAPHY)
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-freight-sourcing","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH prof AS (
    -- Guard the profile at the boundary where it reaches the engine. A NULL or
    -- empty P_PROFILE (e.g. a map layer that fires before the picker resolves, or
    -- any caller that omits it) reaches ORS as 'unknown' and the engine rejects
    -- the whole matrix. Fall back to the sourcing region's active profile.
    -- Resolved as a CTE column, NOT inlined as a scalar subquery into the ORS
    -- argument: a scalar subquery that itself wraps a view carrying aggregation
    -- reproduces "Unsupported subquery type cannot be evaluated" as a UDTF arg.
    SELECT COALESCE(NULLIF(P_PROFILE, ''),
                    (SELECT ORS_PROFILE FROM FLEET_APP.SOURCING.VW_ACTIVE_PROFILE)) AS PR
  ),
  mtx AS (
    -- ORS_MATRIX = suspended-engine guard (see FLEET_APP.CORE): raises instead of
    -- letting the `distances IS NOT NULL` filter below silently return no lanes.
    SELECT FLEET_APP.CORE.ORS_MATRIX(OPENROUTESERVICE_APP.CORE.MATRIX_TABULAR(
      prof.PR,
      (SELECT ARRAY_AGG(ARRAY_CONSTRUCT(LON, LAT)) WITHIN GROUP (ORDER BY PLANT_ID)
         FROM FLEET_INTELLIGENCE.SOURCING.PLANTS WHERE REGION = P_REGION),
      (SELECT ARRAY_AGG(ARRAY_CONSTRUCT(LON, LAT)) WITHIN GROUP (ORDER BY CUSTOMER_ID)
         FROM FLEET_INTELLIGENCE.SOURCING.CUSTOMERS WHERE REGION = P_REGION),
      P_REGION)) AS m
    FROM prof
  ),
  p AS (
    SELECT PLANT_ID, PLANT_NAME, GEOG, ROW_NUMBER() OVER (ORDER BY PLANT_ID) - 1 AS pi
    FROM FLEET_INTELLIGENCE.SOURCING.PLANTS WHERE REGION = P_REGION
  ),
  c AS (
    SELECT CUSTOMER_ID, CUSTOMER_NAME, GEOG, ROW_NUMBER() OVER (ORDER BY CUSTOMER_ID) - 1 AS ci
    FROM FLEET_INTELLIGENCE.SOURCING.CUSTOMERS WHERE REGION = P_REGION
  ),
  d AS (
    SELECT CUSTOMER_ID, TONS_PER_LOAD
    FROM FLEET_INTELLIGENCE.SOURCING.CUSTOMER_DEMAND WHERE REGION = P_REGION
  )
  SELECT p.PLANT_ID, p.PLANT_NAME, c.CUSTOMER_ID, c.CUSTOMER_NAME,
         ROUND((mtx.m:distances[p.pi][c.ci]::FLOAT) / 1000.0, 2)::NUMBER(14,2) AS distance_km,
         ROUND((mtx.m:durations[p.pi][c.ci]::FLOAT) / 60.0, 1)::NUMBER(14,1) AS duration_min,
         COALESCE(d.TONS_PER_LOAD, 22) AS tons,
         ROUND((mtx.m:distances[p.pi][c.ci]::FLOAT) / 1000.0 * P_RATE_PER_KM
               + COALESCE(d.TONS_PER_LOAD, 22) * (mtx.m:distances[p.pi][c.ci]::FLOAT) / 1000.0 * P_RATE_PER_TON_KM
              )::NUMBER(18,2) AS freight_cost,
         p.GEOG AS plant_geog, c.GEOG AS customer_geog
  FROM mtx, p CROSS JOIN c
  LEFT JOIN d ON d.CUSTOMER_ID = c.CUSTOMER_ID
  WHERE mtx.m:distances[p.pi][c.ci] IS NOT NULL
$$;

-- Live location swap: for each customer, restrict lanes to product-capable
-- plants, pick the cheapest, compare to the data-only current source, and
-- annualize the per-load saving by ANNUAL_TRUCKLOADS. Builds on the single
-- MATRIX_TABULAR call inside LIVE_SOURCING_LANES. P_PRODUCT_FILTER is optional
-- (NULL = all products). Owner's-rights; consumers only need USAGE.
CREATE OR REPLACE FUNCTION FLEET_APP.SOURCING.LIVE_LOCATION_SWAP(
  P_REGION VARCHAR, P_PROFILE VARCHAR, P_RATE_PER_KM FLOAT, P_RATE_PER_TON_KM FLOAT,
  P_PRODUCT_FILTER VARCHAR)
RETURNS TABLE (CUSTOMER_ID VARCHAR, CUSTOMER_NAME VARCHAR, PRODUCT VARCHAR, ANNUAL_TRUCKLOADS INT,
               CURRENT_PLANT VARCHAR, CURRENT_COST_PER_LOAD NUMBER(18,2),
               BEST_PLANT VARCHAR, BEST_COST_PER_LOAD NUMBER(18,2),
               SAVINGS_PER_LOAD NUMBER(18,2), ANNUAL_SAVINGS NUMBER(18,0),
               CURRENT_PLANT_GEOG GEOGRAPHY, BEST_PLANT_GEOG GEOGRAPHY, CUSTOMER_GEOG GEOGRAPHY)
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-freight-sourcing","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH lanes AS (
    SELECT * FROM TABLE(FLEET_APP.SOURCING.LIVE_SOURCING_LANES(P_REGION, P_PROFILE, P_RATE_PER_KM, P_RATE_PER_TON_KM))
  ),
  dem AS (
    SELECT CUSTOMER_ID, PRODUCT, ANNUAL_TRUCKLOADS, CURRENT_PLANT_ID
    FROM FLEET_INTELLIGENCE.SOURCING.CUSTOMER_DEMAND
    WHERE REGION = P_REGION
      AND (P_PRODUCT_FILTER IS NULL OR PRODUCT = P_PRODUCT_FILTER)
  ),
  capable AS (
    SELECT l.PLANT_ID, l.PLANT_NAME, l.CUSTOMER_ID, l.CUSTOMER_NAME, l.FREIGHT_COST,
           l.PLANT_GEOG, l.CUSTOMER_GEOG,
           d.PRODUCT, d.ANNUAL_TRUCKLOADS, d.CURRENT_PLANT_ID
    FROM lanes l
    JOIN dem d ON d.CUSTOMER_ID = l.CUSTOMER_ID
    JOIN FLEET_INTELLIGENCE.SOURCING.PLANT_FACTS pf
      ON pf.REGION = P_REGION AND pf.PLANT_ID = l.PLANT_ID
     AND ARRAY_CONTAINS(d.PRODUCT::VARIANT, pf.PRODUCT_CAPABILITY)
  ),
  best AS (
    -- Pick the cheapest capable plant as ONE atomic row (name + geog + cost from
    -- the same winning row), deterministic on a cost tie via PLANT_ID.
    SELECT CUSTOMER_ID, PLANT_NAME AS best_plant, PLANT_GEOG AS best_plant_geog,
           FREIGHT_COST AS best_cost
    FROM capable
    QUALIFY ROW_NUMBER() OVER (PARTITION BY CUSTOMER_ID ORDER BY FREIGHT_COST, PLANT_ID) = 1
  ),
  cur AS (
    SELECT CUSTOMER_ID, CUSTOMER_NAME, PRODUCT, ANNUAL_TRUCKLOADS,
           PLANT_NAME AS current_plant, FREIGHT_COST AS current_cost,
           CUSTOMER_GEOG, PLANT_GEOG AS current_plant_geog
    FROM capable
    WHERE PLANT_ID = CURRENT_PLANT_ID
  )
  SELECT cur.CUSTOMER_ID, cur.CUSTOMER_NAME, cur.PRODUCT, cur.ANNUAL_TRUCKLOADS,
         cur.current_plant, ROUND(cur.current_cost, 2)::NUMBER(18,2) AS current_cost_per_load,
         b.best_plant, ROUND(b.best_cost, 2)::NUMBER(18,2) AS best_cost_per_load,
         ROUND(cur.current_cost - b.best_cost, 2)::NUMBER(18,2) AS savings_per_load,
         ROUND((cur.current_cost - b.best_cost) * cur.ANNUAL_TRUCKLOADS, 0)::NUMBER(18,0) AS annual_savings,
         cur.current_plant_geog, b.best_plant_geog, cur.CUSTOMER_GEOG
  FROM cur JOIN best b ON b.CUSTOMER_ID = cur.CUSTOMER_ID
  ORDER BY annual_savings DESC
$$;

-- Live plant-to-plant road matrix (ONE MATRIX_TABULAR call, plants as both
-- origins and destinations). Used for the inter-plant transfer legs. Diagonal
-- (plant to itself) is 0. Same VARIANT distances[i][j] indexing + ARRAY_AGG
-- ordering alignment as LIVE_SOURCING_LANES. Nothing precomputed (Tenet 9).
CREATE OR REPLACE FUNCTION FLEET_APP.SOURCING.LIVE_PLANT_MATRIX(
  P_REGION VARCHAR, P_PROFILE VARCHAR)
RETURNS TABLE (FROM_PLANT_ID VARCHAR, FROM_PLANT VARCHAR, TO_PLANT_ID VARCHAR, TO_PLANT VARCHAR,
               DISTANCE_KM NUMBER(14,2), DURATION_MIN NUMBER(14,1),
               FROM_GEOG GEOGRAPHY, TO_GEOG GEOGRAPHY)
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-freight-sourcing","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH prof AS (
    -- Profile guard - see LIVE_SOURCING_LANES for the rationale. NULL/'' -> the
    -- sourcing region's active profile, resolved as a column not a nested subquery.
    SELECT COALESCE(NULLIF(P_PROFILE, ''),
                    (SELECT ORS_PROFILE FROM FLEET_APP.SOURCING.VW_ACTIVE_PROFILE)) AS PR
  ),
  mtx AS (
    -- ORS_MATRIX = suspended-engine guard (see FLEET_APP.CORE).
    SELECT FLEET_APP.CORE.ORS_MATRIX(OPENROUTESERVICE_APP.CORE.MATRIX_TABULAR(
      prof.PR,
      (SELECT ARRAY_AGG(ARRAY_CONSTRUCT(LON, LAT)) WITHIN GROUP (ORDER BY PLANT_ID)
         FROM FLEET_INTELLIGENCE.SOURCING.PLANTS WHERE REGION = P_REGION),
      (SELECT ARRAY_AGG(ARRAY_CONSTRUCT(LON, LAT)) WITHIN GROUP (ORDER BY PLANT_ID)
         FROM FLEET_INTELLIGENCE.SOURCING.PLANTS WHERE REGION = P_REGION),
      P_REGION)) AS m
    FROM prof
  ),
  a AS (
    SELECT PLANT_ID, PLANT_NAME, GEOG, ROW_NUMBER() OVER (ORDER BY PLANT_ID) - 1 AS ai
    FROM FLEET_INTELLIGENCE.SOURCING.PLANTS WHERE REGION = P_REGION
  ),
  b AS (
    SELECT PLANT_ID, PLANT_NAME, GEOG, ROW_NUMBER() OVER (ORDER BY PLANT_ID) - 1 AS bi
    FROM FLEET_INTELLIGENCE.SOURCING.PLANTS WHERE REGION = P_REGION
  )
  SELECT a.PLANT_ID, a.PLANT_NAME, b.PLANT_ID, b.PLANT_NAME,
         ROUND((mtx.m:distances[a.ai][b.bi]::FLOAT) / 1000.0, 2)::NUMBER(14,2) AS distance_km,
         ROUND((mtx.m:durations[a.ai][b.bi]::FLOAT) / 60.0, 1)::NUMBER(14,1) AS duration_min,
         a.GEOG, b.GEOG
  FROM mtx, a CROSS JOIN b
  WHERE mtx.m:distances[a.ai][b.bi] IS NOT NULL
$$;

-- Live product-mix tradeoff per customer order (basket of product lines):
--   Option B (SHIP DIRECT): each line from its cheapest capable plant direct to
--     the customer -> cost_multi_plant = sum over lines of min direct freight.
--   Option A (CONSOLIDATE): pick a hub plant, transfer the products the hub
--     cannot make in from the nearest capable plant (+ handling per ton), then
--     ship ONE consolidated load hub->customer. cost_consolidated = min over
--     hubs of (transfer_in + outbound). Because transfer cost is monotonic in
--     road distance, the cheapest transfer source = the nearest capable plant,
--     and a hub that itself makes the product appears as a distance-0 source
--     (so no transfer / no handling for that line).
-- freight(a,b,tons) = dist_km*rate_per_km + tons*dist_km*rate_per_ton_km.
-- Uses LIVE_SOURCING_LANES (plant->customer distances) + LIVE_PLANT_MATRIX
-- (plant->plant distances); two live ORS calls, nothing precomputed. Customers
-- whose order cannot be fully covered (an unreachable required leg) are dropped.
-- P_CUSTOMER_ID optional (NULL = all customers).
CREATE OR REPLACE FUNCTION FLEET_APP.SOURCING.LIVE_MIX_TRADEOFF(
  P_REGION VARCHAR, P_PROFILE VARCHAR, P_RATE_PER_KM FLOAT, P_RATE_PER_TON_KM FLOAT,
  P_HANDLING_PER_TON FLOAT, P_CUSTOMER_ID VARCHAR)
RETURNS TABLE (CUSTOMER_ID VARCHAR, CUSTOMER_NAME VARCHAR, PRODUCT_LINES INT, TOTAL_TONS INT,
               COST_MULTI_PLANT NUMBER(18,2), COST_CONSOLIDATED NUMBER(18,2), BEST_HUB VARCHAR,
               HANDLING_COST NUMBER(18,2), SAVINGS NUMBER(18,2), RECOMMENDATION VARCHAR,
               CUSTOMER_GEOG GEOGRAPHY, BEST_HUB_GEOG GEOGRAPHY)
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-freight-sourcing","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH pc AS (
    SELECT PLANT_ID, CUSTOMER_ID, DISTANCE_KM
    FROM TABLE(FLEET_APP.SOURCING.LIVE_SOURCING_LANES(P_REGION, P_PROFILE, P_RATE_PER_KM, P_RATE_PER_TON_KM))
  ),
  pp AS (
    SELECT FROM_PLANT_ID, TO_PLANT_ID, DISTANCE_KM
    FROM TABLE(FLEET_APP.SOURCING.LIVE_PLANT_MATRIX(P_REGION, P_PROFILE))
  ),
  orders AS (
    SELECT CUSTOMER_ID, PRODUCT, TONS
    FROM FLEET_INTELLIGENCE.SOURCING.ORDER_MIX
    WHERE REGION = P_REGION AND (P_CUSTOMER_ID IS NULL OR CUSTOMER_ID = P_CUSTOMER_ID)
  ),
  plant_products AS (
    SELECT pf.PLANT_ID, f.value::VARCHAR AS PRODUCT
    FROM FLEET_INTELLIGENCE.SOURCING.PLANT_FACTS pf,
         LATERAL FLATTEN(input => pf.PRODUCT_CAPABILITY) f
    WHERE pf.REGION = P_REGION
  ),
  lines AS (SELECT CUSTOMER_ID, COUNT(*) AS product_lines FROM orders GROUP BY CUSTOMER_ID),
  ct AS (SELECT CUSTOMER_ID, SUM(TONS) AS total_tons FROM orders GROUP BY CUSTOMER_ID),
  custname AS (SELECT CUSTOMER_ID, CUSTOMER_NAME, GEOG FROM FLEET_INTELLIGENCE.SOURCING.CUSTOMERS WHERE REGION = P_REGION),
  hubs AS (SELECT PLANT_ID, PLANT_NAME, GEOG FROM FLEET_INTELLIGENCE.SOURCING.PLANTS WHERE REGION = P_REGION),
  -- per (hub, product): min road distance from a capable source plant (0 when the hub itself makes it)
  transfer_basis AS (
    SELECT pp.TO_PLANT_ID AS hub_id, cpp.PRODUCT, MIN(pp.DISTANCE_KM) AS min_dist
    FROM pp JOIN plant_products cpp ON cpp.PLANT_ID = pp.FROM_PLANT_ID
    GROUP BY pp.TO_PLANT_ID, cpp.PRODUCT
  ),
  transfer_line AS (
    SELECT o.CUSTOMER_ID, tb.hub_id, o.PRODUCT, o.TONS, tb.min_dist,
           CASE WHEN tb.min_dist > 0
                THEN tb.min_dist * P_RATE_PER_KM + o.TONS * tb.min_dist * P_RATE_PER_TON_KM + P_HANDLING_PER_TON * o.TONS
                ELSE 0 END AS line_transfer_cost
    FROM orders o
    JOIN transfer_basis tb ON tb.PRODUCT = o.PRODUCT
  ),
  transfer_in AS (
    SELECT CUSTOMER_ID, hub_id,
           SUM(line_transfer_cost) AS transfer_cost,
           SUM(CASE WHEN min_dist > 0 THEN P_HANDLING_PER_TON * TONS ELSE 0 END) AS handling_cost,
           COUNT(*) AS covered_lines
    FROM transfer_line GROUP BY CUSTOMER_ID, hub_id
  ),
  optionA AS (
    SELECT ti.CUSTOMER_ID, ti.hub_id, ti.handling_cost,
           ti.transfer_cost + (pc.DISTANCE_KM * P_RATE_PER_KM + ct.total_tons * pc.DISTANCE_KM * P_RATE_PER_TON_KM) AS cost_a
    FROM transfer_in ti
    JOIN ct ON ct.CUSTOMER_ID = ti.CUSTOMER_ID
    JOIN lines ln ON ln.CUSTOMER_ID = ti.CUSTOMER_ID AND ti.covered_lines = ln.product_lines
    JOIN pc ON pc.PLANT_ID = ti.hub_id AND pc.CUSTOMER_ID = ti.CUSTOMER_ID
  ),
  bestA AS (
    SELECT CUSTOMER_ID, hub_id AS best_hub_id, cost_a AS cost_consolidated, handling_cost
    FROM optionA
    QUALIFY ROW_NUMBER() OVER (PARTITION BY CUSTOMER_ID ORDER BY cost_a, hub_id) = 1
  ),
  lineB AS (
    SELECT o.CUSTOMER_ID, o.PRODUCT, o.TONS,
           MIN(pc.DISTANCE_KM * P_RATE_PER_KM + o.TONS * pc.DISTANCE_KM * P_RATE_PER_TON_KM) AS line_direct_cost
    FROM orders o
    JOIN plant_products cpp ON cpp.PRODUCT = o.PRODUCT
    JOIN pc ON pc.PLANT_ID = cpp.PLANT_ID AND pc.CUSTOMER_ID = o.CUSTOMER_ID
    GROUP BY o.CUSTOMER_ID, o.PRODUCT, o.TONS
  ),
  costB AS (
    SELECT CUSTOMER_ID, SUM(line_direct_cost) AS cost_multi, COUNT(*) AS covered_lines
    FROM lineB GROUP BY CUSTOMER_ID
  ),
  -- Feasible direct plan = every line has a direct lane (covers the whole basket).
  costB_ok AS (
    SELECT cb.CUSTOMER_ID, cb.cost_multi
    FROM costB cb JOIN lines ln ON ln.CUSTOMER_ID = cb.CUSTOMER_ID
    WHERE cb.covered_lines = ln.product_lines
  ),
  -- Customer spine: keep a customer if EITHER plan is feasible (bestA already
  -- requires a fully-covering hub; costB_ok requires a full direct plan). This
  -- surfaces consolidation-only and direct-only customers instead of dropping
  -- them (they show a NULL cost on the infeasible side).
  spine AS (
    SELECT CUSTOMER_ID FROM bestA
    UNION
    SELECT CUSTOMER_ID FROM costB_ok
  )
  SELECT cn.CUSTOMER_ID, cn.CUSTOMER_NAME, ln.product_lines, ct.total_tons,
         ROUND(cb.cost_multi, 2)::NUMBER(18,2) AS cost_multi_plant,
         ROUND(ba.cost_consolidated, 2)::NUMBER(18,2) AS cost_consolidated,
         hb.PLANT_NAME AS best_hub,
         ROUND(ba.handling_cost, 2)::NUMBER(18,2) AS handling_cost,
         ROUND(cb.cost_multi - ba.cost_consolidated, 2)::NUMBER(18,2) AS savings,
         CASE
           WHEN ba.CUSTOMER_ID IS NULL THEN 'SHIP DIRECT'
           WHEN cb.CUSTOMER_ID IS NULL THEN 'CONSOLIDATE'
           WHEN cb.cost_multi - ba.cost_consolidated > 0 THEN 'CONSOLIDATE'
           ELSE 'SHIP DIRECT'
         END AS recommendation,
         cn.GEOG AS customer_geog, hb.GEOG AS best_hub_geog
  FROM spine s
  JOIN custname cn ON cn.CUSTOMER_ID = s.CUSTOMER_ID
  JOIN lines ln ON ln.CUSTOMER_ID = s.CUSTOMER_ID
  JOIN ct ON ct.CUSTOMER_ID = s.CUSTOMER_ID
  LEFT JOIN bestA ba ON ba.CUSTOMER_ID = s.CUSTOMER_ID
  LEFT JOIN costB_ok cb ON cb.CUSTOMER_ID = s.CUSTOMER_ID
  LEFT JOIN hubs hb ON hb.PLANT_ID = ba.best_hub_id
  ORDER BY savings DESC NULLS LAST
$$;

-- Live flow legs for ONE customer's order, for the map: the CONSOLIDATE plan
-- (transfer-in legs from the nearest capable source into the best hub, plus the
-- consolidated outbound leg hub->customer) and the SHIP DIRECT plan (each line
-- from its nearest capable plant direct to the customer). LEG_KIND in
-- ('TRANSFER','OUTBOUND','DIRECT'). Recomputes the best hub the same way as
-- LIVE_MIX_TRADEOFF. Two live ORS calls; region ORS must be RESUMED.
CREATE OR REPLACE FUNCTION FLEET_APP.SOURCING.LIVE_MIX_FLOWS(
  P_REGION VARCHAR, P_PROFILE VARCHAR, P_RATE_PER_KM FLOAT, P_RATE_PER_TON_KM FLOAT,
  P_HANDLING_PER_TON FLOAT, P_CUSTOMER_ID VARCHAR)
RETURNS TABLE (LEG_KIND VARCHAR, PRODUCT VARCHAR, TONS INT,
               FROM_LON FLOAT, FROM_LAT FLOAT, TO_LON FLOAT, TO_LAT FLOAT)
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-freight-sourcing","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH pc AS (
    SELECT PLANT_ID, CUSTOMER_ID, DISTANCE_KM
    FROM TABLE(FLEET_APP.SOURCING.LIVE_SOURCING_LANES(P_REGION, P_PROFILE, P_RATE_PER_KM, P_RATE_PER_TON_KM))
    WHERE CUSTOMER_ID = P_CUSTOMER_ID
  ),
  pp AS (
    SELECT FROM_PLANT_ID, TO_PLANT_ID, DISTANCE_KM
    FROM TABLE(FLEET_APP.SOURCING.LIVE_PLANT_MATRIX(P_REGION, P_PROFILE))
  ),
  orders AS (
    SELECT PRODUCT, TONS FROM FLEET_INTELLIGENCE.SOURCING.ORDER_MIX
    WHERE REGION = P_REGION AND CUSTOMER_ID = P_CUSTOMER_ID
  ),
  plant_products AS (
    SELECT pf.PLANT_ID, f.value::VARCHAR AS PRODUCT
    FROM FLEET_INTELLIGENCE.SOURCING.PLANT_FACTS pf,
         LATERAL FLATTEN(input => pf.PRODUCT_CAPABILITY) f
    WHERE pf.REGION = P_REGION
  ),
  total AS (SELECT SUM(TONS) AS tt, COUNT(*) AS nlines FROM orders),
  custrow AS (SELECT GEOG FROM FLEET_INTELLIGENCE.SOURCING.CUSTOMERS WHERE REGION = P_REGION AND CUSTOMER_ID = P_CUSTOMER_ID),
  plants AS (SELECT PLANT_ID, GEOG FROM FLEET_INTELLIGENCE.SOURCING.PLANTS WHERE REGION = P_REGION),
  -- recompute the best hub (mirror of LIVE_MIX_TRADEOFF option A)
  transfer_basis AS (
    SELECT pp.TO_PLANT_ID AS hub_id, cpp.PRODUCT, MIN(pp.DISTANCE_KM) AS min_dist
    FROM pp JOIN plant_products cpp ON cpp.PLANT_ID = pp.FROM_PLANT_ID
    GROUP BY pp.TO_PLANT_ID, cpp.PRODUCT
  ),
  transfer_line AS (
    SELECT tb.hub_id, o.PRODUCT, o.TONS, tb.min_dist,
           CASE WHEN tb.min_dist > 0
                THEN tb.min_dist * P_RATE_PER_KM + o.TONS * tb.min_dist * P_RATE_PER_TON_KM + P_HANDLING_PER_TON * o.TONS
                ELSE 0 END AS line_transfer_cost
    FROM orders o JOIN transfer_basis tb ON tb.PRODUCT = o.PRODUCT
  ),
  optionA AS (
    SELECT tl.hub_id,
           SUM(tl.line_transfer_cost) + (pc.DISTANCE_KM * P_RATE_PER_KM + total.tt * pc.DISTANCE_KM * P_RATE_PER_TON_KM) AS cost_a
    FROM transfer_line tl
    JOIN pc ON pc.PLANT_ID = tl.hub_id
    CROSS JOIN total
    GROUP BY tl.hub_id, pc.DISTANCE_KM, total.tt
    HAVING COUNT(*) = (SELECT nlines FROM total)
  ),
  best AS (
    SELECT hub_id FROM optionA QUALIFY ROW_NUMBER() OVER (ORDER BY cost_a, hub_id) = 1
  ),
  -- nearest capable source plant for each product into the best hub
  src AS (
    SELECT o.PRODUCT, o.TONS, b.hub_id, pp.FROM_PLANT_ID AS src_id, pp.DISTANCE_KM AS d
    FROM orders o
    CROSS JOIN best b
    JOIN plant_products cpp ON cpp.PRODUCT = o.PRODUCT
    JOIN pp ON pp.FROM_PLANT_ID = cpp.PLANT_ID AND pp.TO_PLANT_ID = b.hub_id
    QUALIFY ROW_NUMBER() OVER (PARTITION BY o.PRODUCT ORDER BY pp.DISTANCE_KM, pp.FROM_PLANT_ID) = 1
  ),
  -- nearest capable plant direct to the customer for each product
  direct AS (
    SELECT o.PRODUCT, o.TONS, cpp.PLANT_ID AS src_id
    FROM orders o
    JOIN plant_products cpp ON cpp.PRODUCT = o.PRODUCT
    JOIN pc ON pc.PLANT_ID = cpp.PLANT_ID
    QUALIFY ROW_NUMBER() OVER (PARTITION BY o.PRODUCT ORDER BY pc.DISTANCE_KM, cpp.PLANT_ID) = 1
  )
  SELECT 'TRANSFER' AS leg_kind, src.PRODUCT, src.TONS,
         ST_X(sp.GEOG) AS from_lon, ST_Y(sp.GEOG) AS from_lat,
         ST_X(hp.GEOG) AS to_lon, ST_Y(hp.GEOG) AS to_lat
  FROM src
  JOIN plants sp ON sp.PLANT_ID = src.src_id
  JOIN plants hp ON hp.PLANT_ID = src.hub_id
  WHERE src.d > 0
  UNION ALL
  SELECT 'OUTBOUND', NULL, (SELECT tt FROM total),
         ST_X(hp.GEOG), ST_Y(hp.GEOG), ST_X(cu.GEOG), ST_Y(cu.GEOG)
  FROM best b JOIN plants hp ON hp.PLANT_ID = b.hub_id CROSS JOIN custrow cu
  UNION ALL
  SELECT 'DIRECT', d.PRODUCT, d.TONS,
         ST_X(sp.GEOG), ST_Y(sp.GEOG), ST_X(cu.GEOG), ST_Y(cu.GEOG)
  FROM direct d JOIN plants sp ON sp.PLANT_ID = d.src_id CROSS JOIN custrow cu
$$;

-- Proposed + selected swap lanes as road paths. When P_ONLY_CUSTOMER IS NULL,
-- returns the road path best_plant->customer for every savings lane (the green
-- "proposed" layer, only a handful). When P_ONLY_CUSTOMER is set, returns just
-- that customer's best-plant road path regardless of savings (the focused
-- "selected" layer, so a no-change customer still road-routes). GEOJSON is the
-- parsed route geometry from DIRECTIONS; DISTANCE is meters, DURATION seconds.
CREATE OR REPLACE FUNCTION FLEET_APP.SOURCING.LIVE_SWAP_ROUTES(
  P_REGION VARCHAR, P_PROFILE VARCHAR, P_RATE_PER_KM FLOAT, P_RATE_PER_TON_KM FLOAT,
  P_PRODUCT_FILTER VARCHAR, P_ONLY_CUSTOMER VARCHAR)
RETURNS TABLE (CUSTOMER_ID VARCHAR, SAVINGS_PER_LOAD NUMBER(18,2),
               ROAD_KM NUMBER(14,2), ROAD_MIN NUMBER(14,1), ROUTE_GEOJSON VARCHAR)
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-freight-sourcing","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH reg AS (
    SELECT COALESCE(P_REGION, (SELECT MAX(REGION) FROM FLEET_INTELLIGENCE.SOURCING.PLANTS)) AS r
  ),
  prof AS (
    -- Profile guard - see LIVE_SOURCING_LANES. NULL/'' -> the sourcing region's
    -- active profile, so the DIRECTIONS leg below never reaches ORS as 'unknown'.
    SELECT COALESCE(NULLIF(P_PROFILE, ''),
                    (SELECT ORS_PROFILE FROM FLEET_APP.SOURCING.VW_ACTIVE_PROFILE)) AS PR
  ),
  swap AS (
    SELECT CUSTOMER_ID, SAVINGS_PER_LOAD, BEST_PLANT_GEOG, CUSTOMER_GEOG
    FROM reg, TABLE(FLEET_APP.SOURCING.LIVE_LOCATION_SWAP(
                 reg.r, P_PROFILE, P_RATE_PER_KM, P_RATE_PER_TON_KM, P_PRODUCT_FILTER))
    WHERE BEST_PLANT_GEOG IS NOT NULL AND CUSTOMER_GEOG IS NOT NULL
      AND ( (P_ONLY_CUSTOMER IS NULL AND SAVINGS_PER_LOAD > 0)
            OR (P_ONLY_CUSTOMER IS NOT NULL AND CUSTOMER_ID = P_ONLY_CUSTOMER) )
  )
  SELECT s.CUSTOMER_ID, s.SAVINGS_PER_LOAD,
         ROUND(d.DISTANCE / 1000.0, 2)::NUMBER(14,2) AS road_km,
         ROUND(d.DURATION / 60.0, 1)::NUMBER(14,1) AS road_min,
         ST_ASGEOJSON(d.GEOJSON)::VARCHAR AS route_geojson
  FROM swap s, reg, prof,
       TABLE(OPENROUTESERVICE_APP.CORE.DIRECTIONS(
               prof.PR,
               ARRAY_CONSTRUCT(ST_X(s.BEST_PLANT_GEOG), ST_Y(s.BEST_PLANT_GEOG)),
               ARRAY_CONSTRUCT(ST_X(s.CUSTOMER_GEOG), ST_Y(s.CUSTOMER_GEOG)),
               reg.r)) d
$$;

-- Product-mix flow legs as road paths for the selected customer's order. Wraps
-- LIVE_MIX_FLOWS and road-routes each TRANSFER/OUTBOUND/DIRECT leg. Skips
-- zero-length legs (a hub that makes the product is a distance-0 self leg).
CREATE OR REPLACE FUNCTION FLEET_APP.SOURCING.LIVE_MIX_FLOW_ROUTES(
  P_REGION VARCHAR, P_PROFILE VARCHAR, P_RATE_PER_KM FLOAT, P_RATE_PER_TON_KM FLOAT,
  P_HANDLING_PER_TON FLOAT, P_CUSTOMER_ID VARCHAR)
RETURNS TABLE (LEG_KIND VARCHAR, PRODUCT VARCHAR, TONS INT,
               ROAD_KM NUMBER(14,2), ROAD_MIN NUMBER(14,1), ROUTE_GEOJSON VARCHAR)
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-freight-sourcing","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH reg AS (
    SELECT COALESCE(P_REGION, (SELECT MAX(REGION) FROM FLEET_INTELLIGENCE.SOURCING.PLANTS)) AS r
  ),
  prof AS (
    -- Profile guard - see LIVE_SOURCING_LANES. NULL/'' -> the sourcing region's
    -- active profile, so the DIRECTIONS leg below never reaches ORS as 'unknown'.
    SELECT COALESCE(NULLIF(P_PROFILE, ''),
                    (SELECT ORS_PROFILE FROM FLEET_APP.SOURCING.VW_ACTIVE_PROFILE)) AS PR
  ),
  flows AS (
    SELECT LEG_KIND, PRODUCT, TONS, FROM_LON, FROM_LAT, TO_LON, TO_LAT
    FROM reg, TABLE(FLEET_APP.SOURCING.LIVE_MIX_FLOWS(
                 reg.r, P_PROFILE, P_RATE_PER_KM, P_RATE_PER_TON_KM,
                 P_HANDLING_PER_TON, P_CUSTOMER_ID))
    WHERE FROM_LON IS NOT NULL AND FROM_LAT IS NOT NULL
      AND TO_LON IS NOT NULL AND TO_LAT IS NOT NULL
      AND NOT (FROM_LON = TO_LON AND FROM_LAT = TO_LAT)
  )
  SELECT f.LEG_KIND, f.PRODUCT, f.TONS,
         ROUND(d.DISTANCE / 1000.0, 2)::NUMBER(14,2) AS road_km,
         ROUND(d.DURATION / 60.0, 1)::NUMBER(14,1) AS road_min,
         ST_ASGEOJSON(d.GEOJSON)::VARCHAR AS route_geojson
  FROM flows f, reg, prof,
       TABLE(OPENROUTESERVICE_APP.CORE.DIRECTIONS(
               prof.PR,
               ARRAY_CONSTRUCT(f.FROM_LON, f.FROM_LAT),
               ARRAY_CONSTRUCT(f.TO_LON, f.TO_LAT),
               reg.r)) d
$$;

-- Current-source lanes as road paths for EVERY customer (not just savings lanes).
-- Wraps LIVE_LOCATION_SWAP and road-routes CURRENT_PLANT_GEOG -> CUSTOMER_GEOG so
-- the map draws road-following current lanes instead of straight arcs. Region is
-- resolved internally so callers pass a literal NULL (avoids the scalar-subquery
-- optimizer error when a subquery arg meets a lateral DIRECTIONS join).
CREATE OR REPLACE FUNCTION FLEET_APP.SOURCING.LIVE_CURRENT_ROUTES(
  P_REGION VARCHAR, P_PROFILE VARCHAR, P_RATE_PER_KM FLOAT, P_RATE_PER_TON_KM FLOAT,
  P_PRODUCT_FILTER VARCHAR)
RETURNS TABLE (CUSTOMER_ID VARCHAR, ROAD_KM NUMBER(14,2), ROAD_MIN NUMBER(14,1), ROUTE_GEOJSON VARCHAR)
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-freight-sourcing","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  WITH reg AS (
    SELECT COALESCE(P_REGION, (SELECT MAX(REGION) FROM FLEET_INTELLIGENCE.SOURCING.PLANTS)) AS r
  ),
  prof AS (
    -- Profile guard - see LIVE_SOURCING_LANES. NULL/'' -> the sourcing region's
    -- active profile, so the DIRECTIONS leg below never reaches ORS as 'unknown'.
    SELECT COALESCE(NULLIF(P_PROFILE, ''),
                    (SELECT ORS_PROFILE FROM FLEET_APP.SOURCING.VW_ACTIVE_PROFILE)) AS PR
  ),
  cur AS (
    SELECT CUSTOMER_ID, CURRENT_PLANT_GEOG, CUSTOMER_GEOG
    FROM reg, TABLE(FLEET_APP.SOURCING.LIVE_LOCATION_SWAP(
                 reg.r, P_PROFILE, P_RATE_PER_KM, P_RATE_PER_TON_KM, P_PRODUCT_FILTER))
    WHERE CURRENT_PLANT_GEOG IS NOT NULL AND CUSTOMER_GEOG IS NOT NULL
      AND NOT (ST_X(CURRENT_PLANT_GEOG) = ST_X(CUSTOMER_GEOG)
               AND ST_Y(CURRENT_PLANT_GEOG) = ST_Y(CUSTOMER_GEOG))
  )
  SELECT c.CUSTOMER_ID,
         ROUND(d.DISTANCE / 1000.0, 2)::NUMBER(14,2) AS road_km,
         ROUND(d.DURATION / 60.0, 1)::NUMBER(14,1) AS road_min,
         ST_ASGEOJSON(d.GEOJSON)::VARCHAR AS route_geojson
  FROM cur c, reg, prof,
       TABLE(OPENROUTESERVICE_APP.CORE.DIRECTIONS(
               prof.PR,
               ARRAY_CONSTRUCT(ST_X(c.CURRENT_PLANT_GEOG), ST_Y(c.CURRENT_PLANT_GEOG)),
               ARRAY_CONSTRUCT(ST_X(c.CUSTOMER_GEOG), ST_Y(c.CUSTOMER_GEOG)),
               reg.r)) d
$$;

GRANT USAGE ON FUNCTION FLEET_APP.SOURCING.LIVE_SOURCING_LANES(VARCHAR, VARCHAR, FLOAT, FLOAT) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.SOURCING.LIVE_SOURCING_LANES(VARCHAR, VARCHAR, FLOAT, FLOAT) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.SOURCING.LIVE_SOURCING_LANES(VARCHAR, VARCHAR, FLOAT, FLOAT) TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.SOURCING.LIVE_LOCATION_SWAP(VARCHAR, VARCHAR, FLOAT, FLOAT, VARCHAR) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.SOURCING.LIVE_LOCATION_SWAP(VARCHAR, VARCHAR, FLOAT, FLOAT, VARCHAR) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.SOURCING.LIVE_LOCATION_SWAP(VARCHAR, VARCHAR, FLOAT, FLOAT, VARCHAR) TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.SOURCING.LIVE_PLANT_MATRIX(VARCHAR, VARCHAR) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.SOURCING.LIVE_PLANT_MATRIX(VARCHAR, VARCHAR) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.SOURCING.LIVE_PLANT_MATRIX(VARCHAR, VARCHAR) TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.SOURCING.LIVE_MIX_TRADEOFF(VARCHAR, VARCHAR, FLOAT, FLOAT, FLOAT, VARCHAR) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.SOURCING.LIVE_MIX_TRADEOFF(VARCHAR, VARCHAR, FLOAT, FLOAT, FLOAT, VARCHAR) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.SOURCING.LIVE_MIX_TRADEOFF(VARCHAR, VARCHAR, FLOAT, FLOAT, FLOAT, VARCHAR) TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.SOURCING.LIVE_MIX_FLOWS(VARCHAR, VARCHAR, FLOAT, FLOAT, FLOAT, VARCHAR) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.SOURCING.LIVE_MIX_FLOWS(VARCHAR, VARCHAR, FLOAT, FLOAT, FLOAT, VARCHAR) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.SOURCING.LIVE_MIX_FLOWS(VARCHAR, VARCHAR, FLOAT, FLOAT, FLOAT, VARCHAR) TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.SOURCING.LIVE_SWAP_ROUTES(VARCHAR, VARCHAR, FLOAT, FLOAT, VARCHAR, VARCHAR) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.SOURCING.LIVE_SWAP_ROUTES(VARCHAR, VARCHAR, FLOAT, FLOAT, VARCHAR, VARCHAR) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.SOURCING.LIVE_SWAP_ROUTES(VARCHAR, VARCHAR, FLOAT, FLOAT, VARCHAR, VARCHAR) TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.SOURCING.LIVE_MIX_FLOW_ROUTES(VARCHAR, VARCHAR, FLOAT, FLOAT, FLOAT, VARCHAR) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.SOURCING.LIVE_MIX_FLOW_ROUTES(VARCHAR, VARCHAR, FLOAT, FLOAT, FLOAT, VARCHAR) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.SOURCING.LIVE_MIX_FLOW_ROUTES(VARCHAR, VARCHAR, FLOAT, FLOAT, FLOAT, VARCHAR) TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON FUNCTION FLEET_APP.SOURCING.LIVE_CURRENT_ROUTES(VARCHAR, VARCHAR, FLOAT, FLOAT, VARCHAR) TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUNCTION FLEET_APP.SOURCING.LIVE_CURRENT_ROUTES(VARCHAR, VARCHAR, FLOAT, FLOAT, VARCHAR) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON FUNCTION FLEET_APP.SOURCING.LIVE_CURRENT_ROUTES(VARCHAR, VARCHAR, FLOAT, FLOAT, VARCHAR) TO ROLE FLEET_APP_ADMIN;

-- =============================================================================
-- DELIVERY SYNC live-routing UDTFs (extracted from scripts/delivery_sync_layer.sql)
-- =============================================================================
-- Same defect, same fix as the LOCATION / CATCHMENT / SOURCING blocks above: these
-- four UDTFs (x2 - the FLEET_INTELLIGENCE implementation and its FLEET_APP contract
-- wrapper) call ISOCHRONES / MATRIX_TABULAR in a SQL function body, which resolves
-- at CREATE time. On an engine-less install the first one aborted
-- delivery_sync_layer.sql and discarded 33 of its 44 statements - including the
-- whole engine-free FLEET_APP.DELIVERY_SYNC contract (schema, 5 views), the
-- DELIVERY_EVENT_LOG table and its task. Found by check_engine_guards.py.
--
-- ORDER: run delivery_sync_layer.sql FIRST - these read DT_SITE_VISITS and the
-- FLEET_APP.DELIVERY_SYNC schema it creates.
-- =============================================================================

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

CREATE OR REPLACE FUNCTION FLEET_INTELLIGENCE.DELIVERY_SYNC.LIVE_FLEET_STATUS(
  P_REGION VARCHAR, P_PROFILE VARCHAR, P_AS_OF TIMESTAMP_NTZ,
  P_APPROACH_MIN NUMBER, P_JUST_LEFT_MIN NUMBER, P_MAX_STALENESS_MIN NUMBER)
RETURNS TABLE (VEHICLE_ID VARCHAR, STATUS_ENUM VARCHAR, SITE_ID VARCHAR,
               SITE_NAME VARCHAR, MINUTES_OUT NUMBER(10,1), DISTANCE_KM NUMBER(10,2),
               ETA_TS TIMESTAMP_NTZ, MINUTES_SINCE_LEFT NUMBER(12,1),
               POSITION_TS TIMESTAMP_NTZ, VEHICLE_GEOG GEOGRAPHY,
               ON_SITE_PHASE VARCHAR, MINUTES_BACK_TO_SITE NUMBER(10,1),
               IDLE_REASON VARCHAR)
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
  --
  -- Scoped via the shared F_IS_DAY_RELEVANT rule rather than repeating
  -- `SERVICE_DATE = as_of::DATE` here. That rule is the single definition of
  -- "belongs to the day being shown" and it also covers a visit that straddles
  -- midnight - which this function's own `visit_now` / `just_left` branches select
  -- by wall clock and so could report against a site this CTE had filtered out.
  day_sites AS (
    SELECT SITE_ID, ANY_VALUE(SITE_LABEL) AS SITE_NAME
    FROM FLEET_INTELLIGENCE.DELIVERY_SYNC.DT_SITE_VISITS
    WHERE REGION = P_REGION
      AND SITE_GEOG IS NOT NULL
      AND FLEET_INTELLIGENCE.DELIVERY_SYNC.F_IS_DAY_RELEVANT(
            COALESCE(P_AS_OF, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ),
            SERVICE_DATE, ARRIVAL_TS, EXIT_TS, DEPARTURE_TS,
            P_JUST_LEFT_MIN)
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
  -- Did this vehicle work at all before the instant? IDLE only says "no further
  -- visit today", which the tooltip cannot tell apart from "never had one": on
  -- MalaysiaSingaporeAndBrunei 2026-08-03 05:40, 19 of 24 IDLE vehicles had not
  -- worked at all yet every one of them read "Day complete". The distinction is
  -- drawn from DETECTED visits, not a dispatch plan - this dataset has no plan -
  -- so the negative case means "no delivery recorded", not "nothing scheduled".
  -- Keyed on ARRIVAL_TS <= as_of rather than a whole-day count so the answer
  -- stays literally true even for a vehicle with a pending visit that `next_site`
  -- cannot see (NULL SITE_GEOG), which would otherwise read IDLE with work
  -- outstanding.
  worked_today AS (
    SELECT DISTINCT VEHICLE_ID
    FROM FLEET_INTELLIGENCE.DELIVERY_SYNC.DT_SITE_VISITS
    WHERE REGION = P_REGION
      AND SERVICE_DATE = COALESCE(P_AS_OF, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ)::DATE
      AND ARRIVAL_TS <= COALESCE(P_AS_OF, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ)
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
      (w.VEHICLE_ID IS NOT NULL) AS WORKED_TODAY,
      (o.VEHICLE_ID IS NULL
       AND j.VEHICLE_ID IS NOT NULL
       AND (b.MINS IS NULL OR b.MINS <= COALESCE(P_APPROACH_MIN, 15))) AS IS_JUST_LEFT
    FROM last_pos p
    LEFT JOIN on_site   o  ON o.VEHICLE_ID  = p.VEHICLE_ID
    LEFT JOIN just_left j  ON j.VEHICLE_ID  = p.VEHICLE_ID
    LEFT JOIN next_site n  ON n.VEHICLE_ID  = p.VEHICLE_ID
    LEFT JOIN eta       e2 ON e2.VID        = p.VEHICLE_ID
    LEFT JOIN back      b  ON b.VID         = p.VEHICLE_ID
    LEFT JOIN worked_today w ON w.VEHICLE_ID = p.VEHICLE_ID
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
    IFF(r.IS_JUST_LEFT, r.BACK_MINS, NULL)::NUMBER(10,1) AS MINUTES_BACK_TO_SITE,
    -- Only meaningful for IDLE, and NULL everywhere else - gated on the SAME
    -- flags the CASE above uses (the triple is the exact complement of its IDLE
    -- arm) rather than on a re-derived predicate, which is how this function has
    -- repeatedly let a column drift out of agreement with the status it
    -- describes.
    IFF(r.IS_ON_SITE OR r.IS_JUST_LEFT OR r.HAS_NEXT, NULL,
        IFF(r.WORKED_TODAY, 'DAY_COMPLETE', 'NO_VISITS_TODAY')) AS IDLE_REASON
  FROM resolved r
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
               ON_SITE_PHASE VARCHAR, MINUTES_BACK_TO_SITE NUMBER(10,1),
               IDLE_REASON VARCHAR)
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-delivery-sync","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
  SELECT * FROM TABLE(FLEET_INTELLIGENCE.DELIVERY_SYNC.LIVE_FLEET_STATUS(
    P_REGION, P_PROFILE, P_AS_OF, P_APPROACH_MIN, P_JUST_LEFT_MIN, P_MAX_STALENESS_MIN))
$$;
