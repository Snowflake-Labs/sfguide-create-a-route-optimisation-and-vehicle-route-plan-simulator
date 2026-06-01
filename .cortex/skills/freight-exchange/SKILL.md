---
name: freight-exchange
description: "Deploy the Freight Exchange page: a dispatcher-grade marketplace cockpit that mirrors what users do today on Timocom, WTransnet, Teleroute, B2P (NA: DAT, Truckstop, Convoy, Uber Freight). Adds a parallel React route to the ORS Control App that lets dispatchers browse, filter, and inspect synthesized freight offers per active preset, with trust scores (credit/KYC/blacklist), market-rate badges (vs. weekly p25/p50/p75 USD/km from a RATE_INDEX dynamic table), and partner lane history. Reads from FLEET_INTELLIGENCE.MARKETPLACE projection views over per-preset SYNTHETIC_DATASETS.UNIFIED data, so switching preset auto-refreshes the page. Use when: setting up the Freight Exchange demo, dispatcher cockpit, freight marketplace, load board, trust-score badges, market-rate badges, Timocom-style UI parity. Do NOT use for: solver-led fleet-wide backload (use backload-matching), route-optimization VRP, route-deviation, retail-catchment, fleet-intelligence taxi/food-delivery demos. Triggers: freight exchange, freight marketplace, load board, dispatcher cockpit, browse offers, filter offers, trust badge, market rate, lane history, partner credit score, Timocom UI, WTransnet UI, Teleroute UI, B2P UI, DAT UI, Truckstop UI, marketplace page, MARKETPLACE schema."
depends_on:
  - build-routing-solution
  - backload-matching
metadata:
  author: Snowflake SIT-IS
  version: 1.0.0
  category: demo
---

# Deploy Freight Exchange Page

Adds a new **Freight Exchange** entry to the ORS Control App sidebar (under *Solution Accelerators*) that lives next to **Backload Matching**. Where Backload Matching is solver-led ("solve my fleet for tomorrow"), Freight Exchange is dispatcher-led ("browse, filter, inspect, post"). The two pages share the same underlying per-preset offer data; this skill adds the trust + market-rate intelligence layer.

## Use Case Narrative

Today a DHL Freight / Maersk Inland / DSV / Schneider dispatcher juggles 4 browser tabs (TC Truck&Cargo, WTransnet Bolsa, Teleroute, B2P or DAT/Truckstop in NA) plus their internal scheduling tool. Each tab has its own filter UI, each has its own credit/trust signal, each has its own price benchmark. Information overload is the explicit pain point Martin Ahleff named in the May 5, 2026 NTBO call.

Phase A of this skill replaces those 4 tabs' **browse + filter** experience with a single sortable grid + map. Phase B adds the two pieces dispatchers actually pay Timocom for: **carrier trust score** (credit, KYC, blacklist) and **market-rate benchmark** (is this offer above or below corridor p50?).

Phases C (action engine: post / chat / bid / saved searches + alerts) and D (compliance: docs / cross-border / round-trip / tariff calculator) are tracked in `references/productisation.md`.

## Prerequisites

- `build-routing-solution` deployed (OPENROUTESERVICE_APP database, all ORS services running). The page reads only from Snowflake; ORS routing functions are not currently called from this page.
- `backload-matching` deployed (provides the FACT_FREIGHT_OFFERS projection pattern this skill builds on).
- Synthetic datasets seeded under `SYNTHETIC_DATASETS.UNIFIED.*` for at least one preset (`DIM_FLEET`, `FACT_FREIGHT_OFFERS`, `DIM_PARTNERS`, `FACT_PARTNER_HISTORY`). Newly-generated presets after this skill ships populate `DIM_PARTNERS` + `FACT_PARTNER_HISTORY` natively. For older presets, re-run a Data Studio job for that preset to seed them.
- For route previews, `/api/fx/offer-route` is cache-first on `FLEET_INTELLIGENCE.MARKETPLACE.V_FACT_OFFER_ROUTES_CURRENT`; Data Studio precomputes this cache for active presets.

