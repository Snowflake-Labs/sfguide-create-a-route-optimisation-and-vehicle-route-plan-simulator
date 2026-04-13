#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
YAML="$SCRIPT_DIR/ors_control_app_service.yaml"
REPO_URL=$(snow spcs image-repository url openrouteservice_setup.public.image_repository -c <connection>)
IMAGE_NAME="ors_control_app"
SERVICE="OPENROUTESERVICE_NATIVE_APP.CORE.ORS_CONTROL_APP"
PKG_STAGE="@OPENROUTESERVICE_NATIVE_APP_PKG.APP_SRC.STAGE"

MANIFEST="$SCRIPT_DIR/../../app/manifest.yml"
BUILD_MD="$SCRIPT_DIR/../../../references/build-images.md"
SKILL_MD="$SCRIPT_DIR/../../../SKILL.md"
README_MD="$SCRIPT_DIR/../../../../../../README.md"
GUIDELINES_MD="$SCRIPT_DIR/../../../references/snowflake-scripting-guidelines.md"
VERSION_FILE="$SCRIPT_DIR/../../image-versions.env"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -c|--connection) CONNECTION="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

source "$VERSION_FILE"
CURRENT_TAG="${ORS_CONTROL_APP_TAG#v}"
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_TAG"
PATCH=$((PATCH + 1))
NEW_TAG="v${MAJOR}.${MINOR}.${PATCH}"
FULL_IMAGE="${REPO_URL}/${IMAGE_NAME}:${NEW_TAG}"

echo "=== Deploying ${IMAGE_NAME}:${NEW_TAG} (was v${CURRENT_TAG}) ==="
echo "    Image: ${FULL_IMAGE}"

echo "--- [1/7] Building client + server ---"
cd "$SCRIPT_DIR"
npm run build
npm run build:server

echo "--- [2/7] Docker build (linux/amd64, runtime-only) ---"
mv .dockerignore .dockerignore.bak 2>/dev/null || true
VERSION_NUM="${NEW_TAG#v}"
docker build --platform linux/amd64 --build-arg APP_VERSION="${VERSION_NUM}" -f Dockerfile.runtime -t "${FULL_IMAGE}" .
mv .dockerignore.bak .dockerignore 2>/dev/null || true

echo "--- [3/7] Docker push ---"
snow spcs image-registry login -c "<connection>"
docker push "${FULL_IMAGE}"

echo "--- [4/7] Update version in all tracked files ---"
sed -i.bak "s|ORS_CONTROL_APP_TAG=v${CURRENT_TAG}|ORS_CONTROL_APP_TAG=${NEW_TAG}|" "$VERSION_FILE" && rm -f "${VERSION_FILE}.bak"
sed -i.bak "s|${IMAGE_NAME}:v${CURRENT_TAG}|${IMAGE_NAME}:${NEW_TAG}|" "$YAML" && rm -f "${YAML}.bak"
sed -i.bak "s|APP_VERSION: \"${CURRENT_TAG}\"|APP_VERSION: \"${VERSION_NUM}\"|" "$YAML" && rm -f "${YAML}.bak"
for f in "$MANIFEST" "$BUILD_MD" "$SKILL_MD" "$README_MD" "$GUIDELINES_MD"; do
  [ -f "$f" ] && sed -i.bak "s|${IMAGE_NAME}:v${CURRENT_TAG}|${IMAGE_NAME}:${NEW_TAG}|g" "$f" && rm -f "${f}.bak"
done
for f in "$BUILD_MD" "$SKILL_MD"; do
  [ -f "$f" ] && sed -i.bak "s|${IMAGE_NAME} (v${CURRENT_TAG})|${IMAGE_NAME} (${NEW_TAG})|g" "$f" && rm -f "${f}.bak"
done
for f in "$BUILD_MD" "$GUIDELINES_MD"; do
  [ -f "$f" ] && sed -i.bak "s/${IMAGE_NAME} | v${CURRENT_TAG} /${IMAGE_NAME} | ${NEW_TAG} /g" "$f" && rm -f "${f}.bak"
done

echo "--- [5/7] Upload YAML + manifest to package stage (prevents version_init revert) ---"
snow sql -c "<connection>" -q "PUT 'file://${YAML}' ${PKG_STAGE}/services/ors_control_app/ OVERWRITE=TRUE AUTO_COMPRESS=FALSE;"
snow sql -c "<connection>" -q "PUT 'file://${MANIFEST}' ${PKG_STAGE}/ OVERWRITE=TRUE AUTO_COMPRESS=FALSE;"

echo "--- [6/7] Upgrade native app (triggers version_init -> create_control_app) ---"
snow sql -c "<connection>" -q "ALTER APPLICATION OPENROUTESERVICE_NATIVE_APP UPGRADE USING ${PKG_STAGE};"

echo "--- [6.5/7] Ensuring Overture Maps access ---"
snow sql -c "<connection>" -q "GRANT IMPORTED PRIVILEGES ON DATABASE OVERTURE_MAPS__PLACES TO APPLICATION OPENROUTESERVICE_NATIVE_APP;" 2>/dev/null || echo "  (Overture Maps share not available -- Data Studio POIs will fail)"

