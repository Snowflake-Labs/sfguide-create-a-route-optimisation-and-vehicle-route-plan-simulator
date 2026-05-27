-- =============================================================================
-- 11_pharma_supply_chain_data.sql
-- Deploys all pharma supply chain tables with seed data + robot telemetry.
-- Run AFTER: 10_pharma_agent_tools.sql
-- Source: .cortex/skills/add-pharma-supply-chain/references/
--
-- Creates: PLANTS (6), SUPPLIERS (12), PRODUCTS (17), PRODUCTION_BATCHES (15),
--          SHIPMENTS (13), MATERIAL_INVENTORY (17), ROBOT_TELEMETRY (~294, scaled by capacity),
--          PLANT_BUILDING_FOOTPRINTS (from Overture Maps Buildings),
--          PLANT_ALERT_STATUS (view), PLANT_PRIMARY_BUILDING (view), PLANT_CAMPUS_BUILDINGS (view)
-- =============================================================================

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-add-pharma-supply-chain","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-add-pharma-supply-chain","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- ============================================================
-- PLANTS (6 manufacturing sites)
-- ============================================================
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANTS (
    PLANT_ID NUMBER, PLANT_CODE VARCHAR, PLANT_NAME VARCHAR, CITY VARCHAR, COUNTRY VARCHAR,
    REGION VARCHAR, SPECIALISATION VARCHAR, CAPACITY_BATCHES_MONTH NUMBER,
    GMP_CERTIFIED BOOLEAN, ISO_CERTIFIED BOOLEAN, LATITUDE FLOAT, LONGITUDE FLOAT
) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-add-pharma-supply-chain","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
INSERT INTO FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANTS VALUES
(1,'MCF','Northshire Site','Macclesfield','United Kingdom','EUROPE','ORAL_SOLIDS',320,TRUE,TRUE,53.2583,-2.1236),
(2,'MVI','Hudson Valley Site','Mount Vernon','United States','AMERICAS','INJECTABLES',180,TRUE,TRUE,40.9126,-73.8370),
(3,'SOD','Nordic Biologics Site','Södertälje','Sweden','EUROPE','BIOLOGICS',95,TRUE,TRUE,59.1955,17.6253),
(4,'SIN','Asia Pacific Hub','Singapore','Singapore','APAC','FILL_FINISH',140,TRUE,TRUE,1.3521,103.8198),
(5,'DUN','Dublin Biologics Site','Dunboyne','Ireland','EUROPE','BIOLOGICS',80,TRUE,TRUE,53.4192,-6.4756),
(6,'LUB','South Plains Site','Lubbock','United States','AMERICAS','ORAL_SOLIDS',210,TRUE,TRUE,33.5779,-101.8552);

-- ============================================================
-- ROBOT_TELEMETRY (scaled by plant capacity)
-- Bigger plants = more robots per building
-- ============================================================
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.ROBOT_TELEMETRY (
    TELEMETRY_ID NUMBER AUTOINCREMENT PRIMARY KEY, SNAPSHOT_TIME TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    PLANT_ID NUMBER, PLANT_NAME VARCHAR, BUILDING_ROLE VARCHAR, BUILDING_ROLE_NAME VARCHAR,
    FLOOR_INDEX NUMBER, ROBOT_ID VARCHAR, ROBOT_TYPE VARCHAR, ROBOT_TYPE_LABEL VARCHAR,
    STATUS VARCHAR, CURRENT_ZONE VARCHAR, DESTINATION_ZONE VARCHAR, BATTERY_PCT NUMBER(5,1),
    SPEED_MS NUMBER(5,2), VIBRATION_MM_S NUMBER(5,2), ONBOARD_TEMP_C NUMBER(5,1),
    DISTANCE_TRAVELLED_M NUMBER(10,1), UPTIME_HRS NUMBER(8,2), MAINT_DUE_HRS NUMBER(8,2),
    CARGO_BATCH VARCHAR, CARGO_KG NUMBER(8,1)
) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-add-plant-map","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

