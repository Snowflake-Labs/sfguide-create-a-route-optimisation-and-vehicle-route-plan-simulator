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
--
-- For the same reason, any Snowflake Scripting block here MUST be wrapped in
-- `EXECUTE IMMEDIATE $$ ... $$;`. The CLI splits the file on semicolons, so a
-- bare `BEGIN ... END;` is cut at its first internal `;`, fails to compile, and
-- aborts the file just like the 090064 case above.
-- ============================================================================

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-routing-solution-cleanup","version":{"major":2,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- ============================================================================
-- OPTIONAL: PRESERVE THE ROUTING ENGINE (fast re-test of the analytics stack)
--
-- Default is FALSE: a full teardown, exactly as before. When TRUE, this script
-- leaves the ORS/VROOM engine completely intact -- the OPENROUTESERVICE_APP
-- database (images, routing graphs, SQL modules, services), the ORS compute
-- pools, and the ORS external access integrations -- and wipes everything else.
-- A reinstall then detects the engine and skips provisioning it, which removes
-- the four image pushes (measured 29m40s), the stage upload, the module load and
-- the graph build from the cycle: roughly 45 min of a ~93 min install.
--
-- READ THIS BEFORE USING IT: the engine is then NOT re-tested. A from-scratch
-- install exists partly to catch a stale image or a broken engine module, and
-- this mode deliberately cannot. Use it to iterate on the analytics stack, and
-- never for a release check or for validating an engine change.
--
-- How to enable (one session; `snow sql -f` cannot see a SET from a separate -q):
--   printf 'SET KEEP_FLEET_ENGINE = TRUE;\n' | cat - drop-order.sql \
--     | snow sql -i -c <connection>
--
-- GETVARIABLE is used rather than a bare `$KEEP_FLEET_ENGINE` because reading an
-- unset session variable fails at COMPILE time, which no EXCEPTION handler can
-- catch -- so the obvious `BEGIN keep := (SELECT $VAR); EXCEPTION ...` idiom
-- cannot provide a default. GETVARIABLE returns NULL when unset, so COALESCE can.
-- ============================================================================

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

-- The ORS pool stops are engine-scoped: skipped when the engine is preserved,
-- because stopping its services is precisely what we are trying to avoid.
EXECUTE IMMEDIATE $$
BEGIN
  LET keep BOOLEAN := (SELECT COALESCE(GETVARIABLE('KEEP_FLEET_ENGINE')::BOOLEAN, FALSE));
  IF (keep) THEN
    RETURN 'KEEP_FLEET_ENGINE=TRUE: left ORS pools running (engine preserved)';
  END IF;
  EXECUTE IMMEDIATE 'ALTER COMPUTE POOL IF EXISTS OPENROUTESERVICE_APP_COMPUTE_POOL STOP ALL';
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
$$;

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

-- The engine database itself. This is the one drop KEEP_FLEET_ENGINE exists for:
-- the image repository lives at OPENROUTESERVICE_APP.CORE.IMAGE_REPOSITORY, so a
-- CASCADE here is what forces every reinstall to re-push four identical,
-- version-pinned images (cycle 2 re-pushed the exact digest cycle 1 had pushed).
EXECUTE IMMEDIATE $$
BEGIN
  LET keep BOOLEAN := (SELECT COALESCE(GETVARIABLE('KEEP_FLEET_ENGINE')::BOOLEAN, FALSE));
  IF (keep) THEN
    RETURN 'KEEP_FLEET_ENGINE=TRUE: PRESERVED OPENROUTESERVICE_APP (images, graphs, services)';
  END IF;
  EXECUTE IMMEDIATE 'DROP DATABASE IF EXISTS OPENROUTESERVICE_APP CASCADE';
  RETURN 'dropped OPENROUTESERVICE_APP';
END;
$$;
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
--          The ORS pools are engine-scoped: preserved with the engine, because a
--          preserved service on a dropped pool is not a preserved service.
-- ============================================================================
DROP COMPUTE POOL IF EXISTS FLEET_APPS_COMPUTE_POOL;

EXECUTE IMMEDIATE $$
BEGIN
  LET keep BOOLEAN := (SELECT COALESCE(GETVARIABLE('KEEP_FLEET_ENGINE')::BOOLEAN, FALSE));
  IF (keep) THEN
    RETURN 'KEEP_FLEET_ENGINE=TRUE: PRESERVED ORS compute pools';
  END IF;
  EXECUTE IMMEDIATE 'DROP COMPUTE POOL IF EXISTS OPENROUTESERVICE_APP_COMPUTE_POOL';
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
$$;

-- Legacy native-app pool:
DROP COMPUTE POOL IF EXISTS OPENROUTESERVICE_NATIVE_APP_COMPUTE_POOL;

-- ============================================================================
-- PHASE 6: Warehouses (DROP does not require a prior SUSPEND; see header note)
--          `scripts/warehouses.sql` is the single creator and it makes TWO:
--          ROUTING_ANALYTICS (batch) and FLEET_APPS_WH (interactive app reads).
--          FLEET_APPS_WH was added by the warehouse split and never added here,
--          so it survived every "full" teardown and a reinstall then inherited a
--          pre-existing warehouse instead of creating it -- which is exactly the
--          drift `check_warehouse_ddl.py` exists to prevent, only invisible
--          because CREATE ... IF NOT EXISTS silently keeps the old parameters.
-- ============================================================================
DROP WAREHOUSE IF EXISTS ROUTING_ANALYTICS;
DROP WAREHOUSE IF EXISTS FLEET_APPS_WH;

-- ============================================================================
-- PHASE 7: External access integrations (ORS/FLEET only)
--          The ORS_* EAIs are engine-scoped. A preserved ORS service still
--          references them, and dropping an EAI out from under a running service
--          breaks its egress (map/tile/geocode downloads) without dropping the
--          service, so the failure surfaces later as a routing error rather than
--          as a missing object. Hence they follow the engine flag too.
-- ============================================================================
DROP INTEGRATION IF EXISTS FLEET_APP_CARTO_EAI;
DROP INTEGRATION IF EXISTS FLEET_APP_OSM_EAI;

EXECUTE IMMEDIATE $$
BEGIN
  LET keep BOOLEAN := (SELECT COALESCE(GETVARIABLE('KEEP_FLEET_ENGINE')::BOOLEAN, FALSE));
  IF (keep) THEN
    RETURN 'KEEP_FLEET_ENGINE=TRUE: PRESERVED ORS_CARTO_EAI / ORS_OSM_EAI / ORS_GEOCODE_EAI';
  END IF;
  EXECUTE IMMEDIATE 'DROP INTEGRATION IF EXISTS ORS_CARTO_EAI';
  EXECUTE IMMEDIATE 'DROP INTEGRATION IF EXISTS ORS_OSM_EAI';
  -- Geocoding egress EAI (added by a later engine module than CARTO/OSM, so it
  -- was missing from this list and survived every teardown):
  EXECUTE IMMEDIATE 'DROP INTEGRATION IF EXISTS ORS_GEOCODE_EAI';
  RETURN 'dropped ORS EAIs';
END;
$$;
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
