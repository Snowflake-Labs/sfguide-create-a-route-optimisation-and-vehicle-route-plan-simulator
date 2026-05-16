 USE SCHEMA OPENROUTESERVICE_APP.CORE;   

-- =============================================================================
-- SERVICE LIFECYCLE: resume, suspend, scale, status, health check
-- =============================================================================

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.RESUME_ALL_SERVICES()
RETURNS STRING
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"lifecycle"}}'
AS
$$
DECLARE
    resumed_count INTEGER DEFAULT 0;
    already_running INTEGER DEFAULT 0;
BEGIN
    SHOW SERVICES IN SCHEMA OPENROUTESERVICE_APP.CORE;

    LET rs RESULTSET := (
        SELECT "name" AS svc_name, "status" AS svc_status
        FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
        WHERE "is_job" = 'false'
    );
    LET cur CURSOR FOR rs;

    FOR rec IN cur DO
        IF (rec.svc_status = 'SUSPENDED') THEN
            BEGIN
                EXECUTE IMMEDIATE 'ALTER SERVICE OPENROUTESERVICE_APP.CORE.' || rec.svc_name || ' RESUME';
                resumed_count := resumed_count + 1;
            EXCEPTION
                WHEN OTHER THEN NULL;
            END;
        ELSEIF (rec.svc_status IN ('RUNNING', 'READY')) THEN
            already_running := already_running + 1;
        END IF;
    END FOR;

    LET pool_name VARCHAR := (SELECT CURRENT_DATABASE()) || '_compute_pool';
    BEGIN
        LET pool_status VARCHAR := 'UNKNOWN';
        SHOW COMPUTE POOLS LIKE :pool_name;
        SELECT "state" INTO :pool_status FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) LIMIT 1;
        IF (pool_status IN ('SUSPENDED', 'STOPPING')) THEN
            ALTER COMPUTE POOL IDENTIFIER(:pool_name) RESUME;
            resumed_count := resumed_count + 1;
        END IF;
    EXCEPTION WHEN OTHER THEN NULL;
    END;

    RETURN OBJECT_CONSTRUCT(
        'resumed', resumed_count,
        'already_running', already_running
    )::STRING;
END;
$$;

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.resume_services()
RETURNS STRING
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"lifecycle"}}'
AS
$$
BEGIN
    LET result VARCHAR;
    CALL OPENROUTESERVICE_APP.CORE.RESUME_ALL_SERVICES() INTO :result;
    RETURN result;
END;
$$;
CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.SUSPEND_ALL_SERVICES()
RETURNS STRING
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"lifecycle"}}'
AS
$$
DECLARE
    suspended_count INTEGER DEFAULT 0;
BEGIN
    -- Best-effort drift repair: ensures services not currently in an active
    -- provision or matrix job have AUTO_SUSPEND_SECS=14400 before / after suspend.
    BEGIN
        CALL OPENROUTESERVICE_APP.CORE.RECONCILE_AUTO_SUSPEND();
    EXCEPTION WHEN OTHER THEN NULL;
    END;

    -- Best-effort warehouse-size drift repair: if no matrix job is active,
    -- shrink ROUTING_ANALYTICS back to the SMALL steady-state. This catches
    -- the case where a matrix build bumped the warehouse to LARGE / X-LARGE
    -- and the in-procedure restore was skipped (e.g. session killed).
    BEGIN
        CALL OPENROUTESERVICE_APP.CORE.RECONCILE_WAREHOUSE_SIZE();
    EXCEPTION WHEN OTHER THEN NULL;
    END;

    SHOW SERVICES IN SCHEMA OPENROUTESERVICE_APP.CORE;

    LET rs RESULTSET := (
        SELECT "name" AS svc_name, "status" AS svc_status
        FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
        WHERE "is_job" = 'false'
    );
    LET cur CURSOR FOR rs;

    FOR rec IN cur DO
        IF (UPPER(rec.svc_name) = 'ORS_CONTROL_APP') THEN
            CONTINUE;
        END IF;
        IF (rec.svc_status IN ('RUNNING', 'READY')) THEN
            BEGIN
                EXECUTE IMMEDIATE 'ALTER SERVICE OPENROUTESERVICE_APP.CORE.' || rec.svc_name || ' SUSPEND';
                suspended_count := suspended_count + 1;
            EXCEPTION
                WHEN OTHER THEN NULL;
            END;
        END IF;
    END FOR;

    RETURN 'Suspended ' || suspended_count || ' services';
