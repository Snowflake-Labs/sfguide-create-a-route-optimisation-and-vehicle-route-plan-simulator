# SQL Pipeline Reference

All SQL for the Route Deviation Analysis ETL pipeline. Execute statements one at a time via `snowflake_sql_execute`.

## Query Tag

```sql
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"deploy-route-deviation","version":{"major":1, "minor":0},"attributes":{"is_quickstart":1, "source":"sql"}}';
```

## ORS Verification

Check services:
```sql
SHOW SERVICES IN APPLICATION OPENROUTESERVICE_NATIVE_APP;
```
All 4 services must be RUNNING: ORS_SERVICE, ROUTING_GATEWAY_SERVICE, VROOM_SERVICE, DOWNLOADER.

Resume if suspended:
```sql
CALL OPENROUTESERVICE_NATIVE_APP.CORE.RESUME_ALL_SERVICES();
-- Verify:
SELECT OPENROUTESERVICE_NATIVE_APP.CORE.CHECK_HEALTH();
```

Test routing (must return DISTANCE > 0):
```sql
SELECT * FROM TABLE(OPENROUTESERVICE_NATIVE_APP.CORE.DIRECTIONS_GEO(
    'driving-hgv',
    OBJECT_CONSTRUCT('coordinates', ARRAY_CONSTRUCT(
        ARRAY_CONSTRUCT(13.388860, 52.517037),
        ARRAY_CONSTRUCT(13.397634, 52.529407)
    ))::VARIANT
));
```

## Infrastructure Setup

```sql
CREATE DATABASE IF NOT EXISTS {SOURCE_DB}
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"deploy-route-deviation","version":{"major":1,"minor":0}}';

CREATE SCHEMA IF NOT EXISTS {SOURCE_DB}.{SOURCE_SCHEMA}
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"deploy-route-deviation","version":{"major":1,"minor":0}}';

CREATE DATABASE IF NOT EXISTS {TARGET_DB}
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"deploy-route-deviation","version":{"major":1,"minor":0}}';

CREATE SCHEMA IF NOT EXISTS {TARGET_DB}.{TARGET_SCHEMA}
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"deploy-route-deviation","version":{"major":1,"minor":0}}';

CREATE DATABASE IF NOT EXISTS {ROUTE_CACHE_DB}
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"deploy-route-deviation","version":{"major":1,"minor":0}}';
CREATE SCHEMA IF NOT EXISTS {ROUTE_CACHE_DB}.{ROUTE_CACHE_SCHEMA}
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"deploy-route-deviation","version":{"major":1,"minor":0}}';

CREATE WAREHOUSE IF NOT EXISTS {WAREHOUSE}
    WAREHOUSE_SIZE = 'MEDIUM'
    AUTO_SUSPEND = 60
    AUTO_RESUME = TRUE
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"deploy-route-deviation","version":{"major":1,"minor":0}}';
```

## Check & Load Source Data

Check if the synthetic fleet dataset already exists:

```sql
SELECT 'FACT_TRUCK_TELEMETRY' AS TBL, COUNT(*) AS ROW_CNT FROM {SOURCE_DB}.{SOURCE_SCHEMA}.FACT_TRUCK_TELEMETRY
UNION ALL SELECT 'TRIP_SCHEDULE', COUNT(*) FROM {SOURCE_DB}.{SOURCE_SCHEMA}.TRIP_SCHEDULE
UNION ALL SELECT 'TRUCK_FLEET', COUNT(*) FROM {SOURCE_DB}.{SOURCE_SCHEMA}.TRUCK_FLEET
UNION ALL SELECT 'GERMANY_DESTINATIONS', COUNT(*) FROM {SOURCE_DB}.{SOURCE_SCHEMA}.GERMANY_DESTINATIONS
UNION ALL SELECT 'GERMANY_REST_STOPS', COUNT(*) FROM {SOURCE_DB}.{SOURCE_SCHEMA}.GERMANY_REST_STOPS;
```

**If all 5 tables exist with expected row counts:** Skip to Route Cache section.

**If any table is missing or has 0 rows:** Load from S3 by executing the canonical loading script from the `synthetic-datasets-generator` skill (`s3-load-fleet-intelligence.sql` in its references folder). Run each statement sequentially via `snowflake_sql_execute`. This creates `SYNTHETIC_DATASETS.FLEET_INTELLIGENCE`, the parquet file format, external stage at `s3://fleet-intelligence/`, and loads all 5 tables with correct GEOGRAPHY handling.

