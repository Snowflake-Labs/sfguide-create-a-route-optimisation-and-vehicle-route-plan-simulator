---
name: responsible-party-performance
description: League table of Drivers: who covers the most distance, who deviates from plan, and who accumulates the most risk events. Use for: Which Drivers need coaching, and which ones are our benchmark? Covers the Driver Performance use case of the Fleet Intelligence accelerator.
---

# Driver Performance

**Business question.** Which Drivers need coaching, and which ones are our benchmark?

**Who asks it.** Fleet safety manager, Depot or branch manager, Training lead, Insurance and risk

## How to answer

1. Use the `query_fleet_ops` Cortex Analyst tool. It is the governed path for this question - do NOT reach for `run_sql` unless query_fleet_ops cannot express what was asked.
2. Scope the question before aggregating. This deployment holds EVERY loaded region and asset mode at once, so an unfiltered aggregate mixes them. `region` is the key (for example SanFrancisco); `region_label` or `city` is the readable form a person types. Say which slice you used.
3. Lead with these measures rather than inventing your own:
   - operator (driver) count
   - total journeys
   - average trip distance
   - deviated journeys
   - safety events per operator
4. This use case is inherently visual in the app. Outside the app you cannot draw its map: give the figures, then call `deep_link(view_id="responsible_party_performance", region=...)` and offer the link. Never describe map contents as if you had seen them.

## How the numbers are produced

Trip counts, distance and speed come from the trip records. Per-operator safety-event counts come from the event data and are not part of the semantic view, so they are event-derived rather than modelled metrics. The leaderboard is sorted by safety events descending.

## Caveats you MUST state

Synthetic operators and events. In a real deployment, whether per-person ranking is acceptable and who may see it is a decision for the customer and their works council; the platform supports masking and row access policies for exactly that reason.

## Questions this skill covers

- Who has the most safety events?
- Which operator covers the most distance?
- How does operator X compare to operator Y?
- What is the safety event rate per journey?

## What the answer is worth

- Target coaching where it changes claims and fuel cost, instead of training everyone equally
- Evidence for insurance and risk negotiations
- Recognise the good operators on the same evidence used to correct the others
