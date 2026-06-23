---
name: install-fleet-apps
description: "Primary one-command installer for the new synapse-based, vehicle/industry-AGNOSTIC fleet analytics architecture on Snowflake: the FLEET_SA_APP consumer app, the FLEET_ADMIN_APP build console, the three role-scoped synapse MCP tool bundles, the neutral FLEET_APP data contract, roles, and Cortex agents. Use when: install the fleet apps, deploy FLEET_SA_APP and FLEET_ADMIN_APP, set up the agnostic fleet analytics solution, install the synapse fleet stack, deploy the new fleet architecture. Self-owning and idempotent: detects-and-reuses-else-creates SPCS infra, seed data, and the ORS engine, so it does not require the build-routing-solution workflow to have run. Do NOT use for: provisioning the raw ORS/VROOM routing engine itself (that is delegated to build-routing-solution), changing routing maps/profiles (use routing-customization), or the legacy per-vehicle demo skills (fleet-intelligence-taxis, route-deviation, etc.). Triggers: install fleet apps, install-fleet-apps, deploy fleet sa app, deploy fleet admin app, install synapse fleet stack, set up agnostic fleet solution, new fleet architecture installer."
depends_on:
  - routing-prerequisites
metadata:
  author: Snowflake SIT-IS
  version: 1.0.0
  category: infrastructure
---

# Install Fleet Apps (primary agnostic installer)

One command stands up the entire new-architecture analytics stack and is the **primary** installation path for it. `build-routing-solution` is a **secondary, delegated** component used only to provision the live ORS/VROOM routing engine when one is not already present.

This skill **owns** its artifacts (relocated here, not referenced from `build-routing-solution`), so the analytics stack keeps installing and running even if `build-routing-solution` and the legacy control app are deprecated. Only live routing verbs depend on an external ORS engine; dashboards, Cortex Analyst, and the agents work without it.

## Scope: vehicle/industry-AGNOSTIC only

This installer is mode-agnostic by construction. `VEHICLE_TYPE` is a data dimension carried by the selected dataset — never a schema, view, semantic view, agent tool, or UI surface. The R6 `fleet_sa_app/app/packs/BUSINESS_PROBLEM_TAXONOMY.md` (status: locked) is the authoritative contract.

| Layer | INSTALLED (agnostic) | EXCLUDED (industry-vertical) |
|---|---|---|
| Packs | `unified_fleet`, `fleet_ops`, `dwell`, `route_deviation`, `route_optimization`, `catchment`, `starter` | `marketplace`, `backload`, `dhl_ntbo` |
| UI views | Fleet/Asset Status, Asset Map, Demand Density (H3), Trip Inspection, Operator Performance, Top Origins, Dwell & Congestion, Route Deviation, Asset Utilization, VRP, Catchment | Freight Marketplace, Backload Matching, DHL pages |
| Agents | `SV_FLEET_OPS`, `SV_DWELL_ANALYTICS`, `SV_ROUTE_DEVIATION`, `SV_ASSET_VELOCITY`, `SV_CATCHMENT` + neutral routing verbs | `SV_FREIGHT_MARKETPLACE`, `SV_BACKLOAD_MATCHING`, `SV_DHL_BACKLOAD` |
| Seed data | `SYNTHETIC_DATASETS.UNIFIED.*` / `NEUTRAL.*`, `FLEET_INTELLIGENCE.CORE`, DWELL/DEVIATION/ROUTE_OPT CONFIG, `CATCHMENT` base tables | freight offers/partners, DHL tables |

The installer always installs the **complete** agnostic set — there is no per-use-case selection prompt.

## Execution Rules

1. All relative paths are relative to this skill's directory (`.cortex/skills/install-fleet-apps/`).
2. Replace `<connection>` with the active Snowflake CLI connection. Find it via `snow connection list` (or read `~/.snowflake/connections.toml`) and verify with `snow sql -q "SELECT CURRENT_ACCOUNT()" -c <connection>`.
3. The installer is **idempotent**: re-running detects existing objects and reuses them. Use per-layer `SKIP_*` env vars only to shorten re-runs.
4. Every object created carries the `oss-install-fleet-apps` COMMENT tag; every session sets the `query_tag` (see `references/conventions.md`).
5. After a run, always emit a friction log to `logs/` per the repo `AGENTS.md`.

## Prerequisites

