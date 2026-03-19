# Plan: Add _GEO Wrapper Functions

## Problem

The `coco-direct` branch is missing the `_GEO` table functions (`DIRECTIONS_GEO`, `ISOCHRONES_GEO`, `OPTIMIZATION_GEO`) that exist on `main`. These were replaced by geocode functions during the refactoring. The route-deviation pipeline depends on `DIRECTIONS_GEO`.

## Root Cause

On `main` (directory: `oss-build-routing-solution-in-snowflake/`), lines 280-347 of `setup_script.sql` define SQL wrapper functions that convert scalar DIRECTIONS/ISOCHRONES/OPTIMIZATION responses into table functions with extracted GEOGRAPHY columns.

On `coco-direct` (directory: `build-routing-solution/`), those same line positions (284-322) contain MATRIX_TABULAR, GEOCODE, REVERSE_GEOCODE, GEOCODE_LOOKUP instead. The `_GEO` functions were not carried over.

## Why NOT a Full Git Merge

A `git merge main` produces 6+ conflicts across:
- README.md (add/add)
- ors-config.yml (rename/delete)  
- archive/setup_script.sql (content)
- Two deleted SKILL.md files (modify/delete)
- retail_catchment.py (modify/delete)

Plus the directory rename (`oss-build-routing-solution-in-snowflake/` -> `build-routing-solution/`) complicates everything. A surgical addition of just the `_GEO` functions is much safer.

## Implementation

### Task 1: Add _GEO Functions to setup_script.sql

Edit [build-routing-solution/Native_app/app/setup_script.sql](build-routing-solution/Native_app/app/setup_script.sql) at line 322 (after the GEOCODE_LOOKUP grant), inserting the following 6 function definitions from main:

```sql
   -- GeoJSON wrapper functions: return parsed geometry as separate columns
   -- DIRECTIONS_GEO (tabular overload)
   CREATE OR REPLACE FUNCTION core.DIRECTIONS_GEO(method VARCHAR, jstart ARRAY, jend ARRAY)
      RETURNS TABLE (RESPONSE VARIANT, GEOJSON GEOGRAPHY, DISTANCE FLOAT, DURATION FLOAT)
      LANGUAGE SQL
      AS
      'SELECT resp AS RESPONSE,
            TO_GEOGRAPHY(resp:features[0]:geometry) AS GEOJSON,
            resp:features[0]:properties:summary:distance::FLOAT AS DISTANCE,
            resp:features[0]:properties:summary:duration::FLOAT AS DURATION
         FROM (SELECT core.DIRECTIONS(method, jstart, jend) AS resp)';
   GRANT USAGE ON FUNCTION core.DIRECTIONS_GEO(VARCHAR, ARRAY, ARRAY) TO APPLICATION ROLE app_user;

   -- DIRECTIONS_GEO (raw overload with locations variant)
   CREATE OR REPLACE FUNCTION core.DIRECTIONS_GEO(method VARCHAR, locations VARIANT)
      RETURNS TABLE (RESPONSE VARIANT, GEOJSON GEOGRAPHY, DISTANCE FLOAT, DURATION FLOAT)
      LANGUAGE SQL
      AS
      'SELECT resp AS RESPONSE,
            TO_GEOGRAPHY(resp:features[0]:geometry) AS GEOJSON,
            resp:features[0]:properties:summary:distance::FLOAT AS DISTANCE,
            resp:features[0]:properties:summary:duration::FLOAT AS DURATION
         FROM (SELECT core.DIRECTIONS(method, locations) AS resp)';
   GRANT USAGE ON FUNCTION core.DIRECTIONS_GEO(VARCHAR, VARIANT) TO APPLICATION ROLE app_user;

   -- ISOCHRONES_GEO
   CREATE OR REPLACE FUNCTION core.ISOCHRONES_GEO(method TEXT, lon FLOAT, lat FLOAT, range INT)
      RETURNS TABLE (RESPONSE VARIANT, GEOJSON GEOGRAPHY)
      LANGUAGE SQL
      AS
      'SELECT resp AS RESPONSE,
            TO_GEOGRAPHY(resp:features[0]:geometry) AS GEOJSON
         FROM (SELECT core.ISOCHRONES(method, lon, lat, range) AS resp)';
   GRANT USAGE ON FUNCTION core.ISOCHRONES_GEO(TEXT, FLOAT, FLOAT, INT) TO APPLICATION ROLE app_user;

   -- OPTIMIZATION_GEO (tabular overload)
   CREATE OR REPLACE FUNCTION core.OPTIMIZATION_GEO(jobs ARRAY, vehicles ARRAY, matrices ARRAY DEFAULT [])
      RETURNS TABLE (RESPONSE VARIANT, GEOJSON GEOGRAPHY, VEHICLE INT, DURATION INT, STEPS VARIANT)
      LANGUAGE SQL
      AS
      'SELECT resp AS RESPONSE,
            TO_GEOGRAPHY(OBJECT_CONSTRUCT(''type'', ''LineString'', ''coordinates'', f.value:geometry)) AS GEOJSON,
            f.value:vehicle::INT AS VEHICLE,
            f.value:duration::INT AS DURATION,
            f.value:steps::VARIANT AS STEPS
         FROM (SELECT core.OPTIMIZATION(jobs, vehicles, matrices) AS resp),
            LATERAL FLATTEN(input => resp:routes) f';
   GRANT USAGE ON FUNCTION core.OPTIMIZATION_GEO(ARRAY, ARRAY, ARRAY) TO APPLICATION ROLE app_user;

   -- OPTIMIZATION_GEO (raw overload)
   CREATE OR REPLACE FUNCTION core.OPTIMIZATION_GEO(challenge VARIANT)
      RETURNS TABLE (RESPONSE VARIANT, GEOJSON GEOGRAPHY, VEHICLE INT, DURATION INT, STEPS VARIANT)
      LANGUAGE SQL
      AS
      'SELECT resp AS RESPONSE,
            TO_GEOGRAPHY(OBJECT_CONSTRUCT(''type'', ''LineString'', ''coordinates'', f.value:geometry)) AS GEOJSON,
            f.value:vehicle::INT AS VEHICLE,
            f.value:duration::INT AS DURATION,
            f.value:steps::VARIANT AS STEPS
         FROM (SELECT core.OPTIMIZATION(challenge) AS resp),
            LATERAL FLATTEN(input => resp:routes) f';
   GRANT USAGE ON FUNCTION core.OPTIMIZATION_GEO(VARIANT) TO APPLICATION ROLE app_user;
```

