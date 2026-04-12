#!/bin/bash
set -euo pipefail

CONN="${1:-fleet_test_evals}"
STAGE="@OPENROUTESERVICE_NATIVE_APP_PKG.APP_SRC.STAGE"
REGISTRY="pm-fleet-test.registry.snowflakecomputing.com/openrouteservice_setup/public/image_repository"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT_PATH="$SCRIPT_DIR/app/setup_script.sql"
MANIFEST_PATH="$SCRIPT_DIR/app/manifest.yml"
CONTROL_APP_DIR="$SCRIPT_DIR/services/ors_control_app"
GATEWAY_DIR="$SCRIPT_DIR/services/gateway"

if [ ! -f "$SCRIPT_PATH" ]; then
  echo "ERROR: $SCRIPT_PATH not found"
  exit 1
fi

echo "==> Uploading setup_script.sql to stage root..."
snow sql -c "$CONN" -q \
  "PUT 'file://$SCRIPT_PATH' $STAGE/ OVERWRITE=TRUE AUTO_COMPRESS=FALSE"

echo "==> Uploading manifest.yml to stage root..."
snow sql -c "$CONN" -q \
  "PUT 'file://$MANIFEST_PATH' $STAGE/ OVERWRITE=TRUE AUTO_COMPRESS=FALSE"

echo "==> Uploading service YAMLs..."
snow sql -c "$CONN" -q \
  "PUT 'file://$CONTROL_APP_DIR/ors_control_app_service.yaml' $STAGE/services/ors_control_app/ OVERWRITE=TRUE AUTO_COMPRESS=FALSE"
snow sql -c "$CONN" -q \
  "PUT 'file://$GATEWAY_DIR/routing-gateway-service.yaml' $STAGE/services/gateway/ OVERWRITE=TRUE AUTO_COMPRESS=FALSE"

STALE=$(snow sql -c "$CONN" -q \
  "LIST $STAGE/app/ PATTERN='.*setup_script.*'" 2>/dev/null || true)
if echo "$STALE" | grep -q "setup_script"; then
  echo "WARNING: Stale stage/app/setup_script.sql detected. Removing..."
  snow sql -c "$CONN" -q "REMOVE ${STAGE}/app/setup_script.sql"
fi

echo "==> Upgrading application..."
snow sql -c "$CONN" -q \
  "ALTER APPLICATION OPENROUTESERVICE_NATIVE_APP UPGRADE USING $STAGE"

echo "==> Granting account-level privileges to app..."
snow sql -c "$CONN" -q "GRANT CREATE COMPUTE POOL ON ACCOUNT TO APPLICATION OPENROUTESERVICE_NATIVE_APP;" 2>/dev/null || true
snow sql -c "$CONN" -q "GRANT BIND SERVICE ENDPOINT ON ACCOUNT TO APPLICATION OPENROUTESERVICE_NATIVE_APP;" 2>/dev/null || true

echo "==> Creating network rules and External Access Integrations..."
snow sql -c "$CONN" -q "
CREATE OR REPLACE NETWORK RULE ORS_OSM_NETWORK_RULE
  TYPE = HOST_PORT  MODE = EGRESS
  VALUE_LIST = ('0.0.0.0:443','0.0.0.0:80','snowflakecomputing.com','download.bbbike.org:443','download.geofabrik.de:443')
  COMMENT = '{\"origin\":\"sf_sit-is-fleet\",\"name\":\"oss-build-routing-solution\",\"version\":{\"major\":1,\"minor\":0},\"attributes\":{\"is_quickstart\":1,\"source\":\"sql\"}}';
"
snow sql -c "$CONN" -q "
CREATE OR REPLACE NETWORK RULE ORS_CARTO_NETWORK_RULE
  TYPE = HOST_PORT  MODE = EGRESS
  VALUE_LIST = ('a.basemaps.cartocdn.com:443','b.basemaps.cartocdn.com:443','c.basemaps.cartocdn.com:443','d.basemaps.cartocdn.com:443')
  COMMENT = '{\"origin\":\"sf_sit-is-fleet\",\"name\":\"oss-build-routing-solution\",\"version\":{\"major\":1,\"minor\":0},\"attributes\":{\"is_quickstart\":1,\"source\":\"sql\"}}';
