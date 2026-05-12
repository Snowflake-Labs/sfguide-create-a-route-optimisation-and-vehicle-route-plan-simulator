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
    CREATED_AT TIMESTAMP_NTZ DEFAULT SYSDATE(),
    STARTED_AT TIMESTAMP_NTZ,
    COMPLETED_AT TIMESTAMP_NTZ
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"matrix"}}';

ALTER TABLE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
    ADD COLUMN IF NOT EXISTS ROAD_FILTER BOOLEAN DEFAULT FALSE;
ALTER TABLE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
    ADD COLUMN IF NOT EXISTS HEXAGONS_BEFORE_FILTER NUMBER DEFAULT 0;
ALTER TABLE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
    ADD COLUMN IF NOT EXISTS HEXAGONS_AFTER_FILTER NUMBER DEFAULT 0;
ALTER TABLE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
    ADD COLUMN IF NOT EXISTS FILTER_DURATION_SECONDS FLOAT DEFAULT 0;

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

    EXECUTE IMMEDIATE 'CREATE TABLE IF NOT EXISTS ' || matrix_table || ' (ORIGIN_H3 VARCHAR, DEST_H3 VARCHAR, TRAVEL_TIME_SECONDS FLOAT, TRAVEL_DISTANCE_METERS FLOAT, CALCULATED_AT TIMESTAMP_LTZ DEFAULT SYSDATE()) COMMENT = ''{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"matrix"}}''';
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

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.BUILD_HEXAGONS_ROAD_AWARE(P_RES VARCHAR, P_MIN_LAT FLOAT, P_MAX_LAT FLOAT, P_MIN_LON FLOAT, P_MAX_LON FLOAT, P_REGION VARCHAR, P_PROFILE VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"matrix","feature":"road-aware"}}'
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

    -- H3_COVERAGE_STRINGS is a table function; invoke via TABLE(...) with lateral join.
    -- Returns every hexagon intersecting the geometry (complete coverage with no edge gaps).
    EXECUTE IMMEDIATE '
    INSERT INTO ' || hex_table || ' (H3_INDEX, CENTER_POINT)
    WITH bbox_poly AS (
        SELECT TO_GEOGRAPHY(''POLYGON((' ||
            P_MIN_LON || ' ' || P_MIN_LAT || ',' ||
            P_MAX_LON || ' ' || P_MIN_LAT || ',' ||
            P_MAX_LON || ' ' || P_MAX_LAT || ',' ||
            P_MIN_LON || ' ' || P_MAX_LAT || ',' ||
            P_MIN_LON || ' ' || P_MIN_LAT || '))'') AS poly
    ),
    road_segments AS (
        SELECT s.geometry
        FROM OVERTURE_MAPS__TRANSPORTATION.CARTO.SEGMENT s, bbox_poly b
        WHERE s.subtype = ''road''
          AND s.bbox:xmin::FLOAT <= ' || P_MAX_LON || '
          AND s.bbox:xmax::FLOAT >= ' || P_MIN_LON || '
          AND s.bbox:ymin::FLOAT <= ' || P_MAX_LAT || '
          AND s.bbox:ymax::FLOAT >= ' || P_MIN_LAT || '
          AND ST_INTERSECTS(s.geometry, b.poly)
    ),
    road_hexes AS (
        SELECT DISTINCT c.value::VARCHAR AS h3_index
        FROM road_segments r, TABLE(FLATTEN(H3_COVERAGE_STRINGS(r.geometry, ' || resolution || '))) c
    )
    SELECT h3_index, H3_CELL_TO_POINT(h3_index) AS center_point
    FROM road_hexes
    WHERE ST_Y(H3_CELL_TO_POINT(h3_index)) BETWEEN ' || P_MIN_LAT || ' AND ' || P_MAX_LAT || '
      AND ST_X(H3_CELL_TO_POINT(h3_index)) BETWEEN ' || P_MIN_LON || ' AND ' || P_MAX_LON || '';

    rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || hex_table);
    LET c CURSOR FOR rs;
    FOR row_val IN c DO
        row_count := row_val.CNT;
    END FOR;

    RETURN P_RES || ' road-aware hexagons built: ' || row_count || ' hexagons';
END;
$$;

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.BUILD_WORK_QUEUE(P_RES VARCHAR, P_REGION VARCHAR, P_PROFILE VARCHAR, P_JOB_ID VARCHAR DEFAULT NULL)
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
    hex_count INTEGER;
    num_shards INTEGER;
    shard_idx INTEGER DEFAULT 0;
    total_inserted INTEGER DEFAULT 0;
    shard_rows INTEGER;
    rs RESULTSET;
BEGIN
    safe_profile := REPLACE(UPPER(P_PROFILE), '-', '_');
    hex_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_LIST_' || P_RES;
    queue_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_WORK_QUEUE_' || P_RES;

    rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || hex_table);
    LET cnt_cursor CURSOR FOR rs;
    FOR r IN cnt_cursor DO hex_count := r.CNT; END FOR;

    num_shards := GREATEST(1, LEAST(100, CEIL(hex_count / 5000)));

    EXECUTE IMMEDIATE 'TRUNCATE TABLE ' || queue_table;

    FOR shard_idx IN 0 TO num_shards - 1 DO
        EXECUTE IMMEDIATE '
        INSERT INTO ' || queue_table || ' (SEQ_ID, ORIGIN_H3, ORIGIN_POINT, DEST_COORDS, DEST_HEX_IDS)
        WITH pairs AS (
            SELECT
                a.H3_INDEX AS origin_h3,
                a.CENTER_POINT AS origin_point,
                b.H3_INDEX AS dest_h3,
                b.CENTER_POINT AS dest_point,
                MOD(HASH(b.H3_INDEX), GREATEST(CEIL(' || hex_count::VARCHAR || '.0 / 1000), 1)) AS chunk_idx
            FROM ' || hex_table || ' a
            CROSS JOIN ' || hex_table || ' b
            WHERE a.H3_INDEX != b.H3_INDEX
              AND MOD(HASH(a.H3_INDEX), ' || num_shards::VARCHAR || ') = ' || shard_idx::VARCHAR || '
        )
        SELECT
            ROW_NUMBER() OVER (ORDER BY origin_h3, chunk_idx) + ' || total_inserted::VARCHAR || ' AS seq_id,
            origin_h3,
            ANY_VALUE(origin_point),
            ARRAY_AGG(ARRAY_CONSTRUCT(ST_X(dest_point), ST_Y(dest_point))),
            ARRAY_AGG(dest_h3)
        FROM pairs
        GROUP BY origin_h3, chunk_idx';

        rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || queue_table || ' WHERE SEQ_ID > ' || total_inserted::VARCHAR);
        LET sc CURSOR FOR rs;
        FOR r IN sc DO shard_rows := r.CNT; END FOR;
        total_inserted := total_inserted + shard_rows;

        IF (P_JOB_ID IS NOT NULL) THEN
            UPDATE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
            SET PCT_COMPLETE = ROUND((:shard_idx + 1) / :num_shards * 30, 1),
                WORK_QUEUE_ROWS = :total_inserted
            WHERE JOB_ID = :P_JOB_ID;
        END IF;
    END FOR;

    RETURN P_RES || ' work queue built: ' || total_inserted || ' chunks (' || num_shards || ' shards, ' || hex_count || ' origins)';
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
        -- Only retry rows that lack BOTH a durations array AND a structured ORS error.
        -- Rows with MATRIX_RESULT:error.code set (e.g. 6010 out-of-bounds) are deterministic
        -- failures — retrying them is futile and creates an infinite delete/re-insert loop.
        error_retry_sql := 'SELECT COUNT(*) AS CNT FROM ' || raw_table ||
            ' WHERE SEQ_ID BETWEEN ' || P_START_SEQ || ' AND ' || P_END_SEQ ||
            ' AND MATRIX_RESULT:durations IS NULL' ||
            ' AND MATRIX_RESULT:error IS NULL';
        rs := (EXECUTE IMMEDIATE :error_retry_sql);
        LET ec CURSOR FOR rs;
        FOR r IN ec DO error_origin_count := r.CNT; END FOR;

        IF (error_origin_count = 0) THEN
            retry_pass := max_error_retries;
        ELSE
            retry_pass := retry_pass + 1;
            EXECUTE IMMEDIATE 'SELECT SYSTEM$WAIT(30)';

            -- Only delete rows that have no response at all; preserve rows with
            -- deterministic ORS error responses so they are not retried indefinitely.
            EXECUTE IMMEDIATE 'DELETE FROM ' || raw_table ||
            ' WHERE SEQ_ID BETWEEN ' || P_START_SEQ || ' AND ' || P_END_SEQ ||
            ' AND MATRIX_RESULT:durations IS NULL' ||
            ' AND MATRIX_RESULT:error IS NULL';

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
        SYSDATE() AS CALCULATED_AT
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
          AND CREATED_AT > DATEADD('day', -30, SYSDATE())
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

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.BUILD_MATRIX_JOB_WRAPPER(P_JOB_ID VARCHAR, P_RES VARCHAR, P_MIN_LAT FLOAT, P_MAX_LAT FLOAT, P_MIN_LON FLOAT, P_MAX_LON FLOAT, P_MATRIX_FN VARCHAR, P_REGION VARCHAR, P_PROFILE VARCHAR, P_ROAD_FILTER BOOLEAN DEFAULT FALSE)
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
    filter_start TIMESTAMP_NTZ;
    used_road_filter BOOLEAN DEFAULT FALSE;
    hex_before INTEGER DEFAULT 0;
    resolution_int INTEGER;
