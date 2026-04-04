# SQL Pipeline (Steps 3b-9) -- DEPRECATED

> **DEPRECATED:** Steps 3b-9 are no longer the primary data path. Use **Data Studio** in the ORS Control Panel to generate synthetic datasets. Data Studio writes to `SYNTHETIC_DATASETS.UNIFIED` tables, and projection views (Step 10 in `streamlit-deployment.md`) read from them.
>
> This file is preserved for reference only. The projection views in Step 10 of `streamlit-deployment.md` are still active.

---

### Step 3b: Check & Install Overture Maps Datasets

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

### Step 4: Create Restaurant Locations (California-wide)

**Goal:** Load restaurant locations from Overture Maps for all of California using the state-level filter.

> **Filter Strategy:** Instead of a bounding box (`ST_X BETWEEN...`), we filter by `COUNTRY='US'` and `region='CA'` in the Overture Maps address metadata. This captures the entire state without missing coastal/border areas and leverages Overture's partition pruning for fast queries.

```sql
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.RESTAURANTS AS
SELECT 
    ID AS RESTAURANT_ID,
    GEOMETRY AS LOCATION,
    NAMES:primary::STRING AS NAME,
    CATEGORIES:primary::STRING AS CUISINE_TYPE,
    ADDRESSES[0]:freeform::STRING AS ADDRESS,
    ADDRESSES[0]:locality::STRING AS CITY,
    ADDRESSES[0]:region::STRING AS STATE
FROM OVERTURE_MAPS__PLACES.CARTO.PLACE
WHERE 
    ADDRESSES[0]:country::STRING = 'US'
    AND ADDRESSES[0]:region::STRING = 'CA'
    AND NAMES:primary IS NOT NULL
    AND (
        CATEGORIES:primary::STRING ILIKE '%restaurant%'
        OR CATEGORIES:primary::STRING ILIKE '%food%'
        OR CATEGORIES:primary::STRING ILIKE '%pizza%'
        OR CATEGORIES:primary::STRING ILIKE '%burger%'
        OR CATEGORIES:primary::STRING ILIKE '%sushi%'
        OR CATEGORIES:primary::STRING ILIKE '%taco%'
        OR CATEGORIES:primary::STRING ILIKE '%coffee%'
        OR CATEGORIES:primary::STRING ILIKE '%bakery%'
        OR CATEGORIES:primary::STRING ILIKE '%cafe%'
        OR CATEGORIES:primary::STRING ILIKE '%deli%'
        OR CATEGORIES:primary::STRING ILIKE '%asian%'
        OR CATEGORIES:primary::STRING ILIKE '%chinese%'
        OR CATEGORIES:primary::STRING ILIKE '%thai%'
        OR CATEGORIES:primary::STRING ILIKE '%indian%'
        OR CATEGORIES:primary::STRING ILIKE '%mexican%'
        OR CATEGORIES:primary::STRING ILIKE '%italian%'
        OR CATEGORIES:primary::STRING ILIKE '%sandwich%'
        OR CATEGORIES:primary::STRING ILIKE '%fast_food%'
    );

ALTER TABLE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.RESTAURANTS SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-a-fleet-intelligence-solution-for-food-delivery","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

Then verify:

```sql
SELECT 
    CITY,
    COUNT(*) AS RESTAURANT_COUNT
FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.RESTAURANTS
GROUP BY CITY
ORDER BY RESTAURANT_COUNT DESC
LIMIT 15;
```

**Enable Search Optimization** for fast city-level lookups:

```sql
ALTER TABLE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.RESTAURANTS
    ADD SEARCH OPTIMIZATION ON EQUALITY(CITY);
```

**Output:** `RESTAURANTS` table with 120K+ food establishments across California, with CITY column for filtering.

---

### Step 5: Create Customer Delivery Addresses (California-wide)

**Goal:** Load customer addresses from Overture Maps for all of California.

```sql
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.CUSTOMER_ADDRESSES AS
SELECT 
    ID AS ADDRESS_ID,
    GEOMETRY AS LOCATION,
    COALESCE(
        ADDRESS_LEVELS[0]:value::STRING || ' ' || STREET,
        STREET
    ) AS FULL_ADDRESS,
    STREET,
    POSTCODE,
    ADDRESS_LEVELS[0]:value::STRING AS STATE,
    ADDRESS_LEVELS[1]:value::STRING AS CITY
