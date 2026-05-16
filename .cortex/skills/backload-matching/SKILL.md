---
name: backload-matching
description: "Deploy the Backload Matching Engine demo: a fleet-wide VRP solve over idle-bound trailers + internal volumes + external freight-exchange offers, anchored on the OPENROUTESERVICE_APP.CORE.OPTIMIZATION function. The page picks one or many trailers, calls OPTIMIZATION once, and renders empty/loaded legs, KPI savings, and a Cortex rationale. Use when: setting up the DHL Freight backload demo, asset velocity / trailer rotation use cases, freight-exchange aggregation, internal-first vs external-second proposals, multi-trailer joint dispatch. Do NOT use for: route optimization VRP from PLACES (use route-optimization), route deviation analysis (use route-deviation), retail catchment (use retail-catchment), fleet intelligence taxi/food-delivery demos, or single-leg directions tests (use FunctionTester). Triggers: backload, backload matching, empty mile, empty leg, asset velocity, trailer rotation, freight exchange, freight exchanges, idle trailer, idle-bound trailer, Timocom, WTransnet, Teleroute, B2P, DHL, DHL Freight, dispatcher proposal, internal-first match, supply chain action engine, NTBO, line-haul VRP, drop-and-hook."
depends_on:
  - build-routing-solution
  - route-optimization
metadata:
  author: Snowflake SIT-IS
  version: 1.0.0
  category: demo
---

# Deploy Backload Matching Engine

Adds a parallel page to the ORS Control App that solves the *backload* problem for any line-haul fleet with imbalanced lanes: trailers reaching the continent and waiting up to three days for a return load. The page issues a **single `OPENROUTESERVICE_APP.CORE.OPTIMIZATION(...)` call** that jointly assigns N idle-bound trailers to a pool of internal volumes (own waiting shipments) and external offers (synthesized in the style of Timocom, WTransnet, Teleroute, B2P), minimizing total empty kilometres. Internal-first preference is encoded as VROOM `priority`; ADR/equipment gating uses VROOM `skills`; direction-to-home bias is encoded in each vehicle's `end` location. Accepted plans are written back to `PROPOSAL_DECISIONS` to close the *Action Engine* loop.

The existing **Route Optimization** and **Asset Velocity** pages are **not modified** — Backload is an additive, parallel page.

## Use Case Narrative

See `references/use-case-narrative.md` for the full story. Summary anchored in the May 5 NTBO call with DHL Freight (Volker Nachtsheim / Martin Ahleff) and the Asset Velocity Case 4 slide:

- ~2,500 trailers, ~100 Nordic dispatchers, ~20 new orders/min across Europe.
- Trailers reach the continent and wait up to **3 days** in Paris for backloads.
- Today: manual portal-hopping across Timocom, WTransnet, Teleroute, B2P.
- Desired: fleet-wide *"give me a structural plan for tomorrow"* — internal-first, external-second.
- Generalises 1:1 to Maersk Inland, K+N Road, DSV, XPO, Geodis, Dachser, FedEx Freight, Schneider, J.B. Hunt — anyone with imbalanced lanes.

## Prerequisites

- `build-routing-solution` deployed (OPENROUTESERVICE_APP database with all 4 ORS services running, `Germany` region provisioned).
- `route-optimization` deployed (FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES seeded — only used to confirm the OPTIMIZATION function is callable).
- Synthetic datasets seeded under `SYNTHETIC_DATASETS.UNIFIED.*` (DIM_FLEET, FACT_TRIPS) — not strictly required for the page, but kept as a dependency since this skill was scoped against that dataset.

## Required Privileges

