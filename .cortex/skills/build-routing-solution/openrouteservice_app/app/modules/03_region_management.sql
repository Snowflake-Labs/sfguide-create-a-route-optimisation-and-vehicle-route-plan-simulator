USE SCHEMA OPENROUTESERVICE_APP.CORE;   

-- =============================================================================
-- REGION CATALOG: Dynamic catalog of OSM regions from Geofabrik + BBBike
-- =============================================================================

CREATE TABLE IF NOT EXISTS OPENROUTESERVICE_APP.CORE.REGION_CATALOG (
    CATALOG_ID    VARCHAR NOT NULL,
    SOURCE        VARCHAR NOT NULL,
    REGION_NAME   VARCHAR NOT NULL,
    REGION_KEY    VARCHAR NOT NULL,
    HIERARCHY     VARCHAR,
    CONTINENT     VARCHAR,
    COUNTRY       VARCHAR,
    PBF_URL       VARCHAR NOT NULL,
    PBF_SIZE_MB   FLOAT,
    LEVEL         VARCHAR NOT NULL,
    MIN_LAT       FLOAT,
    MAX_LAT       FLOAT,
    MIN_LON       FLOAT,
    MAX_LON       FLOAT,
    UPDATED_AT    TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"region-catalog"}}';

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.REFRESH_REGION_CATALOG()
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"region-catalog"}}'
EXECUTE AS OWNER
AS
$$
BEGIN
    RETURN '{"message":"Catalog refresh is handled by the Control App server. Use the Region Builder UI or POST /api/regions/catalog/refresh."}';
END;
$$;

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.LOAD_SEED_CATALOG(P_STAGE_PREFIX VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"region-catalog"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    cnt INTEGER DEFAULT 0;
    existing INTEGER DEFAULT 0;
    rs RESULTSET;
BEGIN
    SELECT COUNT(*) INTO existing FROM OPENROUTESERVICE_APP.CORE.REGION_CATALOG;
    IF (existing > 0) THEN
        RETURN OBJECT_CONSTRUCT('status', 'skipped', 'reason', 'catalog already has ' || existing || ' rows')::VARCHAR;
    END IF;

    EXECUTE IMMEDIATE '
        COPY INTO OPENROUTESERVICE_APP.CORE.REGION_CATALOG
        FROM (
            SELECT
                $1:CATALOG_ID::VARCHAR,
                $1:SOURCE::VARCHAR,
                $1:REGION_NAME::VARCHAR,
                $1:REGION_KEY::VARCHAR,
                $1:HIERARCHY::VARCHAR,
                $1:CONTINENT::VARCHAR,
                $1:COUNTRY::VARCHAR,
                $1:PBF_URL::VARCHAR,
                $1:PBF_SIZE_MB::FLOAT,
                $1:LEVEL::VARCHAR,
                $1:MIN_LAT::FLOAT,
                $1:MAX_LAT::FLOAT,
                $1:MIN_LON::FLOAT,
                $1:MAX_LON::FLOAT,
                CURRENT_TIMESTAMP()
            FROM ' || P_STAGE_PREFIX || '/region_catalog/
        )
        FILE_FORMAT = (TYPE = PARQUET)
        PURGE = FALSE
        FORCE = TRUE';

    rs := (SELECT COUNT(*) AS CNT FROM OPENROUTESERVICE_APP.CORE.REGION_CATALOG);
    LET c CURSOR FOR rs;
    FOR row_val IN c DO cnt := row_val.CNT; END FOR;

    RETURN OBJECT_CONSTRUCT('status', 'loaded', 'rows', cnt)::VARCHAR;
END;
$$;

-- =============================================================================
-- REGION PROVISIONING: Job tracking for region deployment
-- =============================================================================

CREATE TABLE IF NOT EXISTS OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS (
    JOB_ID VARCHAR NOT NULL,
    REGION VARCHAR NOT NULL,
    DISPLAY_NAME VARCHAR,
    PBF_URL VARCHAR,
    PROFILES VARCHAR,
    STATUS VARCHAR DEFAULT 'PENDING',
    STAGE VARCHAR DEFAULT 'NOT_STARTED',
    MESSAGE VARCHAR,
    STATEMENT_HANDLE VARCHAR,
    CREATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    STARTED_AT TIMESTAMP_NTZ,
    COMPLETED_AT TIMESTAMP_NTZ,
    ERROR_MSG VARCHAR,
    DISMISSED BOOLEAN DEFAULT FALSE
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"provisioner"}}';

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.PROVISION_REGION_WRAPPER(
    P_JOB_ID VARCHAR,
    P_REGION VARCHAR,
    P_DISPLAY_NAME VARCHAR,
    P_PBF_URL VARCHAR,
    P_MIN_LAT FLOAT, P_MAX_LAT FLOAT, P_MIN_LON FLOAT, P_MAX_LON FLOAT,
    P_PROFILES VARCHAR,
    P_COMPUTE_SIZE VARCHAR
)
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"provisioner"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    pbf_filename VARCHAR;
    svc_name VARCHAR;
    svc_status VARCHAR DEFAULT '';
    status_raw VARCHAR;
    status_json VARIANT;
    profile_count INTEGER DEFAULT 0;
    rs RESULTSET;
