CREATE OR REPLACE SEMANTIC VIEW FLEET_INTELLIGENCE.PUBLIC.FLEET_TELEMETRY_SV
    TABLES (
        telemetry AS SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY
            PRIMARY KEY (TELEMETRY_ID)
            COMMENT = 'Real-time vehicle telemetry readings including GPS position, speed, battery, and compliance status.',
        fleet AS SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET
            PRIMARY KEY (VEHICLE_ID)
            COMMENT = 'Fleet vehicle and driver configuration including shift type, driver profile, and operating mode.'
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
            COMMENT = 'Total cumulative distance driven by the vehicle in km',
        telemetry.LATITUDE AS LATITUDE
            COMMENT = 'GPS latitude of the vehicle at time of reading',
        telemetry.LONGITUDE AS LONGITUDE
            COMMENT = 'GPS longitude of the vehicle at time of reading'
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
        fleet.SHIFT_TYPE AS SHIFT_TYPE
            WITH SYNONYMS = ('shift', 'working hours', 'schedule', 'rota')
            COMMENT = 'Driver shift hours in 24h format e.g. 10-23, 5-17',
        fleet.DRIVER_PROFILE AS DRIVER_PROFILE
            WITH SYNONYMS = ('driver behaviour', 'driver type', 'driving style')
            COMMENT = 'Driver behaviour: COMPLIANT, MILD, or OUTLIER'
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
        DWELL_READINGS AS SUM(CASE WHEN telemetry.STATUS LIKE 'DWELL%' THEN 1 ELSE 0 END)
            WITH SYNONYMS = ('dwell count', 'stopped count', 'stationary readings', 'dwell events')
            COMMENT = 'Number of readings where vehicle was dwelling (at origin, destination, or recharge)',
        IDLE_READINGS AS SUM(CASE WHEN telemetry.STATUS = 'IDLE' THEN 1 ELSE 0 END)
            WITH SYNONYMS = ('idle count', 'idle time', 'how much idle', 'idling events')
            COMMENT = 'Number of readings where vehicle was idle',
        ACTIVE_VEHICLES AS COUNT(DISTINCT telemetry.VEHICLE_ID)
            WITH SYNONYMS = ('vehicles tracked', 'number of vehicles', 'fleet size')
            COMMENT = 'Number of distinct vehicles with telemetry data'
    )
    COMMENT = 'Real-time fleet telemetry analytics for Fleet Intelligence demos. Covers vehicle speed, battery, compliance violations (speeding, HOS), and dwell/idle behaviour for ebike and HGV fleets.'
    WITH EXTENSION (
        CA = '
verified_queries:
  - question: "How many speeding events occurred by vehicle type?"
    sql: "SELECT VEHICLE_TYPE, SUM(CASE WHEN IS_SPEEDING THEN 1 ELSE 0 END) AS SPEEDING_EVENTS, COUNT(*) AS TOTAL_READINGS FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY GROUP BY VEHICLE_TYPE ORDER BY SPEEDING_EVENTS DESC"
  - question: "What is the average battery level by vehicle type?"
    sql: "SELECT VEHICLE_TYPE, ROUND(AVG(BATTERY_PCT), 1) AS AVG_BATTERY_PCT FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY GROUP BY VEHICLE_TYPE"
  - question: "How many HOS violations were detected by driver profile?"
    sql: "SELECT f.DRIVER_PROFILE, SUM(CASE WHEN t.IS_HOS_VIOLATION THEN 1 ELSE 0 END) AS HOS_VIOLATIONS, COUNT(t.TELEMETRY_ID) AS TOTAL_READINGS FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY t JOIN SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET f ON t.VEHICLE_ID = f.VEHICLE_ID GROUP BY f.DRIVER_PROFILE ORDER BY HOS_VIOLATIONS DESC"
  - question: "What is the breakdown of vehicle status across the fleet?"
    sql: "SELECT STATUS, VEHICLE_TYPE, COUNT(*) AS READINGS FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY GROUP BY STATUS, VEHICLE_TYPE ORDER BY READINGS DESC"
  - question: "What is the average speed by vehicle type and region?"
    sql: "SELECT VEHICLE_TYPE, REGION, ROUND(AVG(SPEED_KMH), 1) AS AVG_SPEED_KMH FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY WHERE STATUS = ''MOVING'' GROUP BY VEHICLE_TYPE, REGION ORDER BY AVG_SPEED_KMH DESC"
  - question: "Which vehicles have the most idle time?"
    sql: "SELECT VEHICLE_ID, VEHICLE_TYPE, SUM(CASE WHEN STATUS = ''IDLE'' THEN 1 ELSE 0 END) AS IDLE_READINGS FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY GROUP BY VEHICLE_ID, VEHICLE_TYPE HAVING IDLE_READINGS > 0 ORDER BY IDLE_READINGS DESC LIMIT 10"
'
    );
