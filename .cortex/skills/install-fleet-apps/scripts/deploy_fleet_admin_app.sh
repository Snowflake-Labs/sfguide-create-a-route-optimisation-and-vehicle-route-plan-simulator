#!/usr/bin/env bash
#
# install-fleet-apps / deploy_fleet_admin_app.sh
#
# One-command deploy for the Routing Platform Admin/Build console (FLEET_ADMIN_APP)
# on SPCS. Sibling to deploy_fleet_sa_app.sh; the admin app lives under
# fleet_admin_app/ with the same prebuilt-.next Docker build, but NO app-config
# bundle (it is a build console, not the agent-first SA host). Mirrors the proven
# flow: build -> push -> render spec -> CREATE/ALTER SERVICE -> set EAI -> URL.
#
# Usage:
#   bash .cortex/skills/install-fleet-apps/scripts/deploy_fleet_admin_app.sh [connection]
#
# Default connection: fleet_test_evals
#
# Env overrides:
#   ALLOW_DIRTY=1   - allow deploying with uncommitted changes (default: refused)
#   SKIP_IMAGE=1    - skip image build/push (just rotate service)
#   SKIP_SERVICE=1  - skip the CREATE/ALTER SERVICE cycle
#   IMAGE_TAG=<tag> - override the tag (default: FLEET_ADMIN_APP_TAG from image-versions.env)
#   COMPUTE_POOL=<name> - override the compute pool (default: OPENROUTESERVICE_APP_COMPUTE_POOL)
set -euo pipefail

CONNECTION=${1:-fleet_test_evals}
REPO_ROOT=$(git rev-parse --show-toplevel)
SKILL_DIR="$REPO_ROOT/.cortex/skills/install-fleet-apps"
APP_DIR="$SKILL_DIR/fleet_admin_app"
UI_DIR="$APP_DIR/ui"
SERVICE_YAML="$APP_DIR/fleet_admin_app_service.yaml"
VERSION_FILE="$SKILL_DIR/image-versions.env"
GIT_SHA=$(git rev-parse --short HEAD)
GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD)

SERVICE_FQN="FLEET_INTELLIGENCE.SYNAPSE_USER.FLEET_ADMIN_APP"
# Infra names are resolved by install_fleet_apps.sh (reuse OPENROUTESERVICE_APP
# else FLEET-owned) and passed in via env; defaults preserve standalone use.
SPEC_STAGE_NAME="${SPEC_STAGE_NAME:-OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE}"
SPEC_STAGE="@${SPEC_STAGE_NAME}/services/fleet_admin_app"
IMAGE_REPO_SQL_NAME="${IMAGE_REPO_SQL_NAME:-OPENROUTESERVICE_APP.core.image_repository}"
CARTO_EAI="${CARTO_EAI:-ORS_CARTO_EAI}"
# OSM catalog egress (geofabrik + bbbike) for Region Builder "Refresh Catalog".
# Resolved by install_fleet_apps.sh (reuse ORS_OSM_EAI else FLEET_APP_OSM_EAI);
# default preserves standalone use. The legacy control app ran with BOTH the
# carto EAI and this OSM EAI attached.
OSM_EAI="${OSM_EAI:-ORS_OSM_EAI}"
COMPUTE_POOL="${COMPUTE_POOL:-OPENROUTESERVICE_APP_COMPUTE_POOL}"

# ── 0. Pre-flight ───────────────────────────────────────────────
echo "[0/7] Pre-flight checks..."

if [ -n "$(git status --porcelain)" ] && [ "${ALLOW_DIRTY:-0}" != "1" ]; then
  echo "ERROR: working tree has uncommitted changes. Commit, stash, or set ALLOW_DIRTY=1."
  git status --short
  exit 1
fi

for tool in snow docker node npm; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: '$tool' not found."; exit 1; }
done

# shellcheck disable=SC1090
source "$VERSION_FILE"
IMAGE_TAG="${IMAGE_TAG:-${FLEET_ADMIN_APP_TAG:?FLEET_ADMIN_APP_TAG missing from image-versions.env}}"

