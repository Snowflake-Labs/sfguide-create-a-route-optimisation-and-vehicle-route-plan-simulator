-- SV_TAXIS — Fleet Taxis demo semantic view
-- Source: FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.VW_TRIP_SUMMARY
-- Deploy target: FLEET_INTELLIGENCE.SEMANTIC (via fleet_test_evals connection)
-- GEOMETRY/ORIGIN/DESTINATION GEOGRAPHY columns excluded. Distance(m)/duration(s) converted in metrics.

CREATE OR REPLACE SEMANTIC VIEW FLEET_INTELLIGENCE.SEMANTIC.SV_TAXIS

  TABLES (
    trips AS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.VW_TRIP_SUMMARY
      PRIMARY KEY (TRIP_ID)
  )

  FACTS (
    trips.route_distance_meters AS ROUTE_DISTANCE_METERS COMMENT = 'Trip distance in meters'
    , trips.route_duration_secs AS ROUTE_DURATION_SECS COMMENT = 'Trip duration in seconds'
    , trips.average_kmh AS AVERAGE_KMH COMMENT = 'Average speed km/h'
    , trips.max_kmh AS MAX_KMH COMMENT = 'Max speed km/h'
  )

  DIMENSIONS (
    trips.driver_id AS DRIVER_ID WITH SYNONYMS ('driver') COMMENT = 'Taxi driver id'
    , trips.region AS REGION WITH SYNONYMS ('city') COMMENT = 'Region'
    , trips.shift_type AS SHIFT_TYPE WITH SYNONYMS ('shift') COMMENT = 'Shift (Morning/Afternoon/Night)'
    , trips.origin_address AS ORIGIN_ADDRESS WITH SYNONYMS ('pickup', 'origin') COMMENT = 'Trip origin address'
    , trips.destination_address AS DESTINATION_ADDRESS WITH SYNONYMS ('dropoff', 'destination') COMMENT = 'Trip destination address'
    , trips.trip_start_time AS TRIP_START_TIME WITH SYNONYMS ('start time', 'pickup time') COMMENT = 'Trip start timestamp'
  )

  METRICS (
    trips.total_trips AS COUNT(DISTINCT TRIP_ID) WITH SYNONYMS ('number of trips', 'trip count', 'rides') COMMENT = 'Distinct taxi trips'
    , trips.active_drivers AS COUNT(DISTINCT DRIVER_ID) WITH SYNONYMS ('number of drivers') COMMENT = 'Distinct active drivers'
    , trips.total_distance_km AS SUM(route_distance_meters) / 1000.0 WITH SYNONYMS ('total distance') COMMENT = 'Total trip distance (km)'
    , trips.avg_distance_km AS AVG(route_distance_meters) / 1000.0 COMMENT = 'Average trip distance (km)'
    , trips.avg_duration_min AS AVG(route_duration_secs) / 60.0 WITH SYNONYMS ('average trip time') COMMENT = 'Average trip duration (minutes)'
    , trips.avg_speed_kmh AS AVG(average_kmh) WITH SYNONYMS ('average speed') COMMENT = 'Average speed (km/h)'
    , trips.max_speed_kmh AS MAX(max_kmh) WITH SYNONYMS ('top speed') COMMENT = 'Maximum speed (km/h)'
  )

  COMMENT = 'Fleet Taxis demo: trip-level taxi telemetry summary (distance, duration, speed) by driver, shift, region, and route.'

  AI_SQL_GENERATION 'Fleet Taxis semantic view. One fact: trips (VW_TRIP_SUMMARY), one row per taxi trip.
Distance is stored in meters and duration in seconds; the provided metrics already convert to km and minutes. Use total_trips for ride counts, avg_speed_kmh/max_speed_kmh for speed, group by shift_type or driver_id.'
;
