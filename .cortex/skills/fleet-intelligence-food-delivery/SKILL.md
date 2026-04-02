---
name: fleet-intelligence-food-delivery
description: "Generate realistic food delivery courier location data for the SwiftBite Fleet Intelligence solution using Overture Maps data and OpenRouteService for actual road routes. California statewide coverage with city-level filtering. Configurable location, number of couriers (default 50), days of simulation (default 1), and shift patterns. Includes deploying the Fleet Intelligence React native app to SPCS (Docker build, push, app package, install). Use when: setting up food delivery data, generating route-based simulation, deploying fleet dashboard, installing native app. Do NOT use for: taxi fleet simulation (use fleet-intelligence-taxis), route deviation analysis, or route optimization demos. Triggers: generate courier locations, create delivery data, setup food delivery fleet, deploy streamlit, deploy native app, install fleet intelligence, swiftbite dashboard, food delivery intelligence."
depends_on:
  - build-routing-solution
  - routing-customization
metadata:
  author: Snowflake SIT-IS
  version: 1.0.0
  category: fleet-intelligence
---

# Generate Food Delivery Courier Locations & Deploy SwiftBite California Fleet Intelligence Dashboard

Generates realistic food delivery courier location data for the SwiftBite Fleet Intelligence solution using:
- **Overture Maps Places** - Restaurant locations (food_and_beverage category) -- California statewide
- **Overture Maps Addresses** - Customer delivery addresses -- 14.2M+ California addresses
- **OpenRouteService Native App** - Real road routing with California statewide graph (4.1M nodes, 5.2M edges)
- **Route Interpolation** - Courier positions along actual roads
- **City-level Filtering** - San Francisco, Los Angeles, San Diego, San Jose, Sacramento, and more
- **Configurable Fleet Size** - Set number of couriers and simulation days
- **Pre-computed Travel Time Matrix** - 1.1M+ H3 hex-pair travel times for instant ETA lookups

---

## IMPORTANT: Location Must Match OpenRouteService Configuration

> **Before selecting a location, verify your OpenRouteService Native App is configured for that region.**
>
> The OpenRouteService app uses map data (OSM PBF files) for a specific geographic area. If you select a location that is **outside** the area configured in your ORS app, this requires changing a map. 
> Read and follow the instructions in `.cortex/skills/routing-customization/SKILL.md`

---

## Configuration Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `LOCATION` | San Francisco | California city for the simulation |
| `NUM_COURIERS` | 50 | Total number of delivery couriers |
| `NUM_DAYS` | 1 | Number of days to simulate |
| `START_DATE` | 2025-01-15 | First day of simulation |
| `WAREHOUSE_SIZE` | MEDIUM | Warehouse size for data generation |

---

## Supported Locations (California Cities)

> **Data Scope:** Overture Maps data is loaded for **all of California** (COUNTRY='US', region='CA'). The city selector in the Streamlit app filters the statewide dataset to the selected city.

| Location | Center LON | Center LAT | Zoom | Notes |
|----------|------------|------------|------|-------|
| **San Francisco** | -122.44 | 37.76 | 12 | Default |
| **Los Angeles** | -118.24 | 34.05 | 11 | Largest CA city |
| **San Diego** | -117.16 | 32.72 | 12 | |
| **San Jose** | -121.89 | 37.34 | 12 | |
| **Sacramento** | -121.49 | 38.58 | 12 | State capital |
| **Fresno** | -119.77 | 36.74 | 12 | Central Valley |
| **Oakland** | -122.27 | 37.80 | 12 | East Bay |
| **Long Beach** | -118.19 | 33.77 | 12 | LA metro |
| **Santa Barbara** | -119.70 | 34.42 | 13 | |
| **Bakersfield** | -119.02 | 35.37 | 12 | Central Valley |

---

## City Selection in the Streamlit App

The Streamlit app includes a **sidebar city selector** on every page. Users select a California city from a dropdown, and the app dynamically re-centers maps, filters data, and updates headers.

