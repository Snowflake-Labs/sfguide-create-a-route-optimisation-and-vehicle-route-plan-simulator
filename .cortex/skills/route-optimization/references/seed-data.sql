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
-- JOB_TEMPLATE (jobs per industry for VRP simulation)
-- v1.0.172+ requires INDUSTRY column and SLOT_START/END in SECONDS (not hours).
-- App queries: WHERE REGION = ? AND STATUS = 'active' AND INDUSTRY = ?
-- UI renders SLOT_START/3600 as hour display (e.g. 32400 = 09:00)
--------------------------------------------------------------------
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.JOB_TEMPLATE (
    ID INT AUTOINCREMENT PRIMARY KEY,
    SLOT_START INT NOT NULL,
    SLOT_END INT,
    SKILLS INT,
    PRODUCT STRING,
    STATUS STRING DEFAULT 'active',
    REGION STRING,
    INDUSTRY STRING
)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-route-optimization","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

INSERT INTO FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.JOB_TEMPLATE (SLOT_START, SLOT_END, SKILLS, PRODUCT, STATUS, REGION, INDUSTRY)
SELECT column1, column2, column3, column4, 'active', $REGION_NAME, column5 FROM VALUES
(32400, 36000, 1, 'pa', 'healthcare'),
(39600, 54000, 2, 'pb', 'healthcare'),
(57600, 64800, 2, 'pb', 'healthcare'),
(39600, 46800, 3, 'pc', 'healthcare'),
(25200, 57600, 3, 'pc', 'healthcare'),
(36000, 54000, 2, 'pa', 'healthcare'),
(46800, 64800, 1, 'pa', 'healthcare'),
(39600, 54000, 2, 'pb', 'Food'),
(57600, 64800, 2, 'pb', 'Food'),
(39600, 46800, 1, 'pa', 'Food'),
(25200, 57600, 1, 'pa', 'Food'),
(36000, 54000, 2, 'pb', 'Food'),
(36000, 54000, 2, 'pb', 'Food'),
(25200, 57600, 1, 'pa', 'Food'),
(32400, 64800, 2, 'pb', 'Food'),
(46800, 64800, 2, 'pb', 'Cosmetics'),
(46800, 64800, 2, 'pb', 'Cosmetics'),
(46800, 64800, 1, 'pa', 'Cosmetics'),
(46800, 64800, 1, 'pa', 'Cosmetics'),
(46800, 64800, 1, 'pa', 'Cosmetics'),
(46800, 64800, 3, 'pc', 'Cosmetics'),
(32400, 64800, 2, 'pb', 'Cosmetics'),
(32400, 64800, 2, 'pb', 'Beverages'),
(46800, 64800, 2, 'pb', 'Beverages'),
(46800, 64800, 2, 'pb', 'Beverages'),
(46800, 64800, 1, 'pa', 'Beverages'),
(46800, 64800, 1, 'pa', 'Beverages'),
(46800, 64800, 1, 'pa', 'Beverages'),
(46800, 64800, 3, 'pc', 'Beverages'),
(25200, 30600, 1, 'pa', 'SEN Transport'),
(25200, 30600, 1, 'pa', 'SEN Transport'),
(25200, 30600, 1, 'pa', 'SEN Transport'),
(25200, 32400, 2, 'pb', 'SEN Transport'),
(25200, 32400, 2, 'pb', 'SEN Transport'),
(25200, 32400, 2, 'pb', 'SEN Transport'),
(25200, 32400, 2, 'pb', 'SEN Transport'),
(25200, 32400, 3, 'pc', 'SEN Transport'),
(25200, 32400, 3, 'pc', 'SEN Transport'),
(25200, 32400, 3, 'pc', 'SEN Transport'),
(54000, 59400, 1, 'pa', 'SEN Transport'),
(54000, 59400, 1, 'pa', 'SEN Transport'),
(54000, 59400, 1, 'pa', 'SEN Transport'),
(54000, 61200, 2, 'pb', 'SEN Transport'),
(54000, 61200, 2, 'pb', 'SEN Transport'),
(54000, 61200, 2, 'pb', 'SEN Transport'),
(54000, 61200, 2, 'pb', 'SEN Transport'),
(54000, 61200, 3, 'pc', 'SEN Transport'),
(54000, 61200, 3, 'pc', 'SEN Transport'),
(54000, 61200, 3, 'pc', 'SEN Transport');

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
       ARRAY_CONSTRUCT('Age Verification Required', 'Fragile Goods Handler', 'Heavy Load Capacity')
UNION ALL
SELECT $REGION_NAME, 'SEN Transport', 'Solo Taxi (1 child, chaperone required)', 'Shared Taxi (2-3 children)', 'Minibus (6-8 children)',
       ARRAY_CONSTRUCT('special needs school education SEN disability autism ADHD'),
       ARRAY_CONSTRUCT('school academy college nursery pupil referral unit'),
       ARRAY_CONSTRUCT('school', 'community_center', 'nursery', 'college'),
       ARRAY_CONSTRUCT('Solo Taxi + Chaperone', 'Shared Taxi (Behavioural)', 'Accessible Minibus');

--------------------------------------------------------------------
-- DROP STAGING TABLE
--------------------------------------------------------------------
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.REGION_DATA;


