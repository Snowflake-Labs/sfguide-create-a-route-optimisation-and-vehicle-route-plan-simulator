-- =============================================================================
-- 01_core_infra.sql
-- Creates databases, schemas, network rules, EAIs, compute pools, and services.
-- Run AFTER: 00_marketplace_datasets.sql
--
-- IMPORTANT — Image Tag Source of Truth:
--   openrouteservice_app/image-versions.env defines all image tags.
--   Service spec YAMLs (workspace root) must match these tags.
--   If CREATE SERVICE fails with "Image not found", run:
--     SHOW IMAGES IN IMAGE REPOSITORY OPENROUTESERVICE_APP.CORE.IMAGE_REPOSITORY;
--   Then update the spec YAML to match the available tag.
--
-- IMPORTANT — Compute Pool Specs:
--   OPENROUTESERVICE_APP_COMPUTE_POOL: HIGHMEM_X64_S, 5 nodes (ORS needs 20GB heap)
--   ORS_CONTROL_APP_COMPUTE_POOL: CPU_X64_XS, 1 node (lightweight React app)
--   These are the TESTED configurations. Do not reduce without verifying ORS starts.
--
-- IMPORTANT — Session Context:
--   This file uses fully-qualified names (no USE DATABASE/SCHEMA) so it works
--   in workspace environments where context doesn't persist between calls.
--   Exception: the initial USE SCHEMA is for service creation (relative stage refs).
-- =============================================================================

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

   -- NOTE: USE SCHEMA required here because CREATE SERVICE uses relative stage refs
   -- (e.g. FROM @ORS_SPCS_STAGE/... resolves against current schema context).
   -- All other statements use fully-qualified names.
   USE SCHEMA OPENROUTESERVICE_APP.CORE;

   -- File formats required by ORS Control App (agent-demos.json loading) and seed data
   CREATE FILE FORMAT IF NOT EXISTS OPENROUTESERVICE_APP.CORE.JSON_FORMAT
     TYPE = JSON
     COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

   CREATE FILE FORMAT IF NOT EXISTS OPENROUTESERVICE_APP.CORE.PARQUET_FF
     TYPE = PARQUET
     COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

   -- Pre-flight: verify ors_control_app image exists with expected tag
   -- If this fails, update ors_control_app_service.yaml to match available tag.
   -- SELECT * FROM (SHOW IMAGES IN IMAGE REPOSITORY OPENROUTESERVICE_APP.CORE.IMAGE_REPOSITORY)
   -- WHERE "image_name" = 'ors_control_app';

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

CREATE COMPUTE POOL IF NOT EXISTS ORS_CONTROL_APP_COMPUTE_POOL
   INSTANCE_FAMILY = CPU_X64_XS
   MIN_NODES = 1
   MAX_NODES = 1
   AUTO_RESUME = true;
ALTER COMPUTE POOL ORS_CONTROL_APP_COMPUTE_POOL SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"OPENROUTESERVICE_APP.CORE.ORS_CONTROL_APP"}}';

-- Verify compute pool is ACTIVE before creating services.
-- State must be ACTIVE; if STARTING wait ~2 minutes and re-run this module.
SHOW COMPUTE POOLS LIKE '%OPENROUTESERVICE_APP%' OR LIKE '%ORS_CONTROL_APP%';
SELECT
    "name",
    "state",
    CASE "state"
        WHEN 'ACTIVE' THEN 'Ready — proceeding to create services'
        ELSE 'WARNING: Pool state is ' || "state" || '. Wait for ACTIVE then re-run 01_core_infra.sql'
    END AS POOL_STATUS_CHECK
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
WHERE "name" IN ('OPENROUTESERVICE_APP_COMPUTE_POOL', 'ORS_CONTROL_APP_COMPUTE_POOL');

CREATE SERVICE IF NOT EXISTS OPENROUTESERVICE_APP.CORE.ors_service
   IN COMPUTE POOL OPENROUTESERVICE_APP_COMPUTE_POOL
   FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/services/openrouteservice
   SPECIFICATION_FILE = 'openrouteservice.yaml'
   MIN_INSTANCES = 3
   MAX_INSTANCES = 3
   AUTO_SUSPEND_SECS = 14400
   COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"OPENROUTESERVICE_APP.CORE"}}';

CREATE SERVICE IF NOT EXISTS OPENROUTESERVICE_APP.CORE.downloader
   IN COMPUTE POOL OPENROUTESERVICE_APP_COMPUTE_POOL
   FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/services/downloader
   SPECIFICATION_FILE = 'downloader_spec.yaml'
   AUTO_SUSPEND_SECS = 14400
   EXTERNAL_ACCESS_INTEGRATIONS = (ORS_OSM_EAI)
   COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"core"}}';

CREATE SERVICE IF NOT EXISTS OPENROUTESERVICE_APP.CORE.vroom_service
   IN COMPUTE POOL OPENROUTESERVICE_APP_COMPUTE_POOL
   FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/services/vroom
   SPECIFICATION_FILE = 'vroom-service.yaml'
   MIN_INSTANCES = 1
   MAX_INSTANCES = 1
   AUTO_SUSPEND_SECS = 14400
   COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"OPENROUTESERVICE_APP.CORE"}}';

CREATE SERVICE IF NOT EXISTS OPENROUTESERVICE_APP.CORE.routing_gateway_service
   IN COMPUTE POOL OPENROUTESERVICE_APP_COMPUTE_POOL
   FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/services/gateway
   SPECIFICATION_FILE = 'routing-gateway-service.yaml'
   MIN_INSTANCES = 3
   MAX_INSTANCES = 3
   AUTO_SUSPEND_SECS = 14400
   COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"OPENROUTESERVICE_APP.CORE"}}';

-- ors_control_app has public endpoints, which are incompatible with AUTO_SUSPEND_SECS.
-- It runs on its own smaller pool (CPU_X64_XS) since it must stay running and doesn't
-- need the high-memory instances required by the ORS routing engine.
CREATE SERVICE IF NOT EXISTS OPENROUTESERVICE_APP.CORE.ors_control_app
   IN COMPUTE POOL ORS_CONTROL_APP_COMPUTE_POOL
   FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/services/ors_control_app
   SPECIFICATION_FILE = 'ors_control_app_service.yaml'
   MIN_INSTANCES = 1
   MAX_INSTANCES = 1
   QUERY_WAREHOUSE = ROUTING_ANALYTICS
   EXTERNAL_ACCESS_INTEGRATIONS = (ORS_OSM_EAI, ORS_CARTO_EAI)
   COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"ui"}}';


