---
name: sourcing-optimizer
description: Serve each customer from the cheapest plant that can actually make their product, priced on real road distance. Use for: Where are we shipping from the wrong plant, and what would re-sourcing save us in a year? Covers the Freight Sourcing Optimizer use case of the Fleet Intelligence accelerator.
---

# Freight Sourcing Optimizer

**Business question.** Where are we shipping from the wrong plant, and what would re-sourcing save us in a year?

**Who asks it.** Supply chain director, Logistics and freight manager, CFO, Commercial operations

## How to answer

1. Use the `query_sourcing` Cortex Analyst tool. It is the governed path for this question - do NOT reach for `run_sql` unless query_sourcing cannot express what was asked.
2. Scope the question before aggregating. This deployment holds EVERY loaded region and asset mode at once, so an unfiltered aggregate mixes them. `region` is the key (for example SanFrancisco); `region_label` or `city` is the readable form a person types. Say which slice you used.
3. Lead with these measures rather than inventing your own:
   - current annual freight spend
   - optimized annual freight spend
   - total annual savings
   - customers with a cheaper source
4. This use case is inherently visual in the app. Outside the app you cannot draw its map: give the figures, then call `deep_link(view_id="sourcing_optimizer", region=...)` and offer the link. Never describe map contents as if you had seen them.

## How the numbers are produced

The plant-to-customer road-distance matrix is computed live with a single ORS MATRIX_TABULAR call (all plants by all customers), not precomputed. Freight cost per truckload = distance_km x rate per km + tons x distance_km x rate per ton-km. The current source is a data-only baseline (the nearest product-capable plant by straight-line distance); the optimizer picks the cheapest source by actual road distance, so the gap is the achievable saving. Only plants that can make the customer's product are considered, and annual savings are the per-load saving multiplied by the customer's annual truckloads.

## Caveats you MUST state

Plants, customers and volumes are synthetic. The saving is only as good as the rates entered, and it assumes the proposed plant has the capacity to absorb the volume - capacity is not modelled. All plants and customers must sit inside one provisioned routing region graph.

## Questions this skill covers

- Based on our plant locations, where would location swaps reduce freight costs?
- Which customer has the biggest freight saving from switching source plant?
- How much can we save in total by re-sourcing?

## What the answer is worth

- Cut freight spend with no capital investment - it is a sourcing decision, not a build
- Quantify a re-sourcing business case customer by customer
- Expose where straight-line planning has been quietly wrong
