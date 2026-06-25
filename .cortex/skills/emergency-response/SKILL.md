---
name: emergency-response
description: "Deploy the Emergency Response evacuation-planning demo: a single-page, multi-step React wizard that finds at-risk ZIP codes for a flood or wildfire scenario (FEMA National Risk Index), seeds CareConnect PACE centers plus synthetic participant addresses from Overture Maps inside drive-time isochrones, and solves a capacitated multi-depot evacuation VRP with ORS OPTIMIZATION. Use when: setting up emergency response demo, evacuation planning, hazard risk by ZIP, flood or wildfire exposure, CareConnect / PACE / paratransit evacuation routing, participant pickup optimization. Do NOT use for: standard fleet tracking (use fleet-intelligence-taxis), retail trade area analysis (use retail-catchment), route deviation analytics (use route-deviation), generic dispatch (use route-optimization). Triggers: emergency response, evacuation planning, hazard risk, wildfire risk, flood risk, ZIP risk, FEMA National Risk Index, NRI, evacuation routing, participant pickup, CareConnect, PACE."
depends_on:
  - install-fleet-apps
metadata:
  author: Snowflake SIT-IS
  version: 2.0.0
  category: demo
---

# Deploy Emergency Response (Evacuation Planning Wizard)

A single-page, multi-step wizard inside the existing `ors_control_app`. The operator walks four steps on one map:

1. **Find risky areas** — pick a disaster type (flood or wildfire) and a US state; the map colors every ZIP code by its FEMA National Risk Index level (1 Very Low … 5 Very High).
2. **Seed data** — enter a number of patient locations and a drive time (minutes); the app places the state's CareConnect PACE centers, draws the union of per-center drive-time isochrones (sanity overlay), and samples participant addresses from Overture Maps uniformly across that union.
3. **Vehicles** — for each center, set a vehicle count and per-vehicle passenger capacity, plus a max trips per vehicle (vans shuttle back to the center to evacuate everyone).
4. **Plan evacuation** — pick a risk threshold; the app solves a capacitated multi-depot, multi-trip VRP (`OPENROUTESERVICE_APP.CORE.OPTIMIZATION`, `pickup:[1]` jobs) over every seeded participant whose home ZIP is at the selected risk level or higher. Each van is expanded into up to `maxTrips` round trips; the panel lists every trip and selecting one highlights its route with numbered stop markers. KPIs report evacuated / trips / drive minutes and warn if the trip cap leaves an overflow.

The wizard is fully client-driven: every step issues a read-only `SELECT` via `/api/query` (risk ZIPs, the isochrone union + Overture sampling in one query, VROOM solve), mirroring `route-optimization` / `asset-velocity` / `backload-matching`. No server-side scenario state is persisted.

## Prerequisites

1. ORS app deployed via `install-fleet-apps`. The state(s) you demo must have a **DEPLOYED + RUNNING** ORS region (verify with `SHOW SERVICES IN DATABASE OPENROUTESERVICE_APP;`). The shipped `STATE_REGION_MAP` covers CA→`UsCalifornia`, CO→`UsColorado`, PA→`UsPennsylvania`. Add rows for more states as their graphs are provisioned.
2. **FEMA National Risk Index (Free)** — Marketplace listing `GZSTZKU9FH9` → `FEMA_NATIONAL_RISK_INDEX.NRI_SCH.NRI_COUNTIES` (auto-installed in Step 0a of `references/sql-pipeline.sql`).
3. **US ZIP metadata + geometry** share → `U_S__ZIP_CODE_METADATA_WITH_GEOMETRY.PUBLIC.{ZIP_CODE_META_SHARE, ZIP_CODE_GEOMETRY_SHARE}`.
4. **Overture Maps addresses** share → `OVERTURE_MAPS__ADDRESSES.CARTO.ADDRESS`.
5. **OpenCage secret** `OPENROUTESERVICE_APP.CORE.OPENCAGE_API_KEY` + `ORS_GEOCODE_EAI` external-access integration (egress `api.opencagedata.com:443`). Used **only at build time** to geocode the 18 CareConnect centers lacking coordinates; the resolved coordinates are committed to `datasets/careconnect_centers_geocoded.csv`, so a fresh install needs no runtime geocoding.

## Required Privileges

