---
name: deploy-route-optimization-demo
description: "Deploy the Route Optimization demo including Marketplace data, notebook, and Streamlit app. Use when: setting up the route optimization demo after native app deployment. Triggers: deploy route optimization demo, setup route optimization demo, run route optimization demo."
---

# Deploy Route Optimization Demo

Deploys the complete Route Optimization demo including Snowflake Marketplace data, the exploration notebook, and the Streamlit simulator application.

## Prerequisites

- OpenRouteService Native App deployed and activated
- Active Snowflake connection

## Workflow

### Step 1: Set Query Tag for Tracking

**Goal:** Set session query tag for attribution tracking.

```sql
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is","name":"oss-deploy-route-optimization-demo","version":{"major":1, "minor":0},"attributes":{"is_quickstart":1, "source":"sql"}}';
```

**Output:** Query tag set for session tracking

### Step 2: Verify Services are Running

**Goal:** Confirm the ORS services are active

**Actions:**

1. **Check** services status:
   ```sql
   SHOW SERVICES IN APPLICATION OPENROUTESERVICE_NATIVE_APP;
   ```

2. **Verify** all 4 services are running:
   - `OPENROUTESERVICE` - Main routing engine
   - `ROUTING_REVERSE_PROXY` - API gateway
   - `VROOM` - Vehicle routing optimization
   - `DOWNLOADER` - Map download service

3. **If services are not running, resume them:**
   ```sql
   ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.DOWNLOADER RESUME;
   ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SERVICE RESUME;
   ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.ROUTING_GATEWAY_SERVICE RESUME;
   ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.VROOM_SERVICE RESUME;
   ```
**Output:** OpenRouteService Native App verified as installed and running

**Next:** ORS prerequisite check complete - ready for demo deployment. Proceed to Step 3. 

### Step 3: Read Current ORS Configuration

**Goal:** Detect the current map region and routing profiles from the ORS configuration to customize the demo accordingly

**Actions:**

1. **Extract** the current ORS configuration from the service definition:
   ```sql
   DESCRIBE SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SERVICE;
   ```
   - Parse the service spec from the output to find the `source_file` setting
   - Look for the map file path: `/home/ors/files/<REGION_NAME>.osm.pbf`
   - Extract `<REGION_NAME>` (e.g., "SanFrancisco", "great-britain-latest", "paris")
   - This determines the `<REGION_NAME>` for the demo

2. **Extract** the enabled vehicle profiles:
   - Look for profiles with `enabled: true`
   - Common profiles: `driving-car`, `driving-hgv`, `cycling-road`, `cycling-regular`, `foot-walking`
   - Store the list of enabled profiles

3. **Determine the city for the demo:**
   - If map is a city (e.g., "SanFrancisco", "Paris", "London"): Use that city name
   - If map is a region/country (e.g., "great-britain", "germany"): Ask user which city within that region to use for sample data

4. **Store configuration for later steps:**
   - `<REGION_NAME>`: The region name
   - `<NOTEBOOK_CITY>`: The city to use for AI-generated sample data
   - `<ENABLED_PROFILES>`: List of enabled vehicle profiles

**Output:** Current ORS configuration detected:
- Map Region: `<REGION_NAME>`
- Demo City: `<NOTEBOOK_CITY>`
- Vehicle Profiles: `<ENABLED_PROFILES>`

**Next:** Proceed to Step 4

### Step 4: Get Carto Overture Dataset from Marketplace

**Goal:** Acquire the Overture Maps Places dataset for point-of-interest data

**Actions:**

1. **Execute** the following SQL commands to get the dataset:
   ```sql
   CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZT0Z4CM1E9KR');
   CREATE DATABASE IF NOT EXISTS OVERTURE_MAPS__PLACES FROM LISTING GZT0Z4CM1E9KR;
   ```

**Output:** Carto Overture Places dataset available in your account as `OVERTURE_MAPS__PLACES`

**Next:** Proceed to Step 5

### Step 5: Setup Snowflake Objects

**Goal:** Create required snowflake objects for the demo

**Actions:**

1. **Execute** the following SQL:
   ```sql
   ALTER ACCOUNT SET CORTEX_ENABLED_CROSS_REGION = 'ANY_REGION';
   
   CREATE SCHEMA IF NOT EXISTS OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR;
   CREATE WAREHOUSE IF NOT EXISTS ROUTING_ANALYTICS AUTO_SUSPEND = 60;
   ```

**Output:** Schema `OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR` created.

**Next:** Proceed to Step 6

### Step 6: Deploy and Run the Notebook to add Carto data

**Goal:** Create and execute notebook that will add Carto data to the database.

**Actions:**

