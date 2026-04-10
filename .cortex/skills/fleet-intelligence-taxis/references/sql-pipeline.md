# SQL Pipeline — Fleet Intelligence Taxis

All SQL below must be executed **one statement per `snowflake_sql_execute` call** with fully qualified object names. Never use `SET` session variables — substitute literal values directly.

---

## Step 1: Set Query Tag

```sql
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-taxis","version":{"major":1, "minor":0},"attributes":{"is_quickstart":1, "source":"sql"}}';
```

---

## Step 2: Detect ORS Configuration & Verify Services

### 2a — Describe ORS Service

```sql
DESCRIBE SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SERVICE;
```

Parse the service spec to find `<REGION_NAME>` from the volume source path: `@OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SPCS_STAGE/<REGION_NAME>`.

### 2b — Download ORS Config

```bash
snow stage copy @OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SPCS_STAGE/<REGION_NAME>/ors-config.yml .cortex/skills/build-routing-solution/native_app/provider_setup/staged_files/ --connection <ACTIVE_CONNECTION> --overwrite
```

Read `ors-config.yml` and parse for `profiles:` entries with `enabled: true`.

### 2d — Show & Resume Services

```sql
SHOW SERVICES IN OPENROUTESERVICE_NATIVE_APP.CORE;
```

If any services are SUSPENDED:

```sql
CALL OPENROUTESERVICE_NATIVE_APP.CORE.RESUME_ALL_SERVICES();
```

Verify ORS is healthy:

```sql
SELECT OPENROUTESERVICE_NATIVE_APP.CORE.CHECK_HEALTH();
```

### 2e — Test ORS Routing

```sql
SELECT OPENROUTESERVICE_NATIVE_APP.CORE.DIRECTIONS(
    'driving-car',
    [{CENTER_LON}, {CENTER_LAT}],
    [{CENTER_LON} + 0.02, {CENTER_LAT} + 0.02]
);
```

If it fails, check logs:

```sql
CALL SYSTEM$GET_SERVICE_LOGS('OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SERVICE', 0, 'ors', 50);
```

---

## Step 3: Configure Database, Warehouse, and Schema

```sql
CREATE DATABASE IF NOT EXISTS FLEET_INTELLIGENCE
    COMMENT = '{"origin":"sf_sit-is-fleet", "name":"oss-fleet-intelligence-taxis", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';
```

```sql
CREATE WAREHOUSE IF NOT EXISTS ROUTING_ANALYTICS
    WAREHOUSE_SIZE = 'XSMALL'
    AUTO_SUSPEND = 60
    AUTO_RESUME = TRUE
    COMMENT = '{"origin":"sf_sit-is-fleet", "name":"oss-fleet-intelligence-taxis", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';
```

```sql
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS
    COMMENT = '{"origin":"sf_sit-is-fleet", "name":"oss-fleet-intelligence-taxis", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';
```

```sql
CREATE STAGE IF NOT EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.STREAMLIT_STAGE
    DIRECTORY = (ENABLE = TRUE)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-taxis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

---

## Step 3b: Check & Install Overture Maps Datasets

Check if datasets are accessible:

```sql
SELECT COUNT(*) FROM OVERTURE_MAPS__PLACES.CARTO.PLACE LIMIT 1;
```

```sql
SELECT COUNT(*) FROM OVERTURE_MAPS__ADDRESSES.CARTO.ADDRESS LIMIT 1;
```

If either query fails, install from Marketplace:

```sql
CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZT0Z4CM1E9KR');
CREATE DATABASE IF NOT EXISTS OVERTURE_MAPS__PLACES FROM LISTING GZT0Z4CM1E9KR;
```

```sql
CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZT0Z4CM1E9NQ');
CREATE DATABASE IF NOT EXISTS OVERTURE_MAPS__ADDRESSES FROM LISTING GZT0Z4CM1E9NQ;
```

Requires IMPORT SHARE privilege.

---

## Step 4: Create Base Locations (TAXI_LOCATIONS)

Substitute `{MIN_LON}`, `{MAX_LON}`, `{MIN_LAT}`, `{MAX_LAT}` from the Supported Locations table.

```sql
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TAXI_LOCATIONS AS
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

```sql
ALTER TABLE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TAXI_LOCATIONS SET
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-taxis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

### Verify

```sql
SELECT 
    SOURCE_TYPE,
    COUNT(*) AS LOCATION_COUNT
FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TAXI_LOCATIONS
GROUP BY SOURCE_TYPE;
```

---

## Step 5: Create Drivers with Shift Patterns (TAXI_DRIVERS)

Substitute driver counts per shift. Default 80 drivers: `{GRAVEYARD_COUNT}=8`, `{EARLY_COUNT}=18`, `{MORNING_COUNT}=22`, `{DAY_COUNT}=18`, `{EVENING_COUNT}=14`.

```sql
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TAXI_DRIVERS AS
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
    FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TAXI_LOCATIONS
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
ALTER TABLE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TAXI_DRIVERS SET
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-taxis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

### Verify

```sql
SELECT 
    SHIFT_TYPE,
    COUNT(*) AS NUM_DRIVERS,
    MIN(SHIFT_START_HOUR) || ':00 - ' || MIN(SHIFT_END_HOUR) || ':00' AS SHIFT_HOURS
FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TAXI_DRIVERS
GROUP BY SHIFT_TYPE
ORDER BY NUM_DRIVERS DESC;
```

---

## Step 6: Generate Trips

### 6a — Materialize Location Pool (TAXI_LOCATIONS_NUMBERED)

```sql
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TAXI_LOCATIONS_NUMBERED AS
SELECT 
    LOCATION_ID,
    POINT_GEOM,
    NAME,
    ROW_NUMBER() OVER (ORDER BY HASH(LOCATION_ID)) AS rn
FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TAXI_LOCATIONS
WHERE NAME IS NOT NULL AND LENGTH(NAME) > 3;
```

```sql
ALTER TABLE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TAXI_LOCATIONS_NUMBERED SET
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-taxis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

### 6b — Create Trip Assignments (DRIVER_TRIPS)

Trip counts by shift: Morning 14-22, Day 12-20, Early 10-18, Evening 10-16, Graveyard 6-12.

```sql
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_TRIPS AS
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
    FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TAXI_DRIVERS d
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
    SELECT COUNT(*) AS cnt FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TAXI_LOCATIONS_NUMBERED
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
ALTER TABLE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_TRIPS SET
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-taxis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

### 6c — Attach Coordinates (DRIVER_TRIPS_WITH_COORDS)

```sql
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_TRIPS_WITH_COORDS AS
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
FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_TRIPS t
JOIN FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TAXI_LOCATIONS_NUMBERED p ON t.PICKUP_LOC_ID = p.rn
JOIN FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TAXI_LOCATIONS_NUMBERED d ON t.DROPOFF_LOC_ID = d.rn;
```

```sql
ALTER TABLE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_TRIPS_WITH_COORDS SET
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-taxis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

### Verify

```sql
SELECT 
    SHIFT_TYPE,
    COUNT(DISTINCT DRIVER_ID) AS DRIVERS,
    MIN(trips) AS MIN_TRIPS,
    MAX(trips) AS MAX_TRIPS,
    AVG(trips)::INT AS AVG_TRIPS
FROM (
    SELECT DRIVER_ID, SHIFT_TYPE, COUNT(*) AS trips
    FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_TRIPS
    GROUP BY DRIVER_ID, SHIFT_TYPE
)
GROUP BY SHIFT_TYPE
ORDER BY AVG_TRIPS DESC;
```

---

## Step 7: Generate ORS Routes

Substitute `{START_DATE}` (default: `2015-06-24`).

**Timing estimates:** ~1,000 trips: 3-5 min · ~5,000 trips: 15-20 min · ~10,000 trips: 30-45 min.

### 7a — Call ORS DIRECTIONS (DRIVER_ROUTES)

```sql
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_ROUTES AS
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
FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_TRIPS_WITH_COORDS;
```

```sql
ALTER TABLE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_ROUTES SET
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-taxis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

### 7b — Parse Route Responses (DRIVER_ROUTES_PARSED)

