---
name: location
description: "To be used as part of customize-main skill"
---

# Customize Location (Map Region)

Downloads a new OpenStreetMap region map and update the configuration files.

**This skill handles:**
1. Downloading the map data from Geofabrik or BBBike
2. Updating ors-config.yml with the new map path
3. Updating service specifications for the new region
4. Restarting services to rebuild routing graphs
5. **Updating Function Tester with new sample addresses**
6. **Upgrading the Native App to deploy the changes**

## Prerequisites

- Active Snowflake connection
- OpenRouteService Native App deployed
- Compute resources for map download and graph building

## Input Parameters

- `<REGION_NAME>`: Target region name (e.g., "great-britain", "switzerland", "new-york")
- `<MAP_NAME>`: OSM file name (e.g., "great-britain-latest.osm.pbf")
- `<URL>`: Download URL from geofabrik.de or bbbike.org

## Workflow

### Step 1: Suspend Compute Pool

**Goal:** Suspend the compute pool to allow configuration changes

**Actions:**

1. **Suspend** the compute pool (required before altering INSTANCE_FAMILY or other properties):
   ```sql
   ALTER COMPUTE POOL OPENROUTESERVICE_NATIVE_APP_COMPUTE_POOL SUSPEND;
   ```

**Output:** Compute pool suspended

### Step 2: Setup Download Notebook

**Goal:** Create required Notebook for map download

**Actions:**

1. **Execute** notebook setup SQL:
   ```sql
   CREATE OR REPLACE NETWORK RULE OPENROUTESERVICE_NATIVE_APP.CORE.DOWNLOAD_MAP_NETWORK_RULE
   MODE = EGRESS
   TYPE = HOST_PORT
   VALUE_LIST = ('download.geofabrik.de', 'download.bbbike.org');

   CREATE OR REPLACE EXTERNAL ACCESS INTEGRATION DOWNLOAD_MAP_ACCESS_INTEGRATION
   ALLOWED_NETWORK_RULES = (OPENROUTESERVICE_NATIVE_APP.CORE.DOWNLOAD_MAP_NETWORK_RULE)
   ENABLED = TRUE;
   
   CREATE COMPUTE POOL IF NOT EXISTS OPENROUTESERVICE_NATIVE_APP_NOTEBOOK_COMPUTE_POOL
   MIN_NODES = 1
   MAX_NODES = 2
   INSTANCE_FAMILY = CPU_X64_S
   AUTO_RESUME = TRUE
   AUTO_SUSPEND_SECS = 600;

   CREATE OR REPLACE NOTEBOOK OPENROUTESERVICE_NATIVE_APP.CORE.DOWNLOAD_MAP
   FROM '@OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SPCS_STAGE/Notebook'
   QUERY_WAREHOUSE = 'ROUTING_ANALYTICS' 
   RUNTIME_NAME = 'SYSTEM$BASIC_RUNTIME' 
   COMPUTE_POOL = 'OPENROUTESERVICE_NATIVE_APP_NOTEBOOK_COMPUTE_POOL' 
   MAIN_FILE = 'download_map.ipynb'
   EXTERNAL_ACCESS_INTEGRATIONS = (DOWNLOAD_MAP_ACCESS_INTEGRATION)
   COMMENT = '{"origin":"sf_sit-is", "name":"oss-build-routing-solution-in-snowflake", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"notebook"}}';

   ALTER NOTEBOOK OPENROUTESERVICE_NATIVE_APP.CORE.DOWNLOAD_MAP ADD LIVE VERSION FROM LAST;
   ```

**Output:** Download notebook created

### Step 3: Download Map Data

**Goal:** Execute notebook to download OSM map data for target region

**Actions:**

1. **Check** if map already exists:
   ```sql
   ALTER STAGE OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SPCS_STAGE REFRESH; 
   LS @OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SPCS_STAGE;
   ```
   - If map exists, ask user if they want to re-download

2. **Execute** download notebook:
   ```sql
   EXECUTE NOTEBOOK OPENROUTESERVICE_NATIVE_APP.CORE.DOWNLOAD_MAP(
     url => '<URL>',
     map_name => '<MAP_NAME>',
     region_name => '<REGION_NAME>'
   )
   ```
   
   **Parameters:**
   - `url`: Link to OSM map (e.g., `'https://download.geofabrik.de/europe/switzerland-latest.osm.pbf'`)
   - `map_name`: File name (e.g., `'switzerland-latest.osm.pbf'`)
   - `region_name`: Region name (e.g., `'switzerland'`)
   
   **Timeout:** 12000 seconds (large maps take time)

3. **Check downloaded map size** and suggest resource scaling:
   ```sql
   LS @OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SPCS_STAGE/<REGION_NAME>/;
   ```
   
   - **1GB - 5GB maps:** Suggest scaling up compute:
     ```sql
     ALTER COMPUTE POOL OPENROUTESERVICE_NATIVE_APP_COMPUTE_POOL SET INSTANCE_FAMILY = HIGHMEM_X64_M;
     ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SERVICE SET AUTO_SUSPEND_SECS = 28800;
     ```
   
   - **5GB+ maps:** Suggest larger scaling:
     ```sql
     ALTER COMPUTE POOL OPENROUTESERVICE_NATIVE_APP_COMPUTE_POOL SET INSTANCE_FAMILY = HIGHMEM_X64_M;
     ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SERVICE SET AUTO_SUSPEND_SECS = 86400;
     ```

