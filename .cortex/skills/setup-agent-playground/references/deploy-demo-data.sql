-- =============================================================================
-- DEPLOY DEMO DATA FOR AGENT PLAYGROUND
-- Run with ACCOUNTADMIN role and ROUTING_ANALYTICS warehouse
-- Deploys: CONFIG updates, DELIVERIES view, 4 data tables, 4 stored procedures
-- =============================================================================

USE ROLE ACCOUNTADMIN;
USE WAREHOUSE ROUTING_ANALYTICS;

-- ===================== STEP 1: Configure Demo Defaults =====================

UPDATE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.CONFIG SET VEHICLE_TYPE = 'ebike', REGION = 'SanFrancisco';
UPDATE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.CONFIG SET VEHICLE_TYPE = 'ebike', REGION = 'SanFrancisco';
UPDATE FLEET_INTELLIGENCE.DWELL_ANALYSIS.CONFIG SET VEHICLE_TYPE = 'ebike', REGION = 'SanFrancisco';
UPDATE FLEET_INTELLIGENCE.ROUTE_DEVIATION.CONFIG SET VEHICLE_TYPE = 'ebike', REGION = 'SanFrancisco';
UPDATE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG SET VEHICLE_TYPE = 'ebike', REGION = 'SanFrancisco';
UPDATE FLEET_INTELLIGENCE.RETAIL_CATCHMENT.CONFIG SET VEHICLE_TYPE = 'ebike', REGION = 'SanFrancisco';

CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERIES AS
SELECT
    t.TRIP_ID AS DELIVERY_ID,
    t.VEHICLE_ID AS COURIER_ID,
    p.NAME AS RESTAURANT_NAME,
    t.ORIGIN_POI_ID AS RESTAURANT_ID,
    t.TRIP_START AS ORDER_TIME,
    t.STATUS AS ORDER_STATUS,
    t.ORIGIN AS PICKUP_LOCATION,
    t.DESTINATION AS DROPOFF_LOCATION,
    t.DESTINATION AS CUSTOMER_LOCATION,
    t.ROUTE_GEOG AS GEOMETRY,
    t.DURATION_MINUTES AS DELIVERY_TIME_MIN,
    t.DISTANCE_KM AS DISTANCE_KM
FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS t
LEFT JOIN SYNTHETIC_DATASETS.UNIFIED.DIM_POIS p ON t.ORIGIN_POI_ID = p.LOCATION_ID
WHERE t.VEHICLE_TYPE = (SELECT VEHICLE_TYPE FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.CONFIG LIMIT 1)
  AND t.REGION = (SELECT REGION FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.CONFIG LIMIT 1);

-- ===================== STEP 2: SF_PHARMA_JOBS (30 rows) =====================

CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_PHARMA_JOBS (
    JOB_ID      NUMBER,
    NAME        VARCHAR,
    ADDRESS     VARCHAR,
    LONGITUDE   FLOAT,
    LATITUDE    FLOAT,
    SKILL       NUMBER,
    SKILL_LABEL VARCHAR,
    AMOUNT      NUMBER DEFAULT 1
);
TRUNCATE TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_PHARMA_JOBS;

