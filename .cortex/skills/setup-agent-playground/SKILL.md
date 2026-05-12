---
name: setup-agent-playground
description: "Deploy the Agent Playground demo data, stored procedures, and configuration. Run AFTER $build-routing-solution and $routing-agent complete. Creates all pharma supply chain, catchment, and optimisation tools needed for the agent playground to work. Triggers: setup agent playground, deploy agent demos, configure agent playground, install agent tools, deploy demo data, missing demographic data, missing pharma data."
depends_on:
  - build-routing-solution
  - routing-agent
metadata:
  author: Snowflake SIT-IS
  version: 1.1.0
  category: demo-setup
---

# Setup Agent Playground

Deploys all demo data, stored procedures, and configuration needed for the Agent Playground to be fully functional.

> **IMPORTANT:** The agent MUST execute every SQL statement below using `ROLE ACCOUNTADMIN` and `WAREHOUSE ROUTING_ANALYTICS`. Each step has a verification query — do NOT proceed to the next step until verification passes.

## Prerequisites Check

Before starting, verify prerequisites are met by running:

```sql
USE ROLE ACCOUNTADMIN;
USE WAREHOUSE ROUTING_ANALYTICS;
SHOW PROCEDURES LIKE 'TOOL_%' IN SCHEMA FLEET_INTELLIGENCE.ROUTING_AGENT;
```

**Required:** `TOOL_DIRECTIONS` and `TOOL_ISOCHRONE` must exist (deployed by `$routing-agent`). If missing, run `$routing-agent` first.

## Step 1: Configure Demo Defaults

Execute each statement individually:

```sql
UPDATE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.CONFIG SET VEHICLE_TYPE = 'ebike', REGION = 'SanFrancisco';
UPDATE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.CONFIG SET VEHICLE_TYPE = 'ebike', REGION = 'SanFrancisco';
UPDATE FLEET_INTELLIGENCE.DWELL_ANALYSIS.CONFIG SET VEHICLE_TYPE = 'ebike', REGION = 'SanFrancisco';
UPDATE FLEET_INTELLIGENCE.ROUTE_DEVIATION.CONFIG SET VEHICLE_TYPE = 'ebike', REGION = 'SanFrancisco';
UPDATE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG SET VEHICLE_TYPE = 'ebike', REGION = 'SanFrancisco';
UPDATE FLEET_INTELLIGENCE.RETAIL_CATCHMENT.CONFIG SET VEHICLE_TYPE = 'ebike', REGION = 'SanFrancisco';
```

Then create the DELIVERIES view. Read and execute the SQL from:
`references/configure-demo-defaults.sql` → contains the `CREATE OR REPLACE VIEW` statement.

If the references file is not available, execute:

```sql
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERIES AS
SELECT
    t.TRIP_ID AS DELIVERY_ID, t.VEHICLE_ID AS COURIER_ID,
    p.NAME AS RESTAURANT_NAME, t.ORIGIN_POI_ID AS RESTAURANT_ID,
    t.TRIP_START AS ORDER_TIME, t.STATUS AS ORDER_STATUS,
    t.ORIGIN AS PICKUP_LOCATION, t.DESTINATION AS DROPOFF_LOCATION,
    t.DESTINATION AS CUSTOMER_LOCATION, t.ROUTE_GEOG AS GEOMETRY,
    t.DURATION_MINUTES AS DELIVERY_TIME_MIN, t.DISTANCE_KM AS DISTANCE_KM
FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS t
LEFT JOIN SYNTHETIC_DATASETS.UNIFIED.DIM_POIS p ON t.ORIGIN_POI_ID = p.LOCATION_ID
WHERE t.VEHICLE_TYPE = (SELECT VEHICLE_TYPE FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.CONFIG LIMIT 1)
  AND t.REGION = (SELECT REGION FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.CONFIG LIMIT 1);
```

## Step 2: Deploy Demo Data Tables

Read `references/deploy-demo-data.sql` and execute every statement in it. This file creates and populates:

| Table | Expected Rows |
|-------|---------------|
| `FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_PHARMA_JOBS` | 30 |
| `FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_HEALTH_DEMOGRAPHICS` | 55 |
| `FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_DRUG_FORMULARY` | 25 |
| `FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_TOP_PHARMACIES` | 6 |

