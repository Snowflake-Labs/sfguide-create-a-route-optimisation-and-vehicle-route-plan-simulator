# SQL Procedures — Travel Time Matrix

All stored procedures for the travel-time-matrix workflow. Each procedure is parameterized by region prefix (`P_REGION`) and H3 resolution (`P_RES`).

---

## BUILD_TRAVEL_TIME_RANGE

Resume-safe, retry-aware worker procedure. Processes a range of work queue rows, inserting raw VARIANT payloads into the staging table. Uses adaptive batch sizing per resolution and exponential backoff on failure.

```sql
CREATE OR REPLACE PROCEDURE <P_DB>.PUBLIC.BUILD_TRAVEL_TIME_RANGE(
    P_REGION VARCHAR,
    P_RES INTEGER,
    P_START_SEQ INTEGER,
    P_END_SEQ INTEGER,
    P_ORS_APP VARCHAR DEFAULT 'OPENROUTESERVICE_NATIVE_APP'
)
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    batch_size INTEGER;
    current_pos INTEGER;
    batch_end INTEGER;
    batch_num INTEGER DEFAULT 0;
    queue_table VARCHAR;
    raw_table VARCHAR;
    res_label VARCHAR;
    insert_sql VARCHAR;
    resume_sql VARCHAR;
    max_done INTEGER DEFAULT 0;
    rs RESULTSET;
    retry_count INTEGER DEFAULT 0;
    max_retries INTEGER DEFAULT 5;
    retry_wait INTEGER DEFAULT 10;
BEGIN
    res_label := 'RES' || P_RES::VARCHAR;
    queue_table := P_REGION || '_WORK_QUEUE_' || res_label;
    raw_table := P_REGION || '_MATRIX_RAW_' || res_label;

    IF (P_RES <= 7) THEN
        batch_size := 100;
    ELSEIF (P_RES = 8) THEN
        batch_size := 1000;
    ELSE
        batch_size := 2000;
    END IF;

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

        insert_sql := '
        INSERT INTO ' || raw_table || '
        SELECT
            q.SEQ_ID,
            q.ORIGIN_H3,
            q.DEST_HEX_IDS,
            ' || P_ORS_APP || '.CORE.MATRIX_TABULAR(
                ''driving-car'',
                ARRAY_CONSTRUCT(q.ORIGIN_LON, q.ORIGIN_LAT),
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
                        RAISE;
                    END IF;
                    EXECUTE IMMEDIATE 'SELECT SYSTEM$WAIT(' || retry_wait || ')';
                    retry_wait := retry_wait * 2;
            END;
        END WHILE;

        current_pos := batch_end + 1;
    END WHILE;

    RETURN res_label || ' range [' || P_START_SEQ || '-' || P_END_SEQ ||
           '] complete: ' || batch_num || ' batches of ' || batch_size ||
           ' (resumed from seq ' || max_done || ')';
END;
$$;

ALTER PROCEDURE <P_DB>.PUBLIC.BUILD_TRAVEL_TIME_RANGE(VARCHAR, INTEGER, INTEGER, INTEGER, VARCHAR) SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-travel-time-matrix","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

**Adaptive batch sizing rationale:**
- ORS has a practical limit of ~500K matrix elements per HTTP request
- RES 6-7: 100 origins (heavy destinations) — safe under 500K elements
- RES 8: 1000 origins x ~438 dests = ~438K elements — safe
- RES 9-10: 2000 origins x ~60-132 dests = ~120-264K elements — safe

---

## FLATTEN_MATRIX_RAW

Post-processing procedure. Extracts structured travel-time pairs from raw VARIANT payloads. Run on a dedicated XLARGE warehouse for fast bulk processing.

```sql
CREATE OR REPLACE PROCEDURE <P_DB>.PUBLIC.FLATTEN_MATRIX_RAW(
    P_REGION VARCHAR,
    P_RES INTEGER
)
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    res_label VARCHAR;
    raw_table VARCHAR;
    target_table VARCHAR;
    row_count INTEGER;
    rs RESULTSET;
