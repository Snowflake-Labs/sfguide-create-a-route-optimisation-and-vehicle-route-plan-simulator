---
name: route-optimization
description: "Deploy the Route Optimization demo including Marketplace data and notebook. Use when: setting up the route optimization demo after native app deployment. Do NOT use for: fleet intelligence demos (use fleet-intelligence-taxis), route deviation analysis (use route-deviation), or retail catchment analysis. Triggers: deploy route optimization demo, setup route optimization demo, run route optimization demo."
depends_on:
  - build-routing-solution
metadata:
  author: Snowflake SIT-IS
  version: 1.0.0
  category: route-optimization
---

# Deploy Route Optimization Demo

Deploys the complete Route Optimization demo including Snowflake Marketplace data and the exploration notebook. The interactive VRP simulator is served via the shared React Demo Dashboard app.

## Prerequisites

- OpenRouteService Native App deployed and activated
- Active Snowflake connection with a role that has privileges listed in the Required Privileges section below

## Required Privileges

| Privilege | Scope | Reason |
|-----------|-------|--------|
| CREATE DATABASE | Account | Creates FLEET_INTELLIGENCE database |
| CREATE WAREHOUSE | Account | Creates ROUTING_ANALYTICS warehouse |
| IMPORT SHARE | Account | Acquires OVERTURE_MAPS__PLACES from Marketplace |
| USAGE ON DATABASE FLEET_INTELLIGENCE | Database | Uses the setup database |
| CREATE SCHEMA | Database (FLEET_INTELLIGENCE) | Creates ROUTE_OPTIMIZATION schema |
| CREATE TABLE | Schema (FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION) | Creates CONFIG, PLACES, LOOKUP, JOB_TEMPLATE |
| USAGE ON DATABASE OVERTURE_MAPS__PLACES | Database | Reads Marketplace POI data |
| USAGE ON DATABASE OPENROUTESERVICE_NATIVE_APP | Database | Calls ORS routing functions |
| EXECUTE MANAGED TASK | Account | Enables ALTER ACCOUNT SET CORTEX_ENABLED_CROSS_REGION (optional) |

> **Note:** ACCOUNTADMIN is NOT required. Create a custom role with the above privileges, or use any role that has them.

> All `snow stage copy` commands use `--connection <ACTIVE_CONNECTION>`. Replace `<ACTIVE_CONNECTION>` with the name of your currently active Snowflake connection.

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| DATABASE | `FLEET_INTELLIGENCE` | Database for demo objects |
| SCHEMA | `ROUTE_OPTIMIZATION` | Schema for VRP tables and notebooks |
| WAREHOUSE | `ROUTING_ANALYTICS` | Warehouse for queries |
| MARKETPLACE_CARTO | `CARTO Academy` | CARTO Academy Marketplace listing name |

## Error Logging

When any step fails or produces unexpected results (SQL errors, missing objects, wrong row counts, service failures, deployment issues), log the issue to `logs/` following the format in `logs/README.md`. Create one log file per execution: `route-optimization_{YYYY-MM-DD}_{HH-MM}.md`. Continue execution where possible, logging all issues encountered. If execution completes with no issues, do not create a log file.

## Execution Rules

1. Never use bulk `sed` or `replace_all` on `.ipynb` files — notebooks are JSON with structured cell arrays. Use targeted replacements on specific cells identified by name.
2. Replace longer phrases before shorter ones when editing notebook prompts to avoid garbled text.
3. Replace complete prompt strings, not individual words.
4. Always validate JSON validity of modified `.ipynb` files before uploading.

## Workflow

### Step 1: Set Query Tag

**Pre-check: If data already exists, skip to Step 7.** Run:
```sql
SELECT COUNT(*) AS cnt FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.JOB_TEMPLATE;
```
If `cnt > 0`, the data pipeline has already run. Skip to Step 7 (fleet simulation notebook) or Step 9 (Streamlit deployment) as needed.

**Goal:** Set session query tag for attribution tracking.

> See `references/sql-setup.md` for the SQL command.

### Step 2: Verify ORS Services

**Goal:** Confirm all 4 ORS services are active (OPENROUTESERVICE, ROUTING_REVERSE_PROXY, VROOM, DOWNLOADER).

