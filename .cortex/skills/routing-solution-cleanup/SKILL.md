---
name: routing-solution-cleanup
description: "Discover and remove all Snowflake objects created by skills in this repo. Uses the COMMENT tracking tag (sf_sit-is-fleet) to find objects, generates DROP statements, and optionally executes them. Use when: cleaning up after a demo, removing all skill-created objects, tearing down an environment, uninstalling a specific skill's objects. Do NOT use for: dropping objects not created by these skills, production environment cleanup without review. Triggers: routing-solution-cleanup, cleanup, teardown, remove, uninstall, drop all, clean up demo, remove skill objects, reset environment."
metadata:
  author: Snowflake SIT-IS
  version: 2.0.0
  category: developer-tools
---

# Cleanup / Teardown

Discovers and removes objects created by skills in this repository **while preserving the OPENROUTESERVICE_APP database and its image repository**. Container images are expensive to rebuild and push — they must survive cleanup. Uses the COMMENT tracking tag `sf_sit-is-fleet` for tagged objects and explicit object lists for untagged resources (marketplace databases, external access integrations, network rules, compute pools).

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
| 1 | SPCS Services | `SHOW SERVICES IN DATABASE OPENROUTESERVICE_APP` | `DROP SERVICE IF EXISTS <db>.<schema>.<name>` |
| 2 | Compute Pools | `SHOW COMPUTE POOLS` + name contains `OPENROUTESERVICE` or `ORS_CONTROL` | `ALTER COMPUTE POOL <name> STOP ALL; DROP COMPUTE POOL IF EXISTS <name>` |
| 3 | External Access Integrations | `SHOW INTEGRATIONS LIKE 'ORS%'` + `LIKE 'MET_OFFICE%'` | `DROP INTEGRATION IF EXISTS <name>` |
| 4 | Network Rules | Created inside OPENROUTESERVICE_APP (dropped with stages/functions) | N/A (dropped individually or via schema) |
| 5 | Cortex Agents | `SHOW AGENTS IN SCHEMA FLEET_INTELLIGENCE.ROUTING_AGENT` | `DROP AGENT IF EXISTS <db>.<schema>.<name>` |
| 6 | Tasks | `SHOW TASKS` in tagged schemas | `ALTER TASK <name> SUSPEND; DROP TASK IF EXISTS <name>` |
| 7 | Dynamic Tables | `SHOW DYNAMIC TABLES` in tagged schemas | `DROP DYNAMIC TABLE IF EXISTS <name>` |
| 8 | Notebooks | `SHOW NOTEBOOKS` in tagged schemas | `DROP NOTEBOOK IF EXISTS <name>` |
| 9 | Streamlit Apps | `SHOW STREAMLITS` + comment match | `DROP STREAMLIT IF EXISTS <name>` |
| 10 | Functions | `INFORMATION_SCHEMA.FUNCTIONS` in OPENROUTESERVICE_APP.CORE | `DROP FUNCTION IF EXISTS <name>(<arg_types>)` |
| 11 | Procedures | `INFORMATION_SCHEMA.PROCEDURES` + comment match | `DROP PROCEDURE IF EXISTS <name>(<arg_types>)` |
| 12 | Semantic Views | `SHOW SEMANTIC VIEWS` in tagged schemas | `DROP SEMANTIC VIEW IF EXISTS <name>` |
| 13 | Views | `INFORMATION_SCHEMA.VIEWS` + comment match | `DROP VIEW IF EXISTS <name>` |
| 14 | Tables | `INFORMATION_SCHEMA.TABLES` + comment match | `DROP TABLE IF EXISTS <name>` |
| 15 | Stages | `SHOW STAGES` in OPENROUTESERVICE_APP.CORE | `DROP STAGE IF EXISTS <name>` |
| 16 | File Formats | `SHOW FILE FORMATS` in OPENROUTESERVICE_APP.CORE | `DROP FILE FORMAT IF EXISTS <name>` |
| 17 | Schemas | `SHOW SCHEMAS` + comment match (in FLEET_INTELLIGENCE) | `DROP SCHEMA IF EXISTS <name> CASCADE` |
| 18 | Warehouses | `SHOW WAREHOUSES` + comment match | `ALTER WAREHOUSE <name> SUSPEND; DROP WAREHOUSE IF EXISTS <name>` |
| 19 | Marketplace Databases | `SHOW DATABASES LIKE 'OVERTURE_MAPS%'` | `DROP DATABASE IF EXISTS <name>` |
| 20 | Project Databases | FLEET_INTELLIGENCE, SYNTHETIC_DATASETS | `DROP DATABASE IF EXISTS <name> CASCADE` |
| — | **PRESERVED** | OPENROUTESERVICE_APP + IMAGE_REPOSITORY | **NEVER DROP** — contains container images |

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

