---
name: ors-map-customization
description: "Customize OpenRouteService map region and industry categories for route optimization. Use when: changing ORS map data, switching countries/regions, reconfiguring route service geography, customizing industry categories. Triggers: change ors map, customize route map, switch openrouteservice region, update ors country, customize industries."
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

### Step 6: Customize Function Tester Streamlit App

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

### Step 7: Customize Routing Functions AISQL Notebook

**Goal:** Update the routing_functions_aisql.ipynb notebook to use region-specific locations for AI-generated data

**Actions:**

1. **Determine notebook location scope:**
   
   The notebook generates sample data (restaurants, customers, delivery jobs) using AI. For practical route optimization demos, all generated locations must be within a drivable area (typically a single city or metro area).
   
   **If the map region is country-wide or state-wide** (e.g., "great-britain", "switzerland", "germany", "california"):
   - Ask the user which major city within that region to use for the notebook's sample data
   - Example: For "great-britain" map, ask: "Which city should the notebook use for sample data? (e.g., London, Manchester, Birmingham)"
   - Use the chosen city name (referred to as `<NOTEBOOK_CITY>`) in all AI prompts
   
   **If the map region is already city-level** (e.g., "new-york", "london", "zurich"):
   - Use the region name directly as `<NOTEBOOK_CITY>`

2. **Read** the notebook file at `Notebook/routing_functions_aisql.ipynb`

3. **Identify** the location-specific AI prompts that need updating. These cells use AI_COMPLETE to generate sample data:

   | Cell Name | Current Location Reference | What to Change |
   |-----------|---------------------------|----------------|
   | `simple_directions_data` | "Mission District", "Financial District", "SAN FRANCISCO" | Change to two distinct areas within <NOTEBOOK_CITY> |
   | `ten_random` | "San Francisco" restaurants | Change to "<NOTEBOOK_CITY>" restaurants |
   | `gen_supplier` | "San Francisco" food supplier | Change to "<NOTEBOOK_CITY>" food supplier |
   | `one_vehicle_optimisation` | "San Francisco" deliveries | Change to "<NOTEBOOK_CITY>" deliveries |
   | `service_these_people` | "San Francisco" residential locations | Change to "<NOTEBOOK_CITY>" residential locations |
   | `takeawaydeliveries` | "San Francisco" takeaway deliveries | Change to "<NOTEBOOK_CITY>" takeaway deliveries |
   | `geocode_summit_address` | "450 Concar Dr, San Mateo, CA" (Snowflake HQ) | Change to a notable address in <NOTEBOOK_CITY> (e.g., Snowflake office or landmark) |
   | `isochrones_try` | Same SF Snowflake office | Same address as above |

4. **Update** each cell's AI prompt by replacing location references:
   
   **simple_directions_data cell:**
   - Change `'Return 1 hotel in the Mission District and 1 restaurant in the Financial District IN SAN FRANCISCO.'`
   - To: `'Return 1 hotel in <DISTRICT_1> and 1 restaurant in <DISTRICT_2> IN <NOTEBOOK_CITY>.'`
   - Where `<DISTRICT_1>` and `<DISTRICT_2>` are two distinct areas within the city (research appropriate districts)

   **ten_random cell:**
   - Change `'Return 10 restaurants in San Francisco.'`
   - To: `'Return 10 restaurants in <NOTEBOOK_CITY>.'`

   **gen_supplier cell:**
   - Change `'give me a location in San Francisco that sells food to restaurants.'`
   - To: `'give me a location in <NOTEBOOK_CITY> that sells food to restaurants.'`

   **one_vehicle_optimisation cell:**
   - Change `'Return 10 delivery jobs with 1 available vehicle in San Francisco.'`
   - To: `'Return 10 delivery jobs with 1 available vehicle in <NOTEBOOK_CITY>.'`

   **service_these_people cell:**
   - Change `'give me 40 random residential locations in San Francisco'`
   - To: `'give me 40 random residential locations in <NOTEBOOK_CITY>'`

   **takeawaydeliveries cell:**
   - Change `'in San Francisco based on the following template'`
   - To: `'in <NOTEBOOK_CITY> based on the following template'`

   **geocode_summit_address and isochrones_try cells:**
   - Change the Snowflake office address to a notable location in <NOTEBOOK_CITY>
   - Research the Snowflake office address in the city, or use a well-known landmark

