---
name: ors-map-customization
description: "Customize OpenRouteService map region for route optimization. Use when: changing ORS map data, switching countries/regions, reconfiguring route service geography. Triggers: change ors map, customize route map, switch openrouteservice region, update ors country."
---

# OpenRouteService Map Customization

Reconfigure OpenRouteService Native App to use a different geographic region/country map.

## Prerequisites
- Active Snowflake connection with access to:
  - `OPENROUTESERVICE_SETUP` database
  - `OPENROUTESERVICE_NATIVE_APP` application
- Compute resources to download and process map data
- Services in `OPENROUTESERVICE_NATIVE_APP.CORE` schema

## Workflow

### Step 1: Setup Notebook

**Goal:** Create required Notebook

**Actions:**

1. **Execute** notebook and associated objects setup using SQL:
   ```sql
   CREATE OR REPLACE NETWORK RULE OPENROUTESERVICE_NATIVE_APP.CORE.DOWNLOAD_MAP_NETWORK_RULE
   MODE = EGRESS
   TYPE = HOST_PORT
   VALUE_LIST = ('download.geofabrik.de', 'download.bbbike.org');

   CREATE OR REPLACE EXTERNAL ACCESS INTEGRATION DOWNLOAD_MAP_ACCESS_INTEGRATION
   ALLOWED_NETWORK_RULES = (OPENROUTESERVICE_NATIVE_APP.CORE.DOWNLOAD_MAPNETWORK_RULE)
   ENABLED = TRUE;
   
   CREATE COMPUTE POOL IF NOT EXISTS OPENROUTESERVICE_NATIVE_APP_NOTEBOOK_COMPUTE_POOL
   MIN_NODES = 1
   MAX_NODES = 2
   INSTANCE_FAMILY = CPU_X64_S
   AUTO_RESUME = TRUE
   AUTO_SUSPEND_SECS = 600;

   CREATE OR REPLACE NOTEBOOK OPENROUTESERVICE_NATIVE_APP.CORE.DOWNLOAD_MAP
   FROM '@OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SPCS_STAGE'
   QUERY_WAREHOUSE = 'ROUTING_ANALYTICS' 
   RUNTIME_NAME = 'SYSTEM$BASIC_RUNTIME' 
   COMPUTE_POOL = 'OPENROUTESERVICE_NATIVE_APP_NOTEBOOK_COMPUTE_POOL' 
   MAIN_FILE = 'download_map.ipynb'
   EXTERNAL_ACCESS_INTEGRATIONS = (DOWNLOAD_MAP_ACCESS_INTEGRATION);

   ALTER NOTEBOOK OPENROUTESERVICE_NATIVE_APP.CORE.DOWNLOAD_MAP ADD LIVE VERSION FROM LAST;
   ```

**Output:** Notebook created 

### Step 2: Download Map Data

**Goal:** Execute notebook to download OSM map data for target region

**Actions:**

1. **Check** if map already exists in stage:
   ```sql
   ALTER STAGE OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SPCS_STAGE REFRESH; 
   LS @OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SPCS_STAGE;
   ```
   
   - Look for the `<MAP_NAME>` file in the stage listing
   - If map already exists, **you must ask the user** if they want to download it again
   - If user declines, skip to Step 3