END;
$$;

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.SCALE_SERVICES(P_MIN_INSTANCES INTEGER, P_MAX_INSTANCES INTEGER)
RETURNS STRING
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"lifecycle"}}'
AS
$$
DECLARE
    region_scaled INTEGER DEFAULT 0;
BEGIN
    ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ors_service SET MIN_INSTANCES = :P_MIN_INSTANCES MAX_INSTANCES = :P_MAX_INSTANCES;
    ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.routing_gateway_service SET MIN_INSTANCES = :P_MIN_INSTANCES MAX_INSTANCES = :P_MAX_INSTANCES;

    BEGIN
        SHOW SERVICES LIKE 'ORS_SERVICE_%' IN SCHEMA OPENROUTESERVICE_APP.CORE;
        LET rs RESULTSET := (
            SELECT "name" AS svc_name FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
        );
        LET cur CURSOR FOR rs;
        FOR rec IN cur DO
            BEGIN
                EXECUTE IMMEDIATE 'ALTER SERVICE OPENROUTESERVICE_APP.CORE.' || rec.svc_name || ' SET MIN_INSTANCES = 1 MAX_INSTANCES = 1';
                region_scaled := region_scaled + 1;
            EXCEPTION WHEN OTHER THEN NULL;
            END;
        END FOR;
    EXCEPTION WHEN OTHER THEN NULL;
    END;

    LET pool_name VARCHAR := (SELECT CURRENT_DATABASE()) || '_compute_pool';
    LET pool_nodes INTEGER := GREATEST(:P_MAX_INSTANCES + region_scaled + 2, 3);
    ALTER COMPUTE POOL IF EXISTS IDENTIFIER(:pool_name) SET MIN_NODES = :pool_nodes MAX_NODES = :pool_nodes;

    RETURN 'Scaled ORS + gateway to ' || :P_MIN_INSTANCES || '-' || :P_MAX_INSTANCES || ' instances, ' || :region_scaled || ' city services, pool to ' || :pool_nodes || ' nodes';
END;
$$;

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.SCALE_SERVICES(P_ORS_INSTANCES INTEGER, P_GATEWAY_INSTANCES INTEGER, P_POOL_NODES INTEGER)
RETURNS STRING
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"lifecycle"}}'
AS
$$
DECLARE
    region_svc_count INTEGER DEFAULT 0;
BEGIN
    ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ors_service SET MIN_INSTANCES = :P_ORS_INSTANCES MAX_INSTANCES = :P_ORS_INSTANCES;
    ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.routing_gateway_service SET MIN_INSTANCES = :P_GATEWAY_INSTANCES MAX_INSTANCES = :P_GATEWAY_INSTANCES;

    SHOW SERVICES LIKE 'ORS_SERVICE_%' IN SCHEMA OPENROUTESERVICE_APP.CORE;
    SELECT COUNT(*) INTO :region_svc_count FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) WHERE "status" != 'SUSPENDED';

    LET pool_name VARCHAR := (SELECT CURRENT_DATABASE()) || '_compute_pool';
    LET total_instances INTEGER := :P_ORS_INSTANCES + :P_GATEWAY_INSTANCES + :region_svc_count + 3;
    LET min_nodes INTEGER := GREATEST(:P_POOL_NODES, CEIL(:total_instances / 3));
    ALTER COMPUTE POOL IF EXISTS IDENTIFIER(:pool_name) SET MIN_NODES = :min_nodes MAX_NODES = :min_nodes;

    RETURN 'Scaled ORS=' || :P_ORS_INSTANCES || ', gateway=' || :P_GATEWAY_INSTANCES || 
           ', region_svcs=' || :region_svc_count || ', pool=' || :min_nodes || ' nodes';
