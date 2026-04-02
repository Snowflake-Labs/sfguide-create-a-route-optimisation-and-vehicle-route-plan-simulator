---
name: travel-time-matrix
description: "Compute travel time matrices across H3 resolutions using ORS MATRIX_TABULAR in Snowflake. Covers H3 hexagon generation, work queue batching, raw VARIANT staging, parallel workers, FLATTEN post-processing, Task DAG orchestration, and VROOM integration. Use when: building travel time matrices, computing H3-based routing distances, scaling ORS matrix calls, setting up parallel matrix ingestion. Do NOT use for: single point-to-point routing (use ORS DIRECTIONS), fleet simulation data generation, or Streamlit deployment. Triggers: travel time matrix, H3 matrix, matrix tabular, ORS matrix, compute travel times, H3 travel time."
depends_on:
  - build-routing-solution
metadata:
  author: Snowflake SIT-IS
  version: 1.0.0
  category: fleet-intelligence
---

# Travel Time Matrix at Scale — ORS + Snowflake

## Overview

Compute travel time matrices across H3 resolutions using ORS MATRIX_TABULAR in Snowflake. Works for any geography — from a single city to an entire country.

**Key insight**: Raw dump VARIANT payloads first, FLATTEN in bulk after. Never FLATTEN inline during API ingestion.

> **Reference files** (in `references/`):
> - [architecture.md](references/architecture.md) — pipeline architecture, data flow diagrams, scaling model
> - [costing.md](references/costing.md) — credit estimates, cost breakdowns per region preset
> - [ors-config.yml](references/ors-config.yml) — ORS Native App configuration template
> - [setup-infrastructure.sql](references/setup-infrastructure.sql) — one-time infrastructure DDL
> - [sql-procedures.md](references/sql-procedures.md) — all stored procedure SQL (BUILD_TRAVEL_TIME_RANGE, FLATTEN_MATRIX_RAW, CREATE/START/STOP_MATRIX_DAG, monitoring queries)
> - [build-city-matrix.sql](references/build-city-matrix.sql) — end-to-end convenience script for single-city runs
> - [build-ca-travel-time.sql](references/build-ca-travel-time.sql) — California statewide matrix build script

## Region Configuration

Every run is parameterized by a **region config**. Choose resolutions and scaling to match your geography.

### Region Presets

| Preset | Example | Resolutions | Approx Origins | Est. Pairs | Est. Credits | Est. Time |
|--------|---------|-------------|----------------|------------|--------------|-----------|
| **City** | San Francisco, Dublin | 9 only | ~50K | ~6.6M | ~1 | ~5 min |
| **Metro** | Greater LA, London | 8, 9 | ~200K | ~100M | ~8 | ~30 min |
| **State/Region** | California, Bavaria | 7, 8, 9 | ~10M | ~1.94B | ~132 | ~6.5 hrs |
| **Country** | UK, Germany | 6, 7, 8 | ~50M | ~10B | ~680 | ~34 hrs |

### Region Config Parameters

| Parameter | Description | Example (SF) | Example (California) | Example (UK) |
|-----------|-------------|--------------|---------------------|--------------|
| `P_REGION` | Short region identifier | `sf` | `california` | `uk` |
| `P_DB` | Target database | `FLEET_INTELLIGENCE` | `FLEET_INTELLIGENCE` | `FLEET_INTELLIGENCE` |
| `P_MIN_LAT` | Bounding box south | 37.70 | 32.49 | 49.90 |
| `P_MAX_LAT` | Bounding box north | 37.84 | 42.19 | 60.90 |
| `P_MIN_LON` | Bounding box west | -122.52 | -124.42 | -8.65 |
| `P_MAX_LON` | Bounding box east | -122.35 | -114.12 | 1.80 |
| `P_RESOLUTIONS` | H3 resolutions to compute | `[9]` | `[7, 8, 9]` | `[6, 7, 8]` |
| `P_OSM_FILE` | OSM PBF filename on stage | `SanFrancisco.osm.pbf` | `california-latest.osm.pbf` | `great-britain-latest.osm.pbf` |
| `P_ORS_APP` | ORS native app name | `OPENROUTESERVICE_NATIVE_APP` | `OPENROUTESERVICE_NATIVE_APP` | `OPENROUTESERVICE_NATIVE_APP` |
| `P_NUM_WORKERS` | Parallel workers per resolution | 3 | 10 | 20 |
| `P_ORS_INSTANCES` | ORS + gateway instance count | 3 | 10 | 20 |

