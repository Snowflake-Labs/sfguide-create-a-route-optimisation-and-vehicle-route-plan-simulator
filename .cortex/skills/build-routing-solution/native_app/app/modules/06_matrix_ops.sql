CREATE OR REPLACE PROCEDURE core.GET_BUILD_STATUS()
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"matrix"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    result VARCHAR DEFAULT '[]';
    rs RESULTSET;
    live_count INTEGER;
    job_rs RESULTSET;
BEGIN
    job_rs := (
        SELECT JOB_ID, REGION, PROFILE, RESOLUTION, STATUS, STAGE
        FROM travel_matrix.MATRIX_BUILD_JOBS
        WHERE STATUS = 'RUNNING' AND STAGE = 'BUILDING'
    );
    LET jc CURSOR FOR job_rs;
    FOR j IN jc DO
        BEGIN
            LET raw_tbl VARCHAR := 'travel_matrix.' || UPPER(j.REGION) || '_' ||
                REPLACE(UPPER(j.PROFILE), '-', '_') || '_MATRIX_RAW_' || j.RESOLUTION;
            LET cnt_rs RESULTSET := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || raw_tbl);
            LET cc CURSOR FOR cnt_rs;
            FOR r IN cc DO live_count := r.CNT; END FOR;
            UPDATE travel_matrix.MATRIX_BUILD_JOBS
            SET RAW_ROWS = :live_count
            WHERE JOB_ID = j.JOB_ID;
        EXCEPTION WHEN OTHER THEN NULL;
        END;
    END FOR;

    rs := (
        SELECT COALESCE(ARRAY_AGG(OBJECT_CONSTRUCT(
            'job_id', JOB_ID,
            'region', REGION,
            'profile', PROFILE,
            'resolution', RESOLUTION,
            'status', STATUS,
            'stage', STAGE,
            'hexagons', HEXAGONS,
            'work_queue_rows', WORK_QUEUE_ROWS,
            'raw_rows', RAW_ROWS,
            'matrix_rows', MATRIX_ROWS,
            'pct_complete', PCT_COMPLETE,
            'error_msg', COALESCE(ERROR_MSG, ''),
            'created_at', COALESCE(TO_VARCHAR(CONVERT_TIMEZONE('UTC', CREATED_AT), 'YYYY-MM-DD"T"HH24:MI:SS') || 'Z', ''),
            'started_at', COALESCE(TO_VARCHAR(CONVERT_TIMEZONE('UTC', STARTED_AT), 'YYYY-MM-DD"T"HH24:MI:SS') || 'Z', ''),
            'completed_at', COALESCE(TO_VARCHAR(CONVERT_TIMEZONE('UTC', COMPLETED_AT), 'YYYY-MM-DD"T"HH24:MI:SS') || 'Z', ''),
            'statement_handle', COALESCE(STATEMENT_HANDLE, '')
        )), ARRAY_CONSTRUCT())::VARCHAR AS ARR
        FROM travel_matrix.MATRIX_BUILD_JOBS
        WHERE CREATED_AT > DATEADD('day', -30, CURRENT_TIMESTAMP())
        ORDER BY CREATED_AT DESC
    );
    LET c CURSOR FOR rs;
    FOR row_val IN c DO result := row_val.ARR; END FOR;
    RETURN COALESCE(result, '[]');
END;
$$;
GRANT USAGE ON PROCEDURE core.GET_BUILD_STATUS() TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.GET_MATRIX_INVENTORY()
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"matrix"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    result VARCHAR DEFAULT '[]';
    rs RESULTSET;
