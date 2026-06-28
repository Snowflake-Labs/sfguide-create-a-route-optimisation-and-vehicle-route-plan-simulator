# Freight Exchange - Use Case Narrative

## Customer anchor

Same NTBO call as `backload-matching` (May 5, 2026, DHL Freight). The pain point Martin Ahleff named was *information overload*: dispatchers juggle 4 browser tabs (Timocom, WTransnet, Teleroute, B2P) plus their internal scheduling tool, manually copying offers across, and there is no single canonical source of truth for *price* or *trust*.

`backload-matching` answered the *fleet-wide* version of that problem: one OPTIMIZATION call replaces 100 dispatchers manually portal-hopping. But the dispatcher still has the *individual* portal-hopping problem when they need to pick a specific load, vet a specific carrier, or compare a price to the market.

`freight-exchange` answers that second half: the dispatcher's everyday cockpit.

## Why two pages, not one

| | Backload Matching | Freight Exchange |
|---|---|---|
| Primary user | Planning lead, supply-chain analyst | Dispatcher (front-line) |
| Mental model | "Solve my fleet for tomorrow" | "Find me a load right now / vet this carrier" |
| Primary action | One **Solve** button | Browse, filter, sort, inspect, accept |
| Output | Optimized fleet plan + KPIs | Single accepted offer + paperwork |
| Cadence | A few times per day | Continuous (every 5-15 min) |
| Read pattern | One big OPTIMIZATION call | Many small filtered selects on one denormalized view |

The two converge at `PROPOSAL_DECISIONS` - accepted offers from either page write the same audit row, so EUR-reclaimed and offers-accepted KPIs roll up uniformly.

## What the demo does (Phase A + B)

Phase A - **looks like a freight exchange**:
1. Sidebar entry **Freight Exchange** (under *Solution Accelerators*) opens a new route.
2. Top filter bar: source vendor chips (Timocom / WTransnet / Teleroute / B2P, or DAT / Truckstop / Convoy / Uber Freight depending on preset region), equipment chips (TAUTLINER / MEGA / REEFER / BOX / FLATBED), ADR toggle, USD/km min/max, posted-since slider.
3. Sortable AG-Grid (300 offers per preset): source, pickup, dropoff, distance_km, equipment, ADR, weight, USD, USD/km, age.
4. Map: deck.gl ScatterplotLayer of offer pickup points, color-coded by source vendor; selected offer highlighted.
5. Click any offer -> right-rail drawer with offer details.

Phase B - **trust + market intelligence on top**:
1. Trust badge per offer (GREEN / YELLOW / RED) computed from `DIM_PARTNERS` credit_score + KYC + blacklist.
2. Market badge per offer (BELOW_MARKET / AT_MARKET / ABOVE_MARKET) computed from `RATE_INDEX` weekly p50 USD/km by EQUIPMENT.
3. Detail drawer shows partner credit score, payment-days average, lane-history aggregate ("This partner has shipped this DE -> NL TAUTLINER lane 14x - 92% on-time, no damage events").

## How customer signals map to the schema

| Customer signal | Schema response |
|---|---|
| *"Information overload across 4 portals"* | `VW_OFFER_ENRICHED` is one denormalized read; one filter UI replaces four. |
| *"How do I know this carrier is legit?"* | `TRUST_BADGE` derived from `CREDIT_SCORE`, `KYC_STATUS`, `BLACKLIST_FLAG` on `DIM_PARTNERS`. |
| *"Is this a fair price?"* | `MARKET_BADGE` + `PRICE_DELTA_PCT` derived from `RATE_INDEX` weekly p25/p50/p75 USD/km by equipment. |
| *"Have I worked with this partner before?"* | `VW_LANE_HISTORY` aggregates `FACT_PARTNER_HISTORY` by (partner, origin_country, dest_country, equipment). |
| *"5-min latency goal"* | `RATE_INDEX` is a Dynamic Table at 15-min target lag (configurable). For Phase C, `VW_OFFERS` flips to a DT over a Snowpipe Streaming feed. |
| *"Every preset = different region/dataset"* | All views filter by `MARKETPLACE.CONFIG`, which is auto-synced to the active Data Studio preset by `region-sync.ts`. |

## Why this generalises (the wider ICP)

Same ICP as `backload-matching`. The skill is vendor-neutral by construction:
- `EXTERNAL_OFFERS.SOURCE` per region uses TIMOCOM / WTRANSNET / TELEROUTE / B2P in EU and DAT / TRUCKSTOP / CONVOY / UBER_FREIGHT in NA. The Data Studio engine picks based on the preset region.
- `DIM_PARTNERS.COUNTRY` is region-aware (DE/NL/PL/CZ/AT for Germany preset, FR/BE/ES/IT for France, US/CA/MX for NA, etc.).

Adding a new region is purely a Data Studio operation - generate a preset for that region and the page picks it up the next time the user selects it from DatasetPicker.

## Supporting roles for other ORS / Cortex functions

| Function | Role on the page |
|---|---|
| `RATE_INDEX` Dynamic Table | Powers the market-rate badge. Refreshes on a 15-min cadence. |
| `SNOWFLAKE.CORTEX.COMPLETE` (Phase C+) | Drafts opening chat message to a partner. |
| `AI_FILTER`, `AI_CLASSIFY` (Phase C+) | Free-text filter on `LISTING_TEXT`, cargo-category classification. |
| `AI_PARSE_DOCUMENT` (Phase D) | CMR / POD / ADR-cert extraction. |
| `OPENROUTESERVICE_APP.CORE.DIRECTIONS` | Optional polyline from trailer to pickup, when a trailer is selected (productisation note). |
