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

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","module":"sv-fleet-ops"}}';

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
