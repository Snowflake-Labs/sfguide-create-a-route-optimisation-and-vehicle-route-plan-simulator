---
name: route-optimization
description: "Deploy the Route Optimization demo including Marketplace data and notebook. Use when: setting up the route optimization demo after ORS app deployment. Do NOT use for: fleet intelligence demos (use fleet-intelligence-taxis), route deviation analysis (use route-deviation), or retail catchment analysis. Triggers: deploy route optimization demo, setup route optimization demo, run route optimization demo."
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
| USAGE ON DATABASE OPENROUTESERVICE_APP | Database | Calls ORS routing functions |
| EXECUTE MANAGED TASK | Account | Enables ALTER ACCOUNT SET CORTEX_ENABLED_CROSS_REGION (optional) |

> **Note:** ACCOUNTADMIN is NOT required. Create a custom role with the above privileges, or use any role that has them.

> All `snow stage copy` commands use `--connection <ACTIVE_CONNECTION>`. Replace `<ACTIVE_CONNECTION>` with the name of your currently active Snowflake connection.

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| DATABASE | `FLEET_INTELLIGENCE` | Database for demo objects |
| SCHEMA | `ROUTE_OPTIMIZATION` | Schema for VRP tables and notebooks |
| WAREHOUSE | `ROUTING_ANALYTICS` | Warehouse for queries |
| VEHICLE_TYPE | `driving-car` | ORS routing profile (NOT 'ebike' — VRP uses car routing) |
| REGION_GEOHASH | `9q` | Geohash prefix for Overture Maps filter (SF Bay Area) |
| REGION_NAME | `SanFrancisco` | Region identifier used in all tables |
| MARKETPLACE_CARTO | `CARTO Academy` | CARTO Academy Marketplace listing name |

## Error Logging

> Follow the Error Logging convention in AGENTS.md. Log file prefix: `route-optimization`.

## Execution Rules

1. Never use bulk `sed` or `replace_all` on `.ipynb` files — notebooks are JSON with structured cell arrays. Use targeted replacements on specific cells identified by name.
2. Replace longer phrases before shorter ones when editing notebook prompts to avoid garbled text.
3. Replace complete prompt strings, not individual words.
4. Always validate JSON validity of modified `.ipynb` files before uploading.
5. **CONFIG.VEHICLE_TYPE must be `'driving-car'`** (the ORS car routing profile). Do NOT use `'ebike'` — the VRP solver and OPTIMIZATION function use driving-car.
6. **In workspace environments** (no `snow sql -f` available), use Option B in Step 5 — execute each SQL statement individually via `snowflake_sql_execute` with literal values substituted for `$REGION_GEOHASH` and `$REGION_NAME`.
7. **LOOKUP table schema** must include ARRAY columns (`IND, IND2, CTYPE, STYPE`) and a `REGION` column. The app reads industries dynamically from this table. Without ARRAY columns the industry dropdown will be empty.

## Workflow

### Step 1: Set Query Tag

**Pre-check: If data already exists, skip to Step 6.** Run:
```sql
SELECT COUNT(*) AS cnt FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES;
```
If `cnt > 0`, the data pipeline has already run. Skip to Step 6 (Claude model check) or Step 7 (AISQL notebook) as needed.

**Goal:** Set session query tag for attribution tracking.

Execute:
```sql
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-route-optimization","version":{"major":1, "minor":0},"attributes":{"is_quickstart":1, "source":"sql"}}';
```

### Step 2: Verify ORS Services

**Goal:** Confirm all 4 ORS services are active (OPENROUTESERVICE, ROUTING_REVERSE_PROXY, VROOM, DOWNLOADER).

Execute:
```sql
SHOW SERVICES IN DATABASE OPENROUTESERVICE_APP;
```

If any services are SUSPENDED, resume them:
```sql
CALL OPENROUTESERVICE_APP.CORE.RESUME_ALL_SERVICES();
SELECT OPENROUTESERVICE_APP.CORE.CHECK_HEALTH();
```

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

