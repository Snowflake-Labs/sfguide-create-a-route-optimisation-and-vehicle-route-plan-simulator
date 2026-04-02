#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NATIVE_APP_DIR="$SCRIPT_DIR"
CONNECTION="fleet_test_evals"
IMAGE_NAME="demo-dashboard"
IMAGE_TAG="v1.0.0"
SETUP_DB="DEMO_DASHBOARD_SETUP"
REPO_SCHEMA="PUBLIC"
REPO_NAME="DEMO_DASHBOARD_REPO"
APP_PKG="DEMO_DASHBOARD_PKG"
APP_NAME="DEMO_DASHBOARD_APP"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -c|--connection) CONNECTION="$2"; shift 2 ;;
    -t|--tag) IMAGE_TAG="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --skip-push) SKIP_PUSH=1; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

echo "=== Demo Dashboard Deployment ==="
echo "    Connection: ${CONNECTION}"
echo "    Image tag:  ${IMAGE_TAG}"

# Step 1: Get registry URL
echo "--- [1/7] Getting image registry URL ---"
REGISTRY_URL=$(snow spcs image-registry url -c "$CONNECTION" 2>/dev/null | tr -d '[:space:]')
FULL_IMAGE="${REGISTRY_URL}/$(echo "${SETUP_DB}/${REPO_SCHEMA}/${REPO_NAME}" | tr '[:upper:]' '[:lower:]')/${IMAGE_NAME}:${IMAGE_TAG}"
echo "    Registry: ${REGISTRY_URL}"
echo "    Image:    ${FULL_IMAGE}"

# Step 2: Create infrastructure (DB + image repo)
echo "--- [2/7] Creating infrastructure ---"
snow sql -c "$CONNECTION" -q "
CREATE DATABASE IF NOT EXISTS ${SETUP_DB};
CREATE SCHEMA IF NOT EXISTS ${SETUP_DB}.${REPO_SCHEMA};
CREATE IMAGE REPOSITORY IF NOT EXISTS ${SETUP_DB}.${REPO_SCHEMA}.${REPO_NAME};
"

# Step 3: Build Docker image
if [[ -z "${SKIP_BUILD:-}" ]]; then
    echo "--- [3/7] Building Docker image (linux/amd64) ---"
    cd "$APP_DIR"
    docker build --platform linux/amd64 -t "${FULL_IMAGE}" .
else
    echo "--- [3/7] Skipping Docker build ---"
fi

# Step 4: Push to SPCS registry
if [[ -z "${SKIP_PUSH:-}" ]]; then
    echo "--- [4/7] Pushing to SPCS image registry ---"
    snow spcs image-registry login -c "$CONNECTION"
    docker push "${FULL_IMAGE}"
else
    echo "--- [4/7] Skipping Docker push ---"
fi

# Step 5: Update image tag in manifest and service YAML
echo "--- [5/7] Updating image references ---"
sed -i.bak "s|${IMAGE_NAME}:v[0-9]*\.[0-9]*\.[0-9]*|${IMAGE_NAME}:${IMAGE_TAG}|g" \
    "${NATIVE_APP_DIR}/manifest.yml" \
    "${NATIVE_APP_DIR}/services/demo_dashboard_service.yaml"
rm -f "${NATIVE_APP_DIR}/manifest.yml.bak" "${NATIVE_APP_DIR}/services/demo_dashboard_service.yaml.bak"

# Step 6: Deploy via snow app run
echo "--- [6/7] Deploying native app ---"
cd "$NATIVE_APP_DIR"
snow app run -c "$CONNECTION" --no-interactive

# Step 7: Post-install grants
echo "--- [7/7] Running post-install grants ---"
snow sql -c "$CONNECTION" -q "
USE DATABASE ${SETUP_DB};

-- Image repo access
GRANT USAGE ON DATABASE ${SETUP_DB} TO APPLICATION ${APP_NAME};
GRANT USAGE ON SCHEMA ${SETUP_DB}.${REPO_SCHEMA} TO APPLICATION ${APP_NAME};
GRANT READ ON IMAGE REPOSITORY ${SETUP_DB}.${REPO_SCHEMA}.${REPO_NAME} TO APPLICATION ${APP_NAME};

