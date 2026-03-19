---
name: route-optimization
description: "Deploy the Route Optimization demo including Marketplace data, notebook, and Streamlit app. Use when: setting up the route optimization demo after native app deployment. Do NOT use for: fleet intelligence demos (use fleet-intelligence-taxis), route deviation analysis (use route-deviation), or retail catchment analysis. Triggers: deploy route optimization demo, setup route optimization demo, run route optimization demo."
depends_on:
  - build-routing-solution
metadata:
  author: Snowflake SIT-IS
  version: 1.0.0
  category: route-optimization
---

# Deploy Route Optimization Demo

Deploys the complete Route Optimization demo including Snowflake Marketplace data, the exploration notebook, and the Streamlit simulator application.

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
| CREATE STAGE | Schema (FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION) | Creates NOTEBOOK and STREAMLIT stages |
| CREATE NOTEBOOK | Schema (FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION) | Deploys Carto data and AISQL notebooks |
| CREATE STREAMLIT | Schema (FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION) | Deploys route simulator app |
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

## Execution Rules

1. Never use bulk `sed` or `replace_all` on `.ipynb` files — notebooks are JSON with structured cell arrays. Use targeted replacements on specific cells identified by name.
2. Replace longer phrases before shorter ones when editing notebook prompts to avoid garbled text.
3. Replace complete prompt strings, not individual words.
4. Always validate JSON validity of modified `.ipynb` files before uploading.

## Workflow

### Step 1: Set Query Tag

**Goal:** Set session query tag for attribution tracking.

> See `references/sql-setup.md` for the SQL command.

### Step 2: Verify ORS Services

**Goal:** Confirm all 4 ORS services are active (OPENROUTESERVICE, ROUTING_REVERSE_PROXY, VROOM, DOWNLOADER).

> See `references/sql-setup.md` for SHOW SERVICES and ALTER SERVICE RESUME SQL.

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

**Goal:** Create database, schema, and warehouse for the demo.

> See `references/sql-setup.md` for CREATE DATABASE / SCHEMA / WAREHOUSE SQL.

**Output:** `FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION` schema created.

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

### Step 9: Deploy Streamlit App

**Goal:** Deploy the route simulator Streamlit app, customized for the detected region.

> See `references/streamlit-deployment.md` for landmark lookup, stage copy commands, and CREATE STREAMLIT SQL.

**Output:** Streamlit app deployed with default location set to `<NOTEBOOK_CITY>`.

### Step 10: Run the Demo

**Goal:** Access and use the route simulator.

1. Access Streamlit app via URL
2. Configure: sidebar > function location > industry > LLM model (recommend mistral-large2) > location > distance radius
3. Select distributor and customers from dropdowns
4. Configure vehicles: start/end times, profiles, skills
5. Run optimization: generate routes, view maps and delivery instructions

**Output:** Fully functional route optimization simulator.

## Stopping Points

- Step 1: STOP if OpenRouteService Native App is not installed
- Step 2: Wait for user to activate app if services not running
- Step 3: Confirm detected region, city, and industry choices with user
- Step 4: Verify Marketplace dataset accessible
- Step 6: Verify PLACES, LOOKUP, JOB_TEMPLATE tables are populated
- Step 7: Verify Claude model is available
- Step 10: Verify app loads correctly with correct region

## Troubleshooting

| Issue | Symptom | Solution |
|-------|---------|----------|
| **Stale config file** | Wrong region detected | Run `rm -rf /tmp/ors* /tmp/*ors*` before downloading config |
| Marketplace access denied | `CALL SYSTEM$ACCEPT_LEGAL_TERMS` fails | Requires IMPORT SHARE privilege (see Required Privileges section) |
| Notebook execution fails | `EXECUTE NOTEBOOK` errors | Check logs in Snowsight; verify `OVERTURE_MAPS__PLACES` accessible and warehouse active |
| Cortex model unavailable | "model not found" error | Try fallback model or set `CORTEX_ENABLED_CROSS_REGION = 'ANY_REGION'` |
| Services not starting | SUSPENDED or FAILED status | `ALTER SERVICE ... RESUME`; check compute pool capacity |
| Streamlit app errors | App fails to load | Verify PLACES, LOOKUP, JOB_TEMPLATE tables are populated |
| Stage upload fails | Permission error | Verify WRITE privilege on stage and correct `--connection` |
| Wrong POI region | PLACES has wrong city data | Fix geohash in Step 6, re-run notebook |
| Custom industries missing | Dropdown shows old industries | Verify LOOKUP table; re-run from Step 6 |

## Recovery

Re-running is safe: all statements use `IF NOT EXISTS` or `OR REPLACE`, and `snow stage copy` uses `--overwrite`. No manual cleanup needed.

## Output

Complete Route Optimization demo with:
- Carto Overture Places dataset for POI data
- Exploration notebook with AISQL examples
- Interactive Streamlit simulator
- 3 configurable vehicles with skills
- Real-world points of interest for routing scenarios

```sql
SELECT CONCAT('https://app.snowflake.com/', CURRENT_ORGANIZATION_NAME(), '/', CURRENT_ACCOUNT_NAME(), '/#/streamlit-apps/FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SIMULATOR') AS streamlit_url;
```

## Cleanup

To remove all objects created by this skill:

```sql
-- Reverse dependency order: streamlit/notebooks first, then tables, stages, schema
DROP STREAMLIT IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SIMULATOR;
DROP NOTEBOOK IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.ROUTING_FUNCTIONS_AISQL;
DROP NOTEBOOK IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.ADD_CARTO_DATA;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP;
DROP STAGE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.STREAMLIT;
DROP STAGE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.NOTEBOOK;
DROP SCHEMA IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION;
```

> **Tip:** Use the `cleanup` skill to auto-discover all tagged objects via COMMENT tracking.
