// Fully-qualified names of the existing routing procedures the User verbs wrap.
// Source of truth for these is the deployed ROUTING_AGENT schema; renaming is a
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
  directions: 'FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_DIRECTIONS',
  isochrone: 'FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ISOCHRONE',
  optimization: 'FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ROUTE_OPTIMIZATION',
  poiInIsochrone: 'FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_POI_IN_ISOCHRONE',
  pharmaCatchment: 'FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_PHARMA_CATCHMENT',
  pharmaOptimization: 'FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_PHARMA_OPTIMIZATION',
  supplyChain: 'FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_SUPPLY_CHAIN',
} as const;