> See `references/sql-setup.md` for SHOW SERVICES, RESUME_ALL_SERVICES, and CHECK_HEALTH SQL.

**STOP** if ORS Native App is not installed.

### Step 3: Read ORS Configuration and Gather Preferences

**Goal:** Detect current map region and routing profiles, gather customization preferences from the user.

1. Read and follow `.cortex/skills/routing-customization/read-ors-configuration/SKILL.md`
2. Determine the demo city:
   - City map (e.g., "SanFrancisco"): use that city name
   - Region/country map (e.g., "great-britain"): ask user which city
3. Ask: "Do you want to customize industries? Default industries are: **Food**, **Healthcare**, **Cosmetics**."
   - If YES: gather specs per `references/industry-customization.md`
   - If NO: use defaults
4. Store for later steps: `<REGION_NAME>`, `<NOTEBOOK_CITY>`, `<ENABLED_PROFILES>`, `<CUSTOM_INDUSTRIES>`

**Output:** Map Region, Demo City, Vehicle Profiles, Custom Industries (YES/NO) confirmed with user.

### Step 4: Get Carto Overture Dataset

**Goal:** Acquire Overture Maps Places dataset for POI data.

> See `references/sql-setup.md` for the Marketplace SQL.

**Output:** `OVERTURE_MAPS__PLACES` database available.

### Step 5: Setup Snowflake Objects

**Goal:** Create database, schema, warehouse, and CONFIG table for the demo.

> See `references/sql-setup.md` for CREATE DATABASE / SCHEMA / WAREHOUSE SQL.

Also create the CONFIG table:
```sql
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG (
    VEHICLE_TYPE VARCHAR NOT NULL,
    REGION       VARCHAR NOT NULL
)
    COMMENT = '{"origin":"sf_sit-is-fleet", "name":"oss-route-optimization", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';
MERGE INTO FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG tgt
USING (SELECT 'driving-car' AS VEHICLE_TYPE, 'SanFrancisco' AS REGION) src
ON TRUE
WHEN NOT MATCHED THEN INSERT (VEHICLE_TYPE, REGION) VALUES (src.VEHICLE_TYPE, src.REGION);
```

**Output:** `FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION` schema created with CONFIG table.

### Step 6: Deploy Carto Data Notebook

**Goal:** Customize the Carto data notebook for `<REGION_NAME>`, optionally customize industries, deploy and execute.

> See `references/notebook-deployment.md` (Step 6) for geohash lookup, notebook edits, industry customization, upload/execute commands, and verification queries.

Key verification: PLACES (50K-500K rows), LOOKUP (3+ rows), JOB_TEMPLATE (29 rows). **STOP** if any table has 0 rows.

**Output:** Standing data populated for `<NOTEBOOK_CITY>`.

### Step 7: Check Claude Model

**Goal:** Verify latest Claude Sonnet model is available in Snowflake Cortex.

> See `references/notebook-deployment.md` (Step 7) for the test SQL and update instructions.

### Step 8: Deploy AISQL Notebook

**Goal:** Deploy the AISQL exploration notebook, customized for `<NOTEBOOK_CITY>`.

> See `references/notebook-deployment.md` (Step 8) for cell-by-cell update tables, text replacement rules, post-replacement validation, and upload/create commands.

If city references already match `<NOTEBOOK_CITY>`, skip modification and upload directly.

**Output:** AISQL notebook deployed with AI prompts customized for `<NOTEBOOK_CITY>`.


## Dashboard Schema Contract

The React Demo Dashboard page queries these exact tables and columns. If the pipeline changes column names, the React page must be updated to match.

### CONFIG
| Column | Type | Used By |
|--------|------|---------|
| VEHICLE_TYPE | VARCHAR | Global vehicle type selector |
| REGION | VARCHAR | Global region selector (updated by server on region switch) |

### PLACES
| Column | Type | Used By |
|--------|------|---------|
| REGION | VARCHAR | RouteOptimization (region filter) |
| NAME | VARCHAR | RouteOptimization (place display) |
| CATEGORY | VARCHAR | RouteOptimization (filtering) |
| GEOMETRY | GEOGRAPHY | RouteOptimization (ST_X/ST_Y, ST_DWITHIN radius filter) |

