-- =============================================================================
-- deploy-pharma-data.sql
-- Pharma Supply Intelligence — synthetic inventory, demand forecast, and
-- replenishment data for 6 SF pharmacies × 25 drugs
--
-- Story: A pharmaceutical manufacturer distributes to 6 pharmacy partners.
-- The key challenge: wastage (esp. cold chain), wrong product mix for
-- catchment demographics, and demand forecasting from population health data.
-- =============================================================================

USE ROLE ACCOUNTADMIN;
USE WAREHOUSE ROUTING_ANALYTICS;
USE DATABASE FLEET_INTELLIGENCE;
USE SCHEMA ROUTE_OPTIMIZATION;

-- =============================================================================
-- 1. INVENTORY — current stock per pharmacy per drug
-- =============================================================================

CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_INVENTORY (
    INVENTORY_ID         NUMBER,
    PHARMACY_ID          NUMBER,
    DRUG_ID              NUMBER,
    CURRENT_STOCK_UNITS  NUMBER,
    REORDER_POINT        NUMBER,
    MAX_CAPACITY_UNITS   NUMBER,
    EXPIRY_DATE          DATE,
    DAYS_TO_EXPIRY       NUMBER,
    WASTAGE_UNITS_MTD    NUMBER,
    WASTAGE_VALUE_USD    FLOAT,
    LAST_RESTOCKED_DATE  DATE,
    STOCK_STATUS         VARCHAR   -- CRITICAL / LOW / ADEQUATE / OVERSTOCKED
);

TRUNCATE TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_INVENTORY;

-- Pharmacy 1: Walgreens Castro — high diabetes/cardiovascular area
-- Pharmacy 2: CVS Geary Blvd — mixed, elderly pockets
-- Pharmacy 3: Rite Aid Clement St — Richmond district, elderly Asian population
-- Pharmacy 4: Walgreens Mission — high density, underserved
-- Pharmacy 5: CVS Market St — tech/young demographic, lower chronic disease
-- Pharmacy 6: Walgreens Divisadero — mixed upper-middle

INSERT INTO FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_INVENTORY VALUES
-- PHARMACY 1: Walgreens Castro (PHARMACY_ID=1)
-- Diabetes drugs: good match for catchment, but insulin near expiry
(1,  1, 1,  18,  25,  150, DATEADD(day, 12, CURRENT_DATE()), 12,  22, 1980.00, DATEADD(day,-45,CURRENT_DATE()), 'CRITICAL'),  -- Insulin Glargine NEAR EXPIRY + waste
(2,  1, 2,  210, 60,  300, DATEADD(day, 90, CURRENT_DATE()), 90,   5,   18.75, DATEADD(day,-20,CURRENT_DATE()), 'ADEQUATE'),  -- Metformin
(3,  1, 3,  8,   20,  120, DATEADD(day, 8,  CURRENT_DATE()), 8,   15, 1200.00, DATEADD(day,-60,CURRENT_DATE()), 'CRITICAL'),  -- Insulin Lispro CRITICAL + waste
(4,  1, 4,  55,  30,  200, DATEADD(day,120, CURRENT_DATE()),120,   2,    7.50, DATEADD(day,-30,CURRENT_DATE()), 'ADEQUATE'),  -- Glipizide
(5,  1, 5,  12,  15,  80,  DATEADD(day, 18, CURRENT_DATE()), 18,  18, 3240.00, DATEADD(day,-45,CURRENT_DATE()), 'LOW'),       -- Ozempic near expiry + high waste
(6,  1, 6,  145, 45,  250, DATEADD(day,180, CURRENT_DATE()),180,   1,    5.00, DATEADD(day,-15,CURRENT_DATE()), 'ADEQUATE'),  -- Lisinopril
(7,  1, 7,  130, 40,  220, DATEADD(day,200, CURRENT_DATE()),200,   0,    0.00, DATEADD(day,-15,CURRENT_DATE()), 'ADEQUATE'),  -- Amlodipine
(8,  1, 8,  95,  35,  180, DATEADD(day,160, CURRENT_DATE()),160,   0,    0.00, DATEADD(day,-20,CURRENT_DATE()), 'ADEQUATE'),  -- Losartan
(9,  1, 9,  280, 35,  200, DATEADD(day,150, CURRENT_DATE()),150,   0,    0.00, DATEADD(day,-10,CURRENT_DATE()), 'OVERSTOCKED'),-- Metoprolol OVERSTOCKED
(10, 1,10,  180, 30,  150, DATEADD(day,180, CURRENT_DATE()),180,   3,    9.75, DATEADD(day,-10,CURRENT_DATE()), 'OVERSTOCKED'),-- HCTZ OVERSTOCKED
(11, 1,11,  160, 50,  250, DATEADD(day,210, CURRENT_DATE()),210,   0,    0.00, DATEADD(day,-25,CURRENT_DATE()), 'ADEQUATE'),  -- Atorvastatin
(12, 1,12,  200, 55,  280, DATEADD(day,365, CURRENT_DATE()),365,   0,    0.00, DATEADD(day,-25,CURRENT_DATE()), 'ADEQUATE'),  -- Aspirin
(13, 1,13,  35,  20,  100, DATEADD(day,120, CURRENT_DATE()),120,   2,   58.00, DATEADD(day,-30,CURRENT_DATE()), 'ADEQUATE'),  -- Clopidogrel
(14, 1,14,  22,  15,  80,  DATEADD(day, 28, CURRENT_DATE()), 28,   8,  600.00, DATEADD(day,-60,CURRENT_DATE()), 'LOW'),       -- Warfarin near expiry
(15, 1,15,  5,   10,  60,  DATEADD(day, 14, CURRENT_DATE()), 14,  12, 1440.00, DATEADD(day,-90,CURRENT_DATE()), 'CRITICAL'),  -- Nitroglycerin CRITICAL
(16, 1,16,  95,  40,  200, DATEADD(day,180, CURRENT_DATE()),180,   1,   14.99, DATEADD(day,-20,CURRENT_DATE()), 'ADEQUATE'),  -- Albuterol
(17, 1,17,  60,  30,  150, DATEADD(day,200, CURRENT_DATE()),200,   0,    0.00, DATEADD(day,-20,CURRENT_DATE()), 'ADEQUATE'),  -- Fluticasone
(18, 1,18,  45,  25,  120, DATEADD(day,240, CURRENT_DATE()),240,   0,    0.00, DATEADD(day,-30,CURRENT_DATE()), 'ADEQUATE'),  -- Montelukast
(19, 1,19,  28,  15,  80,  DATEADD(day,150, CURRENT_DATE()),150,   1,   12.50, DATEADD(day,-30,CURRENT_DATE()), 'ADEQUATE'),  -- Prednisone
(20, 1,20,  4,   8,   40,  DATEADD(day, 6,  CURRENT_DATE()),  6,  10,  450.00, DATEADD(day,-90,CURRENT_DATE()), 'CRITICAL'),  -- Budesonide CRITICAL near expiry
(21, 1,21,  30,  18,  90,  DATEADD(day,120, CURRENT_DATE()),120,   0,    0.00, DATEADD(day,-20,CURRENT_DATE()), 'ADEQUATE'),  -- Tramadol
(22, 1,22,  38,  20,  100, DATEADD(day,180, CURRENT_DATE()),180,   0,    0.00, DATEADD(day,-20,CURRENT_DATE()), 'ADEQUATE'),  -- Gabapentin
(23, 1,23,  55,  25,  130, DATEADD(day,300, CURRENT_DATE()),300,   0,    0.00, DATEADD(day,-15,CURRENT_DATE()), 'ADEQUATE'),  -- Celecoxib
(24, 1,24,  25,  15,  80,  DATEADD(day,200, CURRENT_DATE()),200,   1,   45.00, DATEADD(day,-25,CURRENT_DATE()), 'ADEQUATE'),  -- Pregabalin
(25, 1,25,  40,  12,  80,  DATEADD(day,365, CURRENT_DATE()),365,   0,    0.00, DATEADD(day,-30,CURRENT_DATE()), 'ADEQUATE'),  -- Diclofenac Gel

