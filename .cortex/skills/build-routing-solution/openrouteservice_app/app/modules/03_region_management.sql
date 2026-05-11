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

    -- After the download path (cache miss), REGION_PROVISION_JOBS.PBF_SIZE_GIB is still
    -- null. Without this backfill the diagnostic agent has no PBF size signal and the
    -- ETA computation in DIAGNOSE_REGION cannot derive a band. LIST the staged file and
    -- UPSERT the size; safe to re-run on cache-hit path (already populated).
    BEGIN
        LET pbf_post_bytes INTEGER DEFAULT 0;
        EXECUTE IMMEDIATE 'LIST @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/' || :P_REGION || '/' || :pbf_filename;
        LET rs_pbf_post RESULTSET := (SELECT COALESCE("size", 0)::INTEGER AS B
                                       FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) LIMIT 1);
        LET c_pbf_post CURSOR FOR rs_pbf_post;
        FOR r IN c_pbf_post DO pbf_post_bytes := r.B; END FOR;
        IF (:pbf_post_bytes > 0) THEN
            UPDATE OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
            SET PBF_SIZE_GIB = :pbf_post_bytes / 1073741824.0
            WHERE JOB_ID = :P_JOB_ID AND PBF_SIZE_GIB IS NULL;
            UPDATE OPENROUTESERVICE_APP.CORE.ORS_BUILD_HISTORY
            SET PBF_SIZE_GIB = :pbf_post_bytes / 1073741824.0
            WHERE BUILD_ID = :build_id AND PBF_SIZE_GIB IS NULL;
        END IF;
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
    -- largest high-memory hardware can take 4-6 hours during CH preparation;
    -- smaller regions complete in single-digit minutes. The loop has two exit
    -- conditions: (1) hard wall-clock ceiling (Layer 2 backstop) and (2) a
    -- progress-aware stall detector (Layer 1) that breaks early only when the
    -- on-stage graph byte count has not grown for `stall_threshold` polls
    -- (10 min). A separate task-based rescue layer (RESCUE_PENDING_PROVISIONS)
    -- finalizes any job whose container becomes ready after this loop exits.
    LET wait_iters INTEGER DEFAULT 40;       -- 30s * 40  = 20 min default (S, city builds)
    LET wait_secs  INTEGER DEFAULT 30;
    IF (:P_COMPUTE_SIZE = 'XXL') THEN wait_iters := 720; END IF;        -- 6h for continent builds (USA HGV measured ~5h15m)
    IF (:P_COMPUTE_SIZE = 'L')   THEN wait_iters := 360; END IF;        -- 3h for country / sub-region builds (HIGHMEM_X64_L)
    LET last_bytes      INTEGER DEFAULT 0;
    LET stale_polls     INTEGER DEFAULT 0;
    LET stall_threshold INTEGER DEFAULT 20;  -- 20 polls * 30s = 10 min of zero growth = real stall
    LET cur_bytes       INTEGER DEFAULT 0;
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
        -- Layer 1: progress-aware stall detector. Probe the persisted graph
        -- stage size; if it has not grown for `stall_threshold` consecutive
        -- polls (10 min) we treat the build as genuinely stuck and break out
        -- early. Builds that are still producing output (even multi-hour CH
        -- preparation) keep the loop alive until the wall-clock ceiling.
        BEGIN
            EXECUTE IMMEDIATE 'LIST @OPENROUTESERVICE_APP.CORE.ORS_GRAPHS_SPCS_STAGE/' || :P_REGION || '/';
            LET rs_g RESULTSET := (SELECT COALESCE(SUM("size"), 0)::INTEGER AS B
                                   FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())));
            LET c_g CURSOR FOR rs_g;
            FOR r IN c_g DO cur_bytes := r.B; END FOR;
        EXCEPTION WHEN OTHER THEN cur_bytes := :last_bytes;
        END;
        IF (:cur_bytes > :last_bytes) THEN
            last_bytes := :cur_bytes;
            stale_polls := 0;
        ELSEIF (:last_bytes > 0) THEN
            -- Only count stalls AFTER the first graph byte has been written.
            -- ORS does not write to ORS_GRAPHS_SPCS_STAGE during the OSM import
            -- phase (which can run 25-50 min for multi-GiB PBFs); the first
            -- write happens at the cleanUp boundary. Counting pre-first-write
            -- iterations as stalls falsely trips graph_load_timeout for every
            -- continent-scale build. Pre-first-write the wall-clock ceiling
            -- (wait_iters * 30s) is the only bound.
            stale_polls := :stale_polls + 1;
        END IF;
        IF (:stale_polls >= :stall_threshold) THEN
            BREAK;
        END IF;
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
    service_logs VARCHAR DEFAULT '';
    ors_status VARIANT;
    task_history_json VARIANT;
    region_map_json VARIANT;
    pool_json VARIANT;
    snapshot VARIANT;
    system_prompt VARCHAR;
    llm_response VARCHAR;
    svc_full VARCHAR;
    -- Parsed log signals
    log_chars NUMBER DEFAULT 0;
    log_lines NUMBER DEFAULT 0;
    log_ts_count NUMBER DEFAULT 0;
    last_log_ts VARCHAR DEFAULT NULL;
    current_phase VARCHAR DEFAULT 'UNKNOWN';
    container_start VARCHAR DEFAULT NULL;
    service_age_seconds NUMBER DEFAULT 0;
    -- ETA inputs / outputs
    pbf_gib_resolved FLOAT DEFAULT NULL;
    profiles_str VARCHAR DEFAULT '';
    profile_factor FLOAT DEFAULT 1.0;
    base_minutes NUMBER DEFAULT 0;
    phase_done_pct FLOAT DEFAULT 0.0;
    eta_total_minutes NUMBER DEFAULT NULL;
    eta_remaining_minutes NUMBER DEFAULT NULL;
    -- Deterministic banner prepended to every LLM response
    banner VARCHAR DEFAULT '';
    -- Misc safe-default
    restart_count_str VARCHAR DEFAULT '?';
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

    -- 3. Service container status + parsed startTime + service_age_seconds
    -- Use direct SYSTEM$GET_SERVICE_STATUS() function form via EXECUTE IMMEDIATE
    -- with svc_full baked in as a literal. The CALL + RESULT_SCAN(VALUE::VARCHAR)
    -- pattern silently returns NULL for service_status under EXECUTE AS OWNER,
    -- which cascades to service_age_seconds=0 and restart_count=NULL in the
    -- banner.
    BEGIN
        rs := (EXECUTE IMMEDIATE 'SELECT TRY_PARSE_JSON(SYSTEM$GET_SERVICE_STATUS(''' || :svc_full || '''))[0] AS S');
        LET cs CURSOR FOR rs;
        FOR r IN cs DO service_status := r.S; END FOR;
    EXCEPTION WHEN OTHER THEN service_status := NULL;
    END;

    BEGIN
        LET ss_str VARCHAR := TO_VARCHAR(:service_status);
        rs := (SELECT
                   v:startTime::VARCHAR AS ST,
                   COALESCE(DATEDIFF('second',
                       TO_TIMESTAMP_TZ(v:startTime::VARCHAR),
                       CURRENT_TIMESTAMP()), 0) AS A
               FROM (SELECT TRY_PARSE_JSON(:ss_str) AS v));
        LET cas CURSOR FOR rs;
        FOR r IN cas DO container_start := r.ST; service_age_seconds := r.A; END FOR;
    EXCEPTION WHEN OTHER THEN service_age_seconds := 0;
    END;

    -- 4. Last 1000 lines of container logs (Snowflake hard cap) + parsed signals.
    -- Container name is "ors" (verified via SYSTEM$GET_SERVICE_STATUS). NEVER guess.
    BEGIN
        service_logs := SYSTEM$GET_SERVICE_LOGS(:svc_full, '0', 'ors', 1000);
    EXCEPTION WHEN OTHER THEN service_logs := '';
    END;
    IF (service_logs IS NULL) THEN service_logs := ''; END IF;

    BEGIN
        rs := (SELECT
                   LENGTH(:service_logs)                                        AS LC,
                   REGEXP_COUNT(:service_logs, '\\n') + 1                       AS LL,
                   REGEXP_COUNT(:service_logs,
                       '[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}') AS LT);
        LET clog CURSOR FOR rs;
        FOR r IN clog DO log_chars := r.LC; log_lines := r.LL; log_ts_count := r.LT; END FOR;
    EXCEPTION WHEN OTHER THEN
        log_chars := 0; log_lines := 0; log_ts_count := 0;
    END;

    IF (log_ts_count > 0) THEN
        BEGIN
            rs := (SELECT MAX(VALUE::VARCHAR) AS T
                   FROM TABLE(FLATTEN(input => REGEXP_SUBSTR_ALL(
                       :service_logs,
                       '[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}'))));
            LET clt CURSOR FOR rs;
            FOR r IN clt DO last_log_ts := r.T; END FOR;
        EXCEPTION WHEN OTHER THEN last_log_ts := NULL;
        END;
    END IF;

    -- Phase detection via REGEXP_INSTR position ordering. Pick whichever phase
    -- marker appears LATEST in the log so we follow the timeline. Naive ILIKE
    -- gives false positives (e.g. "Loaded landmark" appears in startup banner).
    BEGIN
        rs := (SELECT CASE
                   WHEN p_ready  > 0 THEN 'SERVICE_READY'
                   WHEN p_lm     > GREATEST(p_ch, p_osm, p_spring, p_init) THEN 'LM_PREPARE'
                   WHEN p_ch     > GREATEST(p_osm, p_spring, p_init)       THEN 'CH_PREPARE'
                   WHEN p_osm    > GREATEST(p_spring, p_init)              THEN 'OSM_IMPORT'
                   WHEN p_spring > p_init                                   THEN 'SPRING_BOOT_START'
                   WHEN p_init   > 0                                        THEN 'CONTAINER_INIT'
                   ELSE 'UNKNOWN'
               END AS PHASE
               FROM (SELECT
                   REGEXP_INSTR(:service_logs, 'Listening on port', 1, 1, 0, 'i')                                                AS p_ready,
                   REGEXP_INSTR(:service_logs, 'PrepareLM|landmark calculation|Calculating tower nodes', 1, 1, 0, 'i')           AS p_lm,
                   REGEXP_INSTR(:service_logs, 'PrepareCore|contraction', 1, 1, 0, 'i')                                          AS p_ch,
                   REGEXP_INSTR(:service_logs, 'GraphProcessContext|OSMReader|optimizing|sorting|start creating graph from', 1, 1, 0, 'i') AS p_osm,
                   REGEXP_INSTR(:service_logs, 'Started Application in', 1, 1, 0, 'i')                                           AS p_spring,
                   REGEXP_INSTR(:service_logs, 'Container ENV', 1, 1, 0, 'i')                                                    AS p_init));
        LET cph CURSOR FOR rs;
        FOR r IN cph DO current_phase := r.PHASE; END FOR;
    EXCEPTION WHEN OTHER THEN current_phase := 'UNKNOWN';
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

    -- 9. Resolve PBF size: prefer DB value, fall back to LIST @stage on first
    -- download (REGION_PROVISION_JOBS.PBF_SIZE_GIB is null until the cache hit
    -- path runs; without this fallback the agent has no scale signal).
    BEGIN
        LET jj_str VARCHAR := TO_VARCHAR(:job_json);
        rs := (SELECT j:pbf_size_gib::FLOAT AS V FROM (SELECT TRY_PARSE_JSON(:jj_str) AS j));
        LET cjp CURSOR FOR rs;
        FOR r IN cjp DO pbf_gib_resolved := r.V; END FOR;
    EXCEPTION WHEN OTHER THEN pbf_gib_resolved := NULL;
    END;

    IF (pbf_gib_resolved IS NULL) THEN
        BEGIN
            EXECUTE IMMEDIATE 'LIST @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/' || :P_REGION || '/';
            rs := (SELECT MAX("size") / 1073741824.0 AS B
                   FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
                   WHERE "name" ILIKE '%.osm.pbf' AND "name" NOT ILIKE '%heidelberg%');
            LET cps CURSOR FOR rs;
            FOR r IN cps DO pbf_gib_resolved := r.B; END FOR;
        EXCEPTION WHEN OTHER THEN pbf_gib_resolved := NULL;
        END;
    END IF;

    -- 10. ETA computation: bands by pbf size * profile factor * (1 - phase_done_pct) - elapsed
    BEGIN
        LET jj_str2 VARCHAR := TO_VARCHAR(:job_json);
        rs := (SELECT
                   COALESCE(j:profiles::VARCHAR, '')                                       AS PRF,
                   CASE
                       WHEN COALESCE(j:profiles::VARCHAR, '') ILIKE '%driving-hgv%' THEN 2.0
                       WHEN COALESCE(j:profiles::VARCHAR, '') ILIKE '%cycling%'     THEN 0.5
                       WHEN COALESCE(j:profiles::VARCHAR, '') ILIKE '%foot%'        THEN 0.5
                       ELSE 1.0
                   END                                                                              AS PF,
                   CASE
                       WHEN p IS NULL  THEN 0
                       WHEN p < 0.5    THEN 10
                       WHEN p < 3      THEN 75
                       WHEN p < 8      THEN 240
                       ELSE                  480
                   END                                                                              AS BM,
                   CASE ph
                       WHEN 'CONTAINER_INIT'    THEN 0.00
                       WHEN 'SPRING_BOOT_START' THEN 0.05
                       WHEN 'OSM_IMPORT'        THEN 0.30
                       WHEN 'CH_PREPARE'        THEN 0.65
                       WHEN 'LM_PREPARE'        THEN 0.90
                       WHEN 'SERVICE_READY'     THEN 1.00
                       ELSE 0.00
                   END                                                                              AS PD
               FROM (SELECT TRY_PARSE_JSON(:jj_str2) AS j, :pbf_gib_resolved AS p, :current_phase AS ph));
        LET ceta CURSOR FOR rs;
        FOR r IN ceta DO
            profiles_str   := r.PRF;
            profile_factor := r.PF;
            base_minutes   := r.BM;
            phase_done_pct := r.PD;
        END FOR;

        IF (pbf_gib_resolved IS NOT NULL) THEN
            eta_total_minutes := ROUND(base_minutes * profile_factor);
            eta_remaining_minutes := GREATEST(0,
                ROUND(eta_total_minutes * (1 - phase_done_pct) - service_age_seconds/60.0));
        END IF;
    EXCEPTION WHEN OTHER THEN
        eta_total_minutes := NULL;
        eta_remaining_minutes := NULL;
    END;

    -- Assemble the snapshot (now with all parsed + derived fields)
    snapshot := OBJECT_CONSTRUCT(
        'region', :P_REGION,
        'generated_at', CURRENT_TIMESTAMP(),
        'provision_job', :job_json,
        'build_history', :history_json,
        'service_status', :service_status,
        'service_age_seconds', :service_age_seconds,
        'ors_status', :ors_status,
        'rescue_task_history', :task_history_json,
        'region_map', :region_map_json,
        'compute_pool', :pool_json,
        'log_tail', :service_logs,
        'log_chars', :log_chars,
        'log_lines', :log_lines,
        'last_log_ts', :last_log_ts,
        'current_phase', :current_phase,
        'pbf_size_gib_resolved', :pbf_gib_resolved,
        'profiles_str', :profiles_str,
        'profile_factor', :profile_factor,
        'phase_done_pct', :phase_done_pct,
        'eta_total_minutes', :eta_total_minutes,
        'eta_remaining_minutes', :eta_remaining_minutes
    );

    -- Deterministic operator-facing banner. Always prepended to LLM response so
    -- the user sees correct phase / age / ETA even if the LLM hallucinates, and
    -- so we have a useful answer if AI_COMPLETE errors.
    BEGIN
        LET ss_str2 VARCHAR := TO_VARCHAR(:service_status);
        rs := (SELECT COALESCE(v:restartCount::VARCHAR, '?') AS R FROM (SELECT TRY_PARSE_JSON(:ss_str2) AS v));
        LET crc CURSOR FOR rs;
        FOR r IN crc DO restart_count_str := r.R; END FOR;
    EXCEPTION WHEN OTHER THEN restart_count_str := '?';
    END;

    banner :=
        '**Diagnostic snapshot (deterministic):**' || CHR(10) || CHR(10) ||
        '| Field | Value |' || CHR(10) ||
        '|---|---|' || CHR(10) ||
        '| current_phase | `' || COALESCE(:current_phase, 'UNKNOWN') || '` |' || CHR(10) ||
        '| service_age_min | ' || COALESCE(ROUND(:service_age_seconds/60.0, 1)::VARCHAR, '?') || ' |' || CHR(10) ||
        '| restart_count | ' || :restart_count_str || ' |' || CHR(10) ||
        '| log_chars | ' || COALESCE(:log_chars::VARCHAR, '0') || ' |' || CHR(10) ||
        '| log_lines | ' || COALESCE(:log_lines::VARCHAR, '0') || ' |' || CHR(10) ||
        '| last_log_ts | ' || COALESCE(:last_log_ts, 'n/a') || ' |' || CHR(10) ||
        '| pbf_size_gib | ' || COALESCE(ROUND(:pbf_gib_resolved, 2)::VARCHAR, 'unknown') || ' |' || CHR(10) ||
        '| profile_factor | ' || COALESCE(:profile_factor::VARCHAR, '1.0') || ' |' || CHR(10) ||
        '| eta_total_min | ' || COALESCE(:eta_total_minutes::VARCHAR, 'unknown') || ' |' || CHR(10) ||
        '| eta_remaining_min | ' || COALESCE(:eta_remaining_minutes::VARCHAR, 'unknown') || ' |' || CHR(10) ||
        CHR(10);

    -- System prompt encodes the decision tree the human operator follows.
    -- HARD RULES are designed to prevent the "logs are empty" hallucination and
    -- the made-up 20-45 min ETA we observed in v1.
    system_prompt :=
'You are an ORS region build diagnostic assistant for a Snowflake-native routing solution. ' ||
'The user clicked "Ask for status" on a region in the Region Builder UI. You receive a JSON ' ||
'snapshot of the build state plus a deterministic banner with parsed phase, age, and ETA.' || CHR(10) ||
'Return concise markdown with this structure:' || CHR(10) ||
'  - One-line "**TL;DR**" at the top (e.g. "OSM import in progress, ~5 h remaining").' || CHR(10) ||
'  - A short bullet list of "Key signals" referencing the deterministic banner values.' || CHR(10) ||
'  - A "What is happening" paragraph (2-4 sentences) referencing the latest 1-2 log lines.' || CHR(10) ||
'  - A "What to do" section: clear recommended action.' || CHR(10) ||
'  - An "ETA" line that cites pbf_size_gib_resolved, profile_factor, current_phase, and eta_remaining_minutes.' || CHR(10) ||
'HARD RULES (violations = wrong answer):' || CHR(10) ||
'  R1. NEVER claim "logs are empty" if log_chars > 0. Quote actual log content.' || CHR(10) ||
'  R2. NEVER invent ETA numbers. Use eta_remaining_minutes from the snapshot. ' ||
       'If pbf_size_gib_resolved is null, say "size unknown; cannot estimate ETA".' || CHR(10) ||
'  R3. NEVER substitute or guess container names. The container is "ors".' || CHR(10) ||
'  R4. ALWAYS quote pbf_size_gib_resolved and profile_factor in the ETA line.' || CHR(10) ||
'Decision tree:' || CHR(10) ||
'1. service_status.restartCount > 0 -> container has crashed (likely OOM if exitCode 137). ' ||
'   Recommend: dismiss the job and retry on a smaller compute size, or split profiles.' || CHR(10) ||
'2. ors_status.service_ready = true -> graph is loaded. If provision_job.status is still ' ||
'   ERROR with error_msg=graph_load_timeout, the rescue task will finalize within 2 min. ' ||
'   Recommend: wait briefly; UI will flip green automatically.' || CHR(10) ||
'3. ors_status.service_ready = false AND service_status.status = READY -> container alive, ' ||
'   building the graph. Sub-cases by log_chars + service_age_seconds:' || CHR(10) ||
'   3a. log_chars > 0 -> NEVER say "logs are empty". Quote latest log line; report current_phase.' || CHR(10) ||
'   3b. log_chars = 0 AND service_age_seconds < 60   -> "container booting; logs flushing in <1 min".' || CHR(10) ||
'   3c. log_chars = 0 AND service_age_seconds < 600  -> "Spring Boot still initialising; check again in 1-2 min".' || CHR(10) ||
'   3d. log_chars = 0 AND service_age_seconds >= 600 -> escalate as a logging issue.' || CHR(10) ||
'4. ETA bands (already computed in eta_remaining_minutes; report and contextualize):' || CHR(10) ||
'   pbf<0.5GiB city ~10 min base; pbf<3GiB country ~75 min; pbf<8GiB ~4 h; pbf>=8GiB continent ~8 h. ' ||
'   profile_factor: driving-hgv 2.0x, driving-car 1.0x, cycling/foot 0.5x. ' ||
'   phase derate: CONTAINER_INIT 0%, SPRING_BOOT 5%, OSM_IMPORT 30%, CH_PREPARE 65%, LM_PREPARE 90%.' || CHR(10) ||
'5. provision_job.error_msg = graph_load_timeout AND container alive -> wrapper exited but ' ||
'   the build continues; rescue task will close the loop. Reassure user.' || CHR(10) ||
'6. provision_job.error_msg = container_crash_during_build -> OOM. Recommend retry on ' ||
'   smaller compute or different family.' || CHR(10) ||
'7. compute_pool.instance_family != region_map.instance_family -> stale pool from earlier ' ||
'   failed attempt. The patched create_region_ors_service should reconcile on next provision.' || CHR(10) ||
'8. provision_job is null -> no provision attempt found. Recommend deploying.' || CHR(10) ||
'Be specific. Quote numeric values from the snapshot. Keep total output under 350 words.';

    -- Call Cortex AI to summarize. claude-4-sonnet has the deepest reasoning for this kind
    -- of correlation; swap to claude-3-5-haiku for cheaper but adequate responses.
    BEGIN
        llm_response := AI_COMPLETE(
            'claude-4-sonnet',
            :system_prompt || CHR(10) || CHR(10) ||
            'Snapshot:' || CHR(10) || TO_VARCHAR(:snapshot)
        );
    EXCEPTION WHEN OTHER THEN
        llm_response := '_(LLM unavailable; relying on the deterministic banner above.)_';
    END;

    RETURN OBJECT_CONSTRUCT(
        'region', :P_REGION,
        'generated_at', CURRENT_TIMESTAMP(),
        'markdown', :banner || COALESCE(:llm_response, ''),
        'raw_snapshot', :snapshot
    )::VARCHAR;
END;
$$;



-- =============================================================================
-- LAYER 3: TASK-BASED RESCUE FOR LATE-COMPLETING BUILDS
-- =============================================================================
-- The PROVISION_REGION_WRAPPER wait loop above is bounded by a wall-clock
-- ceiling AND a progress-aware stall detector, but the SPCS container can
-- still legitimately become `service_ready=true` AFTER the wrapper has
-- already exited (e.g. if a transient ORS_STATUS probe error caused the
-- stall detector to break early). The rescue layer is a sub-second polling
-- task that finalizes any such job whenever the container reports ready.
--
-- Objects:
--   FINALIZE_PROVISION_ITER(P_REGION) - single-region finalizer (idempotent).
--   RESCUE_PENDING_PROVISIONS()       - scans for stuck jobs, calls finalizer.
--   RESCUE_PENDING_PROVISIONS_TASK    - cron */2 min, managed XSMALL warehouse.
-- =============================================================================
CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.FINALIZE_PROVISION_ITER(P_REGION VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"rescue","action":"finalize-iter"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    rs RESULTSET;
    job_id VARCHAR DEFAULT '';
    build_id VARCHAR DEFAULT '';
    compute_size VARCHAR DEFAULT '';
    profile_count INTEGER DEFAULT 0;
    status_raw VARCHAR DEFAULT '';
    status_json VARIANT;
    is_ready BOOLEAN DEFAULT FALSE;
    peak_rss FLOAT DEFAULT NULL;
BEGIN
    -- Find the most recent qualifying job for this region (ERROR with the
    -- well-known timeout/unreachable signature, OR still RUNNING in
    -- BUILDING_GRAPH stage and likely past the wrapper's wait loop).
    rs := (
        SELECT JOB_ID, COALESCE(COMPUTE_SIZE, '') AS CS
        FROM OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
        WHERE REGION = :P_REGION
          AND (
                (STATUS = 'ERROR' AND ERROR_MSG IN ('graph_load_timeout','ors_status_unreachable'))
             OR (STATUS = 'RUNNING' AND STAGE = 'BUILDING_GRAPH'
                 AND TIMESTAMPDIFF(MINUTE, STARTED_AT, CURRENT_TIMESTAMP()) > 30)
              )
          AND (COMPLETED_AT IS NULL OR COMPLETED_AT > DATEADD(HOUR, -24, CURRENT_TIMESTAMP()))
        ORDER BY STARTED_AT DESC
        LIMIT 1
    );
    LET c1 CURSOR FOR rs;
    FOR r IN c1 DO
        job_id := r.JOB_ID;
        compute_size := r.CS;
    END FOR;
    IF (:job_id = '') THEN
        RETURN 'nothing_to_do:' || :P_REGION;
    END IF;

    -- Probe the container.
    BEGIN
        rs := (EXECUTE IMMEDIATE 'SELECT OPENROUTESERVICE_APP.CORE.ORS_STATUS(''' || :P_REGION || ''')::VARCHAR AS S');
        LET c2 CURSOR FOR rs;
        FOR r IN c2 DO status_raw := r.S; END FOR;
        status_json := TRY_PARSE_JSON(:status_raw);
        IF (status_json:service_ready::BOOLEAN = TRUE AND status_json:profiles IS NOT NULL) THEN
            profile_count := ARRAY_SIZE(OBJECT_KEYS(status_json:profiles));
            IF (:profile_count > 0) THEN is_ready := TRUE; END IF;
        END IF;
    EXCEPTION WHEN OTHER THEN is_ready := FALSE;
    END;
    IF (NOT :is_ready) THEN
        -- Container alive but graph not loaded yet. The wrapper may have exited
        -- prematurely (stall detector / wall-clock); leaving STATUS='ERROR' on
        -- the row puts it in the UI's failed-jobs panel even though the build
        -- is still progressing. Downgrade to RUNNING / BUILDING_GRAPH while the
        -- container is healthy so the UI shows it as in-progress, and the next
        -- rescue iteration will keep monitoring (the scan filter below already
        -- includes RUNNING + BUILDING_GRAPH + elapsed > 30 min).
        BEGIN
            LET svc_alive BOOLEAN DEFAULT FALSE;
            LET svc_full_alive VARCHAR := 'OPENROUTESERVICE_APP.CORE.ORS_SERVICE_' || UPPER(:P_REGION);
            -- Use direct SYSTEM$GET_SERVICE_STATUS function form. The
            -- CALL + RESULT_SCAN(VALUE::VARCHAR) pattern silently returns
            -- NULL under EXECUTE AS OWNER, leaving svc_alive=FALSE and
            -- preventing the downgrade UPDATE from firing.
            rs := (EXECUTE IMMEDIATE 'SELECT (TRY_PARSE_JSON(SYSTEM$GET_SERVICE_STATUS(''' || :svc_full_alive || '''))[0]:status::VARCHAR = ''READY'') AS A');
            LET csa CURSOR FOR rs;
            FOR r IN csa DO svc_alive := COALESCE(r.A, FALSE); END FOR;
            IF (:svc_alive) THEN
                UPDATE OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
                SET STATUS='RUNNING',
                    STAGE='BUILDING_GRAPH',
                    MESSAGE='Container alive; graph still loading (rescue task monitoring).',
                    ERROR_MSG=NULL,
                    COMPLETED_AT=NULL
                WHERE JOB_ID = :job_id AND STATUS='ERROR';
            END IF;
        EXCEPTION WHEN OTHER THEN NULL;
        END;
        RETURN 'not_ready:' || :P_REGION;
    END IF;

    -- Container is ready - finalize the job exactly like the wrapper would.
    UPDATE OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP SET STATUS='DEPLOYED' WHERE REGION = :P_REGION;
    BEGIN
        EXECUTE IMMEDIATE 'ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ORS_SERVICE_' || UPPER(:P_REGION) || ' SET AUTO_SUSPEND_SECS = 14400';
    EXCEPTION WHEN OTHER THEN NULL;
    END;
    BEGIN
        CALL OPENROUTESERVICE_APP.CORE.SET_REBUILD_GRAPHS_FLAG(:P_REGION, 'false');
    EXCEPTION WHEN OTHER THEN NULL;
    END;
    BEGIN
        EXECUTE IMMEDIATE 'COPY INTO @OPENROUTESERVICE_APP.CORE.ORS_GRAPHS_SPCS_STAGE/' || :P_REGION ||
            '/_BUILD_OK FROM (SELECT ''ok'') FILE_FORMAT = (TYPE = CSV) SINGLE = TRUE OVERWRITE = TRUE';
    EXCEPTION WHEN OTHER THEN NULL;
    END;

    UPDATE OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
    SET STATUS='COMPLETE', STAGE='READY',
        MESSAGE='Region provisioned via rescue task — ' || :profile_count || ' profile(s) ready',
        ERROR_MSG=NULL,
        COMPLETED_AT=CURRENT_TIMESTAMP()
    WHERE JOB_ID = :job_id;

    -- Update the matching ORS_BUILD_HISTORY row (most recent IN_PROGRESS or
    -- TIMEOUT for this region, which is the row the wrapper opened).
    BEGIN
        rs := (
            SELECT BUILD_ID
            FROM OPENROUTESERVICE_APP.CORE.ORS_BUILD_HISTORY
            WHERE REGION = :P_REGION
              AND EXIT_STATUS IN ('IN_PROGRESS','TIMEOUT')
            ORDER BY STARTED_AT DESC
            LIMIT 1
        );
        LET cb CURSOR FOR rs;
        FOR r IN cb DO build_id := r.BUILD_ID; END FOR;
    EXCEPTION WHEN OTHER THEN build_id := '';
    END;
    IF (:build_id <> '') THEN
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
    END IF;

    -- Best-effort runtime downsize (same as wrapper success path).
    IF (UPPER(:compute_size) IN ('L','XXL')) THEN
        BEGIN
            CALL OPENROUTESERVICE_APP.CORE.DOWNSIZE_REGION_AFTER_BUILD(:P_REGION, :compute_size);
        EXCEPTION WHEN OTHER THEN NULL;
        END;
    END IF;

    RETURN 'rescued:' || :P_REGION || ' (job=' || :job_id || ', profiles=' || :profile_count || ')';
END;
$$;

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.RESCUE_PENDING_PROVISIONS()
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"rescue","action":"scan"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    rs RESULTSET;
    rescued INTEGER DEFAULT 0;
    seen INTEGER DEFAULT 0;
    msg VARCHAR DEFAULT '';
    region VARCHAR DEFAULT '';
BEGIN
    rs := (
        SELECT DISTINCT REGION
        FROM OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
        WHERE (
                (STATUS = 'ERROR' AND ERROR_MSG IN ('graph_load_timeout','ors_status_unreachable'))
             OR (STATUS = 'RUNNING' AND STAGE = 'BUILDING_GRAPH'
                 AND TIMESTAMPDIFF(MINUTE, STARTED_AT, CURRENT_TIMESTAMP()) > 30)
              )
          AND (COMPLETED_AT IS NULL OR COMPLETED_AT > DATEADD(HOUR, -24, CURRENT_TIMESTAMP()))
    );
    LET c CURSOR FOR rs;
    FOR r IN c DO
        seen := :seen + 1;
        region := r.REGION;
        BEGIN
            CALL OPENROUTESERVICE_APP.CORE.FINALIZE_PROVISION_ITER(:region) INTO :msg;
            IF (LEFT(:msg, 8) = 'rescued:') THEN
                rescued := :rescued + 1;
            END IF;
        EXCEPTION WHEN OTHER THEN NULL;
        END;
    END FOR;
    RETURN 'scanned=' || :seen || ' rescued=' || :rescued;
END;
$$;

CREATE OR REPLACE TASK OPENROUTESERVICE_APP.CORE.RESCUE_PENDING_PROVISIONS_TASK
    SCHEDULE = 'USING CRON */2 * * * * UTC'
    USER_TASK_MANAGED_INITIAL_WAREHOUSE_SIZE = 'XSMALL'
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"rescue","action":"task"}}'
AS
    CALL OPENROUTESERVICE_APP.CORE.RESCUE_PENDING_PROVISIONS();

BEGIN
    ALTER TASK OPENROUTESERVICE_APP.CORE.RESCUE_PENDING_PROVISIONS_TASK RESUME;
EXCEPTION WHEN OTHER THEN NULL;
END;
