-- ============================================================================
-- FULL TEARDOWN SCRIPT — Drops all objects created by routing solution skills
-- ============================================================================
-- Usage: snow sql -f .cortex/skills/routing-solution-cleanup/references/drop-order.sql -c <connection>
--
-- WARNING: This script is DESTRUCTIVE. It drops ALL databases, schemas, tables,
-- warehouses, compute pools, integrations, and other objects created by this project.
-- Review carefully before executing. The only surviving objects will be:
--   SNOWFLAKE (system), USER$<username> (personal), MY_WH (personal), SYSTEM_* pools
--
-- The drop order follows reverse-dependency: most-dependent objects first.
-- ============================================================================

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-routing-solution-cleanup","version":{"major":2,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- ============================================================================
-- PHASE 1: Native Application (CASCADE stops SPCS services, drops app objects)
-- ============================================================================
DROP APPLICATION IF EXISTS OPENROUTESERVICE_NATIVE_APP CASCADE;
DROP APPLICATION PACKAGE IF EXISTS OPENROUTESERVICE_NATIVE_APP_PKG CASCADE;

-- ============================================================================
-- PHASE 2: Compute Pools (may already be gone from CASCADE above)
-- ============================================================================
ALTER COMPUTE POOL IF EXISTS OPENROUTESERVICE_NATIVE_APP_COMPUTE_POOL STOP ALL;
DROP COMPUTE POOL IF EXISTS OPENROUTESERVICE_NATIVE_APP_COMPUTE_POOL;

-- ============================================================================
-- PHASE 3: External Access Integrations, Network Rules, App Data DB
-- ============================================================================
DROP INTEGRATION IF EXISTS OPENROUTESERVICE_NATIVE_APP_EXTERNAL_ACCESS_INTEGRATION_REF_EXTERNAL_ACCESS;
DROP INTEGRATION IF EXISTS OPENROUTESERVICE_NATIVE_APP_EXTERNAL_ACCESS_CARTO_REF_EXTERNAL_ACCESS;
DROP DATABASE IF EXISTS OPENROUTESERVICE_NATIVE_APP_APP_DATA;

-- ============================================================================
-- PHASE 4: Cortex Agents
-- ============================================================================
DROP AGENT IF EXISTS FLEET_INTELLIGENCE.ROUTING_AGENT.ROUTING_AGENT;

-- ============================================================================
-- PHASE 5: Tasks (suspend first, then drop)
-- ============================================================================
ALTER TASK IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.LOG_SLA_ALERTS SUSPEND;
DROP TASK IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.LOG_SLA_ALERTS;

-- ============================================================================
-- PHASE 6: Dynamic Tables (reverse pipeline order — downstream first)
-- ============================================================================
DROP DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DAILY_TRENDS;
DROP DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DRIVER_DWELL_SUMMARY;
DROP DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_FACILITY_UTILIZATION;
DROP DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_SLA_ALERTS;
DROP DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_H3_CONGESTION;
DROP DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DWELL_ENRICHED;
DROP DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DWELL_SESSIONS;
DROP DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_STATE_CHANGES;

-- ============================================================================
-- PHASE 7: Notebooks
-- ============================================================================
DROP NOTEBOOK IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.ADD_CARTO_DATA;
DROP NOTEBOOK IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.ROUTING_FUNCTIONS_AISQL;

-- ============================================================================
-- PHASE 8: Procedures
-- ============================================================================
DROP PROCEDURE IF EXISTS FLEET_INTELLIGENCE.CORE.SET_ACTIVE_REGION(VARCHAR);
DROP PROCEDURE IF EXISTS FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_DIRECTIONS(VARCHAR, VARCHAR, VARCHAR);
DROP PROCEDURE IF EXISTS FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ISOCHRONE(VARCHAR, FLOAT, VARCHAR);
DROP PROCEDURE IF EXISTS FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_OPTIMIZATION(VARCHAR, VARCHAR, VARCHAR);

-- ============================================================================
-- PHASE 9: Warehouse
-- ============================================================================
ALTER WAREHOUSE IF EXISTS ROUTING_ANALYTICS SUSPEND;
DROP WAREHOUSE IF EXISTS ROUTING_ANALYTICS;

-- ============================================================================
-- PHASE 10: Marketplace Databases (detaches listing automatically)
-- ============================================================================
DROP DATABASE IF EXISTS OVERTURE_MAPS__PLACES;
DROP DATABASE IF EXISTS OVERTURE_MAPS__ADDRESSES;

-- ============================================================================
-- PHASE 11: Project Databases (CASCADE drops all schemas, tables, views, stages, etc.)
-- ============================================================================
DROP DATABASE IF EXISTS FLEET_INTELLIGENCE CASCADE;
DROP DATABASE IF EXISTS SYNTHETIC_DATASETS CASCADE;
DROP DATABASE IF EXISTS OPENROUTESERVICE_SETUP CASCADE;
