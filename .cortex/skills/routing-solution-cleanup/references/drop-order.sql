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
--
--          The per-region pools are enumerated, NOT listed. A hardcoded list is
--          silently wrong the moment anyone provisions a region that is not on
--          it: an account carrying Brazil/Colombia/Mexico/UnitedStatesOfAmerica
--          alongside SanFrancisco/Europe kept four HIGHMEM_X64_M pools running
--          after a "full" teardown, because only two were named here. Filtering
--          with STARTSWITH rather than LIKE avoids `_` being a LIKE wildcard.
-- ============================================================================
ALTER COMPUTE POOL IF EXISTS FLEET_APPS_COMPUTE_POOL STOP ALL;
ALTER COMPUTE POOL IF EXISTS OPENROUTESERVICE_APP_COMPUTE_POOL STOP ALL;

BEGIN
  SHOW COMPUTE POOLS;
  LET rs RESULTSET := (
    SELECT "name" AS n
    FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
    WHERE STARTSWITH("name", 'ORS_POOL_')
  );
  LET c CURSOR FOR rs;
  FOR r IN c DO
    EXECUTE IMMEDIATE 'ALTER COMPUTE POOL IF EXISTS "' || r.n || '" STOP ALL';
  END FOR;
  RETURN 'stopped services on all ORS_POOL_* pools';
END;

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
--          Per-region pools are enumerated - see the PHASE 1 note.
-- ============================================================================
DROP COMPUTE POOL IF EXISTS FLEET_APPS_COMPUTE_POOL;
DROP COMPUTE POOL IF EXISTS OPENROUTESERVICE_APP_COMPUTE_POOL;

BEGIN
  SHOW COMPUTE POOLS;
  LET rs RESULTSET := (
    SELECT "name" AS n
    FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
    WHERE STARTSWITH("name", 'ORS_POOL_')
  );
  LET c CURSOR FOR rs;
  FOR r IN c DO
    EXECUTE IMMEDIATE 'DROP COMPUTE POOL IF EXISTS "' || r.n || '"';
  END FOR;
  RETURN 'dropped all ORS_POOL_* pools';
END;

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
-- Geocoding egress EAI (added by a later engine module than CARTO/OSM, so it
-- was missing from this list and survived every teardown):
DROP INTEGRATION IF EXISTS ORS_GEOCODE_EAI;
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
