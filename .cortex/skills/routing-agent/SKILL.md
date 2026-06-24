---
name: routing-agent
description: "Deploy the routing TOOL_* procedures (AI-geocoded directions, isochrones, POI-in-isochrone, optimization, catchment, delivery/network demos) into FLEET_INTELLIGENCE.ROUTING_TOOLS. These are wrapped by the synapse ROUTING_MCP verbs that the app-level FLEET_AGENT attaches — there is no separate standalone routing agent. Use when: setting up the ORS routing tool substrate the fleet app depends on, integrating directions/isochrones/optimization with Cortex. Do NOT use for: deploying fleet intelligence demos, route deviation analysis, or changing ORS configuration. Triggers: openrouteservice demo, routing tools, ORS tool procedures, routing substrate."
depends_on:
  - install-fleet-apps
metadata:
  author: Snowflake SIT-IS
  version: 1.2.0
  category: intelligence-agent
---

# OpenRouteService Routing Tool Substrate

Deploy the AI-geocoded routing procedures into `FLEET_INTELLIGENCE.ROUTING_TOOLS`. These `TOOL_*` procedures are the implementation layer wrapped by the synapse `ROUTING_MCP` verbs that the app-level **FLEET_AGENT** attaches. The previous standalone `ROUTING_AGENT` Cortex Agent has been **retired** — `FLEET_AGENT` (created by `install-fleet-apps`) is now the single routing + analytics agent, so this skill only deploys the procedures, not an agent.

The procedures provide seven LLM-facing capabilities:

- `tool_directions` — multi-region driving / cycling / walking directions.
- `tool_isochrone` — multi-region reachability polygons.
- `tool_poi_in_isochrone` — Overture Maps POI search inside an isochrone.
- `tool_optimization` — multi-region multi-vehicle VRP via VROOM.
- `tool_network_optimization` — full distribution-network plan (depot + key sites + 3 skill-tier vehicles).
- `tool_delivery_optimization` — 30 pre-geocoded stops with skill-bound vehicles.
- `tool_catchment` — drive-time catchment / area profile for a site.

The first four are functional immediately after this skill runs. The three demo
tools require seed data deployed by [`setup-agent-playground`](../setup-agent-playground/SKILL.md);
they fail gracefully with a "run setup-agent-playground" message if the data is missing.

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `DATABASE` | `FLEET_INTELLIGENCE` | Target database for all objects |
| `SCHEMA` | `ROUTING_TOOLS` | Schema for the routing TOOL_* procedures |
| `WAREHOUSE` | `ROUTING_ANALYTICS` | Warehouse for geocoding and routing queries |

## Prerequisites

- OpenRouteService Native App installed with functions: `DIRECTIONS`, `ISOCHRONES`, `ISOCHRONES_CLIPPED`, `OPTIMIZATION`
- Cortex AI access (claude-sonnet-4-5 for geocoding)
- Overture Maps Places share acquired (`OVERTURE_MAPS__PLACES` from Snowflake Marketplace listing `GZT0Z4CM1E9KR`) — used by `TOOL_POI_IN_ISOCHRONE`
- A role with privileges listed in the Required Privileges section below

## Required Privileges

| Privilege | Scope | Reason |
|-----------|-------|--------|
| CREATE DATABASE | Account | Creates FLEET_INTELLIGENCE database |
| CREATE WAREHOUSE | Account | Creates ROUTING_ANALYTICS warehouse |
| USAGE ON DATABASE FLEET_INTELLIGENCE | Database | Uses the setup database |
| CREATE SCHEMA | Database (FLEET_INTELLIGENCE) | Creates ROUTING_TOOLS schema |
| CREATE PROCEDURE | Schema (FLEET_INTELLIGENCE.ROUTING_TOOLS) | Creates the routing TOOL_* procedures |
| USAGE ON DATABASE OPENROUTESERVICE_APP | Database | Calls ORS DIRECTIONS, ISOCHRONES, ISOCHRONES_CLIPPED, OPTIMIZATION functions |
| IMPORT SHARE | Account | Acquires OVERTURE_MAPS__PLACES from Marketplace (one-time) |
| USAGE ON DATABASE OVERTURE_MAPS__PLACES | Database | Reads Overture POI data for TOOL_POI_IN_ISOCHRONE |
| SNOWFLAKE.CORTEX_USER | Database role | Enables AI_COMPLETE calls for geocoding |

> **Note:** ACCOUNTADMIN is NOT required. Create a custom role with the above privileges, or use any role that has them.

## Region awareness (Agent Playground)

The Agent Playground (control-app page) is region- and vehicle-aware end-to-end:

