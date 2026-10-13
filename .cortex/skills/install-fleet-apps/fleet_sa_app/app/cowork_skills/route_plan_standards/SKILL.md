---
name: route-plan-standards
description: 'Put a number on planner-to-planner variation, then price it against what the optimizer would have done with the same stops. Use for: Are all our route planners working to the same standard, and what is the inconsistency costing us in distance, hours and warehouse start time? Covers the Route Plan Standards use case of the Fleet Intelligence accelerator.'
---

# Route Plan Standards

**Business question.** Are all our route planners working to the same standard, and what is the inconsistency costing us in distance, hours and warehouse start time?

**Who asks it.** Head of transport planning, Route planning manager, Distribution centre manager, Supply chain lead

## How to answer

1. Use the `query_plan_standards` Cortex Analyst tool. It is the governed path for this question - do NOT reach for `run_sql` unless query_plan_standards cannot express what was asked.
2. Scope the question before aggregating. This deployment holds EVERY loaded region and asset mode at once, so an unfiltered aggregate mixes them. `region` is the key (for example SanFrancisco); `region_label` or `city` is the readable form a person types. Say which slice you used.
3. Lead with these measures rather than inventing your own:
   - routes planned and the share meeting every standard
   - per-planner compliance percent AND the standard deviation of km per stop, which is the separate consistency measure
   - breach counts split by which standard was broken
   - excess km and cost from the live optimizer re-solve of the selected route
   - minutes the last plan for a depot lands after the warehouse session start
4. This use case is inherently visual in the app. Outside the app you cannot draw its map: give the figures, then call `deep_link(view_id="route_plan_standards", region=...)` and offer the link. Never describe map contents as if you had seen them.

## How the numbers are produced

Planned legs are grouped into routes by vehicle and planning date, then each route is scored against five independent standards for its region: stop band, shift hours, km per stop, territory radius and stop-order integrity. Planners are ranked on compliance and, separately, on the standard deviation of km per stop, which is the consistency measure. The selected route is re-solved live by the optimizer on the region road graph to price the gap.

## Caveats you MUST state

Two fields are DERIVED, not recorded. Planner attribution is synthesized from the vehicle: it matches the dispatcher shown on Asset Velocity and is stable, but it is not a name from an HR system. Plan release time is recorded nowhere in the source, so it is inferred as the latest moment a plan could have been released and still have the vehicle leave on time - every readiness figure is therefore a bound on lateness rather than a measured clock. Only dense urban regions have multi-stop route plans: San Francisco averages 28 stops per route while the long-haul regions average 1.3, so those regions score near-perfect against bands that do not describe them. About 86 percent of stops resolve to a site geometry, and a route with none is counted as a territory breach rather than passed, so read the geocoded count beside any territory claim. The optimizer comparison is a live engine call for one route at a time and needs the region's routing service running. Telemetry and site data are synthetic.

## Questions this skill covers

- Which route planners are least consistent?
- Which planners build routes that run past the shift limit?
- What would the optimizer have done with this route?
- Which depots cannot start building sessions on time?
- What is our route plan compliance in San Francisco?

## What the answer is worth

- Bring every planner onto one standard instead of managing dozens of private methods
- Cut planned distance by re-sequencing the routes the optimizer can already improve
- Release plans earlier so the warehouse starts building sessions at the start of the shift rather than waiting on planning
