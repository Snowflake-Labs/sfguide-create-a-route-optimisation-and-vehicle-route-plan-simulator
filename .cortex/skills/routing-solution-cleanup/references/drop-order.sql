-- ============================================================================
-- FULL TEARDOWN SCRIPT - Drops all objects created by the fleet/routing skills
-- ============================================================================
-- Usage: snow sql -f .cortex/skills/routing-solution-cleanup/references/drop-order.sql -c <connection>
--
-- WARNING: This script is DESTRUCTIVE. It drops ALL databases, schemas, tables,
-- warehouses, compute pools, integrations, roles, and other objects created by
-- install-fleet-apps (and the legacy demo skills). The only surviving objects
-- will be: SNOWFLAKE (system), USER$<username> (personal), MY_WH (personal),
-- SYSTEM_* pools, and any objects from UNRELATED projects.
--
-- The drop order follows reverse-dependency: most-dependent objects first.
-- Every statement is IF EXISTS and abort-safe: DROP handles suspend/stop
-- implicitly, so no ALTER ... SUSPEND precedes a DROP (an ALTER on an
-- already-suspended warehouse/task raises 090064 "Invalid state" and, under
-- `snow sql -f`, ABORTS the whole file -- stranding every later drop).
-- ============================================================================

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-routing-solution-cleanup","version":{"major":2,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- ============================================================================
-- PHASE 1: Stop services on fleet/ORS compute pools (so pools + DBs drop clean)
--          STOP ALL on a pool with no services is a no-op, never an error.
-- ============================================================================
ALTER COMPUTE POOL IF EXISTS FLEET_APPS_COMPUTE_POOL STOP ALL;
ALTER COMPUTE POOL IF EXISTS OPENROUTESERVICE_APP_COMPUTE_POOL STOP ALL;
ALTER COMPUTE POOL IF EXISTS ORS_POOL_SANFRANCISCO STOP ALL;
ALTER COMPUTE POOL IF EXISTS ORS_POOL_EUROPE STOP ALL;

-- ============================================================================
-- PHASE 2: Project + engine databases
--   CASCADE removes contained SPCS services, agents, MCP servers, schemas,
--   tables, views, stages, procedures, tasks, dynamic tables, notebooks, etc.
--   (This subsumes the old per-object PHASES for agents/tasks/DTs/procs/views.)
-- ============================================================================
DROP DATABASE IF EXISTS FLEET_APP CASCADE;
DROP DATABASE IF EXISTS FLEET_INTELLIGENCE CASCADE;
DROP DATABASE IF EXISTS SYNTHETIC_DATASETS CASCADE;
DROP DATABASE IF EXISTS ROUTING_PLATFORM CASCADE;
DROP DATABASE IF EXISTS STARTER_APP CASCADE;
DROP DATABASE IF EXISTS OPENROUTESERVICE_APP CASCADE;
-- Legacy native-app / setup databases (pre-relocation installs):
DROP DATABASE IF EXISTS OPENROUTESERVICE_SETUP CASCADE;

-- ============================================================================
-- PHASE 3: SAP mock landscape (landed by install-fleet-apps step 2.6)
-- ============================================================================
DROP DATABASE IF EXISTS MOCK_SAP CASCADE;
DROP DATABASE IF EXISTS MOCK_TELEMATICS CASCADE;

-- ============================================================================
-- PHASE 4: Marketplace listing databases (installer re-acquires FROM LISTING).
--          DROP DATABASE detaches the listing automatically.
-- ============================================================================
DROP DATABASE IF EXISTS OVERTURE_MAPS__PLACES;
DROP DATABASE IF EXISTS OVERTURE_MAPS__ADDRESSES;
DROP DATABASE IF EXISTS OVERTURE_MAPS__TRANSPORTATION;
DROP DATABASE IF EXISTS OVERTURE_MAPS__BUILDINGS;
DROP DATABASE IF EXISTS OVERTURE_MAPS__DIVISIONS;
DROP DATABASE IF EXISTS SAFEGRAPH_OPEN_CENSUS_FREE;

-- ============================================================================
-- PHASE 5: Compute pools (fleet/ORS only; leave unrelated project pools)
-- ============================================================================
DROP COMPUTE POOL IF EXISTS FLEET_APPS_COMPUTE_POOL;
DROP COMPUTE POOL IF EXISTS OPENROUTESERVICE_APP_COMPUTE_POOL;
DROP COMPUTE POOL IF EXISTS ORS_POOL_SANFRANCISCO;
DROP COMPUTE POOL IF EXISTS ORS_POOL_EUROPE;
-- Legacy native-app pool:
DROP COMPUTE POOL IF EXISTS OPENROUTESERVICE_NATIVE_APP_COMPUTE_POOL;

-- ============================================================================
-- PHASE 6: Warehouse (DROP does not require a prior SUSPEND; see header note)
-- ============================================================================
DROP WAREHOUSE IF EXISTS ROUTING_ANALYTICS;

-- ============================================================================
-- PHASE 7: External access integrations (ORS/FLEET only)
-- ============================================================================
DROP INTEGRATION IF EXISTS FLEET_APP_CARTO_EAI;
DROP INTEGRATION IF EXISTS FLEET_APP_OSM_EAI;
DROP INTEGRATION IF EXISTS ORS_CARTO_EAI;
DROP INTEGRATION IF EXISTS ORS_OSM_EAI;
-- Legacy native-app EAIs (pre-relocation installs):
DROP INTEGRATION IF EXISTS OPENROUTESERVICE_NATIVE_APP_EXTERNAL_ACCESS_INTEGRATION_REF_EXTERNAL_ACCESS;
DROP INTEGRATION IF EXISTS OPENROUTESERVICE_NATIVE_APP_EXTERNAL_ACCESS_CARTO_REF_EXTERNAL_ACCESS;

-- ============================================================================
-- PHASE 8: Roles
-- ============================================================================
DROP ROLE IF EXISTS FLEET_APP_ADMIN;
DROP ROLE IF EXISTS FLEET_APP_OPS;
DROP ROLE IF EXISTS FLEET_APP_USER;
DROP ROLE IF EXISTS FLEET_APP_DYNAMIC_READER;
