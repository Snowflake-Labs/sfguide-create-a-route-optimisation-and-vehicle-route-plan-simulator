---
name: dispatch-execution-board
description: Today's committed work against what is actually happening: the job list, the resource board, and adherence by day. Use for: Will we complete today's committed work, and which jobs are already late or missed? Covers the Dispatch Execution Board use case of the Fleet Intelligence accelerator.
---

# Dispatch Execution Board

**Business question.** Will we complete today's committed work, and which jobs are already late or missed?

**Who asks it.** Dispatcher, Depot manager, Customer service lead, Service delivery manager

## How to answer

1. Use the `query_fleet_ops` Cortex Analyst tool. It is the governed path for this question - do NOT reach for `run_sql` unless query_fleet_ops cannot express what was asked.
2. Scope the question before aggregating. This deployment holds EVERY loaded region and asset mode at once, so an unfiltered aggregate mixes them. `region` is the key (for example SanFrancisco); `region_label` or `city` is the readable form a person types. Say which slice you used.
3. Lead with these measures rather than inventing your own:
   - scheduled work items
   - distinct entities (vehicles)
   - assigned operators
   - destination sites
   - on-time vs missed / late / delayed status
4. This use case is inherently visual in the app. Outside the app you cannot draw its map: give the figures, then call `deep_link(view_id="dispatch_execution_board", region=...)` and offer the link. Never describe map contents as if you had seen them.

## How the numbers are produced

Scheduled Scheduled Trips are compared against detected activity. Status (missed, late, delayed) and plan adherence are derived on this page rather than modelled in a semantic view, so the assistant answers those from the on-screen values.

## Caveats you MUST state

Synthetic schedule and telemetry. Because status comes from detection, a job completed outside the geofence or with no pings can read as missed.

## Questions this skill covers

- How many scheduled jobs are there?
- Are there any missed or late jobs?
- Which entity has the most jobs?
- Which site receives the most jobs?

## What the answer is worth

- Catch a missed commitment while it can still be recovered, not in tomorrow's report
- Rebalance work across Vehicles before the day breaks
- Give customer service the same truth dispatch is looking at
