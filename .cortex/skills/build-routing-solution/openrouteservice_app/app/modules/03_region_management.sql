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
        -- Cost guard: if the service either does not exist yet OR is not in
        -- READY status, suspend it. A service in READY status is mid-build
        -- and protected by the same contract as the fall-through path
        -- (lines 229-239) — leave it alone for the operator to inspect via
        -- DIAGNOSE_REGION. See cost-guard-v3-head-aligned.plan.md.
        LET svc_state VARCHAR DEFAULT '';
        BEGIN
            EXECUTE IMMEDIATE 'SHOW SERVICES LIKE ''ORS_SERVICE_'
                || UPPER(:P_REGION) || ''' IN SCHEMA OPENROUTESERVICE_APP.CORE';
            LET rs2 RESULTSET := (SELECT "status" AS S
                                  FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) LIMIT 1);
            LET csc CURSOR FOR rs2;
            FOR r IN csc DO svc_state := COALESCE(r.S, ''); END FOR;
        EXCEPTION WHEN OTHER THEN svc_state := '';
        END;
        IF (:svc_state IN ('FAILED', 'PENDING', 'SUSPENDED', '')) THEN
            BEGIN
                EXECUTE IMMEDIATE 'ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ORS_SERVICE_'
                    || UPPER(:P_REGION) || ' SUSPEND';
            EXCEPTION WHEN OTHER THEN NULL;
            END;
            BEGIN
                INSERT INTO OPENROUTESERVICE_APP.CORE.COST_GUARD_LOG (REGION, ACTION, FIRED_AT, REASON)
                VALUES (:P_REGION, 'wrapper_exception_suspend', CURRENT_TIMESTAMP(),
                        'svc_state=' || :svc_state || '; err=' || :err_msg);
            EXCEPTION WHEN OTHER THEN NULL;
            END;
        END IF;
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
-- COST_GUARD_LOG
-- Audit trail for cost-guard actions taken by the wrapper EXCEPTION block.
-- Fires only when the wrapper raises an exception AND the service is not in
-- READY status (i.e. no useful build is in progress). Strictly additive: never
-- contradicts the fall-through path which marks STATUS=COMPLETE while the
-- container keeps building.
-- =============================================================================
CREATE TABLE IF NOT EXISTS OPENROUTESERVICE_APP.CORE.COST_GUARD_LOG (
    REGION VARCHAR,
    ACTION VARCHAR,
    FIRED_AT TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP(),
    REASON VARCHAR
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"cost-guard","action":"audit"}}';

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
