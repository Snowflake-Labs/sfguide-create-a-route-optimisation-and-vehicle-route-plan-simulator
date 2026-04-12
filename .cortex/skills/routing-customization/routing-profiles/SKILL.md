---
name: routing-profiles
description: "Enable or disable ORS routing profiles (driving-car, driving-hgv, cycling, walking, wheelchair). Subskill of routing-customization — must be invoked from the router, not independently. Use when: changing vehicle types as part of customization workflow. Do NOT use for: standalone execution, changing map region, or deploying demo apps. Triggers: change routing profile, change vehicle type, enable profile, disable profile."
metadata:
  author: Snowflake SIT-IS
  version: 1.1.0
  category: configuration
---

# Customize Routing Profiles

> **WARNING: This subskill cannot be run independently.** It must be invoked from the `routing-customization` router. It only updates the config file -- it does NOT restart services or rebuild routing graphs. The router handles service restarts, graph rebuilding, MAP_CONFIG updates, and Function Tester redeployment in Steps 4-6 after this subskill completes.

Configure which routing profiles are available in your Routing Solution.

## Prerequisites

- Active Snowflake connection
- OpenRouteService Native App deployed

## Input Parameters

- `<REGION_NAME>`: Target region name selected by user (e.g., "SanFrancisco", "NewYork", "London")

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

## Error Logging

When any step fails or produces unexpected results, log the issue to `logs/` following the format in `logs/README.md`. Create one log file per execution: `routing-customization_{YYYY-MM-DD}_{HH-MM}.md`. Continue execution where possible, logging all issues encountered. If execution completes with no issues, do not create a log file.

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
   - Default (car, cycling-electric, hgv) covers most use cases

**Output:** User selections recorded

### Step 2: Update Configuration

**Goal:** Write new ors-config.yml to the region's stage using the `WRITE_ORS_CONFIG` stored procedure

**Actions:**

**Option A — For new cities provisioned via the Cities tab UI:**
Profile selection is built into the RegionBuilder UI. Users select routing profile checkboxes before clicking Deploy. No manual config editing needed.

**Option B — For the default (San Francisco) instance or existing cities:**

1. **Determine the PBF filename** for the region (e.g., `SanFrancisco.osm.pbf`)

2. **Call the WRITE_ORS_CONFIG procedure** to generate and upload the config:
   ```sql
   CALL OPENROUTESERVICE_NATIVE_APP.CORE.WRITE_ORS_CONFIG(
       '<REGION_NAME>',
       '<PBF_FILENAME>',
       'driving-car,driving-hgv,cycling-electric'  -- comma-separated list of profiles to ENABLE
   );
   ```
   
   This generates a complete `ors-config.yml` with only the specified profiles enabled and uploads it to `@CORE.ORS_SPCS_STAGE/<REGION_NAME>/ors-config.yml`.

**Option C — Manual editing (fallback):**

1. **Edit** `.cortex/skills/build-routing-solution/native_app/provider_setup/staged_files/ors-config.yml`:
   - For each profile, set `enabled: true` or `enabled: false`
   - Update `source_file` to match the region's PBF filename

2. **Upload** modified file:
   ```bash
   snow stage copy .cortex/skills/build-routing-solution/native_app/provider_setup/staged_files/ors-config.yml @OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SPCS_STAGE/<REGION_NAME>/ --connection <ACTIVE_CONNECTION> --overwrite
   ```

**Output:** Configuration updated with new profiles

## Return to Router

After completing all steps in this subskill, return to the **routing-customization** router and continue from **Step 4: Update Routing Graphs**. This subskill does NOT restart services or rebuild graphs -- the router handles that.

## Error Handling

| Issue | Solution |
|-------|----------|
| `WRITE_ORS_CONFIG` not found | App needs upgrade. Upload latest `setup_script.sql` and run `ALTER APPLICATION ... UPGRADE` |
| Config file not found locally | Re-download from stage: `snow stage copy @OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SPCS_STAGE/<REGION_NAME>/ors-config.yml .cortex/skills/build-routing-solution/native_app/provider_setup/staged_files/ --connection <ACTIVE_CONNECTION> --overwrite` |
| Stage upload fails | Verify WRITE privilege on stage and correct `--connection` value |
| Profile name typo | Use exact names from Available Profiles table above |

## Stopping Points

- ✋ After Step 1: Confirm user selections before modifying config
