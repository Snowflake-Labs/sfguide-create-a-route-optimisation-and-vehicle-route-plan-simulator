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
--    The two apps proxy /api/tiles -> *.basemaps.cartocdn.com server-side; the
--    service must run with this EAI attached or basemaps render blank.
CREATE OR REPLACE NETWORK RULE FLEET_INTELLIGENCE.CORE.FLEET_APP_CARTO_NETWORK_RULE
  TYPE = HOST_PORT  MODE = EGRESS
  VALUE_LIST = ('a.basemaps.cartocdn.com:443','b.basemaps.cartocdn.com:443','c.basemaps.cartocdn.com:443','d.basemaps.cartocdn.com:443')
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
CREATE COMPUTE POOL IF NOT EXISTS FLEET_APPS_COMPUTE_POOL
  INSTANCE_FAMILY = CPU_X64_XS
  MIN_NODES = 1
  MAX_NODES = 2
  AUTO_RESUME = TRUE
  AUTO_SUSPEND_SECS = 3600;
ALTER COMPUTE POOL FLEET_APPS_COMPUTE_POOL SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"fleet-apps"}}';

SHOW COMPUTE POOLS LIKE 'FLEET_APPS_COMPUTE_POOL';
