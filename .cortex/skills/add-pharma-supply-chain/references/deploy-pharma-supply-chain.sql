-- =============================================================================
-- deploy-pharma-supply-chain.sql
-- Pharma Upstream Supply Chain Intelligence
-- Models the manufacturer's upstream view:
--   API Suppliers → Manufacturing Plants → Batch Production → Distribution
--
-- Business lines: ONCOLOGY / CARDIOVASCULAR / RESPIRATORY / BIOLOGICS
-- Plants: Macclesfield UK, Mount Vernon US, Södertälje SE, Singapore SG
-- Mirrors the structure of the manufacturing supply chain listing but
-- tailored entirely to pharmaceutical manufacturing context.
-- =============================================================================

USE ROLE ACCOUNTADMIN;
USE WAREHOUSE ROUTING_ANALYTICS;
USE DATABASE FLEET_INTELLIGENCE;

CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN;
USE SCHEMA FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN;

-- =============================================================================
-- 1. MANUFACTURING PLANTS
-- =============================================================================

CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANTS (
    PLANT_ID        NUMBER,
    PLANT_CODE      VARCHAR,
    PLANT_NAME      VARCHAR,
    CITY            VARCHAR,
    COUNTRY         VARCHAR,
    REGION          VARCHAR,    -- EUROPE / AMERICAS / APAC
    SPECIALISATION  VARCHAR,    -- ORAL_SOLIDS / INJECTABLES / BIOLOGICS / FILL_FINISH
    CAPACITY_BATCHES_MONTH NUMBER,
    GMP_CERTIFIED   BOOLEAN,
    ISO_CERTIFIED   BOOLEAN,
    LATITUDE        FLOAT,
    LONGITUDE       FLOAT
);

INSERT INTO FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANTS VALUES
(1, 'MCF', 'Macclesfield',     'Macclesfield', 'United Kingdom', 'EUROPE',   'ORAL_SOLIDS',  320, TRUE, TRUE,  53.2583, -2.1236),
(2, 'MVI', 'Mount Vernon',     'Mount Vernon', 'United States',  'AMERICAS', 'INJECTABLES',  180, TRUE, TRUE,  40.9126, -73.8370),
(3, 'SOD', 'Södertälje',       'Södertälje',   'Sweden',         'EUROPE',   'BIOLOGICS',     95, TRUE, TRUE,  59.1955,  17.6253),
(4, 'SIN', 'Singapore',        'Singapore',    'Singapore',      'APAC',     'FILL_FINISH',  140, TRUE, TRUE,   1.3521, 103.8198),
(5, 'DUN', 'Dunboyne',         'Dunboyne',     'Ireland',        'EUROPE',   'BIOLOGICS',     80, TRUE, TRUE,  53.4192,  -6.4756),
(6, 'LUB', 'Lubbock',          'Lubbock',      'United States',  'AMERICAS', 'ORAL_SOLIDS',  210, TRUE, TRUE,  33.5779, -101.8552);

-- =============================================================================
-- 2. SUPPLIERS — API and excipient manufacturers
-- =============================================================================

CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.SUPPLIERS (
    SUPPLIER_ID         NUMBER,
    SUPPLIER_NAME       VARCHAR,
    SUPPLIER_TYPE       VARCHAR,    -- API / EXCIPIENT / PACKAGING / CONTRACT_MFG
    COUNTRY             VARCHAR,
    REGION              VARCHAR,
    RELIABILITY_SCORE   FLOAT,      -- 0-100
    AVG_LEAD_TIME_DAYS  NUMBER,
    ON_TIME_DELIVERY_PCT FLOAT,
    QUALITY_SCORE       FLOAT,      -- 0-100 (batch acceptance rate)
    GMP_STATUS          VARCHAR,    -- APPROVED / PROBATION / SUSPENDED
    LAST_AUDIT_DATE     DATE,
    AUDIT_RESULT        VARCHAR,    -- PASS / MINOR_OBSERVATIONS / CRITICAL_FINDINGS
    SINGLE_SOURCE       BOOLEAN     -- TRUE = risk: only supplier for this material
);

