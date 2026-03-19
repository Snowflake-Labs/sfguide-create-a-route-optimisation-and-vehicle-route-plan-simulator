# Native App Deployment (Step 2)

## Prerequisites

- Docker Desktop installed and running with `linux/amd64` support
- Snow CLI (`snow`) authenticated with target connection
- All images must be built with `--platform linux/amd64` (SPCS requirement)
- When updating an image, always use a NEW tag — SPCS caches images by tag

## Sub-step 2a: Verify Dockerfile Port

Ensure `assets/fleet-intelligence-app/Dockerfile` has `ENV PORT=8080` and `EXPOSE 8080`.

## Sub-step 2b: Build Docker Image

```bash
cd <SKILL_DIR>/assets/fleet-intelligence-app
docker build --platform linux/amd64 -t fleet-intelligence:v1.2 .
```

## Sub-step 2c: Create Image Repository

```sql
CREATE DATABASE IF NOT EXISTS FLEET_INTELLIGENCE_SETUP;
CREATE IMAGE REPOSITORY IF NOT EXISTS FLEET_INTELLIGENCE_SETUP.PUBLIC.FLEET_INTEL_REPO;
```

```sql
SHOW IMAGE REPOSITORIES IN SCHEMA FLEET_INTELLIGENCE_SETUP.PUBLIC;
```

Extract `repository_url`: `<orgname>-<acctname>.registry.snowflakecomputing.com/fleet_intelligence_setup/public/fleet_intel_repo`

## Sub-step 2d: Tag and Push All Docker Images

```bash
snow spcs image-registry login -c {CONNECTION_NAME}

docker tag fleet-intelligence:v1.2 {REPO_URL}/fleet-intelligence:v1.2
docker push {REPO_URL}/fleet-intelligence:v1.2

docker tag openrouteservice:v9.0.0 {REPO_URL}/openrouteservice:v9.0.0
docker push {REPO_URL}/openrouteservice:v9.0.0

docker tag vroom-docker:v1.0.1 {REPO_URL}/vroom-docker:v1.0.1
docker push {REPO_URL}/vroom-docker:v1.0.1

docker tag routing_reverse_proxy:v0.9.2 {REPO_URL}/routing_reverse_proxy:v0.9.2
docker push {REPO_URL}/routing_reverse_proxy:v0.9.2

docker tag downloader:v0.0.3 {REPO_URL}/downloader:v0.0.3
docker push {REPO_URL}/downloader:v0.0.3
```

## Sub-step 2e: Create Application Package

```sql
CREATE APPLICATION PACKAGE IF NOT EXISTS FLEET_INTELLIGENCE_PKG;
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE_PKG.stage_content;
CREATE OR REPLACE STAGE FLEET_INTELLIGENCE_PKG.stage_content.app_code
    DIRECTORY = (ENABLE = TRUE) ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE');
```

## Sub-step 2f: Upload Native App Files

```bash
APP_DIR="<SKILL_DIR>/assets/fleet-intelligence-app/native-app"
snow stage copy "${APP_DIR}/manifest.yml" @FLEET_INTELLIGENCE_PKG.stage_content.app_code/ -c {CONNECTION_NAME} --overwrite
snow stage copy "${APP_DIR}/setup_script.sql" @FLEET_INTELLIGENCE_PKG.stage_content.app_code/ -c {CONNECTION_NAME} --overwrite
snow stage copy "${APP_DIR}/README.md" @FLEET_INTELLIGENCE_PKG.stage_content.app_code/ -c {CONNECTION_NAME} --overwrite
snow stage copy "${APP_DIR}/services/fleet_intelligence_service.yaml" @FLEET_INTELLIGENCE_PKG.stage_content.app_code/services/ -c {CONNECTION_NAME} --overwrite
snow stage copy "${APP_DIR}/streamlit/status.py" @FLEET_INTELLIGENCE_PKG.stage_content.app_code/streamlit/ -c {CONNECTION_NAME} --overwrite
```

## Sub-step 2g: Register Version and Install

```sql
ALTER APPLICATION PACKAGE FLEET_INTELLIGENCE_PKG
    REGISTER VERSION V1_2
    USING '@FLEET_INTELLIGENCE_PKG.stage_content.app_code';
```

