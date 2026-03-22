# Skill Improvement Recommendations: build-routing-solution

## Issues Found During Installation & Multi-Region Setup

### Critical Issues (Must Fix for First-Attempt Success)

#### 1. ~~Function Ownership During Upgrade~~ ✅ ALREADY IMPLEMENTED
**Problem**: `ALTER APPLICATION UPGRADE` re-runs setup_script but only creates/replaces procedure definitions — it doesn't execute them. Functions inside `core.create_functions()` are not recreated during upgrade. If functions were previously created outside the app context (e.g., by ACCOUNTADMIN manually calling create_functions), they become ACCOUNTADMIN-owned and invisible to the SPCS SQL API running in app context.

**Status**: Already handled — `version_init()` calls `create_functions()` at line 33 of setup_script.sql.

#### 2. ~~Service YAML Version Reverts During App Upgrade~~ ✅ RESOLVED
**Problem**: `version_init()` runs `ALTER SERVICE ... FROM SPECIFICATION_FILE` for each service. If the staged YAML has an old image tag, the service reverts to the old version. This silently undoes any out-of-band service updates (e.g., from deploy.sh).

**Solution implemented**: deploy.sh now uploads updated YAMLs to the package stage (step 5/8) after every deployment, preventing version_init from reverting services during app upgrades.

**Files changed**: `deploy.sh` — added `PKG_STAGE` variable, step 5/8 `PUT` command to upload YAML to package stage.

#### 3. ~~ACCOUNTADMIN-Owned Objects Block Upgrades~~ ✅ RESOLVED
**Problem**: If functions, tables, or procedures are created outside the setup_script (e.g., by ACCOUNTADMIN testing), they become ACCOUNTADMIN-owned. During `ALTER APPLICATION UPGRADE`, the app can't replace these objects ("already exists, but current role has no privileges").

**Solution implemented**: Added `core.pre_upgrade_cleanup()` procedure to setup_script.sql that drops non-app-owned functions in CORE schema. Run before `ALTER APPLICATION UPGRADE` to clear conflicting objects.

**Files changed**: `setup_script.sql` — added `pre_upgrade_cleanup()` procedure.

#### 4. ~~SQL API Schema Parameter Required for SPCS~~ ✅ ALREADY IMPLEMENTED
**Problem**: The SPCS SQL API token runs in app context. Without `schema: 'CORE'` in the request body, function overload resolution fails with "Invalid argument types" or "too many arguments."

**Status**: Already handled — `schema: 'CORE'` is set in the SQL API request body (index.ts line 111).

### Important Issues (Should Fix)

#### 5. ~~ORS Service Auto-Suspend~~ ✅ RESOLVED
**Problem**: City-provisioned ORS services (e.g., ORS_SERVICE_BERLIN) have `auto_suspend_secs=3600`. After suspension, graph loading takes ~2.5 minutes. Users see "connection_failed" errors without understanding why.

**Solution implemented**:
- Gateway error messages now include actionable steps: `CALL CORE.RESUME_ALL_SERVICES()`, `SELECT CORE.ORS_STATUS(region)`, `CALL CORE.SETUP_CITY_ORS(region)`
- Control center shows service_ready status (DONE in v1.0.24)

**Files changed**: `routing_service.py` — improved `get_ors_response()` error messages with retry hints.

#### 6. ~~VROOM Not Region-Aware~~ ✅ RESOLVED (v0.9.2)
**Problem**: OPTIMIZATION functions with region parameter route through VROOM, but VROOM only connects to the default ORS service (hardcoded in `config.yml`). Berlin coordinates return "out of bounds" from VROOM.

**Solution implemented**: Pre-computed matrices approach in the gateway (v0.9.2):
- Gateway's `/r/optimization_tabular` handler extracts region, resolves to regional ORS host
- For non-default regions, gateway calls the regional ORS `/matrix/{profile}` endpoint to pre-compute distance/duration matrices
- Remaps job `location` → `location_index` and vehicle `start`/`end` → `start_index`/`end_index`
- Passes matrices to VROOM with `options.g: false` (skip routing, use provided matrices)
- VROOM performs optimization logic only, using the pre-computed matrices
- Default region still uses VROOM → default ORS directly (no change)

**Key details**:
- VROOM matrices must be keyed by profile: `{"driving-car": {"durations": [...], "costs": [...]}}`
- VROOM uses `costs` (not `distances`); ORS `distances` are mapped to VROOM `costs`
- Matrix values must be rounded to integers (ORS returns floats)
- Response uses `location_index` in steps (no coordinate geometry) since VROOM skips routing

**Files changed**: `routing_service.py` — added `_compute_matrices_from_ors()`, `_collect_locations()`, `_remap_indices()` helpers; modified `_handle_optimization_tabular()` and `/r/optimization_tabular` handler.

