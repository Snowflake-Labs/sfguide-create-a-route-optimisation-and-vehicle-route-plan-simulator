---
name: build-routing-solution
description: "Build routing solution Snowflake Native App with SPCS. Use when: build routing solution, set up OpenRouteService native app, building and pushing SPCS images, deploy ORS native app to Snowflake. Do NOT use for: changing maps or routing profiles (use customize-main), deploying demo apps (use deploy-route-optimization-demo or deploy-fleet-intelligence-taxis). Triggers: build routing solution, install openrouteservice app, set up OpenRouteService, build and push SPCS images, deploy ORS native app, SPCS image build, OpenRouteService deployment."
metadata:
  author: Snowflake SIT-IS
  version: 1.0.0
  category: infrastructure
---

# Deploy Route Optimizer

Deploys the OpenRouteService route optimization application as a Snowflake Native App using Snowpark Container Services.

## Prerequisites

- Container runtime (Podman or Docker) installed and running
- Snowflake CLI (`snow`) installed
- Active Snowflake connection with a role that has privileges listed in the Required Privileges section below
- Repository cloned; working directory set to repo root

## Required Privileges

| Privilege | Scope | Reason |
|-----------|-------|--------|
| CREATE DATABASE | Account | Creates OPENROUTESERVICE_SETUP database |
| CREATE WAREHOUSE | Account | Creates ROUTING_ANALYTICS warehouse |
| CREATE APPLICATION | Account | Deploys OPENROUTESERVICE_NATIVE_APP |
| CREATE APPLICATION PACKAGE | Account | Creates OPENROUTESERVICE_NATIVE_APP_PKG |
| CREATE COMPUTE POOL | Account | Required for SPCS container services |
| USAGE ON WAREHOUSE ROUTING_ANALYTICS | Warehouse | Runs deployment queries |
| CREATE STAGE | Schema (OPENROUTESERVICE_SETUP.PUBLIC) | Creates ORS_SPCS_STAGE, ORS_GRAPHS_SPCS_STAGE, ORS_ELEVATION_CACHE_SPCS_STAGE |
| CREATE IMAGE REPOSITORY | Schema (OPENROUTESERVICE_SETUP.PUBLIC) | Creates IMAGE_REPOSITORY for container images |

> **Note:** ACCOUNTADMIN is NOT required. Create a custom role with the above privileges, or use any role that has them.

> All relative paths (e.g., `Native_app/`, `Notebook/`) are relative to the repository root directory.

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| DATABASE | `OPENROUTESERVICE_SETUP` | Database for ORS infrastructure objects |
| WAREHOUSE | `ROUTING_ANALYTICS` | Warehouse for ORS operations (MEDIUM) |
| WAREHOUSE_SIZE | `MEDIUM` | Size of the routing warehouse |
| IMAGE_REPO | `ORS_REPOSITORY` | Image repository for SPCS containers |
| COMPUTE_POOL | `ORS_COMPUTE_POOL` | Compute pool for ORS services |

## Error Logging

When any step fails or produces unexpected results (SQL errors, missing objects, wrong row counts, service failures, deployment issues), log the issue to `logs/` following the format in `logs/README.md`. Create one log file per execution: `build-routing-solution_{YYYY-MM-DD}_{HH-MM}.md`. Continue execution where possible, logging all issues encountered. If execution completes with no issues, do not create a log file.

## Workflow

### Step 1: Set Query Tag for Tracking

**Goal:** Set session query tag for attribution tracking.

```sql
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution-in-snowflake","version":{"major":1, "minor":0},"attributes":{"is_quickstart":1, "source":"sql"}}';
```

**Output:** Query tag set for session tracking

### Step 2: Detect Container Runtime

**Goal:** Identify available container runtime and let user choose

**Actions:**

1. **Check** which container runtimes are installed:
   ```bash
   podman --version 2>/dev/null && echo "PODMAN_AVAILABLE=true" || echo "PODMAN_AVAILABLE=false"
   docker --version 2>/dev/null && echo "DOCKER_AVAILABLE=true" || echo "DOCKER_AVAILABLE=false"
   ```

