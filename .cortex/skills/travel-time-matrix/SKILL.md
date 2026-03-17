# Travel Time Matrix at Scale — ORS + Snowflake

## Overview

Compute travel time matrices across H3 resolutions using ORS MATRIX_TABULAR in Snowflake. Works for any geography — from a single city to an entire country.

**Key insight**: Raw dump VARIANT payloads first, FLATTEN in bulk after. Never FLATTEN inline during API ingestion.

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

Every SQL template below uses these placeholders:

| Parameter | Description | Example (SF) | Example (California) | Example (UK) |
|-----------|-------------|--------------|---------------------|--------------|
| `P_REGION` | Short region identifier | `sf` | `california` | `uk` |
| `P_DB` | Target database | `ROUTING_DB` | `ROUTING_DB` | `ROUTING_DB` |
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

| Res | Hex Edge | Best For | Typical K-Ring | Avg Dests/Origin | Coverage Radius |
|-----|----------|----------|----------------|------------------|-----------------|
| 6 | ~11 km | Country-level strategic | 25 | ~1,000 | ~100 miles |
| 7 | ~3.6 km | State/inter-city | 33 | ~1,567 | ~50 miles |
| 8 | ~1.3 km | Metro/cross-city | 17 | ~438 | ~10 miles |
| 9 | ~0.5 km | City/last-mile delivery | 9 | ~132 | ~2 miles |
| 10 | ~0.2 km | Hyper-local (small city) | 6 | ~60 | ~0.5 miles |

**Rule of thumb**: Pick 1-3 resolutions. Use coarser resolutions for strategic routing, finer for last-mile. Small cities often only need RES 9 (or RES 10 for hyper-local). Large countries should start at RES 6 or 7.

### Grid Step Sizes by Resolution

| Res | Lat Step | Lon Step | Purpose |
|-----|----------|----------|---------|
| 6 | 0.05 | 0.05 | Country-wide coverage |
| 7 | 0.02 | 0.02 | State/region coverage |
| 8 | 0.008 | 0.008 | Metro area coverage |
| 9 | 0.003 | 0.003 | City-level coverage |
| 10 | 0.001 | 0.001 | Neighborhood coverage |

## Architecture

```
┌──────────────┐    ┌───────────────┐    ┌──────────────┐    ┌──────────────┐
│ H3 Hexagons  │ ─► │ Work Queues   │ ─► │ Raw Staging  │ ─► │ Flattened    │
│ (per res)    │    │ (1×N batches) │    │ (VARIANT)    │    │ Travel Times │
└──────────────┘    └───────────────┘    └──────────────┘    └──────────────┘
     Grid gen          Pre-compute          Parallel API        Post-process
     + pair gen        origins+dests        calls (raw dump)    FLATTEN bulk
```

## Prerequisites

1. ORS Native App installed with MATRIX_TABULAR function (gateway v0.6.0+)
2. OSM data loaded for target region
3. ORS graph built for `driving-car` profile (disable unused profiles to save RAM)

```sql
SHOW FUNCTIONS LIKE 'MATRIX_TABULAR' IN SCHEMA <P_ORS_APP>.CORE;
SELECT <P_ORS_APP>.CORE.ORS_STATUS();
```

---

## Workflow

### Step 1: Generate H3 Hexagons

Create hexagon grids covering the target region at each resolution. Run once per resolution.

```sql
CREATE OR REPLACE TABLE <P_DB>.PUBLIC.<P_REGION>_H3_RES<N> AS
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
```

Table naming convention: `<P_REGION>_H3_RES<N>` (e.g., `SF_H3_RES9`, `CA_H3_RES7`, `UK_H3_RES6`).

### Step 2: Build Work Queues

The work queue combines H3_GRID_DISK neighbour lookup, coordinate packing, and grouping into a single table — each row is a ready-to-fire MATRIX_TABULAR call. No intermediate pair tables needed.

