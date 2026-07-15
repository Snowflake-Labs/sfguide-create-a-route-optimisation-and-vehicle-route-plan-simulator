---
name: setup-agent-playground
description: "Deploy industry-agnostic SF demo data tables required by the Agent Playground's catchment/delivery/network scenarios (TOOL_NETWORK_OPTIMIZATION, TOOL_DELIVERY_OPTIMIZATION, TOOL_CATCHMENT). Run AFTER $install-fleet-apps and $routing-agent. Creates DEMO_DELIVERY_STOPS (30), DEMO_AREA_DEMOGRAPHICS (55), DEMO_DEMAND_CATALOG (25), DEMO_KEY_SITES (6), DEMO_DEPOT (1), the FOOD_DELIVERY DELIVERIES view, updates the 6 fleet CONFIG tables to SanFrancisco/ebike defaults, and uploads agent-demos.json to the ORS stage. Triggers: setup agent playground, install agent demo data, deploy demo data, missing demo data, agent playground scenarios missing, agent-demos.json missing, catchment demo, delivery optimization demo, network optimization demo, DEMO_DELIVERY_STOPS, DEMO_AREA_DEMOGRAPHICS, DEMO_DEMAND_CATALOG, DEMO_KEY_SITES."
depends_on:
  - install-fleet-apps
  - routing-agent
metadata:
  author: Snowflake SIT-IS
  version: 1.0.0
  category: demo-setup
---

# Setup Agent Playground

> **Deprecated (demo-data seeding):** As of the dynamic-tools change, the three
> demo tools (`TOOL_CATCHMENT`, `TOOL_DELIVERY_OPTIMIZATION`,
> `TOOL_NETWORK_OPTIMIZATION`) source **live, region-scoped Overture data**
> (`FLEET_INTELLIGENCE.CATCHMENT.POIS` / `REGIONAL_ADDRESSES`, BOUNDARY-constrained
> and routable-filtered) and read the active region from
> `FLEET_INTELLIGENCE.CATCHMENT.CONFIG`. They **no longer read the static `DEMO_*`
> tables**. A fresh `install-fleet-apps` already uploads `agent-demos.json` (step
> 4.6), so this skill is needed **only** to re-upload `agent-demos.json` standalone.
>
> **Retired (universal generation):** The static `DEMO_*` tables are fully
> superseded and should NOT be seeded for new deployments. Their content is now
> produced, region-scoped and config-driven, by Data Studio's universal-generation
> engines (Overture + free Marketplace) and read via `V_*_CURRENT` projection views:
>
> | Legacy static table | Universal-generation replacement |
> |---|---|
> | `DEMO_KEY_SITES`, `DEMO_DELIVERY_STOPS`, `DEMO_DEPOT` | `SYNTHETIC_DATASETS.UNIFIED.V_DIM_ANCHORS_CURRENT` (`ANCHOR_TYPE` = KEY_SITE / DELIVERY_STOP / DEPOT) |
> | `DEMO_AREA_DEMOGRAPHICS` | `SYNTHETIC_DATASETS.UNIFIED.V_DIM_AREA_DEMOGRAPHICS_CURRENT` (SafeGraph Open Census) |
> | `DEMO_DEMAND_CATALOG` | `SYNTHETIC_DATASETS.UNIFIED.V_DIM_DEMAND_CATALOG_CURRENT` (neutral category tiers) |
>
> `references/deploy-demo-data.sql` is retained only for legacy standalone demos
> that still hard-reference `DEMO_*`; it is not part of the `install-fleet-apps`
> path and is slated for deletion once no demo references it.

Deploys the industry-agnostic SF catchment/delivery/network demo data and uploads the
Agent Playground scenario config (`agent-demos.json`) to the ORS stage. After
this skill runs, the Routing Agent's three demo tools (`TOOL_NETWORK_OPTIMIZATION`,
`TOOL_DELIVERY_OPTIMIZATION`, `TOOL_CATCHMENT`) become functional and the
control-app Agent Playground page shows all three scenarios (Catchment &
Delivery, Site & Catchment, Fleet Logistics).

> **Important:** The demo stored procedures themselves are created by
> `$routing-agent`. This skill only seeds the data tables and uploads the
> scenario config - it does NOT create procedures.

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `DATABASE` | `FLEET_INTELLIGENCE` | Demo database (created by install-fleet-apps) |
| `DATA_SCHEMA` | `ROUTE_OPTIMIZATION` | Schema that holds the demo data tables |
| `WAREHOUSE` | `ROUTING_ANALYTICS` | Warehouse for setup statements |
| `STAGE` | `OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE` | Stage receiving `agent-demos.json` |
| `REGION` | `SanFrancisco` | Region the demo data is geocoded for |
| `VEHICLE_TYPE` | `ebike` | Default vehicle for the 6 fleet CONFIG tables |

## Prerequisites

- `$install-fleet-apps` deployed (creates `OPENROUTESERVICE_APP`,
  `ORS_SPCS_STAGE`, the 6 fleet CONFIG tables, and the SanFrancisco region).
- `$routing-agent` deployed (creates the 3 demo stored procedures along with
  the multi-region tools).
- A role that can read/write the schemas listed in **Required Privileges**.

## Required Privileges