### Resolution Selection Guide

| Res | Hex Edge | Best For | K-Ring | Avg Dests/Origin | Coverage Radius |
|-----|----------|----------|--------|------------------|-----------------|
| 6 | ~11 km | Country-level strategic | 25 | ~1,000 | ~100 miles |
| 7 | ~3.6 km | State/inter-city | 33 | ~1,567 | ~50 miles |
| 8 | ~1.3 km | Metro/cross-city | 17 | ~438 | ~10 miles |
| 9 | ~0.5 km | City/last-mile delivery | 9 | ~132 | ~2 miles |
| 10 | ~0.2 km | Hyper-local (small city) | 6 | ~60 | ~0.5 miles |

**Rule of thumb**: Pick 1-3 resolutions. Coarser for strategic routing, finer for last-mile. Small cities often only need RES 9.

## Architecture

```
┌──────────────┐    ┌───────────────┐    ┌──────────────┐    ┌──────────────┐
│ H3 Hexagons  │ ─► │ Work Queues   │ ─► │ Raw Staging  │ ─► │ Flattened    │
│ (per res)    │    │ (1×N batches) │    │ (VARIANT)    │    │ Travel Times │
└──────────────┘    └───────────────┘    └──────────────┘    └──────────────┘
     Grid gen          Pre-compute          Parallel API        Post-process
     + pair gen        origins+dests        calls (raw dump)    FLATTEN bulk
```

> Full architecture details: [references/architecture.md](references/architecture.md)

## Prerequisites

1. ORS Native App installed with MATRIX_TABULAR function (gateway v0.6.0+)
2. OSM data loaded for target region
3. ORS graph built for `driving-car` profile (disable unused profiles to save RAM)

## Required Privileges

| Privilege | Scope | Reason |
|-----------|-------|--------|
| CREATE DATABASE | Account | Creates target database for matrix tables |
| CREATE WAREHOUSE | Account | Creates ROUTING_ANALYTICS and FLATTEN_WH warehouses |
| CREATE TABLE | Schema | Creates H3 hex, work queue, raw staging, and travel time tables |
| CREATE PROCEDURE | Schema | Creates worker and DAG management procedures |
| CREATE TASK | Schema | Creates parallel worker tasks |
| EXECUTE TASK | Account | Enables scheduled task execution |
| USAGE ON APPLICATION OPENROUTESERVICE_NATIVE_APP | Application | Calls MATRIX_TABULAR function |
| ALTER SERVICE | Application | Scales ORS/gateway instances |
| ALTER COMPUTE POOL | Compute Pool | Scales compute pool nodes |

> **Note:** ACCOUNTADMIN is NOT required. Create a custom role with the above privileges.

```sql
SHOW FUNCTIONS LIKE 'MATRIX_TABULAR' IN SCHEMA <P_ORS_APP>.CORE;
SELECT <P_ORS_APP>.CORE.ORS_STATUS();
```

---

## Error Logging

When any step fails or produces unexpected results (SQL errors, missing objects, wrong row counts, service failures, deployment issues), log the issue to `logs/` following the format in `logs/README.md`. Create one log file per execution: `travel-time-matrix_{YYYY-MM-DD}_{HH-MM}.md`. Continue execution where possible, logging all issues encountered. If execution completes with no issues, do not create a log file.

## Step 0: Load San Francisco Baseline (Recommended)

The fastest path to a working demo. Loads pre-computed San Francisco data from S3 in ~2 minutes. No ORS calls needed.

### Quick check

