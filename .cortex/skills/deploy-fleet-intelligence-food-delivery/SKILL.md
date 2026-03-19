---
name: deploy-fleet-intelligence-food-delivery
description: "Deploy the Fleet Intelligence food delivery solution: native app with built-in OpenRouteService routing, Overture Maps data, courier simulation, and Streamlit dashboard. Supports 11 cities worldwide. Triggers: deploy fleet intelligence, install fleet app, food delivery demo, generate courier data."
---

# Deploy Fleet Intelligence Food Delivery Solution

## When to Use

- User wants to deploy the Fleet Intelligence food delivery demo
- User wants to generate delivery simulation data (couriers, orders, routes)
- User asks about the SwiftBite delivery dashboard

## Prerequisites

1. Snowflake account with ACCOUNTADMIN
2. Docker Desktop installed (for React app image build)
3. Snow CLI (`snow`) authenticated with target connection
4. Overture Maps datasets from Snowflake Marketplace (installed in Step 1)

## Configuration Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `LOCATION` | San Francisco | City for the simulation |
| `NUM_COURIERS` | 50 | Total delivery couriers |
| `NUM_DAYS` | 1 | Days to simulate |
| `START_DATE` | 2025-01-15 | First simulation day |
| `VEHICLE_TYPE` | cycling-electric | ORS routing profile |

## Workflow

```
Start
  |
  v
Step 1: Query Tag + Overture Maps
  |
  v
Step 2: Deploy Native App + ORS Routing      <-- Load references/native-app-deploy.md
  |     (Docker build, push, install,              Load references/maps-and-locations.md
  |      EAIs, deploy service, provision ORS)
  v
Step 3: Create Database/Warehouse/Schema
  |
  v
Steps 4-9: Generate Simulation Data          <-- Load references/data-generation.md
  |
  v
Steps 10-11: Analytics Views + Streamlit     <-- Load references/analytics-and-streamlit.md
  |
  v
Step 12: Travel Time Matrix (Optional)       <-- Load references/analytics-and-streamlit.md
  |
  v
Done (or troubleshoot)                        <-- Load references/troubleshooting.md
```

### Execution Rules

> 1. **One statement per `snowflake_sql_execute` call.** Multi-statement blocks can silently fail.
> 2. **Always use fully qualified object names.** `USE` statements do not persist across calls.
> 3. **Never use `SET` session variables.** Substitute literal values directly.
> 4. **Verify row counts after each CTAS.**

---

### Step 1: Set Query Tag and Install Overture Maps

**1a: Set Query Tag**

```sql
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is","name":"oss-deploy-a-fleet-intelligence-solution-for-food-delivery","version":{"major":1, "minor":0},"attributes":{"is_quickstart":1, "source":"sql"}}';
```

**1b: Install Overture Maps from Marketplace**

```sql
SHOW DATABASES LIKE 'OVERTURE_MAPS%';
```

If `OVERTURE_MAPS__PLACES` not listed:
```sql
CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZT0Z4CM1E9KR');
CREATE DATABASE IF NOT EXISTS OVERTURE_MAPS__PLACES FROM LISTING GZT0Z4CM1E9KR;
```

If `OVERTURE_MAPS__ADDRESSES` not listed:
```sql
CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZT0Z4CM1E9NQ');
CREATE DATABASE IF NOT EXISTS OVERTURE_MAPS__ADDRESSES FROM LISTING GZT0Z4CM1E9NQ;
```

Verify:
```sql
SELECT COUNT(*) FROM OVERTURE_MAPS__PLACES.CARTO.PLACE LIMIT 1;
SELECT COUNT(*) FROM OVERTURE_MAPS__ADDRESSES.CARTO.ADDRESS WHERE COUNTRY = 'US' LIMIT 1;
```

---

### Step 2: Deploy Native App, EAIs, and ORS Routing

This is the largest step. It builds and deploys the FLEET_INTELLIGENCE_APP native app with ORS routing.

**Load** `references/maps-and-locations.md` for city tables and Overture filters.
**Load** `references/native-app-deploy.md` and follow sub-steps 2a through 2m.

**MANDATORY STOPPING POINT** (before sub-step 2b): Ask user which city they want. Store `{LOCATION}`, `{COUNTRY}`, `{STATE}`. If they want extra cities beyond the 11 defaults, follow the Adding Additional Cities workflow in maps-and-locations.md — this must happen before Docker build.

**Summary of sub-steps in native-app-deploy.md:**

