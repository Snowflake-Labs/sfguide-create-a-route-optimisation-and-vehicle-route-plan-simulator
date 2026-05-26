---
name: add-weather-routing
description: "Add real-time Met Office weather data to the routing agent. Creates a TOOL_WEATHER stored procedure backed by a Python UDF that queries NetCDF files from the Met Office public S3 bucket (no API key required). Adds weather tool to ROUTING_AGENT and updates agent-demos.json with a Weather-Aware Routing scenario. Use when: adding weather context to routing decisions, weather-aware routing, checking conditions before recommending cycling/walking profiles. Prerequisites: routing-agent must be deployed. Triggers: add weather, weather routing, weather tool, met office, weather agent, weather conditions, fog routing, rain routing."
depends_on:
  - routing-agent
metadata:
  author: Snowflake SIT-IS
  version: 1.0.0
  category: intelligence-agent
---

# Add Weather-Aware Routing

Adds real-time Met Office weather data to the Routing Agent using the public Met Office Atmospheric Model S3 bucket (Open Government Licence, no API key required). Global 10km resolution — covers San Francisco and any other deployed region.

## What Gets Created

| Object | Purpose |
|--------|---------|
| `FLEET_INTELLIGENCE.ROUTING_AGENT.MET_OFFICE_S3_RULE` | Network rule allowing egress to Met Office S3 |
| `MET_OFFICE_S3_ACCESS` EAI | External Access Integration for S3 |
| `FLEET_INTELLIGENCE.ROUTING_AGENT.GET_WEATHER_AT_POINT` | Python UDF — queries NetCDF from S3 for a lat/lon point |
| `FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_WEATHER` | Stored procedure — weather for the active routing region |
| Updated `ROUTING_AGENT` | Agent with new `tool_weather` tool added |
| Updated `agent-demos.json` | New "Weather-Aware Routing" scenario uploaded to stage |

## Prerequisites

- `$routing-agent` deployed (ROUTING_AGENT exists in `FLEET_INTELLIGENCE.ROUTING_AGENT`)
- ROUTING_ANALYTICS warehouse available
- ACCOUNTADMIN role

## Workflow

### Step 1: Create Schema and Network Rule

```sql
USE ROLE ACCOUNTADMIN;
USE WAREHOUSE ROUTING_ANALYTICS;

CREATE DATABASE IF NOT EXISTS FLEET_INTELLIGENCE;
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.ROUTING_AGENT;

CREATE OR REPLACE NETWORK RULE FLEET_INTELLIGENCE.ROUTING_AGENT.MET_OFFICE_S3_RULE
    MODE = EGRESS
    TYPE = HOST_PORT
    VALUE_LIST = (
        'met-office-atmospheric-model-data.s3.amazonaws.com:443',
        'met-office-atmospheric-model-data.s3.eu-west-2.amazonaws.com:443'
    )
    COMMENT = 'Met Office public S3 bucket - Open Government Licence';
```

**Output:** Network rule created

### Step 2: Create External Access Integration

```sql
CREATE OR REPLACE EXTERNAL ACCESS INTEGRATION MET_OFFICE_S3_ACCESS
    ALLOWED_NETWORK_RULES = (FLEET_INTELLIGENCE.ROUTING_AGENT.MET_OFFICE_S3_RULE)
    ENABLED = TRUE
    COMMENT = 'Met Office Atmospheric Model Data access';
```

**Output:** EAI created

### Step 3: Deploy Python UDF and TOOL_WEATHER Procedure

Execute `references/deploy-weather-tool.sql` — creates:
- **GET_WEATHER_AT_POINT** — Python UDF that fetches NetCDF from S3 and extracts a weather value at a lat/lon point
- **TOOL_WEATHER** — Stored procedure the agent calls; geocodes the active region and returns current conditions for all key parameters

### Step 4: Recreate ROUTING_AGENT with Weather Tool

Execute the `CREATE OR REPLACE AGENT` block in `references/deploy-weather-tool.sql` which adds `tool_weather` to the existing tool list.

> **Note:** This recreates the agent with all existing tools preserved plus the new weather tool. The agent spec in `deploy-weather-tool.sql` is kept in sync with `routing-agent/references/deploy-agent.sql`.

**Verify:**
```sql
SHOW AGENTS IN SCHEMA FLEET_INTELLIGENCE.ROUTING_AGENT;
CALL FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_WEATHER('SanFrancisco');
```

Expected: JSON response with temperature, wind_speed, precipitation, visibility, humidity for San Francisco.

### Step 5: Update Agent Playground Config

Upload the updated `agent-demos.json` (which now includes a "Weather-Aware Routing" scenario) to the ORS stage:

```sql
CREATE FILE FORMAT IF NOT EXISTS OPENROUTESERVICE_APP.CORE.JSON_FORMAT
  TYPE = 'JSON' STRIP_OUTER_ARRAY = FALSE;

COPY FILES INTO @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/config/
FROM '<WORKSPACE_STAGE_URI>'
FILES=('agent-demos.json');
```

Replace `<WORKSPACE_STAGE_URI>` with the Snowflake stage URI for the current workspace root (use `SHOW GIT REPOSITORIES` or ask Cortex Code for the stage path).

**Verify:**
```sql
SELECT $1 FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/config/agent-demos.json
  (FILE_FORMAT => 'OPENROUTESERVICE_APP.CORE.JSON_FORMAT');
```

Expected: JSON with 5 scenarios including `"id": "weather"`.

## Weather Parameters Available

| Parameter | Unit | Routing Use |
|-----------|------|-------------|
| `temperature` | °C | E-bike battery range, comfort |
| `wind_speed` | m/s | Flag cycling routes (>10 m/s) |
| `precipitation` | mm/hr | Suggest covered routes, increase time estimates |
| `visibility` | m | Avoid cycling/walking when <1000m (SF fog) |
| `humidity` | % | Comfort index |
| `pressure` | hPa | Weather front indicator |
| `cloud` | fraction | General conditions |

## Agent Behaviour After Installation

The agent will now:
- Check current weather for the active region when asked about conditions
- Warn against cycling/e-bike profiles in low visibility (<1000m) or high wind (>10 m/s)
- Flag heavy precipitation when recommending outdoor courier routes
- Provide weather context alongside routing recommendations

Example prompts:
- *"What are the current weather conditions in San Francisco?"*
- *"Should I send cyclists out today given current conditions?"*
- *"Plan deliveries for 3 vehicles but check if the weather is safe for e-bikes first"*
