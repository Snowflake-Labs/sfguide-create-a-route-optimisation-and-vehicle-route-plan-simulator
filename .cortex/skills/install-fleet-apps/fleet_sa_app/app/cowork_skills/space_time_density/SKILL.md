---
name: space-time-density
description: 'Where and when activity concentrates: an H3 hexagon heatmap you can animate hour by hour. Use for: Where does our activity cluster, and at what times of day, so depots, shifts and capacity can be placed against real demand? Covers the Space-Time Density use case of the Fleet Intelligence accelerator.'
---

# Space-Time Density

**Business question.** Where does our activity cluster, and at what times of day, so depots, shifts and capacity can be placed against real demand?

**Who asks it.** Network planner, Operations strategy, Depot siting, Demand planner

## How to answer

1. Use the `query_fleet_ops` Cortex Analyst tool. It is the governed path for this question - do NOT reach for `run_sql` unless query_fleet_ops cannot express what was asked.
2. Scope the question before aggregating. This deployment holds EVERY loaded region and asset mode at once, so an unfiltered aggregate mixes them. `region` is the key (for example SanFrancisco); `region_label` or `city` is the readable form a person types. Say which slice you used.
3. Lead with these measures rather than inventing your own:
   - activity density by H3 hex
   - time spent (dwell minutes) per hex
   - distinct vehicles per hex
   - top places and drivers by dwell
4. This use case is inherently visual in the app. Outside the app you cannot draw its map: give the figures, then call `deep_link(view_id="space_time_density", region=...)` and offer the link. Never describe map contents as if you had seen them.

## How the numbers are produced

Pings are bucketed into H3 cells and by hour of day. The metric selector switches between time spent and distinct Vehicles per cell; the hour slider filters to one hour and aggregate-all sums the whole day.

## Caveats you MUST state

Synthetic telemetry, so the clusters reflect the generator's route pool rather than a real market. Time spent per cell is derived from ping cadence, so an area sampled more often reads hotter.

## Questions this skill covers

- Where does fleet activity concentrate?
- What are the top places by dwell?
- Which hour of day is busiest?

## What the answer is worth

- Site depots, lockers and charge points against observed demand rather than intuition
- Shape shift patterns around the hours that actually carry the load
- Spot congestion and dead zones in the network you already run