BEGIN
    UPDATE OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
    SET STATUS='RUNNING', STAGE='DOWNLOADING', STARTED_AT=CURRENT_TIMESTAMP(),
        MESSAGE='Inserting region metadata and downloading PBF file...'
    WHERE JOB_ID = :P_JOB_ID;

    BEGIN
        ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.downloader SET AUTO_SUSPEND_SECS = 0;
    EXCEPTION WHEN OTHER THEN NULL;
    END;

    MERGE INTO OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP t USING (
        SELECT :P_REGION AS REGION
    ) s ON t.REGION = s.REGION
    WHEN NOT MATCHED THEN INSERT (REGION, DISPLAY_NAME, PBF_URL, MIN_LAT, MAX_LAT, MIN_LON, MAX_LON, STATUS)
        VALUES (:P_REGION, :P_DISPLAY_NAME, :P_PBF_URL, :P_MIN_LAT, :P_MAX_LAT, :P_MIN_LON, :P_MAX_LON, 'PROVISIONING');

    pbf_filename := SPLIT_PART(:P_PBF_URL, '/', -1);
    IF (pbf_filename IS NULL OR pbf_filename = '') THEN
        pbf_filename := 'data.osm.pbf';
    END IF;
    BEGIN
        EXECUTE IMMEDIATE 'SELECT OPENROUTESERVICE_APP.CORE.DOWNLOAD(''ors_spcs_stage/' || :P_REGION || ''', ''' || :pbf_filename || ''', ''' || :P_PBF_URL || ''')';
    EXCEPTION WHEN OTHER THEN
        LET dl_err STRING := 'PBF download failed: ' || SQLERRM;
        SYSTEM$LOG_INFO(dl_err);
        BEGIN
            ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.downloader SET AUTO_SUSPEND_SECS = 14400;
        EXCEPTION WHEN OTHER THEN NULL;
        END;
        UPDATE OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS SET STATUS='FAILED', MESSAGE=:dl_err WHERE JOB_ID = :P_JOB_ID;
        RETURN OBJECT_CONSTRUCT('status', 'FAILED', 'error', :dl_err)::VARCHAR;
    END;

    BEGIN
        ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.downloader SET AUTO_SUSPEND_SECS = 14400;
    EXCEPTION WHEN OTHER THEN NULL;
    END;

    UPDATE OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS SET STAGE='CONFIGURING', MESSAGE='Writing ORS configuration...' WHERE JOB_ID = :P_JOB_ID;
    CALL OPENROUTESERVICE_APP.CORE.WRITE_ORS_CONFIG(:P_REGION, :pbf_filename, :P_PROFILES, :P_COMPUTE_SIZE);

    UPDATE OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS SET STAGE='STARTING_SERVICE', MESSAGE='Creating ORS service...' WHERE JOB_ID = :P_JOB_ID;
    CALL OPENROUTESERVICE_APP.CORE.CREATE_REGION_ORS_SERVICE(:P_REGION, :P_COMPUTE_SIZE);

    UPDATE OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS SET STAGE='WAITING_FOR_SERVICE', MESSAGE='Waiting for ORS service to start...' WHERE JOB_ID = :P_JOB_ID;
    svc_name := 'ORS_SERVICE_' || UPPER(:P_REGION);
    FOR i IN 1 TO 60 DO
        EXECUTE IMMEDIATE 'SELECT SYSTEM$WAIT(10)';
        BEGIN
            EXECUTE IMMEDIATE 'SHOW SERVICES LIKE ''' || :svc_name || ''' IN SCHEMA OPENROUTESERVICE_APP.CORE';
            rs := (EXECUTE IMMEDIATE 'SELECT "status" AS S FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))');
            LET c1 CURSOR FOR rs;
            FOR r IN c1 DO svc_status := r.S; END FOR;
            IF (:svc_status = 'RUNNING') THEN
                UPDATE OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS SET MESSAGE='ORS service is RUNNING, waiting for graph...' WHERE JOB_ID = :P_JOB_ID;
                BREAK;
            END IF;
        EXCEPTION WHEN OTHER THEN NULL;
        END;
    END FOR;

    UPDATE OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS SET STAGE='BUILDING_GRAPH', MESSAGE='Service running — waiting for routing graph to load...' WHERE JOB_ID = :P_JOB_ID;
    FOR i IN 1 TO 40 DO
        EXECUTE IMMEDIATE 'SELECT SYSTEM$WAIT(15)';
        BEGIN
            rs := (EXECUTE IMMEDIATE 'SELECT OPENROUTESERVICE_APP.CORE.ORS_STATUS(''' || :P_REGION || ''')::VARCHAR AS S');
            LET c2 CURSOR FOR rs;
            FOR r IN c2 DO status_raw := r.S; END FOR;
            status_json := TRY_PARSE_JSON(:status_raw);
            IF (status_json:service_ready::BOOLEAN = TRUE AND status_json:profiles IS NOT NULL) THEN
                profile_count := ARRAY_SIZE(OBJECT_KEYS(status_json:profiles));
                IF (:profile_count > 0) THEN
                    UPDATE OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP SET STATUS='DEPLOYED' WHERE REGION = :P_REGION;
                    BEGIN
                        EXECUTE IMMEDIATE 'ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ORS_SERVICE_' || UPPER(:P_REGION) || ' SET AUTO_SUSPEND_SECS = 14400';
                    EXCEPTION WHEN OTHER THEN NULL;
                    END;
                    -- Issue #59: graphs are now persisted on stage. Flip REBUILD_GRAPHS to false
                    -- so subsequent suspend/resume cycles reuse the built graphs instead of rebuilding.
                    BEGIN
                        CALL OPENROUTESERVICE_APP.CORE.SET_REBUILD_GRAPHS_FLAG(:P_REGION, 'false');
                    EXCEPTION WHEN OTHER THEN NULL;
                    END;
                    UPDATE OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
                    SET STATUS='COMPLETE', STAGE='READY',
                        MESSAGE='Region provisioned — ' || :profile_count || ' profile(s) ready (REBUILD_GRAPHS=false for fast resume)',
                        COMPLETED_AT=CURRENT_TIMESTAMP()
                    WHERE JOB_ID = :P_JOB_ID;
                    RETURN 'Job ' || :P_JOB_ID || ' complete: ' || :profile_count || ' profiles ready';
                END IF;
            END IF;
        EXCEPTION WHEN OTHER THEN NULL;
        END;
    END FOR;

    BEGIN
        EXECUTE IMMEDIATE 'ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ORS_SERVICE_' || UPPER(:P_REGION) || ' SET AUTO_SUSPEND_SECS = 14400';
    EXCEPTION WHEN OTHER THEN NULL;
    END;
    UPDATE OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP SET STATUS='DEPLOYED' WHERE REGION = :P_REGION;
    UPDATE OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
    SET STATUS='COMPLETE', STAGE='READY',
        MESSAGE='Service running but graph may still be loading. Check ORS_STATUS.',
        COMPLETED_AT=CURRENT_TIMESTAMP()
    WHERE JOB_ID = :P_JOB_ID;
    RETURN 'Job ' || :P_JOB_ID || ' complete (graph may still be loading)';

EXCEPTION
    WHEN OTHER THEN
        LET err_msg VARCHAR := SQLERRM;
        BEGIN
            ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.downloader SET AUTO_SUSPEND_SECS = 14400;
        EXCEPTION WHEN OTHER THEN NULL;
        END;
        BEGIN
            EXECUTE IMMEDIATE 'ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ORS_SERVICE_' || UPPER(:P_REGION) || ' SET AUTO_SUSPEND_SECS = 14400';
        EXCEPTION WHEN OTHER THEN NULL;
        END;
        UPDATE OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
        SET STATUS='ERROR', ERROR_MSG=:err_msg, COMPLETED_AT=CURRENT_TIMESTAMP()
        WHERE JOB_ID = :P_JOB_ID;
        RETURN 'Job ' || :P_JOB_ID || ' failed: ' || :err_msg;
END;
$$;

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.GET_PROVISION_STATUS()
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"provisioner"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    result VARCHAR;
BEGIN
    SELECT COALESCE(ARRAY_AGG(OBJECT_CONSTRUCT(
        'job_id', JOB_ID, 'region', REGION, 'display_name', COALESCE(DISPLAY_NAME, REGION),
        'profiles', COALESCE(PROFILES, ''), 'status', STATUS, 'stage', STAGE,
        'message', COALESCE(MESSAGE, ''), 'error_msg', COALESCE(ERROR_MSG, ''),
        'statement_handle', COALESCE(STATEMENT_HANDLE, ''),
        'created_at', TO_VARCHAR(CONVERT_TIMEZONE('UTC', CREATED_AT), 'YYYY-MM-DD"T"HH24:MI:SS') || 'Z',
        'started_at', COALESCE(TO_VARCHAR(CONVERT_TIMEZONE('UTC', STARTED_AT), 'YYYY-MM-DD"T"HH24:MI:SS') || 'Z', ''),
        'completed_at', COALESCE(TO_VARCHAR(CONVERT_TIMEZONE('UTC', COMPLETED_AT), 'YYYY-MM-DD"T"HH24:MI:SS') || 'Z', '')
    )), ARRAY_CONSTRUCT())::VARCHAR INTO result
    FROM OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
    WHERE CREATED_AT > DATEADD('day', -30, CURRENT_TIMESTAMP())
      AND (DISMISSED = FALSE OR DISMISSED IS NULL)
    ORDER BY CREATED_AT DESC;
    RETURN result;
END;
$$;

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.DISMISS_PROVISION_JOB(P_JOB_ID VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"provisioner"}}'
EXECUTE AS OWNER
AS
$$
BEGIN
    UPDATE OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
    SET DISMISSED = TRUE
    WHERE JOB_ID = :P_JOB_ID;
    RETURN 'Job ' || :P_JOB_ID || ' dismissed';
END;
$$;

-- =============================================================================
-- MULTI-REGION: Per-region ORS instances with region-parameterized functions
-- =============================================================================

CREATE TABLE IF NOT EXISTS OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP (
    REGION VARCHAR,
    DISPLAY_NAME VARCHAR,
    PBF_URL VARCHAR,
    MIN_LAT FLOAT,
    MAX_LAT FLOAT,
    MIN_LON FLOAT,
    MAX_LON FLOAT,
    STATUS VARCHAR DEFAULT 'NOT_DEPLOYED',
    COMPUTE_SIZE VARCHAR DEFAULT 'M',
    CREATED_AT TIMESTAMP DEFAULT CURRENT_TIMESTAMP(),
    UPDATED_AT TIMESTAMP DEFAULT CURRENT_TIMESTAMP()
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"multi-region"}}';

-- =============================================================================
-- Spec builder + REBUILD_GRAPHS management
-- See Issue #59: graphs are persisted on @ORS_GRAPHS_SPCS_STAGE/<region> and
-- must be reused across suspend/resume cycles. REBUILD_GRAPHS=true is only
-- appropriate when the graphs stage is empty (first build) or when the caller
-- explicitly wants to force a rebuild (PBF update / corruption recovery).
-- =============================================================================

CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE.BUILD_ORS_SERVICE_SPEC(
    P_REGION VARCHAR, P_COMPUTE_SIZE VARCHAR, P_REBUILD_GRAPHS VARCHAR
)
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"multi-region"}}'
AS
$$
    '{"spec":{"containers":[{"name":"ors","image":"/openrouteservice_app/core/image_repository/openrouteservice:v9.0.0","volumeMounts":[{"name":"files","mountPath":"/home/ors/files"},{"name":"graphs","mountPath":"/home/ors/graphs"},{"name":"elevation-cache","mountPath":"/home/ors/elevation_cache"}],"env":{"REBUILD_GRAPHS":"' || LOWER(P_REBUILD_GRAPHS) ||
    '","ORS_CONFIG_LOCATION":"/home/ors/files/ors-config.yml","XMS":"' ||
    CASE UPPER(P_COMPUTE_SIZE) WHEN 'XL' THEN '16G' WHEN 'L' THEN '8G' WHEN 'S' THEN '2G' ELSE '4G' END ||
    '","XMX":"' ||
    CASE UPPER(P_COMPUTE_SIZE) WHEN 'XL' THEN '200G' WHEN 'L' THEN '96G' WHEN 'S' THEN '20G' ELSE '44G' END ||
    '"}}],"endpoints":[{"name":"ors","port":8082,"public":false}],"volumes":[{"name":"files","source":"@OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/' || P_REGION ||
    '"},{"name":"graphs","source":"@OPENROUTESERVICE_APP.CORE.ORS_GRAPHS_SPCS_STAGE/' || P_REGION ||
    '"},{"name":"elevation-cache","source":"@OPENROUTESERVICE_APP.CORE.ORS_elevation_cache_SPCS_STAGE/' || P_REGION ||
    '"}]}}'
$$;

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.create_region_ors_service(P_REGION VARCHAR, P_COMPUTE_SIZE VARCHAR)
RETURNS STRING
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"2.0","attributes":{"component":"multi-region"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    svc_name VARCHAR;
    pool_name VARCHAR;
    instance_family VARCHAR;
    ors_spec VARCHAR;
    create_sql VARCHAR;
    graph_file_count INTEGER DEFAULT 0;
    rebuild_flag VARCHAR DEFAULT 'true';
    rs RESULTSET;
BEGIN
    svc_name := 'ORS_SERVICE_' || UPPER(:P_REGION);
    pool_name := 'ORS_POOL_' || UPPER(:P_REGION);

    IF (:P_COMPUTE_SIZE = 'XL') THEN
        instance_family := 'HIGHMEM_X64_M';
    ELSEIF (:P_COMPUTE_SIZE = 'L') THEN
        instance_family := 'CPU_X64_L';
    ELSEIF (:P_COMPUTE_SIZE = 'S') THEN
        instance_family := 'CPU_X64_M';
    ELSE
        instance_family := 'CPU_X64_SL';
    END IF;

    -- Probe graphs stage: if a prior successful build left artifacts, reuse them
    -- (REBUILD_GRAPHS=false). Only set true when the stage is empty.
    BEGIN
        EXECUTE IMMEDIATE 'LIST @OPENROUTESERVICE_APP.CORE.ORS_GRAPHS_SPCS_STAGE/' || :P_REGION || '/';
        rs := (SELECT COUNT(*) AS C FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())));
        LET c CURSOR FOR rs;
        FOR r IN c DO graph_file_count := r.C; END FOR;
    EXCEPTION WHEN OTHER THEN graph_file_count := 0;
    END;
    IF (:graph_file_count > 0) THEN rebuild_flag := 'false'; ELSE rebuild_flag := 'true'; END IF;

    EXECUTE IMMEDIATE 'CREATE COMPUTE POOL IF NOT EXISTS ' || :pool_name ||
        ' MIN_NODES = 1 MAX_NODES = 1 INSTANCE_FAMILY = ' || :instance_family ||
        ' AUTO_SUSPEND_SECS = 3600 AUTO_RESUME = TRUE' ||
        ' COMMENT = ''{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"multi-region","region":"' || :P_REGION || '"}}''';

    ors_spec := OPENROUTESERVICE_APP.CORE.BUILD_ORS_SERVICE_SPEC(:P_REGION, :P_COMPUTE_SIZE, :rebuild_flag);

    EXECUTE IMMEDIATE 'DROP SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.' || svc_name;
    create_sql := 'CREATE SERVICE OPENROUTESERVICE_APP.CORE.' || svc_name || ' IN COMPUTE POOL ' || :pool_name || ' FROM SPECIFICATION ''' || ors_spec || ''' MIN_INSTANCES = 1 MAX_INSTANCES = 1 AUTO_SUSPEND_SECS = 0 COMMENT = ''{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"multi-region"}}''';
    EXECUTE IMMEDIATE :create_sql;

    UPDATE OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP
    SET STATUS = 'DEPLOYED', COMPUTE_SIZE = :P_COMPUTE_SIZE, UPDATED_AT = CURRENT_TIMESTAMP()
    WHERE REGION = :P_REGION;

    RETURN 'Region ORS service created for ' || :P_REGION || ' (REBUILD_GRAPHS=' || :rebuild_flag || ', existing graph files: ' || :graph_file_count || ')';
