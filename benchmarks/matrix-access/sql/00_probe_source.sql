-- 00_probe_source.sql
-- Quick probe of source matrix size and key distribution.
-- Source: BENCHMARK.TRAVEL_MATRIX.GERMANY_DRIVING_HGV_MATRIX_RES7 (largest table in the benchmarks db)

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-matrix-access-benchmark","version":{"major":1,"minor":0},"attributes":{"is_quickstart":0,"source":"sql"}}';

-- 1. Row count, distinct origins, distinct dests, avg dests per origin
SELECT
  COUNT(*)                                                           AS row_count,
  COUNT(DISTINCT ORIGIN_H3)                                          AS distinct_origins,
  COUNT(DISTINCT DEST_H3)                                            AS distinct_dests,
  ROUND(COUNT(*)/NULLIF(COUNT(DISTINCT ORIGIN_H3),0),1)              AS avg_dests_per_origin
FROM BENCHMARK.TRAVEL_MATRIX.GERMANY_DRIVING_HGV_MATRIX_RES7;

-- 2. Compressed size on disk
SELECT TABLE_NAME, ROW_COUNT, BYTES, ROUND(BYTES/POWER(1024,3),2) AS GB
FROM BENCHMARK.INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA='TRAVEL_MATRIX' AND TABLE_NAME='GERMANY_DRIVING_HGV_MATRIX_RES7';

-- Source baseline (account WGB26798, region AWS_US_WEST_2):
--   row_count = 3,203,910,336
--   bytes     = 33,877,136,896 (~31.55 GB compressed)
-- Comfortably fits in XSMALL interactive-warehouse cache (<350 GB).
-- distinct_origins / distinct_dests / avg_dests_per_origin captured at run time.