-- PHARMACY 2: CVS Geary Blvd (PHARMACY_ID=2) — elderly population, hypertension heavy
(26, 2, 1,  35,  25,  150, DATEADD(day, 45, CURRENT_DATE()), 45,   8,  720.00, DATEADD(day,-30,CURRENT_DATE()), 'ADEQUATE'),  -- Insulin Glargine
(27, 2, 2,  280, 60,  300, DATEADD(day, 90, CURRENT_DATE()), 90,   3,   11.25, DATEADD(day,-15,CURRENT_DATE()), 'ADEQUATE'),  -- Metformin
(28, 2, 3,  22,  20,  120, DATEADD(day, 60, CURRENT_DATE()), 60,   5,  400.00, DATEADD(day,-30,CURRENT_DATE()), 'ADEQUATE'),  -- Insulin Lispro
(29, 2, 4,  85,  30,  200, DATEADD(day,150, CURRENT_DATE()),150,   0,    0.00, DATEADD(day,-20,CURRENT_DATE()), 'ADEQUATE'),  -- Glipizide
(30, 2, 5,  8,   15,  80,  DATEADD(day, 22, CURRENT_DATE()), 22,  14, 2520.00, DATEADD(day,-45,CURRENT_DATE()), 'LOW'),       -- Ozempic near expiry
(31, 2, 6,  220, 45,  250, DATEADD(day,200, CURRENT_DATE()),200,   0,    0.00, DATEADD(day,-10,CURRENT_DATE()), 'ADEQUATE'),  -- Lisinopril
(32, 2, 7,  310, 40,  220, DATEADD(day,180, CURRENT_DATE()),180,   0,    0.00, DATEADD(day,-10,CURRENT_DATE()), 'OVERSTOCKED'),-- Amlodipine OVERSTOCKED
(33, 2, 8,  175, 35,  180, DATEADD(day,200, CURRENT_DATE()),200,   0,    0.00, DATEADD(day,-10,CURRENT_DATE()), 'ADEQUATE'),  -- Losartan
(34, 2, 9,  130, 35,  200, DATEADD(day,180, CURRENT_DATE()),180,   2,    6.50, DATEADD(day,-15,CURRENT_DATE()), 'ADEQUATE'),  -- Metoprolol
(35, 2,10,  95,  30,  150, DATEADD(day,200, CURRENT_DATE()),200,   0,    0.00, DATEADD(day,-15,CURRENT_DATE()), 'ADEQUATE'),  -- HCTZ
(36, 2,11,  195, 50,  250, DATEADD(day,240, CURRENT_DATE()),240,   0,    0.00, DATEADD(day,-20,CURRENT_DATE()), 'ADEQUATE'),  -- Atorvastatin
(37, 2,12,  240, 55,  280, DATEADD(day,365, CURRENT_DATE()),365,   0,    0.00, DATEADD(day,-20,CURRENT_DATE()), 'ADEQUATE'),  -- Aspirin
(38, 2,13,  45,  20,  100, DATEADD(day,150, CURRENT_DATE()),150,   0,    0.00, DATEADD(day,-25,CURRENT_DATE()), 'ADEQUATE'),  -- Clopidogrel
(39, 2,14,  18,  15,  80,  DATEADD(day, 20, CURRENT_DATE()), 20,  12,  900.00, DATEADD(day,-60,CURRENT_DATE()), 'CRITICAL'),  -- Warfarin CRITICAL
(40, 2,15,  8,   10,  60,  DATEADD(day, 35, CURRENT_DATE()), 35,   6,  720.00, DATEADD(day,-60,CURRENT_DATE()), 'LOW'),       -- Nitroglycerin
(41, 2,16,  80,  40,  200, DATEADD(day,200, CURRENT_DATE()),200,   0,    0.00, DATEADD(day,-15,CURRENT_DATE()), 'ADEQUATE'),  -- Albuterol
(42, 2,17,  55,  30,  150, DATEADD(day,220, CURRENT_DATE()),220,   0,    0.00, DATEADD(day,-15,CURRENT_DATE()), 'ADEQUATE'),  -- Fluticasone
(43, 2,18,  35,  25,  120, DATEADD(day,280, CURRENT_DATE()),280,   0,    0.00, DATEADD(day,-25,CURRENT_DATE()), 'ADEQUATE'),  -- Montelukast
(44, 2,19,  22,  15,  80,  DATEADD(day,180, CURRENT_DATE()),180,   0,    0.00, DATEADD(day,-25,CURRENT_DATE()), 'ADEQUATE'),  -- Prednisone
(45, 2,20,  3,   8,   40,  DATEADD(day, 9,  CURRENT_DATE()),  9,   8,  360.00, DATEADD(day,-90,CURRENT_DATE()), 'CRITICAL'),  -- Budesonide CRITICAL
(46, 2,21,  28,  18,  90,  DATEADD(day,150, CURRENT_DATE()),150,   0,    0.00, DATEADD(day,-20,CURRENT_DATE()), 'ADEQUATE'),
(47, 2,22,  42,  20,  100, DATEADD(day,200, CURRENT_DATE()),200,   0,    0.00, DATEADD(day,-20,CURRENT_DATE()), 'ADEQUATE'),
(48, 2,23,  60,  25,  130, DATEADD(day,320, CURRENT_DATE()),320,   0,    0.00, DATEADD(day,-10,CURRENT_DATE()), 'ADEQUATE'),
(49, 2,24,  30,  15,  80,  DATEADD(day,220, CURRENT_DATE()),220,   0,    0.00, DATEADD(day,-20,CURRENT_DATE()), 'ADEQUATE'),
(50, 2,25,  38,  12,  80,  DATEADD(day,365, CURRENT_DATE()),365,   0,    0.00, DATEADD(day,-25,CURRENT_DATE()), 'ADEQUATE'),

