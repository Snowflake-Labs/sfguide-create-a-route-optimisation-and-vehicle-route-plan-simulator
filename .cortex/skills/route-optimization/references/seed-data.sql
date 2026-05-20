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

-- ALTER TABLE ... ADD SEARCH OPTIMIZATION does NOT support IF NOT EXISTS in Snowflake.
-- These statements are idempotent: re-running on a table that already has the optimization
-- is a no-op (returns "Statement executed successfully" without error).
ALTER TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES ADD SEARCH OPTIMIZATION ON EQUALITY(ALTERNATE);
ALTER TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES ADD SEARCH OPTIMIZATION ON GEO(GEOMETRY);

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
    -- Per-table idempotency: only the (large) PLACES insert is skipped when already populated.
    -- LOOKUP and JOB_TEMPLATE are tiny + deterministic and use DELETE+INSERT, so they're
    -- always reseeded. This prevents the F6 failure mode where a partial earlier run left
    -- PLACES populated but LOOKUP/JOB_TEMPLATE empty and the proc short-circuited.
    LET places_count INT;
    LET lookup_count INT;
    LET jobs_count INT;
    SELECT COUNT(*) INTO :places_count FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES       WHERE REGION = :REGION_KEY;
    SELECT COUNT(*) INTO :lookup_count FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP        WHERE REGION = :REGION_KEY;
    SELECT COUNT(*) INTO :jobs_count   FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.JOB_TEMPLATE WHERE REGION = :REGION_KEY;

    LET seed_places BOOLEAN := (places_count = 0);

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
        WHERE UPPER(LOOKUP_NAME) = UPPER(:REGION_KEY) OR UPPER(REGION_KEY) = UPPER(:REGION_KEY) OR UPPER(REGION_NAME) = UPPER(:REGION_KEY)
        LIMIT 1;
    END IF;

    -- bbox is required only when we actually need to (re)seed PLACES.
    IF (seed_places AND min_lat IS NULL) THEN
        RETURN 'ERROR: No bbox found for region ' || REGION_KEY || '. Register it in REGION_REGISTRY or REGION_CATALOG first.';
    END IF;

    IF (seed_places) THEN
        INSERT INTO FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES (REGION, GEOMETRY, PHONES, CATEGORY, NAME, ADDRESS, ALTERNATE)
        WITH region_boundary AS (
            -- Polygon refinement so non-rectangular regions (California, Italy,
            -- Chile) don't pull in POIs from neighboring states / oceans / countries.
            -- COALESCE-with-TRUE pattern: if the region has no catalog row or
            -- BOUNDARY is NULL, gracefully degrade to bbox-only filtering.
            SELECT BOUNDARY FROM OPENROUTESERVICE_APP.CORE.REGION_CATALOG
            WHERE (UPPER(LOOKUP_NAME) = UPPER(:REGION_KEY)
                   OR UPPER(REGION_KEY) = UPPER(:REGION_KEY)
                   OR UPPER(REGION_NAME) = UPPER(:REGION_KEY))
              AND BOUNDARY IS NOT NULL
            ORDER BY BOUNDARY_AREA_KM2 ASC
            LIMIT 1
        )
        SELECT
            :REGION_KEY,
            p.GEOMETRY,
            p.PHONES[0]::TEXT,
            p.CATEGORIES:primary::TEXT,
            p.NAMES:primary::TEXT,
            p.ADDRESSES[0],
            COALESCE(p.CATEGORIES:alternate:list, ARRAY_CONSTRUCT())
        FROM OVERTURE_MAPS__PLACES.CARTO.PLACE p
        LEFT JOIN region_boundary rb ON TRUE
        WHERE ST_X(p.GEOMETRY) BETWEEN :min_lon AND :max_lon
          AND ST_Y(p.GEOMETRY) BETWEEN :min_lat AND :max_lat
          AND COALESCE(ST_INTERSECTS(p.GEOMETRY, rb.BOUNDARY), TRUE)
          AND p.CATEGORIES:primary IS NOT NULL;
    END IF;

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
        -- NOTE: Snowflake disallows ARRAY_CONSTRUCT() inside a VALUES (...) row constructor
        -- (`Invalid expression [ARRAY_CONSTRUCT(...)] in VALUES clause`). Use SELECT ... UNION ALL
        -- to construct array columns inline. See AGENTS.md > "Loading GEOGRAPHY Data" for the same
        -- restriction on ST_MAKEPOINT in VALUES.
        INSERT INTO FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP (REGION, INDUSTRY, PA, PB, PC, IND, IND2, CTYPE, STYPE)
        SELECT :REGION_KEY, 'Healthcare', 'flammable', 'sharps', 'temperature-controlled',
            ARRAY_CONSTRUCT('hospital health pharmaceutical drug'),
            ARRAY_CONSTRUCT('supplies warehouse depot'),
            ARRAY_CONSTRUCT('hospital', 'pharmacy', 'dentist'),
            ARRAY_CONSTRUCT('Explosive goods', 'Sharp instruments', 'Fridge')
        UNION ALL
        SELECT :REGION_KEY, 'Food', 'Fresh Food Order', 'Frozen Food Order', 'Non Perishable Food Order',
            ARRAY_CONSTRUCT('food vegetables meat'),
            ARRAY_CONSTRUCT('wholesaler warehouse factory'),
            ARRAY_CONSTRUCT('supermarket', 'restaurant', 'butcher_shop'),
            ARRAY_CONSTRUCT('Fresh Food', 'Fridge', 'Premium Delivery')
        UNION ALL
        SELECT :REGION_KEY, 'Cosmetics', 'Hair Products', 'Electronic Goods', 'Make-up',
            ARRAY_CONSTRUCT('hair cosmetics beauty'),
            ARRAY_CONSTRUCT('wholesaler warehouse factory'),
            ARRAY_CONSTRUCT('supermarket', 'outlet', 'fashion'),
            ARRAY_CONSTRUCT('Fresh Food', 'Fridge', 'Premium Delivery')
        UNION ALL
        SELECT :REGION_KEY, 'Beverages', 'Alcoholic Beverages', 'Carbonated Drinks', 'Still Water',
            ARRAY_CONSTRUCT('beverage drink brewery'),
            ARRAY_CONSTRUCT('warehouse distribution depot'),
            ARRAY_CONSTRUCT('bar', 'pub', 'restaurant', 'hotel', 'supermarket', 'convenience_store'),
            ARRAY_CONSTRUCT('Age Verification Required', 'Fragile Goods Handler', 'Heavy Load Capacity');
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

    -- Refresh counts to report what was actually persisted.
    SELECT COUNT(*) INTO :places_count FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES       WHERE REGION = :REGION_KEY;
    SELECT COUNT(*) INTO :lookup_count FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP        WHERE REGION = :REGION_KEY;
    SELECT COUNT(*) INTO :jobs_count   FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.JOB_TEMPLATE WHERE REGION = :REGION_KEY;

    RETURN 'Seeded for ' || REGION_KEY || ': places=' || places_count
        || ', lookup=' || lookup_count
        || ', job_template=' || jobs_count
        || (CASE WHEN seed_places THEN ' (places freshly inserted)' ELSE ' (places preserved from prior run)' END);
END;
$$;

ALTER PROCEDURE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SEED_ROUTE_OPTIMIZATION_REGION(VARCHAR)
SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-route-optimization","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

--------------------------------------------------------------------
-- Initial seed for the configured region
--------------------------------------------------------------------
CALL FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SEED_ROUTE_OPTIMIZATION_REGION($REGION_NAME);


