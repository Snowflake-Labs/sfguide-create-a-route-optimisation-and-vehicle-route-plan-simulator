---
name: setup-agent-playground
description: "Deploy SF pharma demo data tables required by the Agent Playground's pharma supply-chain scenario (TOOL_SUPPLY_CHAIN, TOOL_PHARMA_OPTIMIZATION, TOOL_PHARMA_CATCHMENT). Run AFTER $build-routing-solution and $routing-agent. Creates SF_PHARMA_JOBS (30), SF_HEALTH_DEMOGRAPHICS (55), SF_DRUG_FORMULARY (25), SF_TOP_PHARMACIES (6), the FOOD_DELIVERY DELIVERIES view, updates the 6 fleet CONFIG tables to SanFrancisco/ebike defaults, and uploads agent-demos.json to the ORS stage. Triggers: setup agent playground, install agent demo data, deploy pharma demo, missing pharma data, agent playground scenarios missing, agent-demos.json missing, pharma supply chain demo, SF_PHARMA_JOBS, SF_HEALTH_DEMOGRAPHICS, SF_DRUG_FORMULARY, SF_TOP_PHARMACIES."
depends_on:
  - build-routing-solution
  - routing-agent
metadata:
  author: Snowflake SIT-IS
  version: 1.0.0
  category: demo-setup
---

# Setup Agent Playground

Deploys the San Francisco pharmaceutical supply-chain demo data and uploads the
Agent Playground scenario config (`agent-demos.json`) to the ORS stage. After
this skill runs, the Routing Agent's three pharma tools (`TOOL_SUPPLY_CHAIN`,
`TOOL_PHARMA_OPTIMIZATION`, `TOOL_PHARMA_CATCHMENT`) become functional and the
control-app Agent Playground page shows all three scenarios (Pharma Supply
Chain, Retail & Catchment, Fleet Logistics).

> **Important:** The pharma stored procedures themselves are created by
> `$routing-agent`. This skill only seeds the data tables and uploads the
> scenario config — it does NOT create procedures.

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `DATABASE` | `FLEET_INTELLIGENCE` | Demo database (created by build-routing-solution) |
| `DATA_SCHEMA` | `ROUTE_OPTIMIZATION` | Schema that holds the 4 SF data tables |
| `WAREHOUSE` | `ROUTING_ANALYTICS` | Warehouse for setup statements |
| `STAGE` | `OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE` | Stage receiving `agent-demos.json` |
| `REGION` | `SanFrancisco` | Region the demo data is geocoded for |
| `VEHICLE_TYPE` | `ebike` | Default vehicle for the 6 fleet CONFIG tables |

## Prerequisites

- `$build-routing-solution` deployed (creates `OPENROUTESERVICE_APP`,
  `ORS_SPCS_STAGE`, the 6 fleet CONFIG tables, and the SanFrancisco region).
- `$routing-agent` deployed (creates the 3 pharma stored procedures along with
  the multi-region tools).
- A role that can read/write the schemas listed in **Required Privileges**.

## Required Privileges

| Privilege | Scope | Reason |
|-----------|-------|--------|
| USAGE | DATABASE FLEET_INTELLIGENCE | Access the fleet schemas |
| USAGE | SCHEMA FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION | Create the 4 SF data tables |
| CREATE TABLE | SCHEMA FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION | Create the 4 data tables |
| INSERT, UPDATE | All 6 CONFIG tables | Update vehicle/region defaults |
| CREATE VIEW | SCHEMA FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY | Create DELIVERIES view |
| USAGE | DATABASE OPENROUTESERVICE_APP | Upload agent-demos.json to stage |
| WRITE | STAGE OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE | PUT agent-demos.json |
| CREATE FILE FORMAT | SCHEMA OPENROUTESERVICE_APP.CORE | Create JSON_FORMAT (idempotent) |

> **Note:** ACCOUNTADMIN is **not** required. Use a role with the privileges
> above, or escalate to ACCOUNTADMIN only for the duration of this skill.

## Error Logging

> Follow the Error Logging convention in AGENTS.md. Log file prefix:
> `setup-agent-playground`.

## Step 1 — Run the SQL pipeline

Execute every statement in `references/deploy-demo-data.sql` end-to-end. The
file:

1. Sets the session `query_tag`.
2. Updates the 6 fleet CONFIG tables to `VEHICLE_TYPE = 'ebike'` and
   `REGION = 'SanFrancisco'`.
