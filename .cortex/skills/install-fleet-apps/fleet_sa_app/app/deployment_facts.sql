-- deployment_facts.sql
-- Shared, read-only "what is installed and is it up" rollup for all three agents.
--
-- WHY: the failing Cowork conversation had a user ask the Admin agent "is ORS
-- running for San Francisco?" and get three consecutive non-answers, because
-- service run-state lived only behind Ops-only ACTION verbs. Run-state is a FACT,
-- not an action: sharing the read while keeping suspend/resume Ops-only preserves
-- Tenet 3 role isolation and removes the dead end.
--
-- Owner's rights, so each role-scoped bundle can read engine state without being
-- granted MONITOR on the services (same pattern as CORE.GET_STATUS, wrapped by
-- the ops service_inventory verb).
--
-- Deliberately uses SHOW SERVICES, NOT CORE.ORS_STATUS and NOT
-- SYSTEM$GET_SERVICE_STATUS:
--   * ORS_STATUS issues an HTTP call to the region's gateway, which is slow on a
--     cold region and counts as traffic. This proc must be safe to call from any
--     agent turn and must never wake a suspended region just to describe it.
--   * SYSTEM$GET_SERVICE_STATUS returns '[]' for a SUSPENDED service - no error,
--     no status - so a suspended region is indistinguishable from a missing one,
--     and it reports 'READY' rather than 'RUNNING' for a live one. Both traps
--     produce a confidently wrong answer, which is the exact failure class this
--     change exists to remove.
-- SHOW SERVICES reports RUNNING / SUSPENDED / PENDING / FAILED directly, in one
-- call, without touching the service.
--
-- Idempotent (CREATE OR REPLACE). Runs in install step 4.8 with the catalog.

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.SEMANTIC
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.SEMANTIC.DESCRIBE_DEPLOYMENT()
RETURNS VARIANT
LANGUAGE SQL
-- COMMENT must precede EXECUTE AS (recurring install-time syntax trap in this repo).
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
  v_regions      ARRAY  DEFAULT ARRAY_CONSTRUCT();
  v_svc          OBJECT DEFAULT OBJECT_CONSTRUCT();
  v_region       STRING;
  v_ors_state    STRING;
  v_vroom_state  STRING;
  v_gateway      STRING DEFAULT 'NOT_FOUND';
  v_active_reg   STRING DEFAULT NULL;
  v_active_veh   STRING DEFAULT NULL;
  v_core_fns     NUMBER DEFAULT 0;
  v_tool_procs   NUMBER DEFAULT 0;
  v_sem_views    NUMBER DEFAULT 0;
  v_catalog      NUMBER DEFAULT 0;
  v_domains      ARRAY  DEFAULT ARRAY_CONSTRUCT();
  c_regions CURSOR FOR
    SELECT REGION FROM OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP ORDER BY IS_DEFAULT DESC, REGION;
