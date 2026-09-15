---
name: emergency-response
description: 'Plan the evacuation of people who cannot evacuate themselves: hazard exposure, who is inside the risk zone, and a solved multi-depot van plan. Use for: If this hazard escalates, who do we collect first, with which vehicles, and how many trips does it actually take? Covers the Emergency Response use case of the Fleet Intelligence accelerator.'
---

# Emergency Response

**Business question.** If this hazard escalates, who do we collect first, with which vehicles, and how many trips does it actually take?

**Who asks it.** Emergency management director, Public health and care operations, Transport coordinator, Resilience planner

## How to answer

1. No semantic view models this use case: it is computed live in the app. Answer with whatever `run_sql` and the routing tools can retrieve, then hand over the app view with `deep_link` rather than describing a screen you cannot see.
2. Scope the question before aggregating. This deployment holds EVERY loaded region and asset mode at once, so an unfiltered aggregate mixes them. `region` is the key (for example SanFrancisco); `region_label` or `city` is the readable form a person types. Say which slice you used.
3. Lead with these measures rather than inventing your own:
   - evacuees and evacuated (assigned) counts
   - number of trips, completion time in minutes, and total/longest route distance in km (total_km, longest_trip_km)
   - per-risk-band participant counts for the active hazard (risk_bands) and the other hazard (other_hazard_bands), plus high_on_both_hazards
   - participant addresses grouped by risk band for the active hazard (addresses_by_band)
   - hazard zones (counties) with both wildfire and flood risk levels (hazard_zones) and per-county participant rollup (participants_by_county)
   - per-care-center workload (centers_workload) and van seat utilization (seat_utilization)
   - unassigned / overflow participants that could not be seated
4. This use case is inherently visual in the app. Outside the app you cannot draw its map: give the figures, then call `deep_link(view_id="emergency_response", region=...)` and offer the link. Never describe map contents as if you had seen them.

## How the numbers are produced

Hazard risk is a procedural H3 hex model (wildfire, flood and a composite), so it is granular and works worldwide without a licensed dataset. Participants are sampled inside the union of the care centers' live drive-time isochrones. The plan is a capacitated multi-depot vehicle routing problem where each van is expanded into up to the configured number of round trips, solved live over people at or above the selected risk band.

## Caveats you MUST state

The hazard model is procedural, not an official hazard map, and the participants are synthetic addresses - in production both would be replaced by the customer's authoritative sources. The plan is computed in this view and is not persisted, so re-seeding produces a different set. Solving requires the region routing and optimizer services to be running.

## Questions this skill covers

- how many evacuation trips are there, and what is the total distance in km?
- list the evacuation trips and their stops
- give me all trips and stops for a specific care center
- what are the addresses of the Very High risk participants?
- which counties are Very High wildfire risk?
- which county has the most at-risk participants?
- how many participants are high risk for both flood and wildfire?
- which care center is handling the most evacuees?
- what is on the map right now, and is any layer blank?

## What the answer is worth

- Know before the event whether the fleet on hand can actually clear the at-risk population
- Turn an evacuation annex from a document into an executable, testable plan
- Quantify the resourcing gap in vehicles and trips, not in adjectives