INSERT INTO FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_PHARMA_JOBS VALUES
(1,  'UCSF Parnassus Vaccination Centre', '505 Parnassus Ave, SF',       -122.4584, 37.7630, 1, 'Cold Chain / Vaccines', 1),
(2,  'Kaiser Permanente Geary',            '2425 Geary Blvd, SF',         -122.4440, 37.7819, 1, 'Cold Chain / Vaccines', 1),
(3,  'Zuckerberg SF General Hospital',     '1001 Potrero Ave, SF',         -122.4064, 37.7553, 1, 'Cold Chain / Vaccines', 1),
(4,  'SF VA Medical Center',               '4150 Clement St, SF',          -122.4987, 37.7832, 1, 'Cold Chain / Vaccines', 1),
(5,  'Chinese Hospital Clinic',            '845 Jackson St, SF',           -122.4073, 37.7956, 1, 'Cold Chain / Vaccines', 1),
(6,  'St Mary''s Medical Center',          '450 Stanyan St, SF',           -122.4462, 37.7726, 1, 'Cold Chain / Vaccines', 1),
(7,  'Castro-Davies Medical Center',       '45 Castro St, SF',             -122.4350, 37.7676, 1, 'Cold Chain / Vaccines', 1),
(8,  'Excelsior Health Clinic',            '4921 Mission St, SF',          -122.4374, 37.7222, 1, 'Cold Chain / Vaccines', 1),
(9,  'Bayview Child Health Center',        '3801 3rd St, SF',              -122.3900, 37.7407, 1, 'Cold Chain / Vaccines', 1),
(10, 'Tenderloin Health Clinic',           '311 Turk St, SF',              -122.4175, 37.7820, 1, 'Cold Chain / Vaccines', 1),
(11, 'Walgreens Castro',                   '498 Castro St, SF',            -122.4312, 37.7616, 2, 'Controlled Substances', 1),
(12, 'CVS Geary Boulevard',                '2676 Geary Blvd, SF',          -122.4506, 37.7798, 2, 'Controlled Substances', 1),
(13, 'Walgreens Divisadero',               '3201 Divisadero St, SF',       -122.4431, 37.7925, 2, 'Controlled Substances', 1),
(14, 'CVS Sacramento Street',              '3700 Sacramento St, SF',       -122.4531, 37.7875, 2, 'Controlled Substances', 1),
(15, 'Rite Aid Clement Street',            '801 Clement St, SF',           -122.4675, 37.7832, 2, 'Controlled Substances', 1),
(16, 'Walgreens Mission District',         '2690 Mission St, SF',          -122.4200, 37.7503, 2, 'Controlled Substances', 1),
(17, 'CVS Market Street',                  '2101 Market St, SF',           -122.4340, 37.7673, 2, 'Controlled Substances', 1),
(18, 'Walgreens Haight Street',            '1301 Haight St, SF',           -122.4465, 37.7695, 2, 'Controlled Substances', 1),
(19, 'Rite Aid Taraval',                   '3701 Taraval St, SF',          -122.4842, 37.7422, 2, 'Controlled Substances', 1),
(20, 'Walgreens Noe Valley',               '4278 24th St, SF',             -122.4334, 37.7507, 2, 'Controlled Substances', 1),
(21, 'Marina Medical Group',               '3100 Scott St, SF',            -122.4426, 37.8010, 3, 'Standard Medicines',    1),
(22, 'North Beach Family Medicine',        '620 Columbus Ave, SF',         -122.4094, 37.7989, 3, 'Standard Medicines',    1),
(23, 'Haight Ashbury Free Clinic',         '558 Clayton St, SF',           -122.4476, 37.7687, 3, 'Standard Medicines',    1),
(24, 'Richmond District Medical',          '6239 Geary Blvd, SF',          -122.4842, 37.7803, 3, 'Standard Medicines',    1),
(25, 'Sunset Medical Center',              '3111 Taraval St, SF',          -122.4782, 37.7452, 3, 'Standard Medicines',    1),
(26, 'Inner Sunset GP Practice',           '1709 Irving St, SF',           -122.4723, 37.7634, 3, 'Standard Medicines',    1),
(27, 'Mission District Health Center',     '3555 22nd St, SF',             -122.4232, 37.7540, 3, 'Standard Medicines',    1),
(28, 'South Beach Pharmacy',               '400 Beale St, SF',             -122.3899, 37.7887, 3, 'Standard Medicines',    1),
(29, 'Dogpatch Medical Clinic',            '2468 3rd St, SF',              -122.3890, 37.7587, 3, 'Standard Medicines',    1),
(30, 'FiDi Corporate Health',              '580 California St, SF',        -122.4017, 37.7931, 3, 'Standard Medicines',    1);

-- ===================== STEP 3: SF_HEALTH_DEMOGRAPHICS (55 rows) =====================

CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_HEALTH_DEMOGRAPHICS (
    DEMO_ID             NUMBER,
    NEIGHBORHOOD        VARCHAR,
    LATITUDE            FLOAT,
    LONGITUDE           FLOAT,
    TOTAL_POPULATION    NUMBER,
    PCT_ELDERLY         FLOAT,
    PCT_CHILDREN        FLOAT,
    DIABETES_PCT        FLOAT,
    HYPERTENSION_PCT    FLOAT,
    CARDIOVASCULAR_PCT  FLOAT,
    RESPIRATORY_PCT     FLOAT,
    MOBILITY_ISSUES_PCT FLOAT,
    INCOME_BRACKET      VARCHAR,
    CAR_OWNERSHIP_PCT   FLOAT,
    TRANSIT_ACCESS      NUMBER
);
TRUNCATE TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_HEALTH_DEMOGRAPHICS;

