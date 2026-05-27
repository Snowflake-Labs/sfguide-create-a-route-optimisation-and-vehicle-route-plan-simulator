-- =============================================================================
-- deploy-robot-telemetry.sql
-- Creates ROBOT_TELEMETRY table with synthetic data for all 6 plants
-- and updates PHARMA_SUPPLY_CHAIN_SV to include the ROBOTS entity.
-- =============================================================================

USE ROLE ACCOUNTADMIN;
USE WAREHOUSE ROUTING_ANALYTICS;
USE DATABASE FLEET_INTELLIGENCE;
USE SCHEMA PHARMA_SUPPLY_CHAIN;

-- =============================================================================
-- 1. ROBOT_TELEMETRY TABLE
-- =============================================================================

CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.ROBOT_TELEMETRY (
    TELEMETRY_ID         NUMBER AUTOINCREMENT PRIMARY KEY,
    SNAPSHOT_TIME        TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    PLANT_ID             NUMBER,
    PLANT_NAME           VARCHAR,
    BUILDING_ROLE        VARCHAR,
    BUILDING_ROLE_NAME   VARCHAR,
    FLOOR_INDEX          NUMBER,
    ROBOT_ID             VARCHAR,
    ROBOT_TYPE           VARCHAR,
    ROBOT_TYPE_LABEL     VARCHAR,
    STATUS               VARCHAR,
    CURRENT_ZONE         VARCHAR,
    DESTINATION_ZONE     VARCHAR,
    BATTERY_PCT          NUMBER(5,1),
    SPEED_MS             NUMBER(5,2),
    VIBRATION_MM_S       NUMBER(5,2),
    ONBOARD_TEMP_C       NUMBER(5,1),
    DISTANCE_TRAVELLED_M NUMBER(10,1),
    UPTIME_HRS           NUMBER(8,2),
    MAINT_DUE_HRS        NUMBER(8,2),
    CARGO_BATCH          VARCHAR,
    CARGO_KG             NUMBER(8,1)
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-add-plant-map","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- =============================================================================
-- 2. POPULATE WITH SYNTHETIC DATA
--    Deterministic values via HASH() — matches browser seeding approach.
--    6 plants × 6 buildings × 4 robots = 144 rows.
-- =============================================================================

INSERT INTO FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.ROBOT_TELEMETRY
  (PLANT_ID, PLANT_NAME, BUILDING_ROLE, BUILDING_ROLE_NAME, FLOOR_INDEX,
   ROBOT_ID, ROBOT_TYPE, ROBOT_TYPE_LABEL, STATUS, CURRENT_ZONE, DESTINATION_ZONE,
   BATTERY_PCT, SPEED_MS, VIBRATION_MM_S, ONBOARD_TEMP_C, DISTANCE_TRAVELLED_M,
   UPTIME_HRS, MAINT_DUE_HRS, CARGO_BATCH, CARGO_KG)
WITH buildings AS (
  SELECT column1 AS role_id, column2 AS role_name
  FROM (VALUES
    ('api',  'API Manufacturing'),
    ('form', 'Formulation & Filling'),
    ('cold', 'Cold Chain Warehouse'),
    ('qc',   'QC Laboratory'),
    ('util', 'Central Utilities'),
    ('dist', 'Distribution & Dispatch')
  )
),
zone_map AS (
  SELECT column1 AS role_id, column2 AS zone_a, column3 AS zone_b, column4 AS zone_c, column5 AS zone_d
  FROM (VALUES
    ('api',  'Reactor Hall',              'Solvent Store',         'IPC Lab',                'Cleanroom Prep A'),
    ('form', 'Granulation Suite',         'Tablet Press Area',     'Blending Room',          'Vial Filling Line'),
    ('cold', 'Ultra-Low Freezer',         'Deep Freeze',           'Chill Store',            'Quarantine Cold'),
    ('qc',   'Wet Chemistry Lab',         'Microbiology Suite',    'Sample Receipt',         'Stability Chambers'),
    ('util', 'Purified Water System',     'WFI Generation',        'Clean Steam Generator',  'Effluent Treatment'),
    ('dist', 'Finished Goods Ambient',    'Finished Goods Cold',   'Dispatch Bay',           'Goods Receipt')
  )
),
robots AS (
  SELECT column1 AS rtype, column2 AS rletter, column3 AS rlabel, column4 AS rspeed_base
  FROM (VALUES
    ('AGV',     'A', 'Transport AGV',    1.2),
    ('AGV',     'B', 'Transport AGV',    1.2),
    ('INSPECT', 'C', 'Inspection Robot', 0.6),
    ('CLEAN',   'D', 'Cleaning Robot',   0.3)
  )
),
base AS (
  SELECT
    p.PLANT_ID, p.PLANT_NAME,
    b.role_id, b.role_name,
    0 AS floor_index,
    r.rtype, r.rletter, r.rlabel, r.rspeed_base,
    z.zone_a, z.zone_b, z.zone_c, z.zone_d,
    -- seed for this robot
    ABS(HASH(p.PLANT_ID * 37 + ASCII(r.rletter) * 13 + HASH(b.role_id))) AS seed
  FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANTS p
  CROSS JOIN buildings b
  JOIN zone_map z ON z.role_id = b.role_id
  CROSS JOIN robots r
)
SELECT
  PLANT_ID, PLANT_NAME, role_id, role_name, floor_index,
  rtype || '-' || rletter                                   AS robot_id,
  rtype                                                     AS robot_type,
  rlabel                                                    AS robot_type_label,
  CASE WHEN MOD(seed, 20) = 0 THEN 'charging'
       WHEN MOD(seed, 50) = 0 THEN 'error'
       ELSE 'moving' END                                    AS status,
  -- current zone (pick one of the 4 zones based on seed)
  CASE MOD(seed, 4)
    WHEN 0 THEN zone_a WHEN 1 THEN zone_b WHEN 2 THEN zone_c ELSE zone_d
  END                                                       AS current_zone,
  -- destination zone (different from current)
  CASE MOD(seed + 1, 4)
    WHEN 0 THEN zone_a WHEN 1 THEN zone_b WHEN 2 THEN zone_c ELSE zone_d
  END                                                       AS destination_zone,
  -- battery 25-100%
  ROUND(25 + MOD(seed, 75), 1)                             AS battery_pct,
  -- speed: base + seed variation
  ROUND(rspeed_base + MOD(seed, 100)/62.5 * CASE rtype WHEN 'AGV' THEN 1 WHEN 'INSPECT' THEN 0.5 ELSE 0.3 END, 2) AS speed_ms,
  -- vibration: AGV 0.8-2.5, CLEAN 1.5-3.5, INSPECT 0
  CASE rtype
    WHEN 'AGV'     THEN ROUND(0.8 + MOD(seed, 100)/59.0, 2)
    WHEN 'CLEAN'   THEN ROUND(1.5 + MOD(seed, 100)/50.0, 2)
    ELSE 0.0
  END                                                       AS vibration_mm_s,
  -- onboard temperature
  ROUND(20.0 + MOD(seed, 40)/20.0 + CASE rtype WHEN 'AGV' THEN 1.2 ELSE 0 END, 1) AS onboard_temp_c,
  -- distance: AGV travels furthest
  ROUND(100 + MOD(seed, 900) * CASE rtype WHEN 'AGV' THEN 1 WHEN 'INSPECT' THEN 0.7 ELSE 0.4 END, 1) AS distance_m,
  -- uptime 8-36 hours
  ROUND(8 + MOD(seed, 280)/10.0, 2)                       AS uptime_hrs,
  -- maintenance due: 0-25 hours
  ROUND(MOD(seed + PLANT_ID * 7, 250)/10.0, 2)            AS maint_due_hrs,
  -- cargo: AGV only
  CASE rtype
    WHEN 'AGV' THEN 'B-' || LPAD(CAST(2200 + MOD(seed, 300) AS VARCHAR), 4, '0')
    ELSE NULL
  END                                                       AS cargo_batch,
  CASE rtype
    WHEN 'AGV' THEN ROUND(40 + MOD(seed, 160), 1)
    ELSE NULL
  END                                                       AS cargo_kg
FROM base;

-- Verify
SELECT ROBOT_TYPE, COUNT(*) AS cnt, ROUND(AVG(BATTERY_PCT),1) AS avg_battery,
       ROUND(AVG(MAINT_DUE_HRS),1) AS avg_maint_hrs
FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.ROBOT_TELEMETRY
GROUP BY ROBOT_TYPE;

-- =============================================================================
-- 3. UPDATED PHARMA_SUPPLY_CHAIN_SV — includes ROBOTS entity
-- =============================================================================

CREATE OR REPLACE SEMANTIC VIEW FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PHARMA_SUPPLY_CHAIN_SV
TABLES (
  FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PRODUCTS        primary key (PRODUCT_ID)  comment = 'Drug products across 4 business lines',
  FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANTS           primary key (PLANT_ID)    comment = '6 manufacturing sites worldwide',
  FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.SUPPLIERS        primary key (SUPPLIER_ID) comment = 'API and excipient suppliers',
  BATCHES  as FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PRODUCTION_BATCHES primary key (BATCH_ID)     comment = 'Production batch records',
  FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.SHIPMENTS        primary key (SHIPMENT_ID) comment = 'Inbound material shipments',
  INVENTORY as FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.MATERIAL_INVENTORY primary key (INVENTORY_ID) comment = 'Raw material stock at each plant',
  ROBOTS  as FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.ROBOT_TELEMETRY primary key (TELEMETRY_ID) comment = 'Live robot telemetry — one snapshot per robot per plant/building. Types: AGV (Transport), INSPECT (Inspection), CLEAN (Cleaning). Status: moving, charging, error.'
)
RELATIONSHIPS (
  PRODUCTS_TO_PLANTS     as PRODUCTS(PLANT_ID)             references PLANTS(PLANT_ID),
  PRODUCTS_TO_SUPPLIERS  as PRODUCTS(PRIMARY_SUPPLIER_ID)  references SUPPLIERS(SUPPLIER_ID),
  BATCHES_TO_PRODUCTS    as BATCHES(PRODUCT_ID)            references PRODUCTS(PRODUCT_ID),
  SHIPMENTS_TO_PRODUCTS  as SHIPMENTS(PRODUCT_ID)          references PRODUCTS(PRODUCT_ID),
  INVENTORY_TO_PRODUCTS  as INVENTORY(PRODUCT_ID)          references PRODUCTS(PRODUCT_ID),
  ROBOTS_TO_PLANTS       as ROBOTS(PLANT_ID)               references PLANTS(PLANT_ID)
)
DIMENSIONS (
  PRODUCTS.PRODUCT_NAME          as products.PRODUCT_NAME                    comment = 'Drug product name',
  PRODUCTS.BUSINESS_LINE         as products.BUSINESS_LINE                   comment = 'ONCOLOGY, CARDIOVASCULAR, RESPIRATORY, BIOLOGICS',
  PRODUCTS.FORMULATION           as products.FORMULATION                     comment = 'TABLET, INJECTABLE, BIOLOGIC, INHALER',
  PRODUCTS.PRODUCT_STOCK_STATUS  as products.STOCK_STATUS                    comment = 'Finished product stock status',

  PLANTS.PLANT_NAME              as plants.PLANT_NAME                        comment = 'Manufacturing site name',
  PLANTS.PLANT_CITY              as plants.CITY                              comment = 'City where plant is located',
  PLANTS.PLANT_COUNTRY           as plants.COUNTRY                           comment = 'Country where plant is located',
  PLANTS.PLANT_REGION            as plants.REGION                            comment = 'EUROPE, AMERICAS, APAC',
  PLANTS.SPECIALISATION          as plants.SPECIALISATION                    comment = 'Plant specialisation area',

  SUPPLIERS.SUPPLIER_NAME        as suppliers.SUPPLIER_NAME                  comment = 'Supplier company name',
  SUPPLIERS.SUPPLIER_TYPE        as suppliers.SUPPLIER_TYPE                  comment = 'API, EXCIPIENT, PACKAGING, CONTRACT_MFG',
  SUPPLIERS.GMP_STATUS           as suppliers.GMP_STATUS                     comment = 'APPROVED, PROBATION, SUSPENDED',
  SUPPLIERS.SUPPLIER_COUNTRY     as suppliers.COUNTRY                        comment = 'Country where supplier is based',
  SUPPLIERS.SINGLE_SOURCE        as suppliers.SINGLE_SOURCE                  comment = 'Single source supplier flag',

  BATCHES.BATCH_STATUS           as batches.STATUS                           comment = 'IN_PROGRESS, QC_REVIEW, ON_HOLD, REJECTED, RELEASED',
  BATCHES.BATCH_NUMBER           as batches.BATCH_NUMBER                     comment = 'Batch identifier',
  BATCHES.QC_RESULT              as batches.QC_RESULT                        comment = 'PASS, FAIL, PENDING',
  BATCHES.DEVIATION_SEVERITY     as batches.DEVIATION_SEVERITY               comment = 'NONE, MINOR, MAJOR, CRITICAL',

  SHIPMENTS.SHIPMENT_STATUS      as shipments.STATUS                         comment = 'ORDERED, IN_TRANSIT, CUSTOMS, DELAYED, DELIVERED',
  SHIPMENTS.DELAY_REASON         as shipments.DELAY_REASON                   comment = 'Reason for shipment delay',

  INVENTORY.MATERIAL_STOCK_STATUS as inventory.STOCK_STATUS                  comment = 'CRITICAL, LOW, ADEQUATE, EXCESS',
  INVENTORY.MATERIAL_TYPE        as inventory.MATERIAL_TYPE                  comment = 'API or EXCIPIENT',
  INVENTORY.TEMP_EXCURSION       as inventory.TEMP_EXCURSION_FLAG            comment = 'Temperature excursion flag',

  ROBOTS.ROBOT_ID                as robots.ROBOT_ID                          comment = 'Robot identifier e.g. AGV-A, INSPECT-C',
  ROBOTS.ROBOT_TYPE              as robots.ROBOT_TYPE                        comment = 'AGV, INSPECT, or CLEAN',
  ROBOTS.ROBOT_TYPE_LABEL        as robots.ROBOT_TYPE_LABEL                  comment = 'Transport AGV, Inspection Robot, or Cleaning Robot',
  ROBOTS.ROBOT_STATUS            as robots.STATUS                            comment = 'moving, charging, or error',
  ROBOTS.BUILDING_ROLE           as robots.BUILDING_ROLE                     comment = 'api, form, cold, qc, util, or dist',
  ROBOTS.BUILDING_ROLE_NAME      as robots.BUILDING_ROLE_NAME                comment = 'Full building name e.g. API Manufacturing, Cold Chain Warehouse',
  ROBOTS.CURRENT_ZONE            as robots.CURRENT_ZONE                      comment = 'Room/zone the robot is currently in',
  ROBOTS.DESTINATION_ZONE        as robots.DESTINATION_ZONE                  comment = 'Room/zone the robot is heading toward',
  ROBOTS.CARGO_BATCH             as robots.CARGO_BATCH                       comment = 'Batch number being transported — AGV only, null for other types',
  ROBOTS.ROBOT_PLANT_NAME        as robots.PLANT_NAME                        comment = 'Plant name where robot is deployed'
)
METRICS (
  SUPPLIERS.AVG_RELIABILITY_SCORE  as AVG(suppliers.RELIABILITY_SCORE)       comment = 'Supplier reliability score 0-100',
  SUPPLIERS.AVG_ON_TIME_PCT        as AVG(suppliers.ON_TIME_DELIVERY_PCT)    comment = 'On-time delivery percentage',
  SUPPLIERS.AVG_QUALITY_SCORE      as AVG(suppliers.QUALITY_SCORE)           comment = 'Batch acceptance rate 0-100',
  SUPPLIERS.AVG_LEAD_TIME          as AVG(suppliers.AVG_LEAD_TIME_DAYS)      comment = 'Average supplier lead time in days',

  INVENTORY.AVG_DAYS_OF_COVERAGE   as AVG(inventory.DAYS_OF_COVERAGE)        comment = 'Days of raw material remaining',
  INVENTORY.TOTAL_STOCK_KG         as SUM(inventory.STOCK_KG)                comment = 'Total raw material in kg',

  BATCHES.TOTAL_BATCH_COST         as SUM(batches.COST_USD)                  comment = 'Total batch cost in USD',
  BATCHES.AVG_YIELD                as AVG(batches.YIELD_PCT)                 comment = 'Average manufacturing yield pct',
  BATCHES.TOTAL_DEVIATIONS         as SUM(batches.DEVIATION_COUNT)           comment = 'Total batch deviations',

  SHIPMENTS.TOTAL_SHIPMENT_VALUE   as SUM(shipments.TOTAL_VALUE_USD)         comment = 'Total inbound shipment value USD',
  SHIPMENTS.AVG_DELAY_DAYS         as AVG(shipments.DELAY_DAYS)              comment = 'Average shipment delay in days',

  ROBOTS.TOTAL_ROBOTS              as COUNT(robots.TELEMETRY_ID)             comment = 'Total number of robots',
  ROBOTS.AVG_BATTERY_PCT           as AVG(robots.BATTERY_PCT)                comment = 'Average robot battery percentage',
  ROBOTS.AVG_SPEED_MS              as AVG(robots.SPEED_MS)                   comment = 'Average robot speed in m/s',
  ROBOTS.AVG_VIBRATION             as AVG(robots.VIBRATION_MM_S)             comment = 'Average vibration in mm/s',
  ROBOTS.AVG_UPTIME_HRS            as AVG(robots.UPTIME_HRS)                 comment = 'Average robot uptime in hours',
  ROBOTS.AVG_MAINT_DUE_HRS         as AVG(robots.MAINT_DUE_HRS)             comment = 'Average hours until next maintenance',
  ROBOTS.TOTAL_DISTANCE_M          as SUM(robots.DISTANCE_TRAVELLED_M)       comment = 'Total distance travelled by all robots in metres'
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-add-pharma-supply-chain","version":{"major":1,"minor":0}}'
ai_verified_queries (
  ROBOTS_NEED_MAINTENANCE AS (
    QUESTION 'Which robots need maintenance in the next 4 hours?'
    VERIFIED_AT 1779100000
    VERIFIED_BY '(STEWARD = ACCOUNTADMIN)'
    SQL 'SELECT ROBOT_ID, ROBOT_TYPE_LABEL, PLANT_NAME, BUILDING_ROLE_NAME, ROUND(MAINT_DUE_HRS, 1) AS MAINT_DUE_HOURS FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.ROBOT_TELEMETRY WHERE MAINT_DUE_HRS < 4 ORDER BY MAINT_DUE_HRS'
  ),
  ROBOTS_PER_PLANT AS (
    QUESTION 'How many robots are active per plant?'
    VERIFIED_AT 1779100000
    VERIFIED_BY '(STEWARD = ACCOUNTADMIN)'
    SQL 'SELECT PLANT_NAME, COUNT(*) AS TOTAL_ROBOTS, SUM(CASE WHEN STATUS = ''moving'' THEN 1 ELSE 0 END) AS ACTIVE_ROBOTS, SUM(CASE WHEN STATUS = ''charging'' THEN 1 ELSE 0 END) AS CHARGING_ROBOTS FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.ROBOT_TELEMETRY GROUP BY PLANT_NAME ORDER BY PLANT_NAME'
  ),
  AGV_CARGO AS (
    QUESTION 'Show me all AGVs currently transporting batches'
    VERIFIED_AT 1779100000
    VERIFIED_BY '(STEWARD = ACCOUNTADMIN)'
    SQL 'SELECT ROBOT_ID, PLANT_NAME, BUILDING_ROLE_NAME, CARGO_BATCH, ROUND(CARGO_KG, 0) AS CARGO_KG, CURRENT_ZONE, DESTINATION_ZONE FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.ROBOT_TELEMETRY WHERE ROBOT_TYPE = ''AGV'' AND CARGO_BATCH IS NOT NULL ORDER BY PLANT_NAME, ROBOT_ID'
  ),
  LOW_BATTERY_ROBOTS AS (
    QUESTION 'Which robots have battery below 20 percent?'
    VERIFIED_AT 1779100000
    VERIFIED_BY '(STEWARD = ACCOUNTADMIN)'
    SQL 'SELECT ROBOT_ID, ROBOT_TYPE_LABEL, PLANT_NAME, BUILDING_ROLE_NAME, ROUND(BATTERY_PCT, 1) AS BATTERY_PCT, STATUS, CURRENT_ZONE FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.ROBOT_TELEMETRY WHERE BATTERY_PCT < 20 ORDER BY BATTERY_PCT'
  )
);

-- Remove old individual ALTER statements (replaced by inline ai_verified_queries above)

-- Verify
SELECT 'ROBOT_TELEMETRY rows' AS check_name, COUNT(*) AS result FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.ROBOT_TELEMETRY
UNION ALL
SELECT 'Robots needing maintenance (<4h)', COUNT(*) FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.ROBOT_TELEMETRY WHERE maint_due_hrs < 4
UNION ALL
SELECT 'Low battery robots (<20%)', COUNT(*) FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.ROBOT_TELEMETRY WHERE battery_pct < 20
UNION ALL
SELECT 'AGVs with cargo', COUNT(*) FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.ROBOT_TELEMETRY WHERE robot_type='AGV' AND cargo_batch IS NOT NULL;
