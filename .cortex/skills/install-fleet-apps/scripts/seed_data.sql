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
-- Accelerator data is synthetic / rebuildable: disable Time Travel (DB-level,
-- inherited) to avoid Time-Travel + Fail-safe storage cost. Co-located ALTER
-- because CREATE ... IF NOT EXISTS is a no-op on an existing DB.
ALTER DATABASE SYNTHETIC_DATASETS SET DATA_RETENTION_TIME_IN_DAYS = 0;
CREATE SCHEMA IF NOT EXISTS SYNTHETIC_DATASETS.UNIFIED
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
CREATE DATABASE IF NOT EXISTS FLEET_INTELLIGENCE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
ALTER DATABASE FLEET_INTELLIGENCE SET DATA_RETENTION_TIME_IN_DAYS = 0;
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.CORE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- 1a. OPENROUTESERVICE_APP.CORE engine namespace + REGION_CATALOG stub.
--     The canonical loader is engine-coupled: its FIRST table is
--     `CREATE OR REPLACE TABLE OPENROUTESERVICE_APP.CORE.INTRO_TRIPS` and it later
--     creates `CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.CORE.REGION_REGISTRY_V`
--     which LEFT JOINs `OPENROUTESERVICE_APP.CORE.REGION_CATALOG`. On the
--     agnostic path the engine (which owns OPENROUTESERVICE_APP) is built LATER
--     (step 3) or not at all, so without these the loader aborts (snow sql -f is
--     stop-on-first-error) BEFORE creating FLEET_INTELLIGENCE.CORE.DIM_DATASETS
--     (the active-dataset registry the V_*_CURRENT projection views + every pack
--     depend on). Pre-creating the engine DB + CORE schema + an EMPTY REGION_CATALOG
--     stub lets the loader compile those statements and run all the way through
--     DIM_DATASETS; it then aborts harmlessly at the engine-only LOAD_SEED_CATALOG
--     CALL (which comes AFTER DIM_DATASETS), and the orchestrator WARNs + continues.
--     DDL mirrors engine module 03_region_management.sql. Idempotent: the engine's
--     own `CREATE TABLE IF NOT EXISTS` + LOAD_SEED_CATALOG later reuse/populate it.
CREATE DATABASE IF NOT EXISTS OPENROUTESERVICE_APP
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
ALTER DATABASE OPENROUTESERVICE_APP SET DATA_RETENTION_TIME_IN_DAYS = 0;
CREATE SCHEMA IF NOT EXISTS OPENROUTESERVICE_APP.CORE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
CREATE TABLE IF NOT EXISTS OPENROUTESERVICE_APP.CORE.REGION_CATALOG (
    CATALOG_ID         VARCHAR NOT NULL,
    SOURCE             VARCHAR NOT NULL,
    REGION_NAME        VARCHAR NOT NULL,
    REGION_KEY         VARCHAR NOT NULL,
    LOOKUP_NAME        VARCHAR,
    HIERARCHY          VARCHAR,
    CONTINENT          VARCHAR,
    COUNTRY            VARCHAR,
    ISO_COUNTRY_A2     VARCHAR(2),
    ISO_COUNTRY_A3     VARCHAR(3),
    ISO_SUBDIVISION    VARCHAR,
    UN_M49             INT,
    PBF_URL            VARCHAR,
    PBF_SIZE_MB        FLOAT,
    LEVEL              VARCHAR NOT NULL,
    MIN_LAT            FLOAT,
    MAX_LAT            FLOAT,
    MIN_LON            FLOAT,
    MAX_LON            FLOAT,
    BOUNDARY           GEOGRAPHY,
    BOUNDARY_SOURCE    VARCHAR,
    BOUNDARY_VERTICES  INT,
    BOUNDARY_AREA_KM2  FLOAT,
    BOUNDARY_BAKED_AT  DATE,
    UPDATED_AT         TIMESTAMP_NTZ DEFAULT SYSDATE()
)
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

-- 3. AGNOSTIC GUARD: remove the remaining industry-vertical showcase schemas.
--    Offers (FACT_OFFERS / DIM_PARTNERS / FACT_PARTNER_HISTORY + the
--    MARKETPLACE projection views) are now VEHICLE-AGNOSTIC -- Data Studio
--    generates vehicle-appropriate offers for every fleet type -- so they
--    are RETAINED. Backload Matching is also vehicle-agnostic (neutral,
--    vendor-free) and its control tables are seeded by
--    scripts/analytic_layer.sql, so it is RETAINED. Only the retired
--    vendor-specific showcase schema is dropped.
--
--    DELIBERATE EXCEPTION to the repo-wide no-brand-names rule, and the ONE
--    entry in the check_no_brands.py allowlist: this statement is the only
--    thing that REMOVES the vendor-named schema from an account that still
--    carries one. Renaming or deleting the line would strand that schema in
--    place forever, so naming the brand here is what gets rid of the brand.
--    Do not "clean up" this identifier. It is load-bearing.
DROP SCHEMA IF EXISTS FLEET_INTELLIGENCE.DHL_NTBO;

-- Verify agnostic core data is present (reuse signal for the orchestrator).
-- Guarded: seed_data.sql runs twice - once BEFORE the loader (seedprep pass, when
-- these tables do not exist yet) and once after (purge pass). A bare SELECT COUNT(*)
-- on the pre-load pass fails with "object does not exist" and pollutes the log. Wrap
-- each count in its own handler so a missing table reports -1 instead of erroring.
EXECUTE IMMEDIATE $$
DECLARE
  n_datasets  INT DEFAULT -1;
  n_trips     INT DEFAULT -1;
  n_telemetry INT DEFAULT -1;
BEGIN
  BEGIN SELECT COUNT(*) INTO n_datasets  FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS;                   EXCEPTION WHEN OTHER THEN n_datasets  := -1; END;
  BEGIN SELECT COUNT(*) INTO n_trips     FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS;                  EXCEPTION WHEN OTHER THEN n_trips     := -1; END;
  BEGIN SELECT COUNT(*) INTO n_telemetry FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY;      EXCEPTION WHEN OTHER THEN n_telemetry := -1; END;
  RETURN 'datasets=' || n_datasets || ' trips=' || n_trips || ' telemetry=' || n_telemetry;
END;
$$;