INSERT INTO FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_HEALTH_DEMOGRAPHICS VALUES
(1,  'Tenderloin',              37.7840, -122.4141, 28000, 12.1, 8.4,  24.2, 44.1, 18.3, 22.7, 31.2, 'LOW',    15.2, 9),
(2,  'SoMa North',              37.7795, -122.4005, 22000, 9.8,  6.2,  19.4, 38.7, 15.1, 19.8, 25.4, 'LOW',    22.1, 9),
(3,  'SoMa South',              37.7741, -122.4003, 18000, 10.2, 5.9,  17.8, 36.2, 14.2, 18.3, 24.1, 'LOW',    24.3, 8),
(4,  'Bayview North',           37.7407, -122.3903, 24000, 16.4, 14.2, 22.1, 42.3, 17.6, 20.1, 28.7, 'LOW',    18.4, 7),
(5,  'Bayview South',           37.7283, -122.3876, 19000, 18.2, 15.8, 23.4, 44.7, 19.2, 21.8, 30.1, 'LOW',    16.7, 6),
(6,  'Excelsior',               37.7222, -122.4374, 31000, 17.9, 13.6, 20.8, 40.1, 16.4, 18.9, 27.3, 'LOW',    28.4, 7),
(7,  'Visitacion Valley',       37.7143, -122.4112, 22000, 19.1, 16.3, 22.7, 43.2, 18.1, 20.4, 29.8, 'LOW',    25.1, 6),
(8,  'Outer Mission',           37.7248, -122.4295, 26000, 16.7, 14.1, 21.3, 41.8, 17.2, 19.6, 28.4, 'LOW',    30.2, 7),
(9,  'Portola',                 37.7272, -122.4149, 17000, 17.4, 13.9, 20.6, 39.8, 15.9, 18.4, 26.9, 'LOW',    27.3, 6),
(10, 'Ingleside',               37.7262, -122.4529, 20000, 16.2, 13.2, 19.8, 38.7, 15.4, 17.8, 25.7, 'LOW',    29.1, 7),
(11, 'Mission Dolores',         37.7601, -122.4259, 29000, 13.4, 10.8, 16.2, 34.7, 13.1, 16.4, 20.3, 'MEDIUM', 32.4, 8),
(12, 'Mission District',        37.7503, -122.4194, 34000, 12.8, 11.4, 17.4, 36.2, 14.2, 17.8, 22.1, 'MEDIUM', 35.7, 8),
(13, 'Chinatown',               37.7941, -122.4070, 14000, 22.3, 9.1,  18.9, 37.4, 16.3, 15.2, 27.8, 'MEDIUM', 19.2, 9),
(14, 'Western Addition',        37.7791, -122.4300, 21000, 14.2, 10.2, 15.8, 33.4, 12.7, 15.9, 19.7, 'MEDIUM', 28.3, 8),
(15, 'Fillmore',                37.7823, -122.4360, 18000, 13.7, 9.8,  15.4, 32.8, 12.3, 15.4, 19.1, 'MEDIUM', 30.4, 8),
(16, 'Lower Haight',            37.7718, -122.4306, 16000, 11.2, 8.4,  13.7, 29.8, 11.2, 14.1, 17.3, 'MEDIUM', 37.2, 8),
(17, 'Civic Center',            37.7793, -122.4177, 12000, 15.8, 7.2,  18.1, 35.7, 14.8, 17.2, 23.4, 'LOW',    21.3, 9),
(18, 'Glen Park',               37.7343, -122.4338, 14000, 15.4, 12.7, 14.2, 30.3, 11.8, 13.7, 17.8, 'MEDIUM', 52.4, 7),
(19, 'Bernal Heights',          37.7424, -122.4156, 19000, 13.2, 11.6, 14.8, 31.2, 12.1, 14.3, 18.2, 'MEDIUM', 41.7, 7),
(20, 'Dogpatch',                37.7587, -122.3890, 11000, 9.4,  7.8,  12.3, 27.4, 10.4, 13.2, 15.4, 'MEDIUM', 44.2, 7),
(21, 'Outer Sunset West',       37.7463, -122.5041, 28000, 18.7, 12.4, 15.1, 31.8, 12.4, 14.2, 19.3, 'MEDIUM', 48.7, 6),
(22, 'Outer Sunset East',       37.7522, -122.4877, 26000, 17.4, 11.8, 14.7, 30.4, 11.8, 13.7, 18.4, 'MEDIUM', 51.2, 6),
(23, 'Inner Sunset',            37.7634, -122.4695, 22000, 14.8, 10.2, 12.4, 27.8, 10.7, 12.8, 16.2, 'MEDIUM', 54.8, 7),
(24, 'Outer Richmond West',     37.7803, -122.5012, 24000, 19.2, 11.6, 14.3, 30.7, 11.6, 13.1, 18.7, 'MEDIUM', 46.3, 7),
(25, 'Outer Richmond East',     37.7819, -122.4787, 22000, 18.4, 11.2, 13.8, 29.4, 11.2, 12.7, 17.9, 'MEDIUM', 49.4, 7),
(26, 'Inner Richmond',          37.7817, -122.4632, 20000, 16.2, 10.8, 12.7, 27.6, 10.4, 12.2, 16.4, 'MEDIUM', 56.1, 8),
(27, 'Castro',                  37.7616, -122.4350, 16000, 12.4, 5.6,  11.2, 25.3, 9.8,  11.7, 14.3, 'HIGH',   62.4, 8),
(28, 'Noe Valley',              37.7507, -122.4334, 18000, 11.8, 14.2, 10.4, 23.7, 9.2,  10.8, 13.1, 'HIGH',   67.8, 7),
(29, 'Upper Market',            37.7682, -122.4413, 14000, 11.1, 6.2,  10.8, 24.2, 9.4,  11.2, 13.7, 'HIGH',   64.3, 8),
(30, 'Eureka Valley',           37.7571, -122.4289, 12000, 12.7, 7.4,  11.7, 25.8, 10.1, 12.1, 15.2, 'HIGH',   59.7, 8),
(31, 'Marina',                  37.8010, -122.4354, 22000, 8.4,  6.2,  7.4,  18.3, 7.1,  8.4,  9.2,  'HIGH',   71.4, 8),
(32, 'Pacific Heights',         37.7925, -122.4357, 20000, 12.8, 8.4,  8.2,  19.7, 7.8,  9.1,  10.4, 'HIGH',   68.9, 8),
(33, 'Cow Hollow',              37.7976, -122.4290, 14000, 7.8,  5.4,  6.8,  17.4, 6.4,  7.8,  8.4,  'HIGH',   74.2, 8),
(34, 'Nob Hill',                37.7928, -122.4146, 18000, 16.4, 6.8,  9.8,  22.4, 8.7,  10.4, 12.8, 'HIGH',   52.3, 9),
(35, 'Russian Hill',            37.7987, -122.4192, 16000, 13.2, 7.2,  8.7,  20.1, 7.9,  9.4,  11.3, 'HIGH',   63.7, 9),
(36, 'Hayes Valley',            37.7762, -122.4261, 14000, 10.4, 7.8,  9.4,  21.7, 8.2,  10.1, 12.4, 'HIGH',   69.8, 8),
(37, 'Duboce Triangle',         37.7698, -122.4317, 10000, 9.8,  6.4,  8.8,  20.3, 7.6,  9.2,  11.1, 'HIGH',   72.3, 8),
(38, 'Cole Valley',             37.7679, -122.4482, 12000, 12.1, 9.6,  9.2,  21.2, 8.1,  9.8,  11.8, 'HIGH',   65.4, 8),
(39, 'FiDi / Financial',        37.7937, -122.3995, 8000,  8.2,  4.1,  7.8,  19.2, 7.2,  8.7,  9.8,  'HIGH',   28.4, 9),
(40, 'North Beach',             37.7989, -122.4094, 14000, 15.4, 7.8,  10.2, 22.8, 8.9,  10.7, 13.2, 'HIGH',   58.2, 9),
(41, 'Haight Ashbury',          37.7695, -122.4476, 18000, 10.8, 7.4,  10.7, 24.1, 9.1,  11.4, 13.8, 'MEDIUM', 61.4, 8),
(42, 'Potrero Hill North',      37.7654, -122.4003, 14000, 11.4, 8.2,  11.2, 25.3, 9.4,  12.1, 14.7, 'MEDIUM', 48.7, 7),
(43, 'Potrero Hill South',      37.7561, -122.4024, 12000, 12.2, 8.8,  12.1, 26.7, 10.2, 13.1, 15.8, 'MEDIUM', 44.3, 7),
(44, 'Parkside',                37.7412, -122.4884, 24000, 17.8, 12.4, 13.7, 29.4, 11.2, 12.8, 17.4, 'MEDIUM', 49.8, 6),
(45, 'Forest Hill',             37.7454, -122.4601, 10000, 19.2, 10.8, 13.2, 28.7, 10.8, 12.3, 16.9, 'HIGH',   68.4, 6),
(46, 'West Portal',             37.7408, -122.4649, 12000, 18.4, 11.6, 12.8, 27.8, 10.4, 11.9, 16.3, 'HIGH',   71.2, 7),
(47, 'Diamond Heights',         37.7453, -122.4393, 8000,  16.8, 9.4,  12.4, 27.1, 10.1, 11.7, 15.8, 'HIGH',   65.7, 6),
(48, 'Twin Peaks',              37.7527, -122.4476, 6000,  18.1, 8.2,  12.7, 27.4, 10.3, 11.8, 16.1, 'HIGH',   62.3, 6),
(49, 'Balboa Park',             37.7253, -122.4432, 14000, 17.2, 13.4, 17.8, 36.4, 14.2, 16.7, 22.4, 'LOW',    34.8, 7),
(50, 'Silver Terrace',          37.7298, -122.4023, 9000,  16.4, 14.8, 20.4, 39.7, 16.1, 18.4, 25.7, 'LOW',    27.3, 6),
(51, 'Lone Mountain',           37.7819, -122.4587, 8000,  24.7, 8.4,  16.4, 34.2, 14.1, 15.8, 22.4, 'MEDIUM', 54.2, 7),
(52, 'Anza Vista',              37.7812, -122.4461, 9000,  21.3, 9.1,  15.1, 32.7, 12.8, 14.3, 20.7, 'MEDIUM', 56.8, 7),
(53, 'Jordan Park',             37.7844, -122.4573, 7000,  22.8, 8.7,  15.8, 33.4, 13.2, 14.8, 21.3, 'HIGH',   61.4, 7),
(54, 'Lake Street',             37.7831, -122.4756, 9000,  23.4, 9.2,  15.4, 32.8, 12.9, 14.1, 20.8, 'HIGH',   57.9, 7),
(55, 'Seacliff',                37.7862, -122.4921, 5000,  21.7, 9.8,  12.4, 26.7, 10.2, 11.4, 16.1, 'HIGH',   72.4, 6);

