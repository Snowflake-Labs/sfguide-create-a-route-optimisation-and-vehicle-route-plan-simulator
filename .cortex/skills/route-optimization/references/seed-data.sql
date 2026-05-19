/*
 * seed-data.sql — Route Optimization Demo
 * Creates schema, CONFIG, and populates PLACES, JOB_TEMPLATE, LOOKUP from Overture Maps.
 * Run via: snow sql -f .cortex/skills/route-optimization/references/seed-data.sql -c <connection>
 *
 * To customize for a different region, change the SET variable below.
 * The region must exist in FLEET_INTELLIGENCE.CORE.REGION_REGISTRY or
 * OPENROUTESERVICE_APP.CORE.REGION_CATALOG (the procedure resolves bbox automatically).
 *
 * NOTE: This script uses SET session variables. Execute via `snow sql -f` (single session).
 * If using snowflake_sql_execute (which creates new sessions per call), prepend the SET
 * statements to EACH SQL block.
 */

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-route-optimization","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

--------------------------------------------------------------------
-- REGION CONFIGURATION (customize for your region)
--------------------------------------------------------------------
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
-- PLACES (multi-region, seeded via procedure)
--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES (
    REGION       VARCHAR,
    GEOMETRY     GEOGRAPHY,
    PHONES       VARCHAR,
    CATEGORY     VARCHAR,
    NAME         VARCHAR,
    ADDRESS      VARIANT,
    ALTERNATE    VARIANT
)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-route-optimization","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

ALTER TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES ADD SEARCH OPTIMIZATION IF NOT EXISTS ON EQUALITY(ALTERNATE);
ALTER TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES ADD SEARCH OPTIMIZATION IF NOT EXISTS ON GEO(GEOMETRY);

--------------------------------------------------------------------
-- JOB_TEMPLATE (29 sample jobs per region)
--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.JOB_TEMPLATE (
    ID INT AUTOINCREMENT PRIMARY KEY,
    SLOT_START INT NOT NULL,
    SLOT_END INT,
    SKILLS INT,
    PRODUCT STRING,
    STATUS STRING DEFAULT 'active',
    REGION STRING
)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-route-optimization","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