END;
$$;

-- Flip REBUILD_GRAPHS for an existing region service via ALTER SERVICE FROM SPECIFICATION.
-- The new env var only takes effect on the next container start (suspend/resume or explicit cycle),
-- which is the desired behavior: no mid-build disruption.
CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.SET_REBUILD_GRAPHS_FLAG(P_REGION VARCHAR, P_REBUILD VARCHAR)
RETURNS STRING
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"multi-region"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    svc_name VARCHAR;
    compute_size VARCHAR DEFAULT 'M';
    ors_spec VARCHAR;
    rs RESULTSET;
BEGIN
    svc_name := 'ORS_SERVICE_' || UPPER(:P_REGION);

    rs := (SELECT COALESCE(COMPUTE_SIZE, 'M') AS CS FROM OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP WHERE REGION = :P_REGION);
    LET c CURSOR FOR rs;
    FOR r IN c DO compute_size := r.CS; END FOR;

    ors_spec := OPENROUTESERVICE_APP.CORE.BUILD_ORS_SERVICE_SPEC(:P_REGION, :compute_size, :P_REBUILD);

    EXECUTE IMMEDIATE 'ALTER SERVICE OPENROUTESERVICE_APP.CORE.' || svc_name ||
        ' FROM SPECIFICATION ''' || ors_spec || '''';

    RETURN 'REBUILD_GRAPHS set to ' || LOWER(:P_REBUILD) || ' for ' || :P_REGION ||
           ' (takes effect on next container start)';
END;
$$;

-- Force a full graph rebuild for a region (PBF update / corruption recovery).
-- Flips REBUILD_GRAPHS=true, cycles the service, waits for service_ready, then flips back to false.
CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.REBUILD_REGION_GRAPHS(P_REGION VARCHAR)
RETURNS STRING
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"multi-region"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    svc_name VARCHAR;
    status_raw VARCHAR;
    status_json VARIANT;
    profile_count INTEGER DEFAULT 0;
    rs RESULTSET;
BEGIN
    svc_name := 'ORS_SERVICE_' || UPPER(:P_REGION);

    CALL OPENROUTESERVICE_APP.CORE.SET_REBUILD_GRAPHS_FLAG(:P_REGION, 'true');

    -- Disable auto time-based suspension for the duration of the rebuild so the
    -- service cannot auto-suspend while graphs are being computed.
    BEGIN
        EXECUTE IMMEDIATE 'ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.' || svc_name || ' SET AUTO_SUSPEND_SECS = 0';
    EXCEPTION WHEN OTHER THEN NULL;
    END;

    EXECUTE IMMEDIATE 'ALTER SERVICE OPENROUTESERVICE_APP.CORE.' || svc_name || ' SUSPEND';
    EXECUTE IMMEDIATE 'SELECT SYSTEM$WAIT(5)';
    EXECUTE IMMEDIATE 'ALTER SERVICE OPENROUTESERVICE_APP.CORE.' || svc_name || ' RESUME';

    FOR i IN 1 TO 60 DO
        EXECUTE IMMEDIATE 'SELECT SYSTEM$WAIT(30)';
        BEGIN
            rs := (EXECUTE IMMEDIATE 'SELECT OPENROUTESERVICE_APP.CORE.ORS_STATUS(''' || :P_REGION || ''')::VARCHAR AS S');
            LET c CURSOR FOR rs;
            FOR r IN c DO status_raw := r.S; END FOR;
            status_json := TRY_PARSE_JSON(:status_raw);
            IF (status_json:service_ready::BOOLEAN = TRUE AND status_json:profiles IS NOT NULL) THEN
                profile_count := ARRAY_SIZE(OBJECT_KEYS(status_json:profiles));
                IF (:profile_count > 0) THEN BREAK; END IF;
            END IF;
        EXCEPTION WHEN OTHER THEN NULL;
        END;
    END FOR;

    CALL OPENROUTESERVICE_APP.CORE.SET_REBUILD_GRAPHS_FLAG(:P_REGION, 'false');

    -- Restore normal auto-suspend now that the rebuild is complete (success or timeout).
    BEGIN
        EXECUTE IMMEDIATE 'ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.' || svc_name || ' SET AUTO_SUSPEND_SECS = 14400';
    EXCEPTION WHEN OTHER THEN NULL;
    END;

    RETURN 'Rebuild complete for ' || :P_REGION || ' (' || :profile_count || ' profile(s) ready); REBUILD_GRAPHS flipped back to false';
EXCEPTION
    WHEN OTHER THEN
        LET err_msg VARCHAR := SQLERRM;
        BEGIN
            EXECUTE IMMEDIATE 'ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.' || svc_name || ' SET AUTO_SUSPEND_SECS = 14400';
        EXCEPTION WHEN OTHER THEN NULL;
        END;
        RETURN 'Rebuild failed for ' || :P_REGION || ': ' || :err_msg;
END;
$$;

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.create_region_functions(P_REGION VARCHAR)
RETURNS STRING
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"2.0","attributes":{"component":"multi-region"}}'
EXECUTE AS OWNER
AS
$$
BEGIN
    RETURN 'No-op: per-region function aliases removed in v2.0. Use region parameter instead, e.g. SELECT * FROM TABLE(OPENROUTESERVICE_APP.CORE.DIRECTIONS(method, start, end, ''' || :P_REGION || '''))';
END;
$$;

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.write_ors_config(P_REGION VARCHAR, P_PBF_FILE VARCHAR, P_PROFILES VARCHAR, P_COMPUTE_SIZE VARCHAR)
RETURNS STRING
LANGUAGE PYTHON
RUNTIME_VERSION = '3.11'
PACKAGES = ('snowflake-snowpark-python')
HANDLER = 'run'
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"multi-region"}}'
EXECUTE AS OWNER
AS
$$
def run(session, p_region, p_pbf_file, p_profiles, p_compute_size):
    import tempfile, os

    thread_config = {
        'S':  {'init_threads': 1, 'ch_threads': 4, 'lm_threads': 4},
        'M':  {'init_threads': 1, 'ch_threads': 10, 'lm_threads': 8},
        'L':  {'init_threads': 1, 'ch_threads': 20, 'lm_threads': 14},
        'XL': {'init_threads': 1, 'ch_threads': 20, 'lm_threads': 14},
    }
    tc = thread_config.get(p_compute_size, thread_config['M'])

    profiles_list = [p.strip() for p in p_profiles.split(',') if p.strip()]
    all_profiles = [
        'driving-car', 'driving-hgv', 'cycling-regular', 'cycling-road',
        'cycling-mountain', 'cycling-electric', 'foot-walking', 'foot-hiking', 'wheelchair'
    ]

    profile_lines = []
    for p in all_profiles:
        enabled = 'true' if p in profiles_list else 'false'
        profile_lines.append('      ' + p + ':')
        profile_lines.append('        enabled: ' + enabled)
        if enabled == 'true':
            profile_lines.append('        build:')
            profile_lines.append('          preparation:')
            profile_lines.append('            methods:')
            profile_lines.append('              ch:')
            profile_lines.append('                enabled: true')
            profile_lines.append('                threads: ' + str(tc['ch_threads']))
            profile_lines.append('              lm:')
            profile_lines.append('                enabled: true')
            profile_lines.append('                threads: ' + str(tc['lm_threads']))

    all_profiles_str = ', '.join(all_profiles)
    lines = [
        'ors:',
        '  engine:',
        '    init_threads: ' + str(tc['init_threads']),
        '    profile_default:',
        '      build:',
        '        source_file: /home/ors/files/' + p_pbf_file,
        '        instructions: false',
        '      service:',
        '        maximum_distance: 1500000',
        '        maximum_distance_dynamic_weights: 1500000',
        '        maximum_distance_avoid_areas: 1500000',
        '        maximum_distance_alternative_routes: 1500000',
        '        maximum_distance_round_trip_routes: 1500000',
        '        maximum_visited_nodes: 100000000',
        '    profiles:',
    ]
    yaml_content = '\n'.join(lines) + '\n' + '\n'.join(profile_lines) + '\n'
    yaml_content += '\n'.join([
        '  endpoints:',
        '    matrix:',
        '      maximum_visited_nodes: 100000000',
        '      maximum_routes: 250000',
        '    isochrones:',
        '      maximum_locations: 2',
        '      maximum_intervals: 10',
        '      maximum_range_distance:',
        '        - profiles: ' + all_profiles_str,
        '          value: 1500000',
        '      maximum_range_time:',
        '        - profiles: ' + all_profiles_str,
        '          value: 18000',
        '',
    ])

    tmpdir = tempfile.mkdtemp()
    config_path = os.path.join(tmpdir, 'ors-config.yml')
    with open(config_path, 'w') as f:
        f.write(yaml_content)

    try:
        stage_path = '@OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/' + p_region + '/'
        session.file.put(config_path, stage_path, auto_compress=False, overwrite=True)
    finally:
        os.unlink(config_path)
        os.rmdir(tmpdir)

    return 'ORS config written for ' + p_region + ' with profiles: ' + p_profiles + ', threads: init=' + str(tc['init_threads']) + ' ch=' + str(tc['ch_threads']) + ' lm=' + str(tc['lm_threads'])
$$;

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.resume_region_ors(P_REGION VARCHAR)
RETURNS STRING
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"multi-region"}}'
EXECUTE AS OWNER
AS
$$
BEGIN
    LET svc_name VARCHAR := 'ORS_SERVICE_' || UPPER(:P_REGION);
    EXECUTE IMMEDIATE 'ALTER SERVICE OPENROUTESERVICE_APP.CORE.' || svc_name || ' RESUME';
    BEGIN
        ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.routing_gateway_service RESUME;
    EXCEPTION WHEN OTHER THEN NULL;
    END;
    RETURN 'Resumed ORS services for ' || :P_REGION;
END;
$$;

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.drop_region_ors(P_REGION VARCHAR)
RETURNS STRING
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"multi-region"}}'
EXECUTE AS OWNER
AS
$$
BEGIN
    LET svc_name VARCHAR := 'ORS_SERVICE_' || UPPER(:P_REGION);

    EXECUTE IMMEDIATE 'DROP SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.' || svc_name;

    DELETE FROM OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP WHERE REGION = :P_REGION;

    RETURN 'Dropped region ORS for ' || :P_REGION;
END;
$$;

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.LIST_REGIONS()
RETURNS STRING
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"multi-region"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    result VARCHAR;
BEGIN
    SELECT ARRAY_AGG(OBJECT_CONSTRUCT(
        'region', REGION,
        'display_name', DISPLAY_NAME,
        'status', STATUS,
        'bbox', OBJECT_CONSTRUCT('min_lat', MIN_LAT, 'max_lat', MAX_LAT, 'min_lon', MIN_LON, 'max_lon', MAX_LON)
    ))::VARCHAR INTO result
    FROM OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP;
    RETURN COALESCE(result, '[]');
END;
$$;

-- =============================================================================
-- DIAGNOSE_REGION
-- One-click diagnostic agent. Gathers a structured snapshot of build state
-- from eight read-only sources, hands it to AI_COMPLETE with a decision-tree
-- system prompt, and returns a JSON object with both natural-language
-- diagnosis (markdown) and raw context (for power users).
--
-- Used by the Region Builder UI's "Ask for status" button via the
-- /api/regions/<region>/diagnose endpoint.
-- =============================================================================
CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.DIAGNOSE_REGION(P_REGION VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"diagnostic","action":"agent"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    rs RESULTSET;
    job_json VARIANT;
    history_json VARIANT;
    service_status VARIANT;
    service_logs VARCHAR;
    ors_status VARIANT;
    task_history_json VARIANT;
    region_map_json VARIANT;
    pool_json VARIANT;
    snapshot VARIANT;
    system_prompt VARCHAR;
    llm_response VARCHAR;
    svc_full VARCHAR;
BEGIN
    svc_full := 'OPENROUTESERVICE_APP.CORE.ORS_SERVICE_' || UPPER(:P_REGION);

    -- 1. Latest provision job for this region
    BEGIN
        rs := (SELECT OBJECT_CONSTRUCT(
                   'job_id', JOB_ID, 'stage', STAGE, 'status', STATUS,
                   'message', MESSAGE, 'error_msg', ERROR_MSG,
                   'compute_size', COMPUTE_SIZE, 'instance_family', INSTANCE_FAMILY,
                   'pbf_size_gib', PBF_SIZE_GIB, 'profiles', PROFILES,
                   'created_at', CREATED_AT, 'started_at', STARTED_AT,
                   'completed_at', COMPLETED_AT,
                   'elapsed_min', DATEDIFF('second', COALESCE(STARTED_AT, CREATED_AT), CURRENT_TIMESTAMP())/60.0
               ) AS J
               FROM OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
               WHERE REGION = :P_REGION AND DISMISSED = FALSE
               ORDER BY CREATED_AT DESC LIMIT 1);
        LET cj CURSOR FOR rs;
        FOR r IN cj DO job_json := r.J; END FOR;
    EXCEPTION WHEN OTHER THEN job_json := NULL;
    END;

    -- 2. Last 3 build history rows
    BEGIN
        rs := (SELECT ARRAY_AGG(OBJECT_CONSTRUCT(
                   'build_id', BUILD_ID, 'started_at', STARTED_AT,
                   'finished_at', FINISHED_AT, 'elapsed_minutes', ELAPSED_MINUTES,
                   'exit_status', EXIT_STATUS, 'compute_size', COMPUTE_SIZE,
                   'instance_family', INSTANCE_FAMILY, 'jvm_xmx_gib', JVM_XMX_GIB,
                   'peak_rss_gib', PEAK_RSS_GIB
               )) WITHIN GROUP (ORDER BY STARTED_AT DESC) AS H
               FROM (SELECT * FROM OPENROUTESERVICE_APP.CORE.ORS_BUILD_HISTORY
                     WHERE REGION = :P_REGION ORDER BY STARTED_AT DESC LIMIT 3));
        LET ch CURSOR FOR rs;
        FOR r IN ch DO history_json := r.H; END FOR;
    EXCEPTION WHEN OTHER THEN history_json := NULL;
    END;

    -- 3. Service container status
    BEGIN
        EXECUTE IMMEDIATE 'CALL SYSTEM$GET_SERVICE_STATUS(''' || :svc_full || ''')';
        rs := (SELECT TRY_PARSE_JSON(VALUE::VARCHAR)[0] AS S
               FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())));
        LET cs CURSOR FOR rs;
        FOR r IN cs DO service_status := r.S; END FOR;
    EXCEPTION WHEN OTHER THEN service_status := NULL;
    END;

    -- 4. Last 200 lines of container logs (truncate to ~6000 chars for the LLM)
    BEGIN
        service_logs := SUBSTR(SYSTEM$GET_SERVICE_LOGS(:svc_full, '0', 'ors', 200), -6000);
    EXCEPTION WHEN OTHER THEN service_logs := NULL;
    END;

    -- 5. ORS_STATUS UDF
    BEGIN
        rs := (EXECUTE IMMEDIATE 'SELECT OPENROUTESERVICE_APP.CORE.ORS_STATUS(''' ||
               :P_REGION || ''')::VARCHAR AS S');
        LET co CURSOR FOR rs;
        FOR r IN co DO ors_status := TRY_PARSE_JSON(r.S); END FOR;
    EXCEPTION WHEN OTHER THEN ors_status := NULL;
    END;

    -- 6. Last 5 rescue TASK runs
    BEGIN
        rs := (SELECT ARRAY_AGG(OBJECT_CONSTRUCT(
                   'state', STATE, 'scheduled_time', SCHEDULED_TIME,
                   'completed_time', COMPLETED_TIME, 'error_message', ERROR_MESSAGE
               )) WITHIN GROUP (ORDER BY SCHEDULED_TIME DESC) AS T
               FROM TABLE(OPENROUTESERVICE_APP.INFORMATION_SCHEMA.TASK_HISTORY(
                   TASK_NAME => 'RESCUE_PENDING_PROVISIONS_TASK',
                   SCHEDULED_TIME_RANGE_START => DATEADD('minute', -30, CURRENT_TIMESTAMP())
               )) LIMIT 5);
        LET ct CURSOR FOR rs;
        FOR r IN ct DO task_history_json := r.T; END FOR;
    EXCEPTION WHEN OTHER THEN task_history_json := NULL;
    END;

    -- 7. REGION_ORS_MAP
    BEGIN
        rs := (SELECT OBJECT_CONSTRUCT(
                   'region', REGION, 'status', STATUS, 'compute_size', COMPUTE_SIZE,
                   'instance_family', INSTANCE_FAMILY, 'updated_at', UPDATED_AT
               ) AS M
               FROM OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP WHERE REGION = :P_REGION);
        LET cm CURSOR FOR rs;
        FOR r IN cm DO region_map_json := r.M; END FOR;
    EXCEPTION WHEN OTHER THEN region_map_json := NULL;
    END;

    -- 8. Compute pool
    BEGIN
        EXECUTE IMMEDIATE 'SHOW COMPUTE POOLS LIKE ''ORS_POOL_' || UPPER(:P_REGION) || '''';
        rs := (SELECT OBJECT_CONSTRUCT(
                   'name', "name", 'state', "state",
                   'instance_family', "instance_family", 'active_nodes', "active_nodes",
                   'auto_suspend_secs', "auto_suspend_secs"
               ) AS P
               FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) LIMIT 1);
        LET cp CURSOR FOR rs;
        FOR r IN cp DO pool_json := r.P; END FOR;
    EXCEPTION WHEN OTHER THEN pool_json := NULL;
    END;

    -- Assemble the snapshot
    snapshot := OBJECT_CONSTRUCT(
        'region', :P_REGION,
        'generated_at', CURRENT_TIMESTAMP(),
        'provision_job', :job_json,
        'build_history', :history_json,
        'service_status', :service_status,
        'ors_status', :ors_status,
        'rescue_task_history', :task_history_json,
        'region_map', :region_map_json,
        'compute_pool', :pool_json,
        'log_tail', :service_logs
    );

    -- System prompt encodes the decision tree the human operator follows.
    system_prompt :=