> **TABLE Alternative:** You can combine steps 7a + 7b into a single step using `DIRECTIONS` (TABLE function):
> ```sql
> CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_ROUTES_PARSED AS
> SELECT 
>     t.DRIVER_ID, t.TRIP_ID, t.TRIP_HOUR, t.TRIP_NUMBER, t.SHIFT_TYPE,
>     t.PICKUP_GEOM AS ORIGIN, t.PICKUP_NAME AS ORIGIN_ADDRESS,
>     t.DROPOFF_GEOM AS DESTINATION, t.DROPOFF_NAME AS DESTINATION_ADDRESS,
>     d.GEOJSON AS ROUTE_GEOMETRY,
>     d.DISTANCE AS ROUTE_DISTANCE_METERS,
>     d.DURATION AS ROUTE_DURATION_SECS
> FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_TRIPS_WITH_COORDS t,
>     TABLE(OPENROUTESERVICE_NATIVE_APP.CORE.DIRECTIONS(
>         'driving-car',
>         ARRAY_CONSTRUCT(ST_X(t.PICKUP_GEOM), ST_Y(t.PICKUP_GEOM)),
>         ARRAY_CONSTRUCT(ST_X(t.DROPOFF_GEOM), ST_Y(t.DROPOFF_GEOM))
>     )) d
> WHERE d.GEOJSON IS NOT NULL;
> ```

```sql
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_ROUTES_PARSED AS
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
FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_ROUTES
WHERE ROUTE_RESPONSE IS NOT NULL;
```