END;
$$;

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.GET_STATUS()
RETURNS STRING
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"lifecycle"}}'
AS
$$
DECLARE
    pool_state VARCHAR DEFAULT 'UNKNOWN';
    pool_info VARIANT DEFAULT OBJECT_CONSTRUCT();
    compute_pools VARIANT DEFAULT OBJECT_CONSTRUCT();
    services VARIANT DEFAULT ARRAY_CONSTRUCT();
BEGIN
    LET pool_name VARCHAR := (SELECT CURRENT_DATABASE()) || '_compute_pool';
    BEGIN
        SHOW COMPUTE POOLS LIKE :pool_name;
        SELECT OBJECT_CONSTRUCT(
            'state', "state",
            'instance_family', "instance_family",
            'min_nodes', "min_nodes",
            'max_nodes', "max_nodes",
            'active_nodes', "active_nodes",
            'idle_nodes', "idle_nodes",
            'num_services', "num_services"
        ), "state"
        INTO :pool_info, :pool_state
        FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) LIMIT 1;
    EXCEPTION WHEN OTHER THEN
        pool_state := 'NOT_FOUND';
        pool_info := OBJECT_CONSTRUCT('state', 'NOT_FOUND');
    END;

    BEGIN
        SHOW COMPUTE POOLS;
        LET prs RESULTSET := (
            SELECT "name" AS pn, "state" AS ps, "instance_family" AS pif,
                   "min_nodes" AS pmin, "max_nodes" AS pmax,
                   "active_nodes" AS pact, "idle_nodes" AS pidle,
                   "num_services" AS pnum
            FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
        );
        LET pcur CURSOR FOR prs;
        FOR prec IN pcur DO
            compute_pools := OBJECT_INSERT(compute_pools, prec.pn, OBJECT_CONSTRUCT(
                'state', prec.ps,
                'instance_family', prec.pif,
                'min_nodes', prec.pmin,
                'max_nodes', prec.pmax,
                'active_nodes', prec.pact,
                'idle_nodes', prec.pidle,
                'num_services', prec.pnum
            ), TRUE);
        END FOR;
    EXCEPTION WHEN OTHER THEN NULL;
    END;

    SHOW SERVICES IN SCHEMA OPENROUTESERVICE_APP.CORE;

    LET rs RESULTSET := (
        SELECT
            "name" AS svc_name,
            "status" AS svc_status,
            "compute_pool" AS svc_pool,
            "min_instances" AS svc_min,
            "max_instances" AS svc_max,
            "current_instances" AS svc_cur,
            "target_instances" AS svc_target,
            "auto_suspend_secs" AS svc_auto_suspend
        FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
        WHERE "is_job" = 'false'
    );
    LET cur CURSOR FOR rs;

    FOR rec IN cur DO
        services := ARRAY_APPEND(services, OBJECT_CONSTRUCT(
            'name', rec.svc_name,
            'status', rec.svc_status,
            'compute_pool', rec.svc_pool,
            'min_instances', rec.svc_min,
            'max_instances', rec.svc_max,
            'current_instances', rec.svc_cur,
            'target_instances', rec.svc_target,
            'auto_suspend_secs', rec.svc_auto_suspend
        ));
    END FOR;

    RETURN OBJECT_CONSTRUCT(
        'compute_pool', pool_state,
        'compute_pool_info', pool_info,
        'compute_pools', compute_pools,
        'services', services
    )::STRING;
END;
$$;

