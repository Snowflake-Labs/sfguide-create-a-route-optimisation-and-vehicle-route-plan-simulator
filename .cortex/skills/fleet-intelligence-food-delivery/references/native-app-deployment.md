# Native App Deployment (Step 12)

---

### Step 12: Deploy Fleet Intelligence React Native App

**Goal:** Build the Docker image for the Fleet Intelligence React app, push it to Snowflake, create a native app package, install it, and configure it so the web UI is accessible via SPCS.

**Prerequisites:**
- Docker installed locally (`docker --version`)
- `snow` CLI authenticated with the target connection
- All data tables from Steps 4-10 already exist in `FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY`

---

#### Sub-step 12a: Fix Dockerfile Port for SPCS

The SPCS service spec expects port 8080. Verify the Dockerfile in `assets/react-app/Dockerfile` has:

```dockerfile
ENV PORT=8080
EXPOSE 8080
```

The Express server reads `process.env.PORT` so this is all that's needed.

---

#### Sub-step 12b: Build Docker Image

```bash
cd fleet-intelligence-app
docker build --platform linux/amd64 -t fleet-intelligence:v1.1 .
```

This takes ~1-2 minutes. The multi-stage build compiles the React frontend (`npm run build`) and TypeScript server (`npx tsc -p tsconfig.server.json`).

---

#### Sub-step 12c: Create Image Repository in Snowflake

```sql
CREATE DATABASE IF NOT EXISTS FLEET_INTELLIGENCE_SETUP
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-a-fleet-intelligence-solution-for-food-delivery","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"native-app"}}';
CREATE IMAGE REPOSITORY IF NOT EXISTS FLEET_INTELLIGENCE_SETUP.PUBLIC.FLEET_INTEL_REPO
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-a-fleet-intelligence-solution-for-food-delivery","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"native-app"}}';
```

Then get the repository URL:

```sql
SHOW IMAGE REPOSITORIES IN SCHEMA FLEET_INTELLIGENCE_SETUP.PUBLIC;
```

Extract the `repository_url` from the result. It will look like:
`<orgname>-<acctname>.registry.snowflakecomputing.com/fleet_intelligence_setup/public/fleet_intel_repo`

---

#### Sub-step 12d: Tag and Push Docker Image

```bash
# Login to Snowflake registry
snow spcs image-registry login -c {CONNECTION_NAME}

# Tag the image with the Snowflake registry URL
docker tag fleet-intelligence:v1.1 {REPO_URL}/fleet-intelligence:v1.1

# Push to Snowflake (takes 1-2 minutes)
docker push {REPO_URL}/fleet-intelligence:v1.1
```

Where `{REPO_URL}` is the `repository_url` from the previous step.

---

#### Sub-step 12e: Create Application Package

```sql
CREATE APPLICATION PACKAGE IF NOT EXISTS FLEET_INTELLIGENCE_PKG
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-a-fleet-intelligence-solution-for-food-delivery","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"native-app"}}';
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE_PKG.stage_content
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-a-fleet-intelligence-solution-for-food-delivery","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"native-app"}}';
CREATE OR REPLACE STAGE FLEET_INTELLIGENCE_PKG.stage_content.app_code
    DIRECTORY = (ENABLE = TRUE)
    ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE')
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-a-fleet-intelligence-solution-for-food-delivery","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"native-app"}}';
```

---

#### Sub-step 12f: Upload Native App Files to Stage

Upload all files from `assets/react-app/native-app/` to the stage:

```bash
APP_DIR="assets/react-app/native-app"

snow stage copy "${APP_DIR}/manifest.yml" @FLEET_INTELLIGENCE_PKG.stage_content.app_code/ -c {CONNECTION_NAME} --overwrite
snow stage copy "${APP_DIR}/setup_script.sql" @FLEET_INTELLIGENCE_PKG.stage_content.app_code/ -c {CONNECTION_NAME} --overwrite
snow stage copy "${APP_DIR}/services/fleet_intelligence_service.yaml" @FLEET_INTELLIGENCE_PKG.stage_content.app_code/services/ -c {CONNECTION_NAME} --overwrite
snow stage copy "${APP_DIR}/streamlit/status.py" @FLEET_INTELLIGENCE_PKG.stage_content.app_code/streamlit/ -c {CONNECTION_NAME} --overwrite
snow stage copy "${APP_DIR}/streamlit/environment.yml" @FLEET_INTELLIGENCE_PKG.stage_content.app_code/streamlit/ -c {CONNECTION_NAME} --overwrite
```