After loading, re-run the verification query above to confirm all tables are populated.

## Route Cache

### Create Table

```sql
CREATE TABLE IF NOT EXISTS {ROUTE_CACHE_DB}.{ROUTE_CACHE_SCHEMA}.ROUTE_CACHE (
    ORIGIN_ID VARCHAR,
    DEST_ID VARCHAR,
    ROAD_DISTANCE_M FLOAT,
    DURATION_SECONDS FLOAT,
    ROUTE_LINE GEOGRAPHY,
    CREATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"deploy-route-deviation","version":{"major":1,"minor":0}}';
```

### Check Missing OD Pairs

```sql
SELECT COUNT(*) AS MISSING_OD_PAIRS
FROM (
    SELECT DISTINCT ts.ORIGIN_ID, ts.DEST_ID
    FROM {SOURCE_DB}.{SOURCE_SCHEMA}.TRIP_SCHEDULE ts
    WHERE ts.ORIGIN_ID IS NOT NULL AND ts.DEST_ID IS NOT NULL
) sched
LEFT JOIN {ROUTE_CACHE_DB}.{ROUTE_CACHE_SCHEMA}.ROUTE_CACHE rc
    ON sched.ORIGIN_ID = rc.ORIGIN_ID AND sched.DEST_ID = rc.DEST_ID
WHERE rc.ORIGIN_ID IS NULL;
```

If MISSING_OD_PAIRS = 0, skip batch population.

### Batch Populate (Python)

```python
import os
import snowflake.connector
import time

conn = snowflake.connector.connect(
    connection_name=os.getenv("SNOWFLAKE_CONNECTION_NAME") or "<ACTIVE_CONNECTION>"
)
cursor = conn.cursor()

cursor.execute("""
    SELECT DISTINCT s.ORIGIN_ID, s.DEST_ID, o.LNG AS O_LNG, o.LAT AS O_LAT, d.LNG AS D_LNG, d.LAT AS D_LAT
    FROM {SOURCE_DB}.{SOURCE_SCHEMA}.TRIP_SCHEDULE s
    JOIN {SOURCE_DB}.{SOURCE_SCHEMA}.GERMANY_DESTINATIONS o ON s.ORIGIN_ID = o.ID
    JOIN {SOURCE_DB}.{SOURCE_SCHEMA}.GERMANY_DESTINATIONS d ON s.DEST_ID = d.ID
    LEFT JOIN {ROUTE_CACHE_DB}.{ROUTE_CACHE_SCHEMA}.ROUTE_CACHE rc
        ON s.ORIGIN_ID = rc.ORIGIN_ID AND s.DEST_ID = rc.DEST_ID
    WHERE rc.ORIGIN_ID IS NULL
""")
pairs = cursor.fetchall()
print(f"Total OD pairs to route: {len(pairs)}")

BATCH_SIZE = 200
for i in range(0, len(pairs), BATCH_SIZE):
    batch = pairs[i:i+BATCH_SIZE]
    values = []
    for origin_id, dest_id, o_lng, o_lat, d_lng, d_lat in batch:
        values.append(f"""
            SELECT
                '{origin_id}' AS ORIGIN_ID,
                '{dest_id}' AS DEST_ID,
                {o_lng} AS O_LNG, {o_lat} AS O_LAT,
                {d_lng} AS D_LNG, {d_lat} AS D_LAT
        """)
    union_sql = " UNION ALL ".join(values)

    insert_sql = f"""
        INSERT INTO {ROUTE_CACHE_DB}.{ROUTE_CACHE_SCHEMA}.ROUTE_CACHE
            (ORIGIN_ID, DEST_ID, ROAD_DISTANCE_M, DURATION_SECONDS, ROUTE_LINE)
        SELECT
            pairs.ORIGIN_ID, pairs.DEST_ID,
            ors.DISTANCE, ors.DURATION, ors.GEOJSON
        FROM ({union_sql}) pairs,
        TABLE(OPENROUTESERVICE_NATIVE_APP.CORE.DIRECTIONS_GEO(
            'driving-hgv',
            OBJECT_CONSTRUCT('coordinates', ARRAY_CONSTRUCT(
                ARRAY_CONSTRUCT(pairs.O_LNG, pairs.O_LAT),
                ARRAY_CONSTRUCT(pairs.D_LNG, pairs.D_LAT)
            ))::VARIANT
        )) ors
    """
    cursor.execute(insert_sql)
    done = min(i + BATCH_SIZE, len(pairs))
    print(f"Batch {i//BATCH_SIZE + 1}: {done}/{len(pairs)} pairs done")

cursor.execute(f"SELECT COUNT(*) FROM {ROUTE_CACHE_DB}.{ROUTE_CACHE_SCHEMA}.ROUTE_CACHE")
print(f"Route cache total: {cursor.fetchone()[0]}")
conn.close()
```

