-- =============================================================================
-- build-plant-footprints.sql
-- Creates the PLANT_ALERT_STATUS view (always) and pre-computes
-- Overture building footprints for each manufacturing plant.
-- Run this BEFORE deploying the Plant Intelligence React module.
-- =============================================================================

USE ROLE ACCOUNTADMIN;
USE WAREHOUSE ROUTING_ANALYTICS;
USE DATABASE FLEET_INTELLIGENCE;
USE SCHEMA PHARMA_SUPPLY_CHAIN;

-- =============================================================================
-- 1. PLANT ALERT STATUS VIEW (no external dependencies)
--    Aggregates supply chain alerts per plant for color-coding the map
-- =============================================================================

CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANT_ALERT_STATUS
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-add-plant-map","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
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

-- Verify alert status
SELECT PLANT_NAME, MAX_SEVERITY, CRITICAL_BATCHES, TEMP_EXCURSIONS,
       CRITICAL_STOCK_ITEMS, DELAYED_SHIPMENTS
FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANT_ALERT_STATUS
ORDER BY MAX_SEVERITY DESC;

-- =============================================================================
-- 2. PRE-COMPUTED BUILDING FOOTPRINTS (requires OVERTURE_MAPS__BUILDINGS)
--    Uses BBOX pre-filter for performance on 2.5B row table.
--    Install from Marketplace: search "Overture Maps - Buildings" by CARTO.
--    Database name: OVERTURE_MAPS__BUILDINGS, schema: CARTO
-- =============================================================================

-- Accept terms and install listing (idempotent)
CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZT0Z4CM1E9KN');
CREATE DATABASE IF NOT EXISTS OVERTURE_MAPS__BUILDINGS FROM LISTING 'GZT0Z4CM1E9KN';

CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANT_BUILDING_FOOTPRINTS
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-add-plant-map","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
WITH PLANT_BOUNDS AS (
    SELECT
        PLANT_ID, PLANT_NAME, PLANT_CODE, LATITUDE, LONGITUDE,
        LONGITUDE - 0.008 AS MIN_LON,
        LONGITUDE + 0.008 AS MAX_LON,
        LATITUDE  - 0.008 AS MIN_LAT,
        LATITUDE  + 0.008 AS MAX_LAT
    FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANTS
)
SELECT
    p.PLANT_ID,
    p.PLANT_NAME,
    p.PLANT_CODE,
    b.ID                                    AS OVERTURE_ID,
    ST_ASGEOJSON(b.GEOMETRY)                AS GEOJSON,
    TRY_PARSE_JSON(b.NAMES):primary::string AS BUILDING_NAME,
    b.CLASS,
    b.HEIGHT,
    'BUILDING'                              AS FOOTPRINT_TYPE
FROM PLANT_BOUNDS p
JOIN OVERTURE_MAPS__BUILDINGS.CARTO.BUILDING b
  ON b.BBOX:xmin::FLOAT >= p.MIN_LON
 AND b.BBOX:xmax::FLOAT <= p.MAX_LON
 AND b.BBOX:ymin::FLOAT >= p.MIN_LAT
 AND b.BBOX:ymax::FLOAT <= p.MAX_LAT
 AND b.GEOMETRY IS NOT NULL;

-- Verify footprints
SELECT COUNT(*) AS building_footprint_rows,
       COUNT(DISTINCT PLANT_ID) AS plants_with_footprints
FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANT_BUILDING_FOOTPRINTS;

-- ============================================================
-- PRIMARY BUILDING VIEW: largest building per plant
-- Used by the warehouse drill-down feature
-- ============================================================
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANT_PRIMARY_BUILDING AS
WITH RANKED AS (
  SELECT *,
    ROUND(ST_AREA(TO_GEOGRAPHY(GEOJSON::VARIANT::STRING)), 0) AS AREA_SQM,
    ROW_NUMBER() OVER (PARTITION BY PLANT_ID ORDER BY ST_AREA(TO_GEOGRAPHY(GEOJSON::VARIANT::STRING)) DESC) AS RNK
  FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANT_BUILDING_FOOTPRINTS
  WHERE GEOJSON IS NOT NULL
)
SELECT PLANT_ID, PLANT_NAME, PLANT_CODE, OVERTURE_ID, GEOJSON, BUILDING_NAME, CLASS, HEIGHT, FOOTPRINT_TYPE, AREA_SQM
FROM RANKED WHERE RNK = 1;

SELECT COUNT(*) AS primary_building_rows FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANT_PRIMARY_BUILDING;
