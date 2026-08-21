// Fully-qualified names of the existing routing procedures the User verbs wrap.
// Source of truth for these is the deployed ROUTING_TOOLS schema; renaming is a
// one-line change here.
//
// Engine-agnostic (Step 4B.2): these TOOL_* procs keep their AI-geocoding /
// result-shaping orchestration, but their underlying routing calls now go through
// ROUTING_PLATFORM.CONTRACT.* (DIRECTIONS / ISOCHRONES / ISOCHRONES_CLIPPED /
// OPTIMIZATION), which dispatches to a routing provider (ors_internal today;
// external engines via EXTERNAL ACCESS INTEGRATION in future) per the
// region->provider default + optional per-call provider override. The verbs
// therefore route engine-agnostically without naming any engine.
export const Procs = {
  directions: 'FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_DIRECTIONS',
  snap: 'FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_SNAP',
  isochrone: 'FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_ISOCHRONE',
  optimization: 'FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_ROUTE_OPTIMIZATION',
  poiInIsochrone: 'FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_POI_IN_ISOCHRONE',
  overtureSearch: 'FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_OVERTURE_SEARCH',
  overtureAddresses: 'FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_OVERTURE_ADDRESSES',
  catchment: 'FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_CATCHMENT',
  deliveryOptimization: 'FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_DELIVERY_OPTIMIZATION',
  networkOptimization: 'FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_NETWORK_OPTIMIZATION',
  evacSeed: 'FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_EVAC_SEED',
  evacSolve: 'FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_EVAC_SOLVE',
  vrpSolve: 'FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_VRP_SOLVE',
  introspectSap: 'FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_SAP_INTROSPECT',
} as const;
