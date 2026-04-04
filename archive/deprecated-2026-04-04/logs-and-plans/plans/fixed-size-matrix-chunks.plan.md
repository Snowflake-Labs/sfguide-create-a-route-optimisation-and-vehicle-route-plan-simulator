# Plan: Fixed-Size Matrix Chunks (1x1000)

## Core Idea

Instead of sending 1 origin x ALL destinations (e.g., 1x2610 for Berlin RES8), split each origin's destinations into chunks of 1000 in the work queue. Every ORS MATRIX call is always 1x1000 (or less for the last chunk), regardless of resolution or region size.

## Current Data Flow

```
BUILD_WORK_QUEUE: 1 row per origin, DEST_COORDS = [all 2610 destinations]
                            |
                            v
INSERT...SELECT:  MATRIX_TABULAR(profile, origin, dest_coords)  -->  1x2610 matrix call
                            |
                            v
RAW table:        1 row per origin, MATRIX_RESULT = {durations: [[2610 values]]}
                            |
                            v
FLATTEN:          LATERAL FLATTEN(durations[0]) + DEST_HEX_IDS[f.INDEX]
```

Berlin RES8: 2611 origins x 2610 destinations = each ORS call computes a 1x2610 matrix.

## Proposed Data Flow

```
BUILD_WORK_QUEUE: 3 rows per origin (2610 / 1000 = 3 chunks)
                  Row 1: DEST_COORDS = [dests 1-1000],    DEST_HEX_IDS = [hex_ids 1-1000]
                  Row 2: DEST_COORDS = [dests 1001-2000], DEST_HEX_IDS = [hex_ids 1001-2000]
                  Row 3: DEST_COORDS = [dests 2001-2610], DEST_HEX_IDS = [hex_ids 2001-2610]
                            |
                            v
INSERT...SELECT:  MATRIX_TABULAR(profile, origin, dest_coords)  -->  always 1x1000 or less
                            |
                            v
RAW table:        3 rows per origin, each with MATRIX_RESULT = {durations: [[1000 values]]}
                            |
                            v
FLATTEN:          Works unchanged (each row's DEST_HEX_IDS matches its MATRIX_RESULT indices)
```

Berlin RES8: 2611 x 3 = 7833 work queue rows, each sending a 1x1000 ORS call.

## Impact Analysis

| Metric | Before (1x2610) | After (1x1000) |
|--------|-----------------|-----------------|
| Work queue rows (Berlin RES8) | 2611 | ~7833 |
| ORS payload per call | 1x2610 | 1x1000 (max) |
| ORS compute per call | Heavy | ~2.6x lighter |
| Batch of 100 rows | 100 heavy calls | 100 light calls |
| RES7 (373 dests) | 1x372 (unchanged) | 1x372 (no split needed) |
| RES5 (10 dests) | 1x9 (unchanged) | 1x9 (no split needed) |

Key: for small resolutions where dest_count <= 1000, nothing changes -- no chunking occurs.

## Changes Required

### 1. Add DEST_CHUNK_SIZE Constant

**File**: [05_matrix_pipeline.sql](native_app/app/modules/05_matrix_pipeline.sql)

Define the max destinations per work queue row. This is the only tuning knob.

```sql
LET dest_chunk_size INTEGER := 1000;
```

### 2. Modify BUILD_WORK_QUEUE to Chunk Destinations

**File**: [05_matrix_pipeline.sql](native_app/app/modules/05_matrix_pipeline.sql), lines 137-192

Current SQL (lines 157-182) builds one row per origin with ALL destinations:

```sql
INSERT INTO queue_table (SEQ_ID, ORIGIN_H3, ORIGIN_LON, ORIGIN_LAT, DEST_COORDS, DEST_HEX_IDS)
WITH pairs AS (
    SELECT a.H3_INDEX AS origin_h3, a.CENTER_LON, a.CENTER_LAT,
           b.H3_INDEX AS dest_h3
    FROM hex_table a CROSS JOIN hex_table b
    WHERE a.H3_INDEX != b.H3_INDEX
),
grouped AS (
    SELECT origin_h3, origin_lon, origin_lat,
           ARRAY_AGG(ARRAY_CONSTRUCT(d.CENTER_LON, d.CENTER_LAT)) AS dest_coords,
           ARRAY_AGG(p.dest_h3) AS dest_hex_ids
    FROM pairs p JOIN hex_table d ON p.dest_h3 = d.H3_INDEX
    GROUP BY origin_h3, origin_lon, origin_lat
)
SELECT ROW_NUMBER() OVER (ORDER BY origin_h3), ...
FROM grouped
```

Replace with a chunked version that splits each origin's destinations into groups of 1000:

```sql
INSERT INTO queue_table (SEQ_ID, ORIGIN_H3, ORIGIN_LON, ORIGIN_LAT, DEST_COORDS, DEST_HEX_IDS)
WITH numbered_pairs AS (
    SELECT
        a.H3_INDEX AS origin_h3,
        a.CENTER_LON AS origin_lon,
        a.CENTER_LAT AS origin_lat,
        b.H3_INDEX AS dest_h3,
        b.CENTER_LON AS dest_lon,
        b.CENTER_LAT AS dest_lat,
        ROW_NUMBER() OVER (PARTITION BY a.H3_INDEX ORDER BY b.H3_INDEX) AS dest_seq
    FROM hex_table a
    CROSS JOIN hex_table b
    WHERE a.H3_INDEX != b.H3_INDEX
),
chunked AS (
    SELECT
        origin_h3, origin_lon, origin_lat,
        FLOOR((dest_seq - 1) / dest_chunk_size) AS chunk_idx,
        ARRAY_AGG(ARRAY_CONSTRUCT(dest_lon, dest_lat)) AS dest_coords,
        ARRAY_AGG(dest_h3) AS dest_hex_ids
    FROM numbered_pairs
    GROUP BY origin_h3, origin_lon, origin_lat, chunk_idx
)
SELECT
    ROW_NUMBER() OVER (ORDER BY origin_h3, chunk_idx) AS seq_id,
    origin_h3, origin_lon, origin_lat, dest_coords, dest_hex_ids
FROM chunked
```

