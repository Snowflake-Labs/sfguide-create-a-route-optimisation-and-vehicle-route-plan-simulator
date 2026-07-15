-- semantic_views.sql - agnostic Cortex Analyst semantic views for FLEET_AGENT.
-- Owned by install-fleet-apps. Creates FLEET_INTELLIGENCE.SEMANTIC + the 5 SVs the
-- consumer agent (agent-spec.json) binds its cortex_analyst_text_to_sql tools to.
-- DWELL + ASSET_VELOCITY are rebound onto the pack-built FLEET_APP.* contract views
-- (the agnostic install does not build the FLEET_INTELLIGENCE DT_*/asset-velocity
-- sources); FLEET_OPS already binds FLEET_APP; ROUTE_DEVIATION + CATCHMENT bind the
-- FLEET_INTELLIGENCE objects authored by scripts/analytic_layer.sql. Run AFTER packs
-- (FLEET_APP.* exist) and BEFORE agents. Idempotent (CREATE OR REPLACE).

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","module":"semantic_views"}}';

CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.SEMANTIC
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"semantic-views"}}';

-- ============ SV_FLEET_OPS (FLEET_APP.FLEET_OPS.*) ============
-- SV_FLEET_OPS - the ONE universal, mode-agnostic fleet analytics semantic view (R6)
-- Source: FLEET_APP.FLEET_OPS.* global-active views (thin wrappers over the
--         dataset-scoped UDTFs in fleet_sa_app/app/scoped_contract.sql).
-- Deploy target: FLEET_INTELLIGENCE.SEMANTIC (via the fleet_test_evals connection)
--
-- Supersedes the retired SV_TAXIS, SV_FOOD_DELIVERY, and SV_FLEET_OPERATIONS.
-- VEHICLE_TYPE is a DATA DIMENSION (mode axis) carried by the active dataset; this
-- view NEVER branches on it. Mode-neutral vocab: OPERATOR_ID, ORIGIN, asset.
--
-- Grain model (single fact + one parent dimension + one standalone fact):
--   trips     - FACT, one row per actual trip (finest grain). All trip + operator
--               productivity metrics derive from here (speed = distance/duration).
--   operators - DIMENSION (parent of trips by OPERATOR_ID): descriptive operator
--               attributes (shift, profile). No metrics -> avoids cross-grain errors.
--   origins   - standalone FACT, one row per origin POI (trip volume by origin).

