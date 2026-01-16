---
name: uninstall-demo
description: "Uninstall Route Optimization demo content including notebooks and Streamlit simulator. Use when: removing demo, cleaning up demo deployment, resetting demo environment. Triggers: uninstall demo, remove demo, cleanup demo, remove notebooks, remove streamlit."
---

# Uninstall Demo

Removes the Route Optimization demo content including the demo database (notebooks, Streamlit simulator) and optionally the Carto Overture Maps marketplace data.

> **_NOTE:_** This skill only removes demo content. To remove the OpenRouteService Native App, use the `uninstall-route-optimizer` skill from the ORS folder.

## Prerequisites

- Active Snowflake connection with ACCOUNTADMIN role
- Demo previously deployed via `deploy-demo` skill

## Workflow

### Step 1: Confirm Uninstallation

**Goal:** Verify user wants to proceed with demo removal

**Actions:**

1. **Ask user** to confirm they want to uninstall the demo resources:
   - Demo Database: `VEHICLE_ROUTING_SIMULATOR` (includes notebooks and Streamlit apps)
   
2. **Ask user** if they also want to:
   - Remove the Carto Overture Maps marketplace data (`OVERTURE_MAPS__PLACES`)
   - Remove the warehouse (`ROUTING_ANALYTICS`)

**IMPORTANT:** Do NOT proceed without explicit user confirmation.

**Output:** User confirmation received

**Next:** Proceed to Step 2

### Step 2: Drop Demo Database

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

**Next:** Proceed to Step 3

### Step 3: Drop Marketplace Data (Optional)

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

**Next:** Proceed to Step 4

### Step 4: Drop Warehouse (Optional)

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

**Next:** Proceed to Step 5

### Step 5: Verification Summary

**Goal:** Confirm all demo resources have been removed

**Actions:**

1. **Run** verification queries:
   ```sql
   -- Should return empty results for removed resources
   SHOW DATABASES LIKE 'VEHICLE_ROUTING_SIMULATOR';
   SHOW DATABASES LIKE 'OVERTURE_MAPS__PLACES';
   SHOW WAREHOUSES LIKE 'ROUTING_ANALYTICS';
   ```

2. **Present** summary to user:

   | Resource | Status |
   |----------|--------|
   | Demo Database (notebooks, Streamlit) | ✅ Removed |
   | Marketplace Data (Carto POI) | ✅ Removed / ⏭️ Kept |
   | Warehouse | ✅ Removed / ⏭️ Kept |

3. **Inform user**:
   - The OpenRouteService Native App is still installed and functional
   - To remove ORS as well, run:
     ```
     use the local skill from oss-install-openrouteservice-native-app/skills/uninstall-route-optimizer
     ```
   - To redeploy the demo, run:
     ```
     use the local skill from oss-deploy-route-optimization-demo/skills/deploy-demo
     ```

**Output:** Demo uninstallation complete

## Stopping Points

- ✋ Step 1: MUST wait for user confirmation before proceeding
- ✋ Step 3: Confirm marketplace data removal preference
- ✋ Step 4: Confirm warehouse removal preference

## Common Issues

### Permission Denied
**Symptom:** "Insufficient privileges" error
**Solution:** Ensure you're using ACCOUNTADMIN role or have appropriate privileges

### Database Has Dependencies
**Symptom:** Cannot drop database
**Solution:** Use CASCADE option to remove all dependent objects

## Output

Demo resources removed:
- Demo Database: `VEHICLE_ROUTING_SIMULATOR` - Dropped (includes notebooks and Streamlit apps)
- Marketplace Data: `OVERTURE_MAPS__PLACES` - Dropped or Kept (per user choice)
- Warehouse: `ROUTING_ANALYTICS` - Dropped or Kept (per user choice)

Demo environment is now clean. OpenRouteService Native App remains installed and can be used directly or with a fresh demo deployment.
