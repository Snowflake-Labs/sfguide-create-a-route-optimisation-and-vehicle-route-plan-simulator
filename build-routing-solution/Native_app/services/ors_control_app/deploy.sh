#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
YAML="$SCRIPT_DIR/ors_control_app_service.yaml"
REGISTRY="pm-fleet-test.registry.snowflakecomputing.com"
REPO="openrouteservice_setup/public/image_repository"
IMAGE_NAME="ors_control_app"
CONNECTION="fleet_test_evals"
SERVICE="OPENROUTESERVICE_NATIVE_APP.CORE.ORS_CONTROL_APP"

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

echo "--- [1/6] Building client + server ---"
cd "$SCRIPT_DIR"
npm run build
npm run build:server

echo "--- [2/6] Docker build (linux/amd64, runtime-only) ---"
mv .dockerignore .dockerignore.bak 2>/dev/null || true
docker build --platform linux/amd64 -f Dockerfile.runtime -t "${FULL_IMAGE}" .
mv .dockerignore.bak .dockerignore 2>/dev/null || true

echo "--- [3/6] Docker push ---"
snow spcs image-registry login -c "$CONNECTION"
docker push "${FULL_IMAGE}"

echo "--- [4/6] ALTER SERVICE (inline spec) ---"
SQL_FILE=$(mktemp /tmp/deploy_spec.XXXXXX.sql)
cat > "$SQL_FILE" <<SPECSQL
ALTER SERVICE ${SERVICE} FROM SPECIFICATION
\$\$
spec:
  containers:
    - name: ors-control-app
      image: /${REPO}/${IMAGE_NAME}:${NEW_TAG}
      env:
        SNOWFLAKE_DATABASE: "OPENROUTESERVICE_NATIVE_APP"
        SNOWFLAKE_WAREHOUSE: "ROUTING_ANALYTICS"
      resources:
        requests:
          cpu: "0.5"
          memory: "512Mi"
        limits:
          cpu: "1"
          memory: "1Gi"
  endpoints:
    - name: ors-control-ui
      port: 3001
      public: true
\$\$;
SPECSQL
snow sql -c "$CONNECTION" -f "$SQL_FILE"
rm -f "$SQL_FILE"

echo "--- [5/6] SUSPEND + RESUME ---"
snow sql -c "$CONNECTION" -q "ALTER SERVICE ${SERVICE} SUSPEND;"
sleep 2
snow sql -c "$CONNECTION" -q "ALTER SERVICE ${SERVICE} RESUME;"

echo "--- [6/6] Waiting for READY ---"
STATUS="UNKNOWN"
for i in $(seq 1 30); do
  STATUS=$(snow sql -c "$CONNECTION" -q "SELECT PARSE_JSON(SYSTEM\$GET_SERVICE_STATUS('${SERVICE}'))[0]['status']::VARCHAR AS S;" --format json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['S'])" 2>/dev/null || echo "UNKNOWN")
  if [[ "$STATUS" == "READY" ]]; then
    echo "Service READY with ${IMAGE_NAME}:${NEW_TAG}"
    break
  fi
  echo "  status: ${STATUS} (attempt ${i}/30)..."
  sleep 3
done

if [[ "$STATUS" != "READY" ]]; then
  echo "WARNING: Service not READY after 90s. Check logs."
  exit 1
fi

sed -i.bak "s|${IMAGE_NAME}:v${CURRENT_TAG}|${IMAGE_NAME}:${NEW_TAG}|" "$YAML" && rm -f "${YAML}.bak"
echo "=== Done. YAML updated to ${NEW_TAG} ==="