CREATE OR REPLACE SEMANTIC VIEW FLEET_INTELLIGENCE.SEMANTIC.SV_FLEET_OPS

  TABLES (
    trips AS FLEET_APP.FLEET_OPS.VW_TRIPS
      PRIMARY KEY (TRIP_ID)
    , operators AS FLEET_APP.FLEET_OPS.VW_OPERATOR_PERFORMANCE
      PRIMARY KEY (OPERATOR_ID)
      COMMENT = 'Operator dimension (shift, profile). Parent of trips by OPERATOR_ID.'
    , origins AS FLEET_APP.FLEET_OPS.VW_TOP_ORIGINS
      PRIMARY KEY (ORIGIN_POI_ID)
      COMMENT = 'Origin POI fact (standalone, origin-grained).'
  )

  RELATIONSHIPS (
    trips_to_operators AS trips(OPERATOR_ID) REFERENCES operators(OPERATOR_ID)
  )

  FACTS (
    trips.distance_km AS DISTANCE_KM
      COMMENT = 'Actual trip distance in km'
    , trips.duration_minutes AS DURATION_MINUTES
      COMMENT = 'Actual trip duration in minutes'
    , origins.origin_total_trips AS TOTAL_TRIPS
      COMMENT = 'Trips departing from this origin'
    , origins.origin_avg_duration AS AVG_DURATION_MIN
      COMMENT = 'Average duration of trips from this origin (minutes)'
  )

  DIMENSIONS (
    trips.region AS REGION
      WITH SYNONYMS ('city', 'area', 'geography')
      COMMENT = 'Operating region (e.g. SanFrancisco, Germany, Europe)'
    , trips.vehicle_type AS VEHICLE_TYPE
      WITH SYNONYMS ('vehicle class', 'fleet type', 'mode', 'asset mode')
      COMMENT = 'Asset mode dimension (car, hgv, ebike, and future modes). A data value, not a fixed set.'
    , trips.operator_id AS OPERATOR_ID
      WITH SYNONYMS ('operator', 'driver', 'rider', 'courier')
      COMMENT = 'Mode-neutral operator identifier'
    , trips.status AS STATUS
      WITH SYNONYMS ('trip state')
      COMMENT = 'Trip status'
    , trips.is_detour AS IS_DETOUR
      COMMENT = 'Whether the trip was flagged as a detour'
    , trips.trip_start AS TRIP_START
      WITH SYNONYMS ('trip start time', 'departure time')
      COMMENT = 'Trip start timestamp'
    , operators.shift_type AS SHIFT_TYPE
      WITH SYNONYMS ('shift', 'shift pattern')
      COMMENT = 'Operator shift pattern'
    , operators.driver_profile AS DRIVER_PROFILE
      WITH SYNONYMS ('operator profile', 'behavior')
      COMMENT = 'Operator behavior profile (COMPLIANT, AGGRESSIVE, OUTLIER)'
    , origins.origin_name AS ORIGIN_NAME
      WITH SYNONYMS ('origin', 'start point', 'pickup location', 'depot', 'restaurant')
      COMMENT = 'Origin POI name (any origin type)'
    , origins.origin_location_type AS LOCATION_TYPE
      WITH SYNONYMS ('origin type', 'place type')
      COMMENT = 'Origin POI type (DEPOT, WAREHOUSE, RESTAURANT, etc.)'
    , origins.origin_region AS REGION
      COMMENT = 'Origin region'
  )

  METRICS (
    trips.total_trips AS COUNT(DISTINCT TRIP_ID)
      WITH SYNONYMS ('number of trips', 'trip count')
      COMMENT = 'Distinct count of actual trips'
    , trips.total_operators AS COUNT(DISTINCT OPERATOR_ID)
      WITH SYNONYMS ('number of operators', 'active operators', 'drivers')
      COMMENT = 'Distinct count of operators'
    , trips.total_distance_km AS SUM(distance_km)
      WITH SYNONYMS ('total km driven', 'total distance')
      COMMENT = 'Total actual distance driven (km)'
    , trips.avg_distance_km AS AVG(distance_km)
      COMMENT = 'Average actual trip distance (km)'
    , trips.total_duration_min AS SUM(duration_minutes)
      COMMENT = 'Total actual trip duration (minutes)'
    , trips.avg_duration_min AS AVG(duration_minutes)
      COMMENT = 'Average actual trip duration (minutes)'
    , trips.avg_speed_kmh AS AVG(DIV0(distance_km, duration_minutes) * 60)
      WITH SYNONYMS ('average speed', 'mean speed')
      COMMENT = 'Average trip speed (km/h), derived from distance and duration'
    , trips.detour_trip_count AS COUNT_IF(IS_DETOUR)
      WITH SYNONYMS ('number of detours', 'detour trips')
      COMMENT = 'Count of trips flagged as detours'
    , trips.detour_rate_pct AS DIV0(COUNT_IF(IS_DETOUR), COUNT(*)) * 100
      WITH SYNONYMS ('detour percentage')
      COMMENT = 'Percent of trips flagged as detours'
    , origins.total_origins AS COUNT(DISTINCT ORIGIN_POI_ID)
      WITH SYNONYMS ('number of origins', 'origin locations')
      COMMENT = 'Distinct count of origin POIs'
    , origins.total_origin_trips AS SUM(origin_total_trips)
      WITH SYNONYMS ('trips from origins')
      COMMENT = 'Total trips departing from origins'
  )

  COMMENT = 'Universal, mode-agnostic fleet analytics. Reflects the currently active dataset (region + asset mode). Covers trips (distance, duration, speed, detours, status), operator breakdowns (shift, profile), and top origins (trip volume by origin POI), broken down by region, asset mode (vehicle_type), operator, shift, and origin type. Mode is a data dimension - the same view answers for car, hgv, ebike, and future modes.'

  AI_SQL_GENERATION 'Universal fleet analytics semantic view for the Route Optimisation & Fleet Intelligence solution. It replaces the per-vehicle taxi / food-delivery / fleet-operations views with ONE mode-agnostic model.

Entities:
- trips: THE fact, one row per actual trip (distance_km, duration_minutes, is_detour, status), keyed by TRIP_ID. region, vehicle_type (asset mode), and operator_id live here. All trip + operator productivity metrics derive from this table.
- operators: a DIMENSION (parent of trips by OPERATOR_ID) holding descriptive operator attributes shift_type and driver_profile. Use it to group trip metrics by shift or operator profile. It has no metrics of its own.
- origins: a standalone fact, one row per origin POI (origin_total_trips), keyed by ORIGIN_POI_ID. Use for "busiest / top origins" questions; filter origin_location_type for a specific origin category (DEPOT, WAREHOUSE, RESTAURANT).

