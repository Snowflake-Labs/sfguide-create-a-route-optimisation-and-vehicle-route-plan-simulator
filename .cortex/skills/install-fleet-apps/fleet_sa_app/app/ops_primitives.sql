-- ============================================================================
-- OPS surface primitives (R4 of APP_RESTRUCTURE_PLAN)
-- ============================================================================
-- Global active-scope promotion is an OPS/ADMIN-only action (consumers do
-- per-session selection via the contextBar + F_*_SCOPED functions). This proc is
-- the "activate dataset" primitive: flip DIM_DATASETS.IS_ACTIVE to a chosen
-- dataset while preserving the invariant of at most one active dataset per
-- (REGION, VEHICLE_TYPE). Invoked by the OPS-gated consumer route
-- /api/ops/activate-dataset (requireOps), never by the consumer surface.
--
-- Source of truth: this file; also mirrored into the control-app init.ts boot
-- path so a fresh install creates it.
-- ============================================================================

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-app-restructure","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.CORE.ACTIVATE_DATASET(P_DATASET_ID VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-app-restructure","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
DECLARE
  v_region   VARCHAR;
  v_vehicle  VARCHAR;
  v_count    NUMBER;
BEGIN
  SELECT REGION, VEHICLE_TYPE INTO :v_region, :v_vehicle
    FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS
   WHERE DATASET_ID = :P_DATASET_ID;

  IF (:v_region IS NULL) THEN
    RETURN 'ERROR: dataset not found: ' || :P_DATASET_ID;
  END IF;

  -- Demote peers in the same (region, vehicle) scope, then promote the target.
  UPDATE FLEET_INTELLIGENCE.CORE.DIM_DATASETS
     SET IS_ACTIVE = FALSE
   WHERE REGION = :v_region AND VEHICLE_TYPE = :v_vehicle AND IS_ACTIVE = TRUE;

  UPDATE FLEET_INTELLIGENCE.CORE.DIM_DATASETS
     SET IS_ACTIVE = TRUE
   WHERE DATASET_ID = :P_DATASET_ID;

  RETURN 'OK: activated ' || :P_DATASET_ID || ' for ' || :v_region || '/' || :v_vehicle;
END;
$$;
