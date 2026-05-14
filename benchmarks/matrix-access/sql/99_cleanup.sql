-- 99_cleanup.sql
-- Tear down all objects created by the matrix-access benchmark.
-- Safe to re-run.

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-matrix-access-benchmark","version":{"major":1,"minor":0},"attributes":{"is_quickstart":0,"source":"sql"}}';

-- Detach interactive table from interactive warehouse (no-op if already gone)
ALTER WAREHOUSE BENCH_INT_WH DROP TABLES (OPENROUTESERVICE_APP.BENCH_MATRIX.BENCH_MATRIX_INTERACTIVE);

-- Drop the warehouses
DROP WAREHOUSE IF EXISTS BENCH_INT_WH;
DROP WAREHOUSE IF EXISTS BENCH_STD_WH;

-- Drop the schema and all benchmark tables
DROP SCHEMA IF EXISTS OPENROUTESERVICE_APP.BENCH_MATRIX CASCADE;

-- Sanity check
SHOW SCHEMAS LIKE 'BENCH_MATRIX' IN DATABASE OPENROUTESERVICE_APP;
SHOW WAREHOUSES LIKE 'BENCH_%';