Conventions:
- vehicle_type is the ASSET MODE dimension; values look like car, hgv, ebike (open-ended; future vessel/aircraft). Never assume a fixed set; treat it as a filter.
- operator_id is the mode-neutral operator (driver / rider / courier). Use total_operators for operator counts (it is COUNT(DISTINCT operator_id) on trips).
- "average speed" = trips.avg_speed_kmh (derived from distance/duration). There is no separate telemetry table here.
- For detour rate use trips.detour_rate_pct; for raw counts use trips.detour_trip_count.
- Group trip metrics by trips dimensions (region, vehicle_type, operator_id, status) or by the operators parent dimensions (shift_type, driver_profile).
- origins does not join to trips/operators (origin-POI grained) - answer origin questions from the origins table alone.'
;

-- ============ SV_ROUTE_DEVIATION (FLEET_INTELLIGENCE.ROUTE_DEVIATION) ============
-- SV_ROUTE_DEVIATION - route deviation analysis semantic view
-- Source: FLEET_INTELLIGENCE.ROUTE_DEVIATION.TRIP_DEVIATION_ANALYSIS (per trip)
-- Deploy target: FLEET_INTELLIGENCE.SEMANTIC (via fleet_test_evals connection)
-- ACTUAL_PATH / EXPECTED_PATH GEOGRAPHY columns excluded.

CREATE OR REPLACE SEMANTIC VIEW FLEET_INTELLIGENCE.SEMANTIC.SV_ROUTE_DEVIATION

  TABLES (
    trip_dev AS FLEET_INTELLIGENCE.ROUTE_DEVIATION.TRIP_DEVIATION_ANALYSIS
      PRIMARY KEY (TRIP_ID)
  )

  FACTS (
    trip_dev.route_deviation_factor AS ROUTE_DEVIATION_FACTOR COMMENT = 'Actual/expected route ratio'
    , trip_dev.actual_distance_km AS ACTUAL_DISTANCE_KM COMMENT = 'Actual distance km'
    , trip_dev.actual_duration_min AS ACTUAL_DURATION_MIN COMMENT = 'Actual duration minutes'
    , trip_dev.expected_distance_km AS EXPECTED_DISTANCE_KM COMMENT = 'Expected distance km'
    , trip_dev.expected_duration_min AS EXPECTED_DURATION_MIN COMMENT = 'Expected duration minutes'
    , trip_dev.distance_deviation_km AS DISTANCE_DEVIATION_KM COMMENT = 'Excess distance km vs expected'
    , trip_dev.distance_deviation_pct AS DISTANCE_DEVIATION_PCT COMMENT = 'Distance deviation percent'
    , trip_dev.duration_deviation_min AS DURATION_DEVIATION_MIN COMMENT = 'Excess duration minutes vs expected'
    , trip_dev.duration_deviation_pct AS DURATION_DEVIATION_PCT COMMENT = 'Duration deviation percent'
  )

  DIMENSIONS (
    trip_dev.driver_id AS DRIVER_ID WITH SYNONYMS ('driver') COMMENT = 'Driver id'
    , trip_dev.vehicle_id AS VEHICLE_ID COMMENT = 'Vehicle id'
    , trip_dev.trip_date AS TRIP_DATE WITH SYNONYMS ('date') COMMENT = 'Trip date'
    , trip_dev.route_variation AS ROUTE_VARIATION COMMENT = 'Route variation classification'
    , trip_dev.trip_type AS TRIP_TYPE COMMENT = 'Trip type'
    , trip_dev.origin_name AS ORIGIN_NAME WITH SYNONYMS ('origin') COMMENT = 'Trip origin name'
    , trip_dev.origin_city AS ORIGIN_CITY COMMENT = 'Trip origin city'
    , trip_dev.dest_name AS DEST_NAME WITH SYNONYMS ('destination') COMMENT = 'Trip destination name'
    , trip_dev.dest_city AS DEST_CITY COMMENT = 'Trip destination city'
    , trip_dev.is_route_deviation AS IS_ROUTE_DEVIATION WITH SYNONYMS ('deviated') COMMENT = 'Whether the trip deviated from the planned route'
  )

  METRICS (
    trip_dev.total_trips AS COUNT(DISTINCT TRIP_ID) WITH SYNONYMS ('number of trips', 'trip count') COMMENT = 'Distinct trips analyzed'
    , trip_dev.deviation_trips AS COUNT_IF(IS_ROUTE_DEVIATION) WITH SYNONYMS ('deviated trips', 'number of deviations') COMMENT = 'Trips flagged as route deviations'
    , trip_dev.deviation_rate_pct AS DIV0(COUNT_IF(IS_ROUTE_DEVIATION), COUNT(*)) * 100 WITH SYNONYMS ('deviation rate', 'percent deviated') COMMENT = 'Percent of trips that deviated'
    , trip_dev.total_excess_km AS SUM(distance_deviation_km) WITH SYNONYMS ('total excess distance') COMMENT = 'Total excess km from deviations'
    , trip_dev.avg_distance_deviation_pct AS AVG(distance_deviation_pct) COMMENT = 'Average distance deviation percent'
    , trip_dev.total_time_lost_min AS SUM(duration_deviation_min) WITH SYNONYMS ('time lost', 'total delay') COMMENT = 'Total excess minutes from deviations'
    , trip_dev.avg_duration_deviation_pct AS AVG(duration_deviation_pct) COMMENT = 'Average duration deviation percent'
    , trip_dev.avg_route_deviation_factor AS AVG(route_deviation_factor) COMMENT = 'Average actual/expected route factor'
  )

  COMMENT = 'Route deviation analysis: compares actual driven routes against planned routes per trip, with deviation distance/time and rates, broken down by driver, route variation, and origin/destination.'

  AI_SQL_GENERATION 'Route deviation semantic view for the Route Optimisation & Fleet Intelligence solution.
