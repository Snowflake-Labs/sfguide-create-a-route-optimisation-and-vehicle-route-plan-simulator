# Build Routing Solution Log
**Date:** 2026-04-13 05:45 UTC-07:00
**Skill:** build-routing-solution
**Connection:** fleet_test_evals (account wgb26798)
**Outcome:** SUCCESS - Full deployment with all 7 demo skills

## Issues Found

### 1. Image Version Mismatch (Step 5b) - FRICTION
**Severity:** Medium
**Description:** `check_image_versions.sh` reports 4 mismatches between `build-images.md` (says `ors_control_app:v1.0.95`) and `manifest.yml`/service YAMLs (say `v1.0.98`). The SKILL.md says "Follow the full build instructions in `references/build-images.md`" which lists `v1.0.95`, but the deployment files expect `v1.0.98`.
**Impact:** Agent built `v1.0.95` per build-images.md instructions. Had to re-tag and push as `v1.0.98` to match manifest. Could cause deployment failure if not caught.
**Recommendation:** Update `build-images.md` and `snowflake-scripting-guidelines.md` to say `v1.0.98`, or update manifest/service YAMLs to `v1.0.95`. The version check script correctly identifies the mismatch but it's confusing that the authoritative build doc and the deployment files disagree. Also update SKILL.md Step 5 which says `ors_control_app (v1.0.95)` in the summary.
**Files to update:**
- `.cortex/skills/build-routing-solution/references/build-images.md` - change `v1.0.95` to `v1.0.98`
- `.cortex/skills/build-routing-solution/references/snowflake-scripting-guidelines.md` - change `v1.0.95` to `v1.0.98`
- `.cortex/skills/build-routing-solution/SKILL.md` Step 5 summary line - change `v1.0.95` to `v1.0.98`

### 2. APP_VERSION env mismatch in service YAML (Step 5b)
**Severity:** Low
**Description:** `check_image_versions.sh` also reports "APP_VERSION env in service YAML is 1.0.95, expected 1.0.98". The `APP_VERSION` env var in the ors_control_app service YAML is set to `1.0.95` but the image tag is `v1.0.98`.
**Impact:** Cosmetic - the APP_VERSION env var is used for display in the control app UI, not for image selection. But it's inconsistent.
**Recommendation:** Update `APP_VERSION` env in `ors_control_app_service.yaml` to match the image tag.

### 3. Snowflake Intelligence Not Available (Step 9 - Routing Agent)
**Severity:** Low (Expected)
**Description:** `ALTER SNOWFLAKE INTELLIGENCE SNOWFLAKE_INTELLIGENCE_OBJECT_DEFAULT ADD AGENT` fails with "does not exist or not authorized". This is expected on accounts without Snowflake Intelligence configured.
**Impact:** None - the skill documents this as optional. Agent works via direct `INVOKE_AGENT` calls.
**Recommendation:** No change needed. The SKILL.md correctly documents this as optional (Step 8).

### 4. npm audit vulnerabilities in ors_control_app (Step 5)
**Severity:** Low
**Description:** `npm ci` reports "4 vulnerabilities (2 moderate, 2 high)" in the control app build.
**Impact:** Build-time only, not runtime. The `build-images.md` already notes this.
**Recommendation:** Consider updating dependencies in a future version.

## Execution Timeline

| Step | Duration | Notes |
|------|----------|-------|
| Steps 1-4 (Infrastructure + Upload) | ~3 min | Clean, no issues |
| Step 5 (Build + Push 5 images) | ~5 min | All 5 in parallel, ARM Mac local build for control app |
| Step 5b (Version check) | <1 min | Found mismatch, fixed with re-tag |
| Step 6 (Deploy native app) | ~2 min | `snow app run` smooth |
| Step 7 (Activate app) | ~3 min | Grant callback took ~2 min |
| Step 8 (Seed data) | ~2 min | All counts match exactly |
| Step 8b (Overture Maps) | ~1 min | Both datasets installed |
| Step 9 (7 demo skills) | ~5 min | All deployed successfully |
| **Total** | **~22 min** | |

## Demo Skill Verification

| Demo | Status | Key Counts |
|------|--------|------------|
| Fleet Intelligence: Food Delivery | OK | CONFIG=1, DELIVERIES=6008, RESTAURANTS=5000 |
| Route Deviation | OK | TRIP_DEVIATION=6008, DRIVER_SUMMARY=50, DAILY_TRENDS=8 |
| Dwell Analysis | OK | 8 Dynamic Tables + SLA task created, VW_TELEMETRY=472869 |
| Fleet Intelligence: Taxis | OK | TRIP_SUMMARY=6008, DRIVER_LOCATIONS=472869 |
| Retail Catchment | OK | RETAIL_POIS=56303, REGIONAL_ADDRESSES=2826892 |
| Route Optimization | OK | PLACES populated, LOOKUP=4, JOB_TEMPLATE=29 |
| Routing Agent | OK | 3 procedures + 1 agent created (SI registration skipped) |
