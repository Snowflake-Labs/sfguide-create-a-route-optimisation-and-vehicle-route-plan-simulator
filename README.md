# Build Fleet Intelligence with Cortex Code

**Click the button below to get access to the full Snowflake Guide:**

[![Quickstart Guide](https://img.shields.io/badge/Quickstart-Guide-29B5E8?style=for-the-badge&logo=snowflake&logoColor=white)](https://www.snowflake.com/en/developers/guides/oss-install-openrouteservice-native-app/)

![ORS Control App](docs/guides/intro.png)

Build a complete fleet intelligence platform on Snowflake using [Cortex Code](https://docs.snowflake.com/en/user-guide/cortex-code) — from route optimisation and vehicle routing to real-time fleet analytics. The solution runs entirely inside your Snowflake account using Snowpark Container Services (SPCS).

## What's included

- **Cortex Code IDE** — A cloud-hosted VS Code environment with Cortex Code CLI, Snow CLI, SnowConvert AI CLI, and Python pre-installed. No local setup required.
- **OpenRouteService** routing engine running on SPCS with SQL functions for directions, isochrones, matrices, and VRP optimisation
- **Fleet intelligence demos** — taxi telemetry, food delivery, route deviation, dwell analysis, retail catchment
- **Route optimisation notebook** — Streamlit app with PyDeck visualisation and VROOM VRP solver
- **Cortex Code skills** — AI-guided deployment playbooks you invoke with natural language

## Prerequisites

- Snowflake account with privileges to create databases, warehouses, compute pools, and application packages
- [Cortex Code](https://docs.snowflake.com/en/user-guide/cortex-code) with an active Snowflake connection (or use the bundled Cortex Code IDE)
- Docker or Podman (required only for building container images locally)

**Estimated deployment time:** 15 to 30 minutes.

## Quick start

1. Open this repository in Cortex Code (locally or via the Cortex Code IDE)
2. Say **"check build prerequisites"** to verify your environment
3. Say **"build routing solution"** to deploy the routing engine
4. Say **"deploy route optimization demo"** (or any other demo) to add use cases

## Cortex Code IDE

The Cortex Code IDE is a native app that provides a full cloud development environment inside Snowflake:

| Tool | Description |
|------|-------------|
| **Cortex Code CLI** | AI assistant — natural language to SQL, code generation, MCP |
| **Snow CLI** | Manage stages, tasks, warehouses, Streamlit apps |
| **SnowConvert AI CLI** | Migrate SQL from Oracle, SQL Server, Teradata to Snowflake |
| **Python + Snowpark** | snowflake-connector, pandas, ipython pre-installed |
| **VS Code** | Full editor with Snowflake extension, terminal, Git |
| **Kaniko** | Build and push container images without Docker |

The IDE auto-suspends after 2 hours of inactivity to minimise costs.

## SPCS services

Five container services run inside your Snowflake account:

| Service | Purpose |
|---------|---------|
| `ors_service` | Core routing engine: directions, isochrones, matrix |
| `vroom_service` | Vehicle Routing Problem (VRP) optimizer |
| `routing_gateway_service` | Reverse proxy that routes requests to per-region ORS instances |
| `downloader` | Downloads OSM map files from Geofabrik |
| `ors_control_app` | Web-based control panel and demo dashboards |

## SQL functions

Eight SQL functions you can call from any worksheet, notebook, or stored procedure:

| Function | Description |
|----------|-------------|
| `DIRECTIONS(origin, destination, profile)` | Point-to-point routing with geometry, distance, and duration |
| `ISOCHRONES(location, range, profile)` | Reachability polygons (time or distance based) |
| `OPTIMIZATION(jobs, vehicles)` | Multi-stop VRP with time windows and capacity constraints |
| `MATRIX(locations, profile)` | N x N travel time and distance matrix |
| `MATRIX_TABULAR(locations, profile)` | Matrix output as tabular rows (for joins and analytics) |
| `ORS_STATUS()` | Current service status and loaded routing profiles |
| `CHECK_HEALTH()` | Health check across all services |
| `LIST_REGIONS()` | List provisioned geographic regions |

All functions support an optional `region` parameter for multi-region deployments.

## Demo use cases

| Demo | What it does | Deploy with |
|------|-------------|-------------|
| **Fleet Taxis** | Realistic taxi GPS telemetry using Overture Maps POIs and ORS road-following routes | `generate driver locations` |
| **Food Delivery** | Food delivery courier telemetry with configurable restaurant density and courier counts | `setup food delivery fleet` |
| **Route Deviation** | Compares actual GPS paths against planned routes to detect detours | `deploy route deviation` |
| **Dwell Analysis** | Dynamic Table pipeline: state detection, dwell sessionization, H3 congestion heatmaps, SLA alerts | `deploy dwell analysis` |
| **Route Optimization** | VRP demo with Snowflake notebook and Streamlit map visualisation | `deploy route optimization demo` |
| **Retail Catchment** | Isochrone-based catchment zones, competitor proximity, address density metrics | `deploy retail catchment` |
| **Routing Agent** | Snowflake Intelligence (Cortex Agent) wrapping ORS functions as tools | `create routing agent` |

## Route Optimisation Notebook

The `notebooks/route_optimisation_streamlit.ipynb` notebook deploys a Streamlit app that:

- Solves Vehicle Routing Problems using the VROOM optimiser
- Visualises optimised routes on an interactive PyDeck map
- Displays route geometries decoded from polyline format
- Runs entirely inside Snowflake as a Streamlit in Snowflake app

## Multi-region support

1. Deploy the routing engine (defaults to San Francisco)
2. Use **"change location to [city]"** to provision additional regions
3. The Region Switcher in the Control App lets you switch between regions

## Repository structure

```
.cortex/skills/                    # All Cortex Code skills
  ├── build-routing-solution/      # Core deployment
  ├── fleet-intelligence-taxis/    # Taxi fleet demo
  ├── fleet-intelligence-food-delivery/  # Food delivery demo
  ├── route-optimization/          # VRP demo
  ├── retail-catchment/            # Retail analytics
  └── routing-agent/               # Cortex Agent
docker/                            # Cortex Code IDE Dockerfile and config
native_app/                        # Native app package (manifest, setup, service spec)
notebooks/                         # Snowflake notebooks
datasets/                          # Seed data (parquet files)
docs/                              # Guides and architecture docs
```

## Cleanup

Say **"routing-solution-cleanup"** in Cortex Code to discover and remove all Snowflake objects created by the solution.

## License

Apache License 2.0