Timing: ~9,343 OD pairs at 200/batch = ~47 batches, ~5s each = ~4 minutes total.

## ETL Step 1: TRIP_ACTUAL_METRICS

Aggregates raw telemetry into per-trip metrics: duration, moving time, GPS point count, actual path geometry.

```sql
CREATE OR REPLACE TABLE {TARGET_DB}.{TARGET_SCHEMA}.TRIP_ACTUAL_METRICS AS
WITH valid_trips AS (
    SELECT DISTINCT TRIP_ID
    FROM {SOURCE_DB}.{SOURCE_SCHEMA}.FACT_TRUCK_TELEMETRY
    WHERE REGEXP_LIKE(TRIP_ID, '^[0-9]{8}-TRK-[0-9]{5}-[0-9]{2}$')
),
moving_intervals AS (
    SELECT 
        t.TRIP_ID, t.TS, t.STATUS,
        LEAD(t.TS) OVER (PARTITION BY t.TRIP_ID ORDER BY t.TS) AS next_ts
    FROM {SOURCE_DB}.{SOURCE_SCHEMA}.FACT_TRUCK_TELEMETRY t
    JOIN valid_trips v ON t.TRIP_ID = v.TRIP_ID
),
trip_durations AS (
    SELECT 
        TRIP_ID,
        SUM(CASE WHEN STATUS = 'MOVING' AND next_ts IS NOT NULL THEN TIMESTAMPDIFF('SECOND', TS, next_ts) ELSE 0 END) AS MOVING_DURATION_SEC,
        SUM(CASE WHEN next_ts IS NOT NULL THEN TIMESTAMPDIFF('SECOND', TS, next_ts) ELSE 0 END) AS TOTAL_DURATION_SEC
    FROM moving_intervals
    GROUP BY TRIP_ID
),
trip_meta AS (
    SELECT 
        t.TRIP_ID,
        ANY_VALUE(t.TRUCK_ID) AS TRUCK_ID,
        ANY_VALUE(t.DRIVER_ID) AS DRIVER_ID,
        MIN(t.TS) AS ACTUAL_START_TS,
        MAX(t.TS) AS ACTUAL_END_TS,
        COUNT(*) AS POINT_COUNT,
        TO_GEOGRAPHY(
            OBJECT_CONSTRUCT(
                'type', 'LineString',
                'coordinates', ARRAY_AGG(ARRAY_CONSTRUCT(ST_X(GEOMETRY), ST_Y(GEOMETRY))) WITHIN GROUP (ORDER BY TS)
            )::VARCHAR
        ) AS ACTUAL_PATH
    FROM {SOURCE_DB}.{SOURCE_SCHEMA}.FACT_TRUCK_TELEMETRY t
    JOIN valid_trips v ON t.TRIP_ID = v.TRIP_ID
    GROUP BY t.TRIP_ID
    HAVING COUNT(*) >= 2
)
SELECT
    m.TRIP_ID,
    m.TRUCK_ID,
    m.DRIVER_ID,
    'TRK-' || LPAD(REPLACE(m.TRUCK_ID, 'TRK-', ''), 5, '0') AS TRUCK_ID_NORMALIZED,
    TO_DATE(LEFT(m.TRIP_ID, 8), 'YYYYMMDD') AS TRIP_DATE,
    CAST(SPLIT_PART(m.TRIP_ID, '-', 4) AS INTEGER) AS TRIP_SEQ,
    m.ACTUAL_START_TS,
    m.ACTUAL_END_TS,
    d.TOTAL_DURATION_SEC,
    ROUND(d.TOTAL_DURATION_SEC / 60.0, 2) AS TOTAL_DURATION_MIN,
    d.MOVING_DURATION_SEC AS ACTUAL_DURATION_SEC,
    ROUND(d.MOVING_DURATION_SEC / 60.0, 2) AS ACTUAL_DURATION_MIN,
    m.POINT_COUNT,
    m.ACTUAL_PATH
FROM trip_meta m
JOIN trip_durations d ON m.TRIP_ID = d.TRIP_ID;

ALTER TABLE {TARGET_DB}.{TARGET_SCHEMA}.TRIP_ACTUAL_METRICS SET
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"deploy-route-deviation","version":{"major":1,"minor":0}}';
```

