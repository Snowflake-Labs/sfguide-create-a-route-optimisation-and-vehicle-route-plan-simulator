---
name: backload-proposals
description: Four backhaul strategies run side by side and fused into one graded recommendation per vehicle, with the reasons a load was rejected shown on the card. Use for: Which backhaul should this vehicle take, how confident are we, and why was the obvious-looking load actually ineligible? Covers the Backload Proposals use case of the Fleet Intelligence accelerator.
---

# Backload Proposals

**Business question.** Which backhaul should this vehicle take, how confident are we, and why was the obvious-looking load actually ineligible?

**Who asks it.** Head of transport, Dispatch supervisor, Network optimization lead, Freight buyer

## How to answer

1. Call the `backload_solve` tool. Its result is an MCP tool result, so it CANNOT be charted: `data_to_chart` accepts only a Cortex Analyst or `run_sql` result. Present the figures as a markdown table instead.
2. Scope the question before aggregating. This deployment holds EVERY loaded region and asset mode at once, so an unfiltered aggregate mixes them. `region` is the key (for example SanFrancisco); `region_label` or `city` is the readable form a person types. Say which slice you used.
3. Lead with these measures rather than inventing your own:
   - vehicles_matched, internal_matched, total_empty_km, total_margin_usd (revenue minus empty-leg cost across the plan), avg_composite (0-100 ensemble score)
   - per-vehicle graded proposal (trailer -> load), its strategy family, and how many of the 4 strategies agree
   - eligible_pairs (trailer/load pairs passing distance/pickup-time/horizon/capacity/hazmat), and accepted/rejected counts (session-only)
   - the top ranked proposals are published as __memo_backload (trailer->load, grade, strategy, pickup->delivery cities, empty km, loaded km, margin USD, internal/external)
4. This use case is inherently visual in the app. Outside the app you cannot draw its map: give the figures, then call `deep_link(view_id="backload_proposals", region=...)` and offer the link. Never describe map contents as if you had seen them.

## How the numbers are produced

Quick scan is a great-circle nearest-load pass with no solve. Per-load routing, fleet one-to-one and profit-max each call the routing engine once. Ensemble mode fuses all four with configurable ranking weights into a graded proposal per vehicle, and the constraint chips come from the scored candidate view.

## Caveats you MUST state

Synthetic vehicles and loads. Everything is null until Run is pressed, and Accept, Reject and Flag are session-only rather than persisted. The routing strategies require the region routing and optimizer services to be running.

## Questions this skill covers

- which vehicles have the best backload proposals?
- how many empty km does the plan reclaim?
- how many internal loads were filled versus external offers?
- why is a load ineligible for a vehicle?
- give me a list of proposals with delivery and revenue details for each
- what is on the map right now?

## What the answer is worth

- Higher-quality backhaul decisions than any single heuristic gives
- Explainable rejections, which is what earns dispatcher trust in an optimizer
- A defensible margin number per proposal rather than a gut call