These are **pure SQL wrappers** over the existing scalar functions (DIRECTIONS, ISOCHRONES, OPTIMIZATION). No gateway/Python changes needed.

### Task 2: Upload to Stage

```bash
snow stage copy build-routing-solution/Native_app/app/setup_script.sql \
  @OPENROUTESERVICE_NATIVE_APP_PKG.APP_SRC.STAGE/ --connection fleet_test_evals --overwrite
```

### Task 3: Upgrade Native App

```sql
ALTER APPLICATION OPENROUTESERVICE_NATIVE_APP UPGRADE 
  USING '@OPENROUTESERVICE_NATIVE_APP_PKG.APP_SRC.STAGE';
```

This triggers `grant_callback` -> `create_functions()` which will create the new `_GEO` functions.

### Task 4: Verify

```sql
SELECT * FROM TABLE(OPENROUTESERVICE_NATIVE_APP.CORE.DIRECTIONS_GEO(
    'driving-hgv',
    OBJECT_CONSTRUCT('coordinates', ARRAY_CONSTRUCT(
        ARRAY_CONSTRUCT(13.388860, 52.517037),
        ARRAY_CONSTRUCT(13.397634, 52.529407)
    ))::VARIANT
));
```

Expected: Returns a row with DISTANCE > 0 (once ORS finishes building Germany graphs).

### Task 5: Continue Route-Deviation

Once `DIRECTIONS_GEO` is confirmed working, resume:
- Route cache batch population (9,343 OD pairs)
- 5-step ETL pipeline
- Streamlit deployment

## What This Preserves

- All skill refactoring in `.cortex/skills/` (SKILL.md updates, new skills, metadata)
- Nominatim removal from setup_script.sql
- MATRIX_TABULAR, GEOCODE functions (kept alongside new _GEO functions)
- Gateway image v0.7.2
- All working directory rename (`build-routing-solution/`)
- All uncommitted changes (ors-config.yml Germany update, openrouteservice.yaml volumes)

## Risk

None -- the `_GEO` functions are SQL-only wrappers. They call existing scalar functions that already work. No Python/gateway/Docker changes required.
