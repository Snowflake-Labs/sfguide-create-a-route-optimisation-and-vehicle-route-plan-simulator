# Travel Time Matrix at Scale — ORS + Snowflake

## Overview

Compute billions of travel time pairs across H3 resolutions using ORS MATRIX_TABULAR in Snowflake. Proven at scale on California (1.94B pairs across resolutions 7, 8, 9).

**Key insight**: Raw dump VARIANT payloads first, FLATTEN in bulk after. Never FLATTEN inline during API ingestion.

## Architecture

```
┌──────────────┐    ┌───────────────┐    ┌──────────────┐    ┌──────────────┐
│ H3 Hexagons  │ ─► │ Work Queues   │ ─► │ Raw Staging  │ ─► │ Flattened    │
│ (per res)    │    │ (1×N batches) │    │ (VARIANT)    │    │ Travel Times │
└──────────────┘    └───────────────┘    └──────────────┘    └──────────────┘
     Grid gen          Pre-compute          Parallel API        Post-process
     + pair gen        origins+dests        calls (raw dump)    FLATTEN bulk
```

## Tiered Resolution Strategy

| Res | Hex Size | Origins | Avg Dests/Origin | Total Pairs | Use Case |
|-----|----------|---------|------------------|-------------|----------|
| 7 | ~36 km | 177K | ~1,567 | 278M | Strategic/inter-city |
| 8 | ~4.6 km | 1.2M | ~438 | 526M | Mid-range/cross-city |
| 9 | ~1.2 km | 8.6M | ~132 | 1.13B | Last-mile delivery |

Each origin pairs with **nearby reachable destinations only** (not all-to-all). Destinations are pre-computed per origin using H3_GRID_DISK with resolution-specific k-ring radii.

## Prerequisites

1. ORS Native App installed with MATRIX_TABULAR function (gateway v0.6.0+)
2. OSM data loaded for target region
3. ORS graph built for `driving-car` profile (disable unused profiles to save RAM)

```sql
SHOW FUNCTIONS LIKE 'MATRIX_TABULAR' IN SCHEMA OPENROUTESERVICE_NATIVE_APP.CORE;
SELECT OPENROUTESERVICE_NATIVE_APP.CORE.ORS_STATUS();
```

---

## Workflow

### Step 1: Generate H3 Hexagons

Create hexagon grids covering the target region at each resolution.

```sql
CREATE OR REPLACE TABLE <DB>.PUBLIC.CA_H3_<RES> AS
WITH lat_series AS (
    SELECT <MIN_LAT> + (SEQ4() * <LAT_STEP>) AS lat
    FROM TABLE(GENERATOR(ROWCOUNT => <LAT_COUNT>))
    WHERE <MIN_LAT> + (SEQ4() * <LAT_STEP>) <= <MAX_LAT>
),
lon_series AS (
    SELECT <MIN_LON> + (SEQ4() * <LON_STEP>) AS lon
    FROM TABLE(GENERATOR(ROWCOUNT => <LON_COUNT>))
    WHERE <MIN_LON> + (SEQ4() * <LON_STEP>) <= <MAX_LON>
),
h3_cells AS (
    SELECT DISTINCT H3_POINT_TO_CELL_STRING(ST_MAKEPOINT(lon, lat), <RESOLUTION>) AS h3_index
    FROM lat_series CROSS JOIN lon_series
)
SELECT h3_index,
       ST_X(H3_CELL_TO_POINT(h3_index)) AS lon,
       ST_Y(H3_CELL_TO_POINT(h3_index)) AS lat
FROM h3_cells;
```

**Grid step sizes** (California bounding box 32.49°–42.19° lat, -124.42°–-114.12° lon):

| Res | Lat Step | Lon Step | Approx Hexagons |
|-----|----------|----------|-----------------|
| 7 | 0.02 | 0.02 | ~177K |
| 8 | 0.008 | 0.008 | ~1.2M |
| 9 | 0.003 | 0.003 | ~8.6M |

### Step 2: Build Work Queues

The work queue **replaces separate pair generation entirely**. It combines H3_GRID_DISK neighbour lookup, coordinate packing, and grouping into a single table — each row is a ready-to-fire MATRIX_TABULAR call. No intermediate pair tables needed.

