---
name: build-routing-solution
description: "Build routing solution WITH SPCS. Use when: build routing solution, set up OpenRouteService app, building and pushing SPCS images, deploy ORS app to Snowflake, redeploy spcs app, rebuild container images. Do NOT use for: changing maps or routing profiles (use routing-customization), deploying demo apps (use route-optimization or fleet-intelligence-taxis). Triggers: build routing solution, install openrouteservice app, set up OpenRouteService, build and push SPCS images, deploy ORS app, redeploy app, rebuild images, SPCS image build, OpenRouteService deployment."
metadata:
  author: Snowflake SIT-IS
  version: 1.0.0
  category: infrastructure
---

# Deploy Route Optimizer

Deploys the OpenRouteService route optimization application using Snowpark Container Services.

## Execution Rules

1. All relative paths (e.g., `OP/`, `scripts/`) are relative to this skill's directory (`.cortex/skills/build-routing-solution/`).
2. Replace `<connection>` with the user's active Snowflake CLI connection name. To find it, run `snow connection list` and match by account URL (the `account` field should match the account shown in the Snowflake IDE). If `snow connection list` fails (known issue on some Snow CLI versions), read `~/.snowflake/connections.toml` directly and match by account name. Verify the connection works with `snow sql -q "SELECT CURRENT_ACCOUNT()" -c <connection>`. The `snowflake_sql_execute` tool and `snow` CLI may use DIFFERENT connections — always verify. If no matching connection exists, run `snow connection add` to create one.
3. Before modifying `setup_script.sql` or any service YAML, read `references/snowflake-scripting-guidelines.md`.
4. After every deployment, run verification queries from `references/snowflake-scripting-guidelines.md` Section 9.
5. **Batch bash commands:** Combine multiple `snow` CLI calls into a single bash tool invocation using `&&` to avoid repeated user approval prompts. Never split `snow stage copy` or `snow sql` calls across separate bash invocations when they can be chained.
6. **Prefer snowflake_sql_execute:** Use the `snowflake_sql_execute` tool for individual SQL statements instead of `snow sql -q`. Reserve `snow sql -f` only for multi-statement SQL files.

## Prerequisites

- Container runtime (Podman or Docker) installed and running
- Node.js >= 20 and npm (required for building ors_control_app)
- Snowflake CLI (`snow`) installed
- `export SNOWFLAKE_CLI_NO_UPDATE_CHECK=true` to suppress version upgrade warnings
- Active Snowflake connection with a role that has privileges listed in the Required Privileges section below
- Repository cloned; working directory set to repo root

## Required Privileges

| Privilege | Scope | Reason |
|-----------|-------|--------|
| CREATE DATABASE | Account | Creates OPENROUTESERVICE_APP, SYNTHETIC_DATASETS, and FLEET_INTELLIGENCE databases |
| CREATE WAREHOUSE | Account | Creates ROUTING_ANALYTICS warehouse |
| CREATE COMPUTE POOL | Account | Required for SPCS container services |
| USAGE ON WAREHOUSE ROUTING_ANALYTICS | Warehouse | Runs deployment queries |
| CREATE STAGE | Schema (OPENROUTESERVICE_APP.CORE) | Creates ORS_SPCS_STAGE, ORS_GRAPHS_SPCS_STAGE, ORS_ELEVATION_CACHE_SPCS_STAGE |
| CREATE IMAGE REPOSITORY | Schema (OPENROUTESERVICE_APP.CORE) | Creates IMAGE_REPOSITORY for container images |
| CREATE INTEGRATION | Account | Creates external access integrations for ORS network rules (ORS_OSM_EAI, ORS_CARTO_EAI) |
| BIND SERVICE ENDPOINT | Account | Required for services with public endpoints (ors_control_app) |
| IMPORT SHARE | Account | Installs Overture Maps datasets from Marketplace (Step 7b): Places, Addresses, Transportation |

> **Note:** ACCOUNTADMIN is NOT required. Create a custom role with the above privileges, or use any role that has them.

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| DATABASE | `OPENROUTESERVICE_APP` | Database for ORS infrastructure objects |
| WAREHOUSE | `ROUTING_ANALYTICS` | Warehouse for ORS operations |
| WAREHOUSE_SIZE | `MEDIUM` | Size of the routing warehouse |
| IMAGE_REPO | `ORS_REPOSITORY` | Image repository for SPCS containers |
| COMPUTE_POOL | `ORS_COMPUTE_POOL` | Compute pool for ORS services |

## Workflow