| Sub-step | What it does |
|----------|-------------|
| 2a | Verify Dockerfile port (8080) |
| 2b | Docker build (`--platform linux/amd64`) |
| 2c | Create image repository in Snowflake |
| 2d | Tag and push all 5 Docker images |
| 2e | Create application package + stage |
| 2f | Upload native app files (manifest, setup_script, service YAMLs) |
| 2g | Register version + install/upgrade application |
| 2h | Grant privileges (compute pool, warehouse, endpoint, data access) |
| 2i | Create **both** EAIs (map tiles + download) and bind via `REGISTER_SINGLE_CALLBACK` |
| 2j | Deploy service (`CALL CORE.DEPLOY()`) |
| 2k | Verify service is READY and endpoints resolve |
| 2l | Provision ORS routing for chosen city |
| 2m | Verify routing with city-specific `DIRECTIONS_{LOCATION}()` |

> **CRITICAL:** Always use city-specific functions (`DIRECTIONS_{LOCATION}`, `MATRIX_{LOCATION}`), NOT generic ones (`DIRECTIONS`, `MATRIX_TABULAR`). Generic functions route to the default ORS which has the Karlsruhe/Germany graph.

---

### Step 3: Configure Database, Warehouse, and Schema

```sql
CREATE DATABASE IF NOT EXISTS FLEET_INTELLIGENCE_SETUP
    COMMENT = '{"origin":"sf_sit-is", "name":"oss-deploy-a-fleet-intelligence-solution-for-food-delivery", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';
```

```sql
CREATE WAREHOUSE IF NOT EXISTS ROUTING_ANALYTICS
    WAREHOUSE_SIZE = 'XSMALL'
    AUTO_SUSPEND = 60
    AUTO_RESUME = TRUE
    COMMENT = '{"origin":"sf_sit-is", "name":"oss-deploy-a-fleet-intelligence-solution-for-food-delivery", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';
```

```sql
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY
    COMMENT = '{"origin":"sf_sit-is", "name":"oss-deploy-a-fleet-intelligence-solution-for-food-delivery", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';
```

```sql
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE_SETUP.ROUTING;
```

```sql
CREATE STAGE IF NOT EXISTS FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.STREAMLIT_STAGE
    DIRECTORY = (ENABLE = TRUE);
```

---

### Steps 4-9: Generate Simulation Data

**Load** `references/data-generation.md` and execute Steps 4-9 in order.

**MANDATORY STOPPING POINT**: After Step 8 (ORS Routes), verify route count before proceeding to Step 9.

---

### Steps 10-11: Analytics Views and Streamlit

**Load** `references/analytics-and-streamlit.md` and execute Steps 10-11.

Replace `<SKILL_DIR>` with the absolute path to this skill directory when executing PUT commands.

---

### Step 12: Travel Time Matrix — Streamlit (Optional)

**Load** `references/analytics-and-streamlit.md` — Step 12 section.

Builds an H3 hexagon-level travel time matrix using ORS MATRIX functions. Required for the Travel Time Matrix Streamlit page. Uses city-specific `MATRIX_{LOCATION}()` with parallel workers and resume safety.

> **Two separate matrix architectures exist — they do NOT share data:**
>
> | | Streamlit (Step 12) | React App (built-in) |
> |---|---|---|
> | **Where** | `FLEET_INTELLIGENCE_SETUP.ROUTING` | `FLEET_INTELLIGENCE_APP.DATA` |
> | **Tables** | `SF_TRAVEL_TIME_MATRIX`, `SF_HEXAGONS` | `CA_TRAVEL_TIME_RES7/8/9`, `CA_H3_RES7/8/9` |
> | **Resolutions** | Single (res 9) | Multi (res 7, 8, 9) |
> | **How to build** | Run Step 12 SQL via this skill | Use the Matrix Builder UI in the React app |
> | **Columns** | `origin_hex_id, destination_hex_id, travel_time_seconds, distance_meters` | `ORIGIN_H3, DEST_H3, TRAVEL_TIME_SECONDS, REGION, VEHICLE_TYPE` |
>
> Building one does **not** populate the other. If you need matrix data in both UIs, build separately in each.

---

## Stopping Points

- Before Step 2b: City selection (user must choose location)
- After Step 2k: Verify native app deployment before proceeding
- After Step 8: Verify routes before generating courier locations

**Resume rule:** Upon user approval, proceed directly to next step.

## Assets

Source files used during deployment:

| Path | Description |
|------|-------------|
| `assets/fleet-intelligence-app/` | React UI + Express server (Dockerfile, src/, server/) |
| `assets/fleet-intelligence-app/native-app/` | Native app configs (manifest.yml, setup_script.sql, service YAMLs) |
| `assets/streamlit/` | Streamlit dashboard (Delivery_Control_Center.py + pages/) |

## Output

- `FLEET_INTELLIGENCE_APP` — Native App with React UI, ORS routing, VROOM optimizer
- `FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY` — Schema with all data tables and views
- `FLEET_INTELLIGENCE_SETUP.ROUTING` — Schema with travel time matrix tables
- `SWIFTBITE_DELIVERY_DASHBOARD` — Streamlit app in Snowsight

## Troubleshooting

**Load** `references/troubleshooting.md` for error resolution and complete teardown/uninstall instructions.