-- =============================================================================
-- Per-service lifecycle procedures
-- Used by the ORS Control App for granular Resume/Suspend operations.
-- ORS_CONTROL_APP is intentionally protected from self-suspension since
-- suspending it would terminate the UI that initiated the request.
-- =============================================================================

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.RESUME_SERVICE(P_NAME VARCHAR)
RETURNS STRING
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"lifecycle"}}'
AS
$$
DECLARE
    svc_status VARCHAR DEFAULT NULL;
    svc_match  VARCHAR DEFAULT NULL;
BEGIN
    IF (P_NAME IS NULL OR LENGTH(TRIM(P_NAME)) = 0) THEN
        RETURN OBJECT_CONSTRUCT('status', 'error', 'error', 'service name required')::STRING;
    END IF;

    LET safe_name VARCHAR := REGEXP_REPLACE(UPPER(P_NAME), '[^A-Z0-9_]', '');
    IF (LENGTH(safe_name) = 0) THEN
        RETURN OBJECT_CONSTRUCT('status', 'error', 'error', 'invalid service name')::STRING;
    END IF;

    SHOW SERVICES LIKE :safe_name IN SCHEMA OPENROUTESERVICE_APP.CORE;
    BEGIN
        SELECT "name", "status"
        INTO :svc_match, :svc_status
        FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
        WHERE "is_job" = 'false'
        LIMIT 1;
    EXCEPTION WHEN OTHER THEN
        svc_match := NULL;
    END;

    IF (svc_match IS NULL) THEN
        RETURN OBJECT_CONSTRUCT('status', 'error', 'error', 'service not found: ' || safe_name)::STRING;
    END IF;

    IF (svc_status IN ('RUNNING', 'READY')) THEN
        RETURN OBJECT_CONSTRUCT('status', 'ok', 'service', svc_match, 'already', svc_status)::STRING;
    END IF;

    EXECUTE IMMEDIATE 'ALTER SERVICE OPENROUTESERVICE_APP.CORE.' || svc_match || ' RESUME';
    RETURN OBJECT_CONSTRUCT('status', 'ok', 'service', svc_match, 'action', 'resumed')::STRING;
END;
$$;

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.SUSPEND_SERVICE(P_NAME VARCHAR)
RETURNS STRING
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"lifecycle"}}'
AS
$$
DECLARE
    svc_status VARCHAR DEFAULT NULL;
    svc_match  VARCHAR DEFAULT NULL;
BEGIN
    IF (P_NAME IS NULL OR LENGTH(TRIM(P_NAME)) = 0) THEN
        RETURN OBJECT_CONSTRUCT('status', 'error', 'error', 'service name required')::STRING;
    END IF;

    LET safe_name VARCHAR := REGEXP_REPLACE(UPPER(P_NAME), '[^A-Z0-9_]', '');
    IF (LENGTH(safe_name) = 0) THEN
        RETURN OBJECT_CONSTRUCT('status', 'error', 'error', 'invalid service name')::STRING;
    END IF;

    IF (safe_name = 'ORS_CONTROL_APP') THEN
        RETURN OBJECT_CONSTRUCT('status', 'error', 'error', 'ORS_CONTROL_APP cannot be suspended from itself')::STRING;
    END IF;

    -- Best-effort drift repair before suspension.
    BEGIN
        CALL OPENROUTESERVICE_APP.CORE.RECONCILE_AUTO_SUSPEND();
    EXCEPTION WHEN OTHER THEN NULL;
    END;

    SHOW SERVICES LIKE :safe_name IN SCHEMA OPENROUTESERVICE_APP.CORE;
    BEGIN
        SELECT "name", "status"
        INTO :svc_match, :svc_status
        FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
        WHERE "is_job" = 'false'
        LIMIT 1;
    EXCEPTION WHEN OTHER THEN
        svc_match := NULL;
    END;

    IF (svc_match IS NULL) THEN
        RETURN OBJECT_CONSTRUCT('status', 'error', 'error', 'service not found: ' || safe_name)::STRING;
    END IF;

    IF (svc_status = 'SUSPENDED') THEN
        RETURN OBJECT_CONSTRUCT('status', 'ok', 'service', svc_match, 'already', svc_status)::STRING;
    END IF;

    EXECUTE IMMEDIATE 'ALTER SERVICE OPENROUTESERVICE_APP.CORE.' || svc_match || ' SUSPEND';
    RETURN OBJECT_CONSTRUCT('status', 'ok', 'service', svc_match, 'action', 'suspended')::STRING;