5. **Update** markdown descriptions in the notebook:
   - Cell `heading_simple_directions`: Change "San Francisco" to "<NOTEBOOK_CITY>"
   - Cell `create_synthetic_jobs_and_vehicle`: Change "San Francisco" to "<NOTEBOOK_CITY>"
   - Cell `head_multi_vehicles`: Change "San Francisco" to "<NOTEBOOK_CITY>"
   - Cell `optimal_base_table`: Change "SAN FRANCISCO" to "<NOTEBOOK_CITY>" in the heading

**Output:** Notebook customized for city-specific AI data generation (using <NOTEBOOK_CITY> within the <REGION_NAME> map)

### Step 8: Customize Add Carto Data Notebook

**Goal:** Update the add_carto_data.ipynb notebook to load POI data for the chosen region

**Actions:**

1. **Use the same `<NOTEBOOK_CITY>` determined in Step 8:**
   - If a country/state-wide region was selected, use the major city chosen in Step 8
   - If a city-level region was selected, use that city name

2. **Determine the geohash for `<NOTEBOOK_CITY>`:**
   - Execute the following SQL to find the geohash (precision 2) for the city:
     ```sql
     SELECT ST_GEOHASH(ST_MAKEPOINT(<CITY_LONGITUDE>, <CITY_LATITUDE>), 2) as geohash;
     ```
   - Common geohash examples:
     - San Francisco: `9q`
     - New York: `dr`
     - London: `gc`
     - Paris: `u0`
     - Berlin: `u3`
     - Tokyo: `xn`
     - Sydney: `r3`

3. **Read** the notebook file at `Notebook/add_carto_data.ipynb`

4. **Update** the `add_carto_data` cell:
   - Change the geohash filter from current value to `<GEOHASH>`
   - The cell creates `DATA.REGION_DATA` table from Carto Overture Maps data
   
   **Before:**
   ```sql
   WHERE ST_GEOHASH(GEOMETRY,2) = '9q';
   ```
   
   **After:**
   ```sql
   WHERE ST_GEOHASH(GEOMETRY,2) = '<GEOHASH>';
   ```

5. **Update** the `prompt_multi_layer_isochrone` cell:
   - Change city references in the AI prompt from "San Francisco" to `<NOTEBOOK_CITY>`
   
   **Lines to update:**
   - `"size the points so they pinpoint hotels on a map easily within the city of San Francisco."` → `"size the points so they pinpoint hotels on a map easily within the city of <NOTEBOOK_CITY>."`
   - `"Snowflake World Tour Event in San Francisco 2025"` → `"Snowflake World Tour Event in <NOTEBOOK_CITY> 2025"`

6. **Update** the Streamlit app default location at `Streamlit/routing.py`:
   - Find the `place_input` text input default value
   - Change from current location to a landmark in `<NOTEBOOK_CITY>`
   
   **Before:**
   ```python
   place_input = st.text_input('Choose Input', 'Golden Gate Bridge, San Francisco')
   ```
   
   **After:**
   ```python
   place_input = st.text_input('Choose Input', '<LANDMARK>, <NOTEBOOK_CITY>')
   ```
   - Choose an iconic landmark in the city (e.g., "Big Ben, London", "Eiffel Tower, Paris", "Brandenburg Gate, Berlin")

7. **Re-upload** the modified files:
   ```bash
   snow stage copy "Notebook/add_carto_data.ipynb" @VEHICLE_ROUTING_SIMULATOR.NOTEBOOKS.notebook --overwrite
   snow stage copy "Streamlit/routing.py" @VEHICLE_ROUTING_SIMULATOR.STREAMLITS.STREAMLIT --overwrite
   ```

8. **Recreate** the database tables with new region data:
   ```sql
   -- Create region data table with new geohash
   CREATE OR REPLACE TABLE VEHICLE_ROUTING_SIMULATOR.DATA.REGION_DATA AS 
   SELECT * FROM OVERTURE_MAPS__PLACES.CARTO.PLACE
   WHERE ST_GEOHASH(GEOMETRY,2) = '<GEOHASH>';
   
   -- Recreate PLACES table from new region data
   CREATE OR REPLACE TABLE VEHICLE_ROUTING_SIMULATOR.DATA.PLACES AS 
   SELECT 
       GEOMETRY,
       PHONES:list[0]['element']::text AS PHONES,
       CATEGORIES:primary::text AS CATEGORY,
       NAMES:primary::text AS NAME,
       ADDRESSES:list[0]['element'] AS ADDRESS,
       COALESCE(categories:alternate:list, ARRAY_CONSTRUCT()) AS ALTERNATE
   FROM VEHICLE_ROUTING_SIMULATOR.DATA.REGION_DATA
   WHERE CATEGORIES:primary IS NOT NULL;
   
   -- Add search optimization
   ALTER TABLE VEHICLE_ROUTING_SIMULATOR.DATA.PLACES ADD SEARCH OPTIMIZATION ON EQUALITY(ALTERNATE);
   ALTER TABLE VEHICLE_ROUTING_SIMULATOR.DATA.PLACES ADD SEARCH OPTIMIZATION ON GEO(GEOMETRY);
   ```

