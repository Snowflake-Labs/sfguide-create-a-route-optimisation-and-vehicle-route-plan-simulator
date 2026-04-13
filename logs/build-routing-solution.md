# Build Routing Solution - Friction Log

Started: 2026-04-12

## Friction, Bugs, and Observations

### Step 1 - Query Tag
- No issues. Straightforward.

### Step 2 - Container Runtime Detection
- Both Podman and Docker detected. Skill correctly asks user to choose.
- Node.js v22.22.0 detected (>= 20 requirement met).
- No friction.

### Step 3 - Database and Stages
- No issues. All CREATE IF NOT EXISTS worked cleanly.
- All objects verified successfully.

### Step 4 - Upload Configuration Files
- **FRICTION**: The skill says paths are relative to the skill directory (`.cortex/skills/build-routing-solution/`), but Step 4 uses paths like `native_app/provider_setup/staged_files/SanFrancisco.osm.pbf` and `scripts/download_map.py` WITHOUT clarifying this. If you run from repo root (which is the normal working directory), these paths don't exist. The actual paths are under `.cortex/skills/build-routing-solution/`. This is mentioned in "Execution Rules" Rule 1, but the `snow stage copy` commands don't reflect this — they show bare relative paths. The agent must mentally prepend the skill directory. This is confusing and error-prone.
- **FRICTION**: The skill uses `<connection>` placeholder but the `snowflake_sql_execute` tool and `snow` CLI use different connections. The `snowflake_sql_execute` tool connects to `wgb26798` via account config, but `snow` CLI's `default` connection points to a different account (`SFCOGSOPS-SNOWHOUSE_AWS_US_WEST_2`). The correct CLI connection was `fleet_test_evals`. The skill should either (a) detect the correct connection from the Snowflake context, or (b) explicitly tell the agent how to find the matching CLI connection name. This caused one failed upload attempt.
- **NOTE**: `snow` CLI version 3.9.0 shows deprecation warning about newer version 3.16.0.

### Step 5 - Build and Push Container Images
- ARM Mac (Apple Silicon) detected. Used Dockerfile.runtime approach for ors_control_app as documented.
- All 5 images built successfully: openrouteservice:v9.0.0, downloader:v0.0.3, routing_reverse_proxy:v1.0.0, vroom-docker:v1.0.1, ors_control_app:v1.0.87
- All 5 images pushed to SPCS registry and verified.
- **NOTE**: Build was fast (~17s for ors_control_app, others cached) but push took ~10 minutes for openrouteservice (159MB large layer).
- The `build-images.md` reference was clear and well-structured. No friction on this step.
- **SUSPICIOUS**: The `npm ci` reported 4 vulnerabilities (2 moderate, 2 high) in ors_control_app dependencies. Not a deployment blocker but worth noting for security review.

### Step 5b - Version Consistency Check
- `check_image_versions.sh` ran cleanly: PASSED for all 5 images across manifest.yml, service YAMLs, and build-images.md.
- No friction.

### Step 6 - Deploy Native App
- `snow app run` succeeded. App URL: https://app.snowflake.com/PM/fleet_test/#/apps/application/OPENROUTESERVICE_NATIVE_APP
- Warehouse grant, database creation, and app grants all succeeded.
- **NOTE**: `snow app run` takes about 2 minutes (stage upload + validation + creation). No friction.

### Step 7 - User Confirmation
- User confirmed app is running in Snowsight.
- Verified all 5 services RUNNING: DOWNLOADER, ORS_CONTROL_APP, ORS_SERVICE (3 instances), ROUTING_GATEWAY_SERVICE (3 instances), VROOM_SERVICE.
- No friction.

