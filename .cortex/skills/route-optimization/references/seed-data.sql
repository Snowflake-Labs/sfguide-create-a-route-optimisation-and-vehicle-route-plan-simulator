/*
 * seed-data.sql — Route Optimization Demo
 * Creates schema, CONFIG, and populates PLACES, JOB_TEMPLATE, LOOKUP from Overture Maps.
 * Run via: snow sql -f .cortex/skills/route-optimization/references/seed-data.sql -c <connection>
 *
 * To customize for a different region, change the SET variables below.
 * Use the geohash table in references/notebook-deployment.md to find the correct geohash.
 * Common geohashes:
 *   San Francisco:  9q
 *   New York:       dr
 *   London:         gc
 *   Paris:          u0
 *   Berlin:         u3
 *   Tokyo:          xn
 *   Sydney:         r3
 *
 * NOTE: This script uses SET session variables. Execute via `snow sql -f` (single session).
 * If using snowflake_sql_execute (which creates new sessions per call), prepend the SET
 * statements to EACH SQL block.
 */

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-route-optimization","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

--------------------------------------------------------------------
-- REGION CONFIGURATION (customize these for your region)
--------------------------------------------------------------------
SET REGION_GEOHASH = '9q';
SET REGION_NAME = 'SanFrancisco';

--------------------------------------------------------------------
-- DATABASE, SCHEMA, WAREHOUSE
--------------------------------------------------------------------
CREATE DATABASE IF NOT EXISTS FLEET_INTELLIGENCE
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-route-optimization","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-route-optimization","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE WAREHOUSE IF NOT EXISTS ROUTING_ANALYTICS
    WAREHOUSE_SIZE = 'XSMALL'
    AUTO_SUSPEND = 60
    AUTO_RESUME = TRUE
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-route-optimization","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE STAGE IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.NOTEBOOK
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-route-optimization","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

--------------------------------------------------------------------
-- CONFIG
--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG (
    VEHICLE_TYPE VARCHAR NOT NULL,
    REGION       VARCHAR NOT NULL
)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-route-optimization","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

MERGE INTO FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG tgt
USING (SELECT 'driving-car' AS VEHICLE_TYPE, $REGION_NAME AS REGION) src
ON TRUE
WHEN MATCHED THEN UPDATE SET tgt.VEHICLE_TYPE = src.VEHICLE_TYPE, tgt.REGION = src.REGION
WHEN NOT MATCHED THEN INSERT (VEHICLE_TYPE, REGION) VALUES (src.VEHICLE_TYPE, src.REGION);

--------------------------------------------------------------------
-- REGION_DATA (staging table from Overture Maps)
--------------------------------------------------------------------
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.REGION_DATA AS
SELECT * FROM OVERTURE_MAPS__PLACES.CARTO.PLACE
WHERE ST_GEOHASH(GEOMETRY, 2) = $REGION_GEOHASH;

ALTER TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.REGION_DATA SET
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-route-optimization","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

--------------------------------------------------------------------
-- PLACES (from staging, with search optimization)
--------------------------------------------------------------------
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES AS
SELECT
    $REGION_NAME AS REGION,
    GEOMETRY,
    PHONES[0]::TEXT AS PHONES,
    CATEGORIES:primary::TEXT AS CATEGORY,
    NAMES:primary::TEXT AS NAME,
    ADDRESSES[0] AS ADDRESS,
    COALESCE(CATEGORIES:alternate:list, ARRAY_CONSTRUCT()) AS ALTERNATE
FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.REGION_DATA
WHERE CATEGORIES:primary IS NOT NULL;

ALTER TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES SET
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-route-optimization","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

ALTER TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES ADD SEARCH OPTIMIZATION ON EQUALITY(ALTERNATE);
ALTER TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES ADD SEARCH OPTIMIZATION ON GEO(GEOMETRY);

--------------------------------------------------------------------
-- JOB_TEMPLATE (29 sample jobs for VRP simulation)
--------------------------------------------------------------------
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.JOB_TEMPLATE (
    ID INT AUTOINCREMENT PRIMARY KEY,
    SLOT_START INT NOT NULL,
    SLOT_END INT,
    SKILLS INT,
    PRODUCT STRING,
    STATUS STRING DEFAULT 'active',
    REGION STRING
)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-route-optimization","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

