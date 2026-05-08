---
name: upload-map-files
description: "Subskill of build-routing-solution. Uploads OSM map files and ORS configuration to Snowflake stage with workspace-aware path handling. Handles nested path workarounds, validates uploads, updates service configuration. Use when: uploading map data, staging OSM files, configuring ORS profiles. Do NOT use for: building images, deploying services, or managing service lifecycle. Triggers: upload map, stage OSM file, upload SanFrancisco.osm.pbf, upload ors-config.yml, Step 4 of build-routing-solution."
metadata:
  author: Snowflake SIT-IS
  version: 1.0.0
  category: infrastructure
---

# Upload Map Files to ORS Stage

Uploads OpenStreetMap (OSM) map data and ORS configuration files to Snowflake stage for routing graph generation. Handles workspace vs CLI environment differences and validates successful uploads.

## Prerequisites

1. **ORS infrastructure deployed** (database, schemas, stages created via build-routing-solution Step 1-3)
2. **Service specification files uploaded** (Step 4a completed)
3. **Map files available** in workspace at `.cortex/skills/build-routing-solution/openrouteservice_app/staged_files/`

## Required Files

| File | Size | Purpose | Required |
|------|------|---------|----------|
| `SanFrancisco.osm.pbf` | ~25 MB | OpenStreetMap data for San Francisco region | **MANDATORY** |
| `ors-config.yml` | ~2 KB | ORS routing profiles configuration | **MANDATORY** |

**CRITICAL:** Without these files, ORS service will start but **all routing requests will fail** with "profile unknown" errors.

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `REGION_NAME` | `SanFrancisco` | Target region name (must match service spec) |
| `OSM_FILE` | `SanFrancisco.osm.pbf` | OSM map filename |
| `CONFIG_FILE` | `ors-config.yml` | ORS configuration filename |
| `TARGET_STAGE` | `@OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/SanFrancisco/` | Destination stage path |
| `WORKSPACE_STAGE_URI` | `snow://workspace/<DB>.<SCHEMA>.<NAME>/versions/live/` | Workspace stage URI |

## Error Logging

> Follow the Error Logging convention in AGENTS.md. Log file prefix: `upload-map-files`.

---

## Workflow

### Step 1: Detect Execution Environment

**Goal:** Determine if running in Snowflake Workspace or local CLI environment

**Actions:**

1. **Check** if `snow stage copy` command is available:
   - **CLI Environment:** `snow --help` succeeds → Use CLI workflow (Step 2a)
   - **Workspace Environment:** `snow --help` fails or not available → Use Workspace workflow (Step 2b)

2. **Get workspace stage URI** (Workspace only):
   ```
   Format: snow://workspace/<DATABASE>.<SCHEMA>.<WORKSPACE_NAME>/versions/live/
   Example: snow://workspace/USER$.PUBLIC."sfguide-build-fleet-intelligence-with-cortex-code"/versions/live/
   ```
   
   The workspace stage URI is provided in system context.

**Output:** Environment detected (CLI or Workspace) and workspace URI retrieved if needed

---

### Step 2a: CLI Upload Workflow (Standard Environment)

**Goal:** Upload map and config files using Snow CLI commands

**Actions:**

1. **Upload ORS configuration file:**
   ```bash
   snow stage copy ".cortex/skills/build-routing-solution/openrouteservice_app/staged_files/ors-config.yml" \
     @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/SanFrancisco/ --connection <connection> --overwrite
   ```

2. **Upload San Francisco OSM map file (~25MB):**
   ```bash
   snow stage copy ".cortex/skills/build-routing-solution/openrouteservice_app/staged_files/SanFrancisco.osm.pbf" \
     @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/SanFrancisco/ --connection <connection> --overwrite
   ```

**Expected Duration:** 30-60 seconds (depends on network speed)

**Output:** Files uploaded to stage at flat paths

**Next:** Proceed to Step 3 (Verify Uploads)

---

### Step 2b: Workspace Upload Workflow (Workspace Environment)

**Goal:** Upload map and config files from Snowflake Workspace

**CRITICAL LIMITATION:** Workspace `COPY FILES` command preserves source directory structure, creating nested paths. We must handle this with a workaround.

#### Step 2b.1: Upload ORS Configuration File

**Actions:**

1. **Read** the config file from workspace:
   ```
   Use read tool: .cortex/skills/build-routing-solution/openrouteservice_app/staged_files/ors-config.yml
   ```

2. **Verify required profiles are enabled** in the config:
   - `driving-car: enabled: true`
   - `cycling-regular: enabled: true`
   - `cycling-electric: enabled: true`
   
   If any are `enabled: false`, set them to `enabled: true`.