-- PHARMACY 3: Rite Aid Clement St (PHARMACY_ID=3) — elderly Asian community, high HCTZ/Lisinopril need
(51, 3, 1,  42,  25,  150, DATEADD(day, 55, CURRENT_DATE()), 55,   5,  450.00, DATEADD(day,-30,CURRENT_DATE()), 'ADEQUATE'),
(52, 3, 2,  190, 60,  300, DATEADD(day, 80, CURRENT_DATE()), 80,   4,   15.00, DATEADD(day,-20,CURRENT_DATE()), 'ADEQUATE'),
(53, 3, 3,  28,  20,  120, DATEADD(day, 70, CURRENT_DATE()), 70,   3,  240.00, DATEADD(day,-25,CURRENT_DATE()), 'ADEQUATE'),
(54, 3, 4,  75,  30,  200, DATEADD(day,140, CURRENT_DATE()),140,   0,    0.00, DATEADD(day,-25,CURRENT_DATE()), 'ADEQUATE'),
(55, 3, 5,  6,   15,  80,  DATEADD(day, 15, CURRENT_DATE()), 15,  20, 3600.00, DATEADD(day,-60,CURRENT_DATE()), 'CRITICAL'),  -- Ozempic CRITICAL + huge waste
(56, 3, 6,  260, 45,  250, DATEADD(day,210, CURRENT_DATE()),210,   0,    0.00, DATEADD(day,-10,CURRENT_DATE()), 'OVERSTOCKED'),-- Lisinopril OVERSTOCKED
(57, 3, 7,  240, 40,  220, DATEADD(day,190, CURRENT_DATE()),190,   0,    0.00, DATEADD(day,-10,CURRENT_DATE()), 'OVERSTOCKED'),-- Amlodipine OVERSTOCKED
(58, 3, 8,  185, 35,  180, DATEADD(day,170, CURRENT_DATE()),170,   0,    0.00, DATEADD(day,-10,CURRENT_DATE()), 'OVERSTOCKED'),-- Losartan OVERSTOCKED (right drug wrong amount)
(59, 3, 9,  150, 35,  200, DATEADD(day,160, CURRENT_DATE()),160,   0,    0.00, DATEADD(day,-15,CURRENT_DATE()), 'ADEQUATE'),
(60, 3,10,  200, 30,  150, DATEADD(day,190, CURRENT_DATE()),190,   0,    0.00, DATEADD(day,-10,CURRENT_DATE()), 'OVERSTOCKED'),-- HCTZ OVERSTOCKED
(61, 3,11,  175, 50,  250, DATEADD(day,250, CURRENT_DATE()),250,   0,    0.00, DATEADD(day,-20,CURRENT_DATE()), 'ADEQUATE'),
(62, 3,12,  215, 55,  280, DATEADD(day,365, CURRENT_DATE()),365,   0,    0.00, DATEADD(day,-20,CURRENT_DATE()), 'ADEQUATE'),
(63, 3,13,  30,  20,  100, DATEADD(day,130, CURRENT_DATE()),130,   2,   58.00, DATEADD(day,-30,CURRENT_DATE()), 'ADEQUATE'),
(64, 3,14,  12,  15,  80,  DATEADD(day, 18, CURRENT_DATE()), 18,  14, 1050.00, DATEADD(day,-90,CURRENT_DATE()), 'CRITICAL'),  -- Warfarin near expiry
(65, 3,15,  6,   10,  60,  DATEADD(day, 25, CURRENT_DATE()), 25,   8,  960.00, DATEADD(day,-60,CURRENT_DATE()), 'LOW'),
(66, 3,16,  70,  40,  200, DATEADD(day,200, CURRENT_DATE()),200,   0,    0.00, DATEADD(day,-20,CURRENT_DATE()), 'ADEQUATE'),
(67, 3,17,  50,  30,  150, DATEADD(day,230, CURRENT_DATE()),230,   0,    0.00, DATEADD(day,-20,CURRENT_DATE()), 'ADEQUATE'),
(68, 3,18,  40,  25,  120, DATEADD(day,270, CURRENT_DATE()),270,   0,    0.00, DATEADD(day,-30,CURRENT_DATE()), 'ADEQUATE'),
(69, 3,19,  20,  15,  80,  DATEADD(day,170, CURRENT_DATE()),170,   1,   12.50, DATEADD(day,-30,CURRENT_DATE()), 'ADEQUATE'),
(70, 3,20,  2,   8,   40,  DATEADD(day, 5,  CURRENT_DATE()),  5,  14,  630.00, DATEADD(day,-90,CURRENT_DATE()), 'CRITICAL'),  -- Budesonide CRITICAL 5 days!
(71, 3,21,  25,  18,  90,  DATEADD(day,140, CURRENT_DATE()),140,   0,    0.00, DATEADD(day,-25,CURRENT_DATE()), 'ADEQUATE'),
(72, 3,22,  35,  20,  100, DATEADD(day,190, CURRENT_DATE()),190,   0,    0.00, DATEADD(day,-25,CURRENT_DATE()), 'ADEQUATE'),
(73, 3,23,  48,  25,  130, DATEADD(day,310, CURRENT_DATE()),310,   0,    0.00, DATEADD(day,-15,CURRENT_DATE()), 'ADEQUATE'),
(74, 3,24,  22,  15,  80,  DATEADD(day,210, CURRENT_DATE()),210,   1,   45.00, DATEADD(day,-25,CURRENT_DATE()), 'ADEQUATE'),
(75, 3,25,  35,  12,  80,  DATEADD(day,365, CURRENT_DATE()),365,   0,    0.00, DATEADD(day,-30,CURRENT_DATE()), 'ADEQUATE'),

