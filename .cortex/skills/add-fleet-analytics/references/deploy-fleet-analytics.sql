-- =============================================================================
-- deploy-fleet-analytics.sql
-- Creates FLEET_TRIPS_SV and FLEET_TELEMETRY_SV semantic views and adds
-- fleet_trips + fleet_telemetry Cortex Analyst tools to ROUTING_AGENT.
-- =============================================================================

USE ROLE ACCOUNTADMIN;
USE WAREHOUSE ROUTING_ANALYTICS;
USE DATABASE FLEET_INTELLIGENCE;

-- =============================================================================
-- 1. FLEET TRIPS SEMANTIC VIEW
--    FACT_TRIPS: TRIP_ID, VEHICLE_ID, VEHICLE_TYPE, TRIP_START, TRIP_END,
--                DISTANCE_KM, DURATION_MINUTES, STATUS, ORS_PROFILE,
--                IS_DETOUR, DETOUR_DISTANCE_KM, PLANNED_DISTANCE_KM,
--                ORIGIN_POI_ID, PICKUP_WAIT_MINUTES, DELIVERY_WAIT_MINUTES
--    DIM_FLEET:  VEHICLE_ID, REGION, VEHICLE_TYPE, VEHICLE_NAME, ORS_PROFILE, CAPACITY_KG
--    DIM_POIS:   LOCATION_ID, REGION, NAME, LOCATION_TYPE, CATEGORY
-- =============================================================================

