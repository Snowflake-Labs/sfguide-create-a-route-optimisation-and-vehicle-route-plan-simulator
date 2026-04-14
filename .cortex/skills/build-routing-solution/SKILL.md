---
name: build-routing-solution
description: "Build routing solution Snowflake Native App with SPCS. Use when: build routing solution, set up OpenRouteService native app, building and pushing SPCS images, deploy ORS native app to Snowflake, redeploy native app, rebuild container images. Do NOT use for: changing maps or routing profiles (use routing-customization), deploying demo apps (use route-optimization or fleet-intelligence-taxis). Triggers: build routing solution, install openrouteservice app, set up OpenRouteService, build and push SPCS images, deploy ORS native app, redeploy app, rebuild images, SPCS image build, OpenRouteService deployment."
metadata:
  author: Snowflake SIT-IS
  version: 1.0.0
  category: infrastructure
---

# Deploy Route Optimizer

Deploys the OpenRouteService route optimization application as a Snowflake Native App using Snowpark Container Services.

## Execution Rules

1. All relative paths (e.g., `native_app/`, `scripts/`) are relative to this skill's directory (`.cortex/skills/build-routing-solution/`).
2. Replace `<connection>` with the user's active Snowflake CLI connection name. To find it, run `snow connection list` and match by account URL (the `account` field should match the account shown in the Snowflake IDE). The `snowflake_sql_execute` tool and `snow` CLI may use DIFFERENT connections — always verify. If no matching connection exists, run `snow connection add` to create one.
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
| CREATE DATABASE | Account | Creates OPENROUTESERVICE_SETUP, SYNTHETIC_DATASETS, and FLEET_INTELLIGENCE databases |
| CREATE WAREHOUSE | Account | Creates ROUTING_ANALYTICS warehouse |
| CREATE APPLICATION | Account | Deploys OPENROUTESERVICE_NATIVE_APP |
| CREATE APPLICATION PACKAGE | Account | Creates OPENROUTESERVICE_NATIVE_APP_PKG |
| CREATE COMPUTE POOL | Account | Required for SPCS container services |
| USAGE ON WAREHOUSE ROUTING_ANALYTICS | Warehouse | Runs deployment queries |
| CREATE STAGE | Schema (OPENROUTESERVICE_SETUP.PUBLIC) | Creates ORS_SPCS_STAGE, ORS_GRAPHS_SPCS_STAGE, ORS_ELEVATION_CACHE_SPCS_STAGE |
| CREATE IMAGE REPOSITORY | Schema (OPENROUTESERVICE_SETUP.PUBLIC) | Creates IMAGE_REPOSITORY for container images |
| IMPORT SHARE | Account | Installs Overture Maps datasets from Marketplace (Step 8b) |

> **Note:** ACCOUNTADMIN is NOT required. Create a custom role with the above privileges, or use any role that has them.

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| DATABASE | `OPENROUTESERVICE_SETUP` | Database for ORS infrastructure objects |
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
   - For Podman: `podman info` (if fails: `podman machine start`)
   - For Docker: `docker info` (if fails: `open -a Docker` on macOS)

4. **Remember** which container runtime to use (`podman` or `docker`).
   Each bash tool call starts a fresh shell, so shell variables do not persist.
   In every subsequent command, **prefix inline**: `CONTAINER_CMD=podman` (or `docker`) before `$CONTAINER_CMD`, or chain all build commands in a single bash call with `&&`.

**Output:** Container runtime selected and verified running, Node.js available

**Next:** Proceed to Step 3

### Step 3: Setup Database and Stages

**Goal:** Create required Snowflake infrastructure

**Actions:**