2. **Execute** notebook with three parameters:
   ```sql
   EXECUTE NOTEBOOK OPENROUTESERVICE_NATIVE_APP.CORE.DOWNLOAD_MAP(
     url => '<URL>',
     map_name => '<MAP_NAME>',
     region_name => '<REGION_NAME>'
   )
   ```
   
   **Parameters:**
   - `url`: Link to download OSM map in osm.pbf format from download.geofabrik.de or download.bbbike.org
     - Example: `'https://download.geofabrik.de/europe/albania-latest.osm.pbf'`, `'https://download.geofabrik.de/north-america/us/new-york-latest.osm.pbf'`
   - `map_name`: File name of the map
     - Example: For URL aboves, use `'albania-latest.osm.pbf'`, `'new-york.osm.pbf'` do not change the capitalization 
   - `region_name`: Region name (must be consistent with map_name)
     - Example: For URL above, use `'albania'`, `'new-york'`
     - **IMPORTANT:** If user requests a specific region (e.g., "Zurich") but you decide to download a larger region (e.g., "switzerland-latest.osm.pbf"), you MUST:
       1. Check with the user that if you can download the larger region instead
       2. Use the region_name that matches the map file (e.g., `'switzerland'` not `'zurich'`)
   
   **Timeout:** Use 12000 seconds (map downloads can be large)

3. **Verify** execution succeeded

4. **Check downloaded map size** and suggest resource scaling if needed:
   - List the stage to get the map file size:
     ```sql
     LS @OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SPCS_STAGE/<REGION_NAME>/;
     ```
   - **If map size is between 1GB and 5GB**, suggest the user to scale up resources:
     - Inform the user that larger maps require more compute resources for graph building
     - Ask if they want to scale up the compute pool and extend auto-suspend which might result in excessive cost if used improperly
     - If user agrees, execute:
       ```sql
       ALTER COMPUTE POOL OPENROUTESERVICE_NATIVE_APP_COMPUTE_POOL SET INSTANCE_FAMILY = HIGHMEM_X64_M;
       ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SERVICE SET AUTO_SUSPEND_SECS = 28800;
       ```
     - The HIGHMEM_X64_M instance provides more memory for processing larger map data
     - The 8-hour auto-suspend (28800 seconds) allows sufficient time for graph building

   - **If map size is above 5GB**, suggest the user to scale up resources:
     - Inform the user that very large maps require more compute resources and significantly longer graph building time
     - Ask if they want to scale up the compute pool and extend auto-suspend which might result in excessive cost if used improperly
     - If user agrees, execute:
       ```sql
       ALTER COMPUTE POOL OPENROUTESERVICE_NATIVE_APP_COMPUTE_POOL SET INSTANCE_FAMILY = HIGHMEM_X64_M;
       ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SERVICE SET AUTO_SUSPEND_SECS = 86400;
       ```
     - The HIGHMEM_X64_M instance provides more memory for processing larger map data
     - The 24-hour auto-suspend (86400 seconds) allows sufficient time for graph building with very large maps

**Output:** Map data downloaded to stage

### Step 3: Update Configuration File

**Goal:** Modify ors-config.yml to reference new map file and configure routing profiles

**Actions:**

1. **Edit** the local configuration file at `Native_app/provider_setup/staged_files/ors-config.yml`:
   - Locate line: `source_file: /home/ors/files/{old-map}`
   - Replace with: `source_file: /home/ors/files/<MAP_NAME>`

2. **Inform user about routing profiles:** Read the `ors-config.yml` file and present the current profile configuration to the user in a table format:

   | Profile | Category | Status |
   |---------|----------|--------|
   | driving-car | Driving | Enabled/Disabled |
   | driving-hgv | Driving | Enabled/Disabled |
   | cycling-regular | Cycling | Enabled/Disabled |
   | cycling-road | Cycling | Enabled/Disabled |
   | cycling-mountain | Cycling | Enabled/Disabled |
   | cycling-electric | Cycling | Enabled/Disabled |
   | foot-walking | Foot | Enabled/Disabled |
   | foot-hiking | Foot | Enabled/Disabled |
   | wheelchair | Wheelchair | Enabled/Disabled |

3. **Ask user** if they want to enable or disable any profiles:
   - Present options: "Keep current", "Enable more", "Disable some"
   - If user chooses to modify profiles, ask which specific profiles to enable/disable
   - **Update** the `ors-config.yml` file with their selections by changing `enabled: true/false` for each profile

   **Note:** Enabling more profiles increases build time and resource usage. The default configuration (driving-car, cycling-road, foot-walking) covers most common use cases.

