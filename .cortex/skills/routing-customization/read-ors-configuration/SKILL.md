---
name: read-ors-configuration
description: "Subskill of routing-customization. Read current OpenRouteService configuration (region and routing profiles) and display to the user. Use when: checking current ORS settings, verifying map region, listing enabled vehicle profiles. Do NOT use for: changing configuration (use routing-customization), deploying demos, or building ORS from scratch. Triggers: ors configuration, openrouteservice config, routing simulator configuration, current map, current location, current vehicle types, current routing profiles."
metadata:
  author: Snowflake SIT-IS
  version: 1.0.0
  category: configuration
---

# Read ORS Configuration

Detects the map region/location and routing profiles from the ORS configuration and displays them to the user.

## Prerequisites

- Active Snowflake connection
- OpenRouteService Native App deployed

## Output Parameters

- `<REGION_NAME>`: The configured region name
- `<ENABLED_PROFILES>`: List of enabled vehicle profiles

## Error Logging

When any step fails or produces unexpected results, log the issue to `logs/` following the format in `logs/README.md`. Create one log file per execution: `routing-customization_{YYYY-MM-DD}_{HH-MM}.md`. Continue execution where possible, logging all issues encountered. If execution completes with no issues, do not create a log file.

## Workflow

### Step 1: Extract Region Name from Service Definition

**Goal:** Determine the currently configured map region

**Actions:**

1. **Describe** the ORS service to get the service spec:
   ```sql
   DESCRIBE SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SERVICE;
   ```
   - Parse the service spec from the output to find the configured `<REGION_NAME>` for the service: `/home/ors/files/<REGION_NAME>.osm.pbf`
   - Extract `<REGION_NAME>` (e.g., "SanFrancisco", "great-britain-latest", "paris")

**Output:** `<REGION_NAME>` extracted

### Step 2: Extract Enabled Routing Profiles

**Goal:** Determine which vehicle profiles are currently enabled

**Actions:**

1. **Download** the ORS config file from stage:
   ```bash
   snow stage copy @OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SPCS_STAGE/<REGION_NAME>/ors-config.yml .cortex/skills/build-routing-solution/native_app/provider_setup/staged_files/ --connection <ACTIVE_CONNECTION> --overwrite
   ```

2. **Read** `.cortex/skills/build-routing-solution/native_app/provider_setup/staged_files/ors-config.yml`

3. **Parse** the downloaded file for `profiles:` entries with `enabled: true`
   - Common profiles: `driving-car`, `driving-hgv`, `cycling-electric`, `cycling-regular`, `foot-walking`

**Output:** `<ENABLED_PROFILES>` extracted

### Step 3: Display Configuration to User

**Goal:** Present the current ORS configuration

**Actions:**

1. **Display** the following to the user:
   - Configured Map Region: `<REGION_NAME>`
   - Configured Vehicle profiles: `<ENABLED_PROFILES>`

**Output:** ORS configuration displayed to the user

## Stopping Points

- ✋ After Step 1: Verify DESCRIBE SERVICE returned a valid spec before downloading config
- ✋ After Step 2: Confirm config file was downloaded and profiles parsed correctly

## Error Handling

| Issue | Solution |
|-------|----------|
| DESCRIBE SERVICE fails | ORS Native App not installed or service not created. Install via `build-routing-solution` skill |
| Config file download fails | Service may be running with default config. Check stage path matches `<REGION_NAME>` from Step 1 |
| No profiles found in config | Config file may be malformed. Check `ors.engine.profiles` section exists in the YAML |