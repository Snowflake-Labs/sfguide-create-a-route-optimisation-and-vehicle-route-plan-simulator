-- =============================================================================
-- install-fleet-apps : vehicle-profile catalog (FLEET-owned, agnostic)
-- =============================================================================
-- SQL port of fleet_admin_app/ui/src/server/studio/vehicle-profile-catalog.ts.
-- Creates + seeds FLEET_INTELLIGENCE.CORE.DIM_VEHICLE_PROFILE and
-- DIM_VEHICLE_DWELL_SLA, which the unified_fleet / dwell packs JOIN on the active
-- dataset's VEHICLE_TYPE. Historically these were authored ONLY by the admin-app
-- boot (Studio TS), which the agnostic installer does not run before the pack
-- step, so the packs failed with "DIM_VEHICLE_PROFILE does not exist". Authoring
-- them here (data step, before packs) makes a from-scratch install self-contained.
--
-- Values mirror the TS catalog: asset dims + thresholds from ASSET_SPEC; dwell SLA
-- from BASELINE_DWELL_SLA scaled by DWELL_SCALE (hgv 1.0 / car 0.6 / ebike 0.5;
-- IDLE never scaled; crit = max(warn+1, round(crit*f))). ebike ORS_PROFILE /
-- OPERATING_MODE reflect the seeded SF dataset (cycling-electric / urban_ebike).
-- Idempotent: CREATE IF NOT EXISTS + DELETE/INSERT.
-- =============================================================================

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","module":"vehicle-profile-catalog"}}';

CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.CORE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.CORE.DIM_VEHICLE_PROFILE (
  VEHICLE_TYPE             VARCHAR PRIMARY KEY,
  ORS_PROFILE             VARCHAR  NOT NULL,
  OPERATING_MODE          VARCHAR  NOT NULL,
  WEIGHT_TONS             NUMBER(6,2),
  HEIGHT_M                NUMBER(4,2),
  LENGTH_M                NUMBER(4,2),
  WIDTH_M                 NUMBER(4,2),
  AXLELOAD_T              NUMBER(4,2),
  HAZMAT_PROB             FLOAT,
  SUBTYPE_DIST            VARIANT,
  DEVIATION_DISTANCE_RATIO FLOAT   NOT NULL,
  TELEPORT_DISTANCE_M     NUMBER   NOT NULL,
  SPEEDING_RATIO          FLOAT
) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- Idempotent column add for accounts whose DIM_VEHICLE_PROFILE predates SPEEDING_RATIO
-- (CREATE IF NOT EXISTS above won't alter an existing table). Nullable so the ADD
-- never violates NOT NULL on tables that still hold rows; the INSERT below always
-- supplies a value. SPEEDING_RATIO = posted-speed multiplier above which a synthetic
-- ping is flagged IS_SPEEDING (read by the Data Studio generator, interpolate.ts).
ALTER TABLE FLEET_INTELLIGENCE.CORE.DIM_VEHICLE_PROFILE ADD COLUMN IF NOT EXISTS SPEEDING_RATIO FLOAT;

CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.CORE.DIM_VEHICLE_DWELL_SLA (
  VEHICLE_TYPE    VARCHAR NOT NULL,
  LOCATION_TYPE   VARCHAR NOT NULL,
  WARNING_MIN     NUMBER  NOT NULL,
  CRITICAL_MIN    NUMBER  NOT NULL,
  BUFFER_RADIUS_M NUMBER  NOT NULL
) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- Profiles (VALUES cannot hold PARSE_JSON, so use SELECT ... UNION ALL).
DELETE FROM FLEET_INTELLIGENCE.CORE.DIM_VEHICLE_PROFILE;
INSERT INTO FLEET_INTELLIGENCE.CORE.DIM_VEHICLE_PROFILE
  (VEHICLE_TYPE, ORS_PROFILE, OPERATING_MODE, WEIGHT_TONS, HEIGHT_M, LENGTH_M, WIDTH_M, AXLELOAD_T, HAZMAT_PROB, SUBTYPE_DIST, DEVIATION_DISTANCE_RATIO, TELEPORT_DISTANCE_M, SPEEDING_RATIO)
SELECT 'hgv','driving-hgv','regional_hgv',40.00,4.00,16.50,2.55,11.50,0.18,
       PARSE_JSON('[{"subtype":"DRY","pct":60},{"subtype":"REEFER","pct":25},{"subtype":"FLAT","pct":12},{"subtype":"TANKER","pct":3}]'),0.25,2500,1.05
UNION ALL
SELECT 'car','driving-car','urban_car',2.00,2.00,4.50,1.85,1.20,0,NULL,0.20,1000,1.08
UNION ALL
SELECT 'ebike','cycling-electric','urban_ebike',0.10,1.20,1.80,0.70,0.05,0,NULL,0.15,300,1.15;

-- Dwell SLA (per vehicle_type x location_type; scaled per TS DWELL_SCALE).
DELETE FROM FLEET_INTELLIGENCE.CORE.DIM_VEHICLE_DWELL_SLA;
INSERT INTO FLEET_INTELLIGENCE.CORE.DIM_VEHICLE_DWELL_SLA
  (VEHICLE_TYPE, LOCATION_TYPE, WARNING_MIN, CRITICAL_MIN, BUFFER_RADIUS_M)
VALUES
  -- hgv (f=1.0)
  ('hgv','WAREHOUSE',5,15,200),('hgv','DESTINATION',3,10,100),('hgv','REST_STOP',5,12,150),
  ('hgv','STORE',2,8,100),('hgv','DETOUR',2,5,100),('hgv','IDLE',120,240,100),
  -- car (f=0.6)
  ('car','WAREHOUSE',3,9,200),('car','DESTINATION',2,6,100),('car','REST_STOP',3,7,150),
  ('car','STORE',1,5,100),('car','DETOUR',1,3,100),('car','IDLE',120,240,100),
  -- ebike (f=0.5)
  ('ebike','WAREHOUSE',3,8,200),('ebike','DESTINATION',2,5,100),('ebike','REST_STOP',3,6,150),
  ('ebike','STORE',1,4,100),('ebike','DETOUR',1,3,100),('ebike','IDLE',120,240,100);

-- ---------------------------------------------------------------------------
-- Stamp DIM_FLEET asset columns from the catalog. scoped_contract.sql's
-- F_DIM_FLEET_SCOPED selects f.WEIGHT_TONS/HEIGHT_M/LENGTH_M/WIDTH_M/AXLELOAD_T/
-- HAZMAT/VEHICLE_SUBTYPE - columns the Studio generator normally adds to DIM_FLEET.
-- On the agnostic seed path those columns are absent, so add + stamp them here.
-- V_DIM_FLEET_CURRENT is `SELECT f.*`, so it MUST be dropped before ADD COLUMN
-- (projection_views.sql recreates it AFTER this file runs). Mirrors init.ts.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS SYNTHETIC_DATASETS.UNIFIED.V_DIM_FLEET_CURRENT;
ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET ADD COLUMN IF NOT EXISTS WEIGHT_TONS NUMBER(6,2);
ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET ADD COLUMN IF NOT EXISTS HEIGHT_M NUMBER(4,2);
ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET ADD COLUMN IF NOT EXISTS LENGTH_M NUMBER(4,2);
ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET ADD COLUMN IF NOT EXISTS WIDTH_M NUMBER(4,2);
ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET ADD COLUMN IF NOT EXISTS AXLELOAD_T NUMBER(4,2);
ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET ADD COLUMN IF NOT EXISTS HAZMAT BOOLEAN;
ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET ADD COLUMN IF NOT EXISTS VEHICLE_SUBTYPE VARCHAR(16);

UPDATE SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET f
SET WEIGHT_TONS = p.WEIGHT_TONS,
    HEIGHT_M    = p.HEIGHT_M,
    LENGTH_M    = p.LENGTH_M,
    WIDTH_M     = p.WIDTH_M,
    AXLELOAD_T  = p.AXLELOAD_T,
    HAZMAT      = COALESCE(f.HAZMAT, FALSE)
FROM FLEET_INTELLIGENCE.CORE.DIM_VEHICLE_PROFILE p
WHERE f.VEHICLE_TYPE = p.VEHICLE_TYPE;
