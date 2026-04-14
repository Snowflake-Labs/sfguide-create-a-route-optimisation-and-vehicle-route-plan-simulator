---
name: routing-agent
description: "Create Snowflake Intelligence agent for OpenRouteService routing functions. Use when: setting up ORS demo, creating route planning agent, integrating directions/isochrones/optimization with Cortex. Do NOT use for: deploying fleet intelligence demos, route deviation analysis, or changing ORS configuration. Triggers: openrouteservice demo, routing agent, ORS agent, routing intelligence."
depends_on:
  - build-routing-solution
metadata:
  author: Snowflake SIT-IS
  version: 1.0.0
  category: intelligence-agent
---

# OpenRouteService Intelligence Demo

Create a Snowflake Intelligence agent that provides AI-powered route planning using OpenRouteService functions with natural language geocoding.

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `DATABASE` | `FLEET_INTELLIGENCE` | Target database for all objects |
| `SCHEMA` | `ROUTING_AGENT` | Schema for agent procedures and agent definition |
| `WAREHOUSE` | `ROUTING_ANALYTICS` | Warehouse for geocoding and routing queries |
| `AGENT_NAME` | `ROUTING_AGENT` | Name of the Cortex Agent to create |

## Prerequisites

- OpenRouteService Native App installed with functions: `DIRECTIONS`, `ISOCHRONES`, `OPTIMIZATION`
- Cortex AI access (claude-sonnet-4-5 for geocoding)
- A role with privileges listed in the Required Privileges section below

## Required Privileges

| Privilege | Scope | Reason |
|-----------|-------|--------|
| CREATE DATABASE | Account | Creates FLEET_INTELLIGENCE database |
| CREATE WAREHOUSE | Account | Creates ROUTING_ANALYTICS warehouse |
| USAGE ON DATABASE FLEET_INTELLIGENCE | Database | Uses the setup database |
| CREATE SCHEMA | Database (FLEET_INTELLIGENCE) | Creates ROUTING_AGENT schema |
| CREATE PROCEDURE | Schema (FLEET_INTELLIGENCE.ROUTING_AGENT) | Creates TOOL_DIRECTIONS, TOOL_ISOCHRONE, TOOL_OPTIMIZATION |
| CREATE CORTEX AGENT | Schema (FLEET_INTELLIGENCE.ROUTING_AGENT) | Creates ROUTING_AGENT |
| USAGE ON DATABASE OPENROUTESERVICE_APP | Database | Calls ORS DIRECTIONS, ISOCHRONES, OPTIMIZATION functions |
| SNOWFLAKE.CORTEX_USER | Database role | Enables AI_COMPLETE calls for geocoding |

> **Note:** ACCOUNTADMIN is NOT required. Create a custom role with the above privileges, or use any role that has them.

## Error Logging

> Follow the Error Logging convention in AGENTS.md. Log file prefix: `routing-agent`.

## Execution Rules

1. One statement per `snowflake_sql_execute` tool call.
2. Always use fully qualified object names.
3. Never use `SET` session variables.
4. Verify row counts after each CTAS.
5. All CREATE statements must include a COMMENT tracking tag.

## Quick Start

No seed data or pre-computed tables required. The routing agent consists of stored procedures and a Cortex Agent definition. Run `snow sql -f .cortex/skills/routing-agent/references/deploy-agent.sql -c <connection>` to create all objects.

## Workflow

> All stored procedure and agent SQL definitions are in [references/agent-definitions.md](references/agent-definitions.md).

### Step 1: Set Query Tag for Tracking

Set session query tag for attribution tracking.

```sql
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1, "minor":0},"attributes":{"is_quickstart":1, "source":"sql"}}';
```

### Step 2: Verify ORS Functions and Services

**2a. Check functions exist:**

```sql
SHOW USER FUNCTIONS IN SCHEMA OPENROUTESERVICE_APP.CORE;
```

Verify: `DIRECTIONS(VARCHAR, VARIANT)`, `ISOCHRONES(VARCHAR, FLOAT, FLOAT, NUMBER)`, `OPTIMIZATION(VARIANT, VARIANT)`. If missing, install the OpenRouteService Native App.

