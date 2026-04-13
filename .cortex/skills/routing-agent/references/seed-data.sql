/*
 * seed-data.sql — Routing Agent
 * No data tables to load. Creates the 3 tool procedures + Cortex Agent.
 * These are DDL-only objects, not data.
 * Refer to agent-definitions.md for the complete procedure SQL.
 */

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE DATABASE IF NOT EXISTS FLEET_INTELLIGENCE
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.ROUTING_AGENT
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- The routing agent has no seed data.
-- Tool procedures (TOOL_DIRECTIONS, TOOL_ISOCHRONE, TOOL_OPTIMIZATION)
-- and the ROUTING_AGENT Cortex Agent are created via the DDL
-- in references/agent-definitions.md.
--
-- Run that DDL directly after ensuring ORS is running.

SELECT 'routing-agent: no seed data needed, DDL only' AS STATUS;