```sql
CREATE OR REPLACE TABLE <DB>.PUBLIC.CA_WORK_QUEUE_<RES> AS
WITH pairs AS (
    SELECT
        a.h3_index AS origin_h3,
        a.lon AS origin_lon,
        a.lat AS origin_lat,
        n.value::STRING AS dest_h3
    FROM <DB>.PUBLIC.CA_H3_<RES> a,
    LATERAL FLATTEN(input => H3_GRID_DISK(a.h3_index, <K_RING>)) n
    WHERE n.value::STRING IN (SELECT h3_index FROM <DB>.PUBLIC.CA_H3_<RES>)
      AND a.h3_index != n.value::STRING
),
grouped AS (
    SELECT
        origin_h3, origin_lon, origin_lat,
        ARRAY_AGG(ARRAY_CONSTRUCT(d.lon, d.lat)) AS dest_coords,
        ARRAY_AGG(p.dest_h3) AS dest_hex_ids
    FROM pairs p
    JOIN <DB>.PUBLIC.CA_H3_<RES> d ON p.dest_h3 = d.h3_index
    GROUP BY origin_h3, origin_lon, origin_lat
)
SELECT
    ROW_NUMBER() OVER (ORDER BY origin_h3) AS seq_id,
    origin_h3, origin_lon, origin_lat,
    dest_coords, dest_hex_ids
FROM grouped;

ALTER TABLE <DB>.PUBLIC.CA_WORK_QUEUE_<RES> CLUSTER BY (SEQ_ID);
```

**K-ring radii** (controls destination reach per resolution):

| Res | K-ring | Avg Dests/Origin | Coverage |
|-----|--------|------------------|----------|
| 7 | 33 | ~1,567 | ~50 miles |
| 8 | 17 | ~438 | ~10 miles |
| 9 | 9 | ~132 | ~2 miles |

### Step 3: Create Raw Staging Tables

Raw tables store the VARIANT payload from MATRIX_TABULAR with zero transformation. This is the breakthrough pattern — **never FLATTEN during API ingestion**.

```sql
CREATE OR REPLACE TABLE <DB>.PUBLIC.CA_MATRIX_RAW_<RES> (
    SEQ_ID INTEGER,
    ORIGIN_H3 VARCHAR,
    DEST_HEX_IDS ARRAY,
    MATRIX_RESULT VARIANT
);
```

**Why raw dump beats inline FLATTEN:**
- INSERT...SELECT with FLATTEN blocks until the ENTIRE batch of MATRIX_TABULAR calls completes before any rows commit
- With 100-2000 origins per batch, that's minutes of zero visible progress
- Raw dump inserts VARIANT immediately as each batch returns
- FLATTEN is a pure Snowflake compute operation — fast and parallelizable after the fact

### Step 4: Create the Worker Procedure

Resume-safe, retry-aware, adaptive batch sizing.

```sql
CREATE OR REPLACE PROCEDURE <DB>.PUBLIC.BUILD_TRAVEL_TIME_RANGE(
    P_RES VARCHAR,
    P_START_SEQ INTEGER,
    P_END_SEQ INTEGER
)
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    batch_size INTEGER;
    current_pos INTEGER;
    batch_end INTEGER;
    batch_num INTEGER DEFAULT 0;
    queue_table VARCHAR;
    raw_table VARCHAR;
    insert_sql VARCHAR;
    resume_sql VARCHAR;
    max_done INTEGER DEFAULT 0;
    rs RESULTSET;
    retry_count INTEGER DEFAULT 0;
    max_retries INTEGER DEFAULT 5;
    retry_wait INTEGER DEFAULT 10;
BEGIN
    queue_table := '<DB>.PUBLIC.CA_WORK_QUEUE_' || P_RES;
    raw_table := '<DB>.PUBLIC.CA_MATRIX_RAW_' || P_RES;

    -- Adaptive batch sizing: heavier origins = smaller batches
    IF (P_RES = 'RES7') THEN
        batch_size := 100;      -- ~1567 dests/origin = ~157K matrix elements/batch
    ELSEIF (P_RES = 'RES8') THEN
        batch_size := 1000;     -- ~438 dests/origin = ~438K matrix elements/batch
    ELSE
        batch_size := 2000;     -- ~132 dests/origin = ~264K matrix elements/batch
    END IF;

    -- Resume: find last completed SEQ_ID in our range
    resume_sql := 'SELECT COALESCE(MAX(SEQ_ID), ' || (P_START_SEQ - 1) ||
                  ') AS MAX_DONE FROM ' || raw_table ||
                  ' WHERE SEQ_ID BETWEEN ' || P_START_SEQ || ' AND ' || P_END_SEQ;
    rs := (EXECUTE IMMEDIATE :resume_sql);
    LET c CURSOR FOR rs;
    FOR row_val IN c DO
        max_done := row_val.MAX_DONE;
    END FOR;

    current_pos := max_done + 1;

    WHILE (current_pos <= P_END_SEQ) DO
        batch_num := batch_num + 1;
        batch_end := LEAST(current_pos + batch_size - 1, P_END_SEQ);
        retry_count := 0;
        retry_wait := 10;

        insert_sql := '
        INSERT INTO ' || raw_table || '
        SELECT
            q.SEQ_ID,
            q.ORIGIN_H3,
            q.DEST_HEX_IDS,
            OPENROUTESERVICE_NATIVE_APP.CORE.MATRIX_TABULAR(
                ''driving-car'',
                ARRAY_CONSTRUCT(q.ORIGIN_LON, q.ORIGIN_LAT),
                q.DEST_COORDS
            )
        FROM ' || queue_table || ' q
        WHERE q.SEQ_ID BETWEEN ' || current_pos || ' AND ' || batch_end;

        -- Retry with exponential backoff (503/500 from ORS overload)
        WHILE (retry_count <= max_retries) DO
            BEGIN
                EXECUTE IMMEDIATE :insert_sql;
                retry_count := max_retries + 1;  -- success, exit retry loop
            EXCEPTION
                WHEN OTHER THEN
                    retry_count := retry_count + 1;
                    IF (retry_count > max_retries) THEN
                        RAISE;
                    END IF;
                    EXECUTE IMMEDIATE 'SELECT SYSTEM$WAIT(' || retry_wait || ')';
                    retry_wait := retry_wait * 2;  -- 10s, 20s, 40s, 80s, 160s
            END;
        END WHILE;

        current_pos := batch_end + 1;
    END WHILE;

    RETURN P_RES || ' range [' || P_START_SEQ || '-' || P_END_SEQ ||
           '] complete: ' || batch_num || ' batches of ' || batch_size ||
           ' (resumed from seq ' || max_done || ')';
END;
$$;
```