**Skill guidance**: Document that multi-region OPTIMIZATION uses pre-computed matrices. Note the `location_index` response format for non-default regions.

#### 7. ~~Legacy Per-City Functions Remain After Migration to Region-Parameter Approach~~ ✅ RESOLVED
**Problem**: City provisioning creates `_BERLIN` suffixed functions. After migrating to region-parameter overloads, the old per-city functions remain and can cause confusion.

**Solution implemented**: Added `core.cleanup_legacy_functions()` procedure that drops per-city suffixed functions (_BERLIN, _MUNICH, _LONDON, _PARIS, _AMSTERDAM). Called automatically at the start of `create_functions()`.

**Files changed**: `setup_script.sql` — added `cleanup_legacy_functions()` procedure and call within `create_functions()`.

### UI/UX Issues

#### 8. ~~Browser Cache After Deploy~~ ✅ ALREADY IMPLEMENTED
**Problem**: After deploying a new control app version, users may see stale UI due to browser cache. The old `index-*.js` filename changes with each build (Vite content hash), but the browser may still cache index.html.

**Status**: Already handled — Express static middleware uses `no-cache` headers for HTML files and immutable caching for hashed assets (index.ts lines 1012-1033).

#### 9. ~~Control Center Should Show Graph Loading Status~~ ✅ ALREADY IMPLEMENTED
**Problem**: When an ORS service is running but graphs aren't loaded yet (service_ready=false), the control center showed "RUNNING" without indicating that functions would fail.

**Status**: Already handled — `/api/ors-readiness` endpoint and ServiceManager graph status display (DONE in v1.0.24).

### Deployment Process Improvements

#### 10. ~~deploy.sh Should Be Idempotent~~ ✅ RESOLVED
**Recommendation**: The deploy.sh should:
- Check if the current image matches the target before building
- Verify the service is actually running the new image after deploy (check SYSTEM$GET_SERVICE_STATUS)
- Upload YAML to package stage automatically
- Log the full image URI for debugging

**Solution implemented**: deploy.sh rewritten with 8 steps including YAML stage upload (step 5/8) and post-deploy image verification (step 8/8). Full image URI logged at start.

#### 11. ~~Add Version Tracking~~ ✅ RESOLVED
**Recommendation**: Add a VERSION table or config that tracks:
- Current control app version
- Gateway version
- Last upgrade timestamp
- Which functions exist and their ownership

**Solution implemented**: Added `core.VERSION_INFO` table with columns: COMPONENT, VERSION, UPDATED_AT, UPDATED_BY. `create_functions()` writes a version record via MERGE. Control app `/api/health` endpoint reads and returns version info.

**Files changed**: `setup_script.sql` — added VERSION_INFO table and MERGE in create_functions(); `index.ts` — `/api/health` reads VERSION_INFO.

#### 12. ~~Add Health Check Endpoint That Includes Version~~ ✅ RESOLVED
**Recommendation**: The `/api/health` endpoint should return:
```json
{
  "healthy": true,
  "version": "1.0.25",
  "services": { "ors": "READY", "gateway": "READY", "vroom": "READY" },
  "versions": { "setup_script": "1.1.0" }
}
```

**Solution implemented**:
- Gateway `/health` now returns `{status, version, ors_host, vroom_host}` (GATEWAY_VERSION constant)
- Control app `/api/health` now returns `{healthy, version, services: {ors, gateway, vroom}, versions: {...}}` by querying `SYSTEM$GET_SERVICE_STATUS` and `VERSION_INFO`

**Files changed**: `routing_service.py` — enhanced `/health` endpoint; `index.ts` — rewritten `/api/health` with service status + version info.

### Skill Documentation Improvements

#### 13. Add Troubleshooting Section
Include common error messages and their fixes:
- "Invalid argument types" → Check function ownership, call create_functions()
- "too many arguments" → Same as above
- "connection_failed" → Check if service is suspended, resume and wait for graph loading
- "Table already exists, no privileges" → Drop ACCOUNTADMIN-owned objects before upgrade
- "profile unknown" → Graphs still loading, wait for service_ready=true

#### 14. Add Pre-Flight Checks
Before any install/upgrade, verify:
1. Compute pool is ACTIVE
2. No ACCOUNTADMIN-owned objects in CORE schema
3. All service YAMLs on stage have correct image tags
4. External access integrations are granted

#### 15. Document the Full Lifecycle
```
Install → setup_script runs → version_init runs → services start → graphs load → functions available
Upgrade → setup_script re-runs → version_init re-runs → services altered → wait for rolling upgrade
City Provision → create service → wait for graphs → create_functions() → test
```