All California cities are defined in `city_config.py` with `CALIFORNIA_CITIES` list and `get_california_cities()` helper.

### Adding a New California City

Add to both `CITIES` dict and `CALIFORNIA_CITIES` list in `city_config.py`:

```python
"Riverside": {
    "name": "Riverside",
    "latitude": 33.95,
    "longitude": -117.40,
    "zoom": 12,
},
```

Then add `"Riverside"` to the `CALIFORNIA_CITIES` list.

---

## Recommended Warehouse Sizes

| Couriers | Days | Estimated Rows | Warehouse | Est. Time |
|----------|------|----------------|-----------|-----------|
| 20 | 1 | ~3,000 | SMALL | 2-3 min |
| 50 | 1 | ~8,000 | MEDIUM | 4-6 min |
| 50 | 7 | ~55,000 | LARGE | 15-20 min |
| 100 | 1 | ~16,000 | LARGE | 10-15 min |
| 100 | 7 | ~110,000 | XLARGE | 30-45 min |

---

## Prerequisites

1. **Snowflake Account** with appropriate privileges
2. **OpenRouteService Native App** installed from Snowflake Marketplace
   - Must be configured for your target location's region
3. **Overture Maps Data** -- auto-installed in Step 3b if missing. Requires IMPORT SHARE privilege.

## Required Privileges

| Privilege | Scope | Reason |
|-----------|-------|--------|
| CREATE DATABASE | Account | Creates FLEET_INTELLIGENCE database |
| CREATE WAREHOUSE | Account | Creates ROUTING_ANALYTICS warehouse |
| CREATE SCHEMA | Database (FLEET_INTELLIGENCE) | Creates FLEET_INTELLIGENCE_FOOD_DELIVERY schema |
| CREATE TABLE | Schema | Creates restaurant, courier, order, and route tables |
| CREATE VIEW | Schema | Creates 5 analytics views |
| CREATE STAGE | Schema | Creates STREAMLIT_STAGE for app deployment |
| CREATE STREAMLIT | Schema | Deploys SWIFTBITE_DELIVERY_DASHBOARD |
| USAGE ON APPLICATION OPENROUTESERVICE_NATIVE_APP | Application | Calls DIRECTIONS function for routing |
| IMPORTED PRIVILEGES ON OVERTURE_MAPS__PLACES | Database | Reads restaurant locations |
| IMPORTED PRIVILEGES ON OVERTURE_MAPS__ADDRESSES | Database | Reads customer delivery addresses |

> **Note:** ACCOUNTADMIN is NOT required. Create a custom role with the above privileges.

---

## Error Logging

When any step fails or produces unexpected results (SQL errors, missing objects, wrong row counts, service failures, deployment issues), log the issue to `logs/` following the format in `logs/README.md`. Create one log file per execution: `fleet-intelligence-food-delivery_{YYYY-MM-DD}_{HH-MM}.md`. Continue execution where possible, logging all issues encountered. If execution completes with no issues, do not create a log file.

## Step 0: Load San Francisco Baseline (Recommended)

The fastest path to a working demo. Loads pre-computed San Francisco data from S3 in ~2 minutes. No ORS calls needed.

### Quick check

```sql
SELECT COUNT(*) FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.COURIER_LOCATIONS;
```

If the table exists and has rows, data is already loaded. Skip to Step 10 (Register with Demo Dashboard).

### Load from S3

Execute `references/seed-data.sql`. This creates all tables and loads San Francisco baseline data from `s3://fleet-intelligence/SanFrancisco/fleet-intelligence-food-delivery/`.

### Generate data for other regions (optional)

To generate data for a region other than San Francisco, use the full pipeline starting at Step 2.

Or use the centralized provisioner:
```sql
CALL FLEET_INTELLIGENCE.CORE.PROVISION_REGION('<RegionName>', ARRAY_CONSTRUCT('fleet-intelligence-food-delivery'));
```

## Workflow

Execute each step in order using `snowflake_sql_execute`. Substitute `{PLACEHOLDER}` values based on the user's chosen configuration before executing.

