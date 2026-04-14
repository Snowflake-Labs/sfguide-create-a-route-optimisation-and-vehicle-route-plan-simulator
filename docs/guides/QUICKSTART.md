# Quickstart Guide

Deploy your first routing solution on Snowflake in 4 steps.

## Overview

This repository contains Cortex Code skills that deploy routing, fleet intelligence, and geospatial analytics on Snowflake using the OpenRouteService (ORS) Native App on Snowpark Container Services (SPCS).

```
routing-prerequisites → build-routing-solution → pick a demo skill
```

## Step 1: Check Prerequisites

Open Cortex Code and say:

> "Check my build prerequisites"

This triggers the `routing-prerequisites` skill, which verifies:
- Container runtime (Podman or Docker) is installed
- Snowflake Snow CLI is installed and configured
- Active Snowflake connection with required privileges

## Step 2: Build and Deploy ORS

> "Build the routing solution"

This triggers the `build-routing-solution` skill. It will:
1. Build Docker images for ORS, VROOM, Gateway, and Downloader and ORS Control App
2. Push images to Snowflake Image Repository
3. Deploy the ORS App on SPCS
4. Download and configure OpenStreetMap data for your region

**Time:** ~15–30 minutes depending on region size and compute pool provisioning.

**Verify:** All 5 services should show RUNNING:
```sql
SHOW SERVICES IN DATABASE OPENROUTESERVICE_APP;
```

## Step 3: Configure Your Region

> "Change ORS location to London"

This triggers `routing-customization` → `location` subskill, which downloads the correct OSM map and rebuilds the ORS graph.

## Step 4: Deploy a Demo

Pick one (or more) of these demo skills:

| Say this | What you get |
|----------|-------------|
| "Deploy route optimization demo" | VRP simulator with CARTO data + Streamlit |
| "Generate taxi driver locations" | Realistic taxi fleet telemetry + Streamlit dashboard |
| "Generate food delivery courier data" | Food delivery simulation + React app |
| "Deploy retail catchment demo" | Retail location analysis with isochrone zones |
| "Deploy route deviation demo" | Detour detection ETL + Streamlit dashboards |
| "Deploy dwell analysis" | 12-step Dynamic Table pipeline for dwell/congestion |

## Dependency Chain

Not all demos are independent. Here's what depends on what:

```
routing-prerequisites
  └── build-routing-solution (REQUIRED for everything)
        ├── route-optimization
        ├── retail-catchment
        ├── routing-agent
        ├── travel-time-matrix
        ├── fleet-intelligence-taxis (also needs routing-customization)
        ├── fleet-intelligence-food-delivery (also needs routing-customization)
        └── route-deviation (also needs routing-customization)
              └── dwell-analysis (also needs synthetic-datasets-generator output)
```

## Cleanup

When you're done, clean up all created objects:

> "Clean up all skill objects"

This triggers the `routing-solution-cleanup` skill, which discovers all tagged Snowflake objects and generates DROP statements.

## Further Reading

- [AGENTS.md](../../AGENTS.md) — Skill conventions and dependency graph
- [Skill Audit Report](../dev/AUDIT-REPORT.md) — Full skill quality audit
