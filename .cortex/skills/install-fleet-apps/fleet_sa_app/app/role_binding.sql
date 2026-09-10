-- Fleet Intelligence - production role binding (Phase 3E).
-- Source of truth for the account-role grants applied on the provider account
-- (wgb26798). Creates the three app roles and grants least-privilege access per
-- bundle. Run as ACCOUNTADMIN (or a role with MANAGE GRANTS + ownership).
--
-- Role model:
--   FLEET_APP_USER  -> consumer: dashboards + FLEET_AGENT + Cortex Analyst (the
--                      FLEET_INTELLIGENCE.SEMANTIC semantic views) + ROUTING_MCP
--                      verbs (OPENROUTESERVICE_APP.ROUTING)
--   FLEET_APP_OPS   -> operator: FLEET_OPS_AGENT + FLEET_OPS_MCP (service lifecycle / region / health)
--   FLEET_APP_ADMIN -> installer: FLEET_ADMIN_MCP (substrate checks / region) + FLEET_SUPER_AGENT
-- Hierarchy: ADMIN inherits OPS inherits USER.

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","module":"role-binding"}}';

CREATE ROLE IF NOT EXISTS FLEET_APP_USER  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
CREATE ROLE IF NOT EXISTS FLEET_APP_OPS   COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
CREATE ROLE IF NOT EXISTS FLEET_APP_ADMIN COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
GRANT ROLE FLEET_APP_USER TO ROLE FLEET_APP_OPS;
GRANT ROLE FLEET_APP_OPS  TO ROLE FLEET_APP_ADMIN;
GRANT ROLE FLEET_APP_USER TO ROLE SYSADMIN;
GRANT ROLE FLEET_APP_OPS  TO ROLE SYSADMIN;
GRANT ROLE FLEET_APP_ADMIN TO ROLE SYSADMIN;

-- Agent/Analyst calling requires CORTEX_USER.
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO ROLE FLEET_APP_USER;
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO ROLE FLEET_APP_OPS;

-- Compute + database/schema usage (consumer).
GRANT USAGE ON WAREHOUSE ROUTING_ANALYTICS TO ROLE FLEET_APP_USER;
GRANT USAGE ON DATABASE FLEET_INTELLIGENCE TO ROLE FLEET_APP_USER;
GRANT USAGE ON ALL SCHEMAS IN DATABASE FLEET_INTELLIGENCE TO ROLE FLEET_APP_USER;
GRANT USAGE ON DATABASE SYNTHETIC_DATASETS TO ROLE FLEET_APP_USER;
GRANT USAGE ON SCHEMA SYNTHETIC_DATASETS.UNIFIED TO ROLE FLEET_APP_USER;

-- Read access for Cortex Analyst (SV + underlying tables/views, incl. cross-DB fleet ops).
-- The SEMANTIC schema + the 5 SVs are created by semantic_views.sql in install
-- step 4.5 (BEFORE this role binding in step 6), so these grants resolve on a
-- fresh install. USAGE on the schema is also covered by the ALL SCHEMAS grant
-- above; FUTURE keeps a later-added SV grantable without re-running this file.
GRANT USAGE ON SCHEMA FLEET_INTELLIGENCE.SEMANTIC TO ROLE FLEET_APP_USER;
GRANT SELECT ON ALL SEMANTIC VIEWS IN SCHEMA FLEET_INTELLIGENCE.SEMANTIC TO ROLE FLEET_APP_USER;
GRANT SELECT ON FUTURE SEMANTIC VIEWS IN SCHEMA FLEET_INTELLIGENCE.SEMANTIC TO ROLE FLEET_APP_USER;
GRANT SELECT ON ALL TABLES IN SCHEMA FLEET_INTELLIGENCE.DWELL_ANALYSIS TO ROLE FLEET_APP_USER;
GRANT SELECT ON ALL VIEWS  IN SCHEMA FLEET_INTELLIGENCE.DWELL_ANALYSIS TO ROLE FLEET_APP_USER;
GRANT SELECT ON ALL TABLES IN SCHEMA FLEET_INTELLIGENCE.ROUTE_DEVIATION TO ROLE FLEET_APP_USER;
GRANT SELECT ON ALL VIEWS  IN SCHEMA FLEET_INTELLIGENCE.ROUTE_DEVIATION TO ROLE FLEET_APP_USER;
GRANT SELECT ON ALL TABLES IN SCHEMA FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION TO ROLE FLEET_APP_USER;
GRANT SELECT ON ALL VIEWS  IN SCHEMA FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION TO ROLE FLEET_APP_USER;
GRANT SELECT ON ALL TABLES IN SCHEMA FLEET_INTELLIGENCE.CATCHMENT TO ROLE FLEET_APP_USER;
GRANT SELECT ON ALL VIEWS  IN SCHEMA FLEET_INTELLIGENCE.CATCHMENT TO ROLE FLEET_APP_USER;
GRANT SELECT ON ALL VIEWS  IN SCHEMA SYNTHETIC_DATASETS.UNIFIED TO ROLE FLEET_APP_USER;
GRANT SELECT ON ALL TABLES IN SCHEMA SYNTHETIC_DATASETS.UNIFIED TO ROLE FLEET_APP_USER;

