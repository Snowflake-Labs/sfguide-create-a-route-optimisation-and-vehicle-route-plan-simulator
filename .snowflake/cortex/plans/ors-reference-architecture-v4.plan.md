---
name: "ors-reference-architecture-v4"
created: "2026-03-19T17:43:43.851Z"
status: pending
---

# Reference Architecture v4: ORS App with React Management UI

## Design Principle

> **ORS app = routing engine + React management UI (service management, function testing, city provisioning, matrix builder).** **Demo skills = domain data + domain UI only.**

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     OPENROUTESERVICE_NATIVE_APP                         │
│                     (build-routing-solution skill)                       │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  CORE schema                                                      │  │
│  │                                                                   │  │
│  │  ── Routing Engine (SPCS Services) ──                             │  │
│  │  ORS, Vroom, Gateway, Downloader                                  │  │
│  │  Compute Pool (HIGHMEM_X64_S), Stages, External Access            │  │
│  │                                                                   │  │
│  │  ── Single-Region Functions ──                                    │  │
│  │  DIRECTIONS / DIRECTIONS_GEO                                      │  │
│  │  ISOCHRONES / ISOCHRONES_GEO                                      │  │
│  │  OPTIMIZATION / OPTIMIZATION_GEO                                  │  │
│  │  MATRIX / MATRIX_TABULAR                                          │  │
│  │  ORS_STATUS                                                       │  │
│  │                                                                   │  │
│  │  ── Multi-City ──                                                 │  │
│  │  SETUP_CITY_ORS(region, pbf_url)                                  │  │
│  │  RESUME_CITY_ORS(region) / DROP_CITY_ORS(region)                  │  │
│  │  LIST_CITIES()                                                    │  │
│  │  DIRECTIONS_{REGION} / MATRIX_{REGION} (dynamic)                  │  │
│  │                                                                   │  │
│  │  ── Service Lifecycle ──                                          │  │
│  │  RESUME_ALL_SERVICES() / SUSPEND_ALL_SERVICES()                   │  │
│  │  SCALE_SERVICES(min, max) / GET_STATUS()                          │  │
│  │                                                                   │  │
│  │  ── Travel Time Matrix Pipeline ──                                │  │
│  │  BUILD_HEXAGONS / BUILD_WORK_QUEUE / BUILD_TRAVEL_TIME_RANGE      │  │
│  │  FLATTEN_MATRIX_RAW / BUILD_TRAVEL_TIME_MATRIX                    │  │
│  │  MATRIX_PROGRESS / RESET_MATRIX_DATA                              │  │
│  │  CREATE/START/STOP_MATRIX_DAG                                     │  │
│  │  Tables: H3_RES{N}, WORK_QUEUE_RES{N}, MATRIX_RAW_RES{N},        │  │
│  │          TRAVEL_TIME_RES{N}                                       │  │
│  │                                                                   │  │
│  │  Config: MAP_CONFIG, CITY_ORS_MAP                                 │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  React Management UI (SPCS service — replaces Streamlit)          │  │
│  │                                                                   │  │
│  │  ┌─────────────────┐  ┌─────────────────┐                        │  │
│  │  │ Service Manager │  │ Function Tester │                        │  │
│  │  │ (from Streamlit)│  │ (from Streamlit)│                        │  │
│  │  │                 │  │                 │                        │  │
│  │  │ Start/stop/     │  │ Interactive     │                        │  │
│  │  │ resume services │  │ DIRECTIONS,     │                        │  │
│  │  │ View logs       │  │ ISOCHRONES,     │                        │  │
│  │  │ Service metrics │  │ OPTIMIZATION,   │                        │  │
│  │  │                 │  │ MATRIX tester   │                        │  │
│  │  │                 │  │ with map viz    │                        │  │
│  │  └─────────────────┘  └─────────────────┘                        │  │
│  │                                                                   │  │
│  │  ┌─────────────────┐  ┌─────────────────┐                        │  │
│  │  │ City Provisioner│  │ Matrix Builder  │                        │  │
│  │  │ (from food del) │  │ (from food del) │                        │  │
│  │  │                 │  │                 │                        │  │
│  │  │ City selector   │  │ Resolution/bbox │                        │  │
│  │  │ PBF download    │  │ Cost estimator  │                        │  │
│  │  │ ORS provisioning│  │ Build trigger   │                        │  │
│  │  │ Region status   │  │ Progress tracker│                        │  │
│  │  │ 11 pre-config'd │  │ Data management │                        │  │
│  │  │ cities + custom │  │ remove/restore  │                        │  │
│  │  └─────────────────┘  └─────────────────┘                        │  │
│  │                                                                   │  │
│  │  Server (Express/Node):                                           │  │
│  │    /api/services/*      — service lifecycle management            │  │
│  │    /api/functions/*     — function testing proxy                  │  │
│  │    /api/cities/*        — city ORS provisioning                   │  │
│  │    /api/matrix/*        — matrix pipeline management              │  │
│  │    /api/status          — overall health check                    │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  SPCS Services:                                                         │
│    ors_service              — OpenRouteService engine                   │
│    vroom_service            — VROOM optimizer                           │
│    routing_gateway_service  — API gateway (reverse proxy)               │
│    downloader               — PBF download service                      │
│    ors_control_app          — React management UI (NEW, replaces        │
│                               Streamlit control_app)                    │
└─────────────────────────────────────────────────────────────────────────┘

        │
        │  CORE.* functions
        ▼

┌─────────────────────────────────────────────────────────────────────────┐
│  Demo Skills (domain data + domain UI only)                             │
│                                                                         │
│  fleet-intelligence-taxis        — taxi fleet visualization             │
│  fleet-intelligence-food-delivery — delivery fleet React app (trimmed)  │
│  route-optimization              — VRP notebook + Streamlit             │
│  retail-catchment                — retail isochrone Streamlit            │
│  route-deviation                 — fleet deviation analysis             │
│  routing-agent                   — Cortex AI agent                      │
│  dwell-analysis                  — dwell/congestion DT pipeline         │
│  synthetic-datasets-generator    — synthetic GPS data                   │
│  travel-time-matrix              — usage guide (code now in ORS CORE)   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## React App: What Comes From Where

| Component            | Source                                                               | Changes Needed                                                                    |
| -------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **City Provisioner** | food-delivery `DataBuilder` (React)                                  | Remove delivery data pipeline steps, keep ORS provisioning only                   |
| **Matrix Builder**   | food-delivery `MatrixBuilder` (React)                                | Minimal — already generic, just update SQL endpoints from `routing.*` to `CORE.*` |
| **Service Manager**  | ORS `control_app` (Streamlit)                                        | **Rewrite** from Streamlit to React                                               |
| **Function Tester**  | ORS `control_app/pages/function_tester.py` (Streamlit, \~1700 lines) | **Rewrite** from Streamlit to React (pydeck maps → deck.gl/Mapbox)                |
| **Server API**       | food-delivery `server/index.ts` (ORS parts)                          | Extract ORS management APIs, drop delivery-specific endpoints                     |

The City Provisioner and Matrix Builder are **extraction** (minimal changes). The Service Manager and Function Tester are **rewrites** (Streamlit → React).

---

## Docker Images

**Current ORS app images (4):**

```
openrouteservice:v9.0.0
vroom-docker:v1.0.1
routing_reverse_proxy:v0.9.2
downloader:v0.0.3
```

**New image (1):**

```
ors_control_app:v1.0.0    — React + Express (from food delivery's fleet_intelligence_service image, stripped to ORS-only)
```

**Food delivery app drops to (1):**

```
fleet_intelligence_service:v2.0.0  — React + Express (delivery domain only, calls ORS app for routing)
```

---

## What Changes Per Component

### 1. `build-routing-solution` — ORS App with React UI

**`setup_script.sql` additions (\~900 lines):**

| Feature                                    | Lines | Source                                            |
| ------------------------------------------ | ----- | ------------------------------------------------- |
| Multi-city procs (SETUP\_CITY\_ORS, etc.)  | \~200 | food-delivery `routing.*`                         |
| Lifecycle procs (RESUME\_ALL, GET\_STATUS) | \~100 | food-delivery `core.*`                            |
| Matrix pipeline procs + tables             | \~450 | food-delivery `data.BUILD_*` + travel-time-matrix |
| React UI service creation                  | \~100 | food-delivery `core.create_ui_service` adapted    |
| CITY\_ORS\_MAP config                      | \~50  | food-delivery server                              |

**Remove from `setup_script.sql`:**

- Streamlit `control_app` definition and related procs (\~50 lines)

**New files:**

```
build-routing-solution/
  Native_app/
    services/
      ors_control_app/           ← NEW React app
        server/
          index.ts               — Express server (ORS management APIs)
        src/
          App.tsx                — React app shell
          components/
            ServiceManager.tsx   — rewrite from Streamlit
            FunctionTester.tsx   — rewrite from Streamlit (deck.gl maps)
            CityProvisioner.tsx  — extracted from food delivery DataBuilder
            MatrixBuilder.tsx    — extracted from food delivery MatrixBuilder
        Dockerfile
        package.json
      ors_control_app_service.yaml  ← SPCS service spec
```

**`manifest.yml` additions:**

- `ors_control_app` image reference
- UI compute pool privilege (if not sharing the routing pool)

### 2. `fleet-intelligence-food-delivery` — Domain-Only Demo

**Remove from `setup_script.sql` (\~1030 lines removed):**

- `routing` schema entirely (\~350 lines)
- Matrix pipeline procs from `data` schema (\~600 lines)
- ORS lifecycle procs from `core` schema (\~80 lines)

**Keep (\~750 lines):**

- `core`: React UI service, status launcher, deploy(), grant\_callback
- `data`: 11 delivery tables, 5 views, PREDICT\_DELIVERY\_ETA, data generation pipeline

**React app changes:**

- Remove: DataBuilder ORS provisioning flow, MatrixBuilder component
- Remove: All `routing.*` SQL calls from server/index.ts
- Keep: DataBuilder delivery pipeline (7 steps), FleetMap, ChatPanel, StatsPanel, CatchmentPanel
- Update: Call `OPENROUTESERVICE_NATIVE_APP.CORE.*` for routing + matrix reads

**`manifest.yml`:** Remove 4 ORS Docker images (ORS, Vroom, Gateway, Downloader)

### 3. `travel-time-matrix` skill — Usage Guide

Rewritten as documentation for using `OPENROUTESERVICE_NATIVE_APP.CORE.*` matrix procs + the Matrix Builder UI.

### 4. All other demo skills — NO CHANGE

---

## Migration Phases

| Phase | Task                                                                                                          | Risk   | Notes                                      |
| ----- | ------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------ |
| **1** | Add lifecycle + multi-city + matrix procs to CORE in ORS `setup_script.sql`                                   | Medium | Pure SQL additions, testable independently |
| **2** | Create React `ors_control_app` scaffold with City Provisioner + Matrix Builder (extracted from food delivery) | Medium | Extraction, minimal rewrite                |
| **3** | Rewrite Service Manager + Function Tester as React components                                                 | High   | Streamlit → React rewrite (\~2000 lines)   |
| **4** | Build Docker image, add to manifest.yml, wire up SPCS service                                                 | Medium | Infrastructure                             |
| **5** | Strip food delivery native app (remove routing, matrix, ORS provisioning UI)                                  | High   | Most files affected                        |
| **6** | Update food delivery React server to call ORS CORE functions                                                  | Medium | server/index.ts                            |
| **7** | Update travel-time-matrix skill + all other skill docs                                                        | Low    | Docs only                                  |

---

## Dependency Graph (Target)

```
routing-prerequisites
    │
    ▼
build-routing-solution ──► OPENROUTESERVICE_NATIVE_APP
    │                       CORE: engine + multi-city + matrix + lifecycle
    │                       UI: React (services, functions, cities, matrix)
    │                       5 SPCS services + 5 Docker images
    │
    ├──► routing-customization
    │
    ├──► fleet-intelligence-taxis
    ├──► fleet-intelligence-food-delivery (React: delivery domain only)
    ├──► route-optimization
    ├──► retail-catchment
    ├──► route-deviation ◄── synthetic-datasets-generator
    ├──► routing-agent
    ├──► travel-time-matrix (usage guide)
    └──► dwell-analysis
```
