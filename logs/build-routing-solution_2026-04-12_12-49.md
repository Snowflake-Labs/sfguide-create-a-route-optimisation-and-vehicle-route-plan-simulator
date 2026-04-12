# Build Routing Solution - Friction Log

Started: 2026-04-12 12:49 UTC-7

## Friction, Bugs, and Observations

### Step 1 - Query Tag
- No issues.

### Step 2 - Container Runtime Detection
- Both Podman and Docker detected. Skill correctly asks user to choose.
- Node.js v22.22.0 detected (>= 20 requirement met).
- No friction.

### Step 3 - Database and Stages
- No issues. All CREATE IF NOT EXISTS worked cleanly.

### Step 4 - Upload Configuration Files
- **FRICTION (repeated from prior run)**: Skill says "paths are relative to skill directory" in Execution Rules but Step 4 commands show bare relative paths (e.g., `native_app/provider_setup/...`). The `snow stage copy` commands in the SKILL.md body DO correctly prepend `.cortex/skills/build-routing-solution/` but only because they reference "paths relative to repo root." This is confusing — the Execution Rule says skill dir, but the commands use repo root. Should pick one and be consistent.
- **FRICTION (repeated)**: Connection name mismatch between `snowflake_sql_execute` (uses IDE connection `wgb26798`) and `snow` CLI (default connection points to a different account). Correct CLI connection `fleet_test_evals` had to be identified manually by matching the `account` field. The skill should have a clearer note about this.
- **NOTE**: `snow` CLI version 3.9.0 shows deprecation warning. New version 3.16.0 available.

### Step 5 - Build and Push Container Images
- ARM Mac (Apple Silicon) detected. Used Dockerfile.runtime approach for ors_control_app as documented.
- All 5 images built successfully (all cached from prior builds).
- **FRICTION**: Docker push output is invisible when running via background `bash` tool with `tail` filter. The progress output uses carriage returns which don't survive `tail`. Had to run push commands synchronously (foreground) to confirm they completed. Not a skill bug, but the skill has no guidance on verifying pushes completed.
- **NOTE**: npm ci reported 4 vulnerabilities (2 moderate, 2 high) in ors_control_app dependencies.
- All 5 images pushed successfully: openrouteservice:v9.0.0, downloader:v0.0.3, routing_reverse_proxy:v1.0.0, vroom-docker:v1.0.1, ors_control_app:v1.0.87.

### Step 5b - Version Consistency Check
- `check_image_versions.sh` ran cleanly: PASSED for all 5 images.
- No friction.

### Step 6 - Deploy Native App
- `snow app run` succeeded. App URL: https://app.snowflake.com/PM/fleet_test/#/apps/application/OPENROUTESERVICE_NATIVE_APP
- All grants succeeded.
- No friction.

### Step 7 - User Confirmation
- User confirmed app is running in Snowsight.
- All 5 services RUNNING.
- No friction.

### Step 8 - Load Seed Datasets
- **BUG (repeated from prior run)**: `load-seed-data.sql` run via `snow sql -f` loaded partial data:
  - **DIM_FLEET**: 0 files processed. Stage path is `synthetic_ebikes/dim_fleet` but file is `synthetic_ebikes/dim_fleet_0_0_0.snappy.parquet` (flat, not in subfolder). The COPY INTO prefix `dim_fleet` should match `dim_fleet_` (with trailing underscore) to hit the flat file. Fixed by using path `synthetic_ebikes/dim_fleet_` manually.
  - **DIM_POIS**: Same issue — 0 files processed. Fixed with path `synthetic_ebikes/dim_pois_`.
  - **FACT_VEHICLE_TELEMETRY**: Only loaded 4 of 8 files (211,746 of 472,869 rows). Fixed by TRUNCATE + re-COPY with FORCE=TRUE.
- **BUG**: `load-seed-data.sql` has a syntax error at line ~390: `CREATE OR REPLACE PROCEDURE ... EXECUTE AS OWNER COMMENT = '...' AS $$`. The COMMENT clause is between EXECUTE AS OWNER and AS, which causes `syntax error line 7 at position 0 unexpected 'COMMENT'`. The COMMENT must come before RETURNS or after CREATE OR REPLACE PROCEDURE directly. I had to run the procedure creation manually without the COMMENT.
- **ROOT CAUSE for dim_fleet/dim_pois**: The COPY INTO uses prefix path `synthetic_ebikes/dim_fleet` which matches `synthetic_ebikes/dim_fleet_0_0_0.snappy.parquet`, but Snowflake interprets `dim_fleet` as a directory prefix and expects files IN that directory (like `dim_fleet/something.parquet`). Adding the trailing underscore `dim_fleet_` makes it match correctly as a file prefix.
- **SUGGESTION**: Fix `load-seed-data.sql`:
  1. Change `FROM @.../synthetic_ebikes/dim_fleet` to `FROM @.../synthetic_ebikes/dim_fleet_`
  2. Change `FROM @.../synthetic_ebikes/dim_pois` to `FROM @.../synthetic_ebikes/dim_pois_`
  3. Move COMMENT from SET_ACTIVE_REGION procedure to after creation via ALTER PROCEDURE
  4. Add FORCE = TRUE to all COPY INTO statements (already present but telemetry still had partial loads)
