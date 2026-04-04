# Plan: Reduce Matrix Batch Sizes

## Problem

Each matrix batch is a single `INSERT ... SELECT` calling `MATRIX_TABULAR()` for N origin hexes. If any row in the batch causes an ORS timeout or error, the entire batch fails and must be retried. With RES8 at 200 rows per batch, a single bad row wastes the work of 199 good rows.

## Change

Halve all batch sizes in both procedures:

**File:** [app/modules/05_matrix_pipeline.sql](.cortex/skills/build-routing-solution/native_app/app/modules/05_matrix_pipeline.sql)

Two identical batch-size blocks exist (lines ~220-232 and ~346-358):

| Resolution | Current | Proposed |
|---|---|---|
| RES5 | 20 | 10 |
| RES6 | 50 | 25 |
| RES7 | 100 | 50 |
| RES8 | 200 | 100 |
| RES9 | 100 | 50 |
| RES10 | 50 | 25 |

## Trade-off

- Fewer failures per batch (less wasted work on retries)
- More total batches = more SQL statements = slightly more overhead
- Net effect: faster completion because retries are the dominant cost, not SQL overhead

## Scope

- One file: `05_matrix_pipeline.sql` (deploy copy is a symlink, auto-synced)
- Two procedures: `BUILD_TRAVEL_TIME_RANGE` (line ~220) and `BUILD_TRAVEL_TIME_RANGE_REGION` (line ~346)
- Deploy via `snow app run` and verify with `GET_DDL`