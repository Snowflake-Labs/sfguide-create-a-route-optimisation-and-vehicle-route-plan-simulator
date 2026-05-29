-- =============================================================================
-- deploy-all.sql
-- MASTER ORCHESTRATOR: Deploys the full fleet intelligence stack from zero.
--
-- Execution method (workspace):
--   1. Upload this file + all referenced files to stage
--   2. EXECUTE IMMEDIATE FROM @stage/deploy-all.sql
--
-- OR execute each EXECUTE IMMEDIATE FROM line individually via snowflake_sql_execute.
--
-- IMPORTANT: This file references skill seed-data.sql files as the SINGLE SOURCE
-- OF TRUTH. Do NOT maintain separate module copies. If a skill's SQL changes,
-- it automatically takes effect on next deploy-all run.
--
-- Prerequisites:
--   - OPENROUTESERVICE_APP database exists with images pushed
--   - All workspace files uploaded to @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/deploy/
--   - ORS map files (SanFrancisco.osm.pbf, ors-config.yml) already on stage
--
-- Upload command (run once before deploying):
--   COPY FILES INTO @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/deploy/
--   FROM 'snow://workspace/USER$.PUBLIC."sfguide-build-fleet-intelligence-with-cortex-code"/versions/live/'
--   PATTERN='.*\\.sql';
-- =============================================================================

-- ╔══════════════════════════════════════════════════════════════════════════════╗
-- ║ PHASE 0: WAREHOUSE SETUP                                                    ║
-- ║ Create a LARGE warehouse for heavy geospatial operations (Overture Maps).  ║
-- ║ ROUTING_ANALYTICS (XS) is for day-to-day queries after deployment.         ║
-- ╚══════════════════════════════════════════════════════════════════════════════╝

CREATE WAREHOUSE IF NOT EXISTS ROUTING_DEPLOY
    WAREHOUSE_SIZE = 'LARGE'
    AUTO_SUSPEND = 120
    AUTO_RESUME = TRUE
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE WAREHOUSE IF NOT EXISTS ROUTING_ANALYTICS
    WAREHOUSE_SIZE = 'XSMALL'
    AUTO_SUSPEND = 60
    AUTO_RESUME = TRUE
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

USE WAREHOUSE ROUTING_DEPLOY;

-- Set schema context required by modules that create EAIs and services.
-- EXECUTE IMMEDIATE FROM inherits the caller's session context; some DDL (EAI, service)
-- requires schema to be set BEFORE the module runs even though modules use USE SCHEMA internally.
USE SCHEMA OPENROUTESERVICE_APP.CORE;

-- ╔══════════════════════════════════════════════════════════════════════════════╗
-- ║ PHASE 1: CORE INFRASTRUCTURE (build-routing-solution modules 00-06)        ║
-- ║ Owner: .cortex/skills/build-routing-solution/                              ║
-- ╚══════════════════════════════════════════════════════════════════════════════╝

-- CRITICAL: Remove any ors-config.yml files that landed in deploy/ during bulk upload.
-- The control app scans for *ors-config* and uses the parent folder as a region name.
-- Only @stage/SanFrancisco/ors-config.yml should exist; stray copies create phantom regions.
REMOVE @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/deploy/ors-config.yml;
REMOVE @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/deploy/.cortex/skills/build-routing-solution/openrouteservice_app/staged_files/ors-config.yml;

-- Step 0: Install Overture Maps Marketplace datasets (Places, Addresses, Buildings)
EXECUTE IMMEDIATE FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/deploy/.cortex/skills/build-routing-solution/openrouteservice_app/app/modules/00_marketplace_datasets.sql;

-- Step 1: Databases, schemas, network rules, EAIs, compute pools, services
EXECUTE IMMEDIATE FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/deploy/.cortex/skills/build-routing-solution/openrouteservice_app/app/modules/01_core_infra.sql;

-- Step 2: ORS routing functions (DIRECTIONS, ISOCHRONES, OPTIMIZATION, MATRIX)
EXECUTE IMMEDIATE FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/deploy/.cortex/skills/build-routing-solution/openrouteservice_app/app/modules/02_routing_functions.sql;

-- Step 3: Multi-region management (SETUP_REGION_ORS, DROP_REGION_ORS, LIST_REGIONS)
EXECUTE IMMEDIATE FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/deploy/.cortex/skills/build-routing-solution/openrouteservice_app/app/modules/03_region_management.sql;

