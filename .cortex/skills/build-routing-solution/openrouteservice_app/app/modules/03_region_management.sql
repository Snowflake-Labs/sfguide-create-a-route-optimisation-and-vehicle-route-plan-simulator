ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","module":"03_region_management"}}';
USE SCHEMA OPENROUTESERVICE_APP.CORE;   

-- =============================================================================
-- REGION CATALOG: Dynamic catalog of OSM regions from Geofabrik + BBBike
-- =============================================================================

CREATE TABLE IF NOT EXISTS OPENROUTESERVICE_APP.CORE.REGION_CATALOG (
    CATALOG_ID         VARCHAR NOT NULL,
    SOURCE             VARCHAR NOT NULL,
    REGION_NAME        VARCHAR NOT NULL,
    REGION_KEY         VARCHAR NOT NULL,
    LOOKUP_NAME        VARCHAR,                  -- canonical name consumers use after loading
    HIERARCHY          VARCHAR,
    CONTINENT          VARCHAR,
    COUNTRY            VARCHAR,
    ISO_COUNTRY_A2     VARCHAR(2),               -- ISO 3166-1 alpha-2 (e.g. 'US', 'DE')
    ISO_COUNTRY_A3     VARCHAR(3),               -- ISO 3166-1 alpha-3 (e.g. 'USA', 'DEU')
    ISO_SUBDIVISION    VARCHAR,                  -- ISO 3166-2 (e.g. 'US-CA', 'DE-BY')
    UN_M49             INT,                      -- UN M49 numeric country code
    PBF_URL            VARCHAR,                  -- nullable: natural-earth supplemental rows have no PBF
    PBF_SIZE_MB        FLOAT,
    LEVEL              VARCHAR NOT NULL,
    MIN_LAT            FLOAT,
    MAX_LAT            FLOAT,
    MIN_LON            FLOAT,
    MAX_LON            FLOAT,
    BOUNDARY           GEOGRAPHY,                -- simplified region polygon (~100m tolerance)
    BOUNDARY_SOURCE    VARCHAR,                  -- 'geofabrik-poly' | 'bbbike-bbox' | 'manual-bbox'
    BOUNDARY_VERTICES  INT,                      -- vertex count post-simplify
    BOUNDARY_AREA_KM2  FLOAT,                    -- area in km^2 (sanity check)
    BOUNDARY_BAKED_AT  DATE,                     -- when the boundary snapshot was generated
    UPDATED_AT         TIMESTAMP_NTZ DEFAULT SYSDATE()
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
                $1:LOOKUP_NAME::VARCHAR,
                $1:HIERARCHY::VARCHAR,
                $1:CONTINENT::VARCHAR,
                $1:COUNTRY::VARCHAR,
                $1:ISO_COUNTRY_A2::VARCHAR,
                $1:ISO_COUNTRY_A3::VARCHAR,
                $1:ISO_SUBDIVISION::VARCHAR,
                $1:UN_M49::INT,
                $1:PBF_URL::VARCHAR,
                $1:PBF_SIZE_MB::FLOAT,
                $1:LEVEL::VARCHAR,
                $1:MIN_LAT::FLOAT,
                $1:MAX_LAT::FLOAT,
                $1:MIN_LON::FLOAT,
                $1:MAX_LON::FLOAT,
                TRY_TO_GEOGRAPHY($1:BOUNDARY_WKB::VARCHAR),
                $1:BOUNDARY_SOURCE::VARCHAR,
                $1:BOUNDARY_VERTICES::INT,
                $1:BOUNDARY_AREA_KM2::FLOAT,
                $1:BOUNDARY_BAKED_AT::DATE,
                SYSDATE()
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
    CREATED_AT TIMESTAMP_NTZ DEFAULT SYSDATE(),
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

-- Durable repair telemetry (survives REBUILD_REGION_GRAPHS stage purge).
-- Used by REPAIR_STUCK_REGION_BUILDS for byte-growth stall detection and
-- per-region repair rate-limiting so a false-positive cannot loop forever.
CREATE TABLE IF NOT EXISTS OPENROUTESERVICE_APP.CORE.REGION_REPAIR_LOG (
    REGION VARCHAR NOT NULL,
    LAST_REPAIR_AT TIMESTAMP_NTZ,
    REPAIR_COUNT INTEGER DEFAULT 0,
    LAST_GRAPH_BYTES NUMBER DEFAULT 0,
    LAST_PROBED_AT TIMESTAMP_NTZ
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"rescue","action":"repair-log"}}';

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
    pbf_dl_status VARCHAR DEFAULT '';
    dl_failed BOOLEAN DEFAULT FALSE;
BEGIN
    -- Build-tier JVM heap headroom for build-history telemetry. NOTE: as of the
    -- family-derived heap change, BUILD_ORS_SERVICE_SPEC sizes XMS/XMX from the
    -- resolved instance_family (not the size tier). At BUILD time the family is
    -- the large build family for the tier, so these size-tier values remain a
    -- close approximation of the build-time heap (XXL~1080G, L~740G); they are
    -- intentionally NOT the smaller RUNTIME heap a region gets after downsize.
    xmx_gib := CASE UPPER(:P_COMPUTE_SIZE)
        WHEN 'XXL' THEN 1100 WHEN 'L' THEN 700
        WHEN 'S' THEN 20 ELSE 700 END;

    INSERT INTO OPENROUTESERVICE_APP.CORE.ORS_BUILD_HISTORY
        (BUILD_ID, JOB_ID, REGION, PBF_URL, PROFILES, COMPUTE_SIZE,
         JVM_XMX_GIB, STARTED_AT, EXIT_STATUS, ORS_VERSION)
    VALUES
        (:build_id, :P_JOB_ID, :P_REGION, :P_PBF_URL, :P_PROFILES, :P_COMPUTE_SIZE,
         :xmx_gib, SYSDATE(), 'IN_PROGRESS', 'v9.0.0');

    UPDATE OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
    SET COMPUTE_SIZE = :P_COMPUTE_SIZE
    WHERE JOB_ID = :P_JOB_ID;

    UPDATE OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
    SET STATUS='RUNNING', STAGE='DOWNLOADING', STARTED_AT=SYSDATE(),
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
        dl_failed := FALSE;
        BEGIN
            pbf_dl_status := '';
            EXECUTE IMMEDIATE 'SELECT OPENROUTESERVICE_APP.CORE.DOWNLOAD(''ors_spcs_stage/' || :P_REGION || ''', ''' || :pbf_filename || ''', ''' || :P_PBF_URL || ''')';

            FOR poll_i IN 1 TO 720 DO
                rs := (EXECUTE IMMEDIATE 'SELECT OPENROUTESERVICE_APP.CORE.DOWNLOAD_STATUS(''ors_spcs_stage/' || :P_REGION || ''', ''' || :pbf_filename || ''')::VARCHAR AS S');
                pbf_dl_status := '';
                FOR r IN rs DO
                    pbf_dl_status := COALESCE(r.S, '');
                END FOR;

                IF (LOWER(TRIM(:pbf_dl_status)) = 'success') THEN
                    BREAK;
                ELSEIF (LOWER(TRIM(:pbf_dl_status)) IN ('started', 'in_progress', 'not_started')) THEN
                    UPDATE OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
                    SET MESSAGE = 'Downloading PBF file (' || :pbf_dl_status || ', poll ' || :poll_i || '/720)...'
                    WHERE JOB_ID = :P_JOB_ID;
                    EXECUTE IMMEDIATE 'SELECT SYSTEM$WAIT(30)';
                ELSE
                    BREAK;
                END IF;
            END FOR;

            IF (LOWER(TRIM(:pbf_dl_status)) <> 'success') THEN
                dl_failed := TRUE;
            END IF;
        EXCEPTION WHEN OTHER THEN
            dl_failed := TRUE;
            pbf_dl_status := SQLERRM;
        END;

        IF (:dl_failed) THEN
            LET dl_err STRING := CASE
                WHEN LOWER(TRIM(:pbf_dl_status)) IN ('started', 'in_progress', 'not_started')
                    THEN 'PBF download timed out after 720 polls (last status: ' || COALESCE(:pbf_dl_status, 'unknown') || ')'
                ELSE 'PBF download failed: ' || COALESCE(:pbf_dl_status, 'unknown status')
            END;
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
                    VALUES (:P_REGION, 'pbf_download_failure_suspend', SYSDATE(),
                            'svc_state=' || :dl_svc_state || '; err=' || :dl_err);
                EXCEPTION WHEN OTHER THEN NULL;
                END;
            END IF;
            UPDATE OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS SET STATUS='FAILED', MESSAGE=:dl_err WHERE JOB_ID = :P_JOB_ID;
            -- Parity with timeout handler: reset REGION_ORS_MAP so the region is
            -- not stuck in PROVISIONING after a download failure (the per-region
            -- service was never created, so 'FAILED' marks it as a clean retry candidate).
            UPDATE OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP
            SET STATUS = 'FAILED', UPDATED_AT = SYSDATE()
            WHERE REGION = :P_REGION;
            UPDATE OPENROUTESERVICE_APP.CORE.ORS_BUILD_HISTORY
            SET FINISHED_AT = SYSDATE(),
                ELAPSED_MINUTES = TIMESTAMPDIFF(SECOND, STARTED_AT, SYSDATE()) / 60.0,
                EXIT_STATUS = 'ERROR',
                LOG_URI = :dl_err
            WHERE BUILD_ID = :build_id;
            RETURN OBJECT_CONSTRUCT('status', 'FAILED', 'error', :dl_err)::VARCHAR;
        END IF;
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
                -- Persistence gate: service_ready=true does NOT prove graphs synced
                -- to the stage object store (upload lags the container view). Only
                -- finalize when every requested profile is artifact-complete on the
                -- stage. If not yet persisted, keep waiting; the wrapper may exit on
                -- timeout and the rescue task finalizes once artifacts land.
                LET graphs_ok BOOLEAN := FALSE;
                BEGIN
                    CALL OPENROUTESERVICE_APP.CORE.GRAPHS_ARTIFACT_COMPLETE(:P_REGION, :P_PROFILES) INTO :graphs_ok;
                EXCEPTION WHEN OTHER THEN graphs_ok := FALSE;
                END;
                IF (:profile_count > 0 AND :graphs_ok) THEN
                    UPDATE OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP SET STATUS='DEPLOYED' WHERE REGION = :P_REGION;
                    BEGIN
                        EXECUTE IMMEDIATE 'ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ORS_SERVICE_' || UPPER(:P_REGION) || ' SET AUTO_SUSPEND_SECS = 14400';
                    EXCEPTION WHEN OTHER THEN NULL;
                    END;
                    -- Restore pool auto-suspend on success path. Was set to 0
                    -- during provisioning to keep the build container alive
                    -- across silent CH/LM phases.
                    BEGIN
                        EXECUTE IMMEDIATE 'ALTER COMPUTE POOL IF EXISTS ORS_POOL_' || UPPER(:P_REGION) || ' SET AUTO_SUSPEND_SECS = 3600';
                    EXCEPTION WHEN OTHER THEN NULL;
                    END;
                    -- REBUILD_GRAPHS is now always false in the service spec, so
                    -- there is no post-build flag flip: the next suspend/resume
                    -- reuses the persisted graphs automatically.
                    -- Deploy a per-region VROOM service alongside the ORS service so
                    -- OPTIMIZATION calls for this region route to a VROOM that has
                    -- ORS_HOST=ors-service-<region>. Best-effort: a missing VROOM falls
                    -- back to the global service in the gateway.
                    BEGIN
                        CALL OPENROUTESERVICE_APP.CORE.create_region_vroom_service(:P_REGION);
                    EXCEPTION WHEN OTHER THEN NULL;
                    END;
                    -- Write success marker so create_region_ors_service can
                    -- safely reuse persisted graphs on the next deploy. Retried
                    -- (not silently swallowed): a lost marker is only a missed
                    -- optimization now (reuse is artifact-based, not marker-based),
                    -- but we still surface a persistent failure in MESSAGE.
                    BEGIN
                        LET mk_ok BOOLEAN := FALSE;
                        FOR mk_try IN 1 TO 3 DO
                            BEGIN
                                EXECUTE IMMEDIATE 'COPY INTO @OPENROUTESERVICE_APP.CORE.ORS_GRAPHS_SPCS_STAGE/' || :P_REGION ||
                                    '/_BUILD_OK FROM (SELECT ''ok'') FILE_FORMAT = (TYPE = CSV) SINGLE = TRUE OVERWRITE = TRUE';
                                mk_ok := TRUE;
                            EXCEPTION WHEN OTHER THEN mk_ok := FALSE;
                            END;
                            IF (:mk_ok) THEN BREAK; END IF;
                            EXECUTE IMMEDIATE 'SELECT SYSTEM$WAIT(2)';
                        END FOR;
                        IF (NOT :mk_ok) THEN
                            UPDATE OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
                            SET MESSAGE = COALESCE(MESSAGE, '') || ' [build_ok_marker_write_failed]'
                            WHERE JOB_ID = :P_JOB_ID;
                        END IF;
                    EXCEPTION WHEN OTHER THEN NULL;
                    END;
                    -- Seed Route Optimization PLACES from Overture Maps for this
                    -- region so the Route Optimization page works on first open
                    -- without a manual region switch. Best-effort: failures don't
                    -- block successful provisioning. The procedure is idempotent
                    -- (skips if PLACES already populated for the region).
                    BEGIN
                        CALL FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SEED_ROUTE_OPTIMIZATION_REGION(:P_REGION);
                    EXCEPTION WHEN OTHER THEN
                        -- Surface seed failures in REGION_PROVISION_JOBS.MESSAGE so they
                        -- are visible in the UI status panel. Do not block provisioning;
                        -- the React page calls /api/route-optimization/ensure-seeded as
                        -- a self-healing fallback the next time a user opens the page.
                        UPDATE OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
                        SET MESSAGE = COALESCE(MESSAGE, '') || ' [route_opt_seed_failed: ' || COALESCE(SQLERRM, 'unknown') || ']'
                        WHERE JOB_ID = :P_JOB_ID;
                    END;
                    UPDATE OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
                    SET STATUS='COMPLETE', STAGE='READY',
                        MESSAGE='Region provisioned — ' || :profile_count || ' profile(s) ready (REBUILD_GRAPHS=false for fast resume)',
                        COMPLETED_AT=SYSDATE()
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
                    SET FINISHED_AT = SYSDATE(),
                        ELAPSED_MINUTES = TIMESTAMPDIFF(SECOND, STARTED_AT, SYSDATE()) / 60.0,
                        EXIT_STATUS = 'SUCCESS',
                        PEAK_RSS_GIB = :peak_rss
                    WHERE BUILD_ID = :build_id;
                    -- Auto-downsize the runtime service to a smaller serving tier
                    -- so the user does not pay 24/7 build-tier rates for steady-state
                    -- querying. Level-driven mapping lives in DOWNSIZE_REGION_AFTER_BUILD
                    -- (city -> GEN_X64_G2_4/RAM_STORE; country/sub-region/continent ->
                    -- CPU_X64_SL/MMAP). Fires for EVERY completed build, including city
                    -- (which now shrinks below its GEN_X64_G2_8 build box). Best-effort;
                    -- failure is non-fatal so the build still reports COMPLETE -- but a
                    -- DEGRADED/Refusing result is recorded on the job row so the silent
                    -- "downsized to a dead service" case is observable.
                    BEGIN
                        LET dz_msg VARCHAR := '';
                        CALL OPENROUTESERVICE_APP.CORE.DOWNSIZE_REGION_AFTER_BUILD(:P_REGION, :P_COMPUTE_SIZE) INTO :dz_msg;
                        IF (:dz_msg LIKE 'DEGRADED:%' OR :dz_msg LIKE 'Refusing%') THEN
                            UPDATE OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
                               SET ERROR_MSG = LEFT(COALESCE(ERROR_MSG || ' | ', '') || 'downsize: ' || :dz_msg, 4000)
                             WHERE JOB_ID = :P_JOB_ID;
                        END IF;
                    EXCEPTION WHEN OTHER THEN NULL;
                    END;
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

        -- Fix 6a: phase-marker writer. As graph artifacts appear on the stage,
        -- write tiny marker files so a future container restart can do a
        -- partial resume instead of wiping everything for a full rebuild.
        -- Each marker is written at most once (REMOVE-on-mismatch in
        -- CREATE_REGION_ORS_SERVICE will clean these up if files don't agree).
        --   _OSM_DONE -> location_index present
        --   _LM_DONE  -> landmarks_*_with_turn_costs present
        --   _CH_DONE  -> nodes_ch_* AND shortcuts_* both present
        BEGIN
            EXECUTE IMMEDIATE 'LIST @OPENROUTESERVICE_APP.CORE.ORS_GRAPHS_SPCS_STAGE/' || :P_REGION || '/';
            LET rs_m RESULTSET := (SELECT
                BOOLOR_AGG("name" ILIKE '%/location_index')                AS HAS_OSM,
                BOOLOR_AGG("name" ILIKE '%/landmarks\\_%\\_with\\_turn\\_costs') AS HAS_LM,
                BOOLOR_AGG("name" ILIKE '%/nodes\\_ch\\_%')                 AS HAS_CH_NODES,
                BOOLOR_AGG("name" ILIKE '%/shortcuts\\_%')                  AS HAS_CH_SHORTCUTS,
                BOOLOR_AGG("name" ILIKE '%/\\_OSM\\_DONE%')                 AS MARKER_OSM,
                BOOLOR_AGG("name" ILIKE '%/\\_LM\\_DONE%')                  AS MARKER_LM,
                BOOLOR_AGG("name" ILIKE '%/\\_CH\\_DONE%')                  AS MARKER_CH
                FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())));
            LET c_m CURSOR FOR rs_m;
            FOR mr IN c_m DO
                IF (mr.HAS_OSM AND NOT COALESCE(mr.MARKER_OSM, FALSE)) THEN
                    BEGIN
                        EXECUTE IMMEDIATE 'COPY INTO @OPENROUTESERVICE_APP.CORE.ORS_GRAPHS_SPCS_STAGE/' || :P_REGION ||
                            '/_OSM_DONE FROM (SELECT ''ok'') FILE_FORMAT = (TYPE = CSV) SINGLE = TRUE OVERWRITE = TRUE';
                    EXCEPTION WHEN OTHER THEN NULL;
                    END;
                END IF;
                IF (mr.HAS_LM AND NOT COALESCE(mr.MARKER_LM, FALSE)) THEN
                    BEGIN
                        EXECUTE IMMEDIATE 'COPY INTO @OPENROUTESERVICE_APP.CORE.ORS_GRAPHS_SPCS_STAGE/' || :P_REGION ||
                            '/_LM_DONE FROM (SELECT ''ok'') FILE_FORMAT = (TYPE = CSV) SINGLE = TRUE OVERWRITE = TRUE';
                    EXCEPTION WHEN OTHER THEN NULL;
                    END;
                END IF;
                IF (mr.HAS_CH_NODES AND mr.HAS_CH_SHORTCUTS AND NOT COALESCE(mr.MARKER_CH, FALSE)) THEN
                    BEGIN
                        EXECUTE IMMEDIATE 'COPY INTO @OPENROUTESERVICE_APP.CORE.ORS_GRAPHS_SPCS_STAGE/' || :P_REGION ||
                            '/_CH_DONE FROM (SELECT ''ok'') FILE_FORMAT = (TYPE = CSV) SINGLE = TRUE OVERWRITE = TRUE';
                    EXCEPTION WHEN OTHER THEN NULL;
                    END;
                END IF;
            END FOR;
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
        COMPLETED_AT=SYSDATE()
    WHERE JOB_ID = :P_JOB_ID;
    UPDATE OPENROUTESERVICE_APP.CORE.ORS_BUILD_HISTORY
    SET FINISHED_AT = SYSDATE(),
        ELAPSED_MINUTES = TIMESTAMPDIFF(SECOND, STARTED_AT, SYSDATE()) / 60.0,
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
                VALUES (:P_REGION, 'wrapper_exception_suspend', SYSDATE(),
                        'svc_state=' || :svc_state || '; err=' || :err_msg);
            EXCEPTION WHEN OTHER THEN NULL;
            END;
        END IF;
        UPDATE OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
        SET STATUS='ERROR', ERROR_MSG=:err_msg, COMPLETED_AT=SYSDATE()
        WHERE JOB_ID = :P_JOB_ID;
        -- Heuristic: surface OOM separately so RECOMMEND_RETRY_STRATEGY can
        -- recommend SPLIT_PROFILES instead of REBUILD_SAME.
        UPDATE OPENROUTESERVICE_APP.CORE.ORS_BUILD_HISTORY
        SET FINISHED_AT = SYSDATE(),
            ELAPSED_MINUTES = TIMESTAMPDIFF(SECOND, STARTED_AT, SYSDATE()) / 60.0,
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
        'created_at', TO_VARCHAR(CREATED_AT, 'YYYY-MM-DD"T"HH24:MI:SS') || 'Z',
        'started_at', COALESCE(TO_VARCHAR(STARTED_AT, 'YYYY-MM-DD"T"HH24:MI:SS') || 'Z', ''),
        'completed_at', COALESCE(TO_VARCHAR(COMPLETED_AT, 'YYYY-MM-DD"T"HH24:MI:SS') || 'Z', '')
    )), ARRAY_CONSTRUCT())::VARCHAR INTO result
    FROM OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
    WHERE CREATED_AT > DATEADD('day', -30, SYSDATE())
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
    GRAPHS_DATA_ACCESS VARCHAR DEFAULT 'RAM_STORE',
    IS_DEFAULT BOOLEAN DEFAULT FALSE,
    NEEDS_PREWARM BOOLEAN DEFAULT FALSE,
    CREATED_AT TIMESTAMP DEFAULT SYSDATE(),
    UPDATED_AT TIMESTAMP DEFAULT SYSDATE()
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"multi-region"}}';

