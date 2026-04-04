# Comprehensive Skill Evaluation Report

**Date:** 2026-03-18  
**Account:** UKB96706 (airpublic)  
**Evaluator:** Cortex Code  
**Skills Evaluated:** 17 (14 top-level + 3 subskills)

---

## Executive Summary

| Category | Result |
|----------|--------|
| **Eval Framework** | 50/50 pass (trigger: 16/16, quality: 17/17, xref: 17/17) |
| **Structural Validation** | 8 clean, 9 with issues (13 total issues) |
| **Python Syntax** | 55/55 files pass `ast.parse()` |
| **SQL Infrastructure DDL** | All compile and execute successfully |
| **S3 Data Loading** | Works but schema mismatch in route-deviation |
| **Dwell Analysis SQL** | **CRITICAL**: `ST_BUFFER` fails on GEOGRAPHY type |
| **Overture Maps Listings** | Not available on this account (expected) |
| **ORS Native App** | Not installed (blocks 12 skills at runtime) |

### Severity Counts

| Severity | Count | Description |
|----------|-------|-------------|
| **CRITICAL** | 3 | Broken SQL, data schema mismatches |
| **HIGH** | 4 | SQL injection, missing required sections |
| **MEDIUM** | 9 | Missing conventions, hardcoded values |
| **LOW** | 6 | Style inconsistencies, missing metadata |

---

## Phase 1: Eval Framework Results

```
TRIGGER EVALS:  16/16 skills pass
QUALITY EVALS:  17/17 skills pass (threshold=9/11)
XREF EVALS:    17/17 skills pass
OVERALL:       50/50 eval groups pass
```

### Quality Deductions (non-blocking)

| Skill | Deduction | Issue |
|-------|-----------|-------|
| build-routing-solution | check_9 | No error handling section |
| cleanup | check_10 | No examples or stopping points |
| fleet-intelligence-food-delivery | check_10 | No examples or stopping points |
| fleet-intelligence-taxis | check_10 | No examples or stopping points |
| routing-customization | check_9 | No error handling section |
| location (subskill) | check_9 | No error handling section |
| routing-prerequisites | check_9 | No error handling section |
| skill-optimiser | check_8 | Vague phrase: 'validate things properly' |
| synthetic-datasets-generator | check_10 | No examples or stopping points |

---

## Phase 2: Structural Validation

### CRITICAL Issues

#### C1. `dwell-analysis` — ST_BUFFER fails on GEOGRAPHY type
- **File:** `references/sql-pipeline.sql`, line ~12-28
- **SQL:** `ST_BUFFER(ST_MAKEPOINT(LOC_LON, LOC_LAT), 0.003)`
- **Error:** `Invalid argument types for function 'ST_BUFFER': (GEOGRAPHY, NUMBER(4,3))`
- **Fix:** Must use `ST_BUFFER(TO_GEOMETRY(ST_MAKEPOINT(LOC_LON, LOC_LAT)), 300)` (meters in GEOMETRY, not degrees in GEOGRAPHY)
- **Impact:** Entire dwell analysis pipeline fails at step 1. All 8 dynamic tables and downstream dashboards are blocked.

#### C2. `route-deviation` — S3 Parquet schema mismatch with table DDL
- **File:** `references/sql-pipeline.md` and `references/dataset-guide.md`
- **Issue:** The `COPY INTO` uses `MATCH_BY_COLUMN_NAME = CASE_INSENSITIVE`, but the table DDL defines column names that don't exist in the Parquet files:

| Table Column (DDL) | Parquet Column (Actual) | Status |
|---------------------|------------------------|--------|
| `LAT` | `LATITUDE` | **MISMATCH** → NULL |
| `LON` | `LONGITUDE` | **MISMATCH** → NULL |
| `RECORDED_AT` | `TS` (epoch) | **MISMATCH** → NULL |
| `HEADING` | `HEADING_DEG` | **MISMATCH** → NULL |
| `ODOMETER_KM` | (not in parquet) | **MISSING** → NULL |
| `PLATE_NUMBER` (truck_fleet) | (not in parquet) | **MISSING** → NULL |
| `DRIVER_NAME` (truck_fleet) | (not in parquet) | **MISSING** → NULL |
| `MAX_SPEED_KMH` (truck_fleet) | `BASE_SPEED_KMH` | **MISMATCH** → NULL |
| `DESTINATION_ID` (destinations) | `ID` | **MISMATCH** → NULL |
| `DESTINATION_NAME` (destinations) | `NAME` | **MISMATCH** → NULL |
| `LOC_LAT` (destinations) | `LAT` | **MISMATCH** → NULL |
| `LOC_LON` (destinations) | `LNG` | **MISMATCH** → NULL |
| `REST_STOP_NAME` (rest_stops) | `NAME` | **MISMATCH** → NULL |
| `LOC_LAT` (rest_stops) | `LAT` | **MISMATCH** → NULL |
| `LOC_LON` (rest_stops) | `LNG` | **MISMATCH** → NULL |
| `TRIP_ID` (trip_schedule) | (not in parquet) | **MISSING** → NULL |
| `DESTINATION_ID` (trip_schedule) | `DEST_ID` | **MISMATCH** → NULL |
| `DEPARTURE_TIME` (trip_schedule) | `SHIFT_START_TIME` (text) | **MISMATCH** → NULL |
| `ARRIVAL_TIME` (trip_schedule) | (not in parquet) | **MISSING** → NULL |