BEGIN
    res_label := 'RES' || P_RES::VARCHAR;
    raw_table := P_REGION || '_MATRIX_RAW_' || res_label;
    target_table := P_REGION || '_TRAVEL_TIME_' || res_label;

    EXECUTE IMMEDIATE '
    CREATE TABLE IF NOT EXISTS ' || target_table || ' (
        ORIGIN_H3 VARCHAR, DEST_H3 VARCHAR,
        TRAVEL_TIME_SECONDS FLOAT, TRAVEL_DISTANCE_METERS FLOAT
    )';

    EXECUTE IMMEDIATE 'TRUNCATE TABLE ' || target_table;

    EXECUTE IMMEDIATE '
    INSERT INTO ' || target_table || ' (ORIGIN_H3, DEST_H3, TRAVEL_TIME_SECONDS, TRAVEL_DISTANCE_METERS)
    SELECT
        r.ORIGIN_H3,
        r.DEST_HEX_IDS[f.INDEX]::VARCHAR AS DEST_H3,
        r.MATRIX_RESULT:durations[0][f.INDEX]::FLOAT AS TRAVEL_TIME_SECONDS,
        r.MATRIX_RESULT:distances[0][f.INDEX]::FLOAT AS TRAVEL_DISTANCE_METERS
    FROM ' || raw_table || ' r,
        LATERAL FLATTEN(input => r.MATRIX_RESULT:durations[0]) f
    WHERE r.MATRIX_RESULT:durations IS NOT NULL';

    rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || target_table);
    LET c CURSOR FOR rs;
    FOR row_val IN c DO
        row_count := row_val.CNT;
    END FOR;

    RETURN P_REGION || ' ' || res_label || ' flatten complete: ' || row_count || ' travel time pairs';
END;
$$;

ALTER PROCEDURE <P_DB>.PUBLIC.FLATTEN_MATRIX_RAW(VARCHAR, INTEGER) SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-travel-time-matrix","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

---

## CREATE_MATRIX_DAG

Creates the full Task DAG: per-resolution root tasks, parallel worker tasks, and flatten tasks. Fully parameterized by region, resolution list, and worker count.