if ! grep -qF "fleet_admin_app:${IMAGE_TAG}" "$SERVICE_YAML"; then
  echo "ERROR: $SERVICE_YAML does not reference fleet_admin_app:${IMAGE_TAG}"
  echo "       Update image-versions.env (FLEET_ADMIN_APP_TAG) and the service YAML to match."
  exit 1
fi

echo "  branch=$GIT_BRANCH  sha=$GIT_SHA  tag=$IMAGE_TAG  pool=$COMPUTE_POOL  connection=$CONNECTION"

# ── 1. Build the Next.js standalone bundle (prebuilt-.next Docker path) ──
if [ "${SKIP_IMAGE:-0}" != "1" ]; then
  echo "[1/7] Build Next.js standalone (npm ci + npm run build)..."
  ( cd "$UI_DIR" && { [ -d node_modules ] || npm ci; } && npm run build ) \
    > /tmp/fleet_admin_build.log 2>&1 || { echo "ERROR: next build failed"; tail -40 /tmp/fleet_admin_build.log; exit 1; }

  echo "[2/7] Login to SPCS image registry..."
  snow spcs image-registry login -c "$CONNECTION" >/dev/null
  REPO_URL=$(snow spcs image-repository url "$IMAGE_REPO_SQL_NAME" -c "$CONNECTION")
  echo "  registry=$REPO_URL"

  echo "[3/7] Docker build (prebuilt .next) + push tag=$IMAGE_TAG..."
  docker build --platform linux/amd64 \
    --label "git.sha=$GIT_SHA" --label "git.branch=$GIT_BRANCH" \
    -f "$UI_DIR/Dockerfile" \
    -t "$REPO_URL/fleet_admin_app:$IMAGE_TAG" \
    "$UI_DIR" > /tmp/fleet_admin_docker.log 2>&1 || { echo "ERROR: docker build failed"; tail -40 /tmp/fleet_admin_docker.log; exit 1; }
  # Prefer crane for the SPCS push: plain `docker push` intermittently hangs on the
  # final manifest/blob commit ("timeout awaiting response headers") when the bearer
  # token expires mid-upload; crane commits reliably. Mirrors provision_engine.sh.
  # Falls back to `docker push` if crane is absent or the crane path errors.
  if command -v crane >/dev/null 2>&1 && [ "${USE_CRANE_PUSH:-1}" = "1" ]; then
    snow spcs image-registry login -c "$CONNECTION" >/dev/null 2>&1 || true
    _tar="$(mktemp -t fleetadminimg.XXXXXX).tar"
    if docker save "$REPO_URL/fleet_admin_app:$IMAGE_TAG" -o "$_tar" \
       && crane push "$_tar" "$REPO_URL/fleet_admin_app:$IMAGE_TAG" >/tmp/fleet_admin_push.log 2>&1; then
      rm -f "$_tar"
    else
      rm -f "$_tar"
      echo "  crane push failed; falling back to 'docker push' (see /tmp/fleet_admin_push.log)"
      docker push "$REPO_URL/fleet_admin_app:$IMAGE_TAG" >/tmp/fleet_admin_push.log 2>&1 || { echo "ERROR: docker push failed"; tail -30 /tmp/fleet_admin_push.log; exit 1; }
    fi
  else
    docker push "$REPO_URL/fleet_admin_app:$IMAGE_TAG" >/tmp/fleet_admin_push.log 2>&1 || { echo "ERROR: docker push failed"; tail -30 /tmp/fleet_admin_push.log; exit 1; }
  fi
else
  echo "[1-3/7] SKIP_IMAGE=1, skipping build/push."
fi

