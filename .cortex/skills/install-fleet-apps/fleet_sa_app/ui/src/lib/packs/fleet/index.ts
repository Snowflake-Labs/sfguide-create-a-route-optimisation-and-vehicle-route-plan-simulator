import { lazy } from 'react';
import { viewRegistry } from '@/lib/view-registry';

// Fleet domain pack: registers the Tier-3 showcase views (custom full-page
// components, not YAML area-views). They call User routing verbs via /api/tool
// and render results on a deck.gl map.
//
// This pack is vehicle/industry-AGNOSTIC: the routing/ops showcases
// (vrp_simulator, emergency_wizard, ops_console) are tool-driven and always
// register. Backload Matching is a neutral, DHL-free showcase gated by its
// pack probe (FLEET_APP.BACKLOAD_MATCHING.VW_TRAILERS). The remaining
// industry-vertical showcases (freight exchange, DHL NTBO) stay excluded.
//
// This module is the fleet entry in lib/packs/registry.ts. The app-shell loads
// it generically via the configured `domainPacks` array - there is no fleet
// import in the shell itself (Step 4C).
export function registerViews(_disabledSchemas?: Set<string>): void {
  viewRegistry.register({
    id: 'vrp_simulator',
    label: 'Route Optimization Simulator',
    description: 'Plan multi-stop vehicle routes from a depot and view them on the map.',
    category: 'Optimization',
    component: lazy(() =>
      import('@/components/views/areas/vrp-simulator').then((mod) => ({
        default: mod.VrpSimulatorView,
      })),
    ),
  });

  viewRegistry.register({
    id: 'emergency_response',
    label: 'Emergency Response',
    description: 'Plan a capacitated multi-depot evacuation for the active region: hazard-zone risk, isochrone-seeded participants, and a solved van routing plan. Available when the region has generated hazard + health-anchor data.',
    category: 'Optimization',
    agentKnowledge: {
      keyMetrics: [
        'evacuees and evacuated (assigned) counts',
        'number of trips, completion time in minutes, and total/longest route distance in km (total_km, longest_trip_km)',
        'per-risk-band participant counts for the active hazard (risk_bands) and the other hazard (other_hazard_bands), plus high_on_both_hazards',
        'participant addresses grouped by risk band for the active hazard (addresses_by_band)',
        'hazard zones (counties) with both wildfire and flood risk levels (hazard_zones) and per-county participant rollup (participants_by_county)',
        'per-care-center workload (centers_workload) and van seat utilization (seat_utilization)',
        'unassigned / overflow participants that could not be seated',
      ],
      exampleQuestions: [
        'how many evacuation trips are there, and what is the total distance in km?',
        'list the evacuation trips and their stops',
        'give me all trips and stops for a specific care center',
        'what are the addresses of the Very High risk participants?',
        'which counties are Very High wildfire risk?',
        'which county has the most at-risk participants?',
        'how many participants are high risk for both flood and wildfire?',
        'which care center is handling the most evacuees?',
        'what is on the map right now, and is any layer blank?',
      ],
      gotchas: 'The evacuation plan is computed client-side in this view and lives in the panel context. Trip roster: trips_detail is GROUPED BY CARE CENTER, centers ordered busiest-first (matching centers_workload); each center block reads "Center (N evacuees, N trips, N vans): T<n> Vehicle <n> <mins>m [load/capacity]: <stop addresses> [bN]..." so per-center "all trips and stops for X" questions are answerable directly. Risk<->address join: addresses_by_band lists participant addresses grouped by risk band for the active hazard, and each trip stop carries a "[bN]" risk-band marker matching the risk_bands legend (b5 = Very High). Area risk: hazard_zones lists each county with BOTH wildfire and flood band levels (WF bN/FL bN), and participants_by_county rolls up seeded vs at/above-threshold counts per county. Cross-hazard: risk_bands is the ACTIVE hazard, other_hazard_bands is the other one, and high_on_both_hazards counts people at/above threshold for both. Plan rollups: centers_workload (per depot), seat_utilization, total_km/longest_trip_km (null if the router did not return distance). If a center block or the trip list ends with "(+N more)", those trips/centers exceeded the display cap - the full breakdown is in the on-screen plan panel and the map routes layer; do not invent the remainder. There is no SQL or verb tool that returns the specific on-screen solved set (evac_seed re-samples a new random set), so answer from the panel context and never invent stops, addresses, counts, risk bands, or distances. Re-seeding or changing the risk threshold or hazard updates the numbers.',
    },
    component: lazy(() =>
      import('@/components/views/areas/emergency-response').then((mod) => ({
        default: mod.EmergencyResponseView,
      })),
    ),
  });

  // Backload Matching: neutral (DHL-free) backhaul optimizer. Loads idle trailers
  // + internal loads + external offers from the FLEET_APP.BACKLOAD_MATCHING pack,
  // builds a VROOM challenge, and solves via /api/backload/solve (contract seam).
  viewRegistry.register({
    id: 'backload_matching',
    label: 'Backload Matching',
    description: 'Fill empty return legs by matching idle vehicles to waiting internal loads and external freight offers, internal-first, and view the proposed backhaul tours on the map.',
    category: 'Optimization',
    component: lazy(() =>
      import('@/components/views/areas/backload-matching').then((mod) => ({
        default: mod.BackloadMatchingView,
      })),
    ),
  });

  // Ops console: operator-only platform control (service lifecycle, region, health).
  // Reaches the OPS synapse verbs via /api/ops; data-layer access is gated by the
  // app role (FLEET_APP_OPS) in production (Phase 3E).
  viewRegistry.register({
    id: 'ops_console',
    label: 'Ops Console',
    description: 'Operator controls: suspend/resume services, set the active region, and check platform health.',
    category: 'Admin',
    tags: ['ops', 'admin'],
    roles: ['ops'],
    component: lazy(() =>
      import('@/components/views/areas/ops-console').then((mod) => ({
        default: mod.OpsConsoleView,
      })),
    ),
  });
}
