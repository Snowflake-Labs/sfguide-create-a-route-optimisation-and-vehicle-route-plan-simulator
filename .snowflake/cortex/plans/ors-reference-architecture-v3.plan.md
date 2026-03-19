# Reference Architecture v3: ORS App with Full Management UI

## Design Principle

> **ORS app = routing engine + management UI (city provisioning, matrix builder).**
> **Demo skills = domain data + domain UI only.**

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                    OPENROUTESERVICE_NATIVE_APP                       │
│                    (build-routing-solution skill)                     │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  CORE schema                                                   │  │
│  │                                                                │  │
│  │  ── Routing Engine ──                                          │  │
│  │  Services: ORS, Vroom, Gateway, Downloader                     │  │
│  │  Compute Pool, Stages, External Access                         │  │
│  │                                                                │  │
│  │  ── Single-Region Functions ──                                 │  │
│  │  DIRECTIONS / DIRECTIONS_GEO                                   │  │
│  │  ISOCHRONES / ISOCHRONES_GEO                                   │  │
│  │  OPTIMIZATION / OPTIMIZATION_GEO                               │  │
│  │  MATRIX / MATRIX_TABULAR                                       │  │
│  │  ORS_STATUS                                                    │  │
│  │                                                                │  │
│  │  ── Multi-City (backported from food delivery) ──              │  │
│  │  SETUP_CITY_ORS(region, pbf_url)                               │  │
│  │  RESUME_CITY_ORS(region)                                       │  │
│  │  DROP_CITY_ORS(region)                                         │  │
│  │  LIST_CITIES()                                                 │  │
│  │  DIRECTIONS_{REGION} / MATRIX_{REGION} (dynamic)               │  │
│  │                                                                │  │
│  │  ── Service Lifecycle ──                                       │  │
│  │  RESUME_ALL_SERVICES() / SUSPEND_ALL_SERVICES()                │  │
│  │  SCALE_SERVICES(min, max)                                      │  │
│  │  GET_STATUS() → JSON                                           │  │
│  │                                                                │  │
│  │  ── Travel Time Matrix Pipeline ──                             │  │
│  │  BUILD_HEXAGONS(resolution, bbox)                              │  │
│  │  BUILD_WORK_QUEUE(resolution)                                  │  │
│  │  BUILD_TRAVEL_TIME_RANGE(resolution, start, end)               │  │
│  │  FLATTEN_MATRIX_RAW(resolution, region)                        │  │
│  │  BUILD_TRAVEL_TIME_MATRIX(resolution, bbox)                    │  │
│  │  MATRIX_PROGRESS() / RESET_MATRIX_DATA(resolution)             │  │
│  │  CREATE_MATRIX_DAG / START_MATRIX_DAG / STOP_MATRIX_DAG        │  │
│  │  Tables: H3_RES{N}, WORK_QUEUE_RES{N}, MATRIX_RAW_RES{N},     │  │
│  │          TRAVEL_TIME_RES{N}                                    │  │
│  │                                                                │  │
│  │  Config: MAP_CONFIG, CITY_ORS_MAP                              │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  Management UI (enhanced control_app)                          │  │
│  │                                                                │  │
│  │  Existing:                                                     │  │
│  │    Service Manager — start/stop/resume, logs                   │  │
│  │    Function Tester — DIRECTIONS, ISOCHRONES, OPTIMIZATION,     │  │
│  │                      MATRIX interactive tester                 │  │
│  │                                                                │  │
│  │  NEW (from food delivery DataBuilder):                         │  │
│  │    City Provisioner — select city → download PBF → deploy      │  │
│  │                       per-region ORS → create functions         │  │
│  │                       11 pre-configured cities + custom         │  │
│  │                                                                │  │
│  │  NEW (from food delivery MatrixBuilder):                       │  │
│  │    Matrix Builder — select region + resolution → build H3      │  │
│  │                     hexagons → compute travel times             │  │
│  │                     cost estimator, progress tracker            │  │
│  │                     remove/restore matrix data                  │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
        │
        │  CORE.DIRECTIONS, CORE.MATRIX_TABULAR,
        │  CORE.SETUP_CITY_ORS, CORE.BUILD_TRAVEL_TIME_MATRIX, etc.
        │
        ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Demo Skills (domain data + domain UI only)                          │
