---
name: deploy-retail-catchment-demo
description: "Deploy the Retail Catchment Analysis Streamlit app with Overture Maps data. Use when: setting up retail catchment demo, deploying catchment analysis, creating retail location analysis app. Triggers: retail demo catchment, deploy retail catchment demo"
---

# Deploy Retail Catchment Demo

Deploy the Retail Catchment Analysis Streamlit app that visualizes trade areas, competitors, and address density using OpenRouteService isochrones and Overture Maps data.

## Configuration

- **Database:** `OPENROUTESERVICE_NATIVEAPP`
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

### Step 4: Create Database and Warehouse

**Goal:** Set up the demo database, schema, and warehouse.

```sql
-- Create warehouse if not exists
CREATE WAREHOUSE IF NOT EXISTS ROUTING_ANALYTICS
    WAREHOUSE_SIZE = 'XSMALL'
    AUTO_SUSPEND = 60
    AUTO_RESUME = TRUE;

-- Create and schema
CREATE SCHEMA IF NOT EXISTS OPENROUTESERVICE_NATIVEAPP.RETAIL_CATCHMENT_DEMO;

-- Create stage for Streamlit files
CREATE STAGE IF NOT EXISTS OPENROUTESERVICE_NATIVEAPP.RETAIL_CATCHMENT_DEMO.STREAMLIT_STAGE
    DIRECTORY = (ENABLE = TRUE);
```

**Output:** Schema `OPENROUTESERVICE_NATIVEAPP.RETAIL_CATCHMENT_DEMO` created with stage

### Step 5: Upload Streamlit Files

**Goal:** Upload all Streamlit app files to the stage.

Run these commands from the `oss-retail-catchment-overture-maps` directory:

```bash
snow stage copy Streamlit/retail_catchment.py @OPENROUTESERVICE_NATIVEAPP.RETAIL_CATCHMENT_DEMO.STREAMLIT_STAGE --overwrite
snow stage copy Streamlit/environment.yml @OPENROUTESERVICE_NATIVEAPP.RETAIL_CATCHMENT_DEMO.STREAMLIT_STAGE --overwrite
snow stage copy Streamlit/extra.css @OPENROUTESERVICE_NATIVEAPP.RETAIL_CATCHMENT_DEMO.STREAMLIT_STAGE --overwrite
snow stage copy Streamlit/logo.svg @OPENROUTESERVICE_NATIVEAPP.RETAIL_CATCHMENT_DEMO.STREAMLIT_STAGE --overwrite
```

**Verify files uploaded:**
```sql
LIST @OPENROUTESERVICE_NATIVEAPP.RETAIL_CATCHMENT_DEMO.STREAMLIT_STAGE;
```

**Output:** 4 files uploaded to stage

### Step 6: Create Streamlit App

**Goal:** Create the Streamlit application in Snowflake.

```sql
CREATE OR REPLACE STREAMLIT OPENROUTESERVICE_NATIVEAPP.RETAIL_CATCHMENT_DEMO.RETAIL_CATCHMENT_APP
    ROOT_LOCATION = '@OPENROUTESERVICE_NATIVEAPP.RETAIL_CATCHMENT_DEMO.STREAMLIT_STAGE'
    MAIN_FILE = 'retail_catchment.py'
    QUERY_WAREHOUSE = 'ROUTING_ANALYTICS'
    COMMENT = '{"origin":"sf_sit-is", "name":"oss-retail-catchment-analysis", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"streamlit"}}';
```

**Output:** Streamlit app created

### Step 7: Verify Deployment

**Goal:** Confirm the app is deployed and accessible.

```sql
SHOW STREAMLITS IN SCHEMA OPENROUTESERVICE_NATIVEAPP.RETAIL_CATCHMENT_DEMO;
```

**Output:** `RETAIL_CATCHMENT_APP` visible in results

### Step 8: Launch the App

**Goal:** Open the Streamlit app in Snowsight.

**Option A - Direct URL:**
Navigate to Snowsight > Projects > Streamlit > RETAIL_CATCHMENT_APP

**Option B - Get app URL:**
```sql
SELECT SYSTEM$GET_STREAMLIT_URL('OPENROUTESERVICE_NATIVEAPP.RETAIL_CATCHMENT_DEMO.RETAIL_CATCHMENT_APP');
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
- ✋ Step 8: Verify app loads without errors

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "No stores found" | Verify Overture Maps Places dataset is accessible |
| Isochrone fails | Check ORS services are RUNNING |
| Map not loading | Ensure pydeck is in environment.yml |
| App crashes on load | Check warehouse is active and has credits |

## Output

Deployed resources:
- Schema: `OPENROUTESERVICE_NATIVEAPP.RETAIL_CATCHMENT_DEMO`
- Streamlit App: `RETAIL_CATCHMENT_APP`
- Warehouse: `ROUTING_ANALYTICS`
- Stage: `STREAMLIT_STAGE` (with 4 files)

Demo is ready for retail catchment analysis in San Francisco region.
