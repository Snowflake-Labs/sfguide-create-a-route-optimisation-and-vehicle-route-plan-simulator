---
name: deploy-route-optimization-demo
description: "Deploy the Route Optimization demo including Marketplace data, notebook, and Streamlit app. Use when: setting up the route optimization demo after native app deployment. Triggers: deploy route optimization demo, setup route optimization demo, run route optimization demo."
---

# Deploy Route Optimization Demo

Deploys the complete Route Optimization demo including Snowflake Marketplace data, the exploration notebook, and the Streamlit simulator application.

## Prerequisites

- OpenRouteService Native App deployed and activated
- Active Snowflake connection

> **Note:** All `snow stage copy` commands use `--connection <ACTIVE_CONNECTION>`. Replace `<ACTIVE_CONNECTION>` with the name of your currently active Snowflake connection (e.g., run `cortex connections list` or `snow connection list` to find it).

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

### Step 3: Read Current ORS Configuration and Gather Customization Options

**Goal:** Detect the current map region and routing profiles from the ORS configuration, and gather customization preferences from the user

**Actions:**

1. **Extract** the current ORS configuration from the service definition:
   ```sql
   DESCRIBE SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SERVICE;
   ```
   - Parse the service spec from the output to find the `source_file` setting
   - Look for the map file path: `/home/ors/files/<REGION_NAME>.osm.pbf`
   - Extract `<REGION_NAME>` (e.g., "SanFrancisco", "great-britain-latest", "paris")
   - This determines the `<REGION_NAME>` for the demo

2. **Extract** the enabled vehicle profiles from the same `DESCRIBE SERVICE` output:
   - The `spec` column contains the full service YAML including the `ors-config.yml` content. Parse it for `profiles:` entries with `enabled: true`.
   - **Do NOT** read the config file separately from the stage — the `DESCRIBE SERVICE` output already contains all the information needed.
   - Common profiles: `driving-car`, `driving-hgv`, `cycling-road`, `cycling-regular`, `foot-walking`
   - Store the list of enabled profiles

3. **Determine the city for the demo:**
   - If map is a city (e.g., "SanFrancisco", "Paris", "London"): Use that city name
   - If map is a region/country (e.g., "great-britain", "germany"): Ask user which city within that region to use for sample data

4. **Ask user about industry customization:**
   - "Do you want to customize industries? Default industries are: **Food**, **Healthcare**, **Cosmetics**."
   - If YES: Gather industry specifications (see Industry Customization Reference below)
   - If NO: Use defaults — proceed with no changes to the notebook

5. **Store configuration for later steps:**
   - `<REGION_NAME>`: The region name
   - `<NOTEBOOK_CITY>`: The city to use for AI-generated sample data
   - `<ENABLED_PROFILES>`: List of enabled vehicle profiles
   - `<CUSTOM_INDUSTRIES>`: Whether user wants custom industries (YES/NO) and their specifications

**Output:** Current ORS configuration detected:
- Map Region: `<REGION_NAME>`
- Demo City: `<NOTEBOOK_CITY>`
- Vehicle Profiles: `<ENABLED_PROFILES>`
- Custom Industries: `<CUSTOM_INDUSTRIES>` (YES with specs, or NO for defaults)

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

### Step 6: Deploy and Run the Carto Data Notebook (Customized for Region)

**Goal:** Customize the Carto data notebook for `<REGION_NAME>`, optionally customize industries, then deploy and execute it.

**Actions:**

#### 6.1: Determine the Geohash for the Target City

The notebook filters Overture Maps POI data using a 2-character geohash. The default is `'9q'` (San Francisco). Calculate the correct geohash for `<NOTEBOOK_CITY>`:

```sql
SELECT ST_GEOHASH(ST_MAKEPOINT(<LONGITUDE>, <LATITUDE>), 2) AS geohash;
```

Common geohashes for reference:

| City | Geohash | Approximate Coverage |
|------|---------|---------------------|
| San Francisco | `9q` | SF Bay Area |
| New York | `dr` | NYC Metro |
| London | `gc` | Greater London |
| Paris | `u0` | Paris Region |
| Berlin | `u3` | Berlin Metro |
| Tokyo | `xn` | Tokyo Metro |
| Sydney | `r3` | Sydney Metro |
| Zurich | `u0` | Zurich Region |
| Amsterdam | `u1` | Netherlands |

