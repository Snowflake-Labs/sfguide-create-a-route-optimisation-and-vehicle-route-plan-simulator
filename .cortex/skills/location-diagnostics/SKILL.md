---
name: location-diagnostics
description: "Deploy the Location Diagnostics demo: region-agnostic retail site cannibalisation and closure modelling built from existing Overture data (a POI subset becomes the store estate) plus the live ORS drive-time engine. Adds the FLEET_INTELLIGENCE.LOCATION layer, FLEET_APP.LOCATION contract views, SV_LOCATION, and the Site Impact + Closure Impact app views. Use when: setting up store cannibalisation / transfer modelling, closure impact, next-closest-store analysis, retail location diagnostics. Do NOT use for: fleet tracking (fleet-intelligence-car/ebike), route optimization VRP (route-optimization), single-store catchment visualization (retail-catchment). Triggers: location diagnostics, cannibalisation modelling, transfer modelling, store closure impact, next closest store, retail site impact, catchment overlap."
depends_on:
  - install-fleet-apps
metadata:
  author: Snowflake SIT-IS
  version: 1.0.0
  category: demo
---

# Deploy Location Diagnostics Demo

Region-agnostic store-location intelligence for retail site decisions, covering the two highest-value workstreams from the customer's "Location Diagnostics" brief:

- **Cannibalisation / transfer modelling** - for a candidate new site, how much revenue and EBITDA it draws from the existing estate, by drive-time band and by existing store, split by interaction type (Home Visit / Sample / Walk-in).
- **Closure modelling** - if an existing store closes, which surviving store inherits its households and sales via the next-closest-store (drive-time) approach.

