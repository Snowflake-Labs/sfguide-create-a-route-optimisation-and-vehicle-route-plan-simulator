---
name: fleet-intelligence-taxis
description: "Generate realistic taxi driver location data for the Fleet Intelligence solution using Overture Maps data and OpenRouteService for actual road routes. Configurable location (New York, London, San Francisco, etc.), number of drivers (default 80), days of simulation (default 1), and shift patterns. Use when: setting up driver location data, generating route-based simulation, deploying fleet dashboard. Do NOT use for: food delivery simulation (use fleet-intelligence-food-delivery), route deviation analysis (use route-deviation), or route optimization demos. Triggers: generate driver locations, create driver data, setup fleet data, deploy streamlit, fleet intelligence dashboard."
depends_on:
  - build-routing-solution
  - routing-customization
metadata:
  author: Snowflake SIT-IS
  version: 1.0.0
  category: fleet-intelligence
---

# Generate Driver Locations & Deploy Fleet Intelligence Dashboard

Generates realistic taxi driver location data using Overture Maps Places/Addresses, OpenRouteService Native App routing, route interpolation, and configurable location/fleet size.

---

## IMPORTANT: Location Must Match OpenRouteService Configuration

> **Before selecting a location, verify your OpenRouteService Native App is configured for that region.**
> Read and follow `.cortex/skills/routing-customization/SKILL.md` if a map change is needed.

---

## Configuration Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `LOCATION` | New York | City/region for the simulation |
| `NUM_DRIVERS` | 80 | Total number of taxi drivers |
| `NUM_DAYS` | 1 | Number of days to simulate |
| `START_DATE` | 2015-06-24 | First day of simulation |
| `WAREHOUSE_SIZE` | MEDIUM | Warehouse size for data generation |

---

## Supported Locations (Pre-configured)

| Location | MIN_LON | MAX_LON | MIN_LAT | MAX_LAT | Center LON | Center LAT | Notes |
|----------|---------|---------|---------|---------|------------|------------|-------|
| **San Francisco** | -122.52 | -122.35 | 37.70 | 37.82 | -122.42 | 37.77 | |
| **New York** | -74.05 | -73.90 | 40.65 | 40.85 | -73.97 | 40.75 | Manhattan focus |
| **London** | -0.20 | 0.05 | 51.45 | 51.55 | -0.12 | 51.51 | Central London |
| **Paris** | 2.25 | 2.42 | 48.82 | 48.90 | 2.35 | 48.86 | Central Paris |
| **Chicago** | -87.75 | -87.55 | 41.80 | 41.95 | -87.63 | 41.88 | Downtown |
| **Los Angeles** | -118.35 | -118.15 | 33.95 | 34.15 | -118.25 | 34.05 | Central LA |
| **Seattle** | -122.45 | -122.25 | 47.55 | 47.70 | -122.33 | 47.61 | Downtown |
| **Boston** | -71.15 | -70.95 | 42.30 | 42.40 | -71.06 | 42.36 | Central Boston |
| **Sydney** | 151.15 | 151.30 | -33.92 | -33.82 | 151.21 | -33.87 | CBD area |
| **Singapore** | 103.75 | 103.95 | 1.25 | 1.40 | 103.85 | 1.35 | Central |

---

## Customizing Streamlit App for Your Location

Update `CITY = get_city("New York")` in each Streamlit file to your target city name (must match a key in `city_config.py`).

| File | What to Change |
|------|----------------|
| `Taxi_Control_Center.py` | `get_city("New York")` -> `get_city("Your City")` |
| `pages/1_Driver_Routes.py` | `get_city("New York")` -> `get_city("Your City")` |
| `pages/2_Heat_Map.py` | `get_city("New York")` -> `get_city("Your City")` |

To add a new city, add an entry to the `CITIES` dictionary in `city_config.py` with `name`, `latitude`, `longitude`, and `zoom`.

---

## Recommended Warehouse Sizes

| Drivers | Days | Estimated Rows | Warehouse | Est. Time |
|---------|------|----------------|-----------|-----------|
| 20 | 1 | ~4,000 | SMALL | 2-3 min |
| 80 | 1 | ~18,000 | MEDIUM | 5-8 min |
| 80 | 7 | ~125,000 | LARGE | 20-30 min |
| 200 | 1 | ~45,000 | LARGE | 15-20 min |
| 200 | 7 | ~315,000 | XLARGE | 45-60 min |
| 500 | 7 | ~800,000 | XLARGE | 2-3 hours |

