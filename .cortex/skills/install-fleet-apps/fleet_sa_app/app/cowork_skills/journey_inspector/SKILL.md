---
name: journey-inspector
description: Reconstruct any single Trip end to end: the road it actually took, every stop, speed over time, and how far it drifted from plan. Use for: What actually happened on this Trip, and why did it take longer or cost more than planned? Covers the Trip Inspector use case of the Fleet Intelligence accelerator.
---

# Trip Inspector

**Business question.** What actually happened on this Trip, and why did it take longer or cost more than planned?

**Who asks it.** Dispatch manager, Operations analyst, Claims and dispute handler, Safety lead

## How to answer

1. Use the `query_fleet_ops` Cortex Analyst tool. It is the governed path for this question - do NOT reach for `run_sql` unless query_fleet_ops cannot express what was asked.
2. Scope the question before aggregating. This deployment holds EVERY loaded region and asset mode at once, so an unfiltered aggregate mixes them. `region` is the key (for example SanFrancisco); `region_label` or `city` is the readable form a person types. Say which slice you used.
3. Lead with these measures rather than inventing your own:
   - journey distance vs planned distance
   - duration and average speed
   - stop count and total dwell minutes
   - deviation percentage
   - safety event count
4. This use case is inherently visual in the app. Outside the app you cannot draw its map: give the figures, then call `deep_link(view_id="journey_inspector", region=...)` and offer the link. Never describe map contents as if you had seen them.

## How the numbers are produced

The path is reconstructed from ordered position pings, so it follows the road rather than jumping in straight lines between stops. Deviation compares the actual path against the planned route; a Trip with no planned route is excluded rather than counted as zero deviation.

## Caveats you MUST state

Synthetic telemetry for the active region. Stops and dwell are derived from sessionized pings, so a stop shorter than the detection threshold does not appear at all.

## Questions this skill covers

- How far did this journey deviate from the plan?
- What was the average speed on this trip?
- How many stops and how much dwell time?
- Were there any safety events on this journey?

## What the answer is worth

- Settle a customer or driver dispute in minutes with evidence instead of assertion
- Find the recurring lanes and stops where time is actually lost
- Turn deviation from an anecdote into a measured percentage
