---
name: install-fleet-apps
description: "Primary one-command installer for the synapse-based, vehicle/industry-AGNOSTIC fleet analytics architecture on Snowflake: the FLEET_SA_APP consumer app, the FLEET_ADMIN_APP build console, the three role-scoped synapse MCP tool bundles, the neutral FLEET_APP data contract, roles, Cortex agents, and (by default) the live ORS/VROOM routing engine. Use when: install the fleet apps, deploy FLEET_SA_APP and FLEET_ADMIN_APP, set up the agnostic fleet analytics solution, install the synapse fleet stack, provision the routing engine. Self-owning and idempotent: detects-and-reuses-else-creates SPCS infra, seed data, and the ORS engine; pass --no-engine to skip the heavy engine build. Do NOT use for: changing routing maps/profiles (use routing-customization) or the legacy per-vehicle demo skills (fleet-intelligence-car, route-deviation, etc.). Triggers: install fleet apps, install-fleet-apps, deploy fleet sa app, deploy fleet admin app, install synapse fleet stack, set up agnostic fleet solution, provision routing engine, no-engine."
depends_on:
  - routing-prerequisites
metadata:
  author: Snowflake SIT-IS
  version: 1.0.0
  category: infrastructure
---

# Install Fleet Apps (primary agnostic installer)

One command stands up the entire new-architecture analytics stack and is the **primary** installation path for it. It also **owns the live ORS/VROOM routing engine build** (Phase C): the engine is provisioned natively **by default**, so this skill is fully self-contained. Pass `--no-engine` to skip the heavy engine build.

This skill **owns** all of its artifacts (relocated here), so the stack installs and runs without any other skill. The analytics layer (dashboards, Cortex Analyst, agents) works with no engine; live routing verbs require the ORS engine, which the installer builds and provisions by default (skip with `--no-engine`).

## Scope: vehicle/industry-AGNOSTIC only

This installer is mode-agnostic by construction. `VEHICLE_TYPE` is a data dimension carried by the selected dataset - never a schema, view, semantic view, agent tool, or UI surface. The R6 `fleet_sa_app/app/packs/BUSINESS_PROBLEM_TAXONOMY.md` (status: locked) is the authoritative contract.

| Layer | INSTALLED (agnostic) | EXCLUDED (industry-vertical) |
|---|---|---|
| Packs | `unified_fleet`, `fleet_ops`, `dwell`, `route_deviation`, `route_optimization`, `catchment`, `starter` | `marketplace`, `backload`, `dhl_ntbo` |
| UI views | Fleet/Asset Status, Asset Map, Demand Density (H3), Trip Inspection, Operator Performance, Top Origins, Dwell & Congestion, Route Deviation, Asset Utilization, VRP, Catchment | Freight Marketplace, Backload Matching, DHL pages |
| Agents | `SV_FLEET_OPS`, `SV_DWELL_ANALYTICS`, `SV_ROUTE_DEVIATION`, `SV_ASSET_VELOCITY`, `SV_CATCHMENT` + neutral routing verbs | `SV_DELIVERIES`, `SV_BACKLOAD_MATCHING`, `SV_DHL_BACKLOAD` |
| Seed data | `SYNTHETIC_DATASETS.UNIFIED.*` / `NEUTRAL.*`, `FLEET_INTELLIGENCE.CORE`, DWELL/DEVIATION/ROUTE_OPT CONFIG, `CATCHMENT` base tables | freight offers/partners, DHL tables |

The installer always installs the **complete** agnostic set - there is no per-use-case selection prompt.

> **Agent Playground demo tools are dynamic.** The `TOOL_CATCHMENT`,
> `TOOL_DELIVERY_OPTIMIZATION`, and `TOOL_NETWORK_OPTIMIZATION` procs source live,
> region-scoped Overture POIs (`FLEET_INTELLIGENCE.CATCHMENT.POIS` /
> `REGIONAL_ADDRESSES`, BOUNDARY-constrained + routable-filtered) and read the
> active region from `CATCHMENT.CONFIG` - no static demo seed is required. Step 4.6
> uploads the region-neutral `agent-demos.json` scenario config to the ORS stage
> (engine-present only; skip with `SKIP_DEMO=1`).

## Execution Rules

1. All relative paths are relative to this skill's directory (`.cortex/skills/install-fleet-apps/`).
2. Replace `<connection>` with the active Snowflake CLI connection. Find it via `snow connection list` (or read `~/.snowflake/connections.toml`) and verify with `snow sql -q "SELECT CURRENT_ACCOUNT()" -c <connection>`.
3. The installer is **idempotent**: re-running detects existing objects and reuses them. Use per-layer `SKIP_*` env vars only to shorten re-runs.
4. Every object created carries the `oss-install-fleet-apps` COMMENT tag; every session sets the `query_tag` (see `references/conventions.md`).
5. After a run, always emit a friction log to `logs/` per the repo `AGENTS.md`.

