# Build Routing Solution — 2026-04-13 04:30 PT

## Summary
Full end-to-end deployment completed successfully. All 7 demo skills deployed on top of the base ORS native app.

## Environment
- Account: wgb26798 (fleet_test_evals connection)
- Role: ACCOUNTADMIN
- Container runtime: Docker 29.3.1
- Node.js: v22.22.0
- OS: macOS (ARM/Apple Silicon)

## Steps Completed
| Step | Duration | Status | Notes |
|------|----------|--------|-------|
| 1. Query Tag | <1s | OK | |
| 2. Runtime Detection | <1s | OK | Both Docker+Podman available; chose Docker per user request |
| 3. Database + Stages | ~5s | OK | All 3 stages + image repo + warehouse created |
| 4. Upload Config Files | ~15s | OK | SanFrancisco.osm.pbf (25MB), ors-config.yml, download_map.py |
| 5. Build + Push Images | ~8 min | OK | All 5 images built in parallel, ARM Mac workaround for ors_control_app |
| 5b. Version Check | <1s | OK | All 5 image:tag pairs consistent |
| 6. Deploy Native App | ~30s | OK | `snow app run` succeeded first try |
| 7. Activate App | ~3 min | OK | Grant callback returned "App successfully deployed" |
| 8. Seed Data | ~2 min | OK | All 9 verification counts matched exactly |
| 8b. Overture Maps | ~30s | OK | Both Places and Addresses installed |
| 9a. Food Delivery | ~10s | OK | Seed-data path: CONFIG + 2 views |
| 9b. Taxis | ~15s | OK | Seed-data path: CONFIG + 7 views |
| 9c. Route Deviation | ~20s | OK | Seed-data path: 5 views + 3 ETL tables |
| 9d. Dwell Analysis | ~45s | OK | Seed-data + 8 Dynamic Tables + 1 Task (resumed) |
| 9e. Retail Catchment | ~90s | OK | RETAIL_POIS=56303, REGIONAL_ADDRESSES=2,826,892 |
| 9f. Route Optimization | ~15s | OK | PLACES + LOOKUP + JOB_TEMPLATE populated |
| 9g. Routing Agent | ~10s | OK | 3 procedures + 1 Cortex Agent created |

## Friction / Issues Noted

### 1. No friction on core deployment (Steps 1-8b)
Everything worked first try. The skill instructions were clear and complete. `snow app run` from native_app/ directory worked without issues. Grant callback succeeded.

### 2. npm build output truncation (Step 5 - ors_control_app)
**Severity:** Minor (cosmetic)
**Issue:** When running `npm ci && npm run build && npm run build:server` in a single command with `| tail -5`, the initial background execution appeared incomplete because the bash_output tool showed only partial results. Had to re-run each npm command separately to confirm success.
**Suggestion:** The skill instructions already note the ARM Mac esbuild workaround correctly. Consider adding a note that `npm run build:server` output is minimal (just the tsc command) so users don't think it failed.

### 3. Dwell Analysis requires two-phase deployment (seed-data.sql + sql-pipeline.sql)
**Severity:** Low (expected, documented)
**Issue:** Unlike other demos that have a single seed-data.sql, Dwell Analysis requires running seed-data.sql first (views + static tables) then sql-pipeline.sql (Dynamic Tables). This is documented in the SKILL.md but the sql-pipeline.sql actually re-creates everything from scratch (Steps 1-13), making the seed-data.sql redundant if you're running the full pipeline.
**Suggestion:** Consider adding a `--skip-to-dt` flag or noting that `sql-pipeline.sql` is self-contained and includes all seed-data objects.

### 4. Retail Catchment seed-data.sql uses SET variables (session-dependent)
**Severity:** Low (works with `snow sql -f`)
**Issue:** The seed-data.sql uses `SET REGION_GEOHASH` / `SET BBOX_*` which are session variables that don't persist across `snowflake_sql_execute` calls. Running via `snow sql -f` works fine, but individual tool calls would require inlining the values.
**Suggestion:** Already documented in the skill as a known limitation. No change needed.

### 5. Both Podman and Docker available — skill correctly asks user to choose
**Severity:** None (working as designed)
**Note:** The skill correctly handles the case where both container runtimes are available. User pre-approved Docker.

## Verification
- 5/5 SPCS services: RUNNING
- Seed data counts: All 9 tables matched expected values exactly
- All 7 demo skills deployed and granted to OPENROUTESERVICE_NATIVE_APP
- Routing Agent created with 3 tool procedures

## Total Deployment Time
~20 minutes (including parallel Docker builds)
