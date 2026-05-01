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
- OpenRouteService App deployed

## Output Parameters

- `<REGION_NAME>`: The configured region name
- `<ENABLED_PROFILES>`: List of enabled vehicle profiles

## Error Logging

> Follow the Error Logging convention in AGENTS.md. Log file prefix: `routing-customization`.

## Workflow

### Step 1: Extract Region Name from Service Definition

**Goal:** Determine the currently configured map region

**Actions:**

1. **Describe** the ORS service to get the service spec:
   ```sql
   DESCRIBE SERVICE OPENROUTESERVICE_APP.CORE.ORS_SERVICE;
   ```
   - Parse the service spec from the output to find the configured `<REGION_NAME>` for the service: `/home/ors/files/<REGION_NAME>.osm.pbf`
   - Extract `<REGION_NAME>` (e.g., "SanFrancisco", "great-britain-latest", "paris")

**Output:** `<REGION_NAME>` extracted

### Step 2: Extract Enabled Routing Profiles

**Goal:** Determine which vehicle profiles are currently enabled

**Actions:**

1. **Download** the ORS config file from stage:

   **If using Snow CLI (local environment):**
   ```bash
   snow stage copy @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/<REGION_NAME>/ors-config.yml .cortex/skills/build-routing-solution/openrouteservice_app/staged_files/ --connection <ACTIVE_CONNECTION> --overwrite
   ```

   **If using Snowflake Workspace:** Use SQL to read from stage:
   ```sql
   SELECT $1 AS config_content 
   FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/<REGION_NAME>/ors-config.yml
   (FILE_FORMAT => 'OPENROUTESERVICE_APP.CORE.TEXT_FILE_FORMAT');
   ```
   (Create text file format if needed: `CREATE FILE FORMAT IF NOT EXISTS TEXT_FILE_FORMAT TYPE = 'CSV' FIELD_DELIMITER = NONE RECORD_DELIMITER = NONE;`)

2. **Read** the config content (file or query result)

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
| DESCRIBE SERVICE fails | ORS App not installed or service not created. Install via `build-routing-solution` skill |
| Config file download fails | Service may be running with default config. Check stage path matches `<REGION_NAME>` from Step 1 |
| No profiles found in config | Config file may be malformed. Check `ors.engine.profiles` section exists in the YAML |