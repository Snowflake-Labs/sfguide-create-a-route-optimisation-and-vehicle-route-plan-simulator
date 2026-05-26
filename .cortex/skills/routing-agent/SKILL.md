---
name: routing-agent
description: "Deploy Snowflake Cortex Agent for routing (directions, isochrones, VRP). Creates TOOL_DIRECTIONS, TOOL_ISOCHRONES, TOOL_ROUTE_OPTIMIZATION procedures + Cortex Agent. Use when: setting up routing agent, agent playground, Snowflake Intelligence. Do NOT use for: fleet demos, route deviation, ORS infrastructure. Triggers: routing agent, agent playground, cortex agent, ORS agent."
depends_on:
  - build-routing-solution
metadata:
  author: Snowflake SIT-IS
  version: 1.0.0
  category: intelligence-agent
---

# Deploy Routing Agent

Creates a Cortex Agent with AI-geocoded routing tools (directions, isochrones, VRP optimization) backed by OpenRouteService.

## Prerequisites

- `build-routing-solution` deployed (all 5 services RUNNING)
- ROUTING_ANALYTICS warehouse available

## Workflow

### Step 1: Create Schema

```sql
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
CREATE DATABASE IF NOT EXISTS FLEET_INTELLIGENCE;
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.ROUTING_AGENT;
```

### Step 2: Deploy Procedures + Agent

Execute `references/deploy-agent.sql` — creates:
- **TOOL_DIRECTIONS** (SQL) — AI geocodes locations → ORS DIRECTIONS
- **TOOL_ISOCHRONES** (SQL) — AI geocodes center → ORS ISOCHRONES
- **TOOL_ROUTE_OPTIMIZATION** (JavaScript) — AI parses jobs/vehicles → VROOM solver

> **CRITICAL:** The `?::INT` cast on the ISOCHRONES range parameter is mandatory. Without it, the function signature won't match and isochrones will fail.

### Step 3: Agent Playground Config

```sql
CREATE FILE FORMAT IF NOT EXISTS OPENROUTESERVICE_APP.CORE.JSON_FORMAT
  TYPE = 'JSON' STRIP_OUTER_ARRAY = FALSE;

COPY FILES INTO @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/config/
FROM '<WORKSPACE_STAGE_URI>'
FILES=('agent-demos.json');
```

Verify: `SELECT $1 FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/config/agent-demos.json (FILE_FORMAT => 'OPENROUTESERVICE_APP.CORE.JSON_FORMAT');`

### Step 4: Verify

```sql
SHOW AGENTS IN SCHEMA FLEET_INTELLIGENCE.ROUTING_AGENT;
CALL FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ISOCHRONES('Union Square, San Francisco', 10, 'driving-car');
```

## Agent Spec Rules

> **These rules MUST be followed or the agent will fail:**
>
> 1. Tool `type` must be `generic` — NOT `custom_tool` (causes "Tool type custom_tool is not valid" error)
> 2. `tool_resources` must include `type: procedure` and `execution_environment` with `type: warehouse`
> 3. Procedure names: `TOOL_DIRECTIONS`, `TOOL_ISOCHRONES` (with S), `TOOL_ROUTE_OPTIMIZATION`
> 4. ISOCHRONES range parameter binding must use `?::INT` cast

## Required Privileges

| Privilege | Scope | Reason |
|-----------|-------|--------|
| CREATE SCHEMA | FLEET_INTELLIGENCE | ROUTING_AGENT schema |
| CREATE PROCEDURE | Schema | Tool procedures |
| CREATE AGENT | Schema | Cortex Agent |
| USAGE ON FUNCTIONS | OPENROUTESERVICE_APP.CORE | Routing functions |

## Cleanup

```sql
DROP AGENT IF EXISTS FLEET_INTELLIGENCE.ROUTING_AGENT.ROUTING_AGENT;
DROP PROCEDURE IF EXISTS FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ROUTE_OPTIMIZATION(VARCHAR, FLOAT, VARCHAR);
DROP PROCEDURE IF EXISTS FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ISOCHRONES(VARCHAR, NUMBER, VARCHAR);
DROP PROCEDURE IF EXISTS FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_DIRECTIONS(VARCHAR, VARCHAR);
DROP SCHEMA IF EXISTS FLEET_INTELLIGENCE.ROUTING_AGENT;
```
