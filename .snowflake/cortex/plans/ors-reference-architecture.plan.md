---
name: "ors-reference-architecture"
created: "2026-03-19T17:10:25.926Z"
status: pending
---

# Reference Architecture: ORS + Demo Skills

## Design Principle

> **The ORS app owns ALL routing logic. Demo skills own ONLY domain data and UI.**

Every piece of code that touches ORS services, functions, matrix computation, map config, or service lifecycle belongs in `OPENROUTESERVICE_NATIVE_APP`. Demos only call published functions and manage their own tables/views.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                   OPENROUTESERVICE_NATIVE_APP                       │
│                   (build-routing-solution skill)                     │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  CORE schema (existing, enhanced)                            │   │
│  │                                                               │   │
│  │  Services: ORS, Vroom, Gateway, Downloader                   │   │
│  │  Infra:    Compute Pool, Stages, External Access             │   │
│  │                                                               │   │
│  │  Routing Functions:                                           │   │
│  │    DIRECTIONS / DIRECTIONS_GEO                                │   │
│  │    ISOCHRONES / ISOCHRONES_GEO                                │   │
│  │    OPTIMIZATION / OPTIMIZATION_GEO                            │   │
│  │    MATRIX / MATRIX_TABULAR                                    │   │
│  │    ORS_STATUS                                                 │   │
│  │                                                               │   │
│  │  Config:   MAP_CONFIG table                                   │   │
│  │  UI:       control_app (Streamlit service manager)            │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  MULTI_CITY schema (NEW — backported from food delivery)     │   │
│  │                                                               │   │
│  │  SETUP_CITY_ORS(region, pbf_url)                             │   │
│  │    → Spins up per-region ORS instance                        │   │
│  │    → Creates DIRECTIONS_{REGION}, MATRIX_{REGION} functions  │   │
│  │    → Uses gateway /city/ prefix routing                      │   │
│  │                                                               │   │
│  │  RESUME_CITY_ORS(region)                                     │   │
│  │  LIST_CITIES() → returns active city configs                 │   │
│  │  DROP_CITY_ORS(region)                                       │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  MATRIX schema (NEW — consolidated from food-delivery +      │   │
│  │                  travel-time-matrix)                          │   │
│  │                                                               │   │
│  │  BUILD_HEXAGONS(resolution, bbox)                            │   │
│  │  BUILD_WORK_QUEUE(resolution)                                │   │
│  │  BUILD_TRAVEL_TIME_RANGE(resolution, start, end)             │   │
│  │    → Resume-safe, retry-aware, exponential backoff           │   │
│  │  FLATTEN_MATRIX_RAW(resolution, region)                      │   │
│  │  BUILD_TRAVEL_TIME_MATRIX(resolution, bbox)                  │   │
│  │    → End-to-end orchestrator                                 │   │
│  │  MATRIX_PROGRESS()                                           │   │
│  │  RESET_MATRIX_DATA(resolution)                               │   │
│  │                                                               │   │
│  │  CREATE_MATRIX_DAG(resolution, num_workers, warehouse)       │   │
│  │    → Task DAG: root → N workers → flatten                   │   │
│  │  START_MATRIX_DAG(resolution)                                │   │
│  │  STOP_MATRIX_DAG(resolution)                                 │   │
│  │                                                               │   │
│  │  Tables (per resolution):                                    │   │
│  │    H3_RES{N}, WORK_QUEUE_RES{N},                            │   │
│  │    MATRIX_RAW_RES{N}, TRAVEL_TIME_RES{N}                    │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  LIFECYCLE schema (NEW — common service management)          │   │
│  │                                                               │   │
│  │  RESUME_ALL_SERVICES()                                       │   │
│  │  SUSPEND_ALL_SERVICES()                                      │   │
│  │  SCALE_SERVICES(min_instances, max_instances)                │   │
│  │  GET_STATUS() → JSON with all service states                 │   │
│  │  CHECK_HEALTH() → boolean, verifies gateway responds         │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘

        │                    │                    │
        │ CORE.*             │ MATRIX.*           │ MULTI_CITY.*
        │ functions          │ pipeline           │ per-region
        ▼                    ▼                    ▼

