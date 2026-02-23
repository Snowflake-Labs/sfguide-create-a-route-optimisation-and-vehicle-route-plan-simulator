---
name: customize-profiles
description: "Configure routing profiles. Use when: enabling/disabling routing profiles like car, truck, bicycle, walking, wheelchair. Triggers: customize vehicles, change profiles, add walking, remove truck."
---

# Customize Routing Profiles

Configure which vehicle routing profiles are available in your OpenRouteService deployment.

## Prerequisites

- Active Snowflake connection
- OpenRouteService Native App deployed
- Access to `Native_app/provider_setup/staged_files/ors-config.yml`

## Input Parameters

- `<REGION_NAME>`: Current region name (for stage path)

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

### Step 1: Review Current Configuration

**Goal:** Show user current profile settings

**Actions:**

1. **Read** `Native_app/provider_setup/staged_files/ors-config.yml`

2. **Present** current configuration in table format:

   | Profile | Status |
   |---------|--------|
   | driving-car | Enabled/Disabled |
   | driving-hgv | Enabled/Disabled |
   | cycling-regular | Enabled/Disabled |
   | cycling-road | Enabled/Disabled |
   | cycling-mountain | Enabled/Disabled |
   | cycling-electric | Enabled/Disabled |
   | foot-walking | Enabled/Disabled |
   | foot-hiking | Enabled/Disabled |
   | wheelchair | Enabled/Disabled |

**Output:** User understands current profile configuration

### Step 2: Get User Preferences

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

### Step 3: Update Configuration

**Goal:** Modify ors-config.yml with new profile settings

**Actions:**

1. **Edit** `Native_app/provider_setup/staged_files/ors-config.yml`:
   - For each profile, set `enabled: true` or `enabled: false`
   
   Example structure:
   ```yaml
   ors:
     engine:
       profiles:
         car:
           enabled: true
         hgv:
           enabled: false
         cycling-regular:
           enabled: false
         cycling-road:
           enabled: true
         cycling-mountain:
           enabled: false
         cycling-electric:
           enabled: false
         walking:
           enabled: true
         hiking:
           enabled: false
         wheelchair:
           enabled: false
   ```

2. **Upload** modified file:
   ```sql
   PUT file://provider_setup/staged_files/ors-config.yml @OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SPCS_STAGE/<REGION_NAME> OVERWRITE=TRUE AUTO_COMPRESS=FALSE
   ```

**Output:** Configuration updated with new profiles

### Step 4: Rebuild Graphs

**Goal:** Restart services to rebuild routing graphs with new profiles

**Actions:**

1. **Resume** services to trigger graph rebuild:
   ```sql
   ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SERVICE RESUME;
   ```

2. **Inform user** about rebuild time:
   - Each profile adds to build time
   - Larger maps take longer per profile
   - Monitor service logs for progress

**Output:** Services rebuilding with new profiles

### Step 5: Update Dependent Components

**Goal:** Inform user about components that need updating

**Actions:**

1. **Inform user** that the following should be updated to match:
   - **Function Tester** (`streamlits.md`): Update ROUTING_PROFILES list
   - **Simulator** (`streamlits.md`): Update available vehicle options

2. **Suggest** running `streamlits.md` to update Streamlit apps

**Output:** User informed about dependent updates

## Common Profile Combinations

| Use Case | Recommended Profiles |
|----------|---------------------|
| Delivery (urban) | driving-car, cycling-road, foot-walking |
| Logistics (freight) | driving-car, driving-hgv |
| Active transport | cycling-regular, cycling-electric, foot-walking |
| Accessibility | driving-car, foot-walking, wheelchair |
| Full coverage | All profiles (long build time) |

## Stopping Points

- ✋ After Step 2: Confirm user selections before modifying config
- ✋ After Step 4: Verify services are rebuilding

## Output

Vehicle routing profiles updated. Services rebuilding graphs with new profile configuration.