-- Idempotent backfill of GRAPHS_DATA_ACCESS for installs created before this
-- column existed. Per the ADD COLUMN IF NOT EXISTS gotcha (it can raise a
-- compile-time "ambiguous column" error when the column already exists), the
-- ALTER is wrapped in an EXCEPTION-swallowing EXECUTE IMMEDIATE so a fresh
-- install (where the CREATE TABLE above already has the column) is a clean no-op.
EXECUTE IMMEDIATE $$
BEGIN
    ALTER TABLE OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP
        ADD COLUMN IF NOT EXISTS GRAPHS_DATA_ACCESS VARCHAR DEFAULT 'RAM_STORE';
    RETURN 'ok';
EXCEPTION WHEN OTHER THEN RETURN 'skipped';
END;
$$;

-- Idempotent backfill of NEEDS_PREWARM (set TRUE by the resume/limits/downsize
-- paths for MMAP regions; drained by the RESCUE_PENDING_PROVISIONS reconciler).
-- Same EXECUTE IMMEDIATE wrapper as above so the bare ADD COLUMN can't abort the
-- module on installs that already have the column.
EXECUTE IMMEDIATE $$
BEGIN
    ALTER TABLE OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP
        ADD COLUMN IF NOT EXISTS NEEDS_PREWARM BOOLEAN DEFAULT FALSE;
    RETURN 'ok';
EXCEPTION WHEN OTHER THEN RETURN 'skipped';
END;
$$;

-- Idempotent migration for installs created before IS_DEFAULT existed.
-- Disabled 2026-05-19: triggers "ambiguous column name 'IS_DEFAULT'" on
-- fresh installs where the CREATE TABLE above already includes IS_DEFAULT.
-- ALTER TABLE OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP ADD COLUMN IF NOT EXISTS IS_DEFAULT BOOLEAN DEFAULT FALSE;

-- Seed the canonical default region (SanFrancisco) so LIST_REGIONS() returns
-- it alongside user-provisioned regions. Pre-v1.1.0 the legacy global
-- ORS_SERVICE was surfaced as a synthetic region:'default' entry by the
-- control app server. v1.1.0 unification gives every region its own
-- ORS_SERVICE_<REGION> -- including SanFrancisco -- so the default is no
-- longer special and lives in the registry like any other region.
MERGE INTO OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP t USING (
    SELECT 'SanFrancisco' AS REGION
) s ON t.REGION = s.REGION
WHEN NOT MATCHED THEN INSERT (REGION, DISPLAY_NAME, MIN_LAT, MAX_LAT, MIN_LON, MAX_LON, STATUS, IS_DEFAULT)
    VALUES ('SanFrancisco', 'San Francisco', 37.71, 37.81, -122.51, -122.37, 'DEPLOYED', TRUE)
WHEN MATCHED THEN UPDATE SET t.IS_DEFAULT = TRUE;

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
    FIRED_AT TIMESTAMP_LTZ DEFAULT SYSDATE(),
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

-- 4-arg form: when P_INSTANCE_FAMILY is a known family, the JVM heap (XMS/XMX)
-- is derived from that family's physical RAM (~10% XMS / ~75% XMX) instead of
-- the size tier. This keeps the heap coherent with the actual node after a
-- DOWNSIZE_REGION_AFTER_BUILD recreates the service on a smaller runtime family
-- (e.g. an 'L' region downsized onto HIGHMEM_X64_M / 240 GB now gets XMX 180G,
-- not the 700G build-tier ceiling). Unknown/NULL family falls back to the
-- legacy size-tier CASE so build-time specs and the 3-arg callers are unchanged.
CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE.BUILD_ORS_SERVICE_SPEC(
    P_REGION VARCHAR, P_COMPUTE_SIZE VARCHAR, P_REBUILD_GRAPHS VARCHAR, P_INSTANCE_FAMILY VARCHAR
)
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.1","attributes":{"component":"multi-region"}}'
AS
$$
    '{"spec":{"containers":[{"name":"ors","image":"/openrouteservice_app/core/image_repository/openrouteservice:v9.0.0","volumeMounts":[{"name":"files","mountPath":"/home/ors/files"},{"name":"graphs","mountPath":"/home/ors/graphs"},{"name":"elevation-cache","mountPath":"/home/ors/elevation_cache"}],"env":{"REBUILD_GRAPHS":"false","ORS_CONFIG_LOCATION":"/home/ors/files/ors-config.yml","XMS":"' ||
    CASE UPPER(COALESCE(P_INSTANCE_FAMILY, ''))
        WHEN 'HIGHMEM_X64_M'  THEN '16G'
        WHEN 'HIGHMEM_X64_L'  THEN '64G'
        WHEN 'HIGHMEM_X64_SL' THEN '48G'
        WHEN 'MEM_X64_G2_64'  THEN '32G'
        WHEN 'MEM_X64_G2_192' THEN '96G'
        WHEN 'CPU_X64_SL'     THEN '4G'
        WHEN 'GEN_X64_G2_4'   THEN '1G'
        ELSE (CASE UPPER(P_COMPUTE_SIZE) WHEN 'XXL' THEN '110G' WHEN 'L' THEN '70G' WHEN 'S' THEN '2G' ELSE '70G' END)
    END ||
    '","XMX":"' ||
    CASE UPPER(COALESCE(P_INSTANCE_FAMILY, ''))
        WHEN 'HIGHMEM_X64_M'  THEN '180G'
        WHEN 'HIGHMEM_X64_L'  THEN '740G'
        WHEN 'HIGHMEM_X64_SL' THEN '490G'
        WHEN 'MEM_X64_G2_64'  THEN '368G'
        WHEN 'MEM_X64_G2_192' THEN '1080G'
        WHEN 'CPU_X64_SL'     THEN '24G'
        WHEN 'GEN_X64_G2_4'   THEN '9G'
        ELSE (CASE UPPER(P_COMPUTE_SIZE) WHEN 'XXL' THEN '1100G' WHEN 'L' THEN '700G' WHEN 'S' THEN '20G' ELSE '700G' END)
    END ||
    '"}}],"endpoints":[{"name":"ors","port":8082,"public":false}],"volumes":[{"name":"files","source":"@OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/' || P_REGION ||
    '"},{"name":"graphs","source":"@OPENROUTESERVICE_APP.CORE.ORS_GRAPHS_SPCS_STAGE/' || P_REGION ||
    '"},{"name":"elevation-cache","source":"@OPENROUTESERVICE_APP.CORE.ORS_elevation_cache_SPCS_STAGE/' || P_REGION ||
    '"}]}}'
$$;