2. **Based on results:**
   - If **both** are installed: Ask user which they prefer (Podman or Docker)
   - If **only Podman**: Use Podman
   - If **only Docker**: Use Docker
   - If **neither**: Stop and ask user to install one (see check-prerequisites skill)

3. **Verify** the selected runtime is running:
   - For Podman: `podman info` (if fails: `podman machine start`)
   - For Docker: `docker info` (if fails: `open -a Docker` on macOS)

4. **Set** the container command variable for subsequent steps:
   - `CONTAINER_CMD=podman` or `CONTAINER_CMD=docker`

**Output:** Container runtime selected and verified running

**Next:** Proceed to Step 3

### Step 3: Setup Database and Stages

**Goal:** Create required Snowflake infrastructure

**Actions:**

1. **Execute** environment setup SQL:
   ```sql
   CREATE DATABASE IF NOT EXISTS OPENROUTESERVICE_SETUP
       COMMENT = '{"origin":"sf_sit-is-fleet", "name":"oss-build-routing-solution-in-snowflake", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';
   CREATE STAGE IF NOT EXISTS OPENROUTESERVICE_SETUP.PUBLIC.ORS_SPCS_STAGE ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE') DIRECTORY=(ENABLE=TRUE)
       COMMENT = '{"origin":"sf_sit-is-fleet", "name":"oss-build-routing-solution-in-snowflake", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';
   CREATE STAGE IF NOT EXISTS OPENROUTESERVICE_SETUP.PUBLIC.ORS_GRAPHS_SPCS_STAGE ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE') DIRECTORY=(ENABLE=TRUE)
       COMMENT = '{"origin":"sf_sit-is-fleet", "name":"oss-build-routing-solution-in-snowflake", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';
   CREATE STAGE IF NOT EXISTS OPENROUTESERVICE_SETUP.PUBLIC.ORS_ELEVATION_CACHE_SPCS_STAGE ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE') DIRECTORY=(ENABLE=TRUE)
       COMMENT = '{"origin":"sf_sit-is-fleet", "name":"oss-build-routing-solution-in-snowflake", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';
   CREATE IMAGE REPOSITORY IF NOT EXISTS OPENROUTESERVICE_SETUP.PUBLIC.IMAGE_REPOSITORY
       COMMENT = '{"origin":"sf_sit-is-fleet", "name":"oss-build-routing-solution-in-snowflake", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';
   CREATE WAREHOUSE IF NOT EXISTS ROUTING_ANALYTICS AUTO_SUSPEND = 60
       COMMENT = '{"origin":"sf_sit-is-fleet", "name":"oss-build-routing-solution-in-snowflake", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';
   ```

**Output:** Database `OPENROUTESERVICE_SETUP` with stages, warehouse and image repository created

**Next:** Proceed to Step 4

### Step 4: Upload Configuration Files

**Goal:** Stage required configuration and map files

**Actions:**

1. **Upload** files from `Native_app/provider_setup/staged_files/` to stage:
   ```bash
   snow stage copy "Native_app/provider_setup/staged_files/SanFrancisco.osm.pbf" \
     @OPENROUTESERVICE_SETUP.PUBLIC.ORS_SPCS_STAGE/SanFrancisco/ --connection <connection> --overwrite
   
   snow stage copy "Native_app/provider_setup/staged_files/ors-config.yml" \
     @OPENROUTESERVICE_SETUP.PUBLIC.ORS_SPCS_STAGE/SanFrancisco/ --connection <connection> --overwrite

   snow stage copy "Notebook/download_map.ipynb" \
   @OPENROUTESERVICE_SETUP.PUBLIC.ORS_SPCS_STAGE/Notebook/ --connection <connection> --overwrite
   ```

**Output:** Configuration files uploaded to Snowflake stage

**Next:** Proceed to Step 5

### Step 5: Build and Push Container Images

**Goal:** Build 5 container images and push to Snowflake image repository

**Actions:**

1. **Authenticate** with SPCS image registry:

   **For Docker:**
   ```bash
   snow spcs image-registry login -c <connection>
   ```

   **For Podman:**
   ```bash
   REGISTRY_URL=$(snow spcs image-repository url openrouteservice_setup.public.image_repository -c <connection> | cut -d'/' -f1)
   snow spcs image-registry token --format=JSON -c <connection> | podman login $REGISTRY_URL -u 0sessiontoken --password-stdin
   ```