If max versions error (512023), deregister old version first:
```sql
SHOW VERSIONS IN APPLICATION PACKAGE FLEET_INTELLIGENCE_PKG;
ALTER APPLICATION PACKAGE FLEET_INTELLIGENCE_PKG DEREGISTER VERSION <OLD_VERSION>;
```

For release channel management:
```sql
ALTER APPLICATION PACKAGE FLEET_INTELLIGENCE_PKG MODIFY RELEASE CHANNEL DEFAULT ADD VERSION V1_2;
ALTER APPLICATION PACKAGE FLEET_INTELLIGENCE_PKG MODIFY RELEASE CHANNEL DEFAULT SET DEFAULT RELEASE DIRECTIVE VERSION=V1_2 PATCH=0;
```

First install:
```sql
CREATE APPLICATION FLEET_INTELLIGENCE_APP
    FROM APPLICATION PACKAGE FLEET_INTELLIGENCE_PKG
    USING VERSION V1_2;
```

Upgrade existing app:
```sql
ALTER APPLICATION FLEET_INTELLIGENCE_APP UPGRADE USING VERSION V1_2;
```

## Sub-step 2h: Grant Required Privileges

```sql
GRANT CREATE COMPUTE POOL ON ACCOUNT TO APPLICATION FLEET_INTELLIGENCE_APP;
GRANT CREATE WAREHOUSE ON ACCOUNT TO APPLICATION FLEET_INTELLIGENCE_APP;
GRANT BIND SERVICE ENDPOINT ON ACCOUNT TO APPLICATION FLEET_INTELLIGENCE_APP;
```

```sql
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO APPLICATION FLEET_INTELLIGENCE_APP;
```

```sql
GRANT USAGE ON DATABASE FLEET_INTELLIGENCE_SETUP TO APPLICATION FLEET_INTELLIGENCE_APP;
GRANT USAGE ON SCHEMA FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY TO APPLICATION FLEET_INTELLIGENCE_APP;
GRANT SELECT ON ALL TABLES IN SCHEMA FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY TO APPLICATION FLEET_INTELLIGENCE_APP;
GRANT SELECT ON ALL VIEWS IN SCHEMA FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY TO APPLICATION FLEET_INTELLIGENCE_APP;
```

Also grant on ROUTING schema (for travel time matrix):
```sql
GRANT USAGE ON SCHEMA FLEET_INTELLIGENCE_SETUP.ROUTING TO APPLICATION FLEET_INTELLIGENCE_APP;
GRANT SELECT ON ALL TABLES IN SCHEMA FLEET_INTELLIGENCE_SETUP.ROUTING TO APPLICATION FLEET_INTELLIGENCE_APP;
```

```sql
GRANT IMPORTED PRIVILEGES ON DATABASE OVERTURE_MAPS__PLACES TO APPLICATION FLEET_INTELLIGENCE_APP;
GRANT IMPORTED PRIVILEGES ON DATABASE OVERTURE_MAPS__ADDRESSES TO APPLICATION FLEET_INTELLIGENCE_APP;
```

```sql
GRANT APPLICATION ROLE FLEET_INTELLIGENCE_APP.APP_USER TO ROLE <YOUR_ROLE>;
```

## Sub-step 2i: Create External Access Integrations

### Map Tiles EAI (for React UI map rendering)

```sql
CREATE OR REPLACE NETWORK RULE fleet_intel_map_tiles_rule
    MODE = EGRESS TYPE = HOST_PORT
    VALUE_LIST = ('a.basemaps.cartocdn.com:443', 'b.basemaps.cartocdn.com:443', 'c.basemaps.cartocdn.com:443', 'd.basemaps.cartocdn.com:443');
```

```sql
CREATE OR REPLACE EXTERNAL ACCESS INTEGRATION fleet_intel_map_tiles_eai
    ALLOWED_NETWORK_RULES = (fleet_intel_map_tiles_rule) ENABLED = TRUE;
```

```sql
GRANT USAGE ON INTEGRATION fleet_intel_map_tiles_eai TO APPLICATION FLEET_INTELLIGENCE_APP;
```

Bind the map tiles reference:
```sql
CALL FLEET_INTELLIGENCE_APP.CORE.REGISTER_SINGLE_CALLBACK(
    'EXTERNAL_ACCESS_REF', 'ADD',
    SYSTEM$REFERENCE('EXTERNAL_ACCESS_INTEGRATION', 'FLEET_INTEL_MAP_TILES_EAI', 'PERSISTENT', 'USAGE')
);
```

