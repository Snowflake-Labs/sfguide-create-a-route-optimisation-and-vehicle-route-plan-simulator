-- FLEET_OPS pack - minimal setup (hand-written, NOT generated).
-- The FLEET_OPS analytics layer (schema, dataset-scoped intent UDTFs, global-active
-- views, and their grants) is authored in fleet_sa_app/app/scoped_contract.sql and
-- applied by packs/_lib/install.py AFTER the unified_fleet pack. This file only ensures
-- the schema exists + the consumer/ops/admin roles can USE it, so install ordering and
-- the surfacing-gate probe (FLEET_APP.FLEET_OPS.VW_TRIPS) resolve cleanly. Idempotent.
-- See app/packs/BUSINESS_PROBLEM_TAXONOMY.md.
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-app-restructure","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE DATABASE IF NOT EXISTS FLEET_APP COMMENT='{"origin":"sf_sit-is-fleet","name":"install-fleet-apps","attributes":{"component":"data-contract-app-layer"}}';
ALTER DATABASE FLEET_APP SET DATA_RETENTION_TIME_IN_DAYS = 0;
CREATE SCHEMA IF NOT EXISTS FLEET_APP.FLEET_OPS
  COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-app-restructure","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"fleet-ops-universal-analytics"}}';

GRANT USAGE ON SCHEMA FLEET_APP.FLEET_OPS TO ROLE FLEET_APP_USER;
GRANT USAGE ON SCHEMA FLEET_APP.FLEET_OPS TO ROLE FLEET_APP_OPS;
GRANT USAGE ON SCHEMA FLEET_APP.FLEET_OPS TO ROLE FLEET_APP_ADMIN;
