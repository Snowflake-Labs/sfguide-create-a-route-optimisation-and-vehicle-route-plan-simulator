---
name: setup-agent-playground
description: "Deploy the Agent Playground demo data, stored procedures, and configuration. Run AFTER $build-routing-solution completes. Creates all pharma supply chain, catchment, and optimisation tools needed for the agent playground to work. Triggers: setup agent playground, deploy agent demos, configure agent playground, install agent tools."
depends_on:
  - build-routing-solution
  - routing-agent
metadata:
  author: Snowflake SIT-IS
  version: 1.0.0
  category: demo-setup
---

# Setup Agent Playground

Deploys all demo data, stored procedures, and configuration needed for the Agent Playground to be fully functional.

## Prerequisites

- `$build-routing-solution` has completed successfully (ORS services running)
- `$routing-agent` has completed (base TOOL_DIRECTIONS, TOOL_ISOCHRONE exist)
- FLEET_INTELLIGENCE database exists with ROUTING_AGENT schema
- OPENROUTESERVICE_APP database exists with ORS_SPCS_STAGE

## What Gets Deployed

| Object | Type | Purpose |
|--------|------|---------|
| All CONFIG tables | Update | Sets VEHICLE_TYPE='ebike', REGION='SanFrancisco' across all 6 demo schemas |
| `FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERIES` | View | Maps FACT_TRIPS to Fleet Delivery dashboard schema |
| `FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_PHARMA_JOBS` | Table | 30 pre-geocoded SF delivery stops with VROOM skills |
| `FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_HEALTH_DEMOGRAPHICS` | Table | 55 SF neighbourhood health data points |
| `FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_DRUG_FORMULARY` | Table | 25 drugs mapped to conditions with delivery skills |
| `FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_TOP_PHARMACIES` | Table | 6 pre-geocoded SF pharmacies |
| `FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ROUTE_OPTIMIZATION` | Procedure | JavaScript SP for route optimisation with AI geocoding |
| `FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_PHARMA_OPTIMIZATION` | Procedure | Pharma fleet demo with 30 stops and VROOM skills |
| `FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_PHARMA_CATCHMENT` | Procedure | Catchment health demographics analysis |
| `FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_SUPPLY_CHAIN` | Procedure | Full supply chain optimisation |
| `@ORS_SPCS_STAGE/config/agent-demos.json` | Config | Demo scenarios and prompts (editable) |

## Execution Steps

### Step 1: Configure Demo Defaults

Sets all CONFIG tables to match deployed data and creates the DELIVERIES view:

```bash
snow sql -f .cortex/skills/build-routing-solution/openrouteservice_app/sql/stored_procedures/configure_demo_defaults.sql -c <connection>
```

**Expected Output:** "Demo defaults configured successfully"

### Step 2: Deploy Demo Data Tables and Stored Procedures

Run all SQL files in sequence:

```bash
snow sql -f .cortex/skills/build-routing-solution/openrouteservice_app/sql/stored_procedures/tool_route_optimization.sql -c <connection> && \
snow sql -f .cortex/skills/build-routing-solution/openrouteservice_app/sql/stored_procedures/tool_pharma_optimization.sql -c <connection> && \
snow sql -f .cortex/skills/build-routing-solution/openrouteservice_app/sql/stored_procedures/sf_health_demographics.sql -c <connection> && \
snow sql -f .cortex/skills/build-routing-solution/openrouteservice_app/sql/stored_procedures/tool_pharma_catchment.sql -c <connection> && \
snow sql -f .cortex/skills/build-routing-solution/openrouteservice_app/sql/stored_procedures/tool_supply_chain.sql -c <connection>
```

**Expected Output:** Each file should print a success message.

### Step 3: Upload Agent Config to Stage

```bash
snow stage copy .cortex/skills/build-routing-solution/openrouteservice_app/config/agent-demos.json \
  @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/config/ \
  -c <connection> --overwrite
```

**Expected Output:** File uploaded successfully.

### Step 4: Verify Deployment

Run these verification queries:

```sql
-- Check tables exist
SELECT 'SF_PHARMA_JOBS' AS TBL, COUNT(*) AS ROWS FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_PHARMA_JOBS
UNION ALL SELECT 'SF_HEALTH_DEMOGRAPHICS', COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_HEALTH_DEMOGRAPHICS
UNION ALL SELECT 'SF_DRUG_FORMULARY', COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_DRUG_FORMULARY
UNION ALL SELECT 'SF_TOP_PHARMACIES', COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_TOP_PHARMACIES;

-- Expected: SF_PHARMA_JOBS=30, SF_HEALTH_DEMOGRAPHICS=55, SF_DRUG_FORMULARY=25, SF_TOP_PHARMACIES=6

-- Check procedures exist
SHOW PROCEDURES LIKE 'TOOL_%' IN SCHEMA FLEET_INTELLIGENCE.ROUTING_AGENT;

-- Expected: TOOL_DIRECTIONS, TOOL_ISOCHRONE, TOOL_ROUTE_OPTIMIZATION, TOOL_PHARMA_OPTIMIZATION, TOOL_PHARMA_CATCHMENT, TOOL_SUPPLY_CHAIN

-- Test pharma catchment
CALL FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_PHARMA_CATCHMENT('498 Castro Street San Francisco', 10, 'driving-car');
-- Expected: status = SUCCESS, catchment_population > 0
```

### Step 5: Test in the App

Open the Agent Playground in the ORS Control App and try:
1. Click the "Pharma Supply Chain" scenario tab
2. Click "1. Catchment analysis"
3. Verify the isochrone polygon + health risk dots appear on the map

## Customising Demo Scenarios

After deployment, attendees can customise the Agent Playground without rebuilding images:

1. Edit `config/agent-demos.json` in the workspace (or ask Cortex Code to modify it)
2. Upload: `snow stage copy config/agent-demos.json @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/config/ --overwrite`
3. Refresh the Agent Playground page — new scenarios appear instantly

### Config Format

```json
{
  "default_scenario": "pharma",
  "max_token_limit": 8000,
  "scenarios": [
    {
      "id": "unique_id",
      "label": "Display Name",
      "icon": "emoji",
      "description": "Short description",
      "prompts": [
        { "label": "Step label", "icon": "emoji", "prompt": "Full prompt text" }
      ]
    }
  ]
}
```

## Troubleshooting

| Issue | Fix |
|-------|-----|
| "Isochrone geometry is null" | ORS service not ready — wait for graphs to load (~9s after resume) or check `SELECT ORS_STATUS()` |
| "Unknown function TOOL_PHARMA_CATCHMENT" | Step 1 not run — execute the SQL files |
| Scenarios not appearing | Config not uploaded — run Step 2 |
| "OPTIMIZATION returned no results" | VROOM service suspended — `CALL CORE.RESUME_ALL_SERVICES()` |