1. **Execute** environment setup SQL (all objects include the tracking COMMENT tag):
   ```sql
   -- Tracking tag applied to all objects:
   -- COMMENT = '{"origin":"sf_sit-is-fleet", "name":"oss-build-routing-solution-in-snowflake", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}'

   CREATE DATABASE IF NOT EXISTS OPENROUTESERVICE_SETUP COMMENT = '<tag>';
   CREATE STAGE IF NOT EXISTS OPENROUTESERVICE_SETUP.PUBLIC.ORS_SPCS_STAGE
       ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE') DIRECTORY=(ENABLE=TRUE) COMMENT = '<tag>';
   CREATE STAGE IF NOT EXISTS OPENROUTESERVICE_SETUP.PUBLIC.ORS_GRAPHS_SPCS_STAGE
       ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE') DIRECTORY=(ENABLE=TRUE) COMMENT = '<tag>';
   CREATE STAGE IF NOT EXISTS OPENROUTESERVICE_SETUP.PUBLIC.ORS_ELEVATION_CACHE_SPCS_STAGE
       ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE') DIRECTORY=(ENABLE=TRUE) COMMENT = '<tag>';
   CREATE IMAGE REPOSITORY IF NOT EXISTS OPENROUTESERVICE_SETUP.PUBLIC.IMAGE_REPOSITORY COMMENT = '<tag>';
   CREATE WAREHOUSE IF NOT EXISTS ROUTING_ANALYTICS WAREHOUSE_SIZE = MEDIUM AUTO_SUSPEND = 60 COMMENT = '<tag>';
   ```
   Replace `<tag>` with the full COMMENT JSON shown above.

2. **Verify** infrastructure was created:
   ```sql
   SHOW STAGES IN SCHEMA OPENROUTESERVICE_SETUP.PUBLIC;
   SHOW IMAGE REPOSITORIES IN SCHEMA OPENROUTESERVICE_SETUP.PUBLIC;
   SHOW WAREHOUSES LIKE 'ROUTING_ANALYTICS';
   ```
   Expected: 3 stages (ORS_SPCS_STAGE, ORS_GRAPHS_SPCS_STAGE, ORS_ELEVATION_CACHE_SPCS_STAGE), 1 image repository (IMAGE_REPOSITORY), 1 warehouse (ROUTING_ANALYTICS).

   **If any object is missing:** Check that the role has the required privileges from the Required Privileges section above.

**Output:** Database `OPENROUTESERVICE_SETUP` with stages, warehouse and image repository created and verified

**Next:** Proceed to Step 4

### Step 4: Upload Configuration Files

**Goal:** Stage required configuration and map files

**Actions:**

1. **Upload** files to stage (paths are relative to the **repo root**). Run as a single chained command:
   ```bash
   snow stage copy ".cortex/skills/build-routing-solution/native_app/provider_setup/staged_files/SanFrancisco.osm.pbf" \
     @OPENROUTESERVICE_SETUP.PUBLIC.ORS_SPCS_STAGE/SanFrancisco/ --connection <connection> --overwrite && \
   snow stage copy ".cortex/skills/build-routing-solution/native_app/provider_setup/staged_files/ors-config.yml" \
     @OPENROUTESERVICE_SETUP.PUBLIC.ORS_SPCS_STAGE/SanFrancisco/ --connection <connection> --overwrite && \
   snow stage copy ".cortex/skills/build-routing-solution/scripts/download_map.py" \
     @OPENROUTESERVICE_SETUP.PUBLIC.ORS_SPCS_STAGE/scripts/ --connection <connection> --overwrite
   ```

**Output:** Configuration files uploaded to Snowflake stage

**Next:** Proceed to Step 5

### Step 5: Build and Push Container Images

**Goal:** Build 5 container images and push to Snowflake image repository

**Before building:** Read `native_app/image-versions.env` (the single source of truth for all image tags). Use these values for all `-t` flags. The `build-images.md` code blocks show the commands but always cross-check tags against `image-versions.env`.

Follow the full build instructions in `references/build-images.md`. Summary:

1. Read image tags: `source native_app/image-versions.env`
2. Authenticate with SPCS image registry (Docker or Podman)
3. Get repository URL: `snow spcs image-repository url openrouteservice_setup.public.image_repository -c <connection>`
4. Build and push all 5 images using tags from `image-versions.env`: openrouteservice, downloader, routing_reverse_proxy, vroom-docker, ors_control_app

**Expected Duration:** 10-20 minutes (first push; ~5 minutes with cached layers)

**If authentication fails:** Run `snow spcs image-registry login -c <connection>`. For Podman, see `references/troubleshooting.md` > "Podman Registry Auth".

**If ARM Mac esbuild crash:** Build React app locally first, use `Dockerfile.runtime`. See `references/build-images.md` > ors_control_app section.

