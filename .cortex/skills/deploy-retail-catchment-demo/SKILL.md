---
name: deploy-retail-catchment-demo
description: "Deploy the Retail Catchment Analysis Streamlit app with Overture Maps data. Use when: setting up retail catchment demo, deploying catchment analysis, creating retail location analysis app. Triggers: retail demo catchment, deploy retail catchment demo"
---

# Deploy Retail Catchment Demo

Deploy the Retail Catchment Analysis Streamlit app that visualizes trade areas, competitors, and address density using OpenRouteService isochrones and Overture Maps data.

## Configuration

- **Database:** `OPENROUTESERVICE_SETUP`
- **Schema:** `RETAIL_CATCHMENT_DEMO`
- **Warehouse:** `ROUTING_ANALYTICS`
- **Streamlit App:** `RETAIL_CATCHMENT_APP`
- **Stage:** `STREAMLIT_STAGE`

## Prerequisites

- OpenRouteService Native App installed (e.g., `OPENROUTESERVICE_NATIVE_APP`)
- ACCOUNTADMIN role or equivalent privileges
- snow CLI installed and configured

## Workflow

### Step 1: Set Query Tag for Tracking

**Goal:** Set session query tag for attribution tracking.

```sql
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is","name":"oss-retail-catchment-analysis","version":{"major":1, "minor":0},"attributes":{"is_quickstart":1, "source":"sql"}}';
```

**Output:** Query tag set for session tracking

### Step 2: Verify OpenRouteService Installation

**Goal:** Confirm OpenRouteService Native App is installed and services are running.

**1a. Check ORS application exists:**
```sql
SHOW APPLICATIONS LIKE '%OPENROUTESERVICE%';
```

**If NOT found:** Stop and inform user to install ORS first using:
```
use the local skill from oss-install-openrouteservice-native-app/skills/deploy-route-optimizer
```

**1b. Verify services are running:**
```sql
SHOW SERVICES IN APPLICATION OPENROUTESERVICE_NATIVE_APP;
```

Required services (must be RUNNING):
- `ORS_SERVICE` - powers isochrone calculations
- `ROUTING_GATEWAY_SERVICE` - API gateway

**If any service is SUSPENDED:**
```sql
ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SERVICE RESUME;
ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.ROUTING_GATEWAY_SERVICE RESUME;
```

Wait 15-30 seconds for services to start.

**Output:** ORS verified and running

### Step 3: Get Carto Overture Datasets from Marketplace

**Goal:** Acquire Overture Maps Places and Addresses datasets for POI and density data.

**2a. Get Overture Maps Places (POI data):**
```sql
CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZT0Z4CM1E9KR');
CREATE DATABASE IF NOT EXISTS OVERTURE_MAPS__PLACES FROM LISTING GZT0Z4CM1E9KR;
```

**2b. Get Overture Maps Addresses (for H3 density):**
```sql
CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZT0Z4CM1E9NQ');
CREATE DATABASE IF NOT EXISTS OVERTURE_MAPS__ADDRESSES FROM LISTING GZT0Z4CM1E9NQ;
```

**2c. Verify datasets are accessible:**
```sql
SELECT COUNT(*) FROM OVERTURE_MAPS__PLACES.CARTO.PLACE LIMIT 1;
SELECT COUNT(*) FROM OVERTURE_MAPS__ADDRESSES.CARTO.ADDRESS WHERE COUNTRY = 'US' LIMIT 1;
```

**Output:** Marketplace datasets available

### Step 4: Create Database, Schema, and Warehouse

**Goal:** Set up the demo database, schema, and warehouse.

```sql
-- Create warehouse if not exists
CREATE WAREHOUSE IF NOT EXISTS ROUTING_ANALYTICS
    WAREHOUSE_SIZE = 'XSMALL'
    AUTO_SUSPEND = 60
    AUTO_RESUME = TRUE
    COMMENT = '{"origin":"sf_sit-is", "name":"oss-retail-catchment-analysis", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';

-- Create database
CREATE DATABASE IF NOT EXISTS OPENROUTESERVICE_SETUP
    COMMENT = '{"origin":"sf_sit-is", "name":"oss-retail-catchment-analysis", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';

-- Create schema
CREATE SCHEMA IF NOT EXISTS OPENROUTESERVICE_SETUP.RETAIL_CATCHMENT_DEMO
    COMMENT = '{"origin":"sf_sit-is", "name":"oss-retail-catchment-analysis", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';

-- Create stage for Streamlit files
CREATE STAGE IF NOT EXISTS OPENROUTESERVICE_SETUP.RETAIL_CATCHMENT_DEMO.STREAMLIT_STAGE
    DIRECTORY = (ENABLE = TRUE)
    COMMENT = '{"origin":"sf_sit-is", "name":"oss-retail-catchment-analysis", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';
```

