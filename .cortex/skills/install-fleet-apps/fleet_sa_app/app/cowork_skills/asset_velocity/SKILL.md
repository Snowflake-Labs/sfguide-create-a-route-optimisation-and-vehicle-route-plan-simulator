---
name: asset-velocity
description: Find idle Vehicles, price what the idleness is costing, and get a live repositioning suggestion for each one. Use for: Which of our Vehicles are sitting still, what is that costing us, and where should they go next? Covers the Asset Velocity use case of the Fleet Intelligence accelerator.
---

# Asset Velocity

**Business question.** Which of our Vehicles are sitting still, what is that costing us, and where should they go next?

**Who asks it.** Fleet asset manager, Dispatch manager, CFO, Yard and depot operations

## How to answer

1. Use the `query_asset_velocity` Cortex Analyst tool. It is the governed path for this question - do NOT reach for `run_sql` unless query_asset_velocity cannot express what was asked.
2. Scope the question before aggregating. This deployment holds EVERY loaded region and asset mode at once, so an unfiltered aggregate mixes them. `region` is the key (for example SanFrancisco); `region_label` or `city` is the readable form a person types. Say which slice you used.
3. Lead with these measures rather than inventing your own:
   - idle vehicle count
   - total cost of idleness (USD)
   - projected savings (USD)
   - average idle days
   - lane demand
4. This use case is inherently visual in the app. Outside the app you cannot draw its map: give the figures, then call `deep_link(view_id="asset_velocity", region=...)` and offer the link. Never describe map contents as if you had seen them.

## How the numbers are produced

Idle time is the gap since the asset last moved, filtered by the idle-days threshold set on screen. Cost of idleness is idle days multiplied by the configured daily cost for that class. The repositioning move is solved live against the road network and its rationale is generated on screen.

## Caveats you MUST state

Synthetic assets and positions. Projected savings assume the repositioned asset actually finds work at the destination, so treat the figure as an upper bound.

## Questions this skill covers

- Which vehicle has the highest cost of idleness?
- What is the total cost of idleness?
- Which dispatcher has the most idle vehicles?
- How many CRITICAL-severity vehicles are there?

## What the answer is worth

- Turn parked assets back into earning assets
- Raise utilization enough to defer capital spend on more units
- Give dispatch a defensible next move for every idle asset
