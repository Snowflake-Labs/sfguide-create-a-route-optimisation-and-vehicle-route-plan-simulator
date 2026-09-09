# Backload Matching Engine - Use Case Narrative

## The problem this solves

Any line-haul fleet with imbalanced lanes has the same shape. Trailers carry
exports out to a region where the operator has less return volume, then sit idle
waiting for a backload. Typical scale for a mid-to-large European operator:

- A few thousand trailers across the network, with tens to low hundreds of
  dispatchers planning returns.
- A continuous stream of new orders, in the order of tens per minute across a
  continent.
- Trailers delivering into a net-import region commonly sit **up to 3 days idle**
  waiting for a return load.
- Today's reload search is manual portal-hopping across several external freight
  exchanges plus the operator's own internal scheduling tool.

The operational ask is consistently some version of: *"select a trailer and give
me a proposal for its next job, own loads first and external offers second."*
Two related complaints sit behind it: there is no structural, repeatable process,
and there is information overload. Latency expectations are minutes, not the
overnight ETL cadence most estates actually run.

## Why this is a fleet-wide optimization, not a per-trailer match

The "select one trailer, get a proposal" framing is *the dispatcher's mental
model*, but treated literally it is **locally greedy**. If five trailers all
deliver into the same region within the same 4-hour window, ranking each one
independently leads them to fight over the same best backload while the
second-best offer on an adjacent lane goes unmatched.

The VROOM-style **OPTIMIZATION** solver assigns the whole regional fleet in one
pass, minimizing **total** empty kilometres while respecting time windows,
capacity, and equipment skills simultaneously. That is the structural answer to
"we don't have a structural process": one deterministic call replaces many
dispatchers portal-hopping independently.

The dispatcher still gets the trailer-centric view; it is just rendered out of a
globally optimal plan instead of a chain of greedy local picks.

## How the operational signals map to the VRP solver

| Operational signal | VROOM / OPTIMIZATION encoding |
|---|---|
| Idle-bound trailers in a region today | `vehicles[]` - one per trailer, `start = drop-off`, `end = home depot` |
| Internal volumes (own waiting shipments) | `jobs[]` with `skills:[1]` and `priority` = 100 (high) |
| External freight-exchange offers | `jobs[]` with `skills:[2]` and `priority` = 10 (low) |
| Internal-first preference | `vehicles[].skills:[1,2]` - vehicles can serve both, but priority makes the solver prefer internal |
| HGV-only routing | `profile: "driving-hgv"` for vehicles |
| Trailer ETA + offer pickup window | `jobs[].time_windows` and `vehicles[].time_window` |
| Capacity (FTL vs LTL, weight limits) | `vehicles[].capacity` + `jobs[].amount` |
| Hazmat gating | Dedicated skill id (`3`) - only certified trailers may serve those jobs |
| Direction-to-home bias | Vehicle `end` = trailer's home-depot lat/lon, so the solver naturally prefers jobs whose drop-off is en route to home |
| Empty km cost | VROOM minimizes total travel time (and we report empty km from the solved legs) |

## Chained (two-hop) returns

The capability operators most often lack is the **chain**: when no single load
brings a vehicle back, carry one load part of the way and a second load the rest.
Single-hop matching structurally cannot find it, because it asks "is there a load
from here to my target" rather than "is there a load that gets me *closer*".

`VW_LEG1_CANDIDATES` + `VW_TRIANGLES` enumerate chains as a bounded load-to-load
self-join, and the Triangle Proposals page prices every leg live and grades the
result against the alternative of running home empty. See the *Chained (two-hop)
returns* section of `SKILL.md` for the design and its measured behaviour.

## Why this story generalizes

Every operator with imbalanced lanes reduces to the same model, so the demo is
built against categories rather than any named company:

- Port-hinterland haulage returning to a domestic market.
- Cross-border trunking between a manufacturing region and a consumption region.
- Pan-European or national trailer pools operated centrally.
- Continental LTL and FTL networks.
- Domestic LTL networks with regional imbalance.
- Drop-and-hook trailer pools.