### Phase 1 — SPCS Services (stop services but PRESERVE the database and images)

**CRITICAL: Do NOT drop OPENROUTESERVICE_APP database.** It contains the image repository with pre-built container images that are expensive to rebuild. Instead, drop services, functions, procedures, stages, and other objects individually.

```sql
-- 1. Drop all services (stops containers, releases compute)
DROP SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ORS_CONTROL_APP;
DROP SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ROUTING_GATEWAY_SERVICE;
DROP SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.VROOM_SERVICE;
DROP SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.DOWNLOADER;
DROP SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ORS_SERVICE;

-- 2. Drop all functions (routing functions, service functions)
--    Discovery-driven: query OPENROUTESERVICE_APP.INFORMATION_SCHEMA.FUNCTIONS
--    for all user-defined functions and generate DROP FUNCTION statements.
--    Example:
DROP FUNCTION IF EXISTS OPENROUTESERVICE_APP.CORE.DIRECTIONS(VARCHAR, ARRAY, ARRAY, VARCHAR);
DROP FUNCTION IF EXISTS OPENROUTESERVICE_APP.CORE.DIRECTIONS(VARCHAR, VARIANT, VARCHAR);
DROP FUNCTION IF EXISTS OPENROUTESERVICE_APP.CORE.ISOCHRONES(VARCHAR, FLOAT, FLOAT, NUMBER, VARCHAR);
DROP FUNCTION IF EXISTS OPENROUTESERVICE_APP.CORE.MATRIX(VARCHAR, ARRAY, VARCHAR);
DROP FUNCTION IF EXISTS OPENROUTESERVICE_APP.CORE.MATRIX(VARCHAR, VARIANT, VARCHAR);
DROP FUNCTION IF EXISTS OPENROUTESERVICE_APP.CORE.MATRIX_TABULAR(VARCHAR, ARRAY, ARRAY, VARCHAR);
DROP FUNCTION IF EXISTS OPENROUTESERVICE_APP.CORE.OPTIMIZATION(VARIANT, VARCHAR);
DROP FUNCTION IF EXISTS OPENROUTESERVICE_APP.CORE.OPTIMIZATION(ARRAY, ARRAY, ARRAY, VARCHAR);
DROP FUNCTION IF EXISTS OPENROUTESERVICE_APP.CORE.ORS_STATUS(VARCHAR);
DROP FUNCTION IF EXISTS OPENROUTESERVICE_APP.CORE.CHECK_HEALTH();
DROP FUNCTION IF EXISTS OPENROUTESERVICE_APP.CORE.DOWNLOAD(VARCHAR, VARCHAR, VARCHAR);
--    Also drop all _RAW service functions discovered via INFORMATION_SCHEMA.

-- 3. Drop all procedures in OPENROUTESERVICE_APP.CORE
--    Discovery-driven: query INFORMATION_SCHEMA.PROCEDURES.

-- 4. Drop stages (but NOT the image repository)
DROP STAGE IF EXISTS OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE;
DROP STAGE IF EXISTS OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE;
DROP STAGE IF EXISTS OPENROUTESERVICE_APP.CORE.ORS_GRAPHS_SPCS_STAGE;
DROP STAGE IF EXISTS OPENROUTESERVICE_APP.CORE.ORS_ELEVATION_CACHE_SPCS_STAGE;

-- 5. Drop file formats
DROP FILE FORMAT IF EXISTS OPENROUTESERVICE_APP.CORE.JSON_FORMAT;
DROP FILE FORMAT IF EXISTS OPENROUTESERVICE_APP.CORE.PARQUET_FF;

-- 6. Drop tables in OPENROUTESERVICE_APP.CORE (e.g. REGION_ORS_MAP, REGION_CATALOG)
--    Discovery-driven: query INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = 'CORE'.

-- DO NOT DROP:
--   - OPENROUTESERVICE_APP database
--   - OPENROUTESERVICE_APP.CORE schema
--   - OPENROUTESERVICE_APP.CORE.IMAGE_REPOSITORY
```