## Required Privileges

| Privilege | Scope | Reason |
|-----------|-------|--------|
| USAGE ON DATABASE FLEET_INTELLIGENCE | Database | Demo database |
| CREATE SCHEMA | Database (FLEET_INTELLIGENCE) | Creates MARKETPLACE schema |
| CREATE TABLE | Schema (FLEET_INTELLIGENCE.MARKETPLACE) | CONFIG |
| CREATE VIEW | Schema (FLEET_INTELLIGENCE.MARKETPLACE) | VW_OFFERS, VW_PARTNERS, VW_PARTNER_HISTORY, VW_LANE_HISTORY, VW_OFFER_ENRICHED |
| CREATE DYNAMIC TABLE | Schema (FLEET_INTELLIGENCE.MARKETPLACE) | RATE_INDEX |
| USAGE + SELECT ON SCHEMA SYNTHETIC_DATASETS.UNIFIED | Schema | Source tables for projection views |
| USAGE ON WAREHOUSE ROUTING_ANALYTICS | Warehouse | Powers the page queries + RATE_INDEX refresh |

> **Note:** ACCOUNTADMIN is NOT required.

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| DATABASE | `FLEET_INTELLIGENCE` | Database for demo objects |
| SCHEMA | `MARKETPLACE` | Schema for marketplace tables and views |
| WAREHOUSE | `ROUTING_ANALYTICS` | Warehouse for queries + RATE_INDEX refresh |
| REGION | (active preset) | Auto-derived from `MARKETPLACE.CONFIG`, mirroring the active Control App preset |
| VEHICLE_TYPE | (active preset) | Same |
| RATE_INDEX_LAG | `15 minutes` | Dynamic Table target lag (lower = fresher badges, higher = lower cost) |
| PARTNERS_PER_PRESET | `80` | Partner pool size per preset |
| HISTORY_ROWS_PER_PARTNER | `~6` | Synthetic prior-shipment rows per partner |

## Error Logging

> Follow the Error Logging convention in `AGENTS.md`. Log file prefix: `freight-exchange`.

## Workflow

### Step 1: Set Query Tag

