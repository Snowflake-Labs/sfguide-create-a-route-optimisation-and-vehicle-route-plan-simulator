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