```sql
CREATE OR REPLACE PROCEDURE <P_DB>.PUBLIC.CREATE_MATRIX_DAG(
    P_DB VARCHAR,
    P_REGION VARCHAR,
    P_RESOLUTIONS ARRAY,
    P_ROUTING_WH VARCHAR,
    P_FLATTEN_WH VARCHAR,
    P_NUM_WORKERS INTEGER DEFAULT 10,
    P_ORS_APP VARCHAR DEFAULT 'OPENROUTESERVICE_NATIVE_APP'
)
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    res INTEGER;
    res_label VARCHAR;
    total_rows INTEGER;
    chunk_size INTEGER;
    start_seq INTEGER;
    end_seq INTEGER;
    w INTEGER;
    task_name VARCHAR;
    worker_list VARCHAR;
    ddl VARCHAR;
    i INTEGER DEFAULT 0;
    rs RESULTSET;
    total_tasks INTEGER DEFAULT 0;
BEGIN
    FOR i IN 0 TO ARRAY_SIZE(P_RESOLUTIONS) - 1 DO
        res := P_RESOLUTIONS[i]::INTEGER;
        res_label := 'RES' || res::VARCHAR;

        BEGIN
            EXECUTE IMMEDIATE 'DROP TASK IF EXISTS ' || P_DB || '.PUBLIC.TASK_FLATTEN_' || P_REGION || '_' || res_label;
        EXCEPTION WHEN OTHER THEN NULL; END;
        w := 1;
        WHILE (w <= P_NUM_WORKERS) DO
            BEGIN
                EXECUTE IMMEDIATE 'DROP TASK IF EXISTS ' || P_DB || '.PUBLIC.TASK_WORKER_' || P_REGION || '_' || res_label || '_' || LPAD(w, 2, '0');
            EXCEPTION WHEN OTHER THEN NULL; END;
            w := w + 1;
        END WHILE;
        BEGIN
            EXECUTE IMMEDIATE 'DROP TASK IF EXISTS ' || P_DB || '.PUBLIC.TASK_BUILD_QUEUE_' || P_REGION || '_' || res_label;
        EXCEPTION WHEN OTHER THEN NULL; END;
    END FOR;

    FOR i IN 0 TO ARRAY_SIZE(P_RESOLUTIONS) - 1 DO
        res := P_RESOLUTIONS[i]::INTEGER;
        res_label := 'RES' || res::VARCHAR;

        rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || P_DB || '.PUBLIC.' || P_REGION || '_WORK_QUEUE_' || res_label);
        LET c1 CURSOR FOR rs;
        FOR r IN c1 DO
            total_rows := r.CNT;
        END FOR;
        chunk_size := CEIL(total_rows / P_NUM_WORKERS);

        ddl := 'CREATE OR REPLACE TASK ' || P_DB || '.PUBLIC.TASK_BUILD_QUEUE_' || P_REGION || '_' || res_label ||
               ' WAREHOUSE = ' || P_FLATTEN_WH ||
               ' AS SELECT ''Work queue ' || P_REGION || ' ' || res_label || ' ready: ' || total_rows || ' origins''';
        EXECUTE IMMEDIATE ddl;

        w := 1;
        WHILE (w <= P_NUM_WORKERS) DO
            start_seq := ((w - 1) * chunk_size) + 1;
            end_seq := LEAST(w * chunk_size, total_rows);
            IF (start_seq <= total_rows) THEN
                task_name := P_DB || '.PUBLIC.TASK_WORKER_' || P_REGION || '_' || res_label || '_' || LPAD(w, 2, '0');
                ddl := 'CREATE OR REPLACE TASK ' || task_name ||
                       ' WAREHOUSE = ' || P_ROUTING_WH ||
                       ' AFTER ' || P_DB || '.PUBLIC.TASK_BUILD_QUEUE_' || P_REGION || '_' || res_label ||
                       ' AS CALL ' || P_DB || '.PUBLIC.BUILD_TRAVEL_TIME_RANGE(''' || P_REGION || ''', ' || res || ', ' || start_seq || ', ' || end_seq || ', ''' || P_ORS_APP || ''')';
                EXECUTE IMMEDIATE ddl;
                total_tasks := total_tasks + 1;
            END IF;
            w := w + 1;
        END WHILE;

        worker_list := '';
        w := 1;
        WHILE (w <= P_NUM_WORKERS) DO
            IF (((w - 1) * chunk_size) + 1 <= total_rows) THEN
                IF (worker_list != '') THEN
                    worker_list := worker_list || ', ';
                END IF;
                worker_list := worker_list || P_DB || '.PUBLIC.TASK_WORKER_' || P_REGION || '_' || res_label || '_' || LPAD(w, 2, '0');
            END IF;
            w := w + 1;
        END WHILE;

        ddl := 'CREATE OR REPLACE TASK ' || P_DB || '.PUBLIC.TASK_FLATTEN_' || P_REGION || '_' || res_label ||
               ' WAREHOUSE = ' || P_FLATTEN_WH ||
               ' AFTER ' || worker_list ||
               ' AS CALL ' || P_DB || '.PUBLIC.FLATTEN_MATRIX_RAW(''' || P_REGION || ''', ' || res || ')';
        EXECUTE IMMEDIATE ddl;
        total_tasks := total_tasks + 2;
    END FOR;

    RETURN 'DAG created for ' || P_REGION || ': ' || ARRAY_SIZE(P_RESOLUTIONS) || ' resolutions, ' || total_tasks || ' total tasks';
END;
$$;

ALTER PROCEDURE <P_DB>.PUBLIC.CREATE_MATRIX_DAG(VARCHAR, VARCHAR, ARRAY, VARCHAR, VARCHAR, INTEGER, VARCHAR) SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-travel-time-matrix","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

---

## START_MATRIX_DAG

Resumes all tasks (leaf-to-root order) then executes root tasks to kick off the pipeline.

```sql
CREATE OR REPLACE PROCEDURE <P_DB>.PUBLIC.START_MATRIX_DAG(
    P_DB VARCHAR,
    P_REGION VARCHAR,
    P_RESOLUTIONS ARRAY,
    P_NUM_WORKERS INTEGER DEFAULT 10
)
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    res INTEGER;
    res_label VARCHAR;
    i INTEGER;
    w INTEGER;
BEGIN
    FOR i IN 0 TO ARRAY_SIZE(P_RESOLUTIONS) - 1 DO
        res := P_RESOLUTIONS[i]::INTEGER;
        res_label := 'RES' || res::VARCHAR;
        BEGIN
            EXECUTE IMMEDIATE 'ALTER TASK ' || P_DB || '.PUBLIC.TASK_FLATTEN_' || P_REGION || '_' || res_label || ' RESUME';
        EXCEPTION WHEN OTHER THEN NULL; END;
        w := P_NUM_WORKERS;
        WHILE (w >= 1) DO
            BEGIN
                EXECUTE IMMEDIATE 'ALTER TASK ' || P_DB || '.PUBLIC.TASK_WORKER_' || P_REGION || '_' || res_label || '_' || LPAD(w, 2, '0') || ' RESUME';
            EXCEPTION WHEN OTHER THEN NULL; END;
            w := w - 1;
        END WHILE;
        BEGIN
            EXECUTE IMMEDIATE 'ALTER TASK ' || P_DB || '.PUBLIC.TASK_BUILD_QUEUE_' || P_REGION || '_' || res_label || ' RESUME';
        EXCEPTION WHEN OTHER THEN NULL; END;
    END FOR;

    FOR i IN 0 TO ARRAY_SIZE(P_RESOLUTIONS) - 1 DO
        res := P_RESOLUTIONS[i]::INTEGER;
        res_label := 'RES' || res::VARCHAR;
        EXECUTE IMMEDIATE 'EXECUTE TASK ' || P_DB || '.PUBLIC.TASK_BUILD_QUEUE_' || P_REGION || '_' || res_label;
    END FOR;

    RETURN 'DAG started for ' || P_REGION || ': all tasks resumed and root tasks executed';