One fact: trip_dev (TRIP_DEVIATION_ANALYSIS), one row per analyzed trip.
Conventions:
- "deviation rate" -> deviation_rate_pct; raw counts -> deviation_trips.
- "excess km" -> total_excess_km; "time lost" -> total_time_lost_min.
- Group by driver_id for per-driver deviation; by trip_date for daily trends; by route_variation for classification.'
;

-- ============ SV_CATCHMENT (FLEET_INTELLIGENCE.CATCHMENT) ============
-- SV_CATCHMENT - Catchment demo semantic view
-- Source: FLEET_INTELLIGENCE.CATCHMENT.POIS + CITIES_BY_STATE
-- Deploy target: FLEET_INTELLIGENCE.SEMANTIC (via fleet_test_evals connection)
-- GEOMETRY GEOGRAPHY column excluded; lat/lon retained on base view but not modeled as metrics.

CREATE OR REPLACE SEMANTIC VIEW FLEET_INTELLIGENCE.SEMANTIC.SV_CATCHMENT

  TABLES (
    pois AS FLEET_INTELLIGENCE.CATCHMENT.POIS
      PRIMARY KEY (POI_ID)
    , cities AS FLEET_INTELLIGENCE.CATCHMENT.CITIES_BY_STATE
      PRIMARY KEY (REGION, STATE, CITY)
    , addresses AS FLEET_INTELLIGENCE.CATCHMENT.REGIONAL_ADDRESSES
      PRIMARY KEY (ID)
  )

  FACTS (
    cities.city_poi_count AS POI_COUNT COMMENT = 'Precomputed POI count for a city'
  )

  DIMENSIONS (
    pois.poi_name AS POI_NAME WITH SYNONYMS ('place', 'location name') COMMENT = 'POI name'
    , pois.basic_category AS BASIC_CATEGORY WITH SYNONYMS ('category', 'type') COMMENT = 'POI category (coffee_shop, restaurant, grocery_store, etc.)'
    , pois.city AS CITY COMMENT = 'POI city'
    , pois.state AS STATE COMMENT = 'POI state'
    , pois.postcode AS POSTCODE WITH SYNONYMS ('zip', 'postal code') COMMENT = 'POI postcode'
    , pois.address AS ADDRESS COMMENT = 'POI street address'
    , pois.region AS REGION COMMENT = 'Region'
    , cities.cities_state AS STATE COMMENT = 'State (cities aggregate)'
    , cities.cities_city AS CITY COMMENT = 'City (cities aggregate)'
    , cities.cities_region AS REGION COMMENT = 'Region (cities aggregate)'
    , addresses.addr_city AS CITY COMMENT = 'Address city (Overture addresses)'
    , addresses.addr_postcode AS POSTCODE WITH SYNONYMS ('zip', 'postal code') COMMENT = 'Address postcode (Overture addresses)'
    , addresses.addr_region AS REGION COMMENT = 'Region (Overture addresses)'
  )

  METRICS (
    pois.total_pois AS COUNT(DISTINCT POI_ID) WITH SYNONYMS ('number of pois', 'poi count', 'locations') COMMENT = 'Distinct POI count'
    , pois.unique_cities AS COUNT(DISTINCT CITY) WITH SYNONYMS ('number of cities') COMMENT = 'Distinct cities'
    , pois.unique_categories AS COUNT(DISTINCT BASIC_CATEGORY) WITH SYNONYMS ('number of categories') COMMENT = 'Distinct POI categories'
    , cities.total_city_pois AS SUM(city_poi_count) WITH SYNONYMS ('total pois by city') COMMENT = 'Total POIs across cities (precomputed)'
    , addresses.total_addresses AS COUNT(DISTINCT ID) WITH SYNONYMS ('number of addresses', 'address count', 'address coverage') COMMENT = 'Distinct Overture street-address count (density / coverage)'
  )

  COMMENT = 'Catchment demo: points of interest by category/city/state, plus precomputed POI counts per city.'

  AI_SQL_GENERATION 'Catchment semantic view.
