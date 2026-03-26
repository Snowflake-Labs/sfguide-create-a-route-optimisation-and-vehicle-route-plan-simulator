# Native App Deployment (Step 2)

## Prerequisites

- Container runtime (**Podman** or **Docker**) installed and running — see `prerequisites-build-routing-solution` skill
- Snow CLI (`snow`) authenticated with target connection
- All images must be built with `--platform linux/amd64` (SPCS requirement)
- When updating an image, always use a NEW tag — SPCS caches images by tag

> **Either Podman or Docker works.** You do not need both. Podman is recommended (no daemon required).

## Sub-step 2a: Detect Container Runtime

1. **Check** which runtimes are available:
   ```bash
   podman --version 2>/dev/null && echo "PODMAN_AVAILABLE=true" || echo "PODMAN_AVAILABLE=false"
   docker --version 2>/dev/null && echo "DOCKER_AVAILABLE=true" || echo "DOCKER_AVAILABLE=false"
   ```

2. **Based on results:**
   - If **both** installed: Ask user which they prefer (Podman or Docker)
   - If **only Podman**: Use Podman
   - If **only Docker**: Use Docker
   - If **neither**: Stop — run the `prerequisites-build-routing-solution` skill first

3. **Verify** the selected runtime is running:
   - Podman: `podman info` (if fails: `podman machine start`)
   - Docker: `docker info` (if fails: `open -a Docker` on macOS)

4. **Set** the container command for all subsequent steps:
   - `CONTAINER_CMD=podman` or `CONTAINER_CMD=docker`

## Sub-step 2a-ii: Verify Dockerfile Port

Ensure `assets/fleet-intelligence-app/Dockerfile` has `ENV PORT=8080` and `EXPOSE 8080`.

## Sub-step 2b: Build Container Images

All commands below use `$CONTAINER_CMD` (either `podman` or `docker` from Sub-step 2a).

### Fleet Intelligence App (skill-specific)

```bash
cd <SKILL_DIR>/assets/fleet-intelligence-app
$CONTAINER_CMD build --platform linux/amd64 -t fleet-intelligence:v1.2 .
```

### Gateway (skill-specific — multi-city version)

```bash
cd <SKILL_DIR>/assets/fleet-intelligence-app/native-app/services/gateway
$CONTAINER_CMD build --rm --platform linux/amd64 -t routing_reverse_proxy:v0.9.4 .
```

### Shared ORS Images (from build-routing-solution skill)

The following 3 images are identical to those in the `build-routing-solution` skill and should be
built from the shared source at `oss-build-routing-solution-in-snowflake/Native_app/services/`:

```bash
ORS_SERVICES_DIR="<REPO_ROOT>/oss-build-routing-solution-in-snowflake/Native_app/services"

# openrouteservice — identical to build-routing-solution
cd "${ORS_SERVICES_DIR}/openrouteservice"
$CONTAINER_CMD build --rm --platform linux/amd64 -t openrouteservice:v9.0.0 .

# vroom — identical to build-routing-solution
cd "${ORS_SERVICES_DIR}/vroom"
$CONTAINER_CMD build --rm --platform linux/amd64 -t vroom-docker:v1.0.1 .

# downloader — identical to build-routing-solution
cd "${ORS_SERVICES_DIR}/downloader"
$CONTAINER_CMD build --rm --platform linux/amd64 -t downloader:v0.0.3 .
```

> **NOTE:** If these images were already built and pushed by the `build-routing-solution` skill
> to the same Snowflake image repository, you can skip rebuilding them — just tag and push
> from the existing local images.

## Sub-step 2c: Create Image Repository

```sql
CREATE DATABASE IF NOT EXISTS FLEET_INTELLIGENCE_SETUP;
CREATE IMAGE REPOSITORY IF NOT EXISTS FLEET_INTELLIGENCE_SETUP.PUBLIC.FLEET_INTEL_REPO;
```

