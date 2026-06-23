-- =============================================================================
-- install-fleet-apps : agnostic seed-data prep + guard (FLEET-owned)
-- =============================================================================
-- The bulk synthetic data (SF / ebike preset -- a mode-AGNOSTIC dataset) is
-- loaded from parquet by the canonical, proven loader at repo-root
-- `datasets/load-seed-data.sql`. The orchestrator (install_fleet_apps.sh) runs
-- it ONLY when the probe finds no rows, after staging `datasets/*.parquet` to
-- the FLEET-owned seed stage created below (the loader's stage name is
-- sed-retargeted to this stage so no OPENROUTESERVICE_APP object is required).
--
-- This file:
--   1. ensures the shared analytic schemas exist (engine-independent),
--   2. creates the FLEET-owned seed stage + parquet file format,
--   3. PURGES industry-vertical synthetic data so only agnostic data persists
--      (Tenet: vehicle/industry-agnostic -- no freight/partner/marketplace rows).
--
-- Idempotent. Safe to run before OR after the canonical loader; the purge in
-- step 3 is the authoritative agnostic guard and is what the orchestrator runs
-- AFTER the loader.
-- =============================================================================

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","module":"seed"}}';

-- 0. Analytics warehouse. The canonical loader (datasets/load-seed-data.sql) and
--    the analytic layer both run `USE WAREHOUSE ROUTING_ANALYTICS`. On a truly
--    clean account this warehouse does not exist yet (the engine + analytic_layer
--    create it, but BOTH run AFTER this data step), so the loader would abort on
--    its very first statement and no UNIFIED tables (DIM_FLEET/FACT_TRIPS/...)
--    would load. Ensure it here so the data step is self-sufficient. Idempotent.
CREATE WAREHOUSE IF NOT EXISTS ROUTING_ANALYTICS
  WAREHOUSE_SIZE = 'XSMALL'
  AUTO_SUSPEND = 60
  AUTO_RESUME = TRUE
  INITIALLY_SUSPENDED = TRUE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- 1. Shared analytic schemas (also created by the routing engine when present).
CREATE DATABASE IF NOT EXISTS SYNTHETIC_DATASETS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
CREATE SCHEMA IF NOT EXISTS SYNTHETIC_DATASETS.UNIFIED
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
CREATE DATABASE IF NOT EXISTS FLEET_INTELLIGENCE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.CORE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- 1b. ROUTE_OPTIMIZATION base tables that the canonical loader populates.
--     The loader's PLACES/LOOKUP sections begin with `ALTER TABLE ... ADD COLUMN`
--     and `COPY INTO`, assuming these tables already exist (in the legacy world
--     the control-app boot / engine module 15 created them). On the agnostic path
--     the engine modules run AFTER the data step, so without this pre-creation the
--     loader aborts at the first ALTER (snow sql -f is stop-on-first-error) and
--     never reaches DIM_DATASETS / the V_*_CURRENT projection views, silently
--     breaking every demo. DDL mirrors engine module 15_route_optimization_seed.sql
--     (JOB_ID is added by the loader's own ALTER). All IF NOT EXISTS = idempotent
--     and a no-op once module 15 has run.
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES (
    REGION    VARCHAR,
    GEOMETRY  GEOGRAPHY,
    PHONES    VARCHAR,
    CATEGORY  VARCHAR,
    NAME      VARCHAR,
    ADDRESS   VARIANT,
    ALTERNATE VARIANT
)
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP (
    REGION       STRING,
    INDUSTRY     STRING,
    PA           STRING,
    PB           STRING,
    PC           STRING,
    IND          ARRAY,
    IND2         ARRAY,
    CTYPE        ARRAY,
    STYPE        ARRAY,
    SOURCE_TABLE STRING DEFAULT NULL,
    DEPOT_CTYPE  ARRAY  DEFAULT NULL,
    DEPOT_LABEL  STRING DEFAULT NULL
)
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- 2. FLEET-owned seed stage + parquet file format (retarget for the loader).
CREATE STAGE IF NOT EXISTS FLEET_INTELLIGENCE.CORE.SEED_DATA_STAGE
  DIRECTORY = (ENABLE = TRUE)
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
CREATE FILE FORMAT IF NOT EXISTS FLEET_INTELLIGENCE.CORE.PARQUET_FF
  TYPE = PARQUET
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- 3. AGNOSTIC GUARD: remove industry-vertical synthetic data. The canonical
--    loader also populates freight/partner tables (used only by the excluded
--    marketplace/backload/dhl packs). Dropping them keeps the data layer
--    vehicle/industry-agnostic with no orphaned vertical rows. The agnostic
--    packs (unified_fleet, fleet_ops, dwell, route_deviation, route_optimization,
--    catchment) never read these objects.
DROP TABLE  IF EXISTS SYNTHETIC_DATASETS.UNIFIED.FACT_FREIGHT_OFFERS;
DROP TABLE  IF EXISTS SYNTHETIC_DATASETS.UNIFIED.DIM_PARTNERS;
DROP TABLE  IF EXISTS SYNTHETIC_DATASETS.UNIFIED.FACT_PARTNER_HISTORY;
DROP SCHEMA IF EXISTS FLEET_INTELLIGENCE.MARKETPLACE;
DROP SCHEMA IF EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING;
DROP SCHEMA IF EXISTS FLEET_INTELLIGENCE.DHL_NTBO;

-- Verify agnostic core data is present (reuse signal for the orchestrator).
SELECT
  (SELECT COUNT(*) FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS)            AS datasets,
  (SELECT COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS)          AS trips,
  (SELECT COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY) AS telemetry;