-- PHARMACY 4: Walgreens Mission (PHARMACY_ID=4) — underserved, high need but often understocked
(76, 4, 1,  10,  25,  150, DATEADD(day, 20, CURRENT_DATE()), 20,  28, 2520.00, DATEADD(day,-45,CURRENT_DATE()), 'CRITICAL'),  -- Insulin CRITICAL + waste (ordering too infrequently)
(77, 4, 2,  55,  60,  300, DATEADD(day, 60, CURRENT_DATE()), 60,   8,   30.00, DATEADD(day,-45,CURRENT_DATE()), 'CRITICAL'),  -- Metformin CRITICAL
(78, 4, 3,  6,   20,  120, DATEADD(day, 16, CURRENT_DATE()), 16,  20, 1600.00, DATEADD(day,-60,CURRENT_DATE()), 'CRITICAL'),  -- Insulin Lispro CRITICAL
(79, 4, 4,  22,  30,  200, DATEADD(day,100, CURRENT_DATE()),100,   5,   18.75, DATEADD(day,-45,CURRENT_DATE()), 'CRITICAL'),  -- Glipizide CRITICAL (below reorder)
(80, 4, 5,  4,   15,  80,  DATEADD(day, 10, CURRENT_DATE()), 10,  22, 3960.00, DATEADD(day,-60,CURRENT_DATE()), 'CRITICAL'),  -- Ozempic CRITICAL + massive waste
(81, 4, 6,  38,  45,  250, DATEADD(day,180, CURRENT_DATE()),180,   5,   25.00, DATEADD(day,-45,CURRENT_DATE()), 'CRITICAL'),  -- Lisinopril CRITICAL
(82, 4, 7,  42,  40,  220, DATEADD(day,190, CURRENT_DATE()),190,   3,    9.75, DATEADD(day,-45,CURRENT_DATE()), 'ADEQUATE'),
(83, 4, 8,  35,  35,  180, DATEADD(day,170, CURRENT_DATE()),170,   2,    6.50, DATEADD(day,-45,CURRENT_DATE()), 'ADEQUATE'),
(84, 4, 9,  40,  35,  200, DATEADD(day,160, CURRENT_DATE()),160,   4,   13.00, DATEADD(day,-45,CURRENT_DATE()), 'ADEQUATE'),
(85, 4,10,  28,  30,  150, DATEADD(day,180, CURRENT_DATE()),180,   2,    6.50, DATEADD(day,-45,CURRENT_DATE()), 'CRITICAL'),  -- HCTZ CRITICAL (below reorder)
(86, 4,11,  45,  50,  250, DATEADD(day,220, CURRENT_DATE()),220,   4,   12.00, DATEADD(day,-40,CURRENT_DATE()), 'CRITICAL'),  -- Atorvastatin CRITICAL
(87, 4,12,  60,  55,  280, DATEADD(day,365, CURRENT_DATE()),365,   2,    6.00, DATEADD(day,-40,CURRENT_DATE()), 'ADEQUATE'),
(88, 4,13,  15,  20,  100, DATEADD(day,110, CURRENT_DATE()),110,   3,   87.00, DATEADD(day,-45,CURRENT_DATE()), 'CRITICAL'),  -- Clopidogrel CRITICAL
(89, 4,14,  8,   15,  80,  DATEADD(day, 25, CURRENT_DATE()), 25,  18, 1350.00, DATEADD(day,-75,CURRENT_DATE()), 'CRITICAL'),  -- Warfarin CRITICAL
(90, 4,15,  2,   10,  60,  DATEADD(day, 8,  CURRENT_DATE()),  8,  16, 1920.00, DATEADD(day,-90,CURRENT_DATE()), 'CRITICAL'),  -- Nitroglycerin CRITICAL
(91, 4,16,  30,  40,  200, DATEADD(day,180, CURRENT_DATE()),180,   5,   74.95, DATEADD(day,-45,CURRENT_DATE()), 'CRITICAL'),  -- Albuterol CRITICAL
(92, 4,17,  22,  30,  150, DATEADD(day,200, CURRENT_DATE()),200,   3,   29.97, DATEADD(day,-45,CURRENT_DATE()), 'CRITICAL'),  -- Fluticasone CRITICAL
(93, 4,18,  18,  25,  120, DATEADD(day,250, CURRENT_DATE()),250,   2,   19.98, DATEADD(day,-45,CURRENT_DATE()), 'CRITICAL'),
(94, 4,19,  12,  15,  80,  DATEADD(day,160, CURRENT_DATE()),160,   1,   12.50, DATEADD(day,-45,CURRENT_DATE()), 'ADEQUATE'),
(95, 4,20,  1,   8,   40,  DATEADD(day, 4,  CURRENT_DATE()),  4,  18,  810.00, DATEADD(day,-90,CURRENT_DATE()), 'CRITICAL'),  -- Budesonide 4 DAYS CRITICAL
(96, 4,21,  10,  18,  90,  DATEADD(day,120, CURRENT_DATE()),120,   5,  212.50, DATEADD(day,-45,CURRENT_DATE()), 'CRITICAL'),
(97, 4,22,  12,  20,  100, DATEADD(day,180, CURRENT_DATE()),180,   4,  180.00, DATEADD(day,-45,CURRENT_DATE()), 'CRITICAL'),
(98, 4,23,  20,  25,  130, DATEADD(day,280, CURRENT_DATE()),280,   3,   60.00, DATEADD(day,-45,CURRENT_DATE()), 'CRITICAL'),
(99, 4,24,  8,   15,  80,  DATEADD(day,190, CURRENT_DATE()),190,   2,   90.00, DATEADD(day,-45,CURRENT_DATE()), 'CRITICAL'),
(100,4,25,  15,  12,  80,  DATEADD(day,365, CURRENT_DATE()),365,   1,   18.00, DATEADD(day,-45,CURRENT_DATE()), 'ADEQUATE'),

