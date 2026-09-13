---
name: mix-sourcing
description: For a multi-product order, decide between shipping direct from several plants or consolidating into one truckload. Use for: For customers buying several products, is it cheaper to ship from each plant or to transfer everything into one hub and send a single load? Covers the Product Mix Sourcing use case of the Fleet Intelligence accelerator.
---

# Product Mix Sourcing

**Business question.** For customers buying several products, is it cheaper to ship from each plant or to transfer everything into one hub and send a single load?

**Who asks it.** Supply chain planner, Logistics manager, Order management, CFO

## How to answer

1. Use the `query_sourcing` Cortex Analyst tool. It is the governed path for this question - do NOT reach for `run_sql` unless query_sourcing cannot express what was asked.
2. Scope the question before aggregating. This deployment holds EVERY loaded region and asset mode at once, so an unfiltered aggregate mixes them. `region` is the key (for example SanFrancisco); `region_label` or `city` is the readable form a person types. Say which slice you used.
3. Lead with these measures rather than inventing your own:
   - total consolidation savings
   - orders where consolidation wins
   - orders better shipped direct
   - total handling cost paid to consolidate
4. This use case is inherently visual in the app. Outside the app you cannot draw its map: give the figures, then call `deep_link(view_id="mix_sourcing", region=...)` and offer the link. Never describe map contents as if you had seen them.

## How the numbers are produced

All plant-to-customer and plant-to-plant road distances are computed live with ORS MATRIX_TABULAR (two calls), not precomputed. freight = distance_km x rate per km + tons x distance_km x rate per ton-km. Ship direct: each product line ships from its cheapest capable plant straight to the customer. Consolidate: pick a hub plant, transfer in the products the hub cannot make from the nearest capable plant (adding a handling-per-ton penalty), then ship one consolidated load from the hub. The cheaper of the two is recommended.

## Caveats you MUST state

Synthetic plants, customers and orders. The model compares freight and handling only: it does not model lead time, truck availability, or the service impact of holding an order back to consolidate it. Single-line orders show near-zero savings by construction, and all plants and customers must sit inside one provisioned routing region graph.

## Questions this skill covers

- For customers buying several glass products, is it cheaper to consolidate at one plant or ship from several?
- Which orders should we consolidate to cut freight cost?
- How much handling cost do we pay to consolidate?

## What the answer is worth

- Pick the cheaper fulfilment option order by order instead of applying a blanket policy
- Price the handling penalty that consolidation actually costs
- Give order management a defensible rule for mixed orders