- **Result:** All 15M telemetry rows loaded with NULL coordinates and timestamps. All 5 reference tables have wrong column mappings.
- **Impact:** Entire route-deviation ETL chain produces empty/wrong results. Dwell-analysis (which depends on route-deviation data) also fails.

#### C3. `route-deviation` — S3 path mismatch
- **File:** `references/sql-pipeline.md`
- **Issue:** COPY commands reference `/germany/telemetry/`, `/germany/destinations/`, etc., but S3 actual paths are `/fact_truck_telemetry/`, `/germany_destinations/`, `/GERMANY_REST_STOPS/`, `/truck_fleet/`, `/trip_schedule/`
- **Impact:** COPY commands process 0 files

### HIGH Issues

#### H1. SQL Injection in Streamlit Apps (~10 files)
Multiple Streamlit files use f-string interpolation for user-selected values in SQL:
```python
WHERE TRUCK_ID = '{selected_truck}'   # dwell-analysis trip_inspector
WHERE TRIP_ID = '{selected_trip}'      # route-deviation Route_Inspector
WHERE NEAREST_CITY = '{city}'          # food-delivery Retail_Catchment
```
**Files affected:**
- `dwell-analysis/assets/streamlit/pages/4_Trip_Dwell_Inspector.py`
- `dwell-analysis/assets/sis/pages/7_Trip_Dwell_Inspector.py`
- `dwell-analysis/assets/sis/app_pages/trip_inspector.py`
- `route-deviation/dashboard/pages/Route_Inspector.py`
- `fleet-intelligence-food-delivery/assets/streamlit/pages/4_Retail_Catchment.py`

#### H2. Missing Required Privileges Table (5 skills)
- `synthetic-datasets-generator`
- `routing-customization`
- `fleet-intelligence-food-delivery`
- `travel-time-matrix`
- `fleet-intelligence-taxis`

#### H3. Missing Cleanup Section (2 skills)
- `synthetic-datasets-generator`
- `routing-customization`

#### H4. Missing query_tag (3 skills)
- `dwell-analysis` — no query_tag in SKILL.md or sql-pipeline.sql
- `routing-customization` — no query_tag anywhere
- `travel-time-matrix` — no query_tag in SKILL.md or references

### MEDIUM Issues

#### M1. `synthetic-datasets-generator` — query_tag typo
- **Value:** `"synthetic-datasets-genertor"` (missing 'a')
- **Should be:** `"synthetic-datasets-generator"`

#### M2. `synthetic-datasets-generator` — No object COMMENTs
- None of the CREATE statements include the tracking COMMENT tag

#### M3. `routing-customization` — Missing `depends_on`
- This skill modifies ORS config but doesn't declare `depends_on: build-routing-solution` in frontmatter

#### M4. Hardcoded database/schema names (~35 Python files)
- `FLEET_INTELLIGENCE.DWELL_ANALYSIS` in 22 dwell-analysis files
- `OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.*` in 4 taxis files
- `OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.*` in 7 food-delivery files
- Should be parameterized or read from session context

#### M5. Hardcoded fallback connection names (8 Python files)
- `or "airpublic"` in 5 dwell-analysis local Streamlit files
- `or "default"` in 3 synthetic-datasets-generator files

#### M6. `dwell-analysis/assets/sis/app_pages/root_cause.py` — Cross-schema reference
- References `SYNTHETIC_DATASETS.FLEET_INTELLIGENCE.TRIP_SCHEDULE` directly instead of through the dwell-analysis schema

#### M7. `routing-agent` — Configuration uses bullets instead of table
- Has a Configuration section but uses bullet list format instead of the convention `| Parameter | Default | Description |` table