'You are an ORS region build diagnostic assistant for a Snowflake-native routing solution. ' ||
'The user clicked "Ask for status" on a region in the Region Builder UI. You receive a JSON ' ||
'snapshot of the build state. Return concise markdown with this structure:' || CHR(10) ||
'  - One-line "**TL;DR**" at the top.' || CHR(10) ||
'  - A short table or bullet list of key signals (phase, container restartCount, service_ready, last log time, elapsed).' || CHR(10) ||
'  - A "What is happening" paragraph (2-4 sentences).' || CHR(10) ||
'  - A "What to do" section: clear recommended action.' || CHR(10) ||
'  - An "ETA" line if a build is in progress.' || CHR(10) ||
'Decision tree:' || CHR(10) ||
'1. service_status.restartCount > 0 -> container has crashed (likely OOM if exitCode 137). ' ||
'   Recommend: dismiss the job and retry on a smaller compute size, or split profiles.' || CHR(10) ||
'2. ors_status.service_ready = true -> graph is loaded. If provision_job.status is still ' ||
'   ERROR with error_msg=graph_load_timeout, the rescue task will finalize within 2 min. ' ||
'   Recommend: wait briefly; UI will flip green automatically.' || CHR(10) ||
'3. ors_status.service_ready = false AND service_status.status = READY -> container is alive ' ||
'   and building the graph. Inspect log_tail for the latest phase:' || CHR(10) ||
'   - If logs show CoreLMPreparationHandler with N/4 progress, report which step and ETA ' ||
'     based on per-step time observed in earlier steps.' || CHR(10) ||
'   - If logs show PrepareCore (CH preparation), report the contraction progress (nodes ' ||
'     remaining, shortcuts built) and ETA.' || CHR(10) ||
'   - If logs are silent for >30 minutes AND no fresh activity, raise concern.' || CHR(10) ||
'4. provision_job.error_msg = graph_load_timeout AND container alive -> wrapper exited but ' ||
'   the build continues; rescue task will close the loop. Reassure user.' || CHR(10) ||
'5. provision_job.error_msg = container_crash_during_build -> OOM. Recommend retry on a ' ||
'   smaller compute or different family.' || CHR(10) ||
'6. compute_pool.instance_family does not match region_map.instance_family -> stale pool ' ||
'   from earlier failed attempt. The patched create_region_ors_service should reconcile on ' ||
'   next provision.' || CHR(10) ||
'7. provision_job is null -> no provision attempt found. Recommend deploying.' || CHR(10) ||
'Be specific. Quote numeric values from the snapshot. Do not invent data; if a field is null, ' ||
'say so. Keep total output under 300 words.';

    -- Call Cortex AI to summarize. claude-4-sonnet has the deepest reasoning for this kind
    -- of correlation; swap to claude-3-5-haiku for cheaper but adequate responses.
    BEGIN
        llm_response := AI_COMPLETE(
            'claude-4-sonnet',
            :system_prompt || CHR(10) || CHR(10) ||
            'Snapshot:' || CHR(10) || TO_VARCHAR(:snapshot)
        );
    EXCEPTION WHEN OTHER THEN
        llm_response := '**Diagnostic agent unavailable.** Raw snapshot below.\n\n' ||
                        '```json\n' || TO_VARCHAR(:snapshot) || '\n```';
    END;

    RETURN OBJECT_CONSTRUCT(
        'region', :P_REGION,
        'generated_at', CURRENT_TIMESTAMP(),
        'markdown', :llm_response,
        'raw_snapshot', :snapshot
    )::VARCHAR;
END;
$$;
