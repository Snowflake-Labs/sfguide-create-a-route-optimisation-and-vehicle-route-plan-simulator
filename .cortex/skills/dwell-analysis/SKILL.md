---
name: dwell-analysis
description: "Deploy the Dwell & Congestion Analysis demo: create a 12-step Dynamic Table pipeline for state detection, dwell sessionization, H3 congestion heatmaps, SLA alerts, facility utilization, and daily trends. Includes local Streamlit dashboard and Snowflake-native SiS app. Uses FACT_TRUCK_TELEMETRY from the synthetic fleet dataset. Use when: setting up dwell analysis demo, congestion analytics, SLA breach monitoring, facility utilization tracking. Do NOT use for: route deviation analysis (use route-deviation), food delivery fleet (use fleet-intelligence-food-delivery), taxi fleet (use fleet-intelligence-taxis). Triggers: deploy dwell analysis, dwell analytics, congestion analysis, SLA alerts, facility utilization, dwell demo, H3 heatmap."
depends_on:
  - route-deviation
  - synthetic-datasets-generator
metadata:
  author: Snowflake SIT-IS
  version: 1.0.0
  category: fleet-intelligence
---

# Deploy Dwell & Congestion Analysis

Deploys a 12-step Dynamic Table pipeline that transforms raw truck telemetry into actionable dwell analytics: state detection, session grouping, H3 congestion heatmaps, SLA breach alerts, facility utilization, and fleet-wide daily trends. Includes two Streamlit dashboards (local and Snowflake-native).

## Prerequisites

1. Synthetic fleet telemetry dataset loaded in `SYNTHETIC_DATASETS.FLEET_INTELLIGENCE`:
   - `FACT_TRUCK_TELEMETRY` -- GPS pings with STATUS column
   - `GERMANY_DESTINATIONS` -- warehouse/store/destination locations
   - `GERMANY_REST_STOPS` -- rest stop locations
   - `TRUCK_FLEET` -- truck metadata and driver profiles
2. `COMPUTE_WH` warehouse available
3. A role with privileges listed in the Required Privileges section below

## Required Privileges

| Privilege | Scope | Reason |
|-----------|-------|--------|
| CREATE DATABASE | Account | Creates FLEET_INTELLIGENCE database |
| USAGE ON WAREHOUSE COMPUTE_WH | Warehouse | Used by all Dynamic Tables and tasks |
| USAGE ON DATABASE SYNTHETIC_DATASETS | Database | Reads source telemetry and fleet tables |
| USAGE ON SCHEMA SYNTHETIC_DATASETS.FLEET_INTELLIGENCE | Schema | Reads FACT_TRUCK_TELEMETRY, GERMANY_DESTINATIONS, GERMANY_REST_STOPS, TRUCK_FLEET |
| CREATE SCHEMA | Database (FLEET_INTELLIGENCE) | Creates DWELL_ANALYSIS schema |
| CREATE TABLE | Schema (FLEET_INTELLIGENCE.DWELL_ANALYSIS) | Creates GEOFENCE_POLYGONS, SLA_THRESHOLDS, SLA_ALERT_LOG |
| CREATE DYNAMIC TABLE | Schema (FLEET_INTELLIGENCE.DWELL_ANALYSIS) | Creates 8 Dynamic Tables (DT_STATE_CHANGES through DT_DAILY_TRENDS) |
| CREATE STREAM | Schema (FLEET_INTELLIGENCE.DWELL_ANALYSIS) | Creates TELEMETRY_STREAM |
| CREATE TASK | Schema (FLEET_INTELLIGENCE.DWELL_ANALYSIS) | Creates LOG_SLA_ALERTS task |
| EXECUTE TASK | Account | Enables scheduled task execution |
| CREATE STAGE | Schema (FLEET_INTELLIGENCE.DWELL_ANALYSIS) | Creates STREAMLIT_STAGE for SiS deployment |
| CREATE STREAMLIT | Schema (FLEET_INTELLIGENCE.DWELL_ANALYSIS) | Deploys DWELL_ANALYTICS_APP |

> **Note:** ACCOUNTADMIN is NOT required. Create a custom role with the above privileges, or use any role that has them.

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| Database | `FLEET_INTELLIGENCE` | Target database |
| Schema | `DWELL_ANALYSIS` | Target schema |
| Warehouse | `COMPUTE_WH` | Used by all Dynamic Tables |
| Target Lag | 5-10 min | DT refresh interval |

## Pipeline Architecture

```
FACT_TRUCK_TELEMETRY (source)
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
    |       +---> SLA_ALERT_LOG (Stream + Task MERGE, 5-min schedule)
    +---> DT_FACILITY_UTILIZATION (daily visit stats)
    +---> DT_DRIVER_DWELL_SUMMARY (per-driver breach counts)
    +---> DT_DAILY_TRENDS (fleet-wide daily aggregates)
```

## Workflow

### Step 1: Run SQL Pipeline