END;
$$;

-- =============================================================================
-- AUTO_SUSPEND_SECS invariant / reconciliation
-- ---------------------------------------------------------------------------
-- Invariant: while a region is being provisioned (graph build) or a matrix
-- job is running, the relevant ORS services MUST have AUTO_SUSPEND_SECS=0 so
-- automatic time-based suspension cannot interrupt the job. At all other
-- times the services SHOULD have AUTO_SUSPEND_SECS=14400.
--
-- RECONCILE_AUTO_SUSPEND() is an idempotent safety-net procedure that detects
-- drift (e.g. from an abandoned session / killed statement) and restores the
-- expected AUTO_SUSPEND_SECS value on each service based on whether it is
-- currently participating in an active build.
-- =============================================================================

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.RECONCILE_AUTO_SUSPEND()
RETURNS STRING
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"lifecycle"}}'
AS
$$
DECLARE
    gateway_busy BOOLEAN DEFAULT FALSE;
    reconciled INTEGER DEFAULT 0;
    left_zero  INTEGER DEFAULT 0;
BEGIN
    -- Any matrix job currently running means the gateway and at least one
    -- ORS_SERVICE_<REGION> must stay at AUTO_SUSPEND_SECS=0.
    LET active_matrix INTEGER := 0;
    BEGIN
        SELECT COUNT(*) INTO :active_matrix
        FROM OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
        WHERE STATUS IN ('PENDING','RUNNING')
          AND STAGE NOT IN ('COMPLETE','ERROR');
    EXCEPTION WHEN OTHER THEN active_matrix := 0;
    END;
    IF (active_matrix > 0) THEN gateway_busy := TRUE; END IF;

    -- Reconcile the gateway service.
    BEGIN
        IF (gateway_busy) THEN
            ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.routing_gateway_service SET AUTO_SUSPEND_SECS = 0;
            left_zero := left_zero + 1;
        ELSE
            ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.routing_gateway_service SET AUTO_SUSPEND_SECS = 14400;
            reconciled := reconciled + 1;
        END IF;
    EXCEPTION WHEN OTHER THEN NULL;
    END;

    -- Reconcile each ORS_SERVICE_<REGION> individually.
    SHOW SERVICES LIKE 'ORS_SERVICE_%' IN SCHEMA OPENROUTESERVICE_APP.CORE;
    LET rs RESULTSET := (
        SELECT "name" AS svc_name
        FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
        WHERE "is_job" = 'false'
    );
    LET cur CURSOR FOR rs;

    FOR rec IN cur DO
        LET region_key VARCHAR := REGEXP_REPLACE(UPPER(rec.svc_name), '^ORS_SERVICE_', '');
        LET busy BOOLEAN := FALSE;

        -- Active provisioning job for this region?
        BEGIN
            LET pc INTEGER := 0;
            SELECT COUNT(*) INTO :pc
            FROM OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
            WHERE UPPER(REGION) = :region_key
              AND STATUS IN ('PENDING','RUNNING')
              AND STAGE IN ('DOWNLOADING','CONFIGURING','STARTING_SERVICE','WAITING_FOR_SERVICE','BUILDING_GRAPH');
            IF (pc > 0) THEN busy := TRUE; END IF;
        EXCEPTION WHEN OTHER THEN NULL;
        END;

        -- Active matrix job targeting this region?
        BEGIN
            LET mc INTEGER := 0;
            SELECT COUNT(*) INTO :mc
            FROM OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
            WHERE UPPER(REGION) = :region_key
              AND STATUS IN ('PENDING','RUNNING')
              AND STAGE NOT IN ('COMPLETE','ERROR');
            IF (mc > 0) THEN busy := TRUE; END IF;
        EXCEPTION WHEN OTHER THEN NULL;
        END;

        BEGIN
            IF (busy) THEN
                EXECUTE IMMEDIATE 'ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.' || rec.svc_name || ' SET AUTO_SUSPEND_SECS = 0';
                left_zero := left_zero + 1;
            ELSE
                EXECUTE IMMEDIATE 'ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.' || rec.svc_name || ' SET AUTO_SUSPEND_SECS = 14400';
                reconciled := reconciled + 1;
            END IF;
        EXCEPTION WHEN OTHER THEN NULL;
        END;
    END FOR;

    -- Legacy single-tenant ors_service: only touch if it exists; treat as busy
    -- only if the gateway is busy (matrix path).
    BEGIN
        IF (gateway_busy) THEN
            ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ors_service SET AUTO_SUSPEND_SECS = 0;
        ELSE
            ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ors_service SET AUTO_SUSPEND_SECS = 14400;
        END IF;
    EXCEPTION WHEN OTHER THEN NULL;
    END;

    RETURN OBJECT_CONSTRUCT(
        'reconciled_to_default', reconciled,
        'left_at_zero_due_to_active_job', left_zero
    )::STRING;