Entities (three independent entities):
- pois (POIS): one row per POI. Use total_pois grouped by basic_category, city, or state for density/competition questions.
- cities (CITIES_BY_STATE): precomputed POI counts per city.
- addresses (REGIONAL_ADDRESSES): one row per Overture street address. Use total_addresses grouped by city/postcode for address-density and coverage questions.
Conventions:
- "how many coffee shops in X" -> total_pois filtered by basic_category and city.
- "competition density" -> total_pois grouped by basic_category + city.
- "how many addresses" / "address coverage per city" -> total_addresses grouped by addr_city.'
;

-- ============ SV_DWELL_ANALYTICS (rebound onto FLEET_APP.DWELL.*) ============
-- SV_DWELL_ANALYTICS - dwell analysis semantic view
-- Source: FLEET_APP.DWELL.VW_DWELL_SESSIONS (dwell sessions),
--         FLEET_APP.DWELL.VW_DRIVER_DWELL_SUMMARY (per-driver SLA)
-- Deploy target: FLEET_INTELLIGENCE.SEMANTIC (via fleet_test_evals connection)
-- AVG_POINT GEOGRAPHY excluded. Two independent facts.

CREATE OR REPLACE SEMANTIC VIEW FLEET_INTELLIGENCE.SEMANTIC.SV_DWELL_ANALYTICS

  TABLES (
    sessions AS FLEET_APP.DWELL.VW_DWELL_SESSIONS
      PRIMARY KEY (VEHICLE_ID, SESSION_ID)
    , driver_dwell AS FLEET_APP.DWELL.VW_DRIVER_DWELL_SUMMARY
      PRIMARY KEY (VEHICLE_ID)
  )

  FACTS (
    sessions.dwell_minutes AS DWELL_MINUTES COMMENT = 'Dwell session length in minutes'
    , sessions.dwell_seconds AS DWELL_SECONDS COMMENT = 'Dwell session length in seconds'
    , sessions.ping_count AS PING_COUNT COMMENT = 'GPS pings in the dwell session'
    , driver_dwell.d_total_dwell_min AS TOTAL_DWELL_MIN COMMENT = 'Per-driver total dwell minutes'
    , driver_dwell.d_total_dwell_hours AS TOTAL_DWELL_HOURS COMMENT = 'Per-driver total dwell hours'
    , driver_dwell.d_avg_session_min AS AVG_SESSION_MIN COMMENT = 'Per-driver average session minutes'
    , driver_dwell.d_sla_breach_count AS SLA_BREACH_COUNT COMMENT = 'Per-driver SLA breach count'
    , driver_dwell.d_critical_breach_count AS CRITICAL_BREACH_COUNT COMMENT = 'Per-driver critical SLA breach count'
  )

  DIMENSIONS (
    sessions.dwell_status AS STATUS WITH SYNONYMS ('dwell type', 'session status') COMMENT = 'Dwell status (DWELL_WAREHOUSE, DWELL_STORE, DWELL_REST, etc.)'
    , sessions.facility_type AS FACILITY_TYPE WITH SYNONYMS ('facility') COMMENT = 'Facility type at the dwell location'
    , sessions.loc_type AS LOC_TYPE COMMENT = 'Location type'
    , sessions.city AS CITY WITH SYNONYMS ('dwell city') COMMENT = 'City of the dwell location'
    , sessions.location_name AS LOCATION_NAME WITH SYNONYMS ('facility name', 'place') COMMENT = 'Dwell location name'
    , sessions.h3_cell AS H3_CELL_R7 WITH SYNONYMS ('hex cell', 'h3') COMMENT = 'H3 resolution-7 cell for congestion heatmaps'
    , sessions.driver_profile AS DRIVER_PROFILE COMMENT = 'Driver profile'
    , sessions.operating_mode AS OPERATING_MODE COMMENT = 'Operating mode'
    , sessions.session_start AS SESSION_START WITH SYNONYMS ('dwell start') COMMENT = 'Dwell session start timestamp'
    , driver_dwell.dd_driver_profile AS DRIVER_PROFILE COMMENT = 'Driver profile (driver summary)'
    , driver_dwell.dd_operating_mode AS OPERATING_MODE COMMENT = 'Operating mode (driver summary)'
    , driver_dwell.home_base_name AS HOME_BASE_NAME WITH SYNONYMS ('home base', 'depot') COMMENT = 'Driver home base name'
    , driver_dwell.dd_vehicle_id AS VEHICLE_ID COMMENT = 'Vehicle id (driver summary)'
  )

  METRICS (
    sessions.total_sessions AS COUNT(*) WITH SYNONYMS ('dwell sessions', 'number of dwells') COMMENT = 'Total dwell sessions'
    , sessions.total_dwell_minutes AS SUM(dwell_minutes) WITH SYNONYMS ('total dwell time') COMMENT = 'Total dwell minutes'
    , sessions.total_dwell_hours AS SUM(dwell_minutes) / 60.0 COMMENT = 'Total dwell hours'
    , sessions.avg_dwell_minutes AS AVG(dwell_minutes) WITH SYNONYMS ('average dwell time') COMMENT = 'Average dwell minutes per session'
    , sessions.max_dwell_minutes AS MAX(dwell_minutes) COMMENT = 'Longest dwell session in minutes'
    , sessions.unique_vehicles AS COUNT(DISTINCT VEHICLE_ID) WITH SYNONYMS ('vehicles dwelling') COMMENT = 'Distinct vehicles with dwells'
    , sessions.unique_dwell_locations AS COUNT(DISTINCT LOCATION_ID) WITH SYNONYMS ('locations') COMMENT = 'Distinct dwell locations'
    , driver_dwell.total_sla_breaches AS SUM(d_sla_breach_count) WITH SYNONYMS ('SLA breaches', 'sla violations') COMMENT = 'Total SLA breaches across drivers'
    , driver_dwell.total_critical_breaches AS SUM(d_critical_breach_count) WITH SYNONYMS ('critical breaches') COMMENT = 'Total critical SLA breaches'
    , driver_dwell.driver_total_dwell_hours AS SUM(d_total_dwell_hours) COMMENT = 'Total dwell hours (driver summary)'
    , driver_dwell.avg_driver_session_min AS AVG(d_avg_session_min) COMMENT = 'Average per-driver session minutes'
  )

  COMMENT = 'Dwell analysis: vehicle dwell sessions (where/how long vehicles stop), facility utilization, H3 congestion, and per-driver SLA breaches.'

  AI_SQL_GENERATION 'Dwell analysis semantic view for the Route Optimisation & Fleet Intelligence solution.