BEGIN
    safe_profile := REPLACE(UPPER(P_PROFILE), '-', '_');
    prefix := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile;

    UPDATE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
    SET STATUS = 'ERROR',
        ERROR_MSG = 'Stale job: still RUNNING after 2+ hours, marked as zombie',
        COMPLETED_AT = SYSDATE()
    WHERE STATUS = 'RUNNING'
      AND STARTED_AT < DATEADD('HOUR', -2, SYSDATE())
      AND JOB_ID != :P_JOB_ID;

    UPDATE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
    SET STATUS='RUNNING', STAGE='HEXAGONS', STARTED_AT=SYSDATE()
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

    -- INVARIANT: this RESUME + SET AUTO_SUSPEND_SECS=0 block must run BEFORE
    -- BUILD_WORK_QUEUE and any other long-running step. Moving it later
    -- re-introduces the WORK_QUEUE drift bug (see AGENTS.md
    -- "AUTO_SUSPEND_SECS Invariant"). All long phases (filtering, work-queue
    -- build, MATRIX_API, sweep) must be protected from auto-suspension.
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
        EXECUTE IMMEDIATE 'UPDATE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS SET STATUS=''ERROR'', ERROR_MSG=''ORS profile ' || P_PROFILE || ' not ready after ' || wait_secs || ' seconds. Service may need more time to load graphs.'', COMPLETED_AT=SYSDATE() WHERE JOB_ID=''' || P_JOB_ID || '''';
        RETURN 'Job ' || :P_JOB_ID || ' failed: profile ' || :P_PROFILE || ' not ready';
    END IF;

    EXECUTE IMMEDIATE 'UPDATE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS SET MESSAGE=''ORS profile ' || P_PROFILE || ' ready after ' || wait_secs || 's'' WHERE JOB_ID=''' || P_JOB_ID || '''';

    filter_start := SYSDATE();
    used_road_filter := FALSE;
    hex_before := 0;
    resolution_int := CASE P_RES
        WHEN 'RES5' THEN 5 WHEN 'RES6' THEN 6 WHEN 'RES7' THEN 7
        WHEN 'RES8' THEN 8 WHEN 'RES9' THEN 9 ELSE 10 END;

    IF (P_ROAD_FILTER) THEN
        BEGIN
            LET est_rs RESULTSET := (EXECUTE IMMEDIATE
                'SELECT ARRAY_SIZE(H3_POLYGON_TO_CELLS_STRINGS(
                    TO_GEOGRAPHY(''POLYGON((' ||
                        P_MIN_LON || ' ' || P_MIN_LAT || ',' ||
                        P_MAX_LON || ' ' || P_MIN_LAT || ',' ||
                        P_MAX_LON || ' ' || P_MAX_LAT || ',' ||
                        P_MIN_LON || ' ' || P_MAX_LAT || ',' ||
                        P_MIN_LON || ' ' || P_MIN_LAT || '))''),
                    ' || resolution_int || ')) AS CNT');
            LET ec CURSOR FOR est_rs;
            FOR r IN ec DO hex_before := r.CNT; END FOR;
        EXCEPTION WHEN OTHER THEN hex_before := 0;
        END;

        BEGIN
            CALL OPENROUTESERVICE_APP.CORE.BUILD_HEXAGONS_ROAD_AWARE(:P_RES, :P_MIN_LAT, :P_MAX_LAT, :P_MIN_LON, :P_MAX_LON, :P_REGION, :P_PROFILE);
            used_road_filter := TRUE;
        EXCEPTION WHEN OTHER THEN
            LET err_detail VARCHAR := SQLERRM;
            UPDATE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
            SET MESSAGE = 'Road-aware filter unavailable: ' || :err_detail || ' -- falling back to full bbox'
            WHERE JOB_ID = :P_JOB_ID;
            CALL OPENROUTESERVICE_APP.CORE.BUILD_HEXAGONS(:P_RES, :P_MIN_LAT, :P_MAX_LAT, :P_MIN_LON, :P_MAX_LON, :P_REGION, :P_PROFILE);
        END;
    ELSE
        CALL OPENROUTESERVICE_APP.CORE.BUILD_HEXAGONS(:P_RES, :P_MIN_LAT, :P_MAX_LAT, :P_MIN_LON, :P_MAX_LON, :P_REGION, :P_PROFILE);
    END IF;

    rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || prefix || '_LIST_' || P_RES);
    LET c1 CURSOR FOR rs; FOR r IN c1 DO hex_count := r.CNT; END FOR;
    UPDATE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
    SET STAGE='WORK_QUEUE', HEXAGONS=:hex_count,
        ROAD_FILTER = :used_road_filter,
        HEXAGONS_BEFORE_FILTER = :hex_before,
        HEXAGONS_AFTER_FILTER = :hex_count,
        FILTER_DURATION_SECONDS = DATEDIFF('SECOND', :filter_start, SYSDATE())
    WHERE JOB_ID = :P_JOB_ID;

    LET original_wh_size VARCHAR := NULL;
    IF (hex_count > 5000) THEN
        BEGIN
            LET wh_name VARCHAR := CURRENT_WAREHOUSE();
            EXECUTE IMMEDIATE 'SHOW WAREHOUSES LIKE ''' || wh_name || '''';
            LET wh_rs RESULTSET := (SELECT "size" AS SZ FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) LIMIT 1);
            LET wh_c CURSOR FOR wh_rs;
            FOR r IN wh_c DO original_wh_size := r.SZ; END FOR;
            IF (hex_count > 25000) THEN
                EXECUTE IMMEDIATE 'ALTER WAREHOUSE ' || wh_name || ' SET WAREHOUSE_SIZE = ''X-LARGE''';
            ELSE
                EXECUTE IMMEDIATE 'ALTER WAREHOUSE ' || wh_name || ' SET WAREHOUSE_SIZE = ''LARGE''';
            END IF;
        EXCEPTION WHEN OTHER THEN
            original_wh_size := NULL;
        END;
    END IF;

    BEGIN
        CALL OPENROUTESERVICE_APP.CORE.BUILD_WORK_QUEUE(:P_RES, :P_REGION, :P_PROFILE, :P_JOB_ID);
    EXCEPTION WHEN OTHER THEN
        IF (original_wh_size IS NOT NULL) THEN
            BEGIN
                EXECUTE IMMEDIATE 'ALTER WAREHOUSE ' || CURRENT_WAREHOUSE() || ' SET WAREHOUSE_SIZE = ''' || original_wh_size || '''';
            EXCEPTION WHEN OTHER THEN NULL;
            END;
        END IF;
        RAISE;
    END;

    IF (original_wh_size IS NOT NULL) THEN
        BEGIN
            EXECUTE IMMEDIATE 'ALTER WAREHOUSE ' || CURRENT_WAREHOUSE() || ' SET WAREHOUSE_SIZE = ''' || original_wh_size || '''';
        EXCEPTION WHEN OTHER THEN NULL;
        END;
    END IF;

    rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || prefix || '_WORK_QUEUE_' || P_RES);
    LET c2 CURSOR FOR rs; FOR r IN c2 DO queue_count := r.CNT; END FOR;
    UPDATE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
    SET STAGE='BUILDING', WORK_QUEUE_ROWS=:queue_count
    WHERE JOB_ID = :P_JOB_ID;

    -- AUTO_SUSPEND_SECS=0 was already pinned at the top of this procedure
    -- (before BUILD_WORK_QUEUE) per AGENTS.md AUTO_SUSPEND_SECS invariant.
    -- Do not re-pin here; that pattern caused WORK_QUEUE-stage drift.

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
        -- Sweep retry: only delete rows with no response. Rows with a deterministic
        -- ORS error (e.g. 6010 out-of-bounds) are permanent failures and must be kept
        -- to prevent an infinite delete/re-insert loop.
        EXECUTE IMMEDIATE 'DELETE FROM ' || sweep_raw ||
            ' WHERE MATRIX_RESULT:durations IS NULL' ||
            ' AND MATRIX_RESULT:error IS NULL';

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

    -- Surface partial completion: if far fewer raw rows than queue rows, log warning
    IF (raw_count < queue_count * 0.95 AND raw_count > 0) THEN
        LET missing_pct FLOAT := ROUND((1.0 - raw_count::FLOAT / queue_count) * 100, 1);
        UPDATE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
        SET MESSAGE = 'WARNING: only ' || :raw_count || ' of ' || :queue_count || ' chunks completed (' || :missing_pct || '% missing). ORS may have returned null durations for some origin/dest combos. Consider scaling ORS_SERVICE or reducing chunk size.'
        WHERE JOB_ID = :P_JOB_ID;
    END IF;

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
            RAW_ROWS=:raw_count, COMPLETED_AT=SYSDATE()
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

    -- Purge rows with deterministic ORS error responses (e.g. 6010 out-of-bounds).
    -- These hexagon centroids fall outside the routable graph and will never produce
    -- a valid result. Removing them keeps the raw table lean and avoids carrying
    -- error payloads into downstream tables. Retry-eligible rows (durations IS NULL
    -- AND error IS NULL) are NOT touched here.
    EXECUTE IMMEDIATE 'DELETE FROM ' || prefix || '_MATRIX_RAW_' || P_RES ||
        ' WHERE MATRIX_RESULT:error IS NOT NULL';

    rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || prefix || '_MATRIX_RAW_' || P_RES);
    LET c3c CURSOR FOR rs; FOR r IN c3c DO raw_count := r.CNT; END FOR;

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
            RAW_ROWS=:raw_count, COMPLETED_AT=SYSDATE()
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
        RAW_ROWS=:raw_count, PCT_COMPLETE=100, COMPLETED_AT=SYSDATE()
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
        SET STATUS='ERROR', ERROR_MSG=:err_msg, COMPLETED_AT=SYSDATE()
        WHERE JOB_ID = :P_JOB_ID;
        RETURN 'Job ' || :P_JOB_ID || ' failed: ' || :err_msg;
END;
$$;