Timing: 3-8 minutes on MEDIUM warehouse (processes 15M rows with window functions).
Verify: `SELECT COUNT(*) FROM {TARGET_DB}.{TARGET_SCHEMA}.TRIP_ACTUAL_METRICS;` -- expect ~4,600-4,700

## ETL Step 2: OD_EXPECTED_ROUTES

Joins schedule OD pairs with Germany destinations metadata and route cache distances.

```sql
CREATE OR REPLACE TABLE {TARGET_DB}.{TARGET_SCHEMA}.OD_EXPECTED_ROUTES AS
WITH unique_od_pairs AS (
    SELECT DISTINCT 
        ts.ORIGIN_ID, ts.DEST_ID,
        o.LNG AS ORIGIN_LNG, o.LAT AS ORIGIN_LAT,
        o.NAME AS ORIGIN_NAME, o.CITY AS ORIGIN_CITY,
        d.LNG AS DEST_LNG, d.LAT AS DEST_LAT,
        d.NAME AS DEST_NAME, d.CITY AS DEST_CITY
    FROM {SOURCE_DB}.{SOURCE_SCHEMA}.TRIP_SCHEDULE ts
    JOIN {SOURCE_DB}.{SOURCE_SCHEMA}.GERMANY_DESTINATIONS o ON ts.ORIGIN_ID = o.ID
    JOIN {SOURCE_DB}.{SOURCE_SCHEMA}.GERMANY_DESTINATIONS d ON ts.DEST_ID = d.ID
    WHERE ts.ORIGIN_ID IS NOT NULL AND ts.DEST_ID IS NOT NULL
)
SELECT 
    p.ORIGIN_ID, p.DEST_ID,
    p.ORIGIN_LNG, p.ORIGIN_LAT, p.ORIGIN_NAME, p.ORIGIN_CITY,
    p.DEST_LNG, p.DEST_LAT, p.DEST_NAME, p.DEST_CITY,
    HAVERSINE(p.ORIGIN_LAT, p.ORIGIN_LNG, p.DEST_LAT, p.DEST_LNG) AS STRAIGHT_LINE_DISTANCE_KM,
    ROUND(c.ROAD_DISTANCE_M / 1000, 2) AS EXPECTED_DISTANCE_KM,
    c.DURATION_SECONDS AS EXPECTED_DURATION_SEC,
    ROUND(c.DURATION_SECONDS / 60.0, 2) AS EXPECTED_DURATION_MIN,
    c.ROUTE_LINE AS EXPECTED_PATH
FROM unique_od_pairs p
JOIN {ROUTE_CACHE_DB}.{ROUTE_CACHE_SCHEMA}.ROUTE_CACHE c 
    ON p.ORIGIN_ID = c.ORIGIN_ID AND p.DEST_ID = c.DEST_ID;

ALTER TABLE {TARGET_DB}.{TARGET_SCHEMA}.OD_EXPECTED_ROUTES SET
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"deploy-route-deviation","version":{"major":1,"minor":0}}';
```

Verify: `SELECT COUNT(*) FROM {TARGET_DB}.{TARGET_SCHEMA}.OD_EXPECTED_ROUTES;` -- expect 9,343

STOP if 0 rows: Route cache is empty or OD IDs don't match. Re-run route cache population.

## ETL Step 3: TRIP_DEVIATION_ANALYSIS

Compares actual trip metrics against expected routes. Joins on telemetry OD (first/last LOCATION_ID) to schedule to expected routes.

