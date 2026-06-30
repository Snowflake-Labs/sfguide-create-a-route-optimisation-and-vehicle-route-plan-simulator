-- =============================================================================
-- sap-fleet-connector : build_crosswalk.sql  (Step 3)
-- =============================================================================
-- Creates the normalize_serial UDF and the ASSET_CROSSWALK that resolves any
-- telematics device id to a neutral asset_id (= EQUI.EQUNR when SAP equipment
-- exists). Pick ONE strategy block per account (sap-mapping.yaml join.strategy).
-- Placeholders {{...}} are substituted from sap-mapping.yaml.
-- =============================================================================
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-sap-fleet-connector","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","module":"crosswalk"}}';

CREATE DATABASE IF NOT EXISTS SAP_SOURCE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-sap-fleet-connector","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
CREATE SCHEMA IF NOT EXISTS SAP_SOURCE.FLEET
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-sap-fleet-connector","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- Normalize both sides of any serial/VIN comparison: upper, trim, strip leading zeros.
CREATE OR REPLACE FUNCTION SAP_SOURCE.FLEET.NORMALIZE_SERIAL(X VARCHAR)
RETURNS VARCHAR
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-sap-fleet-connector","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS $$ REGEXP_REPLACE(UPPER(TRIM(X)), '^0+', '') $$;

-- ---------------------------------------------------------------------------
-- STRATEGY: native_serial - crosswalk is a VIEW over EQUI.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW SAP_SOURCE.FLEET.ASSET_CROSSWALK
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-sap-fleet-connector","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT e.EQUNR                                   AS ASSET_ID,
       SAP_SOURCE.FLEET.NORMALIZE_SERIAL(e.SERNR) AS SERIAL,
       CAST(NULL AS VARCHAR)                      AS VIN,
       SAP_SOURCE.FLEET.NORMALIZE_SERIAL(e.SERNR) AS DEVICE_ID,
       'native_serial'                            AS SOURCE
FROM SAP_SOURCE.FLEET.SRC_EQUI_CURRENT e   -- L1 current-row view (cdc-dedup.md)
WHERE e.SERNR IS NOT NULL;

-- ---------------------------------------------------------------------------
-- STRATEGY: vin_2hop - device/message id -> VIN/chassis (vehicle master) -> EQUI.SERNR.
-- Replace the native_serial view above with this when join.strategy=vin_2hop.
-- ---------------------------------------------------------------------------
-- CREATE OR REPLACE VIEW SAP_SOURCE.FLEET.ASSET_CROSSWALK AS
-- SELECT e.EQUNR AS ASSET_ID,
--        SAP_SOURCE.FLEET.NORMALIZE_SERIAL(e.SERNR) AS SERIAL,
--        UPPER(TRIM(t.VIN)) AS VIN,
--        t.{{DEVICE_COL}} AS DEVICE_ID,
--        'vin_2hop' AS SOURCE
-- FROM {{DEVICE_VIN_INDEX}} t
-- JOIN SAP_SOURCE.FLEET.SRC_EQUI_CURRENT e
--   ON SAP_SOURCE.FLEET.NORMALIZE_SERIAL(e.SERNR) = SAP_SOURCE.FLEET.NORMALIZE_SERIAL(t.CHASSIS);

-- ---------------------------------------------------------------------------
-- STRATEGY: vin_external - no EQUI; external fleet-asset master IS the
-- crosswalk. asset_id comes from the master, keyed by validated VIN.
-- ---------------------------------------------------------------------------
-- CREATE OR REPLACE VIEW SAP_SOURCE.FLEET.ASSET_CROSSWALK AS
-- SELECT m.ASSET_ID,
--        CAST(NULL AS VARCHAR) AS SERIAL,
--        REGEXP_REPLACE(UPPER(TRIM(m.VIN)),'[^A-Z0-9]','') AS VIN,
--        REGEXP_REPLACE(UPPER(TRIM(m.VIN)),'[^A-Z0-9]','') AS DEVICE_ID,
--        'vin_external' AS SOURCE
-- FROM {{EXTERNAL_ASSET_MASTER}} m
-- WHERE LENGTH(REGEXP_REPLACE(UPPER(TRIM(m.VIN)),'[^A-Z0-9]','')) = 17;

-- ---------------------------------------------------------------------------
-- STRATEGY: marine - vessel master keyed by IMO/MMSI.
-- ---------------------------------------------------------------------------
-- CREATE OR REPLACE VIEW SAP_SOURCE.FLEET.ASSET_CROSSWALK AS
-- SELECT v.IMO AS ASSET_ID, CAST(NULL AS VARCHAR) AS SERIAL, CAST(NULL AS VARCHAR) AS VIN,
--        v.MMSI AS DEVICE_ID, 'marine' AS SOURCE
-- FROM {{VESSEL_MASTER}} v;
