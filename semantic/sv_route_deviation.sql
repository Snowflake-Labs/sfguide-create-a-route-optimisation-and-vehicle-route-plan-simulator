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
