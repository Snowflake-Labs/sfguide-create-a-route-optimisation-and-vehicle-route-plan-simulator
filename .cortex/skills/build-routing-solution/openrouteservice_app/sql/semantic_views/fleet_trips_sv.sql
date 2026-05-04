CREATE OR REPLACE SEMANTIC VIEW FLEET_INTELLIGENCE.PUBLIC.FLEET_TRIPS_SV
    TABLES (
        trips AS SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS
            PRIMARY KEY (TRIP_ID)
            COMMENT = 'Individual fleet trip records including actual and planned routes, distances, durations, and detour information.',
        fleet AS SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET
            PRIMARY KEY (VEHICLE_ID)
            COMMENT = 'Fleet vehicle and driver configuration including shift type, driver profile, and operating mode.',
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
        fleet.BATTERY_RANGE_KM AS BATTERY_RANGE_KM
            WITH SYNONYMS = ('battery range', 'range', 'charge range')
            COMMENT = 'Maximum battery range of the vehicle in kilometres',
        fleet.BASE_SPEED_KMH AS BASE_SPEED_KMH
            WITH SYNONYMS = ('vehicle speed', 'base speed')
            COMMENT = 'Base operating speed of the vehicle in km/h'
    )
    DIMENSIONS (
        trips.TRIP_ID AS TRIP_ID
            COMMENT = 'Unique identifier for each trip',
        trips.VEHICLE_ID AS VEHICLE_ID
            COMMENT = 'Vehicle identifier',
        trips.VEHICLE_TYPE AS VEHICLE_TYPE
            WITH SYNONYMS = ('mode', 'transport type', 'fleet type', 'courier type')
            COMMENT = 'Type of vehicle: ebike (electric bike) or hgv (heavy goods vehicle)',
        trips.REGION AS REGION
            WITH SYNONYMS = ('city', 'area', 'location', 'zone')
            COMMENT = 'Geographic region: SanFrancisco, Cambridge, or Barcelona',
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
            WITH SYNONYMS = ('start time', 'departure', 'when', 'date', 'trip date')
            COMMENT = 'Date and time when the trip started',
        trips.TRIP_END AS TRIP_END
            WITH SYNONYMS = ('end time', 'arrival', 'completion time')
            COMMENT = 'Date and time when the trip ended',
        fleet.SHIFT_TYPE AS SHIFT_TYPE
            WITH SYNONYMS = ('shift', 'working hours', 'schedule', 'rota')
            COMMENT = 'Driver shift hours 24h format e.g. 10-23, 17-23, 5-17',
        fleet.DRIVER_PROFILE AS DRIVER_PROFILE
            WITH SYNONYMS = ('driver behaviour', 'driver type', 'driving style', 'compliance')
            COMMENT = 'Driver behaviour: COMPLIANT, MILD, or OUTLIER',
        fleet.OPERATING_MODE AS OPERATING_MODE
            WITH SYNONYMS = ('mode', 'fleet mode', 'operation type')
            COMMENT = 'Vehicle operating mode',
        pois.NAME AS NAME
            WITH SYNONYMS = ('pickup', 'start location', 'origin name', 'from')
            COMMENT = 'Name of the origin point of interest',
        pois.LOCATION_TYPE AS LOCATION_TYPE
            WITH SYNONYMS = ('origin category', 'pickup type', 'start type')
            COMMENT = 'Category of origin POI: RESTAURANT, WAREHOUSE, or REST_STOP'
    )
    METRICS (
        TOTAL_TRIPS AS COUNT(trips.TRIP_ID)
            WITH SYNONYMS = ('number of trips', 'trip count', 'deliveries', 'how many trips')
            COMMENT = 'Total number of trips',
        ACTIVE_VEHICLES AS COUNT(DISTINCT trips.VEHICLE_ID)
            WITH SYNONYMS = ('vehicles', 'number of vehicles', 'fleet size')
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
            COMMENT = 'Total extra distance caused by route deviations in kilometres'
    )
    COMMENT = 'Fleet trip analytics for Fleet Intelligence demos. Covers ebike food delivery and HGV logistics operations. Supports questions on trip performance, route deviation, driver behaviour, and fleet utilisation.'
    WITH EXTENSION (
        CA = '
verified_queries:
  - question: "How many trips were made by each vehicle type?"
    sql: "SELECT VEHICLE_TYPE, COUNT(TRIP_ID) AS TOTAL_TRIPS FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS GROUP BY VEHICLE_TYPE ORDER BY TOTAL_TRIPS DESC"
  - question: "What is the average trip distance and duration by vehicle type?"
    sql: "SELECT VEHICLE_TYPE, ROUND(AVG(DISTANCE_KM), 2) AS AVG_DISTANCE_KM, ROUND(AVG(DURATION_MINUTES), 1) AS AVG_DURATION_MINS FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS GROUP BY VEHICLE_TYPE"
  - question: "What is the detour rate by driver profile?"
    sql: "SELECT f.DRIVER_PROFILE, COUNT(t.TRIP_ID) AS TOTAL_TRIPS, SUM(CASE WHEN t.IS_DETOUR THEN 1 ELSE 0 END) AS DETOURS, ROUND(100.0 * SUM(CASE WHEN t.IS_DETOUR THEN 1 ELSE 0 END) / COUNT(t.TRIP_ID), 1) AS DETOUR_RATE_PCT FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS t JOIN SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET f ON t.VEHICLE_ID = f.VEHICLE_ID GROUP BY f.DRIVER_PROFILE ORDER BY DETOUR_RATE_PCT DESC"
  - question: "What is the total distance driven by region?"
    sql: "SELECT REGION, ROUND(SUM(DISTANCE_KM), 1) AS TOTAL_DISTANCE_KM, COUNT(TRIP_ID) AS TRIPS FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS GROUP BY REGION ORDER BY TOTAL_DISTANCE_KM DESC"
  - question: "Which vehicles have the most route deviations?"
    sql: "SELECT t.VEHICLE_ID, f.DRIVER_PROFILE, COUNT(t.TRIP_ID) AS TOTAL_TRIPS, SUM(CASE WHEN t.IS_DETOUR THEN 1 ELSE 0 END) AS DETOURS FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS t JOIN SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET f ON t.VEHICLE_ID = f.VEHICLE_ID GROUP BY t.VEHICLE_ID, f.DRIVER_PROFILE HAVING DETOURS > 0 ORDER BY DETOURS DESC LIMIT 10"
  - question: "How many completed trips per shift type?"
    sql: "SELECT f.SHIFT_TYPE, COUNT(t.TRIP_ID) AS TOTAL_TRIPS, ROUND(AVG(t.DURATION_MINUTES), 1) AS AVG_DURATION_MINS FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS t JOIN SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET f ON t.VEHICLE_ID = f.VEHICLE_ID WHERE t.STATUS = ''COMPLETED'' GROUP BY f.SHIFT_TYPE ORDER BY TOTAL_TRIPS DESC"
'
    );