"
snow sql -c "$CONN" -q "
CREATE OR REPLACE EXTERNAL ACCESS INTEGRATION ORS_OSM_EAI
  ALLOWED_NETWORK_RULES = (ORS_OSM_NETWORK_RULE)  ENABLED = TRUE
  COMMENT = '{\"origin\":\"sf_sit-is-fleet\",\"name\":\"oss-build-routing-solution\",\"version\":{\"major\":1,\"minor\":0},\"attributes\":{\"is_quickstart\":1,\"source\":\"sql\"}}';
"
snow sql -c "$CONN" -q "
CREATE OR REPLACE EXTERNAL ACCESS INTEGRATION ORS_CARTO_EAI
  ALLOWED_NETWORK_RULES = (ORS_CARTO_NETWORK_RULE)  ENABLED = TRUE
  COMMENT = '{\"origin\":\"sf_sit-is-fleet\",\"name\":\"oss-build-routing-solution\",\"version\":{\"major\":1,\"minor\":0},\"attributes\":{\"is_quickstart\":1,\"source\":\"sql\"}}';
"

echo "==> Granting USAGE on EAIs and binding references..."
snow sql -c "$CONN" -q "GRANT USAGE ON INTEGRATION ORS_OSM_EAI TO APPLICATION OPENROUTESERVICE_NATIVE_APP;"
snow sql -c "$CONN" -q "GRANT USAGE ON INTEGRATION ORS_CARTO_EAI TO APPLICATION OPENROUTESERVICE_NATIVE_APP;"
snow sql -c "$CONN" -q "
CALL OPENROUTESERVICE_NATIVE_APP.CORE.REGISTER_SINGLE_CALLBACK(
  'external_access_integration_ref', 'ADD',
  SYSTEM\$REFERENCE('EXTERNAL ACCESS INTEGRATION', 'ORS_OSM_EAI', 'PERSISTENT', 'USAGE'));
"
snow sql -c "$CONN" -q "
CALL OPENROUTESERVICE_NATIVE_APP.CORE.REGISTER_SINGLE_CALLBACK(
  'external_access_carto_ref', 'ADD',
  SYSTEM\$REFERENCE('EXTERNAL ACCESS INTEGRATION', 'ORS_CARTO_EAI', 'PERSISTENT', 'USAGE'));
"

echo "==> Triggering grant_callback (deploys compute pool, services, functions)..."
snow sql -c "$CONN" -q "CALL OPENROUTESERVICE_NATIVE_APP.CORE.GRANT_CALLBACK(ARRAY_CONSTRUCT('CREATE COMPUTE POOL', 'BIND SERVICE ENDPOINT'));"

echo "==> Granting access to FLEET_INTELLIGENCE (projection views, presets, jobs)..."
snow sql -c "$CONN" -q "GRANT USAGE ON DATABASE FLEET_INTELLIGENCE TO APPLICATION OPENROUTESERVICE_NATIVE_APP;"
snow sql -c "$CONN" -q "GRANT USAGE ON ALL SCHEMAS IN DATABASE FLEET_INTELLIGENCE TO APPLICATION OPENROUTESERVICE_NATIVE_APP;"
snow sql -c "$CONN" -q "GRANT SELECT ON ALL TABLES IN DATABASE FLEET_INTELLIGENCE TO APPLICATION OPENROUTESERVICE_NATIVE_APP;"
snow sql -c "$CONN" -q "GRANT SELECT ON ALL VIEWS IN DATABASE FLEET_INTELLIGENCE TO APPLICATION OPENROUTESERVICE_NATIVE_APP;"

