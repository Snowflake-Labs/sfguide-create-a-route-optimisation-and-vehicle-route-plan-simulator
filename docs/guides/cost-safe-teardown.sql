-- =============================================================================
-- Fleet Intelligence Accelerator - cost-safe teardown / resume runbook
-- =============================================================================
-- Purpose: immediately stop idle credit consumption on a DEPLOYED account
-- without a redeploy. Safe and fully reversible (resume block at the bottom).
--
-- Why this is needed: the demo dynamic tables refresh on short (5-15 min) lags
-- and several background tasks are resumed at deploy, so the shared
-- ROUTING_ANALYTICS warehouse and the serverless task layer never go idle -
-- credits accrue even when nobody is using the app. Suspending a dynamic table
-- does NOT stop a task that reads it (they are independent objects), so the
-- tasks must be suspended explicitly.
--
-- Run as a role that owns / can ALTER these objects (the installer role, e.g.
-- ACCOUNTADMIN or the fleet admin role). Every statement uses IF EXISTS so it
-- is safe to run regardless of which demo skills were deployed.
-- =============================================================================

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"cost-safe-teardown"}}';

-- -----------------------------------------------------------------------------
-- 1. Suspend the scheduled / serverless tasks that keep waking compute
-- -----------------------------------------------------------------------------
-- dwell-analysis SLA logger (5-minute schedule on ROUTING_ANALYTICS)
ALTER TASK IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.LOG_SLA_ALERTS SUSPEND;

-- ORS region-provision rescue loop (serverless, every 2 minutes, 24/7)
ALTER TASK IF EXISTS OPENROUTESERVICE_APP.CORE.RESCUE_PENDING_PROVISIONS_TASK SUSPEND;

-- Studio job garbage collector (hourly) and observability tasks (optional)
ALTER TASK IF EXISTS OPENROUTESERVICE_APP.CORE.STUDIO_JOB_GC SUSPEND;
ALTER TASK IF EXISTS OPENROUTESERVICE_APP.OBSERVABILITY.ORS_METRICS_INGEST_TASK SUSPEND;
ALTER TASK IF EXISTS OPENROUTESERVICE_APP.OBSERVABILITY.ORS_REQUEST_LOG_PURGE_TASK SUSPEND;

-- -----------------------------------------------------------------------------
-- 2. Suspend the demo dynamic tables (stops scheduled refresh scans)
-- -----------------------------------------------------------------------------
-- dwell-analysis pipeline
ALTER DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_STATE_CHANGES SUSPEND;
ALTER DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DWELL_SESSIONS SUSPEND;
ALTER DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DWELL_ENRICHED SUSPEND;
ALTER DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_H3_CONGESTION SUSPEND;
ALTER DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_SLA_ALERTS SUSPEND;
ALTER DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_FACILITY_UTILIZATION SUSPEND;
ALTER DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DRIVER_DWELL_SUMMARY SUSPEND;
ALTER DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DAILY_TRENDS SUSPEND;

-- route-deviation pipeline
ALTER DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_DEVIATION.TRIP_DEVIATION_ANALYSIS SUSPEND;
ALTER DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_DEVIATION.DRIVER_DEVIATION_SUMMARY SUSPEND;
ALTER DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_DEVIATION.DAILY_DEVIATION_TRENDS SUSPEND;

-- freight-exchange / marketplace rate index (recreated on admin-app boot; the
-- source default is also raised, but suspend it here for an idle account)
ALTER DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.MARKETPLACE.RATE_INDEX SUSPEND;

-- -----------------------------------------------------------------------------
-- 3. Suspend all SPCS routing services + repair AUTO_SUSPEND / warehouse drift
-- -----------------------------------------------------------------------------
-- SUSPEND_ALL_SERVICES also calls RECONCILE_AUTO_SUSPEND() (restores service /
-- pool AUTO_SUSPEND_SECS off any never-suspend=0 pin) and RECONCILE_WAREHOUSE_SIZE().
CALL OPENROUTESERVICE_APP.CORE.SUSPEND_ALL_SERVICES();

