# Reference Architecture v2: ORS + Demo Skills

## Changes from v1

1. **MULTI_CITY → merged into CORE** — city ORS management becomes part of the core schema alongside existing functions
2. **MATRIX → standalone skill** (not in the ORS app) — it's a consumer of `CORE.MATRIX_TABULAR`, not routing infrastructure itself
3. **LIFECYCLE → stays in ORS app** — service management is routing infrastructure

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                   OPENROUTESERVICE_NATIVE_APP                    │
│                   (build-routing-solution skill)                  │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  CORE schema (enhanced)                                    │  │
│  │                                                            │  │
│  │  ── Routing Engine ──                                      │  │
│  │  Services: ORS, Vroom, Gateway, Downloader                 │  │
│  │  Infra:    Compute Pool, Stages, External Access           │  │
│  │                                                            │  │
│  │  ── Single-Region Functions ──                             │  │
│  │  DIRECTIONS / DIRECTIONS_GEO                               │  │
│  │  ISOCHRONES / ISOCHRONES_GEO                               │  │
│  │  OPTIMIZATION / OPTIMIZATION_GEO                           │  │
│  │  MATRIX / MATRIX_TABULAR                                   │  │
│  │  ORS_STATUS                                                │  │
│  │                                                            │  │
│  │  ── Multi-City (NEW, backported from food delivery) ──     │  │
│  │  SETUP_CITY_ORS(region, pbf_url)                           │  │
│  │    → per-region ORS instance + city-prefixed functions      │  │
│  │  RESUME_CITY_ORS(region)                                   │  │
│  │  DROP_CITY_ORS(region)                                     │  │
│  │  LIST_CITIES()                                             │  │
│  │  DIRECTIONS_{REGION} / MATRIX_{REGION} (dynamic)           │  │
│  │                                                            │  │
│  │  ── Service Lifecycle (NEW) ──                             │  │
│  │  RESUME_ALL_SERVICES()                                     │  │
│  │  SUSPEND_ALL_SERVICES()                                    │  │
│  │  SCALE_SERVICES(min, max)                                  │  │
│  │  GET_STATUS() → JSON                                       │  │
│  │                                                            │  │
│  │  Config:   MAP_CONFIG table                                │  │
│  │  UI:       control_app (Streamlit)                         │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
        │
        │ CORE.DIRECTIONS, CORE.MATRIX_TABULAR, etc.
        │
        ▼
