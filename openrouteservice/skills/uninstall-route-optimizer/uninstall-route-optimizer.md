---
name: uninstall-route-optimizer
description: "Uninstall OpenRouteService Native App and all dependencies for fresh redeployment. Use when: removing route optimizer, cleaning up deployment, resetting environment. Triggers: uninstall route optimizer, remove route optimizer, cleanup deployment, reset app."
---

# Uninstall Route Optimizer

Removes the OpenRouteService Native App and all associated Snowflake resources, allowing for a fresh deployment.

## Prerequisites

- Snowflake CLI (`snow`) installed
- Active Snowflake connection with ACCOUNTADMIN role

## Workflow

### Step 1: Confirm Uninstallation

**Goal:** Verify user wants to proceed with complete removal

**Actions:**

1. **Ask user** to confirm they want to uninstall the Route Optimizer app and ALL associated resources:
   - Native App: `OPENROUTESERVICE_NATIVE_APP`
   - Application Package: `OPENROUTESERVICE_NATIVE_APP_PKG`
   - Database: `OPENROUTESERVICE_SETUP` (includes all stages and image repository)
   - Demo Database: `VEHICLE_ROUTING_SIMULATOR` (includes notebooks and Streamlit apps)
   - Marketplace Data: `OVERTURE_MAPS__PLACES` (Carto POI data)
   - Warehouse: `ROUTING_ANALYTICS` (optional)

2. **Ask user** if they also want to:
   - Remove local container images (podman/docker)
   - Keep the warehouse for other uses
   - Keep the Carto Overture Maps marketplace data for other uses

**IMPORTANT:** Do NOT proceed without explicit user confirmation.

**Output:** User confirmation received

**Next:** Proceed to Step 2

### Step 2: Drop Native App

**Goal:** Remove the deployed Native Application

**Actions:**

1. **Drop** the Native App:
   ```sql
   DROP APPLICATION IF EXISTS OPENROUTESERVICE_NATIVE_APP CASCADE;
   ```

2. **Verify** the app is removed:
   ```sql
   SHOW APPLICATIONS LIKE 'OPENROUTESERVICE_NATIVE_APP';
   ```

**Output:** Native App removed

**Next:** Proceed to Step 3

### Step 3: Drop Application Package

**Goal:** Remove the application package

**Actions:**

1. **Drop** the Application Package:
   ```sql
   DROP APPLICATION PACKAGE IF EXISTS OPENROUTESERVICE_NATIVE_APP_PKG;
   ```

2. **Verify** the package is removed:
   ```sql
   SHOW APPLICATION PACKAGES LIKE 'OPENROUTESERVICE_NATIVE_APP_PKG';
   ```

**Output:** Application Package removed

**Next:** Proceed to Step 4

### Step 4: Drop Database and All Contents

**Goal:** Remove the setup database including all stages and image repository

**Actions:**

1. **Drop** the database (this removes all stages and image repository):
   ```sql
   DROP DATABASE IF EXISTS OPENROUTESERVICE_SETUP CASCADE;
   ```

2. **Verify** the database is removed:
   ```sql
   SHOW DATABASES LIKE 'OPENROUTESERVICE_SETUP';
   ```

**Output:** Database and all contents (stages, image repository) removed

**Next:** Proceed to Step 5

### Step 5: Drop Demo Database

**Goal:** Remove the demo database including notebooks and Streamlit apps

**Actions:**

1. **Drop** the demo database (this removes notebooks and Streamlit apps):
   ```sql
   DROP DATABASE IF EXISTS VEHICLE_ROUTING_SIMULATOR CASCADE;
   ```

2. **Verify** the database is removed:
   ```sql
   SHOW DATABASES LIKE 'VEHICLE_ROUTING_SIMULATOR';
   ```

**Output:** Demo database and all contents (notebooks, Streamlit apps) removed

**Next:** Proceed to Step 6

### Step 6: Drop Marketplace Data (Optional)

**Goal:** Remove the Carto Overture Maps dataset if user confirmed

**Actions:**

1. **If user confirmed marketplace data removal**, drop the database:
   ```sql
   DROP DATABASE IF EXISTS OVERTURE_MAPS__PLACES CASCADE;
   ```

2. **Verify** the database is removed:
   ```sql
   SHOW DATABASES LIKE 'OVERTURE_MAPS__PLACES';
   ```

