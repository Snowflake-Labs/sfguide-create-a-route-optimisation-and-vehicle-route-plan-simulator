import { defineSynapseApp } from '@snowflake/synapse/config';

// Ops tool bundle: role-gated operator verbs for service lifecycle, the active
// routing region, and substrate health. roles: ['ops'] -> this app materializes
// its OWN MCP server (FLEET_OPS_MCP), bound to the ops role and attached to the
// separate FLEET_OPS_AGENT. It is NOT attached to the consumer Cortex Agent, so
// an end-user agent session can never see or invoke an Ops verb (role isolation).
export default defineSynapseApp({
  name: 'fleet-ops-tools',
  audit: { table: 'verb_attempt' },
});
