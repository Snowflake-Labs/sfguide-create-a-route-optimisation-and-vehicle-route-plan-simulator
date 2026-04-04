---
name: "fix-skill-dashboard-architecture"
created: "2026-03-24T15:42:17.505Z"
status: pending
---

# Plan: Fix Skill Dashboard Architecture

## Problem Statement

Three interrelated issues cause all 4 deployed demos to show empty dashboards:

1. **Schema mismatch**: React pages hardcode SQL queries with table/column names that don't match what SQL pipelines produce
2. **No ORS region awareness**: Dashboards can't adapt to the active ORS region -- wrong map centers, no profile validation
3. **Streamlit duplication**: Each skill deploys both Streamlit (interactive, live ORS) and React (read-only). User wants React-only with full interactive parity.

## Approach Decision

**Rewrite React pages** to query the actual pipeline schemas directly, rather than creating adapter views. Rationale:

- Adapter views add a maintenance layer that can drift silently
- React pages can be designed around the actual data model from the start
- Simpler deployment (no extra DDL step)
- The React pages also need interactive feature additions (ORS calls, AI), so they need rewriting anyway

---

## Architecture Overview

```
flowchart TB
    subgraph skillPipeline [Skill SQL Pipelines]
        S1[fleet-intelligence-taxis<br/>14 tables/views]
        S2[route-deviation<br/>11 tables]
        S3[retail-catchment<br/>4 tables]
        S4[route-optimization<br/>4 tables]
    end
    subgraph server [Demo Dashboard Server]
        API["/api/query - SQL Proxy"]
        ORS["/api/ors/status - Region+Profiles"]
        REG["/api/registry - Schema Detection"]
    end
    subgraph react [React Pages - Rewritten]
        R1[FleetOverview + DriverRoutes + HeatMap]
        R2[DeviationDashboard + RouteComparison + RouteInspector]
        R3[RetailCatchment - with Live Isochrones]
        R4[RouteOptimization - with VRP Solver]
    end
    S1 --> API
    S2 --> API
    S3 --> API
    S4 --> API
    API --> R1
    API --> R2
    API --> R3
    API --> R4
    ORS --> R3
    ORS --> R4
```

---

## Task 1: Rewrite Fleet Taxis React Pages (3 pages)

### Current problem

React queries `TRIP_DISTANCE_KM`, `TRIP_DURATION_MIN`, `PICKUP_POINT`, `DROPOFF_POINT`, `TRIP_START`, `FARE_AMOUNT`, `TRIP_H3_HEXES` -- none of which exist.

### Actual pipeline schema (from `sql-pipeline.md`)

**TRIP\_SUMMARY** view columns: `DRIVER_ID, TRIP_ID, TRIP_START_TIME, TRIP_END_TIME, ORIGIN_ADDRESS, DESTINATION_ADDRESS, ROUTE_DURATION_SECS, ROUTE_DISTANCE_METERS, GEOMETRY, ORIGIN, DESTINATION, SHIFT_TYPE, AVERAGE_KMH, MAX_KMH`

**DRIVER\_LOCATIONS\_V** view columns: `TRIP_ID, DRIVER_ID, PICKUP_TIME, DROPOFF_TIME, PICKUP_LOCATION, DROPOFF_LOCATION, ROUTE, POINT_GEOM, LON, LAT, CURR_TIME, POINT_TIME, POINT_INDEX, DRIVER_STATE, KMH`

**TRIPS\_ASSIGNED\_TO\_DRIVERS** view columns: `DRIVER_ID, TRIP_ID, GEOMETRY, ORIGIN, DESTINATION, ORIGIN_ADDRESS, DESTINATION_ADDRESS, PICKUP_TIME, DROPOFF_TIME`

### Changes to `FleetOverview.tsx`

```
// KPI query - use actual column names with inline conversion
const { data: kpis } = useSfQuery(
  `SELECT COUNT(DISTINCT DRIVER_ID) AS DRIVERS, COUNT(DISTINCT TRIP_ID) AS TRIPS,
          ROUND(AVG(ROUTE_DISTANCE_METERS / 1000), 1) AS AVG_DISTANCE_KM,
          ROUND(AVG(ROUTE_DURATION_SECS / 60), 1) AS AVG_DURATION_MIN
   FROM TRIP_SUMMARY`, sourceDb, sourceSchema);

// Recent trips - use ORIGIN/DESTINATION instead of PICKUP_POINT/DROPOFF_POINT
const { data: recent } = useSfQuery(
  `SELECT TRIP_ID, DRIVER_ID,
          ST_X(ORIGIN) AS P_LNG, ST_Y(ORIGIN) AS P_LAT,
          ST_X(DESTINATION) AS D_LNG, ST_Y(DESTINATION) AS D_LAT,
          ROUND(ROUTE_DISTANCE_METERS / 1000, 2) AS TRIP_DISTANCE_KM,
          ROUND(ROUTE_DURATION_SECS / 60, 1) AS TRIP_DURATION_MIN
   FROM TRIP_SUMMARY ORDER BY TRIP_START_TIME DESC LIMIT 200`, sourceDb, sourceSchema);

// Hourly distribution - use TRIP_START_TIME
const { data: hourly } = useSfQuery(
  `SELECT HOUR(TRIP_START_TIME) AS HOUR, COUNT(*) AS TRIPS
   FROM TRIP_SUMMARY GROUP BY 1 ORDER BY 1`, sourceDb, sourceSchema);
```