```sql
CREATE OR REPLACE TABLE {TARGET_DB}.{TARGET_SCHEMA}.TRIP_DEVIATION_ANALYSIS AS
WITH trip_od AS (
    SELECT TRIP_ID, 
        FIRST_VALUE(LOCATION_ID) OVER (PARTITION BY TRIP_ID ORDER BY TS) AS origin_loc_id,
        LAST_VALUE(LOCATION_ID) OVER (PARTITION BY TRIP_ID ORDER BY TS 
            ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS dest_loc_id
    FROM {SOURCE_DB}.{SOURCE_SCHEMA}.FACT_TRUCK_TELEMETRY
    WHERE REGEXP_LIKE(TRIP_ID, '^[0-9]{8}-TRK-[0-9]{5}-[0-9]{2}$')
    QUALIFY ROW_NUMBER() OVER (PARTITION BY TRIP_ID ORDER BY TS) = 1
)
SELECT
    a.TRIP_ID,
    a.TRUCK_ID,
    a.DRIVER_ID,
    a.TRIP_DATE,
    s.ROUTE_VARIATION,
    s.ROUTE_DEVIATION_FACTOR,
    s.TRIP_TYPE,
    ROUND(e.EXPECTED_DISTANCE_KM * s.ROUTE_DEVIATION_FACTOR, 2) AS ACTUAL_DISTANCE_KM,
    a.ACTUAL_DURATION_MIN,
    a.TOTAL_DURATION_MIN,
    a.ACTUAL_START_TS,
    a.ACTUAL_END_TS,
    a.POINT_COUNT,
    e.EXPECTED_DISTANCE_KM,
    e.EXPECTED_DURATION_MIN,
    e.STRAIGHT_LINE_DISTANCE_KM,
    e.ORIGIN_NAME, e.ORIGIN_CITY,
    e.DEST_NAME, e.DEST_CITY,
    ROUND(e.EXPECTED_DISTANCE_KM * s.ROUTE_DEVIATION_FACTOR - e.EXPECTED_DISTANCE_KM, 2) AS DISTANCE_DEVIATION_KM,
    ROUND((s.ROUTE_DEVIATION_FACTOR - 1) * 100, 2) AS DISTANCE_DEVIATION_PCT,
    ROUND(a.ACTUAL_DURATION_MIN - e.EXPECTED_DURATION_MIN, 2) AS DURATION_DEVIATION_MIN,
    ROUND((a.ACTUAL_DURATION_MIN - e.EXPECTED_DURATION_MIN) / NULLIF(e.EXPECTED_DURATION_MIN, 0) * 100, 2) AS DURATION_DEVIATION_PCT,
    CASE WHEN ABS(s.ROUTE_DEVIATION_FACTOR - 1) > 0.20 THEN TRUE ELSE FALSE END AS IS_DISTANCE_DEVIATION,
    CASE WHEN ABS((a.ACTUAL_DURATION_MIN - e.EXPECTED_DURATION_MIN) / NULLIF(e.EXPECTED_DURATION_MIN, 0)) > 0.20 THEN TRUE ELSE FALSE END AS IS_DURATION_DEVIATION,
    CASE WHEN ABS(s.ROUTE_DEVIATION_FACTOR - 1) > 0.20
           OR ABS((a.ACTUAL_DURATION_MIN - e.EXPECTED_DURATION_MIN) / NULLIF(e.EXPECTED_DURATION_MIN, 0)) > 0.20
         THEN TRUE ELSE FALSE END AS IS_ROUTE_DEVIATION,
    a.ACTUAL_PATH,
    e.EXPECTED_PATH
FROM {TARGET_DB}.{TARGET_SCHEMA}.TRIP_ACTUAL_METRICS a
JOIN trip_od od ON a.TRIP_ID = od.TRIP_ID
JOIN {SOURCE_DB}.{SOURCE_SCHEMA}.TRIP_SCHEDULE s 
    ON s.TRUCK_ID = a.TRUCK_ID_NORMALIZED 
    AND s.TRIP_DATE = a.TRIP_DATE 
    AND s.ORIGIN_ID = od.origin_loc_id
    AND s.DEST_ID = od.dest_loc_id
JOIN {TARGET_DB}.{TARGET_SCHEMA}.OD_EXPECTED_ROUTES e 
    ON s.ORIGIN_ID = e.ORIGIN_ID AND s.DEST_ID = e.DEST_ID;

ALTER TABLE {TARGET_DB}.{TARGET_SCHEMA}.TRIP_DEVIATION_ANALYSIS SET
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"deploy-route-deviation","version":{"major":1,"minor":0}}';
```

Verify: `SELECT COUNT(*) FROM {TARGET_DB}.{TARGET_SCHEMA}.TRIP_DEVIATION_ANALYSIS;` -- expect ~3,500-3,600

Not all actual trips match a schedule entry (HOS limits, time cutoffs, random-destination trips cause ~25% drop). This is expected.

