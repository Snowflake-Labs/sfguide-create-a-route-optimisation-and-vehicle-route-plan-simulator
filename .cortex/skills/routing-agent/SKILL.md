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

- **Database:** `FLEET_INTELLIGENCE`
- **Schema:** `ROUTING_AGENT`
- **Warehouse:** `ROUTING_ANALYTICS`
- **Agent Name:** `ROUTING_AGENT`

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
| USAGE ON DATABASE OPENROUTESERVICE_NATIVE_APP | Database | Calls ORS DIRECTIONS, ISOCHRONES, OPTIMIZATION functions |
| SNOWFLAKE.CORTEX_USER | Database role | Enables AI_COMPLETE calls for geocoding |

> **Note:** ACCOUNTADMIN is NOT required. Create a custom role with the above privileges, or use any role that has them.

## Error Logging

When any step fails or produces unexpected results (SQL errors, missing objects, wrong row counts, service failures, deployment issues), log the issue to `logs/` following the format in `logs/README.md`. Create one log file per execution: `routing-agent_{YYYY-MM-DD}_{HH-MM}.md`. Continue execution where possible, logging all issues encountered. If execution completes with no issues, do not create a log file.

## Step 0: Load San Francisco Baseline (Recommended)

No seed data needed. The routing agent consists of stored procedures and a Cortex Agent definition — there are no pre-computed data tables to load.

### Load from S3

The routing agent has no seed data — it consists of stored procedures and a Cortex Agent definition. Run the DDL from `references/agent-definitions.md` to create all objects.

### Generate data for other regions (optional)

To generate data for a region other than San Francisco, use the full pipeline starting at Step 2.

Or use the centralized provisioner:
```sql
CALL FLEET_INTELLIGENCE.CORE.PROVISION_REGION('<RegionName>', ARRAY_CONSTRUCT('routing-agent'));
```

## Workflow

> All stored procedure and agent SQL definitions are in [references/agent-definitions.md](references/agent-definitions.md).

### Step 1: Set Query Tag for Tracking (Optional)

Set session query tag for attribution tracking. This step is optional and only affects session-level tracking.

```sql
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1, "minor":0},"attributes":{"is_quickstart":1, "source":"sql"}}';
```

### Step 2: Verify ORS Functions and Services

**2a. Check functions exist:**

```sql
SHOW USER FUNCTIONS IN SCHEMA OPENROUTESERVICE_NATIVE_APP.CORE;
```

Verify: `DIRECTIONS(VARCHAR, VARIANT)`, `ISOCHRONES(VARCHAR, FLOAT, FLOAT, NUMBER)`, `OPTIMIZATION(VARIANT, VARIANT)`. If missing, install the OpenRouteService Native App.

**2b. Check services are running (CRITICAL):**

```sql
SHOW SERVICES IN SCHEMA OPENROUTESERVICE_NATIVE_APP.CORE;
```

Required services (all must be RUNNING): `ORS_SERVICE`, `VROOM_SERVICE`, `ROUTING_GATEWAY_SERVICE`. If any is SUSPENDED, resume with `CALL OPENROUTESERVICE_NATIVE_APP.CORE.RESUME_ALL_SERVICES();` and verify with `SELECT OPENROUTESERVICE_NATIVE_APP.CORE.CHECK_HEALTH();`.

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

### Step 4: Create TOOL_DIRECTIONS Procedure

Wraps ORS DIRECTIONS with AI geocoding (claude-sonnet-4-5) so users can describe locations in natural language. Returns distance_km, duration_mins, segments, and geometry on success; structured error on failure.

```sql
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_DIRECTIONS(...)
-- Full definition: see references/agent-definitions.md
```

> **Full SQL:** [references/agent-definitions.md § TOOL_DIRECTIONS](references/agent-definitions.md#tool_directions-procedure)

### Step 5: Create TOOL_ISOCHRONE Procedure

Wraps ORS ISOCHRONES with AI geocoding. Accepts a location description and range in minutes; returns area_km2 and geometry polygon on success.

```sql
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ISOCHRONE(...)
-- Full definition: see references/agent-definitions.md
```

> **Full SQL:** [references/agent-definitions.md § TOOL_ISOCHRONE](references/agent-definitions.md#tool_isochrone-procedure)

### Step 6: Create TOOL_OPTIMIZATION Procedure

Python procedure wrapping ORS OPTIMIZATION. Geocodes delivery locations and depot, builds VROOM-compatible jobs/vehicles arrays, and returns optimized routes with unassigned-job detection.

```sql
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_OPTIMIZATION(...)
-- Full definition: see references/agent-definitions.md
```

> **Full SQL:** [references/agent-definitions.md § TOOL_OPTIMIZATION](references/agent-definitions.md#tool_optimization-procedure)

### Step 7: Create the Agent

Create a Cortex Agent (`ROUTING_AGENT`) with three tool bindings pointing to the procedures above.

```sql
CREATE OR REPLACE AGENT FLEET_INTELLIGENCE.ROUTING_AGENT.ROUTING_AGENT
-- Full definition: see references/agent-definitions.md
```

> **Full SQL:** [references/agent-definitions.md § CREATE AGENT](references/agent-definitions.md#create-agent-specification)

### Step 8: Register Agent with Snowflake Intelligence

```sql
ALTER SNOWFLAKE INTELLIGENCE SNOWFLAKE_INTELLIGENCE_OBJECT_DEFAULT 
ADD AGENT FLEET_INTELLIGENCE.ROUTING_AGENT.ROUTING_AGENT;
```

### Step 9: Test the Agent

Test queries must use locations within the ORS-configured region. To determine the region:

```sql
DESCRIBE SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SERVICE;
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

### Step 10: Open Snowflake Intelligence UI

Get org/account names, then open the UI:

```sql
SELECT CURRENT_ORGANIZATION_NAME() AS org_name, CURRENT_ACCOUNT_NAME() AS account_name;
```

Open: `https://ai.snowflake.com/<org_name>/<account_name>/#/ai`

### Step 11: Register with Demo Dashboard

If the shared Demo Dashboard app is installed, register this demo:

```sql
CALL DEMO_DASHBOARD_APP.CORE.REGISTER_DEMO('routing-agent', 'Routing Agent', 'AI-powered routing assistant', 'Routing Agent', 'Bot', 190);
```

Skip if DEMO_DASHBOARD_APP is not installed.

## Stopping Points

- **Step 2**: Verify ORS functions exist before proceeding
- **Step 3**: Verify database, schema, and warehouse exist
- **Step 7**: Review agent spec before creation
- **Step 9**: Confirm all 3 tools work correctly

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
| Routing functions fail | Check service status with `SHOW SERVICES IN SCHEMA OPENROUTESERVICE_NATIVE_APP.CORE;` and resume suspended services |

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
