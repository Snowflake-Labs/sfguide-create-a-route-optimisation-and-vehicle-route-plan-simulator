-- =============================================================================
-- sap-fleet-connector : mock_sap_seed.sql  (DEMO ONLY - not for production)
-- =============================================================================
-- Seeds a tiny, synthetic SAP + telematics landscape so the in-app SAP-table
-- introspection tool (FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_SAP_INTROSPECT, via
-- the agent verb `introspect_sap`) returns real results in a demo account that
-- has NO real SAP data. Table + column names and the CDC metadata columns mirror
-- what introspect_sap.sql looks for, so all three discovery result sets populate:
--   - SAP fleet objects  : EQUI, IFLOT, LIKP, LIPS (in MOCK_SAP.FLEET)
--   - CDC fingerprint     : MANDT + header__change_oper / header__timestamp -> 'qlik'
--   - telematics columns  : DEVICE_ID / SERIAL / EVENT_TS / LAT / LON / SPEED
--
-- This is demo scaffolding only. Real deployments introspect the customer's
-- actual co-located SAP + telematics databases; do NOT ship this to production.
-- Idempotent: CREATE IF NOT EXISTS + reseed. Safe to re-run.
-- =============================================================================
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-sap-fleet-connector","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","module":"mock-seed"}}';

CREATE DATABASE IF NOT EXISTS MOCK_SAP
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-sap-fleet-connector","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","module":"mock-seed"}}';
CREATE SCHEMA IF NOT EXISTS MOCK_SAP.FLEET
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-sap-fleet-connector","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","module":"mock-seed"}}';

CREATE DATABASE IF NOT EXISTS MOCK_TELEMATICS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-sap-fleet-connector","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","module":"mock-seed"}}';
CREATE SCHEMA IF NOT EXISTS MOCK_TELEMATICS.GPS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-sap-fleet-connector","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","module":"mock-seed"}}';

-- ── SAP EAM equipment master (EQUI). MANDT + header__* -> qlik CDC fingerprint.
CREATE OR REPLACE TABLE MOCK_SAP.FLEET.EQUI (
    MANDT                 VARCHAR,
    EQUNR                 VARCHAR,
    SERNR                 VARCHAR,
    EQKTX                 VARCHAR,
    EQTYP                 VARCHAR,
    TPLNR                 VARCHAR,
    HEADER__CHANGE_OPER   VARCHAR,
    HEADER__TIMESTAMP     TIMESTAMP_NTZ
) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-sap-fleet-connector","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","module":"mock-seed"}}';
INSERT INTO MOCK_SAP.FLEET.EQUI (MANDT, EQUNR, SERNR, EQKTX, EQTYP, TPLNR, HEADER__CHANGE_OPER, HEADER__TIMESTAMP) VALUES
    ('100', '000000000010000001', '0000SN-TRUCK-001', 'Line-haul tractor 001', 'V', 'PLANT-DC-01', 'I', CURRENT_TIMESTAMP()),
    ('100', '000000000010000002', '0000SN-TRUCK-002', 'Line-haul tractor 002', 'V', 'PLANT-DC-01', 'I', CURRENT_TIMESTAMP()),
    ('100', '000000000010000003', '0000SN-TRUCK-003', 'Regional van 003',      'V', 'PLANT-DC-02', 'U', CURRENT_TIMESTAMP());

-- ── SAP functional locations (IFLOT).
CREATE OR REPLACE TABLE MOCK_SAP.FLEET.IFLOT (
    MANDT   VARCHAR,
    TPLNR   VARCHAR,
    PLTXT   VARCHAR,
    FLTYP   VARCHAR
) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-sap-fleet-connector","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","module":"mock-seed"}}';
INSERT INTO MOCK_SAP.FLEET.IFLOT (MANDT, TPLNR, PLTXT, FLTYP) VALUES
    ('100', 'PLANT-DC-01', 'Distribution Center 01', '01'),
    ('100', 'PLANT-DC-02', 'Distribution Center 02', '01');

-- ── SAP delivery header (LIKP).
CREATE OR REPLACE TABLE MOCK_SAP.FLEET.LIKP (
    MANDT   VARCHAR,
    VBELN   VARCHAR,
    LFDAT   DATE,
    VSTEL   VARCHAR,
    KUNNR   VARCHAR,
    WBSTK   VARCHAR
) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-sap-fleet-connector","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","module":"mock-seed"}}';
INSERT INTO MOCK_SAP.FLEET.LIKP (MANDT, VBELN, LFDAT, VSTEL, KUNNR, WBSTK) VALUES
    ('100', '0080000001', CURRENT_DATE(), 'PLANT-DC-01', 'CUST-0001', 'C'),
    ('100', '0080000002', CURRENT_DATE(), 'PLANT-DC-02', 'CUST-0002', 'A');

-- ── SAP delivery items (LIPS).
CREATE OR REPLACE TABLE MOCK_SAP.FLEET.LIPS (
    MANDT   VARCHAR,
    VBELN   VARCHAR,
    POSNR   VARCHAR,
    WERKS   VARCHAR
) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-sap-fleet-connector","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","module":"mock-seed"}}';
INSERT INTO MOCK_SAP.FLEET.LIPS (MANDT, VBELN, POSNR, WERKS) VALUES
    ('100', '0080000001', '000010', 'PLANT-DC-01'),
    ('100', '0080000002', '000010', 'PLANT-DC-02');

-- ── Telematics GPS fact (device id + serial + ts + lat/lon + speed).
CREATE OR REPLACE TABLE MOCK_TELEMATICS.GPS.FACT_POSITION (
    DEVICE_ID   VARCHAR,
    SERIAL      VARCHAR,
    EVENT_TS    TIMESTAMP_NTZ,
    LAT         FLOAT,
    LON         FLOAT,
    SPEED       FLOAT,
    HEADING     FLOAT
) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-sap-fleet-connector","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","module":"mock-seed"}}';
INSERT INTO MOCK_TELEMATICS.GPS.FACT_POSITION (DEVICE_ID, SERIAL, EVENT_TS, LAT, LON, SPEED, HEADING) VALUES
    ('DEV-001', 'SN-TRUCK-001', CURRENT_TIMESTAMP(), 37.7749, -122.4194, 42.5, 90),
    ('DEV-002', 'SN-TRUCK-002', CURRENT_TIMESTAMP(), 37.8044, -122.2712, 0.0, 0),
    ('DEV-003', 'SN-TRUCK-003', CURRENT_TIMESTAMP(), 37.3382, -121.8863, 55.1, 180);