BEGIN
    rs := (
        SELECT COALESCE(ARRAY_AGG(OBJECT_CONSTRUCT(
            'table_name', t.TABLE_NAME,
            'row_count', t.ROW_COUNT,
            'created', COALESCE(TO_VARCHAR(CONVERT_TIMEZONE('UTC', t.CREATED), 'YYYY-MM-DD"T"HH24:MI:SS') || 'Z', ''),
            'bytes', t.BYTES,
            'execution_time_secs', COALESCE(DATEDIFF('SECOND', j.STARTED_AT, j.COMPLETED_AT), 0)
        )), ARRAY_CONSTRUCT())::VARCHAR AS ARR
        FROM INFORMATION_SCHEMA.TABLES t
        LEFT JOIN (
            SELECT REGION, PROFILE, RESOLUTION, STARTED_AT, COMPLETED_AT,
                   ROW_NUMBER() OVER (PARTITION BY REGION, PROFILE, RESOLUTION ORDER BY COMPLETED_AT DESC) AS RN
            FROM TRAVEL_MATRIX.MATRIX_BUILD_JOBS
            WHERE STATUS = 'COMPLETE'
        ) j
          ON j.RN = 1
          AND t.TABLE_NAME = UPPER(j.REGION) || '_' || REPLACE(UPPER(j.PROFILE), '-', '_') || '_MATRIX_' || j.RESOLUTION
        WHERE t.TABLE_SCHEMA = 'TRAVEL_MATRIX'
          AND t.TABLE_NAME LIKE '%\\_MATRIX\\_%' ESCAPE '\\'
          AND t.TABLE_NAME NOT LIKE '%\\_MATRIX\\_RAW\\_%' ESCAPE '\\'
          AND t.TABLE_NAME != 'MATRIX_BUILD_JOBS'
        ORDER BY t.TABLE_NAME
    );
    LET c CURSOR FOR rs;
    FOR row_val IN c DO result := row_val.ARR; END FOR;
    RETURN COALESCE(result, '[]');
END;
$$;
GRANT USAGE ON PROCEDURE core.GET_MATRIX_INVENTORY() TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.DELETE_MATRIX_CONFIG(P_REGION VARCHAR, P_PROFILE VARCHAR, P_RES VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"matrix"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    safe_profile VARCHAR;
    prefix VARCHAR;
BEGIN
    safe_profile := REPLACE(UPPER(P_PROFILE), '-', '_');
    prefix := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile;

    BEGIN EXECUTE IMMEDIATE 'DROP TABLE IF EXISTS ' || prefix || '_LIST_' || P_RES; EXCEPTION WHEN OTHER THEN NULL; END;
    BEGIN EXECUTE IMMEDIATE 'DROP TABLE IF EXISTS ' || prefix || '_WORK_QUEUE_' || P_RES; EXCEPTION WHEN OTHER THEN NULL; END;
    BEGIN EXECUTE IMMEDIATE 'DROP TABLE IF EXISTS ' || prefix || '_MATRIX_RAW_' || P_RES; EXCEPTION WHEN OTHER THEN NULL; END;
    BEGIN EXECUTE IMMEDIATE 'DROP TABLE IF EXISTS ' || prefix || '_MATRIX_' || P_RES; EXCEPTION WHEN OTHER THEN NULL; END;

    DELETE FROM travel_matrix.MATRIX_BUILD_JOBS
    WHERE UPPER(REGION) = UPPER(:P_REGION)
      AND UPPER(REPLACE(PROFILE, '-', '_')) = :safe_profile
      AND UPPER(RESOLUTION) = UPPER(:P_RES);

    RETURN 'Deleted: ' || P_REGION || '/' || P_PROFILE || '/' || P_RES;
END;
$$;
GRANT USAGE ON PROCEDURE core.DELETE_MATRIX_CONFIG(VARCHAR, VARCHAR, VARCHAR) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.CANCEL_MATRIX_BUILD(P_JOB_ID VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"matrix"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    handle VARCHAR;
    rs RESULTSET;
BEGIN
    rs := (SELECT STATEMENT_HANDLE FROM travel_matrix.MATRIX_BUILD_JOBS WHERE JOB_ID = :P_JOB_ID AND STATUS = 'RUNNING');
    LET c CURSOR FOR rs;
    FOR row_val IN c DO handle := row_val.STATEMENT_HANDLE; END FOR;

    UPDATE travel_matrix.MATRIX_BUILD_JOBS
    SET STATUS='CANCELLED', COMPLETED_AT=CURRENT_TIMESTAMP()
    WHERE JOB_ID = :P_JOB_ID;

    RETURN OBJECT_CONSTRUCT('cancelled', TRUE, 'job_id', :P_JOB_ID, 'statement_handle', handle)::VARCHAR;
END;
$$;
GRANT USAGE ON PROCEDURE core.CANCEL_MATRIX_BUILD(VARCHAR) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.RESTORE_MATRIX_DATA(P_REGION VARCHAR, P_PROFILE VARCHAR, P_RES VARCHAR, P_OFFSET_SECONDS INTEGER DEFAULT 300)
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"matrix"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    safe_profile VARCHAR;
    matrix_table VARCHAR;
    current_count INTEGER DEFAULT 0;
    restored_count INTEGER DEFAULT 0;
    rs RESULTSET;
BEGIN
    safe_profile := REPLACE(UPPER(P_PROFILE), '-', '_');
    matrix_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_MATRIX_' || P_RES;

    BEGIN
        rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || matrix_table);
        LET c1 CURSOR FOR rs; FOR r IN c1 DO current_count := r.CNT; END FOR;
    EXCEPTION WHEN OTHER THEN
        RETURN OBJECT_CONSTRUCT('status', 'error', 'message', 'Table does not exist: ' || matrix_table)::VARCHAR;
    END;

    IF (current_count > 0) THEN
        RETURN OBJECT_CONSTRUCT(
            'status', 'skipped',
            'message', 'Table already has data',
            'table', matrix_table,
            'current_rows', current_count
        )::VARCHAR;
    END IF;

    BEGIN
        EXECUTE IMMEDIATE '
        INSERT INTO ' || matrix_table || ' (ORIGIN_H3, DEST_H3, TRAVEL_TIME_SECONDS, TRAVEL_DISTANCE_METERS, CALCULATED_AT)
        SELECT ORIGIN_H3, DEST_H3, TRAVEL_TIME_SECONDS, TRAVEL_DISTANCE_METERS, CALCULATED_AT
        FROM ' || matrix_table || ' AT(OFFSET => -' || P_OFFSET_SECONDS || ')';
    EXCEPTION WHEN OTHER THEN
        RETURN OBJECT_CONSTRUCT(
            'status', 'error',
            'message', 'Time Travel restore failed: ' || SQLERRM,
            'table', matrix_table,
            'offset_seconds', P_OFFSET_SECONDS
        )::VARCHAR;
    END;

    rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || matrix_table);
    LET c2 CURSOR FOR rs; FOR r IN c2 DO restored_count := r.CNT; END FOR;

    RETURN OBJECT_CONSTRUCT(
        'status', 'restored',
        'table', matrix_table,
        'restored_rows', restored_count,
        'offset_seconds', P_OFFSET_SECONDS
    )::VARCHAR;
