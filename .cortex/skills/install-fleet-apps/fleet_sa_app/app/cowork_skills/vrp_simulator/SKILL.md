---
name: vrp-simulator
description: Turn a depot and a pile of stops into a solved, drivable multi-vehicle route plan in one click. Use for: What is the cheapest set of routes that covers all of today's stops with the vehicles we actually have? Covers the Route Optimization Simulator use case of the Fleet Intelligence accelerator.
---

# Route Optimization Simulator

**Business question.** What is the cheapest set of routes that covers all of today's stops with the vehicles we actually have?

**Who asks it.** Transport planner, Dispatcher, Operations manager, Supply chain lead

## How to answer

1. No semantic view models this use case: it is computed live in the app. Answer with whatever `run_sql` and the routing tools can retrieve, then hand over the app view with `deep_link` rather than describing a screen you cannot see.
2. Scope the question before aggregating. This deployment holds EVERY loaded region and asset mode at once, so an unfiltered aggregate mixes them. `region` is the key (for example SanFrancisco); `region_label` or `city` is the readable form a person types. Say which slice you used.
3. Lead with these measures rather than inventing your own:
   - number of solved routes returned by the optimizer, one per assigned vehicle
   - the depot, vehicle count and stop count the user set before solving
   - per-route distance and duration as returned by the routing engine
   - stops the solver could not assign
4. This use case is inherently visual in the app. Outside the app you cannot draw its map: give the figures, then call `deep_link(view_id="vrp_simulator", region=...)` and offer the link. Never describe map contents as if you had seen them.

## How the numbers are produced

Stops and vehicles are assembled into a routing problem and solved live by the optimizer against the region road graph. Distances and the drawn geometry come from the routing engine, not from straight lines.

## Caveats you MUST state

A demonstration of the solver rather than a production planning system: it does not model time windows negotiated with customers, driver hours rules, or multi-day horizons. All stops must sit inside one provisioned routing region.

## Questions this skill covers

- how many routes did the optimizer produce?
- plan routes for 4 vehicles from the depot
- why were some stops left unassigned?
- what is the total distance of the solved plan?

## What the answer is worth

- Cut planned distance and vehicle count against a manually built plan
- Replan in seconds when the order book changes
- Keep planning next to the data instead of exporting to a separate optimizer