| Privilege | Scope | Reason |
|-----------|-------|--------|
| USAGE ON DATABASE FLEET_INTELLIGENCE | Database | Demo database |
| CREATE SCHEMA | Database (FLEET_INTELLIGENCE) | Creates BACKLOAD_MATCHING schema |
| CREATE TABLE | Schema (FLEET_INTELLIGENCE.BACKLOAD_MATCHING) | CONFIG, TRAILERS, INTERNAL_VOLUMES, EXTERNAL_OFFERS, PROPOSAL_DECISIONS |
| CREATE VIEW | Schema (FLEET_INTELLIGENCE.BACKLOAD_MATCHING) | VW_TRAILERS, VW_BACKLOAD_CANDIDATES |
| USAGE ON DATABASE OPENROUTESERVICE_APP | Database | Calls OPTIMIZATION + DIRECTIONS + ISOCHRONES (driving-hgv) |
| USAGE ON SCHEMA OPENROUTESERVICE_APP.CORE | Schema | Same |
| USAGE ON FUNCTION OPENROUTESERVICE_APP.CORE.OPTIMIZATION(VARIANT) | Function | Solver entry point |
| USAGE ON WAREHOUSE ROUTING_ANALYTICS | Warehouse | Powers the page queries |
| USAGE ON DATABASE SNOWFLAKE | Database | Calls SNOWFLAKE.CORTEX.COMPLETE for "Why this assignment?" |

> **Note:** ACCOUNTADMIN is NOT required.

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| DATABASE | `FLEET_INTELLIGENCE` | Database for demo objects |
| SCHEMA | `BACKLOAD_MATCHING` | Schema for backload tables and views |
| WAREHOUSE | `ROUTING_ANALYTICS` | Warehouse for queries |
| REGION | `Germany` | Provisioned ORS region the demo runs against |
| HOME_REGION | `Nordics` | Country group counted as "back-to-home" |
| HOME_LAT / HOME_LON | `55.6759 / 12.5655` | Anchor (Copenhagen) used as vehicle `end` |
| TRAILER_COUNT | `80` | Idle-bound trailers seeded |
| INTERNAL_VOLUMES_COUNT | `120` | Internal waiting loads seeded |
| EXTERNAL_OFFERS_COUNT | `300` | Synthetic external offers seeded |
| INTERNAL_PRIORITY | `100` | VROOM `priority` on internal jobs |
| EXTERNAL_PRIORITY | `10` | VROOM `priority` on external offers |
| TIME_WINDOW_TOLERANCE_HRS | `4` | Pickup-window slack added to jobs |
| MAX_EMPTY_KM_PER_LEG | `200` | Hard skip in candidate pre-filter |
| MAX_VEHICLES_PER_SOLVE | `30` | Solver caps vehicles per call to keep ORS responsive |
| EUR_PER_EMPTY_KM | `1.20` | Used for KPI ("EUR/day reclaimed") |
| IDLE_COST_EUR_PER_DAY | `650` | Used for KPI ("EUR/day reclaimed") |

## Error Logging

> Follow the Error Logging convention in `AGENTS.md`. Log file prefix: `backload-matching`.

## Workflow

### Step 1: Set Query Tag

```sql
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-backload-matching","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

### Step 2: Verify Prerequisites

```sql
SHOW SERVICES IN DATABASE OPENROUTESERVICE_APP;            -- 4 services RUNNING
SELECT COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES;  -- > 0
DESC FUNCTION OPENROUTESERVICE_APP.CORE.OPTIMIZATION(VARIANT);     -- exists
```

If any step fails, deploy the upstream skill first.

### Step 3: Run Demo Data Loader

Run `references/load-demo-data.sql` from the active connection:

```bash
snow sql -f .cortex/skills/backload-matching/references/load-demo-data.sql -c <ACTIVE_CONNECTION>
```

This file is **autogenerated** by `tools/gen_demo_data.py`. To change row counts, cities, or product distribution, edit the Python file and re-run:

```bash
python3 .cortex/skills/backload-matching/tools/gen_demo_data.py \
  > .cortex/skills/backload-matching/references/load-demo-data.sql
