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
Step 2: Choose Location + Deploy Native App  <-- Load references/maps-and-locations.md
  |                                               Load references/native-app-deploy.md
  v
Step 3: Create Database/Warehouse/Schema
  |
  v
Steps 4-9: Generate Data                     <-- Load references/data-generation.md
  |
  v
Steps 10-11: Views + Streamlit               <-- Load references/analytics-and-streamlit.md
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

### Step 2: Choose Location, Manage Maps, Deploy Native App

**Load** `references/maps-and-locations.md` for city tables, BBBike workflow, and Overture filters.

**2a:** Present pre-configured cities. Store `{LOCATION}`, `{COUNTRY}`, `{STATE}`.

**⚠️ MANDATORY STOPPING POINT**: Ask user which city they want. Also ask if they want to add cities beyond the 11 defaults.

**2b:** If user wants extra cities, follow the Adding Additional Cities workflow in maps-and-locations.md. This must happen before Docker build.

**2c: Deploy the Native App**

**Load** `references/native-app-deploy.md` and follow Steps 12a-12k.

**2d: Provision ORS Routing**

```sql
CALL FLEET_INTELLIGENCE_APP.ROUTING.SETUP_ORS();
CALL FLEET_INTELLIGENCE_APP.ROUTING.CREATE_CITY_ORS_SERVICE('{LOCATION}');
CALL FLEET_INTELLIGENCE_APP.ROUTING.CREATE_CITY_FUNCTIONS('{LOCATION}');
```

**2e: Verify Routing**

```sql
SELECT FLEET_INTELLIGENCE_APP.ROUTING.DIRECTIONS(
    'driving-car',
    [{CENTER_LON}, {CENTER_LAT}],
    [{CENTER_LON} + 0.02, {CENTER_LAT} + 0.02]
);
```

If it fails: `CALL SYSTEM$GET_SERVICE_LOGS('FLEET_INTELLIGENCE_APP.ROUTING.ORS_SERVICE', 0, 'ors', 50);`

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
CREATE STAGE IF NOT EXISTS FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.STREAMLIT_STAGE
    DIRECTORY = (ENABLE = TRUE);
```

---

### Steps 4-9: Generate Simulation Data

**Load** `references/data-generation.md` and execute Steps 4-9 in order.

**⚠️ MANDATORY STOPPING POINT**: After Step 8 (ORS Routes), verify route count before proceeding to Step 9.

---

### Steps 10-11: Analytics Views and Streamlit

**Load** `references/analytics-and-streamlit.md` and execute Steps 10-11.

Replace `<SKILL_DIR>` with the absolute path to this skill directory when executing PUT commands.

---

## Stopping Points

- ✋ Step 2a: City selection (user must choose location)
- ✋ Step 2b: Additional maps confirmation (if requested)
- ✋ After Step 8: Verify routes before generating courier locations
- ✋ After Step 12k: Verify native app deployment before proceeding

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
- `SWIFTBITE_DELIVERY_DASHBOARD` — Streamlit app in Snowsight

## Troubleshooting

**Load** `references/troubleshooting.md` for error resolution and complete teardown/uninstall instructions.
