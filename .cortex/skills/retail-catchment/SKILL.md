---
name: retail-catchment
description: "Deploy the Retail Catchment Analysis demo with Overture Maps data. Use when: setting up retail catchment demo, deploying catchment analysis, creating retail location analysis app, retail isochrone analysis, competitor mapping demo. Do NOT use for: fleet intelligence demos (use fleet-intelligence-taxis or fleet-intelligence-food-delivery), route optimization (use route-optimization), route deviation analysis (use route-deviation), or dwell analysis (use dwell-analysis). Triggers: retail demo catchment, deploy retail catchment demo, retail isochrone analysis, competitor mapping demo, retail location analysis, trade area analysis."
depends_on:
  - build-routing-solution
metadata:
  author: Snowflake SIT-IS
  version: 1.0.0
  category: retail-analytics
---

# Deploy Retail Catchment Demo

Deploy the Retail Catchment Analysis demo that visualizes trade areas, competitors, and address density using OpenRouteService isochrones and Overture Maps data. Dashboard pages are served via the shared React Demo Dashboard app.

## Configuration

- **Database:** `FLEET_INTELLIGENCE`
- **Schema:** `RETAIL_CATCHMENT`
- **Warehouse:** `ROUTING_ANALYTICS`

## Prerequisites

- OpenRouteService Native App installed (e.g., `OPENROUTESERVICE_NATIVE_APP`)
- A role with privileges listed in the Required Privileges section below
- snow CLI installed and configured

## Required Privileges

| Privilege | Scope | Reason |
|-----------|-------|--------|
| CREATE DATABASE | Account | Creates FLEET_INTELLIGENCE database |
| CREATE WAREHOUSE | Account | Creates ROUTING_ANALYTICS warehouse |
| IMPORT SHARE | Account | Acquires OVERTURE_MAPS__PLACES and OVERTURE_MAPS__ADDRESSES from Marketplace |
| USAGE ON DATABASE FLEET_INTELLIGENCE | Database | Uses the setup database |
| CREATE SCHEMA | Database (FLEET_INTELLIGENCE) | Creates RETAIL_CATCHMENT schema |
| CREATE TABLE | Schema (FLEET_INTELLIGENCE.RETAIL_CATCHMENT) | Creates RETAIL_POIS, CITIES_BY_STATE, REGIONAL_ADDRESSES, REGION_CONFIG |
| USAGE ON DATABASE OVERTURE_MAPS__PLACES | Database | Reads Marketplace POI data |
| USAGE ON DATABASE OVERTURE_MAPS__ADDRESSES | Database | Reads Marketplace address data |
| USAGE ON DATABASE OPENROUTESERVICE_NATIVE_APP | Database | Calls ORS isochrone functions |

> **Note:** ACCOUNTADMIN is NOT required. Create a custom role with the above privileges, or use any role that has them.

## Error Logging

When any step fails or produces unexpected results (SQL errors, missing objects, wrong row counts, service failures, deployment issues), log the issue to `logs/` following the format in `logs/README.md`. Create one log file per execution: `retail-catchment_{YYYY-MM-DD}_{HH-MM}.md`. Continue execution where possible, logging all issues encountered. If execution completes with no issues, do not create a log file.

## Step 0: Load San Francisco Baseline (Recommended)

The fastest path to a working demo. Loads pre-computed San Francisco data from S3 in ~2 minutes. No ORS calls needed.

### Quick check

```sql
SELECT COUNT(*) FROM FLEET_INTELLIGENCE.RETAIL_CATCHMENT.RETAIL_POIS;
```

If the table exists and has rows, data is already loaded. Skip to the Register with Demo Dashboard step.

### Load from S3

Execute `references/seed-data.sql`. This creates all tables and loads San Francisco baseline data from `s3://fleet-intelligence/SanFrancisco/retail-catchment/`.

### Generate data for other regions (optional)

To generate data for a region other than San Francisco, use the full pipeline starting at Step 2.