| Privilege | Scope | Reason |
|-----------|-------|--------|
| CREATE DATABASE | Account | Creates `EMERGENCY_RESPONSE` |
| CREATE SCHEMA | DB `EMERGENCY_RESPONSE` | Creates `CONFIG`, `CORE`, `PIPELINE` |
| CREATE TABLE | DB `EMERGENCY_RESPONSE` | `CARECONNECT_CENTERS`, `STATE_REGION_MAP` |
| CREATE VIEW | DB `EMERGENCY_RESPONSE` | `PIPELINE.V_ZIP_RISK` |
| CREATE FUNCTION | DB `EMERGENCY_RESPONSE` | `ORS_ISOCHRONE_FOR_CENTER` |
| CREATE STAGE | Schema `EMERGENCY_RESPONSE.CONFIG` | `SEED_STAGE` for the committed centers CSV |
| USAGE ON DATABASE `OPENROUTESERVICE_APP` | DB | Calls ISOCHRONES / OPTIMIZATION / ORS_STATUS |
| IMPORT SHARE | Account | Install FEMA NRI listing (Step 0a) |
| IMPORTED PRIVILEGES | Shares | Read NRI, ZIP metadata, Overture addresses |

> ACCOUNTADMIN is NOT required. Grant the above to `EMERGENCY_RESPONSE_ROLE`.

## Configuration

The only persisted config is the state → ORS region map:

`EMERGENCY_RESPONSE.CONFIG.STATE_REGION_MAP (STATE_CODE, STATE_NAME, ORS_REGION, ENABLED)`

| State | ORS region | Notes |
|-------|-----------|-------|
| CA | `UsCalifornia` | resume `ORS_SERVICE_USCALIFORNIA` before demoing CA |
| CO | `UsColorado` | deployed |
| PA | `UsPennsylvania` | deployed |

Wizard inputs (patient count, drive minutes, per-center vehicles/capacity, risk threshold) are entered live in the UI — no config table.

## Data Model

```
FEMA_NATIONAL_RISK_INDEX.NRI_SCH.NRI_COUNTIES  (county risk ratings)
        |  STCOFIPS = ZIP county FIPS
        v
U_S__ZIP_CODE_METADATA_WITH_GEOMETRY (ZIP polygon + county FIPS)
        |
        v
EMERGENCY_RESPONSE.PIPELINE.V_ZIP_RISK         (per-ZIP flood/wildfire level 0-5)

EMERGENCY_RESPONSE.CORE.CARECONNECT_CENTERS      (20 centers, GEOGRAPHY LOC)
EMERGENCY_RESPONSE.CORE.ORS_ISOCHRONE_FOR_CENTER(loc, minutes, region)  -> GEOGRAPHY
OVERTURE_MAPS__ADDRESSES.CARTO.ADDRESS          (participant address pool)
```

Flood level = the higher of riverine (`RFLD_RISKR`) and coastal (`CFLD_RISKR`) ratings; wildfire = `WFIR_RISKR`. Ratings map to ordinal 1–5 (`Very Low`..`Very High`); `No Rating`/`Insufficient Data`/`Not Applicable` → 0.

> **Relationship to Data Studio universal generation.** The fleet stack now has a
> region-scoped hazard primitive — `SYNTHETIC_DATASETS.UNIFIED.FACT_HAZARD_ZONES`
> (FEMA NRI × Overture Divisions county polygons, surfaced via
> `V_FACT_HAZARD_ZONES_CURRENT`) — and a location-anchor primitive
> (`V_DIM_ANCHORS_CURRENT`, `ANCHOR_TYPE='HEALTH_FACILITY'`). Emergency Response
> intentionally **retains** its own `V_ZIP_RISK` and curated `CARECONNECT_CENTERS`
> because it has two requirements the universal tables do not yet meet:
> (1) **ZIP-level** risk for the ZIP choropleth (FACT_HAZARD_ZONES is county-level),
> and (2) **multi-state** scope (CA/CO/PA at once; the universal tables hold a
> single active region) with **curated, named** PACE centers. Migrating this demo
> onto the universal tables requires per-state generation + a ZIP-level hazard
> rollup, and is tracked as a future enhancement; until then `V_ZIP_RISK` +
> `CARECONNECT_CENTERS` remain the source of truth here by design.