INSERT INTO FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.SUPPLIERS VALUES
(1,  'Aurobindo Pharma',          'API',          'India',        'APAC',     92.1, 45, 94.2, 96.8, 'APPROVED',   DATEADD(day,-120,CURRENT_DATE()), 'PASS',               FALSE),
(2,  'Dr. Reddys Laboratories',   'API',          'India',        'APAC',     88.4, 52, 91.7, 94.1, 'APPROVED',   DATEADD(day,-90, CURRENT_DATE()), 'PASS',               FALSE),
(3,  'Lonza Group',               'CONTRACT_MFG', 'Switzerland',  'EUROPE',   96.3, 28, 97.8, 98.2, 'APPROVED',   DATEADD(day,-60, CURRENT_DATE()), 'PASS',               TRUE),
(4,  'Wuxi Biologics',            'CONTRACT_MFG', 'China',        'APAC',     74.2, 68, 78.3, 89.6, 'PROBATION',  DATEADD(day,-30, CURRENT_DATE()), 'MINOR_OBSERVATIONS', FALSE),
(5,  'Evonik Industries',         'EXCIPIENT',    'Germany',      'EUROPE',   97.8, 21, 98.9, 99.1, 'APPROVED',   DATEADD(day,-180,CURRENT_DATE()), 'PASS',               FALSE),
(6,  'BASF Pharma Solutions',     'EXCIPIENT',    'Germany',      'EUROPE',   95.4, 24, 96.2, 97.4, 'APPROVED',   DATEADD(day,-150,CURRENT_DATE()), 'PASS',               FALSE),
(7,  'Piramal Pharma',            'API',          'India',        'APAC',     83.7, 58, 86.4, 91.2, 'APPROVED',   DATEADD(day,-100,CURRENT_DATE()), 'PASS',               FALSE),
(8,  'Siegfried Holding',         'CONTRACT_MFG', 'Switzerland',  'EUROPE',   91.2, 32, 93.7, 95.8, 'APPROVED',   DATEADD(day,-75, CURRENT_DATE()), 'PASS',               TRUE),
(9,  'Cambrex Corporation',       'API',          'United States','AMERICAS',  89.6, 38, 92.1, 94.7, 'APPROVED',   DATEADD(day,-110,CURRENT_DATE()), 'PASS',               FALSE),
(10, 'Strides Pharma',            'API',          'India',        'APAC',     71.8, 72, 74.2, 85.3, 'PROBATION',  DATEADD(day,-45, CURRENT_DATE()), 'CRITICAL_FINDINGS',  FALSE),
(11, 'Schreiner MediPharm',       'PACKAGING',    'Germany',      'EUROPE',   98.1, 18, 99.0, 99.5, 'APPROVED',   DATEADD(day,-200,CURRENT_DATE()), 'PASS',               FALSE),
(12, 'Daicel Corporation',        'EXCIPIENT',    'Japan',        'APAC',     93.4, 35, 94.8, 96.3, 'APPROVED',   DATEADD(day,-130,CURRENT_DATE()), 'PASS',               TRUE);

-- =============================================================================
-- 3. PRODUCTS — drug products mapped to business lines
-- =============================================================================

CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PRODUCTS (
    PRODUCT_ID       NUMBER,
    PRODUCT_CODE     VARCHAR,
    PRODUCT_NAME     VARCHAR,
    BUSINESS_LINE    VARCHAR,    -- ONCOLOGY / CARDIOVASCULAR / RESPIRATORY / BIOLOGICS
    FORMULATION      VARCHAR,    -- TABLET / INJECTABLE / BIOLOGIC / INHALER
    PLANT_ID         NUMBER,     -- primary manufacturing site
    PRIMARY_SUPPLIER_ID NUMBER,
    BACKUP_SUPPLIER_ID  NUMBER,
    SHELF_LIFE_MONTHS   NUMBER,
    COLD_CHAIN_REQUIRED BOOLEAN,
    SAFETY_STOCK_BATCHES NUMBER,
    CURRENT_STOCK_BATCHES NUMBER,
    REORDER_POINT_BATCHES NUMBER,
    STOCK_STATUS     VARCHAR     -- CRITICAL / LOW / ADEQUATE / OVERSTOCKED
);

