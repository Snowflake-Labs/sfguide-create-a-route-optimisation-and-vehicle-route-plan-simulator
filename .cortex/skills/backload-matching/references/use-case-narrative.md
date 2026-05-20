# Backload Matching Engine — Use Case Narrative

## Customer anchor

May 5, 2026 NTBO call with **DHL Freight** (Volker Nachtsheim, Head of IT Product Management; Martin Ahleff, NTBO workstream lead).

- **2,500 trailers** across DHL Freight Europe; **~100 Nordic dispatchers** plan returns.
- ~**20 new orders / minute** flow into the system across Europe.
- Trailers delivering Nordic exports to the continent commonly sit **up to 3 days idle** (Paris, Ruhr, Milan) waiting for backloads.
- Today's reload search is manual portal-hopping across **Timocom**, **WTransnet**, **Teleroute**, **B2P** plus internal scheduling tools.
- Martin's explicit ask: *"Right-click on a trailer and give me a proposal for the next job — internal-first, external-second."*
- Martin: *"We don't have a structural and stable process. There's information overload. Tell me which optimization parameters and cost functions to configure."*
- Volker: real-time / **5-min latency** is the goal; today's setup is historical/ETL-oriented.

## Why this is a fleet-wide optimization, not a per-trailer match

The "right-click one trailer, get a proposal" framing is *the dispatcher's mental model*, but treated literally it is **locally greedy**. If five Nordic trailers all deliver to NRW within the same 4-hour window, ranking each one independently leads them to fight over the same Cologne -> Hamburg backload while the second-best Cologne -> Aarhus offer goes unmatched.

The VROOM-style **OPTIMIZATION** solver assigns the whole regional fleet in one pass, minimizing **total** empty kilometres and respecting time windows, capacity, and equipment skills simultaneously. That is the **structural** answer to *"we don't have a structural process"* — a single deterministic call replaces 100 dispatchers manually portal-hopping.

The dispatcher still gets the trailer-centric view; it is just rendered out of a globally optimal plan instead of a chain of greedy local picks.

## How the customer signals map to the VRP solver

| DHL signal | VROOM / OPTIMIZATION encoding |
|---|---|
| ~50 idle-bound trailers in NRW today | `vehicles[]` — one per trailer, `start = drop-off`, `end = home depot` |
| Internal volumes (own waiting shipments) | `jobs[]` with `skills:[1]` and `priority` = 100 (high) |
| External freight-exchange offers (Timocom / WTransnet / Teleroute / B2P) | `jobs[]` with `skills:[2]` and `priority` = 10 (low) |
| Internal-first preference | `vehicles[].skills:[1,2]` — vehicles can serve both, but priority makes the solver prefer internal |
| HGV-only routing | `profile: "driving-hgv"` for vehicles |
| Trailer ETA + offer pickup window | `jobs[].time_windows` and `vehicles[].time_window` |
| Capacity (FTL vs LTL, weight limits) | `vehicles[].capacity` + `jobs[].amount` |
| ADR / hazmat gating | Dedicated skill id (`3` for ADR) — only ADR-certified trailers may serve ADR jobs |
| Direction-to-home bias | Vehicle `end` = trailer's home-depot lat/lon -> solver naturally prefers jobs whose drop-off is en route to home |
| Empty km cost | VROOM minimizes total travel time (and we report empty km from the solved legs) |

## Why this story generalizes (the wider ICP)

Every line-haul carrier with imbalanced lanes has the same shape:

- **Maersk Inland Services** — North Sea ports back to Scandinavia.
- **Kuehne+Nagel Road Logistics** — Benelux / Germany trunking.
- **DSV Road** — Pan-European trailer pool.
- **XPO Europe**, **Geodis Distribution & Express**, **Dachser**, **Gebrüder Weiss** — continental LTL/FTL.
- **FedEx Freight** (LTL US) — Northeast vs Southeast imbalance.
- **Schneider National**, **J.B. Hunt** — drop-and-hook trailer pools.