```sql
CREATE OR REPLACE TABLE <P_DB>.PUBLIC.<P_REGION>_WORK_QUEUE_RES<N> AS
WITH pairs AS (
    SELECT
        a.h3_index AS origin_h3,
        a.lon AS origin_lon,
        a.lat AS origin_lat,
        n.value::STRING AS dest_h3
    FROM <P_DB>.PUBLIC.<P_REGION>_H3_RES<N> a,
    LATERAL FLATTEN(input => H3_GRID_DISK(a.h3_index, <K_RING>)) n
    WHERE n.value::STRING IN (SELECT h3_index FROM <P_DB>.PUBLIC.<P_REGION>_H3_RES<N>)
      AND a.h3_index != n.value::STRING
),
grouped AS (
    SELECT
        origin_h3, origin_lon, origin_lat,
        ARRAY_AGG(ARRAY_CONSTRUCT(d.lon, d.lat)) AS dest_coords,
        ARRAY_AGG(p.dest_h3) AS dest_hex_ids
    FROM pairs p
    JOIN <P_DB>.PUBLIC.<P_REGION>_H3_RES<N> d ON p.dest_h3 = d.h3_index
    GROUP BY origin_h3, origin_lon, origin_lat
)
SELECT
    ROW_NUMBER() OVER (ORDER BY origin_h3) AS seq_id,
    origin_h3, origin_lon, origin_lat,
    dest_coords, dest_hex_ids
FROM grouped;

ALTER TABLE <P_DB>.PUBLIC.<P_REGION>_WORK_QUEUE_RES<N> CLUSTER BY (SEQ_ID);
```

**K-ring radii** (controls destination reach per resolution):

| Res | K-ring | Avg Dests/Origin | Coverage |
|-----|--------|------------------|----------|
| 6 | 25 | ~1,000 | ~100 miles |
| 7 | 33 | ~1,567 | ~50 miles |
| 8 | 17 | ~438 | ~10 miles |
| 9 | 9 | ~132 | ~2 miles |
| 10 | 6 | ~60 | ~0.5 miles |

Adjust k-ring values based on your use case — larger k-ring = more pairs but wider coverage.

### Step 3: Create Raw Staging Tables

Raw tables store the VARIANT payload from MATRIX_TABULAR with zero transformation. This is the breakthrough pattern — **never FLATTEN during API ingestion**.

