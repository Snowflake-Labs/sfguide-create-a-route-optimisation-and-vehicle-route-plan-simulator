---
name: uninstall-retail-catchment-demo
description: "Uninstall the Retail Catchment Analysis demo including Streamlit app and database. Use when: removing retail demo, cleaning up catchment analysis, resetting demo environment. Triggers: uninstall retail, remove retail demo, cleanup catchment demo, remove retail app."
---

# Uninstall Retail Catchment Demo

Remove the Retail Catchment Analysis demo including the Streamlit app, database, and optionally the marketplace data.

> **Note:** This skill only removes the demo content. The OpenRouteService Native App remains installed.

## Configuration

- **Database:** `RETAIL_CATCHMENT_DEMO`
- **Streamlit App:** `RETAIL_CATCHMENT_APP`
- **Marketplace Data:** `OVERTURE_MAPS__PLACES`, `OVERTURE_MAPS__ADDRESSES`
- **Warehouse:** `ROUTING_ANALYTICS`

## Prerequisites

- Active Snowflake connection with ACCOUNTADMIN role
- Demo previously deployed via `deploy-demo` skill

## Workflow

### Step 1: Confirm Uninstallation

**Goal:** Verify user wants to proceed with demo removal.

**Actions:**

1. **Ask user** to confirm removal of:
   - Demo Database: `RETAIL_CATCHMENT_DEMO` (includes Streamlit app and stage)

2. **Ask user** if they also want to remove:
   - Overture Maps Places: `OVERTURE_MAPS__PLACES`
   - Overture Maps Addresses: `OVERTURE_MAPS__ADDRESSES`
   - Warehouse: `ROUTING_ANALYTICS`

**IMPORTANT:** Do NOT proceed without explicit user confirmation.

**Output:** User confirmation received

### Step 2: Drop Streamlit App

**Goal:** Remove the Streamlit application.

```sql
DROP STREAMLIT IF EXISTS RETAIL_CATCHMENT_DEMO.PUBLIC.RETAIL_CATCHMENT_APP;
```

**Verify:**
```sql
SHOW STREAMLITS LIKE 'RETAIL_CATCHMENT_APP' IN DATABASE RETAIL_CATCHMENT_DEMO;
```

**Output:** Streamlit app removed

### Step 3: Drop Demo Database

**Goal:** Remove the demo database including stage and all files.

```sql
DROP DATABASE IF EXISTS RETAIL_CATCHMENT_DEMO CASCADE;
```

**Verify:**
```sql
SHOW DATABASES LIKE 'RETAIL_CATCHMENT_DEMO';
```

**Output:** Demo database and all contents removed

### Step 4: Drop Marketplace Data (Optional)

**Goal:** Remove Overture Maps datasets if user confirmed.

**If user confirmed marketplace data removal:**

```sql
-- Remove Overture Maps Places (POI data)
DROP DATABASE IF EXISTS OVERTURE_MAPS__PLACES CASCADE;

-- Remove Overture Maps Addresses (density data)
DROP DATABASE IF EXISTS OVERTURE_MAPS__ADDRESSES CASCADE;
```

**Verify:**
```sql
SHOW DATABASES LIKE 'OVERTURE_MAPS%';
```

**Output:** Marketplace data removed (or skipped if user chose to keep)

### Step 5: Drop Warehouse (Optional)

**Goal:** Remove the compute warehouse if user confirmed.

**If user confirmed warehouse removal:**

```sql
DROP WAREHOUSE IF EXISTS ROUTING_ANALYTICS;
```

**Verify:**
```sql
SHOW WAREHOUSES LIKE 'ROUTING_ANALYTICS';
```

**Output:** Warehouse removed (or skipped if user chose to keep)

### Step 6: Verification Summary

**Goal:** Confirm all resources have been removed.

**Run verification:**
```sql
-- Should return empty results for removed resources
SHOW DATABASES LIKE 'RETAIL_CATCHMENT_DEMO';
SHOW DATABASES LIKE 'OVERTURE_MAPS__PLACES';
SHOW DATABASES LIKE 'OVERTURE_MAPS__ADDRESSES';
SHOW WAREHOUSES LIKE 'ROUTING_ANALYTICS';
```

**Present summary to user:**

| Resource | Status |
|----------|--------|
| Demo Database (Streamlit, stage) | ✅ Removed |
| Overture Maps Places | ✅ Removed / ⏭️ Kept |
| Overture Maps Addresses | ✅ Removed / ⏭️ Kept |
| Warehouse | ✅ Removed / ⏭️ Kept |

**Inform user:**
- The OpenRouteService Native App is still installed and functional
- To remove ORS as well, run:
  ```
  use the local skill from oss-install-openrouteservice-native-app/skills/uninstall-route-optimizer
  ```
- To redeploy the demo, run:
  ```
  use the local skill from oss-retail-catchment-overture-maps/skills/deploy-demo
  ```

**Output:** Demo uninstallation complete

## Stopping Points

- ✋ Step 1: MUST wait for user confirmation before proceeding
- ✋ Step 4: Confirm marketplace data removal preference
- ✋ Step 5: Confirm warehouse removal preference

## Common Issues

### Permission Denied
**Symptom:** "Insufficient privileges" error
**Solution:** Ensure you're using ACCOUNTADMIN role or have appropriate privileges

### Database Has Dependencies
**Symptom:** Cannot drop database
**Solution:** Use CASCADE option to remove all dependent objects

### Streamlit App in Use
**Symptom:** Cannot drop Streamlit
**Solution:** Close any open sessions of the app before dropping

## Output

Demo resources removed:
- Streamlit App: `RETAIL_CATCHMENT_APP` - Dropped
- Database: `RETAIL_CATCHMENT_DEMO` - Dropped (includes stage)
- Marketplace Data: `OVERTURE_MAPS__PLACES`, `OVERTURE_MAPS__ADDRESSES` - Dropped or Kept
- Warehouse: `ROUTING_ANALYTICS` - Dropped or Kept

Demo environment is now clean. OpenRouteService Native App remains installed.
