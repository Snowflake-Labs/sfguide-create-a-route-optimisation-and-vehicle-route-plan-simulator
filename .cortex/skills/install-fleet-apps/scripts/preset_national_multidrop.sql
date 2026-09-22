-- =====================================================================
-- PRESET: national-multidrop-hgv - country-scale beverage distribution
-- =====================================================================
-- A Data Studio generation profile that produces GENUINE MULTI-DROP ROUTES at
-- national scale: ~24 stops per vehicle-day across a dozen-odd depot territories,
-- which is what a beverage bottler actually runs and what route-plan
-- standardization analytics need to be meaningful.
--
-- WHY A NEW PRESET RATHER THAN REUSING regional-hgv
-- The two shipped HGV/urban presets sit at opposite extremes and neither is a
-- bottler. MEASURED on this account:
--
--   SanFrancisco  (urban-ebike, city)    28.1 stops/route  - right SHAPE, one city
--   UsTexas       (regional-hgv, country) 1.6 stops/route
--   UnitedStates  (regional-hgv, country) 1.3 stops/route  - right SCALE, wrong shape
--
-- regional-hgv is line-haul: trips_per_day 2-4, long_pct 0.40, medium_max_km 150,
-- and a POI estate of warehouses and truck stops rather than customer outlets. So
-- this preset takes the country scale and the HGV legal caps from regional-hgv,
-- and the trip density and short distance bands from the urban presets.
--
-- WHY IT IS REGISTERED AS A ROW AND NOT IN profiles.ts
-- generation-profile-catalog.ts states a new mode "can be onboarded by INSERTing
-- a profile row", and its boot MERGE is `WHEN MATCHED AND tgt.IS_BUILTIN = TRUE`,
-- so IS_BUILTIN = FALSE rows survive every admin app restart untouched. That
-- keeps this a config artifact (Tenet 4) and needs no image rebuild.
--
-- THE ONE THING THAT DID NEED CODE: poi_cap. poiCapForArea's first tier is
-- "< 250,000 km^2 -> 5,000", which spans a 300x area range, so Switzerland
-- (41,822 km^2) was handed San Francisco's (839 km^2) pool - 0.121 POIs/km^2
-- against 6.0. The H3 round-robin then draws ~14 POIs per res-5 cell, so a Zurich
-- origin finds ~14 outlets within 8 km and a 25-stop route must revisit the same
-- handful. config.poi_cap (admin app v0.1.68+) overrides it. AGAINST AN OLDER
-- IMAGE THIS FIELD IS SILENTLY IGNORED and the pool is default-sized, so verify
-- the generated POI count before trusting a run.
--
-- SUPPLY, MEASURED inside the Swiss BOUNDARY (not the bbox - the bbox overstates
-- by ~40% because it includes France, Germany and Italy):
--   outlets  63,493   on-premise (restaurant, casual_eatery, bar, cafe,
--                     coffee_shop, fast_food), off-premise
--                     (food_and_beverage_store, convenience_store,
--                     shopping_mall, shopping), impulse (gas_station) and
--                     vending/cooler accounts (sport_or_fitness_facility, gym)
--   hotels    6,021
--   depots    2,602   wholesaler, b2b_transportation_and_storage_service,
--                     storage_facility
--
-- A NOTE ON HOW THIS LIST WAS ARRIVED AT, because two attempts were wrong.
--
-- MISTAKE 1, too few categories. grocery_store, supermarket, pub, liquor_store
-- and warehouse all measure ZERO in Overture here, and the first version
-- concluded Switzerland had no off-premise retail to deliver to. It does - the
-- category is named food_and_beverage_store (10,162), and the same error hid
-- casual_eatery (4,452) and gas_station (3,635). Enumerating what the taxonomy
-- DOES contain, rather than probing for the names a bottler would use, roughly
-- doubled usable outlet supply.
--
-- MISTAKE 2, and the more instructive one: raw POI COUNT is not the lever, the
-- DEPOT-to-outlet geometry is. That same sweep also added manufacturer (6,959)
-- and supplier_or_distributor (4,473) to the WAREHOUSE map, on the reasoning
-- that both are distribution-ish. Four 10-vehicle probes, MEASURED:
--
--   P1  cap 35k  33,474 POIs  0.80/km2  3 logistics depot cats  16.2 stops  14.8 km/stop  SD    -
--   P3  cap 75k  72,850 POIs  1.74/km2  5 cats (+industrial)    13.6 stops  25.7 km/stop  SD 88.6
--   P4  cap 70k  67,816 POIs  1.62/km2  3 logistics depot cats  16.4 stops  18.1 km/stop  SD 15.4
--   P5  cap 55k  53,069 POIs  1.27/km2  3 logistics, clustered  15.6 stops  20.3 km/stop  SD153.9
--
-- P3 is the real finding: the two industrial categories took 82% of the depot
-- pool (10,631 of 12,958) and pushed genuine logistics depots down to 18%, so
-- vehicles started from factories scattered through rural industrial zones
-- instead of from depots sited near customer clusters. Stops fell, km/stop rose
-- 74%, and one route degenerated to a single stop. Both categories are therefore
-- excluded from poi_categories ENTIRELY rather than merely unmapped - left
-- listed, "_default": "STORE" would have made them beverage customers.
--
-- WHAT DID NOT REPLICATE, stated plainly because the first version of this
-- comment asserted it: POI density is NOT the lever on km-per-stop. P1 has the
-- LOWEST density of the four and the TIGHTEST routes. Across P1/P4/P5 - which
-- differ only in outlet breadth, not in the depot fix - km/stop moves 14.8/18.1/
-- 20.3 while SD swings 15.4 to 153.9. At 9-10 routes per probe that spread is
-- dominated by where a handful of depots happened to land, so those three are
-- not reliably distinguishable and the earlier density claim was reading noise.
--
-- The category set below is therefore chosen on DOMAIN grounds, not by picking
-- the best probe number: the full on-premise / off-premise / impulse / vending
-- mix a bottler actually serves, with logistics-only depots because that is the
-- one effect large enough (P3) to be real. Over ~1,400 routes in the full run,
-- depot-placement noise averages out in a way it cannot over 9.
--
-- The depot pool is deliberately SMALL (2,602 candidates) and purely logistics.
-- 200 vehicles need a few hundred distinct depots at most; probes realised
-- ~2,200-2,500 WAREHOUSE rows from these three categories.
-- =====================================================================
-- REGION IS NOT PINNED. region/bbox/region_area_km2 are resolved per RUN by the
-- Data Studio job, so this preset is reusable for any region whose graph carries
-- driving-hgv. Switzerland is the first target because it is already provisioned
-- and RUNNING, and its graph loaded driving-hgv ONLY (no driving-car).
-- =====================================================================

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-plan-standards","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