-- Step 4: Service lifecycle (GET_STATUS, RESUME_ALL, SUSPEND_ALL, SCALE)
EXECUTE IMMEDIATE FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/deploy/.cortex/skills/build-routing-solution/openrouteservice_app/app/modules/04_service_lifecycle.sql;

-- Step 5: Travel time matrix pipeline (BUILD_HEXAGONS, BUILD_WORK_QUEUE, etc.)
EXECUTE IMMEDIATE FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/deploy/.cortex/skills/build-routing-solution/openrouteservice_app/app/modules/05_matrix_pipeline.sql;

-- Step 6: Matrix operations (GET_MATRIX_INVENTORY, LOAD_SEED_MATRIX, LOAD_SEED_CATALOG)
EXECUTE IMMEDIATE FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/deploy/.cortex/skills/build-routing-solution/openrouteservice_app/app/modules/06_matrix_ops.sql;

-- Seed REGION_ORS_MAP so the control app resolves SanFrancisco as the active region.
-- The table is created by module 03 but not populated until a region is provisioned.
-- Without this, the control app falls back to stage-scan which can pick up phantom regions.
INSERT INTO OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP (REGION, DISPLAY_NAME, MIN_LAT, MAX_LAT, MIN_LON, MAX_LON, STATUS)
SELECT 'SanFrancisco', 'San Francisco', 37.70, 37.82, -122.52, -122.35, 'DEPLOYED'
WHERE NOT EXISTS (SELECT 1 FROM OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP WHERE REGION = 'SanFrancisco');

-- ╔══════════════════════════════════════════════════════════════════════════════╗
-- ║ PHASE 2: SEED DATA (table schemas + parquet load)                          ║
-- ║ Owner: datasets/load-seed-data.sql                                         ║
-- ╚══════════════════════════════════════════════════════════════════════════════╝

-- Populate SEED_DATA_STAGE with parquet files from workspace (required by load-seed-data.sql)
CREATE STAGE IF NOT EXISTS OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

COPY FILES INTO @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/intro/
FROM 'snow://workspace/USER$.PUBLIC."sfguide-build-fleet-intelligence-with-cortex-code"/versions/live/datasets/intro/'
PATTERN='.*\.parquet';

COPY FILES INTO @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/synthetic_ebikes/fact_vehicle_telemetry/
FROM 'snow://workspace/USER$.PUBLIC."sfguide-build-fleet-intelligence-with-cortex-code"/versions/live/datasets/synthetic_ebikes/fact_vehicle_telemetry/'
PATTERN='.*\.parquet';

COPY FILES INTO @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/synthetic_ebikes/fact_trips/
FROM 'snow://workspace/USER$.PUBLIC."sfguide-build-fleet-intelligence-with-cortex-code"/versions/live/datasets/synthetic_ebikes/fact_trips/'
PATTERN='.*\.parquet';

COPY FILES INTO @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/synthetic_ebikes/
FROM 'snow://workspace/USER$.PUBLIC."sfguide-build-fleet-intelligence-with-cortex-code"/versions/live/datasets/synthetic_ebikes/'
FILES=('dim_fleet_0_0_0.snappy.parquet', 'dim_pois_0_0_0.snappy.parquet');

COPY FILES INTO @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/metadata/
FROM 'snow://workspace/USER$.PUBLIC."sfguide-build-fleet-intelligence-with-cortex-code"/versions/live/datasets/metadata/'
PATTERN='.*\.parquet';

COPY FILES INTO @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/matrix/
FROM 'snow://workspace/USER$.PUBLIC."sfguide-build-fleet-intelligence-with-cortex-code"/versions/live/datasets/matrix/'
PATTERN='.*\.parquet';

COPY FILES INTO @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/matrix_jobs/
FROM 'snow://workspace/USER$.PUBLIC."sfguide-build-fleet-intelligence-with-cortex-code"/versions/live/datasets/matrix_jobs/'
PATTERN='.*\.parquet';

COPY FILES INTO @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/region_catalog/
FROM 'snow://workspace/USER$.PUBLIC."sfguide-build-fleet-intelligence-with-cortex-code"/versions/live/datasets/region_catalog/'
PATTERN='.*\.parquet';