BEGIN
  -- Substrate counts. The routing FUNCTIONS live in the engine database
  -- (OPENROUTESERVICE_APP.CORE); FLEET_INTELLIGENCE.CORE holds procedures, which
  -- is why counting the latter always reported zero.
  SELECT COUNT(*) INTO :v_core_fns
    FROM OPENROUTESERVICE_APP.INFORMATION_SCHEMA.FUNCTIONS
   WHERE FUNCTION_SCHEMA = 'CORE';

  SELECT COUNT(*) INTO :v_tool_procs
    FROM FLEET_INTELLIGENCE.INFORMATION_SCHEMA.PROCEDURES
   WHERE PROCEDURE_SCHEMA = 'ROUTING_TOOLS' AND STARTSWITH(PROCEDURE_NAME, 'TOOL_');

  -- Semantic views live in INFORMATION_SCHEMA.SEMANTIC_VIEWS (columns
  -- CATALOG/SCHEMA/NAME), NOT INFORMATION_SCHEMA.VIEWS - counting the latter
  -- reported 0 on a full 8-SV install. Guarded so an older account without the
  -- info-schema view still gets the rest of the rollup.
  BEGIN
    SELECT COUNT(*) INTO :v_sem_views
      FROM FLEET_INTELLIGENCE.INFORMATION_SCHEMA.SEMANTIC_VIEWS
     WHERE "SCHEMA" = 'SEMANTIC';
  EXCEPTION
    WHEN OTHER THEN
      v_sem_views := 0;
  END;

  -- Solution catalog (built by build_view_catalog.py). Absent on an older install,
  -- so tolerate its absence rather than failing the whole rollup.
  BEGIN
    SELECT COUNT(*), ARRAY_AGG(DISTINCT DOMAIN)
      INTO :v_catalog, :v_domains
      FROM FLEET_INTELLIGENCE.SEMANTIC.VIEW_CATALOG;
  EXCEPTION
    WHEN OTHER THEN
      v_catalog := 0;
      v_domains := ARRAY_CONSTRUCT();
  END;

  -- Active dashboard context (the CONFIG single-row table the projection views read).
  BEGIN
    SELECT REGION, VEHICLE_TYPE INTO :v_active_reg, :v_active_veh
      FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.CONFIG LIMIT 1;
  EXCEPTION
    WHEN OTHER THEN
      v_active_reg := NULL;
      v_active_veh := NULL;
  END;

  -- One SHOW SERVICES pass, collapsed to a name -> status map. SHOW + RESULT_SCAN
  -- run as two sequential statements on the same proc session (the pattern
  -- CORE.GET_STATUS uses); do NOT wrap them in EXECUTE IMMEDIATE.
  BEGIN
    SHOW SERVICES IN SCHEMA OPENROUTESERVICE_APP.CORE;
    SELECT COALESCE(OBJECT_AGG("name", TO_VARIANT("status")), OBJECT_CONSTRUCT())
      INTO :v_svc
      FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
     WHERE "is_job" = 'false';
  EXCEPTION
    WHEN OTHER THEN
      v_svc := OBJECT_CONSTRUCT();
  END;

  v_gateway := COALESCE(GET(:v_svc, 'ROUTING_GATEWAY_SERVICE')::STRING, 'NOT_FOUND');

  -- Per-region ORS + VROOM run-state, read from the map above.
  FOR r IN c_regions DO
    v_region := r.REGION;
    v_ors_state   := COALESCE(GET(:v_svc, 'ORS_SERVICE_'   || UPPER(:v_region))::STRING, 'NOT_FOUND');
    v_vroom_state := COALESCE(GET(:v_svc, 'VROOM_SERVICE_' || UPPER(:v_region))::STRING, 'NOT_FOUND');
    v_regions := ARRAY_APPEND(:v_regions, OBJECT_CONSTRUCT(
      'region', :v_region,
      'routing_service', :v_ors_state,
      'optimization_service', :v_vroom_state,
      -- Routing is only answerable live when the region's ORS service is RUNNING.
      -- SUSPENDED is normal and recoverable (Ops can resume, or the app's
      -- auto-resume path fires on first use), not a broken install.
      'routing_available', :v_ors_state = 'RUNNING'
    ));
  END FOR;

  RETURN OBJECT_CONSTRUCT(
    'substrate_ok', :v_core_fns > 0 AND :v_tool_procs > 0,
    'core_routing_functions', :v_core_fns,
    'tool_procedures', :v_tool_procs,
    'semantic_views', :v_sem_views,
    'catalog_use_cases', :v_catalog,
    'catalog_domains', :v_domains,
    'active_region', :v_active_reg,
    'active_vehicle_type', :v_active_veh,
    'gateway_service', :v_gateway,
    'regions', :v_regions
  );
END;
$$;

-- Shared READ across all three role-scoped bundles: knowledge is shared, ACTIONS
-- stay isolated (Tenet 3). Roles are pre-created at install step 0.5.
GRANT USAGE ON PROCEDURE FLEET_INTELLIGENCE.SEMANTIC.DESCRIBE_DEPLOYMENT() TO ROLE FLEET_APP_USER;
GRANT USAGE ON PROCEDURE FLEET_INTELLIGENCE.SEMANTIC.DESCRIBE_DEPLOYMENT() TO ROLE FLEET_APP_OPS;
GRANT USAGE ON PROCEDURE FLEET_INTELLIGENCE.SEMANTIC.DESCRIBE_DEPLOYMENT() TO ROLE FLEET_APP_ADMIN;
