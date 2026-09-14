---
name: plan-vs-actual-performance
description: 'Which Trips left the plan, where they left it, and how much extra distance that cost. Use for: How closely does execution match the plan we priced, and where is the margin leaking? Covers the Plan-vs-Actual Performance use case of the Fleet Intelligence accelerator.'
---

# Plan-vs-Actual Performance

**Business question.** How closely does execution match the plan we priced, and where is the margin leaking?

**Who asks it.** Transport planner, Operations manager, Cost controller, Customer service lead

## How to answer

1. Use the `query_route_deviation` Cortex Analyst tool. It is the governed path for this question - do NOT reach for `run_sql` unless query_route_deviation cannot express what was asked.
2. Scope the question before aggregating. This deployment holds EVERY loaded region and asset mode at once, so an unfiltered aggregate mixes them. `region` is the key (for example SanFrancisco); `region_label` or `city` is the readable form a person types. Say which slice you used.
3. Lead with these measures rather than inventing your own:
   - deviation rate
   - deviated Trips
   - excess distance vs plan
4. This use case is inherently visual in the app. Outside the app you cannot draw its map: give the figures, then call `deep_link(view_id="plan_vs_actual_performance", region=...)` and offer the link. Never describe map contents as if you had seen them.

## How the numbers are produced

Deviation compares the actual path against the planned route for the same Trip. A Trip with no planned route is excluded rather than counted as zero deviation, so the rate is measured over plannable work only.

## Caveats you MUST state

Synthetic plans and telemetry. A legitimate diversion (roadworks, a customer request) looks identical to an unnecessary one: the view finds the candidates, the operator supplies the reason.

## Questions this skill covers

- Which Trips deviated most from plan?
- How much excess distance did deviations add?

## What the answer is worth

- Recover margin lost to unplanned kilometres
- Separate bad planning from bad execution before blaming either
- Improve the plan using evidence of what crews actually do