│                                                                      │
│  ┌─────────────────────┐  ┌─────────────────────┐                   │
│  │ fleet-intel-taxis   │  │ fleet-intel-food-del │                   │
│  │                     │  │                      │                   │
│  │ Tables: TRIPS,      │  │ React App:           │                   │
│  │  DRIVERS,           │  │  FleetMap            │                   │
│  │  DRIVER_LOCATIONS   │  │  ChatPanel (AI)      │                   │
│  │ Views: TRIP_SUMMARY │  │  StatsPanel          │                   │
│  │ Streamlit dashboard │  │  CatchmentPanel      │                   │
│  │                     │  │                      │                   │
│  │ Calls:              │  │ Tables: RESTAURANTS,  │                   │
│  │  CORE.DIRECTIONS    │  │  COURIERS, ORDERS,   │                   │
│  │                     │  │  DELIVERY_ROUTES...  │                   │
│  └─────────────────────┘  │ Views: DELIVERY_     │                   │
│                            │  SUMMARY, ETA...    │                   │
│  ┌─────────────────────┐  │                      │                   │
│  │ route-optimization  │  │ Data pipeline:       │                   │
│  │                     │  │  7-step delivery     │                   │
│  │ Notebook + Streamlit│  │  data generation     │                   │
│  │ Calls: CORE.OPT,   │  │  (calls CORE.DIR)    │                   │
│  │  CORE.ISO, CORE.DIR│  │                      │                   │
│  └─────────────────────┘  │ Calls:               │                   │
│                            │  CORE.DIRECTIONS     │                   │
│  ┌─────────────────────┐  │  CORE.TRAVEL_TIME_*  │                   │
│  │ retail-catchment    │  │  (reads matrix data) │                   │
│  │                     │  └──────────────────────┘                   │
│  │ Streamlit           │                                             │
│  │ Calls: CORE.ISO     │  ┌─────────────────────┐                   │
│  └─────────────────────┘  │ route-deviation      │                   │
│                            │                     │                   │
│  ┌─────────────────────┐  │ Calls:               │                   │
│  │ routing-agent       │  │  CORE.DIRECTIONS_GEO │                   │
│  │                     │  └─────────────────────┘                   │
│  │ Cortex Agent        │                                             │
│  │ Wraps: CORE.DIR,    │  ┌─────────────────────┐                   │
│  │  CORE.ISO, CORE.OPT │  │ dwell-analysis      │                   │
│  └─────────────────────┘  │ (no ORS calls)       │                   │
│                            └─────────────────────┘                   │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Key Decision: Where Do Matrix Tables Live?

The matrix pipeline creates large tables (H3 hexagons, work queues, raw results, travel time pairs). Two options:

**Option A — Inside ORS app (recommended for v3):**
Matrix tables live in `CORE` schema inside the app. Any demo that needs travel time data queries them via `OPENROUTESERVICE_NATIVE_APP.CORE.TRAVEL_TIME_RES7`. The ORS app owns the full lifecycle.

- Pro: Single location, MatrixBuilder UI manages them directly, clean ownership
- Pro: ORS app already has the compute pool and service access needed
- Con: Data lifecycle coupled to ORS app (DROP APP = lose matrix data)

**Option B — Consumer DB:**
Matrix procedures live in ORS, but write to a caller-specified DB.SCHEMA.

- Pro: Decoupled data lifecycle
- Con: Complex cross-DB writes, MatrixBuilder UI needs target DB picker

