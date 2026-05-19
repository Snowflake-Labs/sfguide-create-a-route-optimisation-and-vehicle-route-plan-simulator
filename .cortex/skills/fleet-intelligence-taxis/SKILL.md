---
name: fleet-intelligence-taxis
description: "Generate realistic taxi driver location data for the Fleet Intelligence solution using Overture Maps data and OpenRouteService for actual road routes. Also supports Data Studio projection views from SYNTHETIC_DATASETS.UNIFIED for any vehicle type via CONFIG table. Configurable location (New York, London, San Francisco, etc.), number of drivers (default 80), days of simulation (default 1), and shift patterns. Use when: setting up driver location data, generating route-based simulation, deploying fleet dashboard. Do NOT use for: food delivery simulation (use fleet-intelligence-food-delivery), route deviation analysis (use route-deviation), or route optimization demos. Triggers: generate driver locations, create driver data, setup fleet data, fleet intelligence dashboard."
depends_on:
  - build-routing-solution
  - routing-customization
metadata:
  author: Snowflake SIT-IS
  version: 1.0.0
  category: fleet-intelligence
---

# Generate Driver Locations & Deploy Fleet Intelligence Dashboard

Generates realistic taxi driver location data using Overture Maps Places/Addresses, OpenRouteService Native App routing, route interpolation, and configurable location/fleet size. Also provides Data Studio projection views that read from `SYNTHETIC_DATASETS.UNIFIED` filtered by CONFIG table (vehicle type + region), making it compatible with any synthetic dataset.

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

| USAGE ON DATABASE OPENROUTESERVICE_APP | DATABASE | Calls DIRECTIONS function for routing |
| IMPORTED PRIVILEGES ON OVERTURE_MAPS__PLACES | Database | Reads POI locations |
| IMPORTED PRIVILEGES ON OVERTURE_MAPS__ADDRESSES | Database | Reads address data |

> **Note:** ACCOUNTADMIN is NOT required. Create a custom role with the above privileges.

---

## Error Logging

> Follow the Error Logging convention in AGENTS.md. Log file prefix: `fleet-intelligence-taxis`.

## Quick Start

The fastest path to a working demo. Creates projection views over `SYNTHETIC_DATASETS.UNIFIED` tables (loaded by `build-routing-solution` Step 8). No ORS calls needed.

### Quick check

```sql
SELECT COUNT(*) FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TRIP_SUMMARY;
```

> **Note:** Seed data uses `vehicle_type=ebike` (San Francisco E-Bike Couriers). The CONFIG table is set to `ebike`/`SanFrancisco` accordingly. To see realistic taxi data, generate a new dataset via Data Studio with a taxi/driving-car profile.

### Create views

Execute `references/seed-data.sql`. This creates CONFIG, VW_DRIVER_LOCATIONS, VW_TRIP_SUMMARY, and 5 wrapper views (TRIP_SUMMARY, DRIVER_LOCATIONS_V, ROUTE_NAMES, TRIP_ROUTE_PLAN, TRIPS_ASSIGNED_TO_DRIVERS) over UNIFIED data.

> **CRITICAL:** ALL 7 objects must be created for the React dashboard to display data. The dashboard queries DRIVER_LOCATIONS_V, TRIP_ROUTE_PLAN, TRIPS_ASSIGNED_TO_DRIVERS, and ROUTE_NAMES directly. If any are missing, the Fleet page will appear empty. Execute the ENTIRE `seed-data.sql` — do not skip any views.

**Verification (all must return > 0):**
```sql
SELECT 'CONFIG' AS TBL, COUNT(*) AS CNT FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.CONFIG
UNION ALL SELECT 'VW_DRIVER_LOCATIONS', COUNT(*) FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.VW_DRIVER_LOCATIONS
UNION ALL SELECT 'VW_TRIP_SUMMARY', COUNT(*) FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.VW_TRIP_SUMMARY
UNION ALL SELECT 'DRIVER_LOCATIONS_V', COUNT(*) FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_LOCATIONS_V
UNION ALL SELECT 'TRIP_SUMMARY', COUNT(*) FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TRIP_SUMMARY
UNION ALL SELECT 'ROUTE_NAMES', COUNT(*) FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.ROUTE_NAMES
UNION ALL SELECT 'TRIP_ROUTE_PLAN', COUNT(*) FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TRIP_ROUTE_PLAN
UNION ALL SELECT 'TRIPS_ASSIGNED_TO_DRIVERS', COUNT(*) FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TRIPS_ASSIGNED_TO_DRIVERS;
```

