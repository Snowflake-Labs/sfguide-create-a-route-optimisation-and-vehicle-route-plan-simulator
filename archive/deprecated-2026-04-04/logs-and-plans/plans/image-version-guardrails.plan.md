# Plan: Image Version Consistency Guardrails

## Problem

Image version tags are defined in 4 separate locations. When one file is updated but others are not, `snow app run` fails with `Image ... not found`:

```
manifest.yml          --> routing_reverse_proxy:v0.9.5  (stale)
service YAML          --> routing_reverse_proxy:v0.9.6  (correct)
build-images.md       --> routing_reverse_proxy:v0.9.6  (correct)
```

This has occurred multiple times during deployment.

## Where Versions Live

| File | Purpose |
|------|---------|
| [native_app/app/manifest.yml](.cortex/skills/build-routing-solution/native_app/app/manifest.yml) | Declares images the Native App is allowed to use |
| `native_app/services/*/\*.yaml` (5 files) | Defines which image each SPCS service container runs |
| [references/build-images.md](.cortex/skills/build-routing-solution/references/build-images.md) | Build/push instructions with version tags |
| [SKILL.md](.cortex/skills/build-routing-solution/SKILL.md) | Skill workflow summary listing versions |

## Changes

### 1. Create `scripts/check_image_versions.sh`

A simple bash script that extracts `image_name:tag` pairs from all 4 source locations and compares them. Exits non-zero on mismatch.

**Location:** `.cortex/skills/build-routing-solution/scripts/check_image_versions.sh`

```bash
#!/usr/bin/env bash
# Validates that image version tags are consistent across manifest.yml,
# service YAMLs, and build-images.md.
#
# Usage: bash scripts/check_image_versions.sh [path_to_native_app_dir]

set -euo pipefail
NATIVE_APP_DIR="${1:-native_app}"
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

MANIFEST="$SKILL_DIR/$NATIVE_APP_DIR/app/manifest.yml"
BUILD_MD="$SKILL_DIR/references/build-images.md"

# Extract image:tag from manifest.yml (lines like /repo/image:tag)
manifest_versions=$(grep -oE '[a-z_]+:v[0-9.]+' "$MANIFEST" | sort)

# Extract image:tag from service YAMLs
service_versions=$(grep -rohE '[a-z_]+:v[0-9.]+' \
  "$SKILL_DIR/$NATIVE_APP_DIR/services/"*/*.yaml | sort -u)

# Extract image:tag from build-images.md Image Inventory table
build_md_versions=$(grep -oE '[a-z_]+:v[0-9.]+' "$BUILD_MD" \
  | grep -v 'node:' | sort -u)

errors=0

echo "=== Image Version Consistency Check ==="
echo ""
echo "manifest.yml versions:"
echo "$manifest_versions" | sed 's/^/  /'
echo ""
echo "Service YAML versions:"
echo "$service_versions" | sed 's/^/  /'
echo ""
echo "build-images.md versions:"
echo "$build_md_versions" | sed 's/^/  /'
echo ""

# Compare manifest vs service YAMLs
for img in $service_versions; do
  if ! echo "$manifest_versions" | grep -qF "$img"; then
    echo "MISMATCH: $img is in service YAMLs but NOT in manifest.yml"
    errors=$((errors + 1))
  fi
done

# Compare manifest vs build-images.md
for img in $build_md_versions; do
  if ! echo "$manifest_versions" | grep -qF "$img"; then
    echo "MISMATCH: $img is in build-images.md but NOT in manifest.yml"
    errors=$((errors + 1))
  fi
done

if [ $errors -gt 0 ]; then
  echo ""
  echo "FAILED: $errors version mismatch(es) found. Fix manifest.yml before deploying."
  exit 1
else
  echo "PASSED: All image versions are consistent."
  exit 0
fi
```

### 2. Add validation step to [SKILL.md](.cortex/skills/build-routing-solution/SKILL.md)

Insert between current Step 5 and Step 6 (around line 158):

```markdown
### Step 5b: Validate Image Version Consistency (MANDATORY)

**Goal:** Ensure all image version tags match across manifest.yml, service YAMLs, and build instructions

**CRITICAL:** This step MUST be run before `snow app run`. Skipping it risks deployment failure with `Image ... not found`.

**Actions:**

1. Run the validation script:
   ```bash
   bash .cortex/skills/build-routing-solution/scripts/check_image_versions.sh
   ```

2. If the script reports MISMATCH:
   - Update the stale file(s) to match the version tags used in the build step
   - Re-run the script to confirm all versions are consistent

3. If no script available, manually verify with grep:
   ```bash
   grep -ohE '[a-z_]+:v[0-9.]+' native_app/app/manifest.yml | sort
   grep -rohE '[a-z_]+:v[0-9.]+' native_app/services/*/*.yaml | sort -u
   ```
   All 5 image:tag pairs must match exactly.

**Next:** Proceed to Step 6
```

### 3. Add warning to [references/build-images.md](.cortex/skills/build-routing-solution/references/build-images.md)

Append after the "Common Errors" section (after line 95):

```markdown
## CRITICAL: Pre-Deploy Version Check

Before running `snow app run`, you MUST verify that all image version tags in
`manifest.yml` match the tags you just built and pushed. A version mismatch
causes deployment to fail with `Image ... not found`.

Run the validation script:
```bash
bash scripts/check_image_versions.sh
```

Or manually compare:
```bash
grep -ohE '[a-z_]+:v[0-9.]+' native_app/app/manifest.yml | sort
grep -rohE '[a-z_]+:v[0-9.]+' native_app/services/*/*.yaml | sort -u
```

All 5 pairs must match: openrouteservice, downloader, routing_reverse_proxy, vroom-docker, ors_control_app.
```

### 4. Add to [references/troubleshooting.md](.cortex/skills/build-routing-solution/references/troubleshooting.md)

Insert as a new section near the top (after "Wrong Directory Error", around line 27):

```markdown
## Image Version Mismatch (Deployment Failure)

**Symptom:** `snow app run` fails with:
```
Image /openrouteservice_setup/public/image_repository/<image>:<old_tag> not found.
Please verify the image exists in the image repository.
```

**Root Cause:** `manifest.yml` references a different version tag than what was actually
built and pushed. This happens when version tags are updated in service YAMLs or
build-images.md but not in manifest.yml (or vice versa).

**Solution:**
1. Run `bash scripts/check_image_versions.sh` to identify which file is out of sync
2. Update the stale version tag to match the version you built
3. Re-run `snow app run`

**Prevention:** Always run Step 5b (version validation) before deploying.
```

## Summary of File Changes

| File | Change |
|------|--------|
| `scripts/check_image_versions.sh` | NEW - validation script |
| `SKILL.md` | ADD Step 5b between Step 5 and Step 6 |
| `references/build-images.md` | ADD "Pre-Deploy Version Check" section |
| `references/troubleshooting.md` | ADD "Image Version Mismatch" section |
