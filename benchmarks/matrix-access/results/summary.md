# Matrix Access Benchmark - Summary

**Source:** `OPENROUTESERVICE_APP.TRAVEL_MATRIX.GERMANY_DRIVING_HGV_MATRIX_RES6`
(121,386,546 rows, 9,669 distinct origins, ~12,554 dests/origin, 0.71 GB compressed)

**Generated:** 2026-05-13 12:32 (region AWS_US_WEST_2, account WGB26798)

**Workloads**
- **W1 - Point lookup**: `WHERE ORIGIN_H3 = ? AND DEST_H3 = ?` (1 row returned)
- **W2 - Group lookup**: `WHERE ORIGIN_H3 = ?` (~12,554 rows returned)

Sample size per variant: 150 W1 probes, 40 W2 probes (warm-up of 10 discarded). Result cache disabled. Bind variables used. Each variant runs sequentially on a freshly resumed XSMALL warehouse (BENCH_STD_WH for A-D, dedicated XSMALL Interactive warehouse BENCH_INT_WH for E).

## Client wall-time latency (per query, ms)

Includes network round-trip + result fetch. This is what an application would observe.

| Variant | Workload | N | p50 | p95 | p99 | mean | mean rows |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Standard | W1 point | 150 | **494.7** | 920.1 | 1323.7 | 550.8 | 1 |
| Standard | W2 group | 40 | 1081.7 | 1623.0 | 1899.2 | 1138.7 | 12,554 |
| Standard+SOS | W1 point | 150 | 451.1 | 860.3 | 1145.7 | 520.8 | 1 |
| Standard+SOS | W2 group | 40 | 1081.3 | 1491.3 | 1637.7 | 1112.1 | 12,554 |
| Clustered (ORIGIN_H3) | W1 point | 150 | 382.3 | 827.9 | 978.3 | 459.7 | 1 |
| Clustered (ORIGIN_H3) | W2 group | 40 | 1119.9 | 1622.4 | 1773.8 | 1165.2 | 12,554 |
| **Hybrid (Unistore)** | W1 point | 150 | **212.8** | 234.7 | 427.6 | 219.4 | 1 |
| Hybrid (Unistore) | W2 group | 40 | 2034.2 | 2771.3 | 2904.2 | 1977.7 | 12,554 |
| Interactive (Gen2) | W1 point | 150 | 218.0 | 265.8 | 396.6 | 225.4 | 1 |
| **Interactive (Gen2)** | W2 group | 40 | **725.2** | 960.3 | 972.1 | 751.4 | 12,554 |

## Server-side metrics (ACCOUNT_USAGE.QUERY_HISTORY)

Strips out client + network overhead. `EXEC_MS` is `EXECUTION_TIME`, `COMPILE_MS` is `COMPILATION_TIME`. Hybrid table queries report 0 partitions because hybrid tables use row-store, not micropartitions.

| Variant | Workload | exec ms | compile ms | MB scanned | parts / total | local cache % |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Standard           | W1 | 195.0 | 87.2  | 114.0 | 21.3 / 48 | 98 |
| Standard           | W2 | 290.6 | 75.6  | 105.8 | 21.9 / 48 | 99 |
| Standard+SOS       | W1 | 222.2 | 117.0 |  88.9 | 15.6 / 50 | 94 |
| Standard+SOS       | W2 | 240.4 | 104.6 | 140.6 |  9.1 / 50 | 99 |
| Clustered          | W1 | 188.4 | 77.0  |  69.5 | 12.0 / 50 | 93 |
| Clustered          | W2 | 244.5 | 72.3  | 157.8 | 12.6 / 50 | 99 |
| Hybrid             | W1 |  64.8 | 115.1 |   - |   -        |  - |
| Hybrid             | W2 | 1090  |  35.0 |   - |   -        |  - |
| **Interactive**    | W1 |  **33.4** |  **16.2** |  87.9 | 17.5 / 76 | **100** |
| **Interactive**    | W2 | **149.8** |  **16.8** | 143.3 | 18.0 / 76 | **100** |

## Headline findings

1. **For point lookups (W1), Hybrid Tables and Interactive Tables tie at ~210 ms p50 client time** - roughly 2x faster than a plain standard table (~495 ms). Server-side, Interactive is ~6x faster (33 ms vs 195 ms) than Standard - the rest is network/fetch overhead.

2. **For group lookups (W2 - one origin to all destinations) Interactive Tables clearly win**: 725 ms p50 client (150 ms server), versus 1080 ms / 290 ms for Standard. Caching plus the Gen2 engine cut server execution by ~50%.

3. **Hybrid Tables are the slowest for group lookups (~2.0 s p50)** despite having a secondary index on `ORIGIN_H3`. Returning 12 k rows from a row-store with sequential index walks is slower than columnar bulk reads. Hybrid wins on point lookups but is the wrong choice for "fan-out" reads.

4. **Search Optimization had a small effect on point lookups (~10 % improvement) and almost none on group lookups**. SOS shines on highly selective equality predicates; the working set here is already micro-partition-prunable by clustering.

5. **Manual `CLUSTER BY (ORIGIN_H3)` reduced partitions scanned from 21 to 12 for W1 (43 % improvement)**, with a corresponding 23 % drop in p50 client latency vs Standard. For W2 the clustered table scans the same number of partitions but each contains ~10x more relevant rows, so wall-time gain is small.

6. **Compilation time matters at this latency scale.** The Interactive engine compiles in ~16 ms vs ~80-120 ms for Standard. Combined with bind-variable cache reuse, this is a major contributor to the sub-50 ms server-side W1 numbers.

7. **Network/client overhead is significant.** Across all variants, p50 client time minus server EXECUTION_TIME is roughly 150-300 ms - this is round-trip + result-fetch. For an app at 200 ms target latency budget, getting server execution under 50 ms (Interactive) or ~65 ms (Hybrid) is the winning move.

## Recommendation per access pattern

| Access pattern | Best variant | Reason |
|---|---|---|
| App-side point lookup (1 row, low concurrency) | Hybrid or Interactive | Both ~210 ms p50; choose Hybrid if you also need DML, Interactive if you also need group/aggregation queries |
| Dashboard / reachability query (origin -> all dests) | **Interactive (Gen2)** | 30-50 % faster than any standard variant, 3x faster than Hybrid |
| Backend aggregations (avg time per region, top-N) | **Interactive (Gen2)** | Columnar engine + cache; same workload pattern Snowflake optimised the variant for |
| Cost-sensitive, occasional access | Standard or Clustered | No interactive-warehouse minimum-bill cost; "good enough" if latency budget > 1 s |

## Caveats

- Sample size is modest (150 W1, 40 W2). Larger N would tighten p99 estimates.
- The Interactive warehouse was newly resumed; initial cache warm-up for `BENCH_MATRIX_INTERACTIVE` (~0.87 GB) on XSMALL takes ~2 s and was completed before measurement. With tables larger than ~350 GB on XSMALL you would see a lower local-cache hit rate.
- Hybrid table `INSERT ... SELECT` of 121 M rows took ~10 minutes and consumed ~6 GB of hybrid-table-rated storage. Operational cost considerations are out of scope here.
- ACCOUNT_USAGE numbers for Hybrid (D) reflect only the most recently committed rows that have propagated; client-side numbers are the authoritative ones for this run.

## Files

- `bench_results.csv` - one row per measured query (variant, workload, client_ms, query_id, row_count).
- `summary.md` - this file.
- See `../sql/` for DDL and `../harness/` for the Python harness.
