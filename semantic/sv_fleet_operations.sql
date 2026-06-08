-- SV_FLEET_OPERATIONS — raw fleet operations semantic view
-- Source: SYNTHETIC_DATASETS.UNIFIED.V_*_CURRENT (active-dataset views written by Data Studio)
-- Deploy target: FLEET_INTELLIGENCE.SEMANTIC (via the fleet_test_evals connection)
-- Built with the semantic_skills toolkit (Phase 2 Build -> Phase 3 Deploy).
--
-- Patterns used:
--   - Multi-fact (trips + telemetry + schedule) sharing the fleet dimension
--   - Role-playing POI dimensions (trip_origin_pois / trip_dest_pois)
--   - COUNT_IF on physical boolean flags for rate metrics
-- Note: schedule does NOT join to trips (TRIP_ID != SCHEDULE_ID); it shares only fleet.

CREATE OR REPLACE SEMANTIC VIEW FLEET_INTELLIGENCE.SEMANTIC.SV_FLEET_OPERATIONS

  TABLES (
    trips AS SYNTHETIC_DATASETS.UNIFIED.V_FACT_TRIPS_CURRENT
      PRIMARY KEY (TRIP_ID)
    , telemetry AS SYNTHETIC_DATASETS.UNIFIED.V_FACT_VEHICLE_TELEMETRY_CURRENT
      PRIMARY KEY (TELEMETRY_ID)
    , schedule AS SYNTHETIC_DATASETS.UNIFIED.V_DIM_TRIP_SCHEDULE_CURRENT
      PRIMARY KEY (SCHEDULE_ID)
    , fleet AS SYNTHETIC_DATASETS.UNIFIED.V_DIM_FLEET_CURRENT
      PRIMARY KEY (VEHICLE_ID)
    , trip_origin_pois AS SYNTHETIC_DATASETS.UNIFIED.V_DIM_POIS_CURRENT
      PRIMARY KEY (LOCATION_ID)
      COMMENT = 'POI role: trip origin'
    , trip_dest_pois AS SYNTHETIC_DATASETS.UNIFIED.V_DIM_POIS_CURRENT
      PRIMARY KEY (LOCATION_ID)
      COMMENT = 'POI role: trip destination'
  )

  RELATIONSHIPS (
    trips_to_fleet AS trips(VEHICLE_ID) REFERENCES fleet(VEHICLE_ID)
    , telemetry_to_fleet AS telemetry(VEHICLE_ID) REFERENCES fleet(VEHICLE_ID)
    , schedule_to_fleet AS schedule(VEHICLE_ID) REFERENCES fleet(VEHICLE_ID)
    , trips_to_origin AS trips(ORIGIN_POI_ID) REFERENCES trip_origin_pois(LOCATION_ID)
    , trips_to_dest AS trips(DESTINATION_POI_ID) REFERENCES trip_dest_pois(LOCATION_ID)
  )

  FACTS (
    trips.distance_km AS DISTANCE_KM
      COMMENT = 'Actual trip distance in km'
    , trips.duration_minutes AS DURATION_MINUTES
      COMMENT = 'Actual trip duration in minutes'
    , trips.planned_distance_km AS PLANNED_DISTANCE_KM
      COMMENT = 'Planned (shortest) trip distance in km'
    , trips.detour_distance_km AS DETOUR_DISTANCE_KM
      COMMENT = 'Excess km vs planned route'
    , telemetry.speed_kmh AS SPEED_KMH
      COMMENT = 'Instantaneous GPS speed in km/h'
    , telemetry.posted_speed_kmh AS POSTED_SPEED_KMH
      COMMENT = 'Posted road speed limit in km/h'
    , telemetry.battery_pct AS BATTERY_PCT
      COMMENT = 'Battery level percent (e-vehicles)'
    , schedule.sched_distance_km AS DISTANCE_KM
      COMMENT = 'Planned schedule distance in km'
    , schedule.sched_duration_minutes AS DURATION_MINUTES
      COMMENT = 'Planned schedule duration in minutes'
  )

  DIMENSIONS (
    fleet.region AS REGION
      WITH SYNONYMS ('city', 'area', 'geography', 'location region')
      COMMENT = 'Operating region (e.g. SanFrancisco, Germany)'
    , fleet.vehicle_type AS VEHICLE_TYPE
      WITH SYNONYMS ('vehicle class', 'fleet type', 'mode')
      COMMENT = 'Vehicle type (ebike, car, hgv, taxi, etc.)'
    , fleet.vehicle_subtype AS VEHICLE_SUBTYPE
      COMMENT = 'Vehicle subtype (DRY, REEFER, FLAT, TANKER)'
    , fleet.ors_profile AS ORS_PROFILE
      COMMENT = 'Routing profile (driving-car, cycling-electric, driving-hgv)'
    , fleet.shift_type AS SHIFT_TYPE
      WITH SYNONYMS ('shift', 'shift pattern')
      COMMENT = 'Driver shift pattern'
    , fleet.driver_profile AS DRIVER_PROFILE
      WITH SYNONYMS ('driver behavior', 'driver type')
      COMMENT = 'Driver profile (COMPLIANT, AGGRESSIVE, OUTLIER)'
    , fleet.operating_mode AS OPERATING_MODE
      COMMENT = 'Operating mode of the vehicle'
    , fleet.hazmat AS HAZMAT
      COMMENT = 'Whether the vehicle carries hazardous materials'
    , trips.trip_status AS STATUS
      WITH SYNONYMS ('trip state')
      COMMENT = 'Trip status'
    , trips.trip_start AS TRIP_START
      WITH SYNONYMS ('trip start time', 'departure time')
      COMMENT = 'Trip start timestamp'
    , telemetry.movement_status AS STATUS
      WITH SYNONYMS ('vehicle state', 'gps status')
      COMMENT = 'Telemetry status (MOVING, IDLE, DWELL_ORIGIN, DWELL_DESTINATION, DWELL_REST, etc.)'
    , telemetry.location_type AS LOCATION_TYPE
      WITH SYNONYMS ('place type')
      COMMENT = 'POI type at the vehicle current position'
    , telemetry.ts AS TS
      WITH SYNONYMS ('timestamp', 'gps time')
      COMMENT = 'GPS ping timestamp'
    , schedule.trip_date AS TRIP_DATE
      WITH SYNONYMS ('scheduled date', 'planned date')
      COMMENT = 'Planned trip date'
    , schedule.sched_shift_type AS SHIFT_TYPE
      COMMENT = 'Planned shift type'
    , trip_origin_pois.origin_name AS NAME
      WITH SYNONYMS ('origin', 'pickup location', 'start point')
      COMMENT = 'Trip origin POI name'
    , trip_origin_pois.origin_type AS LOCATION_TYPE
      COMMENT = 'Trip origin POI type'
    , trip_dest_pois.destination_name AS NAME
      WITH SYNONYMS ('destination', 'dropoff location', 'end point')
      COMMENT = 'Trip destination POI name'
    , trip_dest_pois.destination_type AS LOCATION_TYPE
      COMMENT = 'Trip destination POI type'
  )

  METRICS (
    trips.total_trips AS COUNT(DISTINCT TRIP_ID)
      WITH SYNONYMS ('number of trips', 'trip count')
      COMMENT = 'Distinct count of actual trips'
    , trips.total_distance_km AS SUM(distance_km)
      WITH SYNONYMS ('total km driven', 'total distance')
      COMMENT = 'Total actual distance driven (km)'
    , trips.avg_distance_km AS AVG(distance_km)
      COMMENT = 'Average actual trip distance (km)'
    , trips.total_duration_min AS SUM(duration_minutes)
      COMMENT = 'Total actual trip duration (minutes)'
    , trips.avg_duration_min AS AVG(duration_minutes)
      COMMENT = 'Average actual trip duration (minutes)'
    , trips.total_planned_distance_km AS SUM(planned_distance_km)
      COMMENT = 'Total planned distance (km)'
    , trips.total_detour_distance_km AS SUM(detour_distance_km)
      WITH SYNONYMS ('total excess km')
      COMMENT = 'Total excess km from detours'
    , trips.avg_detour_distance_km AS AVG(detour_distance_km)
      COMMENT = 'Average excess km per trip'
    , trips.detour_trip_count AS COUNT_IF(IS_DETOUR)
      WITH SYNONYMS ('number of detours', 'detour trips')
      COMMENT = 'Count of trips flagged as detours'
    , trips.detour_rate_pct AS DIV0(COUNT_IF(IS_DETOUR), COUNT(*)) * 100
      WITH SYNONYMS ('detour percentage', 'percent of trips that detoured')
      COMMENT = 'Percent of trips flagged as detours'
    , telemetry.total_gps_points AS COUNT(DISTINCT TELEMETRY_ID)
      WITH SYNONYMS ('telemetry points', 'gps pings')
      COMMENT = 'Count of GPS telemetry points'
    , telemetry.avg_speed_kmh AS AVG(speed_kmh)
      WITH SYNONYMS ('average speed')
      COMMENT = 'Average GPS speed (km/h)'
    , telemetry.max_speed_kmh AS MAX(speed_kmh)
      WITH SYNONYMS ('top speed', 'highest speed')
      COMMENT = 'Maximum GPS speed (km/h)'
    , telemetry.speeding_points AS COUNT_IF(IS_SPEEDING)
      WITH SYNONYMS ('speeding events', 'number of speeding points')
      COMMENT = 'Count of telemetry points where the vehicle was speeding'
    , telemetry.speeding_rate_pct AS DIV0(COUNT_IF(IS_SPEEDING), COUNT(*)) * 100
      WITH SYNONYMS ('speeding percentage', 'percent speeding')
      COMMENT = 'Percent of telemetry points where the vehicle was speeding'
    , telemetry.hos_violation_points AS COUNT_IF(IS_HOS_VIOLATION)
      WITH SYNONYMS ('hours of service violations', 'HOS violations')
      COMMENT = 'Count of telemetry points with an hours-of-service violation'
    , telemetry.avg_battery_pct AS AVG(battery_pct)
      COMMENT = 'Average battery level percent'
    , schedule.total_scheduled_trips AS COUNT(DISTINCT SCHEDULE_ID)
      WITH SYNONYMS ('number of scheduled trips', 'planned trips')
      COMMENT = 'Distinct count of planned/scheduled trips'
    , schedule.total_sched_distance_km AS SUM(sched_distance_km)
      COMMENT = 'Total planned distance across scheduled trips (km)'
    , schedule.total_sched_duration_min AS SUM(sched_duration_minutes)
      COMMENT = 'Total planned duration across scheduled trips (minutes)'
  )

  COMMENT = 'Raw fleet operations from the Data Studio unified telemetry/trips/schedule dataset. Always reflects the currently active dataset(s). Covers actual GPS telemetry (speed, speeding, HOS violations, dwell status), actual trips (distance, duration, detours), and planned schedules, broken down by region, vehicle type, driver profile, shift, and origin/destination POI.'

  AI_SQL_GENERATION 'This semantic view models raw fleet movement data generated by Data Studio in the Route Optimisation & Fleet Intelligence solution.

