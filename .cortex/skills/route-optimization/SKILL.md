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

## Optional Dependencies

| Skill | Used By | Behavior if missing |
|-------|---------|---------------------|
| `dwell-analysis` | Asset Velocity page | Page renders a friendly empty state pointing the user to deploy `dwell-analysis`. The core Route Optimizer (VRP) keeps working. |

## Asset Velocity (Non-Moving Trailer Detection & Action Engine)

This skill ships a second React page in the control app, **Asset Velocity**, that materialises an industry-standard ghost-trailer detection workflow. It is fully additive - the existing Route Optimizer (VRP) page is untouched.

It reuses the dwell-analysis Dynamic Tables (no new DTs) and adds four thin views in `FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION`:

| View | Purpose |
|------|---------|
| `VW_IDLE_TRAILERS` | Latest dwell session per HGV, with idle duration metrics, deterministic dispatcher mapping, and an exception filter that drops `MAINTENANCE` statuses and `OUTLIER` driver profiles. |
| `VW_LANE_DEMAND` | Net outbound trips per terminal over the most recent 30 days of `FACT_TRIPS`. High `DEMAND_SCORE` = trailer-short terminal. |
| `VW_FLEET_HGV_PROFILE` | (v1.1) Resilient HGV-attribute view (subtype, weight, height, length, axleload, hazmat). Coalesces against deterministic defaults so the page works even after Data Studio regenerates `DIM_FLEET`. |
| `VW_TRAILER_COST_OF_IDLENESS` | Joins `VW_IDLE_TRAILERS` with `CONFIG.DAILY_RENTAL_RATE_AVOIDED_USD` and `CONFIG.RENTAL_CAPTURE_RATE` to compute cost-of-idleness, projected savings, and severity bucket. (v1.1) Also exposes per-trailer HGV attrs and CONFIG.MAX_REPOSITION_MINUTES / CONFIG.AVOID_FEATURES so the React page can build trailer-specific ORS profile_params. |

Full use case framing, cross-vertical applicability, and risk mitigations live in [references/asset-velocity-use-case.md](references/asset-velocity-use-case.md).

### Smart-reposition (v1.1)

The Asset Velocity page now uses real ORS + VROOM features instead of Euclidean math:

| Feature | Underlying call | Effect |
|---------|-----------------|--------|
| Road-network shortlist | `OPENROUTESERVICE_APP.CORE.MATRIX('driving-hgv', options, region)` with `profile_params.restrictions` envelope | Replaces `Math.hypot(dLng, dLat)` with HGV-aware road duration. |
| Reachability gate | Matrix `durations[r][c]` vs `CONFIG.MAX_REPOSITION_MINUTES` | Terminals outside the shift are excluded with reason `OUT_OF_SHIFT`. |
| Reachability polygon | `OPENROUTESERVICE_APP.CORE.ISOCHRONES('driving-hgv', lng, lat, range, region)` | Selected trailer's polygon overlays the deck.gl map. |
| Multi-constraint VROOM | `OPENROUTESERVICE_APP.CORE.OPTIMIZATION(challenge, region)` with `time_windows`, `skills`, multi-dim `capacity`, `service`, `breaks`, `costs.fixed`, `max_travel_time` | Real bipartite assignment under driver shift, EU 561/2006 break, and trailer-subtype skill matching. |
| HGV restrictions | `options.profile_params.restrictions` (weight/height/length/width/axleload/hazmat) + `options.avoid_features` | Routes avoid weight-restricted bridges, low overpasses, hazmat-banned roads, and (configurable) tollways/ferries. |

Known limitations (synthetic data):
- The wrapped `ISOCHRONES(...)` UDF does not yet pass `profile_params` through, so the polygon is profile-only (the matrix gate is the authoritative filter).
- `DIM_POIS` has no `OPEN_FROM/OPEN_TO`, so terminal time windows default to 06:00–22:00 UTC.
- `LANE_PROFILE` does not exist on terminals; skill-mismatch heuristics treat `RESTAURANT` POIs as REEFER-required and everything else as DRY-friendly.

### Deploy the Asset Velocity views

Prerequisites: `dwell-analysis` skill deployed.

```bash
snow sql -f .cortex/skills/route-optimization/references/extend-dim-fleet-hgv.sql -c <connection>
snow sql -f .cortex/skills/route-optimization/references/asset-velocity-views.sql -c <connection>
```

Verify:
```sql
SELECT 'VW_IDLE_TRAILERS' AS V, COUNT(*) AS CNT FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.VW_IDLE_TRAILERS
UNION ALL
SELECT 'VW_LANE_DEMAND',         COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.VW_LANE_DEMAND
UNION ALL
SELECT 'VW_TRAILER_COST_OF_IDLENESS', COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.VW_TRAILER_COST_OF_IDLENESS;
```

