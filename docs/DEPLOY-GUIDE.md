# Full Stack Deployment Guide

## Prerequisites

- `OPENROUTESERVICE_APP` database exists with all container images pushed to `CORE.IMAGE_REPOSITORY`
- `ACCOUNTADMIN` role
- This workspace open in Cortex Code

## Warehouse Strategy

Embedded in `deploy-all.sql` — no manual setup needed:
- **`ROUTING_DEPLOY`** (LARGE) — created at start, used for Phases 1-5 (heavy Overture Maps scans)
- **`ROUTING_ANALYTICS`** (XS) — created at start, switched to after deployment for day-to-day queries
- `ROUTING_DEPLOY` is **auto-dropped** at the end of deployment (Phase 6)

## Deployment Rules

1. **One SQL statement per tool call** — multi-statement blocks silently fail
2. **Fully qualified names always** — session context doesn't persist between calls
3. **LARGE warehouse for geospatial ops** — Overture Maps queries timeout on XS/S
4. **Verify services RUNNING** before creating routing functions
5. **All objects need COMMENT tracking tags** per AGENTS.md
6. **Log errors** to `logs/` per error logging convention
7. **Stage layout is critical** — `ors-config.yml` and map files go ONLY in `@stage/{RegionName}/` (e.g. `SanFrancisco/`). The control app discovers regions by scanning for `*ors-config*` files and uses the parent folder name as the region identifier. A file at `config/ors-config.yml` would create a phantom region called "config".
8. **EXECUTE IMMEDIATE FROM works via `snowflake_sql_execute`** — Use `snowflake_sql_execute` directly for all `EXECUTE IMMEDIATE FROM` statements. If a module returns error `391917` ("Invalid parameter... Allowed formats: jsonv2"), the SQL still executed successfully — verify by checking that the created objects exist. This is a result-format parsing issue, not an execution failure. No `snow sql` or cloud agents required.

## Execution Order

### Phase 1: Core Infrastructure (modules 00-06)

**Upload workspace files to stage — TWO SEPARATE COMMANDS:**

```sql
-- 1. Upload SQL files only to deploy/ (safe — no ors-config contamination)
COPY FILES INTO @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/deploy/
FROM 'snow://workspace/.../versions/live/'
PATTERN='.*\.sql';

-- 2. Upload parquet data to SEED_DATA_STAGE (separate stage, no conflicts)
COPY FILES INTO @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/
FROM 'snow://workspace/.../versions/live/datasets/'
PATTERN='.*\.parquet';

-- 3. Upload service specs INDIVIDUALLY to their correct paths:
--    @ORS_SPCS_STAGE/services/downloader/downloader_spec.yaml
--    @ORS_SPCS_STAGE/services/openrouteservice/openrouteservice.yaml
--    @ORS_SPCS_STAGE/services/ors_control_app/ors_control_app_service.yaml
--    @ORS_SPCS_STAGE/services/vroom/vroom-service.yaml
--    @ORS_SPCS_STAGE/services/gateway/routing-gateway-service.yaml

-- 4. Upload ors-config.yml ONLY to the region folder:
--    @ORS_SPCS_STAGE/SanFrancisco/ors-config.yml
```

Then execute modules 00→06 sequentially. This installs Overture Maps (Places, Addresses, Buildings), creates compute pool, starts 5 SPCS services, and deploys routing functions (DIRECTIONS, ISOCHRONES, MATRIX, OPTIMIZE).

> **WARNING:** Do NOT use `PATTERN='.*\.(yaml|yml)'` — this uploads `ors-config.yml` to `deploy/` which creates phantom regions that break Retail Catchment (empty city dropdown) and Route Optimization (wrong region context).

Wait for all 5 services to reach RUNNING before proceeding.

### Phase 2: Seed Data

Execute `datasets/load-seed-data.sql` — creates UNIFIED tables with correct schema (including route-deviation columns) and loads parquet from `@SEED_DATA_STAGE`.

### Phase 3: Demo Skills

Execute each skill's reference SQL in order:
1. `fleet-intelligence-taxis/references/seed-data.sql`
2. `fleet-intelligence-food-delivery/references/sql-projection-views.sql`
3. `route-deviation/references/seed-data.sql`
4. `dwell-analysis/references/sql-pipeline.sql`
5. `route-optimization/references/seed-data.sql`
6. `retail-catchment/references/seed-data.sql`

### Phase 4: Data + Tool Procedures

Creates all backing tables and tool procedures. No semantic views or agent here.

**First:** `setup-agent-playground/references/deploy-demo-data.sql` (creates SF_TOP_PHARMACIES, SF_DRUG_FORMULARY, SF_HEALTH_DEMOGRAPHICS — required by pharma intelligence)

Then in order:
1. `add-weather-routing/references/deploy-weather-tool.sql`
2. `add-pharma-supply-chain/references/deploy-pharma-supply-chain.sql`
3. `add-pharma-supply-chain/references/deploy-robot-telemetry.sql` (data + PHARMA_SUPPLY_CHAIN_SV)
4. `add-plant-map/references/build-plant-footprints.sql` (VIEW + ST_DWITHIN, not CTAS)
5. `add-pharma-intelligence/references/deploy-pharma-data.sql`
6. `add-pharma-intelligence/references/deploy-pharma-tools.sql`
7. `add-pharma-intelligence/references/deploy-plant-impact-tool.sql` (TOOL_PLANT_IMPACT procedure)
8. `routing-agent/references/deploy-agent.sql` (TOOL_DIRECTIONS, TOOL_ISOCHRONE, TOOL_OPTIMIZATION, TOOL_SUPPLY_CHAIN)
9. `build-routing-solution/.../stored_procedures/tool_pharma_catchment.sql`
10. `add-plant-map/references/tool-create-plant.sql` (TOOL_CREATE_PLANT — creates plants with configurable robot_count)
11. `add-plant-map/references/tool-alter-plant.sql` (TOOL_ALTER_PLANT — resize/rename/re-status robots, all VARCHAR params)

