-- 00_probe_source.sql
-- Quick probe of source matrix size and key distribution.
-- Source: OPENROUTESERVICE_APP.TRAVEL_MATRIX.GERMANY_DRIVING_HGV_MATRIX_RES6

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-matrix-access-benchmark","version":{"major":1,"minor":0},"attributes":{"is_quickstart":0,"source":"sql"}}';

-- 1. Row count, distinct origins, distinct dests, avg dests per origin
SELECT
  COUNT(*)                                                           AS row_count,
  COUNT(DISTINCT ORIGIN_H3)                                          AS distinct_origins,
  COUNT(DISTINCT DEST_H3)                                            AS distinct_dests,
  ROUND(COUNT(*)/NULLIF(COUNT(DISTINCT ORIGIN_H3),0),1)              AS avg_dests_per_origin
FROM OPENROUTESERVICE_APP.TRAVEL_MATRIX.GERMANY_DRIVING_HGV_MATRIX_RES6;

-- 2. Compressed size on disk
SELECT TABLE_NAME, ROW_COUNT, BYTES, ROUND(BYTES/POWER(1024,3),2) AS GB
FROM OPENROUTESERVICE_APP.INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA='TRAVEL_MATRIX' AND TABLE_NAME='GERMANY_DRIVING_HGV_MATRIX_RES6';

-- Probe results captured 2026-05-13 (account WGB26798, region AWS_US_WEST_2):
--   row_count            = 121,386,546
--   distinct_origins     = 9,669
--   distinct_dests       = 12,555
--   avg_dests_per_origin = ~12,554
--   bytes                = 759,633,408 (~0.71 GB compressed)
-- Comfortably fits in XSMALL interactive-warehouse cache (350 GB).
