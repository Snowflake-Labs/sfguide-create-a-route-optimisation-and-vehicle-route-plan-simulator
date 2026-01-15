---
name: deploy-demo
description: "Deploy the Route Optimization demo including Marketplace data, notebook, and Streamlit app. Use when: setting up the demo after native app deployment, running the demo end-to-end. Triggers: deploy demo, setup demo, run demo, deploy streamlit."
---

# Deploy Route Optimization Demo

Deploys the complete Route Optimization demo including Snowflake Marketplace data, the exploration notebook, and the Streamlit simulator application.

## Prerequisites

- OpenRouteService Native App deployed and activated (use `deploy-route-optimizer` skill first)
- Active Snowflake connection

## Workflow

### Step 1: Get Carto Overture Dataset from Marketplace

**Goal:** Acquire the Overture Maps Places dataset for point-of-interest data

**Actions:**

1. **Execute** the following SQL commands to get the dataset:
   ```sql
   CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZT0Z4CM1E9KR');
   CREATE DATABASE IF NOT EXISTS OVERTURE_MAPS__PLACES FROM LISTING GZT0Z4CM1E9KR;
   ```

**Output:** Carto Overture Places dataset available in your account as `OVERTURE_MAPS__PLACES`

**Next:** Proceed to Step 2

### Step 2: Setup Database and Schemas

**Goal:** Create required database infrastructure for the demo

**Actions:**

1. **Execute** the following SQL:
   ```sql
   ALTER ACCOUNT SET CORTEX_ENABLED_CROSS_REGION = 'ANY_REGION';
   
   CREATE DATABASE IF NOT EXISTS VEHICLE_ROUTING_SIMULATOR;
   CREATE WAREHOUSE IF NOT EXISTS ROUTING_ANALYTICS AUTO_SUSPEND = 60;
   
   CREATE SCHEMA IF NOT EXISTS VEHICLE_ROUTING_SIMULATOR.DATA;
   CREATE SCHEMA IF NOT EXISTS VEHICLE_ROUTING_SIMULATOR.NOTEBOOKS;
   CREATE SCHEMA IF NOT EXISTS VEHICLE_ROUTING_SIMULATOR.STREAMLITS;
   ```

**Output:** Database `VEHICLE_ROUTING_SIMULATOR` with DATA, NOTEBOOKS, and STREAMLITS schemas

**Next:** Proceed to Step 3

### Step 3: Deploy and Run the Notebook to add Carto data

**Goal:** Create and execute notebook that will add Carto data to the database.

**Actions:**

1. **Create** the notebook stage:
   ```sql
   CREATE STAGE IF NOT EXISTS VEHICLE_ROUTING_SIMULATOR.NOTEBOOKS.notebook 
   DIRECTORY = (ENABLE = TRUE) 
   ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE');
   ```

2. **Upload** notebook files to stage:
   ```bash
   snow stage copy "Notebook/add_carto_data.ipynb" \
     @VEHICLE_ROUTING_SIMULATOR.NOTEBOOKS.notebook --connection <connection> --overwrite
   
   snow stage copy "Notebook/environment.yml" \
     @VEHICLE_ROUTING_SIMULATOR.NOTEBOOKS.notebook --connection <connection> --overwrite
   ```

3. **Create** the notebook:
   ```sql
   CREATE OR REPLACE NOTEBOOK VEHICLE_ROUTING_SIMULATOR.NOTEBOOKS.ADD_CARTO_DATA
   FROM '@VEHICLE_ROUTING_SIMULATOR.NOTEBOOKS.NOTEBOOK'
   MAIN_FILE = 'add_carto_data.ipynb'
   QUERY_WAREHOUSE = 'ROUTING_ANALYTICS'
   COMMENT = '{"origin":"sf_sit-is", "name":"Route Optimization with Open Route Service", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"notebook"}}';
   
   ALTER NOTEBOOK VEHICLE_ROUTING_SIMULATOR.NOTEBOOKS.ADD_CARTO_DATA ADD LIVE VERSION FROM LAST;
   ```

