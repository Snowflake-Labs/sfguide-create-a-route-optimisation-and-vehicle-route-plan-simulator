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
        trips AS SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS
            PRIMARY KEY (TRIP_ID)
            COMMENT = 'Individual fleet trip records with distances, durations, timing, and detour information.',
        fleet AS SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET
            PRIMARY KEY (VEHICLE_ID)
            COMMENT = 'Fleet vehicle configuration including region, vehicle type, and capacity.',
        pois AS SYNTHETIC_DATASETS.UNIFIED.DIM_POIS
            PRIMARY KEY (LOCATION_ID)
            COMMENT = 'Points of interest including restaurants, warehouses, and rest stops.'
    )
    RELATIONSHIPS (
        trips(VEHICLE_ID) REFERENCES fleet,
        trips(ORIGIN_POI_ID) REFERENCES pois
    )
    FACTS (
        trips.DISTANCE_KM AS DISTANCE_KM
            WITH SYNONYMS = ('distance', 'km', 'kilometres', 'how far', 'trip distance')
            COMMENT = 'Actual distance travelled in kilometres',
        trips.DURATION_MINUTES AS DURATION_MINUTES
            WITH SYNONYMS = ('duration', 'time taken', 'minutes', 'how long', 'travel time')
            COMMENT = 'Actual trip duration in minutes',
        trips.PLANNED_DISTANCE_KM AS PLANNED_DISTANCE_KM
            WITH SYNONYMS = ('planned km', 'expected distance')
            COMMENT = 'Planned route distance in kilometres',
        trips.DETOUR_DISTANCE_KM AS DETOUR_DISTANCE_KM
            WITH SYNONYMS = ('extra distance', 'deviation km')
            COMMENT = 'Extra distance from route deviation in kilometres',
        trips.PICKUP_WAIT_MINUTES AS PICKUP_WAIT_MINUTES
            WITH SYNONYMS = ('pickup wait', 'wait at origin', 'collection wait')
            COMMENT = 'Minutes waited at pickup location',
        trips.DELIVERY_WAIT_MINUTES AS DELIVERY_WAIT_MINUTES
            WITH SYNONYMS = ('delivery wait', 'wait at destination', 'drop-off wait')
            COMMENT = 'Minutes waited at delivery location',
        fleet.CAPACITY_KG AS CAPACITY_KG
            WITH SYNONYMS = ('vehicle capacity', 'load capacity', 'kg capacity')
            COMMENT = 'Vehicle payload capacity in kg'
    )
    DIMENSIONS (
        trips.TRIP_ID AS TRIP_ID
            COMMENT = 'Unique identifier for each trip',
        trips.VEHICLE_ID AS VEHICLE_ID
            COMMENT = 'Vehicle identifier',
        trips.VEHICLE_TYPE AS VEHICLE_TYPE
            WITH SYNONYMS = ('mode', 'transport type', 'fleet type', 'courier type')
            COMMENT = 'Type of vehicle: ebike (electric bike) or hgv (heavy goods vehicle)',
        trips.STATUS AS STATUS
            WITH SYNONYMS = ('state', 'outcome', 'completion status', 'trip status')
            COMMENT = 'Trip status: COMPLETED, IN_PROGRESS, or CANCELLED',
        trips.IS_DETOUR AS IS_DETOUR
            WITH SYNONYMS = ('deviation', 'off route', 'route deviation')
            COMMENT = 'Whether the vehicle deviated from the planned route',
        trips.ORS_PROFILE AS ORS_PROFILE
            WITH SYNONYMS = ('profile', 'routing mode', 'travel mode')
            COMMENT = 'Routing profile: driving-car, cycling-electric, or driving-hgv',
        trips.TRIP_START AS TRIP_START
            WITH SYNONYMS = ('start time', 'departure', 'when', 'date', 'trip date', 'hour of day')
            COMMENT = 'Date and time when the trip started',
        trips.TRIP_END AS TRIP_END
            WITH SYNONYMS = ('end time', 'arrival', 'completion time')
            COMMENT = 'Date and time when the trip ended',
        fleet.REGION AS REGION
            WITH SYNONYMS = ('city', 'area', 'location', 'zone')
            COMMENT = 'Geographic region: SanFrancisco, Cambridge, or Barcelona',
        fleet.VEHICLE_NAME AS VEHICLE_NAME
            WITH SYNONYMS = ('courier', 'driver name', 'vehicle label')
            COMMENT = 'Human-readable vehicle or courier name',
        pois.NAME AS NAME
            WITH SYNONYMS = ('pickup', 'start location', 'origin name', 'restaurant', 'from')
            COMMENT = 'Name of the origin point of interest',
        pois.LOCATION_TYPE AS LOCATION_TYPE
            WITH SYNONYMS = ('origin category', 'pickup type', 'start type')
            COMMENT = 'Category of origin POI: RESTAURANT, WAREHOUSE, or REST_STOP',
        pois.CATEGORY AS CATEGORY
            WITH SYNONYMS = ('cuisine', 'restaurant type', 'food category')
            COMMENT = 'Cuisine or category of the origin POI'
    )
    METRICS (
        TOTAL_TRIPS AS COUNT(trips.TRIP_ID)
            WITH SYNONYMS = ('number of trips', 'trip count', 'deliveries', 'how many trips')
            COMMENT = 'Total number of trips',
        ACTIVE_VEHICLES AS COUNT(DISTINCT trips.VEHICLE_ID)
            WITH SYNONYMS = ('vehicles', 'number of vehicles', 'fleet size', 'couriers')
            COMMENT = 'Number of distinct vehicles that made trips',
        AVG_TRIP_DISTANCE_KM AS AVG(trips.DISTANCE_KM)
            WITH SYNONYMS = ('average distance', 'mean distance', 'typical trip distance')
            COMMENT = 'Average trip distance in kilometres',
        AVG_TRIP_DURATION_MINUTES AS AVG(trips.DURATION_MINUTES)
            WITH SYNONYMS = ('average duration', 'mean trip time', 'average trip length')
            COMMENT = 'Average trip duration in minutes',
        TOTAL_DISTANCE_KM AS SUM(trips.DISTANCE_KM)
            WITH SYNONYMS = ('total km', 'total kilometres', 'distance driven', 'fleet mileage')
            COMMENT = 'Total distance driven across all trips in kilometres',
        DETOUR_COUNT AS SUM(CASE WHEN trips.IS_DETOUR THEN 1 ELSE 0 END)
            WITH SYNONYMS = ('deviations', 'route deviations', 'off route trips', 'detours')
            COMMENT = 'Number of trips that deviated from the planned route',
        TOTAL_DETOUR_KM AS SUM(CASE WHEN trips.IS_DETOUR THEN trips.DETOUR_DISTANCE_KM ELSE 0 END)
            WITH SYNONYMS = ('extra kilometres', 'wasted distance', 'total deviation distance')
            COMMENT = 'Total extra distance caused by route deviations in kilometres',
        AVG_PICKUP_WAIT AS AVG(trips.PICKUP_WAIT_MINUTES)
            WITH SYNONYMS = ('average pickup wait', 'collection time', 'wait time')
            COMMENT = 'Average wait time at pickup in minutes'
    )
    COMMENT = 'Fleet trip analytics for Fleet Intelligence demos. Covers ebike food delivery and HGV logistics operations. Supports questions on trip performance, route deviation, hourly demand patterns, busiest pickup locations, and fleet utilisation.'
    WITH EXTENSION (
        CA = '
verified_queries:
  - question: "How many trips were made by each vehicle type?"
    sql: "SELECT VEHICLE_TYPE, COUNT(TRIP_ID) AS TOTAL_TRIPS FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS GROUP BY VEHICLE_TYPE ORDER BY TOTAL_TRIPS DESC"
  - question: "What is the trip distribution by hour of day?"
    sql: "SELECT HOUR(TRIP_START) AS HOUR_OF_DAY, COUNT(TRIP_ID) AS TRIPS FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS WHERE TRIP_START IS NOT NULL GROUP BY HOUR(TRIP_START) ORDER BY HOUR_OF_DAY"
  - question: "Which vehicles completed the most trips?"
    sql: "SELECT VEHICLE_ID, VEHICLE_TYPE, COUNT(TRIP_ID) AS TRIPS, ROUND(AVG(DISTANCE_KM), 2) AS AVG_DISTANCE_KM, ROUND(AVG(DURATION_MINUTES), 1) AS AVG_DURATION_MINS FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS GROUP BY VEHICLE_ID, VEHICLE_TYPE ORDER BY TRIPS DESC LIMIT 10"
  - question: "Which pickup locations have the most orders?"
    sql: "SELECT p.NAME, p.LOCATION_TYPE, COUNT(t.TRIP_ID) AS ORDERS FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS t JOIN SYNTHETIC_DATASETS.UNIFIED.DIM_POIS p ON t.ORIGIN_POI_ID = p.LOCATION_ID GROUP BY p.NAME, p.LOCATION_TYPE ORDER BY ORDERS DESC LIMIT 10"
  - question: "What is the fleet overview: total trips, average distance, average duration, and active vehicles?"
    sql: "SELECT COUNT(TRIP_ID) AS TOTAL_TRIPS, ROUND(AVG(DISTANCE_KM), 2) AS AVG_DISTANCE_KM, ROUND(AVG(DURATION_MINUTES), 1) AS AVG_DURATION_MINS, COUNT(DISTINCT VEHICLE_ID) AS ACTIVE_VEHICLES FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS"
'
    );

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
        telemetry AS SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY
            PRIMARY KEY (TELEMETRY_ID)
            COMMENT = 'Vehicle telemetry readings including speed, battery, compliance status, and activity state.',
        fleet AS SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET
            PRIMARY KEY (VEHICLE_ID)
            COMMENT = 'Fleet vehicle configuration.'
    )
    RELATIONSHIPS (
        telemetry(VEHICLE_ID) REFERENCES fleet
    )
    FACTS (
        telemetry.SPEED_KMH AS SPEED_KMH
            WITH SYNONYMS = ('speed', 'velocity', 'how fast')
            COMMENT = 'Vehicle speed at the time of reading in km/h',
        telemetry.POSTED_SPEED_KMH AS POSTED_SPEED_KMH
            WITH SYNONYMS = ('speed limit', 'limit', 'posted limit')
            COMMENT = 'Posted speed limit at the vehicle location in km/h',
        telemetry.BATTERY_PCT AS BATTERY_PCT
            WITH SYNONYMS = ('battery', 'charge', 'battery level', 'battery percentage')
            COMMENT = 'Vehicle battery charge level as a percentage (0-100)',
        telemetry.ODOMETER_KM AS ODOMETER_KM
            WITH SYNONYMS = ('odometer', 'total distance', 'mileage')
            COMMENT = 'Total cumulative distance driven by the vehicle in km'
    )
    DIMENSIONS (
        telemetry.TELEMETRY_ID AS TELEMETRY_ID
            COMMENT = 'Unique identifier for each telemetry reading',
        telemetry.VEHICLE_ID AS VEHICLE_ID
            COMMENT = 'Vehicle identifier',
        telemetry.TRIP_ID AS TRIP_ID
            COMMENT = 'Trip identifier this reading belongs to',
        telemetry.VEHICLE_TYPE AS VEHICLE_TYPE
            WITH SYNONYMS = ('mode', 'transport type', 'fleet type')
            COMMENT = 'Type of vehicle: ebike or hgv',
        telemetry.REGION AS REGION
            WITH SYNONYMS = ('city', 'area', 'location', 'zone')
            COMMENT = 'Geographic region: SanFrancisco, Cambridge, or Barcelona',
        telemetry.STATUS AS STATUS
            WITH SYNONYMS = ('vehicle state', 'activity', 'what is the vehicle doing')
            COMMENT = 'Vehicle status: MOVING, DWELL_ORIGIN, DWELL_DESTINATION, DWELL_RECHARGE, or IDLE',
        telemetry.IS_SPEEDING AS IS_SPEEDING
            WITH SYNONYMS = ('speeding', 'over speed limit', 'speed violation')
            COMMENT = 'Whether the vehicle was exceeding the posted speed limit',
        telemetry.IS_HOS_VIOLATION AS IS_HOS_VIOLATION
            WITH SYNONYMS = ('hos violation', 'hours of service', 'compliance violation', 'driving hours violation')
            COMMENT = 'Whether a hours-of-service violation was detected',
        telemetry.IS_DETOUR AS IS_DETOUR
            WITH SYNONYMS = ('deviation', 'off route', 'route deviation')
            COMMENT = 'Whether the vehicle was off the planned route',
        telemetry.TS AS TS
            WITH SYNONYMS = ('timestamp', 'time', 'when', 'date', 'recorded at')
            COMMENT = 'Timestamp of the telemetry reading',
        telemetry.LOCATION_TYPE AS LOCATION_TYPE
            WITH SYNONYMS = ('location category', 'zone type', 'area type')
            COMMENT = 'Type of location at time of reading',
        fleet.VEHICLE_NAME AS VEHICLE_NAME
            WITH SYNONYMS = ('courier', 'driver name', 'vehicle label')
            COMMENT = 'Human-readable vehicle or courier name'
    )
    METRICS (
        TOTAL_READINGS AS COUNT(telemetry.TELEMETRY_ID)
            WITH SYNONYMS = ('readings', 'data points', 'records', 'total records')
            COMMENT = 'Total number of telemetry readings',
        SPEEDING_EVENTS AS SUM(CASE WHEN telemetry.IS_SPEEDING THEN 1 ELSE 0 END)
            WITH SYNONYMS = ('speeding count', 'speed violations', 'how many speeding', 'over limit events')
            COMMENT = 'Number of telemetry readings where vehicle was speeding',
        HOS_VIOLATIONS AS SUM(CASE WHEN telemetry.IS_HOS_VIOLATION THEN 1 ELSE 0 END)
            WITH SYNONYMS = ('compliance violations', 'hours of service violations', 'driving hour violations')
            COMMENT = 'Number of hours-of-service violations detected',
        AVG_SPEED_KMH AS AVG(telemetry.SPEED_KMH)
            WITH SYNONYMS = ('average speed', 'mean speed', 'typical speed')
            COMMENT = 'Average vehicle speed across all readings in km/h',
        AVG_BATTERY_PCT AS AVG(telemetry.BATTERY_PCT)
            WITH SYNONYMS = ('average battery', 'mean battery level', 'typical charge')
            COMMENT = 'Average battery level across all readings as a percentage',
        ACTIVE_VEHICLES AS COUNT(DISTINCT telemetry.VEHICLE_ID)
            WITH SYNONYMS = ('vehicles tracked', 'number of vehicles', 'fleet size')
            COMMENT = 'Number of distinct vehicles with telemetry data'
    )
    COMMENT = 'Fleet telemetry analytics. Covers speed compliance, battery levels, speeding events, HOS violations, and dwell/idle behaviour for ebike and HGV fleets.'
    WITH EXTENSION (
        CA = '
verified_queries:
  - question: "How many speeding events occurred by vehicle type?"
    sql: "SELECT VEHICLE_TYPE, SUM(CASE WHEN IS_SPEEDING THEN 1 ELSE 0 END) AS SPEEDING_EVENTS, COUNT(*) AS TOTAL_READINGS, ROUND(100.0 * SUM(CASE WHEN IS_SPEEDING THEN 1 ELSE 0 END) / COUNT(*), 1) AS SPEEDING_RATE_PCT FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY GROUP BY VEHICLE_TYPE ORDER BY SPEEDING_EVENTS DESC"
  - question: "What is the average battery level by vehicle?"
    sql: "SELECT VEHICLE_ID, VEHICLE_TYPE, ROUND(AVG(BATTERY_PCT), 1) AS AVG_BATTERY_PCT, MIN(BATTERY_PCT) AS MIN_BATTERY_PCT FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY GROUP BY VEHICLE_ID, VEHICLE_TYPE ORDER BY AVG_BATTERY_PCT ASC LIMIT 10"
  - question: "What is the speeding rate by vehicle?"
    sql: "SELECT VEHICLE_ID, VEHICLE_TYPE, ROUND(100.0 * SUM(CASE WHEN IS_SPEEDING THEN 1 ELSE 0 END) / COUNT(*), 1) AS SPEEDING_RATE_PCT FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY GROUP BY VEHICLE_ID, VEHICLE_TYPE ORDER BY SPEEDING_RATE_PCT DESC LIMIT 10"
'
    );

SELECT 'FLEET_TELEMETRY_SV created' AS STATUS,
       COUNT(*) AS TELEMETRY_ROWS
FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY;

-- Run $setup-agent-playground to register all tools with the Routing Agent.