**Verification — run after all inserts:**

```sql
SELECT 'SF_PHARMA_JOBS' AS TBL, COUNT(*) AS ROW_COUNT FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_PHARMA_JOBS
UNION ALL SELECT 'SF_HEALTH_DEMOGRAPHICS', COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_HEALTH_DEMOGRAPHICS
UNION ALL SELECT 'SF_DRUG_FORMULARY', COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_DRUG_FORMULARY
UNION ALL SELECT 'SF_TOP_PHARMACIES', COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_TOP_PHARMACIES;
```

**Expected:** SF_PHARMA_JOBS=30, SF_HEALTH_DEMOGRAPHICS=55, SF_DRUG_FORMULARY=25, SF_TOP_PHARMACIES=6.

## Step 3: Deploy Stored Procedures

Read and execute each SQL file below. Each file contains a `CREATE OR REPLACE PROCEDURE` statement.

1. `.cortex/skills/build-routing-solution/openrouteservice_app/sql/stored_procedures/tool_route_optimization.sql`
2. `.cortex/skills/build-routing-solution/openrouteservice_app/sql/stored_procedures/tool_pharma_optimization.sql`
3. `.cortex/skills/build-routing-solution/openrouteservice_app/sql/stored_procedures/tool_pharma_catchment.sql`
4. `.cortex/skills/build-routing-solution/openrouteservice_app/sql/stored_procedures/tool_supply_chain.sql`

> **NOTE:** Files 2 and 4 also contain `CREATE TABLE` / `INSERT` statements for their data tables. If you already created the tables in Step 2, the `CREATE OR REPLACE PROCEDURE` statements are the only ones you need from these files.

**Verification:**

```sql
SHOW PROCEDURES LIKE 'TOOL_%' IN SCHEMA FLEET_INTELLIGENCE.ROUTING_AGENT;
```

**Expected (7 procedures):** TOOL_DIRECTIONS, TOOL_ISOCHRONE, TOOL_OPTIMIZATION, TOOL_ROUTE_OPTIMIZATION, TOOL_PHARMA_OPTIMIZATION, TOOL_PHARMA_CATCHMENT, TOOL_SUPPLY_CHAIN.

## Step 4: Upload Agent Config to Stage

Copy the agent-demos.json config file to the ORS stage. First copy the file to workspace root, then upload:

```sql
COPY FILES INTO @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/config/
FROM 'snow://workspace/<WORKSPACE_FQN>/versions/live'
FILES=('agent-demos.json');
```

If the file is nested under `.cortex/skills/...`, first write a copy to the workspace root, then upload from there. The target path must be `@ORS_SPCS_STAGE/config/agent-demos.json`.

**Verification:**

```sql
LIST @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/config/;
```

**Expected:** `ors_spcs_stage/config/agent-demos.json` exists.

## Step 5: Switch Back to Original Role

```sql
USE ROLE ALL_AGENTS_ROLE;
```

## Verification Summary

After all steps complete, these conditions must all be true:

1. 6 CONFIG tables updated to `ebike` / `SanFrancisco`
2. DELIVERIES view exists in `FLEET_INTELLIGENCE_FOOD_DELIVERY`
3. 4 data tables with correct row counts (30 + 55 + 25 + 6)
4. 7 TOOL_* procedures in ROUTING_AGENT schema
5. `agent-demos.json` at `@ORS_SPCS_STAGE/config/agent-demos.json`

## Troubleshooting

| Issue | Fix |
|-------|-----|
| "Insufficient privileges" | Switch to `USE ROLE ACCOUNTADMIN` before running DDL |
| "Object does not exist" for CONFIG tables | `$build-routing-solution` has not completed — run it first |
| "Isochrone geometry is null" | ORS service not ready — check `SELECT SYSTEM$GET_SERVICE_STATUS('OPENROUTESERVICE_APP.CORE.OPENROUTESERVICE')` |
| "Unknown function TOOL_PHARMA_CATCHMENT" | Step 3 not run — execute the stored procedure SQL files |
| Scenarios not appearing in app | Config not uploaded — run Step 4 |
| "OPTIMIZATION returned no results" | VROOM service suspended — `CALL OPENROUTESERVICE_APP.CORE.RESUME_ALL_SERVICES()` |
