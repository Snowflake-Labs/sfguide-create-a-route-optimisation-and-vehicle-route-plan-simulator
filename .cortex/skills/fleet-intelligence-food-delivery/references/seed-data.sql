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

--------------------------------------------------------------------
-- GRANT ACCESS TO NATIVE APP
--------------------------------------------------------------------
GRANT USAGE ON DATABASE FLEET_INTELLIGENCE TO APPLICATION OPENROUTESERVICE_NATIVE_APP;
GRANT USAGE ON SCHEMA FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY TO APPLICATION OPENROUTESERVICE_NATIVE_APP;
GRANT SELECT ON ALL VIEWS IN SCHEMA FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY TO APPLICATION OPENROUTESERVICE_NATIVE_APP;
GRANT SELECT ON ALL TABLES IN SCHEMA FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY TO APPLICATION OPENROUTESERVICE_NATIVE_APP;
