# Reference Architecture v5: Complete ORS Rework

## Summary of All Work Items

| # | Item | Scope |
|---|------|-------|
| A | Architecture decomposition (ORS app + React UI) | `build-routing-solution`, `fleet-intelligence-food-delivery` |
| B | _GEO function migration | `taxis`, `food-delivery`, `route-optimization`, `retail-catchment` |
| C | Tracking tags compliance | `dwell-analysis`, `synthetic-datasets-generator`, `travel-time-matrix`, `food-delivery`, `routing-agent`, `route-deviation` |
| D | Legacy ORS name cleanup | `retail-catchment` |
| E | Standardized ORS resume pattern | All demo skills |
| F | Remove old Streamlit control_app | `build-routing-solution` |
| G | Standardized ORS dependency check | All demo skills |

---

## A. Architecture Decomposition

### A1. ORS CORE Schema — Enhanced

Add to `build-routing-solution/Native_app/app/setup_script.sql`:

```
── Multi-City (from food delivery routing schema) ──
SETUP_CITY_ORS(region, pbf_url)
RESUME_CITY_ORS(region) / DROP_CITY_ORS(region)
LIST_CITIES()
DIRECTIONS_{REGION} / MATRIX_{REGION} (dynamic)
CITY_ORS_MAP config table

── Service Lifecycle (from food delivery core) ──
RESUME_ALL_SERVICES() / SUSPEND_ALL_SERVICES()
SCALE_SERVICES(min, max)
GET_STATUS() → JSON
CHECK_HEALTH() → boolean

── Travel Time Matrix Pipeline (from food delivery data + travel-time-matrix) ──
BUILD_HEXAGONS(resolution, bbox)
BUILD_WORK_QUEUE(resolution)
BUILD_TRAVEL_TIME_RANGE(resolution, start, end)
FLATTEN_MATRIX_RAW(resolution, region)
BUILD_TRAVEL_TIME_MATRIX(resolution, bbox)
MATRIX_PROGRESS() / RESET_MATRIX_DATA(resolution)
CREATE/START/STOP_MATRIX_DAG
Tables: H3_RES{N}, WORK_QUEUE_RES{N}, MATRIX_RAW_RES{N}, TRAVEL_TIME_RES{N}
```

### A2. React Management UI (replaces Streamlit control_app)

New SPCS service `ors_control_app`:

| Component | Source | Effort |
|-----------|--------|--------|
| City Provisioner | food-delivery DataBuilder (extract) | Low |
| Matrix Builder | food-delivery MatrixBuilder (extract) | Low |
| Service Manager | Streamlit app.py (rewrite) | Medium |
| Function Tester | Streamlit function_tester.py (rewrite) | High (~1700 lines) |

New files:
```
build-routing-solution/
  Native_app/
    services/
      ors_control_app/
        server/index.ts
        src/App.tsx
        src/components/
          ServiceManager.tsx
          FunctionTester.tsx
          CityProvisioner.tsx
          MatrixBuilder.tsx
        Dockerfile
        package.json
      ors_control_app_service.yaml
```

Docker images: 4 existing + 1 new (`ors_control_app:v1.0.0`)

### A3. Strip Food Delivery Native App

**Remove (~1030 lines):**
- `routing` schema entirely (~350 lines)
- Matrix pipeline procs from `data` schema (~600 lines)
- ORS lifecycle from `core` schema (~80 lines)
- ORS Docker images from `manifest.yml` (4 images)
- DataBuilder ORS provisioning from React
- MatrixBuilder from React
- `deploy_full()` — keep only `deploy()`

**Keep (~750 lines):**
- `core`: React UI service, status launcher, deploy(), grant_callback
- `data`: 11 delivery tables, 5 views, PREDICT_DELIVERY_ETA, data pipeline
- React: FleetMap, ChatPanel, StatsPanel, CatchmentPanel, DataBuilder (delivery steps only)

**Update:**
- `server/index.ts`: Remove `CITY_ORS_MAP`, `provisionOrsForRegion()`, all `routing.*` calls → use `OPENROUTESERVICE_NATIVE_APP.CORE.*`
- `manifest.yml`: Remove ORS image references
- Add `check_ors_ready()` procedure

### A4. Simplify travel-time-matrix Skill

Rewrite as a usage guide for `OPENROUTESERVICE_NATIVE_APP.CORE.*` matrix procs + Matrix Builder UI. No standalone SQL procedures.

---

## B. _GEO Function Migration

Replace manual VARIANT/JSON parsing with `_GEO` table function variants where available.