```sql
SHOW IMAGE REPOSITORIES IN SCHEMA FLEET_INTELLIGENCE_SETUP.PUBLIC;
```

Extract `repository_url`: `<orgname>-<acctname>.registry.snowflakecomputing.com/fleet_intelligence_setup/public/fleet_intel_repo`

## Sub-step 2d: Tag and Push All Container Images

### Authenticate with SPCS image registry

**Docker:**
```bash
snow spcs image-registry login -c {CONNECTION_NAME}
```

**Podman:**
```bash
REGISTRY_URL=$(snow spcs image-repository url fleet_intelligence_setup.public.fleet_intel_repo -c {CONNECTION_NAME} | cut -d'/' -f1)
snow spcs image-registry token --format=JSON -c {CONNECTION_NAME} | podman login $REGISTRY_URL -u 0sessiontoken --password-stdin
```

### Push images

```bash
# Fleet-intelligence-specific images
$CONTAINER_CMD tag fleet-intelligence:v1.2 {REPO_URL}/fleet-intelligence:v1.2
$CONTAINER_CMD push {REPO_URL}/fleet-intelligence:v1.2

$CONTAINER_CMD tag routing_reverse_proxy:v0.9.4 {REPO_URL}/routing_reverse_proxy:v0.9.4
$CONTAINER_CMD push {REPO_URL}/routing_reverse_proxy:v0.9.4

# Shared images (from build-routing-solution source)
$CONTAINER_CMD tag openrouteservice:v9.0.0 {REPO_URL}/openrouteservice:v9.0.0
$CONTAINER_CMD push {REPO_URL}/openrouteservice:v9.0.0

$CONTAINER_CMD tag vroom-docker:v1.0.1 {REPO_URL}/vroom-docker:v1.0.1
$CONTAINER_CMD push {REPO_URL}/vroom-docker:v1.0.1

$CONTAINER_CMD tag downloader:v0.0.3 {REPO_URL}/downloader:v0.0.3
$CONTAINER_CMD push {REPO_URL}/downloader:v0.0.3
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

For release channel management (must update ALL channels — ALPHA and DEFAULT):
```sql
ALTER APPLICATION PACKAGE FLEET_INTELLIGENCE_PKG MODIFY RELEASE CHANNEL DEFAULT ADD VERSION V1_2;
ALTER APPLICATION PACKAGE FLEET_INTELLIGENCE_PKG MODIFY RELEASE CHANNEL ALPHA ADD VERSION V1_2;
ALTER APPLICATION PACKAGE FLEET_INTELLIGENCE_PKG MODIFY RELEASE CHANNEL DEFAULT SET DEFAULT RELEASE DIRECTIVE VERSION=V1_2 PATCH=0;
ALTER APPLICATION PACKAGE FLEET_INTELLIGENCE_PKG MODIFY RELEASE CHANNEL ALPHA SET DEFAULT RELEASE DIRECTIVE VERSION=V1_2 PATCH=0;
```

> **CRITICAL:** Packages with release channels MUST use `MODIFY RELEASE CHANNEL <channel> SET DEFAULT RELEASE DIRECTIVE` syntax. The standard `SET DEFAULT RELEASE DIRECTIVE` (without channel) silently does nothing. Consumer apps will NOT see upgrades unless the directive is updated on their channel.

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

## Sub-step 2h: Grant Application Privileges

All required privileges are declared in `manifest.yml`. After installation, the consumer
is prompted to grant them via Snowsight or can grant them via SQL:

```sql
-- Infrastructure privileges (declared in manifest.privileges)
GRANT CREATE COMPUTE POOL ON ACCOUNT TO APPLICATION FLEET_INTELLIGENCE_APP;
GRANT CREATE WAREHOUSE ON ACCOUNT TO APPLICATION FLEET_INTELLIGENCE_APP;
GRANT BIND SERVICE ENDPOINT ON ACCOUNT TO APPLICATION FLEET_INTELLIGENCE_APP;
GRANT CREATE DATABASE ON ACCOUNT TO APPLICATION FLEET_INTELLIGENCE_APP;
GRANT EXECUTE TASK ON ACCOUNT TO APPLICATION FLEET_INTELLIGENCE_APP;
GRANT EXECUTE MANAGED TASK ON ACCOUNT TO APPLICATION FLEET_INTELLIGENCE_APP;

