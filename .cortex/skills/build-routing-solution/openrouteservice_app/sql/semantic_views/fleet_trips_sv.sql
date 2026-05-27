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