**If the notebook's geohash already matches `<NOTEBOOK_CITY>`**: Skip modification of the geohash filter.

#### 6.2: Update the Carto Notebook

1. **Edit** the `add_carto_data` cell in `oss-deploy-route-optimization-demo/Notebook/add_carto_data.ipynb`:

   **Find** the current geohash filter (default is `'9q'` for San Francisco):
   ```sql
   WHERE ST_GEOHASH(GEOMETRY, 2) = '9q';
   ```

   **Replace** with the new geohash:
   ```sql
   WHERE ST_GEOHASH(GEOMETRY, 2) = '<GEOHASH>';
   ```

2. **Update** the `prompt_multi_layer_isochrone` cell (if present):
   - Change any city references (e.g., "San Francisco") to `<NOTEBOOK_CITY>`
   - Example: `"within the city of San Francisco"` becomes `"within the city of <NOTEBOOK_CITY>"`

#### 6.3: Customize Industries (if `<CUSTOM_INDUSTRIES>` = YES)

If the user requested custom industries in Step 3, update Cell 15 (the LOOKUP INSERT) in `add_carto_data.ipynb`:

1. **Replace** the existing INSERT statement with the user's custom industries. The format is:
   ```sql
   CREATE TABLE IF NOT EXISTS OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.LOOKUP (
       INDUSTRY VARCHAR,
       PA VARCHAR,
       PB VARCHAR,
       PC VARCHAR,
       IND ARRAY,
       IND2 ARRAY,
       CTYPE ARRAY,
       STYPE ARRAY
   );
   
   INSERT INTO OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.LOOKUP
   SELECT '<Industry1>', '<Product A>', '<Product B>', '<Product C>',
          ARRAY_CONSTRUCT('<keywords>'), ARRAY_CONSTRUCT('warehouse', 'distribution', 'depot'),
          ARRAY_CONSTRUCT('<customer_type1>', '<customer_type2>'),
          ARRAY_CONSTRUCT('<skill1>', '<skill2>', '<skill3>')
   UNION ALL
   SELECT '<Industry2>', ...
   UNION ALL
   SELECT '<Industry3>', ...;
   ```

2. Each industry needs:

   | Field | Purpose | Description |
   |-------|---------|-------------|
   | `INDUSTRY` | Display name | Shown in Streamlit sidebar dropdown |
   | `PA` | Product type 1 (Skill 1) | Product requiring specialized handling |
   | `PB` | Product type 2 (Skill 2) | Product needing careful handling |
   | `PC` | Product type 3 (Skill 3) | Standard delivery product |
   | `IND` | Supplier keywords | Keywords to find suppliers/distributors in POI data |
   | `IND2` | Supplier location types | Keywords for supplier location types (e.g., warehouse, depot) |
   | `CTYPE` | Customer categories | Overture Maps place categories that are customers for this industry |
   | `STYPE` | Vehicle skills | Delivery capability labels assigned to vehicles (one per product type) |

> **Note:** The Streamlit app reads industries dynamically from the `LOOKUP` table. No Streamlit code changes are needed when changing industries.

#### 6.4: Upload and Execute

1. **Create** the notebook stage:
   ```sql
   CREATE STAGE IF NOT EXISTS OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.notebook 
   DIRECTORY = (ENABLE = TRUE) 
   ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE');
   ```

2. **Upload** notebook files to stage:
   ```bash
   snow stage copy "oss-deploy-route-optimization-demo/Notebook/add_carto_data.ipynb" \
     @OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.notebook --connection <ACTIVE_CONNECTION> --overwrite
   
   snow stage copy "oss-deploy-route-optimization-demo/Notebook/environment.yml" \
     @OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.notebook --connection <ACTIVE_CONNECTION> --overwrite
   ```