3. **Write** the config to workspace root (flat path, no subdirectories):
   ```
   Use write tool: ors-config.yml (at workspace root)
   ```

4. **Upload** from workspace root to stage:
   ```sql
   COPY FILES INTO @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/SanFrancisco/
   FROM '<WORKSPACE_STAGE_URI>'
   FILES=('ors-config.yml');
   ```
   
   **Expected Result:** `SanFrancisco/ors-config.yml` uploaded (flat path ✅)

**Output:** `ors-config.yml` uploaded to stage at flat path

#### Step 2b.2: Upload OSM Map File (25MB Binary)

**CRITICAL:** The OSM file is 25MB and binary - cannot be read/written with workspace text tools. Must use SQL-based stage copy.

**Actions:**

1. **Create temporary stage** for intermediate copy:
   ```sql
   CREATE OR REPLACE TEMPORARY STAGE temp_map_stage;
   ```

2. **Copy OSM file from workspace to temp stage:**
   ```sql
   COPY FILES INTO @temp_map_stage/
   FROM '<WORKSPACE_STAGE_URI>'
   FILES=('.cortex/skills/build-routing-solution/openrouteservice_app/staged_files/SanFrancisco.osm.pbf');
   ```
   
   **Result:** File will be at nested path in temp stage:
   ```
   @temp_map_stage/.cortex/skills/build-routing-solution/openrouteservice_app/staged_files/SanFrancisco.osm.pbf
   ```

3. **List temp stage to confirm nested structure:**
   ```sql
   LIST @temp_map_stage;
   ```
   
   Verify the file exists at the nested path with size ~25,103,536 bytes.

4. **Copy from temp stage to ORS stage using PATTERN:**
   ```sql
   COPY FILES INTO @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/SanFrancisco/
   FROM @temp_map_stage
   PATTERN='.*SanFrancisco.osm.pbf';
   ```
   
   **Result:** File will still have nested path at destination:
   ```
   @ORS_SPCS_STAGE/SanFrancisco/.cortex/skills/.../SanFrancisco.osm.pbf
   ```
   
   **This is expected behavior** - Snowflake COPY FILES always preserves source structure.

5. **Verify the nested upload:**
   ```sql
   LIST @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/SanFrancisco/;
   ```
   
   Confirm file exists at nested path with correct size (~25 MB).

**Output:** `SanFrancisco.osm.pbf` uploaded at nested path (this is correct for workspace)

#### Step 2b.3: Update ORS Configuration for Nested Path

**CRITICAL:** Since the OSM file is at a nested path, we must update the `ors-config.yml` to point to it.

**Actions:**

1. **Read** the `ors-config.yml` file currently at workspace root

2. **Update** the `source_file` path in the config to point to the nested location:
   ```yaml
   ors:
     engine:
       profile_default:
         build:
           source_file: /home/ors/files/.cortex/skills/build-routing-solution/openrouteservice_app/staged_files/SanFrancisco.osm.pbf
   ```
   
   **Explanation:** The ORS service mounts `@ORS_SPCS_STAGE/SanFrancisco` to `/home/ors/files`, so:
   - Stage path: `@stage/SanFrancisco/.cortex/.../SanFrancisco.osm.pbf`
   - Container path: `/home/ors/files/.cortex/.../SanFrancisco.osm.pbf`

3. **Write** the updated config back to workspace root

4. **Re-upload** the updated config to stage (overwrite):
   ```sql
   COPY FILES INTO @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/SanFrancisco/
   FROM '<WORKSPACE_STAGE_URI>'
   FILES=('ors-config.yml');
   ```

**Output:** `ors-config.yml` updated with correct nested path for OSM file

**Next:** Proceed to Step 3 (Verify Uploads)

---

### Step 3: Verify Uploads (MANDATORY)

**Goal:** Confirm all required files are present in stage with correct sizes

**CRITICAL:** This step is **MANDATORY**. Do NOT proceed without verifying uploads. Missing or incorrectly uploaded files cause silent failures that are difficult to debug later.

**Actions:**

1. **List all files in the target stage directory:**
   ```sql
   LIST @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/SanFrancisco/;
   ```

2. **Verify required files with size validation:**

   | File Pattern | Expected Size | Status Check |
   |--------------|---------------|--------------|
   | `**/SanFrancisco.osm.pbf` | 25,000,000 - 26,000,000 bytes (~25 MB) | **MANDATORY** |
   | `SanFrancisco/ors-config.yml` | 1,500 - 5,000 bytes (~2 KB) | **MANDATORY** |
   | `services/openrouteservice/openrouteservice.yaml` | ~800 bytes | Required (Step 4a) |
   | `services/ors_control_app/ors_control_app_service.yaml` | ~500 bytes | Required (Step 4a) |