END;
$$;
GRANT USAGE ON PROCEDURE core.RESTORE_MATRIX_DATA(VARCHAR, VARCHAR, VARCHAR, INTEGER) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.GET_LIVE_TABLE_COUNT(P_REGION VARCHAR, P_PROFILE VARCHAR, P_RES VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"matrix"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    safe_profile VARCHAR;
    prefix VARCHAR;
    hex_cnt INTEGER DEFAULT 0;
    queue_cnt INTEGER DEFAULT 0;
    raw_cnt INTEGER DEFAULT 0;
    flat_cnt INTEGER DEFAULT 0;
    rs RESULTSET;
BEGIN
    safe_profile := REPLACE(UPPER(P_PROFILE), '-', '_');
    prefix := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile;

    BEGIN rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || prefix || '_LIST_' || P_RES);
    LET c1 CURSOR FOR rs; FOR r IN c1 DO hex_cnt := r.CNT; END FOR;
    EXCEPTION WHEN OTHER THEN hex_cnt := 0; END;

    BEGIN rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || prefix || '_WORK_QUEUE_' || P_RES);
    LET c2 CURSOR FOR rs; FOR r IN c2 DO queue_cnt := r.CNT; END FOR;
    EXCEPTION WHEN OTHER THEN queue_cnt := 0; END;

    BEGIN rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || prefix || '_MATRIX_RAW_' || P_RES);
    LET c3 CURSOR FOR rs; FOR r IN c3 DO raw_cnt := r.CNT; END FOR;
    EXCEPTION WHEN OTHER THEN raw_cnt := 0; END;

    BEGIN rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || prefix || '_MATRIX_' || P_RES);
    LET c4 CURSOR FOR rs; FOR r IN c4 DO flat_cnt := r.CNT; END FOR;
    EXCEPTION WHEN OTHER THEN flat_cnt := 0; END;

    RETURN OBJECT_CONSTRUCT(
        'hexagons', hex_cnt, 'work_queue', queue_cnt,
        'raw_ingested', raw_cnt, 'flattened', flat_cnt
    )::VARCHAR;
END;
$$;
GRANT USAGE ON PROCEDURE core.GET_LIVE_TABLE_COUNT(VARCHAR, VARCHAR, VARCHAR) TO APPLICATION ROLE app_user;