2. **Get** repository URL:
   ```bash
   REPO_URL=$(snow spcs image-repository url openrouteservice_setup.public.image_repository -c <connection>)
   echo $REPO_URL
   ```

3. **Build and push** images using the selected container runtime (`$CONTAINER_CMD` = podman or docker):

   ```bash
   # openrouteservice image
   cd Native_app/services/openrouteservice
   $CONTAINER_CMD build --rm --platform linux/amd64 -t $REPO_URL/openrouteservice:v9.0.0 .
   $CONTAINER_CMD push $REPO_URL/openrouteservice:v9.0.0
   
   # downloader image
   cd ../downloader
   $CONTAINER_CMD build --rm --platform linux/amd64 -t $REPO_URL/downloader:v0.0.3 .
   $CONTAINER_CMD push $REPO_URL/downloader:v0.0.3
   
   # gateway image
   cd ../gateway
   $CONTAINER_CMD build --rm --platform linux/amd64 -t $REPO_URL/routing_reverse_proxy:v0.7.5 .
   $CONTAINER_CMD push $REPO_URL/routing_reverse_proxy:v0.7.5
   
   # vroom image
   cd ../vroom
   $CONTAINER_CMD build --rm --platform linux/amd64 -t $REPO_URL/vroom-docker:v1.0.1 .
   $CONTAINER_CMD push $REPO_URL/vroom-docker:v1.0.1
   
   # ors control app (React management UI)
   cd ../ors_control_app
   # On ARM Macs (Apple Silicon), esbuild crashes under QEMU amd64 emulation.
   # Build locally first, then use a runtime-only Dockerfile:
   npm ci && npm run build && npm run build:server
   cat > Dockerfile.runtime <<'RTEOF'
   FROM node:20-alpine
   WORKDIR /app
   COPY dist ./dist
   COPY dist-server ./dist-server
   COPY package.json ./
   COPY package-lock.json* ./
   RUN npm ci --omit=dev || npm install --omit=dev
   EXPOSE 3001
   CMD ["node", "dist-server/index.js"]
   RTEOF
   mv .dockerignore .dockerignore.bak 2>/dev/null
   $CONTAINER_CMD build --rm --platform linux/amd64 -f Dockerfile.runtime -t $REPO_URL/ors_control_app:v1.0.5 .
   mv .dockerignore.bak .dockerignore 2>/dev/null; rm -f Dockerfile.runtime
   $CONTAINER_CMD push $REPO_URL/ors_control_app:v1.0.5
   
   # return to working directory
   cd ../../..
   ```

4. **Monitor** progress (builds 5 images):
   - openrouteservice:v9.0.0
   - downloader:v0.0.3
   - routing_reverse_proxy:v0.7.5
   - vroom-docker:v1.0.1
   - ors_control_app:v1.0.5

**Output:** All 5 container images pushed to Snowflake image repository

**Expected Duration:** 5-10 minutes

**If error occurs:**
- Authentication issue: Ensure you ran `snow spcs image-registry login`
- Podman machine not running: `podman machine start`
- Docker daemon not running: Start Docker Desktop
- Build failures: Check container runtime status and retry

**Next:** Proceed to Step 6

### Step 6: Deploy Native App

**Goal:** Create and deploy the native application

**Actions:**

1. **Deploy the application:**
   ```bash
   cd Native_app && snow app run -c <connection> --warehouse ROUTING_ANALYTICS
   ```

2. **Grant warehouse access to the app** (required for the React control app SQL API):
   ```sql
   GRANT USAGE ON WAREHOUSE ROUTING_ANALYTICS TO APPLICATION OPENROUTESERVICE_NATIVE_APP;
   ```

3. **Open the application in browser:**
   ```bash
   cd Native_app && snow app open -c <connection> --warehouse ROUTING_ANALYTICS
   ```

4. **Verify** deployment output includes:
   - Application package created: `OPENROUTESERVICE_NATIVE_APP_PKG`
   - Application created: `OPENROUTESERVICE_NATIVE_APP`
   - Snowsight URL provided

