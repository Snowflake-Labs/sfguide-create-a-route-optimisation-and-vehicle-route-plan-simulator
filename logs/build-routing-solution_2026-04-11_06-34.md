# Build Routing Solution - Execution Log
**Date:** 2026-04-11 06:34 UTC
**Connection:** fleet_test_evals (wgb26798, ACCOUNTADMIN)
**Container Runtime:** Docker (Podman also available)
**Architecture:** ARM64 (Apple Silicon)

## Outcome
Full deployment completed successfully: core ORS native app + 6 demos.

## Friction Points & Issues Found

### 1. Image Version Mismatch (Step 5b) - BUG
**Severity:** Medium
**File:** `native_app/services/ors_control_app/ors_control_app_service.yaml`
**Issue:** Service YAML had `ors_control_app:v1.0.88` but `manifest.yml` and `build-images.md` both specified `v1.0.87`. The `check_image_versions.sh` script correctly caught the mismatch.
**Fix applied:** Updated service YAML from `v1.0.88` to `v1.0.87`.
**Root cause:** Likely a previous `deploy.sh` auto-bumped the service YAML version without updating the other files.
**Recommendation:** Either make `deploy.sh` update ALL files when bumping, or pin the version in a single source-of-truth file that all others reference.

### 2. S3 Seed Data Buckets Empty - BUG
**Severity:** High
**Skills affected:** `retail-catchment`, `route-optimization`
**Issue:** Both `seed-data.sql` files reference S3 stages (`s3://fleet-intelligence/SanFrancisco/retail-catchment/` and `s3://fleet-intelligence/SanFrancisco/route-optimization/`) but the buckets contain 0 files. `COPY INTO` executes with `0 files processed` and all tables end up with 0 rows.
**Workaround:** Ran the full Overture Maps pipeline for retail-catchment (which worked fine). For route-optimization, the notebook execution path (`EXECUTE NOTEBOOK ADD_CARTO_DATA`) worked perfectly.
**Note:** The `seed-data.sql` files do document "The S3 bucket may be empty" but this means the "recommended fast path" (Step 0) always fails, forcing users into the longer pipeline.
**Recommendation:** Either populate the S3 buckets or remove the S3 seed path and make the Overture Maps / notebook path the primary recommended approach.

### 3. Verification SQL Uses Reserved Word `ROWS` - MINOR
**Severity:** Low
**Skills affected:** Multiple skills use `COUNT(*) AS ROWS` in verification queries
**Issue:** `ROWS` is a reserved word in Snowflake. The food delivery skill's verification query in `sql-projection-views.sql` comments uses `ROWS` which fails. The actual code uses `ROW_CNT`.
**Note:** Route deviation's `SKILL.md` already documents this in Troubleshooting as a known issue.

### 4. Dwell Analysis DT_SLA_ALERTS = 0 Rows - EXPECTED
**Severity:** Info
**Issue:** After deploying dwell analysis, `DT_SLA_ALERTS` returned 0 rows. This is expected behavior since dwell durations in the seed data may not exceed the default warning thresholds (e.g., 60min for WAREHOUSE, 30min for DESTINATION).
**Note:** This is not a bug but could confuse users expecting to see SLA alerts. The skill documents this in troubleshooting.

### 5. Snow CLI Version Warning - MINOR
**Severity:** Low
**Issue:** Every `snow` command outputs: `New version of Snowflake CLI available. Newest: 3.16.0, current: 3.9.0`. Not a blocker but adds noise to output.

### 6. SKILL.md Execution Rule Violation - CONFUSION
**Severity:** Low  
**Skills affected:** All skills with seed-data.sql files
**Issue:** Skills say "One statement per snowflake_sql_execute call" in execution rules, but then recommend running `snow sql -f seed-data.sql` which executes many statements in a single call via the CLI. The rules contradict the recommended approach. The CLI approach works fine but violates the stated rules.
**Recommendation:** Clarify that the one-statement rule applies to `snowflake_sql_execute` tool calls only, not CLI execution.

### 7. Route Optimization LOOKUP Table Has 4 Rows Instead of Expected 3 - OBSERVATION
**Severity:** Low
**Issue:** The notebook-deployment.md says LOOKUP should have "3 rows (default)" but after executing the notebook, LOOKUP has 4 rows. Not a problem, just a documentation mismatch.

## Summary

| Step | Status | Notes |
|------|--------|-------|
| Step 1: Query Tag | OK | |
| Step 2: Container Runtime | OK | Docker + Node v22 detected |
| Step 3: Database & Stages | OK | 3 stages + 1 image repo + 1 warehouse |
| Step 4: Upload Config Files | OK | 3 files uploaded |
| Step 5: Build & Push Images | OK | 5 images built and pushed |
| Step 5b: Version Validation | FIXED | Service YAML v1.0.88 -> v1.0.87 |
| Step 6: Deploy Native App | OK | snow app run + grants |
| Step 7: User Activation | OK | 5 services RUNNING |
| Step 8: Seed Datasets | OK | All counts match expected |
| Step 9a: Food Delivery | OK | CONFIG=1, DELIVERIES=6008, RESTAURANTS=5000 |
| Step 9b: Route Deviation | OK | TRIPS=6008, DRIVERS=50, DAYS=8 |
| Step 9c: Dwell Analysis | OK | 472K state changes, 12.5K sessions, 8 daily trends |
| Step 9d: Fleet Taxis | OK | Projection views created |
| Step 9e: Retail Catchment | OK | 56K POIs, 2.8M addresses (via Overture Maps, not S3) |
| Step 9f: Route Optimization | OK | 1.4M places, 4 lookups, 29 jobs, 2 notebooks |