Or use the centralized provisioner:
```sql
CALL FLEET_INTELLIGENCE.CORE.PROVISION_REGION('<RegionName>', ARRAY_CONSTRUCT('retail-catchment'));
```

## Workflow

> Full SQL for all steps: [references/sql-pipeline.md](references/sql-pipeline.md)

### Step 1: Set Query Tag for Tracking

**Pre-check: If data already exists, skip to Step 6.** Run:
```sql
SELECT COUNT(*) AS cnt FROM FLEET_INTELLIGENCE.RETAIL_CATCHMENT.COMPETITOR_ISOCHRONES;
```
If `cnt > 0`, the data pipeline has already run. Skip to Step 6 (Streamlit deployment) as needed.

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

**Output:** Database `FLEET_INTELLIGENCE`, schema `RETAIL_CATCHMENT` created with stage.

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

### Step 6: Register with Demo Dashboard

If the shared Demo Dashboard app is installed, register this demo:

```sql
CALL DEMO_DASHBOARD_APP.CORE.REGISTER_DEMO('retail-catch', 'Retail Catchment', 'POI analysis with Overture Maps', 'Retail Catchment', 'Store', 160, 'FLEET_INTELLIGENCE', 'RETAIL_CATCHMENT');
```

Skip if DEMO_DASHBOARD_APP is not installed.

### Step 7: Verify

**Goal:** Confirm data tables exist and have rows.

> See `references/sql-pipeline.md` Step 8.

## Dashboard Schema Contract

The React Demo Dashboard page queries these exact tables and columns. If the pipeline changes column names, the React page must be updated to match.

### RETAIL_POIS
| Column | Type | Used By |
|--------|------|---------|
| POI_ID | VARCHAR | RetailCatchment (store selection, competitor filter) |
| POI_NAME | VARCHAR | RetailCatchment (store dropdown, metrics) |
| BASIC_CATEGORY | VARCHAR | RetailCatchment (category filter, competitor breakdown) |
| CITY | VARCHAR | RetailCatchment (city filter) |
| GEOMETRY | GEOGRAPHY | RetailCatchment (ST_X/ST_Y for map, ST_WITHIN for competitors) |

### CITIES_BY_STATE
| Column | Type | Used By |
|--------|------|---------|
| CITY | VARCHAR | RetailCatchment (city dropdown) |

### REGIONAL_ADDRESSES
| Column | Type | Used By |
|--------|------|---------|
| GEOMETRY | GEOGRAPHY | RetailCatchment (H3 density, ST_WITHIN catchment filter) |

---

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
- ✋ Step 5: Verify optimized tables have data before registering

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "No stores found" | Verify Overture Maps Places dataset is accessible |
| Isochrone fails | Check ORS services are RUNNING |
| Dashboard shows no data | Verify RETAIL_POIS table has rows; check column BASIC_CATEGORY, CITY exist |
| RETAIL_POIS table empty | Check bounding box config and Overture Maps Places access |
| REGIONAL_ADDRESSES table empty | Check bounding box config and Overture Maps Addresses access |
| "Object does not exist" on table | Ensure Step 5 completed successfully before Step 6 |

## Output

Deployed resources:
- Database: `FLEET_INTELLIGENCE`
- Schema: `FLEET_INTELLIGENCE.RETAIL_CATCHMENT`
- Warehouse: `ROUTING_ANALYTICS`
- Tables: `RETAIL_POIS`, `CITIES_BY_STATE`, `REGIONAL_ADDRESSES`, `REGION_CONFIG`

## Cleanup

To remove all objects created by this skill:

```sql
-- Reverse dependency order: tables, schema
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.RETAIL_CATCHMENT.REGION_CONFIG;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.RETAIL_CATCHMENT.REGIONAL_ADDRESSES;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.RETAIL_CATCHMENT.CITIES_BY_STATE;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.RETAIL_CATCHMENT.RETAIL_POIS;
DROP SCHEMA IF EXISTS FLEET_INTELLIGENCE.RETAIL_CATCHMENT;
```

> **Tip:** Use the `cleanup` skill to auto-discover all tagged objects via COMMENT tracking.