**Output:** Marketplace data removed (or skipped if user chose to keep it)

**Next:** Proceed to Step 7

### Step 7: Drop Warehouse (Optional)

**Goal:** Remove the compute warehouse if user confirmed

**Actions:**

1. **If user confirmed warehouse removal**, drop the warehouse:
   ```sql
   DROP WAREHOUSE IF EXISTS ROUTING_ANALYTICS;
   ```

2. **Verify** the warehouse is removed:
   ```sql
   SHOW WAREHOUSES LIKE 'ROUTING_ANALYTICS';
   ```

**Output:** Warehouse removed (or skipped if user chose to keep it)

**Next:** Proceed to Step 8

### Step 8: Clean Up Local Container Images (Optional)

**Goal:** Remove local container images if user confirmed

**Actions:**

1. **Check** which container runtime is available:
   ```bash
   podman --version 2>/dev/null && CONTAINER_CMD=podman || CONTAINER_CMD=docker
   ```

2. **If user confirmed image cleanup**, remove local images:
   ```bash
   # List ORS-related images
   $CONTAINER_CMD images | grep -E "(openrouteservice|downloader|routing_reverse_proxy|vroom-docker)"
   
   # Remove images (adjust repository URL as needed)
   $CONTAINER_CMD rmi $(CONTAINER_CMD images --format '{{.Repository}}:{{.Tag}}' | grep -E "(openrouteservice|downloader|routing_reverse_proxy|vroom-docker)") 2>/dev/null || echo "No local images to remove"
   ```

**Output:** Local container images removed (or skipped)

**Next:** Proceed to Step 9

### Step 9: Verification Summary

**Goal:** Confirm all resources have been removed

**Actions:**

1. **Run** verification queries:
   ```sql
   -- Should all return empty results
   SHOW APPLICATIONS LIKE 'OPENROUTESERVICE%';
   SHOW APPLICATION PACKAGES LIKE 'OPENROUTESERVICE%';
   SHOW DATABASES LIKE 'OPENROUTESERVICE%';
   SHOW DATABASES LIKE 'VEHICLE_ROUTING_SIMULATOR';
   SHOW DATABASES LIKE 'OVERTURE_MAPS__PLACES';
   ```

2. **Present** summary to user:

   | Resource | Status |
   |----------|--------|
   | Native App | ✅ Removed |
   | Application Package | ✅ Removed |
   | Setup Database (stages, image repo) | ✅ Removed |
   | Demo Database (notebooks, Streamlit) | ✅ Removed |
   | Marketplace Data (Carto POI) | ✅ Removed / ⏭️ Kept |
   | Warehouse | ✅ Removed / ⏭️ Kept |
   | Local Container Images | ✅ Removed / ⏭️ Skipped |

3. **Inform user** they can now redeploy using:
   ```
   use the local skill from skills/deploy-route-optimizer
   ```

**Output:** Uninstallation complete, environment ready for fresh deployment

## Stopping Points

- ✋ Step 1: MUST wait for user confirmation before proceeding
- ✋ Step 6: Confirm marketplace data removal preference
- ✋ Step 7: Confirm warehouse removal preference
- ✋ Step 8: Confirm local image cleanup preference

## Common Issues

### Permission Denied
**Symptom:** "Insufficient privileges" error
**Solution:** Ensure you're using ACCOUNTADMIN role or have appropriate privileges

### App In Use
**Symptom:** "Application is currently in use" error
**Solution:** Wait for any running services to stop, or force drop with CASCADE

### Database Has Dependencies
**Symptom:** Cannot drop database
**Solution:** Use CASCADE option to remove all dependent objects

## Output

All OpenRouteService resources removed:
- Native App: `OPENROUTESERVICE_NATIVE_APP` - Dropped
- Application Package: `OPENROUTESERVICE_NATIVE_APP_PKG` - Dropped
- Setup Database: `OPENROUTESERVICE_SETUP` - Dropped (includes stages and image repository)
- Demo Database: `VEHICLE_ROUTING_SIMULATOR` - Dropped (includes notebooks and Streamlit apps)
- Marketplace Data: `OVERTURE_MAPS__PLACES` - Dropped or Kept (per user choice)
- Warehouse: `ROUTING_ANALYTICS` - Dropped or Kept (per user choice)
- Local Images: Removed or Skipped (per user choice)

Environment is now clean and ready for fresh deployment.
