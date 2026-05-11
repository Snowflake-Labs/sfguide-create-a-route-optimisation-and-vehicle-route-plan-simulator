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
    DISMISSED BOOLEAN DEFAULT FALSE,
    -- Captured at provision time so the row is self-describing without
    -- joining REGION_ORS_MAP. PBF_SIZE_GIB is recorded after PBF download.
    COMPUTE_SIZE VARCHAR,
    INSTANCE_FAMILY VARCHAR,
    PBF_SIZE_GIB FLOAT
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"provisioner"}}';

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.PROVISION_REGION_WRAPPER(
    P_JOB_ID VARCHAR,
    P_REGION VARCHAR,
    P_DISPLAY_NAME VARCHAR,
    P_PBF_URL VARCHAR,
    P_MIN_LAT FLOAT, P_MAX_LAT FLOAT, P_MIN_LON FLOAT, P_MAX_LON FLOAT,
    P_PROFILES VARCHAR,
    P_COMPUTE_SIZE VARCHAR,
    P_FORCE_REDOWNLOAD BOOLEAN DEFAULT FALSE
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
    dl_status VARCHAR DEFAULT '';
    status_raw VARCHAR;
    status_json VARIANT;
    profile_count INTEGER DEFAULT 0;
    rs RESULTSET;
    -- Build-history bookkeeping: one BUILD_ID per job, used by every UPDATE
    -- below so retries on the same JOB_ID overwrite a single history row.
    build_id VARCHAR DEFAULT UUID_STRING();
    xmx_gib NUMBER DEFAULT 0;
    peak_rss FLOAT DEFAULT NULL;
    graph_gib FLOAT DEFAULT NULL;
    resolved_family VARCHAR DEFAULT '';
    pbf_gib FLOAT DEFAULT NULL;
BEGIN
    -- JVM heap mirrors the BUILD_ORS_SERVICE_SPEC heap CASE so build history
    -- captures the actual headroom the JVM was given.
    xmx_gib := CASE UPPER(:P_COMPUTE_SIZE)
        WHEN 'XXL' THEN 1100 WHEN 'L' THEN 700
        WHEN 'S' THEN 20 ELSE 700 END;

    INSERT INTO OPENROUTESERVICE_APP.CORE.ORS_BUILD_HISTORY
        (BUILD_ID, JOB_ID, REGION, PBF_URL, PROFILES, COMPUTE_SIZE,
         JVM_XMX_GIB, STARTED_AT, EXIT_STATUS, ORS_VERSION)
    VALUES
        (:build_id, :P_JOB_ID, :P_REGION, :P_PBF_URL, :P_PROFILES, :P_COMPUTE_SIZE,
         :xmx_gib, CURRENT_TIMESTAMP(), 'IN_PROGRESS', 'v9.0.0');

    UPDATE OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
    SET COMPUTE_SIZE = :P_COMPUTE_SIZE
    WHERE JOB_ID = :P_JOB_ID;

    UPDATE OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
    SET STATUS='RUNNING', STAGE='DOWNLOADING', STARTED_AT=CURRENT_TIMESTAMP(),
        MESSAGE='Inserting region metadata and downloading PBF file...'
    WHERE JOB_ID = :P_JOB_ID;

    BEGIN
        ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.downloader SET AUTO_SUSPEND_SECS = 0;
    EXCEPTION WHEN OTHER THEN NULL;
    END;

    BEGIN
        ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.downloader RESUME;
    EXCEPTION WHEN OTHER THEN NULL;
    END;

    FOR i IN 1 TO 9 DO
        BEGIN
            EXECUTE IMMEDIATE 'SHOW SERVICES LIKE ''DOWNLOADER'' IN SCHEMA OPENROUTESERVICE_APP.CORE';
            LET rs_dl RESULTSET := (EXECUTE IMMEDIATE 'SELECT "status" AS S FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))');
            LET c_dl CURSOR FOR rs_dl;
            FOR r IN c_dl DO dl_status := r.S; END FOR;
            IF (:dl_status = 'RUNNING') THEN
                BREAK;
            END IF;
        EXCEPTION WHEN OTHER THEN NULL;
        END;
        EXECUTE IMMEDIATE 'SELECT SYSTEM$WAIT(10)';
    END FOR;

    MERGE INTO OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP t USING (
        SELECT :P_REGION AS REGION
    ) s ON t.REGION = s.REGION
    WHEN NOT MATCHED THEN INSERT (REGION, DISPLAY_NAME, PBF_URL, MIN_LAT, MAX_LAT, MIN_LON, MAX_LON, STATUS)
        VALUES (:P_REGION, :P_DISPLAY_NAME, :P_PBF_URL, :P_MIN_LAT, :P_MAX_LAT, :P_MIN_LON, :P_MAX_LON, 'PROVISIONING');

    pbf_filename := SPLIT_PART(:P_PBF_URL, '/', -1);
    IF (pbf_filename IS NULL OR pbf_filename = '') THEN
        pbf_filename := 'data.osm.pbf';
    END IF;

    -- Probe stage for cached PBF. Skip the download call entirely when the
    -- file exists with non-zero size and the caller did not request a forced
    -- refresh. Geofabrik refreshes weekly, so users can pass
    -- P_FORCE_REDOWNLOAD=TRUE to pull a fresh copy.
    LET pbf_cached_bytes INTEGER DEFAULT 0;
    BEGIN
        EXECUTE IMMEDIATE 'LIST @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/' || :P_REGION || '/' || :pbf_filename;
        LET rs_pbf RESULTSET := (SELECT COALESCE("size", 0)::INTEGER AS B
                                 FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) LIMIT 1);
        LET c_pbf CURSOR FOR rs_pbf;
        FOR r IN c_pbf DO pbf_cached_bytes := r.B; END FOR;
    EXCEPTION WHEN OTHER THEN pbf_cached_bytes := 0;
    END;

    IF (:pbf_cached_bytes > 0 AND NOT :P_FORCE_REDOWNLOAD) THEN
        UPDATE OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
        SET MESSAGE = 'PBF cache hit (' || ROUND(:pbf_cached_bytes / 1048576.0, 1) ||
                      ' MB on stage). Skipping download.',
            PBF_SIZE_GIB = :pbf_cached_bytes / 1073741824.0
        WHERE JOB_ID = :P_JOB_ID;
        UPDATE OPENROUTESERVICE_APP.CORE.ORS_BUILD_HISTORY
        SET PBF_SIZE_GIB = :pbf_cached_bytes / 1073741824.0
        WHERE BUILD_ID = :build_id;
        BEGIN
            ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.downloader SET AUTO_SUSPEND_SECS = 14400;
        EXCEPTION WHEN OTHER THEN NULL;
        END;
    ELSE
        BEGIN
            EXECUTE IMMEDIATE 'SELECT OPENROUTESERVICE_APP.CORE.DOWNLOAD(''ors_spcs_stage/' || :P_REGION || ''', ''' || :pbf_filename || ''', ''' || :P_PBF_URL || ''')';
        EXCEPTION WHEN OTHER THEN
            LET dl_err STRING := 'PBF download failed: ' || SQLERRM;
            SYSTEM$LOG_INFO(dl_err);
            BEGIN
                ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.downloader SET AUTO_SUSPEND_SECS = 14400;
            EXCEPTION WHEN OTHER THEN NULL;
            END;
            -- Cost guard parity (download path): if a per-region service exists
            -- AND is not in READY status, suspend it. Service almost certainly
            -- doesn't exist yet (download runs before CREATE SERVICE) so this is
            -- a no-op in normal flow, but the audit row tells us the path fired.
            LET dl_svc_state VARCHAR DEFAULT '';
            BEGIN
                EXECUTE IMMEDIATE 'SHOW SERVICES LIKE ''ORS_SERVICE_'
                    || UPPER(:P_REGION) || ''' IN SCHEMA OPENROUTESERVICE_APP.CORE';
                LET dl_rs RESULTSET := (SELECT "status" AS S
                                        FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) LIMIT 1);
                LET dl_csc CURSOR FOR dl_rs;
                FOR r IN dl_csc DO dl_svc_state := COALESCE(r.S, ''); END FOR;
            EXCEPTION WHEN OTHER THEN dl_svc_state := '';
            END;
            IF (:dl_svc_state IN ('FAILED', 'PENDING', 'SUSPENDED', '')) THEN
                BEGIN
                    EXECUTE IMMEDIATE 'ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ORS_SERVICE_'
                        || UPPER(:P_REGION) || ' SUSPEND';
                EXCEPTION WHEN OTHER THEN NULL;
                END;
                BEGIN
                    INSERT INTO OPENROUTESERVICE_APP.CORE.COST_GUARD_LOG (REGION, ACTION, FIRED_AT, REASON)
                    VALUES (:P_REGION, 'pbf_download_failure_suspend', CURRENT_TIMESTAMP(),
                            'svc_state=' || :dl_svc_state || '; err=' || :dl_err);
                EXCEPTION WHEN OTHER THEN NULL;
                END;
            END IF;
            UPDATE OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS SET STATUS='FAILED', MESSAGE=:dl_err WHERE JOB_ID = :P_JOB_ID;
            UPDATE OPENROUTESERVICE_APP.CORE.ORS_BUILD_HISTORY
            SET FINISHED_AT = CURRENT_TIMESTAMP(),
                ELAPSED_MINUTES = TIMESTAMPDIFF(SECOND, STARTED_AT, CURRENT_TIMESTAMP()) / 60.0,
                EXIT_STATUS = 'ERROR',
                LOG_URI = :dl_err
            WHERE BUILD_ID = :build_id;
            RETURN OBJECT_CONSTRUCT('status', 'FAILED', 'error', :dl_err)::VARCHAR;
        END;
    END IF;

    BEGIN
        ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.downloader SET AUTO_SUSPEND_SECS = 14400;
    EXCEPTION WHEN OTHER THEN NULL;
    END;

    UPDATE OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS SET STAGE='CONFIGURING', MESSAGE='Writing ORS configuration...' WHERE JOB_ID = :P_JOB_ID;
    CALL OPENROUTESERVICE_APP.CORE.WRITE_ORS_CONFIG(:P_REGION, :pbf_filename, :P_PROFILES, :P_COMPUTE_SIZE);

    UPDATE OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS SET STAGE='STARTING_SERVICE', MESSAGE='Creating ORS service...' WHERE JOB_ID = :P_JOB_ID;
    CALL OPENROUTESERVICE_APP.CORE.CREATE_REGION_ORS_SERVICE(:P_REGION, :P_COMPUTE_SIZE);

    -- Capture the resolved instance family on both the job row and the
    -- in-progress history row now that create_region_ors_service has decided.
    BEGIN
        rs := (SELECT INSTANCE_FAMILY AS IF FROM OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP WHERE REGION = :P_REGION);
        LET cf CURSOR FOR rs;
        FOR r IN cf DO resolved_family := COALESCE(r.IF, ''); END FOR;
    EXCEPTION WHEN OTHER THEN NULL;
    END;
    UPDATE OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
    SET INSTANCE_FAMILY = :resolved_family
    WHERE JOB_ID = :P_JOB_ID;
    UPDATE OPENROUTESERVICE_APP.CORE.ORS_BUILD_HISTORY
    SET INSTANCE_FAMILY = :resolved_family
    WHERE BUILD_ID = :build_id;

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
    -- Wait ceiling scales with compute size. Country-scale HGV builds on the
    -- largest high-memory hardware routinely take 60-120 minutes; smaller
    -- regions complete in single-digit minutes. Hard-fail at the ceiling so
    -- the UI surfaces a real error instead of a soft "check ORS_STATUS".
    LET wait_iters INTEGER DEFAULT 40;       -- 30s * 40  = 20 min default (S, city builds)
    LET wait_secs  INTEGER DEFAULT 30;
    IF (:P_COMPUTE_SIZE = 'XXL') THEN wait_iters := 240; END IF;        -- 2h for continent builds
    IF (:P_COMPUTE_SIZE = 'L')   THEN wait_iters := 200; END IF;        -- 1h40m for country / sub-region builds (HIGHMEM_X64_L)
    FOR i IN 1 TO :wait_iters DO
        EXECUTE IMMEDIATE 'SELECT SYSTEM$WAIT(' || :wait_secs || ')';
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
                    -- Write success marker so create_region_ors_service can
                    -- safely reuse persisted graphs on the next deploy.
                    BEGIN
                        EXECUTE IMMEDIATE 'COPY INTO @OPENROUTESERVICE_APP.CORE.ORS_GRAPHS_SPCS_STAGE/' || :P_REGION ||
                            '/_BUILD_OK FROM (SELECT ''ok'') FILE_FORMAT = (TYPE = CSV) SINGLE = TRUE OVERWRITE = TRUE';
                    EXCEPTION WHEN OTHER THEN NULL;
                    END;
                    UPDATE OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
                    SET STATUS='COMPLETE', STAGE='READY',
                        MESSAGE='Region provisioned — ' || :profile_count || ' profile(s) ready (REBUILD_GRAPHS=false for fast resume)',
                        COMPLETED_AT=CURRENT_TIMESTAMP()
                    WHERE JOB_ID = :P_JOB_ID;
                    -- Best-effort peak RSS for telemetry; NULL on failure.
                    -- Inlined here because SYSTEM$GET_SERVICE_STATUS requires a
                    -- constant argument and cannot be wrapped in a reusable UDF.
                    BEGIN
                        LET svc_full VARCHAR := 'OPENROUTESERVICE_APP.CORE.ORS_SERVICE_' || UPPER(:P_REGION);
                        EXECUTE IMMEDIATE 'CALL SYSTEM$GET_SERVICE_STATUS(''' || :svc_full || ''')';
                        rs := (SELECT TRY_CAST(
                                  TRY_PARSE_JSON(VALUE::VARCHAR)[0]:containerStatus:peakMemoryGiB::VARCHAR
                                  AS FLOAT) AS V
                               FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())));
                        LET c_rss CURSOR FOR rs;
                        FOR r IN c_rss DO peak_rss := r.V; END FOR;
                    EXCEPTION WHEN OTHER THEN peak_rss := NULL;
                    END;
                    UPDATE OPENROUTESERVICE_APP.CORE.ORS_BUILD_HISTORY
                    SET FINISHED_AT = CURRENT_TIMESTAMP(),
                        ELAPSED_MINUTES = TIMESTAMPDIFF(SECOND, STARTED_AT, CURRENT_TIMESTAMP()) / 60.0,
                        EXIT_STATUS = 'SUCCESS',
                        PEAK_RSS_GIB = :peak_rss
                    WHERE BUILD_ID = :build_id;
                    -- Auto-downsize the runtime service to a smaller tier so the user
                    -- does not pay 24/7 build-tier rates for steady-state querying.
                    -- Only applies to non-city builds (S is already minimal). Mapping
                    -- is in DOWNSIZE_REGION_AFTER_BUILD: L -> HIGHMEM_X64_M, XXL ->
                    -- MEM_X64_G2_64. Best-effort; failure is non-fatal so the build
                    -- still reports COMPLETE even if the downsize hits a transient.
                    IF (UPPER(:P_COMPUTE_SIZE) IN ('L','XXL')) THEN
                        BEGIN
                            CALL OPENROUTESERVICE_APP.CORE.DOWNSIZE_REGION_AFTER_BUILD(:P_REGION, :P_COMPUTE_SIZE);
                        EXCEPTION WHEN OTHER THEN NULL;
                        END;
                    END IF;
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
    -- Wait loop exhausted without service_ready=true. Treat as deployment
    -- failure so the UI surfaces the problem instead of reporting green over
    -- an OOM-loop or stuck graph build. RECOMMEND_RETRY_STRATEGY will see
    -- EXIT_STATUS=TIMEOUT and recommend SPLIT_PROFILES on the next attempt.
    UPDATE OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP SET STATUS='FAILED' WHERE REGION = :P_REGION;
    UPDATE OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
    SET STATUS='ERROR', STAGE='BUILDING_GRAPH',
        MESSAGE='ORS service did not become ready within timeout. Check service logs and ORS_BUILD_HISTORY.',
        ERROR_MSG='graph_load_timeout',
        COMPLETED_AT=CURRENT_TIMESTAMP()
    WHERE JOB_ID = :P_JOB_ID;
    UPDATE OPENROUTESERVICE_APP.CORE.ORS_BUILD_HISTORY
    SET FINISHED_AT = CURRENT_TIMESTAMP(),
        ELAPSED_MINUTES = TIMESTAMPDIFF(SECOND, STARTED_AT, CURRENT_TIMESTAMP()) / 60.0,
        EXIT_STATUS = 'TIMEOUT'
    WHERE BUILD_ID = :build_id;
    RETURN 'Job ' || :P_JOB_ID || ' failed: ORS service did not load graphs within timeout';

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
        -- Heuristic: surface OOM separately so RECOMMEND_RETRY_STRATEGY can
        -- recommend SPLIT_PROFILES instead of REBUILD_SAME.
        UPDATE OPENROUTESERVICE_APP.CORE.ORS_BUILD_HISTORY
        SET FINISHED_AT = CURRENT_TIMESTAMP(),
            ELAPSED_MINUTES = TIMESTAMPDIFF(SECOND, STARTED_AT, CURRENT_TIMESTAMP()) / 60.0,
            EXIT_STATUS = CASE
                WHEN UPPER(:err_msg) LIKE '%OUT OF MEMORY%' OR UPPER(:err_msg) LIKE '%OOM%'
                  OR UPPER(:err_msg) LIKE '%JAVA HEAP SPACE%' THEN 'OOM'
                ELSE 'ERROR' END,
            LOG_URI = :err_msg
        WHERE BUILD_ID = :build_id;
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
    COMPUTE_SIZE VARCHAR DEFAULT 'XXL',
    INSTANCE_FAMILY VARCHAR,
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

-- =============================================================================
-- RESOLVE_LARGEST_HIGHMEM_FAMILY
-- Probes SHOW COMPUTE POOL INSTANCE FAMILIES at runtime and returns the
-- largest high-memory family available in the current cloud + region.
-- The user-mandated rule is: any non-city region runs on the biggest box this
-- account can get, so a single graph build never loses hours of work to OOM.
-- Preference order:
--   1. MEM_X64_G2_192   (AWS/Azure GA, 188 vCPU / 1436 GB)
--   2. HIGHMEM_X64_L    (any cloud, 124 vCPU / 984 GB)
--   3. MEM_X64_G2_64    (AWS/Azure GA, 60 vCPU / 492 GB)
--   4. HIGHMEM_X64_SL   (GCP, 92 vCPU / 654 GB) -- if exposed
--   5. HIGHMEM_X64_M    (any cloud, 28 vCPU / 240 GB) -- last resort
-- =============================================================================
CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.RESOLVE_LARGEST_HIGHMEM_FAMILY()
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"multi-region","action":"resolver"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    chosen VARCHAR DEFAULT NULL;
    rs RESULTSET;
BEGIN
    EXECUTE IMMEDIATE 'SHOW COMPUTE POOL INSTANCE FAMILIES';
    rs := (
        SELECT "name" AS NAME
        FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
        WHERE "name" IN (
            'MEM_X64_G2_192','HIGHMEM_X64_L','MEM_X64_G2_64',
            'HIGHMEM_X64_SL','HIGHMEM_X64_M'
        )
        ORDER BY ARRAY_POSITION("name"::VARIANT, ARRAY_CONSTRUCT(
            'MEM_X64_G2_192','HIGHMEM_X64_L','MEM_X64_G2_64',
            'HIGHMEM_X64_SL','HIGHMEM_X64_M'
        ))
        LIMIT 1
    );
    LET c CURSOR FOR rs;
    FOR r IN c DO chosen := r.NAME; END FOR;

    -- Final fallback if SHOW returned no rows or none of the preferred families
    -- were present (older accounts, restricted regions): use HIGHMEM_X64_M, the
    -- previous-gen family that has been available everywhere since SPCS GA.
    IF (:chosen IS NULL) THEN
        chosen := 'HIGHMEM_X64_M';
    END IF;
    RETURN :chosen;
END;
$$;

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
    CASE UPPER(P_COMPUTE_SIZE) WHEN 'XXL' THEN '110G' WHEN 'L' THEN '70G' WHEN 'S' THEN '2G' ELSE '70G' END ||
    '","XMX":"' ||
    CASE UPPER(P_COMPUTE_SIZE) WHEN 'XXL' THEN '1100G' WHEN 'L' THEN '700G' WHEN 'S' THEN '20G' ELSE '700G' END ||
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

    -- For any non-city tier, resolve the LARGEST high-memory family available
    -- in this cloud + region at runtime. The user-mandated rule is: anything
    -- bigger than a city must run on the biggest box this account can get, so
    -- a single graph build never loses hours of work to OOM. The S tier is the
    -- only level-driven hardcoded family because cities never need high-mem.
    -- Three-tier model: S (city) | L (country/sub-region, HIGHMEM_X64_L) | XXL (continent, largest available high-mem)
    -- Legacy CPU_X64 tiers (M / XL with CPU_X64_SL / HIGHMEM_X64_M) were removed: their heap was too small for
    -- country builds and caused OOM-kill loops. Any unrecognized size resolves to XXL (largest available) -- never
    -- silently downgrade a non-city build.
    IF (:P_COMPUTE_SIZE = 'S') THEN
        instance_family := 'GEN_X64_G2_8';
    ELSEIF (:P_COMPUTE_SIZE = 'L') THEN
        instance_family := 'HIGHMEM_X64_L';     -- 124 vCPU / 984 GB / ~700 G heap (country / sub-region builds)
    ELSEIF (:P_COMPUTE_SIZE = 'XXL') THEN
        CALL OPENROUTESERVICE_APP.CORE.RESOLVE_LARGEST_HIGHMEM_FAMILY() INTO :instance_family;
    ELSE
        -- Default: any unrecognized non-city size resolves to the largest
        -- available family. Never silently downgrade a non-city build.
        CALL OPENROUTESERVICE_APP.CORE.RESOLVE_LARGEST_HIGHMEM_FAMILY() INTO :instance_family;
    END IF;

    -- Pre-flight: confirm the resolved family actually exists. Fail fast with a
    -- clear error instead of a cryptic CREATE COMPUTE POOL failure.
    BEGIN
        EXECUTE IMMEDIATE 'SHOW COMPUTE POOL INSTANCE FAMILIES';
        LET rs_chk RESULTSET := (SELECT COUNT(*) AS C
                                 FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
                                 WHERE "name" = :instance_family);
        LET c_chk CURSOR FOR rs_chk;
        LET family_count INTEGER DEFAULT 0;
        FOR r IN c_chk DO family_count := r.C; END FOR;
        IF (:family_count = 0) THEN
            RETURN 'ERROR: instance family ' || :instance_family ||
                   ' is not available in this cloud/region. Provisioning aborted for ' ||
                   :P_REGION || '. Contact Snowflake support to enable a larger high-memory family.';
        END IF;
    EXCEPTION WHEN OTHER THEN NULL;
    END;

    -- Probe graphs stage for the success marker (_BUILD_OK) written by
    -- PROVISION_REGION_WRAPPER on a clean build. Reuse persisted graphs ONLY
    -- when the marker is present; otherwise treat the stage as dirty
    -- (partial / corrupt artifacts from a prior failed build) and purge it
    -- so ORS does not try to load incomplete graphs.
    LET marker_count INTEGER DEFAULT 0;
    BEGIN
        EXECUTE IMMEDIATE 'LIST @OPENROUTESERVICE_APP.CORE.ORS_GRAPHS_SPCS_STAGE/' || :P_REGION || '/_BUILD_OK';
        rs := (SELECT COUNT(*) AS C FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())));
        LET c_mk CURSOR FOR rs;
        FOR r IN c_mk DO marker_count := r.C; END FOR;
    EXCEPTION WHEN OTHER THEN marker_count := 0;
    END;

    BEGIN
        EXECUTE IMMEDIATE 'LIST @OPENROUTESERVICE_APP.CORE.ORS_GRAPHS_SPCS_STAGE/' || :P_REGION || '/';
        rs := (SELECT COUNT(*) AS C FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())));
        LET c_g CURSOR FOR rs;
        FOR r IN c_g DO graph_file_count := r.C; END FOR;
    EXCEPTION WHEN OTHER THEN graph_file_count := 0;
    END;

    IF (:marker_count > 0) THEN
        rebuild_flag := 'false';
    ELSE
        -- No success marker: either first build, or prior build did not
        -- finish cleanly. Purge whatever partial files remain and rebuild.
        IF (:graph_file_count > 0) THEN
            BEGIN
                EXECUTE IMMEDIATE 'REMOVE @OPENROUTESERVICE_APP.CORE.ORS_GRAPHS_SPCS_STAGE/' || :P_REGION || '/';
            EXCEPTION WHEN OTHER THEN NULL;
            END;
        END IF;
        rebuild_flag := 'true';
    END IF;

    -- ===== Family reconciliation =====
    -- CREATE COMPUTE POOL IF NOT EXISTS will not change INSTANCE_FAMILY on
    -- an existing pool, and SPCS forbids ALTER ... INSTANCE_FAMILY. If the
    -- existing pool's family does not match the resolved family, drop the
    -- dependent service + pool here so the CREATE below recreates them on
    -- the correct family. No-op when the families already match.
    LET existing_family VARCHAR DEFAULT NULL;
    BEGIN
        EXECUTE IMMEDIATE 'SHOW COMPUTE POOLS LIKE ''' || :pool_name || '''';
        LET rs_p RESULTSET := (SELECT "instance_family" AS F
                               FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) LIMIT 1);
        LET c_p CURSOR FOR rs_p;
        FOR r IN c_p DO existing_family := r.F; END FOR;
    EXCEPTION WHEN OTHER THEN existing_family := NULL;
    END;

    IF (:existing_family IS NOT NULL AND :existing_family <> :instance_family) THEN
        BEGIN EXECUTE IMMEDIATE 'DROP SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.' || :svc_name;
        EXCEPTION WHEN OTHER THEN NULL; END;
        BEGIN EXECUTE IMMEDIATE 'ALTER COMPUTE POOL ' || :pool_name || ' STOP ALL';
        EXCEPTION WHEN OTHER THEN NULL; END;
        BEGIN EXECUTE IMMEDIATE 'ALTER COMPUTE POOL ' || :pool_name || ' SUSPEND';
        EXCEPTION WHEN OTHER THEN NULL; END;
        EXECUTE IMMEDIATE 'DROP COMPUTE POOL IF EXISTS ' || :pool_name;
    END IF;

    EXECUTE IMMEDIATE 'CREATE COMPUTE POOL IF NOT EXISTS ' || :pool_name ||
        ' MIN_NODES = 1 MAX_NODES = 1 INSTANCE_FAMILY = ' || :instance_family ||
        ' AUTO_SUSPEND_SECS = 3600 AUTO_RESUME = TRUE' ||
        ' COMMENT = ''{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"multi-region","region":"' || :P_REGION || '"}}''';

    ors_spec := OPENROUTESERVICE_APP.CORE.BUILD_ORS_SERVICE_SPEC(:P_REGION, :P_COMPUTE_SIZE, :rebuild_flag);

    EXECUTE IMMEDIATE 'DROP SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.' || svc_name;
    create_sql := 'CREATE SERVICE OPENROUTESERVICE_APP.CORE.' || svc_name || ' IN COMPUTE POOL ' || :pool_name || ' FROM SPECIFICATION ''' || ors_spec || ''' MIN_INSTANCES = 1 MAX_INSTANCES = 1 AUTO_SUSPEND_SECS = 0 COMMENT = ''{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"multi-region"}}''';
    EXECUTE IMMEDIATE :create_sql;

    UPDATE OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP
    SET STATUS = 'DEPLOYED', COMPUTE_SIZE = :P_COMPUTE_SIZE, INSTANCE_FAMILY = :instance_family, UPDATED_AT = CURRENT_TIMESTAMP()
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
        # L: HIGHMEM_X64_L (124 vCPU / 984 GB) -- country / sub-region builds.
        # Saturate cores for graph contraction; runtime tier downsized after build.
        'L':  {'init_threads': 4, 'ch_threads': 80, 'lm_threads': 40},
        # XXL: largest available high-mem family (MEM_X64_G2_192 / HIGHMEM_X64_L)
        # -- saturate the box: build all profiles in parallel and use most cores
        # for graph contraction so USA/Europe-class builds finish quickly.
        'XXL': {'init_threads': 4, 'ch_threads': 120, 'lm_threads': 60},
    }
    tc = thread_config.get(p_compute_size, thread_config['XXL'])

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

