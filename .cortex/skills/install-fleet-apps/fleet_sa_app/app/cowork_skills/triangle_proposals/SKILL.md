---
name: triangle-proposals
description: Recovers return trips that single-hop matching cannot see, by chaining two loads through an intermediate drop and pricing the chain against the cost of running home empty. Use for: There is no load from here back to where this vehicle is needed. Is there a pair of loads that gets it home via an intermediate stop, and is that chain actually better than running empty? Covers the Triangle Proposals use case of the Fleet Intelligence accelerator.
---

# Triangle Proposals

**Business question.** There is no load from here back to where this vehicle is needed. Is there a pair of loads that gets it home via an intermediate stop, and is that chain actually better than running empty?

**Who asks it.** Head of transport, Dispatch supervisor, Network optimization lead, Freight buyer

## How to answer

1. Call the `backload_chain_solve` tool. Its result is an MCP tool result, so it CANNOT be charted: `data_to_chart` accepts only a Cortex Analyst or `run_sql` result. Present the figures as a markdown table instead.
2. Scope the question before aggregating. This deployment holds EVERY loaded region and asset mode at once, so an unfiltered aggregate mixes them. `region` is the key (for example SanFrancisco); `region_label` or `city` is the readable form a person types. Say which slice you used.
3. Lead with these measures rather than inventing your own:
   - chains (costed two-hop candidates), vehicles covered, and the cascade rung the ladder stopped at (1 own-loads-only .. 4 external-on-both-hops)
   - per chain: both hops as pickup -> delivery with own/external on each, the three empty legs (to hop 1, between hops, residual to target), loaded km, grade and eligibility
   - empty km per chain INCLUDES the residual run from the second delivery to the target, so it is directly comparable with the empty-run-home baseline
   - status-quo comparison per chain: chain empty km against the empty run home, chain net against doing nothing, and whether the chain beats that baseline (a chain can beat it on net while still running more empty km, because it earns revenue)
   - the on-screen chains are published as __memo_triangle_proposals (trailer, rung, both hops, empty incl. residual and loaded km, net vs baseline, beats-baseline, grade)
4. This use case is inherently visual in the app. Outside the app you cannot draw its map: give the figures, then call `deep_link(view_id="triangle_proposals", region=...)` and offer the link. Never describe map contents as if you had seen them.

## How the numbers are produced

Chain skeletons are enumerated in SQL: first hops are loads that carry the vehicle CLOSER to its target (a first hop that already arrives is a direct return and is excluded), kept only when progress toward the target at least pays for the empty km spent reaching it, and bounded to the best few per vehicle before a second hop is joined on. Hop ordering is enforced by an estimated first-leg delivery time because the solver has no precedence constraint. Surviving chains are then costed on the live road network with a single matrix call, scored on utilisation, how completely they close the return, and empty km saved, and filtered by an internal-first cascade that stops at the first rung meeting the acceptance score.

## Caveats you MUST state

Vehicles, loads and offers are synthetic, and revenue per loaded km and cost per empty km are stated assumptions rather than source data - both are editable on the page for what-if purposes only. Vehicle equipment is synthesized and the equipment constraint is seeded off. Many load endpoints have no upstream place name, so cards fall back to a coordinate label. Constraint sliders can only tighten inside the envelope the chain view already pruned at, since chains outside it were never enumerated. Chaining only applies over long distances: on a single-metro dataset the page correctly reports that no chain is needed. Read-only - nothing is written back. Requires the region routing services to be running.

## Questions this skill covers

- which vehicles have a two-hop chain home?
- did we need to go to an external exchange for any of these chains?
- which chains do not beat simply running home empty?
- why is there no chain for this vehicle?
- how much empty running does the best chain save?

## What the answer is worth

- Return trips recovered that a direct-match search structurally cannot find
- Own capacity used before money is spent on an outside exchange
- A defensible comparison against running empty, which is what earns planner trust
