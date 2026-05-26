---
name: fleet-intelligence-taxis
description: "Deploy Fleet Intelligence Taxis demo: projection views over SYNTHETIC_DATASETS.UNIFIED for the React Fleet Taxis dashboard (FleetOverview, HeatMap, DriverRoutes). Use when: setting up fleet taxi dashboard, driver location data. Do NOT use for: food delivery (fleet-intelligence-food-delivery), route deviation, dwell analysis. Triggers: fleet taxis, taxi dashboard, driver routes, fleet overview."
depends_on:
  - build-routing-solution
metadata:
  author: Snowflake SIT-IS
  version: 1.0.0
  category: fleet-intelligence
---

# Deploy Fleet Intelligence Taxis

Creates projection views that the ORS Control App's Fleet Taxis page queries directly.

## Prerequisites

- `SYNTHETIC_DATASETS.UNIFIED` tables loaded (build-routing-solution seed data)
- `DIM_POIS` must have `LAT`, `LNG`, `LOCATION_TYPE` columns (NOT `LATITUDE`/`LONGITUDE`)
- `FACT_TRIPS` must have `DESTINATION_POI_ID` column (NOT `DEST_POI_ID`)

## Workflow

Execute `references/seed-data.sql` statement-by-statement. Creates:

| Object | Purpose | Key Columns for React |
|--------|---------|----------------------|
| `CONFIG` | Vehicle type + region filter | VEHICLE_TYPE, REGION |
| `VW_DRIVER_LOCATIONS` | GPS pings (DriverRoutes tab) | DRIVER_ID, LON, LAT, KMH, DRIVER_STATE |
| `VW_TRIP_SUMMARY` | Trip analytics | DRIVER_ID, ROUTE_DISTANCE_METERS, ROUTE_DURATION_SECS, AVERAGE_KMH, ORIGIN_ADDRESS, GEOMETRY |
| `TRIP_SUMMARY` | Wrapper (= VW_TRIP_SUMMARY) | Same — React queries this name |
| `DRIVER_LOCATIONS_V` | Wrapper with POINT_GEOM | LON, LAT, POINT_GEOM, DRIVER_STATE |
| `ROUTE_NAMES` | Trip labels | TRIP_ID, TRIP_NAME |
| `TRIPS_ASSIGNED_TO_DRIVERS` | Assignment view | DRIVER_ID, TRIP_ID, GEOMETRY |
| `TRIP_ROUTE_PLAN` | Full route detail | ORIGIN, DESTINATION, DISTANCE_METERS, ROUTE |

## Critical Column Mappings

The React components query these EXACT names:

```
FleetOverview.tsx → TRIP_SUMMARY.DRIVER_ID, ROUTE_DISTANCE_METERS, ROUTE_DURATION_SECS
HeatMap.tsx       → TRIP_SUMMARY.ORIGIN (GEOGRAPHY), AVERAGE_KMH, TRIP_START_TIME
DriverRoutes.tsx  → TRIP_SUMMARY.DRIVER_ID, ORIGIN_ADDRESS, DESTINATION_ADDRESS, GEOMETRY
```

Source column → View column mapping:
- `FACT_TRIPS.VEHICLE_ID` → `DRIVER_ID`
- `FACT_TRIPS.DISTANCE_KM * 1000` → `ROUTE_DISTANCE_METERS`
- `FACT_TRIPS.DURATION_MINUTES * 60` → `ROUTE_DURATION_SECS`
- `FACT_TRIPS.ROUTE_GEOG` → `GEOMETRY`
- `FACT_TRIPS.TRIP_START` → `TRIP_START_TIME`
- `DIM_POIS.NAME` (via DESTINATION_POI_ID join) → `DESTINATION_ADDRESS`
- Computed `DISTANCE_KM / (DURATION_MINUTES / 60)` → `AVERAGE_KMH`

## Verify

```sql
SELECT 'TRIP_SUMMARY' AS V, COUNT(*) AS CNT FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TRIP_SUMMARY
UNION ALL SELECT 'DRIVER_LOCATIONS_V', COUNT(*) FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_LOCATIONS_V;
```

Expected: TRIP_SUMMARY 6K+, DRIVER_LOCATIONS_V 470K+.

## Cleanup

```sql
DROP VIEW IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TRIP_ROUTE_PLAN;
DROP VIEW IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TRIPS_ASSIGNED_TO_DRIVERS;
DROP VIEW IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.ROUTE_NAMES;
DROP VIEW IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_LOCATIONS_V;
DROP VIEW IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TRIP_SUMMARY;
DROP VIEW IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.VW_TRIP_SUMMARY;
DROP VIEW IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.VW_DRIVER_LOCATIONS;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.CONFIG;
DROP SCHEMA IF EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS;
```