MERGE INTO FLEET_INTELLIGENCE.CORE.GENERATION_PROFILE_CATALOG tgt
USING (
  SELECT
    'national-multidrop-hgv' AS TEMPLATE_ID,
    'National Multi-Drop Distribution (HGV)' AS NAME,
    'Country-scale beverage/FMCG distribution: many depot territories, each running dense multi-drop routes of ~24 customer stops per vehicle-day. Built for route-plan standardization and planner-variance analytics.' AS DESCRIPTION,
    'hgv' AS VEHICLE_TYPE,
    'driving-hgv' AS ORS_PROFILE,
    'country' AS REGION_SCALE,
    ARRAY_CONSTRUCT('route-plan-standards', 'fleet-intelligence-car') AS FEEDS,
    PARSE_JSON($${
      "mode": "regional_hgv",

      "fleet": {
        "num_vehicles": 200,
        "weekday_operating_rate": 0.92,
        "weekend_operating_rate": 0.45,
        "trips_per_day": { "min": 18, "max": 30 }
      },

      "shifts": [
        { "name": "Early",   "start": 4, "end": 14, "proportion": 0.35 },
        { "name": "Day",     "start": 6, "end": 16, "proportion": 0.45 },
        { "name": "Late",    "start": 9, "end": 19, "proportion": 0.20 }
      ],

      "time": { "start_date": "2026-09-14", "end_date": "2026-09-20", "chunk_size_days": 7 },

      "distance_distribution": {
        "short_pct": 0.78, "short_max_km": 8,
        "medium_pct": 0.20, "medium_max_km": 25,
        "long_pct": 0.02
      },

      "driver_profiles": {
        "COMPLIANT": { "proportion": 0.72, "detour_probability": 0.08, "speeding_probability": 0.05, "hos_violation_probability": 0.02, "speed_variance": 0.06 },
        "MILD":      { "proportion": 0.20, "detour_probability": 0.18, "speeding_probability": 0.12, "hos_violation_probability": 0.06, "speed_variance": 0.10 },
        "OUTLIER":   { "proportion": 0.08, "detour_probability": 0.35, "speeding_probability": 0.25, "hos_violation_probability": 0.12, "speed_variance": 0.16 }
      },

      "routing": {
        "optimal_route_probability": 0.70,
        "alternative_route_probability": 0.20,
        "detour_probability": 0.10,
        "posted_speeds": { "motorway": 80, "primary": 60, "secondary": 50, "residential": 30, "default": 45 }
      },

      "telemetry": {
        "ping_interval_moving": { "mean_sec": 15, "std_sec": 5 },
        "ping_interval_dwell": { "min_sec": 60, "max_sec": 180 },
        "gps_jitter": { "typical_m": 8, "multipath_probability": 0.02, "multipath_max_m": 100 }
      },

      "dwell": {
        "origin":      { "median_min": 25, "sigma": 0.5, "max_min": 60, "long_wait_probability": 0.10 },
        "destination": { "median_min": 12, "sigma": 0.6, "max_min": 45, "long_wait_probability": 0.08 },
        "idle":        { "median_min": 10, "sigma": 0.5, "max_min": 30, "long_wait_probability": 0.10 }
      },

      "breaks": { "driving_hours_between_breaks": 4.5, "mandatory_break_duration_min": 45, "max_daily_driving_hours": 9 },

      "overnight": { "enabled": false, "rest_hours_min": 10, "rest_hours_max": 11, "ping_interval_min_sec": 300, "ping_interval_max_sec": 900 },

      "shift_overrun": { "enabled": true, "probability": 0.35, "max_hours": 2.0, "min_rest_hours": 9, "profile_multiplier": { "COMPLIANT": 0.6, "MILD": 1.0, "OUTLIER": 1.6 } },

      "detour": { "probability": 0.10, "max_detour_factor": 1.4 },

      "poi_categories": [
        "restaurant", "casual_eatery", "bar", "cafe", "coffee_shop",
        "fast_food_restaurant", "hotel",
        "food_and_beverage_store", "convenience_store", "gas_station",
        "shopping_mall", "shopping",
        "sport_or_fitness_facility", "gym",
        "wholesaler",
        "b2b_transportation_and_storage_service", "storage_facility"
      ],

      "category_map": {
        "WAREHOUSE": ["wholesaler", "b2b_transportation_and_storage_service", "storage_facility"],
        "STORE": ["restaurant", "casual_eatery", "bar", "cafe", "coffee_shop", "fast_food_restaurant", "food_and_beverage_store", "convenience_store", "gas_station", "shopping_mall", "shopping", "sport_or_fitness_facility", "gym"],
        "DESTINATION": ["hotel"],
        "_default": "STORE"
      },

      "home_location_types": ["WAREHOUSE"],

      "poi_cap": 70000,

      "spatial_spread": { "enabled": true, "bin_deg": 0.5, "min_bins_required": 3 },

      "base_speed_kmh": { "min": 30, "max": 60 },

      "generates_anchors": true,
      "generates_places": true,
      "generates_offers": false,
      "generates_demographics": false,
      "generates_hazard": false,
      "generates_demand": false,
      "generates_participants": false
    }$$) AS DEFAULT_CONFIG,
    FALSE AS IS_BUILTIN
) src
ON tgt.TEMPLATE_ID = src.TEMPLATE_ID
-- Only ever update a NON-builtin row, mirroring the boot MERGE's guard in the
-- opposite direction: if a future release ever ships a builtin with this id, this
-- file must not clobber it.
WHEN MATCHED AND tgt.IS_BUILTIN = FALSE THEN UPDATE SET
  tgt.NAME = src.NAME,
  tgt.DESCRIPTION = src.DESCRIPTION,
  tgt.VEHICLE_TYPE = src.VEHICLE_TYPE,
  tgt.ORS_PROFILE = src.ORS_PROFILE,
  tgt.REGION_SCALE = src.REGION_SCALE,
  tgt.FEEDS = src.FEEDS,
  tgt.DEFAULT_CONFIG = src.DEFAULT_CONFIG,
  tgt.UPDATED_AT = CURRENT_TIMESTAMP()::TIMESTAMP_NTZ
