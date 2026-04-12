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
| Target Lag | 5-10 min | DT refresh interval |

## Pipeline Architecture

```
VW_VEHICLE_TELEMETRY (source, from SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY)
    |
    v
DT_STATE_CHANGES (Layer 1: LAG-based state detection)
    |
    v
DT_DWELL_SESSIONS (Layer 2: CONDITIONAL_CHANGE_EVENT sessionization + H3)
    |
    v
DT_DWELL_ENRICHED (Layer 3: joins location + fleet metadata)
    |
    +---> DT_H3_CONGESTION (hourly H3 heatmap)
    +---> DT_SLA_ALERTS (WARNING/CRITICAL breach detection)
    |       +---> SLA_ALERT_LOG (Task MERGE, 5-min schedule)
    +---> DT_FACILITY_UTILIZATION (daily visit stats)
    +---> DT_DRIVER_DWELL_SUMMARY (per-driver breach counts)
    +---> DT_DAILY_TRENDS (fleet-wide daily aggregates)
```

## Error Logging

When any step fails or produces unexpected results (SQL errors, missing objects, wrong row counts, service failures, deployment issues), log the issue to `logs/` following the format in `logs/README.md`. Create one log file per execution: `dwell-analysis_{YYYY-MM-DD}_{HH-MM}.md`. Continue execution where possible, logging all issues encountered. If execution completes with no issues, do not create a log file.

## Step 0: Create Projection Views and Seed Tables (Recommended)

The fastest path to a working demo. Creates projection views over `SYNTHETIC_DATASETS.UNIFIED` tables (loaded by `build-routing-solution` Step 8), computes GEOFENCE_POLYGONS, and inserts SLA_THRESHOLDS. No S3 stages needed.

### Quick check

```sql
SELECT COUNT(*) FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.GEOFENCE_POLYGONS;
```

If the table exists and has rows, data is already loaded. Skip to Step 1 (Run SQL Pipeline) -- the seed only creates views and static tables, DTs must still be created.

### Create views and tables

Execute `references/seed-data.sql`. This creates CONFIG, 5 projection views, GEOFENCE_POLYGONS (computed from views), and SLA_THRESHOLDS.

After loading, you must still create the Dynamic Tables by running `references/sql-pipeline.sql` Steps 5-13. Dynamic Tables cannot be pre-baked.

### Generate data for other regions (optional)

To generate data for a region other than San Francisco, use the full pipeline starting at Step 1.

Or use the centralized provisioner:
```sql
CALL FLEET_INTELLIGENCE.CORE.PROVISION_REGION('<RegionName>', ARRAY_CONSTRUCT('dwell-analysis'));
```

## Workflow

### Step 1: Run SQL Pipeline

Execute the complete SQL pipeline from `references/sql-pipeline.sql`. Run each statement sequentially using `snowflake_sql_execute`. All CREATE statements in the referenced SQL include COMMENT tracking tags per AGENTS.md convention (`"origin":"sf_sit-is-fleet","name":"oss-dwell-analysis"`).

**IMPORTANT:** Step 4 (SLA_THRESHOLDS) requires two separate SQL calls -- one CREATE TABLE and one INSERT.

| Step | Object | Type | Description |
|------|--------|------|-------------|
| 1 | Database + Schema | DDL | Create FLEET_INTELLIGENCE.DWELL_ANALYSIS |
| 1b | CONFIG | Table | Single-row vehicle type and region config |
| 2 | VW_VEHICLE_TELEMETRY, VW_VEHICLE_FLEET, VW_DESTINATIONS, VW_REST_STOPS, VW_TRIP_SCHEDULE | Views | Projection views from UNIFIED |
| 3 | GEOFENCE_POLYGONS | Table | Destinations + rest stops with buffer radii |
| 4 | SLA_THRESHOLDS | Table + INSERT | WARNING/CRITICAL minutes per location type (2 calls) |
| 5 | DT_STATE_CHANGES | Dynamic Table | LAG-based state change detection |
| 6 | DT_DWELL_SESSIONS | Dynamic Table | CONDITIONAL_CHANGE_EVENT sessionization |
| 7 | DT_DWELL_ENRICHED | Dynamic Table | Join location + fleet metadata |
| 8 | DT_H3_CONGESTION | Dynamic Table | Hourly H3 heatmap |
| 9 | DT_SLA_ALERTS | Dynamic Table | SLA breach detection |
| 10 | DT_FACILITY_UTILIZATION | Dynamic Table | Daily facility visit stats |
| 11 | DT_DRIVER_DWELL_SUMMARY | Dynamic Table | Per-driver dwell + breach counts |
| 12 | DT_DAILY_TRENDS | Dynamic Table | Fleet-wide daily aggregates |
| 13 | SLA_ALERT_LOG + Task | Table + Task | Schedule-based alert logging (every 5 min) |

### Step 2: Verify Pipeline

```sql
SELECT 'DT_STATE_CHANGES' AS DT, COUNT(*) AS ROW_CNT FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_STATE_CHANGES
UNION ALL SELECT 'DT_DWELL_SESSIONS', COUNT(*) FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DWELL_SESSIONS
UNION ALL SELECT 'DT_SLA_ALERTS', COUNT(*) FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_SLA_ALERTS
UNION ALL SELECT 'DT_DAILY_TRENDS', COUNT(*) FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DAILY_TRENDS;
```


## SLA Threshold Tuning

Default thresholds in SLA_THRESHOLDS table:

| Location Type | Warning (min) | Critical (min) |
|---------------|---------------|----------------|
| WAREHOUSE | 60 | 120 |
| DESTINATION | 30 | 60 |
| REST_STOP | 45 | 90 |
| STORE | 20 | 45 |
| DETOUR | 15 | 30 |

Update thresholds by modifying the SLA_THRESHOLDS table directly. DT_SLA_ALERTS will refresh automatically.

## Stopping Points

- Step 1 (after Step 4 SQL): Verify SLA_THRESHOLDS has 5 rows
- Step 1 (after Step 5): Verify DT_STATE_CHANGES is refreshing
- Step 2: Verify all DT row counts are non-zero

## Troubleshooting

| Issue | Solution |
|-------|----------|
| DT_STATE_CHANGES empty | Verify VW_VEHICLE_TELEMETRY has data with matching STATUS values |
| DT_DWELL_SESSIONS zero rows | Check STATUS LIKE 'DWELL%' filter matches your telemetry data |
| SLA alerts not appearing | Verify SLA_THRESHOLDS has matching LOCATION_TYPE values |
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