**IMPORTANT — Verify all images after push:** Docker push output uses carriage returns that may be invisible when pushing in parallel. Always confirm all 5 images are present:
```bash
snow spcs image-repository list-images openrouteservice_setup.public.image_repository -c <connection>
```
All 5 images must appear with correct tags. If any are missing, re-run `docker push` for that image.

**Next:** Proceed to Step 5b

### Step 5b: Validate Image Version Consistency (MANDATORY)

**Goal:** Ensure all image version tags, repository paths, and volume source schemas match across manifest.yml, service YAMLs, and build instructions

**CRITICAL:** This step MUST be run before `snow app run`. Skipping it risks deployment failure with `Image ... not found`.

**Actions:**

1. Run the validation script:
   ```bash
   bash .cortex/skills/build-routing-solution/scripts/check_image_versions.sh
   ```

2. If the script reports MISMATCH:
   - Update the stale file(s) to match the tags in `native_app/image-versions.env` (the source of truth)
   - Re-run the script to confirm all versions are consistent

3. If no script available, manually verify with grep:
   ```bash
   grep -ohE '[a-z_-]+:v[0-9.]+' native_app/app/manifest.yml | sort
   grep -rohE '[a-z_-]+:v[0-9.]+' native_app/services/*/*.yaml | sort -u
   ```
   All 5 image:tag pairs must match exactly.

**Next:** Proceed to Step 6

### Step 6: Deploy Native App

**Goal:** Create and deploy the native application

**Actions:**

1. **Deploy the application:**
   ```bash
   cd native_app && snow app run -c <connection> --warehouse ROUTING_ANALYTICS
   ```

   > **Expected behavior:** After "Creating new application object", the CLI may appear stuck with no output for 2-3 minutes while the CREATE APPLICATION query executes. This is normal — the query is running but output is not flushed. If concerned, verify progress in a separate session: `SELECT QUERY_TEXT, EXECUTION_STATUS FROM TABLE(INFORMATION_SCHEMA.QUERY_HISTORY()) WHERE QUERY_TEXT ILIKE '%APPLICATION%' ORDER BY START_TIME DESC LIMIT 1;`

   > **Expected warnings:** The CLI may emit warnings about `REGISTER_SINGLE_CALLBACK`, `GET_CONFIG_FOR_REF`, or `GRANT_CALLBACK` procedures not existing. These are expected — the callbacks are registered during Step 7 (Activate App). Ignore these warnings.

2. **Grant warehouse access to the app** (required for the React control app SQL API):
   ```sql
   GRANT USAGE ON WAREHOUSE ROUTING_ANALYTICS TO APPLICATION OPENROUTESERVICE_NATIVE_APP;
   ```

3. **Set up Data Studio databases** (required for synthetic data generation):
   ```sql
   CREATE DATABASE IF NOT EXISTS SYNTHETIC_DATASETS
     COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
   CREATE SCHEMA IF NOT EXISTS SYNTHETIC_DATASETS.UNIFIED
     COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
   CREATE DATABASE IF NOT EXISTS FLEET_INTELLIGENCE
     COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
   CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.CORE
     COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

   GRANT USAGE ON DATABASE SYNTHETIC_DATASETS TO APPLICATION OPENROUTESERVICE_NATIVE_APP;
   GRANT USAGE ON SCHEMA SYNTHETIC_DATASETS.UNIFIED TO APPLICATION OPENROUTESERVICE_NATIVE_APP;
   GRANT CREATE TABLE ON SCHEMA SYNTHETIC_DATASETS.UNIFIED TO APPLICATION OPENROUTESERVICE_NATIVE_APP;
   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA SYNTHETIC_DATASETS.UNIFIED TO APPLICATION OPENROUTESERVICE_NATIVE_APP;

   GRANT USAGE ON DATABASE FLEET_INTELLIGENCE TO APPLICATION OPENROUTESERVICE_NATIVE_APP;
   GRANT USAGE ON ALL SCHEMAS IN DATABASE FLEET_INTELLIGENCE TO APPLICATION OPENROUTESERVICE_NATIVE_APP;
   GRANT CREATE TABLE ON SCHEMA FLEET_INTELLIGENCE.CORE TO APPLICATION OPENROUTESERVICE_NATIVE_APP;
   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN DATABASE FLEET_INTELLIGENCE TO APPLICATION OPENROUTESERVICE_NATIVE_APP;
   GRANT SELECT ON ALL VIEWS IN DATABASE FLEET_INTELLIGENCE TO APPLICATION OPENROUTESERVICE_NATIVE_APP;
   ```
   This creates the databases/schemas and grants the app full access to write generated fleet telemetry data.
   The `deploy.sh` scripts also run these grants automatically on each deploy.

   > **Note:** Future grants to APPLICATION objects are not supported in Snowflake. After loading new data or creating new tables/views, re-run `GRANT SELECT ON ALL TABLES IN SCHEMA ... TO APPLICATION OPENROUTESERVICE_NATIVE_APP` to pick up new objects.

