-- Data Studio and demo databases required by load-seed-data.sql and all demo skills.
-- Created here so module execution order is self-contained.
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","module":"01_core_infra"}}';
CREATE DATABASE IF NOT EXISTS SYNTHETIC_DATASETS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
-- Accelerator data is synthetic / rebuildable, so Time Travel is unnecessary
-- storage+fail-safe cost. Set DB-level retention to 0 (inherited by all
-- schemas/tables/stages). ALTER is co-located (not an inline CREATE clause)
-- because CREATE DATABASE IF NOT EXISTS is a no-op when the DB already exists.
ALTER DATABASE SYNTHETIC_DATASETS SET DATA_RETENTION_TIME_IN_DAYS = 0;
CREATE SCHEMA IF NOT EXISTS SYNTHETIC_DATASETS.UNIFIED
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
CREATE DATABASE IF NOT EXISTS FLEET_INTELLIGENCE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
ALTER DATABASE FLEET_INTELLIGENCE SET DATA_RETENTION_TIME_IN_DAYS = 0;
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.CORE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

   USE SCHEMA OPENROUTESERVICE_APP.CORE;   
   
   CREATE OR REPLACE NETWORK RULE OPENROUTESERVICE_APP.CORE.ORS_OSM_NETWORK_RULE
     TYPE = HOST_PORT  MODE = EGRESS
     VALUE_LIST = ('0.0.0.0:443','0.0.0.0:80','snowflakecomputing.com','download.bbbike.org:443','download.geofabrik.de:443')
     COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

   CREATE OR REPLACE NETWORK RULE OPENROUTESERVICE_APP.CORE.ORS_CARTO_NETWORK_RULE
     TYPE = HOST_PORT  MODE = EGRESS
     VALUE_LIST = ('a.basemaps.cartocdn.com:443','b.basemaps.cartocdn.com:443','c.basemaps.cartocdn.com:443','d.basemaps.cartocdn.com:443')
     COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

   CREATE OR REPLACE EXTERNAL ACCESS INTEGRATION ORS_OSM_EAI
     ALLOWED_NETWORK_RULES = (ORS_OSM_NETWORK_RULE)
     ENABLED = TRUE
     COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

   CREATE OR REPLACE EXTERNAL ACCESS INTEGRATION ORS_CARTO_EAI
     ALLOWED_NETWORK_RULES = (ORS_CARTO_NETWORK_RULE)
     ENABLED = TRUE
     COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE COMPUTE POOL IF NOT EXISTS OPENROUTESERVICE_APP_COMPUTE_POOL
   INSTANCE_FAMILY = HIGHMEM_X64_S
   MIN_NODES = 1
   MAX_NODES = 5
   AUTO_RESUME = true
   AUTO_SUSPEND_SECS = 600;
-- Cost: MIN_NODES=1 (was 5) so an idle pool holds a single highmem node and
-- suspends 600s after its services stop; it auto-scales up to MAX_NODES=5 to
-- fit the gateway (up to 3 instances) + downloader under load. Existing
-- deployments are converged by the boot ALTER in the admin app's
-- instrumentation.ts.
ALTER COMPUTE POOL OPENROUTESERVICE_APP_COMPUTE_POOL SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"install-fleet-apps","version":"1.0","attributes":{"component":"OPENROUTESERVICE_APP.CORE"}}';

-- Verify compute pool state. Services queue automatically if pool is STARTING.
-- No re-run needed; the pool reaches ACTIVE within ~2 minutes and services start.
SHOW COMPUTE POOLS LIKE 'OPENROUTESERVICE_APP_COMPUTE_POOL';
SELECT
    "name",
    "state",
    CASE "state"
        WHEN 'ACTIVE' THEN 'Ready - proceeding to create services'
        WHEN 'IDLE' THEN 'Ready (idle) - proceeding to create services'
        ELSE 'INFO: Pool state is ' || "state" || '. Services will queue and start automatically once ACTIVE (no re-run needed).'
    END AS POOL_STATUS_CHECK
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
WHERE "name" = 'OPENROUTESERVICE_APP_COMPUTE_POOL';

-- ===========================================================================
-- v1.1.0 - Unified region model
--
-- The legacy global services ORS_SERVICE and VROOM_SERVICE have been removed.
-- After this module finishes, the install flow continues with module
-- 03_region_management.sql (which defines PROVISION_REGION_WRAPPER) and is
-- followed by a one-shot bootstrap call:
--
--   CALL OPENROUTESERVICE_APP.CORE.PROVISION_REGION_WRAPPER(
--     UUID_STRING(), 'SanFrancisco', 'San Francisco',
--     'https://download.geofabrik.de/north-america/us/california/norcal-latest.osm.pbf',
--     37.4, 38.0, -123.2, -122.0,
--     'driving-car,driving-hgv,cycling-regular,foot-walking',
--     'S', FALSE
--   );
--
-- This creates ORS_POOL_SANFRANCISCO + ORS_SERVICE_SANFRANCISCO +
-- VROOM_SERVICE_SANFRANCISCO using the same code path as every other region.
-- The gateway (v1.1.0+) resolves missing region to DEFAULT_REGION_NAME
-- (SanFrancisco), so callers that omit region also land on this service.
-- ===========================================================================

