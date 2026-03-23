# Troubleshooting

Common issues and their solutions when deploying the ORS Native App.

## Container Runtime Not Running

**Symptom:** "Cannot connect to the Docker daemon" or "Cannot connect to Podman"
**Solution:**
- Podman: `podman machine start`
- Docker: Start Docker Desktop application

## Authentication Required

**Symptom:** "unauthorized" or "authentication required" or "invalid username/password"
**Solution:**
- Docker: Run `snow spcs image-registry login -c <connection>`
- Podman: Use session token with password-stdin:
  ```bash
  REGISTRY_URL=$(snow spcs image-repository url openrouteservice_setup.public.image_repository -c <connection> | cut -d'/' -f1)
  snow spcs image-registry token --format=JSON -c <connection> | podman login $REGISTRY_URL -u 0sessiontoken --password-stdin
  ```

## Wrong Directory Error

**Symptom:** "cd: services/openrouteservice: No such file or directory"
**Solution:** Ensure script runs from `native_app/` directory, not `provider_setup/`

## ARM Mac esbuild Crash (ors_control_app)

**Symptom:** `esbuild` crashes with QEMU segfault during `npm run build` inside `podman build --platform linux/amd64`
**Solution:** Build the React app locally (native ARM) first, then use a runtime-only Dockerfile that copies the pre-built `dist/` and `dist-server/` directories. See Step 5 in SKILL.md for the exact commands. Must temporarily rename `.dockerignore` since it excludes `dist/`.

## Control App Shows ERROR / Unhealthy / 0 Services

**Symptom:** React UI shows ERROR for compute pool, Unhealthy for ORS health, 0 running services
**Solution:** Check service logs with `SYSTEM$GET_SERVICE_LOGS`. Common causes:
1. **Missing warehouse grant:** Run `GRANT USAGE ON WAREHOUSE ROUTING_ANALYTICS TO APPLICATION OPENROUTESERVICE_NATIVE_APP;`
2. **Missing QUERY_WAREHOUSE:** Run `ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.ORS_CONTROL_APP SET QUERY_WAREHOUSE = ROUTING_ANALYTICS;`
3. **`{{database}}` template not resolved:** SPCS does NOT resolve `{{database}}` in service spec env vars within Native App context. The service spec must hardcode the database name (`OPENROUTESERVICE_NATIVE_APP`), not use `{{database}}`.

## Podman Registry Auth for Wrong Host

**Symptom:** `podman push` fails with "unable to retrieve auth token: invalid username/password: unauthorized" even after `snow spcs image-registry login`
**Solution:** `snow spcs image-registry login` may store credentials for the wrong registry hostname. Use the manual token approach with `--creds` flag:
```bash
REGISTRY_URL=$(snow spcs image-repository url openrouteservice_setup.public.image_repository -c <connection> | cut -d'/' -f1)
TOKEN=$(snow spcs image-registry token --format=JSON -c <connection>)
podman push --creds "0sessiontoken:$TOKEN" $REGISTRY_URL/ors_control_app:v1.0.27
```

## Basemap Tiles Not Loading (ENOTFOUND / 502)

**Symptom:** Map shows grey tiles, browser console shows 502 errors for `/api/tiles/`, service logs show `getaddrinfo ENOTFOUND a.basemaps.cartocdn.com`
**Cause:** The CARTO basemap EAI (`external_access_carto_ref`) is not bound to the control app service, so SPCS cannot resolve DNS for `a.basemaps.cartocdn.com`.
**Solution:**
1. First check if the EAI reference was auto-provisioned during setup. If the app was installed before the CARTO EAI was added, manually create and bind it:
   ```sql
   CREATE OR REPLACE NETWORK RULE OPENROUTESERVICE_SETUP.PUBLIC.ORS_MAP_TILES_RULE
       MODE = EGRESS TYPE = HOST_PORT
       VALUE_LIST = ('a.basemaps.cartocdn.com:443', 'b.basemaps.cartocdn.com:443',
                     'c.basemaps.cartocdn.com:443', 'd.basemaps.cartocdn.com:443');
   CREATE OR REPLACE EXTERNAL ACCESS INTEGRATION ORS_MAP_TILES_EAI
       ALLOWED_NETWORK_RULES = (OPENROUTESERVICE_SETUP.PUBLIC.ORS_MAP_TILES_RULE) ENABLED = TRUE;
   GRANT USAGE ON INTEGRATION ORS_MAP_TILES_EAI TO APPLICATION OPENROUTESERVICE_NATIVE_APP;
   CALL OPENROUTESERVICE_NATIVE_APP.CORE.REGISTER_SINGLE_CALLBACK(
       'EXTERNAL_ACCESS_CARTO_REF', 'ADD',
       SYSTEM$REFERENCE('EXTERNAL ACCESS INTEGRATION', 'ORS_MAP_TILES_EAI', 'PERSISTENT', 'USAGE'));
   ```