4. **Open the application in browser:**
   ```bash
   cd native_app && snow app open -c <connection> --warehouse ROUTING_ANALYTICS
   ```

5. **Verify** deployment:
   ```sql
   SHOW SERVICES IN APPLICATION OPENROUTESERVICE_NATIVE_APP;
   ```
   Expected: 5 services listed. They may take 1-3 minutes to reach RUNNING status. Check again if status shows PENDING.

   **If 0 services appear:** The grant_callback has not fired yet — this is expected. Step 7 will grant privileges, bind EAI references, and trigger the callback automatically via SQL.

**Output:** Native app deployed and accessible via Snowsight URL

### Step 7: Activate App (Automated via SQL)

**Goal:** Grant account privileges, create External Access Integrations, bind references, and trigger the full deployment — all via SQL, no Snowsight UI required

**Actions:**

1. **Grant account-level privileges** to the app:
   ```sql
   GRANT CREATE COMPUTE POOL ON ACCOUNT TO APPLICATION OPENROUTESERVICE_NATIVE_APP;
   GRANT BIND SERVICE ENDPOINT ON ACCOUNT TO APPLICATION OPENROUTESERVICE_NATIVE_APP;
   ```

2. **Create network rules and External Access Integrations** (replicates the Snowsight "Review > Connect" step):
   ```sql
   CREATE OR REPLACE NETWORK RULE ORS_OSM_NETWORK_RULE
     TYPE = HOST_PORT  MODE = EGRESS
     VALUE_LIST = ('0.0.0.0:443','0.0.0.0:80','snowflakecomputing.com','download.bbbike.org:443','download.geofabrik.de:443')
     COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

   CREATE OR REPLACE NETWORK RULE ORS_CARTO_NETWORK_RULE
     TYPE = HOST_PORT  MODE = EGRESS
     VALUE_LIST = ('a.basemaps.cartocdn.com:443','b.basemaps.cartocdn.com:443','c.basemaps.cartocdn.com:443','d.basemaps.cartocdn.com:443')
     COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

   CREATE OR REPLACE EXTERNAL ACCESS INTEGRATION ORS_OSM_EAI
     ALLOWED_NETWORK_RULES = (ORS_OSM_NETWORK_RULE)
     ENABLED = TRUE
     COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

   CREATE OR REPLACE EXTERNAL ACCESS INTEGRATION ORS_CARTO_EAI
     ALLOWED_NETWORK_RULES = (ORS_CARTO_NETWORK_RULE)
     ENABLED = TRUE
     COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
   ```

3. **Grant USAGE on EAIs to the app and bind references:**
   ```sql
   GRANT USAGE ON INTEGRATION ORS_OSM_EAI TO APPLICATION OPENROUTESERVICE_NATIVE_APP;
   GRANT USAGE ON INTEGRATION ORS_CARTO_EAI TO APPLICATION OPENROUTESERVICE_NATIVE_APP;

   CALL OPENROUTESERVICE_NATIVE_APP.CORE.REGISTER_SINGLE_CALLBACK(
     'external_access_integration_ref', 'ADD',
     SYSTEM$REFERENCE('EXTERNAL ACCESS INTEGRATION', 'ORS_OSM_EAI', 'PERSISTENT', 'USAGE'));

   CALL OPENROUTESERVICE_NATIVE_APP.CORE.REGISTER_SINGLE_CALLBACK(
     'external_access_carto_ref', 'ADD',
     SYSTEM$REFERENCE('EXTERNAL ACCESS INTEGRATION', 'ORS_CARTO_EAI', 'PERSISTENT', 'USAGE'));
   ```

