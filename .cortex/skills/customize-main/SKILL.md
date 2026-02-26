---
name: customize-main
description: "Route customization requests to the correct subskills. Use when: changing location, changing map, changing vehicle Triggers: change location, change map, change vehicle, change routing profile"
---

# Customization Router

This skill routes customization requests to the correct subskills based on what you want to customize.

## Workflow

### Step 1: Read Current ORS Configuration and Gather Customization Options

**Goal:** Detect the current map region and routing profiles from the ORS configuration and display to the user

**Actions:**

1. **Extract** the current ORS configuration from the service definition:
   ```sql
   DESCRIBE SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SERVICE;
   ```
   - Parse the service spec from the output to find the configured '<INITIAL_REGION_NAME>' for the service: `/home/ors/files/<INITIAL_REGION_NAME>.osm.pbf`
   - Extract `<INITIAL_REGION_NAME>` (e.g., "SanFrancisco", "great-britain-latest", "paris")

2. **Extract** the enabled vehicle profiles from the config file in stage `@OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SPCS_STAGE/<INITIAL_REGION_NAME>/ors-config.yml`

   ```bash
   rm -f /tmp/ors-config.yml && snow stage copy @OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SPCS_STAGE/<INITIAL_REGION_NAME>/ors-config.yml /tmp/ --connection <ACTIVE_CONNECTION>
   ```
   Then read `/tmp/ors-config.yml`. Always delete before downloading to prevent reading stale files from previous sessions.

   - Parse the downloaded file for `profiles:` entries with `enabled: true`
   - Common profiles: `driving-car`, `driving-hgv`, `cycling-road`, `cycling-regular`, `foot-walking`
   - This determines `<INITIAL_PROFILES>` for the demo

3. **Store configuration for later steps:**
   - `<INITIAL_REGION_NAME>`: The initially configured region name
   - `<INITIAL_PROFILES>`: List of initially enabled vehicle profiles

**Output:** Current ORS configuration displayed to the user:
- Initially configured Map Region: `<INITIAL_REGION_NAME>`
- Initially configured Vehicle profiles: `<INITIAL_PROFILES>`

### Step 2: Determine What to Customize

**Ask the user (allow multiple selections):**

"What would you like to customize? Multiple selection is allowed."

1. **Location/Map** - Change the geographic region (e.g., San Francisco → Paris)
2. **Routing Profiles** - Enable/disable routing profiles (driving-car, foot-walking, cycling-road)

**IMPORTANT:** Use multi-select so the user can choose one or both options. If both are selected, run the location skill first, then the routing profiles skill, before proceeding to Step 4.

### Step 3: Route to Correct Skill

**If user wants to change LOCATION or MAP:**

> This requires changing a map. 
> Read and follow the instructions in `.cortex/skills/customize-main/location/SKILL.md`

**If user wants to change ROUTING PROFILES:**

> This updates which routing profiles are available.
> Read and follow the instructions in `.cortex/skills/customize-main/routing-profiles/SKILL.md`

### Step 4: Update Routing Graphs

**Goal:** Restart services to update routing graphs with new location

**Actions:**

1. **Determine if this is a new region or an existing region re-download:**

   - **New region** (no prior graphs exist): Skip the REMOVE commands and proceed directly to resuming services. The graphs stage paths won't exist yet.
   
   - **Existing region re-download** (map existed and user selected to re-download): Ask the user:
     - "Do you want to rebuild the routing graphs for this region? This will clear existing cached graphs and elevation data, forcing a fresh rebuild."

2. **If existing region and user confirms YES**, clear existing graphs and elevation cache:
   ```sql
   REMOVE @OPENROUTESERVICE_NATIVE_APP.CORE.ORS_ELEVATION_CACHE_SPCS_STAGE/<REGION_NAME>/;
   REMOVE @OPENROUTESERVICE_NATIVE_APP.CORE.ORS_GRAPHS_SPCS_STAGE/<REGION_NAME>/;
   ```
   
   > **_NOTE:_** This ensures graphs are rebuilt from scratch with the new map data rather than using potentially stale cached data.

3. **Resume** the compute pool (required if it was suspended during location change):
   ```sql
   ALTER COMPUTE POOL OPENROUTESERVICE_NATIVE_APP_COMPUTE_POOL RESUME;
   ```