1. **Create** the notebook stage:
   ```sql
   CREATE STAGE IF NOT EXISTS OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.notebook 
   DIRECTORY = (ENABLE = TRUE) 
   ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE');
   ```

2. **Upload** notebook files to stage:
   ```bash
   snow stage copy "oss-deploy-route-optimization-demo/Notebook/add_carto_data.ipynb" \
     @OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.notebook --connection <connection> --overwrite
   
   snow stage copy "oss-deploy-route-optimization-demo/Notebook/environment.yml" \
     @OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.notebook --connection <connection> --overwrite
   ```

3. **Create** the notebook:
   ```sql
   CREATE OR REPLACE OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.ADD_CARTO_DATA
   FROM '@OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.NOTEBOOK'
   MAIN_FILE = 'add_carto_data.ipynb'
   QUERY_WAREHOUSE = 'ROUTING_ANALYTICS'
   COMMENT = '{"origin":"sf_sit-is", "name":"Route Optimization with Open Route Service", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"notebook"}}';
   
   ALTER NOTEBOOK OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.ADD_CARTO_DATA ADD LIVE VERSION FROM LAST;
   ```

4.  **Execute** notebook with three parameters:
   ```sql
   EXECUTE NOTEBOOK OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.ADD_CARTO_DATA();

**Output:** Notebook deployed with standing data for the Streamlit app

**Next:** Proceed to Step 7

### Step 7: Check for Latest Claude Model

**Goal:** Verify the latest Claude Sonnet model available in Snowflake Cortex

**Actions:**

1. **Check** the Snowflake Cortex AI documentation for available models:
   - Reference: https://docs.snowflake.com/en/user-guide/snowflake-cortex/aisql
   - Look for the latest Claude Sonnet model in the "Choosing a model" section

2. **Verify** model availability by running this SQL:
   ```sql
   -- Test the model is available
   SELECT AI_COMPLETE('claude-sonnet-4-5', 'Say hello') AS test_response;
   ```

3. **If needed, update** the notebook to use the latest model:
   - Current default: `claude-sonnet-4-5`
   - If a newer Claude Sonnet model is listed in the documentation, update the notebook file `Notebook/routing_functions_aisql.ipynb` before uploading
   - Replace all occurrences of the old model name with the new one

**Note:** As of January 2026, the recommended Claude Sonnet model is `claude-sonnet-4-5`. Check the documentation link above for any newer versions.

**Output:** Confirmed latest Claude Sonnet model for use in the notebook

**Next:** Proceed to Step 8

### Step 8: Deploy the AISQL Notebook (Customized for Region)

**Goal:** Create the AISQL exploration notebook, customized for the detected region

**Actions:**

1. **Before uploading**, update the notebook with region-specific prompts:
   - Open `oss-deploy-route-optimization-demo/Notebook/routing_functions_aisql.ipynb`
   - Update AI prompts in the notebook to use `<NOTEBOOK_CITY>` in case needed"
   - Example: Change "Generate a restaurant in San Francisco" to "Generate a restaurant in `<NOTEBOOK_CITY>`"

2. **Upload** notebook files to stage:
   ```bash
   snow stage copy "oss-deploy-route-optimization-demo/Notebook/routing_functions_aisql.ipynb" \
     @OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.notebook --connection <connection> --overwrite
   
   snow stage copy "oss-deploy-route-optimization-demo/Notebook/environment.yml" \
     @OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.notebook --connection <connection> --overwrite
   ```

3. **Create** the notebook:
   ```sql
   CREATE OR REPLACE NOTEBOOK OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.ROUTING_FUNCTIONS_AISQL
   FROM '@OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.NOTEBOOK'
   MAIN_FILE = 'routing_functions_aisql.ipynb'
   QUERY_WAREHOUSE = 'ROUTING_ANALYTICS'
   COMMENT = '{"origin":"sf_sit-is", "name":"Route Optimization with Open Route Service", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"notebook"}}';
   
   ALTER NOTEBOOK OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.ROUTING_FUNCTIONS_AISQL ADD LIVE VERSION FROM LAST;
   ```

**Output:** Notebook created with AI prompts customized for `<NOTEBOOK_CITY>`

**Next:** Proceed to Step 9

### Step 9: Deploy the Streamlit Application (Customized for Region)

**Goal:** Deploy the route simulator Streamlit app, customized for the detected region

**Actions:**

1. **Before uploading**, update the Streamlit with region-specific defaults:
   - Open `oss-deploy-route-optimization-demo/Streamlit/routing.py`
   - Find the `place_input` default value (currently "Golden Gate Bridge, San Francisco")
   - Update to a landmark in `<NOTEBOOK_CITY>`:
     - London: "Big Ben, London"
     - Paris: "Eiffel Tower, Paris"
     - Berlin: "Brandenburg Gate, Berlin"
     - etc.

2. **Create** the Streamlit stage:
   ```sql
   CREATE STAGE IF NOT EXISTS OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.STREAMLIT 
   DIRECTORY = (ENABLE = TRUE) 
   ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE');
   ```

3. **Upload** Streamlit files to stage:
   ```bash
   snow stage copy "oss-deploy-route-optimization-demo/Streamlit/routing.py" \
     @OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.STREAMLIT --connection <connection> --overwrite
   
   snow stage copy "oss-deploy-route-optimization-demo/Streamlit/extra.css" \
     @OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.STREAMLIT --connection <connection> --overwrite
   
   snow stage copy "oss-deploy-route-optimization-demo/Streamlit/environment.yml" \
     @OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.STREAMLIT --connection <connection> --overwrite
   
   snow stage copy "oss-deploy-route-optimization-demo/Streamlit/logo.svg" \
     @OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.STREAMLIT --connection <connection> --overwrite

   snow stage copy "oss-deploy-route-optimization-demo/Streamlit/config.toml" \
     @OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.STREAMLIT --connection <connection> --overwrite
   ```

4. **Create** the Streamlit app:
   ```sql
   CREATE OR REPLACE STREAMLIT OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.SIMULATOR
    ROOT_LOCATION = '@OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.streamlit/streamlit'
    MAIN_FILE = 'routing.py'
   QUERY_WAREHOUSE = 'ROUTING_ANALYTICS'
   COMMENT = '{"origin":"sf_sit-is", "name":"oss-deploy-route-optimization-demo", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"streamlit"}}';
   ```

**Note:** The Streamlit app automatically detects available routing methods by reading the `ors-config.yml` from `@OPENROUTESERVICE_SETUP.PUBLIC.ORS_SPCS_STAGE`. It extracts which profiles have `enabled: true` and populates the "Choose Method" dropdowns accordingly. If the config cannot be read, it falls back to defaults: `driving-car`, `driving-hgv`, `cycling-road`.

**Output:** Streamlit application deployed with:
- Default search location set to `<NOTEBOOK_CITY>`
- Vehicle profiles matching the ORS configuration (`<ENABLED_PROFILES>`)

**Next:** Proceed to Step 10

### Step 10: Run the Demo

**Goal:** Access and use the route simulator

**Actions:**

1. **Navigate** to the Streamlit app:
   - Go to Projects > Streamlits
   - Click on **SIMULATOR**

2. **Configure** the simulation:
   - Open the sidebar
   - Select function location (Native App or API)
   - Choose industry type (Food, Health, or Cosmetics)
   - Select LLM model (recommend mistral-large2)
   - Enter location search term
   - Set distance radius in KM

3. **Select** distributor and customers:
   - Choose a wholesaler from the dropdown
   - Select customer types to deliver to
   - Set order acceptance catchment time

4. **Configure** vehicles:
   - Set start/end times for each vehicle
   - Choose vehicle profiles (car, hgv, bicycle, etc.)
   - Skills are pre-assigned per vehicle

5. **Run** optimization:
   - Click to generate optimized routes
   - View route maps, vehicle assignments, and delivery instructions

**Output:** Fully functional route optimization simulator

## Stopping Points

- Step 1: STOP if OpenRouteService Native App is not installed
- Step 2: Wait for user to activate app if services not running
- Step 3: After reading ORS config - confirm detected region and city with user
- Step 4: After getting Marketplace data - verify dataset accessible
- Step 6: After Carto notebook - verify data is populated
- Step 7: After checking Claude model - verify model is available
- Step 10: After accessing Streamlit - verify app loads correctly with correct region

## Common Issues

### Marketplace Dataset Not Found
**Symptom:** Cannot find Overture Maps dataset
**Solution:** Search for "Carto" in Marketplace, look for "Overture Maps - Places"

### Streamlit App Errors
**Symptom:** App fails to load or shows errors
**Solution:** Verify notebook was run successfully to create required tables/views

## Output

Complete Route Optimization demo with:
- Carto Overture Places dataset for POI data
- Exploration notebook with AISQL examples
- Interactive Streamlit simulator
- 3 configurable vehicles with skills
- Real-world points of interest for routing scenarios

Access via: Projects > Streamlits > SIMULATOR

Get Streamlit URL:
```sql
SELECT CONCAT('https://app.snowflake.com/', CURRENT_ORGANIZATION_NAME(), '/', CURRENT_ACCOUNT_NAME(), '/#/streamlit-apps/OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.SIMULATOR') AS streamlit_url;
```