Execute:
```sql
CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZT0Z4CM1E9KR');
CREATE DATABASE IF NOT EXISTS OVERTURE_MAPS__PLACES FROM LISTING GZT0Z4CM1E9KR;
```

> Requires IMPORT SHARE privilege. If profile error occurs, update user profile with first/last name and email. Full details in `references/sql-setup.md` Step 4.

**Output:** `OVERTURE_MAPS__PLACES` database available.

### Step 5: Run Seed Data Script

**Goal:** Create database, schema, warehouse, CONFIG, PLACES, JOB_TEMPLATE, and LOOKUP tables from Overture Maps.

1. If region is NOT SanFrancisco, update the `SET` variables at the top of `references/seed-data.sql`:
   - `$REGION_GEOHASH`: see geohash table in `references/notebook-deployment.md`
   - `$REGION_NAME`: the city/region name (e.g., `'NewYork'`, `'London'`)
2. If the user requested custom industries in Step 3, update the LOOKUP INSERT section in `references/seed-data.sql` per `references/industry-customization.md`.

#### Option A: CLI execution (preserves SET variables)
3. Run:
   ```bash
   snow sql -f .cortex/skills/route-optimization/references/seed-data.sql -c <connection>
   ```

#### Option B: Workspace / snowflake_sql_execute (one statement per call)

> **CRITICAL:** `SET` session variables do NOT persist across `snowflake_sql_execute` calls. You MUST substitute literal values directly into each SQL statement. Replace `$REGION_GEOHASH` with `'9q'` and `$REGION_NAME` with `'SanFrancisco'` (or the chosen region) in every statement.

Execute each statement individually in this order:

```sql
-- 5a: Infrastructure
CREATE DATABASE IF NOT EXISTS FLEET_INTELLIGENCE COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-route-optimization","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
CREATE WAREHOUSE IF NOT EXISTS ROUTING_ANALYTICS WAREHOUSE_SIZE='XSMALL' AUTO_SUSPEND=60 AUTO_RESUME=TRUE COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-route-optimization","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-route-optimization","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
CREATE STAGE IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.NOTEBOOK COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-route-optimization","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

```sql
-- 5b: CONFIG table (VEHICLE_TYPE must be 'driving-car' for VRP routing)
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG (VEHICLE_TYPE VARCHAR NOT NULL, REGION VARCHAR NOT NULL) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-route-optimization","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```
```sql
MERGE INTO FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG tgt USING (SELECT 'driving-car' AS VEHICLE_TYPE, 'SanFrancisco' AS REGION) src ON TRUE WHEN NOT MATCHED THEN INSERT (VEHICLE_TYPE, REGION) VALUES (src.VEHICLE_TYPE, src.REGION) WHEN MATCHED THEN UPDATE SET VEHICLE_TYPE = src.VEHICLE_TYPE, REGION = src.REGION;
```

```sql
-- 5c: PLACES from Overture Maps (substitute geohash literal)
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-route-optimization","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT
    'SanFrancisco' AS REGION,
    GEOMETRY,
    PHONES[0]::TEXT AS PHONES,
    CATEGORIES:primary::TEXT AS CATEGORY,
    NAMES:primary::TEXT AS NAME,
    ADDRESSES[0] AS ADDRESS,
    COALESCE(CATEGORIES:alternate:list, ARRAY_CONSTRUCT()) AS ALTERNATE
FROM OVERTURE_MAPS__PLACES.CARTO.PLACE
WHERE ST_GEOHASH(GEOMETRY, 2) = '9q'
  AND CATEGORIES:primary IS NOT NULL;
