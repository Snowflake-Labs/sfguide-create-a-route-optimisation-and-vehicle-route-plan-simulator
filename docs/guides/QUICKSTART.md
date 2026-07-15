# Quickstart Guide

Deploy your first routing solution on Snowflake in 4 steps.

## Overview

This repository contains Cortex Code skills that deploy routing, fleet intelligence, and geospatial analytics on Snowflake. The OpenRouteService (ORS) routing engine and two web apps run as Snowpark Container Services (SPCS).

```
routing-prerequisites → install-fleet-apps → pick a demo skill
```

## Step 1: Check Prerequisites

Open Cortex Code and say:

> "Check my build prerequisites"

This triggers the `routing-prerequisites` skill, which verifies:
- Container runtime (Podman or Docker) is installed
- Snowflake Snow CLI is installed and configured
- Active Snowflake connection with required privileges

## Step 2: Build and Deploy ORS

> "Install the fleet apps"

This triggers the `install-fleet-apps` skill, the primary one-command installer. It will:
1. Create the neutral data contract (`FLEET_APP`) and semantic views
2. Deploy the two apps on SPCS: `FLEET_ADMIN_APP` (build/admin console) and `FLEET_SA_APP` (agent-first analytics)
3. Create the Cortex agents (`FLEET_AGENT`, `FLEET_OPS_AGENT`) and the role-scoped synapse MCP bundles
4. Build and provision the live ORS/VROOM routing engine (by default; add `--no-engine` to skip)

**Time:** ~15-30 minutes depending on region size and compute pool provisioning. Add `--no-engine` for a fast analytics-only install.

**Verify:** All 5 services should show RUNNING:
```sql
SHOW SERVICES IN DATABASE OPENROUTESERVICE_APP;
```

## Step 3: Configure Your Region

> "Change ORS location to London"

This triggers `routing-customization` → `location` subskill, which downloads the correct OSM map and rebuilds the ORS graph.

## Step 4: Deploy a Demo

Pick one (or more) of these demo skills:

The core install already gives you the analytics app and agent. These optional demo skills layer extra datasets and views on top:

| Say this | What you get |
|----------|-------------|
| "Deploy route optimization demo" | VRP simulator with CARTO Marketplace data + notebook |
| "Generate driver locations" | Realistic vehicle fleet telemetry + dashboard |
| "Generate e-bike fleet data" | E-bike fleet simulation |
| "Deploy retail catchment demo" | Retail location analysis with isochrone zones |
| "Deploy route deviation demo" | Detour detection ETL + dashboards |
| "Deploy dwell analysis" | 12-step Dynamic Table pipeline for dwell/congestion |

## Dependency Chain

Not all demos are independent. Here's what depends on what:

```
routing-prerequisites
  └── install-fleet-apps (REQUIRED for everything)
        ├── route-optimization
        ├── retail-catchment
        ├── routing-agent
        ├── travel-time-matrix
        ├── fleet-intelligence-car (also needs routing-customization)
        ├── fleet-intelligence-ebike (also needs routing-customization)
        └── route-deviation (also needs routing-customization)
              └── dwell-analysis (also needs synthetic-datasets-generator output)
```

## Cleanup

When you're done, clean up all created objects:

> "Clean up all skill objects"

This triggers the `routing-solution-cleanup` skill, which discovers all tagged Snowflake objects and generates DROP statements.

## Further Reading

- [AGENTS.md](../../AGENTS.md) - Skill conventions and dependency graph
- [Architecture reference](../ARCHITECTURE.md) - Databases, contracts, the two apps, and the agentic layer
- [Architecture tenets](../../TENETS.md) - Load-bearing invariants of the solution