4. **Resume** all services:
   ```sql
   ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.DOWNLOADER RESUME;
   ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SERVICE RESUME;
   ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.ROUTING_GATEWAY_SERVICE RESUME;
   ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.VROOM_SERVICE RESUME;
   ```

5. **Verify** services are running:
   ```sql
   SHOW SERVICES IN OPENROUTESERVICE_NATIVE_APP.CORE;
   ```

6. **Monitor** ORS_SERVICE logs for graph building progress:
   ```sql
   CALL SYSTEM$GET_SERVICE_LOGS('OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SERVICE', 0, 'ors', 100);
   ```
   - Look for: `"Graph built in X seconds"` messages for each enabled profile

**Note:** Graph building can take 30 minutes to several hours depending on map size and number of enabled profiles.

**Output:** Services rebuilding with new map

### Step 5: Update MAP_CONFIG Table

**Goal:** Store map configuration so Function Tester can dynamically load settings

**Actions:**

1. **Clear** any existing configuration:
   ```sql
   DELETE FROM OPENROUTESERVICE_NATIVE_APP.CORE.MAP_CONFIG;
   ```

2. **Insert** the new map configuration:
   ```sql
   INSERT INTO OPENROUTESERVICE_NATIVE_APP.CORE.MAP_CONFIG 
   (city_name, center_lat, center_lon, min_lat, max_lat, min_lon, max_lon, osm_file_name)
   VALUES ('<CITY_NAME>', <CENTER_LAT>, <CENTER_LON>, <MIN_LAT>, <MAX_LAT>, <MIN_LON>, <MAX_LON>, '<MAP_NAME>');
   ```
   
   **Example for Paris:**
   ```sql
   INSERT INTO OPENROUTESERVICE_NATIVE_APP.CORE.MAP_CONFIG 
   (city_name, center_lat, center_lon, min_lat, max_lat, min_lon, max_lon, osm_file_name)
   VALUES ('Paris', 48.8566, 2.3522, 48.80, 48.92, 2.22, 2.42, 'Paris.osm.pbf');
   ```
   
   **Example for Berlin:**
   ```sql
   INSERT INTO OPENROUTESERVICE_NATIVE_APP.CORE.MAP_CONFIG 
   (city_name, center_lat, center_lon, min_lat, max_lat, min_lon, max_lon, osm_file_name)
   VALUES ('Berlin', 52.5200, 13.4050, 52.35, 52.70, 13.08, 13.77, 'Berlin.osm.pbf');
   ```

3. **Verify** the configuration was saved:
   ```sql
   SELECT * FROM OPENROUTESERVICE_NATIVE_APP.CORE.MAP_CONFIG;
   ```

**Note:** The Function Tester will automatically generate test addresses within these bounds when it loads. If no MAP_CONFIG entry exists, it defaults to San Francisco.

**Output:** MAP_CONFIG table updated with new region bounds

### Step 6: Redeploy Function Tester

**Goal:** Upload and redeploy the Function Tester so it picks up the new MAP_CONFIG

**Note:** The Function Tester automatically reads the MAP_CONFIG table (updated in Step 4) and dynamically generates region-specific sample addresses within those bounds. No manual code edits are needed — just redeploy.

**Actions:**

1. **Upload** Function Tester to stage:
   ```bash
   snow stage copy oss-build-routing-solution-in-snowflake/Native_app/code_artifacts/streamlit/pages/function_tester.py \
     @OPENROUTESERVICE_NATIVE_APP_PKG.APP_SRC.STAGE/streamlit/pages/ --overwrite
   ```

2. **Upgrade** the Native App to apply changes:
   ```sql
   ALTER APPLICATION OPENROUTESERVICE_NATIVE_APP UPGRADE USING '@OPENROUTESERVICE_NATIVE_APP_PKG.APP_SRC.STAGE';
   ```

**Output:** Function Tester redeployed, now showing addresses for the new region

## Stopping Points

- ✋ After Step 3: Confirm map download completed
- ✋ After Step 4: Verify services are rebuilding graphs
- ✋ After Step 5: Verify MAP_CONFIG table has correct bounds
- ✋ After Step 6: Verify Function Tester shows new region addresses