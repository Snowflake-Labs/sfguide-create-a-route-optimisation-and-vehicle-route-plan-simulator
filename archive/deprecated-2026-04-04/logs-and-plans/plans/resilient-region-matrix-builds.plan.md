# Plan: Resilient Region Matrix Builds

## Root Cause Analysis

Berlin RES8 build completed with **only 603 of 2611 origins** (77% failure rate). Investigation reveals:

### The Numbers

| Metric | Value |
|--------|-------|
| Total origins | 2611 |
| Successful origins | 603 (23%) |
| Failed origins | 2008 (77%) |
| Destinations per origin | 2610 |
| Batch size (RES8) | 100 |
| Parallel workers | 4 |
| Berlin ORS instances | 1 |
| Peak concurrent ORS calls | 400 (4 workers x 100 batch) |

### Why It Fails

Each matrix call for RES8 computes a **1x2610 matrix** -- a heavy operation. The pipeline sends:

```
4 parallel workers x 100 origins/batch = 400 simultaneous MATRIX_TABULAR calls
Each call: 1 origin -> 2610 destinations
Against: 1 single ORS instance (Berlin)
```

Compare with the default ORS_SERVICE which has **3 instances** to distribute load. Berlin's single instance gets overwhelmed, causing ORS to return error responses (not SQL failures -- the INSERT succeeds but `MATRIX_RESULT:durations` is NULL).

### Why Retries Don't Fix It

The post-build error retry loop in [BUILD_TRAVEL_TIME_RANGE_REGION](native_app/app/modules/05_matrix_pipeline.sql) (lines 419-451) has two critical flaws:

1. **Unbatched retry**: It retries ALL failed origins in a single INSERT...SELECT. With 2008 failed origins, this fires 2008 concurrent ORS calls -- even worse than the initial build.
2. **Only 3 retries**: And each retry hammers the service just as hard, so they all fail too.

```sql
-- Current: fires ALL ~500+ failed origins at once per worker
INSERT INTO raw_table
SELECT q.SEQ_ID, q.ORIGIN_H3, q.DEST_HEX_IDS, matrix_call
FROM queue_table q
WHERE q.SEQ_ID BETWEEN start AND end
  AND q.SEQ_ID NOT IN (SELECT SEQ_ID FROM raw_table ...)
```

### Comparison: RES7 vs RES8

| Metric | RES7 (success) | RES8 (77% fail) |
|--------|----------------|------------------|
| Origins | 373 | 2611 |
| Destinations/origin | 372 | 2610 |
| Batch size | 50 | 100 |
| Concurrent calls peak | 200 | 400 |
| ORS load per call | 1x372 | 1x2610 (7x heavier) |
| Result | 100% success | 23% success |

## Proposed Changes

### 1. Adaptive Parallelism Based on Service Instance Count

**File**: [05_matrix_pipeline.sql](native_app/app/modules/05_matrix_pipeline.sql), lines 783-792 (BUILD_MATRIX_JOB_WRAPPER)

Before launching parallel workers, detect the target service's instance count. For single-instance services, reduce parallelism:

```sql
-- Detect instance count for target service
LET svc_instances INTEGER := 3;  -- default
IF (NOT is_default) THEN
    BEGIN
        SHOW SERVICES LIKE 'ORS_SERVICE_%region%' IN SCHEMA core;
        SELECT "min_instances"::INTEGER INTO :svc_instances
        FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) LIMIT 1;
    EXCEPTION WHEN OTHER THEN svc_instances := 1;
    END;
END IF;

-- Scale parallelism: 1 worker per ORS instance, max 4
LET parallel_count INTEGER := LEAST(svc_instances, 4);
```

This ensures Berlin (1 instance) gets 1 worker, while the default service (3 instances) gets 3 workers.

### 2. Dynamic Batch Sizing Based on Destination Count

**File**: [05_matrix_pipeline.sql](native_app/app/modules/05_matrix_pipeline.sql), lines 356-368 (BUILD_TRAVEL_TIME_RANGE_REGION)

The current batch sizes are fixed per resolution. But the actual ORS load depends on `batch_size x destination_count`. A batch of 100 with 2610 destinations is 7x heavier than a batch of 50 with 372 destinations.

