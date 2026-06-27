-- =============================================================================
-- install-fleet-apps : agnostic V_*_CURRENT projection views (FLEET-owned)
-- =============================================================================
-- The dataset-scoped projection views the agnostic packs bind to. Historically
-- these were authored ONLY by the control-app / fleet_admin_app boot (init.ts),
-- which the agnostic installer does not run before the pack step. Without them,
-- the unified_fleet pack's CREATE VIEW ... AS SELECT * FROM V_*_CURRENT fails at
-- definition time and breaks the whole pack install.
--
-- DDL mirrors fleet_admin_app/ui/src/server/lib/init.ts (the runtime owner). The
-- delivery/partner views (V_FACT_OFFERS_CURRENT / V_DIM_PARTNERS_CURRENT /
-- V_FACT_PARTNER_HISTORY_CURRENT) are created at app boot by init.ts (offers
-- are now vehicle-agnostic and retained), so they are not duplicated here.
--
-- Each view returns only rows from the active dataset (DIM_DATASETS.IS_ACTIVE),
-- so it requires the loader to have created DIM_DATASETS + the base tables. Run
-- AFTER datasets/load-seed-data.sql. Idempotent (CREATE OR REPLACE VIEW).
-- =============================================================================

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","module":"projection-views"}}';

CREATE OR REPLACE VIEW SYNTHETIC_DATASETS.UNIFIED.V_DIM_FLEET_CURRENT
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT f.*
FROM SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET f
JOIN FLEET_INTELLIGENCE.CORE.DIM_DATASETS d
  ON d.DATASET_ID = f.JOB_ID
 AND d.REGION = f.REGION
 AND d.VEHICLE_TYPE = f.VEHICLE_TYPE
 AND d.IS_ACTIVE = TRUE;

CREATE OR REPLACE VIEW SYNTHETIC_DATASETS.UNIFIED.V_DIM_POIS_CURRENT
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT p.*
FROM SYNTHETIC_DATASETS.UNIFIED.DIM_POIS p
JOIN FLEET_INTELLIGENCE.CORE.DIM_DATASETS d
  ON d.DATASET_ID = p.JOB_ID
 AND d.REGION = p.REGION
 AND d.IS_ACTIVE = TRUE;

CREATE OR REPLACE VIEW SYNTHETIC_DATASETS.UNIFIED.V_FACT_TRIPS_CURRENT
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT t.*
FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS t
JOIN FLEET_INTELLIGENCE.CORE.DIM_DATASETS d
  ON d.DATASET_ID = t.JOB_ID
 AND d.REGION = t.REGION
 AND d.VEHICLE_TYPE = t.VEHICLE_TYPE
 AND d.IS_ACTIVE = TRUE;

CREATE OR REPLACE VIEW SYNTHETIC_DATASETS.UNIFIED.V_DIM_TRIP_SCHEDULE_CURRENT
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT s.*
FROM SYNTHETIC_DATASETS.UNIFIED.DIM_TRIP_SCHEDULE s
JOIN FLEET_INTELLIGENCE.CORE.DIM_DATASETS d
  ON d.DATASET_ID = s.JOB_ID
 AND d.REGION = s.REGION
 AND d.VEHICLE_TYPE = s.VEHICLE_TYPE
 AND d.IS_ACTIVE = TRUE;

CREATE OR REPLACE VIEW SYNTHETIC_DATASETS.UNIFIED.V_FACT_VEHICLE_TELEMETRY_CURRENT
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT t.*
FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY t
JOIN FLEET_INTELLIGENCE.CORE.DIM_DATASETS d
  ON d.DATASET_ID = t.JOB_ID
 AND d.REGION = t.REGION
 AND d.VEHICLE_TYPE = t.VEHICLE_TYPE
 AND d.IS_ACTIVE = TRUE;
