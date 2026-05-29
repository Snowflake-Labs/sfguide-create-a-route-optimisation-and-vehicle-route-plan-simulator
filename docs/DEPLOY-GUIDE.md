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
8. **Use `snow sql` for EXECUTE IMMEDIATE FROM** — The Cortex Code SQL tool (`snowflake_sql_execute`) returns error `391917` ("Invalid parameter... Allowed formats: jsonv2") for `EXECUTE IMMEDIATE FROM` when the staged file contains SQL scripting blocks (`BEGIN...END`, `$$` procedures). Use `snow sql -q "..."` via the Bash tool instead:
   ```bash
   snow sql -q "USE WAREHOUSE ROUTING_DEPLOY; USE SCHEMA OPENROUTESERVICE_APP.CORE; EXECUTE IMMEDIATE FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/deploy/path/to/module.sql;"
   ```
   This works reliably for all modules. Simple DDL (CREATE TABLE, CREATE FUNCTION) can still use `snowflake_sql_execute` directly.

## Execution Order

### Phase 1: Core Infrastructure (modules 00-06)

Upload all workspace files to `@OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/deploy/`, then execute modules 00→06 sequentially. This installs Overture Maps (Places, Addresses, Buildings), creates compute pool, starts 5 SPCS services, and deploys routing functions (DIRECTIONS, ISOCHRONES, MATRIX, OPTIMIZE).

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

### Phase 4: Agent Tools & Intelligence

**First:** `setup-agent-playground/references/deploy-demo-data.sql` (creates SF_TOP_PHARMACIES, SF_DRUG_FORMULARY, SF_HEALTH_DEMOGRAPHICS — required by pharma intelligence)

Then in order:
1. `add-weather-routing/references/deploy-weather-tool.sql`
2. `add-pharma-supply-chain/references/deploy-pharma-supply-chain.sql`
3. `add-pharma-supply-chain/references/deploy-robot-telemetry.sql`
4. `add-plant-map/references/build-plant-footprints.sql` (VIEW + ST_DWITHIN, not CTAS)
5. `add-pharma-intelligence/references/deploy-pharma-data.sql`
6. `add-pharma-intelligence/references/deploy-pharma-tools.sql`
7. `add-fleet-analytics/references/deploy-fleet-analytics.sql`

### Phase 5: Agent + Streamlit

1. `setup-agent-playground/references/deploy-semantic-view.sql`
2. `setup-agent-playground/references/configure-agent.sql`
3. Create Fleet Explorer Streamlit app
4. Upload `agent-demos.json` to stage

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
| `EXECUTE IMMEDIATE FROM` fails with 391917 | all modules | Cortex Code SQL tool can't handle scripting block results. Use `snow sql -q` via Bash tool instead (see Deployment Rule 8) |
| VRP industries empty (region mismatch) | route-optimization | `$REGION_NAME` session variables don't resolve in CTAS/INSERT inside `EXECUTE IMMEDIATE FROM`. Fixed: replaced `$VAR` with `GETVARIABLE('VAR')` which works in all contexts |

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