INSERT INTO FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PRODUCTS VALUES
-- ONCOLOGY
(1,  'ONC-001', 'Tagrisso (Osimertinib)',     'ONCOLOGY',      'TABLET',    1, 1,  2,  36, FALSE, 8,  6,  10, 'LOW'),
(2,  'ONC-002', 'Imfinzi (Durvalumab)',       'ONCOLOGY',      'INJECTABLE',2, 3,  NULL,24, TRUE,  4,  2,  5,  'CRITICAL'),
(3,  'ONC-003', 'Calquence (Acalabrutinib)',  'ONCOLOGY',      'TABLET',    1, 7,  9,  30, FALSE, 6,  9,  8,  'ADEQUATE'),
(4,  'ONC-004', 'Lynparza (Olaparib)',        'ONCOLOGY',      'TABLET',    6, 9,  1,  30, FALSE, 5,  3,  6,  'CRITICAL'),
(5,  'ONC-005', 'Enhertu (T-DXd)',           'ONCOLOGY',      'INJECTABLE',2, 8,  NULL,18, TRUE,  3,  1,  4,  'CRITICAL'),
-- CARDIOVASCULAR
(6,  'CVS-001', 'Farxiga (Dapagliflozin)',   'CARDIOVASCULAR','TABLET',    1, 2,  7,  36, FALSE, 10, 14, 12, 'ADEQUATE'),
(7,  'CVS-002', 'Brilinta (Ticagrelor)',      'CARDIOVASCULAR','TABLET',    6, 7,  9,  30, FALSE, 8,  5,  9,  'LOW'),
(8,  'CVS-003', 'Lokelma (Sodium Zirconium)','CARDIOVASCULAR','TABLET',    1, 5,  6,  24, FALSE, 6,  18, 7,  'OVERSTOCKED'),
(9,  'CVS-004', 'Onglyza (Saxagliptin)',      'CARDIOVASCULAR','TABLET',    6, 9,  2,  30, FALSE, 7,  4,  8,  'LOW'),
-- RESPIRATORY
(10, 'RSP-001', 'Symbicort (Budesonide)',     'RESPIRATORY',   'INHALER',   4, 5,  6,  24, FALSE, 12, 8,  14, 'LOW'),
(11, 'RSP-002', 'Breztri (BGF Inhaler)',      'RESPIRATORY',   'INHALER',   4, 6,  5,  24, FALSE, 8,  22, 10, 'OVERSTOCKED'),
(12, 'RSP-003', 'Fasenra (Benralizumab)',     'RESPIRATORY',   'INJECTABLE',2, 3,  8,  18, TRUE,  4,  2,  5,  'CRITICAL'),
(13, 'RSP-004', 'Tezspire (Tezepelumab)',     'RESPIRATORY',   'INJECTABLE',5, 3,  NULL,18, TRUE,  3,  1,  4,  'CRITICAL'),
-- BIOLOGICS
(14, 'BIO-001', 'Soliris (Eculizumab)',       'BIOLOGICS',     'BIOLOGIC',  3, 3,  NULL,24, TRUE,  2,  1,  3,  'CRITICAL'),
(15, 'BIO-002', 'Ultomiris (Ravulizumab)',    'BIOLOGICS',     'BIOLOGIC',  3, 3,  NULL,18, TRUE,  2,  2,  3,  'ADEQUATE'),
(16, 'BIO-003', 'Synagis (Palivizumab)',      'BIOLOGICS',     'BIOLOGIC',  5, 8,  3,  18, TRUE,  3,  3,  4,  'ADEQUATE'),
(17, 'BIO-004', 'FluMist (LAIV)',             'BIOLOGICS',     'BIOLOGIC',  3, 3,  NULL,12, TRUE,  4,  1,  5,  'CRITICAL');

-- =============================================================================
-- 4. PRODUCTION BATCHES — recent batch history
-- =============================================================================

CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PRODUCTION_BATCHES (
    BATCH_ID          NUMBER,
    BATCH_NUMBER      VARCHAR,
    PRODUCT_ID        NUMBER,
    PLANT_ID          NUMBER,
    PLANNED_START     DATE,
    ACTUAL_START      DATE,
    PLANNED_COMPLETE  DATE,
    ACTUAL_COMPLETE   DATE,
    BATCH_SIZE_UNITS  NUMBER,
    STATUS            VARCHAR,   -- PLANNED / IN_PROGRESS / QC_REVIEW / RELEASED / REJECTED / ON_HOLD
    QC_RESULT         VARCHAR,   -- PASS / FAIL / PENDING
    YIELD_PCT         FLOAT,
    DEVIATION_COUNT   NUMBER,
    DEVIATION_SEVERITY VARCHAR,  -- NONE / MINOR / MAJOR / CRITICAL
    COST_USD          FLOAT
);

