---
name: build-routing-solution
description: "Build routing solution WITH SPCS. Use when: build routing solution, deploy ORS app, redeploy SPCS app. Do NOT use for: changing maps/profiles (routing-customization), deploying demos (use specific demo skills). Triggers: build routing solution, deploy ORS app, install openrouteservice."
metadata:
  author: Snowflake SIT-IS
  version: 1.0.0
  category: infrastructure
---

# Deploy Route Optimizer

Deploys the OpenRouteService routing engine on Snowpark Container Services.

## Execution Rules

1. One SQL statement per `snowflake_sql_execute` call — multi-statement blocks silently fail
2. Always use fully qualified names (`DATABASE.SCHEMA.OBJECT`)
3. Never use `SET` session variables (don't persist across calls)
4. After every CTAS, verify row count
5. All CREATE statements must include COMMENT tracking tag

## Prerequisites

- OPENROUTESERVICE_APP database with pre-built container images (5 images in IMAGE_REPOSITORY)
- ACCOUNTADMIN or role with: CREATE DATABASE, CREATE WAREHOUSE, CREATE COMPUTE POOL, CREATE INTEGRATION, BIND SERVICE ENDPOINT

## COPY FILES Path Behavior

> **CRITICAL:** `COPY FILES` always preserves full source path. Files in subdirs get nested.
> - **Text files:** Write to workspace root first, then COPY FILES
> - **Binary files:** Use `COPY_FILE_FLAT` Python SP (see `upload-map-files/SKILL.md`)

## Workflow

### Step 0: Clean Previous Installation

> **CRITICAL: Do NOT drop OPENROUTESERVICE_APP database** — contains pre-built images.

```sql
DROP APPLICATION IF EXISTS FLEET_INTELLIGENCE CASCADE;
DROP DATABASE IF EXISTS FLEET_INTEL_CONFIG CASCADE;
DROP SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ORS_CONTROL_APP;
DROP SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ORS_SERVICE;
DROP SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ROUTING_GATEWAY_SERVICE;
DROP SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.VROOM_SERVICE;
DROP SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.DOWNLOADER;
ALTER COMPUTE POOL IF EXISTS OPENROUTESERVICE_APP_COMPUTE_POOL STOP ALL;
DROP COMPUTE POOL IF EXISTS OPENROUTESERVICE_APP_COMPUTE_POOL;
ALTER COMPUTE POOL IF EXISTS ORS_CONTROL_APP_COMPUTE_POOL STOP ALL;
DROP COMPUTE POOL IF EXISTS ORS_CONTROL_APP_COMPUTE_POOL;
DROP DATABASE IF EXISTS SYNTHETIC_DATASETS CASCADE;
DROP WAREHOUSE IF EXISTS ROUTING_ANALYTICS;
```

Verify images still exist: `SHOW IMAGES IN IMAGE REPOSITORY OPENROUTESERVICE_APP.CORE.IMAGE_REPOSITORY;`

### Step 1: Set Query Tag

```sql
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

### Step 2: Create Infrastructure

Execute `openrouteservice_app/app/modules/01_core_infra.sql` — creates:
- SYNTHETIC_DATASETS + FLEET_INTELLIGENCE databases
- Network rules + external access integrations
- Compute pools (HIGHMEM_X64_S × 5, CPU_X64_XS × 1)
- **All 5 SPCS services**

> Wait for compute pools to reach IDLE/ACTIVE before services will start.

### Step 3: Upload Service Specs + Map Files

> Read and follow: `.cortex/skills/build-routing-solution/upload-map-files/SKILL.md`

Service spec YAML files → write to workspace root → COPY FILES to stage.
Map file (SanFrancisco.osm.pbf) → use COPY_FILE_FLAT SP to flatten path.
ORS config (ors-config.yml) → write to root → COPY FILES.

### Step 4: Create Routing Functions

Execute `openrouteservice_app/app/modules/02_routing_functions.sql` — creates:
- Raw service functions (_DIRECTIONS_RAW, _ISOCHRONES_RAW, etc.)
- Public wrapper functions (DIRECTIONS, ISOCHRONES, OPTIMIZATION, MATRIX)
- CHECK_HEALTH, ORS_STATUS utilities
- **JSON_FORMAT + PARQUET_FF** file formats
- MAP_CONFIG table

### Step 5: Create Region Management

Execute `openrouteservice_app/app/modules/03_region_management.sql` — creates:
- REGION_REGISTRY, REGION_ORS_MAP, REGION_CATALOG, REGION_PROVISION_JOBS tables
- Insert SanFrancisco default region

### Step 6: Create Lifecycle Procedures

Execute `openrouteservice_app/app/modules/04_service_lifecycle.sql` — creates:
- GET_STATUS, RESUME_ALL_SERVICES, SUSPEND_ALL_SERVICES procedures

### Step 7: Load Seed Data

Execute `datasets/load-seed-data.sql` — loads:
- INTRO_TRIPS (500 pre-computed routes)
- FACT_VEHICLE_TELEMETRY (472K GPS points)
- FACT_TRIPS (6K trips with GEOGRAPHY routes)
- DIM_POIS (5K POIs with LAT, LNG, LOCATION_TYPE)
- DIM_FLEET (50 vehicles)
- MATRIX_DATA (29K H3 travel-time pairs)
- REGION_REGISTRY (metadata for Control App)
- Creates TRAVEL_MATRIX schema + named matrix table

### Step 8: Verify

```sql
SHOW SERVICES IN SCHEMA OPENROUTESERVICE_APP.CORE;
-- All 5 must be RUNNING

SELECT OPENROUTESERVICE_APP.CORE.CHECK_HEALTH() AS healthy;
-- Must return TRUE (may take 2-3 min after ORS starts loading graphs)

SHOW ENDPOINTS IN SERVICE OPENROUTESERVICE_APP.CORE.ORS_CONTROL_APP;
-- Returns the public URL
```

## Service Architecture

```
ORS_SERVICE (×3)          — OpenRouteService routing engine (20GB JVM)
ROUTING_GATEWAY_SERVICE (×3) — Reverse proxy (routes to ORS + VROOM)
VROOM_SERVICE (×1)        — VROOM VRP solver
DOWNLOADER (×1)           — Downloads OSM files from Geofabrik/BBBike
ORS_CONTROL_APP (×1)      — React dashboard + Express API (public endpoint)
```

## Cleanup

```sql
DROP SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ORS_CONTROL_APP;
DROP SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ORS_SERVICE;
DROP SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ROUTING_GATEWAY_SERVICE;
DROP SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.VROOM_SERVICE;
DROP SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.DOWNLOADER;
ALTER COMPUTE POOL IF EXISTS OPENROUTESERVICE_APP_COMPUTE_POOL STOP ALL;
DROP COMPUTE POOL IF EXISTS OPENROUTESERVICE_APP_COMPUTE_POOL;
ALTER COMPUTE POOL IF EXISTS ORS_CONTROL_APP_COMPUTE_POOL STOP ALL;
DROP COMPUTE POOL IF EXISTS ORS_CONTROL_APP_COMPUTE_POOL;
DROP DATABASE IF EXISTS OPENROUTESERVICE_APP;
DROP DATABASE IF EXISTS SYNTHETIC_DATASETS;
DROP DATABASE IF EXISTS FLEET_INTELLIGENCE;
DROP WAREHOUSE IF EXISTS ROUTING_ANALYTICS;
DROP INTEGRATION IF EXISTS ORS_OSM_EAI;
DROP INTEGRATION IF EXISTS ORS_CARTO_EAI;
```