**Output:** Native app deployed and accessible via Snowsight URL

### Step 7: User Confirmation (Required)

**Goal:** Ensure user has completed UI setup before marking skill as complete

**Actions:**

1. **Ask user to complete** the following in Snowsight:
   - Navigate to **Catalog >> Apps >> OPENROUTESERVICE_NATIVE_APP**
   - Select warehouse **ROUTING_ANALYTICS**
   - **External connections:** Click **Review**, see the message "OPENROUTESERVICE_NATIVE_APP would like to connect to the following external endpoints", then click **Connect**. There are TWO references: one for OSM map downloads and one for CARTO basemap tiles. Both must be connected.
   - **Account Privileges:** Click **Grant**
   - **Activation:** Wait while "Activating OPENROUTESERVICE_NATIVE_APP" is displayed (this may take 1-2 minutes)
   - When you see "OPENROUTESERVICE_NATIVE_APP is activated", click **Proceed to App**
   - (Optional) Go to the **Access Management** tab to grant access to additional roles
   - Click **Launch App** and wait through the launching steps
   - When you see **"OPEN ROUTE SERVICE | SERVICE MANAGER"**, the app is fully operational

2. **Wait for explicit confirmation** from user before proceeding to any subsequent skills

**IMPORTANT:** Do NOT mark this skill as complete until the user confirms all the above steps are done.

**Output:** User confirmation received that app is fully operational

## Stopping Points

- ✋ Step 2: After detecting container runtime - confirm user's choice if both available
- ✋ Step 5: After starting container build - monitor for authentication errors
- ✋ Step 6: After deployment - verify application created successfully

## Common Issues

### Container Runtime Not Running
**Symptom:** "Cannot connect to the Docker daemon" or "Cannot connect to Podman"
**Solution:** 
- Podman: `podman machine start`
- Docker: Start Docker Desktop application

### Authentication Required
**Symptom:** "unauthorized" or "authentication required" or "invalid username/password"
**Solution:** 
- Docker: Run `snow spcs image-registry login -c <connection>`
- Podman: Use session token with password-stdin:
  ```bash
  REGISTRY_URL=$(snow spcs image-repository url openrouteservice_setup.public.image_repository -c <connection> | cut -d'/' -f1)
  snow spcs image-registry token --format=JSON -c <connection> | podman login $REGISTRY_URL -u 0sessiontoken --password-stdin
  ```

### Wrong Directory Error
**Symptom:** "cd: services/openrouteservice: No such file or directory"
**Solution:** Ensure script runs from `Native_app/` directory, not `provider_setup/`

### ARM Mac esbuild Crash (ors_control_app)
**Symptom:** `esbuild` crashes with QEMU segfault during `npm run build` inside `podman build --platform linux/amd64`
**Solution:** Build the React app locally (native ARM) first, then use a runtime-only Dockerfile that copies the pre-built `dist/` and `dist-server/` directories. See Step 5 for the exact commands. Must temporarily rename `.dockerignore` since it excludes `dist/`.

### Control App Shows ERROR / Unhealthy / 0 Services
**Symptom:** React UI shows ERROR for compute pool, Unhealthy for ORS health, 0 running services
**Solution:** Check service logs with `SYSTEM$GET_SERVICE_LOGS`. Common causes:
1. **Missing warehouse grant:** Run `GRANT USAGE ON WAREHOUSE ROUTING_ANALYTICS TO APPLICATION OPENROUTESERVICE_NATIVE_APP;`
2. **Missing QUERY_WAREHOUSE:** Run `ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.ORS_CONTROL_APP SET QUERY_WAREHOUSE = ROUTING_ANALYTICS;`
3. **`{{database}}` template not resolved:** SPCS does NOT resolve `{{database}}` in service spec env vars within Native App context. The service spec must hardcode the database name (`OPENROUTESERVICE_NATIVE_APP`), not use `{{database}}`.

