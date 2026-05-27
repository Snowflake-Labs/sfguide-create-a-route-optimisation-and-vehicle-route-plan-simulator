---
name: setup-agent-playground
description: "Deploy the Agent Playground: semantic view, demo data, stored procedures, agent config with 13 tools including pharma supply chain and plant intelligence. Run AFTER build-routing-solution and routing-agent. Triggers: setup agent playground, deploy agent demos, configure agent playground, install agent tools, plant intel scenario, agent click integration."
depends_on:
  - build-routing-solution
  - routing-agent
metadata:
  author: Snowflake SIT-IS
  version: 2.0.0
  category: demo-setup
---

# Setup Agent Playground

Deploys everything the Agent Playground needs: semantic view for analytics, demo data tables, stored procedures, and the agent-demos.json config.

## Prerequisites

```sql
SHOW AGENTS IN SCHEMA FLEET_INTELLIGENCE.ROUTING_AGENT;
SHOW SERVICES IN SCHEMA OPENROUTESERVICE_APP.CORE;
```

Required: ROUTING_AGENT exists, all 5 services RUNNING.

## Step 1: Create Semantic View

Creates `FLEET_ANALYTICS_VIEW` over trips, telemetry, fleet, and POIs for Cortex Analyst text-to-SQL. Covers ALL demo data.


Execute `references/deploy-semantic-view.sql`.

Verify: `SHOW SEMANTIC VIEWS IN SCHEMA FLEET_INTELLIGENCE.ROUTING_AGENT;`

## Step 2: Configure Agent with All Tools

This is the **single authoritative agent update** — run it after all desired add-on skills have been installed. It creates the agent with all 13 tools. Any tool whose backing resource doesn't exist yet (because an add-on hasn't been run) is silently skipped at runtime until you deploy that add-on and re-run this step.

Execute `references/configure-agent.sql`, or run this statement directly:

```sql
CREATE OR REPLACE AGENT FLEET_INTELLIGENCE.ROUTING_AGENT.ROUTING_AGENT
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
FROM SPECIFICATION $$
models:
  orchestration: auto
instructions:
  response: "You are a fleet intelligence assistant for the San Francisco Bay Area. You can answer routing questions (directions, isochrones, VRP) AND analytical questions about fleet data (trip counts, vehicle performance, delivery stats, dwell times). Present distances in km and durations in minutes."
  orchestration: |
    - For route calculations between locations: Use TOOL_DIRECTIONS
    - For coverage/reachability analysis: Use TOOL_ISOCHRONES
    - For multi-stop delivery optimization (VRP): Use TOOL_ROUTE_OPTIMIZATION
    - For analytical questions about trip counts, vehicle performance, delivery stats, busiest locations, dwell times, fleet data: Use FLEET_ANALYTICS
    - ALWAYS use a tool. NEVER answer from general knowledge.
tools:
  - tool_spec:
      type: generic
      name: TOOL_DIRECTIONS
      description: "Calculate driving directions between locations. Returns distance, duration, and route geometry."
      input_schema:
        type: object
        properties:
          locations_description:
            type: string
            description: "Natural language description of start and end locations"
          profile:
            type: string
            description: "Routing profile: driving-car, driving-hgv, or cycling-electric"
        required:
          - locations_description
  - tool_spec:
      type: generic
      name: TOOL_ISOCHRONES
      description: "Generate an isochrone (reachability polygon) from a location. Returns the area reachable within specified minutes."
      input_schema:
        type: object
        properties:
          location_description:
            type: string
            description: "Natural language description of the center location"
          minutes:
            type: integer
            description: "Travel time in minutes"
          profile:
            type: string
            description: "Routing profile: driving-car, driving-hgv, or cycling-electric"
        required:
          - location_description
          - minutes
  - tool_spec:
      type: generic
      name: TOOL_ROUTE_OPTIMIZATION
      description: "Optimize a multi-stop delivery route (VRP). Describe depot and delivery stops."
      input_schema:
        type: object
        properties:
          description:
            type: string
            description: "Natural language description of depot and all delivery locations"
          num_vehicles:
            type: number
            description: "Number of vehicles (default 1)"
          profile:
            type: string
            description: "Routing profile: driving-car, driving-hgv, or cycling-electric"
        required:
          - description
  - tool_spec:
      type: cortex_analyst_text_to_sql
      name: FLEET_ANALYTICS
      description: "Answer analytical questions about fleet data: trip counts, vehicle performance, delivery times, busiest POIs, hourly distributions, detour rates, and fleet utilization."
tool_resources:
  TOOL_DIRECTIONS:
    type: procedure
    identifier: FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_DIRECTIONS
    execution_environment:
      type: warehouse
      warehouse: ROUTING_ANALYTICS
  TOOL_ISOCHRONES:
    type: procedure
    identifier: FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ISOCHRONES
    execution_environment:
      type: warehouse
      warehouse: ROUTING_ANALYTICS
  TOOL_ROUTE_OPTIMIZATION:
    type: procedure
    identifier: FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ROUTE_OPTIMIZATION
    execution_environment:
      type: warehouse
      warehouse: ROUTING_ANALYTICS
  FLEET_ANALYTICS:
    type: semantic_view
    semantic_view: FLEET_INTELLIGENCE.ROUTING_AGENT.FLEET_ANALYTICS_VIEW
    execution_environment:
      type: warehouse
      warehouse: ROUTING_ANALYTICS
$$;
```

Verify: `DESCRIBE AGENT FLEET_INTELLIGENCE.ROUTING_AGENT.ROUTING_AGENT;` — should show 4 tools (3 generic + 1 cortex_analyst_text_to_sql).

