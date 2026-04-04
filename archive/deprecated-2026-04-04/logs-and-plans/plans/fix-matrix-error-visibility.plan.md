# Fix Matrix Build Silent Failure & EXECUTE AS OWNER Bug

## Problem

When ORS returns errors (like error 6010) during matrix calculation, the pipeline:
1. Inserts RAW rows containing error JSON (no `durations` field)
2. Never checks if the data is valid
3. FLATTEN filters out errors with `WHERE durations IS NOT NULL` → 0 rows
4. Marks job COMPLETE with MATRIX_ROWS=0
5. Drops intermediate tables (destroying the evidence)
6. Inventory shows 0 pairs, 0 B — **silent failure, no error in UI**

The UI already has error display (Recent Errors section, lines 282-292 of MatrixBuilder.tsx). The pipeline just never marks jobs as ERROR when ORS returns bad data.

Root cause: `EXECUTE AS OWNER` in stored procedures causes MATRIX_TABULAR to return ORS error 6010 instead of valid results.

## Changes

### 1. setup_script.sql — Error detection in BUILD_MATRIX_JOB_WRAPPER (line 1762)

After `BUILD_TRAVEL_TIME_RANGE_REGION` returns, add validation:

```sql
-- After line 1764 (counting raw rows), add:
LET valid_count INTEGER := 0;
LET error_count INTEGER := 0;
LET sample_error VARCHAR := '';

rs := (EXECUTE IMMEDIATE 'SELECT 
    COUNT(CASE WHEN MATRIX_RESULT:durations IS NOT NULL THEN 1 END) AS VALID_CNT,
    COUNT(CASE WHEN MATRIX_RESULT:durations IS NULL THEN 1 END) AS ERROR_CNT
    FROM ' || prefix || '_MATRIX_RAW_' || P_RES);
-- extract valid_count and error_count

IF (error_count > 0 AND valid_count = 0) THEN
    -- All rows are errors — extract sample error message
    rs := (EXECUTE IMMEDIATE 'SELECT COALESCE(MATRIX_RESULT:error:message::VARCHAR, 
        MATRIX_RESULT::VARCHAR) AS ERR FROM ' || prefix || '_MATRIX_RAW_' || P_RES || ' LIMIT 1');
    -- extract sample_error
    UPDATE travel_matrix.MATRIX_BUILD_JOBS
    SET STATUS='ERROR', STAGE='BUILDING', 
        ERROR_MSG='ORS returned errors for all ' || raw_count || ' origins. Sample: ' || sample_error,
        RAW_ROWS=raw_count, COMPLETED_AT=CURRENT_TIMESTAMP()
    WHERE JOB_ID = :P_JOB_ID;
    -- DO NOT drop intermediate tables (for debugging)
    RETURN 'Job ' || P_JOB_ID || ' failed: all ORS responses were errors';
END IF;

IF (error_count > 0) THEN
    -- Partial errors — log warning but continue
    UPDATE travel_matrix.MATRIX_BUILD_JOBS
    SET ERROR_MSG='Warning: ' || error_count || ' of ' || raw_count || ' origins returned ORS errors'
    WHERE JOB_ID = :P_JOB_ID;
END IF;
```

Also after FLATTEN, add:
```sql
IF (matrix_count = 0 AND raw_count > 0) THEN
    UPDATE travel_matrix.MATRIX_BUILD_JOBS
    SET STATUS='ERROR', ERROR_MSG='Flatten produced 0 pairs from ' || raw_count || ' RAW rows — all results may be errors',
        COMPLETED_AT=CURRENT_TIMESTAMP()
    WHERE JOB_ID = :P_JOB_ID;
    RETURN 'Job ' || P_JOB_ID || ' failed: 0 pairs after flatten';
END IF;
```

### 2. setup_script.sql — Fix EXECUTE AS OWNER

**Change to EXECUTE AS CALLER:**
- `BUILD_TRAVEL_TIME_RANGE_REGION` (line 1425)
- `BUILD_MATRIX_JOB_WRAPPER` (line 1714)

**Create helper proc for table drops:**
```sql
CREATE OR REPLACE PROCEDURE core.CLEANUP_MATRIX_INTERMEDIATES(P_REGION VARCHAR, P_PROFILE VARCHAR, P_RES VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS $$
-- DROP LIST, WORK_QUEUE, and RAW tables
$$;
```

**Why EXECUTE AS CALLER fixes the root cause:**
- Service functions (MATRIX_TABULAR) work when called from ACCOUNTADMIN/app_user context
- They fail when called from the native app OWNER context
- EXECUTE AS CALLER means the procedure runs with the caller's privileges
- The SPCS app calls with app_user, which has INSERT/SELECT/TRUNCATE on all matrix tables
- The only operation app_user can't do is DROP TABLE → moved to the helper proc

### 3. No UI changes needed

The MatrixBuilder.tsx already:
- Shows ERROR jobs in "Recent Errors" section (line 282)
- Displays error_msg from the job (line 287)
- The polling will stop once the job is no longer RUNNING/PENDING
