import { defineSynapseApp } from '@snowflake/synapse/config';

// User tool bundle: the consumer-facing routing/optimization verbs.
// Each verb is a thin, audited wrapper over the existing ROUTING_AGENT.TOOL_*
// procedures (decision: wrap, do not reimplement). roles: ['user'] on every
// proc -> this app materializes its OWN MCP server (FLEET_USER_MCP), which is
// the ONLY server attached to the consumer Cortex Agent.
export default defineSynapseApp({
  name: 'fleet-user-tools',
  audit: { table: 'verb_attempt' },
});
