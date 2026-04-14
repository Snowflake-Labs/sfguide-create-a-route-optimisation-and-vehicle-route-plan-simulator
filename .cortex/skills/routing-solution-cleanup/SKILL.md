---
name: routing-solution-cleanup
description: "Discover and remove all Snowflake objects created by skills in this repo. Uses the COMMENT tracking tag (sf_sit-is-fleet) to find objects, generates DROP statements, and optionally executes them. Use when: cleaning up after a demo, removing all skill-created objects, tearing down an environment, uninstalling a specific skill's objects. Do NOT use for: dropping objects not created by these skills, production environment cleanup without review. Triggers: routing-solution-cleanup, cleanup, teardown, remove, uninstall, drop all, clean up demo, remove skill objects, reset environment."
metadata:
  author: Snowflake SIT-IS
  version: 2.0.0
  category: developer-tools
---

# Cleanup / Teardown

Discovers and removes **all** Snowflake objects created by skills in this repository. Uses the COMMENT tracking tag `sf_sit-is-fleet` for tagged objects and explicit object lists for untagged resources (marketplace databases, external access integrations, network rules, compute pools).

## How It Works

Every CREATE statement in every skill includes a COMMENT with JSON metadata:
```json
{"origin":"sf_sit-is-fleet","name":"<skill-tracking-name>","version":{"major":1,"minor":0},...}
```

This skill queries `INFORMATION_SCHEMA`, `SHOW` commands, and `ACCOUNT_USAGE` views to discover all tagged objects, then generates DROP statements in dependency-safe order.

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| TRACKING_TAG | `sf_sit-is-fleet` | Origin tag to search for in COMMENT fields |
| SKILL_FILTER | (all) | Optional: filter to a specific skill tracking name |
| DRY_RUN | `true` | When true, only generates DROP statements without executing |

## Error Logging

> Follow the Error Logging convention in AGENTS.md. Log file prefix: `cleanup`.

## Prerequisites

- Active Snowflake connection with ACCOUNTADMIN role (or equivalent DROP privileges)
- The compute pool and SPCS services must be in the same account

## Complete Object Inventory

These are ALL object types created across all skills. The drop order reverses creation dependencies.

| # | Object Type | How to Discover | Drop Command |
|---|-------------|-----------------|--------------|
| 1 | DATABASE | `SHOW DATABASE` + comment/name match | `DROP DATABASE IF EXISTS <name> CASCADE` |
| 2 | Compute Pools | `SHOW COMPUTE POOLS` + name contains `OPENROUTESERVICE` | `ALTER COMPUTE POOL <name> STOP ALL; DROP COMPUTE POOL IF EXISTS <name>` |
| 3 | External Access Integrations | `SHOW INTEGRATIONS LIKE 'OSM'`;| `DROP INTEGRATION IF EXISTS <name>` |
| 4 | Network Rules | `SHOW NETWORK RULES` + name contains `OPENROUTESERVICE_APP` | `DROP NETWORK RULE IF EXISTS <db>.<schema>.<name>` |
| 5 | Cortex Agents | `SHOW AGENTS IN SCHEMA FLEET_INTELLIGENCE.ROUTING_AGENT` | `DROP AGENT IF EXISTS <db>.<schema>.<name>` |
| 6 | Tasks | `SHOW TASKS` in tagged schemas | `ALTER TASK <name> SUSPEND; DROP TASK IF EXISTS <name>` |
| 7 | Dynamic Tables | `SHOW DYNAMIC TABLES` in tagged schemas | `DROP DYNAMIC TABLE IF EXISTS <name>` |
| 8 | Notebooks | `SHOW NOTEBOOKS` in tagged schemas | `DROP NOTEBOOK IF EXISTS <name>` |
| 9 | Streamlit Apps | `SHOW STREAMLITS` + comment match | `DROP STREAMLIT IF EXISTS <name>` |
| 10 | Procedures | `INFORMATION_SCHEMA.PROCEDURES` + comment match | `DROP PROCEDURE IF EXISTS <name>(<arg_types>)` |
| 11 | Functions | `INFORMATION_SCHEMA.FUNCTIONS` + comment match | `DROP FUNCTION IF EXISTS <name>(<arg_types>)` |
| 12 | Views | `INFORMATION_SCHEMA.VIEWS` + comment match | `DROP VIEW IF EXISTS <name>` |
| 13 | Tables | `INFORMATION_SCHEMA.TABLES` + comment match | `DROP TABLE IF EXISTS <name>` |
| 14 | Stages | `SHOW STAGES` + comment match | `DROP STAGE IF EXISTS <name>` |
| 15 | Image Repositories | `SHOW IMAGE REPOSITORIES` + in tagged database | `DROP IMAGE REPOSITORY IF EXISTS <name>` |
| 16 | File Formats | `SHOW FILE FORMATS` + in tagged database | `DROP FILE FORMAT IF EXISTS <name>` |
| 17 | Schemas | `SHOW SCHEMAS` + comment match | `DROP SCHEMA IF EXISTS <name> CASCADE` |
| 18 | Warehouses | `SHOW WAREHOUSES` + comment match | `ALTER WAREHOUSE <name> SUSPEND; DROP WAREHOUSE IF EXISTS <name>` |
| 19 | Marketplace Databases | `SHOW DATABASES` + name/origin match | `DROP DATABASE IF EXISTS <name>` |