Verify all 5 files are staged:

```sql
LS @FLEET_INTELLIGENCE_PKG.stage_content.app_code;
```

Expected files: `manifest.yml`, `setup_script.sql`, `services/fleet_intelligence_service.yaml`, `streamlit/status.py`, `streamlit/environment.yml`

---

#### Sub-step 12g: Register Version and Install Application

**IMPORTANT:** If release channels are enabled (default on newer accounts), use `REGISTER VERSION` not `ADD VERSION`.

```sql
ALTER APPLICATION PACKAGE FLEET_INTELLIGENCE_PKG
    REGISTER VERSION v1_0
    USING '@FLEET_INTELLIGENCE_PKG.stage_content.app_code';
```

If you get error `512020` about release channels, you're using the right syntax above. If release channels are NOT enabled, use:

```sql
ALTER APPLICATION PACKAGE FLEET_INTELLIGENCE_PKG
    ADD VERSION v1_0
    USING '@FLEET_INTELLIGENCE_PKG.stage_content.app_code';
```

Install the application:

```sql
CREATE APPLICATION FLEET_INTELLIGENCE_APP
    FROM APPLICATION PACKAGE FLEET_INTELLIGENCE_PKG
    USING VERSION v1_0
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-a-fleet-intelligence-solution-for-food-delivery","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"native-app"}}';
```

> **Note:** If an object named `FLEET_INTELLIGENCE` already exists (e.g., a database), use `FLEET_INTELLIGENCE_APP` as the application name to avoid conflicts.

---

#### Sub-step 12h: Grant Required Privileges

```sql
GRANT CREATE COMPUTE POOL ON ACCOUNT TO APPLICATION FLEET_INTELLIGENCE_APP;
GRANT CREATE WAREHOUSE ON ACCOUNT TO APPLICATION FLEET_INTELLIGENCE_APP;
GRANT BIND SERVICE ENDPOINT ON ACCOUNT TO APPLICATION FLEET_INTELLIGENCE_APP;
```

**CRITICAL: Grant Cortex AI access (required for the AI agent to function):**

```sql
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO APPLICATION FLEET_INTELLIGENCE_APP;
```

**Grant data access:**

```sql
GRANT USAGE ON DATABASE FLEET_INTELLIGENCE TO APPLICATION FLEET_INTELLIGENCE_APP;
GRANT USAGE ON SCHEMA FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY TO APPLICATION FLEET_INTELLIGENCE_APP;
GRANT SELECT ON ALL TABLES IN SCHEMA FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY TO APPLICATION FLEET_INTELLIGENCE_APP;
GRANT SELECT ON ALL VIEWS IN SCHEMA FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY TO APPLICATION FLEET_INTELLIGENCE_APP;
```

**Grant app role to installer's role:**

```sql
GRANT APPLICATION ROLE FLEET_INTELLIGENCE_APP.APP_USER TO ROLE <YOUR_ROLE>;
```

---

#### Sub-step 12i: Create External Access Integration for Map Tiles

The React app uses Carto basemap tiles and needs egress network access:

```sql
CREATE OR REPLACE NETWORK RULE fleet_intel_map_tiles_rule
    MODE = EGRESS
    TYPE = HOST_PORT
    VALUE_LIST = ('a.basemaps.cartocdn.com:443', 'b.basemaps.cartocdn.com:443', 'c.basemaps.cartocdn.com:443', 'd.basemaps.cartocdn.com:443')
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-a-fleet-intelligence-solution-for-food-delivery","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"native-app"}}';

CREATE OR REPLACE EXTERNAL ACCESS INTEGRATION fleet_intel_map_tiles_eai
    ALLOWED_NETWORK_RULES = (fleet_intel_map_tiles_rule)
    ENABLED = TRUE
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-a-fleet-intelligence-solution-for-food-delivery","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"native-app"}}';
```

Grant the EAI to the application and bind the reference:

```sql
GRANT USAGE ON INTEGRATION fleet_intel_map_tiles_eai TO APPLICATION FLEET_INTELLIGENCE_APP;
```

**IMPORTANT:** To bind the EAI reference, you must use `SYSTEM$REFERENCE()` to create a reference handle and pass it to the app's register callback:

```sql
USE DATABASE FLEET_INTELLIGENCE_APP;
USE SCHEMA CORE;
CALL core.register_single_callback(
    'EXTERNAL_ACCESS_REF',
    'ADD',
    SYSTEM$REFERENCE('EXTERNAL_ACCESS_INTEGRATION', 'FLEET_INTEL_MAP_TILES_EAI', 'persistent', 'USAGE')
);
```