-- Cortex AI access (declared in manifest.privileges)
GRANT IMPORTED PRIVILEGES ON DATABASE SNOWFLAKE TO APPLICATION FLEET_INTELLIGENCE_APP;
```

> **NOTE:** `IMPORTED PRIVILEGES ON SNOWFLAKE DB` is now declared in the manifest, so consumers
> can grant it through the Snowsight UI prompt. This gives the app access to Cortex AI functions
> (COMPLETE, AGENT, ANALYST) without needing the bridging role workaround.

Bind Overture Maps databases (declared as references in manifest):
```sql
CALL FLEET_INTELLIGENCE_APP.CORE.REGISTER_SINGLE_CALLBACK(
    'OVERTURE_PLACES_REF', 'ADD',
    SYSTEM$REFERENCE('DATABASE', 'OVERTURE_MAPS__PLACES', 'PERSISTENT', 'IMPORTED PRIVILEGES'));

CALL FLEET_INTELLIGENCE_APP.CORE.REGISTER_SINGLE_CALLBACK(
    'OVERTURE_ADDRESSES_REF', 'ADD',
    SYSTEM$REFERENCE('DATABASE', 'OVERTURE_MAPS__ADDRESSES', 'PERSISTENT', 'IMPORTED PRIVILEGES'));
```

Grant app roles to user roles:
```sql
GRANT APPLICATION ROLE FLEET_INTELLIGENCE_APP.APP_USER TO ROLE PUBLIC;
GRANT APPLICATION ROLE FLEET_INTELLIGENCE_APP.ALL_AGENTS_ROLE TO ROLE PUBLIC;
```

## Sub-step 2h-ii: Post-Install Cortex Agent Grants (DataOps / manual installs)

> **NOTE:** If the consumer granted `IMPORTED PRIVILEGES ON SNOWFLAKE DB` via the manifest prompt
> (Sub-step 2h above), the bridging role below may not be strictly required. However, for
> production DataOps deployments or if the manifest grant alone is insufficient, create the
> bridging role as a belt-and-braces approach.

```sql
CREATE ROLE IF NOT EXISTS FLEET_INTELLIGENCE;

-- Cortex AI database roles (all 4 required for agent functionality)
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO ROLE FLEET_INTELLIGENCE;
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_AGENT_USER TO ROLE FLEET_INTELLIGENCE;
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_ANALYST_USER TO ROLE FLEET_INTELLIGENCE;
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_REST_API_USER TO ROLE FLEET_INTELLIGENCE;

-- Bridge app roles to the Cortex role
GRANT APPLICATION ROLE FLEET_INTELLIGENCE_APP.APP_USER TO ROLE FLEET_INTELLIGENCE;
GRANT APPLICATION ROLE FLEET_INTELLIGENCE_APP.ALL_AGENTS_ROLE TO ROLE FLEET_INTELLIGENCE;

-- Grant the Cortex role to user roles so they inherit agent access
GRANT ROLE FLEET_INTELLIGENCE TO ROLE PUBLIC;
```

> **NOTE:** The warehouse grants (`USAGE + OPERATE ON WAREHOUSE FLEET_INTEL_WH`) are handled
> automatically by the app's `grant_callback` procedure after the service is deployed (Sub-step 2j).
> If the agent still reports permission errors after deployment, manually run:
> ```sql
> GRANT USAGE ON WAREHOUSE FLEET_INTEL_WH TO ROLE FLEET_INTELLIGENCE;
> GRANT OPERATE ON WAREHOUSE FLEET_INTEL_WH TO ROLE FLEET_INTELLIGENCE;
> ```

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