The page will gracefully render an empty state with deployment instructions if `DWELL_ANALYSIS.DT_DWELL_ENRICHED` is missing.

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| DATABASE | `FLEET_INTELLIGENCE` | Database for demo objects |
| SCHEMA | `ROUTE_OPTIMIZATION` | Schema for VRP tables and notebooks |
| WAREHOUSE | `ROUTING_ANALYTICS` | Warehouse for queries |
| MARKETPLACE_CARTO | `CARTO Academy` | CARTO Academy Marketplace listing name |
| `CONFIG.DAILY_RENTAL_RATE_AVOIDED_USD` | `80.00` | Daily $ saved per trailer hour returned to the network. |
| `CONFIG.RENTAL_CAPTURE_RATE` | `0.600` | Fraction of theoretical idle-cost the operator believes they can capture (60%). |
| `CONFIG.MAX_REPOSITION_MINUTES` | `600` | Driver shift cap (minutes). Drives the matrix reachability gate, the isochrone range, and VROOM `time_window` / `max_travel_time`. |
| `CONFIG.AVOID_FEATURES` | `tollways,ferries` | Comma-separated ORS `avoid_features` list (passed via Matrix `options`). |

## Error Logging

> Follow the Error Logging convention in AGENTS.md. Log file prefix: `route-optimization`.

## Execution Rules

1. Never use bulk `sed` or `replace_all` on `.ipynb` files — notebooks are JSON with structured cell arrays. Use targeted replacements on specific cells identified by name.
2. Replace longer phrases before shorter ones when editing notebook prompts to avoid garbled text.
3. Replace complete prompt strings, not individual words.
4. Always validate JSON validity of modified `.ipynb` files before uploading.

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
3. Run:
   ```bash
   snow sql -f .cortex/skills/route-optimization/references/seed-data.sql -c <connection>
   ```
4. Verify:
   ```sql
   SELECT 'PLACES' AS TBL, COUNT(*) AS CNT FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES
   UNION ALL SELECT 'LOOKUP', COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP
   UNION ALL SELECT 'JOB_TEMPLATE', COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.JOB_TEMPLATE;
   ```
   Expected: PLACES 50K-500K, LOOKUP 4, JOB_TEMPLATE 29. **STOP** if any table has 0 rows.

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

### VW_IDLE_TRAILERS (Asset Velocity)
| Column | Type | Used By |
|--------|------|---------|
| VEHICLE_ID | VARCHAR | AssetVelocity (trailer id) |
| REGION | VARCHAR | AssetVelocity (region filter) |
| LAST_LOCATION_NAME | VARCHAR | AssetVelocity (table + tooltip) |
| LAST_LOCATION_TYPE | VARCHAR | AssetVelocity (table) |
| LAST_LOCATION_GEOM | GEOGRAPHY | AssetVelocity (deck.gl) |
| LAST_LNG / LAST_LAT | FLOAT | AssetVelocity (deck.gl getPosition) |
| IDLE_SINCE | TIMESTAMP | AssetVelocity (tooltip) |
| IDLE_HOURS / IDLE_DAYS | NUMBER | AssetVelocity (KPIs, sort, severity) |
| ASSIGNED_DISPATCHER | VARCHAR | AssetVelocity (table) |

### VW_LANE_DEMAND (Asset Velocity)
| Column | Type | Used By |
|--------|------|---------|
| TERMINAL_ID / TERMINAL_NAME | VARCHAR | AssetVelocity (tooltip + VRP jobs) |
| TERMINAL_LAT / TERMINAL_LNG | FLOAT | AssetVelocity (deck.gl + VRP) |
| NET_OUTBOUND_TRIPS / DEMAND_SCORE | NUMBER | AssetVelocity (sort + VRP priority) |

### VW_TRAILER_COST_OF_IDLENESS (Asset Velocity)
| Column | Type | Used By |
|--------|------|---------|
| COST_OF_IDLENESS_USD | NUMBER | AssetVelocity (KPI + sort) |
| PROJECTED_SAVINGS_USD | NUMBER | AssetVelocity (KPI) |
| IDLE_SEVERITY | VARCHAR | AssetVelocity (color + badge) |

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
DROP VIEW IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.VW_TRAILER_COST_OF_IDLENESS;
DROP VIEW IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.VW_LANE_DEMAND;
DROP VIEW IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.VW_IDLE_TRAILERS;
DROP VIEW IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.VW_FLEET_HGV_PROFILE;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP;
DROP STAGE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.NOTEBOOK;
DROP SCHEMA IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION;

-- v1.1 also added HGV columns to DIM_FLEET. They are non-destructive (NULL for
-- non-trucking modes) and the column-add is idempotent, so cleanup is optional.
-- If a fully clean DIM_FLEET is required (e.g. before regenerating via Data
-- Studio), drop them with:
ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET DROP COLUMN IF EXISTS WEIGHT_TONS;
ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET DROP COLUMN IF EXISTS HEIGHT_M;
ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET DROP COLUMN IF EXISTS LENGTH_M;
ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET DROP COLUMN IF EXISTS WIDTH_M;
ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET DROP COLUMN IF EXISTS AXLELOAD_T;
ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET DROP COLUMN IF EXISTS HAZMAT;
ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET DROP COLUMN IF EXISTS VEHICLE_SUBTYPE;
```

> **Tip:** Use the `cleanup` skill to auto-discover all tagged objects via COMMENT tracking.
