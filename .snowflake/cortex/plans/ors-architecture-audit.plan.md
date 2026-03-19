# ORS Architecture Rework -- Audit Report

## Scope

All changes from Phases 1-5 and 7-8 of the v5 architecture plan. 15 new files, 6 modified files.

---

## CRITICAL -- Bugs

### C1. SQL Injection in [server/index.ts](build-routing-solution/Native_app/services/ors_control_app/server/index.ts)

Seven endpoints construct SQL from unsanitized user input via string interpolation. While this runs inside SPCS (internal-only), it is still a significant vulnerability:

| Line | Endpoint | Injection Surface |
|------|----------|-------------------|
| 155 | `POST /api/cities/provision` | `region`, `city`, `pbf_url`, `bbox.*` all interpolated into INSERT |
| 132 | `GET /api/cities` | `c.region.toUpperCase()` in SHOW SERVICES LIKE |
| 159 | `POST /api/cities/provision` | `pbf_url` in SELECT DOWNLOAD call |
| 163 | `POST /api/cities/provision` | `region` in SETUP_CITY_ORS call |
| 276 | `POST /api/matrix/build` | `region` in SELECT, and `matrixFn` in BUILD_MATRIX_FOR_REGION |
| 249 | `GET /api/matrix/existing` | `region` in WHERE clause |
| 311 | `POST /api/query` | **Arbitrary SQL execution** -- the `/api/query` endpoint accepts raw SQL |

**Fix:** Sanitize all user inputs (whitelist alphanumeric + underscore for region names, validate bbox as floats). For `/api/query`, either remove entirely or add a read-only prefix (`SELECT` only).

### C2. `retail_catchment.py` -- ISOCHRONES_GEO returns GEOGRAPHY not GeoJSON string

In [retail_catchment.py:172-178](/.cortex/skills/retail-catchment/assets/streamlit/retail_catchment.py):
```python
geo_json = json.loads(result.loc[0, 'GEO'])
return {
    'minutes': minutes,
    'coordinates': geo_json['coordinates'],
    'geo_wkt': result.loc[0, 'GEO']
}
```

`ISOCHRONES_GEO` returns a `GEOGRAPHY` typed column (via `TO_GEOGRAPHY(...)`). When fetched via `session.sql().to_pandas()`, Snowpark returns this as a GeoJSON **string** in some cases and a `dict` in others depending on the Snowpark version. If it comes back as a dict, `json.loads()` will fail. Also, `geo_wkt` is mislabeled -- the value is GeoJSON, not WKT.

**Fix:** Use `ST_ASGEOJSON(GEOJSON)` in the query to guarantee a string, or handle both types:
```python
raw = result.loc[0, 'GEO']
geo_json = json.loads(raw) if isinstance(raw, str) else raw
```

### C3. `CHECK_HEALTH()` called as function but defined as procedure

In [setup_script.sql:734-749](build-routing-solution/Native_app/app/setup_script.sql), `CHECK_HEALTH()` is defined as a **PROCEDURE** (returns BOOLEAN). But in [server/index.ts:90](build-routing-solution/Native_app/services/ors_control_app/server/index.ts):
```typescript
const rows = await runSql(`SELECT ${SF_DATABASE}.CORE.CHECK_HEALTH() AS H`);
```
You cannot `SELECT` a procedure -- you must `CALL` it.

**Fix:** Either:
- Change `CHECK_HEALTH` to a UDF: `CREATE OR REPLACE FUNCTION core.CHECK_HEALTH() RETURNS BOOLEAN ...`
- Or change the server to `CALL core.CHECK_HEALTH()` and parse the result

### C4. `create_city_ors_service` -- Inline JSON spec is fragile and missing `REBUILD_GRAPHS`

In [setup_script.sql:447](build-routing-solution/Native_app/app/setup_script.sql):
```sql
ors_spec := '{"spec":{"containers":[{"name":"ors","image":"/openrouteservice_setup/public/image_repository/openrouteservice:v9.0.0",...,"env":{"REBUILD_GRAPHS":"false",...}
```