END;
$$;

ALTER PROCEDURE <P_DB>.PUBLIC.START_MATRIX_DAG(VARCHAR, VARCHAR, ARRAY, INTEGER) SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-travel-time-matrix","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

---

## STOP_MATRIX_DAG

Suspends all tasks (root-to-leaf order) to halt the pipeline.

```sql
CREATE OR REPLACE PROCEDURE <P_DB>.PUBLIC.STOP_MATRIX_DAG(
    P_DB VARCHAR,
    P_REGION VARCHAR,
    P_RESOLUTIONS ARRAY,
    P_NUM_WORKERS INTEGER DEFAULT 10
)
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    res INTEGER;
    res_label VARCHAR;
    i INTEGER;
    w INTEGER;
BEGIN
    FOR i IN 0 TO ARRAY_SIZE(P_RESOLUTIONS) - 1 DO
        res := P_RESOLUTIONS[i]::INTEGER;
        res_label := 'RES' || res::VARCHAR;
        BEGIN
            EXECUTE IMMEDIATE 'ALTER TASK ' || P_DB || '.PUBLIC.TASK_BUILD_QUEUE_' || P_REGION || '_' || res_label || ' SUSPEND';
        EXCEPTION WHEN OTHER THEN NULL; END;
        w := 1;
        WHILE (w <= P_NUM_WORKERS) DO
            BEGIN
                EXECUTE IMMEDIATE 'ALTER TASK ' || P_DB || '.PUBLIC.TASK_WORKER_' || P_REGION || '_' || res_label || '_' || LPAD(w, 2, '0') || ' SUSPEND';
            EXCEPTION WHEN OTHER THEN NULL; END;
            w := w + 1;
        END WHILE;
        BEGIN
            EXECUTE IMMEDIATE 'ALTER TASK ' || P_DB || '.PUBLIC.TASK_FLATTEN_' || P_REGION || '_' || res_label || ' SUSPEND';
        EXCEPTION WHEN OTHER THEN NULL; END;
    END FOR;

    RETURN 'DAG stopped for ' || P_REGION || ': all tasks suspended';
END;
$$;

ALTER PROCEDURE <P_DB>.PUBLIC.STOP_MATRIX_DAG(VARCHAR, VARCHAR, ARRAY, INTEGER) SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-travel-time-matrix","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

---

## MATRIX_PROGRESS (Monitoring Query)

Not a stored procedure, but a reusable monitoring pattern. Use for any resolution:

```sql
SELECT
    '<P_REGION>' AS region,
    'RES<N>' AS res,
    COUNT(*) AS done,
    (SELECT COUNT(*) FROM <P_DB>.PUBLIC.<P_REGION>_WORK_QUEUE_RES<N>) AS total,
    ROUND(COUNT(*) * 100.0 / NULLIF((SELECT COUNT(*) FROM <P_DB>.PUBLIC.<P_REGION>_WORK_QUEUE_RES<N>), 0), 1) AS pct
FROM <P_DB>.PUBLIC.<P_REGION>_MATRIX_RAW_RES<N>;
```

### Running Worker Check

```sql
SELECT
    QUERY_TEXT,
    EXECUTION_STATUS,
    DATEDIFF('minute', START_TIME, CURRENT_TIMESTAMP()) AS running_min
FROM TABLE(INFORMATION_SCHEMA.QUERY_HISTORY_BY_WAREHOUSE('ROUTING_ANALYTICS'))
WHERE QUERY_TEXT ILIKE '%BUILD_TRAVEL_TIME_RANGE%'
  AND EXECUTION_STATUS = 'RUNNING'
ORDER BY START_TIME;
```

### Error vs Success Ratio

```sql
SELECT
    CASE WHEN MATRIX_RESULT:durations IS NOT NULL THEN 'SUCCESS' ELSE 'ERROR' END AS STATUS,
    COUNT(*) AS CNT
FROM <P_DB>.PUBLIC.<P_REGION>_MATRIX_RAW_RES<N>
GROUP BY 1;
```
