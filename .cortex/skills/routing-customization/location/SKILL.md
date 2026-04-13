---
name: location
description: "Change the OpenRouteService map region by downloading new OSM data and updating service configuration. Subskill of routing-customization — must be invoked from the router, not independently. Use when: changing ORS map region as part of customization workflow. Do NOT use for: standalone execution, reading current config, or changing routing profiles. Triggers: change location, change map, download map, new region."
metadata:
  author: Snowflake SIT-IS
  version: 1.0.0
  category: configuration
---

# Customize Location (Map Region)

> **WARNING: This subskill cannot be run independently.** It must be invoked from the `routing-customization` router. It does not restart services, rebuild graphs, update MAP_CONFIG, or redeploy the Function Tester -- the router handles all of those in Steps 4-6 after this subskill completes.

Downloads a new OpenStreetMap region map and update the configuration files.

**This skill handles:**
1. Downloading the map data from Geofabrik or BBBike
2. Updating ors-config.yml with the new map path
3. Updating service specifications for the new region

## Prerequisites

- Active Snowflake connection
- OpenRouteService Native App deployed
- Compute resources for map download and graph building

## Input Parameters

- `<REGION_NAME>`: Target region name selected by user (e.g., "great-britain", "switzerland", "new-york")
- `<MAP_NAME>`: OSM file name (e.g., "great-britain-latest.osm.pbf")
- `<URL>`: Download URL from geofabrik.de or bbbike.org

## Error Logging

> Follow the Error Logging convention in AGENTS.md. Log file prefix: `routing-customization`.

## Workflow

### Step 1: Suspend Compute Pool

**Goal:** Suspend the compute pool to allow configuration changes

**Actions:**

1. **Suspend** the compute pool (required before altering INSTANCE_FAMILY or other properties):
   ```sql
   ALTER COMPUTE POOL OPENROUTESERVICE_NATIVE_APP_COMPUTE_POOL SUSPEND;
   ```

**Output:** Compute pool suspended

### Step 2: Download Map Data (replaces old Notebook workflow)

**Goal:** Download OSM map data locally and upload to Snowflake stage

**Note:** This step no longer requires a Snowflake Notebook, compute pool, or external access integration. The download runs locally via a Python script.

### Step 3: Download Map Data

**Goal:** Download OSM map data and upload to Snowflake stage

**Actions:**

1. **Check** if map already exists:
   ```sql
   ALTER STAGE OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SPCS_STAGE REFRESH; 
   LS @OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SPCS_STAGE;
   ```
   - If map exists, ask user if they want to re-download

2. **Run** the download script from `build-routing-solution/scripts/`:
   ```bash
   python download_map.py \
     "https://download.geofabrik.de/europe/<region>-latest.osm.pbf" \
     "<region>-latest.osm.pbf" \
     "<region>" \
     --connection <connection>
   ```
   
   **Parameters:**
   - First arg: URL of OSM PBF file (e.g., `https://download.geofabrik.de/europe/switzerland-latest.osm.pbf`)
   - Second arg: File name (e.g., `switzerland-latest.osm.pbf`)
   - Third arg: Region folder name on stage (e.g., `switzerland`)
   - `--connection`: Snowflake connection name
   
   **Note:** Large maps (>1GB) will take time to download. The script shows progress.

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

**Option A — Using WRITE_ORS_CONFIG (recommended):**
```sql
CALL OPENROUTESERVICE_NATIVE_APP.CORE.WRITE_ORS_CONFIG(
    '<REGION_NAME>',
    '<MAP_NAME>',
    'driving-car,driving-hgv,cycling-electric'  -- comma-separated profiles to enable
);
```

**Option B — Manual editing (fallback):**

1. **Edit** `.cortex/skills/build-routing-solution/native_app/provider_setup/staged_files/ors-config.yml`:
   - Change `source_file: /home/ors/files/{old-map}`
   - To: `source_file: /home/ors/files/<MAP_NAME>`

2. **Upload** to stage:
   ```bash
   snow stage copy .cortex/skills/build-routing-solution/native_app/provider_setup/staged_files/ors-config.yml @OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SPCS_STAGE/<REGION_NAME>/ --connection <ACTIVE_CONNECTION> --overwrite
   ```

**Output:** Configuration updated

### Step 5: Update Service Specification

**Goal:** Reconfigure ORS service to point to new map region

**Actions:**

1. **Edit** `.cortex/skills/build-routing-solution/native_app/services/openrouteservice/openrouteservice.yaml`:
   
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
   ```bash
   snow stage copy .cortex/skills/build-routing-solution/native_app/services/openrouteservice/openrouteservice.yaml @openrouteservice_native_app_pkg.app_src.stage/services/openrouteservice/ --connection <ACTIVE_CONNECTION> --overwrite
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

## Stopping Points

- ✋ After Step 2: Verify notebook was created without errors
- ✋ After Step 3: Confirm map download completed and check file size for resource scaling
- ✋ After Step 5: Verify service specification uploaded before returning to router

## Return to Router

After completing all steps in this subskill, return to the **routing-customization** router and continue from **Step 4: Update Routing Graphs**. This subskill does NOT restart services or rebuild graphs -- the router handles that.

## Output

Map region changed to `<REGION_NAME>`.
