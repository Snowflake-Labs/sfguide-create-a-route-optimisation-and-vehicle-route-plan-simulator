# Business-Problem Taxonomy — one universal, mode-agnostic analytics package

**Status:** locked (R6). This file is the authoritative contract for the consumer SA app's
analytics surface. It supersedes the per-vehicle demo organization (taxi / food_delivery).

## The principle

The app exposes **business problems (intents)**, not vehicle types. Asset/vehicle type
(`VEHICLE_TYPE`) is a **data dimension carried by the selected dataset**, never a schema,
view, pack, or UI surface. Adding a new mode (today: `car`, `hgv`, `ebike`; tomorrow:
`vessel`, `aircraft`) must require **data + config only** — zero new schema, table, view,
semantic view, or UI.

We reject both:
1. **Per-type duplication** (the retired `FLEET_APP.TAXI` / `FLEET_APP.FOOD_DELIVERY` packs —
   the same SQL repeated per vehicle, differing only by a `VEHICLE_TYPE` filter + cosmetic vocab).
2. **Flattening into one generic blob** (loses the distinct problems + the agent layer).

Instead we **extract intents over ONE consolidated, mode-agnostic data layer** —
`FLEET_APP.FLEET_OPS`. Distinct problem views are *not* duplication; they are different
questions over shared entities. Duplication is the same view repeated per mode (removed).

## The one data layer: `FLEET_APP.FLEET_OPS`

A single schema of **dataset-scoped table functions** (UDTFs). Every function takes
`(P_REGION, P_DATASET_ID[, extra problem param])` and resolves the immutable dataset via
`FLEET_INTELLIGENCE.CORE.DIM_DATASETS` (keyed by `(REGION, VEHICLE_TYPE)`), so
**dataset-scoping IS mode-parameterization**. The functions bind to the neutral
`FLEET_APP.UNIFIED_FLEET.F_VW_*_SCOPED` contract (Tenet 1 data seam) — never to a physical
`SYNTHETIC_DATASETS` table. Authored in `app/scoped_contract.sql`, mirrored into the
control-app boot path (`server/lib/init.ts ensureScopedDatasetContract()`), applied by
`packs/_lib/install.py` after the `unified_fleet` pack.

| UDTF | Args | Powers intent |
|---|---|---|
| `F_VW_TRIPS_SCOPED` | `(region, dataset_id)` | Status, Map, Density (base trips, mode-neutral cols) |
| `F_VW_TELEMETRY_SCOPED` | `(region, dataset_id)` | Status (safety), Map, Density (GPS pings) |
| `F_VW_TRIP_SUMMARY_SCOPED` | `(region, dataset_id)` | Trip Inspection (route detail, speed, shift) |
| `F_VW_H3_DENSITY_SCOPED` | `(region, dataset_id, hour)` | Demand Density (H3 of GPS pings by hour) |
| `F_VW_OPERATOR_PERF_SCOPED` | `(region, dataset_id)` | Operator Performance (per-operator KPIs) |
| `F_VW_TOP_ORIGINS_SCOPED` | `(region, dataset_id, location_type)` | Top Origins (busiest origin POIs) |
| `F_VW_ASSET_ATTRIBUTES_SCOPED` | `(region, dataset_id)` | Asset Utilization (sparse mode attributes) |

## The intents (problem-named, mode-agnostic)

Each intent = **3 parallel artifacts** over the same `FLEET_OPS` UDTFs:
a **dashboard view** (`app/app-views.json`), an **agent tool/orchestration**
(`app/agent-spec.json` → `SV_FLEET_OPS`), and a **semantic-view coverage** (`SV_FLEET_OPS`).

| Intent | Dashboard view id | FLEET_OPS source | Agent | Extracted from |
|---|---|---|---|---|
| Fleet / Asset Status | `fleetops_status` | `F_VW_TRIPS_SCOPED`, `F_VW_TELEMETRY_SCOPED` | `query_fleet_ops` / SV_FLEET_OPS | taxi_overview + fleet_operations |
| Asset Map / Positioning | `fleetops_map` | `F_VW_TELEMETRY_SCOPED`, `F_VW_TRIP_SUMMARY_SCOPED` | `query_fleet_ops` | fleet_map + taxi_routes |
| Demand Density (H3) | `fleetops_density` | `F_VW_H3_DENSITY_SCOPED(hour)` | `query_fleet_ops` | (new; generalizes taxi/food congestion) |
| Trip Inspection | `fleetops_trips` | `F_VW_TRIP_SUMMARY_SCOPED` | `query_fleet_ops` | taxi VW_TRIP_SUMMARY |
| Operator Performance | `fleetops_operators` | `F_VW_OPERATOR_PERF_SCOPED` | `query_fleet_ops` | (new; generalizes driver/courier perf) |
| Top Origins | `fleetops_origins` | `F_VW_TOP_ORIGINS_SCOPED(location_type)` | `query_fleet_ops` | food_delivery VW_RESTAURANTS_ENRICHED |

