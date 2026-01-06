---
name: deploy-route-optimizer
description: "Deploy OpenRouteService route optimizer as Snowflake Native App with SPCS. Use when: deploying route optimizer, setting up OpenRouteService native app, building and pushing SPCS images. Triggers: deploy route optimizer, setup route optimizer, install openrouteservice app."
---

# Deploy Route Optimizer

Deploys the OpenRouteService route optimization application as a Snowflake Native App using Snowpark Container Services.

## Prerequisites

- Docker Desktop installed and running
- Snowflake CLI (`snow`) installed
- Active Snowflake connection with ACCOUNTADMIN role
- Repository cloned at: `/sfguide-create-a-route-optimisation-and-vehicle-route-plan-simulator`

## Workflow

### Step 1: Setup Database and Stages

**Goal:** Create required Snowflake infrastructure

**Actions:**

1. **Execute** environment setup SQL:
   ```sql
   -- From Native_app/provider_setup/env_setup.sql
   CREATE DATABASE OPENROUTESERVICE_SETUP;
   CREATE STAGE OPENROUTESERVICE_SETUP.PUBLIC.ORS_SPCS_STAGE ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE') DIRECTORY=(ENABLE=TRUE);
   CREATE STAGE OPENROUTESERVICE_SETUP.PUBLIC.ORS_GRAPHS_SPCS_STAGE ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE') DIRECTORY=(ENABLE=TRUE);
   CREATE STAGE OPENROUTESERVICE_SETUP.PUBLIC.ORS_ELEVATION_CACHE_SPCS_STAGE ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE') DIRECTORY=(ENABLE=TRUE);
   CREATE IMAGE REPOSITORY OPENROUTESERVICE_SETUP.PUBLIC.IMAGE_REPOSITORY;
   ```

**Output:** Database `OPENROUTESERVICE_SETUP` with stages and image repository created

**Next:** Proceed to Step 2

### Step 2: Upload Configuration Files

**Goal:** Stage required configuration and map files

**Actions:**

1. **Upload** files from `Native_app/provider_setup/staged_files/` to stage:
   ```bash
   snow stage copy "Native_app/provider_setup/staged_files/SanFrancisco.osm.pbf" \
     @OPENROUTESERVICE_SETUP.PUBLIC.ORS_SPCS_STAGE --connection <connection> --overwrite
   
   snow stage copy "Native_app/provider_setup/staged_files/ors-config.yml" \
     @OPENROUTESERVICE_SETUP.PUBLIC.ORS_SPCS_STAGE --connection <connection> --overwrite

   snow stage copy "Notebook/download_map.ipynb" \
   @OPENROUTESERVICE_SETUP.PUBLIC.ORS_SPCS_STAGE --connection <connection> --overwrite
   ```

**Output:** Configuration files uploaded to Snowflake stage

**Next:** Proceed to Step 3

### Step 3: Build and Push Docker Images

**Goal:** Build 4 Docker images and push to Snowflake image repository

**Actions:**

1. **Verify** Docker Desktop is running:
   ```bash
   docker info
   ```
   If not running: `open -a Docker` (macOS)

2. **Check** connection name in `Native_app/provider_setup/spcs_setup.sh`:
   - instead of `<connection` use active connection name, do not replace the name in file directly, use a variable instead

3. **Execute** SPCS setup script from `Native_app/` directory:
   ```bash
   cd Native_app && bash provider_setup/spcs_setup.sh
   ```

4. **Monitor** progress (builds 4 images):
   - openrouteservice:v9.0.0
   - downloader:v0.0.3
   - routing_reverse_proxy:v0.5.6
   - vroom-docker:v1.0.1

**Output:** All 4 Docker images pushed to Snowflake image repository

**Expected Duration:** 5-10 minutes

**If error occurs:**
- Docker authentication issue: Sign in to Docker Desktop with Snowflake org credentials
- Directory not found: Ensure running from `Native_app/` directory
- Build failures: Check Docker daemon status and retry

**Next:** Proceed to Step 4

### Step 4: Deploy Native App

**Goal:** Create and deploy the native application

**Actions:**

1. **Deploy and open the application** the application:
   ```bash
   cd Native_app && snow app run -c <connection>
   snow app open -c <connection>
   ```

2. **Verify** deployment output includes:
   - Application package created: `OPENROUTESERVICE_NATIVE_APP_PKG`
   - Application created: `OPENROUTESERVICE_NATIVE_APP`
   - Snowsight URL provided

**Output:** Native app deployed and accessible via Snowsight URL

## Stopping Points

- ✋ Step 3: After starting Docker build - monitor for authentication errors
- ✋ Step 4: After deployment - verify application created successfully

## Common Issues

### Docker Authentication Required
**Symptom:** "Sign in to continue using Docker Desktop"
**Solution:** Sign in to Docker Desktop with Snowflake organization credentials

### Wrong Directory Error
**Symptom:** "cd: services/openrouteservice: No such file or directory"
**Solution:** Ensure script runs from `Native_app/` directory, not `provider_setup/`

## Output

Fully deployed OpenRouteService route optimizer as Snowflake Native App with:
- Database: `OPENROUTESERVICE_SETUP`
- Application: `OPENROUTESERVICE_NATIVE_APP`
- 4 SPCS services running (downloader, openrouteservice, gateway, vroom)

Access via: Snowsight → Data Products >> Apps. After selecting OPENROUTESERVICE_NATIVE_APP grant the required privileges via UI and launch it for the first time via button in upper right corner. It make take a minute or two.