WHEN NOT MATCHED THEN INSERT
  (TEMPLATE_ID, NAME, DESCRIPTION, VEHICLE_TYPE, ORS_PROFILE, REGION_SCALE, FEEDS, DEFAULT_CONFIG, IS_BUILTIN)
  VALUES (src.TEMPLATE_ID, src.NAME, src.DESCRIPTION, src.VEHICLE_TYPE, src.ORS_PROFILE, src.REGION_SCALE, src.FEEDS, src.DEFAULT_CONFIG, src.IS_BUILTIN);

-- Report the shape rather than assert one number: the knobs that decide whether
-- routes come out multi-drop are worth seeing on every run of this file.
SELECT TEMPLATE_ID, VEHICLE_TYPE, ORS_PROFILE, REGION_SCALE, IS_BUILTIN,
       DEFAULT_CONFIG:fleet:num_vehicles::NUMBER        AS VEHICLES,
       DEFAULT_CONFIG:fleet:trips_per_day:min::NUMBER   AS TPD_MIN,
       DEFAULT_CONFIG:fleet:trips_per_day:max::NUMBER   AS TPD_MAX,
       DEFAULT_CONFIG:poi_cap::NUMBER                   AS POI_CAP,
       DEFAULT_CONFIG:distance_distribution:short_max_km::FLOAT AS SHORT_KM,
       DEFAULT_CONFIG:spatial_spread:bin_deg::FLOAT     AS BIN_DEG,
       DEFAULT_CONFIG:home_location_types::STRING       AS DEPOT_TYPES
FROM FLEET_INTELLIGENCE.CORE.GENERATION_PROFILE_CATALOG
WHERE TEMPLATE_ID = 'national-multidrop-hgv';