## Step 3: Deploy Demo Data

Execute `references/deploy-demo-data.sql` statement-by-statement. Creates:

| Table | Rows | Purpose |
|-------|------|---------|
| SF_PHARMA_JOBS | 30 | Pre-geocoded delivery stops |
| SF_HEALTH_DEMOGRAPHICS | 55 | Population health by neighborhood |
| SF_DRUG_FORMULARY | 25 | Drug demand by condition |
| SF_TOP_PHARMACIES | 6 | SF pharmacy locations |

## Step 4: Upload Config + JSON Format

```sql
CREATE FILE FORMAT IF NOT EXISTS OPENROUTESERVICE_APP.CORE.JSON_FORMAT
  TYPE = JSON STRIP_OUTER_ARRAY = FALSE;

COPY FILES INTO @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/config/
FROM 'snow://workspace/USER$.PUBLIC."sfguide-build-fleet-intelligence-with-cortex-code"/versions/live/'
FILES=('agent-demos.json');
```

Verify:
```sql
SELECT PARSE_JSON($1):scenarios[1]:id::VARCHAR FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/config/agent-demos.json (FILE_FORMAT => 'OPENROUTESERVICE_APP.CORE.JSON_FORMAT');
```
Expected: `analytics`

## Step 5: Configure Demo Defaults
UPDATE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.CONFIG SET VEHICLE_TYPE = 'ebike', REGION = 'SanFrancisco';
UPDATE FLEET_INTELLIGENCE.DWELL_ANALYSIS.CONFIG SET VEHICLE_TYPE = 'ebike', REGION = 'SanFrancisco';
UPDATE FLEET_INTELLIGENCE.ROUTE_DEVIATION.CONFIG SET VEHICLE_TYPE = 'ebike', REGION = 'SanFrancisco';
UPDATE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG SET VEHICLE_TYPE = 'ebike', REGION = 'SanFrancisco';
UPDATE FLEET_INTELLIGENCE.RETAIL_CATCHMENT.CONFIG SET VEHICLE_TYPE = 'ebike', REGION = 'SanFrancisco';
```

## Step 6: Plant Intelligence Scenario + Agent Click Integration

> **Requires:** `$add-plant-map` must be deployed first (creates `PLANT_ALERT_STATUS`, `PLANT_CAMPUS_BUILDINGS` views and the Overture footprints table).

The `agent-demos.json` uploaded in Step 4 already includes the `plant_intel` scenario. Once `$add-plant-map` SQL is run, the Plant Intelligence tab becomes fully functional in the Agent Playground.

### What the plant_intel scenario provides

The **Plant Intel** scenario in the Agent Playground shows an embedded interactive campus map (4-level drill-down) instead of the static intro card. When the user navigates the map and clicks a building or room, the chat input is **automatically pre-filled** with a contextual message:

**Building click → agent receives:**
- Building role (e.g. "API Manufacturing")
- Floor count and area
- Number of GMP sensors + alert summary (critical/warning counts with values)
- Suggested prompt: analyse facility + check supply chain / batch issues

**Room click → agent receives:**
- Zone name and type (e.g. "Reactor Hall — reactor")
- All active sensor alerts with readings and alert text
- Contents summary (up to 4 items: batch numbers, expiry dates, equipment status)
- Suggested prompt: analyse zone + suggest next steps using available tools

### Agent tools used for plant intel

The agent's `pharma_supply_chain` semantic view tool (already in the spec) can answer follow-up questions about the clicked facility:

```
User clicks "API Manufacturing" at Mount Vernon → agent asked:
"Can you check batch status and supply chain risks for this facility?"

Agent uses pharma_supply_chain tool → returns:
- Active batches, on-hold counts, deviation details
- Inventory levels for the plant
- Shipment delays affecting supply
```

The agent can also chain to routing tools — e.g. "Find the fastest route to the nearest API supplier" after identifying a supply issue.

### Verify plant_intel scenario loads

```sql
-- Check agent-demos.json has plant_intel scenario
SELECT PARSE_JSON($1):scenarios[4]:id::VARCHAR AS scenario_id
FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/config/agent-demos.json
(FILE_FORMAT => 'OPENROUTESERVICE_APP.CORE.JSON_FORMAT');
-- Expected: plant_intel
```

## Verification Summary

| Check | Expected |
|-------|----------|
| `SHOW SEMANTIC VIEWS IN SCHEMA FLEET_INTELLIGENCE.ROUTING_AGENT` | FLEET_ANALYTICS_VIEW |
| `DESCRIBE AGENT ...ROUTING_AGENT` | 13 tools (routing + analytics + pharma supply chain) |
| `SELECT COUNT(*) FROM ...SF_HEALTH_DEMOGRAPHICS` | 55 |
| Config loads from stage | JSON with "analytics", "pharma", "plant_intel" scenarios |
| Plant Intel tab shows campus map | Requires `$add-plant-map` SQL deployed |

## Agent Spec Rules

> - Routing tools: `type: generic` with `tool_resources.type: procedure`
> - Analytics tool: `type: cortex_analyst_text_to_sql` with `tool_resources.type: semantic_view`
> - Do NOT use `type: custom_tool` (causes runtime error)

## Cleanup

```sql
DROP SEMANTIC VIEW IF EXISTS FLEET_INTELLIGENCE.ROUTING_AGENT.FLEET_ANALYTICS_VIEW;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_PHARMA_JOBS;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_HEALTH_DEMOGRAPHICS;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_DRUG_FORMULARY;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_TOP_PHARMACIES;
```
