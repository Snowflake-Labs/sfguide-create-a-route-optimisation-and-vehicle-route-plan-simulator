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

| Parameter | Default | Description |
|-----------|---------|-------------|
| `DATABASE` | `FLEET_INTELLIGENCE` | Target database for all objects |
| `SCHEMA` | `RETAIL_CATCHMENT` | Schema for retail analysis tables |
| `WAREHOUSE` | `ROUTING_ANALYTICS` | Warehouse for queries and data loading |

## Prerequisites

- OpenRouteService App installed (e.g., `OPENROUTESERVICE_APP`)
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
| CREATE TABLE | Schema (FLEET_INTELLIGENCE.RETAIL_CATCHMENT) | Creates CONFIG, RETAIL_POIS, CITIES_BY_STATE, REGIONAL_ADDRESSES, REGION_CONFIG |
| USAGE ON DATABASE OVERTURE_MAPS__PLACES | Database | Reads Marketplace POI data |
| USAGE ON DATABASE OVERTURE_MAPS__ADDRESSES | Database | Reads Marketplace address data |
| USAGE ON DATABASE OPENROUTESERVICE_APP | Database | Calls ORS isochrone functions |

> **Note:** ACCOUNTADMIN is NOT required. Create a custom role with the above privileges, or use any role that has them.

## Error Logging

> Follow the Error Logging convention in AGENTS.md. Log file prefix: `retail-catchment`.

## Execution Rules

1. One statement per `snowflake_sql_execute` tool call.
2. Always use fully qualified object names.
3. Never use `SET` session variables.
4. Verify row counts after each CTAS.
5. All CREATE statements must include a COMMENT tracking tag.

## Workflow

> **Quick deploy:** Run [references/seed-data.sql](references/seed-data.sql) via `snow sql -f` to execute Steps 4-5 in one shot. Edit the SET variables at the top to customize for your region. **Expected duration: 3-5 minutes** (queries large Overture Maps datasets).
>
> Full SQL with step-by-step explanations: [references/sql-pipeline.md](references/sql-pipeline.md)
> All CREATE statements in the referenced SQL include COMMENT tracking tags per AGENTS.md convention (`"origin":"sf_sit-is-fleet","name":"oss-retail-catchment"`).

### Step 1: Set Query Tag for Tracking

**Pre-check: If data already exists, skip to Step 6.** Run:
```sql
SELECT COUNT(*) AS cnt FROM FLEET_INTELLIGENCE.RETAIL_CATCHMENT.RETAIL_POIS;
```
If `cnt > 0`, the data pipeline has already run. Skip to Step 6 (Verify) as needed.

**Goal:** Set session query tag for attribution tracking.

Execute:
```sql
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-retail-catchment","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

### Step 2: Verify OpenRouteService Installation

**Goal:** Confirm OpenRouteService Native App is installed and services are running.

Execute:
```sql
SHOW SERVICES IN DATABASE OPENROUTESERVICE_APP;
```

If any services are SUSPENDED, resume them:
```sql
CALL OPENROUTESERVICE_APP.CORE.RESUME_ALL_SERVICES();
```

**STOP** if ORS is not installed. Direct user to `build-routing-solution` skill.

### Step 3: Get Carto Overture Datasets from Marketplace

**Goal:** Acquire Overture Maps Places and Addresses datasets for POI and density data.

Execute:
```sql
CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZT0Z4CM1E9KR');
CREATE DATABASE IF NOT EXISTS OVERTURE_MAPS__PLACES FROM LISTING GZT0Z4CM1E9KR;

CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZT0Z4CM1E9NQ');
CREATE DATABASE IF NOT EXISTS OVERTURE_MAPS__ADDRESSES FROM LISTING GZT0Z4CM1E9NQ;
```

Verify:
```sql
SELECT COUNT(*) FROM OVERTURE_MAPS__PLACES.CARTO.PLACE LIMIT 1;
SELECT COUNT(*) FROM OVERTURE_MAPS__ADDRESSES.CARTO.ADDRESS LIMIT 1;
```

### Step 4: Create Database, Schema, Warehouse, and CONFIG

**Goal:** Set up the demo database, schema, warehouse, and CONFIG table.

> See `references/sql-pipeline.md` Step 4.

**Output:** Database `FLEET_INTELLIGENCE`, schema `RETAIL_CATCHMENT` created with CONFIG table.

### Step 5: Create Optimized Data Tables

**Goal:** Create pre-filtered, performance-optimized tables from Overture Maps marketplace data.

> **Important:** Step 5 uses SQL session variables (`SET REGION_KEY`, `SET BBOX_*`). Execute all Step 5 sub-steps in a single session (e.g., via `snow sql -f`) or prepend the SET statements to each sub-step's SQL block when using `snowflake_sql_execute`.

1. Set region key and bounding box configuration (customize for target region)
2. Create and populate filtered POI table (`RETAIL_POIS`)
3. Create and populate pre-aggregated cities table (`CITIES_BY_STATE`)
4. Create and populate addresses table (`REGIONAL_ADDRESSES`)
5. Store region configuration (`REGION_CONFIG`)
6. Add search optimization and clustering
7. Verify tables have data

**STOP** if any table has 0 rows. Check bounding box config and Marketplace access.

> See `references/sql-pipeline.md` Step 5.


### Step 6: Verify

**Goal:** Confirm data tables exist and have rows.

> See `references/sql-pipeline.md` Step 8.

## Dashboard Schema Contract

The React Demo Dashboard page queries these exact tables and columns. If the pipeline changes column names, the React page must be updated to match.

### CONFIG
| Column | Type | Used By |
|--------|------|---------|
| VEHICLE_TYPE | VARCHAR | Global vehicle type selector |
| REGION | VARCHAR | Global region selector (updated by server on region switch) |

### RETAIL_POIS
| Column | Type | Used By |
|--------|------|---------|
| REGION | VARCHAR | RetailCatchment (region filter) |
| POI_ID | VARCHAR | RetailCatchment (store selection, competitor filter) |
| POI_NAME | VARCHAR | RetailCatchment (store dropdown, metrics) |
| BASIC_CATEGORY | VARCHAR | RetailCatchment (category filter, competitor breakdown) |
| CITY | VARCHAR | RetailCatchment (city filter) |
| GEOMETRY | GEOGRAPHY | RetailCatchment (ST_X/ST_Y for map, ST_WITHIN for competitors) |

### CITIES_BY_STATE
| Column | Type | Used By |
|--------|------|---------|
| REGION | VARCHAR | RetailCatchment (region filter) |
| CITY | VARCHAR | RetailCatchment (city dropdown) |

### REGIONAL_ADDRESSES
| Column | Type | Used By |
|--------|------|---------|
| REGION | VARCHAR | RetailCatchment (region filter) |
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
- Tables: `CONFIG`, `RETAIL_POIS`, `CITIES_BY_STATE`, `REGIONAL_ADDRESSES`, `REGION_CONFIG`

## Cleanup

To remove all objects created by this skill:

```sql
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.RETAIL_CATCHMENT.CONFIG;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.RETAIL_CATCHMENT.REGION_CONFIG;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.RETAIL_CATCHMENT.REGIONAL_ADDRESSES;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.RETAIL_CATCHMENT.CITIES_BY_STATE;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.RETAIL_CATCHMENT.RETAIL_POIS;
DROP SCHEMA IF EXISTS FLEET_INTELLIGENCE.RETAIL_CATCHMENT;
```

> **Tip:** Use the `cleanup` skill to auto-discover all tagged objects via COMMENT tracking.