### Download EAI (for ORS PBF map downloads)

> **CRITICAL:** The downloader service requires this EAI to download city PBF files from BBBike. Without it, `CREATE_CITY_ORS_SERVICE()` will fail.

```sql
CREATE OR REPLACE NETWORK RULE fleet_intel_download_rule
    MODE = EGRESS TYPE = HOST_PORT
    VALUE_LIST = ('download.bbbike.org:443');
```

```sql
CREATE OR REPLACE EXTERNAL ACCESS INTEGRATION fleet_intel_download_eai
    ALLOWED_NETWORK_RULES = (fleet_intel_download_rule) ENABLED = TRUE;
```

```sql
GRANT USAGE ON INTEGRATION fleet_intel_download_eai TO APPLICATION FLEET_INTELLIGENCE_APP;
```

Bind the download reference:
```sql
CALL FLEET_INTELLIGENCE_APP.CORE.REGISTER_SINGLE_CALLBACK(
    'EXTERNAL_ACCESS_DOWNLOAD_REF', 'ADD',
    SYSTEM$REFERENCE('EXTERNAL_ACCESS_INTEGRATION', 'FLEET_INTEL_DOWNLOAD_EAI', 'PERSISTENT', 'USAGE')
);
```

> **Note on REGISTER_SINGLE_CALLBACK:** This is the ONLY way to bind external access integrations to a native app from outside the app. `SYSTEM$SET_REFERENCE()` can only be called from within native app procedures. `ALTER APPLICATION ... SET REFERENCES` is NOT a valid property.

## Sub-step 2j: Deploy the Service

```sql
CALL FLEET_INTELLIGENCE_APP.CORE.DEPLOY();
```

## Sub-step 2k: Verify Deployment

```sql
SELECT SYSTEM$GET_SERVICE_STATUS('FLEET_INTELLIGENCE_APP.CORE.FLEET_INTELLIGENCE_SERVICE');
```

```sql
SHOW ENDPOINTS IN SERVICE FLEET_INTELLIGENCE_APP.CORE.FLEET_INTELLIGENCE_SERVICE;
```

Endpoint URL takes 2-3 minutes after READY to resolve.

## Sub-step 2l: Provision ORS Routing for City

```sql
CALL FLEET_INTELLIGENCE_APP.ROUTING.SETUP_ORS();
CALL FLEET_INTELLIGENCE_APP.ROUTING.CREATE_CITY_ORS_SERVICE('{LOCATION}');
CALL FLEET_INTELLIGENCE_APP.ROUTING.CREATE_CITY_FUNCTIONS('{LOCATION}');
```

## Sub-step 2m: Verify Routing

> **CRITICAL:** Always use city-specific functions, NOT generic ones. See `maps-and-locations.md` for the full function reference.

```sql
SELECT FLEET_INTELLIGENCE_APP.ROUTING.DIRECTIONS_{LOCATION}(
    'driving-car',
    ARRAY_CONSTRUCT({CENTER_LON}, {CENTER_LAT}),
    ARRAY_CONSTRUCT({CENTER_LON} + 0.02, {CENTER_LAT} + 0.02)
);
```

If it fails: `CALL SYSTEM$GET_SERVICE_LOGS('FLEET_INTELLIGENCE_APP.ROUTING.ORS_SERVICE_{LOCATION}', 0, 'ors', 50);`

## ORS Graph Cache Management

When re-provisioning or updating a city's ORS service, you may need to clear cached graph data:

```sql
REMOVE @FLEET_INTELLIGENCE_APP.ROUTING.ORS_GRAPHS_SPCS_STAGE/{ORS_REGION}/driving-car/;
REMOVE @FLEET_INTELLIGENCE_APP.ROUTING.ORS_GRAPHS_SPCS_STAGE/{ORS_REGION}/cycling-regular/;
```

Then restart the ORS service:
```sql
ALTER SERVICE FLEET_INTELLIGENCE_APP.ROUTING.ORS_SERVICE_{LOCATION} SUSPEND;
ALTER SERVICE FLEET_INTELLIGENCE_APP.ROUTING.ORS_SERVICE_{LOCATION} RESUME;
```

> The ORS Docker image ships with a default Karlsruhe (Germany) test PBF (~8MB, 20K edges). When a city-specific PBF is downloaded, the cached graph from the old PBF may persist. Always clear the graph cache before rebuilding.
