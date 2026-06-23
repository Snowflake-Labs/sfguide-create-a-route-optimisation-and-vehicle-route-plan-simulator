import { defineSynapseApp } from '@snowflake/synapse/config';

// Routing tool bundle: the consumer-facing routing/optimization verbs — the
// public API of the standalone Routing Platform (Step 4B). Each verb is a thin,
// audited wrapper over the existing ROUTING_AGENT.TOOL_* procedures (decision:
// wrap, do not reimplement). roles: ['user'] on every proc -> this app
// materializes its OWN MCP server (ROUTING_MCP, in OPENROUTESERVICE_APP.ROUTING),
// which is the server attached to the consumer Cortex Agent.
export default defineSynapseApp({
  name: 'routing-tools',
  audit: { table: 'verb_attempt' },
});
