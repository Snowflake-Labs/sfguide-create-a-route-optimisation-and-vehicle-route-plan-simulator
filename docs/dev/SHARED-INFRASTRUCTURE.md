# Shared Infrastructure Map

Objects created/used across multiple skills. Understand these shared dependencies before deploying or cleaning up.

## Databases

| Database | Created By | Also Used By |
|----------|-----------|--------------|
| `OPENROUTESERVICE_SETUP` | build-routing-solution | route-optimization, fleet-intelligence-taxis, fleet-intelligence-food-delivery, retail-catchment, routing-agent |
| `FLEET_INTELLIGENCE` | route-deviation | dwell-analysis |
| `SYNTHETIC_DATASETS` | route-deviation | dwell-analysis (reads `FLEET_INTELLIGENCE` schema) |
| `FLEET_DEMOS` | route-deviation | synthetic-datasets-generator (configurable default) |
| Configurable (`ROUTING_DB`) | travel-time-matrix | (standalone) |

## Warehouses

| Warehouse | Created By | Also Used By | Size |
|-----------|-----------|--------------|------|
| `ROUTING_ANALYTICS` | build-routing-solution | route-optimization, fleet-intelligence-taxis, fleet-intelligence-food-delivery, retail-catchment, travel-time-matrix, routing-agent | MEDIUM |
| `COMPUTE_WH` | route-deviation | dwell-analysis | MEDIUM |
| `FLATTEN_WH` | travel-time-matrix | (standalone) | X-LARGE |

## Schemas per Database

### OPENROUTESERVICE_SETUP

| Schema | Owner Skill | Purpose |
|--------|------------|---------|
| `PUBLIC` | build-routing-solution | Stages, image repo, native app objects |
| `VEHICLE_ROUTING_SIMULATOR` | route-optimization | VRP demo tables, notebooks, Streamlit |
| `FLEET_INTELLIGENCE_TAXIS` | fleet-intelligence-taxis | Taxi driver telemetry pipeline |
| `FLEET_INTELLIGENCE_FOOD_DELIVERY` | fleet-intelligence-food-delivery | Courier telemetry pipeline |
| `RETAIL_CATCHMENT_DEMO` | retail-catchment | Retail POI + catchment analysis |
| `SI_ROUTING_AGENT` | routing-agent | Cortex agent + tool procedures |

### FLEET_INTELLIGENCE

| Schema | Owner Skill | Purpose |
|--------|------------|---------|
| `DEVIATION_ANALYSIS` | route-deviation | Route deviation ETL pipeline |
| `DWELL_ANALYSIS` | dwell-analysis | 12-step Dynamic Table pipeline |

### SYNTHETIC_DATASETS

| Schema | Owner Skill | Purpose |
|--------|------------|---------|
| `FLEET_INTELLIGENCE` | route-deviation | Raw telemetry from S3 |

### FLEET_DEMOS

| Schema | Owner Skill | Purpose |
|--------|------------|---------|
| `ROUTING` | route-deviation / synthetic-datasets-generator | Configurable output schema |

## Dependency Impact

Dropping a shared resource affects downstream skills:

```
DROP DATABASE OPENROUTESERVICE_SETUP  → breaks 6 skills
DROP WAREHOUSE ROUTING_ANALYTICS      → breaks 7 skills
DROP DATABASE FLEET_INTELLIGENCE      → breaks dwell-analysis
DROP DATABASE SYNTHETIC_DATASETS      → breaks dwell-analysis
DROP WAREHOUSE COMPUTE_WH            → breaks dwell-analysis
```

## Cleanup Order

When tearing down everything:

1. **Demo schemas first** (route-optimization, retail-catchment, routing-agent, fleet-intelligence-*)
2. **Analytics pipelines** (dwell-analysis, route-deviation)
3. **Data generation** (synthetic-datasets-generator)
4. **Shared warehouses** (COMPUTE_WH, FLATTEN_WH)
5. **Core infrastructure** (ROUTING_ANALYTICS warehouse, OPENROUTESERVICE_SETUP database)
6. **ORS Native App** (build-routing-solution) — last, since everything depends on it