## Step 1: Set Session Tag

```sql
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-routing-solution-cleanup","version":{"major":2,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

## Step 2: Discover All Objects

Run the discovery queries from [`references/discovery-queries.sql`](references/discovery-queries.sql).

Execute each query and collect results. Some queries use `SHOW` + `RESULT_SCAN` patterns; these must be run as two consecutive statements in the same session or via `snowflake_sql_execute`.

> **Tip:** If `SHOW AGENTS` fails with a syntax error, the account may not have Cortex Agents enabled — skip that object type.

## Step 3: Generate DROP Statements

Based on discovery results, generate DROP statements in **strict dependency order** (most-dependent first):

### Phase 1 — App (stops SPCS services)

```sql
DROP DATABASE IF EXISTS OPENROUTESERVICE_APP;
```

### Phase 2 — Compute Pools (if not already dropped by CASCADE)

```sql
-- 3. Stop and drop any compute pools created by the app
--    Naming pattern: OPENROUTESERVICE_APP_COMPUTE_POOL or city-specific pools
ALTER COMPUTE POOL IF EXISTS OPENROUTESERVICE_APP_COMPUTE_POOL STOP ALL;
DROP COMPUTE POOL IF EXISTS OPENROUTESERVICE_APP_COMPUTE_POOL;
```

### Phase 3 — External Access Integrations & Network Rules

```sql
-- 4. Drop external access integrations
DROP INTEGRATION IF EXISTS ORS_OSM_EAI;
DROP INTEGRATION IF EXISTS ORS_CARTO_EAI;

```

### Phase 4 — Cortex Agents, Tasks, Dynamic Tables, Notebooks, Streamlits

```sql
-- 5. Drop Cortex agents
DROP AGENT IF EXISTS FLEET_INTELLIGENCE.ROUTING_AGENT.ROUTING_AGENT;

-- 6. Suspend and drop tasks
ALTER TASK IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.LOG_SLA_ALERTS SUSPEND;
DROP TASK IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.LOG_SLA_ALERTS;

-- 7. Drop dynamic tables (dwell-analysis pipeline)
DROP DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DAILY_TRENDS;
DROP DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DRIVER_DWELL_SUMMARY;
DROP DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_FACILITY_UTILIZATION;
DROP DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_SLA_ALERTS;
DROP DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_H3_CONGESTION;
DROP DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DWELL_ENRICHED;
DROP DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DWELL_SESSIONS;
DROP DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_STATE_CHANGES;

-- 8. Drop notebooks (route-optimization)
DROP NOTEBOOK IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.ADD_CARTO_DATA;
DROP NOTEBOOK IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.ROUTING_FUNCTIONS_AISQL;
```

### Phase 5 — Procedures, Functions, Views, Tables

For each tagged object found in discovery, generate the appropriate DROP. Use the full signature for procedures and functions.

```sql
-- 9. Drop procedures (example — actual list comes from discovery)
DROP PROCEDURE IF EXISTS FLEET_INTELLIGENCE.CORE.SET_ACTIVE_REGION(VARCHAR);
DROP PROCEDURE IF EXISTS FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_DIRECTIONS(VARCHAR, VARCHAR, VARCHAR);
DROP PROCEDURE IF EXISTS FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ISOCHRONE(VARCHAR, FLOAT, VARCHAR);
DROP PROCEDURE IF EXISTS FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_OPTIMIZATION(VARCHAR, VARCHAR, VARCHAR);