3. **Create** the notebook:
   ```sql
   CREATE OR REPLACE NOTEBOOK OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.ADD_CARTO_DATA
   FROM '@OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.NOTEBOOK'
   MAIN_FILE = 'add_carto_data.ipynb'
   QUERY_WAREHOUSE = 'ROUTING_ANALYTICS'
   COMMENT = '{"origin":"sf_sit-is", "name":"Route Optimization with Open Route Service", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"notebook"}}';
   
   ALTER NOTEBOOK OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.ADD_CARTO_DATA ADD LIVE VERSION FROM LAST;
   ```

4. **Execute** notebook:
   ```sql
   EXECUTE NOTEBOOK OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.ADD_CARTO_DATA();
   ```

5. **Verify** notebook created the required tables:
   ```sql
   SELECT 'PLACES' AS TABLE_NAME, COUNT(*) AS ROW_COUNT FROM OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.PLACES
   UNION ALL
   SELECT 'LOOKUP', COUNT(*) FROM OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.LOOKUP
   UNION ALL
   SELECT 'JOB_TEMPLATE', COUNT(*) FROM OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.JOB_TEMPLATE;
   ```
   - `PLACES` should have a significant row count (typically 50K-500K depending on the region)
   - `LOOKUP` should have 3 rows (one per default industry) or the number of custom industries
   - `JOB_TEMPLATE` should have 29 rows
   - **STOP** if any table has 0 rows — the notebook execution likely failed. Check notebook logs before proceeding.

6. **If custom industries were configured**, verify them:
   ```sql
   SELECT INDUSTRY, PA, PB, PC, CTYPE, STYPE 
   FROM OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.LOOKUP;
   ```

**Output:** Notebook deployed and verified with standing data for `<NOTEBOOK_CITY>`

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

#### 8.1: Identify Cells to Update

Open `oss-deploy-route-optimization-demo/Notebook/routing_functions_aisql.ipynb` and check whether city references already match `<NOTEBOOK_CITY>`.

**If they already match**: Skip modification and proceed directly to sub-step 8.3 (upload).

**If they differ**: Update the following cells, observing the replacement rules below.

#### 8.1.1: Text Replacement Rules

> **IMPORTANT — follow these rules to avoid garbled text in notebook prompts.**

1. **Never use bulk `sed` or `replace_all` on `.ipynb` files.** Notebooks are JSON with structured cell arrays. Use the Edit tool to make targeted replacements on specific cells identified by name.

2. **Replace longer phrases before shorter ones.** When multiple patterns overlap (e.g., `"WROCLAW, POLAND"` and `"Wroclaw"`), always replace the longest/most-specific match first. Otherwise, partial replacements produce garbled text like `"San Francisco, POLAND"`.

3. **Replace complete prompt strings, not individual words.** When a prompt contains a city in multiple forms (e.g., `"in Wroclaw IN WROCLAW, POLAND"`), rewrite the entire prompt phrase in one edit (e.g., `"in San Francisco"`) rather than doing separate word-level substitutions that can stack incorrectly.

#### 8.2: Update AI Prompt Cells

First, identify two distinct districts/neighborhoods in `<NOTEBOOK_CITY>` for `<DISTRICT_1>` and `<DISTRICT_2>` (e.g., "Westminster" and "Canary Wharf" for London).

Update these code cells:

| Cell Name | What to Change |
|-----------|---------------|
| `simple_directions_data` | Replace "Mission District", "Financial District", "SAN FRANCISCO" with `<DISTRICT_1>`, `<DISTRICT_2>`, `<NOTEBOOK_CITY>` |
| `ten_random` | Replace "San Francisco" with `<NOTEBOOK_CITY>` |
| `gen_supplier` | Replace "San Francisco" with `<NOTEBOOK_CITY>` |
| `one_vehicle_optimisation` | Replace "San Francisco" with `<NOTEBOOK_CITY>` |
| `service_these_people` | Replace "San Francisco" with `<NOTEBOOK_CITY>` |
| `takeawaydeliveries` | Replace "San Francisco" with `<NOTEBOOK_CITY>` |
| `isochrones_try` | **CRITICAL:** Replace `'give me the lat and lon for the Snowflake headquarters at 106 E Babcock St, Bozeman, MT or alternatively 450 Concar Dr, San Mateo, CA 94402.  return the result as a json string'` with `'give me the lat and lon for a well-known landmark or central location in <NOTEBOOK_CITY>.  return the result as a json string'`. Also rename table from `GEOCODE_SF_OFFICE` to `GEOCODE_LOCATION` (both the CREATE TABLE and FROM reference). |