**2b. Check services are running (CRITICAL):**

```sql
SHOW SERVICES IN SCHEMA OPENROUTESERVICE_APP.CORE;
```

Required services (all must be RUNNING): `ORS_SERVICE`, `VROOM_SERVICE`, `ROUTING_GATEWAY_SERVICE`, `DOWNLOADER`. If any is SUSPENDED, resume with `CALL OPENROUTESERVICE_APP.CORE.RESUME_ALL_SERVICES();` and verify with `SELECT OPENROUTESERVICE_APP.CORE.CHECK_HEALTH();`.

### Step 3: Create Database, Schema, and Warehouse

Create dedicated objects for the routing agent.

```sql
CREATE DATABASE IF NOT EXISTS FLEET_INTELLIGENCE
    COMMENT = '{"origin":"sf_sit-is-fleet", "name":"oss-deploy-snowflake-intelligence-routing-agent", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.ROUTING_AGENT
    COMMENT = '{"origin":"sf_sit-is-fleet", "name":"oss-deploy-snowflake-intelligence-routing-agent", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';
CREATE WAREHOUSE IF NOT EXISTS ROUTING_ANALYTICS
    WAREHOUSE_SIZE = 'XSMALL' AUTO_SUSPEND = 60 AUTO_RESUME = TRUE
    COMMENT = '{"origin":"sf_sit-is-fleet", "name":"oss-deploy-snowflake-intelligence-routing-agent", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';
```

### Step 4: Deploy All Procedures and Agent

**Goal:** Create all 3 tool procedures (TOOL_DIRECTIONS, TOOL_ISOCHRONE, TOOL_OPTIMIZATION) and the Cortex Agent in a single step.

```bash
snow sql -f .cortex/skills/routing-agent/references/deploy-agent.sql -c <connection>
```

This creates:
- **TOOL_DIRECTIONS**: Wraps ORS DIRECTIONS with AI geocoding (claude-sonnet-4-5) for natural language location input
- **TOOL_ISOCHRONE**: Wraps ORS ISOCHRONES with AI geocoding for reachability analysis
- **TOOL_OPTIMIZATION**: Python procedure wrapping ORS OPTIMIZATION for multi-stop delivery routing
- **ROUTING_AGENT**: Cortex Agent with tool bindings to all 3 procedures

> **Reference:** For annotated explanations of each procedure, see [references/agent-definitions.md](references/agent-definitions.md).

### Step 5: Register Agent with Snowflake Intelligence (Optional)

> **Note:** This step requires Snowflake Intelligence to be configured on the account. The agent is fully functional via direct `INVOKE_AGENT` calls without SI registration.

1. **Check** if Snowflake Intelligence is available:
   ```sql
   SHOW SNOWFLAKE INTELLIGENCE;
   ```
   If this returns an error or no results, skip the rest of this step.

2. **Register** the agent:
   ```sql
   ALTER SNOWFLAKE INTELLIGENCE SNOWFLAKE_INTELLIGENCE_OBJECT_DEFAULT 
   ADD AGENT FLEET_INTELLIGENCE.ROUTING_AGENT.ROUTING_AGENT;
   ```

### Step 6: Test the Agent

Test queries must use locations within the ORS-configured region. To determine the region:

```sql
DESCRIBE SERVICE OPENROUTESERVICE_APP.CORE.ORS_SERVICE;
```

Parse the spec to find the configured region name from `/home/ors/files/<REGION_NAME>.osm.pbf`.

Before testing, verify all services are RUNNING (see Step 2b).

**Sample queries by region:**