CREATE OR REPLACE SEMANTIC VIEW FLEET_INTELLIGENCE.PUBLIC.FLEET_TRIPS_SV
    TABLES (
        trips AS SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS PRIMARY KEY (TRIP_ID),
        fleet AS SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET PRIMARY KEY (VEHICLE_ID),
        pois AS SYNTHETIC_DATASETS.UNIFIED.DIM_POIS PRIMARY KEY (LOCATION_ID)
    )
    RELATIONSHIPS (
        trips(VEHICLE_ID) REFERENCES fleet,
        trips(ORIGIN_POI_ID) REFERENCES pois
    )
    FACTS (
        trips.DISTANCE_KM AS DISTANCE_KM COMMENT = 'Trip distance km',
        trips.DURATION_MINUTES AS DURATION_MINUTES COMMENT = 'Trip duration minutes',
        trips.DETOUR_DISTANCE_KM AS DETOUR_DISTANCE_KM COMMENT = 'Extra distance from detour km',
        fleet.CAPACITY_KG AS CAPACITY_KG COMMENT = 'Vehicle capacity kg'
    )
    DIMENSIONS (
        trips.TRIP_ID AS TRIP_ID COMMENT = 'Trip identifier',
        trips.VEHICLE_ID AS VEHICLE_ID COMMENT = 'Vehicle identifier',
        trips.VEHICLE_TYPE AS VEHICLE_TYPE WITH SYNONYMS = ('mode', 'transport type', 'fleet type', 'courier type') COMMENT = 'ebike or hgv',
        trips.STATUS AS STATUS WITH SYNONYMS = ('trip status', 'completion') COMMENT = 'COMPLETED IN_PROGRESS CANCELLED',
        trips.IS_DETOUR AS IS_DETOUR WITH SYNONYMS = ('detour', 'deviation') COMMENT = 'Whether trip had a detour',
        trips.ORS_PROFILE AS ORS_PROFILE WITH SYNONYMS = ('routing mode') COMMENT = 'Routing profile',
        trips.TRIP_START AS TRIP_START WITH SYNONYMS = ('start time', 'date', 'when', 'hour of day') COMMENT = 'Trip start timestamp',
        fleet.REGION AS REGION WITH SYNONYMS = ('city', 'area', 'location') COMMENT = 'Geographic region: SanFrancisco Cambridge Barcelona',
        fleet.VEHICLE_NAME AS VEHICLE_NAME WITH SYNONYMS = ('courier', 'driver', 'vehicle') COMMENT = 'Vehicle name',
        pois.NAME AS NAME WITH SYNONYMS = ('pickup', 'restaurant', 'origin', 'start location') COMMENT = 'Origin point of interest name',
        pois.LOCATION_TYPE AS LOCATION_TYPE WITH SYNONYMS = ('pickup type', 'origin type') COMMENT = 'RESTAURANT WAREHOUSE REST_STOP',
        pois.CATEGORY AS CATEGORY WITH SYNONYMS = ('cuisine', 'food type') COMMENT = 'POI category'
    )
    METRICS (
        TOTAL_TRIPS AS COUNT(trips.TRIP_ID) WITH SYNONYMS = ('trip count', 'deliveries', 'number of trips') COMMENT = 'Total trips',
        ACTIVE_VEHICLES AS COUNT(DISTINCT trips.VEHICLE_ID) WITH SYNONYMS = ('fleet size', 'vehicle count') COMMENT = 'Active vehicles',
        AVG_TRIP_DISTANCE_KM AS AVG(trips.DISTANCE_KM) WITH SYNONYMS = ('average distance', 'mean distance') COMMENT = 'Average trip distance km',
        AVG_TRIP_DURATION_MINUTES AS AVG(trips.DURATION_MINUTES) WITH SYNONYMS = ('average duration', 'mean trip time') COMMENT = 'Average trip duration minutes',
        TOTAL_DISTANCE_KM AS SUM(trips.DISTANCE_KM) WITH SYNONYMS = ('total km', 'fleet mileage') COMMENT = 'Total fleet distance km',
        DETOUR_COUNT AS SUM(CASE WHEN trips.IS_DETOUR THEN 1 ELSE 0 END) WITH SYNONYMS = ('deviations', 'detours') COMMENT = 'Trips with detours'
    )
    COMMENT = 'Fleet trip analytics. Trips, distances, durations, vehicle performance, hourly demand, busiest POIs, detour analysis.'
    AI_VERIFIED_QUERIES (
      trip_overview AS (
        QUESTION 'Give me an overview of the fleet: total trips, average distance, and active vehicles'
        SQL 'SELECT COUNT(TRIP_ID) AS TOTAL_TRIPS, ROUND(AVG(DISTANCE_KM),2) AS AVG_DISTANCE_KM, ROUND(AVG(DURATION_MINUTES),1) AS AVG_DURATION_MINS, COUNT(DISTINCT VEHICLE_ID) AS ACTIVE_VEHICLES FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS'
      ),
      trips_by_type AS (
        QUESTION 'How many trips were made by each vehicle type?'
        SQL 'SELECT VEHICLE_TYPE, COUNT(TRIP_ID) AS TOTAL_TRIPS, ROUND(AVG(DISTANCE_KM),2) AS AVG_DISTANCE_KM FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS GROUP BY VEHICLE_TYPE ORDER BY TOTAL_TRIPS DESC'
      ),
      hourly_distribution AS (
        QUESTION 'What is the trip distribution by hour of day? When is peak demand?'
        SQL 'SELECT HOUR(TRIP_START) AS HOUR_OF_DAY, COUNT(TRIP_ID) AS TRIPS FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS WHERE TRIP_START IS NOT NULL GROUP BY HOUR(TRIP_START) ORDER BY HOUR_OF_DAY'
      ),
      top_vehicles AS (
        QUESTION 'Which vehicles completed the most trips?'
        SQL 'SELECT VEHICLE_ID, VEHICLE_TYPE, COUNT(TRIP_ID) AS TRIPS, ROUND(AVG(DISTANCE_KM),2) AS AVG_KM FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS GROUP BY VEHICLE_ID, VEHICLE_TYPE ORDER BY TRIPS DESC LIMIT 10'
      ),
      busiest_pois AS (
        QUESTION 'Which pickup locations have the most orders?'
        SQL 'SELECT p.NAME, p.LOCATION_TYPE, COUNT(t.TRIP_ID) AS ORDERS FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS t JOIN SYNTHETIC_DATASETS.UNIFIED.DIM_POIS p ON t.ORIGIN_POI_ID = p.LOCATION_ID GROUP BY p.NAME, p.LOCATION_TYPE ORDER BY ORDERS DESC LIMIT 10'
      )
    )