```sql
SELECT COUNT(*) FROM FLEET_INTELLIGENCE.TRAVEL_TIME_MATRIX.SF_TRAVEL_TIME_MATRIX;
```

If the table exists and has rows, data is already loaded. Skip to the verification step.

### Load from S3

Execute `references/seed-data.sql`. This creates all tables and loads San Francisco baseline data from `s3://fleet-intelligence/SanFrancisco/travel-time-matrix/`.

### Generate data for other regions (optional)

To generate data for a region other than San Francisco, use the full pipeline starting at Step 2.

Or use the centralized provisioner:
```sql
CALL FLEET_INTELLIGENCE.CORE.PROVISION_REGION('<RegionName>', ARRAY_CONSTRUCT('travel-time-matrix'));
```

## Workflow

### Query Tag

Set at the start of every session:

```sql
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-travel-time-matrix","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

### Step 1: Generate H3 Hexagons

Create hexagon grids covering the target region at each resolution. Run once per resolution.

```sql
CREATE OR REPLACE TABLE <P_DB>.TRAVEL_TIME_MATRIX.<P_REGION>_H3_RES<N> AS
WITH lat_series AS (
    SELECT <P_MIN_LAT> + (SEQ4() * <LAT_STEP>) AS lat
    FROM TABLE(GENERATOR(ROWCOUNT => <LAT_COUNT>))
    WHERE <P_MIN_LAT> + (SEQ4() * <LAT_STEP>) <= <P_MAX_LAT>
),
lon_series AS (
    SELECT <P_MIN_LON> + (SEQ4() * <LON_STEP>) AS lon
    FROM TABLE(GENERATOR(ROWCOUNT => <LON_COUNT>))
    WHERE <P_MIN_LON> + (SEQ4() * <LON_STEP>) <= <P_MAX_LON>
),
h3_cells AS (
    SELECT DISTINCT H3_POINT_TO_CELL_STRING(ST_MAKEPOINT(lon, lat), <N>) AS h3_index
    FROM lat_series CROSS JOIN lon_series
)
SELECT h3_index,
       ST_X(H3_CELL_TO_POINT(h3_index)) AS lon,
       ST_Y(H3_CELL_TO_POINT(h3_index)) AS lat
FROM h3_cells;

ALTER TABLE <P_DB>.TRAVEL_TIME_MATRIX.<P_REGION>_H3_RES<N> SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-travel-time-matrix","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

Grid step sizes: RES 6=0.05, RES 7=0.02, RES 8=0.008, RES 9=0.003, RES 10=0.001.

### Step 2: Build Work Queues

Combines H3_GRID_DISK neighbour lookup, coordinate packing, and grouping — each row is a ready-to-fire MATRIX_TABULAR call.