-- PHARMACY 5: CVS Market St (PHARMACY_ID=5) — young/tech demographic, low chronic disease need
(101,5, 1,  85,  25,  150, DATEADD(day, 80, CURRENT_DATE()), 80,   2,  180.00, DATEADD(day,-30,CURRENT_DATE()), 'OVERSTOCKED'), -- Insulin OVERSTOCKED for demographics
(102,5, 2,  250, 60,  300, DATEADD(day, 90, CURRENT_DATE()), 90,  35,  131.25, DATEADD(day,-15,CURRENT_DATE()), 'OVERSTOCKED'), -- Metformin OVERSTOCKED + waste (wrong mix)
(103,5, 3,  70,  20,  120, DATEADD(day, 75, CURRENT_DATE()), 75,   8,  640.00, DATEADD(day,-30,CURRENT_DATE()), 'OVERSTOCKED'), -- Insulin Lispro OVERSTOCKED + waste
(104,5, 4,  120, 30,  200, DATEADD(day,130, CURRENT_DATE()),130,  12,   45.00, DATEADD(day,-20,CURRENT_DATE()), 'OVERSTOCKED'), -- Glipizide OVERSTOCKED
(105,5, 5,  55,  15,  80,  DATEADD(day, 60, CURRENT_DATE()), 60,  18, 3240.00, DATEADD(day,-30,CURRENT_DATE()), 'OVERSTOCKED'), -- Ozempic OVERSTOCKED + huge waste (wrong location)
(106,5, 6,  220, 45,  250, DATEADD(day,190, CURRENT_DATE()),190,   5,   25.00, DATEADD(day,-15,CURRENT_DATE()), 'ADEQUATE'),
(107,5, 7,  180, 40,  220, DATEADD(day,200, CURRENT_DATE()),200,   2,    6.50, DATEADD(day,-15,CURRENT_DATE()), 'ADEQUATE'),
(108,5, 8,  90,  35,  180, DATEADD(day,180, CURRENT_DATE()),180,   0,    0.00, DATEADD(day,-20,CURRENT_DATE()), 'ADEQUATE'),
(109,5, 9,  80,  35,  200, DATEADD(day,170, CURRENT_DATE()),170,   0,    0.00, DATEADD(day,-20,CURRENT_DATE()), 'ADEQUATE'),
(110,5,10,  65,  30,  150, DATEADD(day,190, CURRENT_DATE()),190,   0,    0.00, DATEADD(day,-20,CURRENT_DATE()), 'ADEQUATE'),
(111,5,11,  100, 50,  250, DATEADD(day,230, CURRENT_DATE()),230,   0,    0.00, DATEADD(day,-20,CURRENT_DATE()), 'ADEQUATE'),
(112,5,12,  120, 55,  280, DATEADD(day,365, CURRENT_DATE()),365,   0,    0.00, DATEADD(day,-20,CURRENT_DATE()), 'ADEQUATE'),
(113,5,13,  25,  20,  100, DATEADD(day,140, CURRENT_DATE()),140,   1,   29.00, DATEADD(day,-30,CURRENT_DATE()), 'ADEQUATE'),
(114,5,14,  20,  15,  80,  DATEADD(day, 50, CURRENT_DATE()), 50,   4,  300.00, DATEADD(day,-45,CURRENT_DATE()), 'ADEQUATE'),
(115,5,15,  12,  10,  60,  DATEADD(day, 40, CURRENT_DATE()), 40,   3,  360.00, DATEADD(day,-45,CURRENT_DATE()), 'ADEQUATE'),
(116,5,16,  110, 40,  200, DATEADD(day,200, CURRENT_DATE()),200,   0,    0.00, DATEADD(day,-15,CURRENT_DATE()), 'ADEQUATE'),
(117,5,17,  80,  30,  150, DATEADD(day,220, CURRENT_DATE()),220,   0,    0.00, DATEADD(day,-15,CURRENT_DATE()), 'ADEQUATE'),
(118,5,18,  60,  25,  120, DATEADD(day,260, CURRENT_DATE()),260,   0,    0.00, DATEADD(day,-20,CURRENT_DATE()), 'ADEQUATE'),
(119,5,19,  35,  15,  80,  DATEADD(day,160, CURRENT_DATE()),160,   0,    0.00, DATEADD(day,-20,CURRENT_DATE()), 'ADEQUATE'),
(120,5,20,  10,  8,   40,  DATEADD(day, 30, CURRENT_DATE()), 30,   4,  180.00, DATEADD(day,-60,CURRENT_DATE()), 'ADEQUATE'),
(121,5,21,  32,  18,  90,  DATEADD(day,160, CURRENT_DATE()),160,   0,    0.00, DATEADD(day,-20,CURRENT_DATE()), 'ADEQUATE'),
(122,5,22,  45,  20,  100, DATEADD(day,200, CURRENT_DATE()),200,   0,    0.00, DATEADD(day,-20,CURRENT_DATE()), 'ADEQUATE'),
(123,5,23,  65,  25,  130, DATEADD(day,330, CURRENT_DATE()),330,   0,    0.00, DATEADD(day,-10,CURRENT_DATE()), 'ADEQUATE'),
(124,5,24,  28,  15,  80,  DATEADD(day,220, CURRENT_DATE()),220,   0,    0.00, DATEADD(day,-20,CURRENT_DATE()), 'ADEQUATE'),
(125,5,25,  42,  12,  80,  DATEADD(day,365, CURRENT_DATE()),365,   0,    0.00, DATEADD(day,-20,CURRENT_DATE()), 'ADEQUATE'),