**Recommendation: Option A** — matrix data is a derivative of the routing engine. It logically belongs with ORS. If the ORS app is dropped, the matrix data should be rebuilt anyway (it's computed, not source data).

---

## What Changes Per Component

### 1. `build-routing-solution` — ORS App Enhanced

**`setup_script.sql` additions (~800 lines):**

| Feature | Source | Lines |
|---------|--------|-------|
| Multi-city ORS procs | food-delivery `routing.create_city_*` | ~200 |
| Lifecycle procs | food-delivery `core.resume_services/get_status` | ~100 |
| Matrix pipeline procs + tables | food-delivery `data.BUILD_*` + travel-time-matrix | ~400 |
| CITY_ORS_MAP config table | food-delivery server | ~50 |
| Matrix DAG procs | travel-time-matrix skill | ~50 |

**`control_app` Streamlit additions (2 new pages):**

| Page | Source | Description |
|------|--------|-------------|
| `pages/city_manager.py` | food-delivery DataBuilder logic | City selector, PBF download trigger, ORS provisioning status, per-city function testing |
| `pages/matrix_builder.py` | food-delivery MatrixBuilder logic | Resolution/bbox picker, cost estimator, build trigger, progress tracker, data management |

**`manifest.yml` unchanged** — already has all ORS Docker images.

### 2. `fleet-intelligence-food-delivery` — STRIPPED to Demo Only

**Remove entirely:**
- `routing` schema (~350 lines)
- Matrix pipeline procedures from `data` schema (~600 lines)
- ORS lifecycle management from `core` schema (~80 lines)
- ORS Docker images from manifest.yml (4 images)
- `deploy_full()` procedure
- DataBuilder ORS provisioning UI (React component)
- MatrixBuilder UI (React component)

**Keep (~650 lines in setup_script.sql + React app):**

```
setup_script.sql:
  core schema:
    - create_ui_compute_pool()     — React service pool
    - create_warehouse()           — analytics warehouse
    - create_ui_service()          — React SPCS container
    - deploy()                     — UI-only deployment
    - check_ors_ready()            — NEW: verify ORS app is running
    - grant_callback               — permissions flow
    - status_app                   — launcher Streamlit

  data schema:
    - 11 delivery tables           — RESTAURANTS, COURIERS, etc.
    - 5 analytics views            — DELIVERY_SUMMARY, etc.
    - PREDICT_DELIVERY_ETA()       — H3 travel-time lookup
    - Data generation pipeline     — 7-step delivery data builder

React App (keeps):
  - FleetMap                       — route visualization
  - ChatPanel                      — AI analytics agent
  - StatsPanel                     — fleet statistics
  - CatchmentPanel                 — restaurant catchment
  - DataBuilder (data part only)   — 7-step delivery pipeline trigger

React App (removes):
  - DataBuilder (ORS part)         — city provisioning → moved to ORS
  - MatrixBuilder                  — matrix building → moved to ORS

server/index.ts:
  - Remove: CITY_ORS_MAP, provisionOrsForRegion(), all routing.* calls
  - Keep: delivery pipeline, analytics APIs, AI agent API
  - Update: call OPENROUTESERVICE_NATIVE_APP.CORE.* for routing
```

### 3. `travel-time-matrix` skill — SIMPLIFIED

Becomes a **usage guide** for the matrix pipeline now built into the ORS app. The skill's value is documentation:
- How to choose H3 resolution for your use case
- How to estimate compute costs
- How to scale the pipeline (ALTER SERVICE, ALTER COMPUTE POOL)
- How to use Task DAGs for automated matrix builds
- How to query travel time data (bidirectional lookup patterns)

### 4. All other demo skills — NO CHANGE

Already correctly structured as thin ORS consumers.

---

## Dependency Graph (Target)

```
routing-prerequisites
    │
    ▼
build-routing-solution ──► OPENROUTESERVICE_NATIVE_APP
    │                       CORE: routing engine + multi-city
    │                             + matrix pipeline + lifecycle
    │                       UI: service manager + function tester
    │                           + city provisioner + matrix builder
    │
    ├──► routing-customization (change maps, profiles)
    │
    ├──► fleet-intelligence-taxis     (domain: taxi fleet viz)
    ├──► fleet-intelligence-food-del  (domain: delivery fleet viz)
    ├──► route-optimization           (domain: VRP solver)
    ├──► retail-catchment             (domain: retail analysis)
    ├──► route-deviation              (domain: fleet deviation)
    ├──► routing-agent                (domain: Cortex AI agent)
    ├──► travel-time-matrix           (guide: matrix pipeline usage)
    └──► dwell-analysis               (domain: dwell/congestion)
```

---

## Migration Phases

| Phase | Task | Scope | Risk |
|-------|------|-------|------|
| **1** | Add lifecycle + multi-city procs to CORE in standalone ORS `setup_script.sql` | ~300 lines SQL | Medium |
| **2** | Add matrix pipeline procs + tables to CORE | ~400 lines SQL | Medium |
| **3** | Add City Provisioner page to control_app Streamlit | New Streamlit page | Low |
| **4** | Add Matrix Builder page to control_app Streamlit | New Streamlit page | Low |
| **5** | Strip food delivery native app (remove routing, matrix, ORS images, DataBuilder ORS, MatrixBuilder) | Major refactor | High |
| **6** | Update food delivery React server to call ORS CORE functions | server/index.ts | Medium |
| **7** | Simplify travel-time-matrix skill to usage guide | Docs only | Low |
| **8** | Update all skill SKILL.md docs with new paths | Docs | Low |