Execute the complete 12-step SQL pipeline from `references/sql-pipeline.sql`. Run each statement sequentially using `snowflake_sql_execute`.

**IMPORTANT:** Step 3 (SLA_THRESHOLDS) requires two separate SQL calls -- one CREATE TABLE and one INSERT.

| Step | Object | Type | Description |
|------|--------|------|-------------|
| 1 | Database + Schema | DDL | Create FLEET_INTELLIGENCE.DWELL_ANALYSIS |
| 2 | GEOFENCE_POLYGONS | Table | Destinations + rest stops with buffer radii |
| 3 | SLA_THRESHOLDS | Table + INSERT | WARNING/CRITICAL minutes per location type (2 calls) |
| 4 | DT_STATE_CHANGES | Dynamic Table | LAG-based state change detection |
| 5 | DT_DWELL_SESSIONS | Dynamic Table | CONDITIONAL_CHANGE_EVENT sessionization |
| 6 | DT_DWELL_ENRICHED | Dynamic Table | Join location + fleet metadata |
| 7 | DT_H3_CONGESTION | Dynamic Table | Hourly H3 heatmap |
| 8 | DT_SLA_ALERTS | Dynamic Table | SLA breach detection |
| 9 | DT_FACILITY_UTILIZATION | Dynamic Table | Daily facility visit stats |
| 10 | DT_DRIVER_DWELL_SUMMARY | Dynamic Table | Per-driver dwell + breach counts |
| 11 | DT_DAILY_TRENDS | Dynamic Table | Fleet-wide daily aggregates |
| 12 | SLA_ALERT_LOG + Stream + Task | Table + Stream + Task | MERGE-based alert logging |

### Step 2: Deploy Streamlit Dashboard

Two deployment options with different page counts:

**Option A: Local Streamlit** (assets/streamlit/)

Multi-page app with 4 pages + main:

| File | Page |
|------|------|
| `Dwell_Analytics.py` | Main entry point |
| `pages/1_H3_Congestion_Map.py` | H3 hex-based heatmap |
| `pages/2_Facility_Utilization.py` | Per-facility visit stats |
| `pages/3_SLA_Alerts.py` | SLA breach drill-down |
| `pages/4_Trip_Dwell_Inspector.py` | Per-truck session timeline |

Run locally: `streamlit run assets/streamlit/Dwell_Analytics.py`

**Option B: Snowflake-native SiS** (assets/sis/)

Multi-page app with 7 pages + main. This version has 3 additional pages compared to the local version:

| File | Page |
|------|------|
| `streamlit_app.py` | Main entry point |
| `pages/1_Live_Operations.py` | Real-time fleet operations |
| `pages/2_H3_Congestion_Map.py` | H3 hex-based heatmap |
| `pages/3_Facility_Performance.py` | Per-facility visit stats |
| `pages/4_SLA_Alerts.py` | SLA breach drill-down |
| `pages/5_Driver_Performance.py` | Per-driver dwell + breach stats |
| `pages/6_Root_Cause_Analysis.py` | Root cause investigation |
| `pages/7_Trip_Dwell_Inspector.py` | Per-truck session timeline |

**SiS Deployment SQL:**

```sql
CREATE STAGE IF NOT EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.STREAMLIT_STAGE
    DIRECTORY = (ENABLE = TRUE)
    ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE')
    COMMENT = '{"origin":"sf_sit-is-fleet", "name":"oss-dwell-analysis", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"streamlit"}}';
```

Upload files:

```bash
snow stage copy assets/sis/streamlit_app.py @FLEET_INTELLIGENCE.DWELL_ANALYSIS.STREAMLIT_STAGE/dwell/ --overwrite
snow stage copy assets/sis/environment.yml @FLEET_INTELLIGENCE.DWELL_ANALYSIS.STREAMLIT_STAGE/dwell/ --overwrite
snow stage copy assets/sis/pages/1_Live_Operations.py @FLEET_INTELLIGENCE.DWELL_ANALYSIS.STREAMLIT_STAGE/dwell/pages/ --overwrite
snow stage copy assets/sis/pages/2_H3_Congestion_Map.py @FLEET_INTELLIGENCE.DWELL_ANALYSIS.STREAMLIT_STAGE/dwell/pages/ --overwrite
snow stage copy assets/sis/pages/3_Facility_Performance.py @FLEET_INTELLIGENCE.DWELL_ANALYSIS.STREAMLIT_STAGE/dwell/pages/ --overwrite
snow stage copy assets/sis/pages/4_SLA_Alerts.py @FLEET_INTELLIGENCE.DWELL_ANALYSIS.STREAMLIT_STAGE/dwell/pages/ --overwrite
snow stage copy assets/sis/pages/5_Driver_Performance.py @FLEET_INTELLIGENCE.DWELL_ANALYSIS.STREAMLIT_STAGE/dwell/pages/ --overwrite
snow stage copy assets/sis/pages/6_Root_Cause_Analysis.py @FLEET_INTELLIGENCE.DWELL_ANALYSIS.STREAMLIT_STAGE/dwell/pages/ --overwrite
snow stage copy assets/sis/pages/7_Trip_Dwell_Inspector.py @FLEET_INTELLIGENCE.DWELL_ANALYSIS.STREAMLIT_STAGE/dwell/pages/ --overwrite
```