9. **Verify** the data was loaded:
   ```sql
   SELECT COUNT(*) FROM VEHICLE_ROUTING_SIMULATOR.DATA.PLACES;
   ```
   - Should return a substantial number of POIs (typically 100K+ for major cities)

**Output:** Add Carto Data notebook and Streamlit app customized for <NOTEBOOK_CITY>, POI data loaded

### Step 8b: Customize Industry Categories (Optional)

**Goal:** Allow user to customize industry categories for their use case

**IMPORTANT:** This step is OPTIONAL. Only proceed if user wants to change industry categories.

**Background:**
The default industries are:
- **Healthcare** - pharmaceutical supplies, medical equipment to hospitals, pharmacies, dentists
- **Food** - fresh, frozen, and non-perishable goods to supermarkets, restaurants, butchers
- **Cosmetics** - hair products, electronics, make-up to retail outlets

The Streamlit app (`routing.py`) reads industries dynamically from the `DATA.LOOKUP` table, so **only the notebook needs updating** - the Streamlit adapts automatically.

**Actions:**

1. **Ask user** if they want to customize industry categories
   - If NO, skip to Step 9
   - If YES, ask what industries they want (e.g., "Beverage distribution", "Medical supplies", "Electronics", "Retail goods")

2. **Update** Cell 15 in `Notebook/add_carto_data.ipynb` with custom industries:
   
   Each industry requires:
   | Field | Purpose | Example |
   |-------|---------|---------|
   | `INDUSTRY` | Display name in app | 'Beverages' |
   | `PA`, `PB`, `PC` | Product categories (3 skill levels) | 'Alcoholic', 'Carbonated', 'Still Water' |
   | `IND` | Keywords to find distributor/warehouse locations | ARRAY_CONSTRUCT('beverage drink brewery distillery') |
   | `IND2` | Secondary keywords (warehouse, depot, etc.) | ARRAY_CONSTRUCT('warehouse distribution depot factory') |
   | `CTYPE` | Customer place categories (from Overture Maps) | ARRAY_CONSTRUCT('bar', 'restaurant', 'supermarket', 'hotel') |
   | `STYPE` | Vehicle skill descriptions | ARRAY_CONSTRUCT('Standard Delivery', 'Temperature Controlled', 'Premium Service') |

   **Example custom industry:**
   ```sql
   SELECT
       'Beverages', 
       'Alcoholic Beverages', 
       'Carbonated Drinks', 
       'Still Water', 
       ARRAY_CONSTRUCT('beverage drink brewery distillery bottling'),
       ARRAY_CONSTRUCT('warehouse distribution depot factory wholesaler'), 
       ARRAY_CONSTRUCT('bar', 'restaurant', 'hotel', 'supermarket'), 
       ARRAY_CONSTRUCT('Standard Delivery', 'Temperature Controlled', 'Premium Service')
   ```

3. **Show user** available Overture Maps categories for their region:
   ```sql
   SELECT DISTINCT CATEGORY, COUNT(*) as COUNT 
   FROM VEHICLE_ROUTING_SIMULATOR.DATA.PLACES 
   GROUP BY CATEGORY 
   ORDER BY COUNT DESC 
   LIMIT 50;
   ```
   - This helps user choose valid `CTYPE` values that exist in their region

4. **Generate** the updated INSERT statement with all industries (default + custom or replaced)

5. **Update** the notebook cell with the new INSERT statement

6. **Re-upload** the modified notebook:
   ```bash
   snow stage copy "Notebook/add_carto_data.ipynb" @VEHICLE_ROUTING_SIMULATOR.NOTEBOOKS.notebook --overwrite
   ```

7. **Recreate** the LOOKUP table with new industries:
   ```sql
   DROP TABLE IF EXISTS VEHICLE_ROUTING_SIMULATOR.DATA.LOOKUP;
   -- Then run the CREATE TABLE and INSERT from the updated notebook cell
   ```

