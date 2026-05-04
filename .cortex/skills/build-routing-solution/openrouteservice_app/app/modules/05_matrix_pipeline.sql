USE SCHEMA OPENROUTESERVICE_APP.CORE;   

CREATE TABLE IF NOT EXISTS OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS (
    JOB_ID VARCHAR NOT NULL,
    REGION VARCHAR NOT NULL,
    PROFILE VARCHAR NOT NULL,
    RESOLUTION VARCHAR NOT NULL,
    STATUS VARCHAR DEFAULT 'PENDING',
    STAGE VARCHAR DEFAULT 'NOT_STARTED',
    HEXAGONS NUMBER DEFAULT 0,
    WORK_QUEUE_ROWS NUMBER DEFAULT 0,
    RAW_ROWS NUMBER DEFAULT 0,
    MATRIX_ROWS NUMBER DEFAULT 0,
    PCT_COMPLETE FLOAT DEFAULT 0,
    MESSAGE VARCHAR,
    ERROR_MSG VARCHAR,
    STATEMENT_HANDLE VARCHAR,
    CREATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    STARTED_AT TIMESTAMP_NTZ,
    COMPLETED_AT TIMESTAMP_NTZ
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"matrix"}}';

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.ENSURE_MATRIX_TABLES(P_REGION VARCHAR, P_PROFILE VARCHAR, P_RES VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"matrix"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    safe_profile VARCHAR;
    list_table VARCHAR;
    wq_table VARCHAR;
    raw_table VARCHAR;
    matrix_table VARCHAR;
BEGIN
    safe_profile := REPLACE(UPPER(P_PROFILE), '-', '_');

    list_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_LIST_' || P_RES;
    wq_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_WORK_QUEUE_' || P_RES;
    raw_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_MATRIX_RAW_' || P_RES;
    matrix_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_MATRIX_' || P_RES;

    EXECUTE IMMEDIATE 'CREATE TABLE IF NOT EXISTS ' || list_table || ' (H3_INDEX VARCHAR, CENTER_POINT GEOGRAPHY) COMMENT = ''{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"matrix"}}''';

    EXECUTE IMMEDIATE 'CREATE TABLE IF NOT EXISTS ' || wq_table || ' (SEQ_ID INTEGER, ORIGIN_H3 VARCHAR, ORIGIN_POINT GEOGRAPHY, DEST_COORDS ARRAY, DEST_HEX_IDS ARRAY) COMMENT = ''{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"matrix"}}''';

    EXECUTE IMMEDIATE 'CREATE TABLE IF NOT EXISTS ' || raw_table || ' (SEQ_ID INTEGER, ORIGIN_H3 VARCHAR, DEST_HEX_IDS ARRAY, MATRIX_RESULT VARIANT) COMMENT = ''{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"matrix"}}''';

    EXECUTE IMMEDIATE 'CREATE TABLE IF NOT EXISTS ' || matrix_table || ' (ORIGIN_H3 VARCHAR, DEST_H3 VARCHAR, TRAVEL_TIME_SECONDS FLOAT, TRAVEL_DISTANCE_METERS FLOAT, CALCULATED_AT TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP()) COMMENT = ''{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"matrix"}}''';
    RETURN 'Tables ensured: ' || list_table || ', ' || wq_table || ', ' || raw_table || ', ' || matrix_table;
END;
$$;

-- =============================================================================
-- TRAVEL TIME MATRIX: Pipeline procedures
-- =============================================================================

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.BUILD_HEXAGONS(P_RES VARCHAR, P_MIN_LAT FLOAT, P_MAX_LAT FLOAT, P_MIN_LON FLOAT, P_MAX_LON FLOAT, P_REGION VARCHAR, P_PROFILE VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"matrix"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    resolution INTEGER;
    hex_table VARCHAR;
    safe_profile VARCHAR;
    row_count INTEGER;
    rs RESULTSET;
BEGIN
    safe_profile := REPLACE(UPPER(P_PROFILE), '-', '_');
    hex_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_LIST_' || P_RES;

    IF (P_RES = 'RES5') THEN
        resolution := 5;
    ELSEIF (P_RES = 'RES6') THEN
        resolution := 6;
    ELSEIF (P_RES = 'RES7') THEN
        resolution := 7;
    ELSEIF (P_RES = 'RES8') THEN
        resolution := 8;
    ELSEIF (P_RES = 'RES9') THEN
        resolution := 9;
    ELSE
        resolution := 10;
    END IF;

    EXECUTE IMMEDIATE 'TRUNCATE TABLE ' || hex_table;

    EXECUTE IMMEDIATE '
    INSERT INTO ' || hex_table || ' (H3_INDEX, CENTER_POINT)
    SELECT
        h.VALUE::VARCHAR AS h3_index,
        H3_CELL_TO_POINT(h.VALUE::VARCHAR) AS center_point
    FROM TABLE(FLATTEN(
        H3_POLYGON_TO_CELLS_STRINGS(
            TO_GEOGRAPHY(''POLYGON((' ||
                P_MIN_LON || ' ' || P_MIN_LAT || ',' ||
                P_MAX_LON || ' ' || P_MIN_LAT || ',' ||
                P_MAX_LON || ' ' || P_MAX_LAT || ',' ||
                P_MIN_LON || ' ' || P_MAX_LAT || ',' ||
                P_MIN_LON || ' ' || P_MIN_LAT || '))''),
            ' || resolution || '
        )
    )) h';

    rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || hex_table);
    LET c CURSOR FOR rs;
    FOR row_val IN c DO
        row_count := row_val.CNT;
    END FOR;

    RETURN P_RES || ' hexagons built: ' || row_count || ' hexagons';
END;
$$;

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.BUILD_WORK_QUEUE(P_RES VARCHAR, P_REGION VARCHAR, P_PROFILE VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"matrix"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    hex_table VARCHAR;
    queue_table VARCHAR;
    safe_profile VARCHAR;
    row_count INTEGER;
    rs RESULTSET;
BEGIN
    safe_profile := REPLACE(UPPER(P_PROFILE), '-', '_');
    hex_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_LIST_' || P_RES;
    queue_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_WORK_QUEUE_' || P_RES;

    EXECUTE IMMEDIATE 'TRUNCATE TABLE ' || queue_table;

    EXECUTE IMMEDIATE '
    INSERT INTO ' || queue_table || ' (SEQ_ID, ORIGIN_H3, ORIGIN_POINT, DEST_COORDS, DEST_HEX_IDS)
    WITH numbered_pairs AS (
        SELECT
            a.H3_INDEX AS origin_h3,
            a.CENTER_POINT AS origin_point,
            b.H3_INDEX AS dest_h3,
            b.CENTER_POINT AS dest_point,
            ROW_NUMBER() OVER (PARTITION BY a.H3_INDEX ORDER BY b.H3_INDEX) AS dest_seq
        FROM ' || hex_table || ' a
        CROSS JOIN ' || hex_table || ' b
        WHERE a.H3_INDEX != b.H3_INDEX
    ),
    chunked AS (
        SELECT
            origin_h3, ANY_VALUE(origin_point) AS origin_point,
            FLOOR((dest_seq - 1) / 1000) AS chunk_idx,
            ARRAY_AGG(ARRAY_CONSTRUCT(ST_X(dest_point), ST_Y(dest_point))) AS dest_coords,
            ARRAY_AGG(dest_h3) AS dest_hex_ids
        FROM numbered_pairs
        GROUP BY origin_h3, chunk_idx
    )
    SELECT
        ROW_NUMBER() OVER (ORDER BY origin_h3, chunk_idx) AS seq_id,
        origin_h3, origin_point,
        dest_coords, dest_hex_ids
    FROM chunked';

    rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || queue_table);
    LET c CURSOR FOR rs;
    FOR row_val IN c DO
        row_count := row_val.CNT;
    END FOR;

    RETURN P_RES || ' work queue built: ' || row_count || ' origins ready';
END;
$$;

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.BUILD_TRAVEL_TIME_RANGE(P_RES VARCHAR, P_START_SEQ INTEGER, P_END_SEQ INTEGER, P_REGION VARCHAR, P_PROFILE VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"matrix"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    batch_size INTEGER;
    current_pos INTEGER;
    batch_end INTEGER;
    batch_num INTEGER DEFAULT 0;
    failed_batches INTEGER DEFAULT 0;
    batch_failed BOOLEAN DEFAULT FALSE;
    queue_table VARCHAR;
    raw_table VARCHAR;
    safe_profile VARCHAR;
    insert_sql VARCHAR;
    resume_sql VARCHAR;
    max_done INTEGER DEFAULT 0;
    rs RESULTSET;
    retry_count INTEGER DEFAULT 0;
    max_retries INTEGER DEFAULT 5;
    retry_wait INTEGER DEFAULT 10;
BEGIN
    safe_profile := REPLACE(UPPER(P_PROFILE), '-', '_');
    queue_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_WORK_QUEUE_' || P_RES;
    raw_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_MATRIX_RAW_' || P_RES;

    batch_size := 100;

    resume_sql := 'SELECT COALESCE(MAX(SEQ_ID), ' || (P_START_SEQ - 1) ||
                  ') AS MAX_DONE FROM ' || raw_table ||
                  ' WHERE SEQ_ID BETWEEN ' || P_START_SEQ || ' AND ' || P_END_SEQ;
    rs := (EXECUTE IMMEDIATE :resume_sql);
    LET c CURSOR FOR rs;
    FOR row_val IN c DO
        max_done := row_val.MAX_DONE;
    END FOR;

    current_pos := max_done + 1;

    WHILE (current_pos <= P_END_SEQ) DO
        batch_num := batch_num + 1;
        batch_end := LEAST(current_pos + batch_size - 1, P_END_SEQ);
        retry_count := 0;
        retry_wait := 10;
        batch_failed := FALSE;

        insert_sql := '
        INSERT INTO ' || raw_table || '
        SELECT
            q.SEQ_ID,
            q.ORIGIN_H3,
            q.DEST_HEX_IDS,
            OPENROUTESERVICE_APP.CORE.MATRIX_TABULAR(
                ''' || P_PROFILE || ''',
                ARRAY_CONSTRUCT(ST_X(q.ORIGIN_POINT), ST_Y(q.ORIGIN_POINT)),
                q.DEST_COORDS
            )
        FROM ' || queue_table || ' q
        WHERE q.SEQ_ID BETWEEN ' || current_pos || ' AND ' || batch_end;

        WHILE (retry_count <= max_retries) DO
            BEGIN
                EXECUTE IMMEDIATE :insert_sql;
                retry_count := max_retries + 1;
            EXCEPTION
                WHEN OTHER THEN
                    retry_count := retry_count + 1;
                    IF (retry_count > max_retries) THEN
                        failed_batches := failed_batches + 1;
                        batch_failed := TRUE;
                        retry_count := max_retries + 1;
                    ELSE
                        BEGIN
                            ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.routing_gateway_service RESUME;
                        EXCEPTION WHEN OTHER THEN NULL;
                        END;
                        BEGIN
                            EXECUTE IMMEDIATE 'ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ORS_SERVICE_' || UPPER(P_REGION) || ' RESUME';
                        EXCEPTION WHEN OTHER THEN
                            BEGIN ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ors_service RESUME; EXCEPTION WHEN OTHER THEN NULL; END;
                        END;
                        EXECUTE IMMEDIATE 'SELECT SYSTEM$WAIT(' || retry_wait || ')';
                        retry_wait := retry_wait * 2;
                    END IF;
            END;
        END WHILE;

        current_pos := batch_end + 1;
    END WHILE;

    RETURN P_RES || ' range [' || P_START_SEQ || '-' || P_END_SEQ ||
           '] complete: ' || batch_num || ' batches of ' || batch_size ||
           ' (resumed from seq ' || max_done || ', failed_batches=' || failed_batches || ')';
END;
$$;

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.BUILD_TRAVEL_TIME_RANGE_REGION(P_RES VARCHAR, P_START_SEQ INTEGER, P_END_SEQ INTEGER, P_MATRIX_FN VARCHAR, P_REGION VARCHAR, P_PROFILE VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"matrix"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    batch_size INTEGER;
    current_pos INTEGER;
    batch_end INTEGER;
    batch_num INTEGER DEFAULT 0;
    failed_batches INTEGER DEFAULT 0;
    batch_failed BOOLEAN DEFAULT FALSE;
    queue_table VARCHAR;
    raw_table VARCHAR;
    safe_profile VARCHAR;
    matrix_call VARCHAR;
    insert_sql VARCHAR;
    resume_sql VARCHAR;
    max_done INTEGER DEFAULT 0;
    rs RESULTSET;
    retry_count INTEGER DEFAULT 0;
    max_retries INTEGER DEFAULT 5;
    retry_wait INTEGER DEFAULT 10;
BEGIN
    safe_profile := REPLACE(UPPER(P_PROFILE), '-', '_');
    queue_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_WORK_QUEUE_' || P_RES;
    raw_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_MATRIX_RAW_' || P_RES;

    LET is_default BOOLEAN DEFAULT TRUE;
    IF (P_REGION IS NOT NULL AND UPPER(P_REGION) != 'DEFAULT') THEN
        BEGIN
            LET svc_rs RESULTSET := (EXECUTE IMMEDIATE
                'SHOW SERVICES LIKE ''ORS_SERVICE_' || UPPER(P_REGION) || ''' IN SCHEMA OPENROUTESERVICE_APP.CORE');
            LET svc_c CURSOR FOR svc_rs;
            FOR r IN svc_c DO
                is_default := FALSE;
            END FOR;
        EXCEPTION WHEN OTHER THEN NULL;
        END;
    END IF;

    IF (NOT is_default) THEN
        matrix_call := P_MATRIX_FN || '(''' || P_REGION || ''', ''' || P_PROFILE || ''', ARRAY_CONSTRUCT(ST_X(q.ORIGIN_POINT), ST_Y(q.ORIGIN_POINT)), q.DEST_COORDS)';
    ELSE
        matrix_call := P_MATRIX_FN || '(''' || P_PROFILE || ''', ARRAY_CONSTRUCT(ST_X(q.ORIGIN_POINT), ST_Y(q.ORIGIN_POINT)), q.DEST_COORDS)';
    END IF;

    batch_size := 100;

    resume_sql := 'SELECT COALESCE(MAX(SEQ_ID), ' || (P_START_SEQ - 1) ||
                  ') AS MAX_DONE FROM ' || raw_table ||
                  ' WHERE SEQ_ID BETWEEN ' || P_START_SEQ || ' AND ' || P_END_SEQ;
    rs := (EXECUTE IMMEDIATE :resume_sql);
    LET c CURSOR FOR rs;
    FOR row_val IN c DO
        max_done := row_val.MAX_DONE;
    END FOR;

    current_pos := max_done + 1;

    WHILE (current_pos <= P_END_SEQ) DO
        batch_num := batch_num + 1;
        batch_end := LEAST(current_pos + batch_size - 1, P_END_SEQ);
        retry_count := 0;
        retry_wait := 10;
        batch_failed := FALSE;

        insert_sql := '
        INSERT INTO ' || raw_table || '
        SELECT
            q.SEQ_ID,
            q.ORIGIN_H3,
            q.DEST_HEX_IDS,
            ' || matrix_call || '
        FROM ' || queue_table || ' q
        WHERE q.SEQ_ID BETWEEN ' || current_pos || ' AND ' || batch_end;

        WHILE (retry_count <= max_retries) DO
            BEGIN
                EXECUTE IMMEDIATE :insert_sql;
                retry_count := max_retries + 1;
            EXCEPTION
                WHEN OTHER THEN
                    retry_count := retry_count + 1;
                    IF (retry_count > max_retries) THEN
                        failed_batches := failed_batches + 1;
                        batch_failed := TRUE;
                        retry_count := max_retries + 1;
                    ELSE
                        EXECUTE IMMEDIATE 'SELECT SYSTEM$WAIT(' || retry_wait || ')';
                        retry_wait := retry_wait * 2;
                    END IF;
            END;
        END WHILE;

        current_pos := batch_end + 1;
    END WHILE;

    LET error_retry_sql VARCHAR;
    LET error_origin_count INTEGER DEFAULT 0;
    LET retry_pass INTEGER DEFAULT 0;
    LET max_error_retries INTEGER DEFAULT 3;

    WHILE (retry_pass < max_error_retries) DO
        error_retry_sql := 'SELECT COUNT(*) AS CNT FROM ' || raw_table ||
            ' WHERE SEQ_ID BETWEEN ' || P_START_SEQ || ' AND ' || P_END_SEQ ||
            ' AND MATRIX_RESULT:durations IS NULL';
        rs := (EXECUTE IMMEDIATE :error_retry_sql);
        LET ec CURSOR FOR rs;
        FOR r IN ec DO error_origin_count := r.CNT; END FOR;

        IF (error_origin_count = 0) THEN
            retry_pass := max_error_retries;
        ELSE
            retry_pass := retry_pass + 1;
            EXECUTE IMMEDIATE 'SELECT SYSTEM$WAIT(30)';

            EXECUTE IMMEDIATE 'DELETE FROM ' || raw_table ||
            ' WHERE SEQ_ID BETWEEN ' || P_START_SEQ || ' AND ' || P_END_SEQ ||
            ' AND MATRIX_RESULT:durations IS NULL';

            LET retry_min INTEGER;
            LET retry_max INTEGER;
            rs := (EXECUTE IMMEDIATE '
                SELECT MIN(q.SEQ_ID) AS MN, MAX(q.SEQ_ID) AS MX FROM ' || queue_table || ' q
                WHERE q.SEQ_ID BETWEEN ' || P_START_SEQ || ' AND ' || P_END_SEQ ||
                ' AND q.SEQ_ID NOT IN (SELECT SEQ_ID FROM ' || raw_table ||
                ' WHERE SEQ_ID BETWEEN ' || P_START_SEQ || ' AND ' || P_END_SEQ || ')');
            LET mc CURSOR FOR rs;
            FOR r IN mc DO retry_min := r.MN; retry_max := r.MX; END FOR;

            IF (retry_min IS NOT NULL) THEN
                LET rpos INTEGER := retry_min;
                WHILE (rpos <= retry_max) DO
                    LET rend INTEGER := LEAST(rpos + batch_size - 1, retry_max);
                    BEGIN
                        EXECUTE IMMEDIATE '
                        INSERT INTO ' || raw_table || '
                        SELECT q.SEQ_ID, q.ORIGIN_H3, q.DEST_HEX_IDS, ' || matrix_call || '
                        FROM ' || queue_table || ' q
                        WHERE q.SEQ_ID BETWEEN ' || rpos || ' AND ' || rend ||
                        ' AND q.SEQ_ID NOT IN (SELECT SEQ_ID FROM ' || raw_table ||
                        ' WHERE SEQ_ID BETWEEN ' || rpos || ' AND ' || rend || ')';
                    EXCEPTION WHEN OTHER THEN NULL;
                    END;
                    rpos := rend + 1;
                END WHILE;
            END IF;
        END IF;
    END WHILE;

    RETURN P_RES || ' range [' || P_START_SEQ || '-' || P_END_SEQ ||
           '] complete: ' || batch_num || ' batches of ' || batch_size ||
           ' (resumed from seq ' || max_done || ', fn=' || P_MATRIX_FN || ', failed_batches=' || failed_batches || ')';
END;
$$;

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.FLATTEN_MATRIX_RAW(P_RES VARCHAR, P_REGION VARCHAR, P_PROFILE VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"matrix"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    raw_table VARCHAR;
    target_table VARCHAR;
    safe_profile VARCHAR;
    row_count INTEGER;
    rs RESULTSET;
BEGIN
    safe_profile := REPLACE(UPPER(P_PROFILE), '-', '_');
    raw_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_MATRIX_RAW_' || P_RES;
    target_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_MATRIX_' || P_RES;

    EXECUTE IMMEDIATE '
    CREATE OR REPLACE TABLE ' || target_table || '
    CLUSTER BY (ORIGIN_H3)
    COMMENT = ''{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"matrix"}}''
    AS
    SELECT
        r.ORIGIN_H3,
        r.DEST_HEX_IDS[f.INDEX]::VARCHAR AS DEST_H3,
        r.MATRIX_RESULT:durations[0][f.INDEX]::FLOAT AS TRAVEL_TIME_SECONDS,
        r.MATRIX_RESULT:distances[0][f.INDEX]::FLOAT AS TRAVEL_DISTANCE_METERS,
        CURRENT_TIMESTAMP() AS CALCULATED_AT
    FROM ' || raw_table || ' r,
        LATERAL FLATTEN(input => r.MATRIX_RESULT:durations[0]) f
    WHERE r.MATRIX_RESULT:durations IS NOT NULL
      AND r.MATRIX_RESULT:durations[0][f.INDEX] IS NOT NULL';

    rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || target_table);
    LET c CURSOR FOR rs;
    FOR row_val IN c DO
        row_count := row_val.CNT;
    END FOR;

    RETURN P_RES || ' flatten complete (' || P_REGION || '/' || P_PROFILE || '): ' || row_count || ' travel time pairs';
END;
$$;

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.BUILD_MATRIX_FOR_REGION(P_RES VARCHAR, P_MIN_LAT FLOAT, P_MAX_LAT FLOAT, P_MIN_LON FLOAT, P_MAX_LON FLOAT, P_MATRIX_FN VARCHAR, P_REGION VARCHAR, P_PROFILE VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"matrix"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    hex_count INTEGER;
    queue_count INTEGER;
    travel_count INTEGER;
    hex_table VARCHAR;
    queue_table VARCHAR;
    travel_table VARCHAR;
    safe_profile VARCHAR;
    count_sql VARCHAR;
    rs RESULTSET;
    parallel_count INTEGER DEFAULT 4;
    chunk_size INTEGER;
    chunk_start INTEGER;
    chunk_end INTEGER;
BEGIN
    safe_profile := REPLACE(UPPER(P_PROFILE), '-', '_');
    hex_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_LIST_' || P_RES;
    queue_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_WORK_QUEUE_' || P_RES;
    travel_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_MATRIX_' || P_RES;

    CALL OPENROUTESERVICE_APP.CORE.ENSURE_MATRIX_TABLES(:P_REGION, :P_PROFILE, :P_RES);

    BEGIN
        ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.routing_gateway_service RESUME;
    EXCEPTION WHEN OTHER THEN NULL;
    END;
    BEGIN
        EXECUTE IMMEDIATE 'ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ORS_SERVICE_' || UPPER(P_REGION) || ' RESUME';
    EXCEPTION WHEN OTHER THEN
        BEGIN
            ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ors_service RESUME;
        EXCEPTION WHEN OTHER THEN NULL;
        END;
    END;
    EXECUTE IMMEDIATE 'SELECT SYSTEM$WAIT(5)';

    CALL OPENROUTESERVICE_APP.CORE.BUILD_HEXAGONS(:P_RES, :P_MIN_LAT, :P_MAX_LAT, :P_MIN_LON, :P_MAX_LON, :P_REGION, :P_PROFILE);

    count_sql := 'SELECT COUNT(*) AS CNT FROM ' || hex_table;
    rs := (EXECUTE IMMEDIATE :count_sql);
    LET c2 CURSOR FOR rs;
    FOR r IN c2 DO hex_count := r.CNT; END FOR;

    CALL OPENROUTESERVICE_APP.CORE.BUILD_WORK_QUEUE(:P_RES, :P_REGION, :P_PROFILE);

    count_sql := 'SELECT COUNT(*) AS CNT FROM ' || queue_table;
    rs := (EXECUTE IMMEDIATE :count_sql);
    LET c4 CURSOR FOR rs;
    FOR r IN c4 DO queue_count := r.CNT; END FOR;

    LET is_default_r BOOLEAN DEFAULT TRUE;
    IF (UPPER(P_REGION) != 'DEFAULT') THEN
        BEGIN
            LET svc_rsr RESULTSET := (EXECUTE IMMEDIATE
                'SHOW SERVICES LIKE ''ORS_SERVICE_' || UPPER(P_REGION) || ''' IN SCHEMA OPENROUTESERVICE_APP.CORE');
            LET svc_cr CURSOR FOR svc_rsr;
            FOR r IN svc_cr DO
                is_default_r := FALSE;
            END FOR;
        EXCEPTION WHEN OTHER THEN NULL;
        END;
    END IF;
    LET svc_inst INTEGER := 3;
    IF (NOT is_default_r) THEN
        BEGIN
            SHOW SERVICES LIKE 'ORS_SERVICE_%' IN SCHEMA OPENROUTESERVICE_APP.CORE;
            LET sir RESULTSET := (
                SELECT "min_instances"::INTEGER AS MI
                FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
                WHERE "name" = 'ORS_SERVICE_' || UPPER(P_REGION)
                LIMIT 1
            );
            LET sic CURSOR FOR sir;
            FOR r IN sic DO svc_inst := r.MI; END FOR;
        EXCEPTION WHEN OTHER THEN svc_inst := 1;
        END;
    END IF;
    parallel_count := LEAST(GREATEST(svc_inst * 2, 2), 4);

    chunk_size := GREATEST(CEIL(queue_count / parallel_count), 1);
    chunk_start := 1;

    WHILE (chunk_start <= queue_count) DO
        chunk_end := LEAST(chunk_start + chunk_size - 1, queue_count);
        ASYNC (CALL OPENROUTESERVICE_APP.CORE.BUILD_TRAVEL_TIME_RANGE_REGION(:P_RES, :chunk_start, :chunk_end, :P_MATRIX_FN, :P_REGION, :P_PROFILE));
        chunk_start := chunk_end + 1;
    END WHILE;
    AWAIT ALL;

    EXECUTE IMMEDIATE 'CALL OPENROUTESERVICE_APP.CORE.FLATTEN_MATRIX_RAW(''' || P_RES || ''', ''' || P_REGION || ''', ''' || P_PROFILE || ''')';

    count_sql := 'SELECT COUNT(*) AS CNT FROM ' || travel_table;
    rs := (EXECUTE IMMEDIATE :count_sql);
    LET c5 CURSOR FOR rs;
    FOR r IN c5 DO travel_count := r.CNT; END FOR;

    RETURN P_RES || ' complete (' || P_MATRIX_FN || ', ' || P_PROFILE || '): ' || hex_count || ' hexagons, ' ||
           queue_count || ' origins, ' || travel_count || ' travel times (' || parallel_count || ' parallel workers)';
END;
$$;

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.MATRIX_PROGRESS(P_REGION VARCHAR, P_PROFILE VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"matrix"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    result VARCHAR;
    rs RESULTSET;
BEGIN
    rs := (
        SELECT COALESCE(OBJECT_AGG(
            RESOLUTION,
            OBJECT_CONSTRUCT(
                'stage', CASE STATUS WHEN 'COMPLETE' THEN 'COMPLETE' WHEN 'ERROR' THEN 'ERROR' ELSE STAGE END,
                'hexagons', HEXAGONS,
                'work_queue', WORK_QUEUE_ROWS,
                'raw_ingested', RAW_ROWS,
                'flattened', MATRIX_ROWS,
                'pct', PCT_COMPLETE,
                'status', STATUS,
                'error', COALESCE(ERROR_MSG, '')
            )
        ), OBJECT_CONSTRUCT())::VARCHAR AS OBJ
        FROM OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
        WHERE UPPER(REGION) = UPPER(:P_REGION)
          AND UPPER(REPLACE(PROFILE, '-', '_')) = UPPER(REPLACE(:P_PROFILE, '-', '_'))
          AND STATUS IN ('RUNNING', 'COMPLETE', 'ERROR')
          AND CREATED_AT > DATEADD('day', -30, CURRENT_TIMESTAMP())
    );
    LET c CURSOR FOR rs;
    FOR row_val IN c DO result := row_val.OBJ; END FOR;
    RETURN COALESCE(result, '{}');
END;
$$;

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.RESET_MATRIX_DATA(P_REGION VARCHAR, P_PROFILE VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"matrix"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    safe_profile VARCHAR;
    prefix VARCHAR;
    res_num INTEGER;
    res_label VARCHAR;
BEGIN
    safe_profile := REPLACE(UPPER(P_PROFILE), '-', '_');
    prefix := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile;

    FOR res_num IN 5 TO 10 DO
        res_label := 'RES' || res_num::VARCHAR;
        BEGIN EXECUTE IMMEDIATE 'DROP TABLE IF EXISTS ' || prefix || '_LIST_' || res_label; EXCEPTION WHEN OTHER THEN NULL; END;
        BEGIN EXECUTE IMMEDIATE 'DROP TABLE IF EXISTS ' || prefix || '_WORK_QUEUE_' || res_label; EXCEPTION WHEN OTHER THEN NULL; END;
        BEGIN EXECUTE IMMEDIATE 'DROP TABLE IF EXISTS ' || prefix || '_MATRIX_RAW_' || res_label; EXCEPTION WHEN OTHER THEN NULL; END;
        BEGIN EXECUTE IMMEDIATE 'DROP TABLE IF EXISTS ' || prefix || '_MATRIX_' || res_label; EXCEPTION WHEN OTHER THEN NULL; END;
    END FOR;

    DELETE FROM OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
    WHERE UPPER(REGION) = UPPER(:P_REGION)
      AND UPPER(REPLACE(PROFILE, '-', '_')) = :safe_profile;

    RETURN 'Matrix tables dropped for ' || P_REGION || '/' || P_PROFILE;
END;
$$;

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.BUILD_MATRIX_JOB_WRAPPER(P_JOB_ID VARCHAR, P_RES VARCHAR, P_MIN_LAT FLOAT, P_MAX_LAT FLOAT, P_MIN_LON FLOAT, P_MAX_LON FLOAT, P_MATRIX_FN VARCHAR, P_REGION VARCHAR, P_PROFILE VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"matrix"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    safe_profile VARCHAR;
    prefix VARCHAR;
    hex_count INTEGER DEFAULT 0;
    queue_count INTEGER DEFAULT 0;
    raw_count INTEGER DEFAULT 0;
    matrix_count INTEGER DEFAULT 0;
    valid_count INTEGER DEFAULT 0;
    error_count INTEGER DEFAULT 0;
    sample_error VARCHAR DEFAULT '';
    rs RESULTSET;
    wait_attempt INTEGER DEFAULT 0;
    max_wait_attempts INTEGER DEFAULT 20;
    profile_ready BOOLEAN DEFAULT FALSE;
    status_json VARIANT;
BEGIN
    safe_profile := REPLACE(UPPER(P_PROFILE), '-', '_');
    prefix := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile;

    UPDATE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
    SET STATUS = 'ERROR',
        ERROR_MSG = 'Stale job: still RUNNING after 2+ hours, marked as zombie',
        COMPLETED_AT = CURRENT_TIMESTAMP()
    WHERE STATUS = 'RUNNING'
      AND STARTED_AT < DATEADD('HOUR', -2, CURRENT_TIMESTAMP())
      AND JOB_ID != :P_JOB_ID;

    UPDATE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
    SET STATUS='RUNNING', STAGE='HEXAGONS', STARTED_AT=CURRENT_TIMESTAMP()
    WHERE JOB_ID = :P_JOB_ID;

    CALL OPENROUTESERVICE_APP.CORE.ENSURE_MATRIX_TABLES(:P_REGION, :P_PROFILE, :P_RES);

    LET is_default BOOLEAN DEFAULT TRUE;
    IF (UPPER(P_REGION) != 'DEFAULT') THEN
        BEGIN
            LET svc_rs RESULTSET := (EXECUTE IMMEDIATE
                'SHOW SERVICES LIKE ''ORS_SERVICE_' || UPPER(P_REGION) || ''' IN SCHEMA OPENROUTESERVICE_APP.CORE');
            LET svc_c CURSOR FOR svc_rs;
            FOR r IN svc_c DO
                is_default := FALSE;
            END FOR;
        EXCEPTION WHEN OTHER THEN NULL;
        END;
    END IF;

    BEGIN
        ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.routing_gateway_service RESUME;
    EXCEPTION WHEN OTHER THEN NULL;
    END;
    BEGIN
        EXECUTE IMMEDIATE 'ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ORS_SERVICE_' || UPPER(P_REGION) || ' RESUME';
    EXCEPTION WHEN OTHER THEN
        BEGIN ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ors_service RESUME; EXCEPTION WHEN OTHER THEN NULL; END;
    END;

    EXECUTE IMMEDIATE 'UPDATE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS SET MESSAGE=''Waiting for ORS profile ' || P_PROFILE || ' to become ready...'' WHERE JOB_ID=''' || P_JOB_ID || '''';

    WHILE (wait_attempt < max_wait_attempts AND NOT profile_ready) DO
        EXECUTE IMMEDIATE 'SELECT SYSTEM$WAIT(15)';
        wait_attempt := wait_attempt + 1;
        BEGIN
            IF (is_default) THEN
                rs := (SELECT PARSE_JSON(TO_VARCHAR(OPENROUTESERVICE_APP.CORE.ORS_STATUS())) AS S);
            ELSE
                rs := (EXECUTE IMMEDIATE 'SELECT PARSE_JSON(TO_VARCHAR(OPENROUTESERVICE_APP.CORE.ORS_STATUS(''' || P_REGION || '''))) AS S');
            END IF;
            LET cs CURSOR FOR rs;
            FOR r IN cs DO
                status_json := r.S;
            END FOR;
            IF (status_json:profiles IS NOT NULL AND status_json:profiles[P_PROFILE] IS NOT NULL) THEN
                profile_ready := TRUE;
            END IF;
        EXCEPTION WHEN OTHER THEN NULL;
        END;
    END WHILE;

    LET wait_secs INTEGER := wait_attempt * 15;

    IF (NOT profile_ready) THEN
        EXECUTE IMMEDIATE 'UPDATE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS SET STATUS=''ERROR'', ERROR_MSG=''ORS profile ' || P_PROFILE || ' not ready after ' || wait_secs || ' seconds. Service may need more time to load graphs.'', COMPLETED_AT=CURRENT_TIMESTAMP() WHERE JOB_ID=''' || P_JOB_ID || '''';
        RETURN 'Job ' || :P_JOB_ID || ' failed: profile ' || :P_PROFILE || ' not ready';
    END IF;

    EXECUTE IMMEDIATE 'UPDATE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS SET MESSAGE=''ORS profile ' || P_PROFILE || ' ready after ' || wait_secs || 's'' WHERE JOB_ID=''' || P_JOB_ID || '''';

    CALL OPENROUTESERVICE_APP.CORE.BUILD_HEXAGONS(:P_RES, :P_MIN_LAT, :P_MAX_LAT, :P_MIN_LON, :P_MAX_LON, :P_REGION, :P_PROFILE);

    rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || prefix || '_LIST_' || P_RES);
    LET c1 CURSOR FOR rs; FOR r IN c1 DO hex_count := r.CNT; END FOR;
    UPDATE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
    SET STAGE='WORK_QUEUE', HEXAGONS=:hex_count
    WHERE JOB_ID = :P_JOB_ID;

    CALL OPENROUTESERVICE_APP.CORE.BUILD_WORK_QUEUE(:P_RES, :P_REGION, :P_PROFILE);

    rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || prefix || '_WORK_QUEUE_' || P_RES);
    LET c2 CURSOR FOR rs; FOR r IN c2 DO queue_count := r.CNT; END FOR;
    UPDATE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
    SET STAGE='BUILDING', WORK_QUEUE_ROWS=:queue_count
    WHERE JOB_ID = :P_JOB_ID;

    BEGIN
        ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.routing_gateway_service RESUME;
    EXCEPTION WHEN OTHER THEN NULL;
    END;
    BEGIN
        EXECUTE IMMEDIATE 'ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ORS_SERVICE_' || UPPER(P_REGION) || ' RESUME';
    EXCEPTION WHEN OTHER THEN
        BEGIN ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ors_service RESUME; EXCEPTION WHEN OTHER THEN NULL; END;
    END;

    BEGIN
        ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.routing_gateway_service SET AUTO_SUSPEND_SECS = 0;
    EXCEPTION WHEN OTHER THEN NULL;
    END;
    BEGIN
        EXECUTE IMMEDIATE 'ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ORS_SERVICE_' || UPPER(P_REGION) || ' SET AUTO_SUSPEND_SECS = 0';
    EXCEPTION WHEN OTHER THEN
        BEGIN ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ors_service SET AUTO_SUSPEND_SECS = 0; EXCEPTION WHEN OTHER THEN NULL; END;
    END;

    LET svc_instances INTEGER := 3;
    IF (NOT is_default) THEN
        BEGIN
            SHOW SERVICES LIKE 'ORS_SERVICE_%' IN SCHEMA OPENROUTESERVICE_APP.CORE;
            LET svc_rs2 RESULTSET := (
                SELECT "min_instances"::INTEGER AS MI
                FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
                WHERE "name" = 'ORS_SERVICE_' || UPPER(P_REGION)
                LIMIT 1
            );
            LET sc CURSOR FOR svc_rs2;
            FOR r IN sc DO svc_instances := r.MI; END FOR;
        EXCEPTION WHEN OTHER THEN svc_instances := 1;
        END;
    END IF;
    LET parallel_count INTEGER := LEAST(GREATEST(svc_instances * 2, 2), 4);
    LET chunk_size INTEGER := GREATEST(CEIL(queue_count / parallel_count), 1);
    LET chunk_start INTEGER := 1;
    LET chunk_end INTEGER;

    WHILE (chunk_start <= queue_count) DO
        chunk_end := LEAST(chunk_start + chunk_size - 1, queue_count);
        ASYNC (CALL OPENROUTESERVICE_APP.CORE.BUILD_TRAVEL_TIME_RANGE_REGION(:P_RES, :chunk_start, :chunk_end, :P_MATRIX_FN, :P_REGION, :P_PROFILE));
        chunk_start := chunk_end + 1;
    END WHILE;
    AWAIT ALL;

    LET sweep_pass INTEGER := 0;
    LET max_sweep INTEGER := 2;
    LET sweep_batch INTEGER := 25;
    LET sweep_missing INTEGER;
    LET sweep_queue VARCHAR := prefix || '_WORK_QUEUE_' || P_RES;
    LET sweep_raw VARCHAR := prefix || '_MATRIX_RAW_' || P_RES;

    WHILE (sweep_pass < max_sweep) DO
        EXECUTE IMMEDIATE 'DELETE FROM ' || sweep_raw ||
            ' WHERE MATRIX_RESULT:durations IS NULL';

        rs := (EXECUTE IMMEDIATE '
            SELECT COUNT(*) AS CNT FROM ' || sweep_queue || ' q
            WHERE q.SEQ_ID NOT IN (SELECT SEQ_ID FROM ' || sweep_raw || ')');
        LET sm_c CURSOR FOR rs;
        FOR r IN sm_c DO sweep_missing := r.CNT; END FOR;

        IF (sweep_missing = 0) THEN
            sweep_pass := max_sweep;
        ELSE
            sweep_pass := sweep_pass + 1;
            EXECUTE IMMEDIATE 'SELECT SYSTEM$WAIT(30)';

            LET sw_min INTEGER;
            LET sw_max INTEGER;
            rs := (EXECUTE IMMEDIATE '
                SELECT MIN(q.SEQ_ID) AS MN, MAX(q.SEQ_ID) AS MX FROM ' || sweep_queue || ' q
                WHERE q.SEQ_ID NOT IN (SELECT SEQ_ID FROM ' || sweep_raw || ')');
            LET sw_mc CURSOR FOR rs;
            FOR r IN sw_mc DO sw_min := r.MN; sw_max := r.MX; END FOR;

            IF (sw_min IS NOT NULL) THEN
                LET matrix_call_w VARCHAR;
                IF (NOT is_default) THEN
                    matrix_call_w := P_MATRIX_FN || '(''' || P_REGION || ''', ''' || P_PROFILE || ''', ARRAY_CONSTRUCT(ST_X(q.ORIGIN_POINT), ST_Y(q.ORIGIN_POINT)), q.DEST_COORDS)';
                ELSE
                    matrix_call_w := P_MATRIX_FN || '(''' || P_PROFILE || ''', ARRAY_CONSTRUCT(ST_X(q.ORIGIN_POINT), ST_Y(q.ORIGIN_POINT)), q.DEST_COORDS)';
                END IF;

                LET swpos INTEGER := sw_min;
                WHILE (swpos <= sw_max) DO
                    LET swend INTEGER := LEAST(swpos + sweep_batch - 1, sw_max);
                    BEGIN
                        EXECUTE IMMEDIATE '
                        INSERT INTO ' || sweep_raw || '
                        SELECT q.SEQ_ID, q.ORIGIN_H3, q.DEST_HEX_IDS, ' || matrix_call_w || '
                        FROM ' || sweep_queue || ' q
                        WHERE q.SEQ_ID BETWEEN ' || swpos || ' AND ' || swend ||
                        ' AND q.SEQ_ID NOT IN (SELECT SEQ_ID FROM ' || sweep_raw ||
                        ' WHERE SEQ_ID BETWEEN ' || swpos || ' AND ' || swend || ')';
                    EXCEPTION WHEN OTHER THEN NULL;
                    END;
                    swpos := swend + 1;
                END WHILE;
            END IF;
        END IF;
    END WHILE;

    rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || prefix || '_MATRIX_RAW_' || P_RES);
    LET c3 CURSOR FOR rs; FOR r IN c3 DO raw_count := r.CNT; END FOR;

    rs := (EXECUTE IMMEDIATE '
        SELECT
            COUNT(CASE WHEN MATRIX_RESULT:durations IS NOT NULL THEN 1 END) AS VALID_CNT,
            COUNT(CASE WHEN MATRIX_RESULT:durations IS NULL THEN 1 END) AS ERROR_CNT
        FROM ' || prefix || '_MATRIX_RAW_' || P_RES);
    LET c3b CURSOR FOR rs;
    FOR r IN c3b DO
        valid_count := r.VALID_CNT;
        error_count := r.ERROR_CNT;
    END FOR;

    IF (error_count > 0 AND valid_count = 0) THEN
        rs := (EXECUTE IMMEDIATE '
            SELECT COALESCE(
                MATRIX_RESULT:error:message::VARCHAR,
                MATRIX_RESULT:metadata:engine:build_date::VARCHAR,
                LEFT(MATRIX_RESULT::VARCHAR, 200)
            ) AS ERR FROM ' || prefix || '_MATRIX_RAW_' || P_RES || ' LIMIT 1');
        LET c3c CURSOR FOR rs;
        FOR r IN c3c DO sample_error := r.ERR; END FOR;
        UPDATE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
        SET STATUS='ERROR', STAGE='BUILDING',
            ERROR_MSG='ORS returned errors for all ' || :raw_count || ' origins. Sample: ' || :sample_error,
            RAW_ROWS=:raw_count, COMPLETED_AT=CURRENT_TIMESTAMP()
        WHERE JOB_ID = :P_JOB_ID;
        BEGIN
            ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.routing_gateway_service SET AUTO_SUSPEND_SECS = 14400;
        EXCEPTION WHEN OTHER THEN NULL;
        END;
        BEGIN
            EXECUTE IMMEDIATE 'ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ORS_SERVICE_' || UPPER(P_REGION) || ' SET AUTO_SUSPEND_SECS = 14400';
        EXCEPTION WHEN OTHER THEN
            BEGIN ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ors_service SET AUTO_SUSPEND_SECS = 14400; EXCEPTION WHEN OTHER THEN NULL; END;
        END;
        RETURN 'Job ' || :P_JOB_ID || ' failed: all ' || raw_count || ' ORS responses were errors';
    END IF;

    IF (error_count > 0) THEN
        UPDATE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
        SET ERROR_MSG='Warning: ' || :error_count || ' of ' || :raw_count || ' origins returned ORS errors'
        WHERE JOB_ID = :P_JOB_ID;
    END IF;

    UPDATE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
    SET STAGE='FLATTENING', RAW_ROWS=:raw_count, PCT_COMPLETE=100
    WHERE JOB_ID = :P_JOB_ID;

    EXECUTE IMMEDIATE 'CALL OPENROUTESERVICE_APP.CORE.FLATTEN_MATRIX_RAW(''' || P_RES || ''', ''' || P_REGION || ''', ''' || P_PROFILE || ''')';

    rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || prefix || '_MATRIX_' || P_RES);
    LET c4 CURSOR FOR rs; FOR r IN c4 DO matrix_count := r.CNT; END FOR;

    IF (matrix_count = 0 AND raw_count > 0) THEN
        UPDATE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
        SET STATUS='ERROR', STAGE='FLATTENING',
            ERROR_MSG='Flatten produced 0 pairs from ' || :raw_count || ' RAW rows (valid=' || :valid_count || ', errors=' || :error_count || ')',
            RAW_ROWS=:raw_count, COMPLETED_AT=CURRENT_TIMESTAMP()
        WHERE JOB_ID = :P_JOB_ID;
        BEGIN
            ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.routing_gateway_service SET AUTO_SUSPEND_SECS = 14400;
        EXCEPTION WHEN OTHER THEN NULL;
        END;
        BEGIN
            EXECUTE IMMEDIATE 'ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ORS_SERVICE_' || UPPER(P_REGION) || ' SET AUTO_SUSPEND_SECS = 14400';
        EXCEPTION WHEN OTHER THEN
            BEGIN ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ors_service SET AUTO_SUSPEND_SECS = 14400; EXCEPTION WHEN OTHER THEN NULL; END;
        END;
        RETURN 'Job ' || :P_JOB_ID || ' failed: 0 pairs after flatten';
    END IF;

    UPDATE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
    SET STATUS='COMPLETE', STAGE='COMPLETE', MATRIX_ROWS=:matrix_count,
        RAW_ROWS=:raw_count, PCT_COMPLETE=100, COMPLETED_AT=CURRENT_TIMESTAMP()
    WHERE JOB_ID = :P_JOB_ID;

    BEGIN EXECUTE IMMEDIATE 'DROP TABLE IF EXISTS ' || prefix || '_LIST_' || P_RES; EXCEPTION WHEN OTHER THEN NULL; END;
    BEGIN EXECUTE IMMEDIATE 'DROP TABLE IF EXISTS ' || prefix || '_WORK_QUEUE_' || P_RES; EXCEPTION WHEN OTHER THEN NULL; END;
    BEGIN EXECUTE IMMEDIATE 'DROP TABLE IF EXISTS ' || prefix || '_MATRIX_RAW_' || P_RES; EXCEPTION WHEN OTHER THEN NULL; END;

    BEGIN
        ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.routing_gateway_service SET AUTO_SUSPEND_SECS = 14400;
    EXCEPTION WHEN OTHER THEN NULL;
    END;
    BEGIN
        EXECUTE IMMEDIATE 'ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ORS_SERVICE_' || UPPER(P_REGION) || ' SET AUTO_SUSPEND_SECS = 14400';
    EXCEPTION WHEN OTHER THEN
        BEGIN ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ors_service SET AUTO_SUSPEND_SECS = 14400; EXCEPTION WHEN OTHER THEN NULL; END;
    END;

    RETURN 'Job ' || :P_JOB_ID || ' complete: ' || matrix_count || ' travel time pairs';
EXCEPTION
    WHEN OTHER THEN
        LET err_msg VARCHAR := SQLERRM;
        BEGIN
            ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.routing_gateway_service SET AUTO_SUSPEND_SECS = 14400;
        EXCEPTION WHEN OTHER THEN NULL;
        END;
        BEGIN
            EXECUTE IMMEDIATE 'ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ORS_SERVICE_' || UPPER(P_REGION) || ' SET AUTO_SUSPEND_SECS = 14400';
        EXCEPTION WHEN OTHER THEN
            BEGIN ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ors_service SET AUTO_SUSPEND_SECS = 14400; EXCEPTION WHEN OTHER THEN NULL; END;
        END;
        UPDATE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
        SET STATUS='ERROR', ERROR_MSG=:err_msg, COMPLETED_AT=CURRENT_TIMESTAMP()
        WHERE JOB_ID = :P_JOB_ID;
        RETURN 'Job ' || :P_JOB_ID || ' failed: ' || :err_msg;
END;
$$;
