---
name: routing-profiles
description: "Enable or disable ORS routing profiles (driving-car, driving-hgv, cycling, walking, wheelchair). Subskill of routing-customization — must be invoked from the router, not independently. Use when: changing vehicle types as part of customization workflow. Do NOT use for: standalone execution, changing map region, or deploying demo apps. Triggers: change routing profile, change vehicle type, enable profile, disable profile."
metadata:
  author: Snowflake SIT-IS
  version: 1.0.0
  category: configuration
---

# Customize Routing Profiles

> **WARNING: This subskill cannot be run independently.** It must be invoked from the `routing-customization` router. It only updates the config file -- it does NOT restart services or rebuild routing graphs. The router handles service restarts, graph rebuilding, MAP_CONFIG updates, and Function Tester redeployment in Steps 4-6 after this subskill completes.

Configure which routing profiles are available in your Routing Solution.

## Prerequisites

- Active Snowflake connection
- OpenRouteService Native App deployed

## Input Parameters

- `<REGION_NAME>`: Target region name selected by user (e.g., "great-britain", "switzerland", "new-york")

## Available Profiles

| Profile | Category | Description |
|---------|----------|-------------|
| `driving-car` | Driving | Standard passenger vehicles |
| `driving-hgv` | Driving | Heavy goods vehicles (trucks) |
| `cycling-regular` | Cycling | Standard bicycles |
| `cycling-road` | Cycling | Road/racing bicycles |
| `cycling-mountain` | Cycling | Mountain bikes |
| `cycling-electric` | Cycling | Electric bicycles |
| `foot-walking` | Foot | Standard walking |
| `foot-hiking` | Foot | Hiking trails |
| `wheelchair` | Wheelchair | Wheelchair accessible routes |

## Workflow

### Step 1: Get User Preferences

**Goal:** Determine which profiles to enable/disable

**Actions:**

1. **Ask user** what changes they want:
   - "Which profiles do you want to ENABLE?" (list any currently disabled)
   - "Which profiles do you want to DISABLE?" (list any currently enabled)

2. **Warn about resource impact:**
   - More profiles = longer graph build time
   - More profiles = more memory usage
   - Default (car, cycling-road, walking) covers most use cases

**Output:** User selections recorded

### Step 2: Update Configuration

**Goal:** Modify ors-config.yml with new profile settings

**Actions:**

1. **Edit** `build-routing-solution/Native_app/provider_setup/staged_files/ors-config.yml`:
   - For each profile, set `enabled: true` or `enabled: false`
   
   Example structure:
   ```yaml
   ors:
     engine:
       profiles:
         driving-car:
           enabled: true
         driving-hgv:
           enabled: false
         cycling-regular:
           enabled: false
         cycling-road:
           enabled: true
         cycling-mountain:
           enabled: false
         cycling-electric:
           enabled: false
         foot-walking:
           enabled: true
         foot-hiking:
           enabled: false
         wheelchair:
           enabled: false
   ```

2. **Upload** modified file:
   ```bash
   snow stage copy build-routing-solution/Native_app/provider_setup/staged_files/ors-config.yml @OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SPCS_STAGE/<REGION_NAME>/ --connection <ACTIVE_CONNECTION> --overwrite
   ```

**Output:** Configuration updated with new profiles

## Return to Router

After completing all steps in this subskill, return to the **routing-customization** router and continue from **Step 4: Update Routing Graphs**. This subskill does NOT restart services or rebuild graphs -- the router handles that.

## Error Handling

| Issue | Solution |
|-------|----------|
| Config file not found locally | Re-download from stage: `snow stage copy @OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SPCS_STAGE/<REGION_NAME>/ors-config.yml build-routing-solution/Native_app/provider_setup/staged_files/ --connection <ACTIVE_CONNECTION> --overwrite` |
| Stage upload fails | Verify WRITE privilege on stage and correct `--connection` value |
| Profile name typo | Use exact names from Available Profiles table above |

## Stopping Points

- ✋ After Step 1: Confirm user selections before modifying config