4. **Upload** modified file to stage:
   ```sql
   PUT file://provider_setup/staged_files/ors-config.yml @OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SPCS_STAGE/<REGION_NAME> OVERWRITE=TRUE AUTO_COMPRESS=FALSE
   ```

**Output:** Configuration updated to reference new map

### Step 4: Update Service Configuration

**Goal:** Reconfigure ORS service to point to new map region

**Actions:**

1. **Edit** the local specification file at `Native_app/services/openrouteservice/openrouteservice.yaml`:
   - Update all volume source paths to use `<REGION_NAME>`:
     - `source: "@OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SPCS_STAGE/<REGION_NAME>/"`
     - `source: "@OPENROUTESERVICE_NATIVE_APP.CORE.ORS_GRAPHS_SPCS_STAGE/<REGION_NAME>/"`
     - `source: "@OPENROUTESERVICE_NATIVE_APP.CORE.ORS_ELEVATION_CACHE_SPCS_STAGE/<REGION_NAME>/"`

2. **Upload** modified specification file to stage:
   ```sql
   PUT file:///services/openrouteservice/openrouteservice.yaml @openrouteservice_native_app_pkg.app_src.stage/services/openrouteservice/ OVERWRITE=TRUE AUTO_COMPRESS=FALSE
   ```

3. **Update** service with new specification:
   ```sql
   ALTER SERVICE IF EXISTS OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SERVICE
   FROM @openrouteservice_native_app_pkg.app_src.stage 
   SPECIFICATION_FILE='/services/openrouteservice/openrouteservice.yaml';
   ```

**Output:** Service configured for new region

### Step 5: Resume Services

**Goal:** Restart all ORS services

**Actions:**

1. **Resume** all services in parallel:
   ```sql
   ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.DOWNLOADER RESUME;
   ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SERVICE RESUME;
   ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.ROUTING_GATEWAY_SERVICE RESUME;
   ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.VROOM_SERVICE RESUME;
   ```

2. **Verify** services are resuming (status will change from SUSPENDED)

**Output:** All services active with new map configuration

### Step 6: Create Feature Branch for Customizations

**Goal:** Preserve original files on main branch, commit customizations to feature branch

**Actions:**

1. **Create** feature branch for this region:
   ```bash
   git checkout -b feature/ors-<REGION_NAME>
   ```

2. **Commit** the config file changes made in Steps 3-4:
   ```bash
   git add Native_app/provider_setup/staged_files/ors-config.yml
   git add Native_app/services/openrouteservice/openrouteservice.yaml
   git commit -m "Configure ORS for <REGION_NAME> map region"
   ```

**Output:** Feature branch created with config changes

### Step 7: Customize Function Tester Streamlit App

**Goal:** Update Function Tester with region-specific coordinates and locations

**Actions:**

1. **Read** the current function tester file at `Native_app/code_artifacts/streamlit/pages/function_tester.py`

2. **Identify** the data structures to update:
   - `SF_ADDRESSES` dict (rename to `<REGION>_ADDRESSES`) - contains start/end location presets
   - `SF_WAYPOINT_ADDRESSES` list (rename to `<REGION>_WAYPOINT_ADDRESSES`) - contains waypoint presets
   - `ROUTING_PROFILES` list - should match enabled profiles from Step 3
   - Page title and sidebar text references to "San Francisco"

3. **Generate** region-specific coordinates:
   - Research 5 popular START locations in the region (landmarks, city centers, transport hubs)
   - Research 5 popular END locations in the region (different from start locations)
   - Research 20 WAYPOINT locations spread across the region (cities, towns, points of interest)
   - Each location needs: `name`, `lat`, `lon`, `full_address`