> **Note:** Passing the raw integration name (e.g., `'FLEET_INTEL_MAP_TILES_EAI'`) to `register_single_callback` will fail with "Object does not exist or not authorized". You MUST use the `SYSTEM$REFERENCE()` handle.

---

#### Sub-step 12j: Deploy the Service

```sql
USE DATABASE FLEET_INTELLIGENCE_APP;
CALL core.deploy();
```

This creates:
1. A compute pool (`FLEET_INTELLIGENCE_APP_compute_pool`, CPU_X64_S)
2. A warehouse (`FLEET_INTEL_WH`, XSMALL)
3. The SPCS service with the Docker container

---

#### Sub-step 12k: Verify Deployment

Check container status (should show READY):

```sql
SELECT SYSTEM$GET_SERVICE_STATUS('FLEET_INTELLIGENCE_APP.core.fleet_intelligence_service');
```

Check the endpoint URL (takes 2-3 minutes after container is READY):

```sql
SHOW ENDPOINTS IN SERVICE FLEET_INTELLIGENCE_APP.core.fleet_intelligence_service;
```

The `ingress_url` will show "Endpoints provisioning in progress..." for 2-3 minutes, then resolve to a URL like `xxxxx-orgname-acctname.snowflakecomputing.app`.

Check service logs to confirm it started correctly:

```sql
SELECT SYSTEM$GET_SERVICE_LOGS('FLEET_INTELLIGENCE_APP.core.fleet_intelligence_service', 0, 'fleet-intelligence', 50);
```

Expected log output:
```
Server running on http://localhost:8080
Mode: SPCS (service token)
SNOWFLAKE_HOST: xxxxxx.snowflakecomputing.com
```

**Output:** The Fleet Intelligence React app is accessible at `https://{ingress_url}`. The Snowsight Streamlit status page is available under Apps → FLEET_INTELLIGENCE_APP.

---

#### Native App Architecture Summary

| Component | Details |
|-----------|---------|
| **App Package** | `FLEET_INTELLIGENCE_PKG` |
| **Application** | `FLEET_INTELLIGENCE_APP` |
| **Image Repo** | `FLEET_INTELLIGENCE_SETUP.PUBLIC.FLEET_INTEL_REPO` |
| **Docker Image** | `fleet-intelligence:v1.1` (linux/amd64, Node 20) |
| **Active Version** | V1_4 patch 0 |
| **Compute Pool** | `FLEET_INTELLIGENCE_APP_compute_pool` (CPU_X64_S) |
| **Service** | `FLEET_INTELLIGENCE_APP.core.fleet_intelligence_service` |
| **Port** | 8080 (SPCS) / 3001 (local dev) |
| **Auth Mode** | SPCS service token (`/snowflake/session/token`) |
| **EAI** | `fleet_intel_map_tiles_eai` (Carto basemap tiles) |
| **Streamlit** | Status/launcher page at `core.status_app` |

#### Updating the App

> **CRITICAL — SPCS Image Caching:** Pushing a Docker image over the same tag (e.g. `v1.1` → `v1.1`) does **NOT** force SPCS to re-pull. The cached image continues running. You **MUST** use a new tag (e.g. `v1.1` → `v1.2`) and update both `manifest.yml` and `services/fleet_intelligence_service.yaml` to reference it.

To push a new version after code changes:

```bash
# Rebuild with NEW tag (increment from current)
cd fleet-intelligence-app
docker build --platform linux/amd64 -t fleet-intelligence:{NEW_TAG} .

# Push (login if session expired: snow spcs image-registry login -c {CONNECTION_NAME})
docker tag fleet-intelligence:{NEW_TAG} {REPO_URL}/fleet-intelligence:{NEW_TAG}
docker push {REPO_URL}/fleet-intelligence:{NEW_TAG}
```

**Update image references in native app files:**
- `assets/react-app/native-app/manifest.yml` — update image reference line
- `assets/react-app/native-app/services/fleet_intelligence_service.yaml` — update `image:` field