```sql
CREATE OR REPLACE TABLE <P_DB>.TRAVEL_TIME_MATRIX.<P_REGION>_WORK_QUEUE_RES<N> AS
WITH pairs AS (
    SELECT a.h3_index AS origin_h3, a.lon AS origin_lon, a.lat AS origin_lat,
           n.value::STRING AS dest_h3
    FROM <P_DB>.TRAVEL_TIME_MATRIX.<P_REGION>_H3_RES<N> a,
    LATERAL FLATTEN(input => H3_GRID_DISK(a.h3_index, <K_RING>)) n
    WHERE n.value::STRING IN (SELECT h3_index FROM <P_DB>.TRAVEL_TIME_MATRIX.<P_REGION>_H3_RES<N>)
      AND a.h3_index != n.value::STRING
),
grouped AS (
    SELECT origin_h3, origin_lon, origin_lat,
           ARRAY_AGG(ARRAY_CONSTRUCT(d.lon, d.lat)) AS dest_coords,
           ARRAY_AGG(p.dest_h3) AS dest_hex_ids
    FROM pairs p
    JOIN <P_DB>.TRAVEL_TIME_MATRIX.<P_REGION>_H3_RES<N> d ON p.dest_h3 = d.h3_index
    GROUP BY origin_h3, origin_lon, origin_lat
)
SELECT ROW_NUMBER() OVER (ORDER BY origin_h3) AS seq_id,
       origin_h3, origin_lon, origin_lat, dest_coords, dest_hex_ids
FROM grouped;

ALTER TABLE <P_DB>.TRAVEL_TIME_MATRIX.<P_REGION>_WORK_QUEUE_RES<N> CLUSTER BY (SEQ_ID);

ALTER TABLE <P_DB>.TRAVEL_TIME_MATRIX.<P_REGION>_WORK_QUEUE_RES<N> SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-travel-time-matrix","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

### Step 3: Create Raw Staging Tables

Raw tables store VARIANT payloads from MATRIX_TABULAR with zero transformation.

```sql
CREATE OR REPLACE TABLE <P_DB>.TRAVEL_TIME_MATRIX.<P_REGION>_MATRIX_RAW_RES<N> (
    SEQ_ID INTEGER, ORIGIN_H3 VARCHAR, DEST_HEX_IDS ARRAY, MATRIX_RESULT VARIANT
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-travel-time-matrix","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
;
```

**Why raw dump beats inline FLATTEN:** INSERT...SELECT with FLATTEN blocks until the ENTIRE batch completes. Raw dump inserts immediately as each batch returns.

### Step 4: Deploy Worker Procedure

> Full SQL: [references/sql-procedures.md](references/sql-procedures.md) — `BUILD_TRAVEL_TIME_RANGE`

Resume-safe, retry-aware, adaptive batch sizing. Key parameters:
- `P_REGION`, `P_RES`, `P_START_SEQ`, `P_END_SEQ`, `P_ORS_APP`
- Batch sizes: RES 6-7 = 100, RES 8 = 1000, RES 9+ = 2000
- Exponential backoff: 10s → 20s → 40s → 80s → 160s, max 5 retries

### Step 5: Scale Infrastructure

| Preset | Warehouse Clusters | ORS/Gateway Instances | Compute Pool Nodes |
|--------|-------------------|-----------------------|-------------------|
| **City** | 3 | 3 | 3 |
| **Metro** | 5 | 5 | 5 |
| **State/Region** | 10 | 10 | 10 |
| **Country** | 20 | 20 | 20 |

```sql
CREATE OR REPLACE WAREHOUSE ROUTING_ANALYTICS
    WAREHOUSE_SIZE = 'XSMALL'
    MIN_CLUSTER_COUNT = 1
    MAX_CLUSTER_COUNT = <P_ORS_INSTANCES>
    SCALING_POLICY = 'STANDARD'
    AUTO_SUSPEND = 300
    AUTO_RESUME = TRUE
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-travel-time-matrix","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

ALTER SERVICE IF EXISTS <P_ORS_APP>.CORE.ORS_SERVICE
    SET MIN_INSTANCES = <P_ORS_INSTANCES> MAX_INSTANCES = <P_ORS_INSTANCES>;
ALTER SERVICE IF EXISTS <P_ORS_APP>.CORE.ROUTING_GATEWAY_SERVICE
    SET MIN_INSTANCES = <P_ORS_INSTANCES> MAX_INSTANCES = <P_ORS_INSTANCES>;
ALTER COMPUTE POOL <POOL_NAME>
    SET MIN_NODES = <P_ORS_INSTANCES> MAX_NODES = <P_ORS_INSTANCES>;
```

**Gateway instances MUST match ORS instances** — gateway was the bottleneck at 3 when ORS had 10.

Wait for warm-up: `SELECT <P_ORS_APP>.CORE.ORS_STATUS();` — confirm `service_ready = true`.

### Step 6: Create and Launch the Task DAG

> Full SQL: [references/sql-procedures.md](references/sql-procedures.md) — `CREATE_MATRIX_DAG`, `START_MATRIX_DAG`, `STOP_MATRIX_DAG`

```sql
CALL CREATE_MATRIX_DAG('FLEET_INTELLIGENCE', 'SF', ARRAY_CONSTRUCT(9), 'ROUTING_ANALYTICS', 'FLATTEN_WH', 3);
CALL START_MATRIX_DAG('FLEET_INTELLIGENCE', 'SF', ARRAY_CONSTRUCT(9), 3);

CALL CREATE_MATRIX_DAG('FLEET_INTELLIGENCE', 'CA', ARRAY_CONSTRUCT(7, 8, 9), 'ROUTING_ANALYTICS', 'FLATTEN_WH', 10);
CALL START_MATRIX_DAG('FLEET_INTELLIGENCE', 'CA', ARRAY_CONSTRUCT(7, 8, 9), 10);

CALL STOP_MATRIX_DAG('FLEET_INTELLIGENCE', 'SF', ARRAY_CONSTRUCT(9), 3);
```

### Step 7: Monitor Progress

> Full monitoring queries: [references/sql-procedures.md](references/sql-procedures.md) — `MATRIX_PROGRESS`

Quick progress check:

```sql
SELECT COUNT(*) AS done,
       (SELECT COUNT(*) FROM <P_DB>.TRAVEL_TIME_MATRIX.<P_REGION>_WORK_QUEUE_RES<N>) AS total,
       ROUND(COUNT(*) * 100.0 / NULLIF((SELECT COUNT(*) FROM <P_DB>.TRAVEL_TIME_MATRIX.<P_REGION>_WORK_QUEUE_RES<N>), 0), 1) AS pct
FROM <P_DB>.TRAVEL_TIME_MATRIX.<P_REGION>_MATRIX_RAW_RES<N>;
```

### Step 8: FLATTEN Raw Data

> Full SQL: [references/sql-procedures.md](references/sql-procedures.md) — `FLATTEN_MATRIX_RAW`

Run on a dedicated XLARGE warehouse:

```sql
CREATE WAREHOUSE IF NOT EXISTS FLATTEN_WH
    WITH WAREHOUSE_SIZE = 'XLARGE' AUTO_SUSPEND = 60 AUTO_RESUME = TRUE
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-travel-time-matrix","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
USE WAREHOUSE FLATTEN_WH;
CALL FLATTEN_MATRIX_RAW('<P_REGION>', <N>);
```

### Step 9: Scale Down

```sql
ALTER WAREHOUSE ROUTING_ANALYTICS SET MIN_CLUSTER_COUNT = 1 MAX_CLUSTER_COUNT = 1;
ALTER WAREHOUSE ROUTING_ANALYTICS SUSPEND;
ALTER WAREHOUSE FLATTEN_WH SUSPEND;
ALTER SERVICE IF EXISTS <P_ORS_APP>.CORE.ORS_SERVICE SET MIN_INSTANCES = 1 MAX_INSTANCES = 1;
ALTER SERVICE IF EXISTS <P_ORS_APP>.CORE.ROUTING_GATEWAY_SERVICE SET MIN_INSTANCES = 1 MAX_INSTANCES = 1;
ALTER COMPUTE POOL <POOL_NAME> SET MIN_NODES = 1 MAX_NODES = 1;
```

---

## Alternative: Manual Bash Launch

For ad-hoc runs or more control:

```bash
#!/bin/bash
REGION="sf"; RES=9; TOTAL=50000; WORKERS=3; CONNECTION="myconn"; DB="FLEET_INTELLIGENCE"
chunk_size=$(( (TOTAL + WORKERS - 1) / WORKERS ))
for w in $(seq 0 $((WORKERS - 1))); do
    start_seq=$(( w * chunk_size + 1 ))
    end_seq=$(( (w + 1) * chunk_size ))
    [ $end_seq -gt $TOTAL ] && end_seq=$TOTAL
    [ $start_seq -gt $TOTAL ] && break
    snow sql -c $CONNECTION -q "
        USE ROLE ACCOUNTADMIN; USE WAREHOUSE ROUTING_ANALYTICS;
        CALL ${DB}.TRAVEL_TIME_MATRIX.BUILD_TRAVEL_TIME_RANGE('${REGION}', ${RES}, ${start_seq}, ${end_seq});
    " 2>/dev/null &
    sleep 3
done
wait
```

---

## Consuming the Data

### Bidirectional Query Pattern (REQUIRED)

The work queue stores each pair (A, B) only once. **You MUST query both directions:**

```sql
SELECT DEST_H3 AS hex_id, TRAVEL_TIME_SECONDS, TRAVEL_DISTANCE_METERS
FROM <P_DB>.TRAVEL_TIME_MATRIX.<P_REGION>_TRAVEL_TIME_RES<N>
WHERE ORIGIN_H3 = '<my_origin_hex>' AND TRAVEL_TIME_SECONDS <= 1800
UNION ALL
SELECT ORIGIN_H3 AS hex_id, TRAVEL_TIME_SECONDS, TRAVEL_DISTANCE_METERS
FROM <P_DB>.TRAVEL_TIME_MATRIX.<P_REGION>_TRAVEL_TIME_RES<N>
WHERE DEST_H3 = '<my_origin_hex>' AND TRAVEL_TIME_SECONDS <= 1800
ORDER BY TRAVEL_TIME_SECONDS;
```

**Without the UNION ALL, you will miss approximately half of the reachable hexagons.**

### Point-to-Point Lookup

```sql
SELECT TRAVEL_TIME_SECONDS, TRAVEL_DISTANCE_METERS
FROM <P_DB>.TRAVEL_TIME_MATRIX.<P_REGION>_TRAVEL_TIME_RES<N>
WHERE (ORIGIN_H3 = '<hex_a>' AND DEST_H3 = '<hex_b>')
   OR (ORIGIN_H3 = '<hex_b>' AND DEST_H3 = '<hex_a>')
LIMIT 1;
```

### Search Optimization

```sql
ALTER TABLE <P_DB>.TRAVEL_TIME_MATRIX.<P_REGION>_TRAVEL_TIME_RES<N>
  ADD SEARCH OPTIMIZATION ON EQUALITY(ORIGIN_H3, DEST_H3);
```

## VROOM Integration

Pre-computed travel times feed directly into VROOM's `matrices` parameter:

```sql
WITH locations AS (
    SELECT ROW_NUMBER() OVER (ORDER BY location_id) - 1 AS idx,
           location_id, lon, lat,
           H3_POINT_TO_CELL_STRING(ST_MAKEPOINT(lon, lat), <N>) AS h3_index
    FROM my_delivery_locations
),
pairs AS (
    SELECT a.idx AS origin_idx, b.idx AS dest_idx,
           COALESCE(tt.TRAVEL_TIME_SECONDS, 0) AS duration,
           COALESCE(tt.TRAVEL_DISTANCE_METERS, 0) AS distance
    FROM locations a CROSS JOIN locations b
    LEFT JOIN <P_DB>.TRAVEL_TIME_MATRIX.<P_REGION>_TRAVEL_TIME_RES<N> tt
        ON (tt.ORIGIN_H3 = a.h3_index AND tt.DEST_H3 = b.h3_index)
        OR (tt.ORIGIN_H3 = b.h3_index AND tt.DEST_H3 = a.h3_index)
)
SELECT ARRAY_AGG(duration_row) AS duration_matrix
FROM (
    SELECT origin_idx, ARRAY_AGG(duration) WITHIN GROUP (ORDER BY dest_idx) AS duration_row
    FROM pairs GROUP BY origin_idx ORDER BY origin_idx
);
```

---

### Step 10: Register with Demo Dashboard

> **DEPRECATED:** `DEMO_DASHBOARD_APP` has been removed. All demo pages are now built into `ORS_CONTROL_APP` (in `OPENROUTESERVICE_NATIVE_APP`). No registration step is needed — Travel Time Explorer is available automatically in the ORS sidebar.

---

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| 503 Upstream Connect | Too many workers overwhelming gateway | Scale gateway instances to match ORS; retry with backoff |
| 500 Internal Server Error | Too many matrix elements (>500K per request) | Reduce batch_size for that resolution |
| Workers producing 0 rows | Inline FLATTEN blocking | Use raw dump approach |
| ORS out-of-bounds errors | H3 centroids in water/outside road network | Expected; FLATTEN filters with `WHERE MATRIX_RESULT:durations IS NOT NULL` |
| App upgrade restarts ORS | ADD PATCH + UPGRADE restarts services | Wait for `ORS_STATUS()` = `service_ready` before launching |

## Key Learnings

1. **Raw dump then FLATTEN** — never FLATTEN during API ingestion
2. **Gateway = hidden bottleneck** — must match ORS instance count
3. **Adaptive batch sizing** — heavy resolutions need small batches
4. **Multi-cluster XSMALL** — workers are I/O-bound, not compute-bound
5. **Resume safety is essential** — procedures resume from last completed SEQ_ID
6. **XLARGE for FLATTEN, XSMALL for API calls** — different workloads need different shapes
7. **Right-size for your region** — don't over-provision a single city
8. **ORS throughput: ~67.5 calls/sec/instance** — scale nodes linearly
9. **MAX_BATCH_ROWS stays at 1000** — reduce per-procedure batch_size instead

> **Cost estimates**: See [references/costing.md](references/costing.md) for detailed credit breakdowns.

## Stopping Points

- ✋ Step 1: Verify H3 hexagon counts match expected for region/resolution
- ✋ Step 2: Verify work queue row count before launching workers
- ✋ Step 5: Confirm ORS_STATUS() returns `service_ready = true` after scaling
- ✋ Step 7: Monitor progress to >95% before FLATTEN
- ✋ Step 8: Verify FLATTEN row count matches expected pairs
- ✋ Step 9: Confirm infrastructure scaled back down to avoid runaway costs

## Cleanup

To remove all objects created by this skill:

```sql
-- Reverse dependency order: procedures first, then tables, warehouses
-- Replace <P_REGION> and <N> with your actual region and resolution values (e.g., SF, 9)
DROP PROCEDURE IF EXISTS <P_DB>.TRAVEL_TIME_MATRIX.STOP_MATRIX_DAG(VARCHAR, VARCHAR, ARRAY, NUMBER);
DROP PROCEDURE IF EXISTS <P_DB>.TRAVEL_TIME_MATRIX.START_MATRIX_DAG(VARCHAR, VARCHAR, ARRAY, NUMBER);
DROP PROCEDURE IF EXISTS <P_DB>.TRAVEL_TIME_MATRIX.CREATE_MATRIX_DAG(VARCHAR, VARCHAR, ARRAY, VARCHAR, VARCHAR, NUMBER);
DROP PROCEDURE IF EXISTS <P_DB>.TRAVEL_TIME_MATRIX.FLATTEN_MATRIX_RAW(VARCHAR, NUMBER);
DROP PROCEDURE IF EXISTS <P_DB>.TRAVEL_TIME_MATRIX.BUILD_TRAVEL_TIME_RANGE(VARCHAR, NUMBER, NUMBER, NUMBER, VARCHAR);
DROP TABLE IF EXISTS <P_DB>.TRAVEL_TIME_MATRIX.<P_REGION>_TRAVEL_TIME_RES<N>;
DROP TABLE IF EXISTS <P_DB>.TRAVEL_TIME_MATRIX.<P_REGION>_MATRIX_RAW_RES<N>;
DROP TABLE IF EXISTS <P_DB>.TRAVEL_TIME_MATRIX.<P_REGION>_WORK_QUEUE_RES<N>;
DROP TABLE IF EXISTS <P_DB>.TRAVEL_TIME_MATRIX.<P_REGION>_H3_RES<N>;
DROP WAREHOUSE IF EXISTS FLATTEN_WH;
DROP WAREHOUSE IF EXISTS ROUTING_ANALYTICS;
```

> **Tip:** Use the `cleanup` skill to auto-discover all tagged objects via COMMENT tracking.
