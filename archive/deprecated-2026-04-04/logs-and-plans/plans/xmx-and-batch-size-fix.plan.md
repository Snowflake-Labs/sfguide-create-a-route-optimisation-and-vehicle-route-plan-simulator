# Plan: Set XMX=20G and batch_size=100

## Changes

### 1. XMX: 200G -> 20G (4 files)

City ORS service spec (dynamically created services like ORS_SERVICE_BERLIN):
- [native_app/app/modules/03_city_management.sql](.cortex/skills/build-routing-solution/native_app/app/modules/03_city_management.sql) line 204: `"XMX":"200G"` -> `"XMX":"20G"`
- [native_app/output/deploy/modules/03_city_management.sql](.cortex/skills/build-routing-solution/native_app/output/deploy/modules/03_city_management.sql) line 204: same change (deploy symlink copy)

Default ORS service YAML (the main 3-instance ORS_SERVICE):
- [native_app/services/openrouteservice/openrouteservice.yaml](.cortex/skills/build-routing-solution/native_app/services/openrouteservice/openrouteservice.yaml) line 15: `XMX: 200G` -> `XMX: 20G`
- [native_app/output/deploy/services/openrouteservice/openrouteservice.yaml](.cortex/skills/build-routing-solution/native_app/output/deploy/services/openrouteservice/openrouteservice.yaml) line 15: same change (deploy copy)

### 2. batch_size: 50 -> 100 (1 file, 2 locations)

- [native_app/app/modules/05_matrix_pipeline.sql](.cortex/skills/build-routing-solution/native_app/app/modules/05_matrix_pipeline.sql) line 226: `batch_size := 50` -> `batch_size := 100` (BUILD_TRAVEL_TIME_RANGE)
- Same file line 346: `batch_size := 50` -> `batch_size := 100` (BUILD_TRAVEL_TIME_RANGE_REGION)

### 3. Redeploy

After editing, run `snow app run` to push the updated procedures to Snowflake. Then recreate the Berlin ORS service so it picks up the new XMX:
```sql
CALL OPENROUTESERVICE_NATIVE_APP.CORE.CREATE_CITY_ORS_SERVICE('Berlin');
```

Note: The currently running matrix job will need to be either waited out or cancelled. The new settings take effect on the next build.
