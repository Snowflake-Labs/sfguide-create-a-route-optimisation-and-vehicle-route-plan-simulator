---
name: "fix-skill-dashboard-issues"
created: "2026-03-24T15:13:36.556Z"
status: pending
---

# Plan: Fix Skill Dashboard Issues

## Problem Statement

Three interrelated issues make all 4 deployed demos show empty dashboards:

1. **Schema mismatch**: React pages hardcode SQL queries with column/table names that don't match what the SQL pipelines produce
2. **No ORS region awareness**: Dashboards don't know what ORS region is active, so map centers are wrong and region-specific demos can't validate their prerequisites
3. **Streamlit duplication**: Each skill deploys both a Streamlit app (interactive, with live ORS calls) and registers React dashboard pages (read-only). User wants React-only.

---

## Root Cause Analysis

### Schema Mismatches (every demo is broken)

```
flowchart LR
    subgraph sqlPipeline [SQL Pipeline Output]
        A1["TRIP_SUMMARY view<br/>ROUTE_DISTANCE_METERS<br/>ROUTE_DURATION_SECS<br/>ORIGIN, DESTINATION<br/>TRIP_START_TIME"]
        A2["TRIP_DEVIATION_ANALYSIS<br/>DISTANCE_DEVIATION_KM<br/>DISTANCE_DEVIATION_PCT<br/>TRIP_ID, TRIP_DATE"]
        A3["JOB_TEMPLATE<br/>slot_start, slot_end<br/>skills, product"]
        A4["RETAIL_POIS<br/>BASIC_CATEGORY<br/>CITY"]
    end
    subgraph reactExpected [React Page Expects]
        B1["TRIP_SUMMARY<br/>TRIP_DISTANCE_KM<br/>TRIP_DURATION_MIN<br/>PICKUP_POINT, DROPOFF_POINT<br/>TRIP_START"]
        B2["ROUTE_DEVIATIONS<br/>DEVIATION_DISTANCE_KM<br/>DEVIATION_PCT<br/>ROUTE_ID, ROUTE_DATE"]
        B3["JOB_TEMPLATE<br/>JOB_ID, STATUS<br/>TOTAL_VEHICLES, TOTAL_STOPS"]
        B4["RETAIL_POIS<br/>POI_TYPE<br/>CITY_NAME"]
    end
    A1 -.->|"MISMATCH"| B1
    A2 -.->|"MISMATCH"| B2
    A3 -.->|"MISMATCH"| B3
    A4 -.->|"MISMATCH"| B4
```

#### Fleet Taxis (`FleetOverview.tsx`, `HeatMap.tsx`)

| React expects         | Pipeline has            | Fix                                                                  |
| --------------------- | ----------------------- | -------------------------------------------------------------------- |
| `TRIP_H3_HEXES` table | Does not exist          | Create new adapter view with H3 conversion                           |
| `TRIP_DISTANCE_KM`    | `ROUTE_DISTANCE_METERS` | `ROUND(ROUTE_DISTANCE_METERS / 1000, 2) AS TRIP_DISTANCE_KM`         |
| `TRIP_DURATION_MIN`   | `ROUTE_DURATION_SECS`   | `ROUND(ROUTE_DURATION_SECS / 60, 1) AS TRIP_DURATION_MIN`            |
| `PICKUP_POINT`        | `ORIGIN`                | `ORIGIN AS PICKUP_POINT`                                             |
| `DROPOFF_POINT`       | `DESTINATION`           | `DESTINATION AS DROPOFF_POINT`                                       |
| `TRIP_START`          | `TRIP_START_TIME`       | `TRIP_START_TIME AS TRIP_START`                                      |
| `FARE_AMOUNT`         | Does not exist          | Synthesize: `ROUND(3.50 + (ROUTE_DISTANCE_METERS / 1000) * 2.80, 2)` |

