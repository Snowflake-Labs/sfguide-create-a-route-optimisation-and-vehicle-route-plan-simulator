# Build Routing Solution — Execution Log

- **Date:** 2026-04-14 00:47
- **Skill:** build-routing-solution
- **Connection:** fleet_test_evals
- **Role:** ACCOUNTADMIN
- **Warehouse:** ROUTING_ANALYTICS
- **Outcome:** COMPLETED_WITH_WORKAROUNDS

## Issues

### Issue 1: Wrong image repository path in 3 service YAML files (BLOCKER)

- **Step:** Step 5b / Step 7 (grant_callback)
- **Severity:** BLOCKER
- **Category:** DOCS_GAP

**What happened:**
Three service YAML files (`downloader_spec.yaml`, `openrouteservice.yaml`, `vroom-service.yaml`) reference `/fleet_intelligence_setup/public/fleet_intel_repo/` as the image repository path instead of `/openrouteservice_setup/public/image_repository/`. The `gateway` and `ors_control_app` YAMLs were correct.

This caused the grant_callback to fail with:
```
Image repository 'FLEET_INTELLIGENCE_SETUP.PUBLIC.FLEET_INTEL_REPO' does not exist or not authorized.
```

**Files affected:**
- `native_app/services/downloader/downloader_spec.yaml` line 4
- `native_app/services/openrouteservice/openrouteservice.yaml` line 3
- `native_app/services/vroom/vroom-service.yaml` line 3

**Resolution:**
Edited all 3 files to replace `/fleet_intelligence_setup/public/fleet_intel_repo/` with `/openrouteservice_setup/public/image_repository/`, then redeployed with `snow app run`.

**Suggested fix:**
1. Fix the 3 service YAML files in the repo to use the correct image repository path.
2. Update `scripts/check_image_versions.sh` to also validate the **repository path** (not just the version tags). Currently it only checks tags, missing the wrong repo path entirely.

---

### Issue 2: Wrong volume source schema in downloader_spec.yaml (BLOCKER)

- **Step:** Step 7 (grant_callback, second attempt)
- **Severity:** BLOCKER
- **Category:** MISSING_OBJECT

**What happened:**
After fixing the image repository paths, the grant_callback failed again with:
```
Schema 'OPENROUTESERVICE_NATIVE_APP.ROUTING' does not exist or not authorized.
```

The `downloader_spec.yaml` volume sources referenced `@ROUTING.ORS_SPCS_STAGE`, `@ROUTING.ORS_GRAPHS_SPCS_STAGE`, and `@ROUTING.ORS_ELEVATION_CACHE_SPCS_STAGE`. The correct schema is `CORE`, not `ROUTING`.

The `openrouteservice.yaml` correctly uses `@CORE.ORS_SPCS_STAGE/SanFrancisco`.

**Resolution:**
Edited `downloader_spec.yaml` to replace `@ROUTING.` with `@CORE.` for all 3 volume sources. Redeployed and re-triggered grant_callback successfully.

**Suggested fix:**
Fix `native_app/services/downloader/downloader_spec.yaml` volume sources to use `@CORE.` prefix.

---

### Issue 3: check_image_versions.sh does not validate repository paths (INFO)

- **Step:** Step 5b
- **Severity:** INFO
- **Category:** DOCS_GAP

**What happened:**
The `check_image_versions.sh` script reported "PASSED" even though 3 service YAMLs had completely wrong image repository paths (`fleet_intelligence_setup/public/fleet_intel_repo` instead of `openrouteservice_setup/public/image_repository`). The script only validates version tags, not the full image path.

**Resolution:** N/A — the script passed, but deployment failed later.

**Suggested fix:**
Enhance `check_image_versions.sh` to also verify that the repository path portion of each image reference matches across all files (manifest.yml, service YAMLs).

---

### Issue 4: Docker push output invisible for some images (INFO)

- **Step:** Step 5 (Push images)
- **Severity:** INFO
- **Category:** DOCS_GAP

**What happened:**
When pushing `openrouteservice:v9.0.0` in parallel with other images, the docker push output was invisible (carriage return issue). The first push attempt appeared to complete but the image was not listed in the repository. A second explicit push was needed.

**Resolution:** Re-ran `docker push` for the openrouteservice image. The build-images.md docs do mention "Docker push progress output uses carriage returns that may be invisible" but the workaround of always running `snow spcs image-repository list-images` after push should be emphasized more.

**Suggested fix:**
Add a note in the SKILL.md Step 5 to always verify with `list-images` after pushing, especially when pushing multiple images in parallel.

---

### Issue 5: Retail Catchment seed-data.sql takes ~5 minutes (INFO)

- **Step:** Step 9 (Deploy demos)
- **Severity:** INFO
- **Category:** DOCS_GAP

**What happened:**
The `retail-catchment/references/seed-data.sql` took significantly longer than other demo seed scripts (~5 minutes vs seconds) because it queries the large Overture Maps datasets (REGIONAL_ADDRESSES loaded 2.8M rows).

**Resolution:** Waited for completion. No action needed.

**Suggested fix:**
Add a note in the retail-catchment SKILL.md that seed-data.sql may take 3-5 minutes due to Overture Maps data volume.

## Summary

All 3 BLOCKER issues were in service YAML files that had stale references to a different project's image repository and schema. After fixing these, the full deployment completed successfully including all 7 demo skills.