┌──────────────┐ ┌──────────────┐ ┌──────────────────────────┐
│ fleet-intel  │ │ route-       │ │ fleet-intel-food-delivery │
│ -taxis       │ │ deviation    │ │                          │
│              │ │              │ │ Native App (UI + Data):  │
│ Tables:      │ │ Tables:      │ │  React SPCS service      │
│  TRIPS       │ │  ROUTE_CACHE │ │  RESTAURANTS             │
│  DRIVERS     │ │  TRIP_ACTUAL │ │  COURIERS                │
│  DRIVER_LOCS │ │  DEVIATION_* │ │  DELIVERY_ORDERS         │
│  ...         │ │  ...         │ │  DELIVERY_ROUTES         │
│              │ │              │ │  COURIER_LOCATIONS        │
│ Views:       │ │ Views:       │ │  PREDICT_DELIVERY_ETA    │
│  TRIP_SUMMARY│ │  DAILY_TREND │ │  DELIVERY_SUMMARY view   │
│              │ │              │ │  ...                     │
│ Streamlit    │ │ Streamlit    │ │                          │
└──────────────┘ └──────────────┘ └──────────────────────────┘

┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ route-       │ │ retail-      │ │ routing-     │
│ optimization │ │ catchment    │ │ agent        │
│              │ │              │ │              │
│ Notebook     │ │ Streamlit    │ │ TOOL_DIR     │
│ Streamlit    │ │  isochrones  │ │ TOOL_ISO     │
│  VRP solver  │ │  competitors │ │ TOOL_OPT     │
│              │ │  H3 density  │ │ Agent spec   │
└──────────────┘ └──────────────┘ └──────────────┘

┌──────────────┐ ┌──────────────┐
│ dwell-       │ │ synthetic-   │
│ analysis     │ │ datasets-gen │
│              │ │              │
│ Dynamic Tbl  │ │ Python       │
│ pipeline     │ │ generator    │
│ (no ORS)     │ │ (calls DIR)  │
└──────────────┘ └──────────────┘
```

---

## What Changes Per Component

### 1. `build-routing-solution` (standalone ORS app) — ENHANCED

Add 3 new schemas to `setup_script.sql`:

| New Schema   | Source                                                       | What Moves In                                            |
| ------------ | ------------------------------------------------------------ | -------------------------------------------------------- |
| `MULTI_CITY` | food-delivery `routing.create_city_*` + `setup_city_ors`     | Per-region ORS instances, city-prefixed functions        |
| `MATRIX`     | food-delivery `data.BUILD_*` + travel-time-matrix procedures | H3 pipeline, work queues, Task DAGs, progress monitoring |
| `LIFECYCLE`  | food-delivery `core.resume_services` + `get_status`          | Centralized service management                           |

The `CORE` schema keeps all existing routing functions unchanged. The `control_app` Streamlit gains tabs/buttons for multi-city and matrix management.

**Estimated addition**: \~600 lines to `setup_script.sql` (moved, not new code)

### 2. `fleet-intelligence-food-delivery` native app — STRIPPED

Remove entirely:

- `routing` schema (\~350 lines) — replaced by `OPENROUTESERVICE_NATIVE_APP.CORE.*`
- Matrix pipeline procedures from `data` schema (\~600 lines) — replaced by `OPENROUTESERVICE_NATIVE_APP.MATRIX.*`
- ORS service lifecycle from `core` schema (\~80 lines) — replaced by `OPENROUTESERVICE_NATIVE_APP.LIFECYCLE.*`
- ORS Docker images from `manifest.yml`

What remains (\~750 lines):

- `core` schema: React UI service, status app, deploy procedure, grant callback
- `data` schema: 11 delivery tables, 5 analytics views, `PREDICT_DELIVERY_ETA`
- Matrix tables still created locally (populated by calling `OPENROUTESERVICE_NATIVE_APP.MATRIX.*`)

Function call changes:

```
-- Before (self-contained):
routing.DIRECTIONS('cycling-electric', origin, dest)
data.BUILD_TRAVEL_TIME_MATRIX_RES7()

