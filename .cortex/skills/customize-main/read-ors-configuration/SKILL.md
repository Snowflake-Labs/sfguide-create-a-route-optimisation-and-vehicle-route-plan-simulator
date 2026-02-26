---
name: read-ors-configuration
description: "read current Openrouteservice/Routing Solution/Routing Simulator configuration (region and routing profiles) and displays them to the user. Helps to answer questions like: What are current settings? What is the current map? What is the current location? What are the current vehicle types? What are current routing profiles? Triggers: ors configuration, openrouteservice config, routing simulator configuration"
---

# Read ORS Configuration

Detects the map region/location and routing profiles from the ORS configuration and displays them to the user.

## Prerequisites

- Active Snowflake connection
- OpenRouteService Native App deployed

## Output Parameters

- `<REGION_NAME>`: The configured region name
- `<ENABLED_PROFILES>`: List of enabled vehicle profiles

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
   snow stage copy @OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SPCS_STAGE/<REGION_NAME>/ors-config.yml oss-build-routing-solution-in-snowflake/Native_app/provider_setup/staged_files/ --connection <ACTIVE_CONNECTION> --overwrite
   ```

2. **Read** `oss-build-routing-solution-in-snowflake/Native_app/provider_setup/staged_files/ors-config.yml`

3. **Parse** the downloaded file for `profiles:` entries with `enabled: true`
   - Common profiles: `driving-car`, `driving-hgv`, `cycling-road`, `cycling-regular`, `foot-walking`

**Output:** `<ENABLED_PROFILES>` extracted

### Step 3: Display Configuration to User

**Goal:** Present the current ORS configuration

**Actions:**

1. **Display** the following to the user:
   - Configured Map Region: `<REGION_NAME>`
   - Configured Vehicle profiles: `<ENABLED_PROFILES>`

**Output:** ORS configuration displayed to the user