-- 3-arg form retained for backward compatibility (diagnostic call in the
-- control app's region registry, and any external caller). Delegates to the
-- 4-arg form with NULL family, preserving the legacy size-tier heap exactly.
CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE.BUILD_ORS_SERVICE_SPEC(
    P_REGION VARCHAR, P_COMPUTE_SIZE VARCHAR, P_REBUILD_GRAPHS VARCHAR
)
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.1","attributes":{"component":"multi-region"}}'
AS
$$
    OPENROUTESERVICE_APP.CORE.BUILD_ORS_SERVICE_SPEC(P_REGION, P_COMPUTE_SIZE, P_REBUILD_GRAPHS, NULL)
$$;

-- ---------------------------------------------------------------------------
-- GRAPHS_ARTIFACT_COMPLETE(region, profiles) -> BOOLEAN
-- Authoritative persistence check: returns TRUE only when EVERY requested
-- profile has stamp.txt + location_index under
-- @ORS_GRAPHS_SPCS_STAGE/<region>/<profile>/ (via DIRECTORY table; LIST is not
-- callable inside SQL procs). Refreshes the stage directory first so recent
-- graph writes from the container volume are visible.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.GRAPHS_ARTIFACT_COMPLETE(P_REGION VARCHAR, P_PROFILES VARCHAR)
RETURNS BOOLEAN
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"multi-region","action":"artifact-complete"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    rs RESULTSET;
    expected_count INTEGER DEFAULT 0;
    complete_count INTEGER DEFAULT 0;
    profiles_csv VARCHAR DEFAULT '';
    profile_arr ARRAY;
    idx INTEGER DEFAULT 0;
    p VARCHAR DEFAULT '';
    has_stamp BOOLEAN DEFAULT FALSE;
    has_osm BOOLEAN DEFAULT FALSE;
    file_cnt INTEGER DEFAULT 0;
    path_prefix VARCHAR DEFAULT '';
BEGIN
    profiles_csv := TRIM(COALESCE(:P_PROFILES, ''));
    profile_arr := SPLIT(:profiles_csv, ',');
    expected_count := ARRAY_SIZE(:profile_arr);
    IF (:expected_count = 0 OR :profiles_csv = '') THEN
        RETURN FALSE;
    END IF;
    -- DIRECTORY() is queryable inside SQL procs; LIST/RESULT_SCAN is not
    -- (Unsupported statement type 'LIST_FILES'). Refresh so recent graph writes
    -- from the container volume are visible before we gate COMPLETE.
    BEGIN
        EXECUTE IMMEDIATE 'ALTER STAGE OPENROUTESERVICE_APP.CORE.ORS_GRAPHS_SPCS_STAGE REFRESH';
    EXCEPTION WHEN OTHER THEN NULL;
    END;
    path_prefix := :P_REGION || '/';
    complete_count := 0;
    WHILE (:idx < :expected_count) DO
        p := TRIM(:profile_arr[:idx]::VARCHAR);
        IF (:p <> '') THEN
            has_stamp := FALSE;
            has_osm := FALSE;
            BEGIN
                rs := (SELECT COUNT(*) AS C
                       FROM DIRECTORY(@OPENROUTESERVICE_APP.CORE.ORS_GRAPHS_SPCS_STAGE)
                       WHERE RELATIVE_PATH ILIKE :path_prefix || :p || '/%stamp.txt%');
                LET c1 CURSOR FOR rs;
                FOR r IN c1 DO file_cnt := r.C; END FOR;
                IF (:file_cnt > 0) THEN has_stamp := TRUE; END IF;
                rs := (SELECT COUNT(*) AS C
                       FROM DIRECTORY(@OPENROUTESERVICE_APP.CORE.ORS_GRAPHS_SPCS_STAGE)
                       WHERE RELATIVE_PATH ILIKE :path_prefix || :p || '/%location_index%');
                LET c2 CURSOR FOR rs;
                file_cnt := 0;
                FOR r IN c2 DO file_cnt := r.C; END FOR;
                IF (:file_cnt > 0) THEN has_osm := TRUE; END IF;
            EXCEPTION WHEN OTHER THEN
                has_stamp := FALSE;
                has_osm := FALSE;
            END;
            IF (:has_stamp AND :has_osm) THEN
                complete_count := :complete_count + 1;
            END IF;
        END IF;
        idx := :idx + 1;
    END WHILE;
    RETURN (:complete_count >= :expected_count);
END;
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
    rebuild_flag VARCHAR DEFAULT 'false';
    has_build_ok BOOLEAN DEFAULT FALSE;
    vroom_existed BOOLEAN DEFAULT FALSE;
    rs RESULTSET;
BEGIN
    svc_name := 'ORS_SERVICE_' || UPPER(:P_REGION);
    pool_name := 'ORS_POOL_' || UPPER(:P_REGION);

    -- Guard against tearing down an in-flight build. If a build job for this
    -- region is RUNNING/PENDING AND the ORS service already exists with a live
    -- container that is actively building (container status RUNNING/READY but
    -- ORS not yet service_ready), refuse to DROP/CREATE. This prevents a
    -- re-provision / family reconciliation from killing an in-progress
    -- multi-hour graph build (the trigger behind the Europe rebuild incident).
    -- It does NOT block the wrapper's own initial create: at that point the
    -- container does not exist yet (or is not a live-building container), so
    -- the guard does not fire. A fully-ready service (service_ready=true) is
    -- also not blocked, since dropping it does not lose an in-progress build.
    BEGIN
        LET guard_job_cnt INTEGER := 0;
        SELECT COUNT(*) INTO :guard_job_cnt
        FROM OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
        WHERE REGION = :P_REGION AND STATUS IN ('RUNNING','PENDING');
        IF (:guard_job_cnt > 0) THEN
            LET guard_svc_status VARCHAR := '';
            BEGIN
                EXECUTE IMMEDIATE 'SHOW SERVICES LIKE ''' || :svc_name || ''' IN SCHEMA OPENROUTESERVICE_APP.CORE';
                LET rs_g RESULTSET := (SELECT "status" AS S FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) LIMIT 1);
                LET c_g CURSOR FOR rs_g;
                FOR r IN c_g DO guard_svc_status := COALESCE(r.S, ''); END FOR;
            EXCEPTION WHEN OTHER THEN guard_svc_status := '';
            END;
            IF (:guard_svc_status IN ('RUNNING','READY')) THEN
                LET guard_ready BOOLEAN := FALSE;
                BEGIN
                    LET rs_gr RESULTSET := (EXECUTE IMMEDIATE 'SELECT COALESCE(TRY_PARSE_JSON(OPENROUTESERVICE_APP.CORE.ORS_STATUS(''' || :P_REGION || ''')::VARCHAR):service_ready::BOOLEAN, FALSE) AS R');
                    LET c_gr CURSOR FOR rs_gr;
                    FOR r IN c_gr DO guard_ready := COALESCE(r.R, FALSE); END FOR;
                EXCEPTION WHEN OTHER THEN guard_ready := FALSE;
                END;
                IF (NOT :guard_ready) THEN
                    RETURN 'SKIPPED: ' || :P_REGION || ' has an in-flight build (container alive, not yet service_ready) with an active provision job; refusing to drop/recreate the service.';
                END IF;
            END IF;
        END IF;
    EXCEPTION WHEN OTHER THEN NULL;
    END;

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

    -- Reuse policy (robust): NEVER force REBUILD_GRAPHS=true, and NEVER REMOVE
    -- graph files based on marker/artifact absence. Stock ORS v9 builds on an
    -- empty graph dir and loads an existing graph when present, so
    -- REBUILD_GRAPHS=false is correct in every normal case:
    --   * empty dir     -> ORS builds from the PBF (first build)
    --   * present graph -> ORS loads it (fast resume in seconds)
    -- A genuinely torn/corrupt graph is recovered out-of-band by an explicit,
    -- controlled stage purge (REBUILD_REGION_GRAPHS), never by this procedure
    -- silently wiping a directory because a best-effort _BUILD_OK marker failed
    -- to land. This removes the destructive "no markers -> REMOVE dir -> set
    -- REBUILD_GRAPHS=true" behavior that caused perpetual rebuild loops.
    rebuild_flag := 'false';

    -- Diagnostic-only probe (drives NO destructive action): record how many
    -- graph files are already staged and whether _BUILD_OK is present, purely
    -- for the return message / operator visibility.
    -- DIRECTORY() is queryable inside owner-rights SQL procs; LIST/RESULT_SCAN
    -- is NOT (raises "Unsupported statement type 'LIST_FILES'"), which silently
    -- forced graph_file_count=0 and disabled the runtime-family-reuse override
    -- below. Refresh first so recent container-side graph writes are visible.
    BEGIN
        EXECUTE IMMEDIATE 'ALTER STAGE OPENROUTESERVICE_APP.CORE.ORS_GRAPHS_SPCS_STAGE REFRESH';
    EXCEPTION WHEN OTHER THEN NULL;
    END;
    BEGIN
        rs := (SELECT COUNT(*) AS C,
                      BOOLOR_AGG(RELATIVE_PATH ILIKE :P_REGION || '/%_BUILD_OK%') AS HAS_OK
               FROM DIRECTORY(@OPENROUTESERVICE_APP.CORE.ORS_GRAPHS_SPCS_STAGE)
               WHERE RELATIVE_PATH ILIKE :P_REGION || '/%');
        LET c_mk CURSOR FOR rs;
        FOR r IN c_mk DO
            graph_file_count := r.C;
            has_build_ok := COALESCE(r.HAS_OK, FALSE);
        END FOR;
    EXCEPTION WHEN OTHER THEN
        graph_file_count := 0; has_build_ok := FALSE;
    END;

    -- ===== Runtime-family reuse =====
    -- Once a region has already been built (graph files present on the stage),
    -- honor the family recorded in REGION_ORS_MAP instead of re-resolving the
    -- large *build* family from the size tier. This makes a prior
    -- DOWNSIZE_REGION_AFTER_BUILD result sticky: without it, re-running
    -- create_region_ors_service for an XXL region would re-resolve
    -- MEM_X64_G2_192 and silently re-inflate the runtime pool the downsize had
    -- shrunk. A forced rebuild purges the graphs FIRST (REBUILD_REGION_GRAPHS),
    -- so graphs are absent there and the large build family is used as before.
    IF (:has_build_ok OR :graph_file_count > 0) THEN
        LET stored_family VARCHAR DEFAULT NULL;
        BEGIN
            SELECT INSTANCE_FAMILY INTO :stored_family
            FROM OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP WHERE REGION = :P_REGION;
        EXCEPTION WHEN OTHER THEN stored_family := NULL;
        END;
        IF (:stored_family IS NOT NULL AND TRIM(:stored_family) <> '') THEN
            instance_family := :stored_family;
        END IF;
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
        -- The per-region VROOM service is co-located in this pool. SPCS refuses
        -- to DROP a compute pool that still owns ANY service, so the VROOM must
        -- be dropped before the pool and recreated after it is rebuilt on the
        -- new family. (Omitting this is what silently broke
        -- DOWNSIZE_REGION_AFTER_BUILD: the pool DROP failed and the family swap
        -- never happened.)
        BEGIN EXECUTE IMMEDIATE 'DROP SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.VROOM_SERVICE_' || UPPER(:P_REGION);
            vroom_existed := TRUE;
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

    -- Pass the resolved instance_family so the spec's JVM heap matches the node
    -- RAM (coherent on downsized runtime families, not just the build tier).
    ors_spec := OPENROUTESERVICE_APP.CORE.BUILD_ORS_SERVICE_SPEC(:P_REGION, :P_COMPUTE_SIZE, :rebuild_flag, :instance_family);

    EXECUTE IMMEDIATE 'DROP SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.' || svc_name;
    create_sql := 'CREATE SERVICE OPENROUTESERVICE_APP.CORE.' || svc_name || ' IN COMPUTE POOL ' || :pool_name || ' FROM SPECIFICATION ''' || ors_spec || ''' MIN_INSTANCES = 1 MAX_INSTANCES = 1 AUTO_SUSPEND_SECS = 0 COMMENT = ''{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"multi-region"}}''';
    EXECUTE IMMEDIATE :create_sql;

    -- If a family swap dropped the co-located VROOM service above, recreate it in
    -- the freshly-rebuilt pool so OPTIMIZATION for this region still routes to a
    -- region-local VROOM. Idempotent (CREATE SERVICE IF NOT EXISTS inside).
    IF (:vroom_existed) THEN
        BEGIN
            CALL OPENROUTESERVICE_APP.CORE.create_region_vroom_service(:P_REGION);
        EXCEPTION WHEN OTHER THEN NULL;
        END;
    END IF;

    MERGE INTO OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP t
    USING (SELECT :P_REGION AS REGION) s ON t.REGION = s.REGION
    WHEN MATCHED THEN UPDATE SET
        STATUS = 'DEPLOYED',
        COMPUTE_SIZE = :P_COMPUTE_SIZE,
        INSTANCE_FAMILY = :instance_family,
        UPDATED_AT = SYSDATE()
    WHEN NOT MATCHED THEN INSERT (REGION, DISPLAY_NAME, STATUS, COMPUTE_SIZE, INSTANCE_FAMILY, UPDATED_AT)
        VALUES (:P_REGION, :P_REGION, 'DEPLOYED', :P_COMPUTE_SIZE, :instance_family, SYSDATE());

    RETURN 'Region ORS service created for ' || :P_REGION || ' (REBUILD_GRAPHS=' || :rebuild_flag || ', existing graph files: ' || :graph_file_count || ', build_ok=' || :has_build_ok || ')';
END;
$$;

-- Re-applies a region's ORS service spec via ALTER SERVICE FROM SPECIFICATION.
-- NOTE: BUILD_ORS_SERVICE_SPEC now hardcodes REBUILD_GRAPHS=false, so P_REBUILD
-- has no effect on the rebuild flag (true is fully eliminated from the system);
-- this proc is retained only as a spec re-apply helper. Forced rebuilds go
-- through REBUILD_REGION_GRAPHS (explicit stage purge + cycle), not this proc.
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
    inst_family VARCHAR DEFAULT NULL;
    ors_spec VARCHAR;
    rs RESULTSET;
BEGIN
    svc_name := 'ORS_SERVICE_' || UPPER(:P_REGION);

    rs := (SELECT COALESCE(COMPUTE_SIZE, 'M') AS CS, INSTANCE_FAMILY AS IF FROM OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP WHERE REGION = :P_REGION);
    LET c CURSOR FOR rs;
    FOR r IN c DO compute_size := r.CS; inst_family := r.IF; END FOR;

    -- Pass the stored instance_family so the re-applied spec keeps a heap that
    -- matches the node RAM (coherent after a downsize).
    ors_spec := OPENROUTESERVICE_APP.CORE.BUILD_ORS_SERVICE_SPEC(:P_REGION, :compute_size, :P_REBUILD, :inst_family);

    EXECUTE IMMEDIATE 'ALTER SERVICE OPENROUTESERVICE_APP.CORE.' || svc_name ||
        ' FROM SPECIFICATION ''' || ors_spec || '''';

    RETURN 'REBUILD_GRAPHS set to ' || LOWER(:P_REBUILD) || ' for ' || :P_REGION ||
           ' (takes effect on next container start)';
END;
$$;

-- Force a full graph rebuild for a region (PBF update / corruption recovery).
-- Purges the persisted graph dir and cycles the service; the spec is always
-- REBUILD_GRAPHS=false, so ORS rebuilds from the PBF into the empty dir. No
-- REBUILD_GRAPHS=true is ever used. Readiness wait scales with region size.
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

    -- Region-sized readiness wait. A continental graph rebuild can take hours;
    -- a fixed 30-min cap would give up mid-build. Tier from the region's size.
    LET compute_size VARCHAR DEFAULT 'L';
    BEGIN
        SELECT COALESCE(COMPUTE_SIZE, 'L') INTO :compute_size
        FROM OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP WHERE REGION = :P_REGION;
    EXCEPTION WHEN OTHER THEN compute_size := 'L';
    END;
    LET wait_iters INTEGER := CASE UPPER(:compute_size)
        WHEN 'S' THEN 120 WHEN 'L' THEN 480 WHEN 'XXL' THEN 720 ELSE 480 END;  -- x 30s

    -- Forced rebuild WITHOUT REBUILD_GRAPHS=true: the spec is always
    -- REBUILD_GRAPHS=false, so we explicitly purge the persisted graph dir and
    -- cycle the service. On resume ORS sees an empty graph dir and rebuilds from
    -- the PBF. This keeps ORS's destructive in-container wipe semantics out of
    -- the codebase entirely (no path can wipe a dir out from under a reuse).
    BEGIN
        EXECUTE IMMEDIATE 'REMOVE @OPENROUTESERVICE_APP.CORE.ORS_GRAPHS_SPCS_STAGE/' || :P_REGION || '/';
    EXCEPTION WHEN OTHER THEN NULL;
    END;

    -- Disable auto time-based suspension for the duration of the rebuild so the
    -- service cannot auto-suspend while graphs are being computed.
    BEGIN
        EXECUTE IMMEDIATE 'ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.' || svc_name || ' SET AUTO_SUSPEND_SECS = 0';
    EXCEPTION WHEN OTHER THEN NULL;
    END;

    -- Re-upsize the pool to the build family before rebuilding. After a region
    -- has been downsized (DOWNSIZE_REGION_AFTER_BUILD) its pool sits on the small
    -- runtime family; rebuilding a continental graph there would OOM. The graph
    -- dir was just purged above, so create_region_ors_service resolves the LARGE
    -- build family (the runtime-family-reuse override only fires when graphs are
    -- present) and reconciles the pool back up, recreating the service so it
    -- rebuilds from the PBF. If an in-flight build guard fires (SKIPPED) or the
    -- recreate errors, fall back to an in-place cycle on the existing pool.
    LET rebuild_recreate VARCHAR DEFAULT '';
    BEGIN
        CALL OPENROUTESERVICE_APP.CORE.create_region_ors_service(:P_REGION, :compute_size) INTO :rebuild_recreate;
    EXCEPTION WHEN OTHER THEN rebuild_recreate := 'ERROR';
    END;
    IF (:rebuild_recreate LIKE 'SKIPPED%' OR :rebuild_recreate = 'ERROR') THEN
        EXECUTE IMMEDIATE 'ALTER SERVICE OPENROUTESERVICE_APP.CORE.' || svc_name || ' SUSPEND';
        EXECUTE IMMEDIATE 'SELECT SYSTEM$WAIT(5)';
        EXECUTE IMMEDIATE 'ALTER SERVICE OPENROUTESERVICE_APP.CORE.' || svc_name || ' RESUME';
    END IF;

    FOR i IN 1 TO :wait_iters DO
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

    -- No flag flip: the spec is always REBUILD_GRAPHS=false. ORS rebuilt into the
    -- (purged) graph dir, which persists via the stage-backed volume for resumes.

    -- Ensure a per-region VROOM service exists alongside the rebuilt ORS.
    -- Idempotent (CREATE SERVICE IF NOT EXISTS) so safe to call on rebuilds.
    BEGIN
        CALL OPENROUTESERVICE_APP.CORE.create_region_vroom_service(:P_REGION);
    EXCEPTION WHEN OTHER THEN NULL;
    END;

    -- Restore normal auto-suspend now that the rebuild is complete (success or timeout).
    BEGIN
        EXECUTE IMMEDIATE 'ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.' || svc_name || ' SET AUTO_SUSPEND_SECS = 14400';
    EXCEPTION WHEN OTHER THEN NULL;
    END;

    RETURN 'Rebuild complete for ' || :P_REGION || ' (' || :profile_count || ' profile(s) ready); graph dir purged and rebuilt with REBUILD_GRAPHS=false';
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

-- ===========================================================================
-- ORS service-level routing limits (per-region, runtime-only — no rebuild).
--
-- ORS_LIMIT_DEFAULTS() is the single source of truth for the default values
-- emitted into ors-config.yml. REGION_ORS_LIMITS stores per-region overrides
-- so a user can widen distance/waypoint/snapping/matrix/isochrone caps via the
-- control-app "Routing Limits" panel; WRITE_ORS_CONFIG reads both at config
-- generation time, so overrides survive every reprovision (Option A — limits
-- are never lost to a fresh build). Changing these requires only a container
-- restart (suspend/resume), never a graph rebuild.
-- ===========================================================================
CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE.ORS_LIMIT_DEFAULTS()
RETURNS VARIANT
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"ors-limits"}}'
AS
$$
    OBJECT_CONSTRUCT(
        'maximum_distance', 100000000,
        'maximum_distance_dynamic_weights', 100000000,
        'maximum_distance_avoid_areas', 100000000,
        'maximum_distance_alternative_routes', 100000000,
        'maximum_distance_round_trip_routes', 100000000,
        'maximum_visited_nodes', 100000000,
        'maximum_waypoints', 1000,
        'maximum_snapping_radius', 1000,
        'matrix_maximum_routes', 2000000,
        'matrix_maximum_visited_nodes', 100000000,
        'isochrones_maximum_locations', 2,
        'isochrones_maximum_intervals', 10,
        'isochrones_maximum_range_distance', 1500000,
        'isochrones_maximum_range_time', 18000
    )::VARIANT
$$;

CREATE TABLE IF NOT EXISTS OPENROUTESERVICE_APP.CORE.REGION_ORS_LIMITS (
    REGION     VARCHAR NOT NULL,
    LIMITS     VARIANT,
    UPDATED_AT TIMESTAMP_NTZ DEFAULT SYSDATE()
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"ors-limits"}}';

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
    import tempfile, os, json

    # Service-level routing limits: defaults from ORS_LIMIT_DEFAULTS(), then
    # per-region overrides from REGION_ORS_LIMITS. These are runtime-only caps
    # (applied on container restart, no graph rebuild). A safe inline fallback
    # is kept in case the helper objects are absent on an older deploy.
    limits = {
        'maximum_distance': 100000000,
        'maximum_distance_dynamic_weights': 100000000,
        'maximum_distance_avoid_areas': 100000000,
        'maximum_distance_alternative_routes': 100000000,
        'maximum_distance_round_trip_routes': 100000000,
        'maximum_visited_nodes': 100000000,
        'maximum_waypoints': 1000,
        'maximum_snapping_radius': 1000,
        'matrix_maximum_routes': 2000000,
        'matrix_maximum_visited_nodes': 100000000,
        'isochrones_maximum_locations': 2,
        'isochrones_maximum_intervals': 10,
        'isochrones_maximum_range_distance': 1500000,
        'isochrones_maximum_range_time': 18000,
    }
    try:
        d = session.sql("SELECT OPENROUTESERVICE_APP.CORE.ORS_LIMIT_DEFAULTS()::STRING AS D").collect()
        if d and d[0]['D']:
            limits.update({k: int(v) for k, v in json.loads(d[0]['D']).items() if v is not None})
    except Exception:
        pass
    try:
        region_lit = (p_region or '').replace("'", "''")
        rows = session.sql(
            "SELECT LIMITS::STRING AS L FROM OPENROUTESERVICE_APP.CORE.REGION_ORS_LIMITS "
            "WHERE UPPER(REGION) = UPPER('" + region_lit + "') LIMIT 1"
        ).collect()
        if rows and rows[0]['L']:
            for k, v in json.loads(rows[0]['L']).items():
                if k in limits and v is not None:
                    limits[k] = int(v)
    except Exception:
        pass

    # Per-region graph data-access mode (RAM_STORE default, MMAP opt-in). MMAP
    # memory-maps the on-disk graph instead of loading it into the JVM heap, so
    # a large graph fits on a small box with a small heap (at a slight per-query
    # latency cost). This is a load-time setting -- switching it only needs a
    # container restart, never a graph rebuild.
    graphs_data_access = 'RAM_STORE'
    try:
        region_lit2 = (p_region or '').replace("'", "''")
        gda_rows = session.sql(
            "SELECT COALESCE(GRAPHS_DATA_ACCESS, 'RAM_STORE') AS G FROM OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP "
            "WHERE UPPER(REGION) = UPPER('" + region_lit2 + "') LIMIT 1"
        ).collect()
        if gda_rows and gda_rows[0]['G']:
            graphs_data_access = str(gda_rows[0]['G']).strip().upper()
    except Exception:
        pass

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
    # init_threads>1 triggers ORS #2180 (parallel PBF-parse race -> profile build crash).
    # S-tier must stay at 1 for reliable city builds; L/XXL cap resume-load parallelism.
    profile_count = max(len(profiles_list), 1)
    cs = (p_compute_size or 'S').upper()
    if cs == 'S':
        init_cap = 1
    elif cs == 'L':
        init_cap = 4
    else:
        init_cap = 8
    init_threads = min(profile_count, init_cap)
    all_profiles = [
        'driving-car', 'driving-hgv', 'cycling-regular', 'cycling-road',
        'cycling-mountain', 'cycling-electric', 'foot-walking', 'foot-hiking', 'wheelchair'
    ]

    profile_lines = []
    for p in all_profiles:
        enabled = 'true' if p in profiles_list else 'false'
        profile_lines.append('      ' + p + ':')
        profile_lines.append('        enabled: ' + enabled)

    all_profiles_str = ', '.join(all_profiles)
    # maximum_snapping_radius is explicit so it survives ORS engine version
    # changes (the default has drifted between 350 and 400 across versions
    # and is too small for continental extracts -- see #43 and the
    # continental.yml preset in #54). 1000m is the safe value for any
    # single-region build; the continental preset overrides to 5000m.
    lines = [
        'ors:',
        '  engine:',
    ]
    # graphs_data_access goes directly under engine: (omitted when RAM_STORE so
    # the default behavior is byte-for-byte unchanged for non-MMAP regions).
    if graphs_data_access == 'MMAP':
        lines.append('    graphs_data_access: MMAP')
    lines += [
        '    init_threads: ' + str(init_threads),
        '    profile_default:',
        '      build:',
        '        source_file: /home/ors/files/' + p_pbf_file,
        '        instructions: false',
        '      service:',
        '        maximum_distance: ' + str(limits['maximum_distance']),
        '        maximum_distance_dynamic_weights: ' + str(limits['maximum_distance_dynamic_weights']),
        '        maximum_distance_avoid_areas: ' + str(limits['maximum_distance_avoid_areas']),
        '        maximum_distance_alternative_routes: ' + str(limits['maximum_distance_alternative_routes']),
        '        maximum_distance_round_trip_routes: ' + str(limits['maximum_distance_round_trip_routes']),
        '        maximum_visited_nodes: ' + str(limits['maximum_visited_nodes']),
        '        maximum_waypoints: ' + str(limits['maximum_waypoints']),
        '        maximum_snapping_radius: ' + str(limits['maximum_snapping_radius']),
        '    profiles:',
    ]
    yaml_content = '\n'.join(lines) + '\n' + '\n'.join(profile_lines) + '\n'
    yaml_content += '\n'.join([
        '  endpoints:',
        '    matrix:',
        '      maximum_visited_nodes: ' + str(limits['matrix_maximum_visited_nodes']),
        '      maximum_routes: ' + str(limits['matrix_maximum_routes']),
        '      maximum_routes_flexible: ' + str(limits['matrix_maximum_routes']),
        '    isochrones:',
        '      maximum_locations: ' + str(limits['isochrones_maximum_locations']),
        '      maximum_intervals: ' + str(limits['isochrones_maximum_intervals']),
        '      maximum_range_distance:',
        '        - profiles: ' + all_profiles_str,
        '          value: ' + str(limits['isochrones_maximum_range_distance']),
        '      maximum_range_time:',
        '        - profiles: ' + all_profiles_str,
        '          value: ' + str(limits['isochrones_maximum_range_time']),
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

    return 'ORS config written for ' + p_region + ' with profiles: ' + p_profiles + ', init_threads=' + str(init_threads) + ' (build ch=' + str(tc['ch_threads']) + ' lm=' + str(tc['lm_threads']) + ', max_distance=' + str(limits['maximum_distance']) + ', max_waypoints=' + str(limits['maximum_waypoints']) + ', graphs_data_access=' + graphs_data_access + ')'
$$;

-- ===========================================================================
-- APPLY_ORS_LIMITS — persist per-region service-level routing limits and apply
-- them WITHOUT a graph rebuild. Stores the overrides in REGION_ORS_LIMITS,
-- regenerates ors-config.yml on the region's stage (WRITE_ORS_CONFIG reads the
-- overrides), then suspend/resumes the regional ORS service so the new config
-- is read on container start. REBUILD_GRAPHS=false means the persisted graph is
-- reloaded, not recalculated. Profiles / pbf / compute are preserved by
-- re-deriving them (mirrors REROLL_ORS_CONFIG_INIT_THREADS), with an ORS_STATUS
-- fallback for the bootstrapped default region that has no provision-job row.
-- ===========================================================================
CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.APPLY_ORS_LIMITS(P_REGION VARCHAR, P_LIMITS VARCHAR)
RETURNS STRING
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"ors-limits"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    rs RESULTSET;
    pbf_url      VARCHAR DEFAULT NULL;
    pbf_file     VARCHAR DEFAULT '';
    profiles     VARCHAR DEFAULT '';
    compute_size VARCHAR DEFAULT 'S';
    svc_name     VARCHAR;
    svc_status   VARCHAR DEFAULT NULL;
    waited       INTEGER DEFAULT 0;
    write_msg    VARCHAR DEFAULT NULL;
    susp_msg     VARCHAR DEFAULT NULL;
    res_msg      VARCHAR DEFAULT NULL;
    warm_msg     VARCHAR DEFAULT NULL;
BEGIN
    IF (P_REGION IS NULL OR TRIM(P_REGION) = '') THEN
        RETURN OBJECT_CONSTRUCT('status', 'error', 'error', 'region required')::STRING;
    END IF;
    svc_name := 'ORS_SERVICE_' || REGEXP_REPLACE(UPPER(:P_REGION), '[^A-Z0-9_]', '');

    -- Self-healing: the table is created by this module on deploy, but ensure it
    -- exists in case the app calls this proc against an older partial deploy.
    CREATE TABLE IF NOT EXISTS OPENROUTESERVICE_APP.CORE.REGION_ORS_LIMITS (
        REGION     VARCHAR NOT NULL,
        LIMITS     VARIANT,
        UPDATED_AT TIMESTAMP_NTZ DEFAULT SYSDATE()
    );

    -- Upsert the per-region overrides (one row per region).
    DELETE FROM OPENROUTESERVICE_APP.CORE.REGION_ORS_LIMITS WHERE UPPER(REGION) = UPPER(:P_REGION);
    INSERT INTO OPENROUTESERVICE_APP.CORE.REGION_ORS_LIMITS (REGION, LIMITS, UPDATED_AT)
        SELECT :P_REGION, PARSE_JSON(:P_LIMITS), SYSDATE();

    -- Derive pbf / compute from REGION_ORS_MAP (mirror REROLL_ORS_CONFIG_INIT_THREADS).
    BEGIN
        SELECT PBF_URL, COALESCE(COMPUTE_SIZE, 'S')
          INTO :pbf_url, :compute_size
          FROM OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP
         WHERE UPPER(REGION) = UPPER(:P_REGION)
         LIMIT 1;
    EXCEPTION WHEN OTHER THEN pbf_url := NULL; compute_size := 'S';
    END;
    pbf_file := SPLIT_PART(COALESCE(:pbf_url, ''), '/', -1);
    IF (pbf_file = '' OR pbf_file IS NULL) THEN
        pbf_file := :P_REGION || '.osm.pbf';
    END IF;

    -- Preserve enabled profiles: most-recent non-failed provision job first.
    profiles := (
        SELECT PROFILES
          FROM OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
         WHERE UPPER(REGION) = UPPER(:P_REGION) AND PROFILES IS NOT NULL
         ORDER BY CASE WHEN COALESCE(STATUS, '') NOT IN ('FAILED', 'ERROR') THEN 0 ELSE 1 END,
                  COALESCE(COMPLETED_AT, STARTED_AT, CREATED_AT) DESC
         LIMIT 1
    );
    -- Fallback for the bootstrapped default region (no provision job): use the
    -- profiles currently loaded by the running engine.
    IF (profiles IS NULL OR TRIM(profiles) = '') THEN
        BEGIN
            rs := (EXECUTE IMMEDIATE
                'SELECT ARRAY_TO_STRING(OBJECT_KEYS(TRY_PARSE_JSON('
                || 'OPENROUTESERVICE_APP.CORE.ORS_STATUS(''' || :P_REGION || ''')::VARCHAR):profiles), '','') AS P');
            LET c CURSOR FOR rs;
            FOR r IN c DO profiles := r.P; END FOR;
        EXCEPTION WHEN OTHER THEN profiles := NULL;
        END;
    END IF;
    IF (profiles IS NULL OR TRIM(profiles) = '') THEN
        profiles := 'driving-car';
    END IF;

    -- Regenerate the staged config with the merged limits.
    CALL OPENROUTESERVICE_APP.CORE.WRITE_ORS_CONFIG(:P_REGION, :pbf_file, :profiles, :compute_size) INTO :write_msg;

    -- Cycle the service so the new config is read on container start. The
    -- persisted graph is reloaded (REBUILD_GRAPHS=false) — no recalculation.
    -- ALTER SERVICE ... SUSPEND is asynchronous, so poll SHOW SERVICES until the
    -- service actually reports SUSPENDED (cap ~60s) BEFORE resuming. A fixed
    -- WAIT(5) raced the suspend: if the container had not finished suspending,
    -- RESUME_SERVICE saw status RUNNING, short-circuited ("already running"),
    -- and the in-flight suspend then landed afterward — leaving the service
    -- SUSPENDED with the new config never loaded. That is the "service didn't
    -- restart / limits look unchanged" symptom.
    CALL OPENROUTESERVICE_APP.CORE.SUSPEND_SERVICE(:svc_name) INTO :susp_msg;
    waited := 0;
    LOOP
        SHOW SERVICES LIKE :svc_name IN SCHEMA OPENROUTESERVICE_APP.CORE;
        BEGIN
            SELECT "status" INTO :svc_status
              FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
             WHERE "is_job" = 'false'
             LIMIT 1;
        EXCEPTION WHEN OTHER THEN svc_status := NULL;
        END;
        IF (svc_status = 'SUSPENDED' OR waited >= 60) THEN
            BREAK;
        END IF;
        EXECUTE IMMEDIATE 'SELECT SYSTEM$WAIT(3)';
        waited := waited + 3;
    END LOOP;
    CALL OPENROUTESERVICE_APP.CORE.RESUME_SERVICE(:svc_name) INTO :res_msg;

    -- MMAP regions: flag for prewarm instead of warming inline. The */2 min
    -- RESCUE_PENDING_PROVISIONS reconciler drains NEEDS_PREWARM (it readiness-
    -- gates via a passive SHOW SERVICES status check), so the limits change
    -- returns promptly to the UI instead of blocking on a ~minute-long page-cache
    -- warm. Best-effort: a flag-write failure never fails the limits change.
    BEGIN
        IF ((SELECT UPPER(COALESCE(GRAPHS_DATA_ACCESS, 'RAM_STORE'))
               FROM OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP
              WHERE UPPER(REGION) = UPPER(:P_REGION) LIMIT 1) = 'MMAP') THEN
            UPDATE OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP
               SET NEEDS_PREWARM = TRUE, UPDATED_AT = SYSDATE()
             WHERE UPPER(REGION) = UPPER(:P_REGION);
            warm_msg := 'flagged-for-reconciler';
        END IF;
    EXCEPTION WHEN OTHER THEN warm_msg := 'prewarm-flag-skipped';
    END;

    RETURN OBJECT_CONSTRUCT(
        'status',       'ok',
        'region',       :P_REGION,
        'service',      :svc_name,
        'profiles',     :profiles,
        'compute_size', :compute_size,
        'write',        TRY_PARSE_JSON(:write_msg),
        'suspend',      TRY_PARSE_JSON(:susp_msg),
        'resume',       TRY_PARSE_JSON(:res_msg),
        'prewarm',      :warm_msg
    )::STRING;
EXCEPTION
    WHEN OTHER THEN
        RETURN OBJECT_CONSTRUCT('status', 'error', 'region', :P_REGION, 'error', SQLERRM)::STRING;
END;
$$;

-- ===========================================================================
-- PREWARM_REGION_GRAPH(region) -> summary string
-- ---------------------------------------------------------------------------
-- MMAP page-cache warmer. When a region serves its graph via
-- graphs_data_access: MMAP (GRAPHS_DATA_ACCESS='MMAP'), the on-disk graph is
-- memory-mapped and pages fault in from the (slow) stage-backed volume on
-- demand. The first long routes after a service start therefore spike to
-- 10s+ while the shared upper contraction-hierarchy pages fault in; once the
-- graph (which fits in the box's free RAM) is fully cached, routes drop to
-- sub-100ms and stay warm for the life of the container.
--
-- This proc forces that warm-up off the critical path by firing a star sweep
-- of long DIRECTIONS routes from the bbox centroid to a 5x5 lattice of points,
-- traversing the bulk of the network. Each call is independently EXCEPTION-
-- wrapped so an unsnappable (ocean / off-road) grid point never aborts the
-- sweep. Best-effort and idempotent: safe to call after any resume.
--
-- Call sites: resume_region_ors, APPLY_ORS_LIMITS, DOWNSIZE_REGION_AFTER_BUILD
-- (MMAP-gated at each caller). City RAM_STORE and legacy high-mem families skip.
--
-- AUTO_RESUME after idle (no proc hook): the first query after ORS auto-suspends
-- (idle >= AUTO_SUSPEND_SECS, default 14400) and SPCS auto-resumes the service
-- cannot be pre-warmed -- that query triggers the resume and pays the cold-fault
-- penalty once, then self-warms for the rest of the session. To eliminate that
-- spike, keep the service hot: ALTER SERVICE ORS_SERVICE_<REGION> SET
-- AUTO_SUSPEND_SECS = 0 (runs the cheap CPU_X64_SL box 24/7; a deliberate
-- exception to the 4h steady-state invariant). A periodic keep-warm TASK is
-- intentionally NOT used: prewarm resumes the service, so a TASK either keeps
-- the box always-on (erasing the MMAP cost saving) or runs too rarely to help.
-- ===========================================================================
CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.PREWARM_REGION_GRAPH(P_REGION VARCHAR)
RETURNS STRING
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"multi-region","action":"mmap-prewarm"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    min_lat FLOAT DEFAULT NULL;
    max_lat FLOAT DEFAULT NULL;
    min_lon FLOAT DEFAULT NULL;
    max_lon FLOAT DEFAULT NULL;
    profile VARCHAR DEFAULT 'driving-car';
    region_lit VARCHAR;
    ok_count INTEGER DEFAULT 0;
    try_count INTEGER DEFAULT 0;
    ready BOOLEAN DEFAULT FALSE;
    waited INTEGER DEFAULT 0;
    pts ARRAY DEFAULT NULL;
    n INTEGER DEFAULT 0;
    stride INTEGER DEFAULT 1;
    jj INTEGER DEFAULT 0;
    olon FLOAT DEFAULT NULL;
    olat FLOAT DEFAULT NULL;
    dlon FLOAT DEFAULT NULL;
    dlat FLOAT DEFAULT NULL;
    anchor_lon FLOAT DEFAULT NULL;
    anchor_lat FLOAT DEFAULT NULL;
    anchor_found BOOLEAN DEFAULT FALSE;
    started_at TIMESTAMP DEFAULT SYSDATE();
    rs RESULTSET;
BEGIN
    region_lit := REPLACE(:P_REGION, '''', '''''');

    -- Wait (bounded) until the engine is ready so callers that only fire-and-
    -- forget a RESUME (APPLY_ORS_LIMITS) can still hand off to this proc safely.
    WHILE (NOT :ready AND :waited < 300) DO
        BEGIN
            rs := (EXECUTE IMMEDIATE 'SELECT COALESCE(TRY_PARSE_JSON(OPENROUTESERVICE_APP.CORE.ORS_STATUS('''
                || :region_lit || ''')::VARCHAR):service_ready::BOOLEAN, FALSE) AS R');
            LET cr CURSOR FOR rs;
            FOR r IN cr DO ready := COALESCE(r.R, FALSE); END FOR;
        EXCEPTION WHEN OTHER THEN ready := FALSE;
        END;
        IF (NOT :ready) THEN
            CALL SYSTEM$WAIT(10);
            waited := TIMESTAMPDIFF(SECOND, :started_at, SYSDATE());
        END IF;
    END WHILE;
    IF (NOT :ready) THEN
        RETURN 'prewarm skipped: ' || :P_REGION || ' not ready after ' || :waited || 's';
    END IF;

    -- Region bounding box (centroid + lattice span).
    BEGIN
        SELECT MIN_LAT, MAX_LAT, MIN_LON, MAX_LON
          INTO :min_lat, :max_lat, :min_lon, :max_lon
          FROM OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP
         WHERE UPPER(REGION) = UPPER(:P_REGION) LIMIT 1;
    EXCEPTION WHEN OTHER THEN min_lat := NULL;
    END;
    IF (min_lat IS NULL OR max_lat IS NULL OR min_lon IS NULL OR max_lon IS NULL) THEN
        RETURN 'prewarm skipped: no bbox for ' || :P_REGION;
    END IF;

    -- Resolve the region's primary profile (most-recent non-failed provision
    -- job, else ORS_STATUS, else driving-car).
    BEGIN
        profile := (
            SELECT SPLIT_PART(PROFILES, ',', 1)
              FROM OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
             WHERE UPPER(REGION) = UPPER(:P_REGION) AND PROFILES IS NOT NULL
             ORDER BY CASE WHEN COALESCE(STATUS, '') NOT IN ('FAILED', 'ERROR') THEN 0 ELSE 1 END,
                      COALESCE(COMPLETED_AT, STARTED_AT, CREATED_AT) DESC
             LIMIT 1);
    EXCEPTION WHEN OTHER THEN profile := NULL;
    END;
    IF (profile IS NULL OR TRIM(profile) = '') THEN
        BEGIN
            rs := (EXECUTE IMMEDIATE 'SELECT ARRAY_TO_STRING(OBJECT_KEYS(TRY_PARSE_JSON('
                || 'OPENROUTESERVICE_APP.CORE.ORS_STATUS(''' || :region_lit || ''')::VARCHAR):profiles), '','') AS P');
            LET cp CURSOR FOR rs;
            FOR r IN cp DO profile := SPLIT_PART(r.P, ',', 1); END FOR;
        EXCEPTION WHEN OTHER THEN profile := NULL;
        END;
    END IF;
    IF (profile IS NULL OR TRIM(profile) = '') THEN profile := 'driving-car'; END IF;
    profile := TRIM(profile);

    -- Sample a 12x12 lattice over the bbox and keep only points that fall inside
    -- the region BOUNDARY polygon (REGION_CATALOG). This discards ocean / out-of-
    -- region points (a continental bbox centroid is often open sea) so the warm
    -- routes have routable land endpoints. Built via EXECUTE IMMEDIATE with the
    -- bbox numbers interpolated -- a declared CURSOR with :min_lon binds is not
    -- bound by an implicit FOR-IN open ("Bind variable not set").
    BEGIN
        rs := (EXECUTE IMMEDIATE
            'SELECT ARRAY_AGG(ARRAY_CONSTRUCT(g.glon, g.glat)) AS PTS FROM ('
            || 'SELECT ' || :min_lon || ' + (' || :max_lon || ' - ' || :min_lon || ') * (MOD(seq,12)/11.0) AS glon, '
            ||              :min_lat || ' + (' || :max_lat || ' - ' || :min_lat || ') * (FLOOR(seq/12)/11.0) AS glat '
            || 'FROM (SELECT ROW_NUMBER() OVER (ORDER BY SEQ4())-1 AS seq FROM TABLE(GENERATOR(ROWCOUNT=>144)))) g '
            || 'JOIN OPENROUTESERVICE_APP.CORE.REGION_CATALOG rc '
            || '  ON rc.BOUNDARY IS NOT NULL '
            || ' AND (UPPER(rc.LOOKUP_NAME)=UPPER(''' || :region_lit || ''') OR UPPER(rc.REGION_KEY)=UPPER(''' || :region_lit || ''')) '
            || 'WHERE ST_WITHIN(ST_MAKEPOINT(g.glon, g.glat), rc.BOUNDARY)');
        LET cg CURSOR FOR rs;
        FOR r IN cg DO pts := r.PTS; END FOR;
    EXCEPTION WHEN OTHER THEN pts := NULL;
    END;
    n := COALESCE(ARRAY_SIZE(:pts), 0);
    IF (:n < 2) THEN
        RETURN 'prewarm skipped: ' || :P_REGION
            || ' has no boundary land sample (n=' || :n || ') -- cannot pick routable warm points';
    END IF;

    -- The region BOUNDARY polygon over a continental extract still contains a lot
    -- of open sea (Atlantic, North Sea, Baltic, Mediterranean) and islands, so a
    -- geometric point is NOT guaranteed routable. Phase 1: discover a connected
    -- mainland anchor by probing pairs (i, i+n/2) until one actually routes
    -- (bounded to 25 probes). Each probe is a long route, so successes already
    -- warm the upper contraction hierarchy.
    FOR i IN 0 TO :n - 1 DO
        IF (NOT :anchor_found AND :try_count < 25) THEN
            jj := MOD(i + FLOOR(:n / 2), :n);
            olon := GET(GET(:pts, i), 0)::FLOAT;
            olat := GET(GET(:pts, i), 1)::FLOAT;
            dlon := GET(GET(:pts, :jj), 0)::FLOAT;
            dlat := GET(GET(:pts, :jj), 1)::FLOAT;
            try_count := try_count + 1;
            BEGIN
                rs := (EXECUTE IMMEDIATE
                    'SELECT DISTANCE FROM TABLE(OPENROUTESERVICE_APP.CORE.DIRECTIONS('
                    || '''' || :profile || ''', '
                    || 'ARRAY_CONSTRUCT(' || :olon || ', ' || :olat || '), '
                    || 'ARRAY_CONSTRUCT(' || :dlon || ', ' || :dlat || '), '
                    || '''' || :region_lit || '''))');
                LET cd CURSOR FOR rs;
                FOR r IN cd DO
                    IF (r.DISTANCE IS NOT NULL AND r.DISTANCE > 0) THEN
                        ok_count := ok_count + 1;
                        anchor_found := TRUE;
                        anchor_lon := :olon;
                        anchor_lat := :olat;
                    END IF;
                END FOR;
            EXCEPTION WHEN OTHER THEN NULL;
            END;
        END IF;
    END FOR;

    -- Phase 2: star from the verified anchor to a spread of land points. The
    -- anchor sits on the connected mainland network, so every reachable target
    -- yields a long route that faults more of the shared graph into page cache.
    IF (:anchor_found) THEN
        stride := GREATEST(1, FLOOR(:n / 30));
        FOR i IN 0 TO :n - 1 DO
            IF (MOD(i, :stride) = 0) THEN
                dlon := GET(GET(:pts, i), 0)::FLOAT;
                dlat := GET(GET(:pts, i), 1)::FLOAT;
                try_count := try_count + 1;
                BEGIN
                    rs := (EXECUTE IMMEDIATE
                        'SELECT DISTANCE FROM TABLE(OPENROUTESERVICE_APP.CORE.DIRECTIONS('
                        || '''' || :profile || ''', '
                        || 'ARRAY_CONSTRUCT(' || :anchor_lon || ', ' || :anchor_lat || '), '
                        || 'ARRAY_CONSTRUCT(' || :dlon || ', ' || :dlat || '), '
                        || '''' || :region_lit || '''))');
                    LET cd CURSOR FOR rs;
                    FOR r IN cd DO
                        IF (r.DISTANCE IS NOT NULL AND r.DISTANCE > 0) THEN ok_count := ok_count + 1; END IF;
                    END FOR;
                EXCEPTION WHEN OTHER THEN NULL;
                END;
            END IF;
        END FOR;
    END IF;

    RETURN 'prewarm ' || :P_REGION || ' profile=' || :profile || ': ' || :ok_count
        || '/' || :try_count || ' routes ok (land sample n=' || :n
        || ', anchor_found=' || :anchor_found || ') in '
        || TIMESTAMPDIFF(SECOND, :started_at, SYSDATE()) || 's';