# ── 2. Render service spec with the tag and (create or) rotate the service ──
if [ "${SKIP_SERVICE:-0}" != "1" ]; then
  echo "[4/7] Render service spec with tag $IMAGE_TAG + upload to $SPEC_STAGE ..."
  STAGE_DIR=$(mktemp -d); trap 'rm -rf "$STAGE_DIR"' EXIT
  STAGE_YAML="$STAGE_DIR/fleet_admin_app_service.yaml"
  # Derive the spec image-path prefix from the RESOLVED image repo (see SA deploy
  # script for rationale): on a from-scratch engine run infra resolves to the
  # FLEET-owned repo first, so the hardcoded /openrouteservice_app/... path must be
  # rewritten to match where the image was actually pushed. Lowercase, '.'->'/'.
  IMAGE_REPO_PATH="/$(printf '%s' "$IMAGE_REPO_SQL_NAME" | tr '[:upper:]' '[:lower:]' | tr '.' '/')"
  sed -E \
    -e "s|(image:[[:space:]]*)[^[:space:]]*/fleet_admin_app:|\1${IMAGE_REPO_PATH}/fleet_admin_app:|" \
    -e "s|(fleet_admin_app:)[^\"' ]+|\1$IMAGE_TAG|" \
    "$SERVICE_YAML" > "$STAGE_YAML"
  # Defense-in-depth: the rendered spec MUST reference the resolved repo + tag.
  # Surfaces any future regression of the path/tag rewrite as a loud error HERE
  # instead of an opaque "Image ... not found" at CREATE SERVICE.
  EXPECT_IMG="${IMAGE_REPO_PATH}/fleet_admin_app:$IMAGE_TAG"
  if ! grep -qF "$EXPECT_IMG" "$STAGE_YAML"; then
    echo "ERROR: rendered spec does not reference expected image $EXPECT_IMG"
    grep -nE 'image:' "$STAGE_YAML" || true
    exit 1
  fi
  # ROUTING_ANALYTICS is ensured alongside the spec stage: the service spec sets
  # SNOWFLAKE_WAREHOUSE=ROUTING_ANALYTICS and every admin-app query runs on it, so a
  # missing warehouse means the service deploys fine and then fails every query.
  # The engine/seed/analytic scripts create it too, but any of them can be skipped.
  snow sql -c "$CONNECTION" -q "ALTER SESSION SET query_tag = '{\"origin\":\"sf_sit-is-fleet\",\"name\":\"oss-install-fleet-apps\",\"version\":{\"major\":1,\"minor\":0},\"attributes\":{\"is_quickstart\":1,\"source\":\"app\"}}'; CREATE WAREHOUSE IF NOT EXISTS ROUTING_ANALYTICS WAREHOUSE_SIZE = XSMALL AUTO_SUSPEND = 600 AUTO_RESUME = TRUE COMMENT = '{\"origin\":\"sf_sit-is-fleet\",\"name\":\"oss-install-fleet-apps\",\"version\":{\"major\":1,\"minor\":0},\"attributes\":{\"is_quickstart\":1,\"source\":\"app\",\"component\":\"core\"}}'; CREATE STAGE IF NOT EXISTS $SPEC_STAGE_NAME COMMENT = '{\"origin\":\"sf_sit-is-fleet\",\"name\":\"oss-install-fleet-apps\",\"version\":{\"major\":1,\"minor\":0},\"attributes\":{\"is_quickstart\":1,\"source\":\"app\"}}';" >/dev/null 2>&1 || true
  snow stage copy "$STAGE_YAML" "$SPEC_STAGE/" -c "$CONNECTION" --overwrite >/dev/null

  echo "[5/7] CREATE SERVICE IF NOT EXISTS (first deploy) ..."
  snow sql -c "$CONNECTION" -q "
    ALTER SESSION SET query_tag = '{\"origin\":\"sf_sit-is-fleet\",\"name\":\"oss-install-fleet-apps\",\"version\":{\"major\":1,\"minor\":0},\"attributes\":{\"is_quickstart\":1,\"source\":\"app\"}}';
    CREATE SERVICE IF NOT EXISTS $SERVICE_FQN
      IN COMPUTE POOL $COMPUTE_POOL
      FROM ${SPEC_STAGE}
      SPECIFICATION_FILE = 'fleet_admin_app_service.yaml'
      COMMENT = '{\"origin\":\"sf_sit-is-fleet\",\"name\":\"oss-install-fleet-apps\",\"version\":{\"major\":1,\"minor\":0},\"attributes\":{\"is_quickstart\":1,\"source\":\"app\"}}';
  " >/tmp/fleet_admin_create.log 2>&1 || { echo "ERROR: create service failed"; tail -30 /tmp/fleet_admin_create.log; exit 1; }

  echo "[6/7] SUSPEND -> ALTER FROM SPEC -> set EAI -> RESUME..."
  snow sql -c "$CONNECTION" -q "
    ALTER SESSION SET query_tag = '{\"origin\":\"sf_sit-is-fleet\",\"name\":\"oss-install-fleet-apps\",\"version\":{\"major\":1,\"minor\":0},\"attributes\":{\"is_quickstart\":1,\"source\":\"app\"}}';
    ALTER SERVICE IF EXISTS $SERVICE_FQN SUSPEND;
    ALTER SERVICE $SERVICE_FQN
      FROM ${SPEC_STAGE}
      SPECIFICATION_FILE = 'fleet_admin_app_service.yaml';
    ALTER SERVICE $SERVICE_FQN SET EXTERNAL_ACCESS_INTEGRATIONS = ($CARTO_EAI, $OSM_EAI);
    ALTER SERVICE $SERVICE_FQN RESUME;
  " >/tmp/fleet_admin_alter.log 2>&1 || { echo "ERROR: service alter failed"; tail -30 /tmp/fleet_admin_alter.log; exit 1; }

  # Endpoint (ingress) access - see the same block in deploy_fleet_sa_app.sh. USAGE
  # on the SERVICE OBJECT is what lets a role open the app in a browser; it is
  # separate from data grants and is silently dropped by a service recreate, so it is
  # re-applied on every deploy. The admin console is deliberately narrower than the
  # SA app: OPS and ADMIN only, no FLEET_APP_USER.
  for grant_role in FLEET_APP_OPS FLEET_APP_ADMIN; do
    snow sql -c "$CONNECTION" -q "
      ALTER SESSION SET query_tag = '{\"origin\":\"sf_sit-is-fleet\",\"name\":\"oss-install-fleet-apps\",\"version\":{\"major\":1,\"minor\":0},\"attributes\":{\"is_quickstart\":1,\"source\":\"app\"}}';
      GRANT USAGE ON DATABASE ${SERVICE_FQN%%.*} TO ROLE $grant_role;
      GRANT USAGE ON SCHEMA ${SERVICE_FQN%.*} TO ROLE $grant_role;
      GRANT USAGE ON SERVICE $SERVICE_FQN TO ROLE $grant_role;
    " >/tmp/fleet_admin_grant_${grant_role}.log 2>&1 \
      && echo "  [grant] $grant_role: USAGE on service endpoint" \
      || echo "  [grant] $grant_role: WARN (not granted; role may not exist yet - see /tmp/fleet_admin_grant_${grant_role}.log)"
  done
else
  echo "[4-6/7] SKIP_SERVICE=1, skipping service rotate."
fi

# ── 3. Resolve endpoint URL ─────────────────────────────────────
echo "[7/7] Resolve endpoint URL..."
URL=$(snow sql -c "$CONNECTION" --format=CSV -q "
  SHOW ENDPOINTS IN SERVICE $SERVICE_FQN;
  SELECT 'https://' || \"ingress_url\"
  FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
  WHERE \"name\" = 'fleet-admin-app';
" 2>/dev/null | grep -E '^https://' | head -1 || true)

echo
echo "================================================================"
echo " Fleet Admin console deploy complete."
echo "   image: fleet_admin_app:$IMAGE_TAG"
echo "   branch: $GIT_BRANCH ($GIT_SHA)"
[ -n "$URL" ] && echo "   url:   $URL"
echo "================================================================"