-- Creates FACT_TRIPS, FACT_VEHICLE_TELEMETRY, DIM_FLEET, DIM_POIS, INTRO_TRIPS,
-- REGION_REGISTRY, GENERATION_JOBS + loads parquet from @SEED_DATA_STAGE
EXECUTE IMMEDIATE FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/deploy/datasets/load-seed-data.sql;

-- ╔══════════════════════════════════════════════════════════════════════════════╗
-- ║ PHASE 3: DEMO SKILLS (each skill owns its own SQL)                         ║
-- ║ Execute in dependency order — no skill should be skipped.                  ║
-- ║ Uses ROUTING_DEPLOY (LARGE) for Overture Maps geospatial queries.          ║
-- ╚══════════════════════════════════════════════════════════════════════════════╝

USE WAREHOUSE ROUTING_DEPLOY;

-- Fleet Intelligence: Taxis (TRIP_SUMMARY, DRIVER_LOCATIONS_V, ROUTE_NAMES, etc.)
-- Owner: .cortex/skills/fleet-intelligence-taxis/
EXECUTE IMMEDIATE FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/deploy/.cortex/skills/fleet-intelligence-taxis/references/seed-data.sql;

-- Fleet Intelligence: Food Delivery (DELIVERIES, RESTAURANTS_ENRICHED)
-- Owner: .cortex/skills/fleet-intelligence-food-delivery/
EXECUTE IMMEDIATE FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/deploy/.cortex/skills/fleet-intelligence-food-delivery/references/sql-projection-views.sql;

-- Route Deviation (TRIP_DEVIATION_ANALYSIS, DRIVER_DEVIATION_SUMMARY, DAILY_DEVIATION_TRENDS)
-- Owner: .cortex/skills/route-deviation/
EXECUTE IMMEDIATE FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/deploy/.cortex/skills/route-deviation/references/seed-data.sql;

-- Dwell Analysis (8 Dynamic Tables + force refresh)
-- Owner: .cortex/skills/dwell-analysis/
EXECUTE IMMEDIATE FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/deploy/.cortex/skills/dwell-analysis/references/sql-pipeline.sql;

-- Route Optimization (PLACES from Overture, LOOKUP+CAPACITY, JOB_TEMPLATE, SEN_STUDENTS)
-- Owner: .cortex/skills/route-optimization/
EXECUTE IMMEDIATE FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/deploy/.cortex/skills/route-optimization/references/seed-data.sql;

-- Retail Catchment (RETAIL_POIS from Overture, CITIES_BY_STATE)
-- Owner: .cortex/skills/retail-catchment/
EXECUTE IMMEDIATE FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/deploy/.cortex/skills/retail-catchment/references/seed-data.sql;

-- ╔══════════════════════════════════════════════════════════════════════════════╗
-- ║ PHASE 4: AGENT TOOLS & INTELLIGENCE                                        ║
-- ║ Tools must be created BEFORE the agent (agent references them).            ║
-- ╚══════════════════════════════════════════════════════════════════════════════╝

-- Ensure LARGE warehouse is active for Overture Maps geospatial queries
USE WAREHOUSE ROUTING_DEPLOY;

-- Agent Playground data (SF_TOP_PHARMACIES, SF_DRUG_FORMULARY, SF_HEALTH_DEMOGRAPHICS)
-- MUST run BEFORE pharma intelligence (provides prerequisite tables)
-- Owner: .cortex/skills/setup-agent-playground/
EXECUTE IMMEDIATE FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/deploy/.cortex/skills/setup-agent-playground/references/deploy-demo-data.sql;

-- Weather Routing (network rule + EAI + GET_WEATHER_AT_POINT UDF + TOOL_WEATHER)
-- Owner: .cortex/skills/add-weather-routing/
EXECUTE IMMEDIATE FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/deploy/.cortex/skills/add-weather-routing/references/deploy-weather-tool.sql;

-- Pharma Supply Chain (PLANTS, SUPPLIERS, PRODUCTS, BATCHES, SHIPMENTS, INVENTORY)
-- Owner: .cortex/skills/add-pharma-supply-chain/
EXECUTE IMMEDIATE FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/deploy/.cortex/skills/add-pharma-supply-chain/references/deploy-pharma-supply-chain.sql;

-- Robot Telemetry (capacity-scaled robots + PHARMA_SUPPLY_CHAIN_SV)
-- Owner: .cortex/skills/add-pharma-supply-chain/
EXECUTE IMMEDIATE FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/deploy/.cortex/skills/add-pharma-supply-chain/references/deploy-robot-telemetry.sql;