| Region | Directions | Isochrone | Optimization |
|--------|-----------|-----------|--------------|
| San Francisco | "Driving directions from Union Square to Fisherman's Wharf" | "Areas reachable within 15 min by car from Union Square" | "Optimize deliveries to Ferry Building, Pier 39, Ghirardelli Square — 2 vehicles from Union Square" |
| New York | "Driving directions from Times Square to Central Park" | "Areas reachable within 15 min by car from Grand Central" | "Optimize deliveries to Empire State, Rockefeller Center, Times Square — 2 vehicles from Grand Central" |
| London | "Driving directions from Tower Bridge to Buckingham Palace" | "Areas reachable within 15 min by car from King's Cross" | "Optimize deliveries to British Museum, Tower of London, Westminster Abbey — 2 vehicles from Trafalgar Square" |
| Berlin | "Driving directions from Brandenburg Gate to Alexanderplatz" | "Areas reachable within 15 min by car from Hauptbahnhof" | "Optimize deliveries to Reichstag, Checkpoint Charlie, East Side Gallery — 2 vehicles from Alexanderplatz" |

Use central city locations as depots.

### Step 7: Open Snowflake Intelligence UI

Get org/account names, then open the UI:

```sql
SELECT CURRENT_ORGANIZATION_NAME() AS org_name, CURRENT_ACCOUNT_NAME() AS account_name;
```

Open: `https://ai.snowflake.com/<org_name>/<account_name>/#/ai`


## Examples

### Example 1: Deploy routing agent for San Francisco
User says: "Create a routing agent"
Actions:
1. Verify ORS functions and services (Step 2)
2. Create database/schema (Step 3)
3. Create TOOL_DIRECTIONS, TOOL_ISOCHRONE, TOOL_OPTIMIZATION procedures (Steps 4-6)
4. Create Cortex Agent (Step 7)
5. Test with: "Driving directions from Union Square to Fisherman's Wharf"
Result: Routing agent accessible via Snowflake Intelligence UI

### Example 2: Test agent with different region
User says: "Test the routing agent with London locations"
Actions:
1. Verify ORS is configured for London (`DESCRIBE SERVICE` check)
2. Test: "Driving directions from Tower Bridge to Buckingham Palace"
3. Test: "Areas reachable within 15 min by car from King's Cross"
Result: Agent returns London-specific routing results (no redeployment needed -- agent is region-agnostic)

## Stopping Points

- **Step 2**: Verify ORS functions exist before proceeding
- **Step 3**: Verify database, schema, and warehouse exist
- **Step 4**: Verify deploy-agent.sql completes without errors
- **Step 6**: Confirm all 3 tools work correctly

## Output

- 1 database: `FLEET_INTELLIGENCE`
- 1 schema: `FLEET_INTELLIGENCE.ROUTING_AGENT`
- 1 warehouse: `ROUTING_ANALYTICS`
- 3 stored procedures with AI geocoding and error handling
- 1 Cortex Agent registered in Snowflake Intelligence
- Agent accessible via Snowsight UI and REST API

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Agent not visible in UI | Run `ALTER SNOWFLAKE INTELLIGENCE ... ADD AGENT` |
| Geocoding fails | Check Cortex AI access and model availability |
| Empty directions | Verify ORS map data covers the requested region |
| Routing functions fail | Check service status with `SHOW SERVICES IN SCHEMA OPENROUTESERVICE_APP.CORE;` and resume suspended services |

## Cleanup

To remove all objects created by this skill:

```sql
-- Reverse dependency order: agent first, then procedures, schema, warehouse, database
DROP CORTEX AGENT IF EXISTS FLEET_INTELLIGENCE.ROUTING_AGENT.ROUTING_AGENT;
DROP PROCEDURE IF EXISTS FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_OPTIMIZATION(VARCHAR, VARCHAR, NUMBER);
DROP PROCEDURE IF EXISTS FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ISOCHRONE(VARCHAR, NUMBER);
DROP PROCEDURE IF EXISTS FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_DIRECTIONS(VARCHAR, VARCHAR);
DROP SCHEMA IF EXISTS FLEET_INTELLIGENCE.ROUTING_AGENT;
DROP WAREHOUSE IF EXISTS ROUTING_ANALYTICS;
```

> **Tip:** Use the `cleanup` skill to auto-discover all tagged objects via COMMENT tracking.
