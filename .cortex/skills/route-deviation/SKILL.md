---
name: route-deviation
description: "Deploy Route Deviation Analysis: projection views comparing actual GPS paths vs planned routes to detect detours. Use when: route deviation demo, detour analytics. Do NOT use for: general fleet tracking, dwell analysis. Triggers: route deviation, detour detection, deviation analysis."
depends_on:
  - build-routing-solution
metadata:
  author: Snowflake SIT-IS
  version: 2.0.0
  category: fleet-intelligence
---

# Deploy Route Deviation Analysis

Compares actual GPS paths against planned routes to detect detours and anomalies. Uses Data Studio-generated data from `SYNTHETIC_DATASETS.UNIFIED`.

## Prerequisites

- `SYNTHETIC_DATASETS.UNIFIED` tables loaded (FACT_TRIPS with PLANNED_ROUTE_GEOG, IS_DETOUR columns)
- `ROUTING_ANALYTICS` warehouse

## Workflow

### Step 1: Execute Pipeline

Run `references/seed-data.sql` statement-by-statement. Creates:

| Object | Purpose | Key Columns for React |
|--------|---------|----------------------|
| `CONFIG` | Vehicle type + region filter | VEHICLE_TYPE, REGION |
| `VW_TRIP_DEVIATIONS` | Trip-level deviation stats | TRIP_ID, DRIVER_ID, ACTUAL_DISTANCE_KM, PLANNED_DISTANCE_KM, DEVIATION_KM, IS_DEVIATION |
| `VW_DETOUR_TELEMETRY` | GPS points flagged as detour | TELEMETRY_ID, TRIP_ID, LATITUDE, LONGITUDE, IS_DETOUR |
| `VW_DRIVER_DEVIATION_SUMMARY` | Driver ranking by deviation | DRIVER_ID, TOTAL_TRIPS, DEVIATION_TRIPS, DEVIATION_RATE |

### Step 2: Verify

```sql
SELECT 'VW_TRIP_DEVIATIONS' AS V, COUNT(*) AS CNT FROM FLEET_INTELLIGENCE.ROUTE_DEVIATION.VW_TRIP_DEVIATIONS
UNION ALL SELECT 'VW_DETOUR_TELEMETRY', COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_DEVIATION.VW_DETOUR_TELEMETRY;
```

Expected: VW_TRIP_DEVIATIONS 6K+, VW_DETOUR_TELEMETRY 12K+.

## React Component → View Mapping

| Component | View | Key Queries |
|-----------|------|-------------|
| `DeviationDashboard.tsx` | VW_TRIP_DEVIATIONS | KPIs: total trips, deviation rate, avg deviation km |
| `RouteComparison.tsx` | VW_TRIP_DEVIATIONS | Trip routes: ACTUAL_ROUTE_GEOG, PLANNED_ROUTE_GEOG |
| `RouteInspector.tsx` | VW_DETOUR_TELEMETRY | GPS trail with IS_DETOUR flag for coloring |

## Cleanup

```sql
DROP VIEW IF EXISTS FLEET_INTELLIGENCE.ROUTE_DEVIATION.VW_DRIVER_DEVIATION_SUMMARY;
DROP VIEW IF EXISTS FLEET_INTELLIGENCE.ROUTE_DEVIATION.VW_DETOUR_TELEMETRY;
DROP VIEW IF EXISTS FLEET_INTELLIGENCE.ROUTE_DEVIATION.VW_TRIP_DEVIATIONS;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_DEVIATION.CONFIG;
DROP SCHEMA IF EXISTS FLEET_INTELLIGENCE.ROUTE_DEVIATION;
```
