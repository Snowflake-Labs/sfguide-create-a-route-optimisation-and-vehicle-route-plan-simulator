#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NATIVE_APP_DIR="${1:-$SKILL_DIR/native_app}"

VERSION_FILE="$SKILL_DIR/native_app/image-versions.env"
MANIFEST="$NATIVE_APP_DIR/app/manifest.yml"
BUILD_MD="$SKILL_DIR/references/build-images.md"
SKILL_MD="$SKILL_DIR/SKILL.md"
README_MD="$SKILL_DIR/../../README.md"
GUIDELINES_MD="$SKILL_DIR/references/snowflake-scripting-guidelines.md"

if [ ! -f "$VERSION_FILE" ]; then
  echo "ERROR: image-versions.env not found at $VERSION_FILE"
  exit 1
fi
if [ ! -f "$MANIFEST" ]; then
  echo "ERROR: manifest.yml not found at $MANIFEST"
  exit 1
fi

source "$VERSION_FILE"

declare -A EXPECTED=(
  [openrouteservice]="$OPENROUTESERVICE_TAG"
  [downloader]="$DOWNLOADER_TAG"
  [routing_reverse_proxy]="$ROUTING_REVERSE_PROXY_TAG"
  [vroom-docker]="$VROOM_DOCKER_TAG"
  [ors_control_app]="$ORS_CONTROL_APP_TAG"
)

errors=0

error() {
  echo "MISMATCH: $1"
  errors=$((errors + 1))
}

echo "=== Image Version Consistency Check ==="
echo ""
echo "Source of truth (image-versions.env):"
for image in "${!EXPECTED[@]}"; do
  echo "  ${image}:${EXPECTED[$image]}"
done
echo ""

for image in "${!EXPECTED[@]}"; do
  tag="${EXPECTED[$image]}"
  pair="${image}:${tag}"

  if ! grep -qF "$pair" "$MANIFEST" 2>/dev/null; then
    error "manifest.yml missing $pair"
  fi

  if ! grep -rqF "$pair" "$NATIVE_APP_DIR/services/" 2>/dev/null; then
    error "service YAMLs missing $pair"
  fi

  if ! grep -qF "$pair" "$BUILD_MD" 2>/dev/null; then
    error "build-images.md missing $pair"
  fi

  if [ -f "$GUIDELINES_MD" ]; then
    if ! grep -qF "$pair" "$GUIDELINES_MD" 2>/dev/null && ! grep -qF "| ${tag} |" "$GUIDELINES_MD" 2>/dev/null; then
      error "snowflake-scripting-guidelines.md missing $pair"
    fi
  fi
done

for label_file in "SKILL.md:$SKILL_MD" "README.md:$README_MD"; do
  label="${label_file%%:*}"
  fpath="${label_file#*:}"
  if [ -f "$fpath" ]; then
    if grep -qF "image-versions.env" "$fpath" 2>/dev/null; then
      continue
    fi
    if ! grep -qF "ors_control_app:${ORS_CONTROL_APP_TAG}" "$fpath" 2>/dev/null && \
       ! grep -qF "ors_control_app (${ORS_CONTROL_APP_TAG})" "$fpath" 2>/dev/null; then
      error "$label missing ors_control_app:${ORS_CONTROL_APP_TAG}"
    fi
  fi
done

expected_app_ver="${ORS_CONTROL_APP_TAG#v}"
svc_yaml="$NATIVE_APP_DIR/services/ors_control_app/ors_control_app_service.yaml"
if [ -f "$svc_yaml" ]; then
  yaml_env_ver=$(grep 'APP_VERSION' "$svc_yaml" 2>/dev/null | sed 's/.*"\([0-9.]*\)".*/\1/' || true)
  if [ -n "$yaml_env_ver" ] && [ "$yaml_env_ver" != "$expected_app_ver" ]; then
    error "APP_VERSION env in service YAML is $yaml_env_ver, expected $expected_app_ver"
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