## Workflow

### Step 1 — Deploy the SQL pipeline

From repo root (run the statements in `references/sql-pipeline.sql`), then upload the committed centers CSV and load it:

```bash
snow stage copy \
  .cortex/skills/emergency-response/datasets/careconnect_centers_geocoded.csv \
  @EMERGENCY_RESPONSE.CONFIG.SEED_STAGE/ --overwrite -c <connection>
```

The pipeline installs FEMA NRI, creates `EMERGENCY_RESPONSE` (CONFIG/CORE/PIPELINE), seeds `STATE_REGION_MAP`, loads `CARECONNECT_CENTERS` (20 rows), builds `V_ZIP_RISK` and `ORS_ISOCHRONE_FOR_CENTER`, and drops retired v1 objects. Every CREATE carries the COMMENT tracking tag.

### Step 2 — Verify

```sql
SELECT COUNT(*) FROM EMERGENCY_RESPONSE.CORE.CARECONNECT_CENTERS;                              -- 20
SELECT WILDFIRE_LEVEL, COUNT(*) FROM EMERGENCY_RESPONSE.PIPELINE.V_ZIP_RISK WHERE STATE='CO' GROUP BY 1 ORDER BY 1;
SHOW SERVICES IN DATABASE OPENROUTESERVICE_APP;   -- target state's ORS + VROOM RUNNING
```

### Step 3 — Deploy the control-app image

The wizard lives in `src/components/emergency/EmergencyResponse.tsx` (+ `helpers.ts`) and appears as the single **Emergency Response** sidebar item. Rebuild and redeploy `ors_control_app` per the AGENTS.md "Control App Image Deployment" section (bump `image-versions.env` + service YAML, `snow stage copy` the spec, suspend → update → resume). Then open the printed endpoint and select **Emergency Response**.

## Geocoding the centers (build-time only)

The 18 centers without coordinates were geocoded once with a transient Python UDF that reads the `OPENCAGE_API_KEY` secret through `ORS_GEOCODE_EAI`, and the results were committed to `datasets/careconnect_centers_geocoded.csv`. To re-geocode (e.g. new centers), recreate that UDF, run it over the new addresses, write the coordinates back into the CSV, and drop the UDF. No runtime geocoding occurs.

## Error Logging

> Follow the Error Logging convention in AGENTS.md. Log file prefix: `emergency-response`.

## Examples

### Example 1: Colorado wildfire
User: "Deploy emergency response and run a Colorado wildfire evacuation."
1. Run `references/sql-pipeline.sql`; upload + load the centers CSV.
2. Ensure `ORS_SERVICE_USCOLORADO` + `VROOM_SERVICE_USCOLORADO` are RUNNING.
3. Open Emergency Response → hazard `Wildfire`, state `Colorado` → Find risky areas → Seed data (150 patients, 15 min) → set vehicles → threshold 4 → Plan evacuation.

### Example 2: California (suspended region)
User: "Demo a California flood scenario."
1. Resume the `UsCalifornia` ORS + VROOM services (`ORS_SERVICE_USCALIFORNIA`, `VROOM_SERVICE_USCALIFORNIA`) via the Service Manager.
2. Same wizard flow with hazard `Flood`, state `California`.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "ORS region not running" banner | Resume the state's ORS + VROOM services; CA ships suspended. |
| Seed returns 0 participants | Drive time too small or centers outside graph; increase minutes. |
| Plan returns no routes | VROOM warming up — retry in ~20s; or capacity 0 for all centers. |
| All ZIPs render risk 0 | County has `No Rating`/`Insufficient Data` in NRI for that hazard. |
| Risers not colored as expected | Flood uses max(riverine, coastal); inland states show riverine only. |

## Cleanup

```sql
DROP DATABASE IF EXISTS EMERGENCY_RESPONSE CASCADE;
-- Optional, only if no other skill uses it:
-- DROP DATABASE IF EXISTS FEMA_NATIONAL_RISK_INDEX;
-- Control-app code (src/components/emergency/*) is removed by reverting the
-- related commits on feat/<github_login>-feat.
```

> **Tip:** Use `routing-solution-cleanup` to discover all tagged objects via the COMMENT tag `oss-emergency-response`.