Entities (two independent facts):
- sessions (DT_DWELL_ENRICHED): one row per dwell session (a vehicle stopped at a location). Use for dwell time, facility utilization (group by facility_type/city/location_name), and congestion (group by h3_cell).
- driver_dwell (DT_DRIVER_DWELL_SUMMARY): per-driver aggregates including SLA breach counts. Use for SLA / per-driver dwell questions.

Conventions:
- "congestion" / "heatmap" -> group sessions by h3_cell.
- "SLA breaches" / "violations" -> driver_dwell.total_sla_breaches or total_critical_breaches.
- "dwell time" -> sessions.total_dwell_minutes or avg_dwell_minutes.
- status values look like DWELL_WAREHOUSE, DWELL_STORE, DWELL_REST.'
;

-- ============ SV_ASSET_VELOCITY (rebound onto FLEET_APP.ROUTE_OPTIMIZATION.*) ============
-- SV_ASSET_VELOCITY - Route Optimization (asset velocity) semantic view
-- Source: FLEET_APP.ROUTE_OPTIMIZATION.VW_VEHICLE_COST_OF_IDLENESS + VW_LANE_DEMAND
-- Deploy target: FLEET_INTELLIGENCE.SEMANTIC (via fleet_test_evals connection)
-- GEOGRAPHY columns (LAST_LOCATION_GEOM, TERMINAL_GEOM) excluded. Two independent facts.