```bash
# Re-upload all changed native app files
APP_DIR="assets/react-app/native-app"
snow stage copy "${APP_DIR}/manifest.yml" @FLEET_INTELLIGENCE_PKG.stage_content.app_code/ -c {CONNECTION_NAME} --overwrite
snow stage copy "${APP_DIR}/setup_script.sql" @FLEET_INTELLIGENCE_PKG.stage_content.app_code/ -c {CONNECTION_NAME} --overwrite
snow stage copy "${APP_DIR}/services/fleet_intelligence_service.yaml" @FLEET_INTELLIGENCE_PKG.stage_content.app_code/services/ -c {CONNECTION_NAME} --overwrite
snow stage copy "${APP_DIR}/streamlit/status.py" @FLEET_INTELLIGENCE_PKG.stage_content.app_code/streamlit/ -c {CONNECTION_NAME} --overwrite
snow stage copy "${APP_DIR}/streamlit/environment.yml" @FLEET_INTELLIGENCE_PKG.stage_content.app_code/streamlit/ -c {CONNECTION_NAME} --overwrite
```

**If manifest.yml changed (image references, privileges)** — MUST register a full new VERSION:

> Under `manifest_version: 2`, changing the manifest (including image references or privileges) requires a full new version. Patches will fail with error 093359. Max 2 unassigned versions — deregister old ones first.

```sql
-- Deregister old version if needed (max 2 unassigned)
ALTER APPLICATION PACKAGE FLEET_INTELLIGENCE_PKG DEREGISTER VERSION {OLD_VERSION};

-- Register new version
ALTER APPLICATION PACKAGE FLEET_INTELLIGENCE_PKG
    REGISTER VERSION {NEW_VERSION}
    USING '@FLEET_INTELLIGENCE_PKG.stage_content.app_code';
```

**If only setup_script.sql / service specs / Streamlit changed** — use a PATCH:

```sql
ALTER APPLICATION PACKAGE FLEET_INTELLIGENCE_PKG
    ADD PATCH FOR VERSION {CURRENT_VERSION}
    USING '@FLEET_INTELLIGENCE_PKG.stage_content.app_code';
```

**Upgrade the installed app:**

```sql
ALTER APPLICATION FLEET_INTELLIGENCE_APP UPGRADE USING VERSION {VERSION};
```

The service will automatically restart with the new image.

---

## Scalable Travel Time Matrix Pipeline (Native App)

The native app includes a scalable travel time matrix pipeline built into `setup_script.sql`. The React UI's Matrix Builder page triggers and monitors the pipeline.

### Pipeline Architecture

```
BUILD_HEXAGONS → BUILD_WORK_QUEUE → BUILD_TRAVEL_TIME_RANGE (workers) → FLATTEN_MATRIX_RAW
```

**Stages:** NOT_STARTED → HEXAGONS_READY → QUEUED → BUILDING → FLATTENING → COMPLETE

### Key Stored Procedures (in DATA schema)

| Procedure | Purpose |
|-----------|---------|
| `BUILD_HEXAGONS(P_RES, P_MIN_LAT, P_MAX_LAT, P_MIN_LON, P_MAX_LON)` | Generate H3 hexagon grid for a resolution |
| `BUILD_WORK_QUEUE(P_RES)` | Pre-compute origin + destination batches (1 row = 1 API call) |
| `BUILD_TRAVEL_TIME_RANGE(P_RES, P_START_SEQ, P_END_SEQ)` | Worker: ingest raw MATRIX_TABULAR responses |
| `FLATTEN_MATRIX_RAW(P_RES)` | Post-process raw VARIANT into travel time pairs |
| `BUILD_TRAVEL_TIME_MATRIX_RES7()` / `RES8()` / `RES9()` | Convenience wrappers — run full pipeline for a resolution |
| `MATRIX_PROGRESS()` | Returns JSON with per-resolution stage, counts, and pct |

### Tables (per resolution 7, 8, 9)

| Table | Schema | Purpose |
|-------|--------|---------|
| `CA_H3_RES{N}` | h3_index, lon, lat | Hexagon cells covering the region |
| `CA_WORK_QUEUE_RES{N}` | seq_id, origin_h3, origin_lon, origin_lat, dest_coords, dest_hex_ids | Pre-computed API call batches |
| `CA_MATRIX_RAW_RES{N}` | seq_id, origin_h3, dest_hex_ids, matrix_result (VARIANT) | Raw API responses |
| `CA_TRAVEL_TIME_RES{N}` | origin_h3, dest_h3, travel_time_seconds, travel_distance_meters | Final flattened pairs |

### Server API Endpoints (server/index.ts)

The Express server exposes two endpoints for the React Matrix Builder:

**`POST /api/matrix/build`** — Triggers the full pipeline for selected resolutions. Calls convenience wrapper `BUILD_TRAVEL_TIME_MATRIX_RES{N}()` for each resolution. Runs asynchronously (fire-and-forget per resolution).

