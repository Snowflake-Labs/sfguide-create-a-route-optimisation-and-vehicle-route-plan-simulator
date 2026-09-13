---
name: catchment
description: Live drive-time market analysis for any site: who and what is actually reachable in 5, 10 and 15 minutes by road. Use for: If we put a site here, how many people can reach it by road, and who is already competing for them? Covers the Catchment use case of the Fleet Intelligence accelerator.
---

# Catchment

**Business question.** If we put a site here, how many people can reach it by road, and who is already competing for them?

**Who asks it.** Head of real estate, Network planner, Franchise development, Commercial strategy

## How to answer

1. Call the `catchment` tool. Its result is an MCP tool result, so it CANNOT be charted: `data_to_chart` accepts only a Cortex Analyst or `run_sql` result. Present the figures as a markdown table instead.
2. Scope the question before aggregating. This deployment holds EVERY loaded region and asset mode at once, so an unfiltered aggregate mixes them. `region` is the key (for example SanFrancisco); `region_label` or `city` is the readable form a person types. Say which slice you used.
3. Lead with these measures rather than inventing your own:
   - reachable population and households
   - median income
   - venues in catchment
   - catchment area
4. This use case is inherently visual in the app. Outside the app you cannot draw its map: give the figures, then call `deep_link(view_id="catchment", region=...)` and offer the link. Never describe map contents as if you had seen them.

## How the numbers are produced

Isochrones are computed at interaction time by calling OpenRouteService, never precomputed, so the region's routing service must be running. Population, households and median income are the real Census figures also used by Site Impact and Closure Impact: ZIP centroids inside the drive-time polygon, with income household-weighted.

## Caveats you MUST state

Bands are cumulative (within X minutes), so never sum population or venues across band rows. The Census metrics are US-only and read 0 elsewhere, while the Overture venue and address counts populate in any region. Because the isochrones are live, a suspended region routing service means no rings.

## Questions this skill covers

- How many people live within a 10-minute drive of this site?
- How many restaurants compete inside the 15-minute catchment?
- What is the median income of the 5-minute catchment?

## What the answer is worth

- Screen sites in minutes instead of commissioning a study per location
- Compare candidates on a measured drive-time basis rather than on radius circles
- Kill bad sites before spending survey money on them