INSERT INTO FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PRODUCTION_BATCHES VALUES
(1,  'MCF-2024-001', 1,  1, DATEADD(day,-60,CURRENT_DATE()), DATEADD(day,-59,CURRENT_DATE()), DATEADD(day,-45,CURRENT_DATE()), DATEADD(day,-44,CURRENT_DATE()), 50000, 'RELEASED',     'PASS',    97.2, 1, 'MINOR',    285000),
(2,  'MCF-2024-002', 3,  1, DATEADD(day,-55,CURRENT_DATE()), DATEADD(day,-54,CURRENT_DATE()), DATEADD(day,-40,CURRENT_DATE()), DATEADD(day,-38,CURRENT_DATE()), 45000, 'RELEASED',     'PASS',    98.4, 0, 'NONE',     195000),
(3,  'MVI-2024-001', 2,  2, DATEADD(day,-45,CURRENT_DATE()), DATEADD(day,-43,CURRENT_DATE()), DATEADD(day,-28,CURRENT_DATE()), NULL,                            8000,  'QC_REVIEW',    'PENDING', 96.1, 2, 'MINOR',    1820000),
(4,  'MVI-2024-002', 5,  2, DATEADD(day,-30,CURRENT_DATE()), DATEADD(day,-30,CURRENT_DATE()), DATEADD(day,-15,CURRENT_DATE()), NULL,                            6500,  'ON_HOLD',      'FAIL',    88.3, 4, 'CRITICAL', 2350000),  -- Critical hold!
(5,  'SOD-2024-001', 14, 3, DATEADD(day,-90,CURRENT_DATE()), DATEADD(day,-88,CURRENT_DATE()), DATEADD(day,-60,CURRENT_DATE()), DATEADD(day,-58,CURRENT_DATE()), 2000,  'RELEASED',     'PASS',    94.8, 1, 'MINOR',    4200000),
(6,  'SOD-2024-002', 15, 3, DATEADD(day,-50,CURRENT_DATE()), DATEADD(day,-49,CURRENT_DATE()), DATEADD(day,-22,CURRENT_DATE()), DATEADD(day,-20,CURRENT_DATE()), 1800,  'RELEASED',     'PASS',    96.2, 0, 'NONE',     3850000),
(7,  'SOD-2024-003', 17, 3, DATEADD(day,-25,CURRENT_DATE()), DATEADD(day,-24,CURRENT_DATE()), DATEADD(day,  5,CURRENT_DATE()), NULL,                            1500,  'IN_PROGRESS',  'PENDING', NULL, 0, 'NONE',     3100000),
(8,  'SIN-2024-001', 10, 4, DATEADD(day,-35,CURRENT_DATE()), DATEADD(day,-34,CURRENT_DATE()), DATEADD(day,-12,CURRENT_DATE()), DATEADD(day,-10,CURRENT_DATE()), 180000,'RELEASED',     'PASS',    99.1, 0, 'NONE',     142000),
(9,  'SIN-2024-002', 11, 4, DATEADD(day,-40,CURRENT_DATE()), DATEADD(day,-38,CURRENT_DATE()), DATEADD(day,-15,CURRENT_DATE()), DATEADD(day,-14,CURRENT_DATE()), 160000,'RELEASED',     'PASS',    98.7, 1, 'MINOR',    128000),
(10, 'DUN-2024-001', 16, 5, DATEADD(day,-70,CURRENT_DATE()), DATEADD(day,-68,CURRENT_DATE()), DATEADD(day,-42,CURRENT_DATE()), DATEADD(day,-40,CURRENT_DATE()), 3500,  'RELEASED',     'PASS',    95.4, 2, 'MINOR',    2800000),
(11, 'LUB-2024-001', 6,  6, DATEADD(day,-28,CURRENT_DATE()), DATEADD(day,-27,CURRENT_DATE()), DATEADD(day,  2,CURRENT_DATE()), NULL,                            85000, 'IN_PROGRESS',  'PENDING', NULL, 0, 'NONE',     245000),
(12, 'LUB-2024-002', 7,  6, DATEADD(day,-20,CURRENT_DATE()), DATEADD(day,-19,CURRENT_DATE()), DATEADD(day, 10,CURRENT_DATE()), NULL,                            72000, 'IN_PROGRESS',  'PENDING', NULL, 1, 'MINOR',    210000),
(13, 'MCF-2024-003', 4,  1, DATEADD(day,-15,CURRENT_DATE()), DATEADD(day,-14,CURRENT_DATE()), DATEADD(day, 15,CURRENT_DATE()), NULL,                            55000, 'IN_PROGRESS',  'PENDING', NULL, 0, 'NONE',     320000),
(14, 'MVI-2024-003', 12, 2, DATEADD(day,-10,CURRENT_DATE()), DATEADD(day,-10,CURRENT_DATE()), DATEADD(day, 20,CURRENT_DATE()), NULL,                            5000,  'IN_PROGRESS',  'PENDING', NULL, 0, 'NONE',     1650000),
(15, 'MCF-2024-REJ', 1,  1, DATEADD(day,-80,CURRENT_DATE()), DATEADD(day,-79,CURRENT_DATE()), DATEADD(day,-65,CURRENT_DATE()), DATEADD(day,-62,CURRENT_DATE()), 50000, 'REJECTED',     'FAIL',    76.2, 8, 'CRITICAL', 285000); -- Rejected batch cost

