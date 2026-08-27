-- =============================================================================
-- install-fleet-apps : self-provisioned SPCS infrastructure (FLEET-owned fallback)
-- =============================================================================
-- This file creates the SKILL-OWNED infra objects used when the equivalent
-- OPENROUTESERVICE_APP objects are ABSENT. The orchestrator (install_fleet_apps.sh)
-- probes first (SHOW ...) and runs this file ONLY when it must self-provision,
-- so a brand-new account with no pre-existing OPENROUTESERVICE_APP still works and
-- a shared account reuses the existing OPENROUTESERVICE_APP infra (no duplicates).
--
-- All statements are idempotent (CREATE ... IF NOT EXISTS / CREATE OR REPLACE on
-- network rule). Run as a role with CREATE COMPUTE POOL / IMAGE REPOSITORY /
-- INTEGRATION privileges (see SKILL.md ## Required Privileges).
-- =============================================================================

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","module":"infra"}}';

-- Owning database/schema (shared with the routing engine when present).
CREATE DATABASE IF NOT EXISTS FLEET_INTELLIGENCE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
ALTER DATABASE FLEET_INTELLIGENCE SET DATA_RETENTION_TIME_IN_DAYS = 0;
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.CORE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- 1. Image repository (push target for the two app images).
CREATE IMAGE REPOSITORY IF NOT EXISTS FLEET_INTELLIGENCE.CORE.IMAGE_REPOSITORY
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- 2. Service-spec stage (volume-mounted config + uploaded YAML specs).
CREATE STAGE IF NOT EXISTS FLEET_INTELLIGENCE.CORE.FLEET_SPEC_STAGE
  DIRECTORY = (ENABLE = TRUE)
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- 3. Basemap egress: CARTO tile CDN (mirrors OPENROUTESERVICE_APP.CORE.ORS_CARTO_*).
--    The apps render CARTO VECTOR basemaps (MapLibre GL JS + a keyless positron
--    style), fetched by the browser directly from the CDN - so maps need no
--    server-side egress today. Retained and repointed at the vector hosts so a
--    same-origin tile proxy can be reinstated without recreating the
--    integration, and because both app services pass this EAI on ALTER SERVICE.
CREATE OR REPLACE NETWORK RULE FLEET_INTELLIGENCE.CORE.FLEET_APP_CARTO_NETWORK_RULE
  TYPE = HOST_PORT  MODE = EGRESS
  VALUE_LIST = ('basemaps.cartocdn.com:443','tiles.basemaps.cartocdn.com:443','tiles-a.basemaps.cartocdn.com:443','tiles-b.basemaps.cartocdn.com:443','tiles-c.basemaps.cartocdn.com:443','tiles-d.basemaps.cartocdn.com:443')
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE EXTERNAL ACCESS INTEGRATION IF NOT EXISTS FLEET_APP_CARTO_EAI
  ALLOWED_NETWORK_RULES = (FLEET_INTELLIGENCE.CORE.FLEET_APP_CARTO_NETWORK_RULE)
  ENABLED = TRUE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- 3b. OSM catalog egress: Geofabrik + BBBike (mirrors OPENROUTESERVICE_APP.CORE.ORS_OSM_*).
--     The Admin app's Region Builder "Refresh Catalog" scrapes these two hosts
--     server-side (download.geofabrik.de / download.bbbike.org) to populate
--     REGION_CATALOG. Without this EAI attached, every scrape fetch is blocked
--     and the catalog silently stays empty. Mirrors the legacy control app,
--     which ran with BOTH the carto EAI and the geofabrik/bbbike EAI attached.
CREATE OR REPLACE NETWORK RULE FLEET_INTELLIGENCE.CORE.FLEET_APP_OSM_NETWORK_RULE
  TYPE = HOST_PORT  MODE = EGRESS
  VALUE_LIST = ('download.geofabrik.de:443','download.bbbike.org:443')
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE EXTERNAL ACCESS INTEGRATION IF NOT EXISTS FLEET_APP_OSM_EAI
  ALLOWED_NETWORK_RULES = (FLEET_INTELLIGENCE.CORE.FLEET_APP_OSM_NETWORK_RULE)
  ENABLED = TRUE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- 4. Compute pool for the two Next.js app services (light vs the ORS engine pool).
-- MAX_NODES = 4: hosts FLEET_ADMIN_APP + FLEET_SA_APP (1 node each at rest).
-- SPCS rolling upgrades spin up a replacement container before retiring the old
-- one, so a deploy transiently needs a free node per app being upgraded. Sizing
-- the pool at 4 lets either app roll without a manual MAX_NODES bump (the old
-- value of 2 left zero headroom and parked the new container as PENDING
-- "insufficient CPU" mid-deploy).
CREATE COMPUTE POOL IF NOT EXISTS FLEET_APPS_COMPUTE_POOL
  INSTANCE_FAMILY = CPU_X64_XS
  MIN_NODES = 1
  MAX_NODES = 4
  AUTO_RESUME = TRUE
  AUTO_SUSPEND_SECS = 3600;
-- Idempotent: bring an already-created pool up to the current MAX_NODES too,
-- since CREATE ... IF NOT EXISTS is a no-op on a pre-existing (smaller) pool.
ALTER COMPUTE POOL FLEET_APPS_COMPUTE_POOL SET MAX_NODES = 4;
ALTER COMPUTE POOL FLEET_APPS_COMPUTE_POOL SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"fleet-apps"}}';

SHOW COMPUTE POOLS LIKE 'FLEET_APPS_COMPUTE_POOL';