**Approach**: Modify the existing `TRIP_SUMMARY` view definition in `sql-pipeline.md` (line 779) to alias columns to React-expected names. Create a new `TRIP_H3_HEXES` view that converts `ORIGIN`/`DESTINATION` geography points to H3 hexes using `H3_POINT_TO_CELL`.

#### Route Deviation (`DeviationDashboard.tsx`, `RouteComparison.tsx`)

| React expects                 | Pipeline has                | Fix                                                        |
| ----------------------------- | --------------------------- | ---------------------------------------------------------- |
| `ROUTE_DEVIATIONS` table      | `TRIP_DEVIATION_ANALYSIS`   | Create adapter view                                        |
| `ROUTE_ID`                    | `TRIP_ID`                   | Alias                                                      |
| `DEVIATION_PCT`               | `DISTANCE_DEVIATION_PCT`    | Alias                                                      |
| `DEVIATION_DISTANCE_KM`       | `DISTANCE_DEVIATION_KM`     | Alias                                                      |
| `ROUTE_DATE`                  | `TRIP_DATE`                 | Alias                                                      |
| `ACTUAL_ROUTE_POINTS` table   | `ACTUAL_PATH` (GEOGRAPHY)   | New view: explode LineString to points via lateral flatten |
| `EXPECTED_ROUTE_POINTS` table | `EXPECTED_PATH` (GEOGRAPHY) | Same approach                                              |

**Approach**: Add 3 adapter views to `sql-pipeline.md`:

1. `ROUTE_DEVIATIONS` view over `TRIP_DEVIATION_ANALYSIS` with column aliases
2. `ACTUAL_ROUTE_POINTS` view that flattens `ACTUAL_PATH` LineString geometry into individual points
3. `EXPECTED_ROUTE_POINTS` view that flattens `EXPECTED_PATH` LineString geometry into individual points

#### Route Optimization (`RouteOptimization.tsx`)

| React expects                | Pipeline has                      | Fix                          |
| ---------------------------- | --------------------------------- | ---------------------------- |
| `PLACES.PLACE_ID`            | No ID column                      | Use `ROW_NUMBER()` or `SEQ`  |
| `PLACES.PLACE_NAME`          | `NAME`                            | Alias                        |
| `PLACES.PLACE_TYPE`          | `CATEGORY`                        | Alias                        |
| `JOB_TEMPLATE` (job results) | `JOB_TEMPLATE` (VRP input params) | Different semantics entirely |
| `LOOKUP` (route steps)       | `LOOKUP` (industry config)        | Different semantics entirely |

**Approach**: The route-optimization React page expects a fundamentally different data model than what the pipeline produces. The pipeline creates VRP *input* data (places to visit, job templates, industry lookup); the React page expects VRP *output* data (completed optimization jobs with routes). Two options:

- **Option A (recommended)**: Rewrite the React page to match the actual pipeline data model -- show the PLACES catalog and JOB\_TEMPLATE parameters as input configuration, removing the non-existent job results display
- **Option B**: Create a stored procedure in the SQL pipeline that runs a sample VRP optimization and stores results in the React-expected schema. This is complex and fragile.

For the `PLACES` table, we can create a simple adapter view:

```
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES_V AS
SELECT ROW_NUMBER() OVER (ORDER BY NAME) AS PLACE_ID, NAME AS PLACE_NAME, CATEGORY AS PLACE_TYPE, GEOMETRY
FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES;
```

#### Retail Catchment (`RetailCatchment.tsx`)

| React expects                | Pipeline has     | Fix   |
| ---------------------------- | ---------------- | ----- |
| `POI_TYPE`                   | `BASIC_CATEGORY` | Alias |
| `CITY_NAME` (in both tables) | `CITY`           | Alias |

**Approach**: Create adapter views or modify the CTAS in `sql-pipeline.md` to add aliases:

```
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.RETAIL_CATCHMENT.RETAIL_POIS_V AS
SELECT *, BASIC_CATEGORY AS POI_TYPE, CITY AS CITY_NAME FROM RETAIL_POIS;
```

Or better: modify the original CTAS to include the aliased columns directly.

---

### ORS Region Awareness

Current state of the demo-dashboard server's `/api/ors/status` endpoint (server/index.ts line 311):

```
// Only checks: is ORS installed? Is the control app service running?
// Returns: { installed: boolean, status: 'available'|'starting'|'not_installed' }
// Does NOT return: region name, enabled profiles, map bounds
```

**Fix**: Extend the endpoint to call `ORS_STATUS()` (already available as a SQL function) and return:

- Current region name (from MAP\_CONFIG or ORS service description)
- Enabled routing profiles (from ORS\_STATUS response)
- Map bounding box (from MAP\_CONFIG)

Then pass this to each React page via the existing `config` prop, allowing pages to:

- Auto-center maps on the correct region
- Show a warning banner if ORS region doesn't match the demo's requirements
- Display available routing profiles in UI controls

---

### Streamlit Removal

Each skill currently has 2 deployment paths:

1. Streamlit app (interactive, live ORS) -- **to be removed**
2. React dashboard pages (read-only) -- **to be the only path**

Files to remove from each skill:

| Skill                    | Streamlit assets path         | SKILL.md steps to remove   |
| ------------------------ | ----------------------------- | -------------------------- |
| fleet-intelligence-taxis | `assets/streamlit/` (7 files) | Step 10 (deploy Streamlit) |
| retail-catchment         | `assets/streamlit/` (5 files) | Step 7 (deploy Streamlit)  |
| route-deviation          | `dashboard/` (3 files)        | Step 7 (deploy Streamlit)  |
| route-optimization       | `assets/streamlit/` (5 files) | Step 9 (deploy Streamlit)  |

**Important**: Some Streamlit features have no React equivalent (live ORS isochrones in retail-catchment, VRP solver in route-optimization, AI trip analysis in fleet-taxis). If these are needed, the React pages must be enhanced -- but that's a separate, larger effort.

---

## Implementation Steps

### Task 1: Create adapter views in SQL pipelines

For each skill's `references/sql-pipeline.md`, add a new "Dashboard Adapter Views" section at the end with CREATE VIEW statements that map actual columns to React-expected names.

**Fleet Taxis** -- add to `sql-pipeline.md`:

```
-- Modify TRIP_SUMMARY view to include React-expected aliases
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TRIP_SUMMARY AS
WITH trip_stats AS (
    SELECT TRIP_ID, AVG(KMH) AS AVERAGE_KMH, MAX(KMH) AS MAX_KMH
    FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_LOCATIONS
    GROUP BY TRIP_ID
)
SELECT 
    rg.*,
    ts.AVERAGE_KMH,
    ts.MAX_KMH,
    -- React dashboard aliases
    ROUND(rg.ROUTE_DISTANCE_METERS / 1000, 2) AS TRIP_DISTANCE_KM,
    ROUND(rg.ROUTE_DURATION_SECS / 60, 1) AS TRIP_DURATION_MIN,
    rg.ORIGIN AS PICKUP_POINT,
    rg.DESTINATION AS DROPOFF_POINT,
    rg.TRIP_START_TIME AS TRIP_START,
    ROUND(3.50 + (rg.ROUTE_DISTANCE_METERS / 1000) * 2.80, 2) AS FARE_AMOUNT
FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_ROUTE_GEOMETRIES rg
LEFT JOIN trip_stats ts ON rg.TRIP_ID = ts.TRIP_ID;

-- New: H3 hexagon view for HeatMap page
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TRIP_H3_HEXES AS
SELECT 
    H3_POINT_TO_CELL(ORIGIN, 8) AS H3_INDEX,
    ROUND(3.50 + (ROUTE_DISTANCE_METERS / 1000) * 2.80, 2) AS FARE_AMOUNT
FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_ROUTE_GEOMETRIES
WHERE ORIGIN IS NOT NULL;
```