## ETL Step 4: DRIVER_DEVIATION_SUMMARY

Aggregates deviation stats per driver, joined with fleet metadata.

```sql
CREATE OR REPLACE TABLE {TARGET_DB}.{TARGET_SCHEMA}.DRIVER_DEVIATION_SUMMARY AS
SELECT
    d.TRUCK_ID,
    d.DRIVER_ID,
    f.DRIVER_PROFILE,
    f.TRUCK_TYPE,
    f.HOME_CITY,
    COUNT(*) AS TOTAL_TRIPS,
    SUM(CASE WHEN d.IS_ROUTE_DEVIATION THEN 1 ELSE 0 END) AS DEVIATION_TRIPS,
    ROUND(SUM(CASE WHEN d.IS_ROUTE_DEVIATION THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 2) AS DEVIATION_RATE_PCT,
    ROUND(SUM(CASE WHEN d.IS_ROUTE_DEVIATION THEN d.DISTANCE_DEVIATION_KM ELSE 0 END), 2) AS TOTAL_EXCESS_KM,
    ROUND(SUM(CASE WHEN d.IS_ROUTE_DEVIATION THEN d.DURATION_DEVIATION_MIN ELSE 0 END), 2) AS TOTAL_TIME_LOST_MIN,
    ROUND(AVG(d.DISTANCE_DEVIATION_PCT), 2) AS AVG_DISTANCE_DEVIATION_PCT,
    ROUND(AVG(d.DURATION_DEVIATION_PCT), 2) AS AVG_DURATION_DEVIATION_PCT,
    MAX(d.DISTANCE_DEVIATION_PCT) AS MAX_DISTANCE_DEVIATION_PCT,
    MAX(d.DURATION_DEVIATION_PCT) AS MAX_DURATION_DEVIATION_PCT
FROM {TARGET_DB}.{TARGET_SCHEMA}.TRIP_DEVIATION_ANALYSIS d
JOIN {SOURCE_DB}.{SOURCE_SCHEMA}.TRUCK_FLEET f
    ON 'TRK-' || LPAD(REPLACE(d.TRUCK_ID, 'TRK-', ''), 5, '0') = f.TRUCK_ID
GROUP BY d.TRUCK_ID, d.DRIVER_ID, f.DRIVER_PROFILE, f.TRUCK_TYPE, f.HOME_CITY;

ALTER TABLE {TARGET_DB}.{TARGET_SCHEMA}.DRIVER_DEVIATION_SUMMARY SET
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"deploy-route-deviation","version":{"major":1,"minor":0}}';
```

Verify: `SELECT COUNT(*) FROM {TARGET_DB}.{TARGET_SCHEMA}.DRIVER_DEVIATION_SUMMARY;` -- expect 500

## ETL Step 5: DAILY_DEVIATION_TRENDS

```sql
CREATE OR REPLACE TABLE {TARGET_DB}.{TARGET_SCHEMA}.DAILY_DEVIATION_TRENDS AS
SELECT
    TRIP_DATE,
    DAYNAME(TRIP_DATE) AS DAY_OF_WEEK,
    COUNT(*) AS TOTAL_TRIPS,
    SUM(CASE WHEN IS_ROUTE_DEVIATION THEN 1 ELSE 0 END) AS DEVIATION_TRIPS,
    ROUND(SUM(CASE WHEN IS_ROUTE_DEVIATION THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 2) AS DEVIATION_RATE_PCT,
    ROUND(SUM(DISTANCE_DEVIATION_KM), 2) AS TOTAL_EXCESS_DISTANCE_KM,
    ROUND(SUM(DURATION_DEVIATION_MIN), 2) AS TOTAL_EXCESS_DURATION_MIN,
    ROUND(AVG(DISTANCE_DEVIATION_PCT), 2) AS AVG_DISTANCE_DEVIATION_PCT,
    ROUND(AVG(DURATION_DEVIATION_PCT), 2) AS AVG_DURATION_DEVIATION_PCT
FROM {TARGET_DB}.{TARGET_SCHEMA}.TRIP_DEVIATION_ANALYSIS
GROUP BY TRIP_DATE;

ALTER TABLE {TARGET_DB}.{TARGET_SCHEMA}.DAILY_DEVIATION_TRENDS SET
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"deploy-route-deviation","version":{"major":1,"minor":0}}';
```