```

The loader creates `FLEET_INTELLIGENCE.BACKLOAD_MATCHING.{TRAILERS, VW_TRAILERS, INTERNAL_VOLUMES, VW_INTERNAL_VOLUMES, EXTERNAL_OFFERS, VW_EXTERNAL_OFFERS, PROPOSAL_DECISIONS}` and inserts 80 / 120 / 300 rows. Coords stay inside the Germany ORS bbox (5.86E..15.05E, 47.27N..55.15N) so HGV routing works.

### Step 4: Rebuild and Redeploy ORS Control App

The new page lives inside the existing `ors_control_app` SPCS service. Follow the `Control App Image Deployment` block in `AGENTS.md`:

1. Bump image tag in `build-routing-solution/openrouteservice_app/services/ors_control_app/ors_control_app_service.yaml`.
2. `docker build --platform linux/amd64 -f Dockerfile.runtime -t <repo>/ors_control_app:vX.Y.Z .`
3. `docker push <repo>/ors_control_app:vX.Y.Z`
4. `snow stage copy ors_control_app_service.yaml @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/services/ors_control_app/ -c <ACTIVE_CONNECTION> --overwrite`
5. SUSPEND -> `ALTER SERVICE ... FROM @stage SPECIFICATION_FILE=...` -> RESUME.
6. `SHOW ENDPOINTS IN SERVICE OPENROUTESERVICE_APP.CORE.ORS_CONTROL_APP;` -> open `https://<ingress_url>` and click **Backload Matching** in the sidebar.

### Step 5: Verify

In the app:

1. Switch the region picker to **Germany**.
2. Click **Backload Matching** in the sidebar (under Solution Accelerators).
3. Verify the map shows ~80 trailer markers + ~120 internal volume circles + ~300 external offer circles.
4. Adjust `Internal Priority` slider if desired (default 100). Click **Solve Backloads**.
5. Within ~10–30 sec the page should render colored loaded legs + gray empty legs + a per-trailer assignment table on the right rail with KPIs:
   - **% trailers assigned**
   - **Total empty km**
   - **% internal coverage** (assigned-to-internal / assigned)
   - **EUR/day reclaimed** (rough = `idle_days_saved * IDLE_COST_EUR_PER_DAY` + `empty_km_saved * EUR_PER_EMPTY_KM`)
6. Click any trailer in the table -> *"Why this assignment?"* card -> Cortex returns a 2-sentence rationale.
7. Click **Confirm Plan** — assignments land in `FLEET_INTELLIGENCE.BACKLOAD_MATCHING.PROPOSAL_DECISIONS`.

### Step 6: AISQL Notebook (optional)

Upload `assets/notebooks/backload-matching-aisql.ipynb` to a notebook stage and walk through the AI_FILTER / AI_AGG / AI_CLASSIFY / AI_EXTRACT / Cortex Complete cells. The notebook re-uses the same tables and shows the AISQL parity to the page, plus the raw VROOM JSON the page sends to OPTIMIZATION.

## Cleanup

```sql
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING.PROPOSAL_DECISIONS;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING.EXTERNAL_OFFERS;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING.INTERNAL_VOLUMES;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING.TRAILERS;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING.CONFIG;
DROP VIEW  IF EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_BACKLOAD_CANDIDATES;
DROP VIEW  IF EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_TRAILERS;
DROP SCHEMA IF EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING;
```

The Control App image rollback is handled by re-deploying the previous image tag from the registry; the new page becomes inaccessible automatically when the schema is dropped (the page surfaces an empty state).

## Out of Scope

- Live Timocom / WTransnet / Teleroute / B2P API integration (synthetic only — productisation note in `references/optimization-vrp-mapping.md`).
- Asset Velocity 7-day idle alerting / email engine (the existing `Asset Velocity` tab covers KPIs; this skill stays focused on the solver).
- DGF / myDHLI POD-map use case.
- Real-time streaming pipeline (we ship a polled view first; productisation: Snowpipe Streaming for `EXTERNAL_OFFERS`).