3. **Check for nested vs flat paths:**
   
   **CLI Environment (Expected):**
   ```
   ✅ ors_spcs_stage/SanFrancisco/SanFrancisco.osm.pbf (flat path)
   ✅ ors_spcs_stage/SanFrancisco/ors-config.yml (flat path)
   ```
   
   **Workspace Environment (Expected):**
   ```
   ✅ ors_spcs_stage/SanFrancisco/.cortex/.../SanFrancisco.osm.pbf (nested path)
   ✅ ors_spcs_stage/SanFrancisco/ors-config.yml (flat path)
   ```
   
   **Both are valid** - the `ors-config.yml` source_file path is adjusted accordingly.

4. **Verify ors-config.yml contents:**
   ```sql
   SELECT $1 AS config_content 
   FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/SanFrancisco/ors-config.yml
   (FILE_FORMAT => (TYPE = 'CSV' FIELD_DELIMITER = NONE RECORD_DELIMITER = NONE SKIP_HEADER = 0));
   ```
   
   Confirm the config contains:
   - **CLI:** `source_file: /home/ors/files/SanFrancisco.osm.pbf`
   - **Workspace:** `source_file: /home/ors/files/.cortex/.../SanFrancisco.osm.pbf`
   - `driving-car: enabled: true`
   - `cycling-regular: enabled: true`
   - `cycling-electric: enabled: true`

5. **Check for common issues:**

   ❌ **FAIL:** OSM file size < 20 MB → File corrupted or incomplete upload
   ❌ **FAIL:** OSM file missing → Upload failed, re-run Step 2
   ❌ **FAIL:** Config file missing → Upload failed, re-run Step 2
   ❌ **FAIL:** Config has wrong source_file path → ORS won't find map file
   ❌ **FAIL:** Required profiles disabled in config → Routing will fail

**If verification fails:**

- **Missing files:** Re-run Step 2 (upload workflow)
- **Wrong file sizes:** File may be corrupted - check source file and re-upload
- **Nested paths in CLI environment:** Should not happen - check workspace detection
- **Wrong source_file path:** Re-run Step 2b.3 to update config

**Output:** All required files verified in stage with correct sizes and paths

**Next:** Proceed to Step 4 (Restart ORS Service) ONLY if all verifications pass

---

### Step 4: Restart ORS Service

**Goal:** Restart ORS service to load new map files and build routing graphs

**Actions:**

1. **Suspend ORS service:**
   ```sql
   ALTER SERVICE OPENROUTESERVICE_APP.CORE.ORS_SERVICE SUSPEND;
   ```
   
   Wait for service to reach SUSPENDED status (check with `SHOW SERVICES`).

2. **Resume ORS service:**
   ```sql
   ALTER SERVICE OPENROUTESERVICE_APP.CORE.ORS_SERVICE RESUME;
   ```
   
   Service will start and begin building routing graphs from the uploaded map file.

3. **Monitor service status:**
   ```sql
   SHOW SERVICES LIKE 'ORS_SERVICE' IN DATABASE OPENROUTESERVICE_APP;
   ```
   
   Expected progression: PENDING → RUNNING (takes 2-5 minutes)

4. **Check service logs for graph building:**
   ```sql
   CALL SYSTEM$GET_SERVICE_LOGS('OPENROUTESERVICE_APP.CORE.ORS_SERVICE', '0', 'ors', 200);
   ```
   
   Look for these key messages:
   - ✅ `Using yml config from ENV: /home/ors/files/ors-config.yml` (config found)
   - ✅ `Building graphs for profile: driving-car` (graph building started)
   - ✅ `Building graphs for profile: cycling-electric` (multiple profiles)
   - ✅ `Graph build completed` (success)
   - ❌ `No config file found` (config upload failed)
   - ❌ `Source file not found` (map file path wrong)

**Expected Duration:** 
- Service restart: 2-5 minutes
- Graph building: 5-15 minutes (depends on map size and enabled profiles)

**Output:** ORS service restarted and building routing graphs

**Next:** Proceed to Step 5 (Test Routing) after service shows RUNNING status

---

### Step 5: Test Routing Functionality

**Goal:** Verify routing graphs built successfully and profiles are available

**Actions:**

1. **Wait for service to reach RUNNING status** (if not already)

