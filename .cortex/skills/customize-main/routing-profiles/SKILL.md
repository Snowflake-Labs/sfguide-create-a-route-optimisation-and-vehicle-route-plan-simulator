---
name: routing-profiles
description: "Change the Routing Solution routing profiles/vehicle types. To be used as part of customize-main skill"
---

# Customize Routing Profiles

Configure which routing profiles are available in your Routing Solution.

## Prerequisites

- Active Snowflake connection
- OpenRouteService Native App deployed

## Input Parameters

- `<REGION_NAME>`: Target region name (e.g., "great-britain", "switzerland", "new-york")

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

1. **Edit** `oss-build-routing-solution-in-snowflake/Native_app/provider_setup/staged_files/ors-config.yml`:
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
   ```sql
   PUT file://oss-build-routing-solution-in-snowflake/Native_app/provider_setup/staged_files/ors-config.yml @OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SPCS_STAGE/<REGION_NAME> OVERWRITE=TRUE AUTO_COMPRESS=FALSE
   ```

**Output:** Configuration updated with new profiles

## Stopping Points

- ✋ After Step 1: Confirm user selections before modifying config