Each origin with >1000 destinations produces multiple rows, each with at most 1000 destinations. SEQ_ID is still globally unique and sequential.

Note: `dest_chunk_size` is a SQL variable, so it needs to be passed into the dynamic SQL. The simplest approach is to inline the literal `1000` directly:

```sql
FLOOR((dest_seq - 1) / 1000) AS chunk_idx
```

### 3. Adjust Batch Sizes (Simplify)

**File**: [05_matrix_pipeline.sql](native_app/app/modules/05_matrix_pipeline.sql), lines 356-368 (BUILD_TRAVEL_TIME_RANGE_REGION)

With every ORS call now capped at 1x1000, we can use larger batch sizes since each call is lightweight. Simplify to a single batch size for all resolutions:

```sql
batch_size := 50;
```

Since each row is now a fixed-size 1x1000 call, a batch of 50 = 50 concurrent 1x1000 ORS calls. This is consistent and predictable regardless of resolution.

For single-instance city services, we may still want to reduce this. But the uniform payload size makes this much less critical than before.

### 4. Adjust Error Detection in FLATTEN_MATRIX_RAW

**File**: [05_matrix_pipeline.sql](native_app/app/modules/05_matrix_pipeline.sql), lines 460-510

The flattening code already handles multiple rows per origin correctly -- it uses `LATERAL FLATTEN` on each row's `MATRIX_RESULT:durations[0]` and maps to `DEST_HEX_IDS[f.INDEX]`. No changes needed here.

### 5. Fix the Error Retry Loop (Still Needed)

**File**: [05_matrix_pipeline.sql](native_app/app/modules/05_matrix_pipeline.sql), lines 419-451

The post-build retry loop still retries all failed rows in a single unbatched INSERT. Even with 1x1000 payloads, retrying 6000+ rows at once is too many concurrent calls. Apply the same batched retry approach:

```sql
WHILE (retry_pass < max_error_retries) DO
    -- Count errors
    ...
    IF (error_origin_count = 0) THEN EXIT;
    ELSE
        retry_pass := retry_pass + 1;
        EXECUTE IMMEDIATE 'SELECT SYSTEM$WAIT(30)';
        -- Delete error rows
        EXECUTE IMMEDIATE 'DELETE FROM ' || raw_table || ' WHERE ... AND MATRIX_RESULT:durations IS NULL';
        -- Retry missing rows in batches of batch_size
        LET min_missing INTEGER; LET max_missing INTEGER;
        ... get range of missing SEQ_IDs ...
        retry_pos := min_missing;
        WHILE (retry_pos <= max_missing) DO
            retry_end := LEAST(retry_pos + batch_size - 1, max_missing);
            BEGIN
                EXECUTE IMMEDIATE 'INSERT INTO ' || raw_table || '
                    SELECT ... FROM ' || queue_table || ' q
                    WHERE q.SEQ_ID BETWEEN ' || retry_pos || ' AND ' || retry_end ||
                    ' AND q.SEQ_ID NOT IN (SELECT SEQ_ID FROM ' || raw_table || ' WHERE ...)';
            EXCEPTION WHEN OTHER THEN NULL;
            END;
            retry_pos := retry_end + 1;
        END WHILE;
    END IF;
END WHILE;
```

### 6. Update WORK_QUEUE_ROWS in Job Status

**File**: [05_matrix_pipeline.sql](native_app/app/modules/05_matrix_pipeline.sql), lines 767-771

The `WORK_QUEUE_ROWS` field and UI progress display (`{raw_rows} / {work_queue_rows} origins`) will now show chunk rows instead of origin count. To keep the UI meaningful, we should also track the actual origin count (hexagons) vs work queue rows:

The existing `HEXAGONS` field already stores the origin count (set at line 761-763). The UI can use `raw_rows / work_queue_rows` for chunk-level progress, or we can update it to show `raw_rows / work_queue_rows chunks ({hexagons} origins)`. This is a minor UI tweak in [MatrixBuilder.tsx](native_app/services/ors_control_app/src/components/MatrixBuilder.tsx) line 269.

### 7. Deploy and Test

Run `snow app run`, then rebuild Berlin cycling-electric RES8.

## Summary of Changes

| File | What Changes |
|------|--------------|
| `05_matrix_pipeline.sql` BUILD_WORK_QUEUE | Chunk destinations into groups of 1000 |
| `05_matrix_pipeline.sql` BUILD_TRAVEL_TIME_RANGE_REGION | Simplify batch sizes, fix error retry loop |
| `05_matrix_pipeline.sql` FLATTEN_MATRIX_RAW | No changes needed |
| `05_matrix_pipeline.sql` BUILD_MATRIX_JOB_WRAPPER | No core changes (parallelism stays at 4) |
| MatrixBuilder.tsx (optional) | Update progress label to show chunks vs origins |