### Step 8 - Load Seed Datasets
- **BUG**: `load-seed-data.sql` ran via `snow sql -f`, but several COPY INTO statements loaded 0 rows:
  - **DIM_FLEET**: `COPY ... FROM @...synthetic_ebikes/dim_fleet ... MATCH_BY_COLUMN_NAME` => "Copy executed with 0 files processed". The file is at `synthetic_ebikes/dim_fleet_0_0_0.snappy.parquet` (root), not `synthetic_ebikes/dim_fleet/` (subfolder). The prefix match works the second time we run it manually, but NOT the first time within `snow sql -f`. This is a Snowflake COPY-INTO caching issue: when the script ran it already "saw" the file but didn't load it (possibly because MATCH_BY_COLUMN_NAME conflicted with the path resolution in sequential multi-statement execution).
  - **DIM_POIS**: Same issue — "Copy executed with 0 files processed" on first run. Reloading manually with the same SQL worked fine.
  - **FACT_VEHICLE_TELEMETRY**: Only loaded 2 of 8 parquet files (90,112 of 472,869 rows). The remaining 6 files were silently skipped. Adding `FORCE = TRUE` or truncating + re-running loaded all 8 files.
  - **Matrix table** (SANFRANCISCO_CYCLING_ELECTRIC_MATRIX_RES8): The CREATE TABLE inside the native app database failed silently when run via `snow sql -f` — the script's last SELECT returned "Seed data loaded successfully" but the matrix table didn't exist afterward. Re-running the CREATE + COPY manually worked.
- **ROOT CAUSE HYPOTHESIS**: Running `snow sql -f` with a large multi-statement SQL file may have issues with COPY INTO metadata caching across statements, causing some COPYs to skip files they think were already loaded in the same session.
- **WORKAROUND**: After running `snow sql -f`, manually verified counts and re-ran any COPY with 0 rows using `FORCE = TRUE`.
- **SUGGESTION**: The `load-seed-data.sql` script should add `FORCE = TRUE` to all COPY INTO statements, or split into separate files/steps to avoid this issue.
- **All final counts verified correct**: INTRO_TRIPS=500, TELEMETRY=472869, TRIPS=6008, FLEET=50, POIS=5000, JOBS=1, REGIONS=1, MATRIX=29402.

### Step 9 - Select and Deploy Demos
- User selected ALL 6 demos: Fleet Intelligence: Food Delivery, Route Deviation, Dwell Analysis, Fleet Intelligence: Taxis, Retail Catchment, Route Optimization.
- Deploying in dependency order per skill instructions.

#### Fleet Intelligence: Food Delivery
- Deployed successfully. CONFIG=1 row, DELIVERIES=6008, RESTAURANTS_ENRICHED=5000.
- No friction.

#### Route Deviation
- Deployed via `snow sql -f seed-data.sql`. All views + ETL tables created.
- TRIP_DEVIATION_ANALYSIS, DRIVER_DEVIATION_SUMMARY, DAILY_DEVIATION_TRENDS all populated.
- No friction.

#### Dwell Analysis
- Deployed via `snow sql -f seed-data.sql` + `snow sql -f sql-pipeline.sql`.
- 8 Dynamic Tables + SLA alert task created and running.
- No friction.

#### Fleet Intelligence: Taxis, Retail Catchment, Route Optimization
- **BLOCKED**: Overture Maps Marketplace data (`OVERTURE_MAPS__*` databases) not found in the account. These 3 demos require Overture Maps data for realistic POI locations and competitor mapping.
- **ACTION NEEDED**: User needs to get the Overture Maps listing from the Snowflake Marketplace before these demos can be deployed.

## Summary

### Overall Deployment Status
- **Steps 1-8**: All completed successfully (infrastructure, images, app, seed data).
- **Step 9 Demos Deployed**: 3 of 6 (Food Delivery, Route Deviation, Dwell Analysis).
- **Step 9 Demos Blocked**: 3 of 6 (Taxis, Retail Catchment, Route Optimization — need Overture Maps).

### Top Friction Points
1. **Step 4 path confusion**: Skill references paths relative to skill dir but doesn't prepend them in commands.
2. **Step 4 connection mismatch**: `snow` CLI default connection != Snowflake IDE connection.
3. **Step 8 COPY INTO partial loads**: `load-seed-data.sql` silently loaded partial data for 3 tables; needed manual FORCE=TRUE re-runs.

### Objects Created
| Object | Type | Location |
|--------|------|----------|
| OPENROUTESERVICE_SETUP | Database | Snowflake |
| OPENROUTESERVICE_NATIVE_APP | Application | Snowflake |
| OPENROUTESERVICE_NATIVE_APP_PKG | Application Package | Snowflake |
| ROUTING_ANALYTICS | Warehouse | Snowflake |
| SYNTHETIC_DATASETS | Database | Snowflake |
| FLEET_INTELLIGENCE | Database | Snowflake |
| 5 SPCS services | Services | Native app |
| 5 container images | Images | SPCS registry |

### Total Time
- ~20 minutes build + push
- ~5 minutes deploy + seed data
- ~5 minutes demo deployment
- ~30 minutes total

