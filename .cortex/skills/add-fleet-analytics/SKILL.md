---
name: add-fleet-analytics
description: "Add fleet analytics intelligence to the Routing Agent. Creates two Cortex Analyst semantic views (fleet trips + telemetry) from SYNTHETIC_DATASETS and adds fleet_trips and fleet_telemetry tools to ROUTING_AGENT, enabling the Fleet Analytics demo scenario: trip counts, vehicle performance, hourly demand, speeding, dwell/idle time, battery health, busiest POIs. Depends on routing-agent. Triggers: fleet analytics, trip data, vehicle performance, speeding, hourly patterns, battery, dwell time, fleet utilisation, delivery analytics."
depends_on:
  - routing-agent
metadata:
  author: Snowflake SIT-IS
  version: 1.0.0
  category: intelligence-agent
---

# Add Fleet Analytics Intelligence

Deploys two Cortex Analyst semantic views over the SYNTHETIC_DATASETS fleet data and wires them into the ROUTING_AGENT, enabling all 7 prompts in the **Fleet Analytics** demo scenario.

## What Gets Created

| Object | Description |
|--------|-------------|
| `FLEET_TRIPS_SV` | Semantic view over `FACT_TRIPS` + `DIM_FLEET` + `DIM_POIS` — trip counts, distances, durations, detours, driver behaviour |
| `FLEET_TELEMETRY_SV` | Semantic view over `FACT_VEHICLE_TELEMETRY` + `DIM_FLEET` — speed, battery, speeding events, dwell/idle status |
| Updated `ROUTING_AGENT` | `fleet_trips` and `fleet_telemetry` Cortex Analyst tools added |

## Prerequisites

- `$routing-agent` deployed
- `SYNTHETIC_DATASETS.UNIFIED` tables exist (FACT_TRIPS, FACT_VEHICLE_TELEMETRY, DIM_FLEET, DIM_POIS)
- ROUTING_ANALYTICS warehouse
- ACCOUNTADMIN role

## Workflow

### Step 1: Verify Source Data Exists

```sql
SELECT COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS;
SELECT COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY;
```

Expected: thousands of rows in each table.

### Step 2: Deploy Semantic Views + Update Agent

Execute `references/deploy-fleet-analytics.sql`:

```sql
USE ROLE ACCOUNTADMIN;
USE WAREHOUSE ROUTING_ANALYTICS;
```

This creates `FLEET_TRIPS_SV` and `FLEET_TELEMETRY_SV` in `FLEET_INTELLIGENCE.PUBLIC`, then recreates the ROUTING_AGENT with two new Cortex Analyst tools.

**Verify:**
```sql
SHOW SEMANTIC VIEWS IN SCHEMA FLEET_INTELLIGENCE.PUBLIC;
SHOW AGENTS IN SCHEMA FLEET_INTELLIGENCE.ROUTING_AGENT;
```

Expected: `FLEET_TRIPS_SV` and `FLEET_TELEMETRY_SV` visible; agent has 13 tools.

## Demo Flow — Fleet Analytics Scenario

| Prompt | What It Demonstrates |
|--------|---------------------|
| 1. Fleet overview | Total trips, avg distance, avg duration, active vehicles |
| 2. Top performers | Vehicles with most trips, avg distance/duration breakdown |
| 3. Speed & compliance | Speeding rate and HOS violations by vehicle/driver profile |
| 4. Dwell & idle time | Moving vs dwelling vs idle split across fleet |
| 5. Battery health | Lowest battery vehicles, avg and min battery by courier |
| 6. Busiest locations | Top 10 pickup restaurants by order volume |
| 7. Hourly patterns | Trip distribution by hour of day — peak demand identification |

## Data Notes

- `FACT_TRIPS`: trip-level records with start/end timestamps, distance, duration, vehicle type, region, detour flag
- `FACT_VEHICLE_TELEMETRY`: per-reading telemetry with speed, battery %, status (MOVING/DWELL/IDLE), speeding flag
- `DIM_FLEET`: vehicle/driver config — shift type, driver profile (COMPLIANT/MILD/OUTLIER), operating mode
- `DIM_POIS`: origin points of interest — restaurants, warehouses, rest stops
- Regions: SanFrancisco, Cambridge, Barcelona
- Vehicle types: ebike (electric bicycle), hgv (heavy goods vehicle)

> **After running this skill**, re-run `$setup-agent-playground` (Step 2: `references/configure-agent.sql`) to register the new tools with the Routing Agent.
