---
name: customize-main
description: "Route customization requests to the correct skill. Use when: changing location, changing map, changing vehicle Triggers: change location, change map, change vehicle, change routing profile"
---

# Customization Router

This skill routes customization requests to the correct skill based on what you want to customize.

## Quick Reference

| What You Want to Change | Correct Skill | What It Does |
|------------------------|---------------|--------------|
| **Map/Location** | `.cortex/skills/customize-main/location` | Changes map map |
| **Routing Profiles** | `.cortex/skills/customize-main/routing-profiles` | Changes routing profiles |

## Workflow

### Step 1: Determine What to Customize

**Ask the user:**

"What would you like to customize?"

1. **Location/Map** - Change the geographic region (e.g., San Francisco → Paris)
2. **Routing Profiles** - Enable/disable routing profiles (car, truck, bicycle, walking)

### Step 2: Route to Correct Skill

**If user wants to change LOCATION or MAP:**

> This requires changing a map. 

Run the location skill (this handles everything for the Native App):
```
$customize-main/location
```

This skill will:
- Download the new map
- Update ors-config.yml
- Update service specifications
- Update Function Tester with new addresses
- Upgrade the Native App
---

**If user wants to change ROUTING PROFILES:**

> This updates which routing profiles are available.

Run the vehicles skill:
```
$customize-main/routing-profiles
```


### Step 5: Update Routing Graphs

**Goal:** Restart services to update routing graphs with new location

**Actions:**

1. **Ask user** if they want to rebuild graphs for the map:
   - "Do you want to rebuild the routing graphs for this region? This will clear existing cached graphs and elevation data, forcing a fresh rebuild."

2. **If user confirms YES**, clear existing graphs and elevation cache:
   ```sql
   REMOVE @OPENROUTESERVICE_NATIVE_APP.CORE.ORS_ELEVATION_CACHE_SPCS_STAGE/<REGION_NAME>/;
   REMOVE @OPENROUTESERVICE_NATIVE_APP.CORE.ORS_GRAPHS_SPCS_STAGE/<REGION_NAME>/;
   ```
   
   > **_NOTE:_** This ensures graphs are rebuilt from scratch with the new map data rather than using potentially stale cached data.

3. **Resume** all services:
   ```sql
   ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.DOWNLOADER RESUME;
   ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SERVICE RESUME;
   ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.ROUTING_GATEWAY_SERVICE RESUME;
   ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.VROOM_SERVICE RESUME;
   ```

4. **Verify** services are running:
   ```sql
   SHOW SERVICES IN OPENROUTESERVICE_NATIVE_APP.CORE;
   ```

5. **Monitor** ORS_SERVICE logs for graph building progress:
   ```sql
   CALL SYSTEM$GET_SERVICE_LOGS('OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SERVICE', 0, 'ors', 100);
   ```
   - Look for: `"Graph built in X seconds"` messages for each enabled profile

**Note:** Graph building can take 30 minutes to several hours depending on map size and number of enabled profiles.

**Output:** Services rebuilding with new map

### Step 6: Update and Deploy Function Tester

**Goal:** Update the Function Tester Streamlit with region-specific addresses and deploy to the Native App

**Actions:**

1. **Generate** region-specific sample addresses for the Function Tester:
   - 5 START addresses (landmarks, transport hubs in `<REGION_NAME>`)
   - 5 END addresses (different locations)
   - 20 WAYPOINT addresses spread across the region

2. **Edit** `oss-install-openrouteservice-native-app/Native_app/code_artifacts/streamlit/pages/function_tester.py`:
   - Update page title to: `page_title="ORS Function Tester For <REGION_NAME> Map"`
   - Replace `SF_ADDRESSES` with region-specific addresses
   - Replace `SF_WAYPOINT_ADDRESSES` with region waypoints
   - Update map center coordinates

3. **Upload** updated Function Tester to stage:
   ```bash
   snow stage copy oss-install-openrouteservice-native-app/Native_app/code_artifacts/streamlit/pages/function_tester.py \
     @OPENROUTESERVICE_NATIVE_APP_PKG.APP_SRC.STAGE/streamlit/pages/ --overwrite
   ```

4. **Upgrade** the Native App to apply changes:
   ```sql
   ALTER APPLICATION OPENROUTESERVICE_NATIVE_APP UPGRADE USING '@OPENROUTESERVICE_NATIVE_APP_PKG.APP_SRC.STAGE';
   ```

**Output:** Function Tester deployed with region-specific addresses

### Step 7: Update MAP_CONFIG Table

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

## Stopping Points

- ✋ After Step 2: Confirm map download completed
- ✋ After Step 5: Verify services are rebuilding graphs
- ✋ After Step 6: Verify Function Tester shows new region addresses
- ✋ After Step 7: Verify MAP_CONFIG table has correct bounds