**Output:** Database `OPENROUTESERVICE_SETUP`, schema `RETAIL_CATCHMENT_DEMO` created with stage

### Step 5: Create Optimized Data Tables

**Goal:** Create pre-filtered, performance-optimized tables from Overture Maps marketplace data. These tables are required by the Streamlit app.

**5a. Set bounding box configuration (customize for your region):**

```sql
-- Default: San Francisco Bay Area
-- Common bounding boxes:
--   San Francisco Bay Area: (-123.0, 36.8, -121.5, 38.5)
--   New York Metro:         (-74.5, 40.4, -73.5, 41.2)
--   Los Angeles:            (-118.8, 33.5, -117.5, 34.5)
--   Chicago:                (-88.5, 41.5, -87.2, 42.2)
--   London:                 (-0.6, 51.2, 0.4, 51.8)
--   Full US (no filter):    (-180, -90, 180, 90)

SET BBOX_MIN_LON = -123.0;  -- Western boundary (longitude)
SET BBOX_MIN_LAT = 36.8;    -- Southern boundary (latitude)
SET BBOX_MAX_LON = -121.5;  -- Eastern boundary (longitude)
SET BBOX_MAX_LAT = 38.5;    -- Northern boundary (latitude)
SET REGION_NAME = 'San Francisco Bay Area';
```

**5b. Create filtered POI table for retail categories within bounding box:**

```sql
CREATE OR REPLACE TABLE OPENROUTESERVICE_SETUP.RETAIL_CATCHMENT_DEMO.RETAIL_POIS AS
SELECT 
    ID AS POI_ID,
    NAMES:primary::VARCHAR AS POI_NAME,
    BASIC_CATEGORY,
    ST_X(GEOMETRY) AS LONGITUDE,
    ST_Y(GEOMETRY) AS LATITUDE,
    GEOMETRY,
    COALESCE(ADDRESSES[0]:freeform::VARCHAR, '') AS ADDRESS,
    ADDRESSES[0]:locality::VARCHAR AS CITY,
    ADDRESSES[0]:region::VARCHAR AS STATE,
    ADDRESSES[0]:postcode::VARCHAR AS POSTCODE
FROM OVERTURE_MAPS__PLACES.CARTO.PLACE
WHERE BASIC_CATEGORY IN (
    'coffee_shop', 'fast_food_restaurant', 'restaurant', 'casual_eatery',
    'grocery_store', 'convenience_store', 'gas_station', 'pharmacy',
    'clothing_store', 'electronics_store', 'specialty_store', 'gym',
    'beauty_salon', 'hair_salon', 'bakery', 'bar', 'supermarket'
)
AND GEOMETRY IS NOT NULL
AND ADDRESSES[0]:region IS NOT NULL
AND ST_X(GEOMETRY) BETWEEN $BBOX_MIN_LON AND $BBOX_MAX_LON
AND ST_Y(GEOMETRY) BETWEEN $BBOX_MIN_LAT AND $BBOX_MAX_LAT;
```

**5c. Create pre-aggregated cities table:**

```sql
CREATE OR REPLACE TABLE OPENROUTESERVICE_SETUP.RETAIL_CATCHMENT_DEMO.CITIES_BY_STATE AS
SELECT 
    STATE,
    CITY,
    COUNT(*) AS POI_COUNT
FROM OPENROUTESERVICE_SETUP.RETAIL_CATCHMENT_DEMO.RETAIL_POIS
WHERE CITY IS NOT NULL
GROUP BY STATE, CITY
HAVING COUNT(*) > 10
ORDER BY STATE, POI_COUNT DESC;
```

**5d. Create addresses table within bounding box:**

