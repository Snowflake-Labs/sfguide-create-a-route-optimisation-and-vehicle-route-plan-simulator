---
name: customize-function-tester
description: "Customize the ORS Function Tester app with coordinates for your chosen map region. Use when: updating function tester addresses, changing test coordinates to match map region, configuring function tester for new country/region. Triggers: customize function tester, update test coordinates, configure function tester for [region]."
---

# Customize Function Tester Coordinates

Updates the ORS Function Tester Streamlit app to use sample addresses and coordinates appropriate for the currently configured map region.

## Prerequisites

- Active Snowflake connection
- OpenRouteService Native App deployed (`OPENROUTESERVICE_NATIVE_APP`)
- Map region already configured (via ors-map-customization skill)
- Access to modify `Native_app/code_artifacts/streamlit/pages/function_tester.py`
- Git repository initialized

## Workflow

### Step 1: Create Feature Branch

**Goal:** Preserve original San Francisco version on main branch

**Actions:**

1. **Check** current git status:
   ```bash
   git status
   ```

2. **Create and checkout** a new branch for the region customization:
   ```bash
   git checkout -b feature/function-tester-<REGION_NAME>
   ```
   Example: `git checkout -b feature/function-tester-great-britain`

3. **Confirm** branch creation:
   ```bash
   git branch
   ```

**Output:** New feature branch created, original main branch preserved

**Next:** Proceed to Step 2

### Step 2: Identify Current Map Region

**Goal:** Determine which map region is currently configured

**Actions:**

1. **Check** the current map configuration:
   ```sql
   LS @OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SPCS_STAGE;
   ```
   Look for region folders (e.g., `great-britain/`, `SanFrancisco/`, etc.)

2. **Verify** the active region by checking the service spec:
   - Read `Native_app/services/openrouteservice/openrouteservice.yaml`
   - Look for the `source:` paths to identify the active region

3. **Ask user to confirm** the target region if unclear

**Output:** Identified current map region name

### Step 3: Generate Region-Specific Coordinates

**Goal:** Create appropriate sample addresses and coordinates for the region

**Actions:**

1. **For the identified region**, generate sample data:
   - 5 start addresses with coordinates
   - 5 end addresses with coordinates
   - 20 waypoint addresses with coordinates
   - All coordinates must be within the map boundaries

2. **Coordinate Requirements:**
   - Use well-known locations (landmarks, neighborhoods, city centers)
   - Spread addresses across the region for variety
   - Include mix of urban and suburban locations where applicable
   - Coordinates must be in decimal degrees (lat, lon)

3. **Example format for each region:**

   **For Great Britain:**
   ```python
   GB_ADDRESSES = {
       'start': {
           'Westminster, London': {'lat': 51.4975, 'lon': -0.1357, 'name': 'Westminster, London', 'full_address': 'Westminster, London SW1A 0AA'},
           'Manchester City Centre': {'lat': 53.4808, 'lon': -2.2426, 'name': 'Manchester City Centre', 'full_address': 'Manchester City Centre, M1 1AD'},
           # ... more addresses
       },
       'end': {
           # ... end addresses
       }
   }
   
   GB_WAYPOINT_ADDRESSES = [
       {'name': 'Covent Garden, London', 'lat': 51.5117, 'lon': -0.1240, 'full_address': 'Covent Garden, London WC2E 8RF'},
       # ... more waypoints
   ]
   ```

**Output:** Region-specific address data structures

### Step 4: Update Function Tester Code

**Goal:** Modify function_tester.py with new coordinates

**Actions:**