Verify: `SELECT COUNT(*) FROM {TARGET_DB}.{TARGET_SCHEMA}.DAILY_DEVIATION_TRENDS;` -- expect 14

## Verify Full ETL Pipeline

```sql
SELECT 'TRIP_ACTUAL_METRICS' AS TABLE_NAME, COUNT(*) AS ROW_CNT FROM {TARGET_DB}.{TARGET_SCHEMA}.TRIP_ACTUAL_METRICS
UNION ALL SELECT 'OD_EXPECTED_ROUTES', COUNT(*) FROM {TARGET_DB}.{TARGET_SCHEMA}.OD_EXPECTED_ROUTES
UNION ALL SELECT 'TRIP_DEVIATION_ANALYSIS', COUNT(*) FROM {TARGET_DB}.{TARGET_SCHEMA}.TRIP_DEVIATION_ANALYSIS
UNION ALL SELECT 'DRIVER_DEVIATION_SUMMARY', COUNT(*) FROM {TARGET_DB}.{TARGET_SCHEMA}.DRIVER_DEVIATION_SUMMARY
UNION ALL SELECT 'DAILY_DEVIATION_TRENDS', COUNT(*) FROM {TARGET_DB}.{TARGET_SCHEMA}.DAILY_DEVIATION_TRENDS;
```

## Streamlit Deployment

Dashboard files:
- `dashboard/pages/Route_Deviations.py`
- `dashboard/pages/Route_Inspector.py`
- `dashboard/environment.yml`

Deploy by uploading to a stage and creating the Streamlit object:

```sql
CREATE STAGE IF NOT EXISTS {TARGET_DB}.{TARGET_SCHEMA}.STREAMLIT
    ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE')
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"deploy-route-deviation","version":{"major":1,"minor":0}}';

PUT file://dashboard/pages/Route_Deviations.py @{TARGET_DB}.{TARGET_SCHEMA}.STREAMLIT/pages/ AUTO_COMPRESS=FALSE OVERWRITE=TRUE;
PUT file://dashboard/pages/Route_Inspector.py @{TARGET_DB}.{TARGET_SCHEMA}.STREAMLIT/pages/ AUTO_COMPRESS=FALSE OVERWRITE=TRUE;
PUT file://dashboard/environment.yml @{TARGET_DB}.{TARGET_SCHEMA}.STREAMLIT/ AUTO_COMPRESS=FALSE OVERWRITE=TRUE;

CREATE OR REPLACE STREAMLIT {TARGET_DB}.{TARGET_SCHEMA}.ROUTE_DEVIATION_DASHBOARD
    FROM @{TARGET_DB}.{TARGET_SCHEMA}.STREAMLIT
    MAIN_FILE = 'pages/Route_Deviations.py'
    QUERY_WAREHOUSE = '{WAREHOUSE}'
    TITLE = 'Route Deviation Analysis'
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"deploy-route-deviation","version":{"major":1,"minor":0}}';

ALTER STREAMLIT {TARGET_DB}.{TARGET_SCHEMA}.ROUTE_DEVIATION_DASHBOARD ADD LIVE VERSION FROM LAST;
```

## Verification Queries

Deviation distribution:
```sql
SELECT 
    ROUTE_VARIATION,
    COUNT(*) AS TRIPS,
    ROUND(AVG(DISTANCE_DEVIATION_PCT), 1) AS AVG_DIST_DEV_PCT,
    SUM(CASE WHEN IS_ROUTE_DEVIATION THEN 1 ELSE 0 END) AS FLAGGED
FROM {TARGET_DB}.{TARGET_SCHEMA}.TRIP_DEVIATION_ANALYSIS
GROUP BY ROUTE_VARIATION
ORDER BY ROUTE_VARIATION;
```

Daily trends:
```sql
SELECT TRIP_DATE, TOTAL_TRIPS, DEVIATION_TRIPS, DEVIATION_RATE_PCT 
FROM {TARGET_DB}.{TARGET_SCHEMA}.DAILY_DEVIATION_TRENDS 
ORDER BY TRIP_DATE;
```

Dashboard URL:
```sql
SELECT CONCAT('https://app.snowflake.com/', CURRENT_ORGANIZATION_NAME(), '/', CURRENT_ACCOUNT_NAME(),
    '/#/streamlit-apps/', '{TARGET_DB}', '.', '{TARGET_SCHEMA}', '.ROUTE_DEVIATION_DASHBOARD') AS STREAMLIT_URL;
```