--------------------------------------------------------------------
-- LOOKUP (industry configuration for VRP simulation)
--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP (
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

--------------------------------------------------------------------
-- SEED_ROUTE_OPTIMIZATION_REGION procedure
-- Dynamically seeds PLACES, LOOKUP, JOB_TEMPLATE for any region
-- using Overture Maps data and bbox from REGION_REGISTRY/REGION_CATALOG.
-- Idempotent: skips if PLACES already has rows for the given region.
-- Called automatically by the server on region switch.
--------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SEED_ROUTE_OPTIMIZATION_REGION(
    REGION_KEY VARCHAR
)
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS CALLER
AS
$$
BEGIN
    LET row_count INT;
    SELECT COUNT(*) INTO :row_count
    FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES
    WHERE REGION = :REGION_KEY;

    IF (row_count > 0) THEN
        RETURN 'Already seeded: ' || row_count || ' places for ' || REGION_KEY;
    END IF;

    LET min_lat FLOAT;
    LET max_lat FLOAT;
    LET min_lon FLOAT;
    LET max_lon FLOAT;

    SELECT BBOX_MIN_LAT, BBOX_MAX_LAT, BBOX_MIN_LON, BBOX_MAX_LON INTO :min_lat, :max_lat, :min_lon, :max_lon
    FROM FLEET_INTELLIGENCE.CORE.REGION_REGISTRY
    WHERE UPPER(REGION_NAME) = UPPER(:REGION_KEY)
    LIMIT 1;

    IF (min_lat IS NULL) THEN
        SELECT MIN_LAT, MAX_LAT, MIN_LON, MAX_LON INTO :min_lat, :max_lat, :min_lon, :max_lon
        FROM OPENROUTESERVICE_APP.CORE.REGION_CATALOG
        WHERE UPPER(REGION_KEY) = UPPER(:REGION_KEY) OR UPPER(REGION_NAME) = UPPER(:REGION_KEY)
        LIMIT 1;
    END IF;

    IF (min_lat IS NULL) THEN
        RETURN 'ERROR: No bbox found for region ' || REGION_KEY || '. Register it in REGION_REGISTRY or REGION_CATALOG first.';
    END IF;

    INSERT INTO FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES (REGION, GEOMETRY, PHONES, CATEGORY, NAME, ADDRESS, ALTERNATE)
    SELECT
        :REGION_KEY,
        GEOMETRY,
        PHONES[0]::TEXT,
        CATEGORIES:primary::TEXT,
        NAMES:primary::TEXT,
        ADDRESSES[0],
        COALESCE(CATEGORIES:alternate:list, ARRAY_CONSTRUCT())
    FROM OVERTURE_MAPS__PLACES.CARTO.PLACE
    WHERE ST_X(GEOMETRY) BETWEEN :min_lon AND :max_lon
      AND ST_Y(GEOMETRY) BETWEEN :min_lat AND :max_lat
      AND CATEGORIES:primary IS NOT NULL;

    DELETE FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP WHERE REGION = :REGION_KEY;

    LET template_count INT;
    SELECT COUNT(*) INTO :template_count
    FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP
    WHERE REGION != :REGION_KEY;

    IF (template_count > 0) THEN
        LET source_region VARCHAR;
        SELECT REGION INTO :source_region
        FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP
        WHERE REGION != :REGION_KEY
        LIMIT 1;

        INSERT INTO FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP (REGION, INDUSTRY, PA, PB, PC, IND, IND2, CTYPE, STYPE)
        SELECT :REGION_KEY, INDUSTRY, PA, PB, PC, IND, IND2, CTYPE, STYPE
        FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP
        WHERE REGION = :source_region;
    ELSE
        INSERT INTO FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP (REGION, INDUSTRY, PA, PB, PC, IND, IND2, CTYPE, STYPE)
        SELECT :REGION_KEY, column1, column2, column3, column4, column5, column6, column7, column8 FROM VALUES
        ('Healthcare', 'flammable', 'sharps', 'temperature-controlled',
         ARRAY_CONSTRUCT('hospital health pharmaceutical drug'),
         ARRAY_CONSTRUCT('supplies warehouse depot'),
         ARRAY_CONSTRUCT('hospital', 'pharmacy', 'dentist'),
         ARRAY_CONSTRUCT('Explosive goods', 'Sharp instruments', 'Fridge')),
        ('Food', 'Fresh Food Order', 'Frozen Food Order', 'Non Perishable Food Order',
         ARRAY_CONSTRUCT('food vegetables meat'),
         ARRAY_CONSTRUCT('wholesaler warehouse factory'),
         ARRAY_CONSTRUCT('supermarket', 'restaurant', 'butcher_shop'),
         ARRAY_CONSTRUCT('Fresh Food', 'Fridge', 'Premium Delivery')),
        ('Cosmetics', 'Hair Products', 'Electronic Goods', 'Make-up',
         ARRAY_CONSTRUCT('hair cosmetics beauty'),
         ARRAY_CONSTRUCT('wholesaler warehouse factory'),
         ARRAY_CONSTRUCT('supermarket', 'outlet', 'fashion'),
         ARRAY_CONSTRUCT('Fresh Food', 'Fridge', 'Premium Delivery')),
        ('Beverages', 'Alcoholic Beverages', 'Carbonated Drinks', 'Still Water',
         ARRAY_CONSTRUCT('beverage drink brewery'),
         ARRAY_CONSTRUCT('warehouse distribution depot'),
         ARRAY_CONSTRUCT('bar', 'pub', 'restaurant', 'hotel', 'supermarket', 'convenience_store'),
         ARRAY_CONSTRUCT('Age Verification Required', 'Fragile Goods Handler', 'Heavy Load Capacity'));
    END IF;

    DELETE FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.JOB_TEMPLATE WHERE REGION = :REGION_KEY;

    LET job_template_count INT;
    SELECT COUNT(*) INTO :job_template_count
    FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.JOB_TEMPLATE
    WHERE REGION != :REGION_KEY;

    IF (job_template_count > 0) THEN
        LET job_source_region VARCHAR;
        SELECT REGION INTO :job_source_region
        FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.JOB_TEMPLATE
        WHERE REGION != :REGION_KEY
        LIMIT 1;

        INSERT INTO FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.JOB_TEMPLATE (SLOT_START, SLOT_END, SKILLS, PRODUCT, STATUS, REGION)
        SELECT SLOT_START, SLOT_END, SKILLS, PRODUCT, 'active', :REGION_KEY
        FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.JOB_TEMPLATE
        WHERE REGION = :job_source_region;
    ELSE
        INSERT INTO FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.JOB_TEMPLATE (SLOT_START, SLOT_END, SKILLS, PRODUCT, STATUS, REGION)
        SELECT column1, column2, column3, column4, 'active', :REGION_KEY FROM VALUES
        (9,10,1,'pa'),(11,15,2,'pb'),(16,18,2,'pb'),(11,13,3,'pc'),(7,16,3,'pc'),
        (10,15,2,'pa'),(10,15,2,'pa'),(7,16,1,'pa'),(9,18,2,'pb'),(13,18,2,'pb'),
        (13,18,2,'pb'),(13,18,1,'pa'),(13,18,1,'pa'),(13,18,1,'pa'),(13,18,3,'pc'),
        (11,15,2,'pb'),(16,18,2,'pb'),(11,13,1,'pa'),(7,16,1,'pa'),(10,15,2,'pb'),
        (10,15,2,'pb'),(7,16,1,'pa'),(9,18,2,'pb'),(13,18,2,'pb'),(13,18,2,'pb'),
        (13,18,1,'pa'),(13,18,1,'pa'),(13,18,1,'pa'),(13,18,3,'pc');
    END IF;

    SELECT COUNT(*) INTO :row_count
    FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES
    WHERE REGION = :REGION_KEY;

    RETURN 'Seeded ' || row_count || ' places for ' || REGION_KEY;
END;
$$;

ALTER PROCEDURE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SEED_ROUTE_OPTIMIZATION_REGION(VARCHAR)
SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-route-optimization","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

--------------------------------------------------------------------
-- Initial seed for the configured region
--------------------------------------------------------------------
CALL FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SEED_ROUTE_OPTIMIZATION_REGION($REGION_NAME);