Add data-driven auto-centering (replace hardcoded NYC):

```
const viewState = useMemo(() => {
  const valid = recent.filter((r: any) => r.P_LNG && r.D_LNG);
  if (valid.length) {
    const lngs = valid.flatMap((r: any) => [Number(r.P_LNG), Number(r.D_LNG)]);
    const lats = valid.flatMap((r: any) => [Number(r.P_LAT), Number(r.D_LAT)]);
    return { longitude: (Math.min(...lngs) + Math.max(...lngs)) / 2,
             latitude: (Math.min(...lats) + Math.max(...lats)) / 2, zoom: 11 };
  }
  return { longitude: -122.4, latitude: 37.8, zoom: 11 }; // neutral fallback
}, [recent]);
```

### Changes to `HeatMap.tsx`

Replace `TRIP_H3_HEXES` with inline H3 computation from actual data:

```
const { data, loading } = useSfQuery(
  `SELECT H3_POINT_TO_CELL_STRING(ORIGIN, 8) AS H3_INDEX,
          COUNT(*) AS TRIP_COUNT,
          ROUND(AVG(3.50 + (ROUTE_DISTANCE_METERS / 1000) * 2.80), 2) AS AVG_FARE
   FROM TRIP_SUMMARY
   WHERE ORIGIN IS NOT NULL
   GROUP BY 1 HAVING TRIP_COUNT >= 2
   ORDER BY TRIP_COUNT DESC LIMIT 8000`, sourceDb, sourceSchema);
```

Remove FARE\_AMOUNT metric toggle (synthetic) or keep with the inline formula. Auto-center map on data.

### Changes to `DriverRoutes.tsx`

Update all queries to use actual column names (`ROUTE_DISTANCE_METERS / 1000`, `ROUTE_DURATION_SECS / 60`, `ORIGIN`/`DESTINATION`, `TRIP_START_TIME`). Auto-center on data.

### New Interactive Features (from Streamlit parity)

**Time-slider driver tracking** -- Add to DriverRoutes page:

- Driver dropdown queries `SELECT DISTINCT DRIVER_ID FROM TRIP_SUMMARY`
- Trip dropdown queries trips for selected driver
- On trip select: `SELECT LON, LAT, CURR_TIME, KMH, DRIVER_STATE FROM DRIVER_LOCATIONS_V WHERE TRIP_ID = '...' ORDER BY POINT_INDEX`
- React range slider scrubs through GPS timestamps, updating a ScatterplotLayer marker position
- Current speed/state displayed in sidebar

**AI Trip Analysis** -- Add to DriverRoutes page:

- "Analyze" button triggers: `SELECT SNOWFLAKE.CORTEX.COMPLETE('claude-3-5-sonnet', '...') AS ANALYSIS` via `/api/query`
- Display response in a card below the map

**H3 Time-slice controls** -- Add to HeatMap page:

- Hour slider (0-23) parameterizes query: `WHERE HOUR(PICKUP_TIME) = ${hour}` on `DRIVER_LOCATIONS_V`
- Resolution slider (7-9) changes `H3_POINT_TO_CELL_STRING(POINT_GEOM, ${res})`

---

## Task 2: Rewrite Route Deviation React Pages (2 pages + 1 new)

### Current problem

React expects `ROUTE_DEVIATIONS`, `ACTUAL_ROUTE_POINTS`, `EXPECTED_ROUTE_POINTS` tables -- none exist.

### Actual pipeline schema

**TRIP\_DEVIATION\_ANALYSIS**: `TRIP_ID, TRUCK_ID, DRIVER_ID, TRIP_DATE, ROUTE_VARIATION, ACTUAL_DISTANCE_KM, EXPECTED_DISTANCE_KM, DISTANCE_DEVIATION_KM, DISTANCE_DEVIATION_PCT, IS_ROUTE_DEVIATION, ACTUAL_PATH, EXPECTED_PATH, ORIGIN_NAME, DEST_NAME, ...`

**DRIVER\_DEVIATION\_SUMMARY**: `TRUCK_ID, DRIVER_ID, DRIVER_PROFILE, TOTAL_TRIPS, DEVIATION_TRIPS, DEVIATION_RATE_PCT, AVG_DISTANCE_DEVIATION_PCT, ...`

**DAILY\_DEVIATION\_TRENDS**: `TRIP_DATE, DAY_OF_WEEK, TOTAL_TRIPS, DEVIATION_TRIPS, DEVIATION_RATE_PCT, ...`