The offer `SOURCE` column carries a neutral channel vocabulary (`DISPATCH`,
`MARKETPLACE`, `PARTNER_APP`, `INTERNAL`) and the originating system is carried
separately in `SOURCE_SYSTEM`, so onboarding a different set of external
exchanges changes no consumer and no page. The skill is **vendor-neutral by
construction**.

It also generalises beyond freight: any **drop-and-hook asset network** with
imbalanced lanes (rail wagons, container chassis, unit-load devices in air cargo,
even rental cars) reduces to the same VRP shape.

## What the demo does (single screen, single solve)

1. **Region picker** -> page loads:
   - Idle-bound trailers from `VW_TRAILERS` (color-coded by home depot).
   - Internal volumes from `INTERNAL_VOLUMES` (filled blue circles).
   - External freight-exchange offers from `EXTERNAL_OFFERS` (hollow circles,
     badge-coloured per source channel).
2. **Sliders** for:
   - `Internal Priority` (default 100 vs `External Priority` 10).
   - `Time-Window Tolerance` (hours, default +/-4h).
   - `Max Empty km per Leg` (hard skip, default 200 km).
3. **Solve Backloads** -> single `OPENROUTESERVICE_APP.CORE.OPTIMIZATION(...)`
   call -> page renders simultaneously:
   - Color-per-trailer **loaded legs** (DIRECTIONS polylines).
   - Gray dashed **empty legs**: both the reposition to the assigned pickup and
     the reposition from the last stop to the tour end.
   - Right rail KPIs: **deadhead avoided** (the vehicle's reposition baseline
     minus the empty km it actually drives, so it can never exceed the
     reposition it replaces), **USD/day reclaimed**, **% internal coverage**,
     **% trailers assigned**.
4. **Click a trailer in the rail** -> map zooms to its solved route and Cortex
   Complete generates a 2-sentence dispatcher rationale, for example: *"Trailer
   T-2118 is assigned internal volume INT-00441 (Essen -> Aarhus) because it sits
   18 km from pickup and points home; this saves 412 empty km against the
   next-best external offer."*
5. **Confirm Plan** -> all assignments are written to `PROPOSAL_DECISIONS`, the
   *Action Engine* close-the-loop step.

## Supporting roles for other ORS functions

| Function | Role on the page |
|---|---|
| `MATRIX('driving-hgv', ...)` | Underpins OPTIMIZATION (VROOM consumes it internally). We surface the call site in the AISQL notebook so the cost matrix is visible. |
| `ISOCHRONES('driving-hgv', ..., 240, NULL)` | "Explore mode" toggle - draws the 4-hour HGV reach polygon from a selected drop-off, visualizing what is reachable *before* solving. |
| `DIRECTIONS('driving-hgv', ...)` | Per-leg polyline renderer for the solved plan (one call per leg in the assignment). |
| `SNOWFLAKE.CORTEX.COMPLETE` | 2-sentence dispatcher rationale per assigned trailer. |
| `AI_FILTER`, `AI_AGG`, `AI_CLASSIFY`, `AI_EXTRACT` | Notebook-only - parse free-text offer descriptions, gate hazmat, roll up per corridor. |

## Operational signals mapped to page features (one-glance)

| Signal | Page response |
|---|---|
| *"Give me a proposal for the next job"* | Trailer pane + per-trailer assignment card |
| *"Internal-first, external-second"* | `Internal Priority` slider defaults 100 vs 10 - VROOM honours it deterministically |
| *"No single load gets this trailer home"* | Triangle Proposals: chained two-hop returns with an internal-first cascade |
| *"Minutes, not overnight"* | Page polls `VW_TRAILERS`; the productisation note calls out Snowpipe Streaming for `EXTERNAL_OFFERS` |
| *"Show me the savings"* | KPI row: deadhead avoided (bounded by the reposition baseline) + USD/day reclaimed |
| *"Information overload"* | One ranked plan, one map, one rationale - replaces several portals |
| *"An action engine, not just a dashboard"* | `Confirm Plan` writes to `PROPOSAL_DECISIONS` |
| *"Tell me which optimization parameters to configure"* | The sliders and the JSON shown in the AISQL notebook *are* the parameters, and `MATCH_PARAMS` makes each one a row rather than a code change |
