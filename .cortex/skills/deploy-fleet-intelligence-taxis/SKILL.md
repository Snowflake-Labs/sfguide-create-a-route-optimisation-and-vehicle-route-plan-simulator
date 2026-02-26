---
name: deploy-fleet-intelligence-taxis
description: "Generate realistic taxi driver location data for the Fleet Intelligence solution using Overture Maps data and OpenRouteService for actual road routes. Configurable location (New York, London, San Francisco, etc.), number of drivers (default 80), days of simulation (default 1), and shift patterns. Use when: setting up driver location data, generating route-based simulation, deploying fleet dashboard. Triggers: generate driver locations, create driver data, setup fleet data, deploy streamlit, fleet intelligence dashboard."
---

# Generate Driver Locations & Deploy Fleet Intelligence Dashboard

Generates realistic taxi driver location data for the Fleet Intelligence solution using:
- **Overture Maps Places & Addresses** - Points of interest and street addresses for pickup/dropoff locations
- **OpenRouteService Native App** - Real road routing for actual driving paths
- **Route Interpolation** - Driver positions along actual roads
- **Configurable Location** - New York, London, San Francisco, Paris, and more
- **Configurable Fleet Size** - Set number of drivers and simulation days

---

## IMPORTANT: Location Must Match OpenRouteService Configuration

> **Before selecting a location, verify your OpenRouteService Native App is configured for that region.**
>
> The OpenRouteService app uses map data (OSM PBF files) for a specific geographic area. If you select a location that is **outside** the area configured in your ORS app, this requires changing a map. 
> Read and follow the instructions in `.cortex/skills/customize-main/SKILL.md`

---

## Configuration Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `LOCATION` | New York | City/region for the simulation |
| `NUM_DRIVERS` | 80 | Total number of taxi drivers |
| `NUM_DAYS` | 1 | Number of days to simulate |
| `START_DATE` | 2015-06-24 | First day of simulation |
| `WAREHOUSE_SIZE` | MEDIUM | Warehouse size for data generation |

---

## Supported Locations (Pre-configured)

| Location | MIN_LON | MAX_LON | MIN_LAT | MAX_LAT | Center LON | Center LAT | Notes |
|----------|---------|---------|---------|---------|------------|------------|-------|
| **San Francisco** | -122.52 | -122.35 | 37.70 | 37.82 | -122.42 | 37.77 | |
| **New York** | -74.05 | -73.90 | 40.65 | 40.85 | -73.97 | 40.75 | Manhattan focus |
| **London** | -0.20 | 0.05 | 51.45 | 51.55 | -0.12 | 51.51 | Central London |
| **Paris** | 2.25 | 2.42 | 48.82 | 48.90 | 2.35 | 48.86 | Central Paris |
| **Chicago** | -87.75 | -87.55 | 41.80 | 41.95 | -87.63 | 41.88 | Downtown |
| **Los Angeles** | -118.35 | -118.15 | 33.95 | 34.15 | -118.25 | 34.05 | Central LA |
| **Seattle** | -122.45 | -122.25 | 47.55 | 47.70 | -122.33 | 47.61 | Downtown |
| **Boston** | -71.15 | -70.95 | 42.30 | 42.40 | -71.06 | 42.36 | Central Boston |
| **Sydney** | 151.15 | 151.30 | -33.92 | -33.82 | 151.21 | -33.87 | CBD area |
| **Singapore** | 103.75 | 103.95 | 1.25 | 1.40 | 103.85 | 1.35 | Central |

---

## Using a Custom Location (Any City)

**The skill works with ANY city worldwide** - the pre-configured locations above are just examples. To use a different city:

### Find Your City's Bounding Box

Use one of these methods to get the bounding box coordinates (min/max longitude and latitude):