Swap the `EXTERNAL_OFFERS.SOURCE` label set (TIMOCOM / WTRANSNET / TELEROUTE / B2P) for **DAT**, **Truckstop.com**, **Convoy**, **Uber Freight** in NA, or **TheLorry**, **Lalamove Freight** in APAC, and the page is unchanged. The skill is **vendor-neutral by construction**.

It also generalises beyond freight: any **drop-and-hook asset network** with imbalanced lanes (rail wagons, container chassis, unit-load devices in air cargo, even rental cars) reduces to the same VRP shape.

## What the demo does (single screen, single solve)

1. **Region picker** (Germany default) -> page loads:
   - ~80 idle-bound HGV trailers from `VW_TRAILERS` (color-coded by home depot).
   - ~120 internal volumes from `INTERNAL_VOLUMES` (filled blue circles).
   - ~300 external freight-exchange offers from `EXTERNAL_OFFERS` (hollow circles, badge-coloured per source vendor).
2. **Sliders** for:
   - `Internal Priority` (default 100 vs `External Priority` 10).
   - `Time-Window Tolerance` (hours, default ±4h).
   - `Max Empty km per Leg` (hard skip, default 200 km).
3. **Solve Backloads** -> single `OPENROUTESERVICE_APP.CORE.OPTIMIZATION(...)` call -> page renders simultaneously:
   - Color-per-trailer **loaded legs** (DIRECTIONS polylines).
   - Gray **empty legs** to the assigned pickup.
   - Right rail KPIs: **empty km saved**, **EUR/day reclaimed** (`empty_km_saved * EUR_per_km`), **% internal coverage**, **% trailers assigned**.
4. **Click a trailer in the rail** -> map zooms to its solved route + Cortex Complete generates a 2-sentence dispatcher rationale: *"Trailer T-2118 is assigned internal volume INT-00441 (Essen -> Aarhus) because it sits 18 km from pickup and points home; this saves 412 empty km vs the next-best Timocom offer."*
5. **Confirm Plan** -> all assignments are written to `PROPOSAL_DECISIONS` — the *Action Engine* close-the-loop step from slide 25 of the supply-chain optimization deck.

## Supporting roles for other ORS functions

| Function | Role on the page |
|---|---|
| `MATRIX('driving-hgv', ...)` | Underpins OPTIMIZATION (VROOM consumes it internally). We surface the call site in the AISQL notebook so customers can see the cost matrix. |
| `ISOCHRONES('driving-hgv', ..., 240, NULL)` | "Explore mode" toggle — draws the 4-hour HGV reach polygon from a selected drop-off, visualizing what is reachable *before* solving. |
| `DIRECTIONS('driving-hgv', ...)` | Per-leg polyline renderer for the solved plan (one call per leg in the assignment). |
| `SNOWFLAKE.CORTEX.COMPLETE` | 2-sentence dispatcher rationale per assigned trailer. |
| `AI_FILTER`, `AI_AGG`, `AI_CLASSIFY`, `AI_EXTRACT` | Notebook-only — parse free-text offer descriptions, gate ADR/non-ADR, rollup per corridor. |

## Customer signals mapped to page features (one-glance)

| Customer signal | Page response |
|---|---|
| *"Give me a proposal for the next job"* | Trailer pane + per-trailer assignment card |
| *"Internal-first, external-second"* | `Internal Priority` slider defaults 100 vs 10 — VROOM honours it deterministically |
| *"5-min latency goal"* | Page polls `VW_TRAILERS`; productisation note calls out Snowpipe Streaming for `EXTERNAL_OFFERS` |
| *"Very high savings number"* | KPI row: empty km saved + EUR/day reclaimed |
| *"Information overload"* | One ranked plan, one map, one rationale — replaces 4 portals |
| *"Action engine, not just a dashboard"* | `Confirm Plan` writes to `PROPOSAL_DECISIONS` |
| *"Tell me which optimization parameters to configure"* | The sliders + the JSON shown in the AISQL notebook *are* the parameters; customer can fork them |
