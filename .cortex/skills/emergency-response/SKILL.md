---
name: emergency-response
description: "Region-generic Emergency Response evacuation-planning demo: a multi-step wizard in the FLEET_SA_APP that, for WHATEVER US region is active, colors counties by FEMA National Risk Index (flood/wildfire), seeds routable participants inside the drive-time isochrone union of the region's health-anchor care centers, and solves a capacitated multi-depot evacuation VRP. Data is produced by Data Studio (generates_hazard + generates_anchors); the wizard binds to the FLEET_APP.EMERGENCY_RESPONSE contract + evac_seed/evac_solve verbs. Use when: setting up emergency response demo, evacuation planning, hazard risk, flood or wildfire exposure, paratransit evacuation routing, participant pickup optimization. Do NOT use for: standard fleet tracking (use fleet-intelligence-car), retail trade area analysis (use retail-catchment), route deviation analytics (use route-deviation), generic dispatch (use route-optimization). Triggers: emergency response, evacuation planning, hazard risk, wildfire risk, flood risk, FEMA National Risk Index, NRI, evacuation routing, participant pickup, evacuation VRP."
depends_on:
  - install-fleet-apps
metadata:
  author: Snowflake SIT-IS
  version: 3.0.0
  category: demo
---

# Emergency Response (region-generic evacuation wizard)

**v3 — region-generic.** Emergency Response is now a normal Data Studio-generated
use case that runs for **whatever US region/dataset is active**, not a hardcoded
CA/CO/PA demo. The full 4-step wizard lives in the **FLEET_SA_APP** (view
`emergency_response`), binds to the neutral `FLEET_APP.EMERGENCY_RESPONSE`
contract for reads, and reaches routing through the `evac_seed` / `evac_solve`
User verbs. No ZIP-code share, no CareConnect CSV, no `STATE_REGION_MAP`.

The operator walks four steps on one map:

1. **Risk** — pick flood or wildfire; the map colors the active region's **counties**
   by FEMA National Risk Index level (1 Very Low … 5 Very High) from
   `FLEET_APP.EMERGENCY_RESPONSE.VW_HAZARD_ZONES`.
2. **Seed participants** — set isochrone minutes + participant count; `evac_seed`
   unions the drive-time isochrones of the region's health-anchor care centers
   (`VW_CARE_CENTERS`), samples routable Overture addresses inside it
   (MATRIX snap-filter ≤ 350 m), and tags each with county risk.
3. **Vans** — set vehicle count, per-van capacity, and max trips per van.
4. **Plan evacuation** — the wizard builds a capacitated multi-depot, multi-trip
   `pickup:[1]` challenge (each van → up to `maxTrips` virtual vehicles across the
   care centers) and solves it via `evac_solve` (ORS `OPTIMIZATION`); routes render
   on the map.

### How to run

1. In the **Admin app → Data Studio**, run a generation for your region with
   **Hazard** and **Anchors** enabled (every built-in preset already does — see
   `feeds: ['emergency-response']`). This populates `FACT_HAZARD_ZONES` +
   `DIM_ANCHORS` for that region.
2. In the **SA app**, select that region's dataset in the context bar and open
   **Emergency Response**. If the region has no hazard/anchor data the view shows
   an actionable empty state.

**US-only:** FEMA NRI covers the US, so hazard data generates only for US regions;
the wizard shows the empty state elsewhere.

### Architecture (source of truth)

| Layer | Object | Authored in |
|---|---|---|
| Data | `FACT_HAZARD_ZONES`, `DIM_ANCHORS` | Data Studio engines (`generates_hazard` / `generates_anchors`) |
| Contract | `FLEET_APP.EMERGENCY_RESPONSE.VW_HAZARD_ZONES` / `VW_CARE_CENTERS` (+ `F_VW_*_SCOPED`) | `fleet_sa_app/app/scoped_contract.sql` |
| Pack/gate | `emergency_response` (probe `VW_HAZARD_ZONES`) | `fleet_sa_app/app/packs/manifest.yaml` |
| Routing procs | `ROUTING_TOOLS.TOOL_EVAC_SEED` / `TOOL_EVAC_SOLVE` | `routing-agent/references/deploy-agent.sql` |
| Verbs | `evac_seed` / `evac_solve` | `fleet_tools/user/src/procs/` |
| Wizard | SA view `emergency_response` | `fleet_sa_app/ui/src/components/views/areas/emergency-response.tsx` |

### Retired (v2 CA/CO/PA)

The v2 pipeline is **retired** and no longer part of any install:
`EMERGENCY_RESPONSE.CONFIG.STATE_REGION_MAP`, `PIPELINE.V_ZIP_RISK` (ZIP-share),
`CORE.CARECONNECT_CENTERS` (the `careconnect_centers_geocoded.csv`), and
`ORS_ISOCHRONE_FOR_CENTER`. `references/sql-pipeline.sql` and the CSV remain only
as a historical reference for the old control-app wizard and are slated for
deletion. The county-level choropleth replaces the ZIP choropleth; generated
health anchors replace the curated PACE centers.

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

> **Superseded.** Everything below this line documents the **retired v2** CA/CO/PA
> pipeline (ZIP-share `V_ZIP_RISK`, CareConnect CSV, `STATE_REGION_MAP`) and the
> control-app wizard. It is kept for historical reference only; the live,
> region-generic model is the v3 architecture described above.


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