-- =============================================================================
-- SOFT_SUSPEND_REGION
-- Park a region's compute cheaply without dropping the service object. Refuses
-- if a provision job is in-flight to honor M1 (AUTO_SUSPEND_SECS=0 during
-- BUILDING_GRAPH) and M5/M10 (alive containers must be left to finish).
-- Resume is fast (~1-2 min) via M11/M12 graph reuse.
-- =============================================================================
CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.SOFT_SUSPEND_REGION(P_REGION VARCHAR)
RETURNS STRING
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"cost-guard"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    rs RESULTSET;
    in_flight_count INTEGER DEFAULT 0;
BEGIN
    LET svc_name VARCHAR := 'ORS_SERVICE_' || UPPER(:P_REGION);
    LET pool_name VARCHAR := 'ORS_POOL_' || UPPER(:P_REGION);

    rs := (SELECT COUNT(*) AS C
           FROM OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
           WHERE REGION = :P_REGION
             AND DISMISSED = FALSE
             AND STATUS = 'RUNNING'
             AND STAGE IN ('DOWNLOADING','CONFIGURING','STARTING_SERVICE',
                           'WAITING_FOR_SERVICE','BUILDING_GRAPH'));
    LET c CURSOR FOR rs;
    FOR r IN c DO in_flight_count := r.C; END FOR;

    IF (:in_flight_count > 0) THEN
        BEGIN
            INSERT INTO OPENROUTESERVICE_APP.CORE.COST_GUARD_LOG (REGION, ACTION, FIRED_AT, REASON)
            VALUES (:P_REGION, 'soft_suspend_refused', CURRENT_TIMESTAMP(),
                    'in-flight provision job - refusing suspend to preserve build');
        EXCEPTION WHEN OTHER THEN NULL;
        END;
        RETURN 'REFUSED: in-flight provision job for ' || :P_REGION ||
               '. Use DIAGNOSE_REGION first; dismiss the job before suspending.';
    END IF;

    LET ors_ready VARCHAR DEFAULT 'unknown';
    BEGIN
        rs := (EXECUTE IMMEDIATE 'SELECT TRY_PARSE_JSON(OPENROUTESERVICE_APP.CORE.ORS_STATUS('''
            || :P_REGION || ''')::VARCHAR):service_ready::VARCHAR AS R');
        LET c2 CURSOR FOR rs;
        FOR r IN c2 DO ors_ready := COALESCE(r.R, 'unknown'); END FOR;
    EXCEPTION WHEN OTHER THEN ors_ready := 'unknown';
    END;

    BEGIN
        EXECUTE IMMEDIATE 'ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.' || svc_name || ' SUSPEND';
    EXCEPTION WHEN OTHER THEN NULL;
    END;
    BEGIN
        EXECUTE IMMEDIATE 'ALTER COMPUTE POOL IF EXISTS ' || pool_name || ' SUSPEND';
    EXCEPTION WHEN OTHER THEN NULL;
    END;
    BEGIN
        INSERT INTO OPENROUTESERVICE_APP.CORE.COST_GUARD_LOG (REGION, ACTION, FIRED_AT, REASON)
        VALUES (:P_REGION, 'soft_suspend_region', CURRENT_TIMESTAMP(),
                'service+pool suspended (no in-flight job; service_ready=' || :ors_ready ||
                '); resume preserves service object');
    EXCEPTION WHEN OTHER THEN NULL;
    END;
    RETURN 'Soft-suspended ' || :P_REGION ||
           ' (resume via resume_region_ors). service_ready was ' || :ors_ready;
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
-- DOWNSIZE_REGION_AFTER_BUILD
-- Cost guardrail: after a region's first successful graph build (graphs persisted
-- on @ORS_GRAPHS_SPCS_STAGE/<region>/), move the runtime service off the XXL
-- (MEM_X64_G2_64) build pool onto a cheaper runtime tier so the account does not
-- pay XXL rates 24/7 for query serving.
--
-- Workflow:
--   1. Verify graphs exist on the stage (refuse to downsize if not).
--   2. Re-render the service spec at the runtime size (P_RUNTIME_SIZE, default 'M').
--   3. SUSPEND the service, ALTER FROM SPECIFICATION to apply the new spec, then
--      DROP+CREATE the compute pool at the smaller instance family
--      (ALTER COMPUTE POOL cannot change INSTANCE_FAMILY).
--   4. RESUME the service and update REGION_ORS_MAP to the new tier/family.
-- =============================================================================
CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.DOWNSIZE_REGION_AFTER_BUILD(
    P_REGION VARCHAR, P_RUNTIME_SIZE VARCHAR DEFAULT 'M'
)
RETURNS STRING
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"multi-region","action":"cost-guardrail"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    svc_name VARCHAR;
    pool_name VARCHAR;
    runtime_family VARCHAR;
    new_spec VARCHAR;
    graph_file_count INTEGER DEFAULT 0;
    rs RESULTSET;
BEGIN
    svc_name := 'ORS_SERVICE_' || UPPER(:P_REGION);
    pool_name := 'ORS_POOL_' || UPPER(:P_REGION);

    -- Refuse to downsize if no graphs exist (would force a full rebuild on small node).
    BEGIN
        EXECUTE IMMEDIATE 'LIST @OPENROUTESERVICE_APP.CORE.ORS_GRAPHS_SPCS_STAGE/' || :P_REGION || '/';
        rs := (SELECT COUNT(*) AS C FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())));
        LET c CURSOR FOR rs;
        FOR r IN c DO graph_file_count := r.C; END FOR;
    EXCEPTION WHEN OTHER THEN graph_file_count := 0;
    END;
    IF (:graph_file_count = 0) THEN
        RETURN 'Refusing to downsize ' || :P_REGION || ': no graph files found on stage. Run REBUILD_REGION_GRAPHS first.';
    END IF;

    -- Resolve runtime instance family (mirrors create_region_ors_service mapping).
    -- Three-tier model: S (city) | L (country, was HIGHMEM_X64_L for build) | XXL (continent).
    -- Runtime is intentionally smaller than build to avoid 24/7 spend at build-tier rates.
    IF (:P_RUNTIME_SIZE = 'XXL') THEN
        runtime_family := 'MEM_X64_G2_64';        -- downsize XXL build -> mid-tier high-mem
    ELSEIF (:P_RUNTIME_SIZE = 'L') THEN
        runtime_family := 'HIGHMEM_X64_M';        -- downsize L build -> smaller high-mem (was unsafe CPU_X64_L)
    ELSEIF (:P_RUNTIME_SIZE = 'S') THEN
        runtime_family := 'GEN_X64_G2_8';
    ELSE
        runtime_family := 'HIGHMEM_X64_M';        -- default to safe high-mem; never CPU-only for non-city
    END IF;

    -- Persist graphs across the cycle (REBUILD_GRAPHS=false).
    new_spec := OPENROUTESERVICE_APP.CORE.BUILD_ORS_SERVICE_SPEC(:P_REGION, :P_RUNTIME_SIZE, 'false');

    -- Suspend service so we can swap the underlying pool.
    BEGIN
        EXECUTE IMMEDIATE 'ALTER SERVICE OPENROUTESERVICE_APP.CORE.' || :svc_name || ' SUSPEND';
    EXCEPTION WHEN OTHER THEN NULL;
    END;

    -- Drop the XXL pool and recreate at the runtime family.
    BEGIN
        EXECUTE IMMEDIATE 'DROP COMPUTE POOL IF EXISTS ' || :pool_name;
    EXCEPTION WHEN OTHER THEN NULL;
    END;

    EXECUTE IMMEDIATE 'CREATE COMPUTE POOL ' || :pool_name ||
        ' MIN_NODES = 1 MAX_NODES = 1 INSTANCE_FAMILY = ' || :runtime_family ||
        ' AUTO_SUSPEND_SECS = 14400 AUTO_RESUME = TRUE' ||
        ' COMMENT = ''{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"multi-region","region":"' || :P_REGION || '","stage":"runtime"}}''';

    -- Apply the new (runtime-sized) spec on top of the new pool.
    EXECUTE IMMEDIATE 'ALTER SERVICE OPENROUTESERVICE_APP.CORE.' || :svc_name ||
        ' FROM SPECIFICATION ''' || :new_spec || '''';

    -- Resume to load graphs from the persisted stage.
    BEGIN
        EXECUTE IMMEDIATE 'ALTER SERVICE OPENROUTESERVICE_APP.CORE.' || :svc_name || ' RESUME';
    EXCEPTION WHEN OTHER THEN NULL;
    END;

    UPDATE OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP
    SET COMPUTE_SIZE = :P_RUNTIME_SIZE, INSTANCE_FAMILY = :runtime_family, UPDATED_AT = CURRENT_TIMESTAMP()
    WHERE REGION = :P_REGION;

    RETURN 'Region ' || :P_REGION || ' downsized to ' || :P_RUNTIME_SIZE ||
           ' (' || :runtime_family || '); ' || :graph_file_count || ' graph files reused from stage.';
END;
$$;

-- =============================================================================
-- ORS_BUILD_HISTORY: telemetry of every region graph build attempt.
-- Populated by PROVISION_REGION_WRAPPER on every terminal state (success, OOM,
-- timeout, error). Foundation for RECOMMEND_RETRY_STRATEGY and any future
-- empirical sizing/learning logic.
-- =============================================================================
CREATE TABLE IF NOT EXISTS OPENROUTESERVICE_APP.CORE.ORS_BUILD_HISTORY (
    BUILD_ID         VARCHAR DEFAULT UUID_STRING(),
    JOB_ID           VARCHAR,
    REGION           VARCHAR,
    PBF_URL          VARCHAR,
    PBF_SIZE_GIB     FLOAT,
    OSM_TIMESTAMP    TIMESTAMP_NTZ,
    ORS_VERSION      VARCHAR,
    PROFILES         VARCHAR,
    COMPUTE_SIZE     VARCHAR,
    CONFIG_HASH      VARCHAR,
    INSTANCE_FAMILY  VARCHAR,
    JVM_XMX_GIB      NUMBER,
    STARTED_AT       TIMESTAMP_NTZ,
    FINISHED_AT      TIMESTAMP_NTZ,
    ELAPSED_MINUTES  FLOAT,
    EXIT_STATUS      VARCHAR,
    PEAK_RSS_GIB     FLOAT,
    OUTPUT_GRAPH_GIB FLOAT,
    LOG_URI          VARCHAR
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"telemetry"}}';

-- =============================================================================
-- RECOMMEND_RETRY_STRATEGY
-- We are already on the largest pool, so we cannot bump tier. Inspect the most
-- recent ORS_BUILD_HISTORY row and return one of:
--   REUSE             - last build succeeded; just resume the service
--   REBUILD_SAME      - last failure was transient (network/timeout under SLA)
--   SPLIT_PROFILES    - last build OOMed or peak RSS > 90% of node RAM
--   DISABLE_FLAGS     - last build OOMed AND fastisochrones/elevation are on
--   NO_HISTORY        - first build for this region
-- The result is informational; the UI surfaces it as a banner so the user can
-- pick a remediation. It is intentionally NOT automated -- changing profiles
-- or disabling fastisochrones is a user-visible decision.
-- =============================================================================
CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.RECOMMEND_RETRY_STRATEGY(P_REGION VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"telemetry","action":"retry-strategy"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    last_status VARCHAR DEFAULT '';
    last_peak FLOAT DEFAULT 0;
    last_elapsed FLOAT DEFAULT 0;
    node_ram FLOAT DEFAULT 0;
    rs RESULTSET;
    history_count INTEGER DEFAULT 0;
BEGIN
    rs := (
        SELECT COALESCE(EXIT_STATUS, '') AS S,
               COALESCE(PEAK_RSS_GIB, 0) AS P,
               COALESCE(ELAPSED_MINUTES, 0) AS E,
               COALESCE(JVM_XMX_GIB, 0) * 1.25 AS NODE_RAM
        FROM OPENROUTESERVICE_APP.CORE.ORS_BUILD_HISTORY
        WHERE REGION = :P_REGION
        ORDER BY STARTED_AT DESC
        LIMIT 1
    );
    LET c CURSOR FOR rs;
    FOR r IN c DO
        history_count := 1;
        last_status := r.S;
        last_peak := r.P;
        last_elapsed := r.E;
        node_ram := r.NODE_RAM;
    END FOR;

    IF (:history_count = 0) THEN
        RETURN 'NO_HISTORY';
    END IF;

    IF (:last_status = 'SUCCESS') THEN
        RETURN 'REUSE';
    END IF;

    IF (:last_status = 'OOM' OR (:node_ram > 0 AND :last_peak > :node_ram * 0.90)) THEN
        RETURN 'SPLIT_PROFILES';
    END IF;

    IF (:last_status = 'TIMEOUT' OR :last_elapsed > 4 * 60 * 1.15) THEN
        RETURN 'SPLIT_PROFILES';
    END IF;

    RETURN 'REBUILD_SAME';
END;
$$;