┌──────────────────────────────────────────────────────────────────┐
│  Demo Skills (thin consumers — own only domain data + UI)        │
│                                                                  │
│  fleet-intelligence-taxis      route-optimization                │
│  fleet-intelligence-food-del   retail-catchment                  │
│  route-deviation               routing-agent                     │
│  dwell-analysis                synthetic-datasets-generator      │
│  travel-time-matrix  ◄── H3 matrix skill (see below)            │
└──────────────────────────────────────────────────────────────────┘
```

---

## Travel Time Matrix — Standalone Skill

The `travel-time-matrix` skill is NOT part of the ORS app. It's a **consumer skill** that:
1. Calls `OPENROUTESERVICE_NATIVE_APP.CORE.MATRIX_TABULAR` to compute travel times
2. Creates its own tables (H3 hexagons, work queues, raw results, flattened pairs) in the **user's database**
3. Provides reusable procedures for any demo that needs pre-computed H3 travel times

```
┌─────────────────────────────────────────────────────────┐
│  travel-time-matrix skill                               │
│  (creates objects in user's chosen DB.SCHEMA)           │
│                                                         │
│  Procedures:                                            │
│    BUILD_HEXAGONS(resolution, bbox)                     │
│    BUILD_WORK_QUEUE(resolution)                         │
│    BUILD_TRAVEL_TIME_RANGE(resolution, start, end)      │
│      → calls CORE.MATRIX_TABULAR in batches             │
│      → resume-safe, retry-aware, exponential backoff    │
│    FLATTEN_MATRIX_RAW(resolution, region)               │
│    BUILD_TRAVEL_TIME_MATRIX(resolution, bbox)           │
│      → end-to-end orchestrator                          │
│    MATRIX_PROGRESS()                                    │
│    RESET_MATRIX_DATA(resolution)                        │
│                                                         │
│  Task DAG management:                                   │
│    CREATE_MATRIX_DAG(resolution, num_workers, wh)       │
│    START_MATRIX_DAG(resolution)                         │
│    STOP_MATRIX_DAG(resolution)                          │
│                                                         │
│  Tables (per resolution, in user DB):                   │
│    H3_RES{N}, WORK_QUEUE_RES{N},                       │
│    MATRIX_RAW_RES{N}, TRAVEL_TIME_RES{N}               │
└─────────────────────────────────────────────────────────┘
```

**Why this is better as a skill, not in ORS:**
- Matrix computation is a **use case** built on top of routing, not routing itself
- Data belongs in the consumer's database (decoupled from ORS app lifecycle)
- Different demos need different resolutions, bounding boxes, and regions
- The skill already exists — it just needs to be the single source of truth (removing the duplicate from food delivery)

**Consumers of the matrix skill:**
- `fleet-intelligence-food-delivery` — California H3 res 7/8/9 for delivery ETAs
- Any future demo needing pre-computed travel times

---

## What Changes Per Component

### 1. `build-routing-solution` — CORE schema enhanced

**Add to `setup_script.sql`:**

| Feature | Lines (approx) | Source |
|---------|----------------|--------|
| Multi-city ORS: `SETUP_CITY_ORS`, `CREATE_CITY_ORS_SERVICE`, `CREATE_CITY_FUNCTIONS`, `RESUME_CITY_ORS`, `DROP_CITY_ORS`, `LIST_CITIES` | ~200 | food-delivery `routing.*` |
| Lifecycle: `RESUME_ALL_SERVICES`, `SUSPEND_ALL_SERVICES`, `SCALE_SERVICES`, `GET_STATUS` | ~100 | food-delivery `core.resume_services/get_status` |

**No new schemas** — everything goes into `CORE`.

### 2. `fleet-intelligence-food-delivery` native app — STRIPPED

**Remove:**
- Entire `routing` schema (~350 lines) — replaced by `OPENROUTESERVICE_NATIVE_APP.CORE.*`
- Matrix pipeline procedures from `data` schema (~600 lines) — replaced by `travel-time-matrix` skill
- ORS Docker images from `manifest.yml` (4 images)
- ORS-related external access references
- `deploy_full()` (ORS deployment) — keep only `deploy()` (UI deployment)

**Keep (~750 lines):**
- `core`: React UI service, status app, deploy(), grant callback
- `data`: 11 delivery tables, 5 analytics views, `PREDICT_DELIVERY_ETA`
- Matrix result tables (H3_RES*, TRAVEL_TIME_RES*) — created by travel-time-matrix skill, read by the app

**Update references:**
```sql
-- Before: routing.DIRECTIONS(...)
-- After:  OPENROUTESERVICE_NATIVE_APP.CORE.DIRECTIONS(...)

-- Before: data.BUILD_TRAVEL_TIME_MATRIX_RES7()
-- After:  use travel-time-matrix skill procedures
```

### 3. `travel-time-matrix` skill — CONSOLIDATED

Becomes the **single source of truth** for H3 matrix computation:
- Merge the best of both implementations (food-delivery's per-region support + travel-time-matrix's Task DAG orchestration)
- All procedures create objects in the caller's database/schema
- Document as a reusable building block that any demo can invoke

### 4. All other demo skills — NO CHANGE

Already correctly structured.

---

## Dependency Graph (Target)

```
routing-prerequisites
    │
    ▼
build-routing-solution ──► OPENROUTESERVICE_NATIVE_APP
    │                       (CORE: routing + multi-city + lifecycle)
    │
    ├──► routing-customization
    │
    ├──► fleet-intelligence-taxis
    ├──► route-optimization
    ├──► retail-catchment
    ├──► route-deviation ◄── synthetic-datasets-generator
    ├──► routing-agent
    │
    ├──► travel-time-matrix  (standalone skill, uses CORE.MATRIX_TABULAR)
    │       │
    │       ▼
    │    fleet-intelligence-food-delivery  (native app: UI + Data)
    │       (uses travel-time-matrix for ETAs)
    │
    └──► dwell-analysis (no direct ORS dependency)
```

---

## Migration Phases

| Phase | Task | Files Changed | Risk |
|-------|------|---------------|------|
| **1** | Add lifecycle procs to CORE schema in standalone ORS `setup_script.sql` | 1 file | Low |
| **2** | Backport multi-city ORS to CORE schema | 1 file + gateway testing | Medium |
| **3** | Consolidate travel-time-matrix skill (merge both implementations) | skill SKILL.md + references | Medium |
| **4** | Strip food delivery native app (remove routing + matrix, update refs) | setup_script.sql, manifest.yml, server/index.ts, SKILL.md, native-app-deployment.md | High |
| **5** | Update all skill docs with correct schema paths | All skill SKILL.md files | Low |