FROM OVERTURE_MAPS__ADDRESSES.CARTO.ADDRESS
WHERE 
    COUNTRY = 'US'
    AND ADDRESS_LEVELS[0]:value::STRING = 'CA'
    AND STREET IS NOT NULL;

ALTER TABLE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.CUSTOMER_ADDRESSES SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-a-fleet-intelligence-solution-for-food-delivery","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

Then verify:

```sql
SELECT 
    CITY,
    COUNT(*) AS ADDRESS_COUNT
FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.CUSTOMER_ADDRESSES
GROUP BY CITY
ORDER BY ADDRESS_COUNT DESC
LIMIT 15;
```

**Enable Search Optimization** for fast city-level lookups:

```sql
ALTER TABLE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.CUSTOMER_ADDRESSES
    ADD SEARCH OPTIMIZATION ON EQUALITY(CITY);
```

**Output:** `CUSTOMER_ADDRESSES` table with 14.2M+ delivery addresses across California.

---

### Step 6: Create Couriers with Shift Patterns

**Goal:** Create couriers distributed across peak meal times.

**Action:** Substitute `{BREAKFAST_COUNT}`, `{LUNCH_COUNT}`, `{AFTERNOON_COUNT}`, `{DINNER_COUNT}`, `{LATE_NIGHT_COUNT}`. For the default 50 couriers: 5, 15, 8, 17, 5.

```sql
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.COURIERS AS
WITH shift_patterns AS (
    SELECT 1 AS shift_id, 'Breakfast' AS shift_name, 6 AS shift_start, 11 AS shift_end, {BREAKFAST_COUNT} AS courier_count UNION ALL
    SELECT 2, 'Lunch', 10, 15, {LUNCH_COUNT} UNION ALL
    SELECT 3, 'Afternoon', 14, 18, {AFTERNOON_COUNT} UNION ALL
    SELECT 4, 'Dinner', 17, 22, {DINNER_COUNT} UNION ALL
    SELECT 5, 'Late Night', 20, 2, {LATE_NIGHT_COUNT}
),
max_per_shift AS (
    SELECT MAX(courier_count) AS max_count FROM shift_patterns
),
courier_assignments AS (
    SELECT 
        ROW_NUMBER() OVER (ORDER BY sp.shift_id, seq.seq) AS courier_num,
        sp.shift_name AS shift_type,
        sp.shift_start AS shift_start_hour,
        sp.shift_end AS shift_end_hour,
        CASE WHEN sp.shift_start > sp.shift_end THEN 'True' ELSE 'False' END AS shift_crosses_midnight
    FROM shift_patterns sp
    CROSS JOIN (SELECT SEQ4() + 1 AS seq FROM TABLE(GENERATOR(ROWCOUNT => 1000))) seq
    CROSS JOIN max_per_shift m
    WHERE seq.seq <= sp.courier_count
),
home_locations AS (
    SELECT 
        ADDRESS_ID,
        ROW_NUMBER() OVER (ORDER BY RANDOM()) AS rn
    FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.CUSTOMER_ADDRESSES
    LIMIT 100
)
SELECT 
    'C-' || LPAD(ca.courier_num::STRING, 4, '0') AS COURIER_ID,
    hl.ADDRESS_ID AS HOME_ADDRESS_ID,
    ca.shift_type AS SHIFT_TYPE,
    ca.shift_start_hour AS SHIFT_START_HOUR,
    ca.shift_end_hour AS SHIFT_END_HOUR,
    ca.shift_crosses_midnight AS SHIFT_CROSSES_MIDNIGHT,
    CASE 
        WHEN UNIFORM(1, 100, RANDOM()) <= 60 THEN 'bicycle'
        WHEN UNIFORM(1, 100, RANDOM()) <= 85 THEN 'car'
        ELSE 'scooter'
    END AS VEHICLE_TYPE
FROM courier_assignments ca
LEFT JOIN home_locations hl ON ca.courier_num = hl.rn;

ALTER TABLE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.COURIERS SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-a-fleet-intelligence-solution-for-food-delivery","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

Then verify:

```sql
SELECT 
    SHIFT_TYPE,
    VEHICLE_TYPE,
    COUNT(*) AS NUM_COURIERS
FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.COURIERS
GROUP BY SHIFT_TYPE, VEHICLE_TYPE
ORDER BY SHIFT_TYPE, NUM_COURIERS DESC;
```

**Output:** `COURIERS` table with configured number of couriers.

---

### Step 7: Generate Delivery Orders

**Goal:** Create order assignments for each courier.

**Action:** Execute this SQL. Order counts vary by shift type (Lunch: 12-18, Dinner: 14-20, Breakfast: 6-10, Afternoon: 8-12, Late Night: 4-8).

First, materialize numbered tables for stable joins:

```sql
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.RESTAURANTS_NUMBERED AS
SELECT 
    RESTAURANT_ID,
    LOCATION,
    NAME,
    CUISINE_TYPE,
    ADDRESS,
    ROW_NUMBER() OVER (ORDER BY HASH(RESTAURANT_ID)) AS rn
FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.RESTAURANTS
WHERE NAME IS NOT NULL AND LENGTH(NAME) > 2;

ALTER TABLE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.RESTAURANTS_NUMBERED SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-a-fleet-intelligence-solution-for-food-delivery","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

```sql
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.ADDRESSES_NUMBERED AS
SELECT 
    ADDRESS_ID,
    LOCATION,
    FULL_ADDRESS,
    ROW_NUMBER() OVER (ORDER BY HASH(ADDRESS_ID)) AS rn
FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.CUSTOMER_ADDRESSES
WHERE FULL_ADDRESS IS NOT NULL AND LENGTH(FULL_ADDRESS) > 3;

ALTER TABLE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.ADDRESSES_NUMBERED SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-a-fleet-intelligence-solution-for-food-delivery","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

Then generate the orders:

```sql
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ORDERS AS
WITH 
courier_order_counts AS (
    SELECT 
        c.COURIER_ID,
        c.SHIFT_TYPE,
        c.SHIFT_START_HOUR,
        c.SHIFT_END_HOUR,
        c.SHIFT_CROSSES_MIDNIGHT,
        c.VEHICLE_TYPE,
        CASE c.SHIFT_TYPE
            WHEN 'Lunch' THEN UNIFORM(12, 18, RANDOM())
            WHEN 'Dinner' THEN UNIFORM(14, 20, RANDOM())
            WHEN 'Breakfast' THEN UNIFORM(6, 10, RANDOM())
            WHEN 'Afternoon' THEN UNIFORM(8, 12, RANDOM())
            WHEN 'Late Night' THEN UNIFORM(4, 8, RANDOM())
        END AS NUM_ORDERS
    FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.COURIERS c
),
order_sequence AS (
    SELECT 
        c.COURIER_ID,
        c.SHIFT_TYPE,
        c.SHIFT_START_HOUR,
        c.SHIFT_END_HOUR,
        c.SHIFT_CROSSES_MIDNIGHT,
        c.VEHICLE_TYPE,
        c.NUM_ORDERS,
        ROW_NUMBER() OVER (PARTITION BY c.COURIER_ID ORDER BY RANDOM()) AS ORDER_NUMBER
    FROM courier_order_counts c
    CROSS JOIN TABLE(GENERATOR(ROWCOUNT => 25)) g
    QUALIFY ORDER_NUMBER <= c.NUM_ORDERS
),
orders_with_hours AS (
    SELECT 
        os.*,
        CASE 
            WHEN os.SHIFT_CROSSES_MIDNIGHT = 'True' THEN
                MOD(os.SHIFT_START_HOUR + FLOOR((os.ORDER_NUMBER - 1) * 6.0 / os.NUM_ORDERS) + UNIFORM(0, 1, RANDOM()), 24)
            ELSE
                os.SHIFT_START_HOUR + FLOOR((os.ORDER_NUMBER - 1) * (os.SHIFT_END_HOUR - os.SHIFT_START_HOUR) / os.NUM_ORDERS) + UNIFORM(0, 1, RANDOM())
        END AS ORDER_HOUR
    FROM order_sequence os
),
rest_count AS (
    SELECT COUNT(*) AS cnt FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.RESTAURANTS_NUMBERED
),
addr_count AS (
    SELECT COUNT(*) AS cnt FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.ADDRESSES_NUMBERED
)
SELECT 
    MD5(o.COURIER_ID || '-' || o.ORDER_NUMBER || '-' || RANDOM()) AS ORDER_ID,
    o.COURIER_ID,
    o.ORDER_HOUR::INT AS ORDER_HOUR,
    o.ORDER_NUMBER::INT AS ORDER_NUMBER,
    o.SHIFT_TYPE,
    o.VEHICLE_TYPE,
    MOD(ABS(HASH(o.COURIER_ID || o.ORDER_NUMBER || 'R')), rc.cnt) + 1 AS RESTAURANT_IDX,
    MOD(ABS(HASH(o.COURIER_ID || o.ORDER_NUMBER || 'C')), ac.cnt) + 1 AS CUSTOMER_IDX,
    UNIFORM(5, 25, RANDOM()) AS PREP_TIME_MINS,
    CASE 
        WHEN UNIFORM(1, 100, RANDOM()) <= 92 THEN 'delivered'
        WHEN UNIFORM(1, 100, RANDOM()) <= 97 THEN 'in_transit'
        ELSE 'picked_up'
    END AS ORDER_STATUS