```sql
CREATE OR REPLACE TABLE <P_DB>.PUBLIC.<P_REGION>_MATRIX_RAW_RES<N> (
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

Resume-safe, retry-aware, adaptive batch sizing. The procedure is region-aware — pass the region prefix and resolution.

```sql
CREATE OR REPLACE PROCEDURE <P_DB>.PUBLIC.BUILD_TRAVEL_TIME_RANGE(
    P_REGION VARCHAR,
    P_RES INTEGER,
    P_START_SEQ INTEGER,
    P_END_SEQ INTEGER,
    P_ORS_APP VARCHAR DEFAULT 'OPENROUTESERVICE_NATIVE_APP'
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
    res_label VARCHAR;
    insert_sql VARCHAR;
    resume_sql VARCHAR;
    max_done INTEGER DEFAULT 0;
    rs RESULTSET;
    retry_count INTEGER DEFAULT 0;
    max_retries INTEGER DEFAULT 5;
    retry_wait INTEGER DEFAULT 10;
BEGIN
    res_label := 'RES' || P_RES::VARCHAR;
    queue_table := P_REGION || '_WORK_QUEUE_' || res_label;
    raw_table := P_REGION || '_MATRIX_RAW_' || res_label;

    IF (P_RES <= 7) THEN
        batch_size := 100;
    ELSEIF (P_RES = 8) THEN
        batch_size := 1000;
    ELSE
        batch_size := 2000;
    END IF;

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
            ' || P_ORS_APP || '.CORE.MATRIX_TABULAR(
                ''driving-car'',
                ARRAY_CONSTRUCT(q.ORIGIN_LON, q.ORIGIN_LAT),
                q.DEST_COORDS
            )
        FROM ' || queue_table || ' q
        WHERE q.SEQ_ID BETWEEN ' || current_pos || ' AND ' || batch_end;

        WHILE (retry_count <= max_retries) DO
            BEGIN
                EXECUTE IMMEDIATE :insert_sql;
                retry_count := max_retries + 1;
            EXCEPTION
                WHEN OTHER THEN
                    retry_count := retry_count + 1;
                    IF (retry_count > max_retries) THEN
                        RAISE;
                    END IF;
                    EXECUTE IMMEDIATE 'SELECT SYSTEM$WAIT(' || retry_wait || ')';
                    retry_wait := retry_wait * 2;
            END;
        END WHILE;

        current_pos := batch_end + 1;
    END WHILE;

    RETURN res_label || ' range [' || P_START_SEQ || '-' || P_END_SEQ ||
           '] complete: ' || batch_num || ' batches of ' || batch_size ||
           ' (resumed from seq ' || max_done || ')';
END;
$$;
```

**Adaptive batch sizing rationale:**
- ORS has a practical limit of ~500K matrix elements per HTTP request
- RES 6-7: 100 origins (heavy destinations) — safe under 500K elements
- RES 8: 1000 origins × ~438 dests = ~438K elements — safe
- RES 9-10: 2000 origins × ~60-132 dests = ~120-264K elements — safe

### Step 5: Scale Infrastructure

**Scale to match your region size.** Smaller regions need fewer resources.

| Preset | Warehouse Clusters | ORS/Gateway Instances | Compute Pool Nodes |
|--------|-------------------|-----------------------|-------------------|
| **City** | 3 | 3 | 3 |
| **Metro** | 5 | 5 | 5 |
| **State/Region** | 10 | 10 | 10 |
| **Country** | 20 | 20 | 20 |

#### Multi-Cluster Warehouse (for worker concurrency)

```sql
CREATE OR REPLACE WAREHOUSE ROUTING_ANALYTICS
    WAREHOUSE_SIZE = 'XSMALL'
    MIN_CLUSTER_COUNT = 1
    MAX_CLUSTER_COUNT = <P_ORS_INSTANCES>
    SCALING_POLICY = 'STANDARD'
    AUTO_SUSPEND = 300
    AUTO_RESUME = TRUE;
```

**Why XSMALL:** Workers are I/O bound (waiting for ORS), not compute bound. XSMALL costs 16x less than MEDIUM per cluster with zero performance impact.

#### ORS Native App Scaling

```sql
ALTER SERVICE IF EXISTS <P_ORS_APP>.CORE.ORS_SERVICE
    SET MIN_INSTANCES = <P_ORS_INSTANCES> MAX_INSTANCES = <P_ORS_INSTANCES>;

ALTER SERVICE IF EXISTS <P_ORS_APP>.CORE.ROUTING_GATEWAY_SERVICE
    SET MIN_INSTANCES = <P_ORS_INSTANCES> MAX_INSTANCES = <P_ORS_INSTANCES>;

ALTER COMPUTE POOL <POOL_NAME>
    SET MIN_NODES = <P_ORS_INSTANCES> MAX_NODES = <P_ORS_INSTANCES>;
```

**Scaling rules:**
- Gateway instances MUST match ORS instances (gateway was the bottleneck at 3 when ORS had 10)
- Each ORS instance handles ~67.5 MATRIX_TABULAR calls/sec
- Scale linearly up to ~20 nodes, then diminishing returns

#### Wait for ORS Warm-Up

```sql
SELECT <P_ORS_APP>.CORE.ORS_STATUS();
-- Wait until service_ready = true before launching workers
```

### Step 6: Create and Launch the Task DAG

The DAG dynamically creates per-resolution root tasks, worker tasks, and flatten tasks. Fully parameterized by region and resolution list.

```sql
CREATE OR REPLACE PROCEDURE <P_DB>.PUBLIC.CREATE_MATRIX_DAG(
    P_DB VARCHAR,
    P_REGION VARCHAR,
    P_RESOLUTIONS ARRAY,
    P_ROUTING_WH VARCHAR,
    P_FLATTEN_WH VARCHAR,
    P_NUM_WORKERS INTEGER DEFAULT 10,
    P_ORS_APP VARCHAR DEFAULT 'OPENROUTESERVICE_NATIVE_APP'
)
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    res INTEGER;
    res_label VARCHAR;
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
    total_tasks INTEGER DEFAULT 0;
BEGIN
    FOR i IN 0 TO ARRAY_SIZE(P_RESOLUTIONS) - 1 DO
        res := P_RESOLUTIONS[i]::INTEGER;
        res_label := 'RES' || res::VARCHAR;

        BEGIN
            EXECUTE IMMEDIATE 'DROP TASK IF EXISTS ' || P_DB || '.PUBLIC.TASK_FLATTEN_' || P_REGION || '_' || res_label;
        EXCEPTION WHEN OTHER THEN NULL; END;
        w := 1;
        WHILE (w <= P_NUM_WORKERS) DO
            BEGIN
                EXECUTE IMMEDIATE 'DROP TASK IF EXISTS ' || P_DB || '.PUBLIC.TASK_WORKER_' || P_REGION || '_' || res_label || '_' || LPAD(w, 2, '0');
            EXCEPTION WHEN OTHER THEN NULL; END;
            w := w + 1;
        END WHILE;
        BEGIN
            EXECUTE IMMEDIATE 'DROP TASK IF EXISTS ' || P_DB || '.PUBLIC.TASK_BUILD_QUEUE_' || P_REGION || '_' || res_label;
        EXCEPTION WHEN OTHER THEN NULL; END;
    END FOR;

    FOR i IN 0 TO ARRAY_SIZE(P_RESOLUTIONS) - 1 DO
        res := P_RESOLUTIONS[i]::INTEGER;
        res_label := 'RES' || res::VARCHAR;

        rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || P_DB || '.PUBLIC.' || P_REGION || '_WORK_QUEUE_' || res_label);
        LET c1 CURSOR FOR rs;
        FOR r IN c1 DO
            total_rows := r.CNT;
        END FOR;
        chunk_size := CEIL(total_rows / P_NUM_WORKERS);

        ddl := 'CREATE OR REPLACE TASK ' || P_DB || '.PUBLIC.TASK_BUILD_QUEUE_' || P_REGION || '_' || res_label ||
               ' WAREHOUSE = ' || P_FLATTEN_WH ||
               ' AS SELECT ''Work queue ' || P_REGION || ' ' || res_label || ' ready: ' || total_rows || ' origins''';
        EXECUTE IMMEDIATE ddl;

        w := 1;
        WHILE (w <= P_NUM_WORKERS) DO
            start_seq := ((w - 1) * chunk_size) + 1;
            end_seq := LEAST(w * chunk_size, total_rows);
            IF (start_seq <= total_rows) THEN
                task_name := P_DB || '.PUBLIC.TASK_WORKER_' || P_REGION || '_' || res_label || '_' || LPAD(w, 2, '0');
                ddl := 'CREATE OR REPLACE TASK ' || task_name ||
                       ' WAREHOUSE = ' || P_ROUTING_WH ||
                       ' AFTER ' || P_DB || '.PUBLIC.TASK_BUILD_QUEUE_' || P_REGION || '_' || res_label ||
                       ' AS CALL ' || P_DB || '.PUBLIC.BUILD_TRAVEL_TIME_RANGE(''' || P_REGION || ''', ' || res || ', ' || start_seq || ', ' || end_seq || ', ''' || P_ORS_APP || ''')';
                EXECUTE IMMEDIATE ddl;
                total_tasks := total_tasks + 1;
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
                worker_list := worker_list || P_DB || '.PUBLIC.TASK_WORKER_' || P_REGION || '_' || res_label || '_' || LPAD(w, 2, '0');
            END IF;
            w := w + 1;
        END WHILE;

        ddl := 'CREATE OR REPLACE TASK ' || P_DB || '.PUBLIC.TASK_FLATTEN_' || P_REGION || '_' || res_label ||
               ' WAREHOUSE = ' || P_FLATTEN_WH ||
               ' AFTER ' || worker_list ||
               ' AS CALL ' || P_DB || '.PUBLIC.FLATTEN_MATRIX_RAW(''' || P_REGION || ''', ' || res || ')';
        EXECUTE IMMEDIATE ddl;
        total_tasks := total_tasks + 2;
    END FOR;

    RETURN 'DAG created for ' || P_REGION || ': ' || ARRAY_SIZE(P_RESOLUTIONS) || ' resolutions, ' || total_tasks || ' total tasks';
END;
$$;
```

#### START_MATRIX_DAG

```sql
CREATE OR REPLACE PROCEDURE <P_DB>.PUBLIC.START_MATRIX_DAG(
    P_DB VARCHAR,
    P_REGION VARCHAR,
    P_RESOLUTIONS ARRAY,
    P_NUM_WORKERS INTEGER DEFAULT 10
)
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    res INTEGER;
    res_label VARCHAR;
    i INTEGER;
    w INTEGER;
BEGIN
    FOR i IN 0 TO ARRAY_SIZE(P_RESOLUTIONS) - 1 DO
        res := P_RESOLUTIONS[i]::INTEGER;
        res_label := 'RES' || res::VARCHAR;
        BEGIN
            EXECUTE IMMEDIATE 'ALTER TASK ' || P_DB || '.PUBLIC.TASK_FLATTEN_' || P_REGION || '_' || res_label || ' RESUME';
        EXCEPTION WHEN OTHER THEN NULL; END;
        w := P_NUM_WORKERS;
        WHILE (w >= 1) DO
            BEGIN
                EXECUTE IMMEDIATE 'ALTER TASK ' || P_DB || '.PUBLIC.TASK_WORKER_' || P_REGION || '_' || res_label || '_' || LPAD(w, 2, '0') || ' RESUME';
            EXCEPTION WHEN OTHER THEN NULL; END;
            w := w - 1;
        END WHILE;
        BEGIN
            EXECUTE IMMEDIATE 'ALTER TASK ' || P_DB || '.PUBLIC.TASK_BUILD_QUEUE_' || P_REGION || '_' || res_label || ' RESUME';
        EXCEPTION WHEN OTHER THEN NULL; END;
    END FOR;

    FOR i IN 0 TO ARRAY_SIZE(P_RESOLUTIONS) - 1 DO
        res := P_RESOLUTIONS[i]::INTEGER;
        res_label := 'RES' || res::VARCHAR;
        EXECUTE IMMEDIATE 'EXECUTE TASK ' || P_DB || '.PUBLIC.TASK_BUILD_QUEUE_' || P_REGION || '_' || res_label;
    END FOR;

    RETURN 'DAG started for ' || P_REGION || ': all tasks resumed and root tasks executed';
END;
$$;
```

#### STOP_MATRIX_DAG

```sql
CREATE OR REPLACE PROCEDURE <P_DB>.PUBLIC.STOP_MATRIX_DAG(
    P_DB VARCHAR,
    P_REGION VARCHAR,
    P_RESOLUTIONS ARRAY,
    P_NUM_WORKERS INTEGER DEFAULT 10
)
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    res INTEGER;
    res_label VARCHAR;
    i INTEGER;
    w INTEGER;
BEGIN
    FOR i IN 0 TO ARRAY_SIZE(P_RESOLUTIONS) - 1 DO
        res := P_RESOLUTIONS[i]::INTEGER;
        res_label := 'RES' || res::VARCHAR;
        BEGIN
            EXECUTE IMMEDIATE 'ALTER TASK ' || P_DB || '.PUBLIC.TASK_BUILD_QUEUE_' || P_REGION || '_' || res_label || ' SUSPEND';
        EXCEPTION WHEN OTHER THEN NULL; END;
        w := 1;
        WHILE (w <= P_NUM_WORKERS) DO
            BEGIN
                EXECUTE IMMEDIATE 'ALTER TASK ' || P_DB || '.PUBLIC.TASK_WORKER_' || P_REGION || '_' || res_label || '_' || LPAD(w, 2, '0') || ' SUSPEND';
            EXCEPTION WHEN OTHER THEN NULL; END;
            w := w + 1;
        END WHILE;
        BEGIN
            EXECUTE IMMEDIATE 'ALTER TASK ' || P_DB || '.PUBLIC.TASK_FLATTEN_' || P_REGION || '_' || res_label || ' SUSPEND';
        EXCEPTION WHEN OTHER THEN NULL; END;
    END FOR;

    RETURN 'DAG stopped for ' || P_REGION || ': all tasks suspended';
END;
$$;
```

#### Usage Examples

```sql
-- City: San Francisco (RES 9 only, 3 workers)
CALL CREATE_MATRIX_DAG('ROUTING_DB', 'SF', ARRAY_CONSTRUCT(9), 'ROUTING_ANALYTICS', 'FLATTEN_WH', 3);
CALL START_MATRIX_DAG('ROUTING_DB', 'SF', ARRAY_CONSTRUCT(9), 3);

-- Metro: Greater LA (RES 8 + 9, 5 workers)
CALL CREATE_MATRIX_DAG('ROUTING_DB', 'LA', ARRAY_CONSTRUCT(8, 9), 'ROUTING_ANALYTICS', 'FLATTEN_WH', 5);
CALL START_MATRIX_DAG('ROUTING_DB', 'LA', ARRAY_CONSTRUCT(8, 9), 5);

-- State: California (RES 7 + 8 + 9, 10 workers)
CALL CREATE_MATRIX_DAG('ROUTING_DB', 'CA', ARRAY_CONSTRUCT(7, 8, 9), 'ROUTING_ANALYTICS', 'FLATTEN_WH', 10);
CALL START_MATRIX_DAG('ROUTING_DB', 'CA', ARRAY_CONSTRUCT(7, 8, 9), 10);

-- Country: UK (RES 6 + 7 + 8, 20 workers)
CALL CREATE_MATRIX_DAG('ROUTING_DB', 'UK', ARRAY_CONSTRUCT(6, 7, 8), 'ROUTING_ANALYTICS', 'FLATTEN_WH', 20);
CALL START_MATRIX_DAG('ROUTING_DB', 'UK', ARRAY_CONSTRUCT(6, 7, 8), 20);

-- Stop any region
CALL STOP_MATRIX_DAG('ROUTING_DB', 'SF', ARRAY_CONSTRUCT(9), 3);
```

### Step 7: Monitor Progress

```sql
SELECT
    '<P_REGION>' AS region,
    'RES<N>' AS res,
    COUNT(*) AS done,
    (SELECT COUNT(*) FROM <P_DB>.PUBLIC.<P_REGION>_WORK_QUEUE_RES<N>) AS total,
    ROUND(COUNT(*) * 100.0 / NULLIF((SELECT COUNT(*) FROM <P_DB>.PUBLIC.<P_REGION>_WORK_QUEUE_RES<N>), 0), 1) AS pct
FROM <P_DB>.PUBLIC.<P_REGION>_MATRIX_RAW_RES<N>;

-- Check running workers
SELECT
    QUERY_TEXT,
    EXECUTION_STATUS,
    DATEDIFF('minute', START_TIME, CURRENT_TIMESTAMP()) AS running_min
FROM TABLE(INFORMATION_SCHEMA.QUERY_HISTORY_BY_WAREHOUSE('ROUTING_ANALYTICS'))
WHERE QUERY_TEXT ILIKE '%BUILD_TRAVEL_TIME_RANGE%'
  AND EXECUTION_STATUS = 'RUNNING'
ORDER BY START_TIME;

-- Check error vs success ratio in raw data
SELECT
    CASE WHEN MATRIX_RESULT:durations IS NOT NULL THEN 'SUCCESS' ELSE 'ERROR' END AS STATUS,
    COUNT(*) AS CNT
FROM <P_DB>.PUBLIC.<P_REGION>_MATRIX_RAW_RES<N>
GROUP BY 1;
```

**Expected throughput** per ORS instance: ~67.5 MATRIX_TABULAR calls/sec. Scale linearly with instance count.

### Step 8: FLATTEN Raw Data into Travel Time Tables

```sql
CREATE OR REPLACE PROCEDURE <P_DB>.PUBLIC.FLATTEN_MATRIX_RAW(
    P_REGION VARCHAR,
    P_RES INTEGER
)
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    res_label VARCHAR;
    raw_table VARCHAR;
    target_table VARCHAR;
    row_count INTEGER;
    rs RESULTSET;
BEGIN
    res_label := 'RES' || P_RES::VARCHAR;
    raw_table := P_REGION || '_MATRIX_RAW_' || res_label;
    target_table := P_REGION || '_TRAVEL_TIME_' || res_label;

    EXECUTE IMMEDIATE '
    CREATE TABLE IF NOT EXISTS ' || target_table || ' (
        ORIGIN_H3 VARCHAR, DEST_H3 VARCHAR,
        TRAVEL_TIME_SECONDS FLOAT, TRAVEL_DISTANCE_METERS FLOAT
    )';

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

    RETURN P_REGION || ' ' || res_label || ' flatten complete: ' || row_count || ' travel time pairs';
END;
$$;
```

Run on a dedicated XLARGE warehouse for fast bulk processing:

```sql
CREATE WAREHOUSE IF NOT EXISTS FLATTEN_WH
    WITH WAREHOUSE_SIZE = 'XLARGE'
    AUTO_SUSPEND = 60 AUTO_RESUME = TRUE;

USE WAREHOUSE FLATTEN_WH;
CALL FLATTEN_MATRIX_RAW('<P_REGION>', <N>);
```

### Step 9: Scale Down

After all resolutions complete:

```sql
ALTER WAREHOUSE ROUTING_ANALYTICS SET
    MIN_CLUSTER_COUNT = 1 MAX_CLUSTER_COUNT = 1
    WAREHOUSE_SIZE = 'XSMALL';
ALTER WAREHOUSE ROUTING_ANALYTICS SUSPEND;
ALTER WAREHOUSE FLATTEN_WH SUSPEND;

ALTER SERVICE IF EXISTS <P_ORS_APP>.CORE.ORS_SERVICE
    SET MIN_INSTANCES = 1 MAX_INSTANCES = 1;
ALTER SERVICE IF EXISTS <P_ORS_APP>.CORE.ROUTING_GATEWAY_SERVICE
    SET MIN_INSTANCES = 1 MAX_INSTANCES = 1;
ALTER COMPUTE POOL <POOL_NAME> SET MIN_NODES = 1 MAX_NODES = 1;
```

---

## Alternative: Manual Bash Launch

For ad-hoc runs or when you want more control:

```bash
#!/bin/bash
REGION="sf"        # region prefix
RES=9              # resolution
TOTAL=50000        # total rows in work queue
WORKERS=3          # parallel workers
CONNECTION="myconn"
DB="ROUTING_DB"

chunk_size=$(( (TOTAL + WORKERS - 1) / WORKERS ))
for w in $(seq 0 $((WORKERS - 1))); do
    start_seq=$(( w * chunk_size + 1 ))
    end_seq=$(( (w + 1) * chunk_size ))
    if [ $end_seq -gt $TOTAL ]; then end_seq=$TOTAL; fi
    if [ $start_seq -gt $TOTAL ]; then break; fi
    snow sql -c $CONNECTION -q "
        USE ROLE ACCOUNTADMIN;
        USE WAREHOUSE ROUTING_ANALYTICS;
        CALL ${DB}.PUBLIC.BUILD_TRAVEL_TIME_RANGE('${REGION}', ${RES}, ${start_seq}, ${end_seq});
    " 2>/dev/null &
    sleep 3
done
wait
```

---

## Connecting to VROOM Route Optimization

Pre-computed travel times feed directly into VROOM's `matrices` parameter, eliminating real-time ORS routing during optimization.

### Building VROOM Matrix from Pre-Computed Data

```sql
WITH locations AS (
    SELECT
        ROW_NUMBER() OVER (ORDER BY location_id) - 1 AS idx,
        location_id, lon, lat,
        H3_POINT_TO_CELL_STRING(ST_MAKEPOINT(lon, lat), <N>) AS h3_index
    FROM my_delivery_locations
),
pairs AS (
    SELECT
        a.idx AS origin_idx, b.idx AS dest_idx,
        COALESCE(tt.TRAVEL_TIME_SECONDS, 0) AS duration,
        COALESCE(tt.TRAVEL_DISTANCE_METERS, 0) AS distance
    FROM locations a CROSS JOIN locations b
    LEFT JOIN <P_DB>.PUBLIC.<P_REGION>_TRAVEL_TIME_RES<N> tt
        ON (tt.ORIGIN_H3 = a.h3_index AND tt.DEST_H3 = b.h3_index)
        OR (tt.ORIGIN_H3 = b.h3_index AND tt.DEST_H3 = a.h3_index)
)
SELECT ARRAY_AGG(duration_row) AS duration_matrix
FROM (
    SELECT origin_idx, ARRAY_AGG(duration) WITHIN GROUP (ORDER BY dest_idx) AS duration_row
    FROM pairs GROUP BY origin_idx ORDER BY origin_idx
);
```

### OPTIMIZATION Call with Pre-Computed Matrix

```sql
SELECT <P_ORS_APP>.CORE.OPTIMIZATION(
    :jobs_array,
    :vehicles_array,
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

---

## Consuming the Data (Bidirectional Queries)

### One-Directional Storage Pattern

The work queue stores each pair (A, B) only once. Travel times are symmetric on road networks, so you do NOT need both (A->B) and (B->A). But **you MUST query both directions** when looking up travel times.

### Bidirectional Query Pattern (REQUIRED)

```sql
SELECT DEST_H3 AS hex_id, TRAVEL_TIME_SECONDS, TRAVEL_DISTANCE_METERS
FROM <P_DB>.PUBLIC.<P_REGION>_TRAVEL_TIME_RES<N>
WHERE ORIGIN_H3 = '<my_origin_hex>'
  AND TRAVEL_TIME_SECONDS <= 1800
UNION ALL
SELECT ORIGIN_H3 AS hex_id, TRAVEL_TIME_SECONDS, TRAVEL_DISTANCE_METERS
FROM <P_DB>.PUBLIC.<P_REGION>_TRAVEL_TIME_RES<N>
WHERE DEST_H3 = '<my_origin_hex>'
  AND TRAVEL_TIME_SECONDS <= 1800
ORDER BY TRAVEL_TIME_SECONDS;
```

**Without the UNION ALL, you will miss approximately half of the reachable hexagons.**

### Point-to-Point Lookup

```sql
SELECT TRAVEL_TIME_SECONDS, TRAVEL_DISTANCE_METERS
FROM <P_DB>.PUBLIC.<P_REGION>_TRAVEL_TIME_RES<N>
WHERE (ORIGIN_H3 = '<hex_a>' AND DEST_H3 = '<hex_b>')
   OR (ORIGIN_H3 = '<hex_b>' AND DEST_H3 = '<hex_a>')
LIMIT 1;
```

### Search Optimization

```sql
ALTER TABLE <P_DB>.PUBLIC.<P_REGION>_TRAVEL_TIME_RES<N>
  ADD SEARCH OPTIMIZATION ON EQUALITY(ORIGIN_H3, DEST_H3);
```

---

## Troubleshooting

### 503 Upstream Connect Error
- **Cause**: Too many concurrent workers overwhelming gateway or ORS
- **Fix**: Scale gateway instances to match ORS instances. Add retry with exponential backoff.

### 500 Internal Server Error from ORS
- **Cause**: Too many matrix elements in one request (origins x destinations > ~500K)
- **Fix**: Reduce batch_size for that resolution. Don't reduce MAX_BATCH_ROWS globally.

### Workers Producing 0 Rows
- **Cause**: Inline FLATTEN blocking until entire batch completes, or WHERE clause filtering all rows
- **Fix**: Use raw dump approach (no FLATTEN during ingestion)

### ORS Out of Bounds Errors
- **Cause**: Some H3 centroids fall in water/outside road network
- **Impact**: Varies by region. Coastal/island regions have higher error rates (~13% for California).
- **Fix**: These are expected. FLATTEN filters them with `WHERE MATRIX_RESULT:durations IS NOT NULL`.

### App Upgrade Restarts ORS
- **Cause**: Every ADD PATCH + UPGRADE restarts ORS services
- **Impact**: ~40-60s graph rebuild, workers get 503 during warmup
- **Fix**: Wait for `ORS_STATUS()` to return `service_ready = true` before launching workers.

---

## Key Learnings

1. **Raw dump then FLATTEN** — The single most important pattern. Inline FLATTEN during API ingestion blocks all progress until entire batches complete. Raw VARIANT dump inserts immediately.

2. **Gateway is a hidden bottleneck** — ORS instances alone aren't enough. Gateway instances must match ORS count or they become the throughput ceiling.

3. **Adaptive batch sizing per resolution** — Don't use one batch size globally. Heavy resolutions (low res numbers with many dests) need small batches, light ones (high res with few dests) can use large batches.

4. **Multi-cluster warehouse for concurrency** — Workers are I/O-bound waiting for ORS, not compute-bound. Use XSMALL with auto-scaling for cost-optimal performance.

5. **Resume safety is essential** — Workers crash, get 503'd, timeout. The procedure must resume from last completed SEQ_ID, not restart.

6. **XLARGE for FLATTEN, XSMALL multi-cluster for API calls** — Different workloads need different warehouse shapes.

7. **Right-size for your region** — A single city needs 3 instances and finishes in minutes. Don't over-provision.

8. **ORS throughput ceiling** — ~67.5 MATRIX_TABULAR calls/sec per instance. Scale nodes linearly to increase.

9. **MAX_BATCH_ROWS stays at 1000** — This is the Snowflake external function batch setting. Reduce per-procedure batch_size instead.