```sql
CREATE OR REPLACE TABLE OPENROUTESERVICE_SETUP.RETAIL_CATCHMENT_DEMO.REGIONAL_ADDRESSES AS
SELECT 
    ID,
    GEOMETRY,
    ST_X(GEOMETRY) AS LONGITUDE,
    ST_Y(GEOMETRY) AS LATITUDE,
    POSTAL_CITY AS CITY,
    POSTCODE
FROM OVERTURE_MAPS__ADDRESSES.CARTO.ADDRESS
WHERE COUNTRY = 'US'
AND GEOMETRY IS NOT NULL
AND ST_X(GEOMETRY) BETWEEN $BBOX_MIN_LON AND $BBOX_MAX_LON
AND ST_Y(GEOMETRY) BETWEEN $BBOX_MIN_LAT AND $BBOX_MAX_LAT;
```

**5e. Store region configuration for reference:**

```sql
CREATE OR REPLACE TABLE OPENROUTESERVICE_SETUP.RETAIL_CATCHMENT_DEMO.REGION_CONFIG AS
SELECT 
    $REGION_NAME AS REGION_NAME,
    $BBOX_MIN_LON AS BBOX_MIN_LON,
    $BBOX_MIN_LAT AS BBOX_MIN_LAT,
    $BBOX_MAX_LON AS BBOX_MAX_LON,
    $BBOX_MAX_LAT AS BBOX_MAX_LAT,
    CURRENT_TIMESTAMP() AS CREATED_AT;
```

**5f. Add search optimization:**

```sql
ALTER TABLE OPENROUTESERVICE_SETUP.RETAIL_CATCHMENT_DEMO.RETAIL_POIS ADD SEARCH OPTIMIZATION ON GEO(GEOMETRY);
ALTER TABLE OPENROUTESERVICE_SETUP.RETAIL_CATCHMENT_DEMO.RETAIL_POIS ADD SEARCH OPTIMIZATION ON EQUALITY(STATE, CITY, BASIC_CATEGORY);

ALTER TABLE OPENROUTESERVICE_SETUP.RETAIL_CATCHMENT_DEMO.REGIONAL_ADDRESSES ADD SEARCH OPTIMIZATION ON GEO(GEOMETRY);

ALTER TABLE OPENROUTESERVICE_SETUP.RETAIL_CATCHMENT_DEMO.CITIES_BY_STATE ADD SEARCH OPTIMIZATION ON EQUALITY(STATE);
```

**5g. Add clustering for query performance:**

```sql
ALTER TABLE OPENROUTESERVICE_SETUP.RETAIL_CATCHMENT_DEMO.RETAIL_POIS CLUSTER BY (STATE, CITY, BASIC_CATEGORY);
ALTER TABLE OPENROUTESERVICE_SETUP.RETAIL_CATCHMENT_DEMO.REGIONAL_ADDRESSES CLUSTER BY (LONGITUDE, LATITUDE);
```

**5h. Verify tables have data:**

```sql
SELECT 'RETAIL_POIS' AS TABLE_NAME, COUNT(*) AS ROW_COUNT FROM OPENROUTESERVICE_SETUP.RETAIL_CATCHMENT_DEMO.RETAIL_POIS
UNION ALL
SELECT 'CITIES_BY_STATE', COUNT(*) FROM OPENROUTESERVICE_SETUP.RETAIL_CATCHMENT_DEMO.CITIES_BY_STATE
UNION ALL
SELECT 'REGIONAL_ADDRESSES', COUNT(*) FROM OPENROUTESERVICE_SETUP.RETAIL_CATCHMENT_DEMO.REGIONAL_ADDRESSES;
```

**If any table has 0 rows:** Check the bounding box configuration and verify Marketplace datasets are accessible.

**Output:** 4 optimized tables created with search optimization and clustering

### Step 6: Upload Streamlit Files

**Goal:** Upload all Streamlit app files to the stage.

Run these commands:

```bash
snow stage copy oss-retail-catchment-overture-maps/Streamlit/retail_catchment.py @OPENROUTESERVICE_SETUP.RETAIL_CATCHMENT_DEMO.STREAMLIT_STAGE --overwrite
snow stage copy oss-retail-catchment-overture-maps/Streamlit/environment.yml @OPENROUTESERVICE_SETUP.RETAIL_CATCHMENT_DEMO.STREAMLIT_STAGE --overwrite
snow stage copy oss-retail-catchment-overture-maps/Streamlit/extra.css @OPENROUTESERVICE_SETUP.RETAIL_CATCHMENT_DEMO.STREAMLIT_STAGE --overwrite
snow stage copy oss-retail-catchment-overture-maps/Streamlit/logo.svg @OPENROUTESERVICE_SETUP.RETAIL_CATCHMENT_DEMO.STREAMLIT_STAGE --overwrite
snow stage copy oss-retail-catchment-overture-maps/Streamlit/config.toml @OPENROUTESERVICE_SETUP.RETAIL_CATCHMENT_DEMO.STREAMLIT_STAGE --overwrite
```

