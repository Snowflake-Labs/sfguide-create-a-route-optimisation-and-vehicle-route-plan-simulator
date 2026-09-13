---
name: dwell-facilities
description: Which sites and site types absorb the fleet's standing time, ranked by load. Use for: Which facilities cost us the most turnaround time, and is the problem one site or a whole class of sites? Covers the Facility Utilization use case of the Fleet Intelligence accelerator.
---

# Facility Utilization

**Business question.** Which facilities cost us the most turnaround time, and is the problem one site or a whole class of sites?

**Who asks it.** Network and yard operations, Site manager, Supplier or carrier manager, Procurement

## How to answer

1. Use the `query_dwell` Cortex Analyst tool. It is the governed path for this question - do NOT reach for `run_sql` unless query_dwell cannot express what was asked.
2. Scope the question before aggregating. This deployment holds EVERY loaded region and asset mode at once, so an unfiltered aggregate mixes them. `region` is the key (for example SanFrancisco); `region_label` or `city` is the readable form a person types. Say which slice you used.
3. Lead with these measures rather than inventing your own:
   - distinct facilities
   - total visits
   - average dwell minutes
   - maximum single-session dwell
   - facility type mix
4. Answer with figures and a chart - this view has no map, so there is nothing you are unable to draw. Offer `deep_link(view_id="dwell_facilities", region=...)` only when the user wants to explore interactively.

## How the numbers are produced

Dwell sessions are attributed to the site whose detection radius contains the stop, then aggregated by site and by site type.

## Caveats you MUST state

Synthetic telemetry and site master. This view shows utilization only and has no map; use SLA Alerts to see breaching sites geographically.

## Questions this skill covers

- Which facility has the longest total dwell?
- Which facility type gets the most visits?
- How many total visits across all facilities?
- Which Facilities cost us the most turnaround time?

## What the answer is worth

- Fix the small number of sites that cause most of the delay
- Evidence for a commercial conversation with a supplier or a landlord
- Plan dock and yard capacity against measured load