-- Overture Maps marketplace shares. The consumer's Cortex Analyst tool
-- (query_overture_global) reads the vendor Places semantic view
-- OVERTURE_MAPS__PLACES.CARTO.OVERTUREMAPS_PLACES_SEMANTIC_VIEW in the agent's
-- role context, so FLEET_APP_USER needs imported privileges on the share. The
-- deterministic Overture verbs (query_overture_places / query_overture_addresses)
-- run owner's-rights and do NOT depend on these grants. Best-effort: the shares
-- are only present when the analytic-layer catchment step acquired them.
GRANT IMPORTED PRIVILEGES ON DATABASE OVERTURE_MAPS__PLACES TO ROLE FLEET_APP_USER;
GRANT IMPORTED PRIVILEGES ON DATABASE OVERTURE_MAPS__ADDRESSES TO ROLE FLEET_APP_USER;
-- Buildings (depot centroids), Divisions (real boundaries), SafeGraph Open
-- Census (demographics). Acquired by the same analytic-layer step, so present
-- by the time role binding runs (same ordering guarantee as the two above).
GRANT IMPORTED PRIVILEGES ON DATABASE OVERTURE_MAPS__BUILDINGS TO ROLE FLEET_APP_USER;
GRANT IMPORTED PRIVILEGES ON DATABASE OVERTURE_MAPS__DIVISIONS TO ROLE FLEET_APP_USER;
GRANT IMPORTED PRIVILEGES ON DATABASE SAFEGRAPH_OPEN_CENSUS_FREE TO ROLE FLEET_APP_USER;

-- Consumer agent + routing MCP + routing verbs (Step 4B: relocated to the
-- Routing Platform schema OPENROUTESERVICE_APP.ROUTING; ROUTING_MCP replaces the
-- retired FLEET_USER_MCP).
GRANT USAGE ON AGENT FLEET_INTELLIGENCE.SYNAPSE_USER.FLEET_AGENT TO ROLE FLEET_APP_USER;
GRANT USAGE ON DATABASE OPENROUTESERVICE_APP TO ROLE FLEET_APP_USER;
GRANT USAGE ON SCHEMA OPENROUTESERVICE_APP.ROUTING TO ROLE FLEET_APP_USER;
GRANT USAGE ON MCP SERVER OPENROUTESERVICE_APP.ROUTING.ROUTING_MCP TO ROLE FLEET_APP_USER;
GRANT USAGE ON ALL PROCEDURES IN SCHEMA OPENROUTESERVICE_APP.ROUTING TO ROLE FLEET_APP_USER;

-- Engine-agnostic Routing Platform (Step 4B.2). Consumers depend on
-- ROUTING_PLATFORM.CONTRACT.*; OPENROUTESERVICE_APP is the ORS provider impl.
-- The TOOL_* procs (EXECUTE AS OWNER) route through CONTRACT, so the consumer
-- role does not strictly need CONTRACT execute, but we grant it for direct/
-- least-privilege use and expose the neutral region inventory view.
-- Full DDL source of truth: .cortex/skills/install-fleet-apps/routing_platform/setup.sql
GRANT USAGE ON DATABASE ROUTING_PLATFORM TO ROLE FLEET_APP_USER;
GRANT USAGE ON SCHEMA ROUTING_PLATFORM.CONTRACT TO ROLE FLEET_APP_USER;
GRANT USAGE ON ALL FUNCTIONS IN SCHEMA ROUTING_PLATFORM.CONTRACT TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUTURE FUNCTIONS IN SCHEMA ROUTING_PLATFORM.CONTRACT TO ROLE FLEET_APP_USER;
GRANT USAGE ON SCHEMA ROUTING_PLATFORM.ADMIN TO ROLE FLEET_APP_USER;
GRANT SELECT ON VIEW ROUTING_PLATFORM.ADMIN.V_REGIONS TO ROLE FLEET_APP_USER;
-- Ops/Admin: provider registry visibility + region->provider steering.
GRANT USAGE ON SCHEMA ROUTING_PLATFORM.PROVIDERS TO ROLE FLEET_APP_OPS;
GRANT SELECT ON ALL TABLES IN SCHEMA ROUTING_PLATFORM.PROVIDERS TO ROLE FLEET_APP_OPS;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ROUTING_PLATFORM.ADMIN TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON PROCEDURE ROUTING_PLATFORM.ADMIN.SET_REGION_PROVIDER(VARCHAR, VARCHAR) TO ROLE FLEET_APP_OPS;