-- Plant Map (building footprints from Overture Maps Buildings + campus views)
-- Owner: .cortex/skills/add-plant-map/
EXECUTE IMMEDIATE FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/deploy/.cortex/skills/add-plant-map/references/build-plant-footprints.sql;

-- Pharma Intelligence (SF_INVENTORY, SF_DEMAND_FORECAST, tool procedures)
-- Owner: .cortex/skills/add-pharma-intelligence/
EXECUTE IMMEDIATE FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/deploy/.cortex/skills/add-pharma-intelligence/references/deploy-pharma-data.sql;
EXECUTE IMMEDIATE FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/deploy/.cortex/skills/add-pharma-intelligence/references/deploy-pharma-tools.sql;

-- Fleet Analytics (FLEET_TRIPS_SV, FLEET_TELEMETRY_SV semantic views)
-- Owner: .cortex/skills/add-fleet-analytics/
EXECUTE IMMEDIATE FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/deploy/.cortex/skills/add-fleet-analytics/references/deploy-fleet-analytics.sql;

-- Routing Agent tool procedures (TOOL_DIRECTIONS, TOOL_ISOCHRONES, TOOL_ROUTE_OPTIMIZATION, TOOL_PHARMA_CATCHMENT)
-- MUST run BEFORE configure-agent.sql (agent references these procedures)
-- Owner: .cortex/skills/routing-agent/
EXECUTE IMMEDIATE FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/deploy/.cortex/skills/routing-agent/references/deploy-agent.sql;

-- ╔══════════════════════════════════════════════════════════════════════════════╗
-- ║ PHASE 5: AGENT + STREAMLIT (created LAST — references all tools/views)     ║
-- ╚══════════════════════════════════════════════════════════════════════════════╝

-- Semantic View for Cortex Analyst
-- Owner: .cortex/skills/setup-agent-playground/
EXECUTE IMMEDIATE FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/deploy/.cortex/skills/setup-agent-playground/references/deploy-semantic-view.sql;

-- Routing Agent (CREATE AGENT with all 10 tools)
-- Owner: .cortex/skills/setup-agent-playground/
EXECUTE IMMEDIATE FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/deploy/.cortex/skills/setup-agent-playground/references/configure-agent.sql;

-- Fleet Explorer Streamlit App
-- Owner: .cortex/skills/fleet-explorer-app/
CREATE OR REPLACE STREAMLIT SYNTHETIC_DATASETS.UNIFIED.FLEET_MAP
  FROM 'snow://workspace/USER$.PUBLIC."sfguide-build-fleet-intelligence-with-cortex-code"/versions/live/fleet-map'
  MAIN_FILE = 'streamlit_app.py'
  QUERY_WAREHOUSE = DEFAULT_WH
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-explorer-app","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}';

-- Upload agent-demos.json to stage for React Agent Playground
COPY FILES INTO @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/config/
FROM 'snow://workspace/USER$.PUBLIC."sfguide-build-fleet-intelligence-with-cortex-code"/versions/live/'
FILES=('agent-demos.json');

-- ╔══════════════════════════════════════════════════════════════════════════════╗
-- ║ PHASE 6: CLEANUP — drop deploy warehouse, switch to ROUTING_ANALYTICS      ║
-- ╚══════════════════════════════════════════════════════════════════════════════╝

USE WAREHOUSE ROUTING_ANALYTICS;
DROP WAREHOUSE IF EXISTS ROUTING_DEPLOY;

-- ╔══════════════════════════════════════════════════════════════════════════════╗
-- ║ DEPLOYMENT COMPLETE                                                         ║
-- ║                                                                             ║
-- ║ Verify:                                                                     ║
-- ║   SHOW SERVICES IN DATABASE OPENROUTESERVICE_APP;  (5 services RUNNING)    ║
-- ║   SHOW AGENTS IN SCHEMA FLEET_INTELLIGENCE.ROUTING_AGENT;                  ║
-- ║   SHOW STREAMLITS IN SCHEMA SYNTHETIC_DATASETS.UNIFIED;                    ║
-- ║   SELECT COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS;  (6008)      ║
-- ║   SELECT COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES;       ║
-- ║   CALL FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_WEATHER('SanFrancisco');      ║
-- ║   CALL FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_PLANT_IMPACT('ALL');          ║
-- ╚══════════════════════════════════════════════════════════════════════════════╝