---

## Prerequisites

1. **Snowflake Account** with appropriate privileges
2. **OpenRouteService Native App** installed from Snowflake Marketplace (configured for target region)
3. **Overture Maps Data** -- auto-installed in Step 3b if missing. Requires IMPORT SHARE privilege.

## Required Privileges

| Privilege | Scope | Reason |
|-----------|-------|--------|
| CREATE DATABASE | Account | Creates FLEET_INTELLIGENCE database |
| CREATE WAREHOUSE | Account | Creates ROUTING_ANALYTICS warehouse |
| CREATE SCHEMA | Database (FLEET_INTELLIGENCE) | Creates FLEET_INTELLIGENCE_TAXIS schema |
| CREATE TABLE | Schema | Creates location, driver, trip, and route tables |
| CREATE VIEW | Schema | Creates 5 analytics views |
| CREATE STAGE | Schema | Creates STREAMLIT_STAGE for app deployment |
| CREATE STREAMLIT | Schema | Deploys TAXI_CONTROL_CENTER |
| USAGE ON APPLICATION OPENROUTESERVICE_NATIVE_APP | Application | Calls DIRECTIONS function for routing |
| IMPORTED PRIVILEGES ON OVERTURE_MAPS__PLACES | Database | Reads POI locations |
| IMPORTED PRIVILEGES ON OVERTURE_MAPS__ADDRESSES | Database | Reads address data |

> **Note:** ACCOUNTADMIN is NOT required. Create a custom role with the above privileges.

---

## Error Logging

When any step fails or produces unexpected results (SQL errors, missing objects, wrong row counts, service failures, deployment issues), log the issue to `logs/` following the format in `logs/README.md`. Create one log file per execution: `fleet-intelligence-taxis_{YYYY-MM-DD}_{HH-MM}.md`. Continue execution where possible, logging all issues encountered. If execution completes with no issues, do not create a log file.

## Workflow

Execute each step in order using `snowflake_sql_execute`. Substitute `{PLACEHOLDER}` values based on the user's chosen configuration before executing.

> **Read `references/sql-pipeline.md` for complete SQL for every step below.**

### CRITICAL: Execution Rules

> 1. **One statement per `snowflake_sql_execute` call.** Multi-statement blocks can silently fail.
> 2. **Always use fully qualified object names** (`FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.<object>`). Session context from `USE` statements does not persist across calls.
> 3. **Never use `SET` session variables.** Substitute literal values directly into SQL.
> 4. **Verify row counts after each CTAS.**

### Step 1: Set Query Tag

Set session query tag for attribution tracking.

### Step 2: Detect ORS Configuration, Choose Location, Verify Services

1. **Describe** ORS service to extract configured `<REGION_NAME>` from volume source path.
2. **Download** ORS config and parse enabled routing profiles. Follow `.cortex/skills/routing-customization/read-ors-configuration/SKILL.md`.
3. **Ask user** which location to use — recommend the currently configured region first.
4. **Check region match** — if mismatch, user must reconfigure ORS via `.cortex/skills/routing-customization/SKILL.md`.
5. **Check/resume services** — run `SHOW SERVICES IN OPENROUTESERVICE_NATIVE_APP.CORE` and resume any suspended services.
6. **Test ORS routing** with a DIRECTIONS call using center coordinates of the target city.

### Step 3: Configure Database, Warehouse, and Schema

Create `FLEET_INTELLIGENCE` database, `ROUTING_ANALYTICS` warehouse, `FLEET_INTELLIGENCE_TAXIS` schema, and `STREAMLIT_STAGE` stage.

### Step 3b: Check & Install Overture Maps Datasets

Check if Overture Maps datasets are accessible:

1. Run `SELECT COUNT(*) FROM OVERTURE_MAPS__PLACES.CARTO.PLACE LIMIT 1`
2. Run `SELECT COUNT(*) FROM OVERTURE_MAPS__ADDRESSES.CARTO.ADDRESS LIMIT 1`

If either fails, install from Marketplace. See `references/sql-pipeline.md` Step 3b.

**STOP** if install fails -- requires IMPORT SHARE privilege.

### Step 4: Create Base Locations (`TAXI_LOCATIONS`)

