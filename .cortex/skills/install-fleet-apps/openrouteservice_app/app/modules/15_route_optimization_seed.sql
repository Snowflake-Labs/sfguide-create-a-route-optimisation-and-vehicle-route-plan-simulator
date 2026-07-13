--------------------------------------------------------------------
-- 15_route_optimization_seed.sql
-- Owns the FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION schema, tables, and the
-- SEED_ROUTE_OPTIMIZATION_REGION procedure. Loaded as an engine module by
-- install-fleet-apps so the proc is always present BEFORE any region is provisioned via
-- PROVISION_REGION_WRAPPER (which calls this proc as part of region setup).
--
-- 100% region-agnostic: every parameter and table key is REGION_KEY.
-- Idempotent: CREATE TABLE IF NOT EXISTS, CREATE OR REPLACE PROCEDURE, and
-- ALTER TABLE ADD COLUMN IF NOT EXISTS so re-deploys are safe and migrate
-- older installs in place.
--------------------------------------------------------------------

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

--------------------------------------------------------------------
-- DATABASE / SCHEMA
--------------------------------------------------------------------
CREATE DATABASE IF NOT EXISTS FLEET_INTELLIGENCE
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

--------------------------------------------------------------------
-- CONFIG (single-row per active region pointer)
--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG (
    VEHICLE_TYPE VARCHAR NOT NULL,
    REGION       VARCHAR NOT NULL
)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

--------------------------------------------------------------------
-- PLACES (multi-region; populated from Overture Maps inside the proc)
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
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- Search optimization is idempotent (re-applying is a no-op).
ALTER TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES ADD SEARCH OPTIMIZATION ON EQUALITY(ALTERNATE);
ALTER TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES ADD SEARCH OPTIMIZATION ON GEO(GEOMETRY);

--------------------------------------------------------------------
-- JOB_TEMPLATE
--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.JOB_TEMPLATE (
    ID INT AUTOINCREMENT PRIMARY KEY,
    SLOT_START INT NOT NULL,
    SLOT_END INT,
    SKILLS INT,
    PRODUCT STRING,
    STATUS STRING DEFAULT 'active',
    REGION STRING,
    INDUSTRY STRING
)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

ALTER TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.JOB_TEMPLATE ADD COLUMN IF NOT EXISTS INDUSTRY STRING;

--------------------------------------------------------------------
-- LOOKUP (industry configuration; per-region)
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
    STYPE ARRAY,
    SOURCE_TABLE STRING DEFAULT NULL,
    DEPOT_CTYPE ARRAY DEFAULT NULL,
    DEPOT_LABEL STRING DEFAULT NULL
)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- Backfill columns for installs created before depot/source-table were added.
ALTER TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP ADD COLUMN IF NOT EXISTS SOURCE_TABLE STRING;
ALTER TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP ADD COLUMN IF NOT EXISTS DEPOT_CTYPE ARRAY;
ALTER TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP ADD COLUMN IF NOT EXISTS DEPOT_LABEL STRING;

--------------------------------------------------------------------
-- SEN_STUDENTS (override table for SEN Transport industry)
--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SEN_STUDENTS (
    REGION STRING,
    NAME STRING,
    CATEGORY STRING DEFAULT 'student_pickup',
    LNG FLOAT,
    LAT FLOAT,
    ADDRESS VARIANT,
    DISPLAY_ADDRESS STRING
)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

