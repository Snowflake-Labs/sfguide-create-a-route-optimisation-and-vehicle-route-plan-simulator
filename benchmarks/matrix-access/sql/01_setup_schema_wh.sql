-- 01_setup_schema_wh.sql
-- Create the BENCH_MATRIX schema and the warehouses used by the benchmark.
-- Target db/schema: BENCHMARK.BENCH_MATRIX (self-contained in the benchmarks database)

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-matrix-access-benchmark","version":{"major":1,"minor":0},"attributes":{"is_quickstart":0,"source":"sql"}}';

CREATE SCHEMA IF NOT EXISTS BENCHMARK.BENCH_MATRIX
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-matrix-access-benchmark","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"benchmark"}}';

-- Measurement warehouse (XSMALL). Also serves as the interactive fallback warehouse
-- for queries that exceed the interactive 5s timeout (W2 group lookups while warming).
CREATE WAREHOUSE IF NOT EXISTS BENCH_STD_WH
  WAREHOUSE_SIZE = 'XSMALL'
  AUTO_SUSPEND = 60
  AUTO_RESUME = TRUE
  INITIALLY_SUSPENDED = FALSE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-matrix-access-benchmark","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"benchmark","role":"standard"}}';

-- Build warehouse (LARGE) used only to build the variant copies and probe sets at 3.2B-row scale.
CREATE WAREHOUSE IF NOT EXISTS BENCH_BUILD_WH
  WAREHOUSE_SIZE = 'LARGE'
  AUTO_SUSPEND = 60
  AUTO_RESUME = TRUE
  INITIALLY_SUSPENDED = FALSE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-matrix-access-benchmark","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"benchmark","role":"build"}}';

-- Interactive warehouse (Gen2), XSMALL: 31.6 GB working set fits the <350 GB XSMALL cache.
-- Pin to a single cluster so no cold cluster appears mid-measurement.
CREATE INTERACTIVE WAREHOUSE IF NOT EXISTS BENCH_INT_WH
  WAREHOUSE_SIZE = 'XSMALL'
  MIN_CLUSTER_COUNT = 1
  MAX_CLUSTER_COUNT = 1
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-matrix-access-benchmark","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"benchmark","role":"interactive"}}';

-- Fallback warehouse: interactive WH cancels queries after a fixed 5s; offload timed-out
-- queries (e.g. cold W2 group lookups over 3.2B rows) to the XSMALL standard WH for auto-retry.
ALTER WAREHOUSE BENCH_INT_WH SET FALLBACK_WAREHOUSE = BENCH_STD_WH;