-- PHARMACY 6: Walgreens Divisadero (PHARMACY_ID=6) — mixed, generally well-stocked
(126,6, 1,  28,  25,  150, DATEADD(day, 40, CURRENT_DATE()), 40,   4,  360.00, DATEADD(day,-30,CURRENT_DATE()), 'ADEQUATE'),
(127,6, 2,  160, 60,  300, DATEADD(day, 85, CURRENT_DATE()), 85,   2,    7.50, DATEADD(day,-20,CURRENT_DATE()), 'ADEQUATE'),
(128,6, 3,  18,  20,  120, DATEADD(day, 55, CURRENT_DATE()), 55,   6,  480.00, DATEADD(day,-30,CURRENT_DATE()), 'ADEQUATE'),
(129,6, 4,  62,  30,  200, DATEADD(day,125, CURRENT_DATE()),125,   1,    3.75, DATEADD(day,-25,CURRENT_DATE()), 'ADEQUATE'),
(130,6, 5,  14,  15,  80,  DATEADD(day, 30, CURRENT_DATE()), 30,  10, 1800.00, DATEADD(day,-35,CURRENT_DATE()), 'ADEQUATE'),
(131,6, 6,  148, 45,  250, DATEADD(day,195, CURRENT_DATE()),195,   0,    0.00, DATEADD(day,-15,CURRENT_DATE()), 'ADEQUATE'),
(132,6, 7,  125, 40,  220, DATEADD(day,185, CURRENT_DATE()),185,   0,    0.00, DATEADD(day,-15,CURRENT_DATE()), 'ADEQUATE'),
(133,6, 8,  88,  35,  180, DATEADD(day,165, CURRENT_DATE()),165,   0,    0.00, DATEADD(day,-20,CURRENT_DATE()), 'ADEQUATE'),
(134,6, 9,  92,  35,  200, DATEADD(day,155, CURRENT_DATE()),155,   0,    0.00, DATEADD(day,-20,CURRENT_DATE()), 'ADEQUATE'),
(135,6,10,  72,  30,  150, DATEADD(day,185, CURRENT_DATE()),185,   0,    0.00, DATEADD(day,-20,CURRENT_DATE()), 'ADEQUATE'),
(136,6,11,  138, 50,  250, DATEADD(day,225, CURRENT_DATE()),225,   0,    0.00, DATEADD(day,-20,CURRENT_DATE()), 'ADEQUATE'),
(137,6,12,  165, 55,  280, DATEADD(day,365, CURRENT_DATE()),365,   0,    0.00, DATEADD(day,-20,CURRENT_DATE()), 'ADEQUATE'),
(138,6,13,  32,  20,  100, DATEADD(day,125, CURRENT_DATE()),125,   1,   29.00, DATEADD(day,-30,CURRENT_DATE()), 'ADEQUATE'),
(139,6,14,  14,  15,  80,  DATEADD(day, 38, CURRENT_DATE()), 38,   7,  525.00, DATEADD(day,-50,CURRENT_DATE()), 'ADEQUATE'),
(140,6,15,  9,   10,  60,  DATEADD(day, 28, CURRENT_DATE()), 28,   5,  600.00, DATEADD(day,-50,CURRENT_DATE()), 'ADEQUATE'),
(141,6,16,  75,  40,  200, DATEADD(day,195, CURRENT_DATE()),195,   0,    0.00, DATEADD(day,-20,CURRENT_DATE()), 'ADEQUATE'),
(142,6,17,  58,  30,  150, DATEADD(day,215, CURRENT_DATE()),215,   0,    0.00, DATEADD(day,-20,CURRENT_DATE()), 'ADEQUATE'),
(143,6,18,  42,  25,  120, DATEADD(day,255, CURRENT_DATE()),255,   0,    0.00, DATEADD(day,-25,CURRENT_DATE()), 'ADEQUATE'),
(144,6,19,  22,  15,  80,  DATEADD(day,155, CURRENT_DATE()),155,   1,   12.50, DATEADD(day,-25,CURRENT_DATE()), 'ADEQUATE'),
(145,6,20,  6,   8,   40,  DATEADD(day, 20, CURRENT_DATE()), 20,   7,  315.00, DATEADD(day,-60,CURRENT_DATE()), 'ADEQUATE'),
(146,6,21,  24,  18,  90,  DATEADD(day,145, CURRENT_DATE()),145,   1,   42.50, DATEADD(day,-25,CURRENT_DATE()), 'ADEQUATE'),
(147,6,22,  36,  20,  100, DATEADD(day,185, CURRENT_DATE()),185,   0,    0.00, DATEADD(day,-25,CURRENT_DATE()), 'ADEQUATE'),
(148,6,23,  52,  25,  130, DATEADD(day,305, CURRENT_DATE()),305,   0,    0.00, DATEADD(day,-15,CURRENT_DATE()), 'ADEQUATE'),
(149,6,24,  24,  15,  80,  DATEADD(day,205, CURRENT_DATE()),205,   0,    0.00, DATEADD(day,-25,CURRENT_DATE()), 'ADEQUATE'),
(150,6,25,  38,  12,  80,  DATEADD(day,365, CURRENT_DATE()),365,   0,    0.00, DATEADD(day,-25,CURRENT_DATE()), 'ADEQUATE');

