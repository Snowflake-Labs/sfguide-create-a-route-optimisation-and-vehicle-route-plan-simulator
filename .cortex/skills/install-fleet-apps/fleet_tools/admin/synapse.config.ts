import { defineSynapseApp } from '@snowflake/synapse/config';

// Admin tool bundle: operator verbs for managing the active routing context and
// verifying the routing substrate. roles: ['admin'] -> this app materializes its
// OWN MCP server (FLEET_ADMIN_MCP), which is bound to the admin role and is NOT
// attached to the consumer Cortex Agent.
export default defineSynapseApp({
  name: 'fleet-admin-tools',
  audit: { table: 'verb_attempt' },
});