| Skill | Current Pattern | Target Pattern | Function |
|-------|----------------|----------------|----------|
| `fleet-intelligence-taxis` | `DIRECTIONS(profile, origin, dest)` → `TRY_TO_GEOGRAPHY(PARSE_JSON(ROUTE_RESPONSE):features[0]:geometry)` | `DIRECTIONS_GEO(profile, coords)` → returns `ROUTE_LINE`, `DISTANCE_M`, `DURATION_S` directly | `DIRECTIONS_GEO` |
| `fleet-intelligence-food-delivery` | Same manual parsing pattern | Same migration to `DIRECTIONS_GEO` | `DIRECTIONS_GEO` |
| `route-optimization` (Streamlit) | `DIRECTIONS(profile, coords)` → parse JSON | `DIRECTIONS_GEO(profile, coords)` | `DIRECTIONS_GEO` |
| `route-optimization` (Streamlit) | `ISOCHRONES(profile, lon, lat, range)` → parse JSON | `ISOCHRONES_GEO(profile, lon, lat, range)` | `ISOCHRONES_GEO` |
| `route-optimization` (Streamlit) | `OPTIMIZATION(jobs, vehicles)` → parse JSON | `OPTIMIZATION_GEO(jobs, vehicles)` | `OPTIMIZATION_GEO` |
| `retail-catchment` | `ISOCHRONES(profile, lon, lat, range)` → parse JSON | `ISOCHRONES_GEO(profile, lon, lat, range)` | `ISOCHRONES_GEO` |
| `route-deviation` | Already uses `DIRECTIONS_GEO` | No change | — |

**Note:** `MATRIX` and `MATRIX_TABULAR` have no `_GEO` variant (matrices return numeric duration/distance, not geometry). No change needed for matrix calls.

**Files to update:**
- `.cortex/skills/fleet-intelligence-taxis/references/sql-pipeline.md`
- `.cortex/skills/fleet-intelligence-food-delivery/references/sql-pipeline.md`
- `.cortex/skills/route-optimization/assets/streamlit/routing.py`
- `.cortex/skills/route-optimization/assets/notebooks/routing_functions_aisql.ipynb`
- `.cortex/skills/retail-catchment/assets/streamlit/retail_catchment.py`

---

## C. Tracking Tags Compliance

Add COMMENT tags to all CREATE statements so the `cleanup` skill can discover and remove objects.

**Tag format:**
```sql
CREATE TABLE ... 
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"<skill-name>","version":"1.0","attributes":{"component":"<component>"}}';
```

**Session query_tag format:**
```sql
ALTER SESSION SET QUERY_TAG = '{"origin":"sf_sit-is-fleet","name":"<skill-name>","version":"1.0"}';
```

| Skill | CREATE Statements | Status |
|-------|-------------------|--------|
| `dwell-analysis` | ~15 (Dynamic Tables, views) | Missing all tags |
| `synthetic-datasets-generator` | ~20 (tables, stages, procedures) | Missing all tags |
| `travel-time-matrix` | ~14 (tables, procedures, tasks) | Missing all tags |
| `fleet-intelligence-food-delivery/setup_script.sql` | ~80 (after stripping, ~40 remain) | Missing all tags |
| `routing-agent` | 1 agent + 3 procedures | Wrong format (missing attributes) |
| `route-deviation` | ~15 (tables, views, dynamic tables) | Incomplete format (missing origin field) |
| `build-routing-solution/setup_script.sql` | ~30 (services, functions, tables) + new procs | Missing all tags |

**Also add `ALTER SESSION SET QUERY_TAG` at the top of every SQL pipeline** in skill references.

---

## D. Legacy ORS Name Cleanup

**File:** `.cortex/skills/retail-catchment/assets/streamlit/retail_catchment.py`

Remove `OPEN_ROUTE_SERVICE_SAN_FRANCISCO` from the ORS app dropdown (line ~72). Only `OPENROUTESERVICE_NATIVE_APP` should remain. Remove the dropdown entirely since there's only one option — hardcode the app name.

---

## E. Standardized ORS Resume Pattern

Replace ad-hoc resume commands across all skills with a single call:

```sql
-- Before (repeated in every skill, 4-8 lines):
ALTER COMPUTE POOL ... RESUME;
ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SERVICE RESUME;
ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.VROOM_SERVICE RESUME;
ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.ROUTING_GATEWAY_SERVICE RESUME;

-- After (one line):
CALL OPENROUTESERVICE_NATIVE_APP.CORE.RESUME_ALL_SERVICES();
```

| Skill | File with ad-hoc resume | Lines |
|-------|-------------------------|-------|
| `fleet-intelligence-taxis` | `references/sql-pipeline.md` Step 2 | ~15 lines |
| `fleet-intelligence-food-delivery` | `references/sql-pipeline.md` Step 2 | ~15 lines |
| `route-optimization` | `references/sql-setup.md` | ~8 lines |
| `retail-catchment` | `assets/streamlit/retail_catchment.py` (runtime) | ~5 lines |
| `route-deviation` | `references/sql-pipeline.md` | ~8 lines |
| `routing-agent` | `references/agent-definitions.md` (setup) | ~5 lines |

