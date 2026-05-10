#!/usr/bin/env bash
#
# build-routing-solution / deploy.sh
#
# One-command deploy for the ORS Control App + supporting SQL on SPCS.
# Replaces the ~12-step manual choreography (registry login, image build,
# image push, YAML edit, stage upload, suspend/alter/resume, endpoint
# lookup) with a single idempotent run.
#
# Usage:
#   bash .cortex/skills/build-routing-solution/scripts/deploy.sh [connection]
#
# Default connection: fleet_test_evals
#
# Env overrides:
#   ALLOW_DIRTY=1     - allow deploying with uncommitted changes (default: refused)
#   SKIP_SQL=1        - skip SQL module deployment
#   SKIP_IMAGE=1      - skip image build/push
#   SKIP_SERVICE=1    - skip ALTER SERVICE cycle
#   IMAGE_TAG=<tag>   - override auto-generated tag (default: v1.0.<n>+<git_sha>)
#
set -euo pipefail

CONNECTION=${1:-fleet_test_evals}
REPO_ROOT=$(git rev-parse --show-toplevel)
SKILL_DIR="$REPO_ROOT/.cortex/skills/build-routing-solution"
APP_DIR="$SKILL_DIR/openrouteservice_app/services/ors_control_app"
MODULES_DIR="$SKILL_DIR/openrouteservice_app/app/modules"
GIT_SHA=$(git rev-parse --short HEAD)
GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD)

# ── 0. Pre-flight checks ────────────────────────────────────────
echo "[0/8] Pre-flight checks..."

if [ -n "$(git status --porcelain)" ] && [ "${ALLOW_DIRTY:-0}" != "1" ]; then
  echo "ERROR: working tree has uncommitted changes."
  echo "       Commit, stash, or set ALLOW_DIRTY=1 to override."
  git status --short
  exit 1
fi

if ! command -v snow >/dev/null 2>&1; then
  echo "ERROR: 'snow' CLI not found. Install snowflake-cli first."
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: 'docker' not found."
  exit 1
fi

# Auto-derive tag from current YAML version + git SHA so the image tag
# always pins to a specific commit. Bypass with IMAGE_TAG=<tag>.
if [ -z "${IMAGE_TAG:-}" ]; then
  CURRENT_TAG=$(grep -oE 'ors_control_app:v[0-9.]+' "$APP_DIR/ors_control_app_service.yaml" | head -1 | sed 's/.*://')
  IMAGE_TAG="${CURRENT_TAG}-${GIT_SHA}"
fi

echo "  branch=$GIT_BRANCH  sha=$GIT_SHA  tag=$IMAGE_TAG  connection=$CONNECTION"

