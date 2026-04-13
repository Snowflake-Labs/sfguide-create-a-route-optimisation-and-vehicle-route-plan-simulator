# Build Routing Solution - Friction Log
**Date:** 2026-04-12 22:30 UTC
**Duration:** ~45 minutes total
**Outcome:** Full success - all steps completed, all demos deployed

## Friction Points

### 1. Docker image push takes very long (MEDIUM)
- **Where:** Step 5 - Build and push container images
- **Issue:** Pushing the openrouteservice image (v9.0.0, ~160MB+ layers) took ~8 minutes. Total image push time was ~15 minutes. The skill says "5-10 minutes" but in practice it was closer to 15-20 minutes for all 5 images.
- **Impact:** Delays the deployment, hard to track progress since Docker push uses carriage returns that are invisible in many terminals.
- **Suggestion:** Update expected duration to "10-20 minutes" and consider noting that first push is slower than subsequent (cached layer) pushes.

### 2. snow CLI version warning noise (LOW)
- **Where:** Every `snow` CLI command
- **Issue:** Every snow command outputs `UserWarning: New version of Snowflake CLI available. Newest: 3.16.0, current: 3.9.0` despite `SNOWFLAKE_CLI_NO_UPDATE_CHECK=true`.
- **Impact:** Output clutter, harder to parse real output from noise.
- **Suggestion:** The `SNOWFLAKE_CLI_NO_UPDATE_CHECK=true` env var does NOT suppress the warning in snow CLI 3.9.0. The skill prereqs should note the minimum snow CLI version or document that this warning is expected.

### 3. Config table creation ordering in route-optimization (LOW)
- **Where:** Step 9f - Route Optimization deployment
- **Issue:** The MERGE INTO CONFIG statement was executed before the CREATE TABLE, causing a "does not exist" error. Had to reorder: CREATE TABLE first, then MERGE.
- **Impact:** Minor - easily recoverable. The `sql-setup.md` reference doesn't include the CONFIG CREATE TABLE + MERGE sequence explicitly (it's in the SKILL.md Step 5 but without full SQL).
- **Suggestion:** Include a complete `seed-data.sql` for route-optimization like the other demos have, or make the ordering explicit in sql-setup.md.

### 4. No seed-data.sql for route-optimization (MEDIUM)
- **Where:** Step 9f
- **Issue:** Unlike food-delivery, taxis, route-deviation, dwell-analysis, and retail-catchment which all have `references/seed-data.sql`, route-optimization requires running a Snowflake notebook to populate data. This adds complexity (stage, create notebook, execute notebook) vs a simple `snow sql -f`.
- **Impact:** More steps, more things that can fail. The notebook approach is necessary for POI data processing but it's a friction point for automated deployments.
- **Suggestion:** Consider creating a pre-computed seed-data.sql for the SF default case that bypasses the notebook.

### 5. Retail catchment seed-data.sql uses session variables (LOW)
- **Where:** Step 9e
- **Issue:** The retail-catchment seed-data.sql uses `SET REGION_KEY = ...` session variables internally, which work with `snow sql -f` but would fail with individual `snowflake_sql_execute` calls. The skill correctly notes this ("Execute all Step 5 sub-steps in a single session") but it's an inconsistency with other demos.
- **Impact:** None when using `snow sql -f`, but could trip up an agent using `snowflake_sql_execute`.

## What Went Well

1. **Image version consistency check** (`check_image_versions.sh`) caught all versions matching perfectly. Great safety net.
2. **Grant callback automation** (`GRANT_CALLBACK`) worked flawlessly - no Snowsight UI steps needed.
3. **Seed data loading** was clean - all counts matched expected values exactly (500/472869/6008/50/5000/1/1/29402).
4. **All 5 services reached RUNNING status** immediately after grant_callback.
5. **Overture Maps Marketplace** installation was smooth via `SYSTEM$ACCEPT_LEGAL_TERMS` + `CREATE DATABASE FROM LISTING`.
6. **Dwell Analysis** 12-step Dynamic Table pipeline deployed without issues.
7. **Routing Agent** Cortex Agent created successfully with all 3 tool procedures.