EXCEPTION
    WHEN OTHER THEN
        RETURN 'prewarm error for ' || :P_REGION || ': ' || SQLERRM;
END;
$$;

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.resume_region_ors(P_REGION VARCHAR, P_WAIT_FOR_READY BOOLEAN DEFAULT TRUE, P_TIMEOUT_SECONDS INTEGER DEFAULT 900)
RETURNS STRING
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"multi-region"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    rs RESULTSET;
    ready BOOLEAN DEFAULT FALSE;
    elapsed INTEGER DEFAULT 0;
    poll_secs INTEGER DEFAULT 15;
    started_at TIMESTAMP DEFAULT SYSDATE();
BEGIN
    LET svc_name VARCHAR := 'ORS_SERVICE_' || UPPER(:P_REGION);
    EXECUTE IMMEDIATE 'ALTER SERVICE OPENROUTESERVICE_APP.CORE.' || svc_name || ' RESUME';
    BEGIN
        ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.routing_gateway_service RESUME;
    EXCEPTION WHEN OTHER THEN NULL;
    END;

    -- Block until ORS is actually warmed up, so the very next user query is not
    -- exposed to the connection_failed race during graph load. Caller can disable
    -- the wait with P_WAIT_FOR_READY = FALSE to retain legacy fire-and-forget.
    --
    -- ORS_STATUS reports service_ready=true the instant the engine accepts
    -- connections, but the very first /directions call after RESUME can still
    -- race with the in-memory graph load. After service_ready=true, fire one
    -- minimal DIRECTIONS canary via the gateway. If it returns an error, the
    -- loop keeps polling -- so the wrapper only returns success once the
    -- engine has demonstrably answered a routing call. (#53)
    IF (:P_WAIT_FOR_READY) THEN
        WHILE (NOT :ready AND :elapsed < :P_TIMEOUT_SECONDS) DO
            LET status_ready BOOLEAN := FALSE;
            LET mid_lat FLOAT := NULL;
            LET mid_lon FLOAT := NULL;
            BEGIN
                rs := (EXECUTE IMMEDIATE 'SELECT COALESCE(TRY_PARSE_JSON(OPENROUTESERVICE_APP.CORE.ORS_STATUS('''
                    || :P_REGION || ''')::VARCHAR):service_ready::BOOLEAN, FALSE) AS R');
                LET c CURSOR FOR rs;
                FOR r IN c DO status_ready := COALESCE(r.R, FALSE); END FOR;
            EXCEPTION WHEN OTHER THEN status_ready := FALSE;
            END;

            IF (:status_ready) THEN
                -- Look up bbox centroid for the canary call. If the region is
                -- not in REGION_ORS_MAP yet (race during bootstrap), fall
                -- through and trust ORS_STATUS.
                BEGIN
                    rs := (EXECUTE IMMEDIATE 'SELECT (MIN_LAT + MAX_LAT) / 2 AS MLAT, '
                        || '(MIN_LON + MAX_LON) / 2 AS MLON FROM OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP '
                        || 'WHERE UPPER(REGION) = UPPER(''' || :P_REGION || ''') LIMIT 1');
                    LET cm CURSOR FOR rs;
                    FOR r IN cm DO mid_lat := r.MLAT; mid_lon := r.MLON; END FOR;
                EXCEPTION WHEN OTHER THEN mid_lat := NULL; mid_lon := NULL;
                END;

                IF (:mid_lat IS NULL OR :mid_lon IS NULL) THEN
                    ready := TRUE;
                ELSE
                    BEGIN
                        -- Cheap 500m segment near the centroid; driving-car
                        -- is guaranteed present on every region we provision.
                        rs := (EXECUTE IMMEDIATE 'SELECT COALESCE('
                            || 'TRY_PARSE_JSON(OPENROUTESERVICE_APP.CORE.DIRECTIONS('
                            || '''driving-car'', ' || :mid_lon || ', ' || :mid_lat || ', '
                            || ((:mid_lon)::FLOAT + 0.005) || ', ' || :mid_lat || ', '
                            || '''' || :P_REGION || ''')::VARCHAR):"RESPONSE"::VARCHAR, '''') AS R');
                        LET cd CURSOR FOR rs;
                        LET response_str VARCHAR := '';
                        FOR r IN cd DO response_str := COALESCE(r.R, ''); END FOR;
                        -- If the response embeds an `error` key, the gateway
                        -- propagated an ORS engine error. Treat as not-ready.
                        IF (POSITION('"error"', :response_str) > 0 OR :response_str = '') THEN
                            ready := FALSE;
                        ELSE
                            ready := TRUE;
                        END IF;
                    EXCEPTION WHEN OTHER THEN ready := FALSE;
                    END;
                END IF;
            END IF;

            IF (NOT :ready) THEN
                CALL SYSTEM$WAIT(:poll_secs);
                elapsed := TIMESTAMPDIFF(SECOND, :started_at, SYSDATE());
            END IF;
        END WHILE;
        IF (:ready) THEN
            -- MMAP regions: flag for prewarm instead of warming inline so the
            -- resume returns as soon as the service is ready+canary-ok. The */2 min
            -- RESCUE_PENDING_PROVISIONS reconciler drains NEEDS_PREWARM (readiness-
            -- gated via a passive SHOW SERVICES status check). Best-effort.
            BEGIN
                IF ((SELECT UPPER(COALESCE(GRAPHS_DATA_ACCESS, 'RAM_STORE'))
                       FROM OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP
                      WHERE UPPER(REGION) = UPPER(:P_REGION) LIMIT 1) = 'MMAP') THEN
                    UPDATE OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP
                       SET NEEDS_PREWARM = TRUE, UPDATED_AT = SYSDATE()
                     WHERE UPPER(REGION) = UPPER(:P_REGION);
                END IF;
            EXCEPTION WHEN OTHER THEN NULL;
            END;
            RETURN 'Resumed ORS services for ' || :P_REGION || ' (ready+canary_ok in ' || :elapsed || 's)';
        ELSE
            RETURN 'Resumed ORS services for ' || :P_REGION ||
                   ' but readiness canary did not pass after ' || :elapsed ||
                   's. Re-poll ORS_STATUS(region) - graph may still be loading.';
        END IF;
    END IF;
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
    -- Region's VROOM service shares the same lifecycle as ORS - drop alongside.
    LET vroom_name VARCHAR := 'VROOM_SERVICE_' || UPPER(:P_REGION);
    EXECUTE IMMEDIATE 'DROP SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.' || vroom_name;
    DELETE FROM OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP WHERE REGION = :P_REGION;
    RETURN 'Dropped region ORS for ' || :P_REGION;
END;
$$;

-- =============================================================================
-- Per-region VROOM service (multi-region OPTIMIZATION support)
-- -----------------------------------------------------------------------------
-- Each provisioned region gets its own VROOM service co-located in the region's
-- compute pool, with ORS_HOST baked in to the templated config.yml at startup.
-- This makes OPTIMIZATION region-agnostic: any region with a running ORS can
-- run VRP without the gateway having to fall back to a single shared VROOM.
-- =============================================================================

CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE.BUILD_VROOM_SERVICE_SPEC(P_REGION VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"multi-region"}}'
AS
$$
    '{"spec":{"containers":[{"name":"vroom","image":"/openrouteservice_app/core/image_repository/vroom-docker:v1.0.4","env":{"VROOM_ROUTER":"ors","ORS_HOST":"ors-service-' ||
    LOWER(REPLACE(P_REGION, ' ', '')) ||
    '"},"resources":{"requests":{"cpu":"0.25","memory":"256Mi"},"limits":{"cpu":"1","memory":"1Gi"}}}],"endpoints":[{"name":"vroom","port":3000,"public":false}]}}'
$$;

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.create_region_vroom_service(P_REGION VARCHAR)
RETURNS STRING
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"multi-region"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    svc_name VARCHAR;
    pool_name VARCHAR;
    vroom_spec VARCHAR;
    create_sql VARCHAR;
BEGIN
    svc_name := 'VROOM_SERVICE_' || UPPER(:P_REGION);
    pool_name := 'ORS_POOL_' || UPPER(:P_REGION);
    vroom_spec := OPENROUTESERVICE_APP.CORE.BUILD_VROOM_SERVICE_SPEC(:P_REGION);
    -- VROOM is light (CPU-only) and co-locates safely with ORS in the same pool.
    -- AUTO_SUSPEND_SECS mirrors the region ORS lifecycle so they suspend / resume together.
    create_sql := 'CREATE SERVICE IF NOT EXISTS OPENROUTESERVICE_APP.CORE.' || :svc_name ||
                  ' IN COMPUTE POOL ' || :pool_name ||
                  ' FROM SPECIFICATION ''' || :vroom_spec ||
                  ''' MIN_INSTANCES = 1 MAX_INSTANCES = 1 AUTO_SUSPEND_SECS = 14400' ||
                  ' COMMENT = ''{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"multi-region"}}''';
    EXECUTE IMMEDIATE :create_sql;
    RETURN 'VROOM service ' || :svc_name || ' created in pool ' || :pool_name;