- The active region (`useRegion`) and vehicle type (`useVehicleType`) are sent on every chat call as `region`, `vehicle_type`, and the derived ORS `profile`. The chat backend prepends a hidden context turn instructing the LLM to default tool args to the active region/profile, and uses those values as the local re-execution defaults in `TOOL_PROC_MAP` (replacing the previously hard-coded `California` / `driving-car`).
- Example chips under "Try an example" are generated **live** by `SNOWFLAKE.CORTEX.COMPLETE('claude-sonnet-4-5', ...)` via `GET /api/agent/examples?region=...&vehicle=...`. The endpoint resolves the region centroid from `OPENROUTESERVICE_APP.CORE.REGION_CATALOG` (boundary preferred, bbox fallback) and asks Cortex for 2 scenarios x 4-5 prompts in the existing `AgentDemosConfig` shape. On any failure (parse error, no region match, unprovisioned region) it falls back to the static `config/agent-demos.json` on `ORS_SPCS_STAGE`, then to a hardcoded SF stub.
- Example regeneration is debounced 300 ms and re-runs every time the user switches region or vehicle type. There is no caching by design.

## Error Logging

> Follow the Error Logging convention in AGENTS.md. Log file prefix: `routing-agent`.

## Execution Rules

1. One statement per `snowflake_sql_execute` tool call.
2. Always use fully qualified object names.
3. Never use `SET` session variables.
4. Verify row counts after each CTAS.
5. All CREATE statements must include a COMMENT tracking tag.

## Quick Start

No seed data or pre-computed tables required. This skill deploys only the routing `TOOL_*` stored procedures (no agent — the app-level FLEET_AGENT wraps them via ROUTING_MCP). Run `snow sql -f .cortex/skills/routing-agent/references/deploy-agent.sql -c <connection>` to create all procedures.

## Workflow

> All stored procedure and agent SQL definitions are in [references/agent-definitions.md](references/agent-definitions.md).
>
> For how the Overture Maps shares are queried (schema, the cost-safe bbox + `ST_WITHIN(BOUNDARY)` + LIMIT pattern, the `TOOL_OVERTURE_SEARCH` / `TOOL_OVERTURE_ADDRESSES` procs, and the three agent surfaces incl. the vendor PLACES semantic view), see [references/overture-schema.md](references/overture-schema.md).

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
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.ROUTING_TOOLS
    COMMENT = '{"origin":"sf_sit-is-fleet", "name":"oss-deploy-snowflake-intelligence-routing-agent", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';
CREATE WAREHOUSE IF NOT EXISTS ROUTING_ANALYTICS
    WAREHOUSE_SIZE = 'XSMALL' AUTO_SUSPEND = 60 AUTO_RESUME = TRUE
    COMMENT = '{"origin":"sf_sit-is-fleet", "name":"oss-deploy-snowflake-intelligence-routing-agent", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';