-- ===================== STEP 4: SF_DRUG_FORMULARY (25 rows) =====================

CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_DRUG_FORMULARY (
    DRUG_ID          NUMBER,
    CONDITION        VARCHAR,
    DRUG_NAME        VARCHAR,
    DRUG_CATEGORY    VARCHAR,
    DELIVERY_SKILL   NUMBER,
    SKILL_LABEL      VARCHAR,
    UNITS_PER_1000   NUMBER,
    PRIORITY         NUMBER
);
TRUNCATE TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_DRUG_FORMULARY;

INSERT INTO FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_DRUG_FORMULARY VALUES
(1,  'DIABETES', 'Insulin Glargine (Lantus)',      'Insulin',           1, 'Cold Chain',            45, 1),
(2,  'DIABETES', 'Metformin 500mg',                'Oral Hypoglycemic', 3, 'Standard Medicines',    120, 3),
(3,  'DIABETES', 'Insulin Lispro (Humalog)',       'Insulin',           1, 'Cold Chain',            30, 1),
(4,  'DIABETES', 'Glipizide 5mg',                  'Oral Hypoglycemic', 3, 'Standard Medicines',    60, 3),
(5,  'DIABETES', 'Ozempic (Semaglutide)',          'GLP-1 Agonist',     1, 'Cold Chain',            25, 2),
(6,  'HYPERTENSION', 'Lisinopril 10mg',           'ACE Inhibitor',     3, 'Standard Medicines',    90, 2),
(7,  'HYPERTENSION', 'Amlodipine 5mg',            'Calcium Blocker',   3, 'Standard Medicines',    85, 2),
(8,  'HYPERTENSION', 'Losartan 50mg',             'ARB',               3, 'Standard Medicines',    70, 3),
(9,  'HYPERTENSION', 'Metoprolol 25mg',           'Beta Blocker',      3, 'Standard Medicines',    65, 2),
(10, 'HYPERTENSION', 'Hydrochlorothiazide 25mg',  'Thiazide Diuretic', 3, 'Standard Medicines',    55, 3),
(11, 'CARDIOVASCULAR', 'Atorvastatin 20mg',       'Statin',            3, 'Standard Medicines',    100, 2),
(12, 'CARDIOVASCULAR', 'Aspirin 81mg',            'Antiplatelet',      3, 'Standard Medicines',    110, 3),
(13, 'CARDIOVASCULAR', 'Clopidogrel 75mg',        'Antiplatelet',      2, 'Controlled Substances', 40, 2),
(14, 'CARDIOVASCULAR', 'Warfarin 5mg',            'Anticoagulant',     2, 'Controlled Substances', 35, 1),
(15, 'CARDIOVASCULAR', 'Nitroglycerin Sublingual', 'Nitrate',          1, 'Cold Chain',            20, 1),
(16, 'RESPIRATORY', 'Albuterol Inhaler',          'Bronchodilator',    3, 'Standard Medicines',    80, 2),
(17, 'RESPIRATORY', 'Fluticasone Inhaler',        'Corticosteroid',    3, 'Standard Medicines',    60, 3),
(18, 'RESPIRATORY', 'Montelukast 10mg',           'Leukotriene',       3, 'Standard Medicines',    45, 3),
(19, 'RESPIRATORY', 'Prednisone 10mg',            'Corticosteroid',    2, 'Controlled Substances', 30, 2),
(20, 'RESPIRATORY', 'Budesonide Nebulizer',       'Corticosteroid',    1, 'Cold Chain',            15, 2),
(21, 'MOBILITY', 'Tramadol 50mg',                'Opioid Analgesic',   2, 'Controlled Substances', 35, 2),
(22, 'MOBILITY', 'Gabapentin 300mg',             'Neuropathic',        2, 'Controlled Substances', 40, 3),
(23, 'MOBILITY', 'Celecoxib 200mg',              'NSAID',              3, 'Standard Medicines',    50, 3),
(24, 'MOBILITY', 'Pregabalin 75mg',              'Neuropathic',        2, 'Controlled Substances', 30, 2),
(25, 'MOBILITY', 'Diclofenac Gel',               'Topical NSAID',      3, 'Standard Medicines',    25, 3);

-- ===================== STEP 5: SF_TOP_PHARMACIES (6 rows) =====================

CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_TOP_PHARMACIES (
    PHARMACY_ID  NUMBER,
    NAME         VARCHAR,
    ADDRESS      VARCHAR,
    LONGITUDE    FLOAT,
    LATITUDE     FLOAT,
    PRIORITY     NUMBER
);
TRUNCATE TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_TOP_PHARMACIES;

INSERT INTO FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_TOP_PHARMACIES VALUES
(1, 'Walgreens Castro',           '498 Castro St, SF',      -122.4312, 37.7616, 1),
(2, 'CVS Geary Boulevard',        '2676 Geary Blvd, SF',    -122.4506, 37.7798, 1),
(3, 'Rite Aid Clement Street',    '801 Clement St, SF',     -122.4675, 37.7832, 2),
(4, 'Walgreens Mission District', '2690 Mission St, SF',    -122.4200, 37.7503, 1),
(5, 'CVS Market Street',          '2101 Market St, SF',     -122.4340, 37.7673, 2),
(6, 'Walgreens Divisadero',       '3201 Divisadero St, SF', -122.4431, 37.7925, 2);