FROM orders_with_hours o
CROSS JOIN rest_count rc
CROSS JOIN addr_count ac;

ALTER TABLE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ORDERS SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-a-fleet-intelligence-solution-for-food-delivery","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

```sql
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.ORDERS_WITH_LOCATIONS AS
SELECT 
    o.ORDER_ID,
    o.COURIER_ID,
    o.ORDER_HOUR,
    o.ORDER_NUMBER,
    o.SHIFT_TYPE,
    o.VEHICLE_TYPE,
    r.RESTAURANT_ID,
    r.NAME AS RESTAURANT_NAME,
    r.CUISINE_TYPE,
    r.LOCATION AS RESTAURANT_LOCATION,
    r.ADDRESS AS RESTAURANT_ADDRESS,
    a.ADDRESS_ID AS CUSTOMER_ADDRESS_ID,
    a.FULL_ADDRESS AS CUSTOMER_ADDRESS,
    a.LOCATION AS CUSTOMER_LOCATION,
    o.PREP_TIME_MINS,
    o.ORDER_STATUS
FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ORDERS o
JOIN FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.RESTAURANTS_NUMBERED r ON o.RESTAURANT_IDX = r.rn
JOIN FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.ADDRESSES_NUMBERED a ON o.CUSTOMER_IDX = a.rn;

ALTER TABLE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.ORDERS_WITH_LOCATIONS SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-a-fleet-intelligence-solution-for-food-delivery","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

Then verify:

```sql
SELECT 
    SHIFT_TYPE,
    COUNT(DISTINCT COURIER_ID) AS COURIERS,
    MIN(orders) AS MIN_ORDERS,
    MAX(orders) AS MAX_ORDERS,
    AVG(orders)::INT AS AVG_ORDERS
FROM (
    SELECT COURIER_ID, SHIFT_TYPE, COUNT(*) AS orders
    FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ORDERS
    GROUP BY COURIER_ID, SHIFT_TYPE
)
GROUP BY SHIFT_TYPE
ORDER BY AVG_ORDERS DESC;
```

**Output:** `DELIVERY_ORDERS` and `ORDERS_WITH_LOCATIONS` tables.

---

### Step 8: Generate ORS Routes

**Goal:** Generate actual road routes using OpenRouteService.

**Action:** Execute this SQL. Substitute `{START_DATE}` with the configured start date (default: `2025-01-15`).

**WARNING:** This step makes many ORS API calls and may take several minutes depending on order count.
- 500 orders: ~2-4 minutes
- 1,500 orders: ~8-12 minutes
- 3,000 orders: ~20-30 minutes

```sql
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ROUTES AS
SELECT 
    COURIER_ID,
    ORDER_ID,
    ORDER_HOUR,
    ORDER_NUMBER,
    SHIFT_TYPE,
    VEHICLE_TYPE,
    RESTAURANT_ID,
    RESTAURANT_NAME,
    CUISINE_TYPE,
    RESTAURANT_LOCATION,
    RESTAURANT_ADDRESS,
    CUSTOMER_ADDRESS_ID,
    CUSTOMER_ADDRESS,
    CUSTOMER_LOCATION,
    PREP_TIME_MINS,
    ORDER_STATUS,
    OPENROUTESERVICE_NATIVE_APP.CORE.DIRECTIONS(
        CASE VEHICLE_TYPE
            WHEN 'bicycle' THEN 'cycling-regular'
            WHEN 'scooter' THEN 'driving-car'
            ELSE 'driving-car'
        END,
        ARRAY_CONSTRUCT(ST_X(RESTAURANT_LOCATION), ST_Y(RESTAURANT_LOCATION)),
        ARRAY_CONSTRUCT(ST_X(CUSTOMER_LOCATION), ST_Y(CUSTOMER_LOCATION))
    ) AS ROUTE_RESPONSE
FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.ORDERS_WITH_LOCATIONS;

ALTER TABLE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ROUTES SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-a-fleet-intelligence-solution-for-food-delivery","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

> **_GEO Alternative:** Combine route + parsing into a single step using `DIRECTIONS_GEO`:
> ```sql
> CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ROUTES_PARSED AS
> SELECT 
>     o.COURIER_ID, o.ORDER_ID, o.ORDER_HOUR, o.ORDER_NUMBER,
>     o.SHIFT_TYPE, o.VEHICLE_TYPE, o.RESTAURANT_ID, o.RESTAURANT_NAME,
>     o.CUISINE_TYPE, o.RESTAURANT_LOCATION, o.RESTAURANT_ADDRESS,
>     o.CUSTOMER_ADDRESS_ID, o.CUSTOMER_ADDRESS, o.CUSTOMER_LOCATION,
>     o.PREP_TIME_MINS, o.ORDER_STATUS,
>     d.GEOJSON AS ROUTE_GEOMETRY,
>     d.DISTANCE AS ROUTE_DISTANCE_METERS,
>     d.DURATION AS ROUTE_DURATION_SECS
> FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.ORDERS_WITH_LOCATIONS o,
>     TABLE(OPENROUTESERVICE_NATIVE_APP.CORE.DIRECTIONS_GEO(
>         CASE o.VEHICLE_TYPE WHEN 'bicycle' THEN 'cycling-regular' ELSE 'driving-car' END,
>         ARRAY_CONSTRUCT(ST_X(o.RESTAURANT_LOCATION), ST_Y(o.RESTAURANT_LOCATION)),
>         ARRAY_CONSTRUCT(ST_X(o.CUSTOMER_LOCATION), ST_Y(o.CUSTOMER_LOCATION))
>     )) d
> WHERE d.GEOJSON IS NOT NULL;
> ```

