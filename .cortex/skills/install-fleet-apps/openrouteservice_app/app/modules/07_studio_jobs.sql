-- 07_studio_jobs.sql
-- Synthetic Data Studio job execution as one-shot SPCS Job Services.
--
-- Why: keep generation runs alive across control-app rebuilds/redeploys.
-- Each generation runs as its own short-lived SPCS Job Service (one container,
-- runs to completion, exits) co-located with the region's ORS pool. The
-- control app only kicks off the job and polls JOB_EVENTS / GENERATION_JOBS
-- for progress.
--
-- Tables:
--   FLEET_INTELLIGENCE.CORE.JOB_EVENTS       -- created in ensure-tables.ts
--   FLEET_INTELLIGENCE.CORE.GENERATION_JOBS  -- created in ensure-tables.ts
--
-- Procedures:
--   STUDIO_START_JOB(job_id, region, image_tag) -> launches the worker job
--   STUDIO_GC_FINISHED_JOBS()                   -> drops DONE/FAILED job services
--
-- Task: STUDIO_JOB_GC -- runs hourly, calls STUDIO_GC_FINISHED_JOBS

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-studio-jobs","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

USE DATABASE OPENROUTESERVICE_APP;
USE SCHEMA CORE;

-- ---------------------------------------------------------------------------
-- STUDIO_START_JOB
--
-- Inputs
--   P_JOB_ID    -- UUID-shaped string (already INSERTed into GENERATION_JOBS)
--   P_REGION    -- region name (will be UPPER'd for pool name)
--   P_IMAGE_TAG -- studio worker image tag (e.g. 'v1.0.0')
--
-- Behavior
--   EXECUTE JOB SERVICE in pool ORS_POOL_<UPPER(REGION)>. The worker container
--   reads STUDIO_WORKER_JOB_ID from env, drives generation, writes progress to
--   JOB_EVENTS, and exits. SPCS reaps the service when the entrypoint exits.
--
-- Notes
--   - We use the per-region pool that already hosts ORS_SERVICE_<REGION>; the
--     pool is sized for ORS plus a small worker comfortably.
--   - The service is named STUDIO_JOB_<sanitized JOB_ID> for simple cleanup.
--   - QUERY_WAREHOUSE is set so the worker's snowflake-sdk uses ROUTING_ANALYTICS
--     as the default for any session-bound calls (the worker can override).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.STUDIO_START_JOB(
    P_JOB_ID    VARCHAR,
    P_REGION    VARCHAR,
    P_IMAGE_TAG VARCHAR
)
RETURNS STRING
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-studio-start-job","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    svc_name      VARCHAR;
    pool_name     VARCHAR;
    spec_yaml     VARCHAR;
    sanitized_id  VARCHAR;
    region_upper  VARCHAR;
BEGIN
    sanitized_id := REGEXP_REPLACE(:P_JOB_ID, '[^A-Za-z0-9]', '_');
    svc_name     := 'STUDIO_JOB_' || UPPER(:sanitized_id);
    region_upper := UPPER(REPLACE(:P_REGION, ' ', ''));
    pool_name    := 'ORS_POOL_' || :region_upper;

    -- Idempotent: drop a stale service with the same name, if any.
    BEGIN
        EXECUTE IMMEDIATE 'DROP SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.' || :svc_name;
    EXCEPTION WHEN OTHER THEN NULL;
    END;

    spec_yaml := 'spec:\n' ||
'  containers:\n' ||
'    - name: studio-worker\n' ||
'      image: /openrouteservice_app/core/image_repository/ors_studio_worker:' || :P_IMAGE_TAG || '\n' ||
'      env:\n' ||
'        STUDIO_WORKER_JOB_ID: "' || :P_JOB_ID || '"\n' ||
'        SNOWFLAKE_DATABASE: "OPENROUTESERVICE_APP"\n' ||
'        SNOWFLAKE_WAREHOUSE: "ROUTING_ANALYTICS"\n' ||
'      resources:\n' ||
'        requests:\n' ||
'          cpu: "0.5"\n' ||
'          memory: "1Gi"\n' ||
'        limits:\n' ||
'          cpu: "2"\n' ||
'          memory: "2Gi"\n';

    EXECUTE IMMEDIATE
        'EXECUTE JOB SERVICE IN COMPUTE POOL ' || :pool_name ||
        ' NAME = OPENROUTESERVICE_APP.CORE.' || :svc_name ||
        ' QUERY_WAREHOUSE = ROUTING_ANALYTICS' ||
        ' ASYNC = TRUE' ||
        ' COMMENT = ''{"origin":"sf_sit-is-fleet","name":"oss-studio-job","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}''' ||
        ' FROM SPECIFICATION ' || CHR(36) || CHR(36) || :spec_yaml || CHR(36) || CHR(36);

    RETURN OBJECT_CONSTRUCT('status', 'launched', 'service', :svc_name, 'pool', :pool_name)::STRING;
END;
$$;

-- ---------------------------------------------------------------------------
-- STUDIO_GC_FINISHED_JOBS
--
-- Drop any STUDIO_JOB_* service whose underlying container has exited (DONE or
-- FAILED status) for >1 hour. Job rows in GENERATION_JOBS are independent of
-- the SPCS service object and are not touched by this proc.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.STUDIO_GC_FINISHED_JOBS()
RETURNS STRING
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-studio-gc","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    dropped INT DEFAULT 0;
BEGIN
    SHOW SERVICES LIKE 'STUDIO_JOB_%' IN SCHEMA OPENROUTESERVICE_APP.CORE;
    -- Assign the RESULTSET before declaring the cursor. Declaring
    -- "cur CURSOR FOR rs" in the DECLARE block (before rs is assigned) raises
    -- "uninitialized resultSet 'RS'"; the working pattern is LET rs := (...)
    -- then LET cur CURSOR FOR rs inside the body.
    LET rs RESULTSET := (
        SELECT "name" AS svc_name, "status" AS status, "updated_on" AS updated_on
        FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
        WHERE "status" IN ('DONE', 'FAILED', 'INTERNAL_ERROR')
          AND "updated_on" < DATEADD(hour, -1, CURRENT_TIMESTAMP())
    );
    LET cur CURSOR FOR rs;
    FOR rec IN cur DO
        BEGIN
            EXECUTE IMMEDIATE 'DROP SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.' || rec.svc_name;
            dropped := dropped + 1;
        EXCEPTION WHEN OTHER THEN NULL;
        END;
    END FOR;

    -- Also trim JOB_EVENTS for jobs whose row is COMPLETED/FAILED/STOPPED for
    -- >7 days. Keeps the polling table small.
    DELETE FROM FLEET_INTELLIGENCE.CORE.JOB_EVENTS
    WHERE JOB_ID IN (
        SELECT JOB_ID FROM FLEET_INTELLIGENCE.CORE.GENERATION_JOBS
        WHERE STATUS IN ('COMPLETED', 'FAILED', 'STOPPED', 'CANCELLED', 'DELETED')
          AND COMPLETED_AT < DATEADD(day, -7, CURRENT_TIMESTAMP())
    );

    RETURN OBJECT_CONSTRUCT('dropped_services', dropped)::STRING;
END;
$$;

-- ---------------------------------------------------------------------------
-- STUDIO_JOB_GC task
--
-- Hourly cleanup of finished SPCS job services and old JOB_EVENTS rows. The
-- task is created in SUSPENDED state; ALTER it to RESUME after first deploy.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE TASK OPENROUTESERVICE_APP.CORE.STUDIO_JOB_GC
    WAREHOUSE = ROUTING_ANALYTICS
    SCHEDULE  = '60 MINUTE'
    COMMENT   = '{"origin":"sf_sit-is-fleet","name":"oss-studio-job-gc","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
    CALL OPENROUTESERVICE_APP.CORE.STUDIO_GC_FINISHED_JOBS();

ALTER TASK OPENROUTESERVICE_APP.CORE.STUDIO_JOB_GC RESUME;