When a city is first provisioned, `REBUILD_GRAPHS` should be `"true"` (graphs don't exist yet). It's hardcoded to `"false"`, so the ORS instance will fail to start for a new city that has no pre-built graphs.

**Fix:** Accept a `P_REBUILD_GRAPHS` parameter defaulting to `'true'`, or detect if graphs exist on the stage path before deciding.

### C5. `create_city_functions` only creates DIRECTIONS and MATRIX -- no ISOCHRONES

In [setup_script.sql:463-501](build-routing-solution/Native_app/app/setup_script.sql), `create_city_functions` creates:
- `DIRECTIONS_{REGION}` (two overloads)
- `MATRIX_{REGION}`

But does NOT create:
- `ISOCHRONES_{REGION}`
- `OPTIMIZATION_{REGION}`
- Any `_GEO` variants

This is inconsistent. Users who provision a city will only get directions and matrix, not the full function set.

**Fix:** Add ISOCHRONES and OPTIMIZATION city-prefixed functions (and optionally their `_GEO` wrappers).

---

## HIGH -- Missing Parts

### H1. Dockerfile does not copy `node_modules` for production dependencies

In [Dockerfile:13](build-routing-solution/Native_app/services/ors_control_app/Dockerfile):
```dockerfile
RUN npm install --omit=dev && npm install tsx
```

This runs in the final stage, but `COPY --from=builder /app/package.json ./` does not include a lock file. The production install may resolve different versions than the build. Also, `tsx` is a dev tool that should ideally be avoided in production.

**Fix:** Either:
- Copy `package-lock.json` alongside `package.json`
- Or compile server TypeScript in the build stage and use plain `node` instead of `tsx`:
```dockerfile
RUN npm run build:server  # compile to JS
CMD ["node", "dist-server/index.js"]
```

### H2. `tsconfig.json` only includes `src/` -- server TypeScript is not compiled

[tsconfig.json](build-routing-solution/Native_app/services/ors_control_app/tsconfig.json):
```json
"include": ["src"]
```

The `server/index.ts` is not included, so `tsc -b` (used in `npm run build`) will not type-check the server code. The `package.json` has a `"start": "node dist-server/index.js"` script, but there's no `dist-server` output configured.

**Fix:** Add a `tsconfig.server.json` for the server, or extend the main tsconfig to include `server/`.

### H3. `grant_callback` does not call `create_control_app()`

In [setup_script.sql:381-398](build-routing-solution/Native_app/app/setup_script.sql), the `grant_callback` procedure (called on app install) runs:
```sql
CALL CORE.create_compute_pool();
CALL CORE.create_stages();
CALL CORE.start_downloader();
CALL CORE.create_services();
CALL CORE.create_functions();
```

It does NOT call `CORE.create_control_app()`. The React UI service will never start automatically on install.

**Fix:** Add `CALL CORE.create_control_app();` to the grant_callback, after `create_functions`.

### H4. `version_init` does not update the control app service

In [setup_script.sql:6-27](build-routing-solution/Native_app/app/setup_script.sql), `version_init` updates specs for ors_service, vroom_service, gateway, and downloader but not `ors_control_app`.

**Fix:** Add:
```sql
ALTER SERVICE IF EXISTS core.ors_control_app
   FROM SPECIFICATION_FILE='services/ors_control_app/ors_control_app_service.yaml';
```

### H5. Matrix tables missing TRUNCATE and UPDATE grants

The 12 matrix tables grant `SELECT`, `INSERT`, and `DELETE` but NOT `TRUNCATE`. However, `BUILD_HEXAGONS`, `BUILD_WORK_QUEUE`, and `RESET_MATRIX_DATA` all use `TRUNCATE TABLE`. These procedures run as `EXECUTE AS OWNER` so this works, but if a user calls TRUNCATE directly, it fails.

Additionally, `CITY_ORS_MAP` does not have `TRUNCATE` either.

### H6. `SUSPEND_ALL_SERVICES` will suspend the control app itself

The SUSPEND procedure iterates ALL non-job services and suspends them, including `ors_control_app`. This is a self-destruct issue -- the React UI will kill its own container.

**Fix:** Exclude the control app from suspension:
```sql
WHERE "is_job" = 'false' AND "name" != 'ORS_CONTROL_APP'
```

### H7. Missing `.gitignore` / `.dockerignore` for ors_control_app

No `.dockerignore` means `node_modules/`, `.git`, and other unnecessary files get copied into the Docker build context, inflating image size significantly.

---

## MEDIUM -- Improvements

### M1. `SCALE_SERVICES` uses MAX_INSTANCES for pool nodes -- should use a separate value

[setup_script.sql:691](build-routing-solution/Native_app/app/setup_script.sql):
```sql
ALTER COMPUTE POOL IF EXISTS IDENTIFIER(:pool_name) SET MIN_NODES = :P_MAX_INSTANCES MAX_NODES = :P_MAX_INSTANCES;
```

This ties pool nodes 1:1 with service instances. If you scale to 1-2 instances, the pool gets set to min=2, max=2 nodes. Should accept a separate pool node parameter or calculate based on total service demand.

### M2. `RESUME_ALL_SERVICES` counts READY as "already_running" but doesn't resume them

[setup_script.sql:603-612](build-routing-solution/Native_app/app/setup_script.sql): Services in states other than `SUSPENDED` (e.g., `STARTING`, `FAILED`, `STOPPING`) are counted as "already_running" which is misleading.

**Fix:** Add specific handling for FAILED services (report them) and only count RUNNING/READY as "already_running".

### M3. `MatrixBuilder.tsx` -- region selection uses `fetchRegions` without `selectedRegion` dep

[MatrixBuilder.tsx:83](build-routing-solution/Native_app/services/ors_control_app/src/components/MatrixBuilder.tsx):
```typescript
const fetchRegions = useCallback(async () => { ... }, []);
```

The `fetchRegions` callback has an empty dependency array but references `selectedRegion` in the auto-select logic. This is a stale closure, but since it only sets the default on first load, it's functionally OK. However, ESLint would flag it.

### M4. `FunctionTester.tsx` -- SQL uses `core.` prefix without database qualifier

[FunctionTester.tsx:26-41](build-routing-solution/Native_app/services/ors_control_app/src/components/FunctionTester.tsx): All generated SQL uses `core.ORS_STATUS()`, `core.DIRECTIONS(...)`, etc. without the `SF_DATABASE` prefix. This works when the server prepends `USE DATABASE`, but the user might edit the SQL and expect it to be fully qualified.

**Fix:** Include the database prefix in generated SQL, or add a note in the UI.

### M5. `create_city_ors_service` drops service before creating -- data loss risk

[setup_script.sql:449](build-routing-solution/Native_app/app/setup_script.sql):
```sql
EXECUTE IMMEDIATE 'DROP SERVICE IF EXISTS core.' || svc_name;
```

This unconditionally drops the existing service, destroying any cached routing graphs. Should check if the service already exists and is healthy before dropping.

### M6. `FLATTEN_MATRIX_RAW` deletes by region but raw table has no REGION column

[setup_script.sql:1163](build-routing-solution/Native_app/app/setup_script.sql):
```sql
EXECUTE IMMEDIATE 'DELETE FROM ' || target_table || ' WHERE REGION = ''' || P_REGION || ''' OR REGION IS NULL';
```

The `TRAVEL_TIME_RES*` tables have a REGION column, so this works. However, `MATRIX_RAW_RES*` tables do NOT have a REGION column, meaning you can't build matrices for multiple regions concurrently (they share the same raw table). If you build for region A, then region B, the raw table still has region A's data mixed in.

**Fix:** Add a REGION column to `MATRIX_RAW_RES*` tables.

### M7. Missing `_GEO` variants in FunctionTester

The FunctionTester UI only lists the 6 base functions (DIRECTIONS, ISOCHRONES, OPTIMIZATION, MATRIX, MATRIX_TABULAR, ORS_STATUS) but not the new `_GEO` table functions. Since `_GEO` functions are a major feature of this rework, they should be testable.

### M8. `ors_control_app_service.yaml` hardcodes `COMPUTE_WH` warehouse

[ors_control_app_service.yaml:8](build-routing-solution/Native_app/services/ors_control_app/ors_control_app_service.yaml):
```yaml
SNOWFLAKE_WAREHOUSE: "COMPUTE_WH"
```

This may not exist in the consumer's account. The food delivery app also hardcodes this, but the ORS control app should use the same pattern as other ORS services or make it configurable.

### M9. `setup_city_ors` calls `create_services()` -- creates default ORS alongside city ORS

[setup_script.sql:511](build-routing-solution/Native_app/app/setup_script.sql):
```sql
CALL core.create_services();
```

This creates the default gateway + ORS services even if the user only wants a city-specific deployment. The gateway is needed (for routing), but the main `ors_service` may not be desired.

### M10. `BUILD_TRAVEL_TIME_RANGE` hardcodes `'driving-car'` profile

[setup_script.sql:1028](build-routing-solution/Native_app/app/setup_script.sql):
```sql
core.MATRIX_TABULAR('driving-car', ...)
```

The profile is hardcoded. Users with HGV or cycling profiles cannot use this procedure directly.

---

## LOW -- Cosmetic / Documentation

### L1. Tracking tags missing from procedures

The 16 COMMENT tags cover tables and the schema, but none of the 20+ procedures have tracking tags. The cleanup skill won't discover these objects.

### L2. `ISOCHRONES_GEO` returns single row -- loses multi-feature info

The base `ISOCHRONES` function can return multiple features (multiple range rings). `ISOCHRONES_GEO` only extracts `features[0]`, losing any additional rings. This matches the current usage (single range per call), but is a documented limitation.

### L3. CityProvisioner uses emoji icons

[CityProvisioner.tsx:21-25](build-routing-solution/Native_app/services/ors_control_app/src/components/CityProvisioner.tsx) and [MatrixBuilder.tsx:47-52](build-routing-solution/Native_app/services/ors_control_app/src/components/MatrixBuilder.tsx) use emoji characters for phase icons. These may not render correctly in all container environments.

---

## Summary

| Severity | Count | Key Items |
|----------|-------|-----------|
| CRITICAL | 5 | SQL injection (C1), GEO output handling (C2), CHECK_HEALTH as proc (C3), REBUILD_GRAPHS=false (C4), incomplete city functions (C5) |
| HIGH | 7 | Dockerfile issues (H1-H2), missing grant_callback call (H3), version_init gap (H4), self-suspend (H6), no dockerignore (H7) |
| MEDIUM | 10 | Pool scaling (M1), status reporting (M2), stale closure (M3), unqualified SQL (M4), drop-before-create (M5), no region in raw (M6), missing _GEO in tester (M7), hardcoded warehouse (M8), unnecessary services (M9), hardcoded profile (M10) |
| LOW | 3 | Missing proc tags (L1), single-feature limit (L2), emoji rendering (L3) |