2. Then recreate the control app to pick up the EAI (it must be present at service creation time):
   ```sql
   CALL OPENROUTESERVICE_NATIVE_APP.CORE.CREATE_CONTROL_APP();
   ```
**Key insight:** `ALTER SERVICE SET EXTERNAL_ACCESS_INTEGRATIONS` does NOT reliably enable DNS. The EAI must be present at `CREATE SERVICE` time. The `create_control_app` procedure now DROP+CREATEs the service to ensure this.

## Services Going PENDING (Resource Exhaustion)

**Symptom:** Services transition from RUNNING to PENDING with "Unschedulable due to insufficient resources" or silently fail to schedule.
**Root Cause:** Compute pool has too many containers relative to available nodes. All containers in a service instance run on a single node; stage volume mounts limited to 8 per node.
**Solution:**
1. **Right-size instances:** ORS and gateway DON'T need the same count. Gateway is a lightweight proxy; 3 instances handles most workloads. ORS is heavy (graph loading); keep at 3 unless high traffic.
2. **Use the 3-arg SCALE_SERVICES:** `CALL CORE.SCALE_SERVICES(ors_instances, gateway_instances, pool_nodes)` to set them independently.
3. **Rule of thumb:** total_containers / 3 = minimum nodes. Example: 3 ORS + 3 gateway + 1 Berlin + 3 others = 10 containers → 4-5 nodes.
4. **During matrix builds:** Suspend unused ORS_SERVICE if only building for a specific region (the region-specific ORS handles it).
5. **Pool sizing formula:** `GREATEST(requested_nodes, CEIL(total_active_containers / 3))` to ensure at least 3 containers per node.

## ALTER SESSION Not Allowed in EXECUTE AS OWNER

**Symptom:** `Unsupported statement type 'ALTER_SESSION'` in stored procedures
**Root Cause:** `ALTER SESSION SET STATEMENT_TIMEOUT_IN_SECONDS` is not allowed in EXECUTE AS OWNER procedures (which all Native App procedures use).
**Solution:** Remove ALTER SESSION statements. Use retry+backoff logic and service resume instead of statement timeouts. Warehouse-level timeout can be set externally if needed.

## Matrix Build 500 Errors from Gateway

**Symptom:** `Request failed for external function MATRIX_TABULAR with remote service error: 500`
**Root Causes and Fixes:**
1. **Gateway can't reach ORS:** Service was PENDING/upgrading. Fix: Add service resume logic before build, reduce compute pressure.
2. **Gateway Python bug (fixed in v0.9.6):** `resp.get('error', {}).get('code')` crashes with AttributeError when `error` is a string (connection failure) instead of a dict (ORS error). Fix: Check `isinstance(error_obj, dict)` before calling `.get('code')`.
3. **MAX_BATCH_ROWS too high:** 100 rows × sequential ORS calls × ~2s each = 200s, exceeding gateway's 120s timeout. Fix: Use MAX_BATCH_ROWS=50 (50 × 2s = 100s, safe margin).

## Matrix Build Performance Tuning

**MAX_BATCH_ROWS settings for region-aware functions (MATRIX_TABULAR, MATRIX):**
- Default (non-region): 1000 (uses the shared ORS_SERVICE with many instances)
- Region-aware: **50** (routes to single-instance region ORS, processed sequentially)
- Gateway timeout: 120s → max ~60 sequential ORS calls per batch
- Each ORS matrix call (1 origin × ~2600 destinations): ~1-3s depending on graph size
- **50 is the sweet spot**: 5x faster than 10, safe within 120s timeout

## Stale/Zombie Build Jobs

**Symptom:** Jobs stuck in RUNNING status indefinitely after services went PENDING
**Solution:** BUILD_MATRIX_JOB_WRAPPER now auto-cleans jobs RUNNING for >2 hours before starting a new build. Manual fix: `UPDATE travel_matrix.MATRIX_BUILD_JOBS SET STATUS = 'ERROR' WHERE STATUS = 'RUNNING' AND STARTED_AT < DATEADD('HOUR', -2, CURRENT_TIMESTAMP())`