3. Creates the `FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERIES` view.
4. Creates and seeds 4 SF data tables:
   - `FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_PHARMA_JOBS` (30 rows)
   - `FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_HEALTH_DEMOGRAPHICS` (55 rows)
   - `FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_DRUG_FORMULARY` (25 rows)
   - `FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_TOP_PHARMACIES` (6 rows)
5. Creates `OPENROUTESERVICE_APP.CORE.JSON_FORMAT` (idempotent).

Every CREATE statement carries the standard `oss-setup-agent-playground`
COMMENT tracking tag.

## Step 2 — Upload `agent-demos.json` to the ORS stage

The Agent Playground's `/api/agent/config` endpoint reads scenarios from
`@OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/config/agent-demos.json`. Upload it
from the repo:

```bash
snow stage copy \
  .cortex/skills/build-routing-solution/openrouteservice_app/config/agent-demos.json \
  @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/config/ \
  --overwrite \
  -c <connection>
```

Or from a Workspace, via SQL:

```sql
COPY FILES INTO @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/config/
FROM 'snow://workspace/USER$.PUBLIC."<workspace-name>"/versions/live/.cortex/skills/build-routing-solution/openrouteservice_app/config/'
FILES=('agent-demos.json');
```

## Verification

After both steps complete, all of the following must be true:

1. 6 CONFIG tables updated:
   ```sql
   SELECT 'FLEET_INTELLIGENCE_FOOD_DELIVERY' AS NAME, REGION, VEHICLE_TYPE FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.CONFIG
   UNION ALL SELECT 'FLEET_INTELLIGENCE_TAXIS',          REGION, VEHICLE_TYPE FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.CONFIG
   UNION ALL SELECT 'DWELL_ANALYSIS',                    REGION, VEHICLE_TYPE FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.CONFIG
   UNION ALL SELECT 'ROUTE_DEVIATION',                   REGION, VEHICLE_TYPE FROM FLEET_INTELLIGENCE.ROUTE_DEVIATION.CONFIG
   UNION ALL SELECT 'ROUTE_OPTIMIZATION',                REGION, VEHICLE_TYPE FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG
   UNION ALL SELECT 'RETAIL_CATCHMENT',                  REGION, VEHICLE_TYPE FROM FLEET_INTELLIGENCE.RETAIL_CATCHMENT.CONFIG;
   ```
2. 4 data tables with correct row counts:
   ```sql
   SELECT 'SF_PHARMA_JOBS' AS TBL, COUNT(*) AS CNT FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_PHARMA_JOBS
   UNION ALL SELECT 'SF_HEALTH_DEMOGRAPHICS', COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_HEALTH_DEMOGRAPHICS
   UNION ALL SELECT 'SF_DRUG_FORMULARY',      COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_DRUG_FORMULARY
   UNION ALL SELECT 'SF_TOP_PHARMACIES',      COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_TOP_PHARMACIES;
   ```
   Expected counts: 30, 55, 25, 6.
3. `agent-demos.json` is on the stage:
   ```sql
   LIST @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/config/;
   ```
4. The endpoint returns the scenarios:
   ```sql
   SELECT $1 AS CONFIG FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/config/agent-demos.json (FILE_FORMAT => 'OPENROUTESERVICE_APP.CORE.JSON_FORMAT');
   ```

## Troubleshooting

| Issue | Fix |
|-------|-----|
| "Object does not exist" for CONFIG tables | `$build-routing-solution` has not completed — run it first. |
| "Unknown function TOOL_PHARMA_CATCHMENT" | `$routing-agent` not run — run it before this skill. |
| Scenarios not appearing in the Agent Playground | `agent-demos.json` not on stage — re-run Step 2. |
| "OPTIMIZATION returned no results" | VROOM service suspended — `CALL OPENROUTESERVICE_APP.CORE.RESUME_ALL_SERVICES()`. |
| "Isochrone geometry is null" | ORS not ready — `SELECT SYSTEM$GET_SERVICE_STATUS('OPENROUTESERVICE_APP.CORE.ORS_SERVICE_SANFRANCISCO');` |

## Cleanup

```sql
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-setup-agent-playground","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

DROP TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_PHARMA_JOBS;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_HEALTH_DEMOGRAPHICS;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_DRUG_FORMULARY;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_TOP_PHARMACIES;
DROP VIEW  IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERIES;
REMOVE @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/config/agent-demos.json;
```

> The 6 fleet CONFIG rows are reset by re-running the relevant deploy skill or
> by manually `UPDATE`-ing them back to the user's preferred defaults.