### Podman Registry Auth for Wrong Host
**Symptom:** `podman push` fails with "unable to retrieve auth token: invalid username/password: unauthorized" even after `snow spcs image-registry login`
**Solution:** `snow spcs image-registry login` may store credentials for the wrong registry hostname. Use the manual token approach with `--creds` flag:
```bash
REGISTRY_URL=$(snow spcs image-repository url openrouteservice_setup.public.image_repository -c <connection> | cut -d'/' -f1)
TOKEN=$(snow spcs image-registry token --format=JSON -c <connection>)
podman push --creds "0sessiontoken:$TOKEN" $REGISTRY_URL/ors_control_app:v1.0.5
```

### Basemap Tiles Not Loading (ENOTFOUND / 502)
**Symptom:** Map shows grey tiles, browser console shows 502 errors for `/api/tiles/`, service logs show `getaddrinfo ENOTFOUND a.basemaps.cartocdn.com`
**Cause:** The CARTO basemap EAI (`external_access_carto_ref`) is not bound to the control app service, so SPCS cannot resolve DNS for `a.basemaps.cartocdn.com`.
**Solution:**
1. First check if the EAI reference was auto-provisioned during setup. If the app was installed before the CARTO EAI was added, manually create and bind it:
   ```sql
   CREATE OR REPLACE NETWORK RULE OPENROUTESERVICE_SETUP.PUBLIC.ORS_MAP_TILES_RULE
       MODE = EGRESS TYPE = HOST_PORT
       VALUE_LIST = ('a.basemaps.cartocdn.com:443', 'b.basemaps.cartocdn.com:443',
                     'c.basemaps.cartocdn.com:443', 'd.basemaps.cartocdn.com:443');
   CREATE OR REPLACE EXTERNAL ACCESS INTEGRATION ORS_MAP_TILES_EAI
       ALLOWED_NETWORK_RULES = (OPENROUTESERVICE_SETUP.PUBLIC.ORS_MAP_TILES_RULE) ENABLED = TRUE;
   GRANT USAGE ON INTEGRATION ORS_MAP_TILES_EAI TO APPLICATION OPENROUTESERVICE_NATIVE_APP;
   CALL OPENROUTESERVICE_NATIVE_APP.CORE.REGISTER_SINGLE_CALLBACK(
       'EXTERNAL_ACCESS_CARTO_REF', 'ADD',
       SYSTEM$REFERENCE('EXTERNAL ACCESS INTEGRATION', 'ORS_MAP_TILES_EAI', 'PERSISTENT', 'USAGE'));
   ```
2. Then recreate the control app to pick up the EAI (it must be present at service creation time):
   ```sql
   CALL OPENROUTESERVICE_NATIVE_APP.CORE.CREATE_CONTROL_APP();
   ```
**Key insight:** `ALTER SERVICE SET EXTERNAL_ACCESS_INTEGRATIONS` does NOT reliably enable DNS. The EAI must be present at `CREATE SERVICE` time. The `create_control_app` procedure now DROP+CREATEs the service to ensure this.

## Output

Fully deployed OpenRouteService route optimizer as Snowflake Native App with:
- Database: `OPENROUTESERVICE_SETUP`
- Application: `OPENROUTESERVICE_NATIVE_APP`
- 5 SPCS services running (downloader, openrouteservice, gateway, vroom, ors_control_app)
- React-based ORS Control App accessible via SPCS endpoint (city provisioning, service management, matrix builder, function tester)

### Default Routing Profiles

| Profile | Enabled |
|---------|--------|
| driving-car | Yes |
| driving-hgv | Yes |
| cycling-electric | Yes |

All other profiles (cycling-regular, cycling-road, cycling-mountain, foot-walking, foot-hiking, wheelchair) are disabled by default. When provisioning new cities via the Cities tab, users can select which routing profiles to install using the profile checkboxes. Use the `routing-customization` skill to change profiles on the default (San Francisco) instance.

### Default Service Limits

| Setting | Value | Description |
|---------|-------|-------------|
| maximum_distance | 1,500 km | Max route distance for all profiles |
| maximum_range_time (isochrones) | 18,000 s (5 hours) | Max isochrone travel time |
| maximum_range_distance (isochrones) | 1,500 km | Max isochrone travel distance |
| maximum_intervals (isochrones) | 10 | Max isochrone intervals per request |
| maximum_routes (matrix) | 250,000 | Max matrix routes |