Update these markdown cells:

| Cell Name | What to Change |
|-----------|---------------|
| `title` | Mention `<NOTEBOOK_CITY>` in the title |
| `heading_simple_directions` | Replace "San Francisco" with `<NOTEBOOK_CITY>` |
| `create_synthetic_jobs_and_vehicle` | Replace "San Francisco" with `<NOTEBOOK_CITY>` |
| `head_multi_vehicles` | Replace "San Francisco" with `<NOTEBOOK_CITY>` |
| `optimal_base_table` | Replace "SAN FRANCISCO" with `<NOTEBOOK_CITY>` in heading |

#### 8.2.1: Post-Replacement Validation

> **REQUIRED — run these checks before uploading the notebook.**

1. **Verify JSON validity** of the modified `.ipynb` file:
   ```bash
   python3 -c "import json; json.load(open('oss-deploy-route-optimization-demo/Notebook/routing_functions_aisql.ipynb')); print('OK')"
   ```

2. **Search for remnants of the old city** in the notebook. Grep for the old city name (all case variants) and any associated country/region name (e.g., `POLAND`, `Germany`):
   ```bash
   grep -i '<OLD_CITY>' oss-deploy-route-optimization-demo/Notebook/routing_functions_aisql.ipynb
   grep -i '<OLD_COUNTRY>' oss-deploy-route-optimization-demo/Notebook/routing_functions_aisql.ipynb
   ```

3. **Search for garbled patterns** — duplicate or stacked city references that indicate a bad replacement:
   ```bash
   grep -iE '<NOTEBOOK_CITY>.*(POLAND|Germany|Poland)' oss-deploy-route-optimization-demo/Notebook/routing_functions_aisql.ipynb
   grep -i '<NOTEBOOK_CITY> IN' oss-deploy-route-optimization-demo/Notebook/routing_functions_aisql.ipynb
   ```

4. **If any artifacts are found**, fix them before proceeding to upload. Do not skip this step.

#### 8.3: Upload and Create Notebook

1. **Upload** notebook files to stage:
   ```bash
   snow stage copy "oss-deploy-route-optimization-demo/Notebook/routing_functions_aisql.ipynb" \
     @OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.notebook --connection <ACTIVE_CONNECTION> --overwrite
   
   snow stage copy "oss-deploy-route-optimization-demo/Notebook/environment.yml" \
     @OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.notebook --connection <ACTIVE_CONNECTION> --overwrite
   ```

2. **Create** the notebook:
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

#### 9.1: Update Streamlit Default Location

Open `oss-deploy-route-optimization-demo/Streamlit/routing.py` and find the `place_input` default value:
```python
place_input = st.text_input('Choose Input', 'Golden Gate Bridge, San Francisco')
```

**If it already matches `<NOTEBOOK_CITY>`**: Skip modification.

**If it differs**: Update to a well-known landmark in `<NOTEBOOK_CITY>`:

| City | Landmark |
|------|----------|
| London | `'Big Ben, London'` |
| Paris | `'Eiffel Tower, Paris'` |
| Berlin | `'Brandenburg Gate, Berlin'` |
| Zurich | `'Zurich Main Station, Zurich'` |
| New York | `'Empire State Building, New York'` |
| Tokyo | `'Tokyo Tower, Tokyo'` |
| Sydney | `'Sydney Opera House, Sydney'` |

For other cities, choose a well-known central landmark.

#### 9.2: Deploy

1. **Create** the Streamlit stage:
   ```sql
   CREATE STAGE IF NOT EXISTS OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.STREAMLIT 
   DIRECTORY = (ENABLE = TRUE) 
   ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE');
   ```

