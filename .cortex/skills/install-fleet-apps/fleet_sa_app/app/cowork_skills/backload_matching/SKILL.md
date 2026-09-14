---
name: backload-matching
description: 'Fill the empty return leg: match idle vehicles to waiting internal loads first, then to external freight offers, and price the result. Use for: Our vehicles run back empty. Which waiting loads could they carry instead, and what is that worth? Covers the Backload Matching use case of the Fleet Intelligence accelerator.'
---

# Backload Matching

**Business question.** Our vehicles run back empty. Which waiting loads could they carry instead, and what is that worth?

**Who asks it.** Dispatcher, Head of transport, Freight buyer, CFO

## How to answer

1. Call the `backload_solve` tool. Its result is an MCP tool result, so it CANNOT be charted: `data_to_chart` accepts only a Cortex Analyst or `run_sql` result. Present the figures as a markdown table instead.
2. Scope the question before aggregating. This deployment holds EVERY loaded region and asset mode at once, so an unfiltered aggregate mixes them. `region` is the key (for example SanFrancisco); `region_label` or `city` is the readable form a person types. Say which slice you used.
3. Lead with these measures rather than inventing your own:
   - assignments_count (trips in the plan), internal_matched, internal_pct, net_benefit_usd, unassigned_count, empty_km_total, deadhead_avoided_km_total
   - trailers / internal_volumes / external_offers loaded for the active preset, and selected_trailer. internal_volumes is a BOUNDED PLANNING POOL, not a real backlog: each row is a historical trip reinterpreted as an open order, and the pool is sized at INTERNAL_LOADS_PER_TRAILER (default 4) x the region's vehicle count, capped by INTERNAL_POOL_CAP. So it scales with fleet size and is NOT a count of orders anyone placed - do not present it as demand, and do not compare it across regions as though it measured activity
   - the full per-trip list is published as __memo_backload_matching: trailer id, source (INTERNAL/external), pickup->dropoff city, the delivery points (dropoff cities), delivery count, empty km split into out + back legs, loaded km, deadhead avoided versus the reposition baseline, and revenue/cost/net USD
4. This use case is inherently visual in the app. Outside the app you cannot draw its map: give the figures, then call `deep_link(view_id="backload_matching", region=...)` and offer the link. Never describe map contents as if you had seen them.

## How the numbers are produced

Idle vehicles, internal loads and external offers are assembled into one routing problem and solved live. Empty km covers both deadhead legs (idle location to first pickup, and last stop to tour end). Deadhead avoided is the vehicle's reposition baseline, the real road distance from its idle location to its end point, minus the empty km actually driven, so it can never exceed that baseline.

## Caveats you MUST state

Vehicles, loads and offers are synthetic, and the economics use the rates configured on screen. Nothing is computed until Solve is pressed, and the plan is not written back to a TMS - it is a recommendation. Requires the region routing and optimizer services to be running.

## Questions this skill covers

- give me a list of assignments with delivery and revenue details for each
- which trips deliver where?
- how much net benefit does the plan reclaim?
- how much deadhead did the plan avoid?
- how many internal vs external loads were matched?
- which trailer has the most profitable backload?

## What the answer is worth

- Convert empty running into revenue-earning or cost-avoiding movement
- Fill your own waiting loads before paying an exchange for someone else's
- Give the dispatcher a priced, ranked recommendation instead of a phone-around
