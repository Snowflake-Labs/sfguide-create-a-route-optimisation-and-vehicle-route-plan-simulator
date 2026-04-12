#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NATIVE_APP_DIR="${1:-$SKILL_DIR/native_app}"

MANIFEST="$NATIVE_APP_DIR/app/manifest.yml"
BUILD_MD="$SKILL_DIR/references/build-images.md"
SKILL_MD="$SKILL_DIR/SKILL.md"
README_MD="$SKILL_DIR/../../README.md"

if [ ! -f "$MANIFEST" ]; then
  echo "ERROR: manifest.yml not found at $MANIFEST"
  exit 1
fi

manifest_versions=$(grep -oE '[a-z_-]+:v[0-9.]+' "$MANIFEST" | sort)
service_versions=$(grep -rohE '[a-z_-]+:v[0-9.]+' "$NATIVE_APP_DIR/services/"*/*.yaml 2>/dev/null | sort -u)
build_md_versions=$(grep -oE '[a-z_-]+:v[0-9.]+' "$BUILD_MD" 2>/dev/null | grep -v 'node:' | sort -u)

errors=0

echo "=== Image Version Consistency Check ==="
echo ""
echo "manifest.yml:"
echo "$manifest_versions" | sed 's/^/  /'
echo ""
echo "Service YAMLs:"
echo "$service_versions" | sed 's/^/  /'
echo ""
echo "build-images.md:"
echo "$build_md_versions" | sed 's/^/  /'
echo ""

for img in $service_versions; do
  if ! echo "$manifest_versions" | grep -qF "$img"; then
    echo "MISMATCH: $img in service YAMLs but NOT in manifest.yml"
    errors=$((errors + 1))
  fi
done

for img in $build_md_versions; do
  if ! echo "$manifest_versions" | grep -qF "$img"; then
    echo "MISMATCH: $img in build-images.md but NOT in manifest.yml"
    errors=$((errors + 1))
  fi
done

for img in $manifest_versions; do
  if ! echo "$service_versions" | grep -qF "$img"; then
    echo "MISMATCH: $img in manifest.yml but NOT in any service YAML"
    errors=$((errors + 1))
  fi
done

control_app_ver=$(echo "$manifest_versions" | grep 'ors_control_app' || true)
if [ -n "$control_app_ver" ]; then
  expected_ver=$(echo "$control_app_ver" | sed 's/.*:v//')
  for label_file in "SKILL.md:$SKILL_MD" "README.md:$README_MD"; do
    label="${label_file%%:*}"
    fpath="${label_file#*:}"
    if [ -f "$fpath" ]; then
      if ! grep -qF "$control_app_ver" "$fpath" 2>/dev/null && ! grep -qF "ors_control_app (v${expected_ver})" "$fpath" 2>/dev/null; then
        echo "MISMATCH: $control_app_ver not found in $label"
        errors=$((errors + 1))
      fi
    fi
  done

  svc_yaml="$NATIVE_APP_DIR/services/ors_control_app/ors_control_app_service.yaml"
  if [ -f "$svc_yaml" ]; then
    yaml_env_ver=$(grep 'APP_VERSION' "$svc_yaml" 2>/dev/null | sed 's/.*"\([0-9.]*\)".*/\1/' || true)
    if [ -n "$yaml_env_ver" ] && [ "$yaml_env_ver" != "$expected_ver" ]; then
      echo "MISMATCH: APP_VERSION env in service YAML is $yaml_env_ver, expected $expected_ver"
      errors=$((errors + 1))
    fi
  fi
fi

if [ $errors -gt 0 ]; then
  echo ""
  echo "FAILED: $errors version mismatch(es) found. Fix before deploying."
  exit 1
else
  echo "PASSED: All image versions are consistent."
  exit 0
fi
