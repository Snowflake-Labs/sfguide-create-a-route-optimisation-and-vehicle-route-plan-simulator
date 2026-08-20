---
name: backload-matching
description: "Deploy the Backload Matching Engine demo: a fleet-wide VRP solve over idle-bound trailers + internal volumes + external freight-exchange offers, anchored on the OPENROUTESERVICE_APP.CORE.OPTIMIZATION function. The page picks one or many trailers, calls OPTIMIZATION once, and renders empty/loaded legs, KPI savings, and a Cortex rationale. Use when: setting up the DHL Freight backload demo, asset velocity / trailer rotation use cases, freight-exchange aggregation, internal-first vs external-second proposals, multi-trailer joint dispatch. Do NOT use for: route optimization VRP from PLACES (use route-optimization), route deviation analysis (use route-deviation), retail catchment (use retail-catchment), fleet intelligence car/e-bike demos, or single-leg directions tests (use FunctionTester). Triggers: backload, backload matching, empty mile, empty leg, asset velocity, trailer rotation, freight exchange, freight exchanges, idle trailer, idle-bound trailer, Timocom, WTransnet, Teleroute, B2P, DHL, DHL Freight, dispatcher proposal, internal-first match, supply chain action engine, NTBO, line-haul VRP, drop-and-hook."
depends_on:
  - install-fleet-apps
  - route-optimization
metadata:
  author: Snowflake SIT-IS
  version: 1.0.0
  category: demo
---

# Deploy Backload Matching Engine

Adds a parallel page to the ORS Control App that solves the *backload* problem for any line-haul fleet with imbalanced lanes: trailers reaching the continent and waiting up to three days for a return load. The page issues a **single `OPENROUTESERVICE_APP.CORE.OPTIMIZATION(...)` call** that jointly assigns N idle-bound trailers to a pool of internal volumes (own waiting shipments) and external offers (synthesized in the style of Timocom, WTransnet, Teleroute, B2P), minimizing total empty kilometres. Internal-first preference is encoded as VROOM `priority`; ADR/equipment gating uses VROOM `skills`; direction-to-home bias is encoded in each vehicle's `end` location. Accepted plans are written back to `PROPOSAL_DECISIONS` to close the *Action Engine* loop.

The existing **Route Optimization** and **Asset Velocity** pages are **not modified** - Backload is an additive, parallel page.

## Use Case Narrative

See `references/use-case-narrative.md` for the full story. Summary anchored in the May 5 NTBO call with DHL Freight (Volker Nachtsheim / Martin Ahleff) and the Asset Velocity Case 4 slide:

- ~2,500 trailers, ~100 Nordic dispatchers, ~20 new orders/min across Europe.
- Trailers reach the continent and wait up to **3 days** in Paris for backloads.
- Today: manual portal-hopping across Timocom, WTransnet, Teleroute, B2P.
- Desired: fleet-wide *"give me a structural plan for tomorrow"* - internal-first, external-second.
- Generalises 1:1 to Maersk Inland, K+N Road, DSV, XPO, Geodis, Dachser, FedEx Freight, Schneider, J.B. Hunt - anyone with imbalanced lanes.

## Prerequisites

- `install-fleet-apps` deployed (OPENROUTESERVICE_APP database with all ORS services running). The demo runs against whatever region/vehicle preset is currently active in the Control App - no specific region required.
- `route-optimization` deployed.
- Synthetic datasets seeded under `SYNTHETIC_DATASETS.UNIFIED.*` (DIM_FLEET, FACT_TRIPS) - not strictly required for the page, but kept as a dependency since this skill was scoped against that dataset.
- Run Data Studio for the target `(region, vehicle_type)` first so `V_DIM_FLEET_CURRENT`, `V_DIM_POIS_CURRENT`, and `V_FACT_FREIGHT_OFFERS_CURRENT` are populated. The page no longer has an in-page "Generate seed data" action.

## Required Privileges

| Privilege | Scope | Reason |
|-----------|-------|--------|
| USAGE ON DATABASE FLEET_INTELLIGENCE | Database | Demo database |
| CREATE SCHEMA | Database (FLEET_INTELLIGENCE) | Creates BACKLOAD_MATCHING schema |
| CREATE TABLE | Schema (FLEET_INTELLIGENCE.BACKLOAD_MATCHING) | CONFIG, TRAILERS, INTERNAL_VOLUMES, EXTERNAL_OFFERS, PROPOSAL_DECISIONS |
| CREATE VIEW | Schema (FLEET_INTELLIGENCE.BACKLOAD_MATCHING) | VW_TRAILERS, VW_BACKLOAD_CANDIDATES |
| USAGE ON DATABASE OPENROUTESERVICE_APP | Database | Calls OPTIMIZATION + DIRECTIONS + ISOCHRONES for the active region's routing profile |
| USAGE ON SCHEMA OPENROUTESERVICE_APP.CORE | Schema | Same |
| USAGE ON FUNCTION OPENROUTESERVICE_APP.CORE.OPTIMIZATION(VARIANT, VARCHAR) | Function | Solver entry point (challenge, region) |
| USAGE ON WAREHOUSE ROUTING_ANALYTICS | Warehouse | Powers the page queries |
| USAGE ON DATABASE SNOWFLAKE | Database | Calls SNOWFLAKE.CORTEX.COMPLETE for "Why this assignment?" |

