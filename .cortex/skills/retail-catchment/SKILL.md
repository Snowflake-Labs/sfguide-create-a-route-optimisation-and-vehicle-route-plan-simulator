---
name: retail-catchment
description: "Deploy the Retail Catchment Analysis Streamlit app with Overture Maps data. Use when: setting up retail catchment demo, deploying catchment analysis, creating retail location analysis app, retail isochrone analysis, competitor mapping demo. Do NOT use for: fleet intelligence demos (use fleet-intelligence-taxis or fleet-intelligence-food-delivery), route optimization (use route-optimization), route deviation analysis (use route-deviation), or dwell analysis (use dwell-analysis). Triggers: retail demo catchment, deploy retail catchment demo, retail isochrone analysis, competitor mapping demo, retail location analysis, trade area analysis."
metadata:
  author: Snowflake SIT-IS
  version: 1.0.0
  category: retail-analytics
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

> Full SQL for all steps: [references/sql-pipeline.md](references/sql-pipeline.md)

### Step 1: Set Query Tag for Tracking

**Goal:** Set session query tag for attribution tracking.

> See `references/sql-pipeline.md` Step 1.

### Step 2: Verify OpenRouteService Installation

**Goal:** Confirm OpenRouteService Native App is installed and services are running.

1. Check ORS application exists
2. Verify ORS_SERVICE and ROUTING_GATEWAY_SERVICE are RUNNING
3. Resume suspended services if needed

**STOP** if ORS is not installed. Direct user to `build-routing-solution` skill.

> See `references/sql-pipeline.md` Step 2.

### Step 3: Get Carto Overture Datasets from Marketplace

**Goal:** Acquire Overture Maps Places and Addresses datasets for POI and density data.

1. Get Overture Maps Places (POI data)
2. Get Overture Maps Addresses (for H3 density)
3. Verify both datasets are accessible

> See `references/sql-pipeline.md` Step 3.

### Step 4: Create Database, Schema, and Warehouse

**Goal:** Set up the demo database, schema, warehouse, and stage.

> See `references/sql-pipeline.md` Step 4.

**Output:** Database `OPENROUTESERVICE_SETUP`, schema `RETAIL_CATCHMENT_DEMO` created with stage.

### Step 5: Create Optimized Data Tables

**Goal:** Create pre-filtered, performance-optimized tables from Overture Maps marketplace data.

1. Set bounding box configuration (customize for target region)
2. Create filtered POI table (`RETAIL_POIS`)
3. Create pre-aggregated cities table (`CITIES_BY_STATE`)
4. Create addresses table (`REGIONAL_ADDRESSES`)
5. Store region configuration (`REGION_CONFIG`)
6. Add search optimization and clustering
7. Verify tables have data

**STOP** if any table has 0 rows. Check bounding box config and Marketplace access.

> See `references/sql-pipeline.md` Step 5.

### Step 6: Upload Streamlit Files

**Goal:** Upload all Streamlit app files to the stage.

> See `references/sql-pipeline.md` Step 6.

**Output:** 5 files uploaded to stage.

### Step 7: Create Streamlit App

**Goal:** Create the Streamlit application in Snowflake.

> See `references/sql-pipeline.md` Step 7.

### Step 8: Verify and Launch

**Goal:** Confirm the app is deployed and accessible.

> See `references/sql-pipeline.md` Step 8.

## Features

The deployed app provides:
- **Isochrone Analysis:** Travel-time based catchment zones (1-60 min)
- **Competitor Mapping:** Find competitors within catchment areas
- **H3 Address Density:** Visualize residential density using hexagonal grid
- **Smart Location Recommendation:** AI-powered optimal new location suggestions
- **Market Analysis:** Synthetic footfall, population density, income data

## Stopping Points

- ✋ Step 2: Verify ORS is installed before proceeding
- ✋ Step 3: Confirm marketplace data is accessible
- ✋ Step 5: Verify optimized tables have data before uploading Streamlit files
- ✋ Step 8: Verify app loads without errors

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

```sql
SELECT CONCAT('https://app.snowflake.com/', CURRENT_ORGANIZATION_NAME(), '/', CURRENT_ACCOUNT_NAME(), '/#/streamlit-apps/OPENROUTESERVICE_SETUP.RETAIL_CATCHMENT_DEMO.RETAIL_CATCHMENT_APP') AS streamlit_url;
```