| Privilege | Scope | Reason |
|-----------|-------|--------|
| USAGE | DATABASE FLEET_INTELLIGENCE | Access the fleet schemas |
| USAGE | SCHEMA FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION | Create the demo data tables |
| CREATE TABLE | SCHEMA FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION | Create the demo data tables |
| INSERT, UPDATE | All 6 CONFIG tables | Update vehicle/region defaults |
| CREATE VIEW | SCHEMA FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_EBIKE | Create DELIVERIES view |
| USAGE | DATABASE OPENROUTESERVICE_APP | Upload agent-demos.json to stage |
| WRITE | STAGE OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE | PUT agent-demos.json |
| CREATE FILE FORMAT | SCHEMA OPENROUTESERVICE_APP.CORE | Create JSON_FORMAT (idempotent) |

> **Note:** ACCOUNTADMIN is **not** required. Use a role with the privileges
> above, or escalate to ACCOUNTADMIN only for the duration of this skill.

## Error Logging

> Follow the Error Logging convention in AGENTS.md. Log file prefix:
> `setup-agent-playground`.

## Step 1 - Run the SQL pipeline

Execute every statement in `references/deploy-demo-data.sql` end-to-end. The
file:

1. Sets the session `query_tag`.
2. Updates the 6 fleet CONFIG tables to `VEHICLE_TYPE = 'ebike'` and
   `REGION = 'SanFrancisco'`.
3. Creates the `FLEET_INTELLIGENCE_EBIKE.DELIVERIES` view.
4. Creates and seeds the demo data tables:
   - `FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.DEMO_DELIVERY_STOPS` (30 rows)
   - `FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.DEMO_AREA_DEMOGRAPHICS` (55 rows)
   - `FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.DEMO_DEMAND_CATALOG` (25 rows)
   - `FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.DEMO_KEY_SITES` (6 rows)
   - `FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.DEMO_DEPOT` (1 row - depot + region)
5. Creates `OPENROUTESERVICE_APP.CORE.JSON_FORMAT` (idempotent).

Every CREATE statement carries the standard `oss-setup-agent-playground`
COMMENT tracking tag.

## Step 2 - Upload `agent-demos.json` to the ORS stage

The Agent Playground's `/api/agent/config` endpoint reads scenarios from
`@OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/config/agent-demos.json`. Upload it
from the repo:

```bash
snow stage copy \
  .cortex/skills/install-fleet-apps/openrouteservice_app/config/agent-demos.json \
  @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/config/ \
  --overwrite \
  -c <connection>
```

Or from a Workspace, via SQL:

```sql
COPY FILES INTO @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/config/
FROM 'snow://workspace/USER$.PUBLIC."<workspace-name>"/versions/live/.cortex/skills/install-fleet-apps/openrouteservice_app/config/'
FILES=('agent-demos.json');
```

## Verification

After both steps complete, all of the following must be true:

1. 6 CONFIG tables updated:
   ```sql
   SELECT 'FLEET_INTELLIGENCE_EBIKE' AS NAME, REGION, VEHICLE_TYPE FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_EBIKE.CONFIG
   UNION ALL SELECT 'FLEET_INTELLIGENCE_CAR',          REGION, VEHICLE_TYPE FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_CAR.CONFIG
   UNION ALL SELECT 'DWELL_ANALYSIS',                    REGION, VEHICLE_TYPE FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.CONFIG
   UNION ALL SELECT 'ROUTE_DEVIATION',                   REGION, VEHICLE_TYPE FROM FLEET_INTELLIGENCE.ROUTE_DEVIATION.CONFIG
   UNION ALL SELECT 'ROUTE_OPTIMIZATION',                REGION, VEHICLE_TYPE FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG
   UNION ALL SELECT 'CATCHMENT',                  REGION, VEHICLE_TYPE FROM FLEET_INTELLIGENCE.CATCHMENT.CONFIG;
   ```
2. Demo data tables with correct row counts:
   ```sql
   SELECT 'DEMO_DELIVERY_STOPS' AS TBL, COUNT(*) AS CNT FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.DEMO_DELIVERY_STOPS
   UNION ALL SELECT 'DEMO_AREA_DEMOGRAPHICS', COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.DEMO_AREA_DEMOGRAPHICS
   UNION ALL SELECT 'DEMO_DEMAND_CATALOG',    COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.DEMO_DEMAND_CATALOG
   UNION ALL SELECT 'DEMO_KEY_SITES',         COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.DEMO_KEY_SITES
   UNION ALL SELECT 'DEMO_DEPOT',             COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.DEMO_DEPOT;
   ```
   Expected counts: 30, 55, 25, 6, 1.
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
| "Object does not exist" for CONFIG tables | `$install-fleet-apps` has not completed - run it first. |
| "Unknown function TOOL_CATCHMENT" | `$routing-agent` not run - run it before this skill. |
| Scenarios not appearing in the Agent Playground | `agent-demos.json` not on stage - re-run Step 2. |
| "OPTIMIZATION returned no results" | VROOM service suspended - `CALL OPENROUTESERVICE_APP.CORE.RESUME_ALL_SERVICES()`. |
| "Isochrone geometry is null" | ORS not ready - `SELECT SYSTEM$GET_SERVICE_STATUS('OPENROUTESERVICE_APP.CORE.ORS_SERVICE_SANFRANCISCO');` |

## Cleanup

```sql
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-setup-agent-playground","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

DROP TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.DEMO_DELIVERY_STOPS;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.DEMO_AREA_DEMOGRAPHICS;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.DEMO_DEMAND_CATALOG;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.DEMO_KEY_SITES;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.DEMO_DEPOT;
DROP VIEW  IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_EBIKE.DELIVERIES;
REMOVE @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/config/agent-demos.json;
```

> The 6 fleet CONFIG rows are reset by re-running the relevant deploy skill or
> by manually `UPDATE`-ing them back to the user's preferred defaults.
