# Plan: Resilient Matrix Batches

## Problem
When a batch fails all 5 retries, the worker **dies and abandons its entire remaining chunk**. With 4 parallel workers, a single bad batch per worker means up to 75% of origins are never attempted. The UI counter goes backwards as failed batch rows roll back, and there's no recovery.

## Root Cause
```sql
-- Current: RAISE kills the worker
IF (retry_count > max_retries) THEN RAISE; END IF;
```

## Solution

### 1. Worker Resilience (highest impact)
Change the retry exhaustion from `RAISE` to `CONTINUE` — skip the failed batch and move on:

```sql
-- Before (worker dies):
IF (retry_count > max_retries) THEN RAISE; END IF;

-- After (worker continues):
IF (retry_count > max_retries) THEN
    failed_batches := failed_batches + 1;
    -- break out of retry WHILE, outer WHILE continues to next batch
END IF;
```

This means a worker that encounters 1 bad batch out of 13 will still complete the other 12 instead of dying.

### 2. Reduce Batch Sizes
| Resolution | Current | New |
|-----------|---------|-----|
| RES5 | 20 | 10 |
| RES6 | 50 | 25 |
| RES7 | 100 | 50 |
| RES8 | 200 | 100 |
| RES9 | 100 | 50 |
| Default | 50 | 25 |

### 3. Failed Batch Tracking
Add `failed_batches` counter variable. Return count in worker result string. Parent procedure logs it to `MATRIX_BUILD_JOBS.ERROR_MSG`.

### 4. Live Progress Updates
Update `MATRIX_BUILD_JOBS.RAW_ROWS` every 10 batches by counting `_MATRIX_RAW_` table rows, so the UI shows real-time progress instead of 0 → final_count jump.

### 5. Files to Modify
- `native_app/app/modules/05_matrix_pipeline.sql` — both `BUILD_TRAVEL_TIME_RANGE` and `BUILD_TRAVEL_TIME_RANGE_REGION` procedures
- Symlinks in `output/deploy/modules/` auto-sync

### 6. Deploy
- `snow app run` to upgrade the native app
