-- 01_setup_schema_wh.sql
-- Create the BENCH_MATRIX schema and the two warehouses used by the benchmark.

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-matrix-access-benchmark","version":{"major":1,"minor":0},"attributes":{"is_quickstart":0,"source":"sql"}}';

CREATE SCHEMA IF NOT EXISTS OPENROUTESERVICE_APP.BENCH_MATRIX
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-matrix-access-benchmark","version":{"major":1,"minor":0},"attributes":{"component":"benchmark"}}';

CREATE WAREHOUSE IF NOT EXISTS BENCH_STD_WH
  WAREHOUSE_SIZE = 'XSMALL'
  AUTO_SUSPEND = 60
  AUTO_RESUME = TRUE
  INITIALLY_SUSPENDED = FALSE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-matrix-access-benchmark","version":{"major":1,"minor":0},"attributes":{"component":"benchmark","role":"standard"}}';

CREATE INTERACTIVE WAREHOUSE IF NOT EXISTS BENCH_INT_WH
  WAREHOUSE_SIZE = 'XSMALL'
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-matrix-access-benchmark","version":{"major":1,"minor":0},"attributes":{"component":"benchmark","role":"interactive"}}';