-- Carto map tiles EAI
CREATE OR REPLACE NETWORK RULE ${SETUP_DB}.${REPO_SCHEMA}.demo_dashboard_map_tiles_nr
    MODE = EGRESS TYPE = HOST_PORT
    VALUE_LIST = ('a.basemaps.cartocdn.com:443', 'b.basemaps.cartocdn.com:443', 'c.basemaps.cartocdn.com:443', 'd.basemaps.cartocdn.com:443');
CREATE OR REPLACE EXTERNAL ACCESS INTEGRATION demo_dashboard_map_tiles_eai
    ALLOWED_NETWORK_RULES = (${SETUP_DB}.${REPO_SCHEMA}.demo_dashboard_map_tiles_nr) ENABLED = TRUE;
GRANT USAGE ON INTEGRATION demo_dashboard_map_tiles_eai TO APPLICATION ${APP_NAME};

-- Register EAI reference
CALL ${APP_NAME}.core.register_single_callback(
    'EXTERNAL_ACCESS_REF', 'ADD',
    SYSTEM\$REFERENCE('EXTERNAL ACCESS INTEGRATION', 'DEMO_DASHBOARD_MAP_TILES_EAI', 'PERSISTENT', 'USAGE'));

-- App role
GRANT APPLICATION ROLE ${APP_NAME}.APP_USER TO ROLE ACCOUNTADMIN;

-- Data access: FLEET_INTELLIGENCE database (skill data)
GRANT USAGE ON DATABASE FLEET_INTELLIGENCE TO APPLICATION ${APP_NAME};
GRANT USAGE ON ALL SCHEMAS IN DATABASE FLEET_INTELLIGENCE TO APPLICATION ${APP_NAME};
GRANT SELECT ON ALL TABLES IN DATABASE FLEET_INTELLIGENCE TO APPLICATION ${APP_NAME};
GRANT SELECT ON ALL VIEWS IN DATABASE FLEET_INTELLIGENCE TO APPLICATION ${APP_NAME};

-- Data access: SYNTHETIC_DATASETS (Data Studio unified tables, referenced by projection views)
GRANT USAGE ON DATABASE SYNTHETIC_DATASETS TO APPLICATION ${APP_NAME};
GRANT USAGE ON ALL SCHEMAS IN DATABASE SYNTHETIC_DATASETS TO APPLICATION ${APP_NAME};
GRANT SELECT ON ALL TABLES IN DATABASE SYNTHETIC_DATASETS TO APPLICATION ${APP_NAME};
GRANT SELECT ON ALL VIEWS IN DATABASE SYNTHETIC_DATASETS TO APPLICATION ${APP_NAME};
GRANT USAGE ON AGENT FLEET_INTELLIGENCE.ROUTING_AGENT.ROUTING_AGENT TO APPLICATION ${APP_NAME};
GRANT USAGE ON ALL PROCEDURES IN SCHEMA FLEET_INTELLIGENCE.ROUTING_AGENT TO APPLICATION ${APP_NAME};

-- Cortex Agent API access
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO APPLICATION ${APP_NAME};

-- Routing Agent tool execution warehouse
GRANT USAGE ON WAREHOUSE ROUTING_ANALYTICS TO APPLICATION ${APP_NAME};

-- Data access: ORS app (travel time matrix viewer — granted via APP_USER role)
-- Run manually: GRANT APPLICATION ROLE OPENROUTESERVICE_NATIVE_APP.APP_USER TO APPLICATION ${APP_NAME};

-- Deploy service
CALL ${APP_NAME}.core.deploy();
"

# Get endpoint URL
echo ""
echo "=== Deployment Complete ==="
ENDPOINT=$(snow sql -c "$CONNECTION" -q "CALL ${APP_NAME}.core.get_service_url();" 2>/dev/null | grep -oP 'https://[^\s"]+' || echo "pending...")
echo "    Endpoint: ${ENDPOINT}"
echo ""
echo "Check status: snow sql -c ${CONNECTION} -q \"CALL ${APP_NAME}.core.get_status();\""
