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

echo "==> Granting access to FLEET_INTELLIGENCE (projection views, presets, jobs)..."
snow sql -c "$CONN" -q "GRANT USAGE ON DATABASE FLEET_INTELLIGENCE TO APPLICATION OPENROUTESERVICE_NATIVE_APP;"
snow sql -c "$CONN" -q "GRANT USAGE ON ALL SCHEMAS IN DATABASE FLEET_INTELLIGENCE TO APPLICATION OPENROUTESERVICE_NATIVE_APP;"
snow sql -c "$CONN" -q "GRANT SELECT ON ALL TABLES IN DATABASE FLEET_INTELLIGENCE TO APPLICATION OPENROUTESERVICE_NATIVE_APP;"
snow sql -c "$CONN" -q "GRANT SELECT ON ALL VIEWS IN DATABASE FLEET_INTELLIGENCE TO APPLICATION OPENROUTESERVICE_NATIVE_APP;"

echo "==> Granting access to SYNTHETIC_DATASETS (Data Studio unified tables)..."
snow sql -c "$CONN" -q "GRANT USAGE ON DATABASE SYNTHETIC_DATASETS TO APPLICATION OPENROUTESERVICE_NATIVE_APP;"
snow sql -c "$CONN" -q "GRANT USAGE ON ALL SCHEMAS IN DATABASE SYNTHETIC_DATASETS TO APPLICATION OPENROUTESERVICE_NATIVE_APP;"
snow sql -c "$CONN" -q "GRANT SELECT ON ALL TABLES IN DATABASE SYNTHETIC_DATASETS TO APPLICATION OPENROUTESERVICE_NATIVE_APP;"
snow sql -c "$CONN" -q "GRANT SELECT ON ALL VIEWS IN DATABASE SYNTHETIC_DATASETS TO APPLICATION OPENROUTESERVICE_NATIVE_APP;"

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