### Available Functions

The app registers the following SQL functions in the `CORE` schema:

**Scalar functions** (return VARIANT with full ORS JSON response):
- `DIRECTIONS(method, jstart, jend)` / `DIRECTIONS(method, locations)`
- `ISOCHRONES(method, lon, lat, range)`
- `OPTIMIZATION(jobs, vehicles, matrices)` / `OPTIMIZATION(challenge)`
- `MATRIX(method, sources, destinations)` / `MATRIX_TABULAR(...)`

**GEO table functions** (return parsed GEOGRAPHY column alongside response):
- `DIRECTIONS_GEO(method, jstart, jend)` → RESPONSE, GEOJSON, DISTANCE, DURATION
- `DIRECTIONS_GEO(method, locations)` → RESPONSE, GEOJSON, DISTANCE, DURATION
- `ISOCHRONES_GEO(method, lon, lat, range)` → RESPONSE, GEOJSON
- `OPTIMIZATION_GEO(jobs, vehicles, matrices)` → RESPONSE, GEOJSON, VEHICLE, DURATION, STEPS
- `OPTIMIZATION_GEO(challenge)` → RESPONSE, GEOJSON, VEHICLE, DURATION, STEPS

The `_GEO` variants are table functions that parse the GeoJSON from ORS responses into Snowflake GEOGRAPHY columns, making it easy to use with spatial joins and visualization.

**Lifecycle management procedures:**
- `RESUME_ALL_SERVICES()` — Resumes all suspended services and the compute pool
- `SUSPEND_ALL_SERVICES()` — Suspends all services except the control app
- `SCALE_SERVICES(min, max)` — Scales ORS + gateway instances and pool nodes
- `GET_STATUS()` — Returns JSON with compute pool state and all service statuses
- `CHECK_HEALTH()` — Returns BOOLEAN, true if ORS gateway responds

**Multi-city procedures:**
- `SETUP_CITY_ORS(region)` — Provisions a new city with its own ORS service + functions
- `DROP_CITY_ORS(region)` — Removes a city's service, functions, and metadata
- `LIST_CITIES()` — Returns JSON array of all provisioned cities
- City-specific functions: `DIRECTIONS_{REGION}`, `ISOCHRONES_{REGION}`, `MATRIX_{REGION}`, `OPTIMIZATION_{REGION}`

**Travel time matrix procedures:**
- `BUILD_MATRIX_FOR_REGION(res, min_lat, max_lat, min_lon, max_lon, matrix_fn, region)` — End-to-end matrix build
- `MATRIX_PROGRESS()` — Returns JSON with per-resolution build status
- `RESET_MATRIX_DATA()` — Truncates all matrix tables

Access via: Snowsight → Data Products >> Apps. After selecting OPENROUTESERVICE_NATIVE_APP grant the required privileges via UI and launch it for the first time via button in upper right corner. It make take a minute or two.

## Cleanup

To remove all objects created by this skill:

```sql
-- Reverse dependency order: application first, then images, stages, warehouse, database
DROP APPLICATION IF EXISTS OPENROUTESERVICE_NATIVE_APP CASCADE;
DROP APPLICATION PACKAGE IF EXISTS OPENROUTESERVICE_NATIVE_APP_PKG;
DROP WAREHOUSE IF EXISTS ROUTING_ANALYTICS;
DROP IMAGE REPOSITORY IF EXISTS OPENROUTESERVICE_SETUP.PUBLIC.IMAGE_REPOSITORY;
DROP STAGE IF EXISTS OPENROUTESERVICE_SETUP.PUBLIC.ORS_ELEVATION_CACHE_SPCS_STAGE;
DROP STAGE IF EXISTS OPENROUTESERVICE_SETUP.PUBLIC.ORS_GRAPHS_SPCS_STAGE;
DROP STAGE IF EXISTS OPENROUTESERVICE_SETUP.PUBLIC.ORS_SPCS_STAGE;
DROP DATABASE IF EXISTS OPENROUTESERVICE_SETUP;
```

> **Tip:** Use the `cleanup` skill to auto-discover all tagged objects via COMMENT tracking.