- Container runtime (Podman or Docker) running; Node.js >= 20 + npm; Python 3; Snowflake CLI (`snow`).
- `export SNOWFLAKE_CLI_NO_UPDATE_CHECK=true`.
- An active connection whose role can create databases, schemas, services, compute pools, image repositories, external access integrations, roles, and agents (see `## Required Privileges`).
- Repository cloned; the four Carto/Overture Marketplace shares are optional (basemap egress is via the CARTO EAI).

## One-command install

```bash
bash .cortex/skills/install-fleet-apps/scripts/install_fleet_apps.sh --connection <connection>
```

The orchestrator runs these layers in order (detect-and-reuse-else-create throughout):

1. **Preflight** — tools, connection, account.
2. **Infra** — image repository, compute pool, CARTO EAI (+ network rule), spec stage. Reuses `OPENROUTESERVICE_APP` equivalents if present; otherwise creates skill-owned objects. See `references/infra.sql`.
3. **Data** — probes the agnostic source tables; reuses existing rows, else loads `scripts/seed_data.sql`. See `references/seed-data.md`.
4. **Data contract** — `python3 fleet_sa_app/app/packs/_lib/install.py --regenerate -c <connection>` builds the 7 agnostic `FLEET_APP.*` packs; `--probe` confirms each resolves.
5. **Synapse tools** — per-account materialize + deploy of the `user`/`ops`/`admin` bundles (`ROUTING_MCP`, `FLEET_OPS_MCP`, `FLEET_ADMIN_MCP`). See `references/synapse-bundles.md`.
6. **Roles** — applies `fleet_sa_app/app/role_binding.sql` (agnostic grants only).
7. **Agents** — `CREATE OR REPLACE AGENT FLEET_AGENT` (consumer) + `FLEET_OPS_AGENT` (ops) from the trimmed specs.
8. **Apps** — `scripts/deploy_fleet_sa_app.sh` and `scripts/deploy_fleet_admin_app.sh`; prints both endpoint URLs.
9. **Routing engine** — probes `ROUTING_PLATFORM.CONTRACT.ROUTING_STATUS()`; binds verbs LIVE if present, else delegates to `build-routing-solution` (or installs verbs inert). See `references/routing-engine.md`.

## Configuration

| Parameter | Default | Purpose |
|---|---|---|
| `--connection` | (required) | Snow CLI connection name |
| `IMAGE_REPO_SQL_NAME` | resolved (reuse `OPENROUTESERVICE_APP.core.image_repository` else `FLEET_INTELLIGENCE.CORE.IMAGE_REPOSITORY`) | SPCS image repo |
| `COMPUTE_POOL` | resolved (`OPENROUTESERVICE_APP_COMPUTE_POOL` else `FLEET_APPS_COMPUTE_POOL`) | SPCS compute pool |
| `CARTO_EAI` | resolved (`ORS_CARTO_EAI` else `FLEET_APP_CARTO_EAI`) | basemap tile egress |
| `SPEC_STAGE` | resolved | service-spec stage |
| `REGION` | `SanFrancisco` | seed-data region when seeding is required |
| `SKIP_INFRA` / `SKIP_DATA` / `SKIP_PACKS` / `SKIP_TOOLS` / `SKIP_ROLES` / `SKIP_AGENTS` / `SKIP_APPS` / `SKIP_ROUTING` | `0` | shorten idempotent re-runs |

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
-- Self-provisioned infra (only if this skill created them):
DROP EXTERNAL ACCESS INTEGRATION IF EXISTS FLEET_APP_CARTO_EAI;
DROP COMPUTE POOL IF EXISTS FLEET_APPS_COMPUTE_POOL;
-- FLEET_INTELLIGENCE / SYNTHETIC_DATASETS / ROUTING_PLATFORM are shared with the
-- routing engine; drop only on a full teardown.
```

> Use the `routing-solution-cleanup` skill to auto-discover all tagged objects via COMMENT tracking.

## References

- `references/conventions.md` — query_tag + COMMENT tracking literals.
- `references/infra.sql` — detect-and-reuse-else-create infra provisioning.
- `references/seed-data.md` — agnostic seed-data probe + load path.
- `references/synapse-bundles.md` — per-account materialize + deploy.
- `references/routing-engine.md` — engine detection + delegation to build-routing-solution.
- `PHASE_C_PLAN.md` — optional future work: absorb the ORS engine build substrate so build-routing-solution becomes deletable (run in a fresh context).
- `fleet_sa_app/app/packs/BUSINESS_PROBLEM_TAXONOMY.md` — the locked agnostic contract.