Add a cap based on total matrix cells per batch:

```sql
-- Base batch sizes (current)
IF (P_RES = 'RES8') THEN batch_size := 100; ...

-- Dynamic cap: limit total matrix cells per batch to ~50,000
-- This keeps ORS load manageable regardless of resolution
LET dest_count INTEGER;
rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || queue_table || ' WHERE SEQ_ID = ' || P_START_SEQ);
-- Actually, destination count ~ hex_count - 1
-- Get it from the work queue's DEST_COORDS array size
rs := (EXECUTE IMMEDIATE 'SELECT ARRAY_SIZE(DEST_COORDS) AS DESTS FROM ' || queue_table || ' LIMIT 1');
LET dc CURSOR FOR rs;
FOR r IN dc DO dest_count := r.DESTS; END FOR;

LET max_cells INTEGER := 50000;
LET dynamic_batch INTEGER := GREATEST(FLOOR(max_cells / GREATEST(dest_count, 1)), 1);
batch_size := LEAST(batch_size, dynamic_batch);
```

For Berlin RES8: `FLOOR(50000 / 2610) = 19` origins per batch instead of 100. Combined with 1 worker = 19 concurrent ORS calls instead of 400.

### 3. Batched Error Retry Loop in BUILD_TRAVEL_TIME_RANGE_REGION

**File**: [05_matrix_pipeline.sql](native_app/app/modules/05_matrix_pipeline.sql), lines 419-451

Replace the unbatched "retry all at once" loop with a batched retry that processes failed origins in small groups:

```sql
-- Replace lines 419-451 with batched retry
LET error_origin_count INTEGER DEFAULT 0;
LET retry_pass INTEGER DEFAULT 0;
LET max_error_retries INTEGER DEFAULT 3;
LET retry_pos INTEGER;
LET retry_end INTEGER;
LET retry_batch INTEGER;

retry_batch := GREATEST(FLOOR(batch_size / 2), 1);  -- half the normal batch

WHILE (retry_pass < max_error_retries) DO
    -- Count remaining errors
    rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || raw_table ||
        ' WHERE SEQ_ID BETWEEN ' || P_START_SEQ || ' AND ' || P_END_SEQ ||
        ' AND MATRIX_RESULT:durations IS NULL');
    LET ec CURSOR FOR rs;
    FOR r IN ec DO error_origin_count := r.CNT; END FOR;

    IF (error_origin_count = 0) THEN
        retry_pass := max_error_retries;  -- exit
    ELSE
        retry_pass := retry_pass + 1;
        EXECUTE IMMEDIATE 'SELECT SYSTEM$WAIT(30)';  -- longer cooldown

        -- Delete all error rows
        EXECUTE IMMEDIATE 'DELETE FROM ' || raw_table ||
            ' WHERE SEQ_ID BETWEEN ' || P_START_SEQ || ' AND ' || P_END_SEQ ||
            ' AND MATRIX_RESULT:durations IS NULL';

        -- Get list of missing SEQ_IDs and retry in small batches
        -- Use a cursor over the missing origins
        LET missing_rs RESULTSET := (EXECUTE IMMEDIATE '
            SELECT q.SEQ_ID FROM ' || queue_table || ' q
            WHERE q.SEQ_ID BETWEEN ' || P_START_SEQ || ' AND ' || P_END_SEQ ||
            ' AND q.SEQ_ID NOT IN (
                SELECT SEQ_ID FROM ' || raw_table ||
                ' WHERE SEQ_ID BETWEEN ' || P_START_SEQ || ' AND ' || P_END_SEQ || ')
            ORDER BY q.SEQ_ID');
        
        -- Get min/max of missing SEQ_IDs for batched retry
        LET min_missing INTEGER;
        LET max_missing INTEGER;
        rs := (EXECUTE IMMEDIATE '
            SELECT MIN(q.SEQ_ID) AS MN, MAX(q.SEQ_ID) AS MX FROM ' || queue_table || ' q
            WHERE q.SEQ_ID BETWEEN ' || P_START_SEQ || ' AND ' || P_END_SEQ ||
            ' AND q.SEQ_ID NOT IN (
                SELECT SEQ_ID FROM ' || raw_table ||
                ' WHERE SEQ_ID BETWEEN ' || P_START_SEQ || ' AND ' || P_END_SEQ || ')');
        LET mc CURSOR FOR rs;
        FOR r IN mc DO min_missing := r.MN; max_missing := r.MX; END FOR;

        -- Retry in small batches
        retry_pos := min_missing;
        WHILE (retry_pos <= max_missing) DO
            retry_end := retry_pos + retry_batch - 1;
            BEGIN
                EXECUTE IMMEDIATE '
                INSERT INTO ' || raw_table || '
                SELECT q.SEQ_ID, q.ORIGIN_H3, q.DEST_HEX_IDS, ' || matrix_call || '
                FROM ' || queue_table || ' q
                WHERE q.SEQ_ID BETWEEN ' || retry_pos || ' AND ' || retry_end ||
                ' AND q.SEQ_ID NOT IN (SELECT SEQ_ID FROM ' || raw_table ||
                ' WHERE SEQ_ID BETWEEN ' || retry_pos || ' AND ' || retry_end || ')';
            EXCEPTION WHEN OTHER THEN NULL;
            END;
            retry_pos := retry_end + 1;
        END WHILE;
    END IF;
END WHILE;
```