**Adaptive batch sizing rationale:**
- ORS has a practical limit of ~500K matrix elements per HTTP request
- RES7: 100 origins × 1567 dests = ~157K elements (safe)
- RES8: 1000 origins × 438 dests = ~438K elements (safe)
- RES9: 2000 origins × 132 dests = ~264K elements (safe)
- Going over causes ORS 500 Internal Server Error

### Step 5: Scale Infrastructure

**This is critical.** At scale you need parallel workers, each with dedicated compute, and enough ORS instances to handle the load.

#### Multi-Cluster Warehouse (for worker concurrency)

```sql
CREATE OR REPLACE WAREHOUSE ROUTING_ANALYTICS
    WAREHOUSE_SIZE = 'XSMALL'
    MIN_CLUSTER_COUNT = 1
    MAX_CLUSTER_COUNT = 10
    SCALING_POLICY = 'STANDARD'
    AUTO_SUSPEND = 300
    AUTO_RESUME = TRUE;
```

**Why XSMALL:** Workers are just sending API calls to ORS and inserting VARIANT responses — the bottleneck is ORS response time, not Snowflake compute. XSMALL is sufficient and costs 16× less than MEDIUM per cluster.

**Why MIN=1, MAX=10:** Auto-scaling spins up clusters as workers need them and scales down during idle gaps between batches. This saves ~50% vs fixed MIN=MAX=10. The STANDARD scaling policy adds clusters as queued queries accumulate.

> **Cost Lesson:** Using MIN=MAX=10 keeps all 10 clusters hot even when only a few workers are active. The optimal configuration (`MIN=1, MAX=10, XSMALL`) costs ~$231 for the full California build vs ~$1,695 with suboptimal settings. See COSTING.md for the detailed breakdown.

#### ORS Native App Scaling

Scale ORS instances and gateway instances via native app patch:

```sql
-- In setup_script.sql, scale services:
-- ORS: match to compute pool node count
ALTER SERVICE IF EXISTS core.ors_service SET MIN_INSTANCES = 10 MAX_INSTANCES = 10;

-- Gateway: MUST match ORS instance count (was the bottleneck at 3)
ALTER SERVICE IF EXISTS core.routing_gateway_service SET MIN_INSTANCES = 10 MAX_INSTANCES = 10;

-- Compute pool: enough nodes for all service instances
ALTER COMPUTE POOL <pool_name> SET MIN_NODES = 10 MAX_NODES = 10;
```

