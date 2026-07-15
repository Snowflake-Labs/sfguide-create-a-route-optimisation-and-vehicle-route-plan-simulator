---
name: emergency-response
description: "Region-generic Emergency Response evacuation-planning demo: a multi-step wizard in the FLEET_SA_APP that, for whatever region/dataset is active, colors the map by procedural hazard-zone risk (flood/wildfire), seeds participants inside the drive-time isochrone union of the region's health-anchor care centers, and solves a capacitated multi-depot evacuation VRP. Data is produced by Data Studio (generates_hazard + generates_anchors + generates_participants); the wizard binds to the FLEET_APP.EMERGENCY_RESPONSE contract + evac_seed/evac_solve verbs. Use when: setting up emergency response demo, evacuation planning, hazard risk, flood or wildfire exposure, paratransit evacuation routing, participant pickup optimization. Do NOT use for: standard fleet tracking (use fleet-intelligence-car), retail trade area analysis (use retail-catchment), route deviation analytics (use route-deviation), generic dispatch (use route-optimization). Triggers: emergency response, evacuation planning, hazard risk, wildfire risk, flood risk, hazard zones, evacuation routing, participant pickup, evacuation VRP."
depends_on:
  - install-fleet-apps
metadata:
  author: Snowflake SIT-IS
  version: 3.1.0
  category: demo
---

# Emergency Response (region-generic evacuation wizard)

**v3 - region-generic.** Emergency Response is a normal Data Studio-generated use
case that runs for **whatever region/dataset is active**. It is not tied to any
country or to a curated CA/CO/PA demo. The full 4-step wizard lives in the
**FLEET_SA_APP** (view `emergency_response`), binds to the neutral
`FLEET_APP.EMERGENCY_RESPONSE` contract for reads, and reaches routing through the
`evac_seed` / `evac_solve` User verbs. No ZIP-code share, no CareConnect CSV, no
`STATE_REGION_MAP`, no FEMA dependency.

The operator walks four steps on one map:

1. **Risk** - pick flood or wildfire; the map colors the active region's
   **hazard zones** by risk level (1 Very Low .. 5 Very High) from
   `FLEET_APP.EMERGENCY_RESPONSE.VW_HAZARD_ZONES`.
2. **Seed participants** - set isochrone minutes + participant count; `evac_seed`
   unions the drive-time isochrones of the region's health-anchor care centers
   (`VW_CARE_CENTERS`), samples Overture residential building points inside it,
   and tags each with the hazard risk of the zone it sits in.
3. **Vehicles** - set **vehicles per care center**, per-vehicle capacity, max trips per vehicle, and an **Optimize** mode. Every seeded care center is a depot, so the total fleet = centers x vehicles/center. Optimize = *Fastest completion* caps each trip's pickups (`max_tasks`) so VROOM spreads work across all vehicles in parallel (lowest completion time, more total km); *Fewest vehicles* consolidates into full trips (least total drive, higher completion).
4. **Plan evacuation** - the wizard builds a capacitated multi-depot, multi-trip
   `pickup:[1]` challenge (every care center is a depot with `vehicles/center` vehicles,
   each vehicle -> up to `maxTrips` virtual vehicles) and solves it via `evac_solve`
   (ORS `OPTIMIZATION`). Returned routes are scheduled across each center's vehicles
   (LPT), so the headline **Completion** metric is the parallel makespan (when the
   last vehicle finishes); routes render on the map.

## How it works (region-generic data)

All three data layers are generated per region by Data Studio and are worldwide:

- **Hazard zones** (`generates_hazard` -> `FACT_HAZARD_ZONES`): a procedural H3
  hexagon grid over the region boundary (or its bbox), emitting WILDFIRE, FLOOD,
  and COMPOSITE rows per cell. It is free, deterministic (seeded by region + JOB_ID),
  and works for **any** region with a boundary polygon - there is no FEMA / NRI /
  county-share dependency. `STATE`/`COUNTY`/`FIPS` are NULL; the H3 id is the zone id.
- **Care centers** (`generates_anchors` -> `DIM_ANCHORS`, `ANCHOR_TYPE='HEALTH_FACILITY'`):
  real Overture Places health facilities within the region.
- **Participants** (`generates_participants` -> `DIM_PARTICIPANTS`): residential
  Overture Building centroids sampled within `participant_radius_km` of the health
  anchors. Overture Buildings has global coverage, so this populates for every region.

### How to run

1. In the **Admin app -> Data Studio**, run a generation for your region with
   **Hazard**, **Anchors**, and **Participants** enabled (every built-in preset
   already does - see `feeds: ['emergency-response']`). This populates
   `FACT_HAZARD_ZONES` + `DIM_ANCHORS` + `DIM_PARTICIPANTS` for that region.
2. In the **SA app**, select that region's dataset in the context bar and open
   **Emergency Response**. If the region has no hazard/anchor data the view shows
   an actionable empty state.
3. Ensure the region's ORS + VROOM services are **RUNNING**
   (`SHOW SERVICES IN DATABASE OPENROUTESERVICE_APP;`) so `evac_seed` / `evac_solve`
   can call `ISOCHRONES` / `OPTIMIZATION`.

## Architecture (source of truth)

