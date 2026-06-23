#!/usr/bin/env bash
#
# build-routing-solution / deploy_fleet_sa_app.sh
#
# One-command deploy for the Fleet Intelligence SA host (Solution Accelerator UI)
# on SPCS. Sibling to deploy.sh (which deploys the ORS control app); kept separate
# because the SA host lives under fleet_sa_app/ with a different (prebuilt-.next)
# Docker build and its own service spec + config stage. Mirrors the proven flow:
# build -> push -> render spec -> upload config bundle -> ALTER SERVICE -> URL.
#
# Usage:
#   bash .cortex/skills/build-routing-solution/scripts/deploy_fleet_sa_app.sh [connection]
#
# Default connection: fleet_test_evals
#
# Env overrides:
#   ALLOW_DIRTY=1   - allow deploying with uncommitted changes (default: refused)
#   SKIP_IMAGE=1    - skip image build/push (just rotate config + service)
#   SKIP_CONFIG=1   - skip uploading app-config.json / app-views.json to the stage
#   SKIP_SERVICE=1  - skip the ALTER SERVICE cycle
#   IMAGE_TAG=<tag> - override the tag (default: FLEET_SA_APP_TAG from image-versions.env)
set -euo pipefail

CONNECTION=${1:-fleet_test_evals}
REPO_ROOT=$(git rev-parse --show-toplevel)
SKILL_DIR="$REPO_ROOT/.cortex/skills/build-routing-solution"
APP_DIR="$SKILL_DIR/fleet_sa_app"
UI_DIR="$APP_DIR/ui"
SERVICE_YAML="$APP_DIR/fleet_sa_app_service.yaml"
VERSION_FILE="$SKILL_DIR/openrouteservice_app/image-versions.env"
GIT_SHA=$(git rev-parse --short HEAD)
GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD)

SERVICE_FQN="FLEET_INTELLIGENCE.SYNAPSE_USER.FLEET_SA_APP"
CONFIG_STAGE="@FLEET_INTELLIGENCE.SYNAPSE_USER.FLEET_APP_STAGE/config"
IMAGE_REPO_SQL_NAME="OPENROUTESERVICE_APP.core.image_repository"

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

# Source the single source of truth for the tag.
# shellcheck disable=SC1090
source "$VERSION_FILE"
IMAGE_TAG="${IMAGE_TAG:-${FLEET_SA_APP_TAG:?FLEET_SA_APP_TAG missing from image-versions.env}}"

# Pre-flight: the committed service YAML must reference the source-of-truth tag.
if ! grep -qF "fleet_sa_app:${IMAGE_TAG}" "$SERVICE_YAML"; then
  echo "ERROR: $SERVICE_YAML does not reference fleet_sa_app:${IMAGE_TAG}"
  echo "       Update image-versions.env (FLEET_SA_APP_TAG) and the service YAML to match."
  exit 1
fi

echo "  branch=$GIT_BRANCH  sha=$GIT_SHA  tag=$IMAGE_TAG  connection=$CONNECTION"

# ── 1. Build the Next.js standalone bundle (prebuilt-.next Docker path) ──
if [ "${SKIP_IMAGE:-0}" != "1" ]; then
  # Defense-in-depth dedup: @fleet-kit/core is symlinked via a file: dependency
  # and its devDependencies install a NESTED copy of @deck.gl/* + @luma.gl/*.
  # With resolve.symlinks=false the kit resolves those from its realpath tree,
  # yielding duplicate @luma.gl/shadertools ShaderAssembler singletons and the
  # "DECKGL_FILTER_COLOR : no matching overloaded function found" shader crash.
  # next.config.ts already aliases these to the consumer copy (authoritative);
  # stripping the nested copies here keeps a fresh build correct even if the
  # alias is ever removed. Safe no-op when the dirs are absent.
  KIT_NM="$REPO_ROOT/packages/fleet-kit/node_modules"
  if [ -d "$KIT_NM" ]; then
    echo "[1/7] Strip nested deck.gl/luma.gl from $KIT_NM (dedup guard)..."
    rm -rf "$KIT_NM/@deck.gl" "$KIT_NM/@luma.gl"
  fi
  echo "[1/7] Build Next.js standalone (npm ci + npm run build)..."
  ( cd "$UI_DIR" && { [ -d node_modules ] || npm ci; } && npm run build ) \
    > /tmp/fleet_sa_build.log 2>&1 || { echo "ERROR: next build failed"; tail -40 /tmp/fleet_sa_build.log; exit 1; }

  echo "[2/7] Login to SPCS image registry..."
  snow spcs image-registry login -c "$CONNECTION" >/dev/null
  REPO_URL=$(snow spcs image-repository url "$IMAGE_REPO_SQL_NAME" -c "$CONNECTION")
  echo "  registry=$REPO_URL"

  echo "[3/7] Docker build (prebuilt .next) + push tag=$IMAGE_TAG..."
  docker build --platform linux/amd64 \
    --label "git.sha=$GIT_SHA" --label "git.branch=$GIT_BRANCH" \
    -f "$UI_DIR/Dockerfile" \
    -t "$REPO_URL/fleet_sa_app:$IMAGE_TAG" \
    "$UI_DIR" > /tmp/fleet_sa_docker.log 2>&1 || { echo "ERROR: docker build failed"; tail -40 /tmp/fleet_sa_docker.log; exit 1; }
  docker push "$REPO_URL/fleet_sa_app:$IMAGE_TAG" >/tmp/fleet_sa_push.log 2>&1 || { echo "ERROR: docker push failed"; tail -30 /tmp/fleet_sa_push.log; exit 1; }