2. **Upload** Streamlit files to stage:
   ```bash
   snow stage copy "oss-deploy-route-optimization-demo/Streamlit/routing.py" \
     @OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.STREAMLIT --connection <ACTIVE_CONNECTION> --overwrite
   
   snow stage copy "oss-deploy-route-optimization-demo/Streamlit/extra.css" \
     @OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.STREAMLIT --connection <ACTIVE_CONNECTION> --overwrite
   
   snow stage copy "oss-deploy-route-optimization-demo/Streamlit/environment.yml" \
     @OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.STREAMLIT --connection <ACTIVE_CONNECTION> --overwrite
   
   snow stage copy "oss-deploy-route-optimization-demo/Streamlit/logo.svg" \
     @OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.STREAMLIT --connection <ACTIVE_CONNECTION> --overwrite

   snow stage copy "oss-deploy-route-optimization-demo/Streamlit/config.toml" \
     @OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.STREAMLIT --connection <ACTIVE_CONNECTION> --overwrite
   ```

3. **Create** the Streamlit app:
   ```sql
   CREATE OR REPLACE STREAMLIT OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.SIMULATOR
    FROM  @OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.STREAMLIT
    MAIN_FILE = 'routing.py'
   QUERY_WAREHOUSE = 'ROUTING_ANALYTICS'
   COMMENT = '{"origin":"sf_sit-is", "name":"oss-deploy-route-optimization-demo", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"streamlit"}}';

   ALTER STREAMLIT OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.SIMULATOR ADD LIVE VERSION FROM LAST;
   ```

**Note:** The Streamlit app automatically detects available routing methods by reading the `ors-config.yml` from `@OPENROUTESERVICE_SETUP.PUBLIC.ORS_SPCS_STAGE`. It extracts which profiles have `enabled: true` and populates the "Choose Method" dropdowns accordingly. If the config cannot be read, it falls back to defaults: `driving-car`, `driving-hgv`, `cycling-road`.

**Output:** Streamlit application deployed with:
- Default search location set to `<NOTEBOOK_CITY>`
- Vehicle profiles matching the ORS configuration (`<ENABLED_PROFILES>`)

**Next:** Proceed to Step 10

### Step 10: Run the Demo

**Goal:** Access and use the route simulator

**Actions:**

1. **Access Streamlit app**:
   - Access via provided Streamlit URL

2. **Configure** the simulation:
   - Open the sidebar
   - Select function location (Native App or API)
   - Choose industry type (from configured industries)
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

## Industry Customization Reference

### Default Industries

| Industry | Products (PA/PB/PC) | Customers |
|----------|----------|-----------|
| **Food** | Fresh goods, Frozen goods, Non-perishable | Supermarkets, Restaurants, Butchers |
| **Healthcare** | Pharmaceutical supplies, Medical equipment, OTC | Hospitals, Pharmacies, Dentists |
| **Cosmetics** | Hair products, Electronics, Make-up | Retail outlets, Salons |

### Gathering Custom Industry Specifications

For each custom industry, collect:

| Field | Purpose | Example Question |
|-------|---------|-----------------|
| `INDUSTRY` | Display name | "What should this industry be called?" |
| `PA` | Product type 1 (Skill 1) | "What product requires specialized handling?" |
| `PB` | Product type 2 (Skill 2) | "What product needs careful handling?" |
| `PC` | Product type 3 (Skill 3) | "What product is standard delivery?" |
| `IND` | Supplier keywords | "Keywords to find suppliers/distributors?" |
| `CTYPE` | Customer categories | "What types of businesses receive these products?" |
| `STYPE` | Vehicle skills | "What delivery capabilities are needed per product type?" |

### Example Custom Industries

**Beverages:**
```sql
SELECT 'Beverages', 'Alcoholic Beverages', 'Carbonated Drinks', 'Still Water',
       ARRAY_CONSTRUCT('beverage drink brewery distillery bottling winery'),
       ARRAY_CONSTRUCT('warehouse distribution depot factory wholesaler'), 
       ARRAY_CONSTRUCT('bar', 'pub', 'restaurant', 'hotel', 'supermarket', 'convenience_store'),
       ARRAY_CONSTRUCT('Age Verification Required', 'Fragile Goods Handler', 'Heavy Load Capacity')
```