4. **Trigger the grant callback** to deploy compute pool, stages, downloader, services, functions, and control app:
   ```sql
   CALL OPENROUTESERVICE_NATIVE_APP.CORE.GRANT_CALLBACK(ARRAY_CONSTRUCT('CREATE COMPUTE POOL', 'BIND SERVICE ENDPOINT'));
   ```
   This takes 2-3 minutes. It creates the compute pool (5 nodes), downloads OSM data, starts all SPCS services, creates routing functions, and launches the ORS Control App.

5. **Grant Overture Maps access** (for Data Studio POI data):
   ```sql
   GRANT IMPORTED PRIVILEGES ON DATABASE OVERTURE_MAPS__PLACES TO APPLICATION OPENROUTESERVICE_NATIVE_APP;
   ```
   If OVERTURE_MAPS__PLACES is not available, skip — Data Studio POI features will be unavailable.

6. **Verify** all services are running:
   ```sql
   SHOW SERVICES IN APPLICATION OPENROUTESERVICE_NATIVE_APP;
   ```
   Expected: 5 services (downloader, ors_service, vroom_service, routing_gateway_service, ors_control_app). They may take 1-3 minutes to reach RUNNING status.

   If services show SUSPENDED or PENDING after 5 minutes:
   ```sql
   SELECT SYSTEM$GET_SERVICE_STATUS('OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SERVICE');
   SELECT SYSTEM$GET_SERVICE_STATUS('OPENROUTESERVICE_NATIVE_APP.CORE.ORS_CONTROL_APP');
   ```

**Output:** App fully activated with all services running — no manual Snowsight UI steps required

### Step 8: Load Seed Datasets

**Goal:** Pre-load Intro page routes, synthetic SF ebike data, and a pre-computed travel time matrix so the app is fully populated on first launch

**Actions:**

1. **Create the seed data stage** (not created in Step 3):
   ```sql
   CREATE STAGE IF NOT EXISTS OPENROUTESERVICE_SETUP.PUBLIC.SEED_DATA_STAGE
     COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
   ```

2. **Upload Parquet files to stage:**

   > **Note:** The `datasets/` directory is at the **repository root**, not in this skill's directory. Run these commands from the repo root.

   ```bash
   snow stage copy datasets/intro/ @OPENROUTESERVICE_SETUP.PUBLIC.SEED_DATA_STAGE/intro/ -c <connection> --overwrite && \
   snow stage copy datasets/synthetic_ebikes/ @OPENROUTESERVICE_SETUP.PUBLIC.SEED_DATA_STAGE/synthetic_ebikes/ -c <connection> --overwrite --recursive && \
   snow stage copy datasets/metadata/ @OPENROUTESERVICE_SETUP.PUBLIC.SEED_DATA_STAGE/metadata/ -c <connection> --overwrite && \
   snow stage copy datasets/matrix/ @OPENROUTESERVICE_SETUP.PUBLIC.SEED_DATA_STAGE/matrix/ -c <connection> --overwrite && \
   snow stage copy datasets/matrix_jobs/ @OPENROUTESERVICE_SETUP.PUBLIC.SEED_DATA_STAGE/matrix_jobs/ -c <connection> --overwrite && \
   snow stage copy datasets/region_catalog/ @OPENROUTESERVICE_SETUP.PUBLIC.SEED_DATA_STAGE/region_catalog/ -c <connection> --overwrite
   ```

3. **Run the loader script:**
   ```bash
   snow sql -f datasets/load-seed-data.sql -c <connection>
   ```