#### M8. `retail-catchment` — Configuration section uses list format
- Same style inconsistency as routing-agent

#### M9. Overture Maps Marketplace listings not available
- `GZTSZAS2KIG` (Addresses) and `GZTSZAS2KHT` (Places) — listing IDs may be region-specific
- Affects: `retail-catchment`, `route-optimization`, `fleet-intelligence-food-delivery`, `fleet-intelligence-taxis`

### LOW Issues

#### L1. Missing metadata block (2 subskills)
- `routing-customization/location/SKILL.md` — no `metadata:` block with author/version
- `routing-customization/routing-profiles/SKILL.md` — no `metadata:` block

#### L2. Quality eval deductions (non-blocking)
- 4 skills missing error handling sections
- 4 skills missing examples/stopping points
- 1 skill has vague phrases

#### L3. `route-optimization/assets/notebooks/add_carto_data.ipynb` — Nearly empty (137 bytes)
- Only contains minimal stub, not a functioning notebook

#### L4. `fleet-intelligence-taxis/assets/streamlit/pages/2_Heat_Map.py` — Stub file (128 bytes)
- Not a complete implementation

#### L5. `route-deviation` — Dashboard files stored outside assets/
- `route-deviation/dashboard/` instead of `route-deviation/assets/dashboard/`
- Inconsistent with other skills' directory structure

#### L6. No `part_0110` in S3 telemetry data
- Part numbering jumps from `part_0109` to `part_0111` — possible missing partition

---

## Phase 3: Deployment Test Results

### Infrastructure DDL (All Pass)

| SQL Statement | Skill | Result |
|---------------|-------|--------|
| CREATE DATABASE OPENROUTESERVICE_SETUP | build-routing-solution | ✅ |
| CREATE STAGE ORS_SPCS_STAGE (x3) | build-routing-solution | ✅ |
| CREATE IMAGE REPOSITORY | build-routing-solution | ✅ |
| CREATE WAREHOUSE ROUTING_ANALYTICS | build-routing-solution | ✅ |
| CREATE SCHEMA ROUTING_AGENT | routing-agent | ✅ |
| CREATE WAREHOUSE ROUTING_AGENT_WH | routing-agent | ✅ |
| CREATE SCHEMA FLEET_INTELLIGENCE_TAXIS | fleet-intelligence-taxis | ✅ |
| CREATE SCHEMA FLEET_INTELLIGENCE_FOOD_DELIVERY | fleet-intelligence-food-delivery | ✅ |
| CREATE SCHEMA VEHICLE_ROUTING_SIMULATOR | route-optimization | ✅ |
| CREATE SCHEMA RETAIL_CATCHMENT_DEMO | retail-catchment | ✅ |
| CREATE DATABASE SYNTHETIC_DATASETS | route-deviation | ✅ |
| CREATE DATABASE FLEET_INTELLIGENCE | route-deviation | ✅ |
| CREATE SCHEMA DEVIATION_ANALYSIS | route-deviation | ✅ |
| CREATE SCHEMA DWELL_ANALYSIS | dwell-analysis | ✅ |

### S3 Data Loading

| Table | Source Path | Rows Loaded | Issues |
|-------|-------------|-------------|--------|
| FACT_TRUCK_TELEMETRY | `/fact_truck_telemetry/` | 15,132,221 | Schema mismatch: LAT/LON/RECORDED_AT all NULL |
| GERMANY_DESTINATIONS | `/germany_destinations/` | 75,242 | Schema mismatch: DESTINATION_ID/LOC_LAT/LOC_LON NULL |
| GERMANY_REST_STOPS | `/GERMANY_REST_STOPS/` | 6,315 | Schema mismatch: REST_STOP_NAME/LOC_LAT/LOC_LON NULL |
| TRUCK_FLEET | `/truck_fleet/` | 500 | Schema mismatch: PLATE_NUMBER/DRIVER_NAME/MAX_SPEED_KMH NULL |
| TRIP_SCHEDULE | `/trip_schedule/` | 9,343 | Schema mismatch: TRIP_ID/DESTINATION_ID/DEPARTURE_TIME NULL |

**NOTE:** The S3 data exists and loads, but the column name mappings between the Parquet files and the CREATE TABLE DDL in `route-deviation/references/sql-pipeline.md` are wrong. The Parquet files were produced by `synthetic-datasets-generator` with different column names than what `route-deviation` expects.

### ETL Compile Tests