-- 11. Drop views (from all schemas — discovery-driven)
-- Example:
-- DROP VIEW IF EXISTS FLEET_INTELLIGENCE.ROUTE_DEVIATION.VW_VEHICLE_TELEMETRY;
-- DROP VIEW IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.VW_VEHICLE_TELEMETRY;

-- 12. Drop tables (from all schemas — discovery-driven)
-- Example:
-- DROP TABLE IF EXISTS FLEET_INTELLIGENCE.RETAIL_CATCHMENT.RETAIL_POIS;
-- DROP TABLE IF EXISTS SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY;

-- 13. Drop stages
DROP STAGE IF EXISTS OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE;
DROP STAGE IF EXISTS OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE;
DROP STAGE IF EXISTS OPENROUTESERVICE_APP.CORE.ORS_GRAPHS_SPCS_STAGE;
DROP STAGE IF EXISTS OPENROUTESERVICE_APP.CORE.ORS_ELEVATION_CACHE_SPCS_STAGE;

-- 14. Drop image repository
DROP IMAGE REPOSITORY IF EXISTS OPENROUTESERVICE_APP.CORE.IMAGE_REPOSITORY;

-- 15. Drop file formats
DROP FILE FORMAT IF EXISTS OPENROUTESERVICE_APP.CORE.PARQUET_FF;
```

### Phase 6 — Schemas, Warehouses, Databases

```sql
-- 16. Drop schemas (CASCADE handles any remaining objects)
DROP SCHEMA IF EXISTS FLEET_INTELLIGENCE.ROUTING_AGENT CASCADE;
DROP SCHEMA IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION CASCADE;
DROP SCHEMA IF EXISTS FLEET_INTELLIGENCE.RETAIL_CATCHMENT CASCADE;
DROP SCHEMA IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS CASCADE;
DROP SCHEMA IF EXISTS FLEET_INTELLIGENCE.ROUTE_DEVIATION CASCADE;
DROP SCHEMA IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY CASCADE;
DROP SCHEMA IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS CASCADE;
DROP SCHEMA IF EXISTS FLEET_INTELLIGENCE.CORE CASCADE;

-- 18. Suspend and drop warehouse
ALTER WAREHOUSE IF EXISTS ROUTING_ANALYTICS SUSPEND;
DROP WAREHOUSE IF EXISTS ROUTING_ANALYTICS;

-- 19. Drop marketplace databases (no tracking tag — match by name and origin)
DROP DATABASE IF EXISTS OVERTURE_MAPS__PLACES;
DROP DATABASE IF EXISTS OVERTURE_MAPS__ADDRESSES;

-- 20. Drop project databases (CASCADE handles all contained objects)
DROP DATABASE IF EXISTS FLEET_INTELLIGENCE CASCADE;
DROP DATABASE IF EXISTS SYNTHETIC_DATASETS CASCADE;
```

## Step 4: Review and Execute

**Action:** Present the generated DROP statements to the user grouped by phase.

- If `DRY_RUN = true`: Display all statements and stop. Ask the user to confirm before executing.
- If `DRY_RUN = false`: Execute each DROP statement sequentially and report results.

**Always confirm before executing.** Show a summary count:
```
Objects to drop:
  Native apps: N
  App packages: N
  Compute pools: N
  Integrations: N
  Network rules: N
  Agents: N
  Tasks: N
  Dynamic tables: N
  Notebooks: N
  Streamlits: N
  Procedures: N
  Functions: N
  Views: N
  Tables: N
  Stages: N
  Image repositories: N
  File formats: N
  Schemas: N
  Warehouses: N
  Databases: N
  ─────────────────
  Total: N objects
