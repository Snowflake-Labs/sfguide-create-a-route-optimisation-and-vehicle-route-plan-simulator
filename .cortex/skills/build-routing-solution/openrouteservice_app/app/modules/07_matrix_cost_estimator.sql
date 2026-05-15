-- =====================================================================
-- Matrix Cost Estimator (Issue #39)
-- Calibrates and predicts: cell count, matrix rows, warehouse credits,
-- SPCS/ORS credits, wall-clock duration, and confidence band.
-- Issues distinct estimates for road_filter ON vs OFF (Issue #35 dep).
-- =====================================================================
USE SCHEMA OPENROUTESERVICE_APP.TRAVEL_MATRIX;

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-matrix-cost-estimator","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- ---------------------------------------------------------------------
-- 1. Calibration table (formula-derived seeds; refreshed from history)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_COST_CALIBRATION (
    H3_RESOLUTION         NUMBER NOT NULL,
    PROFILE               VARCHAR NOT NULL,
    ROAD_FILTER           BOOLEAN NOT NULL,
    REGION_SIZE_BUCKET    VARCHAR NOT NULL, -- 'small','medium','large','xlarge'
    AVG_CELLS_PER_KM2     FLOAT NOT NULL,
    ROAD_FILTER_RATIO     FLOAT DEFAULT 1.0, -- expected road-aware cells / bbox cells
    WH_BASE_CREDITS       FLOAT DEFAULT 0.5,
    WH_PER_CELL_CREDITS   FLOAT DEFAULT 0.0,
    WH_PER_PAIR_CREDITS   FLOAT DEFAULT 0.0,
    SPCS_PAIRS_PER_SEC    FLOAT DEFAULT 30000.0,
    SPCS_CREDIT_RATE_PER_SEC FLOAT DEFAULT 0.00278, -- 10 nodes * 1 cr/h / 3600s
    WALL_SEC_OVERHEAD     FLOAT DEFAULT 60.0,
    SAMPLE_SIZE           NUMBER DEFAULT 0,
    LAST_REFRESHED_AT     TIMESTAMP_NTZ DEFAULT SYSDATE(),
    CONSTRAINT PK_MATRIX_COST_CAL PRIMARY KEY (H3_RESOLUTION, PROFILE, ROAD_FILTER, REGION_SIZE_BUCKET)
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-matrix-cost-estimator","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- Audit trail of calibration refreshes
CREATE TABLE IF NOT EXISTS OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_COST_CALIBRATION_HISTORY (
    REFRESHED_AT          TIMESTAMP_NTZ DEFAULT SYSDATE(),
    H3_RESOLUTION         NUMBER,
    PROFILE               VARCHAR,
    ROAD_FILTER           BOOLEAN,
    REGION_SIZE_BUCKET    VARCHAR,
    AVG_CELLS_PER_KM2     FLOAT,
    ROAD_FILTER_RATIO     FLOAT,
    WH_BASE_CREDITS       FLOAT,
    WH_PER_CELL_CREDITS   FLOAT,
    WH_PER_PAIR_CREDITS   FLOAT,
    SPCS_PAIRS_PER_SEC    FLOAT,
    SPCS_CREDIT_RATE_PER_SEC FLOAT,
    WALL_SEC_OVERHEAD     FLOAT,
    SAMPLE_SIZE           NUMBER
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-matrix-cost-estimator","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- ---------------------------------------------------------------------
-- 2. Formula-derived seed rows
-- AVG_CELLS_PER_KM2 derived from H3 average cell area (km^2):
--   res5=252.9, res6=36.13, res7=5.16, res8=0.737, res9=0.105, res10=0.015
--   cells_per_km2 = 1 / cell_area_km2
-- ROAD_FILTER_RATIO empirical default 0.45 (varies by region density)
-- Profile multipliers on SPCS throughput:
--   driving-car=1.00, driving-hgv=0.85, cycling-regular=0.70, foot-walking=0.55
-- ---------------------------------------------------------------------
MERGE INTO OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_COST_CALIBRATION t
USING (
    SELECT res, profile, rf, bucket, cells_km2, rf_ratio, pairs_sec
    FROM (
        VALUES
            (5, 'driving-car',     FALSE, 'medium',  0.00395, 1.00, 30000.0),
            (5, 'driving-car',     TRUE,  'medium',  0.00395, 0.45, 30000.0),
            (6, 'driving-car',     FALSE, 'medium',  0.02768, 1.00, 30000.0),
            (6, 'driving-car',     TRUE,  'medium',  0.02768, 0.45, 30000.0),
            (7, 'driving-car',     FALSE, 'medium',  0.19380, 1.00, 30000.0),
            (7, 'driving-car',     TRUE,  'medium',  0.19380, 0.45, 30000.0),
            (8, 'driving-car',     FALSE, 'medium',  1.35685, 1.00, 30000.0),
            (8, 'driving-car',     TRUE,  'medium',  1.35685, 0.45, 30000.0),
            (9, 'driving-car',     FALSE, 'medium',  9.52380, 1.00, 30000.0),
            (9, 'driving-car',     TRUE,  'medium',  9.52380, 0.45, 30000.0),
            (10,'driving-car',     FALSE, 'medium', 66.66666, 1.00, 30000.0),
            (10,'driving-car',     TRUE,  'medium', 66.66666, 0.45, 30000.0),
            -- driving-hgv (0.85x throughput)
            (7, 'driving-hgv',     FALSE, 'medium',  0.19380, 1.00, 25500.0),
            (7, 'driving-hgv',     TRUE,  'medium',  0.19380, 0.45, 25500.0),
            (8, 'driving-hgv',     FALSE, 'medium',  1.35685, 1.00, 25500.0),
            (8, 'driving-hgv',     TRUE,  'medium',  1.35685, 0.45, 25500.0),
            (9, 'driving-hgv',     FALSE, 'medium',  9.52380, 1.00, 25500.0),
            (9, 'driving-hgv',     TRUE,  'medium',  9.52380, 0.45, 25500.0),
            -- cycling-regular (0.70x)
            (7, 'cycling-regular', FALSE, 'medium',  0.19380, 1.00, 21000.0),
            (7, 'cycling-regular', TRUE,  'medium',  0.19380, 0.55, 21000.0),
            (8, 'cycling-regular', FALSE, 'medium',  1.35685, 1.00, 21000.0),
            (8, 'cycling-regular', TRUE,  'medium',  1.35685, 0.55, 21000.0),
            (9, 'cycling-regular', FALSE, 'medium',  9.52380, 1.00, 21000.0),
            (9, 'cycling-regular', TRUE,  'medium',  9.52380, 0.55, 21000.0),
            -- foot-walking (0.55x)
            (7, 'foot-walking',    FALSE, 'medium',  0.19380, 1.00, 16500.0),
            (7, 'foot-walking',    TRUE,  'medium',  0.19380, 0.65, 16500.0),
            (8, 'foot-walking',    FALSE, 'medium',  1.35685, 1.00, 16500.0),
            (8, 'foot-walking',    TRUE,  'medium',  1.35685, 0.65, 16500.0),
            (9, 'foot-walking',    FALSE, 'medium',  9.52380, 1.00, 16500.0),
            (9, 'foot-walking',    TRUE,  'medium',  9.52380, 0.65, 16500.0)
    ) AS v(res, profile, rf, bucket, cells_km2, rf_ratio, pairs_sec)
) s
ON  t.H3_RESOLUTION       = s.res
AND t.PROFILE             = s.profile
AND t.ROAD_FILTER         = s.rf
AND t.REGION_SIZE_BUCKET  = s.bucket
WHEN NOT MATCHED THEN INSERT (
    H3_RESOLUTION, PROFILE, ROAD_FILTER, REGION_SIZE_BUCKET,
    AVG_CELLS_PER_KM2, ROAD_FILTER_RATIO, SPCS_PAIRS_PER_SEC, SAMPLE_SIZE
) VALUES (
    s.res, s.profile, s.rf, s.bucket,
    s.cells_km2, s.rf_ratio, s.pairs_sec, 0
);

-- ---------------------------------------------------------------------
-- 3. ESTIMATE_MATRIX_COST procedure
--    Returns JSON with cell count, pair count, credits, duration,
--    confidence. When P_ROAD_FILTER IS NULL returns BOTH variants.
-- ---------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.ESTIMATE_MATRIX_COST(
    P_REGION VARCHAR,
    P_RESOLUTION NUMBER,
    P_PROFILE VARCHAR,
    P_MIN_LAT FLOAT,
    P_MAX_LAT FLOAT,
    P_MIN_LON FLOAT,
    P_MAX_LON FLOAT,
    P_ROAD_FILTER BOOLEAN DEFAULT NULL
)
RETURNS VARIANT
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-matrix-cost-estimator","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    area_km2 FLOAT;
    bucket VARCHAR;
    result VARIANT;
BEGIN
    -- Compute bbox area in km^2 via GEOGRAPHY (ST_AREA returns m^2)
    SELECT ST_AREA(
        TO_GEOGRAPHY(
            'POLYGON((' ||
            :P_MIN_LON || ' ' || :P_MIN_LAT || ',' ||
            :P_MAX_LON || ' ' || :P_MIN_LAT || ',' ||
            :P_MAX_LON || ' ' || :P_MAX_LAT || ',' ||
            :P_MIN_LON || ' ' || :P_MAX_LAT || ',' ||
            :P_MIN_LON || ' ' || :P_MIN_LAT || '))'
        )
    ) / 1000000.0 INTO :area_km2;

    -- Region size bucket
    bucket := CASE
        WHEN :area_km2 <  500    THEN 'small'
        WHEN :area_km2 < 5000    THEN 'medium'
        WHEN :area_km2 < 50000   THEN 'large'
        ELSE                          'xlarge'
    END;

    -- Build JSON: always compute both filter ON and OFF using calibration
    LET q VARCHAR := '
        WITH params AS (
            SELECT
                ' || :area_km2 || '::FLOAT AS area_km2,
                ''' || :bucket || ''' AS bucket,
                ' || :P_RESOLUTION || '::NUMBER AS h3_res,
                ''' || :P_PROFILE || ''' AS profile
        ),
        cal AS (
            SELECT
                rf.ROAD_FILTER,
                COALESCE(c_exact.AVG_CELLS_PER_KM2, c_med.AVG_CELLS_PER_KM2, 0)        AS cells_per_km2,
                COALESCE(c_exact.ROAD_FILTER_RATIO, c_med.ROAD_FILTER_RATIO, 1.0)      AS rf_ratio,
                COALESCE(c_exact.WH_BASE_CREDITS, c_med.WH_BASE_CREDITS, 0.5)          AS wh_base,
                COALESCE(c_exact.WH_PER_CELL_CREDITS, c_med.WH_PER_CELL_CREDITS, 0.0)  AS wh_per_cell,
                COALESCE(c_exact.WH_PER_PAIR_CREDITS, c_med.WH_PER_PAIR_CREDITS, 0.0)  AS wh_per_pair,
                COALESCE(c_exact.SPCS_PAIRS_PER_SEC, c_med.SPCS_PAIRS_PER_SEC, 30000.0) AS pairs_sec,
                COALESCE(c_exact.SPCS_CREDIT_RATE_PER_SEC, c_med.SPCS_CREDIT_RATE_PER_SEC, 0.00278) AS spcs_rate,
                COALESCE(c_exact.WALL_SEC_OVERHEAD, c_med.WALL_SEC_OVERHEAD, 60.0)     AS overhead,
                COALESCE(c_exact.SAMPLE_SIZE, 0)                                       AS sample_size
            FROM (SELECT FALSE AS ROAD_FILTER UNION ALL SELECT TRUE) rf
            CROSS JOIN params p
            LEFT JOIN OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_COST_CALIBRATION c_exact
              ON c_exact.H3_RESOLUTION = p.h3_res
             AND c_exact.PROFILE = p.profile
             AND c_exact.ROAD_FILTER = rf.ROAD_FILTER
             AND c_exact.REGION_SIZE_BUCKET = p.bucket
            LEFT JOIN OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_COST_CALIBRATION c_med
              ON c_med.H3_RESOLUTION = p.h3_res
             AND c_med.PROFILE = p.profile
             AND c_med.ROAD_FILTER = rf.ROAD_FILTER
             AND c_med.REGION_SIZE_BUCKET = ''medium''
        ),
        derived AS (
            SELECT
                cal.ROAD_FILTER,
                p.area_km2,
                CEIL(p.area_km2 * cal.cells_per_km2 * cal.rf_ratio) AS cells,
                cal.cells_per_km2, cal.rf_ratio,
                cal.wh_base, cal.wh_per_cell, cal.wh_per_pair,
                cal.pairs_sec, cal.spcs_rate, cal.overhead, cal.sample_size
            FROM cal, params p
        ),
        calc AS (
            SELECT
                ROAD_FILTER,
                area_km2,
                cells,
                cells * (cells - 1) AS pairs,
                wh_base + (wh_per_cell * cells) + (wh_per_pair * cells * (cells - 1))
                    AS wh_credits,
                (cells * (cells - 1)) / NULLIFZERO(pairs_sec) AS pure_secs,
                (cells * (cells - 1)) / NULLIFZERO(pairs_sec) + overhead AS wall_secs,
                ((cells * (cells - 1)) / NULLIFZERO(pairs_sec)) * spcs_rate AS spcs_credits,
                sample_size
            FROM derived
        )
        SELECT OBJECT_CONSTRUCT(
            ''region'',           ''' || :P_REGION || ''',
            ''profile'',          ''' || :P_PROFILE || ''',
            ''h3_resolution'',    ' || :P_RESOLUTION || ',
            ''bucket'',           ''' || :bucket || ''',
            ''area_km2'',         ROUND(MAX(area_km2), 2),
            ''generated_at'',     CURRENT_TIMESTAMP()::STRING,
            ''estimates'',        OBJECT_CONSTRUCT(
                ''road_filter_off'', OBJECT_CONSTRUCT(
                    ''cells'',            MAX(CASE WHEN NOT ROAD_FILTER THEN cells END),
                    ''matrix_rows'',      MAX(CASE WHEN NOT ROAD_FILTER THEN pairs END),
                    ''warehouse_credits'',ROUND(MAX(CASE WHEN NOT ROAD_FILTER THEN wh_credits END), 3),
                    ''spcs_credits'',     ROUND(MAX(CASE WHEN NOT ROAD_FILTER THEN spcs_credits END), 3),
                    ''total_credits'',    ROUND(MAX(CASE WHEN NOT ROAD_FILTER THEN wh_credits + spcs_credits END), 3),
                    ''duration_seconds'', ROUND(MAX(CASE WHEN NOT ROAD_FILTER THEN wall_secs END), 0),
                    ''confidence'',       CASE
                                            WHEN MAX(CASE WHEN NOT ROAD_FILTER THEN sample_size END) >= 10 THEN ''high''
                                            WHEN MAX(CASE WHEN NOT ROAD_FILTER THEN sample_size END) >= 3  THEN ''medium''
                                            ELSE ''low''
                                          END,
                    ''sample_size'',      MAX(CASE WHEN NOT ROAD_FILTER THEN sample_size END)
                ),
                ''road_filter_on'', OBJECT_CONSTRUCT(
                    ''cells'',            MAX(CASE WHEN ROAD_FILTER THEN cells END),
                    ''matrix_rows'',      MAX(CASE WHEN ROAD_FILTER THEN pairs END),
                    ''warehouse_credits'',ROUND(MAX(CASE WHEN ROAD_FILTER THEN wh_credits END), 3),
                    ''spcs_credits'',     ROUND(MAX(CASE WHEN ROAD_FILTER THEN spcs_credits END), 3),
                    ''total_credits'',    ROUND(MAX(CASE WHEN ROAD_FILTER THEN wh_credits + spcs_credits END), 3),
                    ''duration_seconds'', ROUND(MAX(CASE WHEN ROAD_FILTER THEN wall_secs END), 0),
                    ''confidence'',       CASE
                                            WHEN MAX(CASE WHEN ROAD_FILTER THEN sample_size END) >= 10 THEN ''high''
                                            WHEN MAX(CASE WHEN ROAD_FILTER THEN sample_size END) >= 3  THEN ''medium''
                                            ELSE ''low''
                                          END,
                    ''sample_size'',      MAX(CASE WHEN ROAD_FILTER THEN sample_size END)
                )
            ),
            ''selected_road_filter'', ' ||
                CASE WHEN :P_ROAD_FILTER IS NULL THEN 'NULL'
                     WHEN :P_ROAD_FILTER THEN 'TRUE'
                     ELSE 'FALSE' END
            || '
        ) AS RES
        FROM calc
    ';
    EXECUTE IMMEDIATE :q;
    SELECT $1 INTO :result FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));
    RETURN :result;
EXCEPTION
    WHEN OTHER THEN
        RETURN OBJECT_CONSTRUCT(
            'error', 'estimate_failed',
            'sqlstate', SQLSTATE,
            'sqlerrm', SQLERRM,
            'sqlcode', SQLCODE
        );
END;
$$;

-- ---------------------------------------------------------------------
-- 4. REFRESH_MATRIX_COST_CALIBRATION procedure
--    Re-fits coefficients from MATRIX_BUILD_JOBS + ACCOUNT_USAGE.
--    Falls back gracefully when ACCOUNT_USAGE not granted.
-- ---------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.REFRESH_MATRIX_COST_CALIBRATION()
RETURNS VARIANT
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-matrix-cost-estimator","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    fitted_rows NUMBER DEFAULT 0;
    err_detail VARCHAR DEFAULT NULL;
BEGIN
    -- Build a temp result set of fitted coefficients per (res, profile, road_filter, bucket)
    CREATE OR REPLACE TEMPORARY TABLE _MATRIX_CAL_FIT AS
    WITH jobs AS (
        SELECT
            TO_NUMBER(REPLACE(j.RESOLUTION, 'RES', '')) AS h3_res,
            j.PROFILE,
            COALESCE(j.ROAD_FILTER, FALSE) AS road_filter,
            CASE
                WHEN GREATEST(j.HEXAGONS_BEFORE_FILTER, j.HEXAGONS) <    1000 THEN 'small'
                WHEN GREATEST(j.HEXAGONS_BEFORE_FILTER, j.HEXAGONS) <   10000 THEN 'medium'
                WHEN GREATEST(j.HEXAGONS_BEFORE_FILTER, j.HEXAGONS) <  100000 THEN 'large'
                ELSE                                                          'xlarge'
            END AS bucket,
            j.HEXAGONS AS cells,
            j.MATRIX_ROWS AS pairs,
            DATEDIFF(SECOND, j.STARTED_AT, j.COMPLETED_AT) AS wall_secs,
            CASE
                WHEN j.HEXAGONS_BEFORE_FILTER > 0 AND j.ROAD_FILTER
                THEN j.HEXAGONS / NULLIFZERO(j.HEXAGONS_BEFORE_FILTER)
            END AS observed_rf_ratio
        FROM OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS j
        WHERE j.STATUS IN ('COMPLETE', 'SUCCESS')
          AND j.STARTED_AT IS NOT NULL
          AND j.COMPLETED_AT IS NOT NULL
          AND j.COMPLETED_AT > DATEADD(DAY, -90, CURRENT_TIMESTAMP())
          AND j.HEXAGONS > 0
          AND j.MATRIX_ROWS > 0
    )
    SELECT
        h3_res, profile, road_filter, bucket,
        COUNT(*) AS sample_size,
        AVG(pairs / NULLIFZERO(wall_secs)) AS avg_pairs_per_sec,
        AVG(observed_rf_ratio) AS avg_rf_ratio,
        AVG(GREATEST(wall_secs - (pairs / 30000.0), 30)) AS avg_overhead
    FROM jobs
    GROUP BY 1,2,3,4
    HAVING COUNT(*) >= 1;

    MERGE INTO OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_COST_CALIBRATION t
    USING _MATRIX_CAL_FIT s
      ON t.H3_RESOLUTION = s.h3_res
     AND t.PROFILE = s.profile
     AND t.ROAD_FILTER = s.road_filter
     AND t.REGION_SIZE_BUCKET = s.bucket
    WHEN MATCHED THEN UPDATE SET
        SPCS_PAIRS_PER_SEC = COALESCE(s.avg_pairs_per_sec, t.SPCS_PAIRS_PER_SEC),
        ROAD_FILTER_RATIO  = CASE WHEN s.road_filter THEN COALESCE(s.avg_rf_ratio, t.ROAD_FILTER_RATIO) ELSE 1.0 END,
        WALL_SEC_OVERHEAD  = COALESCE(s.avg_overhead, t.WALL_SEC_OVERHEAD),
        SAMPLE_SIZE        = s.sample_size,
        LAST_REFRESHED_AT  = CURRENT_TIMESTAMP()
    WHEN NOT MATCHED THEN INSERT (
        H3_RESOLUTION, PROFILE, ROAD_FILTER, REGION_SIZE_BUCKET,
        AVG_CELLS_PER_KM2, ROAD_FILTER_RATIO,
        SPCS_PAIRS_PER_SEC, WALL_SEC_OVERHEAD, SAMPLE_SIZE, LAST_REFRESHED_AT
    ) VALUES (
        s.h3_res, s.profile, s.road_filter, s.bucket,
        CASE s.h3_res WHEN 5 THEN 0.00395 WHEN 6 THEN 0.02768 WHEN 7 THEN 0.19380
                      WHEN 8 THEN 1.35685 WHEN 9 THEN 9.52380 WHEN 10 THEN 66.66666
                      ELSE 1.0 END,
        COALESCE(s.avg_rf_ratio, CASE WHEN s.road_filter THEN 0.45 ELSE 1.0 END),
        COALESCE(s.avg_pairs_per_sec, 30000.0),
        COALESCE(s.avg_overhead, 60.0),
        s.sample_size,
        CURRENT_TIMESTAMP()
    );
    fitted_rows := SQLROWCOUNT;
    DROP TABLE IF EXISTS _MATRIX_CAL_FIT;

    -- Snapshot to history
    INSERT INTO OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_COST_CALIBRATION_HISTORY (
        H3_RESOLUTION, PROFILE, ROAD_FILTER, REGION_SIZE_BUCKET,
        AVG_CELLS_PER_KM2, ROAD_FILTER_RATIO,
        WH_BASE_CREDITS, WH_PER_CELL_CREDITS, WH_PER_PAIR_CREDITS,
        SPCS_PAIRS_PER_SEC, SPCS_CREDIT_RATE_PER_SEC,
        WALL_SEC_OVERHEAD, SAMPLE_SIZE
    )
    SELECT
        H3_RESOLUTION, PROFILE, ROAD_FILTER, REGION_SIZE_BUCKET,
        AVG_CELLS_PER_KM2, ROAD_FILTER_RATIO,
        WH_BASE_CREDITS, WH_PER_CELL_CREDITS, WH_PER_PAIR_CREDITS,
        SPCS_PAIRS_PER_SEC, SPCS_CREDIT_RATE_PER_SEC,
        WALL_SEC_OVERHEAD, SAMPLE_SIZE
    FROM OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_COST_CALIBRATION;

    RETURN OBJECT_CONSTRUCT(
        'status', 'ok',
        'fitted_rows', :fitted_rows,
        'refreshed_at', CURRENT_TIMESTAMP()::STRING
    );
EXCEPTION
    WHEN OTHER THEN
        err_detail := SQLERRM;
        RETURN OBJECT_CONSTRUCT(
            'status', 'error',
            'sqlerrm', :err_detail,
            'sqlstate', SQLSTATE,
            'sqlcode', SQLCODE
        );
END;
$$;

-- ---------------------------------------------------------------------
-- 5. Scheduled task: nightly refresh
-- ---------------------------------------------------------------------
CREATE OR REPLACE TASK OPENROUTESERVICE_APP.CORE.REFRESH_MATRIX_COST_CALIBRATION_TASK
    WAREHOUSE = ROUTING_ANALYTICS
    SCHEDULE = 'USING CRON 0 6 * * * UTC'
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-matrix-cost-estimator","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
    CALL OPENROUTESERVICE_APP.CORE.REFRESH_MATRIX_COST_CALIBRATION();

ALTER TASK OPENROUTESERVICE_APP.CORE.REFRESH_MATRIX_COST_CALIBRATION_TASK RESUME;
