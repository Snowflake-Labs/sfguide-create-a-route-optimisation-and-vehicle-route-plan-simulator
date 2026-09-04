#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OPENROUTESERVICE_APP_DIR="${1:-$SKILL_DIR/openrouteservice_app}"

VERSION_FILE="$SKILL_DIR/image-versions.env"
MANIFEST="$OPENROUTESERVICE_APP_DIR/app/manifest.yml"
BUILD_MD="$SKILL_DIR/references/build-images.md"
SKILL_MD="$SKILL_DIR/SKILL.md"
GUIDELINES_MD="$SKILL_DIR/references/snowflake-scripting-guidelines.md"

if [ ! -f "$VERSION_FILE" ]; then
  echo "ERROR: image-versions.env not found at $VERSION_FILE"
  exit 1
fi
# manifest.yml is only present when this skill is packaged as a Snowflake Native App.
# In the SPCS-only deployment path it is absent - that's expected, skip its checks.
HAS_MANIFEST=0
if [ -f "$MANIFEST" ]; then
  HAS_MANIFEST=1
fi

source "$VERSION_FILE"

# Build parallel arrays (bash 3.x compatible - no declare -A)
# Phase C: only the four ORS/VROOM engine images are validated here. The legacy
# ors_control_app was retired (superseded by fleet_admin_app); the two app images
# (FLEET_SA_APP/FLEET_ADMIN_APP) are validated by their own deploy scripts.
IMAGE_NAMES="openrouteservice downloader routing_reverse_proxy vroom-docker"
IMAGE_TAGS="$OPENROUTESERVICE_TAG $DOWNLOADER_TAG $ROUTING_REVERSE_PROXY_TAG $VROOM_DOCKER_TAG"
# Variable references that build-images.md / guidelines may use instead of literal tags.
# These are acceptable because the variables are sourced from image-versions.env at build time.
IMAGE_VARS="OPENROUTESERVICE_TAG DOWNLOADER_TAG ROUTING_REVERSE_PROXY_TAG VROOM_DOCKER_TAG"

errors=0

error() {
  echo "MISMATCH: $1"
  errors=$((errors + 1))
}

echo "=== Image Version Consistency Check ==="
echo ""
echo "Source of truth (image-versions.env):"
i=1
for image in $IMAGE_NAMES; do
  tag=$(echo "$IMAGE_TAGS" | cut -d' ' -f$i)
  echo "  ${image}:${tag}"
  i=$((i + 1))
done
echo ""

i=1
for image in $IMAGE_NAMES; do
  tag=$(echo "$IMAGE_TAGS" | cut -d' ' -f$i)
  var=$(echo "$IMAGE_VARS" | cut -d' ' -f$i)
  pair="${image}:${tag}"
  var_pair="${image}:\$${var}"

  if [ "$HAS_MANIFEST" -eq 1 ] && ! grep -qF "$pair" "$MANIFEST" 2>/dev/null; then
    error "manifest.yml missing $pair"
  fi

  if ! grep -rqF "$pair" "$OPENROUTESERVICE_APP_DIR/services/" 2>/dev/null; then
    error "service YAMLs missing $pair"
  fi

  # SQL modules may embed image tags in FROM SPECIFICATION strings (e.g. BUILD_VROOM_SERVICE_SPEC).
  # Only flag a mismatch if the image name IS referenced but with the wrong tag.
  if grep -rqF "image_repository/${image}:" "$OPENROUTESERVICE_APP_DIR/app/modules/" 2>/dev/null; then
    if ! grep -rqF "$pair" "$OPENROUTESERVICE_APP_DIR/app/modules/" 2>/dev/null; then
      error "SQL modules reference ${image} but not with tag ${tag}"
    fi
  fi

  # Docs may reference either the literal pair or the shell-variable form (preferred).
  if ! grep -qF "$pair" "$BUILD_MD" 2>/dev/null && ! grep -qF "$var_pair" "$BUILD_MD" 2>/dev/null; then
    error "build-images.md missing $pair (or \$$var reference)"
  fi

  if [ -f "$GUIDELINES_MD" ]; then
    if ! grep -qF "$pair"     "$GUIDELINES_MD" 2>/dev/null && \
       ! grep -qF "$var_pair" "$GUIDELINES_MD" 2>/dev/null && \
       ! grep -qF "| ${tag} |" "$GUIDELINES_MD" 2>/dev/null; then
      error "snowflake-scripting-guidelines.md missing $pair"
    fi
  fi

  i=$((i + 1))
