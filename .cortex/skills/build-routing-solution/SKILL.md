---
name: build-routing-solution
description: "Build routing solution Snowflake Native App with SPCS. Use when: build routing solution, set up OpenRouteService native app, building and pushing SPCS images. Triggers: build routing solution, install openrouteservice app."
---

# Deploy Route Optimizer

Deploys the OpenRouteService route optimization application as a Snowflake Native App using Snowpark Container Services.

## Prerequisites

- Container runtime (Podman or Docker) installed and running
- Snowflake CLI (`snow`) installed
- Active Snowflake connection with ACCOUNTADMIN role
- Repository cloned at: `/sfguide-create-a-route-optimisation-and-vehicle-route-plan-simulator`

## Workflow

### Step 1: Set Query Tag for Tracking

**Goal:** Set session query tag for attribution tracking.

```sql
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is","name":"oss-build-routing-solution-in-snowflake","version":{"major":1, "minor":0},"attributes":{"is_quickstart":1, "source":"sql"}}';
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

**Next:** Proceed to Step 2

### Step 3: Setup Database and Stages

**Goal:** Create required Snowflake infrastructure

**Actions:**

1. **Execute** environment setup SQL:
   ```sql
   CREATE DATABASE IF NOT EXISTS OPENROUTESERVICE_SETUP
       COMMENT = '{"origin":"sf_sit-is", "name":"oss-build-routing-solution-in-snowflake", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';
   CREATE STAGE IF NOT EXISTS OPENROUTESERVICE_SETUP.PUBLIC.ORS_SPCS_STAGE ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE') DIRECTORY=(ENABLE=TRUE);
   CREATE STAGE IF NOT EXISTS OPENROUTESERVICE_SETUP.PUBLIC.ORS_GRAPHS_SPCS_STAGE ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE') DIRECTORY=(ENABLE=TRUE);
   CREATE STAGE IF NOT EXISTS OPENROUTESERVICE_SETUP.PUBLIC.ORS_ELEVATION_CACHE_SPCS_STAGE ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE') DIRECTORY=(ENABLE=TRUE);
   CREATE IMAGE IF NOT EXISTS REPOSITORY OPENROUTESERVICE_SETUP.PUBLIC.IMAGE_REPOSITORY;
   CREATE WAREHOUSE IF NOT EXISTS ROUTING_ANALYTICS AUTO_SUSPEND = 60
       COMMENT = '{"origin":"sf_sit-is", "name":"oss-build-routing-solution-in-snowflake", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';
   ```

**Output:** Database `OPENROUTESERVICE_SETUP` with stages, warehouse and image repository created

**Next:** Proceed to Step 3

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

**Next:** Proceed to Step 4

### Step 5: Build and Push Container Images

**Goal:** Build 4 container images and push to Snowflake image repository

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
   $CONTAINER_CMD build --rm --platform linux/amd64 -t $REPO_URL/routing_reverse_proxy:v0.5.6 .
   $CONTAINER_CMD push $REPO_URL/routing_reverse_proxy:v0.5.6
   
   # vroom image
   cd ../vroom
   $CONTAINER_CMD build --rm --platform linux/amd64 -t $REPO_URL/vroom-docker:v1.0.1 .
   $CONTAINER_CMD push $REPO_URL/vroom-docker:v1.0.1
   
   # return to working directory
   cd ../../..
   ```

4. **Monitor** progress (builds 4 images):
   - openrouteservice:v9.0.0
   - downloader:v0.0.3
   - routing_reverse_proxy:v0.5.6
   - vroom-docker:v1.0.1

**Output:** All 4 container images pushed to Snowflake image repository

**Expected Duration:** 5-10 minutes

**If error occurs:**
- Authentication issue: Ensure you ran `snow spcs image-registry login`
- Podman machine not running: `podman machine start`
- Docker daemon not running: Start Docker Desktop
- Build failures: Check container runtime status and retry

**Next:** Proceed to Step 5

### Step 6: Deploy Native App

**Goal:** Create and deploy the native application

**Actions:**

1. **Deploy the application:**
   ```bash
   cd Native_app && snow app run -c <connection> --warehouse ROUTING_ANALYTICS
   ```

2. **Open the application in browser:**
   ```bash
   cd Native_app && snow app open -c <connection> --warehouse ROUTING_ANALYTICS
   ```

3. **Verify** deployment output includes:
   - Application package created: `OPENROUTESERVICE_NATIVE_APP_PKG`
   - Application created: `OPENROUTESERVICE_NATIVE_APP`
   - Snowsight URL provided

**Output:** Native app deployed and accessible via Snowsight URL

### Step 7: User Confirmation (Required)

**Goal:** Ensure user has completed UI setup before marking skill as complete

**Actions:**

1. **Ask user to confirm** they have completed the following in Snowsight:
   - Navigated to Data Products >> Apps >> OPENROUTESERVICE_NATIVE_APP
   - Granted all required privileges via the UI
   - Launched the app using the button in the upper right corner
   - Verified the app is now accessible and services are running

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

## Output

Fully deployed OpenRouteService route optimizer as Snowflake Native App with:
- Database: `OPENROUTESERVICE_SETUP`
- Application: `OPENROUTESERVICE_NATIVE_APP`
- 4 SPCS services running (downloader, openrouteservice, gateway, vroom)

Access via: Snowsight → Data Products >> Apps. After selecting OPENROUTESERVICE_NATIVE_APP grant the required privileges via UI and launch it for the first time via button in upper right corner. It make take a minute or two.