-- Data-contract app layer (FLEET_APP): neutral logical views that all dashboards
-- and semantic views bind to (per-domain packs under fleet_sa_app/app/packs/fleet/*).
-- Database-level + FUTURE grants so new packs are covered without re-granting.
-- DDL source of truth: each pack's generated setup.sql (packs/_lib/generate.py).
GRANT USAGE ON DATABASE FLEET_APP TO ROLE FLEET_APP_USER;
GRANT USAGE ON DATABASE FLEET_APP TO ROLE FLEET_APP_OPS;
GRANT USAGE ON DATABASE FLEET_APP TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON ALL SCHEMAS IN DATABASE FLEET_APP TO ROLE FLEET_APP_USER;
GRANT USAGE ON FUTURE SCHEMAS IN DATABASE FLEET_APP TO ROLE FLEET_APP_USER;
GRANT SELECT ON ALL VIEWS IN DATABASE FLEET_APP TO ROLE FLEET_APP_USER;
GRANT SELECT ON FUTURE VIEWS IN DATABASE FLEET_APP TO ROLE FLEET_APP_USER;
GRANT SELECT ON ALL DYNAMIC TABLES IN DATABASE FLEET_APP TO ROLE FLEET_APP_USER;
GRANT SELECT ON FUTURE DYNAMIC TABLES IN DATABASE FLEET_APP TO ROLE FLEET_APP_USER;

-- ---------------------------------------------------------------------------
-- Dynamic-page reader (agent-emitted view specs). This is the AUTHORITATIVE
-- data boundary for prompt-generated pages: the /api/query route runs any
-- query flagged `dynamic:true` under this role via the SQL API `role` override,
-- so an agent-authored SELECT can ONLY touch the neutral FLEET_APP contract.
-- It is a capability role (NOT an AppRole UI tier) and is intentionally NOT in
-- the USER<-OPS<-ADMIN hierarchy. Granted to SYSADMIN so the ACCOUNTADMIN-run
-- SPCS service can activate it as the per-statement role.
--   * USAGE on the contract UDTFs (owner's-rights SQL UDTFs -> the inner call
--     into SYNTHETIC_DATASETS runs as the function owner, so this role needs NO
--     grants on SYNTHETIC_DATASETS / OPENROUTESERVICE_APP / base tables).
--   * SELECT on the plain contract views (DWELL / CATCHMENT / ROUTE_OPTIMIZATION).
--   * CORTEX_USER for SNOWFLAKE.CORTEX.COMPLETE (asset-velocity rationale).
-- FUTURE grants so regenerated packs stay readable without re-granting (Tenet 8).
CREATE ROLE IF NOT EXISTS FLEET_APP_DYNAMIC_READER
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-render-view","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
GRANT ROLE FLEET_APP_DYNAMIC_READER TO ROLE SYSADMIN;
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO ROLE FLEET_APP_DYNAMIC_READER;
GRANT USAGE ON WAREHOUSE ROUTING_ANALYTICS TO ROLE FLEET_APP_DYNAMIC_READER;
GRANT USAGE ON DATABASE FLEET_APP TO ROLE FLEET_APP_DYNAMIC_READER;
GRANT USAGE ON SCHEMA FLEET_APP.CORE              TO ROLE FLEET_APP_DYNAMIC_READER;
GRANT USAGE ON SCHEMA FLEET_APP.FLEET_OPS         TO ROLE FLEET_APP_DYNAMIC_READER;
GRANT USAGE ON SCHEMA FLEET_APP.UNIFIED_FLEET     TO ROLE FLEET_APP_DYNAMIC_READER;
GRANT USAGE ON SCHEMA FLEET_APP.DWELL             TO ROLE FLEET_APP_DYNAMIC_READER;
GRANT USAGE ON SCHEMA FLEET_APP.CATCHMENT         TO ROLE FLEET_APP_DYNAMIC_READER;
GRANT USAGE ON SCHEMA FLEET_APP.ROUTE_OPTIMIZATION TO ROLE FLEET_APP_DYNAMIC_READER;
-- LABOR: paid hours / overtime contract. Needed here, not just in labor_layer.sql,
-- because that file grants FLEET_APP_USER/OPS/ADMIN while agent-emitted
-- (dynamic:true) queries execute through FLEET_APP.CORE.QUERY_DYNAMIC as THIS
-- role. Without it a dynamic labour query fails with "Unknown user-defined table
-- function FLEET_APP.LABOR.F_FACT_LABOR_WEEK_SCOPED" - which reads as a broken
-- agent rather than a missing grant, and is invisible to validate_app_views.py
-- because that runs as the operator's own role.
GRANT USAGE ON SCHEMA FLEET_APP.LABOR             TO ROLE FLEET_APP_DYNAMIC_READER;
-- Contract UDTFs (owner's-rights): USAGE is sufficient, no underlying-source grants.
GRANT USAGE  ON ALL FUNCTIONS    IN SCHEMA FLEET_APP.CORE          TO ROLE FLEET_APP_DYNAMIC_READER;
GRANT USAGE  ON FUTURE FUNCTIONS IN SCHEMA FLEET_APP.CORE          TO ROLE FLEET_APP_DYNAMIC_READER;
GRANT USAGE  ON ALL FUNCTIONS    IN SCHEMA FLEET_APP.FLEET_OPS     TO ROLE FLEET_APP_DYNAMIC_READER;
GRANT USAGE  ON FUTURE FUNCTIONS IN SCHEMA FLEET_APP.FLEET_OPS     TO ROLE FLEET_APP_DYNAMIC_READER;
GRANT USAGE  ON ALL FUNCTIONS    IN SCHEMA FLEET_APP.UNIFIED_FLEET TO ROLE FLEET_APP_DYNAMIC_READER;
GRANT USAGE  ON FUTURE FUNCTIONS IN SCHEMA FLEET_APP.UNIFIED_FLEET TO ROLE FLEET_APP_DYNAMIC_READER;
GRANT USAGE  ON ALL FUNCTIONS    IN SCHEMA FLEET_APP.LABOR         TO ROLE FLEET_APP_DYNAMIC_READER;
GRANT USAGE  ON FUTURE FUNCTIONS IN SCHEMA FLEET_APP.LABOR         TO ROLE FLEET_APP_DYNAMIC_READER;
-- Plain contract views (CORE exposes some views too; DWELL/CATCHMENT/ROUTE_OPTIMIZATION are view-only).
GRANT SELECT ON ALL VIEWS    IN SCHEMA FLEET_APP.CORE              TO ROLE FLEET_APP_DYNAMIC_READER;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA FLEET_APP.CORE              TO ROLE FLEET_APP_DYNAMIC_READER;
GRANT SELECT ON ALL VIEWS    IN SCHEMA FLEET_APP.FLEET_OPS         TO ROLE FLEET_APP_DYNAMIC_READER;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA FLEET_APP.FLEET_OPS         TO ROLE FLEET_APP_DYNAMIC_READER;
GRANT SELECT ON ALL VIEWS    IN SCHEMA FLEET_APP.DWELL             TO ROLE FLEET_APP_DYNAMIC_READER;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA FLEET_APP.DWELL             TO ROLE FLEET_APP_DYNAMIC_READER;
GRANT SELECT ON ALL VIEWS    IN SCHEMA FLEET_APP.CATCHMENT         TO ROLE FLEET_APP_DYNAMIC_READER;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA FLEET_APP.CATCHMENT         TO ROLE FLEET_APP_DYNAMIC_READER;
GRANT SELECT ON ALL VIEWS    IN SCHEMA FLEET_APP.ROUTE_OPTIMIZATION TO ROLE FLEET_APP_DYNAMIC_READER;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA FLEET_APP.ROUTE_OPTIMIZATION TO ROLE FLEET_APP_DYNAMIC_READER;
GRANT SELECT ON ALL DYNAMIC TABLES    IN SCHEMA FLEET_APP.ROUTE_OPTIMIZATION TO ROLE FLEET_APP_DYNAMIC_READER;
GRANT SELECT ON FUTURE DYNAMIC TABLES IN SCHEMA FLEET_APP.ROUTE_OPTIMIZATION TO ROLE FLEET_APP_DYNAMIC_READER;
GRANT SELECT ON ALL VIEWS    IN SCHEMA FLEET_APP.LABOR             TO ROLE FLEET_APP_DYNAMIC_READER;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA FLEET_APP.LABOR             TO ROLE FLEET_APP_DYNAMIC_READER;
-- LABOR_CONFIG is a policy TABLE (thresholds, week start, gap), not a view, and a
-- dynamic query asking "what is the overtime limit" reads it directly.
GRANT SELECT ON ALL TABLES    IN SCHEMA FLEET_APP.LABOR             TO ROLE FLEET_APP_DYNAMIC_READER;
GRANT SELECT ON FUTURE TABLES IN SCHEMA FLEET_APP.LABOR             TO ROLE FLEET_APP_DYNAMIC_READER;

-- Owner's-rights execution boundary for agent-emitted (dynamic:true) queries.
-- The SQL API `role` override does NOT disable the caller's secondary roles, so a
-- role override alone does not isolate. This proc, owned by FLEET_APP_DYNAMIC_READER
-- and EXECUTE AS OWNER, runs with ONLY the reader role (no caller secondary roles
-- leak in), so an agent SELECT can reach only the FLEET_APP contract - verified:
-- a SYNTHETIC_DATASETS reference fails even when called by ACCOUNTADMIN.
-- Co-located here (not scoped_contract.sql) so re-applying the contract alone can't
-- silently revert ownership to the installer. Requires FLEET_APP.CORE to exist
-- (installed by scoped_contract.sql before this file is applied).
CREATE OR REPLACE PROCEDURE FLEET_APP.CORE.QUERY_DYNAMIC(P_SQL STRING)
RETURNS TABLE()
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-render-view","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
  rs RESULTSET;
  up STRING := TRIM(UPPER(:P_SQL));
  not_select EXCEPTION (-20001, 'Only SELECT/WITH queries are allowed in QUERY_DYNAMIC');
BEGIN
  IF (NOT (up LIKE 'SELECT%' OR up LIKE 'WITH%')) THEN
    RAISE not_select;
  END IF;
  rs := (EXECUTE IMMEDIATE :P_SQL);
  RETURN TABLE(rs);
END;
$$;
GRANT OWNERSHIP ON PROCEDURE FLEET_APP.CORE.QUERY_DYNAMIC(VARCHAR) TO ROLE FLEET_APP_DYNAMIC_READER COPY CURRENT GRANTS;
GRANT USAGE ON PROCEDURE FLEET_APP.CORE.QUERY_DYNAMIC(VARCHAR) TO ROLE ACCOUNTADMIN;
GRANT USAGE ON PROCEDURE FLEET_APP.CORE.QUERY_DYNAMIC(VARCHAR) TO ROLE FLEET_APP_USER;

-- Ops bundle (role-gated; NOT on the consumer agent). The agents are created in
-- SYNAPSE_USER by create_agents.sh, so the USAGE grant must target that schema
-- (a prior grant pointed at SYNAPSE_OPS.FLEET_OPS_AGENT, which does not exist, so
-- FLEET_APP_OPS could not actually reach its agent).
GRANT USAGE ON SCHEMA FLEET_INTELLIGENCE.SYNAPSE_OPS TO ROLE FLEET_APP_OPS;
GRANT USAGE ON AGENT FLEET_INTELLIGENCE.SYNAPSE_USER.FLEET_OPS_AGENT TO ROLE FLEET_APP_OPS;
GRANT USAGE ON MCP SERVER FLEET_INTELLIGENCE.SYNAPSE_OPS.FLEET_OPS_MCP TO ROLE FLEET_APP_OPS;
GRANT USAGE ON ALL PROCEDURES IN SCHEMA FLEET_INTELLIGENCE.SYNAPSE_OPS TO ROLE FLEET_APP_OPS;

-- Deployment-history semantic view (SV_FLEET_DEPLOYMENT, semantic_views_deployment.sql).
-- Backs the ops/admin agents' query_deployment Cortex Analyst tool: routing-call
-- volume / error rate / latency per region, build outcomes and durations, and the
-- audited verb attempts. HISTORY only - live run-state stays behind the ops verbs
-- and DESCRIBE_DEPLOYMENT, so this widens the READ surface, not the action surface.
--
-- It lives in its own schema (SEMANTIC_OPS) precisely so these grants can stop at
-- FLEET_APP_OPS: FLEET_INTELLIGENCE.SEMANTIC has ALL + FUTURE semantic views granted
-- to FLEET_APP_USER, so a view landed there would reach every consumer by default.
-- Do NOT grant SEMANTIC_OPS to FLEET_APP_USER.
--
-- Cortex Analyst runs as the CALLER, so base-table SELECT on the ORS control-app
-- telemetry is required, not optional - without it the tool compiles and then
-- fails at query time, which reads to a user as the agent being broken.
GRANT USAGE ON SCHEMA FLEET_INTELLIGENCE.SEMANTIC_OPS TO ROLE FLEET_APP_OPS;
GRANT SELECT ON ALL VIEWS IN SCHEMA FLEET_INTELLIGENCE.SEMANTIC_OPS TO ROLE FLEET_APP_OPS;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA FLEET_INTELLIGENCE.SEMANTIC_OPS TO ROLE FLEET_APP_OPS;
GRANT SELECT ON ALL SEMANTIC VIEWS IN SCHEMA FLEET_INTELLIGENCE.SEMANTIC_OPS TO ROLE FLEET_APP_OPS;
GRANT SELECT ON FUTURE SEMANTIC VIEWS IN SCHEMA FLEET_INTELLIGENCE.SEMANTIC_OPS TO ROLE FLEET_APP_OPS;
-- ---------------------------------------------------------------------------
-- Engine (OPENROUTESERVICE_APP) reads for the ops role - INDIVIDUALLY GUARDED.
-- ---------------------------------------------------------------------------
-- A `--no-engine` install never runs scripts/provision_engine.sh, so most of the
-- objects below do not exist when this file runs at install step 8. What DOES
-- exist on such an account: the database + CORE schema + CORE.REGION_CATALOG
-- (scripts/seed_data.sql), the OBSERVABILITY schema + ORS_REQUEST_LOG (admin app
-- boot, step 7), and the ROUTING schema + VERB_ATTEMPT (synapse bundles install
-- inert). Absent: the whole TRAVEL_MATRIX schema (provision_engine.sh) plus
-- REGION_ORS_MAP / REGION_PROVISION_JOBS / PBF_MIRRORS /
-- V_DOWNLOAD_RELAUNCH_PENDING / _CANDIDATES / MATRIX_BUILD_JOBS (engine modules
-- 03/05/06, loaded only by provision_engine.sh).
--
-- `snow sql -f` ABORTS on the first failing statement (measured: exit 1, later
-- statements never execute). Left bare, the TRAVEL_MATRIX grant below therefore
-- truncated the rest of this file on every `--no-engine` install, silently
-- dropping ~25 grants including FLEET_SA_APP!ALL_ENDPOINTS_USAGE (app users
-- could not open the app URL at all) and the FLEET_SUPER_AGENT grant that IS the
-- Tenet 3 isolation boundary. Step 8 reported only a soft WARN.
--
-- ONE grant per block, deliberately: a shared block would raise on the first
-- missing object, the handler would swallow it, and every later grant in that
-- block would be skipped - the same bug, just relocated (see the same warning
-- on the idempotent ALTERs in openrouteservice_app/app/modules/
-- 03_region_management.sql). The handler RETURNs the reason rather than NULL so a
-- `--no-engine` install leaves evidence in /tmp/ifa_roles.log of exactly which
-- grants were skipped; a bare `WHEN OTHER THEN NULL` has hidden two real defects
-- in this repo before.
--
-- Guarding is scoped to THIS block. The FLEET_INTELLIGENCE, agent, MCP-server and
-- service-role grants below stay bare on purpose: their objects exist in every
-- install mode, so a failure there is a real defect and must abort loudly.
EXECUTE IMMEDIATE $$
BEGIN
  GRANT USAGE ON SCHEMA OPENROUTESERVICE_APP.CORE TO ROLE FLEET_APP_OPS;
  RETURN 'ok';
EXCEPTION WHEN OTHER THEN
  RETURN 'SKIPPED (engine object absent): USAGE ON SCHEMA CORE -> ' || SQLERRM;
END;
$$;
EXECUTE IMMEDIATE $$
BEGIN
  GRANT USAGE ON SCHEMA OPENROUTESERVICE_APP.OBSERVABILITY TO ROLE FLEET_APP_OPS;
  RETURN 'ok';
EXCEPTION WHEN OTHER THEN
  RETURN 'SKIPPED (engine object absent): USAGE ON SCHEMA OBSERVABILITY -> ' || SQLERRM;
END;
$$;
EXECUTE IMMEDIATE $$
BEGIN
  GRANT USAGE ON SCHEMA OPENROUTESERVICE_APP.TRAVEL_MATRIX TO ROLE FLEET_APP_OPS;
  RETURN 'ok';
EXCEPTION WHEN OTHER THEN
  RETURN 'SKIPPED (engine object absent): USAGE ON SCHEMA TRAVEL_MATRIX -> ' || SQLERRM;
END;
$$;
EXECUTE IMMEDIATE $$
BEGIN
  GRANT SELECT ON TABLE OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP TO ROLE FLEET_APP_OPS;
  RETURN 'ok';
EXCEPTION WHEN OTHER THEN
  RETURN 'SKIPPED (engine object absent): CORE.REGION_ORS_MAP -> ' || SQLERRM;
END;
$$;
EXECUTE IMMEDIATE $$
BEGIN
  GRANT SELECT ON TABLE OPENROUTESERVICE_APP.CORE.REGION_CATALOG TO ROLE FLEET_APP_OPS;
  RETURN 'ok';
EXCEPTION WHEN OTHER THEN
  RETURN 'SKIPPED (engine object absent): CORE.REGION_CATALOG -> ' || SQLERRM;
END;
$$;
EXECUTE IMMEDIATE $$
BEGIN
  GRANT SELECT ON TABLE OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS TO ROLE FLEET_APP_OPS;
  RETURN 'ok';
EXCEPTION WHEN OTHER THEN
  RETURN 'SKIPPED (engine object absent): CORE.REGION_PROVISION_JOBS -> ' || SQLERRM;
END;
$$;
-- PBF download failover config + the reconciler's relaunch queue. Needed for the
-- ops agent's run_sql verb: without them "which mirror is configured" or "is a
-- build waiting to be relaunched" fails with `does not exist or not authorized`,
-- which reads to a user as a MISSING FEATURE rather than a missing grant. Kept
-- per-object like the lines above rather than a blanket ALL/FUTURE on
-- OPENROUTESERVICE_APP.CORE, which would hand the ops role every engine table.
EXECUTE IMMEDIATE $$
BEGIN
  GRANT SELECT ON TABLE OPENROUTESERVICE_APP.CORE.PBF_MIRRORS TO ROLE FLEET_APP_OPS;
  RETURN 'ok';
EXCEPTION WHEN OTHER THEN
  RETURN 'SKIPPED (engine object absent): CORE.PBF_MIRRORS -> ' || SQLERRM;
END;
$$;
EXECUTE IMMEDIATE $$
BEGIN
  GRANT SELECT ON VIEW OPENROUTESERVICE_APP.CORE.V_DOWNLOAD_RELAUNCH_PENDING TO ROLE FLEET_APP_OPS;
  RETURN 'ok';
EXCEPTION WHEN OTHER THEN
  RETURN 'SKIPPED (engine object absent): CORE.V_DOWNLOAD_RELAUNCH_PENDING -> ' || SQLERRM;
END;
$$;
EXECUTE IMMEDIATE $$
BEGIN
  GRANT SELECT ON VIEW OPENROUTESERVICE_APP.CORE.V_DOWNLOAD_RELAUNCH_CANDIDATES TO ROLE FLEET_APP_OPS;
  RETURN 'ok';
EXCEPTION WHEN OTHER THEN
  RETURN 'SKIPPED (engine object absent): CORE.V_DOWNLOAD_RELAUNCH_CANDIDATES -> ' || SQLERRM;
END;
$$;
EXECUTE IMMEDIATE $$
BEGIN
  GRANT SELECT ON TABLE OPENROUTESERVICE_APP.OBSERVABILITY.ORS_REQUEST_LOG TO ROLE FLEET_APP_OPS;
  RETURN 'ok';
EXCEPTION WHEN OTHER THEN
  RETURN 'SKIPPED (engine object absent): OBSERVABILITY.ORS_REQUEST_LOG -> ' || SQLERRM;
END;
$$;
EXECUTE IMMEDIATE $$
BEGIN
  GRANT SELECT ON TABLE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS TO ROLE FLEET_APP_OPS;
  RETURN 'ok';
EXCEPTION WHEN OTHER THEN
  RETURN 'SKIPPED (engine object absent): TRAVEL_MATRIX.MATRIX_BUILD_JOBS -> ' || SQLERRM;
END;
$$;
EXECUTE IMMEDIATE $$
BEGIN
  GRANT SELECT ON TABLE OPENROUTESERVICE_APP.ROUTING.VERB_ATTEMPT TO ROLE FLEET_APP_OPS;
  RETURN 'ok';
EXCEPTION WHEN OTHER THEN
  RETURN 'SKIPPED (engine object absent): ROUTING.VERB_ATTEMPT -> ' || SQLERRM;
END;
$$;

-- Admin bundle. FLEET_ADMIN_AGENT (created in SYNAPSE_USER) attaches the admin
-- MCP, making the previously-dormant FLEET_ADMIN_MCP reachable by an agent.
GRANT USAGE ON SCHEMA FLEET_INTELLIGENCE.SYNAPSE_ADMIN TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON AGENT FLEET_INTELLIGENCE.SYNAPSE_USER.FLEET_ADMIN_AGENT TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON MCP SERVER FLEET_INTELLIGENCE.SYNAPSE_ADMIN.FLEET_ADMIN_MCP TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON ALL PROCEDURES IN SCHEMA FLEET_INTELLIGENCE.SYNAPSE_ADMIN TO ROLE FLEET_APP_ADMIN;

-- FLEET_SUPER_AGENT: the one agent that attaches ALL THREE MCP servers.
--
-- THIS GRANT IS THE TENET 3 BOUNDARY. The super agent's SPEC deliberately has no
-- role isolation - that is the point of it - so isolation is enforced here, by
-- granting it to FLEET_APP_ADMIN ONLY. Do NOT add FLEET_APP_USER (or PUBLIC): the
-- role hierarchy is ADMIN inherits OPS inherits USER, so an admin already holds
-- every MCP server the agent attaches, whereas granting it to FLEET_APP_USER
-- would hand every app user the ability to suspend services and delete regions
-- through the agent, with nothing else in the stack stopping them.
--
-- It exists because a Cowork / Snowflake Intelligence user cannot hand off between
-- agents mid-conversation, so an operator working there needs one assistant that
-- can both answer analytics questions and operate the platform.
GRANT USAGE ON AGENT FLEET_INTELLIGENCE.SYNAPSE_USER.FLEET_SUPER_AGENT TO ROLE FLEET_APP_ADMIN;

-- The super agent's Cortex Analyst tools run as the caller, so the admin role
-- needs the semantic views directly rather than only by inheritance (inheritance
-- covers it today, but an explicit grant keeps the agent working if the hierarchy
-- is ever flattened). FUTURE covers semantic views added later, including SV_OFFERS
-- when the marketplace layer is installed after this file runs.
GRANT USAGE ON SCHEMA FLEET_INTELLIGENCE.SEMANTIC TO ROLE FLEET_APP_ADMIN;
GRANT SELECT ON ALL SEMANTIC VIEWS IN SCHEMA FLEET_INTELLIGENCE.SEMANTIC TO ROLE FLEET_APP_ADMIN;
GRANT SELECT ON FUTURE SEMANTIC VIEWS IN SCHEMA FLEET_INTELLIGENCE.SEMANTIC TO ROLE FLEET_APP_ADMIN;
-- Same reasoning for the ops-only deployment-history view the super agent also
-- attaches (query_deployment). ADMIN inherits OPS today, so this is belt-and-braces.
GRANT USAGE ON SCHEMA FLEET_INTELLIGENCE.SEMANTIC_OPS TO ROLE FLEET_APP_ADMIN;
GRANT SELECT ON ALL VIEWS IN SCHEMA FLEET_INTELLIGENCE.SEMANTIC_OPS TO ROLE FLEET_APP_ADMIN;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA FLEET_INTELLIGENCE.SEMANTIC_OPS TO ROLE FLEET_APP_ADMIN;
GRANT SELECT ON ALL SEMANTIC VIEWS IN SCHEMA FLEET_INTELLIGENCE.SEMANTIC_OPS TO ROLE FLEET_APP_ADMIN;
GRANT SELECT ON FUTURE SEMANTIC VIEWS IN SCHEMA FLEET_INTELLIGENCE.SEMANTIC_OPS TO ROLE FLEET_APP_ADMIN;
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO ROLE FLEET_APP_ADMIN;

-- SPCS endpoint access: only these roles can open the app URL.
GRANT SERVICE ROLE FLEET_INTELLIGENCE.SYNAPSE_USER.FLEET_SA_APP!ALL_ENDPOINTS_USAGE TO ROLE FLEET_APP_USER;

-- Optional: bind to real users, e.g.
--   GRANT ROLE FLEET_APP_USER TO USER <consumer_user>;
--   GRANT ROLE FLEET_APP_OPS  TO USER <operator_user>;