- **All final counts verified**: INTRO_TRIPS=500, TELEMETRY=472869, TRIPS=6008, FLEET=50, POIS=5000, JOBS=1, REGIONS=1, MATRIX=29402.

### Step 8b - Overture Maps
- Both datasets installed successfully via SYSTEM$ACCEPT_LEGAL_TERMS + CREATE DATABASE FROM LISTING.
- Grants to native app succeeded.
- No friction.

### Step 9 - Demo Deployments

#### Fleet Intelligence: Food Delivery
- Deployed via `seed-data.sql`. CONFIG=1, DELIVERIES=6008, RESTAURANTS_ENRICHED=5000.
- No friction.

#### Route Deviation
- Deployed via `seed-data.sql`. All 3 ETL tables populated: TRIP_DEVIATION_ANALYSIS=6008, DRIVER_DEVIATION_SUMMARY=50, DAILY_DEVIATION_TRENDS=7.
- No friction.

#### Dwell Analysis
- Deployed via `seed-data.sql` + `sql-pipeline.sql`. 8 Dynamic Tables + SLA alert task created.
- No friction.

#### Fleet Intelligence: Taxis
- Deployed via `seed-data.sql`. All projection views populated with seed data.
- No friction.

#### Retail Catchment
- **FRICTION**: The `sql-pipeline.md` uses `SET` session variables (`$REGION_KEY`, `$BBOX_MIN_LON`, etc.) which don't persist across `snowflake_sql_execute` calls. Had to inline all values manually. The pipeline should either use a SQL file runnable via `snow sql -f` or document that SET variables require CLI execution.
- **BUG**: `ALTER TABLE ... CLUSTER BY (GEOMETRY)` on REGIONAL_ADDRESSES (GEOGRAPHY column) fails: `Invalid argument types for function 'LINEARIZE': (VARCHAR(6), BOOLEAN, BOOLEAN, NUMBER(1,0), GEOGRAPHY)`. GEOGRAPHY columns cannot be used in CLUSTER BY per Snowflake docs. The `sql-pipeline.md` Step 5g should not include this.
- RETAIL_POIS=56303, CITIES_BY_STATE=138, REGIONAL_ADDRESSES=2826892.

#### Route Optimization
- Deployed via notebook execution. PLACES=1,430,684, LOOKUP=4, JOB_TEMPLATE=29.
- AISQL notebook uploaded (San Francisco, no edits needed).
- No friction.

## Summary

### Overall Deployment Status
- **Steps 1-8b**: All completed successfully.
- **Step 9 Demos**: All 6 deployed (Food Delivery, Route Deviation, Dwell Analysis, Taxis, Retail Catchment, Route Optimization).

### Top Friction Points (Actionable Bugs)
1. **`load-seed-data.sql` DIM_FLEET/DIM_POIS COPY path bug**: Prefix `dim_fleet` doesn't match flat files `dim_fleet_0_0_0.snappy.parquet`. Needs trailing underscore.
2. **`load-seed-data.sql` procedure COMMENT syntax error**: COMMENT between EXECUTE AS OWNER and AS is invalid SQL.
3. **`load-seed-data.sql` partial telemetry loads**: 4 of 8 files skipped silently. FORCE=TRUE + TRUNCATE workaround needed.
4. **`sql-pipeline.md` (retail-catchment) CLUSTER BY GEOGRAPHY**: Invalid — GEOGRAPHY columns can't be clustered.
5. **`sql-pipeline.md` (retail-catchment) SET variables**: Don't persist in `snowflake_sql_execute` tool calls.

### Minor Friction
6. Step 4 path confusion (repo root vs skill dir)
7. CLI connection mismatch (default != IDE connection)
8. Docker push output invisible in background mode

### Objects Created
| Object | Type | Location |
|--------|------|----------|
| OPENROUTESERVICE_SETUP | Database | Snowflake |
| OPENROUTESERVICE_NATIVE_APP | Application | Snowflake |
| OPENROUTESERVICE_NATIVE_APP_PKG | Application Package | Snowflake |
| ROUTING_ANALYTICS | Warehouse | Snowflake |
| SYNTHETIC_DATASETS | Database | Snowflake |
| FLEET_INTELLIGENCE | Database | Snowflake |
| OVERTURE_MAPS__PLACES | Database (Marketplace) | Snowflake |
| OVERTURE_MAPS__ADDRESSES | Database (Marketplace) | Snowflake |
| 5 SPCS services | Services | Native app |
| 5 container images | Images | SPCS registry |

### Total Time
- ~5 minutes infrastructure + image build (cached)
- ~10 minutes image push
- ~5 minutes app deploy + seed data
- ~10 minutes demo deployment (6 demos)
- ~30 minutes total