-- =============================================================================
-- 5. SHIPMENTS — inbound API/material shipments from suppliers
-- =============================================================================

CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.SHIPMENTS (
    SHIPMENT_ID         NUMBER,
    SHIPMENT_REF        VARCHAR,
    SUPPLIER_ID         NUMBER,
    PRODUCT_ID          NUMBER,    -- which product this material feeds
    PLANT_ID            NUMBER,    -- destination plant
    MATERIAL_TYPE       VARCHAR,   -- API / EXCIPIENT / PACKAGING
    QUANTITY_KG         FLOAT,
    ORDER_DATE          DATE,
    PLANNED_ARRIVAL     DATE,
    ACTUAL_ARRIVAL      DATE,
    STATUS              VARCHAR,   -- ORDERED / IN_TRANSIT / CUSTOMS / DELIVERED / DELAYED
    DELAY_DAYS          NUMBER,
    DELAY_REASON        VARCHAR,
    COLD_CHAIN_REQUIRED BOOLEAN,
    TEMP_EXCURSION      BOOLEAN,   -- cold chain breach
    UNIT_COST_USD       FLOAT,
    TOTAL_VALUE_USD     FLOAT
);

INSERT INTO FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.SHIPMENTS VALUES
(1,  'SHP-2024-001', 1,  1,  1, 'API',       850.0,  DATEADD(day,-75,CURRENT_DATE()), DATEADD(day,-30,CURRENT_DATE()), DATEADD(day,-28,CURRENT_DATE()), 'DELIVERED', 0,  NULL,                FALSE, FALSE, 1200.00, 1020000),
(2,  'SHP-2024-002', 3,  2,  2, 'API',       12.5,   DATEADD(day,-60,CURRENT_DATE()), DATEADD(day,-20,CURRENT_DATE()), DATEADD(day,-18,CURRENT_DATE()), 'DELIVERED', 0,  NULL,                TRUE,  FALSE, 85000.00,1062500),
(3,  'SHP-2024-003', 4,  5,  2, 'API',       8.0,    DATEADD(day,-45,CURRENT_DATE()), DATEADD(day,-10,CURRENT_DATE()), NULL,                            'DELAYED',   12, 'CUSTOMS_HOLD',      TRUE,  FALSE, 120000.00,960000),
(4,  'SHP-2024-004', 10, 4,  1, 'API',       620.0,  DATEADD(day,-40,CURRENT_DATE()), DATEADD(day, -5,CURRENT_DATE()), NULL,                            'IN_TRANSIT',0,  NULL,                FALSE, FALSE, 950.00,  589000),
(5,  'SHP-2024-005', 5,  10, 4, 'EXCIPIENT', 2400.0, DATEADD(day,-30,CURRENT_DATE()), DATEADD(day,  5,CURRENT_DATE()), NULL,                            'IN_TRANSIT',0,  NULL,                FALSE, FALSE, 45.00,   108000),
(6,  'SHP-2024-006', 3,  14, 3, 'API',       2.1,    DATEADD(day,-90,CURRENT_DATE()), DATEADD(day,-55,CURRENT_DATE()), DATEADD(day,-52,CURRENT_DATE()), 'DELIVERED', 0,  NULL,                TRUE,  FALSE, 2800000.00,5880000),
(7,  'SHP-2024-007', 7,  7,  6, 'API',       540.0,  DATEADD(day,-35,CURRENT_DATE()), DATEADD(day,  3,CURRENT_DATE()), NULL,                            'IN_TRANSIT',0,  NULL,                FALSE, FALSE, 1100.00, 594000),
(8,  'SHP-2024-008', 2,  6,  1, 'API',       920.0,  DATEADD(day,-50,CURRENT_DATE()), DATEADD(day, -8,CURRENT_DATE()), NULL,                            'DELAYED',   8,  'PORT_CONGESTION',   FALSE, FALSE, 880.00,  809600),
(9,  'SHP-2024-009', 8,  13, 5, 'API',       6.8,    DATEADD(day,-20,CURRENT_DATE()), DATEADD(day, 18,CURRENT_DATE()), NULL,                            'ORDERED',   0,  NULL,                TRUE,  FALSE, 95000.00, 646000),
(10, 'SHP-2024-010', 3,  12, 2, 'API',       9.2,    DATEADD(day,-25,CURRENT_DATE()), DATEADD(day, 12,CURRENT_DATE()), NULL,                            'IN_TRANSIT',0,  NULL,                TRUE,  TRUE,  78000.00, 717600), -- TEMP EXCURSION!
(11, 'SHP-2024-011', 11, 1,  1, 'PACKAGING', 50000.0,DATEADD(day,-15,CURRENT_DATE()), DATEADD(day,  8,CURRENT_DATE()), NULL,                            'ORDERED',   0,  NULL,                FALSE, FALSE, 0.85,    42500),
(12, 'SHP-2024-012', 10, 9,  6, 'API',       480.0,  DATEADD(day,-10,CURRENT_DATE()), DATEADD(day, 25,CURRENT_DATE()), NULL,                            'ORDERED',   0,  NULL,                FALSE, FALSE, 920.00,  441600),
(13, 'SHP-2024-013', 4,  2,  2, 'API',       7.5,    DATEADD(day,-5, CURRENT_DATE()), DATEADD(day, 63,CURRENT_DATE()), NULL,                            'ORDERED',   0,  NULL,                TRUE,  FALSE, 110000.00,825000); -- Probation supplier for critical product!