> **Fresh install assumed.** This workflow targets a clean Snowflake account with no pre-existing ORS objects. All DDL uses `CREATE ... IF NOT EXISTS` or `CREATE OR REPLACE` with complete schemas from the start. All columns (JOB_ID, GEOGRAPHY, etc.) are defined in the initial CREATE TABLE statements -- no ALTER TABLE migration steps are needed.

### Step 1: Set Query Tag for Tracking

**Goal:** Set session query tag for attribution tracking.

```sql
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution-in-snowflake","version":{"major":1, "minor":0},"attributes":{"is_quickstart":1, "source":"sql"}}';
```

**Output:** Query tag set for session tracking

### Step 2: Detect Container Runtime and Node.js

**Goal:** Identify available container runtime and verify Node.js is installed

> **Note:** Version warnings from `snow` CLI (e.g., "newer version available") are informational and do not affect the build.

**Actions:**

1. **Check** which container runtimes and Node.js are installed:
   ```bash
   podman --version 2>/dev/null && echo "PODMAN_AVAILABLE=true" || echo "PODMAN_AVAILABLE=false"
   docker --version 2>/dev/null && echo "DOCKER_AVAILABLE=true" || echo "DOCKER_AVAILABLE=false"
   node --version 2>/dev/null && echo "NODE_AVAILABLE=true" || echo "NODE_AVAILABLE=false"
   ```

2. **Based on results:**
   - If **both** container runtimes are installed: Ask user which they prefer (Podman or Docker)
   - If **only Podman**: Use Podman
   - If **only Docker**: Use Docker
   - If **neither**: Stop and ask user to install one (see check-prerequisites skill)
   - If **Node.js missing**: Stop and ask user to install Node.js >= 20 (required for ors_control_app build)

3. **Verify** the selected runtime is running:
   - For Podman (macOS): Run `podman machine start` first (idempotent — returns instantly if already running). Then verify with `podman ps` to confirm the VM is functional. Do NOT rely on `podman info` alone — it returns client metadata even when the VM is stopped.
   - For Podman (Linux): `podman info` is sufficient (no VM layer).
   - For Docker: `docker info` (if fails: `open -a Docker` on macOS, then wait 5-15 seconds for Docker to initialize before retrying)

4. **Remember** which container runtime to use (`podman` or `docker`).
   Each bash tool call starts a fresh shell, so shell variables do not persist.
   In every subsequent command, **prefix inline**: `CONTAINER_CMD=podman` (or `docker`) before `$CONTAINER_CMD`, or chain all build commands in a single bash call with `&&`.

**Output:** Container runtime selected and verified running, Node.js available

**Next:** Proceed to Step 3

### Step 3: Setup Database and Stages

**Goal:** Create required Snowflake infrastructure

**Actions:**

1. **Execute** environment setup SQL:
   ```sql
   CREATE WAREHOUSE IF NOT EXISTS ROUTING_ANALYTICS
      COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"core"}}';
   
   CREATE DATABASE IF NOT EXISTS OPENROUTESERVICE_APP
      COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"core"}}';

   CREATE SCHEMA IF NOT EXISTS OPENROUTESERVICE_APP.CORE
      COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"core"}}';

   CREATE SCHEMA IF NOT EXISTS OPENROUTESERVICE_APP.TRAVEL_MATRIX
   COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"matrix"}}';

   CREATE IMAGE_REPOSITORY IF NOT EXISTS IMAGE_REPOSITORY
   COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"core"}}';

   CREATE OR ALTER STAGE core.ORS_SPCS_STAGE ENCRYPTION = ( TYPE = 'SNOWFLAKE_SSE' ) DIRECTORY = ( ENABLE = TRUE )
   COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"core"}}';

   CREATE OR ALTER STAGE core.ORS_GRAPHS_SPCS_STAGE ENCRYPTION = ( TYPE = 'SNOWFLAKE_SSE' ) DIRECTORY = ( ENABLE = TRUE )
   COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"core"}}';

   CREATE OR ALTER STAGE core.ORS_elevation_cache_SPCS_STAGE ENCRYPTION = ( TYPE = 'SNOWFLAKE_SSE' ) DIRECTORY = ( ENABLE = TRUE )
   COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"core"}}';
   ```

2. **Verify** infrastructure was created:
   ```sql
   SHOW STAGES IN SCHEMA OPENROUTESERVICE_APP.CORE;
   SHOW IMAGE REPOSITORIES IN SCHEMA OPENROUTESERVICE_APP.CORE;
   SHOW WAREHOUSES LIKE 'ROUTING_ANALYTICS';
   ```
   Expected: 3 stages (ORS_SPCS_STAGE, ORS_GRAPHS_SPCS_STAGE, ORS_ELEVATION_CACHE_SPCS_STAGE), 1 image repository (IMAGE_REPOSITORY), 1 warehouse (ROUTING_ANALYTICS).

   **If any object is missing:** Check that the role has the required privileges from the Required Privileges section above.