```sql
ALTER TABLE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_ROUTES_PARSED SET
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-taxis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

### 7c — Build Route Geometries with Timing (DRIVER_ROUTE_GEOMETRIES)

```sql
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_ROUTE_GEOMETRIES AS
WITH trip_timing AS (
    SELECT 
        *,
        ROW_NUMBER() OVER (PARTITION BY DRIVER_ID ORDER BY TRIP_HOUR, TRIP_NUMBER) AS DRIVER_TRIP_SEQ
    FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_ROUTES_PARSED
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

```sql
ALTER TABLE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_ROUTE_GEOMETRIES SET
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-taxis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

### Verify

```sql
SELECT 
    COUNT(*) AS TOTAL_ROUTES,
    COUNT(DISTINCT DRIVER_ID) AS DRIVERS,
    ROUND(AVG(ROUTE_DISTANCE_METERS)/1000, 2) AS AVG_DISTANCE_KM,
    ROUND(AVG(ROUTE_DURATION_SECS)/60, 1) AS AVG_DURATION_MINS,
    ROUND(SUM(ROUTE_DISTANCE_METERS)/1000, 0) AS TOTAL_DISTANCE_KM
FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_ROUTE_GEOMETRIES;
```

---

## Step 8: Create Driver Locations (DRIVER_LOCATIONS)

Creates 15 points per trip with driver states: `waiting` (0), `pickup` (1), `driving` (2-12), `dropoff` (13), `idle` (14). Speed varies by time of day (rush hour, overnight, normal).

```sql
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_LOCATIONS AS
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
    FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_ROUTE_GEOMETRIES
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

```sql
ALTER TABLE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_LOCATIONS SET
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-taxis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

### Verify

```sql
SELECT 
    COUNT(*) AS TOTAL_LOCATION_POINTS,
    COUNT(DISTINCT DRIVER_ID) AS DRIVERS,
    COUNT(DISTINCT TRIP_ID) AS TRIPS,
    MIN(CURR_TIME) AS EARLIEST_TIME,
    MAX(CURR_TIME) AS LATEST_TIME
FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_LOCATIONS;
```

```sql
SELECT 
    DRIVER_STATE,
    COUNT(*) AS COUNT,
    ROUND(AVG(KMH), 1) AS AVG_SPEED,
    MIN(KMH) AS MIN_SPEED,
    MAX(KMH) AS MAX_SPEED
FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_LOCATIONS
GROUP BY DRIVER_STATE
ORDER BY DRIVER_STATE;
```

---

## Step 9: Create Analytics Views

Execute each view as a separate statement.

### DRIVER_LOCATIONS_V

```sql
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_LOCATIONS_V AS
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
FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_LOCATIONS;
```

```sql
ALTER VIEW FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_LOCATIONS_V SET
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-taxis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

### TRIPS_ASSIGNED_TO_DRIVERS

```sql
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TRIPS_ASSIGNED_TO_DRIVERS AS
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
FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_ROUTE_GEOMETRIES;
```

```sql
ALTER VIEW FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TRIPS_ASSIGNED_TO_DRIVERS SET
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-taxis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

### ROUTE_NAMES

```sql
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.ROUTE_NAMES AS
SELECT 
    TRIP_ID,
    ORIGIN_ADDRESS || ' -> ' || DESTINATION_ADDRESS AS TRIP_NAME
FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_ROUTE_GEOMETRIES;
```

```sql
ALTER VIEW FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.ROUTE_NAMES SET
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-taxis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

### TRIP_ROUTE_PLAN

```sql
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TRIP_ROUTE_PLAN AS
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
FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_ROUTE_GEOMETRIES rg;
```

```sql
ALTER VIEW FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TRIP_ROUTE_PLAN SET
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-taxis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

### TRIP_SUMMARY

```sql
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TRIP_SUMMARY AS
WITH trip_stats AS (
    SELECT 
        TRIP_ID,
        AVG(KMH) AS AVERAGE_KMH,
        MAX(KMH) AS MAX_KMH
    FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_LOCATIONS
    GROUP BY TRIP_ID
)
SELECT 
    rg.*,
    ts.AVERAGE_KMH,
    ts.MAX_KMH
FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_ROUTE_GEOMETRIES rg
LEFT JOIN trip_stats ts ON rg.TRIP_ID = ts.TRIP_ID;
```

```sql
ALTER VIEW FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TRIP_SUMMARY SET
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-taxis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

### Verify All Views

```sql
SELECT 'DRIVER_LOCATIONS_V' AS VIEW_NAME, COUNT(*) AS ROW_COUNT FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_LOCATIONS_V
UNION ALL SELECT 'TRIPS_ASSIGNED_TO_DRIVERS', COUNT(*) FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TRIPS_ASSIGNED_TO_DRIVERS
UNION ALL SELECT 'ROUTE_NAMES', COUNT(*) FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.ROUTE_NAMES
UNION ALL SELECT 'TRIP_ROUTE_PLAN', COUNT(*) FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TRIP_ROUTE_PLAN
UNION ALL SELECT 'TRIP_SUMMARY', COUNT(*) FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TRIP_SUMMARY;
```

### Grant Access to Native App

After creating/replacing views, grant SELECT to the ORS Control App so the SPCS service can query them:

```sql
GRANT SELECT ON ALL VIEWS IN SCHEMA FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS TO APPLICATION OPENROUTESERVICE_NATIVE_APP;
```

```sql
GRANT SELECT ON ALL TABLES IN SCHEMA FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS TO APPLICATION OPENROUTESERVICE_NATIVE_APP;
```

---

---

## Step 11: Data Studio Projection Views

These views read from `SYNTHETIC_DATASETS.UNIFIED` tables generated by Data Studio, projecting them into the column schema expected by the React UI pages. When Data Studio data replaces the native ORS pipeline, these views make the transition transparent.

**Important**: The views handle three key transformations:
1. **GEOGRAPHY columns**: React pages call `ST_X(ORIGIN)` — views create `ST_MAKEPOINT()` from lat/lon
2. **Address resolution**: React pages read `ORIGIN_ADDRESS` — views JOIN `DIM_POIS` for POI names
3. **Metric aggregation**: React pages read `MAX_KMH` — views JOIN telemetry for speed stats
4. **State mapping**: Data Studio emits `MOVING`/`DWELL_ORIGIN`/etc. — views map to `driving`/`pickup`/etc.
5. **Deduplication**: DIM_POIS and DIM_FLEET may contain duplicates from multiple generation runs

### Step 11a: CONFIG Table

Single-row config controlling which vehicle type and region this skill processes. All projection views read from this table instead of hardcoding a vehicle type.

```sql
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.CONFIG (
    VEHICLE_TYPE VARCHAR NOT NULL,
    REGION       VARCHAR NOT NULL
);
MERGE INTO FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.CONFIG tgt
USING (SELECT 'ebike' AS VEHICLE_TYPE, 'SanFrancisco' AS REGION) src
ON TRUE
WHEN NOT MATCHED THEN INSERT (VEHICLE_TYPE, REGION)
    VALUES (src.VEHICLE_TYPE, src.REGION);

ALTER TABLE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.CONFIG SET
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-taxis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

### VW_DRIVER_LOCATIONS (telemetry projection)

```sql
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.VW_DRIVER_LOCATIONS AS
SELECT
    t.VEHICLE_ID AS DRIVER_ID,
    t.TRIP_ID,
    t.TS AS CURR_TIME,
    t.TS AS POINT_TIME,
    t.LONGITUDE AS LON,
    t.LATITUDE AS LAT,
    t.SPEED_KMH AS KMH,
    CASE t.STATUS
        WHEN 'MOVING' THEN 'driving'
        WHEN 'DWELL_ORIGIN' THEN 'pickup'
        WHEN 'DWELL_DESTINATION' THEN 'dropoff'
        WHEN 'IDLE' THEN 'idle'
        ELSE LOWER(t.STATUS)
    END AS DRIVER_STATE,
    t.POINT_INDEX,
    t.REGION,
    t.ODOMETER_KM
FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY t
WHERE t.VEHICLE_TYPE = (SELECT VEHICLE_TYPE FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.CONFIG LIMIT 1)
  AND t.REGION = (SELECT REGION FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.CONFIG LIMIT 1)
QUALIFY ROW_NUMBER() OVER (PARTITION BY t.TELEMETRY_ID ORDER BY t.TS) = 1;
```

```sql
ALTER VIEW FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.VW_DRIVER_LOCATIONS SET
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-taxis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

### VW_TRIP_SUMMARY (trip projection with all columns the React UI needs)

```sql
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.VW_TRIP_SUMMARY AS
WITH cfg AS (SELECT VEHICLE_TYPE, REGION FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.CONFIG LIMIT 1),
trip_speeds AS (
    SELECT TRIP_ID, MAX(SPEED_KMH) AS MAX_KMH
    FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY
    WHERE VEHICLE_TYPE = (SELECT VEHICLE_TYPE FROM cfg)
    GROUP BY TRIP_ID
),
dedup_pois AS (
    SELECT LOCATION_ID, NAME, CATEGORY, LAT, LNG,
           ROW_NUMBER() OVER (PARTITION BY LOCATION_ID ORDER BY NAME) AS RN
    FROM SYNTHETIC_DATASETS.UNIFIED.DIM_POIS
),
dedup_fleet AS (
    SELECT VEHICLE_ID, SHIFT_TYPE,
           ROW_NUMBER() OVER (PARTITION BY VEHICLE_ID ORDER BY SHIFT_TYPE) AS RN
    FROM SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET
    WHERE VEHICLE_TYPE = (SELECT VEHICLE_TYPE FROM cfg)
)
SELECT
    t.VEHICLE_ID AS DRIVER_ID,
    t.TRIP_ID,
    t.TRIP_START AS TRIP_START_TIME,
    t.TRIP_END AS TRIP_END_TIME,
    COALESCE(po.NAME, 'Unknown') AS ORIGIN_ADDRESS,
    COALESCE(pd.NAME, 'Unknown') AS DESTINATION_ADDRESS,
    t.DURATION_MINUTES * 60 AS ROUTE_DURATION_SECS,
    t.DISTANCE_KM * 1000 AS ROUTE_DISTANCE_METERS,
    t.ROUTE_GEOG AS GEOMETRY,
    ST_MAKEPOINT(t.ORIGIN_LON, t.ORIGIN_LAT) AS ORIGIN,
    ST_MAKEPOINT(t.DESTINATION_LON, t.DESTINATION_LAT) AS DESTINATION,
    CASE f.SHIFT_TYPE
        WHEN '6-14' THEN 'Morning'
        WHEN '14-22' THEN 'Afternoon'
        WHEN '22-6' THEN 'Night'
        ELSE f.SHIFT_TYPE
    END AS SHIFT_TYPE,
    t.REGION,
    CASE WHEN t.DURATION_MINUTES > 0
         THEN t.DISTANCE_KM / (t.DURATION_MINUTES / 60)
         ELSE 0 END AS AVERAGE_KMH,
    ts.MAX_KMH
FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS t
LEFT JOIN dedup_pois po ON t.ORIGIN_POI_ID = po.LOCATION_ID AND po.RN = 1
LEFT JOIN dedup_pois pd ON t.DESTINATION_POI_ID = pd.LOCATION_ID AND pd.RN = 1
LEFT JOIN dedup_fleet f ON t.VEHICLE_ID = f.VEHICLE_ID AND f.RN = 1
LEFT JOIN trip_speeds ts ON t.TRIP_ID = ts.TRIP_ID
WHERE t.VEHICLE_TYPE = (SELECT VEHICLE_TYPE FROM cfg)
  AND t.REGION = (SELECT REGION FROM cfg);
```

```sql
ALTER VIEW FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.VW_TRIP_SUMMARY SET
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-taxis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

### Replace Native Views with Data Studio Wrappers

After generating data via Data Studio, replace the native pipeline views so React pages work without code changes:

```sql
ALTER VIEW FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TRIP_SUMMARY
  RENAME TO FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TRIP_SUMMARY_NATIVE;
ALTER VIEW FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_LOCATIONS_V
  RENAME TO FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_LOCATIONS_V_NATIVE;
```

```sql
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TRIP_SUMMARY AS
SELECT * FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.VW_TRIP_SUMMARY;
```

```sql
ALTER VIEW FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TRIP_SUMMARY SET
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-taxis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

```sql
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_LOCATIONS_V AS
SELECT
    DRIVER_ID, TRIP_ID,
    NULL::TIMESTAMP_NTZ AS PICKUP_TIME,
    NULL::TIMESTAMP_NTZ AS DROPOFF_TIME,
    NULL::VARIANT AS PICKUP_LOCATION,
    NULL::VARIANT AS DROPOFF_LOCATION,
    NULL::VARIANT AS ROUTE,
    ST_MAKEPOINT(LON, LAT) AS POINT_GEOM,
    LON, LAT, CURR_TIME, CURR_TIME AS POINT_TIME,
    POINT_INDEX, DRIVER_STATE, KMH, REGION
FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.VW_DRIVER_LOCATIONS;
```

```sql
ALTER VIEW FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_LOCATIONS_V SET
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-taxis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

```sql
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.ROUTE_NAMES AS
SELECT TRIP_ID, ORIGIN_ADDRESS || ' -> ' || DESTINATION_ADDRESS AS TRIP_NAME
FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.VW_TRIP_SUMMARY;
```

```sql
ALTER VIEW FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.ROUTE_NAMES SET
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-taxis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

```sql
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TRIPS_ASSIGNED_TO_DRIVERS AS
SELECT DRIVER_ID, TRIP_ID, GEOMETRY, ORIGIN, DESTINATION,
       ORIGIN_ADDRESS, DESTINATION_ADDRESS,
       TRIP_START_TIME AS PICKUP_TIME, TRIP_END_TIME AS DROPOFF_TIME
FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.VW_TRIP_SUMMARY;
```

```sql
ALTER VIEW FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TRIPS_ASSIGNED_TO_DRIVERS SET
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-taxis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

```sql
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TRIP_ROUTE_PLAN AS
SELECT TRIP_ID, DRIVER_ID, ORIGIN_ADDRESS, ORIGIN_ADDRESS AS ORIGIN_STREET,
       DESTINATION_ADDRESS, DESTINATION_ADDRESS AS DESTINATION_STREET,
       TRIP_START_TIME AS PICKUP_TIME, TRIP_END_TIME AS DROPOFF_TIME,
       ORIGIN, DESTINATION, GEOMETRY, ROUTE_DISTANCE_METERS AS DISTANCE_METERS,
       SHIFT_TYPE,
       OBJECT_CONSTRUCT('features', ARRAY_CONSTRUCT(OBJECT_CONSTRUCT('properties',
           OBJECT_CONSTRUCT('summary', OBJECT_CONSTRUCT(
               'distance', ROUTE_DISTANCE_METERS, 'duration', ROUTE_DURATION_SECS
           ))))) AS ROUTE
FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.VW_TRIP_SUMMARY;
```

```sql
ALTER VIEW FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TRIP_ROUTE_PLAN SET
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-intelligence-taxis","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

### Verify All Views

```sql
SELECT 'TRIP_SUMMARY' AS VIEW_NAME, COUNT(*) AS ROW_COUNT FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TRIP_SUMMARY
UNION ALL SELECT 'DRIVER_LOCATIONS_V', COUNT(*) FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_LOCATIONS_V
UNION ALL SELECT 'VW_TRIP_SUMMARY', COUNT(*) FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.VW_TRIP_SUMMARY
UNION ALL SELECT 'VW_DRIVER_LOCATIONS', COUNT(*) FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.VW_DRIVER_LOCATIONS
UNION ALL SELECT 'ROUTE_NAMES', COUNT(*) FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.ROUTE_NAMES
UNION ALL SELECT 'TRIP_ROUTE_PLAN', COUNT(*) FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TRIP_ROUTE_PLAN
UNION ALL SELECT 'TRIPS_ASSIGNED_TO_DRIVERS', COUNT(*) FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TRIPS_ASSIGNED_TO_DRIVERS;
```

### Grant Access to Native App

After creating/replacing views, grant SELECT to the ORS Control App so the SPCS service can query them:

```sql
GRANT SELECT ON ALL VIEWS IN SCHEMA FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS TO APPLICATION OPENROUTESERVICE_NATIVE_APP;
```

```sql
GRANT SELECT ON ALL TABLES IN SCHEMA FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS TO APPLICATION OPENROUTESERVICE_NATIVE_APP;
```