4.  **Execute** notebook with three parameters:
   ```sql
   EXECUTE NOTEBOOK VEHICLE_ROUTING_SIMULATOR.NOTEBOOKS.ADD_CARTO_DATA()

**Output:** Notebook deployed with standing data for the Streamlit app

**Next:** Proceed to Step 4

### Step 4: Check for Latest Claude Model

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

**Next:** Proceed to Step 5

### Step 5: Deploy and Run the Notebook that will help to explore Routing functions with AISQL

**Goal:** Create and execute the notebook that will help to explore Routing functions with AISQL

**Actions:**

1. **Upload** notebook files to stage:
   ```bash
   snow stage copy "Notebook/routing_functions_aisql.ipynb" \
     @VEHICLE_ROUTING_SIMULATOR.NOTEBOOKS.notebook --connection <connection> --overwrite
   
   snow stage copy "Notebook/environment.yml" \
     @VEHICLE_ROUTING_SIMULATOR.NOTEBOOKS.notebook --connection <connection> --overwrite
   ```

2. **Create** the notebook:
   ```sql
   CREATE OR REPLACE NOTEBOOK VEHICLE_ROUTING_SIMULATOR.NOTEBOOKS.ROUTING_FUNCTIONS_AISQL
   FROM '@VEHICLE_ROUTING_SIMULATOR.NOTEBOOKS.NOTEBOOK'
   MAIN_FILE = 'routing_functions_aisql'
   QUERY_WAREHOUSE = 'ROUTING_ANALYTICS'
   COMMENT = '{"origin":"sf_sit-is", "name":"Route Optimization with Open Route Service", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"notebook"}}';
   
   ALTER NOTEBOOK VEHICLE_ROUTING_SIMULATOR.NOTEBOOKS.ROUTING_FUNCTIONS_AISQL ADD LIVE VERSION FROM LAST;
   ```

**Output:** Notebook created and ready to be explored

**Next:** Proceed to Step 6

### Step 6: Deploy the Streamlit Application

**Goal:** Deploy the route simulator Streamlit app

**Actions:**

1. **Create** the Streamlit stage:
   ```sql
   CREATE STAGE IF NOT EXISTS VEHICLE_ROUTING_SIMULATOR.STREAMLITS.STREAMLIT 
   DIRECTORY = (ENABLE = TRUE) 
   ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE');
   ```

2. **Upload** Streamlit files to stage:
   ```bash
   snow stage copy "Streamlit/routing.py" \
     @VEHICLE_ROUTING_SIMULATOR.STREAMLITS.STREAMLIT --connection <connection> --overwrite
   
   snow stage copy "Streamlit/extra.css" \
     @VEHICLE_ROUTING_SIMULATOR.STREAMLITS.STREAMLIT --connection <connection> --overwrite
   
   snow stage copy "Streamlit/environment.yml" \
     @VEHICLE_ROUTING_SIMULATOR.STREAMLITS.STREAMLIT --connection <connection> --overwrite
   
   snow stage copy "Streamlit/logo.svg" \
     @VEHICLE_ROUTING_SIMULATOR.STREAMLITS.STREAMLIT --connection <connection> --overwrite
   ```

3. **Create** the Streamlit app:
   ```sql
   CREATE OR REPLACE STREAMLIT VEHICLE_ROUTING_SIMULATOR.STREAMLITS.SIMULATOR
   ROOT_LOCATION = '@VEHICLE_ROUTING_SIMULATOR.STREAMLITS.streamlit'
   MAIN_FILE = 'routing.py'
   QUERY_WAREHOUSE = 'ROUTING_ANALYTICS'
   COMMENT = '{"origin":"sf_sit-is", "name":"Route Optimization with Open Route Service", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"Streamlit"}}';
   ```

**Note:** The Streamlit app automatically detects available routing methods by reading the `ors-config.yml` from `@OPENROUTESERVICE_SETUP.PUBLIC.ORS_SPCS_STAGE`. It extracts which profiles have `enabled: true` and populates the "Choose Method" dropdowns accordingly. If the config cannot be read, it falls back to defaults: `driving-car`, `driving-hgv`, `cycling-road`.

**Output:** Streamlit application deployed with routing methods matching native app configuration

**Next:** Proceed to Step 7

### Step 7: Run the Demo

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

- Step 1: After getting Marketplace data - verify dataset accessible
- Step 3: After notebook creation - run notebook cells manually in Snowsight
- Step 4: After checking Claude model - verify model is available and working
- Step 6: After accessing Streamlit - verify app loads correctly

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
SELECT CONCAT('https://app.snowflake.com/', CURRENT_ORGANIZATION_NAME(), '/', CURRENT_ACCOUNT_NAME(), '/#/streamlit-apps/VEHICLE_ROUTING_SIMULATOR.STREAMLITS.SIMULATOR') AS streamlit_url;
```