INSERT INTO FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.ROBOT_TELEMETRY
  (PLANT_ID, PLANT_NAME, BUILDING_ROLE, BUILDING_ROLE_NAME, FLOOR_INDEX,
   ROBOT_ID, ROBOT_TYPE, ROBOT_TYPE_LABEL, STATUS, CURRENT_ZONE, DESTINATION_ZONE,
   BATTERY_PCT, SPEED_MS, VIBRATION_MM_S, ONBOARD_TEMP_C, DISTANCE_TRAVELLED_M,
   UPTIME_HRS, MAINT_DUE_HRS, CARGO_BATCH, CARGO_KG)
WITH buildings AS (
  SELECT column1 AS role_id, column2 AS role_name FROM (VALUES
    ('api','API Manufacturing'),('form','Formulation & Filling'),('cold','Cold Chain Warehouse'),
    ('qc','QC Laboratory'),('util','Central Utilities'),('dist','Distribution & Dispatch'))
),
zone_map AS (
  SELECT column1 AS role_id, column2 AS z1, column3 AS z2, column4 AS z3, column5 AS z4 FROM (VALUES
    ('api','Reactor Hall','Solvent Store','IPC Lab','Cleanroom Prep A'),
    ('form','Granulation Suite','Tablet Press Area','Blending Room','Vial Filling Line'),
    ('cold','Ultra-Low Freezer','Deep Freeze','Chill Store','Quarantine Cold'),
    ('qc','Wet Chemistry Lab','Microbiology Suite','Sample Receipt','Stability Chambers'),
    ('util','Purified Water System','WFI Generation','Clean Steam Generator','Effluent Treatment'),
    ('dist','Finished Goods Ambient','Finished Goods Cold','Dispatch Bay','Goods Receipt'))
),
robot_templates AS (
  SELECT column1 AS rtype, column2 AS rlabel, column3 AS base_speed FROM (VALUES
    ('AGV','Transport AGV',1.2),('INSPECT','Inspection Robot',0.6),('CLEAN','Cleaning Robot',0.3))
),
plant_robot_count AS (
  SELECT PLANT_ID, PLANT_NAME, CAPACITY_BATCHES_MONTH,
    CASE WHEN CAPACITY_BATCHES_MONTH >= 300 THEN 8
         WHEN CAPACITY_BATCHES_MONTH >= 200 THEN 6
         WHEN CAPACITY_BATCHES_MONTH >= 130 THEN 5
         WHEN CAPACITY_BATCHES_MONTH >= 90  THEN 4
         ELSE 3 END AS ROBOTS_PER_BUILDING
  FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANTS
),
numbered AS (SELECT ROW_NUMBER() OVER (ORDER BY TRUE) AS SEQ FROM TABLE(GENERATOR(ROWCOUNT => 8))),
base AS (
  SELECT p.PLANT_ID, p.PLANT_NAME, p.ROBOTS_PER_BUILDING,
    b.role_id, b.role_name, z.z1, z.z2, z.z3, z.z4,
    n.SEQ AS ROBOT_NUM, rt.rtype, rt.rlabel, rt.base_speed,
    ABS(HASH(p.PLANT_ID * 101 + n.SEQ * 37 + HASH(b.role_id) + HASH(rt.rtype))) AS seed
  FROM plant_robot_count p
  CROSS JOIN buildings b JOIN zone_map z ON z.role_id = b.role_id
  CROSS JOIN numbered n CROSS JOIN robot_templates rt
  WHERE n.SEQ <= p.ROBOTS_PER_BUILDING
    AND (rt.rtype = 'AGV' OR (rt.rtype = 'INSPECT' AND n.SEQ <= 2) OR (rt.rtype = 'CLEAN' AND n.SEQ <= 1))
)
SELECT PLANT_ID, PLANT_NAME, role_id, role_name, 0,
  rtype || '-' || LPAD(CAST(ROBOT_NUM AS VARCHAR), 2, '0'), rtype, rlabel,
  CASE WHEN MOD(seed,15)=0 THEN 'charging' WHEN MOD(seed,40)=0 THEN 'error' ELSE 'moving' END,
  CASE MOD(seed,4) WHEN 0 THEN z1 WHEN 1 THEN z2 WHEN 2 THEN z3 ELSE z4 END,
  CASE MOD(seed+1,4) WHEN 0 THEN z1 WHEN 1 THEN z2 WHEN 2 THEN z3 ELSE z4 END,
  ROUND(20+MOD(seed,80),1), ROUND(base_speed*(0.7+MOD(seed,60)/100.0),2),
  ROUND(0.5+MOD(seed,200)/100.0,2), ROUND(18.0+MOD(seed,80)/10.0,1),
  ROUND(50+MOD(seed,950),1), ROUND(4+MOD(seed,360)/10.0,2), ROUND(MOD(seed,300)/10.0,2),
  CASE rtype WHEN 'AGV' THEN 'B-'||LPAD(CAST(2000+MOD(seed,500) AS VARCHAR),4,'0') ELSE NULL END,
  CASE rtype WHEN 'AGV' THEN ROUND(20+MOD(seed,180),1) ELSE NULL END