INSERT INTO FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.JOB_TEMPLATE (SLOT_START, SLOT_END, SKILLS, PRODUCT, STATUS, REGION)
SELECT column1, column2, column3, column4, 'active', $REGION_NAME FROM VALUES
(9,  10, 1, 'pa'),
(11, 15, 2, 'pb'),
(16, 18, 2, 'pb'),
(11, 13, 3, 'pc'),
(7,  16, 3, 'pc'),
(10, 15, 2, 'pa'),
(10, 15, 2, 'pa'),
(7,  16, 1, 'pa'),
(9,  18, 2, 'pb'),
(13, 18, 2, 'pb'),
(13, 18, 2, 'pb'),
(13, 18, 1, 'pa'),
(13, 18, 1, 'pa'),
(13, 18, 1, 'pa'),
(13, 18, 3, 'pc'),
(11, 15, 2, 'pb'),
(16, 18, 2, 'pb'),
(11, 13, 1, 'pa'),
(7,  16, 1, 'pa'),
(10, 15, 2, 'pb'),
(10, 15, 2, 'pb'),
(7,  16, 1, 'pa'),
(9,  18, 2, 'pb'),
(13, 18, 2, 'pb'),
(13, 18, 2, 'pb'),
(13, 18, 1, 'pa'),
(13, 18, 1, 'pa'),
(13, 18, 1, 'pa'),
(13, 18, 3, 'pc');

--------------------------------------------------------------------
-- LOOKUP (industry configuration for VRP simulation)
--------------------------------------------------------------------
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP (
    REGION STRING,
    INDUSTRY STRING,
    PA STRING,
    PB STRING,
    PC STRING,
    IND ARRAY,
    IND2 ARRAY,
    CTYPE ARRAY,
    STYPE ARRAY
)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-route-optimization","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

INSERT INTO FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP (REGION, INDUSTRY, PA, PB, PC, IND, IND2, CTYPE, STYPE)
SELECT $REGION_NAME, 'healthcare', 'flammable', 'sharps', 'temperature-controlled',
       ARRAY_CONSTRUCT('hospital health pharmaceutical drug healthcare pharmacy surgical'),
       ARRAY_CONSTRUCT('supplies warehouse depot distribution wholesaler distributors'),
       ARRAY_CONSTRUCT('hospital', 'family_practice', 'dentist', 'pharmacy'),
       ARRAY_CONSTRUCT('Can handle potentially explosive goods', 'Can handle instruments that could be used as weapons', 'Has a fridge')
UNION ALL
SELECT $REGION_NAME, 'Food', 'Fresh Food Order', 'Frozen Food Order', 'Non Perishable Food Order',
       ARRAY_CONSTRUCT('food vegatables meat vegatable'),
       ARRAY_CONSTRUCT('wholesaler warehouse factory processing distribution distributors'),
       ARRAY_CONSTRUCT('supermarket', 'restaurant', 'butcher_shop'),
       ARRAY_CONSTRUCT('Can deliver Fresh Food', 'Has a Fridge', 'Premium Delivery')
UNION ALL
SELECT $REGION_NAME, 'Cosmetics', 'Hair Products', 'Electronic Goods', 'Make-up',
       ARRAY_CONSTRUCT('hair cosmetics make-up beauty'),
       ARRAY_CONSTRUCT('wholesaler warehouse factory supplies distribution distributors'),
       ARRAY_CONSTRUCT('supermarket', 'outlet', 'fashion'),
       ARRAY_CONSTRUCT('Can deliver Fresh Food', 'Has a Fridge', 'Premium Delivery')
UNION ALL
SELECT $REGION_NAME, 'Beverages', 'Alcoholic Beverages', 'Carbonated Drinks', 'Still Water',
       ARRAY_CONSTRUCT('beverage drink brewery distillery bottling winery'),
       ARRAY_CONSTRUCT('warehouse distribution depot factory wholesaler'),
       ARRAY_CONSTRUCT('bar', 'pub', 'restaurant', 'hotel', 'supermarket', 'convenience_store'),
       ARRAY_CONSTRUCT('Age Verification Required', 'Fragile Goods Handler', 'Heavy Load Capacity');

--------------------------------------------------------------------
-- DROP STAGING TABLE
--------------------------------------------------------------------
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.REGION_DATA;