**Key column notes (for workspace execution without `snow sql -f`):**
- `VW_DRIVER_LOCATIONS`: Must map STATUS to DRIVER_STATE (`MOVING`->`driving`, `DWELL_ORIGIN`->`pickup`, `DWELL_DESTINATION`->`dropoff`, `IDLE`->`idle`)
- `VW_TRIP_SUMMARY`: Must TRIM quotes from POI names (`COALESCE(TRIM(po.NAME, '"'), 'Unknown')`)
- `DRIVER_LOCATIONS_V`: Must include `ST_MAKEPOINT(LON, LAT) AS POINT_GEOM`
- `TRIP_ROUTE_PLAN`: Must construct fake ROUTE VARIANT with `OBJECT_CONSTRUCT('features', ...)` for the React map

### Generate data for other regions (optional)

To generate data for a region other than San Francisco, use the full pipeline starting at Step 2.

Or use the centralized provisioner:
```sql
CALL FLEET_INTELLIGENCE.CORE.PROVISION_REGION('<RegionName>', ARRAY_CONSTRUCT('fleet-intelligence-taxis'));
```

## Workflow

Execute each step in order using `snowflake_sql_execute`. Substitute `{PLACEHOLDER}` values based on the user's chosen configuration before executing.

> **Read `references/sql-pipeline.md` for complete SQL for every step below.**

### CRITICAL: Execution Rules

> 1. **One statement per `snowflake_sql_execute` tool call.** Multi-statement blocks can silently fail. This rule applies to the `snowflake_sql_execute` tool only; `snow sql -f` and other CLI execution is fine.
> 2. **Always use fully qualified object names** (`FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.<object>`). Session context from `USE` statements does not persist across calls.
> 3. **Never use `SET` session variables.** Substitute literal values directly into SQL.
> 4. **Verify row counts after each CTAS.**
> 5. **All CREATE statements must include a COMMENT tracking tag** per AGENTS.md convention: `COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-taxis",...}'`. See `references/sql-pipeline.md` for tagged SQL.

### Step 1: Set Query Tag

Execute:
```sql
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-taxis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

### Step 2: Detect ORS Configuration, Choose Location, Verify Services

1. **Describe** ORS service to extract configured `<REGION_NAME>` from volume source path.
2. **Download** ORS config and parse enabled routing profiles. Follow `.cortex/skills/routing-customization/read-ors-configuration/SKILL.md`.
3. **Ask user** which location to use — recommend the currently configured region first.
4. **Check region match** — if mismatch, user must reconfigure ORS via `.cortex/skills/routing-customization/SKILL.md`.
5. **Check/resume services** — run `SHOW SERVICES IN OPENROUTESERVICE_APP.CORE` and resume any suspended services.
6. **Test ORS routing** with a DIRECTIONS call using center coordinates of the target city.

### Step 3: Configure Database, Warehouse, and Schema

**Pre-check: If data already exists, skip to Step 9.** Run:
```sql
SELECT COUNT(*) AS cnt FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TAXI_LOCATIONS_INTERPOLATED;
```
If `cnt > 0`, the data pipeline has already run. Skip to Step 9 (analytics views) or Step 10 (Streamlit deployment) as needed.

Create `FLEET_INTELLIGENCE` database, `ROUTING_ANALYTICS` warehouse, and `FLEET_INTELLIGENCE_TAXIS` schema.

### Step 3b: Check & Install Overture Maps Datasets

Check if Overture Maps datasets are accessible:
```sql
SELECT COUNT(*) FROM OVERTURE_MAPS__PLACES.CARTO.PLACE LIMIT 1;
SELECT COUNT(*) FROM OVERTURE_MAPS__ADDRESSES.CARTO.ADDRESS LIMIT 1;
```

If either fails, install from Marketplace:
```sql
CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZT0Z4CM1E9KR');
CREATE DATABASE IF NOT EXISTS OVERTURE_MAPS__PLACES FROM LISTING GZT0Z4CM1E9KR;

CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZT0Z4CM1E9NQ');
CREATE DATABASE IF NOT EXISTS OVERTURE_MAPS__ADDRESSES FROM LISTING GZT0Z4CM1E9NQ;
```

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

1. **Create** `DRIVER_ROUTES` — call `OPENROUTESERVICE_APP.CORE.DIRECTIONS` for each trip.
2. **Create** `DRIVER_ROUTES_PARSED` — extract geometry, distance, duration from JSON response.
3. **Create** `DRIVER_ROUTE_GEOMETRIES` — add cumulative timing with `{START_DATE}`.
4. **Verify** route statistics.

### Step 8: Create Driver Locations (`DRIVER_LOCATIONS`)

Interpolate 15 points per trip along route geometry with driver states (`waiting`, `pickup`, `driving`, `dropoff`, `idle`) and realistic speeds varying by time of day (rush hour, overnight, normal). Verify point counts and speed distributions.

### Step 9: Create Analytics Views

Create 5 analytics views:
- `DRIVER_LOCATIONS_V` — locations with LAT/LON
- `TRIPS_ASSIGNED_TO_DRIVERS` — trip assignments with geometry
- `ROUTE_NAMES` — origin→destination labels
- `TRIP_ROUTE_PLAN` — full trip details with ROUTE JSON
- `TRIP_SUMMARY` — route geometries with avg/max speed

Verify all view row counts.


---

## Dashboard Schema Contract

The React Demo Dashboard pages query these exact tables and columns. If the pipeline changes column names, the React pages must be updated to match.

### TRIP_SUMMARY (view)
| Column | Type | Used By |
|--------|------|---------|
| DRIVER_ID | VARCHAR | FleetOverview, DriverRoutes, HeatMap |
| TRIP_ID | VARCHAR | FleetOverview, DriverRoutes |
| ORIGIN | GEOGRAPHY | FleetOverview (ST_X/ST_Y), DriverRoutes, HeatMap (H3) |
| DESTINATION | GEOGRAPHY | FleetOverview (ST_X/ST_Y), DriverRoutes |
| ROUTE_DISTANCE_METERS | FLOAT | FleetOverview, DriverRoutes (/ 1000 for km) |
| ROUTE_DURATION_SECS | FLOAT | FleetOverview, DriverRoutes (/ 60 for min) |
| TRIP_START_TIME | TIMESTAMP | FleetOverview (HOUR), HeatMap (HOUR filter) |
| AVERAGE_KMH | FLOAT | DriverRoutes, HeatMap |
| ORIGIN_ADDRESS | VARCHAR | DriverRoutes (AI analysis) |
| DESTINATION_ADDRESS | VARCHAR | DriverRoutes (AI analysis) |

### DRIVER_LOCATIONS_V (view)
| Column | Type | Used By |
|--------|------|---------|
| LON | FLOAT | DriverRoutes (GPS track), HeatMap (driver dots) |
| LAT | FLOAT | DriverRoutes (GPS track), HeatMap (driver dots) |
| TRIP_ID | VARCHAR | DriverRoutes (GPS filter) |
| CURR_TIME | TIMESTAMP | DriverRoutes (time display), HeatMap (hour filter) |
| KMH | FLOAT | DriverRoutes (speed chart) |
| DRIVER_STATE | VARCHAR | DriverRoutes (state display) |
| POINT_INDEX | NUMBER | DriverRoutes (ordering) |
| DRIVER_ID | VARCHAR | HeatMap (driver dots) |

---

## Examples

### Example 1: Quick deploy with seed data
User says: "Set up the taxi fleet dashboard"
Actions:
1. Run `references/seed-data.sql` to create projection views over UNIFIED tables
2. Verify TRIP_SUMMARY view returns rows
Result: Fleet dashboard shows San Francisco e-bike courier data via projection views (~2 min)

### Example 2: Full generation for New York
User says: "Generate taxi data for New York with 80 drivers"
Actions:
1. Verify ORS is configured for New York (Step 2)
2. Create database/schema (Step 3), install Overture Maps (Step 3b)
3. Create base locations from Overture POIs (Step 4), drivers (Step 5), trips (Step 6)
4. Generate ORS routes (Step 7), interpolate locations (Step 8)
5. Create analytics views (Step 9)
Result: 80 taxi drivers with ~18,000 realistic GPS points across New York (~8 min)

## Troubleshooting

| Issue | Solution |
|-------|----------|
| ORS routes returning NULL | Location outside ORS configured region — verify map data |
| ORS routes failing | Verify OpenRouteService Native App is installed and running |
| No locations found | Bounding box may be too restrictive or outside Overture coverage |
| Out of memory | Use larger warehouse or batch processing |
| Missing Overture data | Install shares from Snowflake Marketplace |
| Dashboard shows no data | Verify TRIP_SUMMARY view returns rows; check column names match React expectations |

## Cleanup

To remove all objects created by this skill:

```sql
-- Reverse dependency order: views, tables, schema
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
DROP SCHEMA IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS;
```

> **Tip:** Use the `cleanup` skill to auto-discover all tagged objects via COMMENT tracking.
