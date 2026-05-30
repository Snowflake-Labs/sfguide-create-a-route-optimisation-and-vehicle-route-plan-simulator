-- =============================================================================
-- TOOL_CREATE_PLANT — Create a new manufacturing plant with building footprints
-- and configurable robot fleet.
-- =============================================================================

USE ROLE ACCOUNTADMIN;
USE WAREHOUSE ROUTING_ANALYTICS;

CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_CREATE_PLANT(
    PLANT_NAME VARCHAR,
    CITY VARCHAR,
    COUNTRY VARCHAR,
    LATITUDE FLOAT,
    LONGITUDE FLOAT,
    SPECIALISATION VARCHAR DEFAULT 'ORAL_SOLIDS',
    CAPACITY_BATCHES_MONTH NUMBER DEFAULT 200,
    SEARCH_RADIUS_M NUMBER DEFAULT 800,
    ROBOT_COUNT NUMBER DEFAULT 24
)
RETURNS VARIANT
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-add-plant-map","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    v_plant_id NUMBER;
    v_plant_code VARCHAR;
    v_buildings_found NUMBER;
    v_campus_count NUMBER;
    v_region VARCHAR;
    v_robots_created NUMBER;
BEGIN
    -- Generate plant ID and code
    SELECT COALESCE(MAX(p.PLANT_ID), 0) + 1 INTO v_plant_id
    FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANTS p;

    v_plant_code := UPPER(SUBSTR(:CITY, 1, 3));

    v_region := CASE
        WHEN :COUNTRY IN ('United States', 'US', 'Canada', 'Brazil', 'Mexico') THEN 'AMERICAS'
        WHEN :COUNTRY IN ('Singapore', 'China', 'Japan', 'India', 'Australia') THEN 'APAC'
        ELSE 'EUROPE'
    END;

    -- Insert plant record
    INSERT INTO FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANTS
        (PLANT_ID, PLANT_CODE, PLANT_NAME, CITY, COUNTRY, REGION, SPECIALISATION,
         CAPACITY_BATCHES_MONTH, GMP_CERTIFIED, ISO_CERTIFIED, LATITUDE, LONGITUDE)
    VALUES (:v_plant_id, :v_plant_code, :PLANT_NAME, :CITY, :COUNTRY, :v_region,
            :SPECIALISATION, :CAPACITY_BATCHES_MONTH, TRUE, TRUE, :LATITUDE, :LONGITUDE);

    -- Discover building footprints from Overture Maps
    INSERT INTO FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANT_BUILDING_FOOTPRINTS
        (PLANT_ID, PLANT_NAME, PLANT_CODE, OVERTURE_ID, GEOJSON, BUILDING_NAME, CLASS, HEIGHT, FOOTPRINT_TYPE)
    SELECT :v_plant_id, :PLANT_NAME, :v_plant_code,
           b.ID, ST_ASGEOJSON(b.GEOMETRY),
           TRY_PARSE_JSON(b.NAMES):primary::STRING,
           b.CLASS, b.HEIGHT, 'BUILDING'
    FROM OVERTURE_MAPS__BUILDINGS.CARTO.BUILDING b
    WHERE ST_DWITHIN(b.GEOMETRY, ST_MAKEPOINT(:LONGITUDE, :LATITUDE), :SEARCH_RADIUS_M)
      AND b.GEOMETRY IS NOT NULL
      AND ST_AREA(b.GEOMETRY) >= 200;

    SELECT COUNT(*) INTO v_buildings_found
    FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANT_BUILDING_FOOTPRINTS
    WHERE PLANT_ID = :v_plant_id;

    SELECT COUNT(*) INTO v_campus_count
    FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANT_BUILDING_FOOTPRINTS
    WHERE PLANT_ID = :v_plant_id AND ST_AREA(TO_GEOGRAPHY(GEOJSON)) >= 500;

    -- Generate robots: distribute ROBOT_COUNT across 6 building roles × 3 floors
    INSERT INTO FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.ROBOT_TELEMETRY
        (SNAPSHOT_TIME, PLANT_ID, PLANT_NAME, BUILDING_ROLE, BUILDING_ROLE_NAME, FLOOR_INDEX,
         ROBOT_ID, ROBOT_TYPE, ROBOT_TYPE_LABEL, STATUS, CURRENT_ZONE, DESTINATION_ZONE,
         BATTERY_PCT, SPEED_MS, VIBRATION_MM_S, ONBOARD_TEMP_C, DISTANCE_TRAVELLED_M,
         UPTIME_HRS, MAINT_DUE_HRS, CARGO_BATCH, CARGO_KG)
    WITH
    buildings AS (
        SELECT column1 AS idx, column2 AS role_id, column3 AS role_name
        FROM (VALUES
            (0, 'api',  'API Manufacturing'),
            (1, 'form', 'Formulation & Filling'),
            (2, 'cold', 'Cold Chain Warehouse'),
            (3, 'qc',   'QC Laboratory'),
            (4, 'util', 'Central Utilities'),
            (5, 'dist', 'Distribution & Dispatch')
        )
    ),
    seq AS (
        SELECT ROW_NUMBER() OVER (ORDER BY SEQ4()) - 1 AS rn
        FROM TABLE(GENERATOR(ROWCOUNT => :ROBOT_COUNT))
    )
    SELECT
        CURRENT_TIMESTAMP(),
        :v_plant_id,
        :PLANT_NAME,
        b.role_id,
        b.role_name,
        MOD(s.rn, 3),
        -- Robot ID: TYPE-PLANTCODE-NNN
        CASE
            WHEN MOD(s.rn, 10) < 5 THEN 'AGV'
            WHEN MOD(s.rn, 10) < 8 THEN 'INSPECT'
            ELSE 'CLEAN'
        END || '-' || :v_plant_code || '-' || LPAD(CAST(s.rn + 1 AS VARCHAR), 3, '0'),
        -- Robot type
        CASE
            WHEN MOD(s.rn, 10) < 5 THEN 'AGV'
            WHEN MOD(s.rn, 10) < 8 THEN 'INSPECT'
            ELSE 'CLEAN'
        END,
        -- Robot type label
        CASE
            WHEN MOD(s.rn, 10) < 5 THEN 'Transport AGV'
            WHEN MOD(s.rn, 10) < 8 THEN 'Inspection Robot'
            ELSE 'Cleaning Robot'
        END,
        -- Status: ~70% moving, ~15% charging, ~10% idle, ~5% error
        CASE MOD(s.rn, 20)
            WHEN 0 THEN 'charging'
            WHEN 5 THEN 'charging'
            WHEN 10 THEN 'charging'
            WHEN 15 THEN 'error'
            ELSE 'moving'
        END,
        'Zone ' || CHR(65 + MOD(s.rn, 6)),
        'Zone ' || CHR(65 + MOD(s.rn + 3, 6)),
        -- Battery: 15-99%
        ROUND(15 + ABS(MOD(HASH(s.rn * 7 + :v_plant_id), 85)), 1),
        -- Speed: 0.3 - 2.0 m/s
        ROUND(0.3 + ABS(MOD(HASH(s.rn * 13 + :v_plant_id), 170)) / 100.0, 2),
        -- Vibration: 0.3 - 3.5 mm/s
        ROUND(0.3 + ABS(MOD(HASH(s.rn * 17 + :v_plant_id), 320)) / 100.0, 2),
        -- Onboard temp: 18-24 C
        ROUND(18 + ABS(MOD(HASH(s.rn * 23 + :v_plant_id), 60)) / 10.0, 1),
        -- Distance: 50-1200m
        ROUND(50 + ABS(MOD(HASH(s.rn * 31 + :v_plant_id), 1150)), 1),
        -- Uptime: 2-30 hrs
        ROUND(2 + ABS(MOD(HASH(s.rn * 37 + :v_plant_id), 280)) / 10.0, 2),
        -- Maintenance due: 0-24 hrs
        ROUND(ABS(MOD(HASH(s.rn * 41 + :v_plant_id), 240)) / 10.0, 2),
        -- Cargo batch (AGVs only)
        CASE WHEN MOD(s.rn, 10) < 5
             THEN 'B-' || :v_plant_code || '-' || LPAD(CAST(ABS(MOD(HASH(s.rn * 43), 999)) AS VARCHAR), 3, '0')
             ELSE NULL END,
        -- Cargo kg (AGVs only)
        CASE WHEN MOD(s.rn, 10) < 5
             THEN ROUND(30 + ABS(MOD(HASH(s.rn * 47 + :v_plant_id), 170)), 1)
             ELSE NULL END
    FROM seq s
    JOIN buildings b ON b.idx = MOD(s.rn, 6);

    SELECT COUNT(*) INTO v_robots_created
    FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.ROBOT_TELEMETRY
    WHERE PLANT_ID = :v_plant_id;

    RETURN OBJECT_CONSTRUCT(
        'status', 'SUCCESS',
        'plant_id', v_plant_id,
        'plant_name', PLANT_NAME,
        'plant_code', v_plant_code,
        'location', OBJECT_CONSTRUCT('lat', LATITUDE, 'lon', LONGITUDE, 'city', CITY, 'country', COUNTRY),
        'region', v_region,
        'specialisation', SPECIALISATION,
        'buildings_discovered', v_buildings_found,
        'campus_buildings', v_campus_count,
        'robots_deployed', v_robots_created,
        'robot_count_requested', ROBOT_COUNT
    );
END;
$$;