CTAS combining POIs from `OVERTURE_MAPS__PLACES.CARTO.PLACE` and addresses from `OVERTURE_MAPS__ADDRESSES.CARTO.ADDRESS` filtered by the bounding box. Verify counts by `SOURCE_TYPE`.

### Step 5: Create Drivers with Shift Patterns (`TAXI_DRIVERS`)

CTAS with 5 shift patterns (Graveyard, Early, Morning, Day, Evening). Default 80 drivers: 8/18/22/18/14. Verify driver counts per shift.

### Step 6: Generate Trips

1. **Materialize** `TAXI_LOCATIONS_NUMBERED` with stable row numbers.
2. **Create** `DRIVER_TRIPS` — trip assignments with hour/pickup/dropoff location IDs. Trip counts vary by shift.
3. **Create** `DRIVER_TRIPS_WITH_COORDS` — join trips with coordinate geometry.
4. **Verify** trip distribution per shift.

### Step 7: Generate ORS Routes

**WARNING:** This step makes many ORS API calls. ~1,000 trips: 3-5 min, ~5,000: 15-20 min.

1. **Create** `DRIVER_ROUTES` — call `OPENROUTESERVICE_NATIVE_APP.CORE.DIRECTIONS` for each trip.
2. **Create** `DRIVER_ROUTES_PARSED` — extract geometry, distance, duration from JSON response.
3. **Create** `DRIVER_ROUTE_GEOMETRIES` — add cumulative timing with `{START_DATE}`.
4. **Verify** route statistics.

### Step 8: Create Driver Locations (`DRIVER_LOCATIONS`)

Interpolate 15 points per trip along route geometry with driver states (`waiting`, `pickup`, `driving`, `dropoff`, `idle`) and realistic speeds varying by time of day (rush hour, overnight, normal). Verify point counts and speed distributions.

### Step 9: Create Analytics Views

Create 5 views for Streamlit consumption:
- `DRIVER_LOCATIONS_V` — locations with LAT/LON
- `TRIPS_ASSIGNED_TO_DRIVERS` — trip assignments with geometry
- `ROUTE_NAMES` — origin→destination labels
- `TRIP_ROUTE_PLAN` — full trip details with ROUTE JSON
- `TRIP_SUMMARY` — route geometries with avg/max speed

Verify all view row counts.

### Step 10: Deploy Streamlit App

1. **Upload** Streamlit files to `@STREAMLIT_STAGE/taxi/` via PUT commands (main app, CSS, logo, env, city config, pages).
2. **Verify** upload with `LIST @STREAMLIT_STAGE/taxi/`.
3. **Create** Streamlit app `TAXI_CONTROL_CENTER` pointing to the stage.
4. **Set live version** with `ALTER STREAMLIT ... ADD LIVE VERSION FROM LAST`.
5. **Provide** the generated Snowsight URL to the user.

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| ORS routes returning NULL | Location outside ORS configured region — verify map data |
| ORS routes failing | Verify OpenRouteService Native App is installed and running |
| No locations found | Bounding box may be too restrictive or outside Overture coverage |
| Out of memory | Use larger warehouse or batch processing |
| Missing Overture data | Install shares from Snowflake Marketplace |
| Streamlit not loading | Check all files uploaded to stage via `LIST @STREAMLIT_STAGE/taxi/` |
| Map centered wrong | Update view_state coordinates in Streamlit files |
| PUT command fails | Ensure the file path is absolute and the file exists locally |

## Cleanup

To remove all objects created by this skill:

```sql
-- Reverse dependency order: streamlit first, then views, tables, stage, schema
DROP STREAMLIT IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TAXI_CONTROL_CENTER;
DROP VIEW IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TRIP_SUMMARY;
DROP VIEW IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TRIP_ROUTE_PLAN;
DROP VIEW IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.ROUTE_NAMES;
DROP VIEW IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TRIPS_ASSIGNED_TO_DRIVERS;
DROP VIEW IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_LOCATIONS_V;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_LOCATIONS;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_ROUTE_GEOMETRIES;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_ROUTES_PARSED;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_ROUTES;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_TRIPS_WITH_COORDS;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_TRIPS;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TAXI_LOCATIONS_NUMBERED;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TAXI_DRIVERS;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TAXI_LOCATIONS;
DROP STAGE IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.STREAMLIT_STAGE;
DROP SCHEMA IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS;
```

> **Tip:** Use the `cleanup` skill to auto-discover all tagged objects via COMMENT tracking.