### 4. Wrapper-Level Final Retry Sweep

**File**: [05_matrix_pipeline.sql](native_app/app/modules/05_matrix_pipeline.sql), lines 793-830 (BUILD_MATRIX_JOB_WRAPPER, after AWAIT ALL)

After all parallel workers finish and before flattening, add a final single-threaded retry sweep at the wrapper level. This catches any origins that all worker retries missed:

```sql
-- After AWAIT ALL (line 793), before error counting (line 795)
-- Final single-threaded retry sweep
LET sweep_error_count INTEGER;
LET sweep_pass INTEGER DEFAULT 0;
LET max_sweep_passes INTEGER DEFAULT 2;
LET sweep_batch INTEGER := GREATEST(FLOOR(dynamic_batch / 2), 5);

WHILE (sweep_pass < max_sweep_passes) DO
    rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || prefix || '_MATRIX_RAW_' || P_RES ||
        ' WHERE MATRIX_RESULT:durations IS NULL');
    LET sc CURSOR FOR rs;
    FOR r IN sc DO sweep_error_count := r.CNT; END FOR;

    IF (sweep_error_count = 0) THEN
        sweep_pass := max_sweep_passes;
    ELSE
        sweep_pass := sweep_pass + 1;
        UPDATE travel_matrix.MATRIX_BUILD_JOBS
        SET MESSAGE='Retry sweep ' || :sweep_pass || ': ' || :sweep_error_count || ' failed origins'
        WHERE JOB_ID = :P_JOB_ID;

        -- Delete errors, then re-insert in small batches
        EXECUTE IMMEDIATE 'DELETE FROM ' || prefix || '_MATRIX_RAW_' || P_RES ||
            ' WHERE MATRIX_RESULT:durations IS NULL';
        EXECUTE IMMEDIATE 'SELECT SYSTEM$WAIT(30)';

        -- Batched retry of all missing origins
        -- (single-threaded, small batches, with per-batch error handling)
        ...
    END IF;
END WHILE;
```

### 5. Deploy and Verify

Run `snow app run --connection fleet_test_evals` then trigger a Berlin cycling-electric RES8 rebuild from the UI.

## Expected Impact

| Metric | Before | After |
|--------|--------|-------|
| Peak concurrent ORS calls | 400 | ~19 |
| Batch size (RES8, 2610 dests) | 100 | ~19 |
| Parallel workers (Berlin) | 4 | 1 |
| Build time (est.) | 10 min | ~20-30 min |
| Success rate | 23% | ~95%+ |

The trade-off is longer build times (2-3x) but dramatically higher success rates. For the default ORS service with 3 instances, parallelism stays at 3 workers and batch sizes only shrink slightly, so there's minimal impact on default region builds.
