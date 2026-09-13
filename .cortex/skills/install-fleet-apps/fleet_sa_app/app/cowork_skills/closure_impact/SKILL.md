---
name: closure-impact
description: Closure what-if: when a site closes, which surviving sites inherit its customers and which revenue simply leaks away. Use for: If we close this site, how much revenue do we keep because a neighbour can still serve it, and how much do we lose outright? Covers the Closure Impact use case of the Fleet Intelligence accelerator.
---

# Closure Impact

**Business question.** If we close this site, how much revenue do we keep because a neighbour can still serve it, and how much do we lose outright?

**Who asks it.** Head of real estate, CFO, Network strategy, Regional director

## How to answer

1. Use the `query_location` Cortex Analyst tool. It is the governed path for this question - do NOT reach for `run_sql` unless query_location cannot express what was asked.
2. Scope the question before aggregating. This deployment holds EVERY loaded region and asset mode at once, so an unfiltered aggregate mixes them. `region` is the key (for example SanFrancisco); `region_label` or `city` is the readable form a person types. Say which slice you used.
3. Lead with these measures rather than inventing your own:
   - revenue retained by surviving stores
   - revenue at risk
   - closure risk score
   - households reassigned
   - households at risk
4. This use case is inherently visual in the app. Outside the app you cannot draw its map: give the figures, then call `deep_link(view_id="closure_impact", region=...)` and offer the link. Never describe map contents as if you had seen them.

## How the numbers are produced

The map shows a household H3 hexagon heatmap of the closing store's drive-time catchment, shaded by how many surviving stores still reach each cell (red = at risk or thin coverage, green = well covered). Coverage is computed from pre-rasterized H3 res-8 household cells tested against live drive-time isochrones, not from stacked polygons. A postcode (ZIP) is RETAINED if at least one surviving store's catchment reaches its centroid within the band, otherwise AT_RISK, and its revenue is the closure leakage. Revenue and EBITDA are user-driven: households x value per household x retention rate, with EBITDA = revenue x margin, and the Home Visit / Sample / Walk-in split comes from the closing store's interaction mix. Closure risk score = at-risk revenue / total closing-store revenue. The gainers table assigns each catchment cell to its nearest surviving store (non-overlapping).

## Caveats you MUST state

Households are real address density, but revenue, EBITDA and the retained-versus-at-risk split all depend on the assumptions set on screen. Overlap-summary rows are pairwise (closed store versus one surviving store), so do not sum households across rows, because surviving-store catchments themselves overlap. The store estate and its interaction mix are synthetic, and customer loyalty to a specific site is not modelled beyond the retention rate.

## Questions this skill covers

- If we close this store, which store inherits the most sales?
- How much revenue is at risk if we close this store?
- What is the closure risk score for this store?

## What the answer is worth

- Close the sites whose demand is genuinely absorbed, rather than the ones with the worst P&L
- Quantify the leakage before it shows up in next year's revenue
- Prepare the transfer plan for the stores that inherit the volume
