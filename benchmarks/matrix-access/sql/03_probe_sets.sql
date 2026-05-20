-- 03_probe_sets.sql
-- Build fixed probe-set tables so every variant runs identical workloads.
-- W1 = 1000 random (ORIGIN_H3, DEST_H3) pairs from the source matrix
-- W2 = 200 random distinct ORIGIN_H3 values

USE WAREHOUSE BENCH_STD_WH;
USE SCHEMA OPENROUTESERVICE_APP.BENCH_MATRIX;
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-matrix-access-benchmark","version":{"major":1,"minor":0},"attributes":{"is_quickstart":0,"source":"sql"}}';

CREATE OR REPLACE TABLE BENCH_PROBES_W1 (probe_id INTEGER, ORIGIN_H3 VARCHAR, DEST_H3 VARCHAR)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-matrix-access-benchmark","version":{"major":1,"minor":0},"attributes":{"variant":"probes_w1"}}';

INSERT INTO BENCH_PROBES_W1
SELECT ROW_NUMBER() OVER (ORDER BY 1) AS probe_id, ORIGIN_H3, DEST_H3
FROM OPENROUTESERVICE_APP.TRAVEL_MATRIX.GERMANY_DRIVING_HGV_MATRIX_RES6
SAMPLE (1000 ROWS);

CREATE OR REPLACE TABLE BENCH_PROBES_W2 (probe_id INTEGER, ORIGIN_H3 VARCHAR)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-matrix-access-benchmark","version":{"major":1,"minor":0},"attributes":{"variant":"probes_w2"}}';

INSERT INTO BENCH_PROBES_W2
SELECT ROW_NUMBER() OVER (ORDER BY 1) AS probe_id, ORIGIN_H3
FROM (SELECT DISTINCT ORIGIN_H3 FROM OPENROUTESERVICE_APP.TRAVEL_MATRIX.GERMANY_DRIVING_HGV_MATRIX_RES6) s
SAMPLE (200 ROWS);

SELECT (SELECT COUNT(*) FROM BENCH_PROBES_W1) AS w1_rows,
       (SELECT COUNT(*) FROM BENCH_PROBES_W2) AS w2_rows;