2. **Test isochrone generation** for each enabled profile:
   
   ```sql
   -- Test driving-car profile
   SELECT 
       ST_ASGEOJSON(GEOJSON)::STRING AS geojson,
       LENGTH(ST_ASGEOJSON(GEOJSON)::STRING) AS geojson_length
   FROM TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES('driving-car', -122.43::FLOAT, 37.77::FLOAT, 10::INT))
   LIMIT 1;
   
   -- Test cycling-regular profile
   SELECT 
       ST_ASGEOJSON(GEOJSON)::STRING AS geojson,
       LENGTH(ST_ASGEOJSON(GEOJSON)::STRING) AS geojson_length
   FROM TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES('cycling-regular', -122.43::FLOAT, 37.77::FLOAT, 10::INT))
   LIMIT 1;
   
   -- Test cycling-electric profile
   SELECT 
       ST_ASGEOJSON(GEOJSON)::STRING AS geojson,
       LENGTH(ST_ASGEOJSON(GEOJSON)::STRING) AS geojson_length
   FROM TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES('cycling-electric', -122.43::FLOAT, 37.77::FLOAT, 10::INT))
   LIMIT 1;
   ```
   
   **Expected Results:**
   - ✅ GeoJSON string returned (not NULL or empty)
   - ✅ GeoJSON length > 100 characters (valid polygon geometry)
   - ❌ NULL or empty string → Profile not available (check logs)
   - ❌ Error "profile unknown" → Graphs not built yet or profile disabled

3. **Test route generation:**
   ```sql
   SELECT 
       GEOJSON,
       DURATION_MINUTES,
       DISTANCE_KM
   FROM TABLE(OPENROUTESERVICE_APP.CORE.DIRECTIONS(
       'cycling-regular',
       ARRAY_CONSTRUCT(-122.43, 37.77),  -- Start: Downtown SF
       ARRAY_CONSTRUCT(-122.48, 37.72),  -- End: West SF
       NULL
   ))
   LIMIT 1;
   ```
   
   **Expected Results:**
   - ✅ GEOJSON geometry returned (route linestring)
   - ✅ DURATION_MINUTES > 0
   - ✅ DISTANCE_KM > 0

4. **If tests fail:**
   
   - **Check service logs** for error messages:
     ```sql
     CALL SYSTEM$GET_SERVICE_LOGS('OPENROUTESERVICE_APP.CORE.ORS_SERVICE', '0', 'ors', 500);
     ```
   
   - **Common issues:**
     - "Source file not found" → Wrong source_file path in config (re-run Step 2b.3)
     - "Profile unknown" → Graphs not built yet (wait 5-10 more minutes)
     - "No config file found" → Config upload failed (re-run Step 2)
     - Empty isochrone results → Service still building graphs (check logs for progress)

**Output:** Routing functionality verified - all tested profiles return valid geometries

---

## Stopping Points

- ✋ **Step 1:** Confirm environment detection before proceeding to uploads
- ✋ **Step 2b.2:** After OSM upload, verify file exists at nested path before updating config
- ✋ **Step 3:** **MANDATORY STOP** - All files must pass validation before restarting service
- ✋ **Step 4:** Wait for service RUNNING status before testing
- ✋ **Step 5:** If routing tests fail, check logs and fix issues before proceeding

## Troubleshooting

### Upload Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| OSM file size < 20 MB | Incomplete upload or corrupted file | Re-download source file and re-upload |
| Config file missing after upload | COPY FILES failed | Check stage permissions, retry upload |
| Nested paths in CLI environment | Wrong environment detected | Manually specify CLI workflow |
| File not found in stage LIST | Upload command failed silently | Check SQL output for errors, retry |

### Configuration Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| "Source file not found" in logs | Wrong source_file path in config | Update config with correct nested/flat path (Step 2b.3) |
| "No config file found" in logs | Config not uploaded or wrong filename | Verify `ors-config.yml` exists at `@stage/SanFrancisco/` |
| Profiles disabled | Config not updated before upload | Edit config to enable required profiles (Step 2b.1) |

### Service Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| Service stuck in PENDING | Container startup failure | Check service logs for errors |
| "Profile unknown" error | Graphs not built yet or profile disabled | Wait for graph building (5-15 min) or check config |
| Empty isochrone results | Graphs still building | Check logs for "Building graphs" messages |
| Service shows ERROR | Configuration error or missing files | Review logs, verify Step 3 validation passed |

## Output

- ✅ `SanFrancisco.osm.pbf` (~25 MB) uploaded to stage (flat or nested path)
- ✅ `ors-config.yml` (~2 KB) uploaded with correct source_file path
- ✅ Required routing profiles enabled (driving-car, cycling-regular, cycling-electric)
- ✅ ORS service restarted and building routing graphs
- ✅ Routing functionality tested and verified

## Cleanup

**DO NOT** remove uploaded files - they are required for ORS service to function. 

To remove (only during full teardown):
```sql
-- Remove all map files for a region
REMOVE @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/SanFrancisco/;

-- Remove temp stage (if created)
DROP STAGE IF EXISTS temp_map_stage;
```