**Output:** Database `OPENROUTESERVICE_APP` with stages, warehouse and image repository created and verified

**Next:** Proceed to Step 4

### Step 4: Upload Configuration Files

**Goal:** Stage required configuration and map files

**Actions:**

0. **Verify image-tag consistency** (prevents F1-style failures during `01_core_infra.sql`).
   Service YAMLs reference image tags that MUST match `openrouteservice_app/image-versions.env`. Run the validator from the skill directory:
   ```bash
   bash .cortex/skills/build-routing-solution/scripts/check_image_versions.sh
   ```
   The script must print `PASSED`. If it reports `MISMATCH`, fix the offending YAML or doc to match `image-versions.env` BEFORE uploading the spec files in step 1 below — otherwise `CREATE SERVICE FROM @stage` in Step 6 will fail with `Image not found`.

1. **Upload** map, config, and script files to stage (paths are relative to the **repo root**). Run as a single chained command:
   ```bash
   snow stage copy ".cortex/skills/build-routing-solution/openrouteservice_app/staged_files/SanFrancisco.osm.pbf" \
     @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/SanFrancisco/ --connection <connection> --overwrite && \
   snow stage copy ".cortex/skills/build-routing-solution/openrouteservice_app/staged_files/ors-config.yml" \
     @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/SanFrancisco/ --connection <connection> --overwrite && \
   snow stage copy ".cortex/skills/build-routing-solution/scripts/download_map.py" \
     @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/scripts/ --connection <connection> --overwrite
   ```

2. **Upload** SPCS service specification files (required by `01_core_infra.sql` CREATE SERVICE statements):
   ```bash
   snow stage copy ".cortex/skills/build-routing-solution/openrouteservice_app/services/openrouteservice/openrouteservice.yaml" \
     @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/services/openrouteservice/ --connection <connection> --overwrite && \
   snow stage copy ".cortex/skills/build-routing-solution/openrouteservice_app/services/downloader/downloader_spec.yaml" \
      @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/services/downloader/ --connection <connection> --overwrite && \
   snow stage copy ".cortex/skills/build-routing-solution/openrouteservice_app/services/gateway/routing-gateway-service.yaml" \
     @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/services/gateway/ --connection <connection> --overwrite && \
   snow stage copy ".cortex/skills/build-routing-solution/openrouteservice_app/services/vroom/vroom-service.yaml" \
     @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/services/vroom/ --connection <connection> --overwrite  && \
   snow stage copy ".cortex/skills/build-routing-solution/openrouteservice_app/services/ors_control_app/ors_control_app_service.yaml" \
     @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/services/ors_control_app/ --connection <connection> --overwrite 
   ```

**Output:** Configuration files and service specs uploaded to Snowflake stage

**Next:** Proceed to Step 5

### Step 5: Build and Push Container Images

**Goal:** Build 5 container images and push to Snowflake image repository

**Before building:** Read `openrouteservice_app/image-versions.env` (the single source of truth for all image tags). Use these values for all `-t` flags. The `build-images.md` code blocks show the commands but always cross-check tags against `openrouteservice_app/image-versions.env`.

Follow the full build instructions in `references/build-images.md`. Summary:

1. **Change** to the skill directory: `cd .cortex/skills/build-routing-solution`
2. Read image tags: `source image-versions.env`
2. Authenticate with SPCS image registry (Docker or Podman)
3. Get repository URL: `snow spcs image-repository url OPENROUTESERVICE_APP.CORE.image_repository -c <connection>`
4. Build and push all 5 images using tags from openrouteservice_app/image-versions.env`: openrouteservice, downloader routing_reverse_proxy, vroom-docker, ors_control_app

**Expected Duration:** 10-20 minutes (first push; ~5 minutes with cached layers)

**If authentication fails:** Run `snow spcs image-registry login -c <connection>`. For Podman, see `references/troubleshooting.md` > "Podman Registry Auth".

**If ARM Mac esbuild crash:** Build React app locally first. For Podman, use `--ignorefile .dockerignore.prebuilt`. For Docker (which does not support `--ignorefile`), temporarily swap `.dockerignore` with `.dockerignore.prebuilt` before building. See `references/build-images.md` for exact commands.

**Next:** Proceed to Step 6

### Step 6: Deploy App

**Goal:** Create and deploy the application

**Actions:**

1. **Set up Data Studio databases** (required for synthetic data generation):

   > **Pre-deployment check:** Read `openrouteservice_app/image-versions.env` and verify each tag matches the corresponding service YAML file (e.g., `ORS_CONTROL_APP_TAG` must match the image tag in `openrouteservice_app/services/ors_control_app/ors_control_app_service.yaml`). If any tag differs, update the YAML to match the env file. This prevents "Image not found" errors at CREATE SERVICE time.
   ```sql
   CREATE DATABASE IF NOT EXISTS SYNTHETIC_DATASETS
     COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
   CREATE SCHEMA IF NOT EXISTS SYNTHETIC_DATASETS.UNIFIED
     COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
   CREATE DATABASE IF NOT EXISTS FLEET_INTELLIGENCE
     COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
   CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.CORE 
     COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
   ```

   > **Prerequisite:** Step 4 must have uploaded service YAML specs to `@ORS_SPCS_STAGE/services/`. Module `01_core_infra.sql` creates services using `FROM @stage SPECIFICATION_FILE=` which will fail if the spec files are missing.

   ```bash
   snow sql -f ".cortex/skills/build-routing-solution/openrouteservice_app/app/modules/01_core_infra.sql"       -c <connection> && \
   snow sql -f ".cortex/skills/build-routing-solution/openrouteservice_app/app/modules/02_routing_functions.sql" -c <connection> && \
   snow sql -f ".cortex/skills/build-routing-solution/openrouteservice_app/app/modules/03_region_management.sql" -c <connection> && \
   snow sql -f ".cortex/skills/build-routing-solution/openrouteservice_app/app/modules/04_service_lifecycle.sql" -c <connection> && \
   snow sql -f ".cortex/skills/build-routing-solution/openrouteservice_app/app/modules/05_matrix_pipeline.sql"   -c <connection> && \
   snow sql -f ".cortex/skills/build-routing-solution/openrouteservice_app/app/modules/06_matrix_ops.sql"        -c <connection> 
   ```

   > **Recovery if 01_core_infra.sql fails partway:** Fix the underlying issue (e.g., grant missing privileges), then re-run the full file. All DDL uses `IF NOT EXISTS` or `CREATE OR REPLACE`, making re-runs safe and idempotent. Alternatively, create only the missing service(s) individually using the corresponding `CREATE SERVICE` statement from the SQL file.

2. **Verify** all services are running:
   ```sql
   SHOW SERVICES IN DATABASE OPENROUTESERVICE_APP;
   ```
   Expected: 5 services (ors_service, downloader, vroom_service, routing_gateway_service, ors_control_app). Most services reach RUNNING within 1-3 minutes.

   > **Note:** `ORS_SERVICE` typically takes 5-15 minutes to reach RUNNING status on first deploy because it builds its routing graph from the uploaded `.osm.pbf` map file. This is expected. All other deployment steps (seed data loading, demo deployment) can proceed while ORS_SERVICE starts. Routing function calls will fail until ORS_SERVICE reaches RUNNING.

   If services show SUSPENDED or PENDING after 5 minutes:
   ```sql
   SELECT SYSTEM$GET_SERVICE_STATUS('OPENROUTESERVICE_APP.CORE.ORS_SERVICE');
   SELECT SYSTEM$GET_SERVICE_STATUS('OPENROUTESERVICE_APP.CORE.ORS_CONTROL_APP');
   ```

**Output:** App fully activated with all services running

### Step 7: Load Seed Datasets

> **IMPORTANT:** This step is **required** for fleet intelligence demos. Without seed data, the Control App will have empty dashboards and Fleet Data Studio will be the only way to generate telemetry data.

**Goal:** Pre-load Intro page routes, synthetic SF ebike data, and a pre-computed travel time matrix so the app is fully populated on first launch

**Actions:**

> **Sequencing (CRITICAL):** Sub-step 1 (CREATE STAGE) MUST complete and return before sub-step 2 (uploads) starts. Do NOT parallelize them — kicking off `snow stage copy` while the CREATE STAGE call is still in flight produces `Stage SEED_DATA_STAGE does not exist or not authorized` errors (F2 in the friction log).

1. **Create the seed data stage** (not created in Step 3):
   ```sql
   CREATE STAGE IF NOT EXISTS OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE
     COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
   ```

   **Verify the stage exists before continuing:**
   ```sql
   LIST @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE;
   ```
   The query must return successfully (zero rows is fine — stage is empty until sub-step 2 uploads files). If it errors with "does not exist", retry the CREATE STAGE.

2. **Upload Parquet files to stage:**

   > **Note:** The `datasets/` directory is at the **repository root**, not in this skill's directory.

   **If using Snow CLI (local environment):** Run from repo root:
   ```bash
   snow stage copy datasets/intro/ @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/intro/ -c <connection> --overwrite && \
   snow stage copy datasets/synthetic_ebikes/ @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/synthetic_ebikes/ -c <connection> --overwrite --recursive && \
   snow stage copy datasets/metadata/ @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/metadata/ -c <connection> --overwrite --recursive && \
   snow stage copy datasets/matrix/ @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/matrix/ -c <connection> --overwrite --recursive && \
   snow stage copy datasets/matrix_jobs/ @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/matrix_jobs/ -c <connection> --overwrite --recursive && \
   snow stage copy datasets/region_catalog/ @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/region_catalog/ -c <connection> --recursive --overwrite
   ```

   **If using Snowflake Workspace:** Use COPY FILES with workspace URI:
   ```sql
   COPY FILES
   INTO @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE
   FROM 'snow://workspace/USER$.PUBLIC."<workspace-name>"/versions/live/datasets/'
   PATTERN='.*\\.parquet';
   ```
   Replace `<workspace-name>` with your actual workspace fully qualified name.

3. **Run the loader script:**
   ```bash
   snow sql -f datasets/load-seed-data.sql -c <connection>
   ```

4. **Verify** the data loaded:
   ```sql
   SELECT 'INTRO_TRIPS' AS TBL, COUNT(*) AS CNT FROM OPENROUTESERVICE_APP.CORE.INTRO_TRIPS
   UNION ALL SELECT 'TELEMETRY', COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY
   UNION ALL SELECT 'TRIPS', COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS
   UNION ALL SELECT 'FLEET', COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET
   UNION ALL SELECT 'POIS', COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.DIM_POIS
   UNION ALL SELECT 'FREIGHT_OFFERS', COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.FACT_FREIGHT_OFFERS
   UNION ALL SELECT 'JOBS', COUNT(*) FROM FLEET_INTELLIGENCE.CORE.GENERATION_JOBS
   UNION ALL SELECT 'REGIONS', COUNT(*) FROM FLEET_INTELLIGENCE.CORE.REGION_REGISTRY
   UNION ALL SELECT 'MATRIX', COUNT(*) FROM OPENROUTESERVICE_APP.TRAVEL_MATRIX.SANFRANCISCO_CYCLING_ELECTRIC_MATRIX_RES8
   UNION ALL SELECT 'REGION_CATALOG', COUNT(*) FROM OPENROUTESERVICE_APP.CORE.REGION_CATALOG;
   ```

   Expected: INTRO_TRIPS=500, TELEMETRY=472869, TRIPS=6008, FLEET=50, POIS=5000, FREIGHT_OFFERS=300, JOBS=1, REGIONS=1, MATRIX=29402, REGION_CATALOG ≥ 460 (current parquet ships ~5,200 rows; the count is a floor, not an exact match — the catalog is periodically expanded with more world regions).

   **If any count is 0 or lower than expected:** The COPY INTO may have skipped files due to metadata caching when run via `snow sql -f`. Re-run the full loader: `snow sql -f datasets/load-seed-data.sql -c <connection>`. The script uses `TRUNCATE` + `COPY INTO ... FORCE = TRUE`, so re-runs are safe and idempotent. If a single table still shows a low count after re-run, execute its TRUNCATE + COPY INTO as a standalone `snow sql -q` command (not inside the multi-statement file) to bypass metadata caching.

   **If MATRIX = 0 or table not found:** The matrix is loaded via the app's `LOAD_SEED_MATRIX` procedure (which runs `EXECUTE AS OWNER` so the table is app-owned and visible to `GET_MATRIX_INVENTORY()`). Ensure the app upgrade (Step 6) completed successfully before running the seed loader. You can also call the procedure manually:
   ```sql
   CALL OPENROUTESERVICE_APP.CORE.LOAD_SEED_MATRIX('@OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE', 'SanFrancisco', 'cycling-electric', 'RES8');
   ```

   **If REGION_CATALOG = 0:** The catalog is loaded via the app's `LOAD_SEED_CATALOG` procedure (which runs `EXECUTE AS OWNER`). Ensure the app upgrade (Step 6) completed successfully before running the seed loader. You can also call the procedure manually:
   ```sql
   CALL OPENROUTESERVICE_APP.CORE.LOAD_SEED_CATALOG('@OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE');
   ```

   **If REGION_CATALOG is much larger than 460 (e.g. ~5,200):** That's expected — the parquet snapshot is periodically expanded with more world regions and the original 460 figure was the count at the time the SKILL.md spec was written. The Region Builder treats catalog rows as additive, so a higher count just means more pre-populated regions in the dropdown. Treat 460 as a floor, not an exact match.

**Output:** Intro page shows 500 animated SF routes, Data Studio shows 1 completed E-Bike Couriers job, Matrix Viewer has a pre-computed SanFrancisco cycling-electric RES8 matrix (178 hexagons, 29K travel-time pairs), Region Builder shows 460 pre-populated catalog entries (no remote API scrape needed)

### Step 7b: Install Overture Maps Marketplace Datasets

**Goal:** Pre-install Overture Maps datasets from Snowflake Marketplace so downstream demos that need POI/address/transportation data (Taxis, Retail Catchment, Route Optimization, Road-Aware Matrix) are not blocked.

**Actions:**

1. **Check** if the datasets are already installed:
   ```sql
   SHOW DATABASES LIKE 'OVERTURE_MAPS%';
   ```

2. **If `OVERTURE_MAPS__PLACES` is NOT listed**, install it:
   ```sql
   CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZT0Z4CM1E9KR');
   CREATE DATABASE IF NOT EXISTS OVERTURE_MAPS__PLACES FROM LISTING GZT0Z4CM1E9KR;
   ```
   Marketplace link: https://app.snowflake.com/marketplace/listing/GZT0Z4CM1E9KR/carto-overture-maps-places

3. **If `OVERTURE_MAPS__ADDRESSES` is NOT listed**, install it:
   ```sql
   CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZT0Z4CM1E9NQ');
   CREATE DATABASE IF NOT EXISTS OVERTURE_MAPS__ADDRESSES FROM LISTING GZT0Z4CM1E9NQ;
   ```
   Marketplace link: https://app.snowflake.com/marketplace/listing/GZT0Z4CM1E9NQ/carto-overture-maps-addresses

4. **If `OVERTURE_MAPS__TRANSPORTATION` is NOT listed**, install it:
   ```sql
   CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZT0Z4CM1E9KJ');
   CREATE DATABASE IF NOT EXISTS OVERTURE_MAPS__TRANSPORTATION FROM LISTING GZT0Z4CM1E9KJ;
   ```
   Marketplace link: https://app.snowflake.com/marketplace/listing/GZT0Z4CM1E9KJ/carto-overture-maps-transportation

5. **Verify** all datasets are accessible:
   ```sql
   SELECT COUNT(*) FROM OVERTURE_MAPS__PLACES.CARTO.PLACE LIMIT 1;
   SELECT COUNT(*) FROM OVERTURE_MAPS__ADDRESSES.CARTO.ADDRESS WHERE COUNTRY = 'US' LIMIT 1;
   SELECT COUNT(*) FROM OVERTURE_MAPS__TRANSPORTATION.CARTO.SEGMENT WHERE SUBTYPE = 'road' LIMIT 1;
   ```

**If SYSTEM$ACCEPT_LEGAL_TERMS fails:** The user may need to accept terms manually via Snowsight Marketplace using the links above.

**Output:** Overture Maps databases available. Demos requiring POI data (Taxis, Retail Catchment, Route Optimization) and road-aware matrix filtering can now be deployed.

### Step 8: Select and Deploy Demos

**Goal:** Ask the user which demo skills to deploy on top of the base ORS installation. They can choose not to deploy any demos.

**Actions:**

1. **Present the available demos** and ask the user to select which ones to deploy:

   | Demo | Description | Time | Prerequisites |
   |------|-------------|------|---------------|
   | **Fleet Intelligence: Food Delivery** | E-bike courier fleet with projection views from seed data | ~2 min | Seed data (Step 8) |
   | **Route Deviation** | Detour detection ETL comparing actual vs planned routes | ~5 min | Seed data (Step 8) |
   | **Dwell Analysis** | 12-step Dynamic Table pipeline for dwell/congestion/SLA alerts | ~10 min | Seed data (Step 8) |
   | **Fleet Intelligence: Taxis** | Taxi GPS telemetry with Overture Maps POIs + driver routes | ~5 min | Overture Maps (auto-installed in Step 8b) |
   | **Retail Catchment** | Isochrone retail location analysis + competitor mapping | ~5 min | Overture Maps (auto-installed in Step 8b) |
   | **Route Optimization (seed + VRP page)** | Seeds PLACES/LOOKUP/JOB_TEMPLATE; powers the VRP page in the Control App | ~5 min | Overture Maps (Step 8b) |
   | **Route Optimization (AISQL notebook)** | Optional Snowsight notebook with AISQL exploration prompts. Skippable — VRP page works without it. | ~3 min | Above + Cortex Claude access (`claude-sonnet-4-5`); may need `CORTEX_ENABLED_CROSS_REGION='ANY_REGION'` |
   | **Routing Agent** | Snowflake Intelligence agent wrapping ORS routing functions | ~5 min | Cortex AI access (claude-sonnet-4-5) |

   **Recommended for first-time users:** Fleet Intelligence: Food Delivery, Route Deviation, Dwell Analysis.
   These three use the seed data already loaded in Step 8 and require no additional Marketplace data or services.

   > **Explicit AISQL prompt:** When deploying Route Optimization, ALWAYS ask the user whether to also deploy the AISQL notebook (default: yes for first-install). Do NOT silently skip it — the friction log F-AISQL item documents that the notebook is easy to miss otherwise. If the user opts in, follow `.cortex/skills/route-optimization/references/notebook-deployment.md` (and use the SanFrancisco fast-path described there when `<NOTEBOOK_CITY>` already matches).

2. **Deploy selected demos in dependency order:**
   - **First (independent, can run in parallel):** Fleet Intelligence: Food Delivery, Fleet Intelligence: Taxis, Retail Catchment, Route Optimization, Routing Agent
   - **Then:** Route Deviation (needs SYNTHETIC_DATASETS data)
   - **Then:** Dwell Analysis (needs SYNTHETIC_DATASETS data)

3. **For each selected demo**, invoke the corresponding skill:
   - Fleet Intelligence: Food Delivery -> Read and follow `.cortex/skills/fleet-intelligence-food-delivery/SKILL.md`
   - Fleet Intelligence: Taxis -> Read and follow `.cortex/skills/fleet-intelligence-taxis/SKILL.md`
   - Route Deviation -> Read and follow `.cortex/skills/route-deviation/SKILL.md`
   - Dwell Analysis -> Read and follow `.cortex/skills/dwell-analysis/SKILL.md`
   - Retail Catchment -> Read and follow `.cortex/skills/retail-catchment/SKILL.md`
   - Route Optimization -> Read and follow `.cortex/skills/route-optimization/SKILL.md`
   - Routing Agent -> Read and follow `.cortex/skills/routing-agent/SKILL.md`

4. **After all selected demos are deployed**, verify by checking the ORS Control App — each deployed demo should appear as a page in the navigation menu.

**Output:** Selected demos deployed and verified in the ORS Control App

### Step 9: Generate Friction Log

**Goal:** Create a friction log capturing the full installation experience.

**This step is MANDATORY — do not skip, even if everything succeeded.**

**Actions:**

1. **Create** a friction log file in `logs/friction-log_{YYYY-MM-DD}_{HH-MM}.md` using the template from `logs/README.md`.
2. **Record** wall-clock duration for each step completed.
3. **Document** any friction points encountered (slow operations, confusing instructions, unexpected behavior, workarounds applied).
4. **For each friction point**, record:
   - What was done to resolve it during this run
   - A recommendation for how to prevent it in future runs (e.g., reword a step, add a validation query, change a default, add a retry)
5. **If no friction points:** Still create the log with "No friction points encountered" and the step timing table.

**Output:** Friction log saved to `logs/`

## Stopping Points

- Step 2: After detecting container runtime — confirm user's choice if both available
- Step 5: After starting container build — monitor for authentication errors
- Step 6: After deployment — verify application created successfully
- Step 8: After presenting demo list — wait for user selection before deploying. When deploying Route Optimization, EXPLICITLY ASK whether to also deploy the AISQL notebook (default: yes for first install). Do not silently skip it.

## Redeploys (`scripts/deploy.sh`)

After the initial install, use the one-command deploy script for any subsequent
SQL, image, or service-spec change. It replaces ~12 manual steps with a single
idempotent run.

```bash
bash .cortex/skills/build-routing-solution/scripts/deploy.sh [connection]
```

Default connection: `fleet_test_evals`. The script:

1. Refuses to run if the working tree is dirty (set `ALLOW_DIRTY=1` to override).
2. Applies every `app/modules/*.sql` file via `snow sql -f` (idempotent
   `CREATE OR REPLACE` and `ADD COLUMN IF NOT EXISTS`).
3. Logs in to the SPCS image registry, derives an image tag from the current
   YAML version + `git rev-parse --short HEAD`, and rebuilds the image with
   `--no-cache` so a stale layer cache can never silently ship the previous
   build. The git SHA is baked into the image as a `git.sha` label.
4. Pushes the image, templates the new tag into `ors_control_app_service.yaml`
   (without modifying the file in-place), uploads to stage, and runs
   `SUSPEND -> ALTER FROM SPECIFICATION -> RESUME` per the AGENTS.md cycle.
5. Resolves the public endpoint URL via `SHOW ENDPOINTS` and prints it.
6. If the current branch is not `main` or `dev`, prints the
   `pull/new/<branch>` URL — `gh pr create` does not work for Snowflake-Labs
   Enterprise Managed Users, so PRs must be opened in the GitHub UI.

Optional env overrides: `SKIP_SQL=1`, `SKIP_IMAGE=1`, `SKIP_SERVICE=1`,
`IMAGE_TAG=<tag>`.

After deploy completes, the UI exposes a healthcheck banner: if any of the
new SQL artifacts (resolver, retry-strategy, build-history, etc.) are
missing, the Region Builder displays a yellow "Partial deploy detected"
banner instead of silently degrading to hardcoded fallbacks.

For the SQL constraints the script's writers handle — particularly
`SYSTEM$GET_SERVICE_STATUS` requiring a constant argument, `UUID_STRING()`
not allowed in `INSERT ... VALUES`, and `SHOW ... + RESULT_SCAN` columns
being quoted-lowercase — see `references/snowflake-sql-gotchas.md`.

## Troubleshooting

See `references/troubleshooting.md` for detailed solutions to common issues:
- Container runtime not running
- Authentication / registry push failures
- ARM Mac esbuild crash (ors_control_app)
- Control app showing ERROR / Unhealthy / 0 Services
- Podman registry auth for wrong host
- Basemap tiles not loading (ENOTFOUND / 502)

## Output

Fully deployed OpenRouteService route optimizer App with:
- Database: `OPENROUTESERVICE_APP`
- 5 SPCS services running (openrouteservice, downloader, gateway, vroom, ors_control_app)
- React-based ORS Control App accessible via SPCS endpoint
- Pre-loaded seed data: 500 Intro page routes, synthetic SF ebike fleet (472K telemetry points, 6K trips, 50 vehicles, 5K POIs), pre-computed SanFrancisco cycling-electric RES8 travel time matrix (29K pairs)
- Optional: User-selected demo skills deployed on top of the base installation
- Friction log saved to `logs/`

### Final Step: Open the Routing Control Center

Retrieve the ORS Control App endpoint URL:

```sql
SHOW ENDPOINTS IN SERVICE OPENROUTESERVICE_APP.CORE.ORS_CONTROL_APP;
SELECT 'https://' || ingress_url AS control_app_url
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
WHERE name = 'ors-control-app';
```

Print this exact message to the user (substituting the actual URL):

> **Open this URL and log in with your Snowflake credentials to see the Routing Control Center:**
>
> `<url>`

Then open it automatically:
```bash
open "<url>"
```

See `references/available-functions.md` for the full list of SQL functions, routing profiles, service limits, and matrix builder details.

See `references/snowflake-scripting-guidelines.md` for SQL Scripting coding rules (variable binding, EXECUTE IMMEDIATE patterns, sandbox testing, deployment paths).

## AUTO_SUSPEND_SECS Invariant

ORS services in `OPENROUTESERVICE_APP.CORE` MUST never auto-suspend while a region graph is being built or an H3 travel-time matrix is being calculated. The invariant is:

- While any provisioning job is active (`REGION_PROVISION_JOBS.STAGE IN ('DOWNLOADING','CONFIGURING','STARTING_SERVICE','WAITING_FOR_SERVICE','BUILDING_GRAPH')`): the target `ORS_SERVICE_<REGION>` and `downloader` have `AUTO_SUSPEND_SECS=0`.
- While any matrix job is active (`MATRIX_BUILD_JOBS.STATUS IN ('PENDING','RUNNING')` with `STAGE NOT IN ('COMPLETE','ERROR')`): `routing_gateway_service` and the target `ORS_SERVICE_<REGION>` have `AUTO_SUSPEND_SECS=0`.
- All other times: services have `AUTO_SUSPEND_SECS=14400` (4 hours).

Every procedure that flips these values to 0 must restore 14400 on ALL exit paths (success, timeout, early return, exception). A safety-net procedure `OPENROUTESERVICE_APP.CORE.RECONCILE_AUTO_SUSPEND()` is idempotent and self-heals drift (e.g. from a killed session); it is auto-called by `SUSPEND_ALL_SERVICES` and `SUSPEND_SERVICE`.

## Cleanup

To remove all objects created by this skill:

```sql
-- Suspend the rescue task before dropping the database so it does not fire
-- against a half-deleted environment.
ALTER TASK IF EXISTS OPENROUTESERVICE_APP.CORE.RESCUE_PENDING_PROVISIONS_TASK SUSPEND;

DROP DATABASE IF EXISTS OPENROUTESERVICE_APP;
DROP DATABASE IF EXISTS SYNTHETIC_DATASETS;
DROP DATABASE IF EXISTS FLEET_INTELLIGENCE;
DROP WAREHOUSE IF EXISTS ROUTING_ANALYTICS;
```

> **Tip:** Use the `cleanup` skill to auto-discover all tagged objects via COMMENT tracking.