4. **Update** the function_tester.py file:
   - Replace `SF_ADDRESSES` with `<REGION>_ADDRESSES` containing region-specific start/end locations
   - Replace `SF_WAYPOINT_ADDRESSES` with `<REGION>_WAYPOINT_ADDRESSES` containing region waypoints
   - Update `ROUTING_PROFILES` to only include profiles enabled in ors-config.yml
   - Update page title from "San Francisco Map" to "<REGION_NAME> Map"
   - Update sidebar text from "San Francisco Addresses" to "<REGION_NAME> Addresses"
   - Update all references from `SF_ADDRESSES` to `<REGION>_ADDRESSES` throughout the file
   - Update all references from `SF_WAYPOINT_ADDRESSES` to `<REGION>_WAYPOINT_ADDRESSES` throughout the file
   - Update routing profile documentation text to reflect enabled profiles

**Output:** Function tester customized for region

### Step 8: Deploy Updated Streamlit App

**Goal:** Upload customized streamlit and upgrade Native App

**Actions:**

1. **Upload** modified function_tester.py to stage:
   ```bash
   snow stage copy Native_app/code_artifacts/streamlit/pages/function_tester.py @OPENROUTESERVICE_NATIVE_APP_PKG.APP_SRC.STAGE/streamlit/pages/ --overwrite
   ```

2. **Upgrade** the Native App to use updated streamlit:
   ```sql
   ALTER APPLICATION OPENROUTESERVICE_NATIVE_APP UPGRADE USING '@OPENROUTESERVICE_NATIVE_APP_PKG.APP_SRC.STAGE';
   ```

3. **Verify** upgrade succeeded

**Output:** Native App updated with region-specific Function Tester

### Step 9: Commit Streamlit Changes to Feature Branch

**Goal:** Commit all customizations to the feature branch

**Actions:**

1. **Add and commit** the function tester changes:
   ```bash
   git add Native_app/code_artifacts/streamlit/pages/function_tester.py
   git commit -m "Customize function tester for <REGION_NAME> map region"
   ```

2. **Show** the user the commit history on the feature branch:
   ```bash
   git log --oneline -5
   ```

3. **Inform** user that:
   - Original San Francisco version remains on `main` branch
   - All <REGION_NAME> customizations are on `feature/ors-<REGION_NAME>` branch
   - To switch back to SF version: `git checkout main`
   - To return to this region: `git checkout feature/ors-<REGION_NAME>`

**Output:** All changes committed to feature branch

## Stopping Points

- ✋ After Step 2: Confirm map download completed successfully
- ✋ After Step 5: Verify services resumed without errors
- ✋ After Step 7: Confirm region-specific coordinates are accurate
- ✋ After Step 9: Verify all changes committed to feature branch

## Verification

After completion, verify:

1. **Services running:**
   ```sql
   SHOW SERVICES IN OPENROUTESERVICE_NATIVE_APP.CORE
   ```
   Status should be READY or RUNNING

2. **Map loaded:** Services should be using the new region for routing calculations

3. **Function Tester updated:** Open the Native App and verify:
   - Page title shows "<REGION_NAME> Map"
   - Start/End dropdowns show region-specific locations
   - Waypoints are relevant to the region
   - Only enabled routing profiles are available

4. **Git branches correct:**
   ```bash
   git branch
   git log --oneline main -3
   git log --oneline feature/ors-<REGION_NAME> -3
   ```
   - Main branch should have original SF configuration
   - Feature branch should have region-specific customizations

## Common Issues

**Issue:** Notebook timeout during download
- **Solution:** Increase timeout or choose smaller region

**Issue:** Service fails to start after resume
- **Solution:** Check service logs, verify stage paths exist, confirm map file is present

**Issue:** Configuration file not found
- **Solution:** Verify stage name and path are correct

## Output

OpenRouteService Native App reconfigured to use specified country/region map, with:
- All services resumed and operational
- Function Tester customized with region-specific locations
- Original SF version preserved on main branch
- All customizations committed to feature/ors-<REGION_NAME> branch