### JOB_TEMPLATE
| Column | Type | Used By |
|--------|------|---------|
| REGION | VARCHAR | RouteOptimization (region filter) |
| ID | NUMBER | RouteOptimization (job assignment) |
| SLOT_START | NUMBER | RouteOptimization (VRP time windows) |
| SLOT_END | NUMBER | RouteOptimization (VRP time windows) |
| SKILLS | NUMBER | RouteOptimization (VRP skills constraint) |
| PRODUCT | VARCHAR | RouteOptimization |
| STATUS | VARCHAR | RouteOptimization (active filter) |

### LOOKUP
| Column | Type | Used By |
|--------|------|---------|
| REGION | VARCHAR | RouteOptimization (region filter) |
| INDUSTRY | VARCHAR | RouteOptimization (industry selector) |
| PA | VARCHAR | RouteOptimization (POI category filter) |
| PB | VARCHAR | RouteOptimization |
| PC | VARCHAR | RouteOptimization |

### ORS Functions (cross-app)
| Function | Used By |
|----------|---------|
| OPENROUTESERVICE_NATIVE_APP.CORE.ISOCHRONES | Catchment preview (TABLE function) |
| OPENROUTESERVICE_NATIVE_APP.CORE.OPTIMIZATION | VRP solver |
| OPENROUTESERVICE_NATIVE_APP.CORE.DIRECTIONS | Per-vehicle route geometry (TABLE function) |
| SNOWFLAKE.CORTEX.COMPLETE | AI geocoding |

---

### Step 10: Verify

**Goal:** Confirm tables exist and Demo Dashboard shows the page.

1. Verify PLACES, LOOKUP, JOB_TEMPLATE tables have rows
2. Check Demo Dashboard loads Route Optimization page

## Stopping Points

- Step 1: STOP if OpenRouteService Native App is not installed
- Step 2: Wait for user to activate app if services not running
- Step 3: Confirm detected region, city, and industry choices with user
- Step 4: Verify Marketplace dataset accessible
- Step 6: Verify PLACES, LOOKUP, JOB_TEMPLATE tables are populated
- Step 7: Verify Claude model is available
- Step 9: Verify Demo Dashboard shows the Route Optimization page

## Troubleshooting

| Issue | Symptom | Solution |
|-------|---------|----------|
| **Stale config file** | Wrong region detected | Run `rm -rf /tmp/ors* /tmp/*ors*` before downloading config |
| Marketplace access denied | `CALL SYSTEM$ACCEPT_LEGAL_TERMS` fails | Requires IMPORT SHARE privilege (see Required Privileges section) |
| Notebook execution fails | `EXECUTE NOTEBOOK` errors | Check logs in Snowsight; verify `OVERTURE_MAPS__PLACES` accessible and warehouse active |
| Cortex model unavailable | "model not found" error | Try fallback model or set `CORTEX_ENABLED_CROSS_REGION = 'ANY_REGION'` |
| Services not starting | SUSPENDED or FAILED status | `CALL OPENROUTESERVICE_NATIVE_APP.CORE.RESUME_ALL_SERVICES()`; check compute pool capacity |
| Dashboard shows no data | Verify PLACES, LOOKUP, JOB_TEMPLATE tables are populated |
| Stage upload fails | Permission error | Verify WRITE privilege on stage and correct `--connection` |
| Wrong POI region | PLACES has wrong city data | Fix geohash in Step 6, re-run notebook |
| Custom industries missing | Dropdown shows old industries | Verify LOOKUP table; re-run from Step 6 |

## Recovery

Re-running is safe: all statements use `IF NOT EXISTS` or `OR REPLACE`, and `snow stage copy` uses `--overwrite`. No manual cleanup needed.

## Output

Complete Route Optimization demo with:
- Carto Overture Places dataset for POI data
- Exploration notebook with AISQL examples
- React VRP simulator in Demo Dashboard
- 3 configurable vehicles with skills
- Real-world points of interest for routing scenarios

## Cleanup

To remove all objects created by this skill:

```sql
DROP NOTEBOOK IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.ROUTING_FUNCTIONS_AISQL;
DROP NOTEBOOK IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.ADD_CARTO_DATA;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP;
DROP STAGE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.NOTEBOOK;
DROP SCHEMA IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION;
```

> **Tip:** Use the `cleanup` skill to auto-discover all tagged objects via COMMENT tracking.