```sql
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ROUTES_PARSED AS
SELECT 
    COURIER_ID,
    ORDER_ID,
    ORDER_HOUR,
    ORDER_NUMBER,
    SHIFT_TYPE,
    VEHICLE_TYPE,
    RESTAURANT_ID,
    RESTAURANT_NAME,
    CUISINE_TYPE,
    RESTAURANT_LOCATION,
    RESTAURANT_ADDRESS,
    CUSTOMER_ADDRESS_ID,
    CUSTOMER_ADDRESS,
    CUSTOMER_LOCATION,
    PREP_TIME_MINS,
    ORDER_STATUS,
    TRY_TO_GEOGRAPHY(PARSE_JSON(ROUTE_RESPONSE):features[0]:geometry) AS ROUTE_GEOMETRY,
    PARSE_JSON(ROUTE_RESPONSE):features[0]:properties:summary:distance::FLOAT AS ROUTE_DISTANCE_METERS,
    PARSE_JSON(ROUTE_RESPONSE):features[0]:properties:summary:duration::FLOAT AS ROUTE_DURATION_SECS
FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ROUTES
WHERE ROUTE_RESPONSE IS NOT NULL;

ALTER TABLE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ROUTES_PARSED SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-a-fleet-intelligence-solution-for-food-delivery","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

```sql
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ROUTE_GEOMETRIES AS
WITH order_timing AS (
    SELECT 
        *,
        ROW_NUMBER() OVER (PARTITION BY COURIER_ID ORDER BY ORDER_HOUR, ORDER_NUMBER) AS COURIER_ORDER_SEQ
    FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ROUTES_PARSED
    WHERE ROUTE_GEOMETRY IS NOT NULL
),
cumulative_timing AS (
    SELECT 
        t.*,
        SUM(COALESCE(ROUTE_DURATION_SECS, 0) + (PREP_TIME_MINS * 60) + 120) OVER (
            PARTITION BY COURIER_ID 
            ORDER BY COURIER_ORDER_SEQ 
            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
        ) AS TIME_OFFSET_SECS
    FROM order_timing t
)
SELECT 
    COURIER_ID,
    ORDER_ID,
    DATEADD('second', COALESCE(TIME_OFFSET_SECS, 0), 
        DATEADD('hour', ORDER_HOUR, '{START_DATE}'::TIMESTAMP_NTZ)
    ) AS ORDER_TIME,
    DATEADD('second', COALESCE(TIME_OFFSET_SECS, 0) + (PREP_TIME_MINS * 60), 
        DATEADD('hour', ORDER_HOUR, '{START_DATE}'::TIMESTAMP_NTZ)
    ) AS PICKUP_TIME,
    DATEADD('second', COALESCE(TIME_OFFSET_SECS, 0) + (PREP_TIME_MINS * 60) + ROUTE_DURATION_SECS, 
        DATEADD('hour', ORDER_HOUR, '{START_DATE}'::TIMESTAMP_NTZ)
    ) AS DELIVERY_TIME,
    RESTAURANT_ID,
    RESTAURANT_NAME,
    CUISINE_TYPE,
    RESTAURANT_LOCATION,
    RESTAURANT_ADDRESS,
    CUSTOMER_ADDRESS_ID,
    CUSTOMER_ADDRESS,
    CUSTOMER_LOCATION,
    PREP_TIME_MINS,
    ORDER_STATUS,
    ROUTE_DURATION_SECS,
    ROUTE_DISTANCE_METERS,
    ROUTE_GEOMETRY AS GEOMETRY,
    SHIFT_TYPE,
    VEHICLE_TYPE
FROM cumulative_timing;

ALTER TABLE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ROUTE_GEOMETRIES SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-a-fleet-intelligence-solution-for-food-delivery","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

Then verify:

```sql
SELECT 
    COUNT(*) AS TOTAL_ROUTES,
    COUNT(DISTINCT COURIER_ID) AS COURIERS,
    COUNT(DISTINCT RESTAURANT_ID) AS RESTAURANTS,
    ROUND(AVG(ROUTE_DISTANCE_METERS)/1000, 2) AS AVG_DISTANCE_KM,
    ROUND(AVG(ROUTE_DURATION_SECS)/60, 1) AS AVG_DURATION_MINS,
    ROUND(SUM(ROUTE_DISTANCE_METERS)/1000, 0) AS TOTAL_DISTANCE_KM
FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ROUTE_GEOMETRIES;
```

**Output:** `DELIVERY_ROUTES`, `DELIVERY_ROUTES_PARSED`, and `DELIVERY_ROUTE_GEOMETRIES` tables.

---

### Step 9: Create Courier Locations

**Goal:** Interpolate courier positions along routes with realistic speeds.

**Action:** Execute this SQL. Creates 15 points per delivery with courier states:
- `at_restaurant` - Waiting at restaurant (point 0)
- `picking_up` - Collecting order (point 1)
- `en_route` - Variable speed based on vehicle type (points 2-12)
- `arriving` - Approaching customer (point 13)
- `delivered` - Order handed off (point 14)