**Route Deviation** -- add to `sql-pipeline.md`:

```
CREATE OR REPLACE VIEW {TARGET_DB}.{TARGET_SCHEMA}.ROUTE_DEVIATIONS AS
SELECT 
    TRIP_ID AS ROUTE_ID,
    DRIVER_ID,
    TRIP_DATE AS ROUTE_DATE,
    DISTANCE_DEVIATION_PCT AS DEVIATION_PCT,
    DISTANCE_DEVIATION_KM AS DEVIATION_DISTANCE_KM,
    ACTUAL_DISTANCE_KM,
    ACTUAL_PATH,
    EXPECTED_PATH
FROM {TARGET_DB}.{TARGET_SCHEMA}.TRIP_DEVIATION_ANALYSIS;

CREATE OR REPLACE VIEW {TARGET_DB}.{TARGET_SCHEMA}.ACTUAL_ROUTE_POINTS AS
SELECT 
    t.TRIP_ID AS ROUTE_ID,
    f.INDEX AS POINT_INDEX,
    ST_MAKEPOINT(
        GET(f.VALUE, 0)::FLOAT,
        GET(f.VALUE, 1)::FLOAT
    ) AS GEOMETRY
FROM {TARGET_DB}.{TARGET_SCHEMA}.TRIP_DEVIATION_ANALYSIS t,
    LATERAL FLATTEN(INPUT => ST_ASGEOJSON(t.ACTUAL_PATH):coordinates) f;

CREATE OR REPLACE VIEW {TARGET_DB}.{TARGET_SCHEMA}.EXPECTED_ROUTE_POINTS AS
SELECT 
    t.TRIP_ID AS ROUTE_ID,
    f.INDEX AS POINT_INDEX,
    ST_MAKEPOINT(
        GET(f.VALUE, 0)::FLOAT,
        GET(f.VALUE, 1)::FLOAT
    ) AS GEOMETRY
FROM {TARGET_DB}.{TARGET_SCHEMA}.TRIP_DEVIATION_ANALYSIS t,
    LATERAL FLATTEN(INPUT => ST_ASGEOJSON(t.EXPECTED_PATH):coordinates) f;
```

**Retail Catchment** -- modify the CTAS in `sql-pipeline.md` to include aliased columns, or add adapter views:

```
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.RETAIL_CATCHMENT.RETAIL_POIS_V AS
SELECT *, BASIC_CATEGORY AS POI_TYPE, CITY AS CITY_NAME FROM RETAIL_POIS;
```

Then update the React page to query `RETAIL_POIS_V` instead of `RETAIL_POIS`. **Or simpler**: just add the aliased columns to the original CTAS so no view is needed.

**Route Optimization** -- The React page's data model is fundamentally incompatible. Recommend:

- Create a `PLACES_V` adapter view with `PLACE_ID`, `PLACE_NAME`, `PLACE_TYPE`
- Rewrite `RouteOptimization.tsx` to remove the JOB\_TEMPLATE results table (which shows completed VRP jobs that don't exist) and instead show the `JOB_TEMPLATE` as what it actually is: a catalog of delivery job configurations
- Remove the LOOKUP route-steps query since LOOKUP is an industry config table

### Task 2: Fix hardcoded map centers in React pages

In `FleetOverview.tsx` (line 79), `HeatMap.tsx` (line 54), and `DriverRoutes.tsx`:

- Add data-driven auto-centering (like RetailCatchment already does)
- Change fallback from NYC (-73.98, 40.75) to a neutral default or use ORS region info

In `RouteOptimization.tsx` (line 75):

- Already auto-centers on data -- just fix fallback from Germany (10.4, 51.1) to neutral

### Task 3: Add ORS region/profile info to demo-dashboard server

In `server/index.ts`, extend the `/api/ors/status` endpoint:

```
app.get('/api/ors/status', async (_req, res) => {
  // Existing: check if ORS app is installed
  // NEW: If installed, also query:
  //   SELECT * FROM OPENROUTESERVICE_NATIVE_APP.CORE.MAP_CONFIG LIMIT 1
  //   SELECT OPENROUTESERVICE_NATIVE_APP.CORE.ORS_STATUS() AS S
  // Return: { installed, status, region, profiles, bounds }
});
```

Update `useOrsStatus()` hook in `useRegistry.ts` to expose region/profiles. Pages can then use `config.orsRegion` and `config.orsProfiles` for map centering and profile selection.

### Task 4: Remove Streamlit from skills

For each skill:

1. Delete the Streamlit assets directory
2. Remove the Streamlit deployment step from SKILL.md
3. Remove the stage creation for Streamlit files
4. Renumber remaining steps

### Task 5: Add ORS region validation to skill pipelines

Add a standardized "ORS Compatibility Check" step at the beginning of each skill's SKILL.md that:

1. Queries `ORS_STATUS()` to get current region and profiles
2. Compares against the skill's requirements (e.g., route-deviation needs Germany + driving-hgv)
3. If mismatch: offers to invoke `routing-customization` to install the required region
4. Blocks pipeline execution until region is compatible

Template for each skill:

```
### Step N: Verify ORS Region Compatibility
Required region: <REGION> | Required profiles: <PROFILES>
1. Query: SELECT OPENROUTESERVICE_NATIVE_APP.CORE.ORS_STATUS() AS S
2. Parse response for profiles and service_ready
3. If region mismatch or missing profiles: "ORS is configured for {current_region} but this demo requires {required_region}. Run the routing-customization skill to switch."
```

### Task 6: Document React schema contract in SKILL.md

Add a "Dashboard Schema Contract" section to each skill's SKILL.md listing the exact views/columns the React pages expect. Include a verification query:

```
-- Verify dashboard adapter views
SELECT 'ROUTE_DEVIATIONS' AS VIEW_NAME, COUNT(*) FROM ROUTE_DEVIATIONS
UNION ALL SELECT 'ACTUAL_ROUTE_POINTS', COUNT(*) FROM ACTUAL_ROUTE_POINTS
UNION ALL SELECT 'EXPECTED_ROUTE_POINTS', COUNT(*) FROM EXPECTED_ROUTE_POINTS;
```

### Task 7: Update demo-dashboard registration seeding

Verify and fix the `setup_script.sql` REGISTER\_DEMO calls to ensure REQUIRED\_DATABASE and REQUIRED\_SCHEMA match the actual pipeline outputs. Currently all point to `FLEET_INTELLIGENCE` with the correct schema names, so this is mostly a verification step.

---

## Recommendations for Long-term Quality

1. **Schema contract testing**: Add a CI/CD step or skill-level validation that compares React page SQL queries against the actual Snowflake schema to catch mismatches before deployment.

2. **Centralize ORS config**: Create a shared ORS utility (SQL function or stored procedure) that returns `{ region, profiles, bounds }` in a standard format. All skills and the demo-dashboard should use this single source of truth instead of 4 different detection methods.

3. **React page data abstraction**: Instead of hardcoding SQL in React components, create a data layer where each page declares its required tables/columns and the server validates them at startup, returning meaningful errors instead of silent empty pages.

4. **Skill dependency graph**: Formalize skill dependencies (e.g., route-deviation requires ORS-Germany, fleet-taxis requires ORS-matching-city) as structured metadata in SKILL.md, not just prose. The demo-dashboard can read this to show prerequisite warnings.

5. **Integration tests**: Each skill should include a `verify.sql` script that runs after deployment and checks all expected tables, views, row counts, and column names exist. The demo-dashboard registration step should only proceed if verification passes.