```

```sql
-- 5d: Search optimization
ALTER TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES ADD SEARCH OPTIMIZATION ON GEO(GEOMETRY);
ALTER TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES ADD SEARCH OPTIMIZATION ON EQUALITY(ALTERNATE);
```

```sql
-- 5e: JOB_TEMPLATE (29 delivery jobs with time windows and skills)
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.JOB_TEMPLATE (ID INT AUTOINCREMENT PRIMARY KEY, SLOT_START INT NOT NULL, SLOT_END INT, SKILLS INT, PRODUCT STRING, STATUS STRING DEFAULT 'active', REGION STRING) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-route-optimization","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
INSERT INTO FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.JOB_TEMPLATE (SLOT_START, SLOT_END, SKILLS, PRODUCT, STATUS, REGION)
SELECT column1, column2, column3, column4, 'active', 'SanFrancisco' FROM VALUES
(9,10,1,'pa'),(11,15,2,'pb'),(16,18,2,'pb'),(11,13,3,'pc'),(7,16,3,'pc'),
(10,15,2,'pa'),(10,15,2,'pa'),(7,16,1,'pa'),(9,18,2,'pb'),(13,18,2,'pb'),
(13,18,2,'pb'),(13,18,1,'pa'),(13,18,1,'pa'),(13,18,1,'pa'),(13,18,3,'pc'),
(11,15,2,'pb'),(16,18,2,'pb'),(11,13,1,'pa'),(7,16,1,'pa'),(10,15,2,'pb'),
(10,15,2,'pb'),(7,16,1,'pa'),(9,18,2,'pb'),(13,18,2,'pb'),(13,18,2,'pb'),
(13,18,1,'pa'),(13,18,1,'pa'),(13,18,1,'pa'),(13,18,3,'pc');
```

```sql
-- 5f: LOOKUP (4 industries - customize per references/industry-customization.md)
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP (REGION STRING, INDUSTRY STRING, PA STRING, PB STRING, PC STRING, IND ARRAY, IND2 ARRAY, CTYPE ARRAY, STYPE ARRAY) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-route-optimization","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
INSERT INTO FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP (REGION, INDUSTRY, PA, PB, PC, IND, IND2, CTYPE, STYPE)
SELECT 'SanFrancisco', 'healthcare', 'flammable', 'sharps', 'temperature-controlled',
       ARRAY_CONSTRUCT('hospital health pharmaceutical drug healthcare pharmacy surgical'),
       ARRAY_CONSTRUCT('supplies warehouse depot distribution wholesaler distributors'),
       ARRAY_CONSTRUCT('hospital', 'family_practice', 'dentist', 'pharmacy'),
       ARRAY_CONSTRUCT('Can handle potentially explosive goods', 'Can handle instruments that could be used as weapons', 'Has a fridge')
UNION ALL
SELECT 'SanFrancisco', 'Food', 'Fresh Food Order', 'Frozen Food Order', 'Non Perishable Food Order',
       ARRAY_CONSTRUCT('food vegatables meat vegatable'),
       ARRAY_CONSTRUCT('wholesaler warehouse factory processing distribution distributors'),
       ARRAY_CONSTRUCT('supermarket', 'restaurant', 'butcher_shop'),
       ARRAY_CONSTRUCT('Can deliver Fresh Food', 'Has a Fridge', 'Premium Delivery')
UNION ALL
SELECT 'SanFrancisco', 'Cosmetics', 'Hair Products', 'Electronic Goods', 'Make-up',
       ARRAY_CONSTRUCT('hair cosmetics make-up beauty'),
       ARRAY_CONSTRUCT('wholesaler warehouse factory supplies distribution distributors'),
       ARRAY_CONSTRUCT('supermarket', 'outlet', 'fashion'),
       ARRAY_CONSTRUCT('Can deliver Fresh Food', 'Has a Fridge', 'Premium Delivery')
UNION ALL
SELECT 'SanFrancisco', 'Beverages', 'Alcoholic Beverages', 'Carbonated Drinks', 'Still Water',
       ARRAY_CONSTRUCT('beverage drink brewery distillery bottling winery'),
       ARRAY_CONSTRUCT('warehouse distribution depot factory wholesaler'),
       ARRAY_CONSTRUCT('bar', 'pub', 'restaurant', 'hotel', 'supermarket', 'convenience_store'),
       ARRAY_CONSTRUCT('Age Verification Required', 'Fragile Goods Handler', 'Heavy Load Capacity');