### Changes to `DeviationDashboard.tsx`

```
// KPIs - query TRIP_DEVIATION_ANALYSIS with actual columns
const { data: kpis } = useSfQuery(
  `SELECT COUNT(*) AS TOTAL_ROUTES,
          ROUND(AVG(DISTANCE_DEVIATION_KM), 2) AS AVG_DEVIATION_KM,
          ROUND(AVG(DISTANCE_DEVIATION_PCT), 1) AS AVG_DEVIATION_PCT,
          SUM(CASE WHEN DISTANCE_DEVIATION_PCT > 20 THEN 1 ELSE 0 END) AS HIGH_DEVIATION_COUNT,
          ROUND(100.0 * SUM(CASE WHEN DISTANCE_DEVIATION_PCT <= 5 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 1) AS ON_ROUTE_PCT
   FROM TRIP_DEVIATION_ANALYSIS`, sourceDb, sourceSchema);

// Daily trend - use DAILY_DEVIATION_TRENDS directly (pre-aggregated!)
const { data: daily } = useSfQuery(
  `SELECT TRIP_DATE, TOTAL_TRIPS AS ROUTES, DEVIATION_RATE_PCT AS AVG_DEV_PCT
   FROM DAILY_DEVIATION_TRENDS ORDER BY TRIP_DATE`, sourceDb, sourceSchema);

// Deviation buckets - use DISTANCE_DEVIATION_PCT
const { data: buckets } = useSfQuery(
  `SELECT CASE WHEN DISTANCE_DEVIATION_PCT <= 5 THEN '0-5%' ...
   FROM TRIP_DEVIATION_ANALYSIS GROUP BY 1 ORDER BY 1`, sourceDb, sourceSchema);

// Top deviators - use DRIVER_DEVIATION_SUMMARY (pre-aggregated!)
const { data: topDeviators } = useSfQuery(
  `SELECT DRIVER_ID, TOTAL_TRIPS AS ROUTES, 
          ROUND(AVG_DISTANCE_DEVIATION_PCT, 1) AS AVG_DEV_PCT,
          ROUND(MAX_DISTANCE_DEVIATION_PCT, 2) AS MAX_DEV_PCT
   FROM DRIVER_DEVIATION_SUMMARY ORDER BY AVG_DISTANCE_DEVIATION_PCT DESC LIMIT 15`, sourceDb, sourceSchema);
```

Auto-center map on Germany (10.4, 51.1) -- this is correct for route-deviation since data is always Germany.

### Changes to `RouteComparison.tsx`

Instead of querying nonexistent `ACTUAL_ROUTE_POINTS`/`EXPECTED_ROUTE_POINTS`, extract points from GEOGRAPHY LineStrings inline:

```
// Route list
const { data: routes } = useSfQuery(
  `SELECT TRIP_ID, DRIVER_ID, TRIP_DATE, 
          ROUND(DISTANCE_DEVIATION_PCT, 1) AS DEV_PCT,
          ROUND(DISTANCE_DEVIATION_KM, 2) AS DEV_KM,
          ROUND(ACTUAL_DISTANCE_KM, 1) AS ACTUAL_KM
   FROM TRIP_DEVIATION_ANALYSIS ORDER BY DISTANCE_DEVIATION_PCT DESC LIMIT 100`, sourceDb, sourceSchema);

// On route click - extract points from GEOGRAPHY paths
const loadRoute = async (tripId: string) => {
  const paths = await query(
    `SELECT 
       f_a.INDEX AS A_IDX, GET(f_a.VALUE, 0)::FLOAT AS A_LNG, GET(f_a.VALUE, 1)::FLOAT AS A_LAT,
       f_e.INDEX AS E_IDX, GET(f_e.VALUE, 0)::FLOAT AS E_LNG, GET(f_e.VALUE, 1)::FLOAT AS E_LAT
     FROM TRIP_DEVIATION_ANALYSIS t,
       LATERAL FLATTEN(INPUT => ST_ASGEOJSON(t.ACTUAL_PATH):coordinates) f_a,
       LATERAL FLATTEN(INPUT => ST_ASGEOJSON(t.EXPECTED_PATH):coordinates) f_e
     WHERE t.TRIP_ID = '${tripId}' AND f_a.INDEX = f_e.INDEX`,
    { database: sourceDb, schema: sourceSchema });
  // OR two separate queries for actual/expected
};
```

### New Page: RouteInspector (Streamlit parity)

Create new file: `.cortex/skills/demo-dashboard/assets/react-app/src/pages/route-deviation/RouteInspector.tsx`

Register in `PageRegistry.tsx` as `deviation-inspector` with route `/route-deviation/inspector`.

Features to port from Streamlit `Route_Inspector.py`:

- **Truck/driver selector** dropdown querying `SELECT DISTINCT TRUCK_ID, DRIVER_ID FROM FACT_TRUCK_TELEMETRY` (source schema)
- **Trip selector** with deviation info in label
- **GPS point query**: `SELECT LATITUDE, LONGITUDE, SPEED_KMH, HEADING_DEG, POSTED_SPEED_KMH, GPS_ACCURACY_M, IS_DETOUR, TS FROM FACT_TRUCK_TELEMETRY WHERE TRIP_ID = '...' ORDER BY TS`
- **Client-side teleportation detection**: JavaScript haversine between consecutive points, flag >200km/h AND >5km jumps
- **Toggle controls**: Show teleports (red dots), Hide teleported, Show detours (orange), GPS accuracy filter slider
- **Speed profile chart**: Recharts LineChart with actual speed vs posted speed limit over time
- **GPS accuracy area chart**: Recharts AreaChart of GPS\_ACCURACY\_M over time
- **Point-level DataTable** with computed flags

Note: This page queries from **two schemas** -- `FLEET_INTELLIGENCE.ROUTE_DEVIATION` for deviation data and `SYNTHETIC_DATASETS.FLEET_INTELLIGENCE` for raw telemetry. The `sourceDb`/`sourceSchema` pattern needs to be extended or the second schema hardcoded/configurable.

Add to `setup_script.sql` registration:

```
CALL core.REGISTER_DEMO('deviation-inspector', 'Route Inspector', 'GPS telemetry inspector with teleportation detection', 'Route Deviation', 'Search', 203, 'FLEET_INTELLIGENCE', 'ROUTE_DEVIATION');
```

---

## Task 3: Rewrite Retail Catchment React Page (1 page, major enhancement)

### Current problem

Column name mismatches (`POI_TYPE` vs `BASIC_CATEGORY`, `CITY_NAME` vs `CITY`) AND no live ORS isochrone functionality.

### Actual pipeline schema

**RETAIL\_POIS**: `POI_ID, POI_NAME, BASIC_CATEGORY, LONGITUDE, LATITUDE, GEOMETRY, ADDRESS, CITY, STATE, POSTCODE`

**CITIES\_BY\_STATE**: `STATE, CITY, POI_COUNT`

**REGIONAL\_ADDRESSES**: `ID, GEOMETRY, LONGITUDE, LATITUDE, CITY, POSTCODE`

### Changes to `RetailCatchment.tsx`

Fix column names:

```
const { data: cities } = useSfQuery(
  `SELECT DISTINCT CITY FROM CITIES_BY_STATE ORDER BY CITY LIMIT 50`, sourceDb, sourceSchema);

const { data: pois, loading } = useSfQuery(
  `SELECT POI_ID, POI_NAME, BASIC_CATEGORY, CITY,
          ST_X(GEOMETRY) AS LNG, ST_Y(GEOMETRY) AS LAT
   FROM RETAIL_POIS
   ${selectedCity !== 'ALL' ? `WHERE CITY = '${selectedCity}'` : ''}
   ${poiType !== 'ALL' ? `${selectedCity !== 'ALL' ? 'AND' : 'WHERE'} BASIC_CATEGORY = '${poiType}'` : ''}
   LIMIT 2000`, sourceDb, sourceSchema, [selectedCity, poiType]);

const { data: typeStats } = useSfQuery(
  `SELECT BASIC_CATEGORY AS POI_TYPE, COUNT(*) AS CNT FROM RETAIL_POIS GROUP BY 1 ORDER BY CNT DESC LIMIT 20`, sourceDb, sourceSchema);
```

### New Interactive Features (from Streamlit parity)

Add live ORS isochrone functionality:

```
// Store selector (when category + city selected)
const [selectedStore, setSelectedStore] = useState<any>(null);
const [catchmentZones, setCatchmentZones] = useState<any[]>([]);

// Isochrone config
const [travelMode, setTravelMode] = useState('foot-walking');
const [numZones, setNumZones] = useState(3);
const [maxMinutes, setMaxMinutes] = useState(15);

// Analyze Catchment button handler
const analyzeCatchment = async () => {
  const zones = [];
  for (let i = numZones; i >= 1; i--) {
    const minutes = Math.round(maxMinutes * (i / numZones));
    const result = await query(
      `SELECT GEOJSON AS GEO
       FROM TABLE(OPENROUTESERVICE_NATIVE_APP.CORE.ISOCHRONES_GEO(
         '${travelMode}',
         ${selectedStore.LNG}::FLOAT,
         ${selectedStore.LAT}::FLOAT,
         ${minutes}::INT
       ))`, { database: 'OPENROUTESERVICE_NATIVE_APP', schema: 'CORE' });
    zones.push({ minutes, geojson: JSON.parse(result[0]?.GEO) });
  }
  setCatchmentZones(zones);

  // Find competitors within largest isochrone
  const competitors = await query(
    `SELECT POI_ID, POI_NAME, BASIC_CATEGORY, ST_X(GEOMETRY) AS LNG, ST_Y(GEOMETRY) AS LAT
     FROM ${sourceDb}.${sourceSchema}.RETAIL_POIS
     WHERE POI_ID != '${selectedStore.POI_ID}'
       AND ST_WITHIN(GEOMETRY, TO_GEOGRAPHY('${JSON.stringify(zones[0].geojson)}'))
     LIMIT 500`);

  // H3 address density within catchment
  const density = await query(
    `SELECT H3_POINT_TO_CELL_STRING(GEOMETRY, ${h3Res}) AS H3_INDEX, COUNT(*) AS ADDR_COUNT
     FROM ${sourceDb}.${sourceSchema}.REGIONAL_ADDRESSES
     WHERE ST_WITHIN(GEOMETRY, TO_GEOGRAPHY('${JSON.stringify(zones[0].geojson)}'))
     GROUP BY 1 ORDER BY ADDR_COUNT DESC LIMIT 5000`);
};
```

Render zones as `GeoJsonLayer` with graduated opacity, competitors as `ScatterplotLayer`, density as `H3HexagonLayer`.

UI controls:

- Category dropdown, Store search text input, Store dropdown
- Travel mode radio (Walking/Driving)
- Number of zones slider (1-5)
- Max travel time slider (5-60 min)
- Toggle: Show competitors, Show address density
- H3 resolution slider (7-10, when density on)
- "Analyze Catchment" button
- Stats cards: store name, travel time, competitor count, addresses in zone

---

## Task 4: Rewrite Route Optimization React Page (1 page, major enhancement)

### Current problem

React expects VRP output data (`JOB_ID`, `STATUS`, `TOTAL_VEHICLES`, `ROUTE_ID`...) but pipeline only creates VRP input data (`PLACES`, `JOB_TEMPLATE` as delivery slots, `LOOKUP` as industry config).

### Actual pipeline schema

**PLACES**: `GEOMETRY, PHONES, CATEGORY, NAME, ADDRESS, ALTERNATE` **JOB\_TEMPLATE**: `ID, SLOT_START, SLOT_END, SKILLS, PRODUCT, STATUS` **LOOKUP**: `INDUSTRY, PA, PB, PC, IND, IND2, CTYPE, STYPE`

### Complete Rewrite of `RouteOptimization.tsx`

This page needs to become a full VRP simulator (porting from Streamlit `routing.py`):

**Phase 1: Configuration Panel**

```
// Industry selector from LOOKUP table
const { data: industries } = useSfQuery(
  `SELECT INDUSTRY, PA, PB, PC FROM LOOKUP`, sourceDb, sourceSchema);

// AI geocoding for place search
const geocode = async (place: string) => {
  const r = await query(
    `SELECT SNOWFLAKE.CORTEX.COMPLETE('claude-sonnet-4-5',
       'Give me LAT and LON for: ${place}. Return exactly: LAT,LON,ZOOM') AS RESULT`);
  // Parse "lat,lon,zoom" from response
};

// Places within radius
const { data: places } = useSfQuery(
  `SELECT NAME, CATEGORY, ST_X(GEOMETRY) AS LNG, ST_Y(GEOMETRY) AS LAT
   FROM PLACES WHERE ST_DWITHIN(GEOMETRY, ST_MAKEPOINT(${lon}, ${lat}), ${radius * 1000})
   LIMIT 200`, sourceDb, sourceSchema, [lat, lon, radius]);
```

**Phase 2: Vehicle Configuration**

- 3 vehicle config cards (collapsible)
- Per vehicle: profile dropdown (from ORS status), start/end hour sliders, capacity, skills

**Phase 3: Catchment Preview**

```
// Isochrone preview
const previewCatchment = async () => {
  const r = await query(
    `SELECT GEOJSON FROM TABLE(OPENROUTESERVICE_NATIVE_APP.CORE.ISOCHRONES_GEO(
       '${profile}', ${lon}::FLOAT, ${lat}::FLOAT, ${minutes}::INT))`);
};
```

**Phase 4: VRP Solve**

```
const solveVRP = async () => {
  // Build jobs array from filtered PLACES + JOB_TEMPLATE slots
  // Build vehicles array from config
  const result = await query(
    `SELECT * FROM TABLE(OPENROUTESERVICE_NATIVE_APP.CORE.OPTIMIZATION(
       PARSE_JSON('${JSON.stringify(jobsArray)}'),
       PARSE_JSON('${JSON.stringify(vehiclesArray)}')
     ))`);
  // Parse: routes[], unassigned[], summary

  // Per vehicle: get turn-by-turn directions
  for (const route of result.routes) {
    const dirs = await query(
      `SELECT * FROM TABLE(OPENROUTESERVICE_NATIVE_APP.CORE.DIRECTIONS(
         '${route.profile}',
         PARSE_JSON('${JSON.stringify({coordinates: route.coordinates})}')::VARIANT
       ))`);
  }
};
```

**Phase 5: Results Display**

- Map: color-coded route paths per vehicle, pickup/delivery markers
- Sidebar: job table with vehicle assignment colors, unassigned list
- Per-vehicle tabs: stop sequence, distance, duration
- Summary metrics: total distance, total duration, vehicles used, unassigned count

---

## Task 5: Extend Demo Dashboard Server for ORS Region/Profile Support

### Enhance `/api/ors/status` in `server/index.ts` (line 311)

```
app.get('/api/ors/status', async (_req, res) => {
  try {
    // Existing check
    const apps = await runSql("SHOW DATABASES LIKE 'OPENROUTESERVICE_NATIVE_APP'");
    if (!apps.length) return res.json({ installed: false, status: 'not_installed' });

    // NEW: Get region + profiles from ORS_STATUS()
    const orsStatus = await runSql(
      "SELECT OPENROUTESERVICE_NATIVE_APP.CORE.ORS_STATUS() AS S");
    const statusJson = JSON.parse(orsStatus[0]?.S || '{}');

    // NEW: Get map config for bounds + city name
    const mapConfig = await runSql(
      "SELECT * FROM OPENROUTESERVICE_NATIVE_APP.CORE.MAP_CONFIG ORDER BY UPDATED_AT DESC LIMIT 1");
    const config = mapConfig[0] || {};

    // NEW: Get all available regions
    const services = await runSql(
      "SHOW SERVICES LIKE 'ORS_SERVICE%' IN SCHEMA OPENROUTESERVICE_NATIVE_APP.CORE");
    const regions = services.map((s: any) => s.name.replace('ORS_SERVICE_', '').toLowerCase())
      .filter((r: string) => r !== 'ors_service');

    res.json({
      installed: true,
      status: 'available',
      region: config.CITY_NAME || 'Unknown',
      profiles: Object.keys(statusJson.profiles || {}),
      bounds: {
        center: { lat: config.CENTER_LAT, lng: config.CENTER_LON },
        min: { lat: config.MIN_LAT, lng: config.MIN_LON },
        max: { lat: config.MAX_LAT, lng: config.MAX_LON },
      },
      availableRegions: regions,
    });
  } catch (err) {
    res.json({ installed: false, status: 'error', error: String(err) });
  }
});
```

### Enhance `useOrsStatus()` in `useRegistry.ts`

Update the hook to expose new fields. Pass as `config.ors` to all pages.

### Pass ORS config to page components

In `App.tsx`, spread ORS info into the `config` prop:

```
<PageShell config={{ ...demo.config, ors: orsStatus }}>
```

Pages can then use `config.ors.bounds.center` for initial map view and `config.ors.profiles` for profile dropdowns.

---

## Task 6: Update PageRegistry and Demo Registration

### Add new page to `PageRegistry.tsx`

Add `deviation-inspector` entry pointing to the new `RouteInspector` component.

### Update `PAGE_DEFS` in `server/index.ts`

Add the `deviation-inspector` page definition with path `/route-deviation/inspector`.

### Update `setup_script.sql`

Add registration for the new `deviation-inspector` demo.

---

## Task 7: Remove Streamlit from All 4 Skills

### Files to delete

| Skill                    | Directory                                                   | Files                                                                                                                                     |
| ------------------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| fleet-intelligence-taxis | `.cortex/skills/fleet-intelligence-taxis/assets/streamlit/` | `Taxi_Control_Center.py`, `city_config.py`, `extra.css`, `logo.svg`, `environment.yml`, `pages/1_Driver_Routes.py`, `pages/2_Heat_Map.py` |
| retail-catchment         | `.cortex/skills/retail-catchment/assets/streamlit/`         | `retail_catchment.py`, `extra.css`, `logo.svg`, `environment.yml`, `config.toml`                                                          |
| route-deviation          | `.cortex/skills/route-deviation/dashboard/`                 | `pages/Route_Deviations.py`, `pages/Route_Inspector.py`, `environment.yml`                                                                |
| route-optimization       | `.cortex/skills/route-optimization/assets/streamlit/`       | `routing.py`, `extra.css`, `logo.svg`, `environment.yml`, `config.toml`                                                                   |

### SKILL.md changes for each skill

Remove the following steps and renumber:

- **fleet-intelligence-taxis**: Remove Step 10 (stage creation, file upload, CREATE STREAMLIT, ADD LIVE VERSION)
- **retail-catchment**: Remove Step 7 (same pattern)
- **route-deviation**: Remove Step 7 (same pattern)
- **route-optimization**: Remove Step 9 (same pattern)

Also remove any references to Streamlit stage creation, file uploading, environment.yml, etc.

---

## Task 8: Add ORS Region Validation to Each Skill SKILL.md

Add a standardized "ORS Compatibility Check" step early in each skill's pipeline. Template:

````
### Step N: Verify ORS Region Compatibility

**Required region:** <REGION_NAME>
**Required profiles:** <PROFILE_LIST>

1. Query ORS status:
   ```sql
   SELECT OPENROUTESERVICE_NATIVE_APP.CORE.ORS_STATUS() AS S;
````

2. Parse the JSON response for `profiles` keys and `service_ready`

3. Query current region:
   ```
   SELECT CITY_NAME FROM OPENROUTESERVICE_NATIVE_APP.CORE.MAP_CONFIG LIMIT 1;
   ```

4. **If region mismatch or missing profiles:**

   - Inform user: "ORS is configured for {current\_region} with profiles {current\_profiles}, but this demo requires {required\_region} with {required\_profiles}."
   - Offer to invoke the `routing-customization` skill to install the correct region
   - **STOP** pipeline execution until ORS is correctly configured

5. **If compatible:** Proceed to next step

````

Per-skill requirements:
| Skill | Required Region | Required Profiles |
|---|---|---|
| fleet-intelligence-taxis | Matches user's city choice | `driving-car` |
| retail-catchment | Matches user's bounding box | `foot-walking`, `driving-car` |
| route-deviation | Germany | `driving-hgv` |
| route-optimization | Matches user's city choice | `driving-car` (minimum) |

---

## Task 9: Add Dashboard Schema Contract to Each SKILL.md

Add a "Dashboard Schema Contract" section at the end of each skill's SKILL.md documenting exactly what the React pages expect. This serves as a contract -- if the pipeline changes, this section flags what must also change.

Example for fleet-taxis:
```markdown
### Dashboard Schema Contract

The React demo-dashboard pages query the following from this schema:

**FleetOverview page** queries `TRIP_SUMMARY`:
- `DRIVER_ID`, `TRIP_ID`, `TRIP_START_TIME`, `ROUTE_DISTANCE_METERS`, `ROUTE_DURATION_SECS`, `ORIGIN` (GEOGRAPHY), `DESTINATION` (GEOGRAPHY)

**HeatMap page** queries `TRIP_SUMMARY`:
- `ORIGIN` (GEOGRAPHY), `ROUTE_DISTANCE_METERS` -- uses `H3_POINT_TO_CELL_STRING(ORIGIN, 8)` inline

**DriverRoutes page** queries `TRIP_SUMMARY` + `DRIVER_LOCATIONS_V`:
- `DRIVER_LOCATIONS_V`: `TRIP_ID`, `DRIVER_ID`, `LON`, `LAT`, `CURR_TIME`, `KMH`, `DRIVER_STATE`, `POINT_INDEX`

**Verification:**
```sql
SELECT 'TRIP_SUMMARY' AS OBJ, COUNT(*) AS ROWS FROM TRIP_SUMMARY
UNION ALL SELECT 'DRIVER_LOCATIONS_V', COUNT(*) FROM DRIVER_LOCATIONS_V;
````

````

---

## Task 10: Long-Term Quality Controls

### 10a. Schema Contract Testing (CI/CD)

Create a script that:
1. Parses all React `.tsx` files for SQL query strings (regex: `` /useSfQuery\(\s*`([^`]+)`/ ``)
2. Extracts referenced table/column names
3. Parses corresponding `sql-pipeline.md` for CREATE TABLE/VIEW definitions
4. Reports mismatches

File: `.cortex/skills/demo-dashboard/scripts/validate-schema-contracts.ts`

Can be run as: `npx tsx scripts/validate-schema-contracts.ts`

### 10b. Centralize ORS Configuration

Create a shared SQL utility:
```sql
CREATE OR REPLACE FUNCTION OPENROUTESERVICE_NATIVE_APP.CORE.GET_ORS_CONFIG()
RETURNS VARIANT
AS $$
  SELECT OBJECT_CONSTRUCT(
    'region', (SELECT CITY_NAME FROM CORE.MAP_CONFIG LIMIT 1),
    'profiles', (SELECT PARSE_JSON(S):profiles FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))),
    'bounds', (SELECT OBJECT_CONSTRUCT('center_lat', CENTER_LAT, 'center_lon', CENTER_LON, ...) FROM CORE.MAP_CONFIG LIMIT 1)
  )
$$;
````

All skills and the demo-dashboard should call this single function instead of implementing their own detection logic.

### 10c. React Page Data Abstraction Layer

Instead of hardcoding SQL strings in React components, create a data layer:

```
// src/data/schemas.ts
export const FLEET_TAXIS = {
  TRIP_SUMMARY: {
    requiredColumns: ['DRIVER_ID', 'TRIP_ID', 'TRIP_START_TIME', 'ROUTE_DISTANCE_METERS', 'ORIGIN', 'DESTINATION'],
    kpiQuery: `SELECT COUNT(DISTINCT DRIVER_ID) AS DRIVERS, ...`,
    recentTripsQuery: `SELECT TRIP_ID, DRIVER_ID, ST_X(ORIGIN) AS P_LNG, ...`,
  },
};
```

Server can validate at startup that all required columns exist in the target schema, returning meaningful errors instead of silent empty pages.

### 10d. Skill Dependency Graph as Structured Metadata

Add a `dependencies` section to each SKILL.md in machine-readable format:

```
# At top of SKILL.md, in frontmatter or structured block
dependencies:
  ors:
    required: true
    region: germany
    profiles: [driving-hgv]
  marketplace:
    - listing: GZT0Z4CM1E9KR  # Overture Maps Places
    - listing: GZT0Z4CM1E9NQ  # Overture Maps Addresses
  databases:
    - FLEET_INTELLIGENCE
  schemas:
    - SYNTHETIC_DATASETS.FLEET_INTELLIGENCE
```

The demo-dashboard can parse this to show prerequisite warnings on the Home page.

### 10e. Integration Test Script per Skill

Each skill should include a `verify.sql` or `verify.md` section that runs after deployment:

```
-- fleet-intelligence-taxis verification
SELECT 'TRIP_SUMMARY' AS OBJ, COUNT(*) AS ROWS FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TRIP_SUMMARY
UNION ALL SELECT 'DRIVER_LOCATIONS_V', COUNT(*) FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_LOCATIONS_V
UNION ALL SELECT 'TRIPS_ASSIGNED_TO_DRIVERS', COUNT(*) FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TRIPS_ASSIGNED_TO_DRIVERS;
-- Expected: all rows > 0
```

If any table returns 0 rows, the demo registration step should warn rather than silently register broken pages.

---

## File Change Summary

| Action      | File                                                                                                | Description                                           |
| ----------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **REWRITE** | `.cortex/skills/demo-dashboard/assets/react-app/src/pages/fleet-taxis/FleetOverview.tsx`            | Query actual columns, auto-center map                 |
| **REWRITE** | `.cortex/skills/demo-dashboard/assets/react-app/src/pages/fleet-taxis/HeatMap.tsx`                  | Inline H3 computation, time-slice controls            |
| **REWRITE** | `.cortex/skills/demo-dashboard/assets/react-app/src/pages/fleet-taxis/DriverRoutes.tsx`             | Actual columns, time-slider GPS tracking, AI analysis |
| **REWRITE** | `.cortex/skills/demo-dashboard/assets/react-app/src/pages/route-deviation/DeviationDashboard.tsx`   | Query actual ETL tables                               |
| **REWRITE** | `.cortex/skills/demo-dashboard/assets/react-app/src/pages/route-deviation/RouteComparison.tsx`      | Inline GEOGRAPHY path extraction                      |
| **CREATE**  | `.cortex/skills/demo-dashboard/assets/react-app/src/pages/route-deviation/RouteInspector.tsx`       | GPS telemetry inspector with teleportation detection  |
| **REWRITE** | `.cortex/skills/demo-dashboard/assets/react-app/src/pages/retail-catchment/RetailCatchment.tsx`     | Fix columns, add live ORS isochrone analysis          |
| **REWRITE** | `.cortex/skills/demo-dashboard/assets/react-app/src/pages/route-optimization/RouteOptimization.tsx` | Full VRP simulator with ORS calls                     |
| **EDIT**    | `.cortex/skills/demo-dashboard/assets/react-app/server/index.ts`                                    | Extend `/api/ors/status` with region+profiles         |
| **EDIT**    | `.cortex/skills/demo-dashboard/assets/react-app/src/registry/PageRegistry.tsx`                      | Add RouteInspector                                    |
| **EDIT**    | `.cortex/skills/demo-dashboard/assets/react-app/src/registry/useRegistry.ts`                        | Extend useOrsStatus                                   |
| **EDIT**    | `.cortex/skills/demo-dashboard/assets/react-app/native-app/setup_script.sql`                        | Add deviation-inspector registration                  |
| **EDIT**    | `.cortex/skills/fleet-intelligence-taxis/SKILL.md`                                                  | Remove Streamlit, add ORS check, add schema contract  |
| **EDIT**    | `.cortex/skills/retail-catchment/SKILL.md`                                                          | Remove Streamlit, add ORS check, add schema contract  |
| **EDIT**    | `.cortex/skills/route-deviation/SKILL.md`                                                           | Remove Streamlit, add ORS check, add schema contract  |
| **EDIT**    | `.cortex/skills/route-optimization/SKILL.md`                                                        | Remove Streamlit, add ORS check, add schema contract  |
| **DELETE**  | `.cortex/skills/fleet-intelligence-taxis/assets/streamlit/`                                         | 7 files                                               |
| **DELETE**  | `.cortex/skills/retail-catchment/assets/streamlit/`                                                 | 5 files                                               |
| **DELETE**  | `.cortex/skills/route-deviation/dashboard/`                                                         | 3 files                                               |
| **DELETE**  | `.cortex/skills/route-optimization/assets/streamlit/`                                               | 5 files                                               |
| **CREATE**  | `.cortex/skills/demo-dashboard/scripts/validate-schema-contracts.ts`                                | CI schema validation                                  |
