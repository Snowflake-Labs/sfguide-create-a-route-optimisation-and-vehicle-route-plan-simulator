/*
 * seed-data.sql — Fleet Intelligence Food Delivery
 * Creates projection views over SYNTHETIC_DATASETS.UNIFIED tables.
 * Source data is loaded by build-routing-solution Step 8 (datasets/ seed).
 * No S3 external stages — all data comes from UNIFIED.
 */

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-food-delivery","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE DATABASE IF NOT EXISTS FLEET_INTELLIGENCE
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-food-delivery","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
CREATE WAREHOUSE IF NOT EXISTS ROUTING_ANALYTICS
    WAREHOUSE_SIZE = 'XSMALL'
    AUTO_SUSPEND = 60
    AUTO_RESUME = TRUE
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-food-delivery","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-food-delivery","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

--------------------------------------------------------------------
-- CONFIG
--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.CONFIG (
    VEHICLE_TYPE VARCHAR NOT NULL,
    REGION       VARCHAR NOT NULL
);
MERGE INTO FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.CONFIG tgt
USING (SELECT 'ebike' AS VEHICLE_TYPE, 'SanFrancisco' AS REGION) src
ON TRUE
WHEN NOT MATCHED THEN INSERT (VEHICLE_TYPE, REGION) VALUES (src.VEHICLE_TYPE, src.REGION);

