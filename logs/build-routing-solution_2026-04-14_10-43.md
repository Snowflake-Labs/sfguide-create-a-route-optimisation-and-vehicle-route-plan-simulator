# Build Routing Solution — Execution Log
**Date:** 2026-04-14 10:43 UTC
**Connection:** fleet_test_evals (wgb26798, ACCOUNTADMIN)
**Container Runtime:** Docker 29.3.1
**Node.js:** v22.22.0

## Friction / Issues Found

### 1. ors_control_app image push appeared to succeed but image was missing
- **Severity:** Medium
- **Step:** 5 (Build and Push)
- **What happened:** Pushed all 5 images in parallel. Docker push for ors_control_app showed output with carriage returns but when listing images, only 4 appeared. Had to re-push ors_control_app separately.
- **Root cause:** Docker push progress output uses carriage returns that are invisible in terminal capture. The push likely didn't finish despite terminal appearing idle.
- **Skill already warns:** Yes — "Docker push output uses carriage returns that may be invisible when pushing in parallel. Always confirm all 5 images are present."
- **Suggestion:** The skill's warning is correct. Consider adding a mandatory serial verification after each parallel push completes, or suggesting serial pushes to avoid this.

### 2. FLEET_INTELLIGENCE.CORE schema creation failed on first attempt
- **Severity:** Low
- **Step:** 6 (Deploy Native App — Data Studio databases)
- **What happened:** Attempted to create `FLEET_INTELLIGENCE.CORE` schema before creating the `FLEET_INTELLIGENCE` database. Got error: `Database 'FLEET_INTELLIGENCE' does not exist or not authorized.`
- **Root cause:** The SKILL.md lists the CREATE DATABASE and CREATE SCHEMA statements together, but I issued them in the wrong order (schema before database) when batching parallel SQL calls.
- **Suggestion:** The SKILL.md is correct (DB comes first). This is agent error, not skill friction. However, the skill could note that the database MUST exist before the schema.

### 3. Dwell Analysis Dynamic Tables take a long time (~8 minutes)
- **Severity:** Info
- **Step:** 9c (Dwell Analysis)
- **What happened:** The `sql-pipeline.sql` for dwell-analysis creates 8 Dynamic Tables + 1 Task. Each DT creation takes time as it does an initial refresh against 472K telemetry rows. Total time was ~8 minutes.
- **Root cause:** Expected behavior for DTs with large source data.
- **Suggestion:** Add an estimated duration to the dwell-analysis SKILL.md (e.g., "Expected duration: 8-10 minutes for 500K source rows").

### 4. Retail Catchment and Route Optimization seed-data.sql take 3-5 minutes
- **Severity:** Info
- **Step:** 9e, 9f
- **What happened:** Both scripts query large Overture Maps datasets (PLACE, ADDRESS tables). REGIONAL_ADDRESSES alone loaded 2.8M rows.
- **Root cause:** Expected — querying marketplace datasets with large bounding boxes.
- **Suggestion:** Already documented in retail-catchment SKILL.md. No change needed.

## Summary

| Step | Status | Duration | Notes |
|------|--------|----------|-------|
| 1: Query tag | OK | <1s | |
| 2: Detect runtime | OK | <1s | Docker + Node.js both available |
| 3: Setup DB/stages | OK | ~5s | All 6 objects created |
| 4: Upload configs | OK | ~10s | 3 files (25MB map + 2 configs) |
| 5: Build images | OK | ~3 min | All cached from prior builds |
| 5b: Version check | OK | <1s | All versions consistent |
| 6: Deploy native app | OK | ~3 min | 5 services started |
| 7: Activate app | OK | ~3 min | EAI + grant_callback |
| 8: Load seed data | OK | ~2 min | All 9 counts match expected |
| 8b: Overture Maps | OK | ~30s | Both datasets installed |
| 9a: Food Delivery | OK | ~15s | 3 objects (CONFIG + 2 views) |
| 9b: Route Deviation | OK | ~30s | 9 objects (CONFIG + 5 views + 3 ETL tables) |
| 9c: Dwell Analysis | OK | ~8 min | 18 objects (CONFIG + 5 views + 2 tables + 8 DTs + 1 task + 1 alert log) |
| 9d: Taxis | OK | ~15s | 8 objects (CONFIG + 7 views) |
| 9e: Retail Catchment | OK | ~4 min | 6 objects (CONFIG + 4 tables + 1 region_config) |
| 9f: Route Optimization | OK | ~3 min | 5 objects (CONFIG + PLACES + LOOKUP + JOB_TEMPLATE + REGION_DATA) |
| 9g: Routing Agent | OK | ~10s | 4 objects (3 procedures + 1 agent) |

**Total execution time:** ~25 minutes (including parallel builds/deploys)
**All 7 demo skills deployed successfully.**
