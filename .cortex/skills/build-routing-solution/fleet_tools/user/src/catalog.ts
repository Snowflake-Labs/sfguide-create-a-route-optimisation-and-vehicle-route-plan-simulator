// Fully-qualified names of the existing routing procedures the User verbs wrap.
// Source of truth for these is the deployed ROUTING_AGENT schema; renaming is a
// one-line change here.
export const Procs = {
  directions: 'FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_DIRECTIONS',
  isochrone: 'FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ISOCHRONE',
  optimization: 'FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ROUTE_OPTIMIZATION',
  poiInIsochrone: 'FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_POI_IN_ISOCHRONE',
  pharmaCatchment: 'FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_PHARMA_CATCHMENT',
} as const;
