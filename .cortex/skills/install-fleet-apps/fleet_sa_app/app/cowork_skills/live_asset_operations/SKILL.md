---
name: live-asset-operations
description: 'One live picture of the whole fleet: where every Vehicle is right now, what state it is in, and whether the fleet is earning or idling. Use for: Where is every Vehicle right now, and how much of our movement is productive rather than empty? Covers the Live Vehicle Operations use case of the Fleet Intelligence accelerator.'
---

# Live Vehicle Operations

**Business question.** Where is every Vehicle right now, and how much of our movement is productive rather than empty?

**Who asks it.** Fleet operations manager, Dispatch supervisor, COO

## How to answer

1. Use the `query_fleet_ops` Cortex Analyst tool. It is the governed path for this question - do NOT reach for `run_sql` unless query_fleet_ops cannot express what was asked.
2. Scope the question before aggregating. This deployment holds EVERY loaded region and asset mode at once, so an unfiltered aggregate mixes them. `region` is the key (for example SanFrancisco); `region_label` or `city` is the readable form a person types. Say which slice you used.
3. Lead with these measures rather than inventing your own:
   - active Vehicles
   - movement utilization %
   - empty miles %
   - average speed
4. This use case is inherently visual in the app. Outside the app you cannot draw its map: give the figures, then call `deep_link(view_id="live_asset_operations", region=...)` and offer the link. Never describe map contents as if you had seen them.

## How the numbers are produced

Positions are raw GPS pings. Utilization is the share of pings in a MOVING state, so it is a movement measure rather than a duty-cycle or paid-hours measure. Empty miles come from leg classification (laden versus empty), not from an assumption.

## Caveats you MUST state

The telemetry is synthetic, generated for the active region and vehicle type. Because utilization is ping-based, do not quote it as a contractual utilization figure.

## Questions this skill covers

- How many Vehicles are moving right now?
- What is our empty miles percentage?
- Which Vehicles are moving, idle, or on site at this moment?
- Where do we start if we want to reduce empty miles?

## What the answer is worth

- Cut empty running, which is cost with no revenue attached
- Replace a morning roll-call spreadsheet with a live shared picture
- Give dispatch one screen instead of one portal per telematics vendor