4. **Verify** the data loaded:
   ```sql
   SELECT 'INTRO_TRIPS' AS TBL, COUNT(*) AS CNT FROM OPENROUTESERVICE_SETUP.PUBLIC.INTRO_TRIPS
   UNION ALL SELECT 'TELEMETRY', COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY
   UNION ALL SELECT 'TRIPS', COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS
   UNION ALL SELECT 'FLEET', COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET
   UNION ALL SELECT 'POIS', COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.DIM_POIS
   UNION ALL SELECT 'JOBS', COUNT(*) FROM FLEET_INTELLIGENCE.CORE.GENERATION_JOBS
   UNION ALL SELECT 'REGIONS', COUNT(*) FROM FLEET_INTELLIGENCE.CORE.REGION_REGISTRY
   UNION ALL SELECT 'MATRIX', COUNT(*) FROM OPENROUTESERVICE_NATIVE_APP.TRAVEL_MATRIX.SANFRANCISCO_CYCLING_ELECTRIC_MATRIX_RES8
   UNION ALL SELECT 'REGION_CATALOG', COUNT(*) FROM OPENROUTESERVICE_NATIVE_APP.CORE.REGION_CATALOG;
   ```

   Expected: INTRO_TRIPS=500, TELEMETRY=472869, TRIPS=6008, FLEET=50, POIS=5000, JOBS=1, REGIONS=1, MATRIX=29402, REGION_CATALOG=460

   **If any count is 0 or lower than expected:** The COPY INTO may have skipped files due to metadata caching when run via `snow sql -f`. Re-run the full loader: `snow sql -f datasets/load-seed-data.sql -c <connection>`. The script uses `TRUNCATE` + `COPY INTO ... FORCE = TRUE`, so re-runs are safe and idempotent. If a single table still shows a low count after re-run, execute its TRUNCATE + COPY INTO as a standalone `snow sql -q` command (not inside the multi-statement file) to bypass metadata caching.

   **If MATRIX = 0 or table not found:** The matrix is loaded via the native app's `LOAD_SEED_MATRIX` procedure (which runs `EXECUTE AS OWNER` so the table is app-owned and visible to `GET_MATRIX_INVENTORY()`). Ensure the app upgrade (Step 6) completed successfully before running the seed loader. You can also call the procedure manually:
   ```sql
   GRANT READ ON STAGE OPENROUTESERVICE_SETUP.PUBLIC.SEED_DATA_STAGE TO APPLICATION OPENROUTESERVICE_NATIVE_APP;
   GRANT USAGE ON FILE FORMAT OPENROUTESERVICE_SETUP.PUBLIC.PARQUET_FF TO APPLICATION OPENROUTESERVICE_NATIVE_APP;
   CALL OPENROUTESERVICE_NATIVE_APP.CORE.LOAD_SEED_MATRIX('@OPENROUTESERVICE_SETUP.PUBLIC.SEED_DATA_STAGE', 'SanFrancisco', 'cycling-electric', 'RES8');
   ```

   **If REGION_CATALOG = 0:** The catalog is loaded via the native app's `LOAD_SEED_CATALOG` procedure (which runs `EXECUTE AS OWNER`). Ensure the app upgrade (Step 6) completed successfully before running the seed loader. You can also call the procedure manually:
   ```sql
   GRANT READ ON STAGE OPENROUTESERVICE_SETUP.PUBLIC.SEED_DATA_STAGE TO APPLICATION OPENROUTESERVICE_NATIVE_APP;
   CALL OPENROUTESERVICE_NATIVE_APP.CORE.LOAD_SEED_CATALOG('@OPENROUTESERVICE_SETUP.PUBLIC.SEED_DATA_STAGE');
   ```

**Output:** Intro page shows 500 animated SF routes, Data Studio shows 1 completed E-Bike Couriers job, Matrix Viewer has a pre-computed SanFrancisco cycling-electric RES8 matrix (178 hexagons, 29K travel-time pairs), Region Builder shows 460 pre-populated catalog entries (no remote API scrape needed)

### Step 8b: Install Overture Maps Marketplace Datasets

**Goal:** Pre-install Overture Maps datasets from Snowflake Marketplace so downstream demos that need POI/address data (Taxis, Retail Catchment, Route Optimization) are not blocked.

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

4. **Verify** both datasets are accessible:
   ```sql
   SELECT COUNT(*) FROM OVERTURE_MAPS__PLACES.CARTO.PLACE LIMIT 1;
   SELECT COUNT(*) FROM OVERTURE_MAPS__ADDRESSES.CARTO.ADDRESS WHERE COUNTRY = 'US' LIMIT 1;
   ```