END;
$$;

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.drop_region_vroom(P_REGION VARCHAR)
RETURNS STRING
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"multi-region"}}'
EXECUTE AS OWNER
AS
$$
BEGIN
    LET svc_name VARCHAR := 'VROOM_SERVICE_' || UPPER(:P_REGION);
    EXECUTE IMMEDIATE 'DROP SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.' || svc_name;
    RETURN 'Dropped region VROOM for ' || :P_REGION;
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
            VALUES (:P_REGION, 'soft_suspend_refused', SYSDATE(),
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
        VALUES (:P_REGION, 'soft_suspend_region', SYSDATE(),
                'service+pool suspended (no in-flight job; service_ready=' || :ors_ready ||
                '); resume preserves service object');
    EXCEPTION WHEN OTHER THEN NULL;
    END;
    -- Clear any pending prewarm flag: the service is now suspended, so a stale
    -- TRUE would just be skipped by the reconciler's status gate until the next
    -- resume re-sets it. Keeping the flag truthful avoids an unwanted warm if the
    -- region is later resumed for a reason that doesn't want a prewarm.
    BEGIN
        UPDATE OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP
           SET NEEDS_PREWARM = FALSE, UPDATED_AT = SYSDATE()
         WHERE UPPER(REGION) = UPPER(:P_REGION);
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
        'is_default', COALESCE(IS_DEFAULT, FALSE),
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
--
-- #61 evaluation note (2026-05):
--   The issue proposes a two-pool model (separate build vs. serve pools).
--   This procedure already realizes ~80% of that benefit: after a build
--   completes the pool is re-created at the smaller instance family used
--   for serving, so steady-state compute spend is bounded by the runtime
--   tier, not the build tier. The remaining ~20% gain a two-pool split
--   would add is zero-downtime hand-off (today's DROP+CREATE costs ~30s
--   of service interruption on the smaller new pool).
--
--   Decision: keep the single-pool design unless a customer reports the
--   ~30s downsize window as a problem. The two-pool variant would add
--   one more SPCS object per region and a moving ALTER SERVICE call
--   between pools, doubling the lifecycle code paths to reconcile.
-- =============================================================================
-- Drop the prior 2-arg signature so the new 3-arg form (with two defaulted
-- params) is not flagged as "ambiguous PROCEDURE overloading". Idempotent:
-- no-op on a fresh install where the 2-arg version never existed.
DROP PROCEDURE IF EXISTS OPENROUTESERVICE_APP.CORE.DOWNSIZE_REGION_AFTER_BUILD(VARCHAR, VARCHAR);

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.DOWNSIZE_REGION_AFTER_BUILD(
    P_REGION VARCHAR, P_RUNTIME_SIZE VARCHAR DEFAULT 'M', P_GRAPHS_DATA_ACCESS VARCHAR DEFAULT 'RAM_STORE'
)
RETURNS STRING
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.1","attributes":{"component":"multi-region","action":"cost-guardrail"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    svc_name VARCHAR;
    pool_name VARCHAR;
    runtime_family VARCHAR;
    recreate_msg VARCHAR DEFAULT '';
    graph_file_count INTEGER DEFAULT 0;
    gda VARCHAR DEFAULT 'RAM_STORE';
    pbf_url VARCHAR DEFAULT NULL;
    pbf_file VARCHAR DEFAULT '';
    profiles VARCHAR DEFAULT '';
    compute_size VARCHAR DEFAULT 'S';
    write_msg VARCHAR DEFAULT NULL;
    region_level VARCHAR DEFAULT NULL;
    serving_size VARCHAR DEFAULT NULL;
    warm_msg VARCHAR DEFAULT NULL;
    downsize_ready BOOLEAN DEFAULT FALSE;
    downsize_status VARCHAR DEFAULT 'ok';
    rs RESULTSET;
BEGIN
    svc_name := 'ORS_SERVICE_' || UPPER(:P_REGION);
    pool_name := 'ORS_POOL_' || UPPER(:P_REGION);
    gda := UPPER(COALESCE(:P_GRAPHS_DATA_ACCESS, 'RAM_STORE'));
    IF (:gda NOT IN ('RAM_STORE', 'MMAP')) THEN
        gda := 'RAM_STORE';
    END IF;

    -- Refuse to downsize if no graphs exist (would force a full rebuild on small node).
    -- DIRECTORY() works inside owner-rights procs; LIST/RESULT_SCAN does not
    -- (raises "Unsupported statement type 'LIST_FILES'"), which previously made
    -- this guard always see 0 files and refuse every downsize.
    BEGIN
        EXECUTE IMMEDIATE 'ALTER STAGE OPENROUTESERVICE_APP.CORE.ORS_GRAPHS_SPCS_STAGE REFRESH';
    EXCEPTION WHEN OTHER THEN NULL;
    END;
    BEGIN
        rs := (SELECT COUNT(*) AS C
               FROM DIRECTORY(@OPENROUTESERVICE_APP.CORE.ORS_GRAPHS_SPCS_STAGE)
               WHERE RELATIVE_PATH ILIKE :P_REGION || '/%');
        LET c CURSOR FOR rs;
        FOR r IN c DO graph_file_count := r.C; END FOR;
    EXCEPTION WHEN OTHER THEN graph_file_count := 0;
    END;
    IF (:graph_file_count = 0) THEN
        RETURN 'Refusing to downsize ' || :P_REGION || ': no graph files found on stage. Run REBUILD_REGION_GRAPHS first.';
    END IF;

    -- Resolve the runtime (serving) instance family.
    -- Level-driven serving-tier policy (keyed off REGION_CATALOG.LEVEL):
    --   * city                         -> GEN_X64_G2_4 (3 vCPU / 13 GB), RAM_STORE
    --       Small city graph fits in RAM on a tiny box; MMAP not needed.
    --   * country / sub-region / continent -> CPU_X64_SL (14 vCPU / 58 GB), MMAP
    --       The graph is memory-mapped (off-heap, OS page cache), not loaded into
    --       the JVM heap, so serving RAM is decoupled from graph size. This is the
    --       proven Europe (continent) serving box; country/continent share it.
    -- Serving is intentionally far smaller than the build tier to avoid 24/7 spend
    -- at build-tier rates. If LEVEL is unknown (custom region with no catalog row),
    -- fall back to the legacy P_RUNTIME_SIZE mapping so existing callers are safe.
    BEGIN
        SELECT LEVEL INTO :region_level
        FROM OPENROUTESERVICE_APP.CORE.REGION_CATALOG
        WHERE UPPER(LOOKUP_NAME) = UPPER(:P_REGION)
           OR UPPER(REGION_KEY)  = UPPER(:P_REGION)
        LIMIT 1;
    EXCEPTION WHEN OTHER THEN region_level := NULL;
    END;
    region_level := LOWER(TRIM(COALESCE(:region_level, '')));

    -- serving_size is the COMPUTE_SIZE token recorded for the runtime pool. It
    -- drives WRITE_ORS_CONFIG thread profile; heap is family-driven elsewhere.
    serving_size := COALESCE(:P_RUNTIME_SIZE, 'M');

    IF (:region_level = 'city') THEN
        runtime_family := 'GEN_X64_G2_4';         -- 3 vCPU / 13 GB; small city graph in RAM
        gda := 'RAM_STORE';
        serving_size := 'S';
    ELSEIF (:region_level IN ('country', 'sub-region', 'continent')) THEN
        runtime_family := 'CPU_X64_SL';           -- 14 vCPU / 58 GB; graph mmap'd off-heap
        gda := 'MMAP';
        serving_size := 'M';
    -- ----- Fallback: no LEVEL in catalog. Use legacy P_RUNTIME_SIZE mapping. -----
    ELSEIF (:P_RUNTIME_SIZE = 'XXL') THEN
        runtime_family := 'MEM_X64_G2_64';        -- downsize XXL build -> mid-tier high-mem
    ELSEIF (:P_RUNTIME_SIZE = 'L') THEN
        runtime_family := 'HIGHMEM_X64_M';        -- downsize L build -> smaller high-mem (was unsafe CPU_X64_L)
    ELSEIF (:P_RUNTIME_SIZE = 'S') THEN
        runtime_family := 'GEN_X64_G2_8';
    ELSEIF (:P_RUNTIME_SIZE = 'M' AND :gda = 'MMAP') THEN
        runtime_family := 'CPU_X64_SL';
    ELSE
        runtime_family := 'HIGHMEM_X64_M';        -- default to safe high-mem; never CPU-only for non-city
    END IF;

    -- Record the runtime family BEFORE recreating the service. create_region_ors_service
    -- honors the stored family whenever graphs are present (which they are here),
    -- so it recreates the pool on runtime_family instead of re-resolving the large
    -- build family. This is also what makes the swap actually drop the build-tier
    -- pool: create_region_ors_service drops the co-located VROOM + ORS services
    -- first, which the old in-line DROP COMPUTE POOL could never do (the pool still
    -- owned VROOM, so the drop silently failed and the family never changed).
    UPDATE OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP
    SET INSTANCE_FAMILY = :runtime_family, COMPUTE_SIZE = :serving_size,
        GRAPHS_DATA_ACCESS = :gda, UPDATED_AT = SYSDATE()
    WHERE REGION = :P_REGION;

    -- Regenerate the staged ors-config.yml BEFORE recreating the service so the
    -- container reads the correct graphs_data_access on first start. This is
    -- mandatory for the MMAP+small-family path: CPU_X64_SL has a 24 GB heap, so
    -- a RAM_STORE start would OOM loading the graph -- the MMAP line must already
    -- be in the staged config. WRITE_ORS_CONFIG reads GRAPHS_DATA_ACCESS from
    -- REGION_ORS_MAP (just set above). Derivation mirrors APPLY_ORS_LIMITS.
    BEGIN
        SELECT PBF_URL, COALESCE(COMPUTE_SIZE, :serving_size)
          INTO :pbf_url, :compute_size
          FROM OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP
         WHERE UPPER(REGION) = UPPER(:P_REGION) LIMIT 1;
    EXCEPTION WHEN OTHER THEN pbf_url := NULL; compute_size := :serving_size;
    END;
    pbf_file := SPLIT_PART(COALESCE(:pbf_url, ''), '/', -1);
    IF (pbf_file = '' OR pbf_file IS NULL) THEN
        pbf_file := :P_REGION || '.osm.pbf';
    END IF;
    profiles := (
        SELECT PROFILES FROM OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
         WHERE UPPER(REGION) = UPPER(:P_REGION) AND PROFILES IS NOT NULL
         ORDER BY CASE WHEN COALESCE(STATUS, '') NOT IN ('FAILED', 'ERROR') THEN 0 ELSE 1 END,
                  COALESCE(COMPLETED_AT, STARTED_AT, CREATED_AT) DESC
         LIMIT 1
    );
    IF (profiles IS NULL OR TRIM(profiles) = '') THEN
        BEGIN
            rs := (EXECUTE IMMEDIATE
                'SELECT ARRAY_TO_STRING(OBJECT_KEYS(TRY_PARSE_JSON('
                || 'OPENROUTESERVICE_APP.CORE.ORS_STATUS(''' || :P_REGION || ''')::VARCHAR):profiles), '','') AS P');
            LET c2 CURSOR FOR rs;
            FOR r IN c2 DO profiles := r.P; END FOR;
        EXCEPTION WHEN OTHER THEN profiles := NULL;
        END;
    END IF;
    IF (profiles IS NULL OR TRIM(profiles) = '') THEN
        profiles := 'driving-car';
    END IF;
    BEGIN
        CALL OPENROUTESERVICE_APP.CORE.WRITE_ORS_CONFIG(:P_REGION, :pbf_file, :profiles, :compute_size) INTO :write_msg;
    EXCEPTION WHEN OTHER THEN write_msg := 'config-regen-skipped';
    END;

    -- Recreate pool + ORS service + VROOM on the runtime family. Graphs are loaded
    -- from the persisted stage on the smaller box (REBUILD_GRAPHS=false in the spec).
    CALL OPENROUTESERVICE_APP.CORE.create_region_ors_service(:P_REGION, :serving_size) INTO :recreate_msg;

    -- create_region_ors_service leaves the freshly-created service at
    -- AUTO_SUSPEND_SECS=0 (for in-progress builds); the build is done here, so
    -- restore the steady-state service default.
    BEGIN
        EXECUTE IMMEDIATE 'ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.' || :svc_name || ' SET AUTO_SUSPEND_SECS = 14400';
    EXCEPTION WHEN OTHER THEN NULL;
    END;

    -- Belt-and-suspenders: ensure VROOM exists in the new pool (create_region_ors_service
    -- recreates it only when its family-swap branch fired).
    BEGIN
        CALL OPENROUTESERVICE_APP.CORE.create_region_vroom_service(:P_REGION);
    EXCEPTION WHEN OTHER THEN NULL;
    END;

    UPDATE OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP
    SET COMPUTE_SIZE = :serving_size, INSTANCE_FAMILY = :runtime_family,
        GRAPHS_DATA_ACCESS = :gda, UPDATED_AT = SYSDATE()
    WHERE REGION = :P_REGION;

    -- Assert the recreated service actually comes ready. Every caller wraps this
    -- proc in EXCEPTION ... NULL and the family/map row is written BEFORE the
    -- recreate, so a half-failed recreate would otherwise leave REGION_ORS_MAP on
    -- the new family with a dead service while the build still reports SUCCESS.
    -- This bounded readiness probe (reuses the ORS_STATUS service_ready signal)
    -- makes that degrade observable -- COST_GUARD_LOG row + a 'DEGRADED:' return
    -- prefix -- WITHOUT throwing (the build stays COMPLETE; this stays best-effort).
    LET dn_started TIMESTAMP := SYSDATE();
    WHILE (NOT :downsize_ready AND TIMESTAMPDIFF(SECOND, :dn_started, SYSDATE()) < 120) DO
        BEGIN
            rs := (EXECUTE IMMEDIATE 'SELECT COALESCE(TRY_PARSE_JSON(OPENROUTESERVICE_APP.CORE.ORS_STATUS('''
                || :P_REGION || ''')::VARCHAR):service_ready::BOOLEAN, FALSE) AS R');
            LET cdr CURSOR FOR rs;
            FOR r IN cdr DO downsize_ready := COALESCE(r.R, FALSE); END FOR;
        EXCEPTION WHEN OTHER THEN downsize_ready := FALSE;
        END;
        IF (NOT :downsize_ready) THEN
            CALL SYSTEM$WAIT(10);
        END IF;
    END WHILE;
    IF (NOT :downsize_ready) THEN
        downsize_status := 'degraded';
        BEGIN
            INSERT INTO OPENROUTESERVICE_APP.CORE.COST_GUARD_LOG (REGION, ACTION, REASON)
            VALUES (:P_REGION, 'downsize_not_ready',
                    'service not ready after recreate to ' || :runtime_family
                    || ' (gda=' || :gda || ', size=' || :serving_size || '); ' || :recreate_msg);
        EXCEPTION WHEN OTHER THEN NULL;
        END;
    END IF;

    -- MMAP serving tiers (country/continent -> CPU_X64_SL): warm the page cache
    -- now so the first user query after the build does not pay cold graph-page
    -- faults. PREWARM self-waits for readiness. Best-effort: never fails downsize.
    -- Only when the service came ready (downsize_status='ok'): warming a service
    -- that never came up is pointless and would just burn the readiness wait.
    -- Set NEEDS_PREWARM=TRUE first and clear it only on a successful inline warm,
    -- so a failed inline warm is retried by the */2 min reconciler (self-heal).
    IF (:gda = 'MMAP' AND :downsize_status = 'ok') THEN
        UPDATE OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP
           SET NEEDS_PREWARM = TRUE, UPDATED_AT = SYSDATE()
         WHERE UPPER(REGION) = UPPER(:P_REGION);
        BEGIN
            CALL OPENROUTESERVICE_APP.CORE.PREWARM_REGION_GRAPH(:P_REGION) INTO :warm_msg;
            -- 'anchor_found=true' is PREWARM's reliable "the sweep actually routed"
            -- signal; only then clear the flag. Otherwise leave it for the reconciler.
            IF (:warm_msg LIKE '%anchor_found=true%') THEN
                UPDATE OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP
                   SET NEEDS_PREWARM = FALSE, UPDATED_AT = SYSDATE()
                 WHERE UPPER(REGION) = UPPER(:P_REGION);
            END IF;
        EXCEPTION WHEN OTHER THEN warm_msg := 'prewarm-skipped';
        END;
    END IF;

    RETURN CASE WHEN :downsize_status = 'degraded' THEN 'DEGRADED: ' ELSE '' END ||
           'Region ' || :P_REGION || ' downsized to ' || :serving_size ||
           ' (' || :runtime_family || ', graphs_data_access=' || :gda || '); ' ||
           :graph_file_count || ' graph files reused from stage. ' || :recreate_msg ||
           COALESCE(' prewarm=' || :warm_msg, '');
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
    -- Profile attribution: requested (from job) vs actually building (from logs)
    requested_profiles VARCHAR DEFAULT '';
    building_profiles VARCHAR DEFAULT '';
    eta_profiles VARCHAR DEFAULT '';
    profile_mismatch BOOLEAN DEFAULT FALSE;
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
                   'elapsed_min', DATEDIFF('second', COALESCE(STARTED_AT, CREATED_AT), SYSDATE())/60.0
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
                       SYSDATE()), 0) AS A
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

    -- 4b. Profile attribution from log tags (ground truth) vs the job's
    -- requested profiles. ORS spawns one loader thread "ORS-pl-<profile>" per
    -- ENABLED profile in the running config, so these names reflect what the
    -- engine is ACTUALLY building -- not what the job asked for. A divergence
    -- (e.g. job requested driving-hgv but logs show driving-car) is the
    -- signature of a config hijack and must be surfaced, not masked.
    BEGIN
        rs := (SELECT LISTAGG(DISTINCT prof, ',') WITHIN GROUP (ORDER BY prof) AS BP
               FROM (SELECT LOWER(REPLACE(VALUE::VARCHAR, 'ORS-pl-', '')) AS prof
                     FROM TABLE(FLATTEN(input => REGEXP_SUBSTR_ALL(:service_logs, 'ORS-pl-[A-Za-z-]+'))))
               WHERE prof IS NOT NULL AND prof <> '');
        LET cbp CURSOR FOR rs;
        FOR r IN cbp DO building_profiles := COALESCE(r.BP, ''); END FOR;
    EXCEPTION WHEN OTHER THEN building_profiles := '';
    END;

    BEGIN
        LET jj_str0 VARCHAR := TO_VARCHAR(:job_json);
        rs := (SELECT COALESCE(j:profiles::VARCHAR, '') AS RP FROM (SELECT TRY_PARSE_JSON(:jj_str0) AS j));
        LET crp CURSOR FOR rs;
        FOR r IN crp DO requested_profiles := COALESCE(r.RP, ''); END FOR;
    EXCEPTION WHEN OTHER THEN requested_profiles := '';
    END;

    -- ETA profile basis = what is actually building; fall back to requested
    -- only when the engine has not yet spawned any loader thread.
    eta_profiles := COALESCE(NULLIF(:building_profiles, ''), :requested_profiles);

    -- Mismatch alarm: any profile the engine is actually building that the user
    -- did NOT request. (The reverse -- requested but not yet started -- is
    -- normal early in a sequential build and is NOT flagged.)
    IF (TRIM(:building_profiles) <> '' AND TRIM(:requested_profiles) <> '') THEN
        BEGIN
            rs := (SELECT BOOLOR_AGG(:requested_profiles NOT ILIKE '%' || bp || '%') AS MM
                   FROM (SELECT TRIM(VALUE::VARCHAR) AS bp
                         FROM TABLE(FLATTEN(input => SPLIT(:building_profiles, ','))))
                   WHERE bp <> '');
            LET cmm CURSOR FOR rs;
            FOR r IN cmm DO profile_mismatch := COALESCE(r.MM, FALSE); END FOR;
        EXCEPTION WHEN OTHER THEN profile_mismatch := FALSE;
        END;
    END IF;

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
                   SCHEDULED_TIME_RANGE_START => DATEADD('minute', -30, SYSDATE())
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
        rs := (SELECT
                   :eta_profiles                                                            AS PRF,
                   CASE
                       WHEN :eta_profiles ILIKE '%driving-hgv%' THEN 2.0
                       WHEN :eta_profiles ILIKE '%cycling%'     THEN 0.5
                       WHEN :eta_profiles ILIKE '%foot%'        THEN 0.5
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
               FROM (SELECT :pbf_gib_resolved AS p, :current_phase AS ph));
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
        'generated_at', SYSDATE(),
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
        'requested_profiles', :requested_profiles,
        'building_profiles', :building_profiles,
        'profile_mismatch', :profile_mismatch,
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
        '| requested_profiles | `' || COALESCE(NULLIF(:requested_profiles, ''), 'unknown') || '` |' || CHR(10) ||
        '| building_profiles | `' || COALESCE(NULLIF(:building_profiles, ''), 'unknown') || '` |' || CHR(10) ||
        '| profile_mismatch | ' || IFF(:profile_mismatch, '**YES - engine building a profile that was not requested**', 'no') || ' |' || CHR(10) ||
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
       'If eta_remaining_minutes is null OR pbf_size_gib_resolved is null, say ' ||
       '"ETA unavailable (size/profile unknown)" - do NOT estimate or guess a range.' || CHR(10) ||
'  R3. NEVER substitute or guess container names. The container is "ors".' || CHR(10) ||
'  R4. ALWAYS quote pbf_size_gib_resolved and profile_factor in the ETA line.' || CHR(10) ||
'  R5. The profile being built is building_profiles (parsed from the live logs), ' ||
       'NOT requested_profiles (job intent). Report building_profiles as the profile(s) ' ||
       'in progress. NEVER name a profile that is absent from building_profiles.' || CHR(10) ||
'  R6. If profile_mismatch = true, OPEN with a prominent warning: the build is producing ' ||
       'profile(s) the user did NOT request (requested_profiles vs building_profiles). ' ||
       'Recommend cancelling and relaunching with the intended profiles; do NOT reassure.' || CHR(10) ||
'Decision tree:' || CHR(10) ||
'1. service_status.restartCount > 0 -> container has crashed (likely OOM if exitCode 137). ' ||
'   Recommend: dismiss the job and retry on a smaller compute size, or split profiles.' || CHR(10) ||
'2. ors_status.service_ready = true -> graph is loaded. If provision_job.status is still ' ||
'   ERROR with error_msg=graph_load_timeout, the rescue task will finalize within 2 min. ' ||
'   Recommend: wait briefly; UI will flip green automatically.' || CHR(10) ||
'3. ors_status.service_ready = false AND service_status.status = READY -> container alive, ' ||
'   building the graph. Sub-cases by log_chars + service_age_seconds:' || CHR(10) ||
'   3a. log_chars > 0 AND logs contain "Index N out of bounds for length 0" -> ORS #2180 ' ||
'       init_threads race (parallel PBF parse). Recommend: rewrite ors-config with init_threads=1 ' ||
'       and CALL REBUILD_REGION_GRAPHS(region); REPAIR_STUCK_REGION_BUILDS may auto-trigger only after tier-scaled age + flat-byte stall checks.' || CHR(10) ||
'   3b. log_chars > 0 -> NEVER say "logs are empty". Quote latest log line; report current_phase.' || CHR(10) ||
'   3c. log_chars = 0 AND service_age_seconds < 60   -> "container booting; logs flushing in <1 min".' || CHR(10) ||
'   3d. log_chars = 0 AND service_age_seconds < 600  -> "Spring Boot still initialising; check again in 1-2 min".' || CHR(10) ||
'   3e. log_chars = 0 AND service_age_seconds >= 600 -> escalate as a logging issue.' || CHR(10) ||
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
        'generated_at', SYSDATE(),
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
    svc_ready BOOLEAN DEFAULT FALSE;
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
                 AND TIMESTAMPDIFF(MINUTE, STARTED_AT, SYSDATE()) > 30)
              )
          AND (COMPLETED_AT IS NULL OR COMPLETED_AT > DATEADD(HOUR, -24, SYSDATE()))
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
            svc_ready := TRUE;
            profile_count := ARRAY_SIZE(OBJECT_KEYS(status_json:profiles));
            IF (:profile_count > 0) THEN
                -- Persistence gate: only finalize when every REQUESTED profile is
                -- artifact-complete on the stage (not just what ORS loaded).
                -- service_ready=true alone does not prove the graph synced to the
                -- object store.
                LET loaded_profiles VARCHAR := ARRAY_TO_STRING(OBJECT_KEYS(status_json:profiles), ',');
                LET requested_profiles VARCHAR := '';
                SELECT COALESCE(PROFILES, '') INTO :requested_profiles
                FROM OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS WHERE JOB_ID = :job_id;
                IF (TRIM(:requested_profiles) = '') THEN requested_profiles := :loaded_profiles; END IF;
                LET graphs_ok BOOLEAN := FALSE;
                BEGIN
                    CALL OPENROUTESERVICE_APP.CORE.GRAPHS_ARTIFACT_COMPLETE(:P_REGION, :requested_profiles) INTO :graphs_ok;
                EXCEPTION WHEN OTHER THEN graphs_ok := FALSE;
                END;
                IF (:graphs_ok) THEN is_ready := TRUE; END IF;
            END IF;
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
                -- Also reset the matching build_history row. The Region Builder
                -- "Recent builds" card reads ORS_BUILD_HISTORY directly; without
                -- this reset the false TIMEOUT badge stays red even after the
                -- provision_jobs row has been downgraded. Idempotent: only fires
                -- on rows that the wrapper falsely marked TIMEOUT.
                UPDATE OPENROUTESERVICE_APP.CORE.ORS_BUILD_HISTORY
                SET EXIT_STATUS='IN_PROGRESS',
                    FINISHED_AT=NULL,
                    ELAPSED_MINUTES=NULL,
                    LOG_URI=NULL
                WHERE JOB_ID = :job_id AND EXIT_STATUS='TIMEOUT';
                -- Restore the AGENTS.md "no auto-suspend during provisioning"
                -- invariant. The wrapper sets AUTO_SUSPEND_SECS=14400 on its
                -- way out of the wait loop (line ~464); without this restore
                -- the JVM idle-suspends mid-build (no HTTP requests during
                -- silent CH/LM phases) and the compute pool follows 1h later,
                -- which kills the container and forces a full rebuild on resume.
                BEGIN
                    EXECUTE IMMEDIATE 'ALTER SERVICE IF EXISTS ' || :svc_full_alive || ' SET AUTO_SUSPEND_SECS = 0';
                EXCEPTION WHEN OTHER THEN NULL;
                END;
                BEGIN
                    EXECUTE IMMEDIATE 'ALTER COMPUTE POOL IF EXISTS ORS_POOL_' || UPPER(:P_REGION) || ' SET AUTO_SUSPEND_SECS = 0';
                EXCEPTION WHEN OTHER THEN NULL;
                END;
            END IF;
        EXCEPTION WHEN OTHER THEN NULL;
        END;
        -- Terminal guard: if the container reports service_ready (graph loaded in
        -- the container) but the artifacts still have NOT persisted to the stage
        -- after a generous cap, stop monitoring forever and mark the job ERROR so
        -- it surfaces in the UI failed panel instead of hanging RUNNING. Only
        -- fires when svc_ready=TRUE (build finished) but persistence is stuck --
        -- never kills a still-in-progress build (svc_ready=FALSE then). The cap is
        -- intentionally generous (continental build + multi-GB stage sync) and is
        -- a tunable constant.
        IF (:svc_ready) THEN
            LET persist_elapsed_min INTEGER DEFAULT 0;
            BEGIN
                SELECT TIMESTAMPDIFF(MINUTE, STARTED_AT, SYSDATE()) INTO :persist_elapsed_min
                FROM OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS WHERE JOB_ID = :job_id;
            EXCEPTION WHEN OTHER THEN persist_elapsed_min := 0;
            END;
            IF (:persist_elapsed_min > 720) THEN
                UPDATE OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
                SET STATUS='ERROR',
                    ERROR_MSG='graph_persist_timeout',
                    MESSAGE='Service reported ready but graph artifacts never persisted to stage within the cap (720 min); marking ERROR instead of hanging RUNNING.',
                    COMPLETED_AT=SYSDATE()
                WHERE JOB_ID = :job_id;
                RETURN 'persist_timeout:' || :P_REGION;
            END IF;
        END IF;
        RETURN 'not_ready:' || :P_REGION;
    END IF;

    -- Container is ready - finalize the job exactly like the wrapper would.
    MERGE INTO OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP t
    USING (SELECT :P_REGION AS REGION) s ON t.REGION = s.REGION
    WHEN MATCHED THEN UPDATE SET STATUS = 'DEPLOYED'
    WHEN NOT MATCHED THEN INSERT (REGION, DISPLAY_NAME, STATUS, COMPUTE_SIZE, UPDATED_AT)
        VALUES (:P_REGION, :P_REGION, 'DEPLOYED', NULLIF(:compute_size, ''), SYSDATE());
    BEGIN
        EXECUTE IMMEDIATE 'ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ORS_SERVICE_' || UPPER(:P_REGION) || ' SET AUTO_SUSPEND_SECS = 14400';
    EXCEPTION WHEN OTHER THEN NULL;
    END;
    -- Restore pool auto-suspend on success path (Fix 5b). Was set to 0
    -- during provisioning to keep the build container alive across silent
    -- CH/LM phases; restore to default cost-guard interval now that build
    -- is done.
    BEGIN
        EXECUTE IMMEDIATE 'ALTER COMPUTE POOL IF EXISTS ORS_POOL_' || UPPER(:P_REGION) || ' SET AUTO_SUSPEND_SECS = 3600';
    EXCEPTION WHEN OTHER THEN NULL;
    END;
    -- REBUILD_GRAPHS is always false in the service spec now; no flag flip is
    -- needed (the next resume reuses persisted graphs automatically).
    -- Ensure region VROOM exists (rescue path: ORS came up via async job).
    BEGIN
        CALL OPENROUTESERVICE_APP.CORE.create_region_vroom_service(:P_REGION);
    EXCEPTION WHEN OTHER THEN NULL;
    END;
    -- Write the success marker, retried (not silently swallowed). With
    -- artifact-based reuse a lost marker no longer arms a destructive wipe, but
    -- we still retry and surface a persistent failure in MESSAGE.
    BEGIN
        LET mk_ok BOOLEAN := FALSE;
        FOR mk_try IN 1 TO 3 DO
            BEGIN
                EXECUTE IMMEDIATE 'COPY INTO @OPENROUTESERVICE_APP.CORE.ORS_GRAPHS_SPCS_STAGE/' || :P_REGION ||
                    '/_BUILD_OK FROM (SELECT ''ok'') FILE_FORMAT = (TYPE = CSV) SINGLE = TRUE OVERWRITE = TRUE';
                mk_ok := TRUE;
            EXCEPTION WHEN OTHER THEN mk_ok := FALSE;
            END;
            IF (:mk_ok) THEN BREAK; END IF;
            EXECUTE IMMEDIATE 'SELECT SYSTEM$WAIT(2)';
        END FOR;
        IF (NOT :mk_ok) THEN
            UPDATE OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
            SET MESSAGE = COALESCE(MESSAGE, '') || ' [build_ok_marker_write_failed]'
            WHERE JOB_ID = :job_id;
        END IF;
    EXCEPTION WHEN OTHER THEN NULL;
    END;

    UPDATE OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
    SET STATUS='COMPLETE', STAGE='READY',
        MESSAGE='Region provisioned via rescue task — ' || :profile_count || ' profile(s) ready',
        ERROR_MSG=NULL,
        COMPLETED_AT=SYSDATE()
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
        SET FINISHED_AT = SYSDATE(),
            ELAPSED_MINUTES = TIMESTAMPDIFF(SECOND, STARTED_AT, SYSDATE()) / 60.0,
            EXIT_STATUS = 'SUCCESS',
            PEAK_RSS_GIB = :peak_rss
        WHERE BUILD_ID = :build_id;
    END IF;

    -- Best-effort runtime downsize (same as wrapper success path). Fires for every
    -- level (city -> GEN_X64_G2_4/RAM_STORE; larger -> CPU_X64_SL/MMAP). A
    -- DEGRADED/Refusing result is recorded on the job row so the failure is visible.
    BEGIN
        LET dz_msg VARCHAR := '';
        CALL OPENROUTESERVICE_APP.CORE.DOWNSIZE_REGION_AFTER_BUILD(:P_REGION, :compute_size) INTO :dz_msg;
        IF (:dz_msg LIKE 'DEGRADED:%' OR :dz_msg LIKE 'Refusing%') THEN
            UPDATE OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
               SET ERROR_MSG = LEFT(COALESCE(ERROR_MSG || ' | ', '') || 'downsize: ' || :dz_msg, 4000)
             WHERE JOB_ID = :job_id;
        END IF;
    EXCEPTION WHEN OTHER THEN NULL;
    END;

    RETURN 'rescued:' || :P_REGION || ' (job=' || :job_id || ', profiles=' || :profile_count || ')';
END;
$$;

-- Idempotent finalizer for bootstrapped default regions (e.g. SanFrancisco) that
-- never run through PROVISION_REGION_WRAPPER and therefore never get
-- REBUILD_GRAPHS=false or _BUILD_OK from the wrapper/rescue job paths.
-- Wired into RESCUE_PENDING_PROVISIONS_TASK (*/2 min). Safe to call every cycle.
CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.FINALIZE_DEFAULT_REGION_IF_READY()
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"bootstrap","action":"finalize-default"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    rs RESULTSET;
    region VARCHAR DEFAULT '';
    svc_name VARCHAR DEFAULT '';
    status_raw VARCHAR DEFAULT '';
    status_json VARIANT;
    profile_count INTEGER DEFAULT 0;
    expected_count INTEGER DEFAULT 0;
    profiles_csv VARCHAR DEFAULT '';
    is_ready BOOLEAN DEFAULT FALSE;
    has_build_ok BOOLEAN DEFAULT FALSE;
    finalized INTEGER DEFAULT 0;
    skipped INTEGER DEFAULT 0;
BEGIN
    rs := (
        SELECT REGION
        FROM OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP
        WHERE COALESCE(IS_DEFAULT, FALSE) = TRUE
    );
    LET c_def CURSOR FOR rs;
    FOR r IN c_def DO
        region := r.REGION;
        has_build_ok := FALSE;
        is_ready := FALSE;
        profile_count := 0;

        BEGIN
            EXECUTE IMMEDIATE 'LIST @OPENROUTESERVICE_APP.CORE.ORS_GRAPHS_SPCS_STAGE/' || :region || '/';
            LET rs_ok RESULTSET := (SELECT BOOLOR_AGG("name" ILIKE '%/_BUILD_OK%') AS HAS_OK
                                    FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())));
            LET c_ok CURSOR FOR rs_ok;
            FOR ro IN c_ok DO has_build_ok := COALESCE(ro.HAS_OK, FALSE); END FOR;
        EXCEPTION WHEN OTHER THEN has_build_ok := FALSE;
        END;

        IF (:has_build_ok) THEN
            skipped := :skipped + 1;
            CONTINUE;
        END IF;

        profiles_csv := NULL;
        expected_count := 0;
        BEGIN
            rs := (
                SELECT PROFILES
                FROM OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
                WHERE REGION = :region AND PROFILES IS NOT NULL
                ORDER BY CASE WHEN COALESCE(STATUS,'') NOT IN ('FAILED','ERROR') THEN 0 ELSE 1 END,
                         COALESCE(COMPLETED_AT, STARTED_AT, CREATED_AT) DESC
                LIMIT 1
            );
            LET c_prof CURSOR FOR rs;
            FOR rp IN c_prof DO profiles_csv := rp.PROFILES; END FOR;
        EXCEPTION WHEN OTHER THEN profiles_csv := NULL;
        END;
        IF (profiles_csv IS NULL OR TRIM(profiles_csv) = '') THEN
            IF (UPPER(:region) = 'SANFRANCISCO') THEN
                profiles_csv := 'driving-car,driving-hgv,cycling-electric';
            ELSE
                profiles_csv := 'driving-car,cycling-electric';
            END IF;
        END IF;
        expected_count := ARRAY_SIZE(SPLIT(TRIM(:profiles_csv), ','));

        BEGIN
            rs := (EXECUTE IMMEDIATE 'SELECT OPENROUTESERVICE_APP.CORE.ORS_STATUS(''' || :region || ''')::VARCHAR AS S');
            LET c2 CURSOR FOR rs;
            FOR rs_row IN c2 DO status_raw := rs_row.S; END FOR;
            status_json := TRY_PARSE_JSON(:status_raw);
            IF (status_json:service_ready::BOOLEAN = TRUE AND status_json:profiles IS NOT NULL) THEN
                profile_count := ARRAY_SIZE(OBJECT_KEYS(status_json:profiles));
                IF (:profile_count >= :expected_count AND :expected_count > 0) THEN is_ready := TRUE; END IF;
            END IF;
        EXCEPTION WHEN OTHER THEN is_ready := FALSE;
        END;

        IF (NOT :is_ready) THEN
            CONTINUE;
        END IF;

        svc_name := 'ORS_SERVICE_' || UPPER(:region);

        BEGIN
            CALL OPENROUTESERVICE_APP.CORE.SET_REBUILD_GRAPHS_FLAG(:region, 'false');
        EXCEPTION WHEN OTHER THEN NULL;
        END;
        BEGIN
            EXECUTE IMMEDIATE 'COPY INTO @OPENROUTESERVICE_APP.CORE.ORS_GRAPHS_SPCS_STAGE/' || :region ||
                '/_BUILD_OK FROM (SELECT ''ok'') FILE_FORMAT = (TYPE = CSV) SINGLE = TRUE OVERWRITE = TRUE';
        EXCEPTION WHEN OTHER THEN NULL;
        END;
        BEGIN
            EXECUTE IMMEDIATE 'ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.' || :svc_name || ' SET AUTO_SUSPEND_SECS = 14400';
        EXCEPTION WHEN OTHER THEN NULL;
        END;
        BEGIN
            EXECUTE IMMEDIATE 'ALTER COMPUTE POOL IF EXISTS ORS_POOL_' || UPPER(:region) || ' SET AUTO_SUSPEND_SECS = 3600';
        EXCEPTION WHEN OTHER THEN NULL;
        END;
        BEGIN
            CALL OPENROUTESERVICE_APP.CORE.create_region_vroom_service(:region);
        EXCEPTION WHEN OTHER THEN NULL;
        END;

        -- Apply the level-driven serving tier exactly once (the _BUILD_OK marker
        -- written just above gates this loop, so the next cycle skips this region).
        -- For the default city region (SanFrancisco) this shrinks the runtime pool
        -- from the GEN_X64_G2_8 build box down to GEN_X64_G2_4. Graphs are present
        -- and persisted, so DOWNSIZE reuses them (no rebuild). Best-effort. A
        -- DEGRADED/Refusing result is annotated on the region's latest job row
        -- (DOWNSIZE also writes a COST_GUARD_LOG row on degrade as a backstop).
        BEGIN
            LET dz_msg VARCHAR := '';
            CALL OPENROUTESERVICE_APP.CORE.DOWNSIZE_REGION_AFTER_BUILD(:region, 'S') INTO :dz_msg;
            IF (:dz_msg LIKE 'DEGRADED:%' OR :dz_msg LIKE 'Refusing%') THEN
                UPDATE OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
                   SET ERROR_MSG = LEFT(COALESCE(ERROR_MSG || ' | ', '') || 'downsize: ' || :dz_msg, 4000)
                 WHERE JOB_ID = (
                       SELECT JOB_ID FROM OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
                        WHERE UPPER(REGION) = UPPER(:region)
                        ORDER BY COALESCE(COMPLETED_AT, STARTED_AT, CREATED_AT) DESC LIMIT 1);
            END IF;
        EXCEPTION WHEN OTHER THEN NULL;
        END;

        finalized := :finalized + 1;
    END FOR;

    RETURN 'finalized=' || :finalized || ' skipped=' || :skipped;
END;
$$;

-- Auto-repair DEPLOYED regions stuck with container READY but service_ready=false
-- and no _BUILD_OK (typical when init_threads>1 triggers ORS #2180 PBF-parse race).
-- Guarded by REGION_REPAIR_LOG (durable; survives REBUILD stage purge): tier-scaled
-- minimum service age, time-based in-flight window, byte-growth stall detection, and
-- per-region repair rate-limit so a false-positive cannot loop forever.
CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.REPAIR_STUCK_REGION_BUILDS()
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.1","attributes":{"component":"rescue","action":"repair-stuck-build"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    rs RESULTSET;
    region VARCHAR DEFAULT '';
    svc_name VARCHAR DEFAULT '';
    svc_full VARCHAR DEFAULT '';
    compute_size VARCHAR DEFAULT 'S';
    pbf_file VARCHAR DEFAULT '';
    profiles VARCHAR DEFAULT '';
    status_raw VARCHAR DEFAULT '';
    status_json VARIANT;
    service_status VARIANT;
    service_age_seconds INTEGER DEFAULT 0;
    min_service_age_secs INTEGER DEFAULT 1200;
    inflight_window_secs INTEGER DEFAULT 4800;
    repair_rate_limit_secs INTEGER DEFAULT 28800;
    container_ready BOOLEAN DEFAULT FALSE;
    service_ready BOOLEAN DEFAULT FALSE;
    has_build_ok BOOLEAN DEFAULT FALSE;
    repaired INTEGER DEFAULT 0;
    scanned INTEGER DEFAULT 0;
    repair_msg VARCHAR DEFAULT '';
    active_job_cnt INTEGER DEFAULT 0;
    last_job_started TIMESTAMP_NTZ DEFAULT NULL;
    last_repair_at TIMESTAMP_NTZ DEFAULT NULL;
    last_graph_bytes NUMBER DEFAULT 0;
    last_probed_at TIMESTAMP_NTZ DEFAULT NULL;
    graph_bytes NUMBER DEFAULT 0;
    log_row_exists BOOLEAN DEFAULT FALSE;
BEGIN
    rs := (
        SELECT REGION, COALESCE(COMPUTE_SIZE, 'S') AS COMPUTE_SIZE, PBF_URL
        FROM OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP
        WHERE STATUS = 'DEPLOYED'
    );
    LET c_reg CURSOR FOR rs;
    FOR r IN c_reg DO
        scanned := :scanned + 1;
        region := r.REGION;
        compute_size := r.COMPUTE_SIZE;
        has_build_ok := FALSE;
        container_ready := FALSE;
        service_ready := FALSE;
        service_age_seconds := 0;
        profiles := NULL;
        pbf_file := SPLIT_PART(COALESCE(r.PBF_URL, ''), '/', -1);
        IF (pbf_file = '' OR pbf_file IS NULL) THEN
            pbf_file := :region || '.osm.pbf';
        END IF;

        -- Tier-scaled thresholds mirror PROVISION_REGION_WRAPPER wait caps.
        min_service_age_secs := CASE UPPER(:compute_size)
            WHEN 'S' THEN 1200 WHEN 'L' THEN 10800 WHEN 'XXL' THEN 21600 ELSE 1200 END;
        inflight_window_secs := CASE UPPER(:compute_size)
            WHEN 'S' THEN 1200 + 3600 WHEN 'L' THEN 10800 + 3600 WHEN 'XXL' THEN 21600 + 3600 ELSE 1200 + 3600 END;
        repair_rate_limit_secs := 28800;  -- 8h minimum between repairs (>= any tier build cap)

        -- Never touch a region that still has an in-flight provision job. A
        -- legitimately slow build (e.g. a continental XXL extract) is NOT
        -- "stuck"; repair is only for genuinely crashed/abandoned containers.
        active_job_cnt := 0;
        BEGIN
            SELECT COUNT(*) INTO :active_job_cnt
            FROM OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
            WHERE REGION = :region AND STATUS IN ('RUNNING','PENDING');
        EXCEPTION WHEN OTHER THEN active_job_cnt := 0;
        END;
        IF (:active_job_cnt > 0) THEN
            CONTINUE;
        END IF;

        -- Time-based in-flight guard: skip if the most recent job for this region
        -- started within the tier build+load window, regardless of STATUS. Closes
        -- the COMPLETE/ERROR race where FINALIZE has not yet downgraded the row.
        last_job_started := NULL;
        BEGIN
            SELECT MAX(STARTED_AT) INTO :last_job_started
            FROM OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
            WHERE REGION = :region;
        EXCEPTION WHEN OTHER THEN last_job_started := NULL;
        END;
        IF (:last_job_started IS NOT NULL
            AND DATEDIFF('second', :last_job_started, SYSDATE()) < :inflight_window_secs) THEN
            CONTINUE;
        END IF;

        BEGIN
            EXECUTE IMMEDIATE 'LIST @OPENROUTESERVICE_APP.CORE.ORS_GRAPHS_SPCS_STAGE/' || :region || '/';
            LET rs_mark RESULTSET := (
                SELECT BOOLOR_AGG("name" ILIKE '%/_BUILD_OK%') AS HAS_OK
                FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
            );
            LET c_mark CURSOR FOR rs_mark;
            FOR rm IN c_mark DO has_build_ok := COALESCE(rm.HAS_OK, FALSE); END FOR;
        EXCEPTION WHEN OTHER THEN has_build_ok := FALSE;
        END;

        IF (:has_build_ok) THEN
            CONTINUE;
        END IF;

        svc_name := 'ORS_SERVICE_' || UPPER(:region);
        svc_full := 'OPENROUTESERVICE_APP.CORE.' || :svc_name;

        BEGIN
            rs := (EXECUTE IMMEDIATE 'SELECT TRY_PARSE_JSON(SYSTEM$GET_SERVICE_STATUS(''' || :svc_full || '''))[0] AS S');
            LET cs CURSOR FOR rs;
            FOR rs_row IN cs DO service_status := rs_row.S; END FOR;
            IF (service_status:status::VARCHAR = 'READY') THEN container_ready := TRUE; END IF;
            service_age_seconds := COALESCE(DATEDIFF('second',
                TO_TIMESTAMP_TZ(service_status:startTime::VARCHAR), SYSDATE()), 0);
        EXCEPTION WHEN OTHER THEN
            container_ready := FALSE;
            service_age_seconds := 0;
        END;

        IF (NOT :container_ready OR :service_age_seconds < :min_service_age_secs) THEN
            CONTINUE;
        END IF;

        BEGIN
            rs := (EXECUTE IMMEDIATE 'SELECT OPENROUTESERVICE_APP.CORE.ORS_STATUS(''' || :region || ''')::VARCHAR AS S');
            LET c2 CURSOR FOR rs;
            FOR rs_row IN c2 DO status_raw := rs_row.S; END FOR;
            status_json := TRY_PARSE_JSON(:status_raw);
            service_ready := COALESCE(status_json:service_ready::BOOLEAN, FALSE);
        EXCEPTION WHEN OTHER THEN service_ready := FALSE;
        END;

        IF (:service_ready) THEN
            CONTINUE;
        END IF;

        -- Progress-aware stall check: only repair when on-stage graph bytes are
        -- flat across probe cycles (mirrors wrapper stall detector). Growing bytes
        -- mean a build is still progressing even if service_ready=false.
        graph_bytes := 0;
        BEGIN
            EXECUTE IMMEDIATE 'ALTER STAGE OPENROUTESERVICE_APP.CORE.ORS_GRAPHS_SPCS_STAGE REFRESH';
        EXCEPTION WHEN OTHER THEN NULL;
        END;
        BEGIN
            rs := (
                SELECT COALESCE(SUM(SIZE), 0) AS B
                FROM DIRECTORY(@OPENROUTESERVICE_APP.CORE.ORS_GRAPHS_SPCS_STAGE)
                WHERE RELATIVE_PATH ILIKE :region || '/%'
            );
            LET cg CURSOR FOR rs;
            FOR rb IN cg DO graph_bytes := rb.B; END FOR;
        EXCEPTION WHEN OTHER THEN graph_bytes := 0;
        END;

        last_graph_bytes := 0;
        last_probed_at := NULL;
        last_repair_at := NULL;
        log_row_exists := FALSE;
        BEGIN
            rs := (
                SELECT LAST_GRAPH_BYTES, LAST_PROBED_AT, LAST_REPAIR_AT
                FROM OPENROUTESERVICE_APP.CORE.REGION_REPAIR_LOG
                WHERE REGION = :region
            );
            LET cl CURSOR FOR rs;
            FOR rl IN cl DO
                log_row_exists := TRUE;
                last_graph_bytes := COALESCE(rl.LAST_GRAPH_BYTES, 0);
                last_probed_at := rl.LAST_PROBED_AT;
                last_repair_at := rl.LAST_REPAIR_AT;
            END FOR;
        EXCEPTION WHEN OTHER THEN
            log_row_exists := FALSE;
            last_graph_bytes := 0;
            last_probed_at := NULL;
            last_repair_at := NULL;
        END;

        IF (NOT :log_row_exists) THEN
            BEGIN
                INSERT INTO OPENROUTESERVICE_APP.CORE.REGION_REPAIR_LOG
                    (REGION, LAST_GRAPH_BYTES, LAST_PROBED_AT, REPAIR_COUNT)
                VALUES (:region, :graph_bytes, SYSDATE(), 0);
            EXCEPTION WHEN OTHER THEN NULL;
            END;
            CONTINUE;
        END IF;

        IF (:graph_bytes > :last_graph_bytes) THEN
            BEGIN
                UPDATE OPENROUTESERVICE_APP.CORE.REGION_REPAIR_LOG
                SET LAST_GRAPH_BYTES = :graph_bytes, LAST_PROBED_AT = SYSDATE()
                WHERE REGION = :region;
            EXCEPTION WHEN OTHER THEN NULL;
            END;
            CONTINUE;
        END IF;

        -- Bytes flat (or shrank): require at least 10 min since the last probe
        -- before treating as stalled (mirrors wrapper stall_threshold * 30s).
        IF (:last_probed_at IS NULL
            OR DATEDIFF('minute', :last_probed_at, SYSDATE()) < 10) THEN
            CONTINUE;
        END IF;

        -- Per-region repair rate-limit (durable; survives stage purge).
        IF (:last_repair_at IS NOT NULL
            AND DATEDIFF('second', :last_repair_at, SYSDATE()) < :repair_rate_limit_secs) THEN
            CONTINUE;
        END IF;

        -- Honor the profiles the user actually requested. Prefer the most
        -- recent non-failed job (the pattern FINALIZE_PROVISION_ITER uses);
        -- only COMPLETE-job lookups would miss an in-progress build and force
        -- the hardcoded fallback below, silently changing the built profiles.
        profiles := (
            SELECT PROFILES
            FROM OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
            WHERE REGION = :region AND PROFILES IS NOT NULL
            ORDER BY CASE WHEN COALESCE(STATUS,'') NOT IN ('FAILED','ERROR') THEN 0 ELSE 1 END,
                     COALESCE(COMPLETED_AT, STARTED_AT, CREATED_AT) DESC
            LIMIT 1
        );
        IF (profiles IS NULL OR TRIM(profiles) = '') THEN
            IF (UPPER(:region) = 'SANFRANCISCO') THEN
                profiles := 'driving-car,driving-hgv,cycling-electric';
            ELSE
                profiles := 'driving-car,cycling-electric';
            END IF;
            BEGIN
                EXECUTE IMMEDIATE 'COPY INTO @OPENROUTESERVICE_APP.CORE.ORS_GRAPHS_SPCS_STAGE/' || :region ||
                    '/_REPAIR_PROFILE_FALLBACK FROM (SELECT ''' || :profiles ||
                    ''') FILE_FORMAT = (TYPE = CSV) SINGLE = TRUE OVERWRITE = TRUE';
            EXCEPTION WHEN OTHER THEN NULL;
            END;
        END IF;

        BEGIN
            UPDATE OPENROUTESERVICE_APP.CORE.REGION_REPAIR_LOG
            SET LAST_REPAIR_AT = SYSDATE(), REPAIR_COUNT = COALESCE(REPAIR_COUNT, 0) + 1
            WHERE REGION = :region;
        EXCEPTION WHEN OTHER THEN NULL;
        END;

        BEGIN
            CALL OPENROUTESERVICE_APP.CORE.WRITE_ORS_CONFIG(:region, :pbf_file, :profiles, :compute_size) INTO :repair_msg;
        EXCEPTION WHEN OTHER THEN NULL;
        END;

        BEGIN
            CALL OPENROUTESERVICE_APP.CORE.REBUILD_REGION_GRAPHS(:region) INTO :repair_msg;
            repaired := :repaired + 1;
        EXCEPTION WHEN OTHER THEN NULL;
        END;
    END FOR;

    RETURN 'scanned=' || :scanned || ' repaired=' || :repaired;
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
    BEGIN
        CALL OPENROUTESERVICE_APP.CORE.FINALIZE_DEFAULT_REGION_IF_READY();
    EXCEPTION WHEN OTHER THEN NULL;
    END;

    rs := (
        SELECT DISTINCT REGION
        FROM OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
        WHERE (
                (STATUS = 'ERROR' AND ERROR_MSG IN ('graph_load_timeout','ors_status_unreachable'))
             OR (STATUS = 'RUNNING' AND STAGE = 'BUILDING_GRAPH'
                 AND TIMESTAMPDIFF(MINUTE, STARTED_AT, SYSDATE()) > 30)
              )
          AND (COMPLETED_AT IS NULL OR COMPLETED_AT > DATEADD(HOUR, -24, SYSDATE()))
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

    -- Run REPAIR after FINALIZE so recoverable ERROR jobs are downgraded to
    -- RUNNING before REPAIR evaluates its in-flight guards.
    BEGIN
        CALL OPENROUTESERVICE_APP.CORE.REPAIR_STUCK_REGION_BUILDS();
    EXCEPTION WHEN OTHER THEN NULL;
    END;

    -- MMAP prewarm drain. Setters (resume_region_ors, APPLY_ORS_LIMITS,
    -- RESUME_ALL_SERVICES, DOWNSIZE) only flip NEEDS_PREWARM=TRUE and return
    -- promptly; the actual page-cache warm happens here, off the interactive
    -- path. Placed after REPAIR and before RETURN so it runs EVERY cycle even
    -- when the provision-job cursor above is empty (steady state).
    --
    -- Wake-safe by construction: for each flagged MMAP region we first read the
    -- service "status" via a passive SHOW SERVICES (metadata only -- it never
    -- resumes a service or pool). Only when status='RUNNING' do we call PREWARM.
    -- A flagged-but-suspended region is skipped (no probe, no wake) and warms
    -- naturally the next cycle after it is running -- so a stuck flag cannot
    -- create a 2-min wake-loop / cost regression.
    BEGIN
        LET pw_rs RESULTSET := (
            SELECT REGION FROM OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP
             WHERE NEEDS_PREWARM = TRUE
               AND UPPER(COALESCE(GRAPHS_DATA_ACCESS, 'RAM_STORE')) = 'MMAP'
        );
        LET pw_cur CURSOR FOR pw_rs;
        FOR pw IN pw_cur DO
            BEGIN
                LET pw_region VARCHAR := pw.REGION;
                LET pw_status VARCHAR := '';
                EXECUTE IMMEDIATE 'SHOW SERVICES LIKE ''ORS_SERVICE_' || UPPER(:pw_region)
                    || ''' IN SCHEMA OPENROUTESERVICE_APP.CORE';
                BEGIN
                    SELECT "status" INTO :pw_status
                    FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) LIMIT 1;
                EXCEPTION WHEN OTHER THEN pw_status := '';
                END;
                IF (UPPER(:pw_status) = 'RUNNING') THEN
                    CALL OPENROUTESERVICE_APP.CORE.PREWARM_REGION_GRAPH(:pw_region);
                    UPDATE OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP
                       SET NEEDS_PREWARM = FALSE, UPDATED_AT = SYSDATE()
                     WHERE UPPER(REGION) = UPPER(:pw_region);
                END IF;
            EXCEPTION WHEN OTHER THEN NULL;
            END;
        END FOR;
    EXCEPTION WHEN OTHER THEN NULL;
    END;

    RETURN 'scanned=' || :seen || ' rescued=' || :rescued;
END;
$$;

CREATE OR REPLACE TASK OPENROUTESERVICE_APP.CORE.RESCUE_PENDING_PROVISIONS_TASK
    SCHEDULE = 'USING CRON */2 * * * * UTC'
    USER_TASK_MANAGED_INITIAL_WAREHOUSE_SIZE = 'XSMALL'
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"rescue","action":"task"}}'
AS
    CALL OPENROUTESERVICE_APP.CORE.RESCUE_PENDING_PROVISIONS();

