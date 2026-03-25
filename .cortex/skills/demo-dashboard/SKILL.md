---
name: demo-dashboard
description: "Deploy the shared React demo dashboard as an SPCS native app. All demo skills register pages here via DEMO_REGISTRY. Use when: deploying demo dashboard, installing shared demo UI, setting up demo platform, upgrading dashboard, rebuilding dashboard image. Do NOT use for: individual demo data pipelines (use skill per demo), ORS admin (use build-routing-solution). Triggers: demo dashboard, demo app, demo application, deploy demo, install demo, shared dashboard, demo platform, demo UI, upgrade dashboard."
depends_on:
  - build-routing-solution
metadata:
  author: Snowflake SIT-IS
  version: 1.0.15
  category: demo-platform
---

# Demo Dashboard

Deploy and manage the shared React demo application as an SPCS native app. This is the unified demo platform where all demo skills register their pages.

## Prerequisites

- Snowflake account with privileges listed in Required Privileges below
- Docker or Podman installed (for building SPCS images)
- Snowflake CLI (`snow`) installed and configured
- OpenRouteService Native App installed (for ORS-dependent demos)

## Required Privileges

| Privilege | Scope | Reason |
|-----------|-------|--------|
| CREATE DATABASE | Account | Creates DEMO_DASHBOARD_SETUP database |
| CREATE APPLICATION | Account | Deploys DEMO_DASHBOARD_APP |
| CREATE APPLICATION PACKAGE | Account | Creates DEMO_DASHBOARD_PKG |
| CREATE COMPUTE POOL | Account | Required for SPCS container services |
| CREATE WAREHOUSE | Account | Creates DEMO_DASHBOARD_WH |
| BIND SERVICE ENDPOINT | Account | Allows public endpoint for web UI |
| CREATE IMAGE REPOSITORY | Schema | Creates image repo for container images |
| CREATE NETWORK RULE | Schema | Creates network rule for map tile access |
| CREATE EXTERNAL ACCESS INTEGRATION | Account | Creates EAI for Carto map tiles |

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| DATABASE | `DEMO_DASHBOARD_SETUP` | Database for image repository |
| APP_PACKAGE | `DEMO_DASHBOARD_PKG` | Application package name |
| APP_NAME | `DEMO_DASHBOARD_APP` | Application name |
| WAREHOUSE | `DEMO_DASHBOARD_WH` | XS warehouse for SQL queries |
| COMPUTE_POOL | `DEMO_DASHBOARD_APP_COMPUTE_POOL` | CPU_X64_S compute pool |
| IMAGE_TAG | `v1.0.2` | Docker image version tag |

## Execution Rules

1. **One statement per `snowflake_sql_execute` call.** Multi-statement blocks can silently fail.
2. **Always use fully qualified object names.** Session context does not persist across calls.
3. **Log failures** to `logs/` following `logs/README.md` format.

## Architecture

React 18 + Express backend deployed as SPCS native app. Express server has dual-mode: SQL REST API in SPCS (detects `/snowflake/session/token`), `snow` CLI locally. Reads `CORE.DEMO_REGISTRY` table to discover installed demos. Groups flat per-page rows by `CATEGORY` and synthesizes `DemoRegistration[]` with nested `pages[]` arrays.

### Registry Pattern

Each demo skill registers pages by calling:
```sql
CALL DEMO_DASHBOARD_APP.CORE.REGISTER_DEMO(
  'route-optimization',
  'Route Optimization',
  'VRP solver with fleet sim',
  'truck',
  10,
  'FLEET_INTELLIGENCE',
  'ROUTE_OPTIMIZATION',
  PARSE_JSON('[{"id":"route-optimization","path":"/route-optimization","title":"Route Optimization"}]'),
  TRUE,
  '1.0.0',
  PARSE_JSON('{}')
);
```

## Workflow

### Step 1: Build Docker Image

```bash
cd {SKILL_DIR}/assets/react-app
docker build --platform linux/amd64 -t "demo-dashboard:{IMAGE_TAG}" .
```

**STOP**: Verify build succeeds with no errors.

### Step 2: Create Infrastructure & Push Image

```sql
CREATE DATABASE IF NOT EXISTS DEMO_DASHBOARD_SETUP;
CREATE IMAGE REPOSITORY IF NOT EXISTS DEMO_DASHBOARD_SETUP.PUBLIC.DEMO_DASHBOARD_REPO;
SHOW IMAGE REPOSITORIES IN SCHEMA DEMO_DASHBOARD_SETUP.PUBLIC;
```

Tag and push using the `repository_url` from SHOW output:
```bash
docker tag demo-dashboard:{IMAGE_TAG} {REPO_URL}/demo-dashboard:{IMAGE_TAG}
docker push {REPO_URL}/demo-dashboard:{IMAGE_TAG}
```

**STOP**: Verify image appears in repository.

### Step 3: Deploy Native App

Update image tag in `native-app/manifest.yml` and `native-app/services/demo_dashboard_service.yaml`, then:

```bash
cd {SKILL_DIR}/assets/react-app/native-app
snow app run -c {CONNECTION} --no-interactive
```

**STOP**: Verify app created/upgraded successfully.

### Step 4: Grant External Access

```sql
CREATE NETWORK RULE IF NOT EXISTS demo_dashboard_map_tiles_nr
  TYPE = HOST_PORT MODE = EGRESS
  VALUE_LIST = ('basemaps.cartocdn.com:443');

CREATE OR REPLACE EXTERNAL ACCESS INTEGRATION demo_dashboard_map_tiles_eai
  ALLOWED_NETWORK_RULES = (demo_dashboard_map_tiles_nr)
  ENABLED = TRUE;

GRANT USAGE ON INTEGRATION demo_dashboard_map_tiles_eai TO APPLICATION DEMO_DASHBOARD_APP;

CALL DEMO_DASHBOARD_APP.CORE.REGISTER_SINGLE_CALLBACK(
  'EXTERNAL_ACCESS_REF', 'ADD',
  SYSTEM$REFERENCE('EXTERNAL ACCESS INTEGRATION', 'demo_dashboard_map_tiles_eai', 'PERSISTENT', 'USAGE')
);
```

### Step 5: Grant ORS Access (if ORS installed)

```sql
GRANT APPLICATION ROLE OPENROUTESERVICE_NATIVE_APP.APP_USER TO APPLICATION DEMO_DASHBOARD_APP;
```

### Step 5b: Grant Routing Agent Access (if routing agent exists)

```sql
GRANT USAGE ON ALL PROCEDURES IN SCHEMA FLEET_INTELLIGENCE.ROUTING_AGENT TO APPLICATION DEMO_DASHBOARD_APP;
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO APPLICATION DEMO_DASHBOARD_APP;
GRANT USAGE ON WAREHOUSE ROUTING_ANALYTICS TO APPLICATION DEMO_DASHBOARD_APP;
```

The SPCS service uses `SNOWFLAKE.CORTEX.COMPLETE` via SQL API with custom tool-calling. Three grants required:
- USAGE on tool procedures (TOOL_DIRECTIONS, TOOL_ISOCHRONE, TOOL_OPTIMIZATION use _GEO table functions)
- SNOWFLAKE.CORTEX_USER database role (for CORTEX.COMPLETE access)
- USAGE on ROUTING_ANALYTICS warehouse (tool procedures execute SQL)

`deploy.sh` includes all grants automatically.

### Step 6: Verify

```sql
SHOW ENDPOINTS IN SERVICE DEMO_DASHBOARD_APP.CORE.DEMO_DASHBOARD_SERVICE;
SELECT SYSTEM$GET_SERVICE_STATUS('DEMO_DASHBOARD_APP.CORE.DEMO_DASHBOARD_SERVICE');
```

Navigate to the `ingress_url` to verify the dashboard loads.

## Stopping Points

- **Step 1**: Docker build succeeds
- **Step 2**: Image pushed to SPCS registry
- **Step 3**: `snow app run` succeeds
- **Step 6**: Service READY, endpoint accessible

## Local Development

```bash
cd {SKILL_DIR}/assets/react-app
SNOWFLAKE_CONNECTION_NAME={CONNECTION} npm run dev
```

Starts Vite dev server (port 5173) + Express backend (port 3001). Vite proxy forwards `/api` to backend.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Docker build fails | Ensure node:20 base image available; check npm install errors |
| `snow app run` debug error | Set `debug: false` in `snowflake.yml` (manifest_version 2 requires this) |
| Service not starting | Check `SYSTEM$GET_SERVICE_LOGS(...)` for startup errors |
| Black screen / .map() crash | Server must return grouped DemoRegistration with pages[] array, not flat rows |
| Registry HTTP 500 | Check DEMO_REGISTRY table exists with correct columns |
| ORS Not Installed | Grant `OPENROUTESERVICE_NATIVE_APP.APP_USER` to app |
| Routing Agent 401 | `GRANT USAGE ON AGENT FLEET_INTELLIGENCE.ROUTING_AGENT.ROUTING_AGENT TO APPLICATION DEMO_DASHBOARD_APP` |
| Routing Agent 403 | `GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO APPLICATION DEMO_DASHBOARD_APP` |
| Routing Agent tool error | `GRANT USAGE ON WAREHOUSE ROUTING_ANALYTICS TO APPLICATION DEMO_DASHBOARD_APP` + procedure grants |
| Map tiles not loading | Register EAI callback (Step 4) |
| Endpoint provisioning | Wait 1-2 minutes after service starts for public endpoint |

## Cleanup

```sql
DROP APPLICATION IF EXISTS DEMO_DASHBOARD_APP CASCADE;
DROP APPLICATION PACKAGE IF EXISTS DEMO_DASHBOARD_PKG;
DROP DATABASE IF EXISTS DEMO_DASHBOARD_SETUP;
DROP EXTERNAL ACCESS INTEGRATION IF EXISTS demo_dashboard_map_tiles_eai;
DROP NETWORK RULE IF EXISTS demo_dashboard_map_tiles_nr;
```