-- =============================================================================
-- 6. MATERIAL INVENTORY — raw material / API stock at each plant
-- =============================================================================

CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.MATERIAL_INVENTORY (
    INVENTORY_ID        NUMBER,
    PLANT_ID            NUMBER,
    PRODUCT_ID          NUMBER,
    MATERIAL_TYPE       VARCHAR,
    STOCK_KG            FLOAT,
    SAFETY_STOCK_KG     FLOAT,
    DAYS_OF_COVERAGE    NUMBER,
    EXPIRY_DATE         DATE,
    STOCK_STATUS        VARCHAR,   -- CRITICAL / LOW / ADEQUATE / EXCESS
    LAST_RECEIVED_DATE  DATE,
    TEMP_EXCURSION_FLAG BOOLEAN,
    COLD_CHAIN_REQUIRED BOOLEAN
);

INSERT INTO FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.MATERIAL_INVENTORY VALUES
(1,  1, 1,  'API',      320.0, 500.0,  18, DATEADD(day, 180,CURRENT_DATE()), 'CRITICAL', DATEADD(day,-28,CURRENT_DATE()), FALSE, FALSE),
(2,  1, 3,  'API',      880.0, 400.0,  62, DATEADD(day, 240,CURRENT_DATE()), 'ADEQUATE', DATEADD(day,-20,CURRENT_DATE()), FALSE, FALSE),
(3,  1, 4,  'API',      140.0, 450.0,  9,  DATEADD(day, 150,CURRENT_DATE()), 'CRITICAL', DATEADD(day,-45,CURRENT_DATE()), FALSE, FALSE),
(4,  1, 6,  'API',      1840.0,600.0,  90, DATEADD(day, 300,CURRENT_DATE()), 'EXCESS',   DATEADD(day,-15,CURRENT_DATE()), FALSE, FALSE),
(5,  2, 2,  'API',      3.8,   8.0,    14, DATEADD(day, 90, CURRENT_DATE()), 'CRITICAL', DATEADD(day,-18,CURRENT_DATE()), FALSE, TRUE),
(6,  2, 5,  'API',      1.2,   5.0,    8,  DATEADD(day, 60, CURRENT_DATE()), 'CRITICAL', DATEADD(day,-30,CURRENT_DATE()), FALSE, TRUE),
(7,  2, 12, 'API',      2.1,   4.0,    22, DATEADD(day, 120,CURRENT_DATE()), 'LOW',      DATEADD(day,-10,CURRENT_DATE()), FALSE, TRUE),
(8,  3, 14, 'API',      0.8,   1.5,    12, DATEADD(day, 90, CURRENT_DATE()), 'CRITICAL', DATEADD(day,-52,CURRENT_DATE()), FALSE, TRUE),
(9,  3, 15, 'API',      1.9,   1.5,    30, DATEADD(day, 120,CURRENT_DATE()), 'ADEQUATE', DATEADD(day,-20,CURRENT_DATE()), FALSE, TRUE),
(10, 3, 17, 'API',      0.9,   1.2,    15, DATEADD(day, 75, CURRENT_DATE()), 'CRITICAL', DATEADD(day,-40,CURRENT_DATE()), FALSE, TRUE),
(11, 4, 10, 'API',      680.0, 300.0,  68, DATEADD(day, 270,CURRENT_DATE()), 'ADEQUATE', DATEADD(day,-10,CURRENT_DATE()), FALSE, FALSE),
(12, 4, 11, 'API',      920.0, 300.0,  92, DATEADD(day, 300,CURRENT_DATE()), 'EXCESS',   DATEADD(day,-14,CURRENT_DATE()), FALSE, FALSE),
(13, 5, 13, 'API',      1.4,   2.5,    17, DATEADD(day, 80, CURRENT_DATE()), 'CRITICAL', DATEADD(day,-40,CURRENT_DATE()), FALSE, TRUE),
(14, 5, 16, 'API',      2.8,   2.0,    42, DATEADD(day, 200,CURRENT_DATE()), 'ADEQUATE', DATEADD(day,-40,CURRENT_DATE()), FALSE, FALSE),
(15, 6, 7,  'API',      210.0, 350.0,  30, DATEADD(day, 200,CURRENT_DATE()), 'LOW',      DATEADD(day,-19,CURRENT_DATE()), FALSE, FALSE),
(16, 6, 8,  'API',      1200.0,400.0, 120, DATEADD(day, 280,CURRENT_DATE()), 'EXCESS',   DATEADD(day,-10,CURRENT_DATE()), FALSE, FALSE),
(17, 2, 12, 'API',      1.8,   4.0,    18, DATEADD(day, 80, CURRENT_DATE()), 'CRITICAL', DATEADD(day,-10,CURRENT_DATE()), TRUE,  TRUE); -- TEMP EXCURSION FLAG