> **Note:** ACCOUNTADMIN is NOT required.

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| DATABASE | `FLEET_INTELLIGENCE` | Database for demo objects |
| SCHEMA | `BACKLOAD_MATCHING` | Schema for backload tables and views |
| WAREHOUSE | `ROUTING_ANALYTICS` | Warehouse for queries |
| REGION | (active preset) | Auto-derived from `BACKLOAD_MATCHING.CONFIG`, which mirrors the active Control App region/vehicle. No hardcoded city. |
| VEHICLE_CLASS_PROFILE | `OPENROUTESERVICE_APP.CORE.VEHICLE_CLASS_PROFILE` | Single source of truth for per-vehicle-class capacity (`PAYLOAD_KG_TYP`), shipment-weight band, ORS profile, costs (€/km, €/hr), and UI label. The skill is transport-type agnostic - no HGV-specific constants. Seeded with 8 classes (`bicycle`, `ebike`, `foot`, `motorcycle`, `car`, `van`, `hgv`, `truck`). Unknown `vehicle_type` → bootstrap and React both fail loudly so a custom preset never silently runs with wrong-class defaults. |
| TRAILER_COUNT | up to ~80 (driven by Data Studio dataset) | Idle-bound trailers for the active preset |
| INTERNAL_VOLUMES_COUNT | 120 | Internal waiting loads (most-recent FACT_TRIPS) |
| EXTERNAL_OFFERS_COUNT | 300 | Synthetic external offers per region |
| INTERNAL_PRIORITY | `100` | VROOM `priority` on internal jobs |
| EXTERNAL_PRIORITY | `10` | VROOM `priority` on external offers |
| TIME_WINDOW_TOLERANCE_HRS | `4` | Pickup-window slack added to jobs |
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
SELECT COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.V_FACT_FREIGHT_OFFERS_CURRENT;  -- > 0
DESC FUNCTION OPENROUTESERVICE_APP.CORE.OPTIMIZATION(VARIANT, VARCHAR);     -- exists
```

If any step fails, deploy the upstream skill first.

### Step 3: Run Bootstrap

Run `references/bootstrap.sql` from the active connection:

```bash
snow sql -f .cortex/skills/backload-matching/references/bootstrap.sql -c <ACTIVE_CONNECTION>
```

This creates `FLEET_INTELLIGENCE.BACKLOAD_MATCHING.{CONFIG, VW_TRAILERS, VW_INTERNAL_VOLUMES, VW_EXTERNAL_OFFERS, PROPOSAL_DECISIONS}` as **projection views** over `SYNTHETIC_DATASETS.UNIFIED.*` filtered by the active Data Studio preset (CONFIG row).

The active preset is auto-synced when the user switches in DatasetPicker (or runs a new Data Studio job) - same pattern that fleet-intelligence-ebike, dwell-analysis, and route-deviation use.

### Step 3b (one-time, existing accounts only): Backfill freight offers

Data Studio jobs created BEFORE the v1.0.199 control app rollout did not generate `SYNTHETIC_DATASETS.UNIFIED.FACT_FREIGHT_OFFERS`. Backfill them once:

```bash
snow sql -f .cortex/skills/backload-matching/references/backfill-freight-offers.sql -c <ACTIVE_CONNECTION>
```

Idempotent: skips regions that already have offers. New presets generated after v1.0.199 deploy will populate offers natively, so this script is a no-op on greenfield deployments.

### Step 3c: Cockpit schema (Backload Proposals)

Run `references/proposals-schema.sql` AFTER `bootstrap.sql`. It adds the neutral cockpit layer to `FLEET_INTELLIGENCE.BACKLOAD_MATCHING`:

```bash
snow sql -f .cortex/skills/backload-matching/references/proposals-schema.sql -c <ACTIVE_CONNECTION>
```

Creates `MATCH_PARAMS` (config-driven, vehicle-class-generalized constraints - distance / pickup-date / horizon / weight-fit / hazmat; no FTL-specific ADR/Thermo/Mega/LDM), `VW_LOADS` (internal volumes + external offers as one demand pool with an `IS_INTERNAL` priority flag), `VW_TRAILERS_GEO` (idle-vehicle free point + return-to-home geometry, free time anchored to the live "now" window), `VW_CANDIDATES` + `VW_CANDIDATES_SCORED` (per-rule pass/fail explainability), and empty `PROPOSALS` / `FEEDBACK` tables. All are synthetic-backed projections filtered by the active `CONFIG` preset. Sanity report prints row counts at the end.

### Step 4: Interactive pages (FLEET_SA_APP)

Two config-registered views ship in `FLEET_SA_APP` (category **Optimization**), both reading the neutral `FLEET_APP.BACKLOAD_MATCHING` + `FLEET_INTELLIGENCE.BACKLOAD_MATCHING` views and solving live via the `/api/backload/solve` contract seam. They render an empty state until Steps 3/3c have been run for the active preset.

- **Backload Matching** (`backload_matching`) - single-solve engine: idle vehicles + internal loads + external offers, internal-first VROOM, assignment cards + KPIs + map, write-back to `PROPOSAL_DECISIONS`.
- **Backload Proposals** (`backload_proposals`) - the advanced multi-strategy cockpit: run Quick scan / Per-load VRP / Fleet 1:1 / Profit-max, or **Ensemble** to fuse all four into one graded (A..F), internal-first proposal per vehicle. Adjustable ranking weights, per-constraint pass/fail chips from `VW_CANDIDATES_SCORED`, a Cortex rationale, and session-only Accept/Reject/Flag (no write-back).

The generic, use-case-agnostic `vrp_solve` User verb (backed by `ROUTING_TOOLS.TOOL_VRP_SOLVE`) lets the Cortex agent solve any prepared VROOM challenge; the app itself uses `/api/backload/solve` (robust raw-scalar seam that avoids the TVF 0-row trap).

### Step 5: Verify

1. Set the region/vehicle preset you want to demo (default: SanFrancisco/ebike). Both pages read `BACKLOAD_MATCHING.CONFIG`, auto-synced to the active preset.
2. Open **Backload Proposals** (sidebar, Optimization). Confirm the counts strip shows idle vehicles, internal loads, external offers, and eligible pairs > 0.
3. Leave strategy on **Ensemble**, click **Run proposals**. Within ~10-40 sec (VROOM must be running for the active region) the page renders per-vehicle graded cards, KPIs (vehicles matched / internal filled / empty km / avg score), and the empty+loaded legs on the map.
4. Expand a card to see the per-constraint pass/fail chips and alternative loads; click **Explain (Cortex)** for a rationale; use Accept/Reject/Flag (session-only).
5. Open **Backload Matching** for the single-solve variant; **Match backloads** then **Accept & write decisions** persists to `PROPOSAL_DECISIONS`.

### Step 6: AISQL Notebook (optional)

Upload `assets/notebooks/backload-matching-aisql.ipynb` to a notebook stage and walk through the AI_FILTER / AI_AGG / AI_CLASSIFY / AI_EXTRACT / Cortex Complete cells. The notebook re-uses the same tables and shows the AISQL parity to the page, plus the raw VROOM JSON the page sends to OPTIMIZATION.

## Cleanup

```sql
DROP VIEW   IF EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_CANDIDATES_SCORED;
DROP VIEW   IF EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_CANDIDATES;
DROP VIEW   IF EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_TRAILERS_GEO;
DROP VIEW   IF EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_LOADS;
DROP TABLE  IF EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING.FEEDBACK;
DROP TABLE  IF EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING.PROPOSALS;
DROP TABLE  IF EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING.MATCH_PARAMS;
DROP VIEW   IF EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_EXTERNAL_OFFERS;
DROP VIEW   IF EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_INTERNAL_VOLUMES;
DROP VIEW   IF EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_TRAILERS;
DROP TABLE  IF EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING.PROPOSAL_DECISIONS;
DROP TABLE  IF EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING.CONFIG;
DROP SCHEMA IF EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING;
```

Note: this skill does NOT delete from `SYNTHETIC_DATASETS.UNIFIED.FACT_FREIGHT_OFFERS` since that table is owned by `install-fleet-apps` (Data Studio output) and is shared. Use the cleanup script in `install-fleet-apps` if you also want to remove the freight-offer data per preset.

The Control App image rollback is handled by re-deploying the previous image tag from the registry; the new page becomes inaccessible automatically when the schema is dropped (the page surfaces an empty state).

## Out of Scope

- Live Timocom / WTransnet / Teleroute / B2P API integration (synthetic only - productisation note in `references/optimization-vrp-mapping.md`).
- Asset Velocity 7-day idle alerting / email engine (the existing `Asset Velocity` tab covers KPIs; this skill stays focused on the solver).
- DGF / myDHLI POD-map use case.
- Real-time streaming pipeline (we ship a polled view first; productisation: Snowpipe Streaming for `EXTERNAL_OFFERS`).