CREATE OR REPLACE SEMANTIC VIEW FLEET_INTELLIGENCE.SEMANTIC.SV_ASSET_VELOCITY

  TABLES (
    idle AS FLEET_APP.ROUTE_OPTIMIZATION.VW_VEHICLE_COST_OF_IDLENESS
      PRIMARY KEY (VEHICLE_ID)
    , lane AS FLEET_APP.ROUTE_OPTIMIZATION.VW_LANE_DEMAND
      PRIMARY KEY (TERMINAL_ID)
  )

  FACTS (
    idle.idle_minutes AS IDLE_MINUTES COMMENT = 'Minutes idle'
    , idle.idle_hours AS IDLE_HOURS COMMENT = 'Hours idle'
    , idle.idle_days AS IDLE_DAYS COMMENT = 'Days idle'
    , idle.cost_of_idleness_usd AS COST_OF_IDLENESS_USD COMMENT = 'Cost of idleness USD'
    , idle.projected_savings_usd AS PROJECTED_SAVINGS_USD COMMENT = 'Projected savings from repositioning USD'
    , idle.weight_tons AS WEIGHT_TONS COMMENT = 'Vehicle weight tons'
    , lane.outbound AS OUTBOUND COMMENT = 'Outbound trips (30-day)'
    , lane.inbound AS INBOUND COMMENT = 'Inbound trips (30-day)'
    , lane.net_outbound_trips AS NET_OUTBOUND_TRIPS COMMENT = 'Net outbound trips'
    , lane.demand_score AS DEMAND_SCORE COMMENT = 'Weighted demand score'
  )

  DIMENSIONS (
    idle.region AS REGION COMMENT = 'Operating region'
    , idle.last_location_name AS LAST_LOCATION_NAME WITH SYNONYMS ('parked at', 'location') COMMENT = 'Where the vehicle is parked'
    , idle.last_location_type AS LAST_LOCATION_TYPE COMMENT = 'Type of parking location'
    , idle.assigned_dispatcher AS ASSIGNED_DISPATCHER WITH SYNONYMS ('dispatcher') COMMENT = 'Assigned dispatcher'
    , idle.driver_profile AS DRIVER_PROFILE COMMENT = 'Driver profile'
    , idle.idle_severity AS IDLE_SEVERITY WITH SYNONYMS ('severity') COMMENT = 'Idle severity (OK/WATCH/WARNING/CRITICAL)'
    , idle.vehicle_subtype AS VEHICLE_SUBTYPE WITH SYNONYMS ('vehicle type', 'subtype') COMMENT = 'Vehicle subtype (e.g. DRY/REEFER/FLAT/TANKER for HGV)'
    , idle.hazmat AS HAZMAT COMMENT = 'Hazmat flag'
    , idle.ors_profile AS ORS_PROFILE COMMENT = 'Routing profile'
    , idle.vehicle_id AS VEHICLE_ID WITH SYNONYMS ('vehicle', 'vehicle id', 'asset', 'trailer') COMMENT = 'Vehicle/asset identifier'
    , lane.terminal_name AS TERMINAL_NAME WITH SYNONYMS ('terminal', 'depot') COMMENT = 'Terminal name'
    , lane.location_type AS LOCATION_TYPE COMMENT = 'Terminal location type'
  )

  METRICS (
    idle.idle_vehicle_count AS COUNT(DISTINCT VEHICLE_ID) WITH SYNONYMS ('number of idle vehicles', 'idle vehicles', 'idle trailers') COMMENT = 'Distinct idle vehicles'
    , idle.total_cost_of_idleness AS SUM(cost_of_idleness_usd) WITH SYNONYMS ('total idle cost', 'cost of idleness') COMMENT = 'Total cost of idleness (USD)'
    , idle.total_projected_savings AS SUM(projected_savings_usd) WITH SYNONYMS ('potential savings') COMMENT = 'Total projected savings (USD)'
    , idle.avg_idle_hours AS AVG(idle_hours) COMMENT = 'Average idle hours'
    , idle.avg_idle_days AS AVG(idle_days) COMMENT = 'Average idle days'
    , idle.max_idle_days AS MAX(idle_days) WITH SYNONYMS ('longest idle') COMMENT = 'Maximum idle days'
    , lane.total_outbound AS SUM(outbound) COMMENT = 'Total outbound trips'
    , lane.total_inbound AS SUM(inbound) COMMENT = 'Total inbound trips'
    , lane.total_net_outbound AS SUM(net_outbound_trips) WITH SYNONYMS ('net demand') COMMENT = 'Total net outbound trips'
    , lane.avg_demand_score AS AVG(demand_score) COMMENT = 'Average demand score'
  )

  COMMENT = 'Asset velocity (Route Optimization): idle vehicles with cost of idleness and projected savings, plus terminal lane demand for repositioning.'

  AI_SQL_GENERATION 'Asset velocity semantic view.
Entities (two independent facts):
- idle (VW_VEHICLE_COST_OF_IDLENESS): one row per idle vehicle with cost/savings and idle duration. Use for idle fleet, cost of idleness, projected savings; group by idle_severity, region, vehicle_subtype.
- lane (VW_LANE_DEMAND): terminal-level demand for repositioning idle assets; use total_net_outbound to find reposition target terminals.
Conventions:
- "idle vehicles over N days" -> filter idle_days; "cost of idleness" -> total_cost_of_idleness; "savings" -> total_projected_savings.
- "where to reposition" -> lane.total_net_outbound by terminal_name.'
;

