---
name: dwell-analysis
description: "Deploy the Dwell & Congestion Analysis demo: create a 12-step Dynamic Table pipeline for state detection, dwell sessionization, H3 congestion heatmaps, SLA alerts, facility utilization, and daily trends. Works with any vehicle type from SYNTHETIC_DATASETS.UNIFIED, configured via CONFIG table. Use when: setting up dwell analysis demo, congestion analytics, SLA breach monitoring, facility utilization tracking. Do NOT use for: route deviation analysis (use route-deviation), food delivery fleet (use fleet-intelligence-food-delivery), taxi fleet (use fleet-intelligence-taxis). Triggers: deploy dwell analysis, dwell analytics, congestion analysis, SLA alerts, facility utilization, dwell demo, H3 heatmap."
depends_on:
  - build-routing-solution
metadata:
  author: Snowflake SIT-IS
  version: 2.0.0
  category: fleet-intelligence
---

# Deploy Dwell & Congestion Analysis

Deploys a 12-step Dynamic Table pipeline that transforms vehicle telemetry into actionable dwell analytics: state detection, session grouping, H3 congestion heatmaps, SLA breach alerts, facility utilization, and fleet-wide daily trends. Vehicle-type agnostic -- works with trucks, taxis, e-bikes, e-scooters, or any fleet type. All data sourced from `SYNTHETIC_DATASETS.UNIFIED` via projection views.

## Prerequisites

1. Synthetic fleet data in `SYNTHETIC_DATASETS.UNIFIED` (any vehicle type):
   - `FACT_VEHICLE_TELEMETRY` -- GPS pings with STATUS column
   - `DIM_POIS` -- POI locations (warehouses, stores, rest stops)
   - `DIM_FLEET` -- vehicle metadata and driver profiles
   - `DIM_TRIP_SCHEDULE` -- trip schedule with OD pairs
2. CONFIG table set to desired VEHICLE_TYPE and REGION (created automatically during deployment)
3. `ROUTING_ANALYTICS` warehouse available
4. A role with privileges listed in the Required Privileges section below

## Required Privileges