### CRITICAL: Execution Rules

> **These rules MUST be followed to avoid silent failures:**
>
> 1. **One statement per `snowflake_sql_execute` call.** Never combine multiple SQL statements (CREATE, INSERT, SET, USE) in a single call. Multi-statement blocks can silently fail -- tables may be created with 0 rows and no error is reported.
>
> 2. **Always use fully qualified object names.** Use `FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.<object>` instead of relying on `USE DATABASE` / `USE SCHEMA`. Session context from `USE` statements does not persist across `snowflake_sql_execute` calls.
>
> 3. **Never use `SET` session variables.** Variables set with `SET VAR = 'value'` do not persist across calls. Instead, substitute literal values directly into the SQL before execution.
>
> 4. **Verify row counts after each CTAS.** Run `SELECT COUNT(*) FROM <table>` after every `CREATE TABLE ... AS SELECT` to catch silent failures early.

### Step 1: Set Query Tag for Tracking

**Pre-check: If data already exists, skip to Step 10.** Run:
```sql
SELECT COUNT(*) AS cnt FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.COURIER_LOCATIONS;
```
If `cnt > 0`, the data pipeline has already run. Skip to Step 10 (analytics views) or Step 11 (Streamlit deployment) as needed.

```sql
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-a-fleet-intelligence-solution-for-food-delivery","version":{"major":1, "minor":0},"attributes":{"is_quickstart":1, "source":"sql"}}';
```

### Step 2: Detect ORS Configuration, Choose Location, and Verify Services

Read and follow the instructions in `.cortex/skills/routing-customization/read-ors-configuration/SKILL.md` to detect the current region and enabled routing profiles. Then:

1. Display current ORS configuration to the user
2. Ask user to choose location (recommend the currently configured region first)
3. If region mismatch, follow `.cortex/skills/routing-customization/SKILL.md` to change map
4. Check service status and resume if suspended:
   ```sql
   SHOW SERVICES IN APPLICATION OPENROUTESERVICE_NATIVE_APP;
   CALL OPENROUTESERVICE_NATIVE_APP.CORE.RESUME_ALL_SERVICES();
   SELECT OPENROUTESERVICE_NATIVE_APP.CORE.CHECK_HEALTH();
   ```
5. Test ORS routing with coordinates in the target city

### Step 3: Configure Database, Warehouse, and Schema

Create `FLEET_INTELLIGENCE` database, `ROUTING_ANALYTICS` warehouse, `FLEET_INTELLIGENCE_FOOD_DELIVERY` schema, and `STREAMLIT_STAGE` stage.

### Step 3b: Check & Install Overture Maps Datasets

Check if Overture Maps datasets are accessible:

1. Run `SELECT COUNT(*) FROM OVERTURE_MAPS__PLACES.CARTO.PLACE LIMIT 1`
2. Run `SELECT COUNT(*) FROM OVERTURE_MAPS__ADDRESSES.CARTO.ADDRESS LIMIT 1`

If either fails, install from Marketplace. See `references/sql-pipeline.md` Step 3b.

**STOP** if install fails -- requires IMPORT SHARE privilege.

### Steps 4-9: Data Generation Pipeline

**Read `references/sql-pipeline.md` for complete SQL.**

| Step | Action | Output |
|------|--------|--------|
| 4 | Create Restaurant Locations (California-wide) | `RESTAURANTS` table (120K+ rows) |
| 5 | Create Customer Delivery Addresses | `CUSTOMER_ADDRESSES` table (14.2M+ rows) |
| 6 | Create Couriers with Shift Patterns | `COURIERS` table |
| 7 | Generate Delivery Orders | `DELIVERY_ORDERS` + `ORDERS_WITH_LOCATIONS` tables |
| 8 | Generate ORS Routes | `DELIVERY_ROUTES` + `DELIVERY_ROUTES_PARSED` + `DELIVERY_ROUTE_GEOMETRIES` tables |
| 9 | Create Courier Locations | `COURIER_LOCATIONS` table with interpolated positions |