5. **Grant** access to the native app (required for Data Studio POI queries):
   ```sql
   GRANT IMPORTED PRIVILEGES ON DATABASE OVERTURE_MAPS__PLACES TO APPLICATION OPENROUTESERVICE_NATIVE_APP;
   GRANT IMPORTED PRIVILEGES ON DATABASE OVERTURE_MAPS__ADDRESSES TO APPLICATION OPENROUTESERVICE_NATIVE_APP;
   ```

**Requires:** IMPORT SHARE privilege (ACCOUNTADMIN has it by default).

**If SYSTEM$ACCEPT_LEGAL_TERMS fails:** The user may need to accept terms manually via Snowsight Marketplace using the links above.

**Output:** Overture Maps databases available. Demos requiring POI data (Taxis, Retail Catchment, Route Optimization) can now be deployed.

### Step 9: Select and Deploy Demos (Optional)

**Goal:** Ask the user which demo skills to deploy on top of the base ORS installation

**Actions:**

1. **Present the available demos** and ask the user to select which ones to deploy:

   | Demo | Description | Time | Prerequisites |
   |------|-------------|------|---------------|
   | **Fleet Intelligence: Food Delivery** | E-bike courier fleet with projection views from seed data | ~2 min | Seed data (Step 8) |
   | **Route Deviation** | Detour detection ETL comparing actual vs planned routes | ~5 min | Seed data (Step 8) |
   | **Dwell Analysis** | 12-step Dynamic Table pipeline for dwell/congestion/SLA alerts | ~10 min | Seed data (Step 8) |
   | **Fleet Intelligence: Taxis** | Taxi GPS telemetry with Overture Maps POIs + driver routes | ~5 min | Overture Maps (auto-installed in Step 8b) |
   | **Retail Catchment** | Isochrone retail location analysis + competitor mapping | ~5 min | Overture Maps (auto-installed in Step 8b) |
   | **Route Optimization** | VRP simulator with notebook + AISQL + Cortex AI | ~15 min | Overture Maps (Step 8b) + Cortex AI access |
   | **Routing Agent** | Snowflake Intelligence agent wrapping ORS routing functions | ~5 min | Cortex AI access (claude-sonnet-4-5) |

   **Recommended for first-time users:** Fleet Intelligence: Food Delivery, Route Deviation, Dwell Analysis.
   These three use the seed data already loaded in Step 8 and require no additional Marketplace data or services.

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

## Stopping Points

- Step 2: After detecting container runtime — confirm user's choice if both available
- Step 5: After starting container build — monitor for authentication errors
- Step 6: After deployment — verify application created successfully
- Step 9: After presenting demo list — wait for user selection before deploying

## Troubleshooting

See `references/troubleshooting.md` for detailed solutions to common issues:
- Container runtime not running
- Authentication / registry push failures
- ARM Mac esbuild crash (ors_control_app)
- Control app showing ERROR / Unhealthy / 0 Services
- Podman registry auth for wrong host
- Basemap tiles not loading (ENOTFOUND / 502)

## Output

Fully deployed OpenRouteService route optimizer as Snowflake Native App with:
- Database: `OPENROUTESERVICE_SETUP`
- Application: `OPENROUTESERVICE_NATIVE_APP`
- 5 SPCS services running (downloader, openrouteservice, gateway, vroom, ors_control_app)
- React-based ORS Control App accessible via SPCS endpoint (city provisioning, service management, matrix builder, function tester)
- Pre-loaded seed data: 500 Intro page routes, synthetic SF ebike fleet (472K telemetry points, 6K trips, 50 vehicles, 5K POIs), pre-computed SanFrancisco cycling-electric RES8 travel time matrix (29K pairs)
- Optional: User-selected demo skills deployed on top of the base installation

See `references/available-functions.md` for the full list of SQL functions, routing profiles, service limits, and matrix builder details.

See `references/snowflake-scripting-guidelines.md` for SQL Scripting coding rules (variable binding, EXECUTE IMMEDIATE patterns, sandbox testing, deployment paths).

Access via: Snowsight -> Data Products >> Apps >> OPENROUTESERVICE_NATIVE_APP >> Launch App. All privileges and external access integrations are granted automatically during Step 7 — no manual UI approval is needed.

## Examples