# ── 1. Apply SQL modules ────────────────────────────────────────
if [ "${SKIP_SQL:-0}" != "1" ]; then
  echo "[1/8] Apply SQL modules from $MODULES_DIR ..."
  for f in "$MODULES_DIR"/*.sql; do
    echo "  -> $(basename "$f")"
    snow sql -c "$CONNECTION" -f "$f" >/tmp/ors_deploy_sql.log 2>&1 || {
      echo "ERROR: SQL deploy failed for $f"
      tail -30 /tmp/ors_deploy_sql.log
      exit 1
    }
  done
else
  echo "[1/8] SKIP_SQL=1, skipping SQL module deployment."
fi

# ── 2. Image build + push ───────────────────────────────────────
if [ "${SKIP_IMAGE:-0}" != "1" ]; then
  echo "[2/8] Login to SPCS image registry..."
  snow spcs image-registry login -c "$CONNECTION" >/dev/null

  REPO_URL=$(snow spcs image-repository url \
    OPENROUTESERVICE_APP.core.image_repository -c "$CONNECTION")
  echo "  registry=$REPO_URL"

  echo "[3/8] Build image (no-cache, GIT_SHA=$GIT_SHA, tag=$IMAGE_TAG)..."
  docker build --no-cache --platform linux/amd64 \
    --build-arg GIT_SHA="$GIT_SHA" \
    --label "git.sha=$GIT_SHA" \
    --label "git.branch=$GIT_BRANCH" \
    -f "$APP_DIR/Dockerfile.runtime" \
    -t "$REPO_URL/ors_control_app:$IMAGE_TAG" \
    "$APP_DIR" > /tmp/ors_build.log 2>&1 || {
      echo "ERROR: docker build failed"
      tail -50 /tmp/ors_build.log
      exit 1
    }
  echo "  built $(grep '#16 naming to' /tmp/ors_build.log | head -1 || echo "$IMAGE_TAG")"

  echo "[4/8] Push image..."
  docker push "$REPO_URL/ors_control_app:$IMAGE_TAG" >/tmp/ors_push.log 2>&1 || {
    echo "ERROR: docker push failed"
    tail -30 /tmp/ors_push.log
    exit 1
  }
else
  echo "[2-4/8] SKIP_IMAGE=1, skipping image build and push."
fi

# ── 3. Render service spec with new tag and upload to stage ─────
if [ "${SKIP_SERVICE:-0}" != "1" ]; then
  echo "[5/8] Render service spec with image tag $IMAGE_TAG..."
  TMP_YAML=$(mktemp)
  trap "rm -f $TMP_YAML" EXIT
  sed -E "s|(ors_control_app:)[^\"' ]+|\1$IMAGE_TAG|" \
    "$APP_DIR/ors_control_app_service.yaml" > "$TMP_YAML"

  echo "[6/8] Upload spec to stage..."
  snow stage copy "$TMP_YAML" \
    @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/services/ors_control_app/ors_control_app_service.yaml \
    -c "$CONNECTION" --overwrite >/dev/null

  echo "[7/8] Suspend, ALTER FROM SPECIFICATION, Resume..."
  snow sql -c "$CONNECTION" -q "
    ALTER SERVICE OPENROUTESERVICE_APP.CORE.ORS_CONTROL_APP SUSPEND;
    ALTER SERVICE OPENROUTESERVICE_APP.CORE.ORS_CONTROL_APP
      FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/services/ors_control_app/
      SPECIFICATION_FILE = 'ors_control_app_service.yaml';
    ALTER SERVICE OPENROUTESERVICE_APP.CORE.ORS_CONTROL_APP RESUME;
  " >/tmp/ors_alter.log 2>&1 || {
    echo "ERROR: service alter failed"
    tail -30 /tmp/ors_alter.log
    exit 1
  }
else
  echo "[5-7/8] SKIP_SERVICE=1, skipping service spec rotate."
fi

# ── 4. Show endpoint URL ────────────────────────────────────────
echo "[8/8] Resolve endpoint URL..."
URL=$(snow sql -c "$CONNECTION" --format=plain -q "
  SHOW ENDPOINTS IN SERVICE OPENROUTESERVICE_APP.CORE.ORS_CONTROL_APP;
  SELECT 'https://' || \"ingress_url\"
  FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
  WHERE \"name\" = 'ors-control-app';
" 2>/dev/null | grep -E '^https://' | head -1 || true)

echo
echo "================================================================"
echo " Deploy complete."
echo "   image: $IMAGE_TAG"
echo "   branch: $GIT_BRANCH ($GIT_SHA)"
[ -n "$URL" ] && echo "   url:   $URL"
echo "================================================================"

# ── 5. PR URL hint (Enterprise Managed User workaround) ─────────
# `gh pr create` is blocked for EMU users on Snowflake-Labs. After
# pushing your branch, open the PR via the GitHub UI using the URL
# below.
if [ "$GIT_BRANCH" != "main" ] && [ "$GIT_BRANCH" != "dev" ]; then
  REMOTE=$(git config --get remote.origin.url 2>/dev/null || echo "")
  REPO_PATH=$(echo "$REMOTE" | sed -E 's|.*[:/]([^/]+/[^/.]+)(\.git)?$|\1|')
  if [ -n "$REPO_PATH" ]; then
    echo
    echo "PR URL (open in browser, EMU blocks gh pr create):"
    echo "  https://github.com/$REPO_PATH/pull/new/$GIT_BRANCH"
  fi
fi