-- ============ SV_LOCATION (FLEET_APP.LOCATION.*) ============
-- SV_LOCATION - location-diagnostics ESTATE semantic view (store facts only).
-- Source: FLEET_APP.LOCATION.VW_STORE_FACTS (store estate + synthetic commercials).
-- Deploy target: FLEET_INTELLIGENCE.SEMANTIC (via the fleet_test_evals connection).
-- NOTE: cannibalisation + closure are NOT modeled here - they are computed LIVE by the
-- app (calling ORS ISOCHRONES on each interaction; see Architecture Tenet 9), so there
-- is no materialized table for Cortex Analyst to query. This view covers the estate
-- (how many stores, revenue/EBITDA, household base) which the agent CAN answer via SQL.
-- Revenue/EBITDA/interaction-mix/rent are SYNTHETIC proxies (see analytic_layer.sql).

CREATE OR REPLACE SEMANTIC VIEW FLEET_INTELLIGENCE.SEMANTIC.SV_LOCATION

  TABLES (
    stores AS FLEET_APP.LOCATION.VW_STORE_FACTS
      PRIMARY KEY (REGION, STORE_ID)
  )

  FACTS (
    stores.annual_revenue AS ANNUAL_REVENUE COMMENT = 'Synthetic annual revenue'
    , stores.annual_ebitda AS ANNUAL_EBITDA COMMENT = 'Synthetic annual EBITDA'
    , stores.reference_hh AS REFERENCE_HH COMMENT = 'Household base (nearest-store Voronoi territory)'
    , stores.sqft AS SQFT COMMENT = 'Synthetic store floor area (sqft)'
    , stores.annual_rent AS ANNUAL_RENT COMMENT = 'Synthetic annual rent'
    , stores.value_per_cost AS VALUE_PER_COST COMMENT = 'Revenue per unit of rent cost'
  )

  DIMENSIONS (
    stores.store_id AS STORE_ID WITH SYNONYMS ('store', 'site') COMMENT = 'Store identifier'
    , stores.store_name AS POI_NAME WITH SYNONYMS ('store name', 'site name') COMMENT = 'Store name'
    , stores.store_role AS STORE_ROLE WITH SYNONYMS ('role', 'owned or candidate') COMMENT = 'OWNED (existing estate) or CANDIDATE (proposed new site)'
    , stores.store_category AS CATEGORY WITH SYNONYMS ('category', 'format') COMMENT = 'Store category'
    , stores.store_region AS REGION COMMENT = 'Region'
  )

  METRICS (
    stores.store_count AS COUNT(DISTINCT STORE_ID) WITH SYNONYMS ('number of stores', 'store count') COMMENT = 'Distinct stores'
    , stores.total_revenue AS SUM(annual_revenue) WITH SYNONYMS ('total revenue') COMMENT = 'Total synthetic annual revenue'
    , stores.total_ebitda AS SUM(annual_ebitda) WITH SYNONYMS ('total ebitda') COMMENT = 'Total synthetic annual EBITDA'
    , stores.total_households AS SUM(reference_hh) WITH SYNONYMS ('total households', 'catchment households') COMMENT = 'Total household base across the estate'
    , stores.avg_value_per_cost AS AVG(value_per_cost) WITH SYNONYMS ('value for money', 'revenue per rent') COMMENT = 'Average revenue per unit of rent'
  )

  COMMENT = 'Location diagnostics estate: store estate (OWNED/CANDIDATE) with synthetic commercials and household base. Cannibalisation and closure are computed live in-app (ORS), not modeled here.'

  AI_SQL_GENERATION 'Location-diagnostics ESTATE semantic view (store-level facts only).
- stores (VW_STORE_FACTS): one row per store. store_role = OWNED (existing) or CANDIDATE (proposed). Use total_revenue/total_ebitda/total_households/store_count/avg_value_per_cost grouped by store_role or store_category. Commercials are synthetic proxies.
Conventions:
- "how many stores" -> store_count; "total revenue/ebitda" -> total_revenue/total_ebitda grouped by store_role.
- "best value stores" -> avg_value_per_cost or store_name ordered by value_per_cost.
IMPORTANT: cannibalisation ("how much would a new site take from the estate") and closure ("who inherits a closed store") are computed LIVE in the Site Impact / Closure Impact app pages (ORS drive-time), not in this view. Direct such questions to those pages / the routing tools; this view answers estate composition only.'
;
