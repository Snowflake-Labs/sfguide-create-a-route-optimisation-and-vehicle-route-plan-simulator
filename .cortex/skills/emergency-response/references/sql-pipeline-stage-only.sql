-- =============================================================================
-- Emergency Response Intelligence -- pre-upload subset of the SQL pipeline.
-- =============================================================================
-- Run this BEFORE the IPAWS seed parquet is uploaded to the stage. It creates
-- everything the COPY INTO in references/sql-pipeline.sql Step 0f depends on:
-- the database, schemas, CONFIG.PARAMS, and the IPAWS_SEED_STAGE.
--
-- After this script completes, the install runner uploads the bundled
-- assets/ipaws_sf.parquet to @EMERGENCY_RESPONSE.SOURCE.IPAWS_SEED_STAGE/, then
-- executes the full references/sql-pipeline.sql which COPY INTOs the parquet
-- and builds the Dynamic Tables.
--
-- This file is intentionally a strict subset of references/sql-pipeline.sql --
-- every CREATE here also exists there with the same definition, so the full
-- pipeline can be re-run safely by itself if needed.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- query_tag (hard requirement per AGENTS.md)
-- ----------------------------------------------------------------------------
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- ----------------------------------------------------------------------------
-- Step 0a: Install required Marketplace listings (idempotent)
-- ----------------------------------------------------------------------------
CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZTSZ290BV255');
CREATE DATABASE IF NOT EXISTS SNOWFLAKE_PUBLIC_DATA_FREE FROM LISTING GZTSZ290BV255;

CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZSTZKU9FH9');
CREATE DATABASE IF NOT EXISTS FEMA_NATIONAL_RISK_INDEX FROM LISTING GZSTZKU9FH9;

-- ----------------------------------------------------------------------------
-- Step 0: Database + 4 schemas + CONFIG.PARAMS
-- ----------------------------------------------------------------------------
CREATE DATABASE IF NOT EXISTS EMERGENCY_RESPONSE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE SCHEMA IF NOT EXISTS EMERGENCY_RESPONSE.CONFIG
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
CREATE SCHEMA IF NOT EXISTS EMERGENCY_RESPONSE.SOURCE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
CREATE SCHEMA IF NOT EXISTS EMERGENCY_RESPONSE.CORE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
CREATE SCHEMA IF NOT EXISTS EMERGENCY_RESPONSE.PIPELINE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE TABLE IF NOT EXISTS EMERGENCY_RESPONSE.CONFIG.PARAMS (
  PARAM_NAME  VARCHAR PRIMARY KEY,
  PARAM_VALUE VARCHAR
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

MERGE INTO EMERGENCY_RESPONSE.CONFIG.PARAMS t
USING (SELECT * FROM VALUES
  ('REGION','SanFrancisco'),
  ('NUM_PARTICIPANTS','5000'),
  ('NUM_STAFF','300'),
  ('NUM_CENTERS','12'),
  ('NUM_DRIVERS','40'),
  ('VULNERABILITY_WEIGHTING','0.5'),
  ('TARGET_LAG','5 minutes'),
  ('H3_RESOLUTION_HISTORY','7')
  AS s(PARAM_NAME, PARAM_VALUE)) s
ON t.PARAM_NAME = s.PARAM_NAME
WHEN NOT MATCHED THEN INSERT (PARAM_NAME, PARAM_VALUE) VALUES (s.PARAM_NAME, s.PARAM_VALUE);

-- ----------------------------------------------------------------------------
-- Step 0c: IPAWS seed stage (the install runner uploads ipaws_sf.parquet next)
-- ----------------------------------------------------------------------------
CREATE STAGE IF NOT EXISTS EMERGENCY_RESPONSE.SOURCE.IPAWS_SEED_STAGE
  FILE_FORMAT = (TYPE = PARQUET)
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