CREATE SERVICE IF NOT EXISTS OPENROUTESERVICE_APP.CORE.downloader
   IN COMPUTE POOL OPENROUTESERVICE_APP_COMPUTE_POOL
   FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/services/downloader
   SPECIFICATION_FILE = 'downloader_spec.yaml'
   AUTO_SUSPEND_SECS = 14400
   EXTERNAL_ACCESS_INTEGRATIONS = (ORS_OSM_EAI)
   COMMENT = '{"origin":"sf_sit-is-fleet","name":"install-fleet-apps","version":"1.0","attributes":{"component":"core"}}';

-- Gateway receives DIRECT app/agent HTTP calls, so its auto-suspend idle timer
-- reflects real usage (unlike city/ORS services, which only see gateway-routed
-- traffic and therefore stay at 14400 - see snowflake-scripting-guidelines.md).
-- A 1h idle window here lets the shared core pool collapse ~3h sooner after the
-- last request. During builds RECONCILE_AUTO_SUSPEND pins the gateway to 0, so
-- this never suspends mid-build. MIN_INSTANCES=1 (was 3) with MAX_INSTANCES=3
-- keeps one warm instance idle and scales up under load.
CREATE SERVICE IF NOT EXISTS OPENROUTESERVICE_APP.CORE.routing_gateway_service
   IN COMPUTE POOL OPENROUTESERVICE_APP_COMPUTE_POOL
   FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/services/gateway
   SPECIFICATION_FILE = 'routing-gateway-service.yaml'
   MIN_INSTANCES = 1
   MAX_INSTANCES = 3
   AUTO_SUSPEND_SECS = 3600
   COMMENT = '{"origin":"sf_sit-is-fleet","name":"install-fleet-apps","version":"1.0","attributes":{"component":"OPENROUTESERVICE_APP.CORE"}}';

-- NOTE (Phase C): the legacy Vite `ors_control_app` UI service is NOT created here.
-- install-fleet-apps ships the control surface as FLEET_SA_APP + FLEET_ADMIN_APP
-- (deployed in orchestrator layer 8) and never stages `ors_control_app_service.yaml`,
-- so creating it here would fail-fast every fresh engine build. The engine modules
-- own only the routing substrate (ORS/VROOM/gateway/downloader); the app layer is
-- provisioned separately by deploy_fleet_sa_app.sh / deploy_fleet_admin_app.sh.

-- =============================================================================
-- VERSION_INFO
-- Component -> version registry surfaced by the control-app /api/health endpoint.
-- Pre-existing installs polled this table inside an empty try/catch which spammed
-- 002003 SQL compilation errors into QUERY_HISTORY because the table was never
-- created. Seed values mirror image-versions.env at install time; the
-- control-app deploy procedure (or a follow-up MERGE) refreshes them when the
-- image tags advance.
-- =============================================================================
CREATE TABLE IF NOT EXISTS OPENROUTESERVICE_APP.CORE.VERSION_INFO (
    COMPONENT VARCHAR NOT NULL,
    VERSION   VARCHAR NOT NULL,
    UPDATED_AT TIMESTAMP_LTZ DEFAULT SYSDATE(),
    CONSTRAINT PK_VERSION_INFO PRIMARY KEY (COMPONENT)
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

MERGE INTO OPENROUTESERVICE_APP.CORE.VERSION_INFO t USING (
    SELECT 'openrouteservice'      AS COMPONENT, 'v9.0.0'  AS VERSION UNION ALL
    SELECT 'downloader'             AS COMPONENT, 'v0.0.4'  AS VERSION UNION ALL
    SELECT 'routing_reverse_proxy'  AS COMPONENT, 'v1.1.2'  AS VERSION UNION ALL
    SELECT 'vroom_docker'           AS COMPONENT, 'v1.0.4'  AS VERSION
) s ON t.COMPONENT = s.COMPONENT
WHEN NOT MATCHED THEN INSERT (COMPONENT, VERSION) VALUES (s.COMPONENT, s.VERSION)
WHEN MATCHED AND t.VERSION <> s.VERSION THEN UPDATE SET t.VERSION = s.VERSION, t.UPDATED_AT = SYSDATE();

-- =============================================================================
-- VEHICLE_THRESHOLDS (#33) -- RETIRED
-- Per-vehicle-type SLA / geofence / deviation thresholds are now sourced from the
-- single catalog FLEET_INTELLIGENCE.CORE.DIM_VEHICLE_PROFILE (+ DIM_VEHICLE_DWELL_SLA),
-- created by scripts/vehicle_profile_catalog.sql and read by the route_deviation /
-- dwell packs and analytic_layer.sql via DEVIATION_DISTANCE_RATIO and per-(vehicle,
-- location) dwell SLA. This legacy table had a single remaining consumer, the retired
-- legacy control app dwell/LiveOperations.tsx, so its DDL + seed are removed here
-- to keep one source of truth. Existing accounts may still carry an orphaned table;
-- it is unreferenced and safe to drop manually.
-- =============================================================================


