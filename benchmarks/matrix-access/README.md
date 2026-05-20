# Travel-Matrix Access-Speed Benchmark

A side study (NOT a deployable skill) comparing query latency for two access
patterns on a copy of `OPENROUTESERVICE_APP.TRAVEL_MATRIX.GERMANY_DRIVING_HGV_MATRIX_RES6`
across five Snowflake table formats:

| # | Variant | Notes |
|---|---|---|
| A | Standard table | Baseline CTAS |
| B | Standard + Search Optimization | `EQUALITY(ORIGIN_H3, DEST_H3)` |
| C | Standard clustered by `(ORIGIN_H3)` | Helps W2 pruning |
| D | Hybrid (Unistore) | PK `(ORIGIN_H3, DEST_H3)`, secondary index on `ORIGIN_H3` |
| E | Interactive Table (Gen2) | `CLUSTER BY (ORIGIN_H3)` on a dedicated interactive WH |

## Workloads

- **W1 - Point lookup**: `WHERE ORIGIN_H3 = ? AND DEST_H3 = ?` (1 row)
- **W2 - Group lookup**: `WHERE ORIGIN_H3 = ?` (one origin -> all destinations)

## Folder layout

```
benchmarks/matrix-access/
  sql/
    00_probe_source.sql      Source-size + distinct-key probes
    01_setup_schema_wh.sql   BENCH_MATRIX schema + 2 warehouses
    02_create_variants.sql   CTAS A,B,C,D,E + SOS + interactive WH attach
    03_probe_sets.sql        BENCH_PROBES_W1 / W2 fixed probe tables
    99_cleanup.sql           Drop everything
  harness/
    run_benchmark.py         Runs warm-up + measurement; writes CSV
    workloads.py             W1 / W2 query templates
    requirements.txt
  results/
    bench_results.csv
    summary.md
  logs/
    friction-log_*.md
```

All benchmark Snowflake objects live in `OPENROUTESERVICE_APP.BENCH_MATRIX`
and on dedicated warehouses `BENCH_STD_WH` and `BENCH_INT_WH`. Production
objects in `TRAVEL_MATRIX.*` are NOT modified.

## How to run

```bash
# 1. Prep + variants (run once)
snow sql -f benchmarks/matrix-access/sql/00_probe_source.sql
snow sql -f benchmarks/matrix-access/sql/01_setup_schema_wh.sql
snow sql -f benchmarks/matrix-access/sql/02_create_variants.sql
snow sql -f benchmarks/matrix-access/sql/03_probe_sets.sql

# 2. Run harness
cd benchmarks/matrix-access/harness
pip install -r requirements.txt
SNOWFLAKE_CONNECTION_NAME=<your-connection> python run_benchmark.py

# 3. Inspect results
cat ../results/summary.md

# 4. Cleanup
snow sql -f benchmarks/matrix-access/sql/99_cleanup.sql
```

## Caveats / preconditions

- Hybrid Tables must be enabled on the account.
- Interactive Tables (Gen2) must be GA in your AWS region.
- Source matrix `GERMANY_DRIVING_HGV_MATRIX_RES6` must be fully populated.
- Interactive Warehouse first resume incurs a 1-hour minimum bill.
- `USE_CACHED_RESULT = FALSE` is set at session level so result caching
  doesn't pollute the comparison.