else
  echo "[1-3/7] SKIP_IMAGE=1, skipping build/push."
fi

# ── 2. Upload the editable app bundle (tier-B config-extensibility) ──
if [ "${SKIP_CONFIG:-0}" != "1" ]; then
  echo "[4/7] Upload app-config.json / app-views.json to $CONFIG_STAGE ..."
  for f in app-config.json app-views.json; do
    snow stage copy "$APP_DIR/app/$f" "$CONFIG_STAGE/" -c "$CONNECTION" --overwrite >/dev/null
  done
else
  echo "[4/7] SKIP_CONFIG=1, skipping config bundle upload."
fi

# ── 3. Render service spec with the tag and rotate the service ──
if [ "${SKIP_SERVICE:-0}" != "1" ]; then
  echo "[5/7] Render service spec with tag $IMAGE_TAG..."
  STAGE_DIR=$(mktemp -d); trap 'rm -rf "$STAGE_DIR"' EXIT
  STAGE_YAML="$STAGE_DIR/fleet_sa_app_service.yaml"
  sed -E "s|(fleet_sa_app:)[^\"' ]+|\1$IMAGE_TAG|" "$SERVICE_YAML" > "$STAGE_YAML"
  snow stage copy "$STAGE_YAML" "$CONFIG_STAGE/" -c "$CONNECTION" --overwrite >/dev/null

  echo "[6/7] ALTER SERVICE FROM SPECIFICATION + RESUME..."
  snow sql -c "$CONNECTION" -q "
    ALTER SERVICE IF EXISTS $SERVICE_FQN SUSPEND;
    ALTER SERVICE $SERVICE_FQN
      FROM ${CONFIG_STAGE}
      SPECIFICATION_FILE = 'fleet_sa_app_service.yaml';
    -- CARTO basemap tile proxy (/api/tiles) needs egress to *.basemaps.cartocdn.com.
    -- EAIs are a service property (not expressible in the spec YAML), so set it here.
    -- Reuses the ORS control app's ORS_CARTO_EAI (a/b/c/d.basemaps.cartocdn.com:443).
    ALTER SERVICE $SERVICE_FQN SET EXTERNAL_ACCESS_INTEGRATIONS = (ORS_CARTO_EAI);
    ALTER SERVICE $SERVICE_FQN RESUME;
  " >/tmp/fleet_sa_alter.log 2>&1 || { echo "ERROR: service alter failed"; tail -30 /tmp/fleet_sa_alter.log; exit 1; }
else
  echo "[5-6/7] SKIP_SERVICE=1, skipping service rotate."
fi

# ── 4. Resolve endpoint URL ─────────────────────────────────────
echo "[7/7] Resolve endpoint URL..."
URL=$(snow sql -c "$CONNECTION" --format=plain -q "
  SHOW ENDPOINTS IN SERVICE $SERVICE_FQN;
  SELECT 'https://' || \"ingress_url\"
  FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
  WHERE \"name\" = 'fleet-sa-app';
" 2>/dev/null | grep -E '^https://' | head -1 || true)

echo
echo "================================================================"
echo " Fleet SA host deploy complete."
echo "   image: fleet_sa_app:$IMAGE_TAG"
echo "   branch: $GIT_BRANCH ($GIT_SHA)"
[ -n "$URL" ] && echo "   url:   $URL"
echo "================================================================"