Everything is built from data already present in the accelerator: a deterministic subset of `FLEET_INTELLIGENCE.CATCHMENT.POIS` (the region's most spatially-spread retail category) becomes the **store estate** (OWNED existing + CANDIDATE proposed sites); `CATCHMENT.REGIONAL_ADDRESSES` is the **household proxy**; and drive-time bands (10/15/20/25/30/45/60 min) come from the live OpenRouteService engine. The estate's commercial figures (revenue, EBITDA, HV/Sample/Walk-in mix, sqft, rent) are **synthetic, deterministic proxies** - clearly a stand-in for a customer's first-party sales, not real data. To plug in richer branded first-party data, see [references/data-studio-extension.md](references/data-studio-extension.md).

> Deferred to a follow-on slice (not built here): gap / penetration analysis, competitor & catchment analytics, property benchmarking, retail-park intelligence. The `FLEET_INTELLIGENCE.LOCATION` layer and `SV_LOCATION` are designed to extend to those.

## Prerequisites

CRITICAL: Verify these before starting:
- `install-fleet-apps` has been run (FLEET_SA_APP + FLEET_APP contract + `FLEET_INTELLIGENCE.CATCHMENT.*` populated + roles exist).
- The **active dataset's region has a provisioned, RUNNING ORS graph** (`driving-car` profile). Check with `SELECT TO_VARCHAR(OPENROUTESERVICE_APP.CORE.ORS_STATUS('<region>'))` -> `service_ready:true`. If suspended, `CALL OPENROUTESERVICE_APP.CORE.RESUME_ALL_SERVICES()`. To add a new region, provision it first (see `routing-customization`).
- `FLEET_INTELLIGENCE.CATCHMENT.POIS` and `REGIONAL_ADDRESSES` have rows for the active region (built by `install-fleet-apps` step 3.5 `analytic_layer.sql`).

## Required Privileges

| Privilege | Scope | Reason |
|-----------|-------|--------|
| USAGE | DATABASE OPENROUTESERVICE_APP | Call ISOCHRONES (drive-time bands) |
| USAGE | DATABASE FLEET_INTELLIGENCE + CATCHMENT schema | Read POIs / addresses |
| CREATE SCHEMA | FLEET_INTELLIGENCE, FLEET_APP | Create LOCATION schemas |
| CREATE TABLE / VIEW / PROCEDURE | FLEET_INTELLIGENCE.LOCATION | Build the diagnostics layer |
| CREATE VIEW | FLEET_APP.LOCATION | Neutral-contract views |
| CREATE SEMANTIC VIEW | FLEET_INTELLIGENCE.SEMANTIC | SV_LOCATION for Cortex Analyst |
| GRANT | FLEET_APP_USER / _OPS / _ADMIN roles | App read access |

> **Note:** ACCOUNTADMIN is NOT required. Any role with the above privileges works.

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| Region | active dataset (`FLEET_INTELLIGENCE.CATCHMENT.CONFIG`) | Region whose estate is built; must have an ORS graph |
| Owned stores | 10 | Existing estate size (one per H3 res-6 cell of the primary category) |
| Candidate sites | 3 | Proposed new sites |
| Drive-time bands | 10,15,20,25,30,45,60 (min) | `FLEET_INTELLIGENCE.LOCATION.BANDS` |
| Capture rate | 0.5 | Share of overlapping demand a candidate captures (cannibalisation) |

To change owned/candidate counts or bands, edit `BUILD_LOCATION_DIAGNOSTICS` / the `BANDS` seed in `scripts/analytic_layer.sql` and re-run the build.

## Workflow

The `FLEET_INTELLIGENCE.LOCATION` layer, `FLEET_APP.LOCATION` views, `SV_LOCATION`, and the two app views all ship inside `install-fleet-apps`. This skill's job is to (re)build the layer for the active region and surface the views.

1. **Set the query tag** for attribution:
   ```sql
   ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-location-diagnostics","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
   ```
2. **Verify ORS** for the active region is `service_ready:true` (resume if needed).
3. **Build the layer** (precomputes estate, isochrones, household cells, facts, cannibalisation, closure). Idempotent per region; the isochrone loop makes ~ (owned+candidate) x bands ORS calls (default ~91), a few minutes:
   ```sql
   CALL FLEET_INTELLIGENCE.LOCATION.BUILD_LOCATION_DIAGNOSTICS();
   ```
   If the objects/proc do not yet exist (older install), run the `5. LOCATION DIAGNOSTICS` section of `.cortex/skills/install-fleet-apps/scripts/analytic_layer.sql` first (it creates the schema, tables, proc, calls it, and creates the `FLEET_APP.LOCATION` contract views + grants).
4. **Verify** the derived tables are populated:
   ```sql
   SELECT 'STORES' T, COUNT(*) N FROM FLEET_INTELLIGENCE.LOCATION.STORES
   UNION ALL SELECT 'ISOCHRONES', COUNT(*) FROM FLEET_INTELLIGENCE.LOCATION.STORE_ISOCHRONES
   UNION ALL SELECT 'FACTS', COUNT(*) FROM FLEET_INTELLIGENCE.LOCATION.STORE_FACTS
   UNION ALL SELECT 'CANNIBALISATION', COUNT(*) FROM FLEET_INTELLIGENCE.LOCATION.CANNIBALISATION
   UNION ALL SELECT 'CLOSURE', COUNT(*) FROM FLEET_INTELLIGENCE.LOCATION.CLOSURE_REASSIGNMENT;
   ```
5. **Deploy the app config** (the Site Impact + Closure Impact views live in `app-views.json`):
   ```bash
   SKIP_SERVICE=0 bash .cortex/skills/install-fleet-apps/scripts/deploy_fleet_sa_app.sh <connection>
   ```
   Or, config-only: upload `app-views.json` to `@FLEET_INTELLIGENCE.SYNAPSE_USER.FLEET_APP_STAGE/config/` and suspend/resume `FLEET_INTELLIGENCE.SYNAPSE_USER.FLEET_SA_APP`.
6. **(Optional) Rebind the agent** so chat/Analyst can answer via `query_location` (SV_LOCATION): re-run `create_agents.sh <connection>` after the `agent-spec.json` change. Not required for the dashboard views.

## How it works

- **Store estate** - the region's `BASIC_CATEGORY` with the most distinct H3 res-6 cells is chosen (data-derived, not hardcoded); one POI per cell is taken, first 10 flagged `OWNED`, next 3 `CANDIDATE`.
- **Drive-time bands** - `OPENROUTESERVICE_APP.CORE.ISOCHRONES('driving-car', lon, lat, band_min, region)` per store (range is in MINUTES). ORS SQL table functions only evaluate with LITERAL args, so a stored-proc loop issues literal `EXECUTE IMMEDIATE` inserts.
- **Household proxy** - addresses aggregated to H3 res-8 cells (`HH_CELLS`) with a representative centroid.
- **Cannibalisation** - candidate band polygon intersected with each owned store's 20-min catchment; shared households / owned households x capture -> transferred revenue, split by the owned store's interaction mix. Bands are **nested what-if scenarios**; pick ONE band, never sum across bands for a pair.
- **Closure** - each closed store's 20-min household cells reassigned to the nearest OTHER owned store (smallest band containing the cell, tie = distance); households and revenue aggregated per gaining store.

## Output

- Tables: `FLEET_INTELLIGENCE.LOCATION.{STORES, BANDS, STORE_ISOCHRONES, HH_CELLS, STORE_FACTS, CANNIBALISATION, CLOSURE_REASSIGNMENT}`
- Contract views: `FLEET_APP.LOCATION.{VW_STORES, VW_STORE_ISOCHRONES, VW_STORE_FACTS, VW_CANNIBALISATION, VW_CLOSURE_REASSIGNMENT}`
- Semantic view: `FLEET_INTELLIGENCE.SEMANTIC.SV_LOCATION` (agent tool `query_location`)
- App views: **Site Impact** (cannibalisation) and **Closure Impact** under the Location category

## Data Studio Extension (optional)

The synthetic commercials are a demo proxy. To drive the same views from richer, branded first-party facts (real sales, EBITDA, interaction-type splits, and a Mosaic-style segmentation), see [references/data-studio-extension.md](references/data-studio-extension.md) for a proposed `engine/estate.ts` generator and segmentation table.

## Cleanup

```sql
DROP VIEW IF EXISTS FLEET_APP.LOCATION.VW_STORES;
DROP VIEW IF EXISTS FLEET_APP.LOCATION.VW_STORE_ISOCHRONES;
DROP VIEW IF EXISTS FLEET_APP.LOCATION.VW_STORE_FACTS;
DROP VIEW IF EXISTS FLEET_APP.LOCATION.VW_CANNIBALISATION;
DROP VIEW IF EXISTS FLEET_APP.LOCATION.VW_CLOSURE_REASSIGNMENT;
DROP SCHEMA IF EXISTS FLEET_APP.LOCATION;
DROP SEMANTIC VIEW IF EXISTS FLEET_INTELLIGENCE.SEMANTIC.SV_LOCATION;
DROP SCHEMA IF EXISTS FLEET_INTELLIGENCE.LOCATION;
```
Then remove the `site_impact` and `closure_impact` keys from `app-views.json`, the `query_location` tool + resource from `agent-spec.json`, and `SV_LOCATION` from `semantic_views.sql`, and redeploy.
