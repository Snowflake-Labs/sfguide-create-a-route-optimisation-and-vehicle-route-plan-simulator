#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
YAML="$SCRIPT_DIR/ors_control_app_service.yaml"
REGISTRY="pm-fleet-test.registry.snowflakecomputing.com"
REPO="openrouteservice_setup/public/image_repository"
IMAGE_NAME="ors_control_app"
CONNECTION="fleet_test_evals"
SERVICE="OPENROUTESERVICE_NATIVE_APP.CORE.ORS_CONTROL_APP"
PKG_STAGE="@OPENROUTESERVICE_NATIVE_APP_PKG.APP_SRC.STAGE"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -c|--connection) CONNECTION="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

CURRENT_TAG=$(sed -n 's/.*ors_control_app:v\([0-9]*\.[0-9]*\.[0-9]*\).*/\1/p' "$YAML")
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_TAG"
PATCH=$((PATCH + 1))
NEW_TAG="v${MAJOR}.${MINOR}.${PATCH}"
FULL_IMAGE="${REGISTRY}/${REPO}/${IMAGE_NAME}:${NEW_TAG}"

echo "=== Deploying ${IMAGE_NAME}:${NEW_TAG} (was v${CURRENT_TAG}) ==="
echo "    Image: ${FULL_IMAGE}"

echo "--- [1/7] Building client + server ---"
cd "$SCRIPT_DIR"
npm run build
npm run build:server

echo "--- [2/7] Docker build (linux/amd64, runtime-only) ---"
mv .dockerignore .dockerignore.bak 2>/dev/null || true
docker build --platform linux/amd64 -f Dockerfile.runtime -t "${FULL_IMAGE}" .
mv .dockerignore.bak .dockerignore 2>/dev/null || true

echo "--- [3/7] Docker push ---"
snow spcs image-registry login -c "$CONNECTION"
docker push "${FULL_IMAGE}"

echo "--- [4/7] Update local YAML ---"
sed -i.bak "s|${IMAGE_NAME}:v${CURRENT_TAG}|${IMAGE_NAME}:${NEW_TAG}|" "$YAML" && rm -f "${YAML}.bak"

echo "--- [5/7] Upload YAML to package stage (prevents version_init revert) ---"
snow sql -c "$CONNECTION" -q "PUT 'file://${YAML}' ${PKG_STAGE}/services/ors_control_app/ OVERWRITE=TRUE AUTO_COMPRESS=FALSE;"

echo "--- [6/7] Upgrade native app (triggers version_init -> create_control_app) ---"
snow sql -c "$CONNECTION" -q "ALTER APPLICATION OPENROUTESERVICE_NATIVE_APP UPGRADE USING ${PKG_STAGE};"

echo "--- [6.5/7] Ensuring Overture Maps access ---"
snow sql -c "$CONNECTION" -q "GRANT IMPORTED PRIVILEGES ON DATABASE OVERTURE_MAPS__PLACES TO APPLICATION OPENROUTESERVICE_NATIVE_APP;" 2>/dev/null || echo "  (Overture Maps share not available -- Data Studio POIs will fail)"

echo "--- [6.6/7] Refreshing grants on FLEET_INTELLIGENCE & SYNTHETIC_DATASETS ---"
snow sql -c "$CONNECTION" -q "GRANT USAGE ON DATABASE FLEET_INTELLIGENCE TO APPLICATION OPENROUTESERVICE_NATIVE_APP;" 2>/dev/null || true
snow sql -c "$CONNECTION" -q "GRANT USAGE ON ALL SCHEMAS IN DATABASE FLEET_INTELLIGENCE TO APPLICATION OPENROUTESERVICE_NATIVE_APP;" 2>/dev/null || true
snow sql -c "$CONNECTION" -q "GRANT SELECT ON ALL TABLES IN DATABASE FLEET_INTELLIGENCE TO APPLICATION OPENROUTESERVICE_NATIVE_APP;" 2>/dev/null || true
snow sql -c "$CONNECTION" -q "GRANT SELECT ON ALL VIEWS IN DATABASE FLEET_INTELLIGENCE TO APPLICATION OPENROUTESERVICE_NATIVE_APP;" 2>/dev/null || true
snow sql -c "$CONNECTION" -q "GRANT USAGE ON DATABASE SYNTHETIC_DATASETS TO APPLICATION OPENROUTESERVICE_NATIVE_APP;" 2>/dev/null || true
snow sql -c "$CONNECTION" -q "GRANT USAGE ON ALL SCHEMAS IN DATABASE SYNTHETIC_DATASETS TO APPLICATION OPENROUTESERVICE_NATIVE_APP;" 2>/dev/null || true
snow sql -c "$CONNECTION" -q "GRANT SELECT ON ALL TABLES IN DATABASE SYNTHETIC_DATASETS TO APPLICATION OPENROUTESERVICE_NATIVE_APP;" 2>/dev/null || true
snow sql -c "$CONNECTION" -q "GRANT SELECT ON ALL VIEWS IN DATABASE SYNTHETIC_DATASETS TO APPLICATION OPENROUTESERVICE_NATIVE_APP;" 2>/dev/null || true

echo "--- [7/7] Waiting for READY + verifying image ---"
STATUS="UNKNOWN"
for i in $(seq 1 30); do
  STATUS=$(snow sql -c "$CONNECTION" -q "SELECT PARSE_JSON(SYSTEM\$GET_SERVICE_STATUS('${SERVICE}'))[0]['status']::VARCHAR AS S;" --format json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['S'])" 2>/dev/null || echo "UNKNOWN")
  if [[ "$STATUS" == "READY" ]]; then
    RUNNING_IMAGE=$(snow sql -c "$CONNECTION" -q "SELECT PARSE_JSON(SYSTEM\$GET_SERVICE_STATUS('${SERVICE}'))[0]['image']::VARCHAR AS I;" --format json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['I'])" 2>/dev/null || echo "UNKNOWN")
    echo "Service READY"
    echo "  Running image: ${RUNNING_IMAGE}"
    if [[ "$RUNNING_IMAGE" == *"${NEW_TAG}"* ]]; then
      echo "  Image tag verified: ${NEW_TAG}"
    else
      echo "  WARNING: Expected ${NEW_TAG} but got ${RUNNING_IMAGE}"
    fi
    break
  fi
  echo "  status: ${STATUS} (attempt ${i}/30)..."
  sleep 3
done

if [[ "$STATUS" != "READY" ]]; then
  echo "WARNING: Service not READY after 90s. Check logs."
  exit 1
fi

echo "=== Done. Deployed ${IMAGE_NAME}:${NEW_TAG} ==="
