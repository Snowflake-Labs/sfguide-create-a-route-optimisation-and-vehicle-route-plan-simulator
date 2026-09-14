---
name: dwell-overview
description: 'How much of the day the fleet spends standing still, how that is trending, and how often it breaches the dwell SLA. Use for: How much paid time are we losing to standing still, and are we meeting our turnaround commitments? Covers the Dwell Overview use case of the Fleet Intelligence accelerator.'
---

# Dwell Overview

**Business question.** How much paid time are we losing to standing still, and are we meeting our turnaround commitments?

**Who asks it.** Operations manager, Supply chain lead, Site or yard manager, Carrier performance manager

## How to answer

1. Use the `query_dwell` Cortex Analyst tool. It is the governed path for this question - do NOT reach for `run_sql` unless query_dwell cannot express what was asked.
2. Scope the question before aggregating. This deployment holds EVERY loaded region and asset mode at once, so an unfiltered aggregate mixes them. `region` is the key (for example SanFrancisco); `region_label` or `city` is the readable form a person types. Say which slice you used.
3. Lead with these measures rather than inventing your own:
   - total dwell sessions
   - average dwell minutes
   - SLA compliance rate
   - active drivers
4. Answer with figures and a chart - this view has no map, so there is nothing you are unable to draw. Offer `deep_link(view_id="dwell_overview", region=...)` only when the user wants to explore interactively.

## How the numbers are produced

Dwell sessions are sessionized from position pings: consecutive stationary pings inside a site radius are grouped into one session. SLA compliance is the fraction of sessions at or under the configured threshold, 30 minutes by default.

## Caveats you MUST state

Synthetic telemetry. A stop shorter than the detection threshold is not a session at all, so very brief stops are invisible by design. The four headline numbers count REAL dwell only: IDLE spans are excluded so the KPIs match the trend and facility charts beside them, and vehicles that were never dispatched over the horizon are excluded because their whole stay is one unbroken multi-day idle span that would otherwise dominate every average. This view has no map; use SLA Alerts for dwell geography.

## Questions this skill covers

- What is the average dwell time?
- What is the SLA compliance rate?
- Which facility has the most visits?
- Are dwells trending up or down?

## What the answer is worth

- Recover paid hours lost at the dock or the kerb
- Hold sites and carriers to a measured turnaround commitment
- Free capacity without buying more Vehicles
