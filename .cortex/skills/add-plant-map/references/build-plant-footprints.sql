-- =============================================================================
-- build-plant-footprints.sql
-- Pre-computes Overture building footprints for each manufacturing plant
-- and creates an alert status view joining supply chain data.
-- Run this BEFORE deploying the Plant Intelligence React module.
-- =============================================================================

USE ROLE ACCOUNTADMIN;
USE WAREHOUSE ROUTING_ANALYTICS;
USE DATABASE FLEET_INTELLIGENCE;
USE SCHEMA PHARMA_SUPPLY_CHAIN;

-- =============================================================================
-- 1. PRE-COMPUTED BUILDING FOOTPRINTS
--    Pulls buildings + building_parts from Overture within ~800m of each plant
-- =============================================================================

CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANT_BUILDING_FOOTPRINTS AS

-- Main buildings
SELECT
    p.PLANT_ID,
    p.PLANT_NAME,
    p.PLANT_CODE,
    b.ID                                                     AS OVERTURE_ID,
    ST_ASGEOJSON(b.GEOMETRY)                                 AS GEOJSON,
    TRY_PARSE_JSON(b.NAMES):primary::string                  AS BUILDING_NAME,
    b.CLASS,
    b.HEIGHT,
    'BUILDING'                                               AS FOOTPRINT_TYPE
FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANTS p,
     LATERAL (
         SELECT * FROM OVERTURE_MAPS__BUILDINGS.BUILDINGS.BUILDING
         WHERE ST_DWITHIN(GEOMETRY, ST_POINT(p.LONGITUDE, p.LATITUDE), 0.008)
           AND GEOMETRY IS NOT NULL
     ) b

UNION ALL

-- Building parts (sub-structures within each building complex)
SELECT
    p.PLANT_ID,
    p.PLANT_NAME,
    p.PLANT_CODE,
    bp.ID                                                    AS OVERTURE_ID,
    ST_ASGEOJSON(bp.GEOMETRY)                                AS GEOJSON,
    NULL                                                     AS BUILDING_NAME,
    bp.CLASS,
    NULL                                                     AS HEIGHT,
    'BUILDING_PART'                                          AS FOOTPRINT_TYPE
FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANTS p,
     LATERAL (
         SELECT bp.*
         FROM OVERTURE_MAPS__BUILDINGS.BUILDINGS.BUILDING_PART bp
         JOIN OVERTURE_MAPS__BUILDINGS.BUILDINGS.BUILDING b2
              ON bp.BUILDING_ID = b2.ID
         WHERE ST_DWITHIN(b2.GEOMETRY, ST_POINT(p.LONGITUDE, p.LATITUDE), 0.008)
           AND bp.GEOMETRY IS NOT NULL
     ) bp;

-- =============================================================================
-- 2. PLANT ALERT STATUS VIEW
--    Aggregates supply chain alerts per plant for color-coding the map
-- =============================================================================

CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANT_ALERT_STATUS AS
SELECT
    pl.PLANT_ID,
    pl.PLANT_NAME,
    pl.PLANT_CODE,
    pl.CITY,
    pl.COUNTRY,
    pl.REGION,
    pl.SPECIALISATION,
    pl.CAPACITY_BATCHES_MONTH,
    pl.LATITUDE,
    pl.LONGITUDE,

    -- Severity per category (4=critical, 3=high, 2=medium, 1=low, 0=none)
    MAX(CASE
        WHEN b.STATUS = 'ON_HOLD'   AND b.DEVIATION_SEVERITY = 'CRITICAL' THEN 4
        WHEN b.STATUS = 'REJECTED'                                         THEN 4
        WHEN b.STATUS = 'ON_HOLD'   AND b.DEVIATION_SEVERITY = 'MAJOR'    THEN 3
        WHEN b.STATUS = 'QC_REVIEW' AND b.QC_RESULT = 'FAIL'              THEN 3
        WHEN b.DEVIATION_COUNT > 0                                         THEN 1
        ELSE 0
    END) AS BATCH_SEVERITY,

    MAX(CASE
        WHEN mi.TEMP_EXCURSION_FLAG = TRUE  THEN 3
        ELSE 0
    END) AS TEMP_SEVERITY,

    MAX(CASE
        WHEN mi.STOCK_STATUS = 'CRITICAL' THEN 2
        WHEN mi.STOCK_STATUS = 'LOW'      THEN 1
        ELSE 0
    END) AS STOCK_SEVERITY,

    MAX(CASE
        WHEN sh.STATUS IN ('DELAYED', 'CUSTOMS') AND sh.DELAY_DAYS >= 7 THEN 2
        WHEN sh.STATUS IN ('DELAYED', 'CUSTOMS')                         THEN 1
        ELSE 0
    END) AS SHIPMENT_SEVERITY,

    -- Overall worst severity
    GREATEST(
        MAX(CASE
            WHEN b.STATUS = 'ON_HOLD'   AND b.DEVIATION_SEVERITY = 'CRITICAL' THEN 4
            WHEN b.STATUS = 'REJECTED'                                         THEN 4
            WHEN b.STATUS = 'ON_HOLD'   AND b.DEVIATION_SEVERITY = 'MAJOR'    THEN 3
            WHEN b.STATUS = 'QC_REVIEW' AND b.QC_RESULT = 'FAIL'              THEN 3
            WHEN b.DEVIATION_COUNT > 0                                         THEN 1
            ELSE 0
        END),
        MAX(CASE WHEN mi.TEMP_EXCURSION_FLAG = TRUE THEN 3 ELSE 0 END),
        MAX(CASE WHEN mi.STOCK_STATUS = 'CRITICAL' THEN 2 WHEN mi.STOCK_STATUS = 'LOW' THEN 1 ELSE 0 END),
        MAX(CASE WHEN sh.STATUS IN ('DELAYED', 'CUSTOMS') AND sh.DELAY_DAYS >= 7 THEN 2
                 WHEN sh.STATUS IN ('DELAYED', 'CUSTOMS') THEN 1 ELSE 0 END)
    ) AS MAX_SEVERITY,

    -- Alert counts
    COUNT(DISTINCT CASE WHEN b.STATUS IN ('ON_HOLD', 'REJECTED') THEN b.BATCH_ID END) AS CRITICAL_BATCHES,
    COUNT(DISTINCT CASE WHEN mi.TEMP_EXCURSION_FLAG = TRUE THEN mi.INVENTORY_ID END)   AS TEMP_EXCURSIONS,
    COUNT(DISTINCT CASE WHEN mi.STOCK_STATUS = 'CRITICAL'   THEN mi.INVENTORY_ID END)  AS CRITICAL_STOCK_ITEMS,
    COUNT(DISTINCT CASE WHEN sh.STATUS IN ('DELAYED', 'CUSTOMS') THEN sh.SHIPMENT_ID END) AS DELAYED_SHIPMENTS,
    COUNT(DISTINCT CASE WHEN b.STATUS = 'IN_PROGRESS' THEN b.BATCH_ID END)             AS BATCHES_IN_PROGRESS

FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANTS pl
LEFT JOIN FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PRODUCTION_BATCHES b
    ON b.PLANT_ID = pl.PLANT_ID
LEFT JOIN FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.MATERIAL_INVENTORY mi
    ON mi.PLANT_ID = pl.PLANT_ID
LEFT JOIN FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.SHIPMENTS sh
    ON sh.PLANT_ID = pl.PLANT_ID
GROUP BY
    pl.PLANT_ID, pl.PLANT_NAME, pl.PLANT_CODE, pl.CITY, pl.COUNTRY,
    pl.REGION, pl.SPECIALISATION, pl.CAPACITY_BATCHES_MONTH,
    pl.LATITUDE, pl.LONGITUDE;

-- =============================================================================
-- VERIFY
-- =============================================================================

SELECT COUNT(*) AS building_footprint_rows,
       COUNT(DISTINCT PLANT_ID) AS plants_with_footprints
FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANT_BUILDING_FOOTPRINTS;

SELECT PLANT_NAME, MAX_SEVERITY, CRITICAL_BATCHES, TEMP_EXCURSIONS,
       CRITICAL_STOCK_ITEMS, DELAYED_SHIPMENTS
FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANT_ALERT_STATUS
ORDER BY MAX_SEVERITY DESC;