8. **Verify** industries are loaded:
   ```sql
   SELECT INDUSTRY, PA, PB, PC FROM VEHICLE_ROUTING_SIMULATOR.DATA.LOOKUP;
   ```

**Note:** The Streamlit app (`routing.py`) does NOT need updating - it reads industries dynamically from `DATA.LOOKUP`.

**Output:** Industry categories customized for user's use case

### Step 9: Save Customizations (Git Optional)

**Goal:** Save customizations - either to a Git branch or just locally

**Actions:**

1. **Check** if Git is available and the directory is a Git repository:
   ```bash
   git status
   ```

2. **If Git is NOT available or not a Git repo:**
   - Inform user that customizations have been made directly to local files
   - Recommend keeping a backup of original files if they want to restore defaults later
   - **Skip to Step 10**

3. **If Git IS available:**
   - **Ask user** if they want to save customizations to a feature branch
   - If NO, inform them changes remain in working directory and skip to Step 10
   - If YES, continue with branching:

4. **Create** feature branch for this region:
   ```bash
   git checkout -b feature/ors-<REGION_NAME>
   ```

5. **Add and commit** all customization changes made in Steps 3-8:
   ```bash
   git add Native_app/provider_setup/staged_files/ors-config.yml
   git add Native_app/services/openrouteservice/openrouteservice.yaml
   git add Native_app/code_artifacts/streamlit/pages/function_tester.py
   git add Notebook/routing_functions_aisql.ipynb
   git add Notebook/add_carto_data.ipynb
   git add Streamlit/routing.py
   git commit -m "Configure ORS and customize all artifacts for <REGION_NAME> map region"
   ```

6. **Inform** user that:
   - Original San Francisco version remains on `main` branch
   - All <REGION_NAME> customizations are on `feature/ors-<REGION_NAME>` branch
   - To switch back to original version: `git checkout main`
   - To return to this region: `git checkout feature/ors-<REGION_NAME>`

**Output:** Customizations saved (either to Git branch or local files only)

### Step 10: Deploy Updated Streamlit App

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

## Stopping Points

- ✋ After Step 2: Confirm map download completed successfully
- ✋ After Step 5: Verify services resumed without errors
- ✋ After Step 6: Confirm region-specific coordinates are accurate for Function Tester
- ✋ After Step 7: Confirm AISQL notebook location references are updated correctly
- ✋ After Step 8: Confirm Add Carto Data notebook and POI data loaded for the region
- ✋ After Step 8b (if used): Confirm industry categories customized and LOOKUP table updated
- ✋ After Step 9: Verify customizations saved (Git branch if using Git, or local files)

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

4. **AISQL Notebook updated:** Open `Notebook/routing_functions_aisql.ipynb` and verify:
   - All AI prompts reference <NOTEBOOK_CITY> (a city within the map region) instead of San Francisco
   - Geocode address references a location within <NOTEBOOK_CITY>
   - Markdown descriptions mention the correct city

5. **Add Carto Data Notebook updated:** Open `Notebook/add_carto_data.ipynb` and verify:
   - Geohash filter matches the chosen city/region
   - AI prompts reference <NOTEBOOK_CITY> instead of San Francisco
   - POI data table (`VEHICLE_ROUTING_SIMULATOR.DATA.PLACES`) contains data for the region

6. **Streamlit Simulator updated:** Open `Streamlit/routing.py` and verify:
   - Default location input references a landmark in <NOTEBOOK_CITY>

7. **Git branches (if using Git):**
   ```bash
   git branch --show-current
   git log --oneline -3
   ```
   - If Git was used: Current branch should be `feature/ors-<REGION_NAME>`
   - Main branch should have original SF configuration
   - If not using Git: Skip this verification

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
- AISQL Notebook customized with city-specific AI prompts (using a major city within the map region)
- Add Carto Data Notebook customized with region-specific geohash and POI data loaded
- Streamlit Simulator updated with region-specific default location
- Industry categories customized (if Step 8b was used)

**If using Git:**
- Original SF version preserved on main branch
- All customizations committed to `feature/ors-<REGION_NAME>` branch
- Working directory checked out to feature branch

**If not using Git:**
- All customizations saved to local files
- User advised to keep backup of original files if needed

**Note on Industry Customization:**
The Streamlit app reads industries dynamically from the database, so only the `add_carto_data.ipynb` notebook needs updating when changing industries. The app will automatically reflect any changes to the `DATA.LOOKUP` table.