SELECT 'FLEET_TRIPS_SV created' AS STATUS,
       COUNT(*) AS FACT_TRIP_ROWS
FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS;

-- =============================================================================
-- 2. FLEET TELEMETRY SEMANTIC VIEW
--    FACT_VEHICLE_TELEMETRY: TELEMETRY_ID, VEHICLE_ID, VEHICLE_TYPE, TRIP_ID,
--                            REGION, TS, SPEED_KMH, POSTED_SPEED_KMH, BATTERY_PCT,
--                            ODOMETER_KM, STATUS, IS_SPEEDING, IS_HOS_VIOLATION,
--                            IS_DETOUR, LOCATION_TYPE, ORS_PROFILE
--    DIM_FLEET: VEHICLE_ID, REGION, VEHICLE_TYPE, VEHICLE_NAME
-- =============================================================================

CREATE OR REPLACE SEMANTIC VIEW FLEET_INTELLIGENCE.PUBLIC.FLEET_TELEMETRY_SV
    TABLES (
        telemetry AS SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY PRIMARY KEY (TELEMETRY_ID),
        fleet AS SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET PRIMARY KEY (VEHICLE_ID)
    )
    RELATIONSHIPS (
        telemetry(VEHICLE_ID) REFERENCES fleet
    )
    FACTS (
        telemetry.SPEED_KMH AS SPEED_KMH WITH SYNONYMS = ('speed', 'velocity') COMMENT = 'Vehicle speed km/h',
        telemetry.POSTED_SPEED_KMH AS POSTED_SPEED_KMH WITH SYNONYMS = ('speed limit', 'limit') COMMENT = 'Posted speed limit km/h',
        telemetry.BATTERY_PCT AS BATTERY_PCT WITH SYNONYMS = ('battery', 'charge level') COMMENT = 'Battery level percentage',
        telemetry.ODOMETER_KM AS ODOMETER_KM WITH SYNONYMS = ('odometer', 'mileage') COMMENT = 'Cumulative distance km'
    )
    DIMENSIONS (
        telemetry.TELEMETRY_ID AS TELEMETRY_ID COMMENT = 'Reading identifier',
        telemetry.VEHICLE_ID AS VEHICLE_ID COMMENT = 'Vehicle identifier',
        telemetry.TRIP_ID AS TRIP_ID COMMENT = 'Trip identifier',
        telemetry.VEHICLE_TYPE AS VEHICLE_TYPE WITH SYNONYMS = ('mode', 'transport type') COMMENT = 'ebike or hgv',
        telemetry.REGION AS REGION WITH SYNONYMS = ('city', 'area') COMMENT = 'Geographic region',
        telemetry.STATUS AS STATUS WITH SYNONYMS = ('vehicle state', 'activity') COMMENT = 'MOVING DWELL_ORIGIN DWELL_DESTINATION DWELL_RECHARGE IDLE',
        telemetry.IS_SPEEDING AS IS_SPEEDING WITH SYNONYMS = ('speeding', 'speed violation', 'over limit') COMMENT = 'Whether exceeding speed limit',
        telemetry.IS_HOS_VIOLATION AS IS_HOS_VIOLATION WITH SYNONYMS = ('hos violation', 'hours of service', 'compliance') COMMENT = 'Hours-of-service violation',
        telemetry.IS_DETOUR AS IS_DETOUR WITH SYNONYMS = ('off route', 'deviation') COMMENT = 'Whether off planned route',
        telemetry.TS AS TS WITH SYNONYMS = ('timestamp', 'time', 'when') COMMENT = 'Reading timestamp',
        fleet.VEHICLE_NAME AS VEHICLE_NAME WITH SYNONYMS = ('courier', 'driver') COMMENT = 'Vehicle name'
    )
    METRICS (
        TOTAL_READINGS AS COUNT(telemetry.TELEMETRY_ID) WITH SYNONYMS = ('readings', 'records') COMMENT = 'Total telemetry readings',
        SPEEDING_EVENTS AS SUM(CASE WHEN telemetry.IS_SPEEDING THEN 1 ELSE 0 END) WITH SYNONYMS = ('speeding count', 'speed violations') COMMENT = 'Speeding events',
        HOS_VIOLATIONS AS SUM(CASE WHEN telemetry.IS_HOS_VIOLATION THEN 1 ELSE 0 END) WITH SYNONYMS = ('compliance violations', 'HOS violations') COMMENT = 'Hours-of-service violations',
        AVG_SPEED_KMH AS AVG(telemetry.SPEED_KMH) WITH SYNONYMS = ('average speed', 'mean speed') COMMENT = 'Average speed km/h',
        AVG_BATTERY_PCT AS AVG(telemetry.BATTERY_PCT) WITH SYNONYMS = ('average battery', 'mean charge') COMMENT = 'Average battery percentage',
        ACTIVE_VEHICLES AS COUNT(DISTINCT telemetry.VEHICLE_ID) WITH SYNONYMS = ('fleet size', 'vehicles tracked') COMMENT = 'Active vehicles'
    )
    COMMENT = 'Fleet telemetry analytics. Speed compliance, speeding events, HOS violations, battery levels, vehicle activity status.'
    AI_VERIFIED_QUERIES (
      speeding_by_type AS (
        QUESTION 'What is the speeding rate by vehicle type?'
        SQL 'SELECT VEHICLE_TYPE, SUM(CASE WHEN IS_SPEEDING THEN 1 ELSE 0 END) AS SPEEDING_EVENTS, COUNT(*) AS TOTAL_READINGS, ROUND(100.0*SUM(CASE WHEN IS_SPEEDING THEN 1 ELSE 0 END)/COUNT(*),1) AS SPEEDING_RATE_PCT FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY GROUP BY VEHICLE_TYPE ORDER BY SPEEDING_EVENTS DESC'
      ),
      battery_by_vehicle AS (
        QUESTION 'Which vehicles have the lowest battery levels?'
        SQL 'SELECT VEHICLE_ID, VEHICLE_TYPE, ROUND(AVG(BATTERY_PCT),1) AS AVG_BATTERY, MIN(BATTERY_PCT) AS MIN_BATTERY FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY GROUP BY VEHICLE_ID, VEHICLE_TYPE ORDER BY AVG_BATTERY ASC LIMIT 10'
      ),
      status_breakdown AS (
        QUESTION 'What is the breakdown of vehicle status across the fleet?'
        SQL 'SELECT STATUS, VEHICLE_TYPE, COUNT(*) AS READINGS FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY GROUP BY STATUS, VEHICLE_TYPE ORDER BY READINGS DESC'
      ),
      speeding_by_vehicle AS (
        QUESTION 'Which couriers have the most speed violations?'
        SQL 'SELECT t.VEHICLE_ID, f.VEHICLE_NAME, ROUND(100.0*SUM(CASE WHEN t.IS_SPEEDING THEN 1 ELSE 0 END)/COUNT(*),1) AS SPEEDING_RATE_PCT FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY t JOIN SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET f ON t.VEHICLE_ID=f.VEHICLE_ID GROUP BY t.VEHICLE_ID, f.VEHICLE_NAME ORDER BY SPEEDING_RATE_PCT DESC LIMIT 10'
      )
    )
SELECT 'FLEET_TELEMETRY_SV created' AS STATUS,
       COUNT(*) AS TELEMETRY_ROWS
FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY;

-- Run $setup-agent-playground to register all tools with the Routing Agent.