Entities:
- trips: one row per actual completed trip (distance, duration, detour info).
- telemetry: one row per GPS ping (speed, speeding flag, HOS violation flag, movement/dwell status).
- schedule: one row per PLANNED trip (planned distance/duration, trip_date). Note: schedule does NOT join to trips (no shared trip key); it shares only the fleet (vehicle) dimension. Use schedule metrics for planned/dispatch questions and trips metrics for actual-execution questions.
- fleet: the vehicle/driver dimension shared by all three facts. region and vehicle_type live here.
- trip_origin_pois / trip_dest_pois: role-playing aliases of the POI table for a trip''s origin and destination.

Conventions:
- region values look like SanFrancisco, Germany. vehicle_type values look like ebike, car, hgv, taxi.
- For "detour rate" use detour_rate_pct; for raw counts use detour_trip_count.
- For speeding use speeding_points or speeding_rate_pct; telemetry is point-grained, trips is trip-grained — do not mix telemetry metrics with trip metrics in one grouping unless grouping only by shared fleet dimensions (region, vehicle_type, driver_profile, shift_type).
- "average speed" = telemetry.avg_speed_kmh; "top speed" = telemetry.max_speed_kmh.
- Planned vs actual distance: trips.total_planned_distance_km and trips.total_distance_km are both on the trips fact (use these for planned-vs-actual on executed trips). schedule.* metrics are the dispatch plan, a separate grain.'
;
