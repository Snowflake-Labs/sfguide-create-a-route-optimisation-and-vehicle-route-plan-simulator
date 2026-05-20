-- Data Studio and demo databases required by load-seed-data.sql and all demo skills.
-- Created here so module execution order is self-contained.
CREATE DATABASE IF NOT EXISTS SYNTHETIC_DATASETS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
CREATE SCHEMA IF NOT EXISTS SYNTHETIC_DATASETS.UNIFIED
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
CREATE DATABASE IF NOT EXISTS FLEET_INTELLIGENCE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.CORE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

   USE SCHEMA OPENROUTESERVICE_APP.CORE;   
   
   CREATE OR REPLACE NETWORK RULE OPENROUTESERVICE_APP.CORE.ORS_OSM_NETWORK_RULE
     TYPE = HOST_PORT  MODE = EGRESS
     VALUE_LIST = ('0.0.0.0:443','0.0.0.0:80','snowflakecomputing.com','download.bbbike.org:443','download.geofabrik.de:443')
     COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

   CREATE OR REPLACE NETWORK RULE OPENROUTESERVICE_APP.CORE.ORS_CARTO_NETWORK_RULE
     TYPE = HOST_PORT  MODE = EGRESS
     VALUE_LIST = ('a.basemaps.cartocdn.com:443','b.basemaps.cartocdn.com:443','c.basemaps.cartocdn.com:443','d.basemaps.cartocdn.com:443')
     COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

   CREATE OR REPLACE EXTERNAL ACCESS INTEGRATION ORS_OSM_EAI
     ALLOWED_NETWORK_RULES = (ORS_OSM_NETWORK_RULE)
     ENABLED = TRUE
     COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

   CREATE OR REPLACE EXTERNAL ACCESS INTEGRATION ORS_CARTO_EAI
     ALLOWED_NETWORK_RULES = (ORS_CARTO_NETWORK_RULE)
     ENABLED = TRUE
     COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE COMPUTE POOL IF NOT EXISTS OPENROUTESERVICE_APP_COMPUTE_POOL
   INSTANCE_FAMILY = HIGHMEM_X64_S
   MIN_NODES = 5
   MAX_NODES = 5
   AUTO_RESUME = true
   AUTO_SUSPEND_SECS = 600;
ALTER COMPUTE POOL OPENROUTESERVICE_APP_COMPUTE_POOL SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"OPENROUTESERVICE_APP.CORE"}}';

-- Verify compute pool is ACTIVE before creating services.
-- State must be ACTIVE; if STARTING wait ~2 minutes and re-run this module.
SHOW COMPUTE POOLS LIKE 'OPENROUTESERVICE_APP_COMPUTE_POOL';
SELECT
    "name",
    "state",
    CASE "state"
        WHEN 'ACTIVE' THEN 'Ready — proceeding to create services'
        ELSE 'WARNING: Pool state is ' || "state" || '. Wait for ACTIVE then re-run 01_core_infra.sql'
    END AS POOL_STATUS_CHECK
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
WHERE "name" = 'OPENROUTESERVICE_APP_COMPUTE_POOL';

-- ===========================================================================
-- v1.1.0 — Unified region model
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
   COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"core"}}';

CREATE SERVICE IF NOT EXISTS OPENROUTESERVICE_APP.CORE.routing_gateway_service
   IN COMPUTE POOL OPENROUTESERVICE_APP_COMPUTE_POOL
   FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/services/gateway
   SPECIFICATION_FILE = 'routing-gateway-service.yaml'
   MIN_INSTANCES = 3
   MAX_INSTANCES = 3
   AUTO_SUSPEND_SECS = 14400
   COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"OPENROUTESERVICE_APP.CORE"}}';

-- ors_control_app has public endpoints, which are incompatible with AUTO_SUSPEND_SECS.
-- It also requires QUERY_WAREHOUSE and EXTERNAL_ACCESS_INTEGRATIONS, which must appear
-- before the FROM SPECIFICATION clause.
CREATE SERVICE IF NOT EXISTS OPENROUTESERVICE_APP.CORE.ors_control_app
   IN COMPUTE POOL OPENROUTESERVICE_APP_COMPUTE_POOL
   FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/services/ors_control_app
   SPECIFICATION_FILE = 'ors_control_app_service.yaml'
   MIN_INSTANCES = 1
   MAX_INSTANCES = 1
   QUERY_WAREHOUSE = ROUTING_ANALYTICS
   EXTERNAL_ACCESS_INTEGRATIONS = (ORS_OSM_EAI, ORS_CARTO_EAI)
   COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"ui"}}';