**Output:** Map data downloaded to stage

### Step 4: Update Configuration

**Goal:** Modify ors-config.yml to reference new map file

**Actions:**

1. **Edit** `Native_app/provider_setup/staged_files/ors-config.yml`:
   - Change `source_file: /home/ors/files/{old-map}`
   - To: `source_file: /home/ors/files/<MAP_NAME>`

2. **Upload** to stage:
   ```sql
   PUT file://provider_setup/staged_files/ors-config.yml @OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SPCS_STAGE/<REGION_NAME> OVERWRITE=TRUE AUTO_COMPRESS=FALSE
   ```

**Output:** Configuration updated

### Step 5: Update Service Specification

**Goal:** Reconfigure ORS service to point to new map region

**Actions:**

1. **Edit** `Native_app/services/openrouteservice/openrouteservice.yaml`:
   
   - **Update all volume source paths** to new region:
     ```yaml
     volumes:
       - name: files
         source: "@CORE.ORS_SPCS_STAGE/<REGION_NAME>"
       - name: graphs
         source: "@CORE.ORS_GRAPHS_SPCS_STAGE/<REGION_NAME>"
       - name: elevation-cache
         source: "@CORE.ORS_ELEVATION_CACHE_SPCS_STAGE/<REGION_NAME>"
     ```

2. **Upload** specification:
   ```sql
   PUT file:///services/openrouteservice/openrouteservice.yaml @openrouteservice_native_app_pkg.app_src.stage/services/openrouteservice/ OVERWRITE=TRUE AUTO_COMPRESS=FALSE
   ```

3. **Update** service with new specification:
   ```sql
   ALTER SERVICE IF EXISTS OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SERVICE
   FROM @openrouteservice_native_app_pkg.app_src.stage 
   SPECIFICATION_FILE='/services/openrouteservice/openrouteservice.yaml';
   ```

> **_IMPORTANT: DO NOT modify the `REBUILD_GRAPHS` parameter in openrouteservice.yaml**

**Output:** Service configured for new region

## Choosing a Map Size

When the user asks to change location, **always ask if they want a city-only map or a larger region**:

> "Do you want just the **city of Paris** (faster download, quicker graph build) or the **entire France** region (larger coverage, longer build time)?"

- **City maps** (~50-200MB): Faster to download, quicker graph builds (5-15 min), perfect for demos
- **Country/Region maps** (1-10GB): Full coverage, longer build times (1-8 hours), better for production

## City-Specific Maps (BBBike.org)

For city-only maps, use **BBBike.org** which offers pre-built city extracts:

| City | URL | Approximate Size |
|------|-----|------------------|
| Paris | `https://download.bbbike.org/osm/bbbike/Paris/Paris.osm.pbf` | ~100MB |
| London | `https://download.bbbike.org/osm/bbbike/London/London.osm.pbf` | ~150MB |
| Berlin | `https://download.bbbike.org/osm/bbbike/Berlin/Berlin.osm.pbf` | ~80MB |
| New York | `https://download.bbbike.org/osm/bbbike/NewYork/NewYork.osm.pbf` | ~200MB |
| Tokyo | `https://download.bbbike.org/osm/bbbike/Tokyo/Tokyo.osm.pbf` | ~150MB |
| Sydney | `https://download.bbbike.org/osm/bbbike/Sydney/Sydney.osm.pbf` | ~80MB |
| Amsterdam | `https://download.bbbike.org/osm/bbbike/Amsterdam/Amsterdam.osm.pbf` | ~50MB |
| Munich | `https://download.bbbike.org/osm/bbbike/Muenchen/Muenchen.osm.pbf` | ~60MB |
| Barcelona | `https://download.bbbike.org/osm/bbbike/Barcelona/Barcelona.osm.pbf` | ~70MB |
| Rome | `https://download.bbbike.org/osm/bbbike/Roma/Roma.osm.pbf` | ~60MB |

> **_TIP:_** Browse all available cities at: https://download.bbbike.org/osm/bbbike/

## Country/Region Maps (Geofabrik)

For full country or region coverage, use **Geofabrik**:

| Region | URL | Approximate Size |
|--------|-----|------------------|
| Great Britain | `https://download.geofabrik.de/europe/great-britain-latest.osm.pbf` | ~1.5GB |
| France | `https://download.geofabrik.de/europe/france-latest.osm.pbf` | ~4GB |
| Germany | `https://download.geofabrik.de/europe/germany-latest.osm.pbf` | ~3.5GB |
| Switzerland | `https://download.geofabrik.de/europe/switzerland-latest.osm.pbf` | ~350MB |
| New York State | `https://download.geofabrik.de/north-america/us/new-york-latest.osm.pbf` | ~500MB |
| California | `https://download.geofabrik.de/north-america/us/california-latest.osm.pbf` | ~1GB |

> **_TIP:_** Browse all regions at: https://download.geofabrik.de/

## Output

Map region changed to `<REGION_NAME>`.