**Option A: Use OpenStreetMap**
1. Go to [OpenStreetMap](https://www.openstreetmap.org)
2. Navigate to your city and zoom to the area you want
3. Click "Export" in the top menu
4. The bounding box coordinates are shown (or click "Manually select a different area")

**Option B: Use Google Maps**
1. Navigate to your city center
2. Note the coordinates from the URL (e.g., `@51.5074,-0.1278,12z`)
3. Add/subtract ~0.1-0.15 degrees for the bounding box

**Option C: Use a Bounding Box Tool**
- [Bounding Box Tool](http://bboxfinder.com) - Draw a box and get coordinates
- [Klokantech Bounding Box](https://boundingbox.klokantech.com/) - Multiple format outputs

### Calculate Your Values

For a city centered at `(CENTER_LON, CENTER_LAT)`:

```
Bounding Box (typical city coverage ~15-20km):
  MIN_LON = CENTER_LON - 0.10
  MAX_LON = CENTER_LON + 0.10
  MIN_LAT = CENTER_LAT - 0.08
  MAX_LAT = CENTER_LAT + 0.08

Map Center:
  longitude = CENTER_LON
  latitude = CENTER_LAT
```

### Custom City Examples

**Tokyo** - Center: 139.69, 35.69
- MIN_LON=139.60, MAX_LON=139.85, MIN_LAT=35.60, MAX_LAT=35.78

**Dubai** - Center: 55.27, 25.20
- MIN_LON=55.15, MAX_LON=55.40, MIN_LAT=25.05, MAX_LAT=25.30

**Toronto** - Center: -79.38, 43.65
- MIN_LON=-79.50, MAX_LON=-79.30, MIN_LAT=43.60, MAX_LAT=43.75

> **Remember:** Your OpenRouteService Native App must be configured with map data that covers your chosen city.

---

## Customizing Streamlit App for Your Location

When changing the location, update the `CITY = get_city("New York")` call in each Streamlit file to use your target city name (must match a key in `city_config.py`). The app uses `CITY["name"]` for all headers and `CITY["latitude"]`/`CITY["longitude"]` for map centering, so no manual coordinate changes are needed.

### Files to Update

| File | What to Change |
|------|----------------|
| `Taxi_Control_Center.py` | `get_city("New York")` -> `get_city("Your City")` |
| `pages/1_Driver_Routes.py` | `get_city("New York")` -> `get_city("Your City")` |
| `pages/2_Heat_Map.py` | `get_city("New York")` -> `get_city("Your City")` |

### Adding a New City

If your city isn't in `city_config.py`, add it to the `CITIES` dictionary:

```python
"Tokyo": {
    "name": "Tokyo",
    "latitude": 35.69,
    "longitude": 139.69,
    "zoom": 12,
},
```

---

## Recommended Warehouse Sizes

| Drivers | Days | Estimated Rows | Warehouse | Est. Time |
|---------|------|----------------|-----------|-----------|
| 20 | 1 | ~4,000 | SMALL | 2-3 min |
| 80 | 1 | ~18,000 | MEDIUM | 5-8 min |
| 80 | 7 | ~125,000 | LARGE | 20-30 min |
| 200 | 1 | ~45,000 | LARGE | 15-20 min |
| 200 | 7 | ~315,000 | XLARGE | 45-60 min |
| 500 | 7 | ~800,000 | XLARGE | 2-3 hours |

*Note: Rows estimated at 15 location points per trip (includes waiting, pickup, driving, dropoff, idle states)*

---

## Shift Distribution Formula

When scaling the number of drivers, distribute them across shifts proportionally:

| Shift | % of Fleet | Purpose |
|-------|------------|---------|
| Graveyard (22:00-06:00) | 10% | Overnight |
| Early (04:00-12:00) | 22.5% | Early morning |
| Morning (06:00-14:00) | 27.5% | Peak AM rush |
| Day (11:00-19:00) | 22.5% | Midday |
| Evening (15:00-23:00) | 17.5% | PM rush |

**Examples:**

| Total | Graveyard | Early | Morning | Day | Evening |
|-------|-----------|-------|---------|-----|---------|
| 20 | 2 | 5 | 5 | 5 | 3 |
| 50 | 5 | 11 | 14 | 11 | 9 |
| 80 | 8 | 18 | 22 | 18 | 14 |
| 100 | 10 | 22 | 28 | 22 | 18 |
| 200 | 20 | 45 | 55 | 45 | 35 |

---

## Prerequisites

1. **Snowflake Account** with appropriate privileges
2. **OpenRouteService Native App** installed from Snowflake Marketplace
   - Must be configured for your target location's region
3. **Overture Maps Data** shares:
   - `OVERTURE_MAPS__PLACES`
   - `OVERTURE_MAPS__ADDRESSES`

---

## Workflow

Execute each step in order using `snowflake_sql_execute`. Substitute `{PLACEHOLDER}` values based on the user's chosen configuration before executing.

### CRITICAL: Execution Rules

> **These rules MUST be followed to avoid silent failures:**
>
> 1. **One statement per `snowflake_sql_execute` call.** Never combine multiple SQL statements (CREATE, INSERT, SET, USE) in a single call. Multi-statement blocks can silently fail — tables may be created with 0 rows and no error is reported.
>
> 2. **Always use fully qualified object names.** Use `OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.<object>` instead of relying on `USE DATABASE` / `USE SCHEMA`. Session context from `USE` statements does not persist across `snowflake_sql_execute` calls.
>
> 3. **Never use `SET` session variables.** Variables set with `SET VAR = 'value'` do not persist across calls. Instead, substitute literal values directly into the SQL before execution.
>
> 4. **Verify row counts after each CTAS.** Run `SELECT COUNT(*) FROM <table>` after every `CREATE TABLE ... AS SELECT` to catch silent failures early.

### Step 1: Set Query Tag for Tracking

**Goal:** Set session query tag for attribution tracking.

```sql
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is","name":"oss-deploy-a-fleet-intelligence-solution-for-taxis","version":{"major":1, "minor":0},"attributes":{"is_quickstart":1, "source":"sql"}}';
```

**Output:** Query tag set for session tracking

---

### Step 2: Verify ORS Configuration and Service Status

**Goal:** Read the current ORS configuration, verify it matches the user's target location, check service status in database OPENROUTESERVICE_NATIVE_APP and ensure they are all running.

> Read and follow the instructions in `.cortex/skills/customize-main/read-ors-configuration/SKILL.md` to detect the current region and enabled routing profiles.

**Sub-step 2a: Read Current ORS Configuration**

1. **Describe** the ORS service to extract the configured region name:
   ```sql
   DESCRIBE SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SERVICE;
   ```
   - Parse the service spec to find the configured `<REGION_NAME>` from the volume source path: `@OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SPCS_STAGE/<REGION_NAME>`
   - Extract `<REGION_NAME>` (e.g., "Chicago", "SanFrancisco", "great-britain-latest")

2. **Download** the ORS config file from stage to read enabled profiles:
   ```bash
   snow stage copy @OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SPCS_STAGE/<REGION_NAME>/ors-config.yml oss-build-routing-solution-in-snowflake/Native_app/provider_setup/staged_files/ --connection <ACTIVE_CONNECTION> --overwrite
   ```

3. **Read** `oss-build-routing-solution-in-snowflake/Native_app/provider_setup/staged_files/ors-config.yml` and parse for `profiles:` entries with `enabled: true`

4. **Display** the current configuration to the user:
   - Configured Map Region: `<REGION_NAME>`
   - Configured Vehicle Profiles: `<ENABLED_PROFILES>`

**Sub-step 2b: Check Region Match**

Compare the detected `<REGION_NAME>` with the user's selected `{LOCATION}`:

- **If the region matches:** Proceed to Sub-step 2c.
- **If the region does NOT match:** Warn the user that ORS is configured for a different region. The user must reconfigure ORS for their target location before continuing. Read and follow the instructions in `.cortex/skills/customize-main/SKILL.md` to change the map, then return here to continue.

**Sub-step 2c: Check Service Status and Resume if Needed**

1. **Check** the status of all ORS services:
   ```sql
   SHOW SERVICES IN OPENROUTESERVICE_NATIVE_APP.CORE;
   ```
   - Verify the status of: `ORS_SERVICE`, `DOWNLOADER`, `ROUTING_GATEWAY_SERVICE`, `VROOM_SERVICE`

2. **If any services are SUSPENDED**, resume them:
   ```sql
   ALTER COMPUTE POOL OPENROUTESERVICE_NATIVE_APP_COMPUTE_POOL RESUME;
   ```
   ```sql
   ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.DOWNLOADER RESUME;
   ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SERVICE RESUME;
   ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.ROUTING_GATEWAY_SERVICE RESUME;
   ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.VROOM_SERVICE RESUME;
   ```

3. **If all services are RUNNING**, skip resuming.

**Sub-step 2d: Test ORS Routing**

Test the ORS DIRECTIONS function with coordinates in the target city to confirm routing works:

```sql
SELECT OPENROUTESERVICE_NATIVE_APP.CORE.DIRECTIONS(
    'driving-car',
    [{CENTER_LON}, {CENTER_LAT}],
    [{CENTER_LON} + 0.02, {CENTER_LAT} + 0.02]
);
```

If the query returns a route geometry, ORS is ready. If it fails or returns null, check the ORS_SERVICE logs for errors:

```sql
CALL SYSTEM$GET_SERVICE_LOGS('OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SERVICE', 0, 'ors', 50);
```

**Output:** ORS configuration displayed, region match confirmed, all services running, routing verified

---

### Step 3: Configure Database, Warehouse, and Schema

**Goal:** Create database, warehouse, schema, and stage.

```sql
CREATE DATABASE IF NOT EXISTS OPENROUTESERVICE_SETUP
    COMMENT = '{"origin":"sf_sit-is", "name":"oss-deploy-a-fleet-intelligence-solution-for-taxis", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';

CREATE WAREHOUSE IF NOT EXISTS ROUTING_ANALYTICS
    WAREHOUSE_SIZE = 'XSMALL'
    AUTO_SUSPEND = 60
    AUTO_RESUME = TRUE
    COMMENT = '{"origin":"sf_sit-is", "name":"oss-deploy-a-fleet-intelligence-solution-for-taxis", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';

CREATE SCHEMA IF NOT EXISTS OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS
    COMMENT = '{"origin":"sf_sit-is", "name":"oss-deploy-a-fleet-intelligence-solution-for-taxis", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';

CREATE STAGE IF NOT EXISTS OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.STREAMLIT_STAGE
    DIRECTORY = (ENABLE = TRUE);
```

**Output:** Database `OPENROUTESERVICE_SETUP`, warehouse `ROUTING_ANALYTICS`, schema `FLEET_INTELLIGENCE_TAXIS`, and stage `STREAMLIT_STAGE` created.

---

### Step 4: Create Base Locations

**Goal:** Load locations from Overture Maps for the target city.

**Action:** Substitute `{MIN_LON}`, `{MAX_LON}`, `{MIN_LAT}`, `{MAX_LAT}` with the values from the Supported Locations table (or the user's custom bounding box).

```sql
CREATE OR REPLACE TABLE OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.TAXI_LOCATIONS AS
-- POIs from Overture Maps Places
SELECT 
    ID AS LOCATION_ID,
    GEOMETRY AS POINT_GEOM,
    NAMES:primary::STRING AS NAME,
    CATEGORIES:primary::STRING AS CATEGORY,
    'poi' AS SOURCE_TYPE
FROM OVERTURE_MAPS__PLACES.CARTO.PLACE
WHERE 
    ST_X(GEOMETRY) BETWEEN {MIN_LON} AND {MAX_LON}
    AND ST_Y(GEOMETRY) BETWEEN {MIN_LAT} AND {MAX_LAT}
    AND NAMES:primary IS NOT NULL

UNION ALL

-- Addresses from Overture Maps Addresses
SELECT 
    ID AS LOCATION_ID,
    GEOMETRY AS POINT_GEOM,
    COALESCE(
        ADDRESS_LEVELS[0]:value::STRING || ' ' || STREET,
        STREET
    ) AS NAME,
    'address' AS CATEGORY,
    'address' AS SOURCE_TYPE
FROM OVERTURE_MAPS__ADDRESSES.CARTO.ADDRESS
WHERE 
    ST_X(GEOMETRY) BETWEEN {MIN_LON} AND {MAX_LON}
    AND ST_Y(GEOMETRY) BETWEEN {MIN_LAT} AND {MAX_LAT}
    AND STREET IS NOT NULL;
```

Then verify:

```sql
SELECT 
    SOURCE_TYPE,
    COUNT(*) AS LOCATION_COUNT
FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.TAXI_LOCATIONS
GROUP BY SOURCE_TYPE;
```

**Output:** `TAXI_LOCATIONS` table with POIs and addresses for the target city.

---

### Step 5: Create Drivers with Shift Patterns

**Goal:** Create drivers distributed across shifts.

**Action:** Substitute `{GRAVEYARD_COUNT}`, `{EARLY_COUNT}`, `{MORNING_COUNT}`, `{DAY_COUNT}`, `{EVENING_COUNT}` using the Shift Distribution Formula. For the default 80 drivers: 8, 18, 22, 18, 14.

```sql
CREATE OR REPLACE TABLE OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.TAXI_DRIVERS AS
WITH shift_patterns AS (
    SELECT 1 AS shift_id, 'Graveyard' AS shift_name, 22 AS shift_start, 6 AS shift_end, {GRAVEYARD_COUNT} AS driver_count UNION ALL
    SELECT 2, 'Early', 4, 12, {EARLY_COUNT} UNION ALL
    SELECT 3, 'Morning', 6, 14, {MORNING_COUNT} UNION ALL
    SELECT 4, 'Day', 11, 19, {DAY_COUNT} UNION ALL
    SELECT 5, 'Evening', 15, 23, {EVENING_COUNT}
),
max_per_shift AS (
    SELECT MAX(driver_count) AS max_count FROM shift_patterns
),
driver_assignments AS (
    SELECT 
        ROW_NUMBER() OVER (ORDER BY sp.shift_id, seq.seq) AS driver_num,
        sp.shift_name AS shift_type,
        sp.shift_start AS shift_start_hour,
        sp.shift_end AS shift_end_hour,
        CASE WHEN sp.shift_start > sp.shift_end THEN 'True' ELSE 'False' END AS shift_crosses_midnight
    FROM shift_patterns sp
    CROSS JOIN (SELECT SEQ4() + 1 AS seq FROM TABLE(GENERATOR(ROWCOUNT => 1000))) seq
    CROSS JOIN max_per_shift m
    WHERE seq.seq <= sp.driver_count
),
home_locations AS (
    SELECT 
        LOCATION_ID,
        ROW_NUMBER() OVER (ORDER BY RANDOM()) AS rn
    FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.TAXI_LOCATIONS
    WHERE SOURCE_TYPE = 'address'
    LIMIT 100
)
SELECT 
    'D-' || LPAD(da.driver_num::STRING, 4, '0') AS DRIVER_ID,
    hl.LOCATION_ID AS HOME_LOCATION_ID,
    da.shift_type AS SHIFT_TYPE,
    da.shift_start_hour AS SHIFT_START_HOUR,
    da.shift_end_hour AS SHIFT_END_HOUR,
    da.shift_crosses_midnight AS SHIFT_CROSSES_MIDNIGHT
FROM driver_assignments da
LEFT JOIN home_locations hl ON da.driver_num = hl.rn;
```

```sql
CREATE OR REPLACE TABLE OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.DRIVERS AS
SELECT 
    DRIVER_ID,
    'Driver ' || DRIVER_ID AS DRIVER_NAME,
    SHIFT_TYPE,
    SHIFT_START_HOUR,
    SHIFT_END_HOUR,
    SHIFT_CROSSES_MIDNIGHT
FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.TAXI_DRIVERS;
```

Then verify:

```sql
SELECT 
    SHIFT_TYPE,
    COUNT(*) AS NUM_DRIVERS,
    MIN(SHIFT_START_HOUR) || ':00 - ' || MIN(SHIFT_END_HOUR) || ':00' AS SHIFT_HOURS
FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.TAXI_DRIVERS
GROUP BY SHIFT_TYPE
ORDER BY NUM_DRIVERS DESC;
```

**Output:** `TAXI_DRIVERS` and `DRIVERS` tables with configured number of drivers.

---

### Step 6: Generate Trips

**Goal:** Create trip assignments for each driver.

**Action:** Execute this SQL. Trip counts vary by shift type (Morning: 14-22, Day: 12-20, Early: 10-18, Evening: 10-16, Graveyard: 6-12).

First, materialize the location pool with stable row numbers. This table is used by both the trip assignment and coordinate lookup steps, ensuring deterministic joins.

```sql
CREATE OR REPLACE TABLE OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.TAXI_LOCATIONS_NUMBERED AS
SELECT 
    LOCATION_ID,
    POINT_GEOM,
    NAME,
    ROW_NUMBER() OVER (ORDER BY HASH(LOCATION_ID)) AS rn
FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.TAXI_LOCATIONS
WHERE NAME IS NOT NULL AND LENGTH(NAME) > 3;
```

Then generate the trips:

```sql
CREATE OR REPLACE TABLE OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.DRIVER_TRIPS AS
WITH 
driver_trip_counts AS (
    SELECT 
        d.DRIVER_ID,
        d.SHIFT_TYPE,
        d.SHIFT_START_HOUR,
        d.SHIFT_END_HOUR,
        d.SHIFT_CROSSES_MIDNIGHT,
        CASE d.SHIFT_TYPE
            WHEN 'Morning' THEN UNIFORM(14, 22, RANDOM())
            WHEN 'Day' THEN UNIFORM(12, 20, RANDOM())
            WHEN 'Early' THEN UNIFORM(10, 18, RANDOM())
            WHEN 'Evening' THEN UNIFORM(10, 16, RANDOM())
            WHEN 'Graveyard' THEN UNIFORM(6, 12, RANDOM())
        END AS NUM_TRIPS
    FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.TAXI_DRIVERS d
),
trip_sequence AS (
    SELECT 
        d.DRIVER_ID,
        d.SHIFT_TYPE,
        d.SHIFT_START_HOUR,
        d.SHIFT_END_HOUR,
        d.SHIFT_CROSSES_MIDNIGHT,
        d.NUM_TRIPS,
        ROW_NUMBER() OVER (PARTITION BY d.DRIVER_ID ORDER BY RANDOM()) AS TRIP_NUMBER
    FROM driver_trip_counts d
    CROSS JOIN TABLE(GENERATOR(ROWCOUNT => 25)) g
    QUALIFY TRIP_NUMBER <= d.NUM_TRIPS
),
trips_with_hours AS (
    SELECT 
        ts.*,
        CASE 
            WHEN ts.SHIFT_CROSSES_MIDNIGHT = 'True' THEN
                MOD(ts.SHIFT_START_HOUR + FLOOR((ts.TRIP_NUMBER - 1) * 8.0 / ts.NUM_TRIPS) + UNIFORM(0, 1, RANDOM()), 24)
            ELSE
                ts.SHIFT_START_HOUR + FLOOR((ts.TRIP_NUMBER - 1) * (ts.SHIFT_END_HOUR - ts.SHIFT_START_HOUR) / ts.NUM_TRIPS) + UNIFORM(0, 1, RANDOM())
        END AS TRIP_HOUR
    FROM trip_sequence ts
),
loc_count AS (
    SELECT COUNT(*) AS cnt FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.TAXI_LOCATIONS_NUMBERED
)
SELECT 
    MD5(t.DRIVER_ID || '-' || t.TRIP_NUMBER || '-' || RANDOM()) AS TRIP_ID,
    t.DRIVER_ID,
    t.TRIP_HOUR::INT AS TRIP_HOUR,
    t.TRIP_NUMBER::INT AS TRIP_NUMBER,
    t.SHIFT_TYPE,
    MOD(ABS(HASH(t.DRIVER_ID || t.TRIP_NUMBER || 'P')), lc.cnt) + 1 AS PICKUP_LOC_ID,
    MOD(ABS(HASH(t.DRIVER_ID || t.TRIP_NUMBER || 'D')), lc.cnt) + 1 AS DROPOFF_LOC_ID
FROM trips_with_hours t
CROSS JOIN loc_count lc;
```

```sql
CREATE OR REPLACE TABLE OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.DRIVER_TRIPS_WITH_COORDS AS
SELECT 
    t.TRIP_ID,
    t.DRIVER_ID,
    t.TRIP_HOUR,
    t.TRIP_NUMBER,
    t.SHIFT_TYPE,
    p.POINT_GEOM AS PICKUP_GEOM,
    p.NAME AS PICKUP_NAME,
    d.POINT_GEOM AS DROPOFF_GEOM,
    d.NAME AS DROPOFF_NAME
FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.DRIVER_TRIPS t
JOIN OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.TAXI_LOCATIONS_NUMBERED p ON t.PICKUP_LOC_ID = p.rn
JOIN OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.TAXI_LOCATIONS_NUMBERED d ON t.DROPOFF_LOC_ID = d.rn;
```

Then verify:

```sql
SELECT 
    SHIFT_TYPE,
    COUNT(DISTINCT DRIVER_ID) AS DRIVERS,
    MIN(trips) AS MIN_TRIPS,
    MAX(trips) AS MAX_TRIPS,
    AVG(trips)::INT AS AVG_TRIPS
FROM (
    SELECT DRIVER_ID, SHIFT_TYPE, COUNT(*) AS trips
    FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.DRIVER_TRIPS
    GROUP BY DRIVER_ID, SHIFT_TYPE
)
GROUP BY SHIFT_TYPE
ORDER BY AVG_TRIPS DESC;
```

**Output:** `DRIVER_TRIPS` and `DRIVER_TRIPS_WITH_COORDS` tables.

---

### Step 7: Generate ORS Routes

**Goal:** Generate actual road routes using OpenRouteService.

**Action:** Execute this SQL. Substitute `{START_DATE}` with the configured start date (default: `2015-06-24`).

**WARNING:** This step makes many ORS API calls and may take several minutes depending on trip count.
- 1,000 trips: ~3-5 minutes
- 5,000 trips: ~15-20 minutes
- 10,000 trips: ~30-45 minutes

```sql
CREATE OR REPLACE TABLE OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.DRIVER_ROUTES AS
SELECT 
    DRIVER_ID,
    TRIP_ID,
    TRIP_HOUR,
    TRIP_NUMBER,
    SHIFT_TYPE,
    PICKUP_GEOM,
    PICKUP_NAME,
    DROPOFF_GEOM,
    DROPOFF_NAME,
    OPENROUTESERVICE_NATIVE_APP.CORE.DIRECTIONS(
        'driving-car',
        ARRAY_CONSTRUCT(ST_X(PICKUP_GEOM), ST_Y(PICKUP_GEOM)),
        ARRAY_CONSTRUCT(ST_X(DROPOFF_GEOM), ST_Y(DROPOFF_GEOM))
    ) AS ROUTE_RESPONSE
FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.DRIVER_TRIPS_WITH_COORDS;
```

```sql
CREATE OR REPLACE TABLE OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.DRIVER_ROUTES_PARSED AS
SELECT 
    DRIVER_ID,
    TRIP_ID,
    TRIP_HOUR,
    TRIP_NUMBER,
    SHIFT_TYPE,
    PICKUP_GEOM AS ORIGIN,
    PICKUP_NAME AS ORIGIN_ADDRESS,
    DROPOFF_GEOM AS DESTINATION,
    DROPOFF_NAME AS DESTINATION_ADDRESS,
    TRY_TO_GEOGRAPHY(PARSE_JSON(ROUTE_RESPONSE):features[0]:geometry) AS ROUTE_GEOMETRY,
    PARSE_JSON(ROUTE_RESPONSE):features[0]:properties:summary:distance::FLOAT AS ROUTE_DISTANCE_METERS,
    PARSE_JSON(ROUTE_RESPONSE):features[0]:properties:summary:duration::FLOAT AS ROUTE_DURATION_SECS
FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.DRIVER_ROUTES
WHERE ROUTE_RESPONSE IS NOT NULL;
```

```sql
CREATE OR REPLACE TABLE OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.DRIVER_ROUTE_GEOMETRIES AS
WITH trip_timing AS (
    SELECT 
        *,
        ROW_NUMBER() OVER (PARTITION BY DRIVER_ID ORDER BY TRIP_HOUR, TRIP_NUMBER) AS DRIVER_TRIP_SEQ
    FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.DRIVER_ROUTES_PARSED
    WHERE ROUTE_GEOMETRY IS NOT NULL
),
cumulative_timing AS (
    SELECT 
        t.*,
        SUM(COALESCE(ROUTE_DURATION_SECS, 0) + 180) OVER (
            PARTITION BY DRIVER_ID 
            ORDER BY DRIVER_TRIP_SEQ 
            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
        ) AS TIME_OFFSET_SECS
    FROM trip_timing t
)
SELECT 
    DRIVER_ID,
    TRIP_ID,
        DATEADD('second', COALESCE(TIME_OFFSET_SECS, 0), 
        DATEADD('hour', TRIP_HOUR, '{START_DATE}'::TIMESTAMP_NTZ)
    ) AS TRIP_START_TIME,
    DATEADD('second', COALESCE(TIME_OFFSET_SECS, 0) + ROUTE_DURATION_SECS, 
        DATEADD('hour', TRIP_HOUR, '{START_DATE}'::TIMESTAMP_NTZ)
    ) AS TRIP_END_TIME,
    ORIGIN_ADDRESS,
    DESTINATION_ADDRESS,
    ROUTE_DURATION_SECS,
    ROUTE_DISTANCE_METERS,
    ROUTE_GEOMETRY AS GEOMETRY,
    ORIGIN,
    DESTINATION,
    SHIFT_TYPE
FROM cumulative_timing;
```

Then verify:

```sql
SELECT 
    COUNT(*) AS TOTAL_ROUTES,
    COUNT(DISTINCT DRIVER_ID) AS DRIVERS,
    ROUND(AVG(ROUTE_DISTANCE_METERS)/1000, 2) AS AVG_DISTANCE_KM,
    ROUND(AVG(ROUTE_DURATION_SECS)/60, 1) AS AVG_DURATION_MINS,
    ROUND(SUM(ROUTE_DISTANCE_METERS)/1000, 0) AS TOTAL_DISTANCE_KM
FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.DRIVER_ROUTE_GEOMETRIES;
```

**Output:** `DRIVER_ROUTES`, `DRIVER_ROUTES_PARSED`, and `DRIVER_ROUTE_GEOMETRIES` tables.

---

### Step 8: Create Driver Locations

**Goal:** Interpolate driver positions along routes with realistic speeds.

**Action:** Execute this SQL. Creates 15 points per trip with driver states:
- `waiting` - Stationary, waiting for fare (point 0)
- `pickup` - Stationary, passenger boarding (point 1)
- `driving` - Variable speed based on time of day (points 2-12)
- `dropoff` - Slow, passenger exiting (point 13)
- `idle` - Stationary, post-trip (point 14)

```sql
CREATE OR REPLACE TABLE OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.DRIVER_LOCATIONS AS
WITH 
route_info AS (
    SELECT 
        DRIVER_ID,
        TRIP_ID,
        TRIP_START_TIME,
        TRIP_END_TIME,
        ORIGIN AS PICKUP_LOCATION,
        DESTINATION AS DROPOFF_LOCATION,
        GEOMETRY AS ROUTE,
        ROUTE_DURATION_SECS,
        ROUTE_DISTANCE_METERS,
        SHIFT_TYPE,
        ST_NPOINTS(GEOMETRY)::NUMBER(10,0) AS NUM_POINTS,
        UNIFORM(120, 480, RANDOM()) AS WAIT_BEFORE_SECS
    FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.DRIVER_ROUTE_GEOMETRIES
    WHERE GEOMETRY IS NOT NULL
),
point_seq AS (
    SELECT SEQ4()::NUMBER(10,0) AS POINT_INDEX FROM TABLE(GENERATOR(ROWCOUNT => 15))
),
expanded AS (
    SELECT 
        r.DRIVER_ID,
        r.TRIP_ID,
        r.TRIP_START_TIME,
        r.TRIP_END_TIME,
        r.PICKUP_LOCATION,
        r.DROPOFF_LOCATION,
        r.ROUTE,
        r.NUM_POINTS,
        r.ROUTE_DURATION_SECS,
        r.WAIT_BEFORE_SECS,
        p.POINT_INDEX,
        UNIFORM(1, 100, RANDOM()) AS SPEED_ROLL,
        CASE 
            WHEN p.POINT_INDEX = 0 THEN 'waiting'
            WHEN p.POINT_INDEX = 1 THEN 'pickup'
            WHEN p.POINT_INDEX BETWEEN 2 AND 12 THEN 'driving'
            WHEN p.POINT_INDEX = 13 THEN 'dropoff'
            WHEN p.POINT_INDEX = 14 THEN 'idle'
        END AS DRIVER_STATE,
        CASE 
            WHEN p.POINT_INDEX = 0 THEN 
                DATEADD('second', -r.WAIT_BEFORE_SECS, r.TRIP_START_TIME)
            WHEN p.POINT_INDEX = 1 THEN 
                r.TRIP_START_TIME
            WHEN p.POINT_INDEX BETWEEN 2 AND 12 THEN
                DATEADD('second', 
                    FLOOR(r.ROUTE_DURATION_SECS * (p.POINT_INDEX - 2) / 10.0)::INT,
                    r.TRIP_START_TIME
                )
            WHEN p.POINT_INDEX = 13 THEN
                r.TRIP_END_TIME
            ELSE
                DATEADD('second', 60, r.TRIP_END_TIME)
        END AS CURR_TIME,
        CASE 
            WHEN p.POINT_INDEX IN (0, 1) THEN 1::NUMBER(10,0)
            WHEN p.POINT_INDEX IN (13, 14) THEN r.NUM_POINTS
            ELSE GREATEST(1::NUMBER(10,0), LEAST(r.NUM_POINTS, 
                CEIL((p.POINT_INDEX - 2) * r.NUM_POINTS / 10.0)::NUMBER(10,0)))
        END AS GEOM_IDX
    FROM route_info r
    CROSS JOIN point_seq p
)
SELECT 
    TRIP_ID,
    DRIVER_ID,
    TRIP_START_TIME AS PICKUP_TIME,
    TRIP_END_TIME AS DROPOFF_TIME,
    PICKUP_LOCATION,
    DROPOFF_LOCATION,
    ROUTE,
    ST_POINTN(ROUTE, GEOM_IDX::INT) AS POINT_GEOM,
    CURR_TIME,
    POINT_INDEX,
    DRIVER_STATE,
    CASE 
        WHEN DRIVER_STATE = 'waiting' THEN 0
        WHEN DRIVER_STATE = 'pickup' THEN 0
        WHEN DRIVER_STATE = 'dropoff' THEN UNIFORM(0, 3, RANDOM())
        WHEN DRIVER_STATE = 'idle' THEN 0
        WHEN DRIVER_STATE = 'driving' THEN
            CASE 
                WHEN HOUR(CURR_TIME) BETWEEN 7 AND 9 THEN
                    CASE 
                        WHEN SPEED_ROLL <= 15 THEN UNIFORM(0, 5, RANDOM())
                        WHEN SPEED_ROLL <= 35 THEN UNIFORM(5, 15, RANDOM())
                        WHEN SPEED_ROLL <= 70 THEN UNIFORM(15, 30, RANDOM())
                        ELSE UNIFORM(25, 40, RANDOM())
                    END
                WHEN HOUR(CURR_TIME) BETWEEN 17 AND 19 THEN
                    CASE 
                        WHEN SPEED_ROLL <= 20 THEN UNIFORM(0, 5, RANDOM())
                        WHEN SPEED_ROLL <= 40 THEN UNIFORM(5, 15, RANDOM())
                        WHEN SPEED_ROLL <= 75 THEN UNIFORM(15, 30, RANDOM())
                        ELSE UNIFORM(25, 40, RANDOM())
                    END
                WHEN HOUR(CURR_TIME) BETWEEN 0 AND 5 THEN
                    CASE 
                        WHEN SPEED_ROLL <= 5  THEN UNIFORM(0, 10, RANDOM())
                        WHEN SPEED_ROLL <= 20 THEN UNIFORM(20, 35, RANDOM())
                        ELSE UNIFORM(35, 55, RANDOM())
                    END
                ELSE
                    CASE 
                        WHEN SPEED_ROLL <= 10 THEN UNIFORM(0, 8, RANDOM())
                        WHEN SPEED_ROLL <= 25 THEN UNIFORM(8, 20, RANDOM())
                        WHEN SPEED_ROLL <= 60 THEN UNIFORM(20, 35, RANDOM())
                        ELSE UNIFORM(30, 50, RANDOM())
                    END
            END
    END AS KMH
FROM expanded;
```

Then verify:

```sql
SELECT 
    COUNT(*) AS TOTAL_LOCATION_POINTS,
    COUNT(DISTINCT DRIVER_ID) AS DRIVERS,
    COUNT(DISTINCT TRIP_ID) AS TRIPS,
    MIN(CURR_TIME) AS EARLIEST_TIME,
    MAX(CURR_TIME) AS LATEST_TIME
FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.DRIVER_LOCATIONS;
```

```sql
SELECT 
    DRIVER_STATE,
    COUNT(*) AS COUNT,
    ROUND(AVG(KMH), 1) AS AVG_SPEED,
    MIN(KMH) AS MIN_SPEED,
    MAX(KMH) AS MAX_SPEED
FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.DRIVER_LOCATIONS
GROUP BY DRIVER_STATE
ORDER BY DRIVER_STATE;
```

**Output:** `DRIVER_LOCATIONS` table with interpolated positions and realistic speed patterns.

**Expected Speed Distribution:**
| Speed Band | Percentage |
|------------|------------|
| 0 km/h (Stationary) | ~23% |
| 1-5 km/h (Crawling) | ~11% |
| 6-15 km/h (Slow) | ~14% |
| 16-30 km/h (Moderate) | ~26% |
| 31-45 km/h (Normal) | ~20% |
| 46+ km/h (Fast) | ~6% |

---

### Step 9: Create Analytics Views

**Goal:** Create views for Streamlit consumption.

**Action:** Execute each view as a separate statement.

```sql
CREATE OR REPLACE VIEW OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.DRIVERS_V AS
SELECT * FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.DRIVERS;
```

```sql
CREATE OR REPLACE VIEW OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.DRIVER_LOCATIONS_V AS
SELECT 
    TRIP_ID,
    DRIVER_ID,
    PICKUP_TIME,
    DROPOFF_TIME,
    PICKUP_LOCATION,
    DROPOFF_LOCATION,
    ROUTE,
    POINT_GEOM,
    ST_X(POINT_GEOM) AS LON,
    ST_Y(POINT_GEOM) AS LAT,
    CURR_TIME,
    CURR_TIME AS POINT_TIME,
    POINT_INDEX,
    DRIVER_STATE,
    KMH
FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.DRIVER_LOCATIONS;
```

```sql
CREATE OR REPLACE VIEW OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.TRIPS_ASSIGNED_TO_DRIVERS AS
SELECT 
    DRIVER_ID,
    TRIP_ID,
    GEOMETRY,
    ORIGIN,
    DESTINATION,
    ORIGIN_ADDRESS,
    DESTINATION_ADDRESS,
    TRIP_START_TIME AS PICKUP_TIME,
    TRIP_END_TIME AS DROPOFF_TIME
FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.DRIVER_ROUTE_GEOMETRIES;
```

```sql
CREATE OR REPLACE VIEW OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.TRIPS AS
SELECT 
    rg.TRIP_ID,
    rg.ORIGIN_ADDRESS,
    rg.DESTINATION_ADDRESS,
    rg.ORIGIN AS ORIGIN,
    rg.DESTINATION AS DESTINATION,
    rg.TRIP_START_TIME AS PICKUP_TIME,
    rg.TRIP_END_TIME AS DROPOFF_TIME,
    rg.ROUTE_DURATION_SECS / 60.0 AS TRIP_DURATION_MINS,
    rg.ROUTE_DISTANCE_METERS AS DISTANCE_METERS,
    rg.GEOMETRY,
    rg.DRIVER_ID,
    rg.SHIFT_TYPE
FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.DRIVER_ROUTE_GEOMETRIES rg;
```

```sql
CREATE OR REPLACE VIEW OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.ROUTE_NAMES AS
SELECT 
    TRIP_ID,
    ORIGIN_ADDRESS || ' -> ' || DESTINATION_ADDRESS AS TRIP_NAME
FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.DRIVER_ROUTE_GEOMETRIES;
```

```sql
CREATE OR REPLACE VIEW OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.TRIP_ROUTE_PLAN AS
SELECT 
    rg.TRIP_ID,
    rg.DRIVER_ID,
    rg.ORIGIN_ADDRESS,
    rg.ORIGIN_ADDRESS AS ORIGIN_STREET,
    rg.DESTINATION_ADDRESS,
    rg.DESTINATION_ADDRESS AS DESTINATION_STREET,
    rg.TRIP_START_TIME AS PICKUP_TIME,
    rg.TRIP_END_TIME AS DROPOFF_TIME,
    rg.ORIGIN,
    rg.DESTINATION,
    rg.GEOMETRY,
    rg.ROUTE_DISTANCE_METERS AS DISTANCE_METERS,
    rg.SHIFT_TYPE,
    OBJECT_CONSTRUCT(
        'features', ARRAY_CONSTRUCT(
            OBJECT_CONSTRUCT(
                'properties', OBJECT_CONSTRUCT(
                    'summary', OBJECT_CONSTRUCT(
                        'distance', rg.ROUTE_DISTANCE_METERS,
                        'duration', rg.ROUTE_DURATION_SECS
                    )
                )
            )
        )
    ) AS ROUTE
FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.DRIVER_ROUTE_GEOMETRIES rg;
```

```sql
CREATE OR REPLACE VIEW OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.TRIP_SUMMARY AS
WITH trip_stats AS (
    SELECT 
        TRIP_ID,
        AVG(KMH) AS AVERAGE_KMH,
        MAX(KMH) AS MAX_KMH
    FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.DRIVER_LOCATIONS
    GROUP BY TRIP_ID
)
SELECT 
    rg.*,
    ts.AVERAGE_KMH,
    ts.MAX_KMH
FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.DRIVER_ROUTE_GEOMETRIES rg
LEFT JOIN trip_stats ts ON rg.TRIP_ID = ts.TRIP_ID;
```

Then verify:

```sql
SELECT 'DRIVERS_V' AS VIEW_NAME, COUNT(*) AS ROW_COUNT FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.DRIVERS_V
UNION ALL SELECT 'DRIVER_LOCATIONS_V', COUNT(*) FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.DRIVER_LOCATIONS_V
UNION ALL SELECT 'TRIPS_ASSIGNED_TO_DRIVERS', COUNT(*) FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.TRIPS_ASSIGNED_TO_DRIVERS
UNION ALL SELECT 'TRIPS', COUNT(*) FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.TRIPS
UNION ALL SELECT 'ROUTE_NAMES', COUNT(*) FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.ROUTE_NAMES
UNION ALL SELECT 'TRIP_ROUTE_PLAN', COUNT(*) FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.TRIP_ROUTE_PLAN
UNION ALL SELECT 'TRIP_SUMMARY', COUNT(*) FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.TRIP_SUMMARY;
```

**Output:** 7 analytics views created.

---

### Step 10: Deploy Streamlit App

**Goal:** Upload Streamlit files to stage and deploy the application.

**Action:** Upload the Streamlit files to the Snowflake stage, then create the Streamlit app.

**Upload files using PUT commands:**

```sql
PUT 'file://oss-deploy-a-fleet-intelligence-solution-for-taxis/Streamlit/Taxi_Control_Center.py' @OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.STREAMLIT_STAGE/taxi/ AUTO_COMPRESS=FALSE OVERWRITE=TRUE;
PUT 'file://oss-deploy-a-fleet-intelligence-solution-for-taxis/Streamlit/extra.css' @OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.STREAMLIT_STAGE/taxi/ AUTO_COMPRESS=FALSE OVERWRITE=TRUE;
PUT 'file://oss-deploy-a-fleet-intelligence-solution-for-taxis/Streamlit/logo.svg' @OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.STREAMLIT_STAGE/taxi/ AUTO_COMPRESS=FALSE OVERWRITE=TRUE;
PUT 'file://oss-deploy-a-fleet-intelligence-solution-for-taxis/Streamlit/environment.yml' @OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.STREAMLIT_STAGE/taxi/ AUTO_COMPRESS=FALSE OVERWRITE=TRUE;
PUT 'file://oss-deploy-a-fleet-intelligence-solution-for-taxis/Streamlit/city_config.py' @OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.STREAMLIT_STAGE/taxi/ AUTO_COMPRESS=FALSE OVERWRITE=TRUE;
PUT 'file://oss-deploy-a-fleet-intelligence-solution-for-taxis/Streamlit/pages/1_Driver_Routes.py' @OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.STREAMLIT_STAGE/taxi/pages/ AUTO_COMPRESS=FALSE OVERWRITE=TRUE;
PUT 'file://oss-deploy-a-fleet-intelligence-solution-for-taxis/Streamlit/pages/2_Heat_Map.py' @OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.STREAMLIT_STAGE/taxi/pages/ AUTO_COMPRESS=FALSE OVERWRITE=TRUE;
```

**Verify files uploaded:**

```sql
LIST @OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.STREAMLIT_STAGE/taxi/;
```

**Deploy the Streamlit app:**

```sql
CREATE OR REPLACE STREAMLIT OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.TAXI_CONTROL_CENTER
  FROM @OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.STREAMLIT_STAGE/taxi
  MAIN_FILE = 'Taxi_Control_Center.py'
  QUERY_WAREHOUSE = ROUTING_ANALYTICS
  TITLE =  'Taxi Control Center'
  COMMENT = '{"origin":"sf_sit-is", "name":"oss-deploy-a-fleet-intelligence-solution-for-taxis", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"streamlit"}}';
```

**Set the live version so other users can access the app without edit mode:**

```sql
ALTER STREAMLIT OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.TAXI_CONTROL_CENTER ADD LIVE VERSION FROM LAST;
```

**Verify deployment:**

```sql
SHOW STREAMLITS IN SCHEMA OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS;
```

**Get app URL:**

```sql
SELECT CONCAT('https://app.snowflake.com/', CURRENT_ORGANIZATION_NAME(), '/', CURRENT_ACCOUNT_NAME(), '/#/streamlit-apps/OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_TAXIS.TAXI_CONTROL_CENTER') AS STREAMLIT_URL;
```

**Output:** Streamlit app deployed. Provide the user with the generated URL to open the app directly in Snowsight.

---

## Data Model

```
OPENROUTESERVICE_SETUP
└── FLEET_INTELLIGENCE_TAXIS (schema)
    ├── Tables
    │   ├── TAXI_LOCATIONS      # Location pool for target city
    │   ├── TAXI_LOCATIONS_NUMBERED # Locations with stable row numbers for joins
    │   ├── TAXI_DRIVERS           # Configured driver count
    │   ├── DRIVERS                # Driver display data
    │   ├── DRIVER_TRIPS           # Trip assignments
    │   ├── DRIVER_TRIPS_WITH_COORDS # Trips with coordinates
    │   ├── DRIVER_ROUTES          # Raw ORS responses
    │   ├── DRIVER_ROUTES_PARSED   # Parsed route data
    │   ├── DRIVER_ROUTE_GEOMETRIES # Routes with timing
    │   └── DRIVER_LOCATIONS       # Interpolated positions with driver states
    │
    ├── Views
    │   ├── DRIVERS_V              # Driver info with shift details
    │   ├── DRIVER_LOCATIONS_V     # Positions with LON/LAT and DRIVER_STATE
    │   ├── TRIPS_ASSIGNED_TO_DRIVERS # Trip details with route geometries
    │   ├── TRIPS                  # Compatibility view with duration/distance
    │   ├── ROUTE_NAMES            # Human-readable trip names
    │   ├── TRIP_ROUTE_PLAN        # Route data for Heat Map page
    │   └── TRIP_SUMMARY           # Comprehensive trip metrics with speed stats
    │
    ├── Stage
    │   └── STREAMLIT_STAGE        # Streamlit application files
    │
    └── Streamlit
        └── TAXI_CONTROL_CENTER # Fleet Intelligence dashboard
```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| ORS routes returning NULL | Location outside ORS configured region - verify map data |
| ORS routes failing | Verify OpenRouteService Native App is installed and running |
| No locations found | Bounding box may be too restrictive or outside Overture coverage |
| Query timeout | Increase warehouse size |
| Out of memory | Use larger warehouse or batch processing |
| Missing Overture data | Install shares from Snowflake Marketplace |
| Streamlit not loading | Check all files uploaded to stage via `LIST @STREAMLIT_STAGE/taxi/` |
| Map centered wrong | Update view_state coordinates in Streamlit files |
| PUT command fails | Ensure the file path is absolute and the file exists locally |