-- After (references standalone):
OPENROUTESERVICE_NATIVE_APP.CORE.DIRECTIONS('cycling-electric', origin, dest)
OPENROUTESERVICE_NATIVE_APP.MATRIX.BUILD_TRAVEL_TIME_MATRIX(7, bbox)
```

### 3. `travel-time-matrix` skill — SIMPLIFIED

The entire skill becomes a **guide for using `OPENROUTESERVICE_NATIVE_APP.MATRIX.*`** rather than providing standalone SQL procedures. The skill's value shifts from "here's the code" to "here's how to configure and scale the matrix pipeline."

### 4. All other demo skills — NO CHANGE

Already correctly structured: they call `OPENROUTESERVICE_NATIVE_APP.CORE.*` and own only domain objects.

---

## Dependency Graph (Target State)

```
routing-prerequisites
    │
    ▼
build-routing-solution  ←── installs OPENROUTESERVICE_NATIVE_APP
    │                        with CORE + MULTI_CITY + MATRIX + LIFECYCLE
    │
    ├──► routing-customization (change maps, profiles)
    │
    ├──► fleet-intelligence-taxis (Streamlit + loose SQL)
    ├──► fleet-intelligence-food-delivery (Native App: UI + Data only)
    ├──► route-optimization (Notebook + Streamlit)
    ├──► retail-catchment (Streamlit)
    ├──► route-deviation (depends on synthetic-datasets-generator)
    ├──► routing-agent (Cortex Agent)
    ├──► travel-time-matrix (guide for MATRIX schema usage)
    └──► dwell-analysis (no direct ORS dependency)
```

---

## Migration Order

| Phase       | Task                                                                        | Risk                                          |
| ----------- | --------------------------------------------------------------------------- | --------------------------------------------- |
| **Phase 1** | Add `LIFECYCLE` schema to standalone ORS app (lowest risk, just new procs)  | Low                                           |
| **Phase 2** | Add `MATRIX` schema to standalone ORS app (consolidate from both sources)   | Medium — need to reconcile naming differences |
| **Phase 3** | Add `MULTI_CITY` schema to standalone ORS app (backport from food delivery) | Medium — gateway routing needs testing        |
| **Phase 4** | Strip food delivery native app (remove routing schema, update references)   | High — most files affected                    |
| **Phase 5** | Update `travel-time-matrix` skill to reference ORS MATRIX schema            | Low                                           |
| **Phase 6** | Update all skill docs to reference new schema paths                         | Low                                           |

---

## Open Questions

1. **Matrix table ownership**: Should matrix result tables (H3\_RES7, TRAVEL\_TIME\_RES7, etc.) live inside the ORS app or in the consumer's database?

   - **Inside ORS**: Simpler API, single location, but couples data lifecycle to app lifecycle
   - **Consumer DB**: More flexible, each demo owns its matrix data, but procedures need cross-DB writes
   - **Recommendation**: ORS MATRIX procedures accept a target database/schema parameter and write results there. The procedures live in ORS, the data lives in the consumer's DB.

2. **Cross-app function grants**: When the food delivery native app calls `OPENROUTESERVICE_NATIVE_APP.CORE.DIRECTIONS(...)`, it needs `GRANT USAGE ON FUNCTION` from the ORS app to the food delivery app's role.

   - This is already the pattern for all other demos (they run as the installing user who granted both apps)
   - For native-app-to-native-app calls, may need explicit grants in the install flow

3. **Multi-city ORS in standalone app**: The gateway currently routes `/city/{region}/` requests to city-specific ORS instances. This requires the gateway service spec in the standalone app to be updated.

   - Keep the gateway routing prefix approach (proven, works with current gateway code)
   - Add `MULTI_CITY.SETUP_CITY_ORS(region, pbf_url)` as the public API