-- Vehicle-aware threshold reference table (Issue #33)
-- Drives SLA, geofence, and deviation behaviour based on the active VEHICLE_TYPE.
-- LOCATION_TYPE = '*' holds vehicle-level globals (deviation %, speed factor, H3 resolution).
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.VEHICLE_THRESHOLDS (
    VEHICLE_TYPE        VARCHAR NOT NULL,
    LOCATION_TYPE       VARCHAR NOT NULL,
    SLA_WARNING_MIN     NUMBER,
    SLA_CRITICAL_MIN    NUMBER,
    GEOFENCE_RADIUS_M   NUMBER,
    DEVIATION_PCT       NUMBER(5,2),
    SPEED_LIMIT_FACTOR  NUMBER(3,2),
    H3_RESOLUTION       NUMBER(2),
    PRIMARY KEY (VEHICLE_TYPE, LOCATION_TYPE)
)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-food-delivery","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
MERGE INTO FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.VEHICLE_THRESHOLDS tgt
USING (
    SELECT column1 AS VEHICLE_TYPE, column2 AS LOCATION_TYPE,
           column3 AS SLA_WARNING_MIN, column4 AS SLA_CRITICAL_MIN,
           column5 AS GEOFENCE_RADIUS_M, column6 AS DEVIATION_PCT,
           column7 AS SPEED_LIMIT_FACTOR, column8 AS H3_RESOLUTION
    FROM VALUES
      ('car',      'WAREHOUSE',    8, 20, 150, NULL, NULL, NULL),
      ('car',      'DESTINATION',  5, 15,  80, NULL, NULL, NULL),
      ('car',      'REST_STOP',   10, 25, 120, NULL, NULL, NULL),
      ('car',      'STORE',        3, 10,  80, NULL, NULL, NULL),
      ('car',      'DETOUR',       3,  8,  80, NULL, NULL, NULL),
      ('car',      '*',         NULL, NULL, NULL, 15.00, 1.10, 8),
      ('ebike',    'WAREHOUSE',    5, 12,  80, NULL, NULL, NULL),
      ('ebike',    'DESTINATION',  3,  8,  50, NULL, NULL, NULL),
      ('ebike',    'REST_STOP',    5, 15,  60, NULL, NULL, NULL),
      ('ebike',    'STORE',        2,  6,  40, NULL, NULL, NULL),
      ('ebike',    'DETOUR',       2,  5,  50, NULL, NULL, NULL),
      ('ebike',    '*',         NULL, NULL, NULL, 25.00, 1.05, 9),
      ('hgv',      'WAREHOUSE',   30, 90, 300, NULL, NULL, NULL),
      ('hgv',      'DESTINATION', 20, 60, 200, NULL, NULL, NULL),
      ('hgv',      'REST_STOP',   45, 90, 250, NULL, NULL, NULL),
      ('hgv',      'STORE',       15, 45, 200, NULL, NULL, NULL),
      ('hgv',      'DETOUR',       5, 15, 200, NULL, NULL, NULL),
      ('hgv',      '*',         NULL, NULL, NULL, 10.00, 1.05, 7),
      ('escooter', 'WAREHOUSE',    4, 10,  60, NULL, NULL, NULL),
      ('escooter', 'DESTINATION',  2,  6,  40, NULL, NULL, NULL),
      ('escooter', 'REST_STOP',    4, 12,  50, NULL, NULL, NULL),
      ('escooter', 'STORE',        2,  5,  30, NULL, NULL, NULL),
      ('escooter', 'DETOUR',       2,  4,  40, NULL, NULL, NULL),
      ('escooter', '*',         NULL, NULL, NULL, 30.00, 1.05, 10)
) src
ON tgt.VEHICLE_TYPE = src.VEHICLE_TYPE AND tgt.LOCATION_TYPE = src.LOCATION_TYPE
WHEN NOT MATCHED THEN INSERT (VEHICLE_TYPE, LOCATION_TYPE, SLA_WARNING_MIN, SLA_CRITICAL_MIN, GEOFENCE_RADIUS_M, DEVIATION_PCT, SPEED_LIMIT_FACTOR, H3_RESOLUTION)
    VALUES (src.VEHICLE_TYPE, src.LOCATION_TYPE, src.SLA_WARNING_MIN, src.SLA_CRITICAL_MIN, src.GEOFENCE_RADIUS_M, src.DEVIATION_PCT, src.SPEED_LIMIT_FACTOR, src.H3_RESOLUTION);



ALTER TABLE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.CONFIG SET
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-food-delivery","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

--------------------------------------------------------------------
-- DELIVERIES (FleetMap.tsx + CatchmentPanel.tsx)
--------------------------------------------------------------------
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERIES AS
SELECT
    t.TRIP_ID        AS DELIVERY_ID,
    t.VEHICLE_ID     AS COURIER_ID,
    t.ORIGIN_POI_ID  AS RESTAURANT_ID,
    t.DESTINATION_POI_ID AS CUSTOMER_ADDRESS_ID,
    t.ORIGIN           AS PICKUP_LOCATION,
    t.DESTINATION  AS DROPOFF_LOCATION,
    t.DESTINATION  AS CUSTOMER_LOCATION,
    t.DURATION_MINUTES  AS DELIVERY_TIME_MIN,
    t.DISTANCE_KM,
    t.ROUTE_GEOG     AS GEOMETRY,
    t.TRIP_START      AS ORDER_TIME,
    t.TRIP_END        AS DELIVERY_TIME,
    t.STATUS          AS ORDER_STATUS,
    t.REGION
FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS t
WHERE t.VEHICLE_TYPE = (SELECT VEHICLE_TYPE FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.CONFIG LIMIT 1)
  AND t.REGION       = (SELECT REGION FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.CONFIG LIMIT 1);

ALTER VIEW FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERIES SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-food-delivery","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

--------------------------------------------------------------------
-- RESTAURANTS_ENRICHED (CatchmentPanel.tsx)
--------------------------------------------------------------------
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.RESTAURANTS_ENRICHED AS
SELECT
    p.LOCATION_ID         AS RESTAURANT_ID,
    p.NAME                AS RESTAURANT_NAME,
    ANY_VALUE(p.POINT_GEOM) AS LOCATION,
    COUNT(t.TRIP_ID)      AS TOTAL_ORDERS,
    ROUND(AVG(t.DURATION_MINUTES), 1) AS AVG_DELIVERY_TIME_MIN,
    p.REGION
FROM SYNTHETIC_DATASETS.UNIFIED.DIM_POIS p
LEFT JOIN SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS t
    ON p.LOCATION_ID = t.ORIGIN_POI_ID
   AND t.VEHICLE_TYPE = (SELECT VEHICLE_TYPE FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.CONFIG LIMIT 1)
   AND t.REGION       = (SELECT REGION FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.CONFIG LIMIT 1)
WHERE p.LOCATION_TYPE = 'RESTAURANT'
  AND p.REGION = (SELECT REGION FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.CONFIG LIMIT 1)
GROUP BY p.LOCATION_ID, p.NAME, p.REGION;

ALTER VIEW FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.RESTAURANTS_ENRICHED SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-food-delivery","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

--------------------------------------------------------------------
-- VALIDATION
--------------------------------------------------------------------
SELECT 'CONFIG' AS TBL, COUNT(*) AS ROW_CNT FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.CONFIG
UNION ALL SELECT 'DELIVERIES', COUNT(*) FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERIES
UNION ALL SELECT 'RESTAURANTS_ENRICHED', COUNT(*) FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.RESTAURANTS_ENRICHED;