-- =============================================================================
-- 2. DEMAND FORECAST — monthly predicted vs actual, demographic-driven
-- =============================================================================

CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_DEMAND_FORECAST (
    FORECAST_ID             NUMBER,
    PHARMACY_ID             NUMBER,
    DRUG_ID                 NUMBER,
    FORECAST_MONTH          VARCHAR,   -- YYYY-MM
    FORECAST_UNITS          NUMBER,    -- demographic model: pop × morbidity% × units_per_1000/1000
    ACTUAL_UNITS_DISPENSED  NUMBER,    -- what was actually dispensed
    VARIANCE_PCT            FLOAT,     -- (actual-forecast)/forecast × 100
    CATCHMENT_POPULATION    NUMBER,    -- estimated population in 10-min catchment
    PRIMARY_MORBIDITY_PCT   FLOAT,     -- driving morbidity rate
    DEMAND_DRIVER           VARCHAR    -- condition name
);

TRUNCATE TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_DEMAND_FORECAST;

-- 6 pharmacies × 25 drugs = 150 rows for current month
-- Forecast = catchment_pop × (morbidity%/100) × units_per_1000 / 1000
-- Variance tells the story: Mission under-supplied, Market St over-supplied

INSERT INTO FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_DEMAND_FORECAST
WITH NEAREST_NEIGHBORHOOD AS (
    SELECT
        ph.PHARMACY_ID,
        dh.NEIGHBORHOOD,
        dh.DIABETES_PCT,
        dh.HYPERTENSION_PCT,
        dh.CARDIOVASCULAR_PCT,
        dh.RESPIRATORY_PCT,
        dh.MOBILITY_ISSUES_PCT,
        ROW_NUMBER() OVER (
            PARTITION BY ph.PHARMACY_ID
            ORDER BY SQRT(POW(dh.LATITUDE - ph.LATITUDE, 2) + POW(dh.LONGITUDE - ph.LONGITUDE, 2))
        ) AS rn
    FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_TOP_PHARMACIES ph
    CROSS JOIN FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_HEALTH_DEMOGRAPHICS dh
),
CATCHMENT_POP AS (
    SELECT
        ph.PHARMACY_ID,
        SUM(dh.TOTAL_POPULATION) AS TOTAL_POP
    FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_TOP_PHARMACIES ph
    CROSS JOIN FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_HEALTH_DEMOGRAPHICS dh
    WHERE dh.NEIGHBORHOOD IN (
        SELECT NEIGHBORHOOD FROM NEAREST_NEIGHBORHOOD nn WHERE nn.PHARMACY_ID = ph.PHARMACY_ID AND nn.rn <= 5
    )
    GROUP BY ph.PHARMACY_ID
)
SELECT
    ROW_NUMBER() OVER (ORDER BY p.PHARMACY_ID, f.DRUG_ID) AS FORECAST_ID,
    p.PHARMACY_ID,
    f.DRUG_ID,
    TO_CHAR(CURRENT_DATE(), 'YYYY-MM') AS FORECAST_MONTH,
    CEIL(
        CASE f.CONDITION
            WHEN 'DIABETES'       THEN d.DIABETES_PCT       / 100
            WHEN 'HYPERTENSION'   THEN d.HYPERTENSION_PCT   / 100
            WHEN 'CARDIOVASCULAR' THEN d.CARDIOVASCULAR_PCT / 100
            WHEN 'RESPIRATORY'    THEN d.RESPIRATORY_PCT    / 100
            WHEN 'MOBILITY'       THEN d.MOBILITY_ISSUES_PCT/ 100
        END
        * cp.TOTAL_POP / 1000
        * f.UNITS_PER_1000
    ) AS FORECAST_UNITS,
    CEIL(
        CASE
            WHEN p.PHARMACY_ID = 4 THEN 0.85
            WHEN p.PHARMACY_ID = 5 THEN 1.40
            WHEN p.PHARMACY_ID = 3 THEN 1.15
            ELSE 1.05
        END
        * CEIL(
            CASE f.CONDITION
                WHEN 'DIABETES'       THEN d.DIABETES_PCT       / 100
                WHEN 'HYPERTENSION'   THEN d.HYPERTENSION_PCT   / 100
                WHEN 'CARDIOVASCULAR' THEN d.CARDIOVASCULAR_PCT / 100
                WHEN 'RESPIRATORY'    THEN d.RESPIRATORY_PCT    / 100
                WHEN 'MOBILITY'       THEN d.MOBILITY_ISSUES_PCT/ 100
            END
            * cp.TOTAL_POP / 1000
            * f.UNITS_PER_1000
        )
    ) AS ACTUAL_UNITS_DISPENSED,
    ROUND(
        (
            CASE
                WHEN p.PHARMACY_ID = 4 THEN 0.85
                WHEN p.PHARMACY_ID = 5 THEN 1.40
                WHEN p.PHARMACY_ID = 3 THEN 1.15
                ELSE 1.05
            END - 1.0
        ) * 100, 1
    ) AS VARIANCE_PCT,
    cp.TOTAL_POP AS CATCHMENT_POPULATION,
    CASE f.CONDITION
        WHEN 'DIABETES'       THEN d.DIABETES_PCT
        WHEN 'HYPERTENSION'   THEN d.HYPERTENSION_PCT
        WHEN 'CARDIOVASCULAR' THEN d.CARDIOVASCULAR_PCT
        WHEN 'RESPIRATORY'    THEN d.RESPIRATORY_PCT
        WHEN 'MOBILITY'       THEN d.MOBILITY_ISSUES_PCT
    END AS PRIMARY_MORBIDITY_PCT,
    f.CONDITION AS DEMAND_DRIVER
FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_TOP_PHARMACIES p
CROSS JOIN FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_DRUG_FORMULARY f
JOIN NEAREST_NEIGHBORHOOD d
    ON d.PHARMACY_ID = p.PHARMACY_ID AND d.rn = 1
JOIN CATCHMENT_POP cp
    ON cp.PHARMACY_ID = p.PHARMACY_ID;

-- =============================================================================
-- 3. REPLENISHMENT ORDERS — what to manufacture/dispatch
-- =============================================================================

CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_REPLENISHMENT_ORDERS (
    ORDER_ID             NUMBER,
    PHARMACY_ID          NUMBER,
    DRUG_ID              NUMBER,
    ORDER_DATE           DATE,
    UNITS_REQUIRED       NUMBER,
    UNIT_COST_USD        FLOAT,
    ORDER_VALUE_USD      FLOAT,
    DELIVERY_PRIORITY    NUMBER,   -- 1=Cold Chain, 2=Controlled, 3=Standard
    PRIORITY_LABEL       VARCHAR,
    DAYS_UNTIL_STOCKOUT  NUMBER,
    STATUS               VARCHAR   -- URGENT / STANDARD / REVIEW
);

TRUNCATE TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_REPLENISHMENT_ORDERS;

-- Generate replenishment orders for all CRITICAL/LOW items
INSERT INTO FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_REPLENISHMENT_ORDERS
SELECT
    ROW_NUMBER() OVER (ORDER BY inv.PHARMACY_ID, f.DELIVERY_SKILL, inv.DAYS_TO_EXPIRY) AS ORDER_ID,
    inv.PHARMACY_ID,
    inv.DRUG_ID,
    CURRENT_DATE()                                  AS ORDER_DATE,
    GREATEST(0, fc.FORECAST_UNITS - inv.CURRENT_STOCK_UNITS + inv.WASTAGE_UNITS_MTD) AS UNITS_REQUIRED,
    CASE f.DELIVERY_SKILL
        WHEN 1 THEN 85.00   -- Cold chain premium
        WHEN 2 THEN 45.00   -- Controlled substances
        ELSE        12.00   -- Standard
    END                                             AS UNIT_COST_USD,
    GREATEST(0, fc.FORECAST_UNITS - inv.CURRENT_STOCK_UNITS + inv.WASTAGE_UNITS_MTD)
        * CASE f.DELIVERY_SKILL WHEN 1 THEN 85.00 WHEN 2 THEN 45.00 ELSE 12.00 END
                                                    AS ORDER_VALUE_USD,
    f.DELIVERY_SKILL                                AS DELIVERY_PRIORITY,
    f.SKILL_LABEL                                   AS PRIORITY_LABEL,
    CASE
        WHEN inv.CURRENT_STOCK_UNITS = 0 THEN 0
        WHEN fc.FORECAST_UNITS = 0       THEN 999
        ELSE FLOOR(inv.CURRENT_STOCK_UNITS / (fc.FORECAST_UNITS / 30.0))
    END                                             AS DAYS_UNTIL_STOCKOUT,
    CASE
        WHEN inv.STOCK_STATUS = 'CRITICAL' OR inv.DAYS_TO_EXPIRY <= 14 THEN 'URGENT'
        WHEN inv.STOCK_STATUS = 'LOW'                                   THEN 'STANDARD'
        ELSE 'REVIEW'
    END                                             AS STATUS
FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_INVENTORY inv
JOIN FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_DRUG_FORMULARY f  ON f.DRUG_ID  = inv.DRUG_ID
JOIN FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_DEMAND_FORECAST  fc
    ON fc.PHARMACY_ID = inv.PHARMACY_ID AND fc.DRUG_ID = inv.DRUG_ID
WHERE inv.STOCK_STATUS IN ('CRITICAL', 'LOW')
   OR inv.DAYS_TO_EXPIRY <= 30
ORDER BY f.DELIVERY_SKILL, inv.DAYS_TO_EXPIRY;

-- =============================================================================
-- VERIFY
-- =============================================================================

SELECT 'SF_INVENTORY'             AS tbl, COUNT(*) AS row_count FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_INVENTORY
UNION ALL
SELECT 'SF_DEMAND_FORECAST',       COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_DEMAND_FORECAST
UNION ALL
SELECT 'SF_REPLENISHMENT_ORDERS',  COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_REPLENISHMENT_ORDERS;