## Prerequisites

- Container runtime (Podman or Docker) running; Node.js >= 20 + npm; Python 3; Snowflake CLI (`snow`).
  - The engine build (on by default) auto-detects **docker first** (a default 2 GB podman machine OOMs the ORS image build). Force a runtime with `CONTAINER_CMD=docker|podman`.
  - Install **crane** (`brew install crane`) for reliable SPCS image pushes - `docker push` to the SPCS registry intermittently hangs on the final manifest commit; `build_push` prefers crane when present (docker runtime). Disable with `USE_CRANE_PUSH=0`.
- `export SNOWFLAKE_CLI_NO_UPDATE_CHECK=true`.
- An active connection whose role can create databases, schemas, services, compute pools, image repositories, external access integrations, roles, and agents (see `## Required Privileges`).
- Repository cloned; the four Carto/Overture Marketplace shares are optional (basemap egress is via the CARTO EAI).

## One-command install

```bash
bash .cortex/skills/install-fleet-apps/scripts/install_fleet_apps.sh --connection <connection>
```

The orchestrator runs these layers in order (detect-and-reuse-else-create throughout):

1. **Preflight** - tools, connection, account.
2. **Infra** - image repository, compute pool, CARTO EAI (+ network rule), spec stage. Reuses `OPENROUTESERVICE_APP` equivalents if present; otherwise creates skill-owned objects. See `references/infra.sql`.
3. **Data** - probes the agnostic source tables; reuses existing rows, else loads `scripts/seed_data.sql`. See `references/seed-data.md`.
3.5. **SAP mock landscape** - always lands a tiny, static `MOCK_SAP` (EAM/SD: EQUI/IFLOT/LIKP/LIPS) + `MOCK_TELEMATICS` (GPS) example so the `sap-fleet-connector` demo (introspection/discovery) has data in an account with no real SAP. Runs `.cortex/skills/sap-fleet-connector/scripts/mock_sap_seed.sql` (pure static INSERTs - NOT a Data Studio generator), raw tables only (does NOT bind `FLEET_APP` to SAP), idempotent, best-effort (a WARN never aborts). Not gated by `SKIP_DATA`.
4. **Analytic layer** - authors the agnostic `FLEET_INTELLIGENCE.*` objects the packs read but do not build themselves: `DWELL_ANALYSIS.CONFIG`, `ROUTE_DEVIATION` CONFIG + projection views + `TRIP_DEVIATION_ANALYSIS` (a plain VIEW, no DT refresh), the `ROUTE_OPTIMIZATION.CONFIG` cost-column safety-net, and the Overture-sourced `CATCHMENT` tables (`POIS`/`CITIES_BY_STATE`/`REGIONAL_ADDRESSES` with real address/city/state/postcode - the installer acquires the two Overture Marketplace listings idempotently). Runs `scripts/analytic_layer.sql`, best-effort (a catchment failure never aborts the install); gate off with `SKIP_ANALYTIC=1`.
5. **Data contract** - `python3 fleet_sa_app/app/packs/_lib/install.py --regenerate -c <connection>` builds the 7 agnostic `FLEET_APP.*` packs; `--probe` confirms each resolves.
5.5. **Semantic views** - `fleet_sa_app/app/semantic_views.sql` creates `FLEET_INTELLIGENCE.SEMANTIC` + the 5 Cortex Analyst SVs the consumer agent binds to (`SV_FLEET_OPS`, `SV_ROUTE_DEVIATION`, `SV_CATCHMENT`, `SV_DWELL_ANALYTICS`, `SV_ASSET_VELOCITY`). DWELL/ASSET_VELOCITY are rebound onto the pack-built `FLEET_APP.*` views; the rest bind the analytic-layer objects. Runs after packs + analytic layer, before roles/agents (so the role grant and the agent's Cortex Analyst tools resolve). Best-effort; gate off with `SKIP_SEMANTIC=1`.
6. **Synapse tools** - per-account materialize + deploy of the `user`/`ops`/`admin` bundles (`ROUTING_MCP`, `FLEET_OPS_MCP`, `FLEET_ADMIN_MCP`). See `references/synapse-bundles.md`.
7. **Roles** - applies `fleet_sa_app/app/role_binding.sql` (agnostic grants only).
8. **Agents** - `CREATE OR REPLACE AGENT FLEET_AGENT` (consumer) + `FLEET_OPS_AGENT` (ops) from the trimmed specs.
9. **Apps** - `scripts/deploy_fleet_sa_app.sh` and `scripts/deploy_fleet_admin_app.sh`; prints both endpoint URLs.
10. **Routing engine + tool substrate** - probes `ROUTING_PLATFORM.CONTRACT.ROUTING_STATUS()` / `SHOW SERVICES IN DATABASE OPENROUTESERVICE_APP`; binds verbs LIVE if the engine is present. If absent (and not `--no-engine`), builds + provisions it natively via `scripts/provision_engine.sh`; with `--no-engine` the verbs install inert. Then applies the engine-agnostic routing contract (`routing_platform/setup.sql`) and the 9 `FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_*` procedures (from `routing-agent/references/deploy-agent.sql`) that the synapse routing verbs wrap - without this substrate every `FLEET_AGENT` routing request fails ("routing service experiencing issues") even with a healthy engine. The installer asserts all 9 `TOOL_*` procs exist and warns loudly if any are missing. See `references/routing-engine.md`.

## Live routing engine (default; skip with `--no-engine`)

Live routing verbs (directions, isochrones, matrix, VRP optimization, find_poi, catchment) require the ORS/VROOM engine. The analytics stack installs and runs without it; by default the installer builds + provisions the engine in the same run. To skip the heavy engine build (routing verbs install inert):

```bash
bash .cortex/skills/install-fleet-apps/scripts/install_fleet_apps.sh --connection <connection> --no-engine
```

The engine build is HEAVY (builds 4 SPCS images + a region routing graph, tens of minutes) but runs by default and is skipped automatically when an engine is already present. `provision_engine.sh` ensures the `OPENROUTESERVICE_APP.CORE` infra, builds + pushes the 4 engine images (`references/build-images.md`), stages the map/config + service specs, loads SQL modules `01-08`/`15`, and lets module `03` bootstrap the default region. The engine keeps the `OPENROUTESERVICE_APP.CORE` namespace behind the `ROUTING_PLATFORM.CONTRACT` seam, and preserves the AUTO_SUSPEND_SECS, REBUILD_GRAPHS reuse, and per-region VROOM invariants (see `references/available-functions.md`, `references/snowflake-scripting-guidelines.md`, `references/snowflake-sql-gotchas.md`, `references/troubleshooting.md`).

## Configuration

| Parameter | Default | Purpose |
|---|---|---|
| `--connection` | (required) | Snow CLI connection name |
| `--no-engine` | (unset; engine on) | Skip the heavy ORS engine build (verbs install inert). Env equivalents: `NO_ENGINE=1` or `PROVISION_ENGINE=0`. `--with-engine` is accepted as a no-op (engine is the default). |
| `IMAGE_REPO_SQL_NAME` | resolved (reuse `OPENROUTESERVICE_APP.core.image_repository` else `FLEET_INTELLIGENCE.CORE.IMAGE_REPOSITORY`) | SPCS image repo |
| `COMPUTE_POOL` | resolved (`OPENROUTESERVICE_APP_COMPUTE_POOL` else `FLEET_APPS_COMPUTE_POOL`) | SPCS compute pool |
| `CARTO_EAI` | resolved (`ORS_CARTO_EAI` else `FLEET_APP_CARTO_EAI`) | basemap tile egress |
| `SPEC_STAGE` | resolved | service-spec stage |
| `REGION` | `SanFrancisco` | seed-data region when seeding is required |
| `SKIP_INFRA` / `SKIP_DATA` / `SKIP_ANALYTIC` / `SKIP_PACKS` / `SKIP_SEMANTIC` / `SKIP_TOOLS` / `SKIP_ROLES` / `SKIP_AGENTS` / `SKIP_APPS` / `SKIP_ROUTING` | `0` | shorten idempotent re-runs |

## Required Privileges

| Privilege | Scope | Why |
|---|---|---|
| CREATE DATABASE / SCHEMA | account | `FLEET_INTELLIGENCE`, `FLEET_APP`, `STARTER_APP`, `ROUTING_PLATFORM` if absent |
| CREATE COMPUTE POOL | account | app compute pool when self-provisioned |
| CREATE IMAGE REPOSITORY | schema | push app images when self-provisioned |
| CREATE INTEGRATION | account | CARTO external access integration when self-provisioned |
| CREATE SERVICE | schema | `FLEET_SA_APP`, `FLEET_ADMIN_APP` |
| CREATE ROLE + MANAGE GRANTS | account | `FLEET_APP_USER/OPS/ADMIN`, `FLEET_APP_DYNAMIC_READER` |
| CREATE AGENT, CREATE MCP SERVER | schema | consumer/ops agents + synapse bundles |
| SNOWFLAKE.CORTEX_USER | database role | Cortex Analyst / agent calls |

ACCOUNTADMIN satisfies all of the above but is not required if the above are granted to a custom role.

## Cleanup

```sql
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

DROP SERVICE IF EXISTS FLEET_INTELLIGENCE.SYNAPSE_USER.FLEET_SA_APP;
DROP SERVICE IF EXISTS FLEET_INTELLIGENCE.SYNAPSE_USER.FLEET_ADMIN_APP;
DROP AGENT  IF EXISTS FLEET_INTELLIGENCE.SYNAPSE_USER.FLEET_AGENT;
DROP AGENT  IF EXISTS FLEET_INTELLIGENCE.SYNAPSE_USER.FLEET_OPS_AGENT;
DROP DATABASE IF EXISTS FLEET_APP;
DROP DATABASE IF EXISTS STARTER_APP;
-- SAP mock landscape (demo example landed by step 3.5):
DROP DATABASE IF EXISTS MOCK_SAP;
DROP DATABASE IF EXISTS MOCK_TELEMATICS;
-- Self-provisioned infra (only if this skill created them):
DROP EXTERNAL ACCESS INTEGRATION IF EXISTS FLEET_APP_CARTO_EAI;
DROP COMPUTE POOL IF EXISTS FLEET_APPS_COMPUTE_POOL;
-- FLEET_INTELLIGENCE / SYNTHETIC_DATASETS / ROUTING_PLATFORM are shared with the
-- routing engine; drop only on a full teardown.
```

> Use the `routing-solution-cleanup` skill to auto-discover all tagged objects via COMMENT tracking.

## Object ownership (analytic layer)

The agnostic `FLEET_INTELLIGENCE.*` analytic objects the packs read are owned by skill SQL and authored in the data + analytic steps, in this order:

- `scripts/seed_data.sql` - ensures `ROUTING_ANALYTICS`, the engine-namespace stubs the loader needs (`OPENROUTESERVICE_APP.CORE` + `REGION_CATALOG`), and the `ROUTE_OPTIMIZATION` base tables, then runs the canonical loader (`UNIFIED.*` + `DIM_DATASETS`).
- `scripts/vehicle_profile_catalog.sql` - `DIM_VEHICLE_PROFILE` / `DIM_VEHICLE_DWELL_SLA` + the `DIM_FLEET` asset-column stamp.
- `scripts/projection_views.sql` - the dataset-scoped `SYNTHETIC_DATASETS.UNIFIED.V_*_CURRENT` views.
- `scripts/analytic_layer.sql` (step 3.5) - `DWELL_ANALYSIS.CONFIG`, `ROUTE_DEVIATION` CONFIG + projection views + `TRIP_DEVIATION_ANALYSIS` (a plain VIEW), the `ROUTE_OPTIMIZATION.CONFIG` cost-column safety-net, and the Overture-sourced `CATCHMENT` tables.

These skill SQL files are the single source of truth for a fresh install. The new admin app's `fleet_admin_app/ui/src/server/lib/init.ts` is a secondary, idempotent runtime owner that overlaps only on the `V_*_CURRENT` projection views (kept consistent with `projection_views.sql` by design); its legacy DWELL asset-velocity views are gated on `DWELL_ANALYSIS.DT_DWELL_ENRICHED` (absent on the agnostic install → skipped) and its `MARKETPLACE`/`BACKLOAD` creations reference purged tables → best-effort skip, so init.ts never clobbers the agnostic analytic layer. The legacy `build-routing-solution` Vite control app (which had its own `init.ts`) has been removed from the repo.

## References

- `references/conventions.md` - query_tag + COMMENT tracking literals.
- `references/infra.sql` - detect-and-reuse-else-create infra provisioning.
- `references/seed-data.md` - agnostic seed-data probe + load path.
- `references/synapse-bundles.md` - per-account materialize + deploy.
- `references/routing-engine.md` - engine detection + native provisioning (default; skip with `--no-engine`).
- `references/build-images.md` - build + push the 4 ORS/VROOM engine images.
- `references/available-functions.md` - engine SQL functions, profiles, service limits, matrix builders.
- `references/snowflake-scripting-guidelines.md` - SQL Scripting rules for the engine modules.
- `references/snowflake-sql-gotchas.md` - engine SQL constraints (GET_SERVICE_STATUS, RESULT_SCAN, etc.).
- `references/troubleshooting.md` - engine image build / registry / service troubleshooting.
- `fleet_sa_app/app/packs/BUSINESS_PROBLEM_TAXONOMY.md` - the locked agnostic contract.