-- =============================================================================
-- 7. SEMANTIC VIEW for Cortex Analyst
-- NOTE: Skipped — requires TABLES-based syntax rewrite.
-- =============================================================================

-- =============================================================================
-- VERIFY
-- =============================================================================

SELECT 'PLANTS'              AS tbl, COUNT(*) FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANTS
UNION ALL SELECT 'SUPPLIERS',   COUNT(*) FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.SUPPLIERS
UNION ALL SELECT 'PRODUCTS',    COUNT(*) FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PRODUCTS
UNION ALL SELECT 'BATCHES',     COUNT(*) FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PRODUCTION_BATCHES
UNION ALL SELECT 'SHIPMENTS',   COUNT(*) FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.SHIPMENTS
UNION ALL SELECT 'INVENTORY',   COUNT(*) FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.MATERIAL_INVENTORY;

-- =============================================================================
-- VERIFY
-- =============================================================================

SELECT 'PLANTS'              AS tbl, COUNT(*) FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANTS
UNION ALL SELECT 'SUPPLIERS',   COUNT(*) FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.SUPPLIERS
UNION ALL SELECT 'PRODUCTS',    COUNT(*) FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PRODUCTS
UNION ALL SELECT 'BATCHES',     COUNT(*) FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PRODUCTION_BATCHES
UNION ALL SELECT 'SHIPMENTS',   COUNT(*) FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.SHIPMENTS
UNION ALL SELECT 'INVENTORY',   COUNT(*) FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.MATERIAL_INVENTORY;