```sql
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.COURIER_LOCATIONS AS
WITH 
route_info AS (
    SELECT 
        COURIER_ID,
        ORDER_ID,
        ORDER_TIME,
        PICKUP_TIME,
        DELIVERY_TIME,
        RESTAURANT_LOCATION,
        CUSTOMER_LOCATION,
        GEOMETRY AS ROUTE,
        ROUTE_DURATION_SECS,
        ROUTE_DISTANCE_METERS,
        VEHICLE_TYPE,
        SHIFT_TYPE,
        ST_NPOINTS(GEOMETRY)::NUMBER(10,0) AS NUM_POINTS,
        PREP_TIME_MINS
    FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ROUTE_GEOMETRIES
    WHERE GEOMETRY IS NOT NULL
),
point_seq AS (
    SELECT SEQ4()::NUMBER(10,0) AS POINT_INDEX FROM TABLE(GENERATOR(ROWCOUNT => 15))
),
expanded AS (
    SELECT 
        r.COURIER_ID,
        r.ORDER_ID,
        r.ORDER_TIME,
        r.PICKUP_TIME,
        r.DELIVERY_TIME,
        r.RESTAURANT_LOCATION,
        r.CUSTOMER_LOCATION,
        r.ROUTE,
        r.NUM_POINTS,
        r.ROUTE_DURATION_SECS,
        r.VEHICLE_TYPE,
        p.POINT_INDEX,
        UNIFORM(1, 100, RANDOM()) AS SPEED_ROLL,
        CASE 
            WHEN p.POINT_INDEX = 0 THEN 'at_restaurant'
            WHEN p.POINT_INDEX = 1 THEN 'picking_up'
            WHEN p.POINT_INDEX BETWEEN 2 AND 12 THEN 'en_route'
            WHEN p.POINT_INDEX = 13 THEN 'arriving'
            WHEN p.POINT_INDEX = 14 THEN 'delivered'
        END AS COURIER_STATE,
        CASE 
            WHEN p.POINT_INDEX = 0 THEN 
                r.ORDER_TIME
            WHEN p.POINT_INDEX = 1 THEN 
                r.PICKUP_TIME
            WHEN p.POINT_INDEX BETWEEN 2 AND 12 THEN
                DATEADD('second', 
                    FLOOR(r.ROUTE_DURATION_SECS * (p.POINT_INDEX - 2) / 10.0)::INT,
                    r.PICKUP_TIME
                )
            WHEN p.POINT_INDEX = 13 THEN
                DATEADD('second', -30, r.DELIVERY_TIME)
            ELSE
                r.DELIVERY_TIME
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
    ORDER_ID,
    COURIER_ID,
    ORDER_TIME,
    PICKUP_TIME,
    DELIVERY_TIME AS DROPOFF_TIME,
    RESTAURANT_LOCATION,
    CUSTOMER_LOCATION,
    ROUTE,
    ST_POINTN(ROUTE, GEOM_IDX::INT) AS POINT_GEOM,
    CURR_TIME,
    POINT_INDEX,
    COURIER_STATE,
    CASE 
        WHEN COURIER_STATE = 'at_restaurant' THEN 0
        WHEN COURIER_STATE = 'picking_up' THEN 0
        WHEN COURIER_STATE = 'arriving' THEN UNIFORM(2, 8, RANDOM())
        WHEN COURIER_STATE = 'delivered' THEN 0
        WHEN COURIER_STATE = 'en_route' THEN
            CASE VEHICLE_TYPE
                WHEN 'bicycle' THEN
                    CASE 
                        WHEN SPEED_ROLL <= 20 THEN UNIFORM(8, 15, RANDOM())
                        WHEN SPEED_ROLL <= 60 THEN UNIFORM(15, 22, RANDOM())
                        ELSE UNIFORM(20, 30, RANDOM())
                    END
                WHEN 'scooter' THEN
                    CASE 
                        WHEN SPEED_ROLL <= 15 THEN UNIFORM(10, 20, RANDOM())
                        WHEN SPEED_ROLL <= 50 THEN UNIFORM(20, 35, RANDOM())
                        ELSE UNIFORM(30, 45, RANDOM())
                    END
                ELSE
                    CASE 
                        WHEN HOUR(CURR_TIME) BETWEEN 11 AND 13 THEN
                            CASE 
                                WHEN SPEED_ROLL <= 25 THEN UNIFORM(5, 15, RANDOM())
                                WHEN SPEED_ROLL <= 60 THEN UNIFORM(15, 30, RANDOM())
                                ELSE UNIFORM(25, 45, RANDOM())
                            END
                        WHEN HOUR(CURR_TIME) BETWEEN 18 AND 20 THEN
                            CASE 
                                WHEN SPEED_ROLL <= 30 THEN UNIFORM(5, 15, RANDOM())
                                WHEN SPEED_ROLL <= 65 THEN UNIFORM(15, 30, RANDOM())
                                ELSE UNIFORM(25, 40, RANDOM())
                            END
                        ELSE
                            CASE 
                                WHEN SPEED_ROLL <= 15 THEN UNIFORM(10, 20, RANDOM())
                                WHEN SPEED_ROLL <= 45 THEN UNIFORM(20, 35, RANDOM())
                                ELSE UNIFORM(30, 55, RANDOM())
                            END
                    END
            END
    END AS KMH
FROM expanded;

ALTER TABLE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.COURIER_LOCATIONS SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-a-fleet-intelligence-solution-for-food-delivery","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

Then verify:

```sql
SELECT 
    COUNT(*) AS TOTAL_LOCATION_POINTS,
    COUNT(DISTINCT COURIER_ID) AS COURIERS,
    COUNT(DISTINCT ORDER_ID) AS ORDERS,
    MIN(CURR_TIME) AS EARLIEST_TIME,
    MAX(CURR_TIME) AS LATEST_TIME
FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.COURIER_LOCATIONS;
```

```sql
SELECT 
    COURIER_STATE,
    COUNT(*) AS COUNT,
    ROUND(AVG(KMH), 1) AS AVG_SPEED,
    MIN(KMH) AS MIN_SPEED,
    MAX(KMH) AS MAX_SPEED
FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.COURIER_LOCATIONS
GROUP BY COURIER_STATE
ORDER BY COURIER_STATE;
```

**Output:** `COURIER_LOCATIONS` table with interpolated positions and realistic speed patterns.

---

### Step 10: Data Studio Projection Views

These views read from `SYNTHETIC_DATASETS.UNIFIED`, filtered by the CONFIG table (vehicle type + region).

#### CONFIG Table

```sql
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.CONFIG (
    VEHICLE_TYPE VARCHAR NOT NULL,
    REGION       VARCHAR NOT NULL
);
MERGE INTO FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.CONFIG tgt
USING (SELECT 'ebike' AS VEHICLE_TYPE, 'SanFrancisco' AS REGION) src
ON TRUE
WHEN NOT MATCHED THEN INSERT (VEHICLE_TYPE, REGION) VALUES (src.VEHICLE_TYPE, src.REGION);
```

#### VW_COURIER_LOCATIONS

```sql
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.VW_COURIER_LOCATIONS AS
SELECT
    t.TELEMETRY_ID,
    t.VEHICLE_ID AS COURIER_ID,
    t.TRIP_ID AS ORDER_ID,
    t.TS AS CURR_TIME,
    t.LATITUDE AS LAT,
    t.LONGITUDE AS LON,
    t.SPEED_KMH AS KMH,
    t.HEADING_DEG,
    t.STATUS AS COURIER_STATE,
    t.IS_SPEEDING,
    t.BATTERY_PCT,
    t.LOCATION_ID,
    t.LOCATION_TYPE,
    t.POINT_INDEX,
    t.VEHICLE_TYPE,
    t.REGION
FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY t
WHERE t.VEHICLE_TYPE = (SELECT VEHICLE_TYPE FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.CONFIG LIMIT 1)
  AND t.REGION = (SELECT REGION FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.CONFIG LIMIT 1);
```

#### VW_DELIVERY_SUMMARY

```sql
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.VW_DELIVERY_SUMMARY AS
SELECT
    t.TRIP_ID AS ORDER_ID,
    t.VEHICLE_ID AS COURIER_ID,
    t.ORIGIN_POI_ID AS RESTAURANT_ID,
    t.DESTINATION_POI_ID AS CUSTOMER_ADDRESS_ID,
    t.ORIGIN_LAT AS RESTAURANT_LAT,
    t.ORIGIN_LON AS RESTAURANT_LON,
    t.DESTINATION_LAT AS CUSTOMER_LAT,
    t.DESTINATION_LON AS CUSTOMER_LON,
    t.ROUTE_GEOG AS GEOMETRY,
    t.DISTANCE_KM,
    t.DURATION_MINUTES,
    t.TRIP_START AS PICKUP_TIME,
    t.TRIP_END AS DELIVERY_TIME,
    t.STATUS AS ORDER_STATUS,
    t.ORS_PROFILE,
    t.VEHICLE_TYPE,
    t.REGION
FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS t
WHERE t.VEHICLE_TYPE = (SELECT VEHICLE_TYPE FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.CONFIG LIMIT 1)
  AND t.REGION = (SELECT REGION FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.CONFIG LIMIT 1);
```