1. **Edit** `Native_app/code_artifacts/streamlit/pages/function_tester.py`:

   a. **Update page title** (line ~19):
      - Change `page_title="ORS Function Tester For San Francisco Map"` 
      - To `page_title="ORS Function Tester For <REGION_NAME> Map"`

   b. **Update routing profiles** (lines ~32-36):
      - Check `ors-config.yml` for enabled profiles
      - Update `ROUTING_PROFILES` list to match enabled profiles only

   c. **Replace address dictionaries** (lines ~45-83):
      - Replace `SF_ADDRESSES` with `<REGION>_ADDRESSES`
      - Replace `SF_WAYPOINT_ADDRESSES` with `<REGION>_WAYPOINT_ADDRESSES`
      - Update all references from `SF_ADDRESSES` to new name
      - Update all references from `SF_WAYPOINT_ADDRESSES` to new name

   d. **Update sidebar text** (line ~106):
      - Change `"**🏠 San Francisco Addresses:**"` to `"**🏠 <REGION_NAME> Addresses:**"`

   e. **Update map view center** (lines ~977-980 in OPTIMIZATION section):
      - Change default center latitude/longitude to region center
      - Example: `latitude=51.5074, longitude=-0.1278` for London

   f. **Update any hardcoded "San Francisco" text references**

2. **Verify** all variable name references are updated consistently

**Output:** Updated function_tester.py with region-specific coordinates

### Step 5: Deploy Updated App

**Goal:** Push changes to Snowflake and restart the app

**Actions:**

1. **Upload** modified function_tester.py to stage:
   ```bash
   cd Native_app && snow app run -c <connection> --warehouse ROUTING_ANALYTICS
   ```

2. **Verify** deployment succeeded

**Output:** Function tester deployed with new coordinates

### Step 7: Commit Changes to Branch

**Goal:** Save customizations to the feature branch

**Actions:**

1. **Stage** the modified files:
   ```bash
   git add Native_app/code_artifacts/streamlit/pages/function_tester.py
   ```

2. **Commit** the changes:
   ```bash
   git commit -m "Customize function tester for <REGION_NAME> map region"
   ```

3. **Inform user** about branch management:
   - Current branch contains region-specific customizations
   - Main branch preserves original San Francisco version
   - To switch regions: checkout appropriate branch or main

**Output:** Changes committed to feature branch

### Step 8: Test the Updated Function Tester

**Goal:** Verify the function tester works with new coordinates

**Actions:**

1. **Open** the native app in browser:
   ```bash
   cd Native_app && snow app open -c <connection>
   ```

2. **Navigate** to the Function Tester page

3. **Test** each function:
   - DIRECTIONS: Select start/end addresses and verify route displays correctly
   - OPTIMIZATION: Run a test optimization with multiple vehicles/jobs
   - ISOCHRONES: Generate an isochrone from center location

4. **Verify** map renders correctly centered on the new region

**Output:** User confirmation that function tester works with new region

## Common Region Coordinate Sets

### Great Britain
- Center: 51.5074, -0.1278 (London)
- Sample cities: London, Manchester, Birmingham, Edinburgh, Bristol, Leeds, Glasgow

### Germany
- Center: 52.5200, 13.4050 (Berlin)
- Sample cities: Berlin, Munich, Hamburg, Frankfurt, Cologne, Stuttgart, Dusseldorf

### France
- Center: 48.8566, 2.3522 (Paris)
- Sample cities: Paris, Lyon, Marseille, Toulouse, Nice, Nantes, Bordeaux

### Switzerland
- Center: 46.9480, 7.4474 (Bern)
- Sample cities: Zurich, Geneva, Basel, Bern, Lausanne, Lucerne, St. Gallen

### New York State (US)
- Center: 40.7128, -74.0060 (NYC)
- Sample areas: Manhattan, Brooklyn, Queens, Albany, Buffalo, Syracuse, Rochester

## Stopping Points

- ✋ After Step 1: Confirm branch created successfully
- ✋ After Step 3: Review generated coordinates with user before applying
- ✋ After Step 5: Verify deployment succeeded before testing
- ✋ After Step 7: Confirm changes committed to branch

## Common Issues

**Issue:** Routes fail to calculate
- **Solution:** Ensure coordinates are within the map boundaries; check ORS service logs

**Issue:** Map displays wrong region
- **Solution:** Verify view_state latitude/longitude matches region center

**Issue:** Profiles not available
- **Solution:** Check ors-config.yml for enabled profiles; update ROUTING_PROFILES list

## Output

Function Tester app customized with region-appropriate sample addresses, coordinates, and map centering for the configured OpenRouteService map region.
