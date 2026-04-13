# Notebook Deployment Reference

Detailed instructions for Steps 7 and 8 of the route-optimization workflow.

> **Note:** Step 6 (Carto data pipeline) was replaced by `seed-data.sql`. The geohash table below is retained for reference when configuring `seed-data.sql` for non-SF regions.

## Geohash Reference

The `seed-data.sql` script filters Overture Maps POI data using a 2-character geohash. Default is `'9q'` (San Francisco).

Calculate the correct geohash:
```sql
SELECT ST_GEOHASH(ST_MAKEPOINT(<LONGITUDE>, <LATITUDE>), 2) AS geohash;
```

Common geohashes:

| City | Geohash | Coverage |
|------|---------|----------|
| San Francisco | `9q` | SF Bay Area |
| New York | `dr` | NYC Metro |
| London | `gc` | Greater London |
| Paris | `u0` | Paris Region |
| Berlin | `u3` | Berlin Metro |
| Tokyo | `xn` | Tokyo Metro |
| Sydney | `r3` | Sydney Metro |
| Zurich | `u0` | Zurich Region |
| Amsterdam | `u1` | Netherlands |

## Step 7: Check for Latest Claude Model

1. Reference: https://docs.snowflake.com/en/user-guide/snowflake-cortex/aisql
2. Test model availability:
   ```sql
   SELECT AI_COMPLETE('claude-sonnet-4-5', 'Say hello') AS test_response;
   ```
3. If a newer Claude Sonnet model exists, update all occurrences in `assets/notebooks/routing_functions_aisql.ipynb` before uploading.

Current recommended model: `claude-sonnet-4-5`.

## Step 8: Deploy AISQL Notebook

### 8.1: Text Replacement Rules

> **CRITICAL — follow these rules to avoid garbled text in notebook prompts.**

1. **Never use bulk `sed` or `replace_all` on `.ipynb` files.** Notebooks are JSON with structured cell arrays. Use targeted replacements on specific cells identified by name.
2. **Replace longer phrases before shorter ones.** When multiple patterns overlap (e.g., `"WROCLAW, POLAND"` and `"Wroclaw"`), always replace the longest/most-specific match first.
3. **Replace complete prompt strings, not individual words.** When a prompt contains a city in multiple forms, rewrite the entire prompt phrase in one edit.

### 8.2: Update AI Prompt Cells

First, identify two distinct districts/neighborhoods in `<NOTEBOOK_CITY>` for `<DISTRICT_1>` and `<DISTRICT_2>`.

Code cells to update:

| Cell Name | What to Change |
|-----------|---------------|
| `simple_directions_data` | Replace "Mission District", "Financial District", "SAN FRANCISCO" with `<DISTRICT_1>`, `<DISTRICT_2>`, `<NOTEBOOK_CITY>` |
| `ten_random` | Replace "San Francisco" with `<NOTEBOOK_CITY>` |
| `gen_supplier` | Replace "San Francisco" with `<NOTEBOOK_CITY>` |
| `one_vehicle_optimisation` | Replace "San Francisco" with `<NOTEBOOK_CITY>` |
| `service_these_people` | Replace "San Francisco" with `<NOTEBOOK_CITY>` |
| `takeawaydeliveries` | Replace "San Francisco" with `<NOTEBOOK_CITY>` |
| `isochrones_try` | Replace Snowflake HQ prompt with a well-known landmark in `<NOTEBOOK_CITY>`. Rename table from `GEOCODE_SF_OFFICE` to `GEOCODE_LOCATION` (both CREATE TABLE and FROM reference). |

Markdown cells to update:

| Cell Name | What to Change |
|-----------|---------------|
| `title` | Mention `<NOTEBOOK_CITY>` |
| `heading_simple_directions` | Replace "San Francisco" |
| `create_synthetic_jobs_and_vehicle` | Replace "San Francisco" |
| `head_multi_vehicles` | Replace "San Francisco" |
| `optimal_base_table` | Replace "SAN FRANCISCO" in heading |

### 8.3: Post-Replacement Validation

> **REQUIRED — run before uploading.**

1. Verify JSON validity:
   ```bash
   python3 -c "import json; json.load(open('assets/notebooks/routing_functions_aisql.ipynb')); print('OK')"
   ```

2. Search for remnants of the old city (all case variants):
   ```bash
   grep -i '<OLD_CITY>' assets/notebooks/routing_functions_aisql.ipynb
   grep -i '<OLD_COUNTRY>' assets/notebooks/routing_functions_aisql.ipynb
   ```

3. Search for garbled patterns:
   ```bash
   grep -iE '<NOTEBOOK_CITY>.*(POLAND|Germany|Poland)' assets/notebooks/routing_functions_aisql.ipynb
   grep -i '<NOTEBOOK_CITY> IN' assets/notebooks/routing_functions_aisql.ipynb
   ```

4. Fix any artifacts before uploading.

### 8.4: Upload and Create Notebook

1. Upload:
   ```bash
   snow stage copy "assets/notebooks/routing_functions_aisql.ipynb" \
     @FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.notebook --connection <ACTIVE_CONNECTION> --overwrite
   
   snow stage copy "assets/notebooks/environment.yml" \
     @FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.notebook --connection <ACTIVE_CONNECTION> --overwrite
   ```

2. Create:
   ```sql
   CREATE OR REPLACE NOTEBOOK FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.ROUTING_FUNCTIONS_AISQL
   FROM '@FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.NOTEBOOK'
   MAIN_FILE = 'routing_functions_aisql.ipynb'
   QUERY_WAREHOUSE = 'ROUTING_ANALYTICS'
   COMMENT = '{"origin":"sf_sit-is-fleet", "name":"Route Optimization with Open Route Service", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"notebook"}}';
   
   ALTER NOTEBOOK FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.ROUTING_FUNCTIONS_AISQL ADD LIVE VERSION FROM LAST;
   ```