**Electronics:**
```sql
SELECT 'Electronics', 'High-Value Items', 'Fragile Equipment', 'Standard Electronics',
       ARRAY_CONSTRUCT('electronics computer phone appliance tech hardware'),
       ARRAY_CONSTRUCT('warehouse distribution depot factory wholesaler'), 
       ARRAY_CONSTRUCT('electronics_store', 'computer_store', 'mobile_phone_shop', 'department_store'),
       ARRAY_CONSTRUCT('Secure Transport', 'Fragile Goods Handler', 'Standard Delivery')
```

### Discovering Available Customer Categories

After the Carto notebook runs, query available Overture Maps categories to validate `CTYPE` values:
```sql
SELECT DISTINCT CATEGORY, COUNT(*) AS COUNT 
FROM OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.PLACES 
GROUP BY CATEGORY 
ORDER BY COUNT DESC 
LIMIT 50;
```
Recommend categories with 100+ POIs for reliable demo results.

## Stopping Points

- Step 1: STOP if OpenRouteService Native App is not installed
- Step 2: Wait for user to activate app if services not running
- Step 3: After reading ORS config - confirm detected region, city, and industry choices with user
- Step 4: After getting Marketplace data - verify dataset accessible
- Step 6: After Carto notebook - verify PLACES, LOOKUP, and JOB_TEMPLATE tables are populated
- Step 7: After checking Claude model - verify model is available
- Step 10: After accessing Streamlit - verify app loads correctly with correct region

## Troubleshooting

| Issue | Symptom | Solution |
|-------|---------|----------|
| Marketplace access denied | `CALL SYSTEM$ACCEPT_LEGAL_TERMS` fails with insufficient privileges | Requires ACCOUNTADMIN role or IMPORT SHARE privilege |
| Marketplace dataset not found | Cannot find Overture Maps dataset | Search for "Carto" in Marketplace, look for "Overture Maps - Places" |
| Notebook execution fails | `EXECUTE NOTEBOOK` returns errors | Check notebook logs in Snowsight; verify `OVERTURE_MAPS__PLACES` database is accessible and `ROUTING_ANALYTICS` warehouse is active |
| Cortex model unavailable | `AI_COMPLETE` returns "model not found" or region error | Check the model is available in your region; try a fallback model or set `CORTEX_ENABLED_CROSS_REGION = 'ANY_REGION'` |
| Services not starting | `SHOW SERVICES` shows SUSPENDED or FAILED status | Resume services with `ALTER SERVICE ... RESUME`; check compute pool has capacity |
| Streamlit app errors | App fails to load or shows errors | Verify notebook was run successfully and PLACES, LOOKUP, JOB_TEMPLATE tables are populated |
| Stage upload fails | `snow stage copy` returns permission error | Verify you have WRITE privilege on the target stage and the correct `--connection` is specified |
| Wrong POI data region | PLACES table has data for wrong city | Verify geohash in Step 6.1 matches target city; re-run notebook after fixing |
| Custom industries not showing | Streamlit dropdown shows old industries | Verify LOOKUP table has correct rows via SQL; re-run `$deploy-route-optimization-demo` from Step 6 |

## Recovery

If deployment fails mid-way, re-running the skill is safe:
- All `CREATE STAGE` and `CREATE SCHEMA` statements use `IF NOT EXISTS`
- All `CREATE NOTEBOOK` and `CREATE STREAMLIT` statements use `OR REPLACE`
- `snow stage copy` uses `--overwrite` for idempotent uploads
- The Marketplace listing (`CREATE DATABASE IF NOT EXISTS ... FROM LISTING`) is also safe to re-run

No manual cleanup is needed. Simply fix the underlying issue (e.g., permissions, service state) and re-run from the failed step onward.

## Output

Complete Route Optimization demo with:
- Carto Overture Places dataset for POI data
- Exploration notebook with AISQL examples
- Interactive Streamlit simulator
- 3 configurable vehicles with skills
- Real-world points of interest for routing scenarios

Access app via Streamlit URL:
```sql
SELECT CONCAT('https://app.snowflake.com/', CURRENT_ORGANIZATION_NAME(), '/', CURRENT_ACCOUNT_NAME(), '/#/streamlit-apps/OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.SIMULATOR') AS streamlit_url;
```