```

### Step 4: Deploy All Procedures

**Goal:** Create the routing TOOL_* procedures (TOOL_DIRECTIONS, TOOL_ISOCHRONE, TOOL_POI_IN_ISOCHRONE, TOOL_ROUTE_OPTIMIZATION, TOOL_OVERTURE_SEARCH, TOOL_OVERTURE_ADDRESSES, TOOL_CATCHMENT, TOOL_DELIVERY_OPTIMIZATION, TOOL_NETWORK_OPTIMIZATION) in a single step. No agent is created — FLEET_AGENT wraps these via ROUTING_MCP.

```bash
snow sql -f .cortex/skills/routing-agent/references/deploy-agent.sql -c <connection>
```

This creates:
- **TOOL_DIRECTIONS**: Wraps ORS DIRECTIONS with AI geocoding (claude-sonnet-4-5) for natural language location input
- **TOOL_ISOCHRONE**: Wraps ORS ISOCHRONES with AI geocoding for reachability analysis
- **TOOL_POI_IN_ISOCHRONE**: Joins an isochrone polygon with Overture Maps POIs (cafes, restaurants, shops, etc.) via `ST_WITHIN`
- **TOOL_ROUTE_OPTIMIZATION**: Python procedure wrapping ORS OPTIMIZATION for multi-stop delivery routing
- Plus **TOOL_OVERTURE_SEARCH**, **TOOL_OVERTURE_ADDRESSES**, **TOOL_CATCHMENT**, **TOOL_DELIVERY_OPTIMIZATION**, **TOOL_NETWORK_OPTIMIZATION**

No Cortex Agent is created by this skill. The app-level `FLEET_AGENT` (created by `install-fleet-apps`) attaches `OPENROUTESERVICE_APP.ROUTING.ROUTING_MCP`, whose verbs wrap these procedures.

> **Reference:** For annotated explanations of each procedure, see [references/agent-definitions.md](references/agent-definitions.md).

### Step 5: Test the procedures (via FLEET_AGENT)

The routing capabilities are exposed to users through the app-level `FLEET_AGENT` (created by `install-fleet-apps`), which attaches `ROUTING_MCP`. There is no separate agent to register with Snowflake Intelligence from this skill. Test through the fleet app chat, or call a procedure directly to confirm it works.

Test queries must use locations within the ORS-configured region. To determine the region:

```sql
DESCRIBE SERVICE OPENROUTESERVICE_APP.CORE.ORS_SERVICE;
```

Parse the spec to find the configured region name from `/home/ors/files/<REGION_NAME>.osm.pbf`.

Before testing, verify all services are RUNNING (see Step 2b).

**Sample queries by region:**

| Region | Directions | Isochrone | Optimization | POIs in isochrone |
|--------|-----------|-----------|--------------|-------------------|
| San Francisco | "Driving directions from Union Square to Fisherman's Wharf" | "Areas reachable within 15 min by car from Union Square" | "Optimize deliveries to Ferry Building, Pier 39, Ghirardelli Square — 2 vehicles from Union Square" | "What cafes can I reach within a 15 minute ebike ride from Civic Center, San Francisco" |
| New York | "Driving directions from Times Square to Central Park" | "Areas reachable within 15 min by car from Grand Central" | "Optimize deliveries to Empire State, Rockefeller Center, Times Square — 2 vehicles from Grand Central" | "Pharmacies within 10 minutes walk of Grand Central" |
| London | "Driving directions from Tower Bridge to Buckingham Palace" | "Areas reachable within 15 min by car from King's Cross" | "Optimize deliveries to British Museum, Tower of London, Westminster Abbey — 2 vehicles from Trafalgar Square" | "Restaurants within 20 minutes walk of King's Cross" |
| Berlin | "Driving directions from Brandenburg Gate to Alexanderplatz" | "Areas reachable within 15 min by car from Hauptbahnhof" | "Optimize deliveries to Reichstag, Checkpoint Charlie, East Side Gallery — 2 vehicles from Alexanderplatz" | "Bars within 15 minutes cycle from Alexanderplatz" |

Use central city locations as depots.

## Examples

### Example 1: Deploy routing tool procedures for San Francisco
User says: "Deploy the routing tools"
Actions:
1. Verify ORS functions and services (Step 2)
2. Create database/schema (Step 3)
3. Create the routing TOOL_* procedures (Step 4)
4. Test via FLEET_AGENT: "Driving directions from Union Square to Fisherman's Wharf"
Result: Routing capabilities available to the app-level FLEET_AGENT (via ROUTING_MCP)

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
- **Step 4**: Confirm all 9 procedures deploy correctly

## Output

- 1 database: `FLEET_INTELLIGENCE`
- 1 schema: `FLEET_INTELLIGENCE.ROUTING_TOOLS`
- 1 warehouse: `ROUTING_ANALYTICS`
- 9 stored procedures with AI geocoding and error handling
- Routing capabilities surfaced through the app-level `FLEET_AGENT` (via `ROUTING_MCP`)

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Routing tools not available to FLEET_AGENT | Confirm `ROUTING_MCP` lists the verbs and that the procedures exist in `FLEET_INTELLIGENCE.ROUTING_TOOLS` |
| Geocoding fails | Check Cortex AI access and model availability |
| Empty directions | Verify ORS map data covers the requested region |
| Routing functions fail | Check service status with `SHOW SERVICES IN SCHEMA OPENROUTESERVICE_APP.CORE;` and resume suspended services |
| Tool returns `Parameter 'profile' has incorrect value of 'unknown'` | The requested profile is not loaded in this ORS install. The default `install-fleet-apps` install loads `driving-car`, `driving-hgv`, `cycling-electric` only. Other ORS profile names (e.g. `cycling-regular`, `cycling-mountain`, `foot-walking`) are valid identifiers but require a different `p_profiles` value when calling `install-fleet-apps`. See `.cortex/skills/build-routing-solution/openrouteservice_app/app/modules/03_region_management.sql` (the `all_profiles` list) for the full set of selectable profile names. |
| Agent says "OpenRouteService is currently unreachable" for POI questions (e.g. "what cafes can I reach") | This is the agent confabulating because it had no POI search tool. Re-run `deploy-agent.sql` to install `TOOL_POI_IN_ISOCHRONE` and ensure `OVERTURE_MAPS__PLACES` is acquired from Marketplace. |
| `TOOL_POI_IN_ISOCHRONE` returns count=0 | Try a broader category (e.g. `restaurant` instead of `specialty bistro`) or a longer travel range. Confirm `SELECT COUNT(*) FROM OVERTURE_MAPS__PLACES.CARTO.PLACE` returns rows. |

## Cleanup

To remove all objects created by this skill:

```sql
-- Drop the routing procedures, then the schema and warehouse.
-- (The standalone ROUTING_AGENT agent is retired; on a pre-relocation install
--  also run: DROP AGENT IF EXISTS FLEET_INTELLIGENCE.ROUTING_AGENT.ROUTING_AGENT;)
DROP PROCEDURE IF EXISTS FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_ROUTE_OPTIMIZATION(VARCHAR, VARCHAR, NUMBER, VARCHAR, VARCHAR);
DROP PROCEDURE IF EXISTS FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_POI_IN_ISOCHRONE(VARCHAR, NUMBER, VARCHAR, VARCHAR, NUMBER);
DROP PROCEDURE IF EXISTS FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_ISOCHRONE(VARCHAR, NUMBER, VARCHAR);
DROP PROCEDURE IF EXISTS FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_DIRECTIONS(VARCHAR, VARCHAR);
DROP SCHEMA IF EXISTS FLEET_INTELLIGENCE.ROUTING_TOOLS;
DROP WAREHOUSE IF EXISTS ROUTING_ANALYTICS;
```

> **Tip:** Use the `cleanup` skill to auto-discover all tagged objects via COMMENT tracking.
