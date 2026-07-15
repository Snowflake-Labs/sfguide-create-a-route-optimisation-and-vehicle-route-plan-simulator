# Matrix Access Benchmark - Summary

Generated: 2026-06-01 21:48:39 CEST
Source: `BENCHMARK.TRAVEL_MATRIX.GERMANY_DRIVING_HGV_MATRIX_RES7` (~3.2 B rows, ~31.6 GB).

Latencies are client-measured wall time per query (warm-up excluded).
Result cache disabled at session level.

| Variant | Workload | N | p50 ms | p95 ms | p99 ms | mean ms | mean rows |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Standard | W1_point | 150 | 2449.0 | 3306.4 | 3895.7 | 2393.0 | 1 |
| Standard | W2_group | 40 | 5275.8 | 7523.7 | 9123.4 | 5509.8 | 77712 |
| Clustered | W1_point | 150 | 3046.0 | 4245.0 | 5050.3 | 2602.8 | 1 |
| Clustered | W2_group | 40 | 8062.4 | 12628.2 | 13788.1 | 8138.5 | 77712 |
| Interactive (Gen2) | W1_point | 150 | 285.6 | 802.5 | 1096.5 | 343.1 | 1 |
| Interactive (Gen2) | W2_group | 40 | 2515.6 | 38817.2 | 57411.3 | 6353.5 | 77712 |

## Run configuration

- Variants measured: **Standard, Clustered, Interactive (Gen2)**. The **Hybrid (Unistore)** variant was **excluded** at this scale (see below).
- Probes: 150 W1 point lookups, 40 W2 group lookups (warm-up = 10, discarded). Reduced from the default 1000/200 because point lookups on a 3.2 B-row table run ~2.5 s each on XSMALL, making the full probe set multi-hour.
- Build warehouse: `BENCH_BUILD_WH` (LARGE). Measurement: `BENCH_STD_WH` (XSMALL standard) for Standard/Clustered; `BENCH_INT_WH` (XSMALL interactive, single cluster) for Interactive.
- W2 group lookup returns **77,712 rows** per origin (avg dests/origin on RES7) - ~6x the original RES6 study.
- `USE_CACHED_RESULT = FALSE`; bind variables used (warm compilation cache). Interactive cache warmed ~100 min before measurement.

## Key findings

- **Interactive wins both workloads on p50.** W1 point lookup p50 **285.6 ms vs 2449 ms** standard (~8.6x faster). W2 group lookup p50 **2515 ms vs 5276 ms** standard (~2.1x faster).
- **Interactive W2 tail latency is huge (p95 38.8 s, p99 57.4 s).** Interactive warehouses enforce a hard **5-second query timeout**; the heavier W2 group lookups (77 k rows) that exceed 5 s are auto-cancelled and **retried on the fallback warehouse** (`BENCH_STD_WH`, an XSMALL standard WH that must cold-resume). Those retries dominate the tail. p50 stays low because most warm W2 queries complete under 5 s. This is the documented fallback behavior (`fault_handling_time` in Query Profile), not query failures - zero errors occurred.
- **Clustered was not faster than Standard here.** Clustering by `ORIGIN_H3` did not improve point lookups (filter is `ORIGIN_H3 + DEST_H3`) and W2 came out slower, likely clustering/maintenance overhead plus cold micro-partitions at 3.2 B rows. Search Optimization (dropped per request) would be the lever for point lookups on standard tables.

## Hybrid (Unistore) exclusion

The Hybrid variant `INSERT` of all 3.2 B rows did **not complete within ~100 minutes** on a LARGE warehouse and was cancelled. Hybrid-table bulk-load throughput is the bottleneck at billions of rows (it does not scale with warehouse size). For point-lookup serving on Unistore at this scale, load incrementally or via smaller batched/CDC ingestion rather than a single multi-billion-row `INSERT ... SELECT`. The variant is retained in the SQL DDL for smaller tables but removed from the harness `VARIANTS` for this run.