```

## Step 5: Verify Clean State

After execution, verify nothing remains:

```sql
-- Verify no tagged databases remain
SHOW DATABASES;
-- Expected: only SNOWFLAKE (system) and USER$<username> (personal)

-- Verify no tagged warehouses remain
SHOW WAREHOUSES;
-- Expected: only MY_WH (personal) and SYSTEM$STREAMLIT_NOTEBOOK_WH (system)

-- Verify no compute pools remain (except system pools)
SHOW COMPUTE POOLS;
-- Expected: only SYSTEM_COMPUTE_POOL_CPU and SYSTEM_COMPUTE_POOL_GPU

-- Verify no project integrations remain
SHOW INTEGRATIONS;
-- Expected: only SNOWFLAKE$LOCAL_APPLICATION (system)

-- Verify no marketplace listings attached
-- (Overture Maps databases being dropped detaches the listing)
```

Report results as a table:

| Object Type | Remaining Count | Expected | Status |
|-------------|----------------|----------|--------|
| Databases | 2 | 2 (SNOWFLAKE, USER$*) | CLEAN |
| Warehouses | 2 | 2 (MY_WH, SYSTEM$*) | CLEAN |
| Compute Pools | 2 | 2 (SYSTEM_*) | CLEAN |
| Integrations | 1 | 1 (SNOWFLAKE$LOCAL_APPLICATION) | CLEAN |

## Cleanup by Skill

To clean up objects from a single skill, set `SKILL_FILTER` to its tracking name and run discovery. Then drop only the objects tagged with that skill. This is useful for re-deploying a single skill.

| Skill | Tracking Name | Key Objects |
|-------|--------------|-------------|
| build-routing-solution | `oss-build-routing-solution` | compute pool, OPENROUTESERVICE_APP DB, SYNTHETIC_DATASETS DB, FLEET_INTELLIGENCE DB, ROUTING_ANALYTICS WH, seed data, EAIs |
| fleet-intelligence-taxis | `oss-fleet-intelligence-taxis` | FLEET_INTELLIGENCE_TAXIS schema, 10+ tables, views, CONFIG |
| fleet-intelligence-food-delivery | `oss-fleet-intelligence-food-delivery` | FLEET_INTELLIGENCE_FOOD_DELIVERY schema, projection views, CONFIG |
| route-deviation | `oss-route-deviation` | ROUTE_DEVIATION schema, deviation tables, views, CONFIG |
| dwell-analysis | `oss-dwell-analysis` | DWELL_ANALYSIS schema, 8 dynamic tables, task, geofence/SLA tables, views |
| retail-catchment | `oss-retail-catchment` | RETAIL_CATCHMENT schema, POIs, addresses, cities, region config |
| route-optimization | `oss-route-optimization` | ROUTE_OPTIMIZATION schema, notebooks, CONFIG, PLACES, LOOKUP |
| routing-agent | `oss-deploy-snowflake-intelligence-routing-agent` | ROUTING_AGENT schema, Cortex agent, tool procedures |

> **Note:** `build-routing-solution` is the foundation skill. Dropping its objects (databases, warehouse) will cascade to all downstream skills. Only drop it when tearing down the entire environment.

## Troubleshooting

| Issue | Solution |
|-------|---------|
| No objects found | Check you're using ACCOUNTADMIN role: `USE ROLE ACCOUNTADMIN;` |
| Cannot drop compute pool — active nodes | `ALTER COMPUTE POOL <name> STOP ALL;` then wait 30s before DROP |
| Cannot drop table — has dependents | Drop dynamic tables and views first (follow phase order) |
| Schema not empty after drops | Some objects may lack COMMENT tags. Use `DROP SCHEMA ... CASCADE` |
| Warehouse in use | `ALTER WAREHOUSE <name> SUSPEND;` first, then DROP |
| DROP APPLICATION fails | Ensure all services are stopped: `SHOW SERVICES IN APPLICATION <name>` |
| Integration still exists after app drop | EAIs are account-level; drop them explicitly in Phase 3 |
| SHOW AGENTS syntax error | Account may not have Cortex Agents enabled — skip that type |
| Marketplace DB won't drop | Run `DROP DATABASE IF EXISTS <name>;` — this detaches the listing automatically |
