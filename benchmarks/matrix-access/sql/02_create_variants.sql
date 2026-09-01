-- 02_create_variants.sql
-- Create the four table variants from the source travel-time matrix.
-- Source: BENCHMARK.TRAVEL_MATRIX.GERMANY_DRIVING_HGV_MATRIX_RES7
-- Target schema: BENCHMARK.BENCH_MATRIX
-- Builds run on the LARGE build warehouse (3.2B-row scale).

USE WAREHOUSE BENCH_BUILD_WH;
USE SCHEMA BENCHMARK.BENCH_MATRIX;
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-matrix-access-benchmark","version":{"major":1,"minor":0},"attributes":{"is_quickstart":0,"source":"sql"}}';

-- A. Standard table
CREATE OR REPLACE TABLE BENCH_MATRIX_STD AS
SELECT ORIGIN_H3, DEST_H3, TRAVEL_TIME_SECONDS, TRAVEL_DISTANCE_METERS, CALCULATED_AT
FROM BENCHMARK.TRAVEL_MATRIX.GERMANY_DRIVING_HGV_MATRIX_RES7;
ALTER TABLE BENCH_MATRIX_STD SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-matrix-access-benchmark","version":{"major":1,"minor":0},"attributes":{"is_quickstart":0,"source":"sql","variant":"A_standard"}}';

-- C. Clustered standard table on (ORIGIN_H3) - sorted by ORIGIN_H3 at load
CREATE OR REPLACE TABLE BENCH_MATRIX_CLUSTERED CLUSTER BY (ORIGIN_H3) AS
SELECT ORIGIN_H3, DEST_H3, TRAVEL_TIME_SECONDS, TRAVEL_DISTANCE_METERS, CALCULATED_AT
FROM BENCHMARK.TRAVEL_MATRIX.GERMANY_DRIVING_HGV_MATRIX_RES7
ORDER BY ORIGIN_H3;
ALTER TABLE BENCH_MATRIX_CLUSTERED SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-matrix-access-benchmark","version":{"major":1,"minor":0},"attributes":{"is_quickstart":0,"source":"sql","variant":"C_clustered"}}';

-- D. Hybrid (Unistore) table with PK and secondary index
-- NOTE: at 3.2B rows this INSERT is the slowest/riskiest step and may hit Unistore limits.
CREATE OR REPLACE HYBRID TABLE BENCH_MATRIX_HYBRID (
  ORIGIN_H3              VARCHAR     NOT NULL,
  DEST_H3                VARCHAR     NOT NULL,
  TRAVEL_TIME_SECONDS    FLOAT,
  TRAVEL_DISTANCE_METERS FLOAT,
  CALCULATED_AT          TIMESTAMP_NTZ,
  PRIMARY KEY (ORIGIN_H3, DEST_H3),
  INDEX idx_origin (ORIGIN_H3)
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-matrix-access-benchmark","version":{"major":1,"minor":0},"attributes":{"is_quickstart":0,"source":"sql","variant":"D_hybrid"}}';

INSERT INTO BENCH_MATRIX_HYBRID (ORIGIN_H3, DEST_H3, TRAVEL_TIME_SECONDS, TRAVEL_DISTANCE_METERS, CALCULATED_AT)
SELECT ORIGIN_H3, DEST_H3, TRAVEL_TIME_SECONDS, TRAVEL_DISTANCE_METERS, CALCULATED_AT
FROM BENCHMARK.TRAVEL_MATRIX.GERMANY_DRIVING_HGV_MATRIX_RES7;

-- E. Interactive Table (Gen2) clustered by (ORIGIN_H3). Built with a standard warehouse.
CREATE OR REPLACE INTERACTIVE TABLE BENCH_MATRIX_INTERACTIVE
CLUSTER BY (ORIGIN_H3) AS
SELECT ORIGIN_H3, DEST_H3, TRAVEL_TIME_SECONDS, TRAVEL_DISTANCE_METERS, CALCULATED_AT
FROM BENCHMARK.TRAVEL_MATRIX.GERMANY_DRIVING_HGV_MATRIX_RES7;
ALTER TABLE BENCH_MATRIX_INTERACTIVE SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-matrix-access-benchmark","version":{"major":1,"minor":0},"attributes":{"is_quickstart":0,"source":"sql","variant":"E_interactive"}}';

-- Attach interactive table to the interactive warehouse so the data cache warms.
ALTER WAREHOUSE BENCH_INT_WH ADD TABLES (BENCHMARK.BENCH_MATRIX.BENCH_MATRIX_INTERACTIVE);
ALTER WAREHOUSE BENCH_INT_WH RESUME IF SUSPENDED;