Also upload app_pages modules:

```bash
snow stage copy assets/sis/app_pages/overview.py @FLEET_INTELLIGENCE.DWELL_ANALYSIS.STREAMLIT_STAGE/dwell/app_pages/ --overwrite
snow stage copy assets/sis/app_pages/live_operations.py @FLEET_INTELLIGENCE.DWELL_ANALYSIS.STREAMLIT_STAGE/dwell/app_pages/ --overwrite
snow stage copy assets/sis/app_pages/h3_congestion.py @FLEET_INTELLIGENCE.DWELL_ANALYSIS.STREAMLIT_STAGE/dwell/app_pages/ --overwrite
snow stage copy assets/sis/app_pages/facility_utilization.py @FLEET_INTELLIGENCE.DWELL_ANALYSIS.STREAMLIT_STAGE/dwell/app_pages/ --overwrite
snow stage copy assets/sis/app_pages/sla_alerts.py @FLEET_INTELLIGENCE.DWELL_ANALYSIS.STREAMLIT_STAGE/dwell/app_pages/ --overwrite
snow stage copy assets/sis/app_pages/driver_performance.py @FLEET_INTELLIGENCE.DWELL_ANALYSIS.STREAMLIT_STAGE/dwell/app_pages/ --overwrite
snow stage copy assets/sis/app_pages/root_cause.py @FLEET_INTELLIGENCE.DWELL_ANALYSIS.STREAMLIT_STAGE/dwell/app_pages/ --overwrite
snow stage copy assets/sis/app_pages/trip_inspector.py @FLEET_INTELLIGENCE.DWELL_ANALYSIS.STREAMLIT_STAGE/dwell/app_pages/ --overwrite
```

Create app:

```sql
CREATE OR REPLACE STREAMLIT FLEET_INTELLIGENCE.DWELL_ANALYSIS.DWELL_ANALYTICS_APP
    FROM @FLEET_INTELLIGENCE.DWELL_ANALYSIS.STREAMLIT_STAGE/dwell
    MAIN_FILE = 'streamlit_app.py'
    QUERY_WAREHOUSE = 'COMPUTE_WH'
    TITLE = 'Dwell & Congestion Analytics'
    COMMENT = '{"origin":"sf_sit-is-fleet", "name":"oss-dwell-analysis", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"streamlit"}}';

ALTER STREAMLIT FLEET_INTELLIGENCE.DWELL_ANALYSIS.DWELL_ANALYTICS_APP ADD LIVE VERSION FROM LAST;
```

Get app URL:

```sql
SELECT CONCAT('https://app.snowflake.com/', CURRENT_ORGANIZATION_NAME(), '/', CURRENT_ACCOUNT_NAME(), '/#/streamlit-apps/FLEET_INTELLIGENCE.DWELL_ANALYSIS.DWELL_ANALYTICS_APP') AS streamlit_url;
```

### Step 3: Verify Pipeline

```sql
SELECT 'DT_STATE_CHANGES' AS DT, COUNT(*) AS ROWS FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_STATE_CHANGES
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

- ✋ Step 1: Verify source tables exist before running pipeline
- ✋ Step 1 (after Step 3 SQL): Verify SLA_THRESHOLDS has 5 rows
- ✋ Step 2: Verify Dynamic Tables are refreshing before deploying Streamlit
- ✋ Step 3: Verify all DT row counts are non-zero

## Troubleshooting

| Issue | Solution |
|-------|----------|
| DT_STATE_CHANGES empty | Verify FACT_TRUCK_TELEMETRY has data with matching STATUS values |
| DT_DWELL_SESSIONS zero rows | Check STATUS LIKE 'DWELL%' filter matches your telemetry data |
| SLA alerts not appearing | Verify SLA_THRESHOLDS has matching LOCATION_TYPE values |
| H3 cells NULL | Ensure latitude/longitude values are valid (not NULL or 0) |
| Task not running | Run `ALTER TASK ... RESUME` and verify COMPUTE_WH is active |
| Dynamic Tables stale | Check `SHOW DYNAMIC TABLES` for refresh status and errors |

## Cleanup

To remove all objects created by this skill:

```sql
-- Reverse dependency order: task/stream first, then dynamic tables (leaf to root), tables, stage, schema
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
DROP STREAMLIT IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.DWELL_ANALYTICS_APP;
DROP STAGE IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.STREAMLIT_STAGE;
DROP SCHEMA IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS;
```

> **Tip:** Use the `cleanup` skill to auto-discover all tagged objects via COMMENT tracking.
