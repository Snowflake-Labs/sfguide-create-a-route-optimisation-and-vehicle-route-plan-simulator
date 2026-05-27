-- =============================================================================
-- deploy-semantic-view.sql
-- Creates FLEET_ANALYTICS_VIEW semantic view for the Agent Playground.
-- Run BEFORE configure-agent.sql.
-- =============================================================================

USE ROLE ACCOUNTADMIN;
USE WAREHOUSE ROUTING_ANALYTICS;

CREATE OR REPLACE SEMANTIC VIEW FLEET_INTELLIGENCE.ROUTING_AGENT.FLEET_ANALYTICS_VIEW
  TABLES (
    trips AS SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS PRIMARY KEY (TRIP_ID),
    telemetry AS SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY PRIMARY KEY (TELEMETRY_ID),
    fleet AS SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET PRIMARY KEY (VEHICLE_ID),
    pois AS SYNTHETIC_DATASETS.UNIFIED.DIM_POIS PRIMARY KEY (LOCATION_ID)
  )
  RELATIONSHIPS (
    trips(VEHICLE_ID) REFERENCES fleet,
    trips(ORIGIN_POI_ID) REFERENCES pois,
    telemetry(VEHICLE_ID) REFERENCES fleet
  )
  FACTS (
    trips.distance_km AS DISTANCE_KM COMMENT = 'Trip distance in km',
    trips.duration_min AS DURATION_MINUTES COMMENT = 'Trip duration in minutes',
    trips.pickup_wait AS PICKUP_WAIT_MINUTES COMMENT = 'Wait at pickup in minutes',
    trips.delivery_wait AS DELIVERY_WAIT_MINUTES COMMENT = 'Wait at delivery in minutes',
    telemetry.speed AS SPEED_KMH COMMENT = 'Vehicle speed km/h',
    telemetry.battery AS BATTERY_PCT COMMENT = 'Battery charge percentage 0-100',
    telemetry.odometer AS ODOMETER_KM COMMENT = 'Cumulative distance driven km'
  )
  DIMENSIONS (
    trips.vehicle_type AS trips.VEHICLE_TYPE WITH SYNONYMS = ('fleet type', 'transport mode') COMMENT = 'Vehicle type: ebike, taxi, hgv',
    trips.region AS trips.REGION WITH SYNONYMS = ('city', 'area') COMMENT = 'Geographic region',
    trips.trip_status AS trips.STATUS WITH SYNONYMS = ('trip status', 'delivery status') COMMENT = 'Trip status: COMPLETED',
    trips.ors_profile AS trips.ORS_PROFILE WITH SYNONYMS = ('routing profile') COMMENT = 'ORS routing profile',
    trips.is_detour AS trips.IS_DETOUR WITH SYNONYMS = ('detour', 'deviation', 'off route') COMMENT = 'Whether trip had route deviation',
    trips.trip_start AS trips.TRIP_START WITH SYNONYMS = ('date', 'start time', 'when') COMMENT = 'Trip start timestamp',
    trips.trip_date AS DATE_TRUNC('day', trips.TRIP_START) WITH SYNONYMS = ('day', 'trip date') COMMENT = 'Trip date',
    trips.trip_hour AS HOUR(trips.TRIP_START) WITH SYNONYMS = ('hour', 'time of day') COMMENT = 'Hour of day 0-23',
    fleet.vehicle_name AS fleet.VEHICLE_NAME WITH SYNONYMS = ('driver', 'courier', 'vehicle') COMMENT = 'Vehicle/driver name',
    fleet.capacity AS fleet.CAPACITY_KG WITH SYNONYMS = ('load capacity') COMMENT = 'Vehicle capacity kg',
    pois.poi_name AS pois.NAME WITH SYNONYMS = ('restaurant', 'place', 'POI', 'location') COMMENT = 'Point of interest name',
    pois.poi_category AS pois.CATEGORY WITH SYNONYMS = ('POI type', 'business type') COMMENT = 'POI category',
    pois.location_type AS pois.LOCATION_TYPE WITH SYNONYMS = ('POI classification') COMMENT = 'Location classification',
    telemetry.vehicle_status AS telemetry.STATUS WITH SYNONYMS = ('state', 'activity', 'what is vehicle doing') COMMENT = 'MOVING, DWELL_ORIGIN, DWELL_DESTINATION, DWELL_RECHARGE, IDLE',
    telemetry.is_speeding AS telemetry.IS_SPEEDING WITH SYNONYMS = ('speeding', 'over limit', 'speed violation') COMMENT = 'Whether exceeding speed limit',
    telemetry.is_detour_point AS telemetry.IS_DETOUR WITH SYNONYMS = ('off route point') COMMENT = 'Whether GPS point was off planned route',
    telemetry.location_type AS telemetry.LOCATION_TYPE WITH SYNONYMS = ('stop type', 'dwell location') COMMENT = 'Type of dwell location'
  )
  METRICS (
    trips.total_trips AS COUNT(trips.TRIP_ID) WITH SYNONYMS = ('trip count', 'deliveries', 'number of trips') COMMENT = 'Total trips',
    trips.avg_distance_km AS AVG(trips.distance_km) WITH SYNONYMS = ('average distance') COMMENT = 'Average trip distance km',
    trips.avg_duration_min AS AVG(trips.duration_min) WITH SYNONYMS = ('average duration', 'delivery time') COMMENT = 'Average trip duration minutes',
    trips.total_distance_km AS SUM(trips.distance_km) WITH SYNONYMS = ('total km', 'fleet mileage') COMMENT = 'Total fleet distance km',
    trips.detour_rate AS AVG(CASE WHEN trips.IS_DETOUR THEN 1.0 ELSE 0.0 END) WITH SYNONYMS = ('deviation rate', 'off-route rate') COMMENT = 'Fraction of trips with detours',
    fleet.active_vehicles AS COUNT(DISTINCT fleet.VEHICLE_ID) WITH SYNONYMS = ('fleet size', 'vehicle count', 'active couriers') COMMENT = 'Active vehicle count',
    telemetry.total_readings AS COUNT(telemetry.TELEMETRY_ID) WITH SYNONYMS = ('GPS points', 'telemetry count') COMMENT = 'Total telemetry readings',
    telemetry.avg_speed AS AVG(telemetry.speed) WITH SYNONYMS = ('average speed', 'mean speed') COMMENT = 'Average vehicle speed km/h',
    telemetry.speeding_events AS SUM(CASE WHEN telemetry.IS_SPEEDING THEN 1 ELSE 0 END) WITH SYNONYMS = ('speed violations', 'speeding count') COMMENT = 'Number of speeding events',
    telemetry.avg_battery AS AVG(telemetry.battery) WITH SYNONYMS = ('average battery', 'mean charge') COMMENT = 'Average battery percentage'
  )
  COMMENT = 'Fleet intelligence analytics covering trips, telemetry, vehicles, and POIs. Supports trip performance, speed/compliance, dwell time, battery monitoring, and delivery metrics across all demos.'
  AI_SQL_GENERATION 'Round numeric results to 1 decimal. Use TRIM(pois.NAME, chr(34)) for POI names. For percentages multiply by 100 and add %. Group by VEHICLE_NAME for vehicle comparison.'
  AI_VERIFIED_QUERIES (
    trips_by_day AS (
      QUESTION 'How many trips were completed each day?'
      VERIFIED_AT 1748200000
      VERIFIED_BY '(STEWARD = fleet_admin)'
      SQL 'SELECT DATE_TRUNC(''day'', TRIP_START) AS TRIP_DATE, COUNT(*) AS TOTAL_TRIPS FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS GROUP BY TRIP_DATE ORDER BY TRIP_DATE'
    ),
    top_vehicles AS (
      QUESTION 'Which vehicles completed the most trips?'
      VERIFIED_AT 1748200000
      VERIFIED_BY '(STEWARD = fleet_admin)'
      SQL 'SELECT t.VEHICLE_ID, f.VEHICLE_NAME, COUNT(*) AS TRIP_COUNT, ROUND(AVG(t.DISTANCE_KM),1) AS AVG_KM, ROUND(AVG(t.DURATION_MINUTES),1) AS AVG_MIN FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS t JOIN SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET f ON t.VEHICLE_ID=f.VEHICLE_ID GROUP BY t.VEHICLE_ID, f.VEHICLE_NAME ORDER BY TRIP_COUNT DESC LIMIT 10'
    ),
    busiest_pois AS (
      QUESTION 'Which locations have the most pickups?'
      VERIFIED_AT 1748200000
      VERIFIED_BY '(STEWARD = fleet_admin)'
      SQL 'SELECT TRIM(p.NAME, chr(34)) AS POI_NAME, p.CATEGORY, COUNT(*) AS PICKUPS FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS t JOIN SYNTHETIC_DATASETS.UNIFIED.DIM_POIS p ON t.ORIGIN_POI_ID=p.LOCATION_ID GROUP BY p.NAME, p.CATEGORY ORDER BY PICKUPS DESC LIMIT 10'
    ),
    speed_compliance AS (
      QUESTION 'What is the speeding rate by vehicle?'
      VERIFIED_AT 1748200000
      VERIFIED_BY '(STEWARD = fleet_admin)'
      SQL 'SELECT t.VEHICLE_ID, f.VEHICLE_NAME, COUNT(*) AS TOTAL_READINGS, SUM(CASE WHEN t.IS_SPEEDING THEN 1 ELSE 0 END) AS SPEEDING_EVENTS, ROUND(SUM(CASE WHEN t.IS_SPEEDING THEN 1 ELSE 0 END)*100.0/COUNT(*),1) AS SPEEDING_PCT FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY t JOIN SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET f ON t.VEHICLE_ID=f.VEHICLE_ID GROUP BY t.VEHICLE_ID, f.VEHICLE_NAME ORDER BY SPEEDING_PCT DESC LIMIT 10'
    ),
    vehicle_status_breakdown AS (
      QUESTION 'What percentage of time do vehicles spend moving vs dwelling vs idle?'
      VERIFIED_AT 1748200000
      VERIFIED_BY '(STEWARD = fleet_admin)'
      SQL 'SELECT STATUS, COUNT(*) AS READINGS, ROUND(COUNT(*)*100.0/(SELECT COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY),1) AS PCT FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY GROUP BY STATUS ORDER BY READINGS DESC'
    ),
    hourly_distribution AS (
      QUESTION 'What is the trip distribution by hour of day?'
      VERIFIED_AT 1748200000
      VERIFIED_BY '(STEWARD = fleet_admin)'
      SQL 'SELECT HOUR(TRIP_START) AS HOUR_OF_DAY, COUNT(*) AS TRIP_COUNT FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS GROUP BY HOUR_OF_DAY ORDER BY HOUR_OF_DAY'
    ),
    battery_by_vehicle AS (
      QUESTION 'Which vehicles have the lowest battery levels?'
      VERIFIED_AT 1748200000
      VERIFIED_BY '(STEWARD = fleet_admin)'
      SQL 'SELECT t.VEHICLE_ID, f.VEHICLE_NAME, ROUND(AVG(t.BATTERY_PCT),1) AS AVG_BATTERY, ROUND(MIN(t.BATTERY_PCT),1) AS MIN_BATTERY FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY t JOIN SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET f ON t.VEHICLE_ID=f.VEHICLE_ID GROUP BY t.VEHICLE_ID, f.VEHICLE_NAME ORDER BY AVG_BATTERY LIMIT 10'
    )
  );

SELECT 'FLEET_ANALYTICS_VIEW created' AS STATUS;