```sql
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-freight-exchange","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

### Step 2: Verify Prerequisites

```sql
SHOW SERVICES IN DATABASE OPENROUTESERVICE_APP;
SELECT COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.FACT_FREIGHT_OFFERS;   -- > 0
SELECT COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.DIM_PARTNERS;          -- > 0 after a Data Studio run
SELECT COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.FACT_PARTNER_HISTORY;  -- > 0 after a Data Studio run
```

If `DIM_PARTNERS` or `FACT_PARTNER_HISTORY` are empty, run a Data Studio job for the active preset. Existing presets that pre-date partner generation will be re-populated automatically the next time a job runs for that preset.

### Step 3: Run Bootstrap

```bash
snow sql -f .cortex/skills/freight-exchange/references/bootstrap.sql -c <ACTIVE_CONNECTION>
```

This creates `FLEET_INTELLIGENCE.MARKETPLACE.{CONFIG, VW_OFFERS, VW_PARTNERS, VW_PARTNER_HISTORY, VW_LANE_HISTORY, RATE_INDEX, VW_OFFER_ENRICHED}`. The same DDL is also embedded in `services/ors_control_app/server/lib/init.ts` and runs on every container start.

> **CRITICAL on a fresh `build-routing-solution` install — run this AFTER seed data loads.** `init.ts` seeds `MARKETPLACE.CONFIG` at container boot, but the boot (build-routing-solution Step 6) happens BEFORE seed data loads (Step 7). The CONFIG row is data-derived from `SYNTHETIC_DATASETS.UNIFIED`, so at boot it derives nothing, `CONFIG` stays empty, and `VW_OFFERS` returns 0 even though seed `FACT_FREIGHT_OFFERS` has rows. The container does not auto-restart after the seed load, so you MUST run this `bootstrap.sql` here (post-seed) to re-derive `CONFIG`. This is why Freight Exchange is a Step 8 item in build-routing-solution, not a boot-time guarantee. The self-healing MERGE makes it idempotent.

### Step 4: Rebuild and Redeploy ORS Control App (only for page source changes)

> **Not required in the standard build-routing-solution flow.** The Freight Exchange page already ships in the control-app image (>= v1.1.78), so a fresh install only needs Step 3 (`bootstrap.sql`). Rebuild only when you have changed the page's React/server source.

The page lives inside the existing `ors_control_app` SPCS service. Follow the `Control App Image Deployment` block in `AGENTS.md`.

### Step 5: Verify

In the app:

1. Confirm the region/vehicle picker matches an active preset that has `FACT_FREIGHT_OFFERS` rows.
2. Click **Freight Exchange** in the sidebar (under *Solution Accelerators*).
3. The grid should list ~300 offers with columns: source, pickup, dropoff, distance_km, equipment, ADR, weight, USD, USD/km, age, trust badge, market badge, status.
4. The map shows offer pickup points clustered, color-coded by source vendor.
5. Filter by equipment chip (e.g. REEFER) -> grid + map both refresh.
6. Click any offer -> right-rail drawer shows partner trust details, lane-history aggregate, and the price-vs-market delta.

If the **MARKET badge** column shows `UNKNOWN` for every row, the `RATE_INDEX` Dynamic Table has not yet refreshed. It refreshes within the configured target lag (default 15 minutes). To force-refresh:

```sql
ALTER DYNAMIC TABLE FLEET_INTELLIGENCE.MARKETPLACE.RATE_INDEX REFRESH;
```

## Phases

| Phase | Status | Scope |
|-------|--------|-------|
| A     | shipped | Browse + filter shell, grid + map + detail drawer |
| B     | shipped | Trust badge, market-rate badge, partner lane-history tooltip |
| E1    | shipped (server) | ORS road km/min cache (`FACT_OFFER_ROUTES`, routed columns on `VW_OFFER_ENRICHED`); endpoints `POST /api/fx/refresh-routes`, `POST /api/fx/eta` |
| E2    | shipped (server) | Reachability isochrone via `POST /api/fx/isochrone` |
| E3    | shipped (server) | Deadhead matrix vs. `BACKLOAD_MATCHING.VW_TRAILERS` (`FACT_DEADHEAD_MATRIX`, `VW_OFFER_DEADHEAD`); endpoints `GET /api/fx/deadhead`, `POST /api/fx/refresh-deadhead` |
| E4    | shipped (server) | Round-trip 1-vehicle/2-shipment VROOM via `POST /api/fx/round-trip` |
| E5    | shipped (server) | Multi-offer bundle solver with EU 561/2006 break via `POST /api/fx/bundle` |
| E6    | shipped (server) | HGV profile selection per vehicle type; ADR offers add `avoid_features=ferries,tunnels`; `VW_OFFER_COMPLIANCE` view |
| E7    | shipped (sql) | Lane density H3 res-5 heatmap via `VW_LANE_DENSITY` + `GET /api/fx/lane-density` |
| E8    | shipped (server) | Cortex Complete negotiation drafts in `OFFER_DRAFTS` via `POST /api/fx/draft-counter` |
| --    | shipped (sql) | `PROPOSAL_DECISIONS` schema migration: `SOURCE_PAGE`, `DECISION_TYPE`, `BUNDLE_ID`; shared audit endpoint `POST /api/fx/decisions` |
| C     | future | Saved searches, Snowflake Alerts -> SSE, posting (trucks + loads), chat, bids |
| D     | future | OFFER_DOCS + AI_PARSE_DOCUMENT, full cabotage cross-border flags, round-trip toggle UI, tariff calculator |

> **Pending:** UI surfaces for E1–E8 (React grid columns, drawers, map layers) are not yet wired into [FreightExchange.tsx](../build-routing-solution/openrouteservice_app/services/ors_control_app/src/components/FreightExchange.tsx). Server endpoints + SQL objects exist; UI integration is a follow-up.

## Enrichment Bootstrap (E1–E8)

Phase E1–E8 MARKETPLACE objects (`FACT_OFFER_ROUTES`, `FACT_DEADHEAD_MATRIX`, `VW_OFFER_DEADHEAD`, `VW_LANE_DENSITY`, `OFFER_DRAFTS`, routed columns on `VW_OFFER_ENRICHED`, and `PROPOSAL_DECISIONS` discriminator columns) are created automatically on every `ors_control_app` container boot via `init.ts`. No manual SQL step is required for a normal deploy.

For greenfield audits or out-of-band rebuilds, run:

```bash
snow sql -f .cortex/skills/freight-exchange/references/bootstrap.sql -c <ACTIVE_CONNECTION>
snow sql -f .cortex/skills/freight-exchange/references/bootstrap-enrichment.sql -c <ACTIVE_CONNECTION>
```

Then rebuild + redeploy the `ors_control_app` image per the `Control App Image Deployment` block in `AGENTS.md` so the `/api/fx/*` endpoints land.

## Cleanup

```sql
-- Phase E1-E8 enrichment objects
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.MARKETPLACE.OFFER_DRAFTS;
DROP VIEW  IF EXISTS FLEET_INTELLIGENCE.MARKETPLACE.VW_LANE_DENSITY;
DROP VIEW  IF EXISTS FLEET_INTELLIGENCE.MARKETPLACE.VW_OFFER_DEADHEAD;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.MARKETPLACE.FACT_DEADHEAD_MATRIX;
DROP VIEW  IF EXISTS FLEET_INTELLIGENCE.MARKETPLACE.VW_OFFER_ENRICHED_V2;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.MARKETPLACE.FACT_OFFER_ROUTES;

-- Phase A/B core objects
DROP DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.MARKETPLACE.RATE_INDEX;
DROP VIEW IF EXISTS FLEET_INTELLIGENCE.MARKETPLACE.VW_OFFER_ENRICHED;
DROP VIEW IF EXISTS FLEET_INTELLIGENCE.MARKETPLACE.VW_LANE_HISTORY;
DROP VIEW IF EXISTS FLEET_INTELLIGENCE.MARKETPLACE.VW_PARTNER_HISTORY;
DROP VIEW IF EXISTS FLEET_INTELLIGENCE.MARKETPLACE.VW_PARTNERS;
DROP VIEW IF EXISTS FLEET_INTELLIGENCE.MARKETPLACE.VW_OFFERS;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.MARKETPLACE.CONFIG;
DROP SCHEMA IF EXISTS FLEET_INTELLIGENCE.MARKETPLACE;

-- The PROPOSAL_DECISIONS schema additions (SOURCE_PAGE, DECISION_TYPE,
-- BUNDLE_ID) are NOT dropped automatically — backload-matching also writes
-- to those columns now.
```

> Note: the `DIM_PARTNERS`, `FACT_PARTNER_HISTORY`, and the new enrichment columns on `FACT_FREIGHT_OFFERS` are owned by `build-routing-solution` (Data Studio output) and shared. Use the `routing-solution-cleanup` skill if you also want to remove those rows.

## Out of Scope

- Live Timocom / WTransnet / Teleroute / B2P / DAT / Truckstop API integration (synthetic only).
- Reverse posting (free truck / load) — Phase C.
- Chat / bidding / counter-offers — Phase C.
- Saved searches + push notifications — Phase C.
- Document parsing (CMR / POD / ADR certificates) — Phase D.
- Cross-border / customs flags — Phase D.
- Round-trip / multi-leg solver — Phase D.
- Tariff calculator widget — Phase D.
- i18n (multi-language UI) — out of scope per current product direction.