### Kept intents (already mode-agnostic; re-labeled, not rebuilt)

| Intent | Surface | Notes |
|---|---|---|
| Dwell & Congestion | `dwell_*` dashboards, `SV_DWELL_ANALYTICS`, `query_dwell` | **global-default scoped** (DT substrate; per-session re-key deferred — Tenet 6) |
| Route Deviation | `deviation_*`, `SV_ROUTE_DEVIATION`, `query_route_deviation` | **global-default scoped** (deferred re-key) |
| Catchment | `catchment` + ISOCHRONES verb | ISOCHRONES-verb intent (`ROUTING_PLATFORM.CONTRACT`) |
| Asset Utilization | `asset_velocity`, `SV_ASSET_VELOCITY`, `query_asset_velocity` | HGV economics via the **optional attribute set**, not a vehicle pack |
| Optimization (VRP) | `vrp_simulator` (programmatic view) | `/api/tool` + `ROUTING_PLATFORM.CONTRACT.OPTIMIZATION` |
| Freight Matching | `backload_matching`, `freight_exchange` (programmatic) + `SV_BACKLOAD_MATCHING`, `SV_FREIGHT_MARKETPLACE`, `SV_DHL_BACKLOAD` | `/api/tool` + contract |

## Mode-neutrality rules (enforced)

- **Naming:** new artifacts use neutral vocab — `VEHICLE_ID`/`ASSET_ID`, `OPERATOR_ID`
  (not driver/courier), `ORIGIN_POI`/`DEST_POI` (not restaurant). No mode token
  (`taxi`/`food`/`hgv`) in any intent / view / schema / SV / agent-tool name.
- **The mode axis** is the existing `VEHICLE_TYPE` column, reused as-is (no rename, to avoid
  churn) and documented as the generic asset-mode dimension. Allowed values are open-ended
  (incl. future `vessel`, `aircraft`).
- **No branching on mode:** views / SVs / UDTFs NEVER `CASE WHEN VEHICLE_TYPE = ...`. Mode is
  a filter value carried by the selected dataset, nothing more.
- **Mode-specific attributes** (HGV dims now; vessel draft / aircraft flight-level later) live
  in the **optional/sparse attribute set** `F_VW_ASSET_ATTRIBUTES_SCOPED`, which returns the
  union of attribute columns and NULLs for modes that lack them — generalized from the
  `route_optimization` HGV-profile pattern. **Never a new schema/pack.**
- **Routing verbs for non-road modes** (vessel/aircraft Catchment/Optimization) are handled by
  registering a provider behind `ROUTING_PLATFORM.CONTRACT.*` (Tenet 1 routing seam) —
  out of scope here. Analytics intents stay mode-agnostic regardless.

## Retire list (end-to-end)

- **Schemas:** `FLEET_APP.TAXI`, `FLEET_APP.FOOD_DELIVERY` (dropped).
- **Packs:** `taxi`, `food_delivery` (removed from `manifest.yaml`; pack dirs deleted).
- **Semantic views:** `SV_TAXIS`, `SV_FOOD_DELIVERY`, `SV_FLEET_OPERATIONS` (superseded by `SV_FLEET_OPS`).
- **Agent tools:** `query_taxis`, `query_food_delivery`, `query_fleet_operations` (replaced by single `query_fleet_ops`).
- **Dashboard views:** `taxi_overview`, `taxi_routes`, `food_delivery`, `fleet_operations`, `fleet_map`
  (replaced by the six `fleetops_*` intents).
- `unified_fleet` pack **stays as substrate** — it owns `FLEET_APP.UNIFIED_FLEET` + the neutral
  `F_VW_FACT_*_SCOPED` contract that `FLEET_OPS` wraps. Its `semantic_views` entry is cleared
  (no SV; it is no longer a consumer-facing surface).

## Acceptance test for "universal"

Switching the active dataset's mode (e.g. `ebike` ↔ `hgv` ↔ `car`) flows through **every**
analytics intent (all six `fleetops_*` dashboards + the agent answering via `SV_FLEET_OPS`)
with **zero** new schema / view / SV / UI artifact. This is the stand-in for onboarding
`vessel` / `aircraft` (which then needs only a generated dataset + — for verb intents — a
routing provider behind `ROUTING_PLATFORM.CONTRACT`). Verified by pointing two concurrent
sessions at different-mode datasets and confirming isolated, correct rendering.
