---
name: customize-carto-notebook
description: "Update the Add Carto Data notebook with region-specific geohash filter. Use when: changing map region to load POI data for new location. Triggers: customize carto, update poi data, change region data."
---

# Customize Carto Data Notebook

Updates the add_carto_data.ipynb notebook to load Overture Maps POI data for your chosen region.

## Prerequisites

- Active Snowflake connection
- Demo deployed with `OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR` schema
- Access to Carto Overture Maps data in Marketplace
- Access to `oss-deploy-route-optimization-demo/Notebook/add_carto_data.ipynb`

## Input Parameters

- `<NOTEBOOK_CITY>`: The city for POI data (e.g., "London", "Paris", "Berlin")
- `<GEOHASH>`: The 2-character geohash for the city

## What is a Geohash?

A geohash is a spatial encoding that divides the world into grid cells. Using a 2-character geohash filters data to a specific region (roughly city-sized area).

## Common Geohashes

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

## Workflow

### Step 1: Determine Geohash

**Goal:** Find the correct geohash for the target city

**Actions:**

1. **If you know the city center coordinates**, calculate the geohash:
   ```sql
   SELECT ST_GEOHASH(ST_MAKEPOINT(<LONGITUDE>, <LATITUDE>), 2) as geohash;
   ```

2. **Example calculations:**
   ```sql
   -- London
   SELECT ST_GEOHASH(ST_MAKEPOINT(-0.1278, 51.5074), 2);  -- Returns 'gc'
   
   -- Paris
   SELECT ST_GEOHASH(ST_MAKEPOINT(2.3522, 48.8566), 2);   -- Returns 'u0'
   
   -- Berlin
   SELECT ST_GEOHASH(ST_MAKEPOINT(13.4050, 52.5200), 2);  -- Returns 'u3'
   ```

3. **Store** the geohash as `<GEOHASH>`

**Output:** Geohash determined for target city

### Step 2: Update Notebook

**Goal:** Modify add_carto_data.ipynb with new geohash

**Actions:**

1. **Edit** the `add_carto_data` cell in `oss-deploy-route-optimization-demo/Notebook/add_carto_data.ipynb`:

   **Find** the geohash filter:
   ```sql
   WHERE ST_GEOHASH(GEOMETRY, 2) = '9q';
   ```

   **Replace** with new geohash:
   ```sql
   WHERE ST_GEOHASH(GEOMETRY, 2) = '<GEOHASH>';
   ```

2. **Update** the `prompt_multi_layer_isochrone` cell (if present):
   - Change "San Francisco" references to `<NOTEBOOK_CITY>`
   
   Example changes:
   - `"within the city of San Francisco"` → `"within the city of <NOTEBOOK_CITY>"`
   - `"Snowflake World Tour Event in San Francisco"` → `"Snowflake World Tour Event in <NOTEBOOK_CITY>"`

**Output:** Notebook updated with new geohash

### Step 3: Upload Notebook

**Goal:** Deploy updated notebook to Snowflake

**Actions:**

1. **Upload** to stage:
   ```bash
   snow stage copy "oss-deploy-route-optimization-demo/Notebook/add_carto_data.ipynb" @OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.notebook --connection <ACTIVE_CONNECTION> --overwrite
   ```

**Output:** Notebook deployed

### Step 4: Reload POI Data

**Goal:** Recreate database tables with new region's POI data

**Actions:**

1. **Create** region data table:
   ```sql
   CREATE OR REPLACE TABLE OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.REGION_DATA AS 
   SELECT * FROM OVERTURE_MAPS__PLACES.CARTO.PLACE
   WHERE ST_GEOHASH(GEOMETRY, 2) = '<GEOHASH>';
   ```

2. **Create** places table:
   ```sql
   CREATE OR REPLACE TABLE OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.PLACES AS 
   SELECT 
       GEOMETRY,
       PHONES[0]::text AS PHONES,
       CATEGORIES:primary::text AS CATEGORY,
       NAMES:primary::text AS NAME,
       ADDRESSES[0] AS ADDRESS,
       COALESCE(categories:alternate:list, ARRAY_CONSTRUCT()) AS ALTERNATE
   FROM OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.REGION_DATA
   WHERE CATEGORIES:primary IS NOT NULL;
   ```

3. **Add** search optimization:
   ```sql
   ALTER TABLE OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.PLACES 
   ADD SEARCH OPTIMIZATION ON EQUALITY(ALTERNATE);
   
   ALTER TABLE OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.PLACES 
   ADD SEARCH OPTIMIZATION ON GEO(GEOMETRY);
   ```

4. **Verify** data loaded:
   ```sql
   SELECT COUNT(*) as poi_count FROM OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.PLACES;
   ```
   - Should return significant POI count (typically 50K-500K for major cities)

5. **Check** available categories:
   ```sql
   SELECT CATEGORY, COUNT(*) as count 
   FROM OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.PLACES 
   GROUP BY CATEGORY 
   ORDER BY count DESC 
   LIMIT 20;
   ```
   - Verify expected categories exist (restaurants, hotels, shops, etc.)

**Output:** POI data loaded for new region

### Step 5: Update Simulator Default Location

**Goal:** Update routing.py default location to match new city

**Actions:**

1. **Edit** `oss-deploy-route-optimization-demo/Streamlit/routing.py`:

   **Find:**
   ```python
   place_input = st.text_input('Choose Input', 'Golden Gate Bridge, San Francisco')
   ```

   **Replace** with a landmark in `<NOTEBOOK_CITY>`:
   ```python
   place_input = st.text_input('Choose Input', '<LANDMARK>, <NOTEBOOK_CITY>')
   ```

   **Examples:**
   - London: `'Big Ben, London'`
   - Paris: `'Eiffel Tower, Paris'`
   - Berlin: `'Brandenburg Gate, Berlin'`
   - Tokyo: `'Tokyo Tower, Tokyo'`

2. **Upload** updated Streamlit:
   ```bash
   snow stage copy "oss-deploy-route-optimization-demo/Streamlit/routing.py" @OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.STREAMLIT --connection <ACTIVE_CONNECTION> --overwrite
   ```

**Output:** Simulator updated with new default location

## Verifying Data Quality

After loading data, verify quality:

```sql
-- Check POI distribution by category
SELECT CATEGORY, COUNT(*) 
FROM OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.PLACES 
GROUP BY CATEGORY 
HAVING COUNT(*) > 100
ORDER BY COUNT(*) DESC;

-- Check geographic spread
SELECT 
    MIN(ST_X(GEOMETRY)) as min_lon,
    MAX(ST_X(GEOMETRY)) as max_lon,
    MIN(ST_Y(GEOMETRY)) as min_lat,
    MAX(ST_Y(GEOMETRY)) as max_lat
FROM OPENROUTESERVICE_NATIVE_APP.VEHICLE_ROUTING_SIMULATOR.PLACES;
```

## Stopping Points

- ✋ After Step 1: Confirm geohash is correct for target city
- ✋ After Step 4: Verify POI data count is reasonable

## Output

Carto Data notebook customized for `<NOTEBOOK_CITY>` with POI data loaded from Overture Maps for the geohash region `<GEOHASH>`.