--------------------------------------------------------------------
-- SEED_ROUTE_OPTIMIZATION_REGION procedure
-- Dynamically seeds PLACES, LOOKUP, JOB_TEMPLATE, SEN_STUDENTS for any region
-- using Overture Maps data and bbox/boundary from REGION_REGISTRY/REGION_CATALOG.
-- Idempotent: skips PLACES if already populated; LOOKUP & JOB_TEMPLATE always
-- DELETE+INSERT for the target region; SEN_STUDENTS DELETE+INSERT.
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

    IF (seed_places AND min_lat IS NULL) THEN
        RETURN 'ERROR: No bbox found for region ' || REGION_KEY || '. Register it in REGION_REGISTRY or REGION_CATALOG first.';
    END IF;

    IF (seed_places) THEN
        INSERT INTO FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES (REGION, GEOMETRY, PHONES, CATEGORY, NAME, ADDRESS, ALTERNATE)
        WITH region_boundary AS (
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

        INSERT INTO FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP (REGION, INDUSTRY, PA, PB, PC, IND, IND2, CTYPE, STYPE, SOURCE_TABLE, DEPOT_CTYPE, DEPOT_LABEL)
        SELECT :REGION_KEY, INDUSTRY, PA, PB, PC, IND, IND2, CTYPE, STYPE, SOURCE_TABLE, DEPOT_CTYPE, DEPOT_LABEL
        FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP
        WHERE REGION = :source_region;
    ELSE
        INSERT INTO FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP (REGION, INDUSTRY, PA, PB, PC, IND, IND2, CTYPE, STYPE, SOURCE_TABLE, DEPOT_CTYPE, DEPOT_LABEL)
        SELECT :REGION_KEY, 'healthcare', 'flammable', 'sharps', 'temperature-controlled',
            ARRAY_CONSTRUCT('hospital health pharmaceutical drug healthcare pharmacy surgical'),
            ARRAY_CONSTRUCT('supplies warehouse depot distribution wholesaler distributors'),
            ARRAY_CONSTRUCT('hospital', 'family_practice', 'dentist', 'pharmacy'),
            ARRAY_CONSTRUCT('Can handle potentially explosive goods', 'Can handle instruments that could be used as weapons', 'Has a fridge'),
            NULL,
            ARRAY_CONSTRUCT('warehouses', 'medical_supply', 'storage_facility'),
            'Supplier Depot'
        UNION ALL
        SELECT :REGION_KEY, 'Food', 'Fresh Food Order', 'Frozen Food Order', 'Non Perishable Food Order',
            ARRAY_CONSTRUCT('food vegetables meat'),
            ARRAY_CONSTRUCT('wholesaler warehouse factory processing distribution distributors'),
            ARRAY_CONSTRUCT('supermarket', 'restaurant', 'butcher_shop'),
            ARRAY_CONSTRUCT('Can deliver Fresh Food', 'Has a Fridge', 'Premium Delivery'),
            NULL,
            ARRAY_CONSTRUCT('warehouses', 'food_beverage_service_distribution', 'storage_facility'),
            'Distribution Depot'
        UNION ALL
        SELECT :REGION_KEY, 'Cosmetics', 'Hair Products', 'Electronic Goods', 'Make-up',
            ARRAY_CONSTRUCT('hair cosmetics make-up beauty'),
            ARRAY_CONSTRUCT('wholesaler warehouse factory supplies distribution distributors'),
            ARRAY_CONSTRUCT('supermarket', 'outlet', 'fashion'),
            ARRAY_CONSTRUCT('Can deliver Fresh Food', 'Has a Fridge', 'Premium Delivery'),
            NULL,
            ARRAY_CONSTRUCT('warehouses', 'distribution_services', 'storage_facility'),
            'Distribution Centre'
        UNION ALL
        SELECT :REGION_KEY, 'Beverages', 'Alcoholic Beverages', 'Carbonated Drinks', 'Still Water',
            ARRAY_CONSTRUCT('beverage drink brewery distillery bottling winery'),
            ARRAY_CONSTRUCT('warehouse distribution depot factory wholesaler'),
            ARRAY_CONSTRUCT('bar', 'pub', 'restaurant', 'hotel', 'supermarket', 'convenience_store'),
            ARRAY_CONSTRUCT('Age Verification Required', 'Fragile Goods Handler', 'Heavy Load Capacity'),
            NULL,
            ARRAY_CONSTRUCT('warehouses', 'brewery', 'distillery', 'winery'),
            'Distribution Depot'
        UNION ALL
        SELECT :REGION_KEY, 'SEN Transport', 'Solo Taxi (1 child, chaperone required)', 'Shared Taxi (2-3 children)', 'Minibus (6-8 children)',
            ARRAY_CONSTRUCT('special needs school education SEN disability autism ADHD'),
            ARRAY_CONSTRUCT('school academy college nursery pupil referral unit'),
            ARRAY_CONSTRUCT('school', 'elementary_school', 'high_school', 'middle_school'),
            ARRAY_CONSTRUCT('Solo Taxi + Chaperone', 'Shared Taxi (Behavioural)', 'Accessible Minibus'),
            'FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SEN_STUDENTS',
            ARRAY_CONSTRUCT('school', 'elementary_school', 'high_school', 'middle_school', 'private_school'),
            'School Destinations';
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

        INSERT INTO FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.JOB_TEMPLATE (SLOT_START, SLOT_END, SKILLS, PRODUCT, STATUS, REGION, INDUSTRY)
        SELECT SLOT_START, SLOT_END, SKILLS, PRODUCT, 'active', :REGION_KEY, INDUSTRY
        FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.JOB_TEMPLATE
        WHERE REGION = :job_source_region;
    ELSE
        INSERT INTO FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.JOB_TEMPLATE (SLOT_START, SLOT_END, SKILLS, PRODUCT, STATUS, REGION, INDUSTRY)
        SELECT column1, column2, column3, column4, 'active', :REGION_KEY, column5 FROM VALUES
        (32400,36000,1,'pa','healthcare'),(39600,54000,2,'pb','healthcare'),(57600,64800,2,'pb','healthcare'),
        (39600,46800,3,'pc','healthcare'),(25200,57600,3,'pc','healthcare'),(36000,54000,2,'pa','healthcare'),
        (46800,64800,1,'pa','healthcare'),
        (39600,54000,2,'pb','Food'),(57600,64800,2,'pb','Food'),(39600,46800,1,'pa','Food'),
        (25200,57600,1,'pa','Food'),(36000,54000,2,'pb','Food'),(36000,54000,2,'pb','Food'),
        (25200,57600,1,'pa','Food'),(32400,64800,2,'pb','Food'),
        (46800,64800,2,'pb','Cosmetics'),(46800,64800,2,'pb','Cosmetics'),(46800,64800,1,'pa','Cosmetics'),
        (46800,64800,1,'pa','Cosmetics'),(46800,64800,1,'pa','Cosmetics'),(46800,64800,3,'pc','Cosmetics'),
        (32400,64800,2,'pb','Cosmetics'),
        (32400,64800,2,'pb','Beverages'),(46800,64800,2,'pb','Beverages'),(46800,64800,2,'pb','Beverages'),
        (46800,64800,1,'pa','Beverages'),(46800,64800,1,'pa','Beverages'),(46800,64800,1,'pa','Beverages'),
        (46800,64800,3,'pc','Beverages'),
        (25200,30600,1,'pa','SEN Transport'),(25200,30600,1,'pa','SEN Transport'),(25200,30600,1,'pa','SEN Transport'),
        (25200,32400,2,'pb','SEN Transport'),(25200,32400,2,'pb','SEN Transport'),(25200,32400,2,'pb','SEN Transport'),
        (25200,32400,2,'pb','SEN Transport'),(25200,32400,3,'pc','SEN Transport'),(25200,32400,3,'pc','SEN Transport'),
        (25200,32400,3,'pc','SEN Transport'),(54000,59400,1,'pa','SEN Transport'),(54000,59400,1,'pa','SEN Transport'),
        (54000,59400,1,'pa','SEN Transport'),(54000,61200,2,'pb','SEN Transport'),(54000,61200,2,'pb','SEN Transport'),
        (54000,61200,2,'pb','SEN Transport'),(54000,61200,2,'pb','SEN Transport'),(54000,61200,3,'pc','SEN Transport'),
        (54000,61200,3,'pc','SEN Transport'),(54000,61200,3,'pc','SEN Transport');
    END IF;

    DELETE FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SEN_STUDENTS WHERE REGION = :REGION_KEY;

    BEGIN
        INSERT INTO FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SEN_STUDENTS (REGION, NAME, CATEGORY, LNG, LAT, ADDRESS, DISPLAY_ADDRESS)
        SELECT
            :REGION_KEY,
            'Student ' || ROW_NUMBER() OVER (ORDER BY RANDOM()),
            'student_pickup',
            ST_X(GEOMETRY),
            ST_Y(GEOMETRY),
            ADDRESS,
            ADDRESS:freeform::VARCHAR || ', ' || ADDRESS:locality::VARCHAR
        FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES
        WHERE REGION = :REGION_KEY
          AND ADDRESS:freeform IS NOT NULL
          AND ADDRESS:locality::VARCHAR IS NOT NULL
          AND CATEGORY IN ('real_estate_agent','landmark_and_historical_building','community_services_non_profits','home_health_care','professional_services')
          AND ST_DWITHIN(GEOMETRY, (SELECT ST_COLLECT(GEOMETRY) FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES WHERE REGION = :REGION_KEY AND CATEGORY = 'school' LIMIT 1), 15000)
        ORDER BY RANDOM()
        LIMIT 60;
    EXCEPTION WHEN OTHER THEN NULL;
    END;

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
SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