### Phase 5: Semantic Views → Agent → Streamlit

**Order is critical:** semantic views first, then agent (references all views + tools), then Streamlit/config.

1. `add-fleet-analytics/references/deploy-fleet-analytics.sql` (FLEET_TRIPS_SV, FLEET_TELEMETRY_SV)
2. `setup-agent-playground/references/deploy-semantic-view.sql` (FLEET_ANALYTICS_VIEW)
3. `setup-agent-playground/references/configure-agent.sql` ← **MUST BE LAST** (references all tools + semantic views)
4. Create Fleet Explorer Streamlit app
5. Upload `agent-demos.json` to stage

## Known Pitfalls (fixed in codebase)

| Issue | Module | Fix Applied |
|-------|--------|-------------|
| `VALUES` + `ARRAY_CONSTRUCT()` fails | 08 | Changed to `INSERT...SELECT...UNION ALL` |
| Building footprints CTAS scans 2.5B rows (9 min) | 11, add-plant-map | Changed to CTAS with per-plant UNION ALL + literal ST_MAKEPOINT (~30s). A VIEW with JOIN doesn't push ST_DWITHIN through the spatial index |
| Correlated subquery not supported | 13 | Rewritten as CTE + `ROW_NUMBER()` |
| `SELECT...INTO` invalid in SQL scripting | 13 | Changed to `LET v_result := (SELECT...)` |
| SF_TOP_PHARMACIES not found | 13 | Moved `deploy-demo-data.sql` earlier in execution order |
| Missing FACT_TRIPS columns | 07 | `load-seed-data.sql` defines full schema (don't create tables manually) |
| Services without EAI/QUERY_WAREHOUSE | 01 | Never create services manually — always use module 01 (attaches EAIs, sets QUERY_WAREHOUSE, uses correct compute pools) |
| Map tiles not loading (blank map) | 01 | `ORS_CARTO_EAI` must be attached to ORS_CONTROL_APP service |
| Region catalog empty | 01+seed | `load-seed-data.sql` populates REGION_CATALOG (460 regions) + REGION_ORS_MAP |
| Region resolves as 'config' (industries empty) | stage layout | `ors-config.yml` must ONLY exist at `@stage/SanFrancisco/ors-config.yml`. NEVER upload to `@stage/config/` — the control app scans for `*ors-config*` and treats each parent folder as a region name |
| DOWNLOAD function not found | 01 | Module 01 calls `DOWNLOAD()` but it was defined in module 02. Fixed: inline CREATE FUNCTION in 01 before the SELECT call |
| ROUTING_AGENT schema not found | deploy-demo-data | `deploy-demo-data.sql` creates procs in `FLEET_INTELLIGENCE.ROUTING_AGENT` but didn't create the schema. Fixed: added CREATE SCHEMA IF NOT EXISTS at top |
| ORS_STATUS returns 404 | 02 | `_ORS_STATUS_RAW` was mapped to `/status` but gateway endpoint is `/ors_status`. Fixed in module 02 |
| `EXECUTE IMMEDIATE FROM` returns 391917 | all modules | This is a result-format parsing issue, NOT an execution failure. The SQL executes successfully — verify by checking created objects exist. No `snow sql` needed |
| VRP industries empty (region mismatch) | route-optimization | `$REGION_NAME` session variables don't resolve in CTAS/INSERT inside `EXECUTE IMMEDIATE FROM`. Fixed: replaced `$VAR` with `GETVARIABLE('VAR')` which works in all contexts |
| Agent tool identifiers mismatch | configure-agent | Agent spec referenced `TOOL_ISOCHRONES` and `TOOL_ROUTE_OPTIMIZATION` but actual procs are `TOOL_ISOCHRONE` and `TOOL_OPTIMIZATION`. Also `TOOL_PHARMA_CATCHMENT` and `TOOL_PLANT_IMPACT` weren't being deployed. Fixed: corrected identifiers and added missing deploy steps |
| PHARMA_SUPPLY_CHAIN_SV not found (agent 399504) | configure-agent | Agent references semantic view that didn't exist yet. Fixed: moved all semantic view creation to Phase 5 BEFORE `configure-agent.sql`. Agent must be created LAST after all tools + views exist |
| Agent refuses VARIANT/object params (unsupported type) | tool-alter-plant | Warehouse execution environment only supports scalar types. Fixed: changed VARIANT params to VARCHAR, PARSE_JSON inside procedure body. Tool_spec uses `type: string` not `type: object` |

## Verification

```sql
SHOW SERVICES IN DATABASE OPENROUTESERVICE_APP;  -- 5 services RUNNING
SELECT COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS;  -- 6008
SELECT COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES;  -- ~1.4M
SHOW AGENTS IN SCHEMA FLEET_INTELLIGENCE.ROUTING_AGENT;
SHOW STREAMLITS IN SCHEMA SYNTHETIC_DATASETS.UNIFIED;
```

## Cleanup

Warehouses are auto-managed by `deploy-all.sql` (ROUTING_DEPLOY is dropped in Phase 6). No manual cleanup needed.