| Layer | Object | Authored in |
|---|---|---|
| Data | `FACT_HAZARD_ZONES`, `DIM_ANCHORS`, `DIM_PARTICIPANTS` | Data Studio engines (`generates_hazard` / `generates_anchors` / `generates_participants`) |
| Contract | `FLEET_APP.EMERGENCY_RESPONSE.VW_HAZARD_ZONES` / `VW_CARE_CENTERS` (+ `F_VW_*_SCOPED`) | `install-fleet-apps/fleet_sa_app/app/scoped_contract.sql` |
| Pack/gate | `emergency_response` (probe `VW_HAZARD_ZONES`) | `install-fleet-apps/fleet_sa_app/app/packs/manifest.yaml` |
| Routing procs | `ROUTING_TOOLS.TOOL_EVAC_SEED` / `TOOL_EVAC_SOLVE` | `routing-agent/references/deploy-agent.sql` |
| Verbs | `evac_seed` / `evac_solve` | `install-fleet-apps/fleet_tools/user/src/procs/` |
| Wizard | SA view `emergency_response` | `install-fleet-apps/fleet_sa_app/ui/src/components/views/areas/emergency-response.tsx` |

## Prerequisites

1. ORS app deployed via `install-fleet-apps`. The region(s) you demo must have a
   **DEPLOYED + RUNNING** ORS region (verify with
   `SHOW SERVICES IN DATABASE OPENROUTESERVICE_APP;`). Provision new regions from the
   Admin app Region Builder as needed.
2. **Overture Maps places** share -> `OVERTURE_MAPS__PLACES.CARTO.PLACE` (health-anchor pool).
3. **Overture Maps buildings** share -> `OVERTURE_MAPS__BUILDINGS.CARTO.BUILDING`
   (residential building centroids are the participant/household pool, generated for every region by Data Studio).

Both Overture shares are created and granted by `install-fleet-apps`
(`scripts/analytic_layer.sql` + `fleet_sa_app/app/role_binding.sql`), so a fresh
install needs no extra setup. There is no FEMA NRI or ZIP-code share dependency.

## Required Privileges

| Privilege | Scope | Reason |
|-----------|-------|--------|
| USAGE ON DATABASE `OPENROUTESERVICE_APP` | DB | Calls ISOCHRONES / OPTIMIZATION / ORS_STATUS |
| USAGE ON `FLEET_APP.EMERGENCY_RESPONSE` views | Schema | Reads hazard zones / care centers / participants |
| USAGE on the User synapse MCP / verbs | Role | Runs `evac_seed` / `evac_solve` |
| IMPORTED PRIVILEGES | Shares | Read Overture Places + Overture Buildings |

> ACCOUNTADMIN is NOT required. The grants above are applied by `install-fleet-apps`.

## Data Model

```
SYNTHETIC_DATASETS.UNIFIED.FACT_HAZARD_ZONES   (per-region H3 hazard cells; WILDFIRE/FLOOD/COMPOSITE; risk 1-5)
SYNTHETIC_DATASETS.UNIFIED.DIM_ANCHORS         (HEALTH_FACILITY = care centers, from Overture Places)
SYNTHETIC_DATASETS.UNIFIED.DIM_PARTICIPANTS    (participant/household pool, residential Overture Building centroids)
        |  (all keyed by REGION + JOB_ID, exposed via FLEET_APP.EMERGENCY_RESPONSE.F_VW_*_SCOPED)
        v
FLEET_APP.EMERGENCY_RESPONSE.VW_HAZARD_ZONES / VW_CARE_CENTERS   (active-dataset contract views)
```

Risk level is the 1-5 ordinal; flood and wildfire are independent smooth gradients
plus deterministic hotspots seeded per region + JOB_ID. `COMPOSITE` blends the two.

## Examples

### Example 1: United Kingdom wildfire
User: "Run a UK wildfire evacuation."
1. In Data Studio, run a generation for `UnitedKingdom` with Hazard + Anchors + Participants enabled.
2. Ensure `ORS_SERVICE_UNITEDKINGDOM` + `VROOM_SERVICE_UNITEDKINGDOM` are RUNNING.
3. In the SA app select the UK dataset -> open Emergency Response -> hazard `Wildfire`, 45 min, 60 participants -> set vehicles -> Plan evacuation.

### Example 2: San Francisco flood
User: "Demo a San Francisco flood scenario."
1. Ensure the SanFrancisco region has an active dataset with hazard/anchor/participant data.
2. Same wizard flow with hazard `Flood`.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "No Emergency Response data" empty state | Run Data Studio for this region with Hazard + Anchors + Participants enabled. |
| "ORS region not running" banner | Resume the region's ORS + VROOM services. |
| Seed returns 0 participants | Increase isochrone minutes, or the region has no residential buildings near its care centers. |
| Plan returns no routes | VROOM warming up - retry in ~20s; or capacity is 0 for all centers. |

## Error Logging

> Follow the Error Logging convention in AGENTS.md. Log file prefix: `emergency-response`.

## Cleanup

Emergency Response owns no standalone Snowflake objects - its data lives in the
shared `SYNTHETIC_DATASETS.UNIFIED` tables (managed by Data Studio dataset
versioning) and is read through the `FLEET_APP.EMERGENCY_RESPONSE` contract views
created by `install-fleet-apps`. To remove a region's data, delete its dataset from
the Admin app Data Studio Datasets panel.

> **Tip:** Use `routing-solution-cleanup` to discover all tagged objects via the COMMENT tag `oss-emergency-response`.