END;
$$;


-- =============================================================================
-- ROUTING_ANALYTICS warehouse size invariant / reconciliation
-- ---------------------------------------------------------------------------
-- Invariant: while a matrix build is running, the matrix pipeline may bump
-- ROUTING_ANALYTICS to LARGE (>5k hex) or X-LARGE (>25k hex) and is expected
-- to restore the original size when the BUILD_WORK_QUEUE step finishes. If
-- the session is killed or an unhandled error path is hit, the warehouse can
-- get stranded at the bumped size.
--
-- RECONCILE_WAREHOUSE_SIZE() is an idempotent safety-net that shrinks
-- ROUTING_ANALYTICS back to the 'SMALL' steady-state when no matrix job is
-- active. It is auto-called from SUSPEND_ALL_SERVICES.
-- =============================================================================

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.RECONCILE_WAREHOUSE_SIZE()
RETURNS STRING
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"lifecycle"}}'
AS
$$
DECLARE
    active_jobs INTEGER DEFAULT 0;
    current_size VARCHAR DEFAULT NULL;
BEGIN
    BEGIN
        SELECT COUNT(*) INTO :active_jobs
        FROM OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
        WHERE STATUS IN ('PENDING','RUNNING')
          AND STAGE NOT IN ('COMPLETE','ERROR');
    EXCEPTION WHEN OTHER THEN active_jobs := 0;
    END;

    IF (active_jobs > 0) THEN
        RETURN 'skipped: ' || active_jobs || ' active matrix job(s)';
    END IF;

    BEGIN
        SHOW WAREHOUSES LIKE 'ROUTING_ANALYTICS';
        SELECT "size" INTO :current_size
        FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
        LIMIT 1;
    EXCEPTION WHEN OTHER THEN current_size := NULL;
    END;

    -- Already at or below steady-state: nothing to do.
    IF (current_size IS NOT NULL
        AND UPPER(current_size) IN ('X-SMALL','XSMALL','SMALL'))
    THEN
        RETURN 'already at steady-state: ' || current_size;
    END IF;

    BEGIN
        ALTER WAREHOUSE ROUTING_ANALYTICS SET WAREHOUSE_SIZE = 'SMALL';
    EXCEPTION WHEN OTHER THEN
        RETURN 'reconcile_failed: could not resize from ' || COALESCE(current_size, 'unknown');
    END;

    RETURN 'reconciled: ' || COALESCE(current_size, 'unknown') || ' -> SMALL';
END;
$$;