-- Optional: verify nothing is left RUNNING
SHOW SERVICES IN DATABASE OPENROUTESERVICE_APP;

-- -----------------------------------------------------------------------------
-- 4. Disable Time Travel on the accelerator databases (storage cost)
-- -----------------------------------------------------------------------------
-- The accelerator's data is synthetic / rebuildable, so Time Travel (and the
-- 7-day Fail-safe that rides on any non-zero retention) is pure storage cost.
-- Setting DB-level retention to 0 is inherited by all existing and future
-- schemas/tables/stages and takes effect immediately. IF EXISTS makes this safe
-- to run regardless of which databases are present.
ALTER DATABASE IF EXISTS FLEET_INTELLIGENCE   SET DATA_RETENTION_TIME_IN_DAYS = 0;
ALTER DATABASE IF EXISTS SYNTHETIC_DATASETS   SET DATA_RETENTION_TIME_IN_DAYS = 0;
ALTER DATABASE IF EXISTS OPENROUTESERVICE_APP SET DATA_RETENTION_TIME_IN_DAYS = 0;
ALTER DATABASE IF EXISTS FLEET_APP            SET DATA_RETENTION_TIME_IN_DAYS = 0;
ALTER DATABASE IF EXISTS ROUTING_PLATFORM     SET DATA_RETENTION_TIME_IN_DAYS = 0;

-- -----------------------------------------------------------------------------
-- 5. Right-size the shared routing compute pool + gateway (one-time)
-- -----------------------------------------------------------------------------
-- Permanent config change (not a suspend): the core pool defaulted to
-- MIN_NODES=5 on HIGHMEM_X64_S, holding five high-memory nodes whenever the
-- pool is up. Drop the idle floor to 1 (scales to 5 under load) and let the
-- gateway idle-suspend after 1h instead of 4h. City/ORS + VROOM services keep
-- their 4h window on purpose (gateway-routed traffic does not reset their idle
-- timer). Safe to run any time; RECONCILE_AUTO_SUSPEND re-pins to 0 during builds.
ALTER COMPUTE POOL IF EXISTS OPENROUTESERVICE_APP_COMPUTE_POOL SET MIN_NODES = 1 MAX_NODES = 5;
ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.routing_gateway_service SET MIN_INSTANCES = 1 MAX_INSTANCES = 3;
ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.routing_gateway_service SET AUTO_SUSPEND_SECS = 3600;

-- =============================================================================
-- RESUME BLOCK - run this before your next demo to bring the stack back
-- =============================================================================
-- SPCS services resume lazily on the first routing query, so you normally do
-- NOT need to resume them manually; the dynamic tables and tasks below are the
-- ones to re-enable if you want live refresh / SLA logging during a demo.
--
-- ALTER TASK IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.LOG_SLA_ALERTS RESUME;
-- ALTER TASK IF EXISTS OPENROUTESERVICE_APP.CORE.RESCUE_PENDING_PROVISIONS_TASK RESUME;
--
-- ALTER DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_STATE_CHANGES RESUME;
-- ALTER DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DWELL_SESSIONS RESUME;
-- ALTER DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DWELL_ENRICHED RESUME;
-- ALTER DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_H3_CONGESTION RESUME;
-- ALTER DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_SLA_ALERTS RESUME;
-- ALTER DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_FACILITY_UTILIZATION RESUME;
-- ALTER DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DRIVER_DWELL_SUMMARY RESUME;
-- ALTER DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DAILY_TRENDS RESUME;
-- ALTER DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_DEVIATION.TRIP_DEVIATION_ANALYSIS RESUME;
-- ALTER DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_DEVIATION.DRIVER_DEVIATION_SUMMARY RESUME;
-- ALTER DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_DEVIATION.DAILY_DEVIATION_TRENDS RESUME;
-- ALTER DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.MARKETPLACE.RATE_INDEX RESUME;