**Verify files uploaded:**
```sql
LIST @OPENROUTESERVICE_SETUP.RETAIL_CATCHMENT_DEMO.STREAMLIT_STAGE;
```

**Output:** 5 files uploaded to stage

### Step 7: Create Streamlit App

**Goal:** Create the Streamlit application in Snowflake.

```sql
CREATE OR REPLACE STREAMLIT OPENROUTESERVICE_SETUP.RETAIL_CATCHMENT_DEMO.RETAIL_CATCHMENT_APP
    FROM @OPENROUTESERVICE_SETUP.RETAIL_CATCHMENT_DEMO.STREAMLIT_STAGE
    MAIN_FILE = 'retail_catchment.py'
    QUERY_WAREHOUSE = 'ROUTING_ANALYTICS'
    TITLE = 'RETAIL CATCHMENT APP'
    COMMENT = '{"origin":"sf_sit-is", "name":"oss-retail-catchment-analysis", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"streamlit"}}';

ALTER STREAMLIT OPENROUTESERVICE_SETUP.RETAIL_CATCHMENT_DEMO.RETAIL_CATCHMENT_APP ADD LIVE VERSION FROM LAST;
```

**Output:** Streamlit app created

### Step 8: Verify Deployment

**Goal:** Confirm the app is deployed and accessible.

```sql
SHOW STREAMLITS IN SCHEMA OPENROUTESERVICE_SETUP.RETAIL_CATCHMENT_DEMO;
```

**Output:** `RETAIL_CATCHMENT_APP` visible in results

### Step 9: Launch the App

**Goal:** Open the Streamlit app in Snowsight.

**Option A - Direct URL:**
Navigate to Snowsight > Projects > Streamlit > RETAIL_CATCHMENT_APP

**Option B - Get app URL:**
```sql
SELECT CONCAT('https://app.snowflake.com/', CURRENT_ORGANIZATION_NAME(), '/', CURRENT_ACCOUNT_NAME(), '/#/streamlit-apps/OPENROUTESERVICE_SETUP.RETAIL_CATCHMENT_DEMO.RETAIL_CATCHMENT_APP') AS streamlit_url;
```

**Output:** App launched and ready to use

## Features

The deployed app provides:
- **Isochrone Analysis:** Travel-time based catchment zones (1-60 min)
- **Competitor Mapping:** Find competitors within catchment areas
- **H3 Address Density:** Visualize residential density using hexagonal grid
- **Smart Location Recommendation:** AI-powered optimal new location suggestions based on:
  - Address density
  - Median household income
  - Distance from competitors
  - Demographics (education, families)
- **Market Analysis:** Synthetic footfall, population density, income data

## Stopping Points

- ✋ Step 2: Verify ORS is installed before proceeding
- ✋ Step 3: Confirm marketplace data is accessible
- ✋ Step 5: Verify optimized tables have data before uploading Streamlit files
- ✋ Step 9: Verify app loads without errors

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "No stores found" | Verify Overture Maps Places dataset is accessible |
| Isochrone fails | Check ORS services are RUNNING |
| Map not loading | Ensure pydeck is in environment.yml |
| App crashes on load | Check warehouse is active and has credits |
| RETAIL_POIS table empty | Check bounding box config and Overture Maps Places access |
| REGIONAL_ADDRESSES table empty | Check bounding box config and Overture Maps Addresses access |
| "Object does not exist" on table | Ensure Step 5 completed successfully before Step 6 |

## Output

Deployed resources:
- Database: `OPENROUTESERVICE_SETUP`
- Schema: `OPENROUTESERVICE_SETUP.RETAIL_CATCHMENT_DEMO`
- Streamlit App: `RETAIL_CATCHMENT_APP`
- Warehouse: `ROUTING_ANALYTICS`
- Stage: `STREAMLIT_STAGE` (with 5 files)
- Tables: `RETAIL_POIS`, `CITIES_BY_STATE`, `REGIONAL_ADDRESSES`, `REGION_CONFIG`

Demo is ready for retail catchment analysis in San Francisco region.
