# Route Optimisation & Fleet Intelligence on Snowflake

A collection of Cortex Code skills that deploy routing, fleet intelligence, and geospatial analytics solutions on Snowflake — powered by the [OpenRouteService Native App](https://app.snowflake.com/marketplace) running on Snowpark Container Services.

## Prerequisites

- [Cortex Code CLI](https://docs.snowflake.com/en/user-guide/cortex-code) with an active Snowflake connection
- Snowflake account with `ACCOUNTADMIN` or equivalent privileges
- Docker or Podman (required only for building the ORS native app)

## Getting Started

1. Open this repository in Cortex Code
2. Invoke any skill by name — Cortex Code will guide you through the full deployment

All skills live in `.cortex/skills/` and follow the Anthropic skill format. Each skill contains a `SKILL.md` with step-by-step instructions, optional `references/` for detailed SQL/code, and `assets/` for notebooks or other deployable artifacts.

## Skills

### Core Infrastructure

**build-routing-solution** — Builds and deploys the OpenRouteService routing engine as a Snowflake Native App on SPCS. This is the foundational skill — most other skills depend on a running ORS instance. Handles Docker image builds, registry pushes, app package creation, and service startup. Invoke: `build routing solution`.

**routing-prerequisites** — Checks and installs build prerequisites (Docker/Podman, Snow CLI, network access) before building the routing solution. Run this first if you're unsure about your local environment. Invoke: `check build prerequisites`.

**routing-customization** — Changes the ORS deployment configuration: swap map regions, switch vehicle/routing profiles, or read current config. Routes to three subskills (location, routing-profiles, read-ors-configuration). Invoke: `change location` / `change routing profile`.

### Demo Solutions

**route-optimization** — Deploys a route optimization demo with Marketplace data and a Snowflake notebook. Demonstrates the ORS OPTIMIZATION endpoint for vehicle routing problems (VRP) with time windows and capacity constraints. Invoke: `deploy route optimization demo`.

**fleet-intelligence-taxis** — Generates realistic taxi driver GPS telemetry using Overture Maps POIs and ORS road-following routes. Configurable for any city (New York, London, San Francisco, etc.), number of drivers, and shift patterns. Dashboard via ORS Control App. Invoke: `generate driver locations`.

**fleet-intelligence-food-delivery** — Generates food delivery courier telemetry for the SwiftBite solution across California cities. Uses Overture Maps restaurants/POIs, ORS routes, and configurable courier counts. Includes a React native app deployed to SPCS and optional travel-time matrix integration. Invoke: `setup food delivery fleet`.

**retail-catchment** — Deploys a Retail Catchment Analysis using Overture Maps data to analyze store locations, trade areas, and competitive proximity with isochrone-based catchment zones. Dashboard via ORS Control App. Invoke: `deploy retail catchment`.

**route-deviation** — Deploys the Route Deviation Analysis demo: loads synthetic truck telemetry from S3, populates the ORS route cache, and runs a 5-step ETL pipeline for detour detection and analysis. Dashboard via ORS Control App. Invoke: `deploy route deviation`.

**dwell-analysis** — Creates a 12-step Dynamic Table pipeline for dwell and congestion analysis: state detection, dwell sessionization, H3 congestion heatmaps, SLA alerts, facility utilization, and daily trends. Dashboard via ORS Control App. Invoke: `deploy dwell analysis`.

### Advanced

**travel-time-matrix** — Computes travel time matrices across H3 resolutions using ORS MATRIX_TABULAR. Covers hexagon generation, work queue batching, parallel workers, FLATTEN post-processing, and Task DAG orchestration. Integrates with VROOM for optimization. Invoke: `build travel time matrix`.

**routing-agent** — Creates a Snowflake Intelligence agent that wraps ORS routing functions (directions, isochrones, optimization) as Cortex tools. Deploys three Python stored procedures and a CREATE AGENT definition for natural-language route planning. Invoke: `create routing agent`.

### Meta

**skill-optimiser** — Audits, optimizes, and creates Cortex Code skills following Anthropic best practices. Checks SKILL.md structure, description triggers, progressive disclosure, and frontmatter format. Invoke: `audit skill` / `optimize skill`.

## Repository Structure

```
.cortex/skills/          # All 12 Cortex Code skills
  ├── <skill-name>/
  │   ├── SKILL.md       # Skill definition (frontmatter + instructions)
  │   ├── references/    # Detailed SQL, code, and documentation
  │   └── assets/        # Notebooks and other deployable artifacts
build-routing-solution/  # ORS native app build artifacts (Dockerfiles, configs)
archive/                 # Archived materials (hands-on-lab, deprecated code)
```
