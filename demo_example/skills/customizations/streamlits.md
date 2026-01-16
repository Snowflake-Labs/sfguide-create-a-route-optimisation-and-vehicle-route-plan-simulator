---
name: customize-streamlits
description: "Update Function Tester and Simulator Streamlit apps with region-specific coordinates. Use when: changing map region, updating sample addresses. Triggers: customize streamlit, update coordinates, update function tester."
---

# Customize Streamlit Apps

Updates the Function Tester and Simulator Streamlit apps with region-specific coordinates and settings.

## Prerequisites

- Active Snowflake connection
- OpenRouteService Native App deployed
- Know the target region and a major city within it
- Access to:
  - `Native_app/code_artifacts/streamlit/pages/function_tester.py`
  - `Streamlit/routing.py`

## Input Parameters

- `<REGION_NAME>`: The map region (e.g., "great-britain", "switzerland")
- `<NOTEBOOK_CITY>`: A major city within the region for sample data (e.g., "London", "Zurich")

## Workflow

### Step 1: Generate Region-Specific Coordinates

**Goal:** Create sample addresses and coordinates for the region

**Actions:**

1. **For the target region**, generate:
   - 5 START addresses with coordinates (landmarks, transport hubs)
   - 5 END addresses with coordinates (different from start)
   - 20 WAYPOINT addresses spread across the region

2. **Each location needs:**
   - `name`: Short name
   - `lat`: Latitude (decimal degrees)
   - `lon`: Longitude (decimal degrees)
   - `full_address`: Complete address string

3. **Example format:**
   ```python
   REGION_ADDRESSES = {
       'start': {
           'Westminster, London': {'lat': 51.4975, 'lon': -0.1357, 'name': 'Westminster', 'full_address': 'Westminster, London SW1A'},
           'Manchester Centre': {'lat': 53.4808, 'lon': -2.2426, 'name': 'Manchester', 'full_address': 'Manchester City Centre'},
       },
       'end': {
           'Canary Wharf': {'lat': 51.5054, 'lon': -0.0235, 'name': 'Canary Wharf', 'full_address': 'Canary Wharf, London E14'},
       }
   }
   
   REGION_WAYPOINT_ADDRESSES = [
       {'name': 'Covent Garden', 'lat': 51.5117, 'lon': -0.1240, 'full_address': 'Covent Garden, London'},
       {'name': 'Liverpool', 'lat': 53.4084, 'lon': -2.9916, 'full_address': 'Liverpool City Centre'},
   ]
   ```

**Output:** Region-specific coordinate data structures

### Step 2: Update Function Tester

**Goal:** Modify function_tester.py with new coordinates

**Actions:**

1. **Edit** `Native_app/code_artifacts/streamlit/pages/function_tester.py`:

   a. **Update page title** (~line 19):
      - From: `page_title="ORS Function Tester For San Francisco Map"`
      - To: `page_title="ORS Function Tester For <REGION_NAME> Map"`

   b. **Update routing profiles** (~lines 32-36):
      - Check `ors-config.yml` for enabled profiles
      - Update `ROUTING_PROFILES` list to match

   c. **Replace address dictionaries** (~lines 45-83):
      - Replace `SF_ADDRESSES` with `<REGION>_ADDRESSES`
      - Replace `SF_WAYPOINT_ADDRESSES` with `<REGION>_WAYPOINT_ADDRESSES`

   d. **Update all references**:
      - Find/replace all `SF_ADDRESSES` → `<REGION>_ADDRESSES`
      - Find/replace all `SF_WAYPOINT_ADDRESSES` → `<REGION>_WAYPOINT_ADDRESSES`

   e. **Update sidebar text** (~line 106):
      - From: `"**🏠 San Francisco Addresses:**"`
      - To: `"**🏠 <REGION_NAME> Addresses:**"`

   f. **Update map view center** (OPTIMIZATION section):
      - Change default latitude/longitude to region center

**Output:** Function Tester updated

### Step 3: Update Simulator Streamlit

**Goal:** Modify routing.py with region-specific default location

**Actions:**

1. **Edit** `Streamlit/routing.py`:

   a. **Find** the `place_input` default value:
      ```python
      place_input = st.text_input('Choose Input', 'Golden Gate Bridge, San Francisco')
      ```

   b. **Change** to a landmark in `<NOTEBOOK_CITY>`:
      ```python
      place_input = st.text_input('Choose Input', '<LANDMARK>, <NOTEBOOK_CITY>')
      ```
      
      Examples:
      - London: `'Big Ben, London'`
      - Paris: `'Eiffel Tower, Paris'`
      - Berlin: `'Brandenburg Gate, Berlin'`
      - Zurich: `'Zurich Main Station, Zurich'`

**Output:** Simulator updated

### Step 4: Deploy Updated Apps

**Goal:** Upload changes and upgrade the Native App

**Actions:**

1. **Upload** Function Tester:
   ```bash
   snow stage copy Native_app/code_artifacts/streamlit/pages/function_tester.py @OPENROUTESERVICE_NATIVE_APP_PKG.APP_SRC.STAGE/streamlit/pages/ --overwrite
   ```

2. **Upload** Simulator:
   ```bash
   snow stage copy "Streamlit/routing.py" @VEHICLE_ROUTING_SIMULATOR.STREAMLITS.STREAMLIT --overwrite
   ```

3. **Upgrade** Native App:
   ```sql
   ALTER APPLICATION OPENROUTESERVICE_NATIVE_APP UPGRADE USING '@OPENROUTESERVICE_NATIVE_APP_PKG.APP_SRC.STAGE';
   ```

**Output:** Streamlit apps deployed with new coordinates

### Step 5: Test Updates

**Goal:** Verify the apps work with new coordinates

**Actions:**

1. **Open** Native App:
   ```bash
   cd Native_app && snow app open -c <connection>
   ```

2. **Test** Function Tester:
   - Verify page title shows correct region
   - Verify start/end dropdowns have region addresses
   - Test a simple direction calculation

3. **Open** Simulator (after deploy-demo):
   - Verify default location is the new landmark
   - Test search functionality with region-specific places

**Output:** Apps verified working

## Common Region Centers

| Region | Center Lat | Center Lon | Sample City |
|--------|------------|------------|-------------|
| Great Britain | 51.5074 | -0.1278 | London |
| France | 48.8566 | 2.3522 | Paris |
| Germany | 52.5200 | 13.4050 | Berlin |
| Switzerland | 47.3769 | 8.5417 | Zurich |
| New York | 40.7128 | -74.0060 | New York City |

## Stopping Points

- ✋ After Step 1: Review generated coordinates with user
- ✋ After Step 4: Verify deployment succeeded
- ✋ After Step 5: Confirm apps work correctly

## Output

Function Tester and Simulator Streamlit apps customized for `<REGION_NAME>` with appropriate sample addresses and map centering.