### Phase 2 — Compute Pools (if not already dropped by CASCADE)

```sql
-- 3. Stop and drop any compute pools created by the app
--    Naming pattern: OPENROUTESERVICE_APP_COMPUTE_POOL or city-specific pools
ALTER COMPUTE POOL IF EXISTS OPENROUTESERVICE_APP_COMPUTE_POOL STOP ALL;
DROP COMPUTE POOL IF EXISTS OPENROUTESERVICE_APP_COMPUTE_POOL;
ALTER COMPUTE POOL IF EXISTS ORS_CONTROL_APP_COMPUTE_POOL STOP ALL;
DROP COMPUTE POOL IF EXISTS ORS_CONTROL_APP_COMPUTE_POOL;
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

-- 13. Drop stages (OPENROUTESERVICE_APP stages already handled in Phase 1)

-- 14. DO NOT drop image repository — it holds pre-built container images
-- DROP IMAGE REPOSITORY IF EXISTS OPENROUTESERVICE_APP.CORE.IMAGE_REPOSITORY;  -- NEVER

-- 15. Drop file formats (OPENROUTESERVICE_APP formats already handled in Phase 1)
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
--     OPENROUTESERVICE_APP is PRESERVED (contains image repository with container images)
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

After execution, verify cleanup was successful while OPENROUTESERVICE_APP is preserved:

```sql
-- Verify OPENROUTESERVICE_APP still exists with images
SHOW DATABASES LIKE 'OPENROUTESERVICE_APP';
-- Expected: 1 row (database preserved)

SHOW IMAGES IN IMAGE REPOSITORY OPENROUTESERVICE_APP.CORE.IMAGE_REPOSITORY;
-- Expected: 5 images (openrouteservice, ors_control_app, routing_reverse_proxy, vroom-docker, downloader)

-- Verify no services remain
SHOW SERVICES IN DATABASE OPENROUTESERVICE_APP;
-- Expected: 0 rows (all services dropped)

-- Verify downstream databases are gone
SHOW DATABASES LIKE 'FLEET_INTELLIGENCE';
SHOW DATABASES LIKE 'SYNTHETIC_DATASETS';
-- Expected: 0 rows each

-- Verify no tagged warehouses remain
SHOW WAREHOUSES LIKE 'ROUTING%';
-- Expected: 0 rows

-- Verify no compute pools remain (except system pools)
SHOW COMPUTE POOLS;
-- Expected: only SYSTEM_COMPUTE_POOL_CPU and SYSTEM_COMPUTE_POOL_GPU

-- Verify no project integrations remain
SHOW INTEGRATIONS LIKE 'ORS%';
-- Expected: 0 rows