FROM base;

-- ============================================================
-- PLANT_BUILDING_FOOTPRINTS (from Overture Maps Buildings)
-- ============================================================
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANT_BUILDING_FOOTPRINTS
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-add-plant-map","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
WITH PLANT_BOUNDS AS (
    SELECT PLANT_ID, PLANT_NAME, PLANT_CODE, LATITUDE, LONGITUDE,
        LONGITUDE - 0.008 AS MIN_LON, LONGITUDE + 0.008 AS MAX_LON,
        LATITUDE - 0.008 AS MIN_LAT, LATITUDE + 0.008 AS MAX_LAT
    FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANTS
)
SELECT p.PLANT_ID, p.PLANT_NAME, p.PLANT_CODE, b.ID AS OVERTURE_ID,
    ST_ASGEOJSON(b.GEOMETRY) AS GEOJSON, TRY_PARSE_JSON(b.NAMES):primary::STRING AS BUILDING_NAME,
    b.CLASS, b.HEIGHT, 'BUILDING' AS FOOTPRINT_TYPE
FROM PLANT_BOUNDS p
JOIN OVERTURE_MAPS__BUILDINGS.CARTO.BUILDING b
  ON b.BBOX:xmin::FLOAT >= p.MIN_LON AND b.BBOX:xmax::FLOAT <= p.MAX_LON
 AND b.BBOX:ymin::FLOAT >= p.MIN_LAT AND b.BBOX:ymax::FLOAT <= p.MAX_LAT
 AND b.GEOMETRY IS NOT NULL;

-- ============================================================
-- VIEWS (depend on footprints + supply chain tables)
-- ============================================================
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANT_CAMPUS_BUILDINGS AS
WITH RANKED AS (
  SELECT *, ROUND(ST_AREA(TO_GEOGRAPHY(GEOJSON)), 0) AS AREA_SQM,
    ROW_NUMBER() OVER (PARTITION BY PLANT_ID ORDER BY ST_AREA(TO_GEOGRAPHY(GEOJSON)) DESC) AS RNK
  FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANT_BUILDING_FOOTPRINTS
  WHERE GEOJSON IS NOT NULL AND ST_AREA(TO_GEOGRAPHY(GEOJSON)) >= 500
)
SELECT PLANT_ID, PLANT_NAME, PLANT_CODE, OVERTURE_ID, GEOJSON, BUILDING_NAME, CLASS, HEIGHT, FOOTPRINT_TYPE, AREA_SQM, RNK AS CAMPUS_RANK
FROM RANKED WHERE RNK <= 6;

CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANT_PRIMARY_BUILDING AS
WITH RANKED AS (
  SELECT *, ROUND(ST_AREA(TO_GEOGRAPHY(GEOJSON::VARIANT::STRING)), 0) AS AREA_SQM,
    ROW_NUMBER() OVER (PARTITION BY PLANT_ID ORDER BY ST_AREA(TO_GEOGRAPHY(GEOJSON::VARIANT::STRING)) DESC) AS RNK
  FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANT_BUILDING_FOOTPRINTS WHERE GEOJSON IS NOT NULL
)
SELECT PLANT_ID, PLANT_NAME, PLANT_CODE, OVERTURE_ID, GEOJSON, BUILDING_NAME, CLASS, HEIGHT, FOOTPRINT_TYPE, AREA_SQM
FROM RANKED WHERE RNK = 1;

CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANT_ALERT_STATUS
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-add-plant-map","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT pl.PLANT_ID, pl.PLANT_NAME, pl.PLANT_CODE, pl.CITY, pl.COUNTRY, pl.REGION,
    pl.SPECIALISATION, pl.CAPACITY_BATCHES_MONTH, pl.LATITUDE, pl.LONGITUDE,
    GREATEST(
        COALESCE(MAX(CASE WHEN b.STATUS='ON_HOLD' AND b.DEVIATION_SEVERITY='CRITICAL' THEN 4 WHEN b.STATUS='REJECTED' THEN 4
             WHEN b.STATUS='ON_HOLD' AND b.DEVIATION_SEVERITY='MAJOR' THEN 3 WHEN b.STATUS='QC_REVIEW' AND b.QC_RESULT='FAIL' THEN 3
             WHEN b.DEVIATION_COUNT>0 THEN 1 ELSE 0 END),0),
        COALESCE(MAX(CASE WHEN mi.TEMP_EXCURSION_FLAG=TRUE THEN 3 ELSE 0 END),0),
        COALESCE(MAX(CASE WHEN mi.STOCK_STATUS='CRITICAL' THEN 2 WHEN mi.STOCK_STATUS='LOW' THEN 1 ELSE 0 END),0),
        COALESCE(MAX(CASE WHEN sh.STATUS IN ('DELAYED','CUSTOMS') AND sh.DELAY_DAYS>=7 THEN 2 WHEN sh.STATUS IN ('DELAYED','CUSTOMS') THEN 1 ELSE 0 END),0)
    ) AS MAX_SEVERITY,
    COUNT(DISTINCT CASE WHEN b.STATUS IN ('ON_HOLD','REJECTED') THEN b.BATCH_ID END) AS CRITICAL_BATCHES,
    COUNT(DISTINCT CASE WHEN mi.TEMP_EXCURSION_FLAG=TRUE THEN mi.INVENTORY_ID END) AS TEMP_EXCURSIONS,
    COUNT(DISTINCT CASE WHEN mi.STOCK_STATUS='CRITICAL' THEN mi.INVENTORY_ID END) AS CRITICAL_STOCK_ITEMS,
    COUNT(DISTINCT CASE WHEN sh.STATUS IN ('DELAYED','CUSTOMS') THEN sh.SHIPMENT_ID END) AS DELAYED_SHIPMENTS,
    COUNT(DISTINCT CASE WHEN b.STATUS='IN_PROGRESS' THEN b.BATCH_ID END) AS BATCHES_IN_PROGRESS
FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANTS pl
LEFT JOIN FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PRODUCTION_BATCHES b ON b.PLANT_ID=pl.PLANT_ID
LEFT JOIN FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.MATERIAL_INVENTORY mi ON mi.PLANT_ID=pl.PLANT_ID
LEFT JOIN FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.SHIPMENTS sh ON sh.PLANT_ID=pl.PLANT_ID
GROUP BY pl.PLANT_ID, pl.PLANT_NAME, pl.PLANT_CODE, pl.CITY, pl.COUNTRY, pl.REGION,
    pl.SPECIALISATION, pl.CAPACITY_BATCHES_MONTH, pl.LATITUDE, pl.LONGITUDE;