---

## F. Remove Old Streamlit Control App

**Delete files:**
- `build-routing-solution/Native_app/code_artifacts/streamlit/app.py`
- `build-routing-solution/Native_app/code_artifacts/streamlit/pages/function_tester.py`
- Possibly the entire `code_artifacts/streamlit/` directory

**Update `setup_script.sql`:**
- Remove `CREATE STREAMLIT core.control_app` definition
- Remove Streamlit-related grants
- Add `CREATE SERVICE core.ors_control_app` definition

---

## G. Standardized ORS Dependency Check

Add a consistent "verify ORS is ready" pattern to every demo skill's pipeline:

```sql
-- Standard ORS readiness check (add to every skill pipeline start):
SELECT OPENROUTESERVICE_NATIVE_APP.CORE.ORS_STATUS();
-- Returns 'ready' if gateway is responding, error otherwise
```

Or with the new lifecycle proc:
```sql
SELECT OPENROUTESERVICE_NATIVE_APP.CORE.CHECK_HEALTH();
-- Returns TRUE/FALSE
```

Add this as Step 0 in every skill's `sql-pipeline.md` or equivalent setup doc.

| Skill | Has ORS check today? |
|-------|---------------------|
| `fleet-intelligence-taxis` | Partial (SHOW SERVICES, manual) |
| `fleet-intelligence-food-delivery` | Partial (DESCRIBE SERVICE) |
| `route-optimization` | No |
| `retail-catchment` | No |
| `route-deviation` | No |
| `routing-agent` | No |
| `synthetic-datasets-generator` | No |

---

## Migration Phases (All Items)

| Phase | Item | Task | Risk |
|-------|------|------|------|
| **1** | A1 | Add lifecycle + multi-city + matrix procs to CORE in ORS `setup_script.sql` | Medium |
| **2** | C | Add tracking COMMENT tags to all CREATE statements in ORS `setup_script.sql` | Low |
| **3** | A2 | Create React `ors_control_app` — extract City Provisioner + Matrix Builder from food delivery | Medium |
| **4** | A2 | Rewrite Service Manager + Function Tester as React components | High |
| **5** | A2 | Build Docker image, add to manifest.yml, wire SPCS service | Medium |
| **6** | F | Remove old Streamlit control_app files and definition | Low |
| **7** | A3 | Strip food delivery native app (remove routing, matrix, ORS UI) | High |
| **8** | A3 | Update food delivery React server to call ORS CORE functions | Medium |
| **9** | B | Migrate _GEO functions in taxis, food-delivery, route-optimization, retail-catchment | Medium |
| **10** | C | Add tracking tags to dwell-analysis, synthetic-datasets-generator, travel-time-matrix, routing-agent, route-deviation | Low |
| **11** | D | Remove legacy `OPEN_ROUTE_SERVICE_SAN_FRANCISCO` from retail-catchment | Low |
| **12** | E | Replace ad-hoc ORS resume commands with `CORE.RESUME_ALL_SERVICES()` across all skills | Low |
| **13** | G | Add standard ORS readiness check to all demo skill pipelines | Low |
| **14** | A4 | Simplify travel-time-matrix skill to usage guide | Low |
| **15** | — | Final review: verify all skill docs reference correct paths, dependency graph is documented | Low |

---

## Dependency Graph (Target State)

```
routing-prerequisites
    │
    ▼
build-routing-solution ──► OPENROUTESERVICE_NATIVE_APP
    │                       CORE: engine + multi-city + matrix + lifecycle
    │                       UI: React (services, functions, cities, matrix)
    │                       6 SPCS services, 5 Docker images
    │                       All objects with tracking COMMENT tags
    │
    ├──► routing-customization
    │
    ├──► fleet-intelligence-taxis        (uses DIRECTIONS_GEO, RESUME_ALL, CHECK_HEALTH)
    ├──► fleet-intelligence-food-delivery (React: delivery domain, uses DIRECTIONS_GEO)
    ├──► route-optimization              (uses DIRECTIONS_GEO, ISOCHRONES_GEO, OPTIMIZATION_GEO)
    ├──► retail-catchment                (uses ISOCHRONES_GEO, no legacy dropdown)
    ├──► route-deviation ◄── synthetic-datasets-generator  (already uses DIRECTIONS_GEO)
    ├──► routing-agent
    ├──► travel-time-matrix              (usage guide for CORE.MATRIX pipeline)
    └──► dwell-analysis                  (no ORS calls, all objects tagged)
```