-- Verify no marketplace listings attached
SHOW DATABASES LIKE 'OVERTURE_MAPS%';
-- Expected: 0 rows
```

Report results as a table:

| Object Type | Remaining Count | Expected | Status |
|-------------|----------------|----------|--------|
| OPENROUTESERVICE_APP | 1 | 1 (preserved with images) | OK |
| Images in repository | 5 | 5 | OK |
| Services | 0 | 0 | CLEAN |
| FLEET_INTELLIGENCE | 0 | 0 | CLEAN |
| SYNTHETIC_DATASETS | 0 | 0 | CLEAN |
| Warehouses (ROUTING*) | 0 | 0 | CLEAN |
| Compute Pools (ORS*) | 0 | 0 | CLEAN |
| Integrations (ORS*) | 0 | 0 | CLEAN |
| Marketplace DBs | 0 | 0 | CLEAN |

## Cleanup by Skill

To clean up objects from a single skill, set `SKILL_FILTER` to its tracking name and run discovery. Then drop only the objects tagged with that skill. This is useful for re-deploying a single skill.

| Skill | Tracking Name | Key Objects |
|-------|--------------|-------------|
| build-routing-solution | `oss-build-routing-solution` | compute pools, services, stages, functions, procedures, SYNTHETIC_DATASETS DB, FLEET_INTELLIGENCE DB, ROUTING_ANALYTICS WH, EAIs. **PRESERVES**: OPENROUTESERVICE_APP DB + IMAGE_REPOSITORY |
| fleet-intelligence-taxis | `oss-fleet-intelligence-taxis` | FLEET_INTELLIGENCE_TAXIS schema, 10+ tables, views, CONFIG |
| fleet-intelligence-food-delivery | `oss-fleet-intelligence-food-delivery` | FLEET_INTELLIGENCE_FOOD_DELIVERY schema, projection views, CONFIG |
| route-deviation | `oss-route-deviation` | ROUTE_DEVIATION schema, deviation tables, views, CONFIG |
| dwell-analysis | `oss-dwell-analysis` | DWELL_ANALYSIS schema, 8 dynamic tables, task, geofence/SLA tables, views |
| retail-catchment | `oss-retail-catchment` | RETAIL_CATCHMENT schema, POIs, addresses, cities, region config |
| route-optimization | `oss-route-optimization` | ROUTE_OPTIMIZATION schema, notebooks, CONFIG, PLACES, LOOKUP |
| routing-agent | `oss-deploy-snowflake-intelligence-routing-agent` | ROUTING_AGENT schema, Cortex agent, tool procedures |

> **Note:** `build-routing-solution` is the foundation skill. Dropping its services, stages, and downstream databases will cascade to all demo skills. The OPENROUTESERVICE_APP database and IMAGE_REPOSITORY are **always preserved** — they hold container images that require Docker access to rebuild.

## Troubleshooting

| Issue | Solution |
|-------|---------|
| No objects found | Check you're using ACCOUNTADMIN role: `USE ROLE ACCOUNTADMIN;` |
| Cannot drop compute pool — active nodes | `ALTER COMPUTE POOL <name> STOP ALL;` then wait 30s before DROP |
| Cannot drop table — has dependents | Drop dynamic tables and views first (follow phase order) |
| Schema not empty after drops | Some objects may lack COMMENT tags. Use `DROP SCHEMA ... CASCADE` |
| Warehouse in use | `ALTER WAREHOUSE <name> SUSPEND;` first, then DROP |
| Cannot drop service — compute pool suspended | Resume pool first: `ALTER COMPUTE POOL <name> RESUME;` then DROP SERVICE |
| Integration still exists after cleanup | EAIs are account-level; drop them explicitly in Phase 3 |
| SHOW AGENTS syntax error | Account may not have Cortex Agents enabled — skip that type |
| Marketplace DB won't drop | Run `DROP DATABASE IF EXISTS <name>;` — this detaches the listing automatically |
| OPENROUTESERVICE_APP accidentally dropped | Recreate DB + schema + image repository, then re-push images from Docker host |