```

4. Verify:
   ```sql
   SELECT 'PLACES' AS TBL, COUNT(*) AS CNT FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES
   UNION ALL SELECT 'LOOKUP', COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP
   UNION ALL SELECT 'JOB_TEMPLATE', COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.JOB_TEMPLATE;
   ```
   Expected: PLACES 50K–1.5M (depends on geohash density), LOOKUP 4, JOB_TEMPLATE 29. **STOP** if any table has 0 rows.

**Output:** Standing data populated for `<REGION_NAME>`.

### Step 6: Check Claude Model

**Goal:** Verify latest Claude Sonnet model is available in Snowflake Cortex.

> See `references/notebook-deployment.md` (Step 7) for the test SQL and update instructions.

### Step 7: Deploy AISQL Notebook

**Goal:** Deploy the AISQL exploration notebook, customized for `<NOTEBOOK_CITY>`.

> **Required for full demo:** The AISQL notebook provides the interactive route optimization experience in Snowsight. Without it, only the seed data tables are deployed and the Route Optimization page in the control app will have its VRP simulator but no notebook-driven workflow. If you skip this step now, you can add it later by following [references/notebook-deployment.md](references/notebook-deployment.md).

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
| OPENROUTESERVICE_APP.CORE.ISOCHRONES | Catchment preview (TABLE function) |
| OPENROUTESERVICE_APP.CORE.OPTIMIZATION | VRP solver |
| OPENROUTESERVICE_APP.CORE.DIRECTIONS | Per-vehicle route geometry (TABLE function) |
| SNOWFLAKE.CORTEX.COMPLETE | AI geocoding |

---

### Step 8: Verify

**Goal:** Confirm tables exist and Demo Dashboard shows the page.

1. Verify PLACES, LOOKUP, JOB_TEMPLATE tables have rows
2. Check Demo Dashboard loads Route Optimization page

## Stopping Points

- Step 1: STOP if OpenRouteService Native App is not installed
- Step 2: Wait for user to activate app if services not running
- Step 3: Confirm detected region, city, and industry choices with user
- Step 4: Verify Marketplace dataset accessible
- Step 5: Verify PLACES, LOOKUP, JOB_TEMPLATE tables are populated
- Step 6: Verify Claude model is available
- Step 8: Verify Demo Dashboard shows the Route Optimization page

## Troubleshooting

| Issue | Symptom | Solution |
|-------|---------|----------|
| **Stale config file** | Wrong region detected | Run `rm -rf /tmp/ors* /tmp/*ors*` before downloading config |
| Marketplace access denied | `CALL SYSTEM$ACCEPT_LEGAL_TERMS` fails | Requires IMPORT SHARE privilege (see Required Privileges section) |
| Notebook execution fails | `EXECUTE NOTEBOOK` errors | Check logs in Snowsight; verify `OVERTURE_MAPS__PLACES` accessible and warehouse active |
| Cortex model unavailable | "model not found" error | Try fallback model or set `CORTEX_ENABLED_CROSS_REGION = 'ANY_REGION'` |
| Services not starting | SUSPENDED or FAILED status | `CALL OPENROUTESERVICE_APP.CORE.RESUME_ALL_SERVICES()`; check compute pool capacity |
| Dashboard shows no data | Verify PLACES, LOOKUP, JOB_TEMPLATE tables are populated |
| Stage upload fails | Permission error | Verify WRITE privilege on stage and correct `--connection` |
| Wrong POI region | PLACES has wrong city data | Fix geohash in Step 5, re-run notebook |
| Custom industries missing | Dropdown shows old industries | Verify LOOKUP table; re-run from Step 5 |

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
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP;
DROP STAGE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.NOTEBOOK;
DROP SCHEMA IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION;
```

> **Tip:** Use the `cleanup` skill to auto-discover all tagged objects via COMMENT tracking.
