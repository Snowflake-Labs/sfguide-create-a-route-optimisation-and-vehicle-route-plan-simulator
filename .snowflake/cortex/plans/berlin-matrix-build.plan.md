# Plan: Build Berlin RES8 Matrix and Fix Procedure

## Problem Summary

The Berlin matrix build produced 0 pairs because the `BUILD_TRAVEL_TIME_RANGE_REGION` stored procedure runs `EXECUTE AS OWNER` (the native app). When the MATRIX_TABULAR service function is called from this context, ORS returns error 6010 ("points out of bounds") for every row. The same INSERT works perfectly when run directly as ACCOUNTADMIN.

## Current State

- **Hexagons**: 2475 built in `BERLIN_DRIVING_CAR_LIST_RES8`
- **Work queue**: 2475 origins in `BERLIN_DRIVING_CAR_WORK_QUEUE_RES8`
- **RAW table**: 500 valid rows (SEQ 1-500) already inserted by direct INSERT
- **Remaining**: SEQ 501-2475 (1975 rows)

## Step 1: Complete Batch INSERTs

Run 4 batch INSERTs directly (not through the stored procedure):

```sql
-- Batch 3: SEQ 501-1000
INSERT INTO ...BERLIN_DRIVING_CAR_MATRIX_RAW_RES8
SELECT q.SEQ_ID, q.ORIGIN_H3, q.DEST_HEX_IDS,
    OPENROUTESERVICE_NATIVE_APP.CORE.MATRIX_TABULAR('Berlin', 'driving-car',
        ARRAY_CONSTRUCT(q.ORIGIN_LON, q.ORIGIN_LAT), q.DEST_COORDS)
FROM ...BERLIN_DRIVING_CAR_WORK_QUEUE_RES8 q
WHERE q.SEQ_ID BETWEEN 501 AND 1000;

-- Batch 4: SEQ 1001-1500
-- Batch 5: SEQ 1501-2000
-- Batch 6: SEQ 2001-2475
```

Each batch of 500 rows takes ~2-4 minutes. Total: ~10-15 minutes.

## Step 2: Verify and Flatten

```sql
-- Verify all rows valid
SELECT COUNT(*) total,
    COUNT(CASE WHEN MATRIX_RESULT:durations IS NOT NULL THEN 1 END) valid
FROM ...BERLIN_DRIVING_CAR_MATRIX_RAW_RES8;

-- Flatten
CALL OPENROUTESERVICE_NATIVE_APP.CORE.FLATTEN_MATRIX_RAW('RES8', 'Berlin', 'driving-car');
```

Expected: ~6.1M travel time pairs (2475 x 2474).

## Step 3: Clean Up

```sql
DROP TABLE IF EXISTS ...BERLIN_DRIVING_CAR_LIST_RES8;
DROP TABLE IF EXISTS ...BERLIN_DRIVING_CAR_WORK_QUEUE_RES8;
DROP TABLE IF EXISTS ...BERLIN_DRIVING_CAR_MATRIX_RAW_RES8;
```

## Step 4: Fix Root Cause

The issue is in [setup_script.sql](build-routing-solution/Native_app/app/setup_script.sql) line 1425:

```sql
-- Current (broken for service functions in native app context):
EXECUTE AS OWNER

-- Fix:
EXECUTE AS CALLER
```

Procedures to fix:
- `BUILD_TRAVEL_TIME_RANGE_REGION` (line 1425) - the direct caller of MATRIX_TABULAR
- Possibly `BUILD_MATRIX_JOB_WRAPPER` (line 1714) and `BUILD_MATRIX_FOR_REGION` (line 1566)

After editing, redeploy via `ALTER APPLICATION ... UPGRADE USING @stage`.

## Risk

Changing `EXECUTE AS OWNER` to `EXECUTE AS CALLER` means the procedures will run with the caller's privileges. The caller (SPCS app) needs SELECT/INSERT/TRUNCATE on the travel_matrix tables and USAGE on the functions. This should work because the SPCS app runs with the app_user role which already has these grants.