echo "--- [6.6/7] Refreshing grants on FLEET_INTELLIGENCE & SYNTHETIC_DATASETS ---"
snow sql -c "<connection>" -q "GRANT USAGE ON DATABASE FLEET_INTELLIGENCE TO APPLICATION OPENROUTESERVICE_NATIVE_APP;" 2>/dev/null || true
snow sql -c "<connection>" -q "GRANT USAGE ON ALL SCHEMAS IN DATABASE FLEET_INTELLIGENCE TO APPLICATION OPENROUTESERVICE_NATIVE_APP;" 2>/dev/null || true
snow sql -c "<connection>" -q "GRANT SELECT ON ALL TABLES IN DATABASE FLEET_INTELLIGENCE TO APPLICATION OPENROUTESERVICE_NATIVE_APP;" 2>/dev/null || true
snow sql -c "<connection>" -q "GRANT SELECT ON ALL VIEWS IN DATABASE FLEET_INTELLIGENCE TO APPLICATION OPENROUTESERVICE_NATIVE_APP;" 2>/dev/null || true
snow sql -c "<connection>" -q "GRANT USAGE ON DATABASE SYNTHETIC_DATASETS TO APPLICATION OPENROUTESERVICE_NATIVE_APP;" 2>/dev/null || true
snow sql -c "<connection>" -q "GRANT USAGE ON SCHEMA SYNTHETIC_DATASETS.UNIFIED TO APPLICATION OPENROUTESERVICE_NATIVE_APP;" 2>/dev/null || true
snow sql -c "<connection>" -q "GRANT CREATE TABLE ON SCHEMA SYNTHETIC_DATASETS.UNIFIED TO APPLICATION OPENROUTESERVICE_NATIVE_APP;" 2>/dev/null || true
snow sql -c "<connection>" -q "GRANT SELECT ON ALL TABLES IN SCHEMA SYNTHETIC_DATASETS.UNIFIED TO APPLICATION OPENROUTESERVICE_NATIVE_APP;" 2>/dev/null || true
snow sql -c "<connection>" -q "GRANT INSERT ON ALL TABLES IN SCHEMA SYNTHETIC_DATASETS.UNIFIED TO APPLICATION OPENROUTESERVICE_NATIVE_APP;" 2>/dev/null || true
snow sql -c "<connection>" -q "GRANT UPDATE ON ALL TABLES IN SCHEMA SYNTHETIC_DATASETS.UNIFIED TO APPLICATION OPENROUTESERVICE_NATIVE_APP;" 2>/dev/null || true
snow sql -c "<connection>" -q "GRANT DELETE ON ALL TABLES IN SCHEMA SYNTHETIC_DATASETS.UNIFIED TO APPLICATION OPENROUTESERVICE_NATIVE_APP;" 2>/dev/null || true
snow sql -c "<connection>" -q "GRANT SELECT ON ALL VIEWS IN SCHEMA SYNTHETIC_DATASETS.UNIFIED TO APPLICATION OPENROUTESERVICE_NATIVE_APP;" 2>/dev/null || true
snow sql -c "<connection>" -q "GRANT CREATE TABLE ON SCHEMA FLEET_INTELLIGENCE.CORE TO APPLICATION OPENROUTESERVICE_NATIVE_APP;" 2>/dev/null || true
snow sql -c "<connection>" -q "GRANT INSERT ON ALL TABLES IN SCHEMA FLEET_INTELLIGENCE.CORE TO APPLICATION OPENROUTESERVICE_NATIVE_APP;" 2>/dev/null || true
snow sql -c "<connection>" -q "GRANT UPDATE ON ALL TABLES IN SCHEMA FLEET_INTELLIGENCE.CORE TO APPLICATION OPENROUTESERVICE_NATIVE_APP;" 2>/dev/null || true
snow sql -c "<connection>" -q "GRANT DELETE ON ALL TABLES IN SCHEMA FLEET_INTELLIGENCE.CORE TO APPLICATION OPENROUTESERVICE_NATIVE_APP;" 2>/dev/null || true

echo "--- [7/7] Waiting for READY + verifying image ---"
STATUS="UNKNOWN"
for i in $(seq 1 30); do
  STATUS=$(snow sql -c "<connection>" -q "SELECT PARSE_JSON(SYSTEM\$GET_SERVICE_STATUS('${SERVICE}'))[0]['status']::VARCHAR AS S;" --format json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['S'])" 2>/dev/null || echo "UNKNOWN")
  if [[ "$STATUS" == "READY" ]]; then
    RUNNING_IMAGE=$(snow sql -c "<connection>" -q "SELECT PARSE_JSON(SYSTEM\$GET_SERVICE_STATUS('${SERVICE}'))[0]['image']::VARCHAR AS I;" --format json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['I'])" 2>/dev/null || echo "UNKNOWN")
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