| SQL | Skill | Result |
|-----|-------|--------|
| GEOFENCE_POLYGONS CTAS | dwell-analysis | ❌ `ST_BUFFER(GEOGRAPHY, NUMBER)` invalid |
| GEOFENCE_POLYGONS (fixed with TO_GEOMETRY) | dwell-analysis | ✅ |
| DT_STATE_CHANGES (with TO_GEOMETRY fix) | dwell-analysis | ✅ Compiles |
| TRIP_ACTUAL_METRICS CTAS | route-deviation | ✅ Compiles, 0 rows (NULL coords) |

### Blocked by ORS (Cannot Test)

These skills require the ORS Native App to be running:
- `route-optimization` — VROOM optimization calls
- `fleet-intelligence-taxis` — Overture Maps + DIRECTIONS function
- `fleet-intelligence-food-delivery` — DIRECTIONS + VROOM functions
- `retail-catchment` — ISOCHRONE function
- `routing-agent` — ORS tool procedures
- `travel-time-matrix` — MATRIX_TABULAR function
- `synthetic-datasets-generator` — DIRECTIONS function for route generation
- `routing-customization` — Service config modifications

---

## Phase 4: Python Asset Validation

### Syntax: 55/55 files pass

### Security Findings

| Category | Files | Severity |
|----------|-------|----------|
| SQL injection via f-string | ~10 files | HIGH |
| Hardcoded DB.SCHEMA names | ~35 files | MEDIUM |
| Hardcoded fallback connection | 8 files | MEDIUM |
| No credentials/secrets found | All | ✅ |

---

## Phase 5: Cross-Skill Dependency Analysis

### Dependency Chain Issues

```
synthetic-datasets-generator → produces Parquet with columns: LATITUDE, LONGITUDE, TS, HEADING_DEG
route-deviation → expects columns: LAT, LON, RECORDED_AT, HEADING
dwell-analysis → depends on route-deviation data + own ST_BUFFER bug
```

**Root Cause:** The `synthetic-datasets-generator` Python code produces Parquet files with one schema, but the `route-deviation` SQL pipeline expects a different schema. These two skills were likely developed independently and never tested end-to-end together.

### Missing Dependency Declaration

- `routing-customization` should declare `depends_on: [build-routing-solution]` but doesn't

---

## Recommendations

### Immediate Fixes (CRITICAL)

1. **Fix `dwell-analysis/references/sql-pipeline.sql`**: Replace `ST_BUFFER(ST_MAKEPOINT(...), 0.003)` with `ST_BUFFER(TO_GEOMETRY(ST_MAKEPOINT(...)), 300)` and update the DT_STATE_CHANGES join to use `TO_GEOMETRY()` as well.

2. **Fix `route-deviation/references/sql-pipeline.md`**: Update all CREATE TABLE DDL to match the actual Parquet column names from `synthetic-datasets-generator`:
   - `LATITUDE` not `LAT`, `LONGITUDE` not `LON`, `TS` not `RECORDED_AT`, `HEADING_DEG` not `HEADING`
   - Or add column aliases in the COPY/CTAS statements

3. **Fix S3 paths** in `route-deviation/references/sql-pipeline.md`:
   - `/germany/telemetry/` → `/fact_truck_telemetry/`
   - `/germany/destinations/` → `/germany_destinations/`
   - etc.

### Short-Term Fixes (HIGH)

4. **Fix SQL injection** in ~10 Streamlit files: Use parameterized queries or Snowpark `filter(col("X") == value)`

5. **Add Required Privileges table** to 5 skills

6. **Add Cleanup section** to `synthetic-datasets-generator` and `routing-customization`

7. **Add query_tag** to `dwell-analysis`, `routing-customization`, `travel-time-matrix`

### Medium-Term Improvements

8. **Fix `synthetic-datasets-generator` query_tag typo**: `genertor` → `generator`
9. **Add object COMMENTs** to `synthetic-datasets-generator` CREATE statements
10. **Add `depends_on: [build-routing-solution]`** to `routing-customization` frontmatter
11. **Add metadata blocks** to `location` and `routing-profiles` subskills
12. **Parameterize hardcoded DB/schema names** in Python files
13. **Remove hardcoded fallback connection names** (`"airpublic"`, `"default"`)

---

## Test Account Cleanup

All test objects created during this evaluation have been dropped:
- OPENROUTESERVICE_SETUP (database)
- SYNTHETIC_DATASETS (database)
- FLEET_INTELLIGENCE (database)
- ROUTING_ANALYTICS (warehouse)
- ROUTING_AGENT_WH (warehouse)

Account is back to its original state (MY_WH + SYSTEM$STREAMLIT_NOTEBOOK_WH only).
