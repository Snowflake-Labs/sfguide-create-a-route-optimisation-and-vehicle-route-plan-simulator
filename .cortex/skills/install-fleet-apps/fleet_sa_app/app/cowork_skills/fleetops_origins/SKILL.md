---
name: fleetops-origins
description: Where Trips begin, ranked by volume, so network and depot decisions start from observed origins. Use for: Which origins generate most of our work, and is our network actually positioned against them? Covers the Top Origins use case of the Fleet Intelligence accelerator.
---

# Top Origins

**Business question.** Which origins generate most of our work, and is our network actually positioned against them?

**Who asks it.** Network planner, Depot siting, Operations strategy, Commercial planner

## How to answer

1. Use the `query_fleet_ops` Cortex Analyst tool. It is the governed path for this question - do NOT reach for `run_sql` unless query_fleet_ops cannot express what was asked.
2. Scope the question before aggregating. This deployment holds EVERY loaded region and asset mode at once, so an unfiltered aggregate mixes them. `region` is the key (for example SanFrancisco); `region_label` or `city` is the readable form a person types. Say which slice you used.
3. Lead with these measures rather than inventing your own:
   - distinct origin locations
   - total trips from origins
   - average trip duration
   - distinct location types
4. This use case is inherently visual in the app. Outside the app you cannot draw its map: give the figures, then call `deep_link(view_id="fleetops_origins", region=...)` and offer the link. Never describe map contents as if you had seen them.

## How the numbers are produced

Only origins with more than zero Trips are shown, and the map is capped at 2000 points, so the dot count on the map is not the origin total - the header count is.

## Caveats you MUST state

Synthetic Trips for the active region.

## Questions this skill covers

- Which origin has the most trips?
- What are the top 5 origins by trip count?
- How many distinct location types are there?

## What the answer is worth

- Position depots and staging against real origin volume
- Find the few origins worth a dedicated resource
- Simplify a network that grew by accident