**Scaling rules:**
- Gateway instances MUST match ORS instances (gateway was the bottleneck at 3 when ORS had 10)
- Each ORS instance handles ~67.5 MATRIX_TABULAR calls/sec
- 10 instances = ~675 calls/sec total throughput ceiling
- MATRIX_TABULAR MAX_BATCH_ROWS should stay at 1000 (don't reduce globally — higher resolutions need it)

#### Wait for ORS Warm-Up

After any native app upgrade, ORS instances restart and must rebuild graphs (~40-60s):

```sql
SELECT OPENROUTESERVICE_NATIVE_APP.CORE.ORS_STATUS();
-- Wait until service_ready = true before launching workers
```

### Step 6: Create and Launch the Task DAG

Use Snowflake Tasks to automate the entire pipeline. The DAG dynamically creates:
- **3 root tasks** (one per resolution) — triggers the pipeline
- **10 worker tasks per resolution** (30 total) — each processes a SEQ_ID range in parallel
- **3 flatten tasks** — fires automatically when ALL workers for that resolution complete

The multi-cluster warehouse (MIN=MAX=10) automatically spawns clusters for the 10 concurrent worker tasks per resolution.

```
TASK_BUILD_QUEUE_RES7 ──┬── TASK_WORKER_RES7_01 (seq 1-17735)
                         ├── TASK_WORKER_RES7_02 (seq 17736-35470)
                         ├── ...
                         └── TASK_WORKER_RES7_10 (seq 159612-177346)
                                   └── TASK_FLATTEN_RES7 (XL warehouse)

TASK_BUILD_QUEUE_RES8 ──┬── TASK_WORKER_RES8_01 ── ... ── TASK_FLATTEN_RES8
TASK_BUILD_QUEUE_RES9 ──┬── TASK_WORKER_RES9_01 ── ... ── TASK_FLATTEN_RES9
```

#### CREATE_MATRIX_DAG — generates all tasks dynamically

```sql
CREATE OR REPLACE PROCEDURE <DB>.PUBLIC.CREATE_MATRIX_DAG(
    P_DB VARCHAR,
    P_ROUTING_WH VARCHAR,
    P_FLATTEN_WH VARCHAR,
    P_NUM_WORKERS INTEGER DEFAULT 10
)
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    res_list ARRAY DEFAULT ARRAY_CONSTRUCT('RES7', 'RES8', 'RES9');
    res VARCHAR;
    total_rows INTEGER;
    chunk_size INTEGER;
    start_seq INTEGER;
    end_seq INTEGER;
    w INTEGER;
    task_name VARCHAR;
    worker_list VARCHAR;
    ddl VARCHAR;
    i INTEGER DEFAULT 0;
    rs RESULTSET;
BEGIN
    FOR i IN 0 TO 2 DO
        res := res_list[i];
        BEGIN
            EXECUTE IMMEDIATE 'DROP TASK IF EXISTS ' || P_DB || '.PUBLIC.TASK_FLATTEN_' || res;
        EXCEPTION WHEN OTHER THEN NULL; END;
        w := 1;
        WHILE (w <= P_NUM_WORKERS) DO
            BEGIN
                EXECUTE IMMEDIATE 'DROP TASK IF EXISTS ' || P_DB || '.PUBLIC.TASK_WORKER_' || res || '_' || LPAD(w, 2, '0');
            EXCEPTION WHEN OTHER THEN NULL; END;
            w := w + 1;
        END WHILE;
        BEGIN
            EXECUTE IMMEDIATE 'DROP TASK IF EXISTS ' || P_DB || '.PUBLIC.TASK_BUILD_QUEUE_' || res;
        EXCEPTION WHEN OTHER THEN NULL; END;
    END FOR;

    FOR i IN 0 TO 2 DO
        res := res_list[i];

        rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || P_DB || '.PUBLIC.CA_WORK_QUEUE_' || res);
        LET c1 CURSOR FOR rs;
        FOR r IN c1 DO
            total_rows := r.CNT;
        END FOR;
        chunk_size := CEIL(total_rows / P_NUM_WORKERS);

        ddl := 'CREATE OR REPLACE TASK ' || P_DB || '.PUBLIC.TASK_BUILD_QUEUE_' || res ||
               ' WAREHOUSE = ' || P_FLATTEN_WH ||
               ' AS SELECT ''Work queue ' || res || ' ready: ' || total_rows || ' origins''';
        EXECUTE IMMEDIATE ddl;

        w := 1;
        WHILE (w <= P_NUM_WORKERS) DO
            start_seq := ((w - 1) * chunk_size) + 1;
            end_seq := LEAST(w * chunk_size, total_rows);
            IF (start_seq <= total_rows) THEN
                task_name := P_DB || '.PUBLIC.TASK_WORKER_' || res || '_' || LPAD(w, 2, '0');
                ddl := 'CREATE OR REPLACE TASK ' || task_name ||
                       ' WAREHOUSE = ' || P_ROUTING_WH ||
                       ' AFTER ' || P_DB || '.PUBLIC.TASK_BUILD_QUEUE_' || res ||
                       ' AS CALL ' || P_DB || '.PUBLIC.BUILD_TRAVEL_TIME_RANGE(''' || res || ''', ' || start_seq || ', ' || end_seq || ')';
                EXECUTE IMMEDIATE ddl;
            END IF;
            w := w + 1;
        END WHILE;

        worker_list := '';
        w := 1;
        WHILE (w <= P_NUM_WORKERS) DO
            IF (((w - 1) * chunk_size) + 1 <= total_rows) THEN
                IF (worker_list != '') THEN
                    worker_list := worker_list || ', ';
                END IF;
                worker_list := worker_list || P_DB || '.PUBLIC.TASK_WORKER_' || res || '_' || LPAD(w, 2, '0');
            END IF;
            w := w + 1;
        END WHILE;

        ddl := 'CREATE OR REPLACE TASK ' || P_DB || '.PUBLIC.TASK_FLATTEN_' || res ||
               ' WAREHOUSE = ' || P_FLATTEN_WH ||
               ' AFTER ' || worker_list ||
               ' AS CALL ' || P_DB || '.PUBLIC.FLATTEN_MATRIX_RAW(''' || res || ''')';
        EXECUTE IMMEDIATE ddl;
    END FOR;

    RETURN 'DAG created: 3 root tasks, ' || (P_NUM_WORKERS * 3) || ' worker tasks, 3 flatten tasks';
END;
$$;
```

#### START_MATRIX_DAG — resume all tasks and execute root tasks

```sql
CREATE OR REPLACE PROCEDURE <DB>.PUBLIC.START_MATRIX_DAG(
    P_DB VARCHAR,
    P_NUM_WORKERS INTEGER DEFAULT 10
)
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    res_list ARRAY DEFAULT ARRAY_CONSTRUCT('RES7', 'RES8', 'RES9');
    res VARCHAR;
    i INTEGER;
    w INTEGER;
BEGIN
    FOR i IN 0 TO 2 DO
        res := res_list[i];
        BEGIN
            EXECUTE IMMEDIATE 'ALTER TASK ' || P_DB || '.PUBLIC.TASK_FLATTEN_' || res || ' RESUME';
        EXCEPTION WHEN OTHER THEN NULL; END;
        w := P_NUM_WORKERS;
        WHILE (w >= 1) DO
            BEGIN
                EXECUTE IMMEDIATE 'ALTER TASK ' || P_DB || '.PUBLIC.TASK_WORKER_' || res || '_' || LPAD(w, 2, '0') || ' RESUME';
            EXCEPTION WHEN OTHER THEN NULL; END;
            w := w - 1;
        END WHILE;
        BEGIN
            EXECUTE IMMEDIATE 'ALTER TASK ' || P_DB || '.PUBLIC.TASK_BUILD_QUEUE_' || res || ' RESUME';
        EXCEPTION WHEN OTHER THEN NULL; END;
    END FOR;

    FOR i IN 0 TO 2 DO
        res := res_list[i];
        EXECUTE IMMEDIATE 'EXECUTE TASK ' || P_DB || '.PUBLIC.TASK_BUILD_QUEUE_' || res;
    END FOR;

    RETURN 'DAG started: all tasks resumed and root tasks executed for RES7, RES8, RES9';
END;
$$;
```

#### STOP_MATRIX_DAG — suspend all tasks

```sql
CREATE OR REPLACE PROCEDURE <DB>.PUBLIC.STOP_MATRIX_DAG(
    P_DB VARCHAR,
    P_NUM_WORKERS INTEGER DEFAULT 10
)
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    res_list ARRAY DEFAULT ARRAY_CONSTRUCT('RES7', 'RES8', 'RES9');
    res VARCHAR;
    i INTEGER;
    w INTEGER;
BEGIN
    FOR i IN 0 TO 2 DO
        res := res_list[i];
        BEGIN
            EXECUTE IMMEDIATE 'ALTER TASK ' || P_DB || '.PUBLIC.TASK_BUILD_QUEUE_' || res || ' SUSPEND';
        EXCEPTION WHEN OTHER THEN NULL; END;
        w := 1;
        WHILE (w <= P_NUM_WORKERS) DO
            BEGIN
                EXECUTE IMMEDIATE 'ALTER TASK ' || P_DB || '.PUBLIC.TASK_WORKER_' || res || '_' || LPAD(w, 2, '0') || ' SUSPEND';
            EXCEPTION WHEN OTHER THEN NULL; END;
            w := w + 1;
        END WHILE;
        BEGIN
            EXECUTE IMMEDIATE 'ALTER TASK ' || P_DB || '.PUBLIC.TASK_FLATTEN_' || res || ' SUSPEND';
        EXCEPTION WHEN OTHER THEN NULL; END;
    END FOR;

    RETURN 'DAG stopped: all tasks suspended';
END;
$$;
```

#### Usage

```sql
-- 1. Create the DAG (generates 36 tasks)
CALL <DB>.PUBLIC.CREATE_MATRIX_DAG('<DB>', 'ROUTING_ANALYTICS', 'FLATTEN_WH', 10);

-- 2. Start the pipeline (resumes all tasks, executes root tasks)
CALL <DB>.PUBLIC.START_MATRIX_DAG('<DB>', 10);

-- 3. Stop if needed
CALL <DB>.PUBLIC.STOP_MATRIX_DAG('<DB>', 10);
```

**How it works:**
- Root tasks fire instantly (no schedule) — they're triggered by `EXECUTE TASK`
- 10 worker tasks per resolution start concurrently after the root task completes
- Multi-cluster warehouse auto-spawns clusters for the concurrent workers
- When ALL 10 workers for a resolution finish, the flatten task fires automatically on the XLARGE warehouse
- Workers are resume-safe — if the DAG is stopped and restarted, workers pick up from where they left off

#### Alternative: Manual Bash Launch

For ad-hoc runs or when you want more control, use the bash script approach:

```bash
#!/bin/bash
launch_workers() {
    local res=$1
    local total=$2
    local num_workers=$3
    local chunk_size=$(( (total + num_workers - 1) / num_workers ))
    for w in $(seq 0 $((num_workers - 1))); do
        local start_seq=$(( w * chunk_size + 1 ))
        local end_seq=$(( (w + 1) * chunk_size ))
        if [ $end_seq -gt $total ]; then end_seq=$total; fi
        if [ $start_seq -gt $total ]; then break; fi
        snow sql -c <CONNECTION> -q "
            USE ROLE ACCOUNTADMIN;
            USE WAREHOUSE ROUTING_ANALYTICS;
            CALL <DB>.PUBLIC.BUILD_TRAVEL_TIME_RANGE('$res', $start_seq, $end_seq);
        " 2>/dev/null &
        sleep 3
    done
}

launch_workers "RES7" 177346 10
launch_workers "RES8" 1202348 10
launch_workers "RES9" 8557513 10
wait
```

### Step 7: Monitor Progress

```sql
SELECT 'RES7' AS res, COUNT(*) AS done, 177346 AS total,
       ROUND(COUNT(*)*100/177346, 1) AS pct
FROM <DB>.PUBLIC.CA_MATRIX_RAW_RES7
UNION ALL
SELECT 'RES8', COUNT(*), 1202348, ROUND(COUNT(*)*100/1202348, 1)
FROM <DB>.PUBLIC.CA_MATRIX_RAW_RES8
UNION ALL
SELECT 'RES9', COUNT(*), 8557513, ROUND(COUNT(*)*100/8557513, 1)
FROM <DB>.PUBLIC.CA_MATRIX_RAW_RES9
ORDER BY res;

-- Check running workers
SELECT
    SUBSTR(QUERY_TEXT, POSITION('(''' IN QUERY_TEXT)+2, 4) AS RES,
    COUNT(*) AS RUNNING_WORKERS
FROM TABLE(INFORMATION_SCHEMA.QUERY_HISTORY_BY_WAREHOUSE('ROUTING_ANALYTICS'))
WHERE QUERY_TEXT ILIKE '%BUILD_TRAVEL_TIME_RANGE%'
  AND EXECUTION_STATUS = 'RUNNING'
GROUP BY 1 ORDER BY 1;

-- Check error vs success ratio in raw data
SELECT
    CASE WHEN MATRIX_RESULT:durations IS NOT NULL THEN 'SUCCESS' ELSE 'ERROR' END AS STATUS,
    COUNT(*) AS CNT
FROM <DB>.PUBLIC.CA_MATRIX_RAW_<RES>
GROUP BY 1;
```

**Expected throughput** (10 ORS instances, 10 gateway instances):
- ~675 MATRIX_TABULAR calls/sec total
- RES7 (177K origins): ~35 min
- RES8 (1.2M origins): ~3-4 hrs
- RES9 (8.6M origins): ~12-14 hrs (accelerates as other resolutions finish)

### Step 8: FLATTEN Raw Data into Travel Time Tables

**If using the Task DAG (Step 6), flatten happens automatically** when all workers for a resolution complete. The flatten tasks fire on the XLARGE warehouse.

For manual runs, flatten on a dedicated XLARGE warehouse (single-query power, not concurrency):

```sql
CREATE WAREHOUSE IF NOT EXISTS FLATTEN_WH
    WITH WAREHOUSE_SIZE = 'XLARGE'
    AUTO_SUSPEND = 60 AUTO_RESUME = TRUE;

CREATE OR REPLACE PROCEDURE <DB>.PUBLIC.FLATTEN_MATRIX_RAW(P_RES VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    raw_table VARCHAR;
    target_table VARCHAR;
    row_count INTEGER;
    rs RESULTSET;
BEGIN
    raw_table := '<DB>.PUBLIC.CA_MATRIX_RAW_' || P_RES;
    target_table := '<DB>.PUBLIC.CA_TRAVEL_TIME_' || P_RES;

    EXECUTE IMMEDIATE 'TRUNCATE TABLE ' || target_table;

    EXECUTE IMMEDIATE '
    INSERT INTO ' || target_table || ' (ORIGIN_H3, DEST_H3, TRAVEL_TIME_SECONDS, TRAVEL_DISTANCE_METERS)
    SELECT
        r.ORIGIN_H3,
        r.DEST_HEX_IDS[f.INDEX]::VARCHAR AS DEST_H3,
        r.MATRIX_RESULT:durations[0][f.INDEX]::FLOAT AS TRAVEL_TIME_SECONDS,
        r.MATRIX_RESULT:distances[0][f.INDEX]::FLOAT AS TRAVEL_DISTANCE_METERS
    FROM ' || raw_table || ' r,
        LATERAL FLATTEN(input => r.MATRIX_RESULT:durations[0]) f
    WHERE r.MATRIX_RESULT:durations IS NOT NULL';

    rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || target_table);
    LET c CURSOR FOR rs;
    FOR row_val IN c DO
        row_count := row_val.CNT;
    END FOR;

    RETURN P_RES || ' flatten complete: ' || row_count || ' travel time pairs inserted';
END;
$$;

-- Run on XL warehouse (handles 285M+ rows in minutes)
USE WAREHOUSE FLATTEN_WH;
CALL <DB>.PUBLIC.FLATTEN_MATRIX_RAW('RES7');
CALL <DB>.PUBLIC.FLATTEN_MATRIX_RAW('RES8');
CALL <DB>.PUBLIC.FLATTEN_MATRIX_RAW('RES9');
```

**Target table schema:**

```sql
CREATE TABLE IF NOT EXISTS <DB>.PUBLIC.CA_TRAVEL_TIME_<RES> (
    ORIGIN_H3 VARCHAR,
    DEST_H3 VARCHAR,
    TRAVEL_TIME_SECONDS FLOAT,
    TRAVEL_DISTANCE_METERS FLOAT
);
```

**FLATTEN performance**: RES7 (285M rows) completed in ~2 minutes on XLARGE.

### Step 9: Scale Down

After all resolutions complete:

```sql
ALTER WAREHOUSE ROUTING_ANALYTICS SET
    MIN_CLUSTER_COUNT = 1 MAX_CLUSTER_COUNT = 1
    WAREHOUSE_SIZE = 'XSMALL';
ALTER WAREHOUSE ROUTING_ANALYTICS SUSPEND;
ALTER WAREHOUSE FLATTEN_WH SUSPEND;

-- Scale ORS back (via native app patch)
-- MIN_INSTANCES = 1, MAX_INSTANCES = 1 for ORS + gateway
-- MIN_NODES = 1, MAX_NODES = 1 for compute pool
```

---

## Connecting to VROOM Route Optimization

The pre-computed travel times feed directly into VROOM's `matrices` parameter, eliminating real-time ORS routing during optimization.

### Format Mapping

ORS MATRIX_TABULAR returns (per origin, stored as MATRIX_RESULT):
```json
{"durations": [[d0, d1, d2, ...]], "distances": [[m0, m1, m2, ...]], "sources": [...], "destinations": [...]}
```

VROOM expects (NxN, keyed by profile):
```json
{"driving-car": {"durations": [[0,d01,d02],[d10,0,d12],[d20,d21,0]], "distances": [[...]]}}
```

### Building VROOM Matrix from Pre-Computed Data

```sql
WITH locations AS (
    SELECT
        ROW_NUMBER() OVER (ORDER BY location_id) - 1 AS idx,
        location_id, lon, lat,
        H3_POINT_TO_CELL_STRING(ST_MAKEPOINT(lon, lat), 9) AS h3_index
    FROM my_delivery_locations
),
pairs AS (
    SELECT
        a.idx AS origin_idx, b.idx AS dest_idx,
        COALESCE(tt.TRAVEL_TIME_SECONDS, 0) AS duration,
        COALESCE(tt.TRAVEL_DISTANCE_METERS, 0) AS distance
    FROM locations a CROSS JOIN locations b
    LEFT JOIN <DB>.PUBLIC.CA_TRAVEL_TIME_RES9 tt
        ON tt.ORIGIN_H3 = a.h3_index AND tt.DEST_H3 = b.h3_index
)
SELECT ARRAY_AGG(duration_row) AS duration_matrix
FROM (
    SELECT origin_idx, ARRAY_AGG(duration) WITHIN GROUP (ORDER BY dest_idx) AS duration_row
    FROM pairs GROUP BY origin_idx ORDER BY origin_idx
);
```

### OPTIMIZATION Call with Pre-Computed Matrix

```sql
SELECT OPENROUTESERVICE_NATIVE_APP.CORE.OPTIMIZATION(
    :jobs_array,      -- jobs use location_index (integer), NOT location (coords)
    :vehicles_array,  -- vehicles use start_index/end_index, NOT start/end coords
    ARRAY_CONSTRUCT(
        OBJECT_CONSTRUCT(
            'driving-car', OBJECT_CONSTRUCT(
                'durations', :duration_matrix,
                'distances', :distance_matrix
            )
        )
    )
);
```

When matrices provided: `options.g = False` (no geometry), jobs/vehicles reference locations by index.

---

## Troubleshooting

### 503 Upstream Connect Error
- **Cause**: Too many concurrent workers overwhelming gateway or ORS
- **Fix**: Scale gateway instances to match ORS instances. Add retry with exponential backoff.

### 500 Internal Server Error from ORS
- **Cause**: Too many matrix elements in one request (origins × destinations > ~500K)
- **Fix**: Reduce batch_size for that resolution. Don't reduce MAX_BATCH_ROWS globally.

### Workers Producing 0 Rows
- **Cause**: Inline FLATTEN blocking until entire batch completes, or WHERE clause filtering all rows
- **Fix**: Use raw dump approach (no FLATTEN during ingestion)

### ORS Out of Bounds Errors
- **Cause**: Some H3 centroids fall in water/outside road network
- **Impact**: ~13% error rate for coastal California. Errors stored in raw table, filtered during FLATTEN.
- **Fix**: These are expected. FLATTEN filters them with `WHERE MATRIX_RESULT:durations IS NOT NULL`.

### App Upgrade Restarts ORS
- **Cause**: Every ADD PATCH + UPGRADE restarts ORS services
- **Impact**: ~40-60s graph rebuild, workers get 503 during warmup
- **Fix**: Wait for `ORS_STATUS()` to return `service_ready = true` before launching workers.

---

## Consuming the Data (Bidirectional Queries)

### One-Directional Storage Pattern

The work queue build (Step 2) generates pairs where each origin–destination combination is stored **only once**. The `H3_GRID_DISK` expansion combined with the `a.h3_index != n.value::STRING` filter means each pair (A, B) appears in the raw data as whichever hex happened to be the origin during batch processing. After FLATTEN, the travel time tables contain:

- `ORIGIN_H3` — the hex that was the origin in the MATRIX_TABULAR call
- `DEST_H3` — one of its neighbors

Because travel times are symmetric on road networks (same route, same distance), you do NOT need to store both (A→B) and (B→A). But this means **you MUST query both directions** when looking up travel times from a given hex.

### Bidirectional Query Pattern (REQUIRED)

When looking up all hexagons reachable from a specific origin hex, use a UNION ALL:

```sql
SELECT DEST_H3 AS hex_id, TRAVEL_TIME_SECONDS, TRAVEL_DISTANCE_METERS
FROM OPENROUTESERVICE_SETUP.PUBLIC.CA_TRAVEL_TIME_RES9
WHERE ORIGIN_H3 = '<my_origin_hex>'
  AND TRAVEL_TIME_SECONDS <= 1800
UNION ALL
SELECT ORIGIN_H3 AS hex_id, TRAVEL_TIME_SECONDS, TRAVEL_DISTANCE_METERS
FROM OPENROUTESERVICE_SETUP.PUBLIC.CA_TRAVEL_TIME_RES9
WHERE DEST_H3 = '<my_origin_hex>'
  AND TRAVEL_TIME_SECONDS <= 1800
ORDER BY TRAVEL_TIME_SECONDS
```

**Without the UNION ALL, you will miss approximately half of the reachable hexagons.** The first SELECT finds pairs where your hex was the origin; the second finds pairs where your hex was stored as the destination.

### Point-to-Point Lookup

For a single origin-destination pair, check both orderings:

```sql
SELECT TRAVEL_TIME_SECONDS, TRAVEL_DISTANCE_METERS
FROM OPENROUTESERVICE_SETUP.PUBLIC.CA_TRAVEL_TIME_RES9
WHERE (ORIGIN_H3 = '<hex_a>' AND DEST_H3 = '<hex_b>')
   OR (ORIGIN_H3 = '<hex_b>' AND DEST_H3 = '<hex_a>')
LIMIT 1
```

### JOIN Pattern for Bulk Lookups

When joining travel times with another table (e.g., orders, stores), use an OR condition or UNION pattern:

```sql
LEFT JOIN CA_TRAVEL_TIME_RES9 tt
  ON (source_h3 = tt.ORIGIN_H3 AND target_h3 = tt.DEST_H3)
  OR (source_h3 = tt.DEST_H3 AND target_h3 = tt.ORIGIN_H3)
```

### Search Optimization

Ensure search optimization is enabled on both columns for fast lookups:

```sql
ALTER TABLE OPENROUTESERVICE_SETUP.PUBLIC.CA_TRAVEL_TIME_RES9
  ADD SEARCH OPTIMIZATION ON EQUALITY(ORIGIN_H3, DEST_H3);
```

---

## Key Learnings (California Case Study)

1. **Raw dump then FLATTEN** — The single most important pattern. Inline FLATTEN during API ingestion blocks all progress until entire batches complete. Raw VARIANT dump inserts immediately.

2. **Gateway is a hidden bottleneck** — ORS instances alone aren't enough. Gateway instances must match ORS count or they become the throughput ceiling.

3. **Adaptive batch sizing per resolution** — Don't use one batch size globally. Heavy resolutions (RES7: 1567 dests) need small batches (100), light ones (RES9: 132 dests) can use large batches (2000).

4. **Multi-cluster warehouse for concurrency** — 30 concurrent worker procedures need 10 warehouse clusters. Use XSMALL with MIN=1, MAX=10 and STANDARD scaling policy for cost-optimal auto-scaling. Workers are I/O-bound waiting for ORS, not compute-bound.

5. **Resume safety is essential** — Workers crash, get 503'd, timeout. The procedure must resume from last completed SEQ_ID, not restart.

6. **XLARGE for FLATTEN, XSMALL multi-cluster for API calls** — Different workloads need different warehouse shapes. API calls need concurrency (multi-cluster XSMALL). FLATTEN needs single-query power (XLARGE).

7. **Stagger worker launches** — `sleep 3` between launches prevents thundering herd on ORS.

8. **ORS throughput ceiling** — ~67.5 MATRIX_TABULAR calls/sec per instance. 10 instances = ~675/sec. This is the fundamental limit. Scale nodes to increase.

9. **MAX_BATCH_ROWS stays at 1000** — This is the Snowflake external function batch setting. Higher resolutions need larger batches through the gateway. Reduce per-procedure batch_size instead.
