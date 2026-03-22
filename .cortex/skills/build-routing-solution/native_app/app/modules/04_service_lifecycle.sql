-- =============================================================================
-- SERVICE LIFECYCLE: resume, suspend, scale, status, health check
-- =============================================================================

CREATE OR REPLACE PROCEDURE core.RESUME_ALL_SERVICES()
RETURNS STRING
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"lifecycle"}}'
AS
$$
DECLARE
    resumed_count INTEGER DEFAULT 0;
    already_running INTEGER DEFAULT 0;
BEGIN
    SHOW SERVICES IN SCHEMA core;

    LET rs RESULTSET := (
        SELECT "name" AS svc_name, "status" AS svc_status
        FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
        WHERE "is_job" = 'false'
    );
    LET cur CURSOR FOR rs;

    FOR rec IN cur DO
        IF (rec.svc_status = 'SUSPENDED') THEN
            BEGIN
                EXECUTE IMMEDIATE 'ALTER SERVICE core.' || rec.svc_name || ' RESUME';
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
GRANT USAGE ON PROCEDURE core.RESUME_ALL_SERVICES() TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.resume_services()
RETURNS STRING
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"lifecycle"}}'
AS
$$
BEGIN
    LET result VARCHAR;
    CALL core.RESUME_ALL_SERVICES() INTO :result;
    RETURN result;
END;
$$;
GRANT USAGE ON PROCEDURE core.resume_services() TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.SUSPEND_ALL_SERVICES()
RETURNS STRING
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"lifecycle"}}'
AS
$$
DECLARE
    suspended_count INTEGER DEFAULT 0;
BEGIN
    SHOW SERVICES IN SCHEMA core;

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
                EXECUTE IMMEDIATE 'ALTER SERVICE core.' || rec.svc_name || ' SUSPEND';
                suspended_count := suspended_count + 1;
            EXCEPTION
                WHEN OTHER THEN NULL;
            END;
        END IF;
    END FOR;

    RETURN 'Suspended ' || suspended_count || ' services';
END;
$$;
GRANT USAGE ON PROCEDURE core.SUSPEND_ALL_SERVICES() TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.SCALE_SERVICES(P_MIN_INSTANCES INTEGER, P_MAX_INSTANCES INTEGER)
RETURNS STRING
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"lifecycle"}}'
AS
$$
BEGIN
    ALTER SERVICE IF EXISTS core.ors_service SET MIN_INSTANCES = :P_MIN_INSTANCES MAX_INSTANCES = :P_MAX_INSTANCES;
    ALTER SERVICE IF EXISTS core.routing_gateway_service SET MIN_INSTANCES = :P_MIN_INSTANCES MAX_INSTANCES = :P_MAX_INSTANCES;

    LET pool_name VARCHAR := (SELECT CURRENT_DATABASE()) || '_compute_pool';
    LET pool_nodes INTEGER := GREATEST(:P_MAX_INSTANCES + 2, 3);
    ALTER COMPUTE POOL IF EXISTS IDENTIFIER(:pool_name) SET MIN_NODES = :pool_nodes MAX_NODES = :pool_nodes;

    RETURN 'Scaled ORS + gateway to ' || :P_MIN_INSTANCES || '-' || :P_MAX_INSTANCES || ' instances, pool to ' || :pool_nodes || ' nodes';
END;
$$;
GRANT USAGE ON PROCEDURE core.SCALE_SERVICES(INTEGER, INTEGER) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.GET_STATUS()
RETURNS STRING
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"lifecycle"}}'
AS
$$
DECLARE
    pool_status VARCHAR DEFAULT 'UNKNOWN';
    services VARIANT DEFAULT ARRAY_CONSTRUCT();
BEGIN
    LET pool_name VARCHAR := (SELECT CURRENT_DATABASE()) || '_compute_pool';
    BEGIN
        SHOW COMPUTE POOLS LIKE :pool_name;
        SELECT "state" INTO :pool_status FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) LIMIT 1;
    EXCEPTION WHEN OTHER THEN pool_status := 'NOT_FOUND'; END;

    SHOW SERVICES IN SCHEMA core;

    LET rs RESULTSET := (
        SELECT "name" AS svc_name, "status" AS svc_status
        FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
        WHERE "is_job" = 'false'
    );
    LET cur CURSOR FOR rs;

    FOR rec IN cur DO
        services := ARRAY_APPEND(services, OBJECT_CONSTRUCT('name', rec.svc_name, 'status', rec.svc_status));
    END FOR;

    RETURN OBJECT_CONSTRUCT(
        'compute_pool', pool_status,
        'services', services
    )::STRING;
END;
$$;
GRANT USAGE ON PROCEDURE core.GET_STATUS() TO APPLICATION ROLE app_user;