-- ===========================================================================
-- VALIDATE_REGION_PREFLIGHT (#52)
-- ---------------------------------------------------------------------------
-- Estimates a PBF's resource needs from its bounding-box area, compares
-- against the chosen compute size, and returns a JSON verdict the
-- control-app uses to warn the user BEFORE starting a build that would
-- run out of memory or hang for days (the documented 3-day continental
-- failure mode on borders=true).
--
-- Inputs:
--   P_MIN_LAT, P_MAX_LAT, P_MIN_LON, P_MAX_LON  -- region bounding box
--   P_PROFILES                                  -- comma-separated profile list
--   P_COMPUTE_SIZE                              -- 'S' | 'L' | 'XXL'
--
-- Returns JSON:
--   {
--     "ok": <bool>,
--     "estimated_pbf_gib": <float>,
--     "estimated_graph_gib": <float>,
--     "recommended_compute_size": "S|L|XXL",
--     "recommended_instance_family": "HIGHMEM_X64_S|M|L",
--     "warnings": [...],
--     "errors": [...]
--   }
--
-- The procedure NEVER mutates state. PROVISION_REGION_WRAPPER and the
-- control-app are free to call it as a soft check (warn-only) or refuse
-- the build.
-- ===========================================================================
CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.VALIDATE_REGION_PREFLIGHT(
    P_MIN_LAT FLOAT, P_MAX_LAT FLOAT, P_MIN_LON FLOAT, P_MAX_LON FLOAT,
    P_PROFILES VARCHAR,
    P_COMPUTE_SIZE VARCHAR
)
RETURNS STRING
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"preflight"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    bbox_area_sqkm FLOAT DEFAULT 0;
    est_pbf_gib    FLOAT DEFAULT 0;
    est_graph_gib  FLOAT DEFAULT 0;
    profile_count  INTEGER DEFAULT 1;
    rec_size       VARCHAR DEFAULT 'S';
    rec_family     VARCHAR DEFAULT 'HIGHMEM_X64_S';
    compute_rank   INTEGER DEFAULT 1;
    rec_rank       INTEGER DEFAULT 1;
    warnings_arr   ARRAY DEFAULT ARRAY_CONSTRUCT();
    errors_arr     ARRAY DEFAULT ARRAY_CONSTRUCT();
    ok BOOLEAN DEFAULT TRUE;
BEGIN
    bbox_area_sqkm := ABS((P_MAX_LON - P_MIN_LON) * (P_MAX_LAT - P_MIN_LAT)) * 111.0 * 111.0;
    -- Inhabited-area heuristic: ~0.05 GiB per 2500 km^2 (Berlin / SF / Munich
    -- city extracts) climbing to ~10 GiB at continental scale. Coastal /
    -- desert bboxes over-estimate; the procedure errs on the side of warning.
    est_pbf_gib := GREATEST(0.05, bbox_area_sqkm / 50000.0);
    profile_count := GREATEST(1, ARRAY_SIZE(SPLIT(:P_PROFILES, ',')));
    -- Each profile adds ~1.5x of the PBF in graph artefacts (CH + LM landmarks).
    est_graph_gib := :est_pbf_gib * 1.5 * :profile_count;

    -- Recommended compute_size mapping (matches BUILD_ORS_SERVICE_SPEC heap CASE).
    rec_size := CASE
        WHEN :est_graph_gib < 1.0 THEN 'S'
        WHEN :est_graph_gib < 6.0 THEN 'L'
        ELSE 'XXL'
    END;
    rec_family := CASE :rec_size
        WHEN 'S'   THEN 'HIGHMEM_X64_S'
        WHEN 'L'   THEN 'HIGHMEM_X64_M'
        ELSE             'HIGHMEM_X64_L'
    END;

    compute_rank := CASE UPPER(NVL(:P_COMPUTE_SIZE, 'S'))
        WHEN 'S' THEN 1 WHEN 'L' THEN 2 WHEN 'XXL' THEN 3 ELSE 1 END;
    rec_rank := CASE :rec_size
        WHEN 'S' THEN 1 WHEN 'L' THEN 2 WHEN 'XXL' THEN 3 END;

    IF (:compute_rank < :rec_rank) THEN
        warnings_arr := ARRAY_APPEND(
            :warnings_arr,
            'Estimated graph size ' || ROUND(:est_graph_gib, 2)
            || ' GiB exceeds the headroom of compute size '
            || NVL(:P_COMPUTE_SIZE, 'S')
            || '. Recommended: ' || :rec_size
            || ' (' || :rec_family || '). The build may OOM during LM landmark generation.'
        );
        ok := FALSE;
    END IF;

    IF (:est_graph_gib > 5.0) THEN
        warnings_arr := ARRAY_APPEND(
            :warnings_arr,
            'Estimated graph size ' || ROUND(:est_graph_gib, 2)
            || ' GiB is in the continental range. Apply the continental.yml '
            || 'preset (graphs_data_access: MMAP, maximum_snapping_radius: 5000) '
            || 'from .cortex/skills/routing-customization/references/ors-config-presets/ '
            || 'so the JVM can mmap the graph instead of loading it into RAM.'
        );
    END IF;

    IF (:profile_count > 4) THEN
        warnings_arr := ARRAY_APPEND(
            :warnings_arr,
            'Enabled ' || :profile_count || ' profiles. Each profile multiplies LM '
            || 'preparation time and graph artefact size by roughly 1.5x. '
            || 'Disable unused profiles to keep build time bounded.'
        );
    END IF;

    RETURN OBJECT_CONSTRUCT(
        'ok', :ok,
        'estimated_pbf_gib', ROUND(:est_pbf_gib, 2),
        'estimated_graph_gib', ROUND(:est_graph_gib, 2),
        'bbox_area_sqkm', ROUND(:bbox_area_sqkm, 0),
        'recommended_compute_size', :rec_size,
        'recommended_instance_family', :rec_family,
        'warnings', :warnings_arr,
        'errors', :errors_arr
    )::STRING;
END;
$$;

-- Resume the task. CREATE OR REPLACE TASK creates the task in SUSPENDED state
-- by default; without this RESUME the rescue loop never runs and every
-- finalization (Fix 2 downgrade, Fix 3 build-history reset, Fix 5a
-- auto-suspend restore, eventual STATUS=COMPLETE flip) requires a manual
-- CALL FINALIZE_PROVISION_ITER. ALTER TASK IF EXISTS is a plain statement
-- that snow sql -f can parse (the previous BEGIN/EXCEPTION/END wrapper
-- failed parsing with "unexpected EOF" and left the task suspended after
-- every deploy).
ALTER TASK IF EXISTS OPENROUTESERVICE_APP.CORE.RESCUE_PENDING_PROVISIONS_TASK RESUME;

-- ===========================================================================
-- Idempotent migration: re-stage ors-config.yml with init_threads for every
-- DEPLOYED region so the next suspend/resume loads profiles in parallel.
-- Does not ALTER SERVICE — config is picked up on the next container start.
-- ===========================================================================
CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.REROLL_ORS_CONFIG_INIT_THREADS()
RETURNS STRING
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.1","attributes":{"component":"migration","init_threads":true}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    rs RESULTSET;
    regions_processed INTEGER DEFAULT 0;
    msg VARCHAR DEFAULT '';
    profiles VARCHAR DEFAULT '';
    pbf_file VARCHAR DEFAULT '';
BEGIN
    rs := (
        SELECT REGION, PBF_URL, COALESCE(COMPUTE_SIZE, 'S') AS COMPUTE_SIZE
        FROM OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP
        WHERE STATUS = 'DEPLOYED'
    );
    LET c_reg CURSOR FOR rs;
    FOR r IN c_reg DO
        LET reg VARCHAR := r.REGION;
        LET reg_pbf_url VARCHAR := r.PBF_URL;
        LET reg_compute VARCHAR := r.COMPUTE_SIZE;
        -- Skip regions with an in-flight provision job: rewriting the ORS
        -- config (enabled profiles) mid-build would corrupt the running build.
        LET active_job_cnt INTEGER := 0;
        BEGIN
            SELECT COUNT(*) INTO :active_job_cnt
            FROM OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
            WHERE REGION = :reg AND STATUS IN ('RUNNING','PENDING');
        EXCEPTION WHEN OTHER THEN active_job_cnt := 0;
        END;
        IF (:active_job_cnt > 0) THEN
            CONTINUE;
        END IF;
        -- Honor the actual requested profiles (most recent non-failed job),
        -- not COMPLETE-only, so this migration never silently switches a
        -- region's enabled profiles to a hardcoded fallback.
        profiles := (
            SELECT PROFILES
            FROM OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
            WHERE REGION = :reg AND PROFILES IS NOT NULL
            ORDER BY CASE WHEN COALESCE(STATUS,'') NOT IN ('FAILED','ERROR') THEN 0 ELSE 1 END,
                     COALESCE(COMPLETED_AT, STARTED_AT, CREATED_AT) DESC
            LIMIT 1
        );
        IF (profiles IS NULL OR TRIM(profiles) = '') THEN
            -- No job ever recorded profiles for this region. Skip rather than
            -- guess: writing an empty profile set would produce a config with
            -- every profile disabled (a broken graph on next resume).
            CONTINUE;
        END IF;
        pbf_file := SPLIT_PART(COALESCE(:reg_pbf_url, ''), '/', -1);
        IF (pbf_file = '' OR pbf_file IS NULL) THEN
            pbf_file := :reg || '.osm.pbf';
        END IF;
        CALL OPENROUTESERVICE_APP.CORE.WRITE_ORS_CONFIG(:reg, :pbf_file, :profiles, :reg_compute);
        regions_processed := regions_processed + 1;
        msg := msg || :reg || '; ';
    END FOR;
    RETURN 'REROLL_ORS_CONFIG_INIT_THREADS: updated ' || regions_processed || ' region(s): ' || msg;
END;
$$;

-- ===========================================================================
-- v1.1.0 — Bootstrap default region (SanFrancisco) using the same per-region
-- service-creation procs used for every other region. Replaces the legacy
-- global ORS_SERVICE/VROOM_SERVICE create-statements that lived in
-- 01_core_infra.sql.
--
-- The SanFrancisco PBF + ors-config are shipped in the repo and pre-staged at
-- @ORS_SPCS_STAGE/SanFrancisco/ by the deploy script (SKILL.md Step 4), so we
-- deliberately skip PROVISION_REGION_WRAPPER's downloader flow.
--
-- create_region_ors_service probes @ORS_GRAPHS_SPCS_STAGE/SanFrancisco/ for
-- graph build markers; on first install no markers are present so it sets
-- REBUILD_GRAPHS=true. ORS then builds graphs from the staged PBF on first
-- boot. FINALIZE_DEFAULT_REGION_IF_READY (via RESCUE_PENDING_PROVISIONS_TASK,
-- */2 min) flips REBUILD_GRAPHS=false and writes _BUILD_OK once ORS_STATUS
-- reports service_ready so subsequent suspend/resume cycles reuse graphs.
--
-- Idempotent: skips create_region_ors_service when ORS_SERVICE_SANFRANCISCO
-- already exists (avoids drop/recreate on module redeploy). VROOM is always
-- ensured via create_region_vroom_service (CREATE IF NOT EXISTS).
-- ===========================================================================
CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.BOOTSTRAP_DEFAULT_REGION()
RETURNS STRING
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.1","attributes":{"component":"bootstrap"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    svc_exists INTEGER DEFAULT 0;
    rs RESULTSET;
BEGIN
  LET svc_name VARCHAR := 'ORS_SERVICE_SANFRANCISCO';
  BEGIN
    EXECUTE IMMEDIATE 'SHOW SERVICES LIKE ''' || :svc_name || ''' IN SCHEMA OPENROUTESERVICE_APP.CORE';
    rs := (SELECT COUNT(*) AS C FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())));
    LET c_svc CURSOR FOR rs;
    FOR r IN c_svc DO svc_exists := r.C; END FOR;
  EXCEPTION WHEN OTHER THEN svc_exists := 0;
  END;

  IF (:svc_exists = 0) THEN
    CALL OPENROUTESERVICE_APP.CORE.create_region_ors_service('SanFrancisco', 'S');
  END IF;

  CALL OPENROUTESERVICE_APP.CORE.create_region_vroom_service('SanFrancisco');

  IF (:svc_exists > 0) THEN
    RETURN 'BOOTSTRAP_DEFAULT_REGION: ORS_SERVICE_SANFRANCISCO already exists; ensured VROOM only.';
  END IF;
  RETURN 'BOOTSTRAP_DEFAULT_REGION: created ORS_SERVICE_SANFRANCISCO + VROOM_SERVICE_SANFRANCISCO in ORS_POOL_SANFRANCISCO. Graphs build from staged PBF on first boot.';
END;
$$;

CALL OPENROUTESERVICE_APP.CORE.REROLL_ORS_CONFIG_INIT_THREADS();
CALL OPENROUTESERVICE_APP.CORE.BOOTSTRAP_DEFAULT_REGION();
