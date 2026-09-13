---
name: site-impact
description: Cannibalisation what-if on a live gravity model: how much of a new site's revenue is genuinely new, and how much is simply moved off your own estate. Use for: If we open here, how much of the revenue is incremental, how much comes out of our existing stores, and does it pay back against the rent? Covers the Site Impact use case of the Fleet Intelligence accelerator.
---

# Site Impact

**Business question.** If we open here, how much of the revenue is incremental, how much comes out of our existing stores, and does it pay back against the rent?

**Who asks it.** Head of real estate, CFO and finance business partner, Network strategy, Franchise development

## How to answer

1. Use the `query_location` Cortex Analyst tool. It is the governed path for this question - do NOT reach for `run_sql` unless query_location cannot express what was asked.
2. Scope the question before aggregating. This deployment holds EVERY loaded region and asset mode at once, so an unfiltered aggregate mixes them. `region` is the key (for example SanFrancisco); `region_label` or `city` is the readable form a person types. Say which slice you used.
3. Lead with these measures rather than inventing your own:
   - net new revenue
   - cannibalisation rate %
   - cannibalised revenue
   - payback years
   - share of loss by store
4. This use case is inherently visual in the app. Outside the app you cannot draw its map: give the figures, then call `deep_link(view_id="site_impact", region=...)` and offer the link. Never describe map contents as if you had seen them.

## How the numbers are produced

Demand is allocated by a Huff gravity model over LIVE drive times, not by proximity. One ORS matrix call prices every household anchor cell against every store, and each store's pull is its attractiveness (floor area relative to the region mean) divided by drive minutes raised to the decay exponent beta. Each store's share of a cell is its pull over the total pull of the whole choice set - our stores, competitor stores, and the candidate. The model is solved twice, with and without the candidate, and the DIFFERENCE is the transfer: demand lost by our own stores is cannibalisation, demand lost by competitors is net new. Those two sum exactly to what the candidate captures, because shares sum to one in both worlds. Household anchors are H3 cells (native res 8 where the matrix budget allows, coarsened automatically for wide bands on sprawling regions - the reported anchor resolution tells you which). The separate Overlaps panel is a different, stricter question: the literal ST_INTERSECTION of two live isochrones, pairwise, so its rows must not be summed and it will legitimately show nothing when store catchments do not physically touch even though the gravity model still reports transfer.

## Caveats you MUST state

Household counts are real address density from Overture addresses, but every money figure is modelled from the assumptions set on screen - value per household, capture rate, EBITDA margin - so present them as a model, never as a measurement. The store estate is a synthetic stand-in built from Overture POIs: which stores are ours, which are competitors, and which are candidate sites is an arbitrary partition, so the candidate sites are NOT sited anywhere commercially meaningful. Floor area, rent and the Home Visit / Sample / Walk-in mix are synthetic too, which means attractiveness and payback are structurally right but not real. Competitor stores deliberately carry no revenue or EBITDA - we model where they lose demand, not their accounts. Drive-time bands are nested what-if scenarios: never sum transfer across bands for the same candidate and store pair. Share of loss distributes the transfer across our estate and sums to 100; it is not a percentage of any store's turnover.

## Questions this skill covers

- How much of this site's revenue is genuinely new rather than taken from our own stores?
- Which of our stores bears the largest share of the transfer?
- What is the payback on the candidate against its rent and rates?
- How does the answer change if households are less willing to travel?

## What the answer is worth

- Avoid opening a site that mostly moves existing revenue around
- Defend or challenge a site proposal with a transparent, adjustable model
- Rank a candidate pipeline on net rather than gross opportunity