### Steps 10-11: Analytics Views & Streamlit Deployment

**Read `references/streamlit-deployment.md` for complete SQL and deployment commands.**

- Step 10: Create 5 analytics views (COURIER_LOCATIONS_V, ORDERS_ASSIGNED_TO_COURIERS, DELIVERY_NAMES, DELIVERY_ROUTE_PLAN, DELIVERY_SUMMARY)
- Step 11: Upload Streamlit files to stage and deploy the application

### Step 12: Deploy Fleet Intelligence React Native App (Optional)

**Read `references/native-app-deployment.md` for Docker build, push, and SPCS deployment.**

**DEPRECATED:** Step 12 is no longer needed. Both `FLEET_INTEL_APP` and `DEMO_DASHBOARD_APP` have been removed. All demo pages are now built into `ORS_CONTROL_APP` (in `OPENROUTESERVICE_NATIVE_APP`). See `.cortex/skills/build-routing-solution/` for deployment instructions.

> **Note:** The Fleet Intelligence app delegates all routing calls to the standalone `OPENROUTESERVICE_NATIVE_APP` via SQL wrapper functions. No ORS/vroom/gateway/downloader images need to be built — only the `fleet-intelligence` image.

---

## California Statewide Routing Graph

**Read `references/travel-time-integration.md` for complete instructions on:**
- Building the California statewide ORS routing graph (~45-75 min end-to-end)
- Matrix scaling performance benchmarks
- Search optimization for large tables
- Pre-computed travel time matrix for realistic ETAs
- ETA prediction function and live delivery tracking

---

### Step 13: Register with Demo Dashboard

> **DEPRECATED:** `DEMO_DASHBOARD_APP` has been removed. All demo pages are now built into `ORS_CONTROL_APP` (in `OPENROUTESERVICE_NATIVE_APP`). No registration step is needed — Fleet Delivery pages are available automatically in the ORS sidebar.

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| ORS routes returning NULL | Location outside ORS configured region -- verify map data |
| ORS routes failing | Verify OpenRouteService Native App is installed and running |
| No restaurants found | Bounding box may be too restrictive; try expanding coordinates |
| No addresses found | Verify Overture Maps Addresses share is installed |
| Out of memory | Use larger warehouse or reduce NUM_COURIERS |
| Streamlit not loading | Check all files uploaded to stage via `LIST @STREAMLIT_STAGE/swiftbite/` |
| PUT command fails | Ensure the file path is absolute and the file exists locally |
| Bicycle routes failing | ORS may not have cycling profile enabled; check OpenRouteService Native App configuration |

For Docker/SPCS/Native App troubleshooting, see `references/native-app-deployment.md`.

## Cleanup

To remove all objects created by this skill:

```sql
-- Reverse dependency order: views, tables, stages, schemas
-- NOTE: Both FLEET_INTEL_APP and DEMO_DASHBOARD_APP are deprecated; use ORS_CONTROL_APP in OPENROUTESERVICE_NATIVE_APP instead
DROP STREAMLIT IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.SWIFTBITE_DELIVERY_DASHBOARD;
DROP VIEW IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_SUMMARY;
DROP VIEW IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ROUTE_PLAN;
DROP VIEW IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_NAMES;
DROP VIEW IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.ORDERS_ASSIGNED_TO_COURIERS;
DROP VIEW IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.COURIER_LOCATIONS_V;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.COURIER_LOCATIONS;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ROUTE_GEOMETRIES;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ROUTES_PARSED;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ROUTES;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.ORDERS_WITH_LOCATIONS;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ORDERS;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.ADDRESSES_NUMBERED;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.RESTAURANTS_NUMBERED;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.COURIERS;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.CUSTOMER_ADDRESSES;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.RESTAURANTS;
DROP STAGE IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.STREAMLIT_STAGE;
DROP SCHEMA IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY;
```

> **Tip:** Use the `cleanup` skill to auto-discover all tagged objects via COMMENT tracking.