| Privilege | Scope | Reason |
|-----------|-------|--------|
| CREATE DATABASE | Account | Creates FLEET_INTELLIGENCE database |
| USAGE ON WAREHOUSE ROUTING_ANALYTICS | Warehouse | Used by all Dynamic Tables and tasks |
| USAGE ON DATABASE SYNTHETIC_DATASETS | Database | Reads source telemetry and fleet tables |
| USAGE ON SCHEMA SYNTHETIC_DATASETS.UNIFIED | Schema | Reads FACT_VEHICLE_TELEMETRY, DIM_POIS, DIM_FLEET, DIM_TRIP_SCHEDULE |
| CREATE SCHEMA | Database (FLEET_INTELLIGENCE) | Creates DWELL_ANALYSIS schema |
| CREATE TABLE | Schema (FLEET_INTELLIGENCE.DWELL_ANALYSIS) | Creates GEOFENCE_POLYGONS, SLA_THRESHOLDS, SLA_ALERT_LOG |
| CREATE DYNAMIC TABLE | Schema (FLEET_INTELLIGENCE.DWELL_ANALYSIS) | Creates 8 Dynamic Tables (DT_STATE_CHANGES through DT_DAILY_TRENDS) |
| CREATE STREAM | Schema (FLEET_INTELLIGENCE.DWELL_ANALYSIS) | Not currently used (subquery views don't support change tracking) |
| CREATE TASK | Schema (FLEET_INTELLIGENCE.DWELL_ANALYSIS) | Creates LOG_SLA_ALERTS task |
| EXECUTE TASK | Account | Enables scheduled task execution |

> **Note:** ACCOUNTADMIN is NOT required. Create a custom role with the above privileges, or use any role that has them.

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| Database | `FLEET_INTELLIGENCE` | Target database |
| Schema | `DWELL_ANALYSIS` | Target schema |
| Warehouse | `ROUTING_ANALYTICS` | Used by all Dynamic Tables |
| Target Lag | DOWNSTREAM | DTs refresh only when queried (saves credits with static seed data) |

## Credit Management

Dynamic Tables use `TARGET_LAG = DOWNSTREAM` — they only refresh when a query reads them, not on a schedule. This prevents continuous credit consumption with static seed data.

Additionally, an `AUTO_SUSPEND_DTS` task runs once after 2 hours to suspend all DTs. To re-enable after suspension:

```sql
ALTER DYNAMIC TABLE FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_STATE_CHANGES RESUME;
-- Repeat for other DTs as needed
```

## Execution Rules

1. **FACT_VEHICLE_TELEMETRY MUST have a `POINT_GEOM` (GEOGRAPHY) column.** If only `POINT_GEOM_WKT` exists, add and populate: `ALTER TABLE ... ADD COLUMN POINT_GEOM GEOGRAPHY; UPDATE ... SET POINT_GEOM = TRY_TO_GEOGRAPHY(POINT_GEOM_WKT);`
2. **DT_DWELL_ENRICHED.STATUS must contain telemetry STATUS values** (`DWELL_ORIGIN`, `DWELL_DESTINATION`, `IDLE`) — NOT location types like `RESTAURANT`. TripInspector filters with `WHERE STATUS LIKE 'DWELL%'`.
3. **DT_DWELL_ENRICHED must include `AVG_POINT` column** (alias for DWELL_CENTER GEOGRAPHY). TripInspector calls `ST_X(AVG_POINT)`.
4. **SLA_THRESHOLDS must be tight for seed data** (avg dwell is 3.5 min). Use `WARNING_MINUTES=3, MAX_DWELL_MINUTES=5` for RESTAURANT type to generate meaningful alerts.
5. **Do NOT reference `DIM_TRIP_SCHEDULE`** — it doesn't exist in seed data. Skip `VW_TRIP_SCHEDULE`.

## Pipeline Architecture

```
VW_VEHICLE_TELEMETRY (source, from SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY)
    |
    +---> DT_STATE_CHANGES (LAG-based state detection, for LiveOperations)
    |
    +---> DT_DWELL_EVENTS (GROUP BY session detection)
              |
              v
         DT_DWELL_ENRICHED (joins POI names, adds AVG_POINT/STATUS)
              |
              +---> DT_H3_CONGESTION (hourly H3 R7 heatmap)
              +---> DT_SLA_ALERTS (WARNING/CRITICAL/INFO breach detection)
              +---> DT_FACILITY_UTILIZATION (per-location stats)
              +---> DT_DRIVER_DWELL_SUMMARY (per-driver breach counts)
              +---> DT_DAILY_TRENDS (fleet-wide daily aggregates)
```

## Dashboard Schema Contract

The React components query these EXACT DT names and columns:

| Component | DT Name | Key Columns |
|-----------|---------|-------------|
| DwellOverview | `DT_DWELL_ENRICHED` | SESSION_ID, DWELL_MINUTES, VEHICLE_ID |
| DwellOverview | `DT_DAILY_TRENDS` | TREND_DATE, TOTAL_SESSIONS, ACTIVE_VEHICLES |
| DwellOverview | `DT_FACILITY_UTILIZATION` | LOCATION_NAME, TOTAL_SESSIONS |
| FacilityUtilization | `DT_FACILITY_UTILIZATION` | LOCATION_NAME, FACILITY_TYPE, TOTAL_SESSIONS, AVG_DWELL_MIN, UNIQUE_VEHICLES |
| SLAAlerts | `DT_SLA_ALERTS` | SLA_STATUS, SESSION_ID, VEHICLE_ID, LOCATION_NAME, DWELL_MINUTES, WARNING_MINUTES, SESSION_START |
| DriverPerformance | `DT_DRIVER_DWELL_SUMMARY` | VEHICLE_ID, UNIQUE_LOCATIONS, TOTAL_DWELL_SESSIONS, AVG_SESSION_MIN, SLA_BREACH_COUNT, TOTAL_DWELL_MIN |
| CongestionMap | `DT_H3_CONGESTION` | H3_CELL_R7, HOUR_BUCKET, SESSION_COUNT, AVG_DWELL_MIN |
| TripInspector | `DT_DWELL_ENRICHED` | TRIP_ID, VEHICLE_ID, SESSION_START, SESSION_END, STATUS (LIKE 'DWELL%'), AVG_POINT (GEOGRAPHY) |
| LiveOperations | `DT_STATE_CHANGES` | VEHICLE_ID, STATUS, POINT_GEOM, TS, SPEED_KMH, IS_STATE_CHANGE |
| LiveOperations | `DT_DWELL_ENRICHED` | VEHICLE_ID, LOCATION_NAME, SESSION_START, DWELL_MINUTES |

## Error Logging

> Follow the Error Logging convention in AGENTS.md. Log file prefix: `dwell-analysis`.

## Quick Start

The fastest path to a working demo. Creates projection views over `SYNTHETIC_DATASETS.UNIFIED` tables (loaded by `build-routing-solution` Step 8), computes GEOFENCE_POLYGONS, and inserts SLA_THRESHOLDS.

### Quick check

```sql
SELECT COUNT(*) FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DWELL_ENRICHED;
```

If > 0 rows, the pipeline is deployed. Skip to verification.

### Deploy (CLI)

```bash
snow sql -f .cortex/skills/dwell-analysis/references/sql-pipeline.sql -c <connection>
```

### Deploy (Workspace — no snow sql -f)

Execute each statement from `references/sql-pipeline.sql` individually via `snowflake_sql_execute`.

**PREREQUISITE:** FACT_VEHICLE_TELEMETRY must have `POINT_GEOM` (GEOGRAPHY) column:
```sql
ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY ADD COLUMN IF NOT EXISTS POINT_GEOM GEOGRAPHY;
UPDATE SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY SET POINT_GEOM = TRY_TO_GEOGRAPHY(POINT_GEOM_WKT) WHERE POINT_GEOM IS NULL AND POINT_GEOM_WKT IS NOT NULL;
ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.DIM_POIS ADD COLUMN IF NOT EXISTS POINT_GEOM GEOGRAPHY;
UPDATE SYNTHETIC_DATASETS.UNIFIED.DIM_POIS SET POINT_GEOM = TRY_TO_GEOGRAPHY(POINT_GEOM_WKT) WHERE POINT_GEOM IS NULL AND POINT_GEOM_WKT IS NOT NULL;
```

## Workflow

### Step 1: Run SQL Pipeline

Execute `references/sql-pipeline.sql` — the single source of truth for this skill.

| Step | Object | Type | Description |
|------|--------|------|-------------|
| 1 | Database + Schema + CONFIG | DDL + Table | Infrastructure |
| 2 | VW_VEHICLE_TELEMETRY, VW_TRIP_SUMMARY | Views | Projection views from UNIFIED |
| 3 | SLA_THRESHOLDS | Table | Dwell time limits (WARNING=3min, MAX=5min for RESTAURANT) |
| 4 | DT_STATE_CHANGES | Dynamic Table | LAG-based state detection (LiveOperations) |
| 5 | DT_DWELL_EVENTS | Dynamic Table | Session grouping |
| 6 | DT_DWELL_ENRICHED | Dynamic Table | POI-enriched dwells with AVG_POINT + STATUS |
| 7 | DT_H3_CONGESTION | Dynamic Table | Hourly H3 R7 heatmap (CongestionMap) |
| 8 | DT_SLA_ALERTS | Dynamic Table | SLA breach events (SLAAlerts) |
| 9 | DT_FACILITY_UTILIZATION | Dynamic Table | Per-location stats (FacilityUtilization) |
| 10 | DT_DRIVER_DWELL_SUMMARY | Dynamic Table | Per-driver breach counts (DriverPerformance) |
| 11 | DT_DAILY_TRENDS | Dynamic Table | Fleet-wide daily aggregates (DwellOverview) |

### Step 2: Verify Pipeline

```sql
SELECT 'DT_STATE_CHANGES' AS DT, COUNT(*) AS ROW_CNT FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_STATE_CHANGES
UNION ALL SELECT 'DT_DWELL_ENRICHED', COUNT(*) FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DWELL_ENRICHED
UNION ALL SELECT 'DT_H3_CONGESTION', COUNT(*) FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_H3_CONGESTION
UNION ALL SELECT 'DT_SLA_ALERTS', COUNT(*) FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_SLA_ALERTS
UNION ALL SELECT 'DT_FACILITY_UTILIZATION', COUNT(*) FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_FACILITY_UTILIZATION
UNION ALL SELECT 'DT_DRIVER_DWELL_SUMMARY', COUNT(*) FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DRIVER_DWELL_SUMMARY
UNION ALL SELECT 'DT_DAILY_TRENDS', COUNT(*) FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DAILY_TRENDS;
```

Expected (SF seed data): STATE_CHANGES ~470K, DWELL_ENRICHED ~12K, H3_CONGESTION ~1.5K, SLA_ALERTS ~3K, FACILITY_UTIL ~12K, DRIVER_SUMMARY 50, DAILY_TRENDS 7.

## SLA Threshold Tuning

Default thresholds (tuned for seed data with avg 3.5 min dwell):

| Location Type | Warning (min) | Max (min) | Priority |
|---------------|---------------|-----------|----------|
| RESTAURANT | 3 | 5 | HIGH |
| DWELL_ORIGIN | 3 | 5 | HIGH |
| DWELL_DESTINATION | 3 | 5 | MEDIUM |
| IDLE | 5 | 10 | LOW |

> **Production note:** For real-world data, increase to realistic values (e.g., RESTAURANT: 20/30 min).

Update thresholds by modifying the SLA_THRESHOLDS table directly. DT_SLA_ALERTS will refresh automatically.

## Examples

### Example 1: Quick deploy with seed data
User says: "Deploy dwell analysis"
Actions:
1. Run `references/seed-data.sql` to create projection views, geofences, and SLA thresholds
2. Run `references/sql-pipeline.sql` Steps 5-13 to create Dynamic Tables
3. Verify DT_SLA_ALERTS and DT_DAILY_TRENDS have rows
Result: 12-step Dynamic Table pipeline with SLA alerts, congestion heatmaps, and facility utilization (~10 min)

### Example 2: Deploy with Data Studio data
User says: "Set up dwell analysis for London truck fleet"
Actions:
1. Generate truck fleet data via Data Studio for London region
2. Update CONFIG table with `VEHICLE_TYPE='hgv'`, `REGION='London'`
3. Run full pipeline from Step 1
Result: Dwell analysis pipeline processing London HGV telemetry with region-specific geofences

## Stopping Points

- Step 1 (after Step 4 SQL): Verify SLA_THRESHOLDS has 5 rows
- Step 1 (after Step 5): Verify DT_STATE_CHANGES is refreshing
- Step 2: Verify all DT row counts are non-zero

## Troubleshooting

| Issue | Solution |
|-------|----------|
| DT_STATE_CHANGES empty | Verify VW_VEHICLE_TELEMETRY has data with matching STATUS values |
| DT_DWELL_SESSIONS zero rows | Check STATUS LIKE 'DWELL%' filter matches your telemetry data |
| SLA alerts not appearing | Thresholds may be too high for your data's dwell durations. Lower WARNING_MINUTES/CRITICAL_MINUTES in SLA_THRESHOLDS |
| H3 cells NULL | Ensure latitude/longitude values are valid (not NULL or 0) |
| Task not running | Run `ALTER TASK ... RESUME` and verify ROUTING_ANALYTICS is active |
| Dynamic Tables stale | Check `SHOW DYNAMIC TABLES` for refresh status and errors |
| VW_ views return 0 rows | Verify CONFIG table has correct VEHICLE_TYPE and REGION matching UNIFIED data |
| All DTs show FULL refresh mode | Expected -- VW_ views use CONFIG subquery expressions which prevent incremental change tracking |
| Stream creation fails | Expected -- subquery views don't support change tracking; the task uses a 5-minute schedule instead |
| DT_DWELL_ENRICHED has more rows than DT_DWELL_SESSIONS | Duplicate LOCATION_IDs in DIM_POIS cause fan-out in the enrichment join; the sql-pipeline uses deduplication CTEs to prevent this |
| DIM_TRIP_SCHEDULE has 0 rows | Data Studio may not have populated this table yet; VW_TRIP_SCHEDULE will return 0 rows until data exists |

## Cleanup

To remove all objects created by this skill:

```sql
ALTER TASK IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.LOG_SLA_ALERTS SUSPEND;
DROP TASK IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.LOG_SLA_ALERTS;
DROP STREAM IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.TELEMETRY_STREAM;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.SLA_ALERT_LOG;
DROP DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DAILY_TRENDS;
DROP DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DRIVER_DWELL_SUMMARY;
DROP DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_FACILITY_UTILIZATION;
DROP DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_SLA_ALERTS;
DROP DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_H3_CONGESTION;
DROP DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DWELL_ENRICHED;
DROP DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DWELL_SESSIONS;
DROP DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_STATE_CHANGES;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.SLA_THRESHOLDS;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.GEOFENCE_POLYGONS;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.CONFIG;
DROP VIEW IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.VW_VEHICLE_TELEMETRY;
DROP VIEW IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.VW_VEHICLE_FLEET;
DROP VIEW IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.VW_DESTINATIONS;
DROP VIEW IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.VW_REST_STOPS;
DROP VIEW IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.VW_TRIP_SCHEDULE;
DROP SCHEMA IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS;
```

> **Tip:** Use the `cleanup` skill to auto-discover all tagged objects via COMMENT tracking.