### Example 1: Fresh deployment with demos
User says: "Set up the OpenRouteService native app from scratch"
Actions:
1. Detect container runtime and Node.js (Step 2)
2. Create database and stages (Step 3)
3. Upload config files (Step 4)
4. Build and push all 5 images (Step 5)
5. Deploy native app (Step 6)
6. Guide user through Snowsight activation (Step 7)
7. Load seed datasets (Step 8)
8. Ask user which demos to deploy, deploy selected (Step 9)
Result: Fully operational ORS app with San Francisco routing and user-selected demos

### Example 2: Rebuild control app only
User says: "Update the control app to latest version"
Actions: Run `cd native_app/services/ors_control_app && ./deploy.sh -c <connection>`
Result: Control app image rebuilt and deployed, app upgraded

### Example 3: Update stored procedures only
User says: "I changed setup_script.sql, deploy it"
Actions: PUT to stage ROOT and upgrade (see Partial Deploys below)
Result: Stored procedures updated without container rebuild

## Partial Deploys

### Control App Only (Fast Deploy)

```bash
cd native_app/services/ors_control_app
./deploy.sh -c <connection>
```

This script: builds React + server locally, creates a runtime Docker image, pushes image to the SPCS registry, auto-bumps the version tag in the service YAML, uploads the YAML to the app package stage, and runs `ALTER APPLICATION ... UPGRADE` to apply the new image.

**WARNING:** `deploy.sh` auto-bumps the version in the service YAML only. After running it, you MUST also update the matching version in `manifest.yml` and `references/build-images.md`. Run `check_image_versions.sh` to verify all files are in sync.

**Why UPGRADE instead of ALTER SERVICE:** The ORS control app service uses `reference('external_access_carto_ref')` for its external access integration. This native app reference can only be resolved inside the app's own stored procedures (via `version_init` -> `create_control_app`). Running `ALTER SERVICE FROM SPECIFICATION` or `SUSPEND/RESUME` from outside the app context fails because the reference cannot be resolved. `ALTER APPLICATION UPGRADE` triggers the app lifecycle callback which recreates the service with proper reference bindings.

### Stored Procedures Only

```sql
PUT file:///path/to/setup_script.sql @OPENROUTESERVICE_NATIVE_APP_PKG.APP_SRC.STAGE/ OVERWRITE=TRUE AUTO_COMPRESS=FALSE;
ALTER APPLICATION OPENROUTESERVICE_NATIVE_APP UPGRADE USING @OPENROUTESERVICE_NATIVE_APP_PKG.APP_SRC.STAGE;
```

PUT to stage ROOT, NOT `app/` -- manifest reads from root. See `references/snowflake-scripting-guidelines.md` Section 2.

## Cleanup

To remove all objects created by this skill:

```sql
-- Reverse dependency order: application first, then images, stages, warehouse, database
DROP APPLICATION IF EXISTS OPENROUTESERVICE_NATIVE_APP CASCADE;
DROP APPLICATION PACKAGE IF EXISTS OPENROUTESERVICE_NATIVE_APP_PKG;
DROP WAREHOUSE IF EXISTS ROUTING_ANALYTICS;
DROP IMAGE REPOSITORY IF EXISTS OPENROUTESERVICE_SETUP.PUBLIC.IMAGE_REPOSITORY;
DROP STAGE IF EXISTS OPENROUTESERVICE_SETUP.PUBLIC.SEED_DATA_STAGE;
DROP STAGE IF EXISTS OPENROUTESERVICE_SETUP.PUBLIC.ORS_ELEVATION_CACHE_SPCS_STAGE;
DROP STAGE IF EXISTS OPENROUTESERVICE_SETUP.PUBLIC.ORS_GRAPHS_SPCS_STAGE;
DROP STAGE IF EXISTS OPENROUTESERVICE_SETUP.PUBLIC.ORS_SPCS_STAGE;
DROP DATABASE IF EXISTS OPENROUTESERVICE_SETUP;
DROP DATABASE IF EXISTS SYNTHETIC_DATASETS;
DROP DATABASE IF EXISTS FLEET_INTELLIGENCE;
```

> **Tip:** Use the `cleanup` skill to auto-discover all tagged objects via COMMENT tracking.
