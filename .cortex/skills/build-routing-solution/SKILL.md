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

> All relative paths (e.g., `native_app/`, `scripts/`) are relative to this skill's directory (`.cortex/skills/build-routing-solution/`).

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

1. **Upload** files from `native_app/provider_setup/staged_files/` to stage:
   ```bash
   snow stage copy "native_app/provider_setup/staged_files/SanFrancisco.osm.pbf" \
     @OPENROUTESERVICE_SETUP.PUBLIC.ORS_SPCS_STAGE/SanFrancisco/ --connection <connection> --overwrite
   
   snow stage copy "native_app/provider_setup/staged_files/ors-config.yml" \
     @OPENROUTESERVICE_SETUP.PUBLIC.ORS_SPCS_STAGE/SanFrancisco/ --connection <connection> --overwrite

   snow stage copy "scripts/download_map.py" \
   @OPENROUTESERVICE_SETUP.PUBLIC.ORS_SPCS_STAGE/scripts/ --connection <connection> --overwrite
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
   cd native_app/services/openrouteservice
   $CONTAINER_CMD build --rm --platform linux/amd64 -t $REPO_URL/openrouteservice:v9.0.0 .
   $CONTAINER_CMD push $REPO_URL/openrouteservice:v9.0.0
   
   # downloader image
   cd ../downloader
   $CONTAINER_CMD build --rm --platform linux/amd64 -t $REPO_URL/downloader:v0.0.3 .
   $CONTAINER_CMD push $REPO_URL/downloader:v0.0.3
   
   # gateway image
   cd ../gateway
   $CONTAINER_CMD build --rm --platform linux/amd64 -t $REPO_URL/routing_reverse_proxy:v0.9.5 .
   $CONTAINER_CMD push $REPO_URL/routing_reverse_proxy:v0.9.5
   
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
   $CONTAINER_CMD build --rm --platform linux/amd64 -f Dockerfile.runtime -t $REPO_URL/ors_control_app:v1.0.28 .
   mv .dockerignore.bak .dockerignore 2>/dev/null; rm -f Dockerfile.runtime
   $CONTAINER_CMD push $REPO_URL/ors_control_app:v1.0.28
   
   # return to working directory
   cd ../../..
   ```

4. **Monitor** progress (builds 5 images):
   - openrouteservice:v9.0.0
   - downloader:v0.0.3
   - routing_reverse_proxy:v0.9.5
   - vroom-docker:v1.0.1
   - ors_control_app:v1.0.28

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
   cd native_app && snow app run -c <connection> --warehouse ROUTING_ANALYTICS
   ```

2. **Grant warehouse access to the app** (required for the React control app SQL API):
   ```sql
   GRANT USAGE ON WAREHOUSE ROUTING_ANALYTICS TO APPLICATION OPENROUTESERVICE_NATIVE_APP;
   ```

3. **Open the application in browser:**
   ```bash
   cd native_app && snow app open -c <connection> --warehouse ROUTING_ANALYTICS
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

- Step 2: After detecting container runtime — confirm user's choice if both available
- Step 5: After starting container build — monitor for authentication errors
- Step 6: After deployment — verify application created successfully

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

See `references/available-functions.md` for the full list of SQL functions, routing profiles, service limits, and matrix builder details.

See `references/snowflake-scripting-guidelines.md` for SQL Scripting coding rules (variable binding, EXECUTE IMMEDIATE patterns, sandbox testing, deployment paths).

Access via: Snowsight → Data Products >> Apps. After selecting OPENROUTESERVICE_NATIVE_APP grant the required privileges via UI and launch it for the first time via button in upper right corner. It may take a minute or two.

## Examples

### Example 1: Fresh deployment
User says: "Set up the OpenRouteService native app from scratch"
Actions:
1. Detect container runtime (Step 2)
2. Create database and stages (Step 3)
3. Upload config files (Step 4)
4. Build and push all 5 images (Step 5)
5. Deploy native app (Step 6)
6. Guide user through Snowsight activation (Step 7)
Result: Fully operational ORS app with San Francisco routing

### Example 2: Rebuild control app only
User says: "Update the control app to latest version"
Actions:
1. Use the Fast Deploy shortcut: `cd native_app/services/ors_control_app && ./deploy.sh <connection> v1.0.28`
Result: Control app image rebuilt and deployed, app upgraded

### Example 3: Update stored procedures only
User says: "I changed setup_script.sql, deploy it"
Actions:
1. Upload setup_script.sql to stage ROOT (NOT `app/` — see `references/snowflake-scripting-guidelines.md` §2) and upgrade app:
   ```sql
   PUT file:///path/to/setup_script.sql @OPENROUTESERVICE_NATIVE_APP_PKG.APP_SRC.STAGE/ OVERWRITE=TRUE AUTO_COMPRESS=FALSE;
   ALTER APPLICATION OPENROUTESERVICE_NATIVE_APP UPGRADE USING @OPENROUTESERVICE_NATIVE_APP_PKG.APP_SRC.STAGE;
   ```
Result: Stored procedures updated without container rebuild

## Fast Deploy (Control App Only)

To rebuild and redeploy only the ORS Control App without rebuilding all images:

```bash
cd native_app/services/ors_control_app
./deploy.sh <connection> <version>
# Example: ./deploy.sh fleet_test_evals v1.0.19
```

This script: builds React + server locally, creates runtime Dockerfile, pushes image, updates service YAML version, uploads setup_script.sql to app package stage, and upgrades the native app.

Alternatively, to update just the setup_script.sql (stored procedures) without rebuilding the container:

```sql
-- IMPORTANT: PUT to stage ROOT, not app/ — manifest reads from root
PUT file:///path/to/setup_script.sql @OPENROUTESERVICE_NATIVE_APP_PKG.APP_SRC.STAGE/ OVERWRITE=TRUE AUTO_COMPRESS=FALSE;
ALTER APPLICATION OPENROUTESERVICE_NATIVE_APP UPGRADE USING @OPENROUTESERVICE_NATIVE_APP_PKG.APP_SRC.STAGE;
```

## Coding Guidelines

Before modifying `setup_script.sql` or any service YAML, read `references/snowflake-scripting-guidelines.md`. It covers:
- Variable binding rules (colon prefix gotchas)
- Stage file map (where each file must be PUT)
- Pre-deployment and post-deployment checklists
- Deployment verification SQL
- Sandbox testing workflow
- Common pitfalls and their fixes

These guidelines exist because past issues were caused by wrong stage paths, incorrect variable syntax, and missing verification steps. Follow them to avoid repeating these mistakes.

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