done

EXPECTED_REPO=""
if [ "$HAS_MANIFEST" -eq 1 ]; then
  EXPECTED_REPO=$(grep -oE '/[a-z_]+/public/[a-z_]+/' "$MANIFEST" | head -1)
fi
if [ -n "$EXPECTED_REPO" ]; then
  echo "Expected repository path: $EXPECTED_REPO"
  for yaml_file in "$OPENROUTESERVICE_APP_DIR"/services/*/*.yaml; do
    [ -f "$yaml_file" ] || continue
    ACTUAL_REPO=$(grep -oE '/[a-z_]+/public/[a-z_]+/' "$yaml_file" 2>/dev/null | head -1 || true)
    if [ -n "$ACTUAL_REPO" ] && [ "$ACTUAL_REPO" != "$EXPECTED_REPO" ]; then
      error "$(basename "$yaml_file") has repo path $ACTUAL_REPO, expected $EXPECTED_REPO"
    fi
  done
  echo ""
fi

EXPECTED_SCHEMA="CORE"
for yaml_file in "$OPENROUTESERVICE_APP_DIR"/services/*/*.yaml; do
  [ -f "$yaml_file" ] || continue
  BAD_SCHEMAS=$(grep -oE '@[A-Z_]+\.' "$yaml_file" 2>/dev/null | grep -v "@${EXPECTED_SCHEMA}\." | sort -u || true)
  if [ -n "$BAD_SCHEMAS" ]; then
    for bad in $BAD_SCHEMAS; do
      error "$(basename "$yaml_file") references volume schema ${bad} - expected @${EXPECTED_SCHEMA}."
    done
  fi
done

# ── Gateway build-version drift guard ───────────────────────────
# routing_service.py bakes GATEWAY_VERSION into the image and returns it via
# ORS_STATUS(region):gateway_version. It is the reliable stale-image detector
# (SPCS serves images by tag and does not re-pull an unchanged tag). It MUST
# equal ROUTING_REVERSE_PROXY_TAG so the value the running gateway reports is
# trustworthy; otherwise verify_gateway_version.sh would compare against a lie.
GATEWAY_PY="$OPENROUTESERVICE_APP_DIR/services/gateway/routing_service.py"
if [ -f "$GATEWAY_PY" ]; then
  GW_VER=$(grep -oE "^GATEWAY_VERSION[[:space:]]*=[[:space:]]*'[^']*'" "$GATEWAY_PY" | sed -E "s/.*'([^']*)'.*/\1/" | head -1)
  if [ -z "$GW_VER" ]; then
    error "could not read GATEWAY_VERSION from $(basename "$GATEWAY_PY")"
  elif [ "$GW_VER" != "$ROUTING_REVERSE_PROXY_TAG" ]; then
    error "GATEWAY_VERSION ($GW_VER) in routing_service.py != ROUTING_REVERSE_PROXY_TAG ($ROUTING_REVERSE_PROXY_TAG). Bump both together so the gateway reports its true build."
  fi
fi

if [ $errors -gt 0 ]; then
  echo ""
  echo "FAILED: $errors version mismatch(es) found."
  echo "Fix consumer files to match image-versions.env, then re-run."
  exit 1
else
  echo "PASSED: All image versions are consistent with image-versions.env."
  exit 0
fi