**`GET /api/matrix/status`** — Polls `MATRIX_PROGRESS()` for real-time stage-level data. Returns per-resolution: stage, hexagons, work_queue, raw_ingested, flattened, percent_complete.

### React MatrixBuilder UI (src/components/MatrixBuilder.tsx)

The Matrix Builder page shows:
- Pipeline stage indicators per resolution: Hexagons → Work Queue → API Calls → Flatten → Complete
- Active stage has pulsing animation, completed stages show green checkmark
- Progress bar with percentage
- Detailed counts: hex cells, queued origins, raw ingested, flattened pairs
- Time estimate during BUILDING stage

### Key Design Decisions

- **Raw dump then FLATTEN:** API responses are stored as raw VARIANT. FLATTEN happens in bulk after all API calls complete. This avoids blocking during ingestion.
- **Resume-safe workers:** `BUILD_TRAVEL_TIME_RANGE` checks last completed SEQ_ID and resumes from there.
- **Adaptive batch sizing:** RES7=100, RES8=1000, RES9=2000 origins per batch (tuned to stay under ORS 500K matrix element limit).
- **K-ring radii:** RES7=33 (~50mi), RES8=17 (~10mi), RES9=9 (~2mi).

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| ORS routes returning NULL | Location outside ORS configured region - verify map data |
| ORS routes failing | Verify OpenRouteService Native App is installed and running |
| No restaurants found | Bounding box may be too restrictive; try expanding coordinates |
| No addresses found | Verify Overture Maps Addresses share is installed |
| Out of memory | Use larger warehouse or reduce NUM_COURIERS |
| Missing Overture data | Install shares from Snowflake Marketplace |
| Streamlit not loading | Check all files uploaded to stage via `LIST @STREAMLIT_STAGE/swiftbite/` |
| Map centered wrong | Update `get_city()` call in Streamlit files |
| PUT command fails | Ensure the file path is absolute and the file exists locally |
| Bicycle routes failing | ORS may not have cycling profile enabled; check ors-config.yml |
| Docker build fails | Ensure Docker is running and has linux/amd64 platform support |
| Image push fails | Run `snow spcs image-registry login -c {CONNECTION_NAME}` to refresh auth |
| `ADD VERSION` error 512020 | Account has release channels enabled; use `REGISTER VERSION` instead |
| App install name conflict | If `FLEET_INTELLIGENCE` database exists, use `FLEET_INTELLIGENCE_APP` as the app name |
| EAI bind fails with "Object does not exist" | Must use `SYSTEM$REFERENCE()` handle, not raw integration name |
| Endpoint "provisioning in progress" | Normal — wait 2-3 minutes after container shows READY |
| Service container not starting | Check logs: `SELECT SYSTEM$GET_SERVICE_LOGS(...)`. Verify image was pushed correctly |
| Map tiles not loading in SPCS | EAI not bound. Re-run `register_single_callback` with `SYSTEM$REFERENCE()` |
| Server shows "Mode: local" in SPCS | `/snowflake/session/token` file missing; check service spec mounts |
| Agent error "Unknown function SNOWFLAKE.CORTEX.COMPLETE" | Missing Cortex grant: `GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO APPLICATION FLEET_INTELLIGENCE_APP` |
| Agent shows "error generating response" | Check Cortex grant AND data grants (USAGE on database/schema, SELECT on tables/views) |
| SPCS not picking up new Docker image | Same tag won't re-pull. Must use NEW tag (e.g. v1.1 → v1.2) and update manifest.yml + service YAML |
| `ADD PATCH` error 093359 | Cannot change manifest under `manifest_version: 2` via patch; must register a full new VERSION |
| `REGISTER VERSION` max versions error | Max 2 unassigned versions. Deregister old: `ALTER APPLICATION PACKAGE ... DEREGISTER VERSION ...` |
| `ALTER APPLICATION UPGRADE` fails | Use explicit version: `ALTER APPLICATION ... UPGRADE USING VERSION {VERSION}` |
| `REGISTER PATCH` syntax error | Use `ADD PATCH FOR VERSION` (not `REGISTER PATCH FOR VERSION`) |
| Matrix build shows 0/0 progress | Server endpoints may reference old tables. Verify `/api/matrix/status` calls `MATRIX_PROGRESS()` |
| `SYSTEM$REGISTRY_LIST_IMAGES` 401 | Use `snow spcs image-repository list-images` CLI command instead |