echo "==> Granting access to SYNTHETIC_DATASETS (Data Studio unified tables)..."
snow sql -c "$CONN" -q "GRANT USAGE ON DATABASE SYNTHETIC_DATASETS TO APPLICATION OPENROUTESERVICE_NATIVE_APP;"
snow sql -c "$CONN" -q "GRANT USAGE ON SCHEMA SYNTHETIC_DATASETS.UNIFIED TO APPLICATION OPENROUTESERVICE_NATIVE_APP;"
snow sql -c "$CONN" -q "GRANT CREATE TABLE ON SCHEMA SYNTHETIC_DATASETS.UNIFIED TO APPLICATION OPENROUTESERVICE_NATIVE_APP;"
snow sql -c "$CONN" -q "GRANT SELECT ON ALL TABLES IN SCHEMA SYNTHETIC_DATASETS.UNIFIED TO APPLICATION OPENROUTESERVICE_NATIVE_APP;"
snow sql -c "$CONN" -q "GRANT INSERT ON ALL TABLES IN SCHEMA SYNTHETIC_DATASETS.UNIFIED TO APPLICATION OPENROUTESERVICE_NATIVE_APP;"
snow sql -c "$CONN" -q "GRANT UPDATE ON ALL TABLES IN SCHEMA SYNTHETIC_DATASETS.UNIFIED TO APPLICATION OPENROUTESERVICE_NATIVE_APP;"
snow sql -c "$CONN" -q "GRANT DELETE ON ALL TABLES IN SCHEMA SYNTHETIC_DATASETS.UNIFIED TO APPLICATION OPENROUTESERVICE_NATIVE_APP;"
snow sql -c "$CONN" -q "GRANT SELECT ON ALL VIEWS IN SCHEMA SYNTHETIC_DATASETS.UNIFIED TO APPLICATION OPENROUTESERVICE_NATIVE_APP;"
snow sql -c "$CONN" -q "GRANT CREATE TABLE ON SCHEMA FLEET_INTELLIGENCE.CORE TO APPLICATION OPENROUTESERVICE_NATIVE_APP;"
snow sql -c "$CONN" -q "GRANT INSERT ON ALL TABLES IN SCHEMA FLEET_INTELLIGENCE.CORE TO APPLICATION OPENROUTESERVICE_NATIVE_APP;"
snow sql -c "$CONN" -q "GRANT UPDATE ON ALL TABLES IN SCHEMA FLEET_INTELLIGENCE.CORE TO APPLICATION OPENROUTESERVICE_NATIVE_APP;"
snow sql -c "$CONN" -q "GRANT DELETE ON ALL TABLES IN SCHEMA FLEET_INTELLIGENCE.CORE TO APPLICATION OPENROUTESERVICE_NATIVE_APP;"

echo "==> Granting access to OVERTURE_MAPS__PLACES (Overture Maps POI data share)..."
snow sql -c "$CONN" -q "GRANT IMPORTED PRIVILEGES ON DATABASE OVERTURE_MAPS__PLACES TO APPLICATION OPENROUTESERVICE_NATIVE_APP;" 2>/dev/null || echo "  (Overture Maps share not available -- Data Studio POIs will fail)"

echo "==> Checking for ACCOUNTADMIN-owned objects..."
ACCT_OBJS=$(snow sql -c "$CONN" --format json -q "
  SELECT 'ACCT_OWN: ' || procedure_name || argument_signature AS obj
  FROM OPENROUTESERVICE_NATIVE_APP.INFORMATION_SCHEMA.PROCEDURES
  WHERE procedure_owner = 'ACCOUNTADMIN'
  UNION ALL
  SELECT 'ACCT_OWN: ' || table_schema || '.' || table_name
  FROM OPENROUTESERVICE_NATIVE_APP.INFORMATION_SCHEMA.TABLES
  WHERE table_owner = 'ACCOUNTADMIN'
" 2>/dev/null || true)

if echo "$ACCT_OBJS" | grep -q '"OBJ"'; then
  echo "WARNING: ACCOUNTADMIN-owned objects found after upgrade:"
  echo "$ACCT_OBJS"
  echo "These are invisible to the app context. Drop them manually."
  exit 1
else
  echo "OK: No ACCOUNTADMIN-owned objects."
fi

echo "==> Deployment complete."
