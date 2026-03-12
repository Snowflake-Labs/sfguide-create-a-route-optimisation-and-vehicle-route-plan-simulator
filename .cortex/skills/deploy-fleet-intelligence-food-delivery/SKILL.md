---
name: deploy-fleet-intelligence-food-delivery
description: "Generate realistic food delivery courier location data for the SwiftBite Fleet Intelligence solution using Overture Maps data and OpenRouteService for actual road routes. California statewide coverage with city-level filtering. Configurable location, number of couriers (default 50), days of simulation (default 1), and shift patterns. Includes deploying the Fleet Intelligence React native app to SPCS (Docker build, push, app package, install). Use when: setting up food delivery data, generating route-based simulation, deploying fleet dashboard, installing native app. Triggers: generate courier locations, create delivery data, setup food delivery fleet, deploy streamlit, deploy native app, install fleet intelligence, swiftbite dashboard, food delivery intelligence."
---

# Generate Food Delivery Courier Locations & Deploy SwiftBite California Fleet Intelligence Dashboard

Generates realistic food delivery courier location data for the SwiftBite Fleet Intelligence solution using:
- **Overture Maps Places** - Restaurant locations (food_and_beverage category) — California statewide
- **Overture Maps Addresses** - Customer delivery addresses — 14.2M+ California addresses
- **OpenRouteService Native App** - Real road routing with California statewide graph (4.1M nodes, 5.2M edges)
- **Route Interpolation** - Courier positions along actual roads
- **City-level Filtering** - San Francisco, Los Angeles, San Diego, San Jose, Sacramento, and more
- **Configurable Fleet Size** - Set number of couriers and simulation days
- **Pre-computed Travel Time Matrix** - 1.1M+ H3 hex-pair travel times for instant ETA lookups

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
| `LOCATION` | San Francisco | California city for the simulation |
| `NUM_COURIERS` | 50 | Total number of delivery couriers |
| `NUM_DAYS` | 1 | Number of days to simulate |
| `START_DATE` | 2025-01-15 | First day of simulation |
| `WAREHOUSE_SIZE` | MEDIUM | Warehouse size for data generation |

---

## Supported Locations (California Cities)

> **Data Scope:** Overture Maps data is loaded for **all of California** (COUNTRY='US', region='CA'). The city selector in the Streamlit app filters the statewide dataset to the selected city.

| Location | Center LON | Center LAT | Zoom | Notes |
|----------|------------|------------|------|-------|
| **San Francisco** | -122.44 | 37.76 | 12 | Default |
| **Los Angeles** | -118.24 | 34.05 | 11 | Largest CA city |
| **San Diego** | -117.16 | 32.72 | 12 | |
| **San Jose** | -121.89 | 37.34 | 12 | |
| **Sacramento** | -121.49 | 38.58 | 12 | State capital |
| **Fresno** | -119.77 | 36.74 | 12 | Central Valley |
| **Oakland** | -122.27 | 37.80 | 12 | East Bay |
| **Long Beach** | -118.19 | 33.77 | 12 | LA metro |
| **Santa Barbara** | -119.70 | 34.42 | 13 | |
| **Bakersfield** | -119.02 | 35.37 | 12 | Central Valley |

---

## City Selection in the Streamlit App

The Streamlit app includes a **sidebar city selector** on every page. Users select a California city from a dropdown, and the app dynamically re-centers maps, filters data, and updates headers.

All California cities are defined in `city_config.py` with `CALIFORNIA_CITIES` list and `get_california_cities()` helper. Each page imports this and creates the selector:

```python
from city_config import get_city, get_company, get_california_cities

with st.sidebar:
    selected_city = st.selectbox("City", get_california_cities(), index=0)

CITY = get_city(selected_city)
```

### Adding a New California City

Add to both `CITIES` dict and `CALIFORNIA_CITIES` list in `city_config.py`:

```python
"Riverside": {
    "name": "Riverside",
    "latitude": 33.95,
    "longitude": -117.40,
    "zoom": 12,
},
```

Then add `"Riverside"` to the `CALIFORNIA_CITIES` list.

---

## Recommended Warehouse Sizes

| Couriers | Days | Estimated Rows | Warehouse | Est. Time |
|----------|------|----------------|-----------|-----------|
| 20 | 1 | ~3,000 | SMALL | 2-3 min |
| 50 | 1 | ~8,000 | MEDIUM | 4-6 min |
| 50 | 7 | ~55,000 | LARGE | 15-20 min |
| 100 | 1 | ~16,000 | LARGE | 10-15 min |
| 100 | 7 | ~110,000 | XLARGE | 30-45 min |

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
> 2. **Always use fully qualified object names.** Use `OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.<object>` instead of relying on `USE DATABASE` / `USE SCHEMA`. Session context from `USE` statements does not persist across `snowflake_sql_execute` calls.
>
> 3. **Never use `SET` session variables.** Variables set with `SET VAR = 'value'` do not persist across calls. Instead, substitute literal values directly into the SQL before execution.
>
> 4. **Verify row counts after each CTAS.** Run `SELECT COUNT(*) FROM <table>` after every `CREATE TABLE ... AS SELECT` to catch silent failures early.

### Step 1: Set Query Tag for Tracking

**Goal:** Set session query tag for attribution tracking.

```sql
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is","name":"oss-deploy-a-fleet-intelligence-solution-for-food-delivery","version":{"major":1, "minor":0},"attributes":{"is_quickstart":1, "source":"sql"}}';
```

**Output:** Query tag set for session tracking

---

### Step 2: Detect ORS Configuration, Choose Location, and Verify Services

**Goal:** Detect the current ORS configuration, present it to the user, let them choose a location (proposing the currently configured region first), then verify services are running.

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

**Sub-step 2b: Ask User to Choose Location**

Based on the detected `<REGION_NAME>`, identify the matching city from the Supported Locations table (e.g., "SanFrancisco" → "San Francisco", "great-britain-latest" → "London").

**Ask the user which location they want to use for the food delivery simulation.** Present the currently configured ORS region as the **first/recommended choice**, since it requires no ORS reconfiguration. Include a few other pre-configured locations as alternatives, noting they would require an ORS map change.

Example prompt structure:
- **`<MATCHING_CITY>` (recommended)** — Matches your current ORS configuration (`<REGION_NAME>`). No map change needed.
- **Other pre-configured cities** — Requires changing the ORS map before proceeding.
- **Custom location** — Any city worldwide (requires ORS map to cover that area).

Store the user's selection as `{LOCATION}`.

**Sub-step 2c: Check Region Match**

Compare the detected `<REGION_NAME>` with the user's selected `{LOCATION}`:

- **If the region matches:** Proceed to Sub-step 2d.
- **If the region does NOT match:** Warn the user that ORS is configured for a different region. The user must reconfigure ORS for their target location before continuing. Read and follow the instructions in `.cortex/skills/customize-main/SKILL.md` to change the map, then return here to continue.

**Sub-step 2d: Check Service Status and Resume if Needed**

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

**Sub-step 2e: Test ORS Routing**

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

**Output:** ORS configuration displayed, location chosen, region match confirmed, all services running, routing verified

---

### Step 3: Configure Database, Warehouse, and Schema

**Goal:** Create database, warehouse, schema, and stage.

```sql
CREATE DATABASE IF NOT EXISTS OPENROUTESERVICE_SETUP
    COMMENT = '{"origin":"sf_sit-is", "name":"oss-deploy-a-fleet-intelligence-solution-for-food-delivery", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';
```

```sql
CREATE WAREHOUSE IF NOT EXISTS ROUTING_ANALYTICS
    WAREHOUSE_SIZE = 'XSMALL'
    AUTO_SUSPEND = 60
    AUTO_RESUME = TRUE
    COMMENT = '{"origin":"sf_sit-is", "name":"oss-deploy-a-fleet-intelligence-solution-for-food-delivery", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';
```

```sql
CREATE SCHEMA IF NOT EXISTS OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY
    COMMENT = '{"origin":"sf_sit-is", "name":"oss-deploy-a-fleet-intelligence-solution-for-food-delivery", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';
```

```sql
CREATE STAGE IF NOT EXISTS OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.STREAMLIT_STAGE
    DIRECTORY = (ENABLE = TRUE);
```

**Output:** Database `OPENROUTESERVICE_SETUP`, warehouse `ROUTING_ANALYTICS`, schema `FLEET_INTELLIGENCE_FOOD_DELIVERY`, and stage `STREAMLIT_STAGE` created.

---

### Step 4: Create Restaurant Locations (California-wide)

**Goal:** Load restaurant locations from Overture Maps for all of California using the state-level filter.

> **Filter Strategy:** Instead of a bounding box (`ST_X BETWEEN...`), we filter by `COUNTRY='US'` and `region='CA'` in the Overture Maps address metadata. This captures the entire state without missing coastal/border areas and leverages Overture's partition pruning for fast queries.

```sql
CREATE OR REPLACE TABLE OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.RESTAURANTS AS
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
```

Then verify:

```sql
SELECT 
    CITY,
    COUNT(*) AS RESTAURANT_COUNT
FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.RESTAURANTS
GROUP BY CITY
ORDER BY RESTAURANT_COUNT DESC
LIMIT 15;
```

**Enable Search Optimization** for fast city-level lookups:

```sql
ALTER TABLE OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.RESTAURANTS
    ADD SEARCH OPTIMIZATION ON EQUALITY(CITY);
```

**Output:** `RESTAURANTS` table with 120K+ food establishments across California, with CITY column for filtering.

---

### Step 5: Create Customer Delivery Addresses (California-wide)

**Goal:** Load customer addresses from Overture Maps for all of California.

```sql
CREATE OR REPLACE TABLE OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.CUSTOMER_ADDRESSES AS
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
```

Then verify:

```sql
SELECT 
    CITY,
    COUNT(*) AS ADDRESS_COUNT
FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.CUSTOMER_ADDRESSES
GROUP BY CITY
ORDER BY ADDRESS_COUNT DESC
LIMIT 15;
```

**Enable Search Optimization** for fast city-level lookups:

```sql
ALTER TABLE OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.CUSTOMER_ADDRESSES
    ADD SEARCH OPTIMIZATION ON EQUALITY(CITY);
```

**Output:** `CUSTOMER_ADDRESSES` table with 14.2M+ delivery addresses across California.

---

### Step 6: Create Couriers with Shift Patterns

**Goal:** Create couriers distributed across peak meal times.

**Action:** Substitute `{BREAKFAST_COUNT}`, `{LUNCH_COUNT}`, `{AFTERNOON_COUNT}`, `{DINNER_COUNT}`, `{LATE_NIGHT_COUNT}`. For the default 50 couriers: 5, 15, 8, 17, 5.

```sql
CREATE OR REPLACE TABLE OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.COURIERS AS
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
    FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.CUSTOMER_ADDRESSES
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
```

Then verify:

```sql
SELECT 
    SHIFT_TYPE,
    VEHICLE_TYPE,
    COUNT(*) AS NUM_COURIERS
FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.COURIERS
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
CREATE OR REPLACE TABLE OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.RESTAURANTS_NUMBERED AS
SELECT 
    RESTAURANT_ID,
    LOCATION,
    NAME,
    CUISINE_TYPE,
    ADDRESS,
    ROW_NUMBER() OVER (ORDER BY HASH(RESTAURANT_ID)) AS rn
FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.RESTAURANTS
WHERE NAME IS NOT NULL AND LENGTH(NAME) > 2;
```

```sql
CREATE OR REPLACE TABLE OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.ADDRESSES_NUMBERED AS
SELECT 
    ADDRESS_ID,
    LOCATION,
    FULL_ADDRESS,
    ROW_NUMBER() OVER (ORDER BY HASH(ADDRESS_ID)) AS rn
FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.CUSTOMER_ADDRESSES
WHERE FULL_ADDRESS IS NOT NULL AND LENGTH(FULL_ADDRESS) > 3;
```

Then generate the orders:

```sql
CREATE OR REPLACE TABLE OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ORDERS AS
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
    FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.COURIERS c
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
    SELECT COUNT(*) AS cnt FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.RESTAURANTS_NUMBERED
),
addr_count AS (
    SELECT COUNT(*) AS cnt FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.ADDRESSES_NUMBERED
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
```

```sql
CREATE OR REPLACE TABLE OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.ORDERS_WITH_LOCATIONS AS
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
FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ORDERS o
JOIN OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.RESTAURANTS_NUMBERED r ON o.RESTAURANT_IDX = r.rn
JOIN OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.ADDRESSES_NUMBERED a ON o.CUSTOMER_IDX = a.rn;
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
    FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ORDERS
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
CREATE OR REPLACE TABLE OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ROUTES AS
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
FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.ORDERS_WITH_LOCATIONS;
```

```sql
CREATE OR REPLACE TABLE OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ROUTES_PARSED AS
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
FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ROUTES
WHERE ROUTE_RESPONSE IS NOT NULL;
```

```sql
CREATE OR REPLACE TABLE OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ROUTE_GEOMETRIES AS
WITH order_timing AS (
    SELECT 
        *,
        ROW_NUMBER() OVER (PARTITION BY COURIER_ID ORDER BY ORDER_HOUR, ORDER_NUMBER) AS COURIER_ORDER_SEQ
    FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ROUTES_PARSED
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
FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ROUTE_GEOMETRIES;
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
CREATE OR REPLACE TABLE OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.COURIER_LOCATIONS AS
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
    FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ROUTE_GEOMETRIES
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
```

Then verify:

```sql
SELECT 
    COUNT(*) AS TOTAL_LOCATION_POINTS,
    COUNT(DISTINCT COURIER_ID) AS COURIERS,
    COUNT(DISTINCT ORDER_ID) AS ORDERS,
    MIN(CURR_TIME) AS EARLIEST_TIME,
    MAX(CURR_TIME) AS LATEST_TIME
FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.COURIER_LOCATIONS;
```

```sql
SELECT 
    COURIER_STATE,
    COUNT(*) AS COUNT,
    ROUND(AVG(KMH), 1) AS AVG_SPEED,
    MIN(KMH) AS MIN_SPEED,
    MAX(KMH) AS MAX_SPEED
FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.COURIER_LOCATIONS
GROUP BY COURIER_STATE
ORDER BY COURIER_STATE;
```

**Output:** `COURIER_LOCATIONS` table with interpolated positions and realistic speed patterns.

---

### Step 10: Create Analytics Views

**Goal:** Create views for Streamlit consumption.

**Action:** Execute each view as a separate statement.

```sql
CREATE OR REPLACE VIEW OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.COURIER_LOCATIONS_V AS
SELECT 
    ORDER_ID,
    COURIER_ID,
    ORDER_TIME,
    PICKUP_TIME,
    DROPOFF_TIME,
    RESTAURANT_LOCATION,
    CUSTOMER_LOCATION,
    ROUTE,
    POINT_GEOM,
    ST_X(POINT_GEOM) AS LON,
    ST_Y(POINT_GEOM) AS LAT,
    CURR_TIME,
    CURR_TIME AS POINT_TIME,
    POINT_INDEX,
    COURIER_STATE,
    KMH
FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.COURIER_LOCATIONS;
```

```sql
CREATE OR REPLACE VIEW OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.ORDERS_ASSIGNED_TO_COURIERS AS
SELECT 
    COURIER_ID,
    ORDER_ID,
    RESTAURANT_ID,
    GEOMETRY,
    RESTAURANT_LOCATION,
    CUSTOMER_LOCATION,
    RESTAURANT_NAME,
    RESTAURANT_ADDRESS,
    CUSTOMER_ADDRESS,
    ORDER_TIME,
    PICKUP_TIME,
    DELIVERY_TIME,
    ORDER_STATUS
FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ROUTE_GEOMETRIES;
```

```sql
CREATE OR REPLACE VIEW OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_NAMES AS
SELECT 
    ORDER_ID,
    RESTAURANT_NAME || ' -> ' || CUSTOMER_ADDRESS AS DELIVERY_NAME
FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ROUTE_GEOMETRIES;
```

```sql
CREATE OR REPLACE VIEW OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ROUTE_PLAN AS
SELECT 
    rg.ORDER_ID,
    rg.COURIER_ID,
    rg.RESTAURANT_NAME,
    rg.RESTAURANT_ADDRESS,
    rg.CUSTOMER_ADDRESS,
    rg.CUSTOMER_ADDRESS AS CUSTOMER_STREET,
    rg.ORDER_TIME,
    rg.PICKUP_TIME,
    rg.DELIVERY_TIME,
    rg.RESTAURANT_LOCATION,
    rg.CUSTOMER_LOCATION,
    rg.GEOMETRY,
    rg.ROUTE_DISTANCE_METERS AS DISTANCE_METERS,
    rg.SHIFT_TYPE,
    rg.VEHICLE_TYPE,
    rg.ORDER_STATUS
FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ROUTE_GEOMETRIES rg;
```

```sql
CREATE OR REPLACE VIEW OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_SUMMARY AS
WITH delivery_stats AS (
    SELECT 
        ORDER_ID,
        AVG(KMH) AS AVERAGE_KMH,
        MAX(KMH) AS MAX_KMH
    FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.COURIER_LOCATIONS
    GROUP BY ORDER_ID
)
SELECT 
    rg.COURIER_ID,
    rg.ORDER_ID,
    rg.ORDER_TIME,
    rg.PICKUP_TIME,
    rg.DELIVERY_TIME,
    rg.RESTAURANT_ID,
    rg.RESTAURANT_NAME,
    rg.CUISINE_TYPE,
    rg.RESTAURANT_LOCATION,
    rg.RESTAURANT_ADDRESS,
    rg.CUSTOMER_ADDRESS_ID,
    rg.CUSTOMER_ADDRESS,
    rg.CUSTOMER_LOCATION,
    rg.PREP_TIME_MINS,
    rg.ORDER_STATUS,
    rg.ROUTE_DURATION_SECS,
    rg.ROUTE_DISTANCE_METERS,
    rg.GEOMETRY,
    rg.SHIFT_TYPE,
    rg.VEHICLE_TYPE,
    ds.AVERAGE_KMH,
    ds.MAX_KMH
FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ROUTE_GEOMETRIES rg
LEFT JOIN delivery_stats ds ON rg.ORDER_ID = ds.ORDER_ID;
```

Then verify:

```sql
SELECT 'COURIER_LOCATIONS_V' AS VIEW_NAME, COUNT(*) AS ROW_COUNT FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.COURIER_LOCATIONS_V
UNION ALL SELECT 'ORDERS_ASSIGNED_TO_COURIERS', COUNT(*) FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.ORDERS_ASSIGNED_TO_COURIERS
UNION ALL SELECT 'DELIVERY_NAMES', COUNT(*) FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_NAMES
UNION ALL SELECT 'DELIVERY_ROUTE_PLAN', COUNT(*) FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ROUTE_PLAN
UNION ALL SELECT 'DELIVERY_SUMMARY', COUNT(*) FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_SUMMARY;
```

**Output:** 5 analytics views created.

---

### Step 11: Deploy Streamlit App

**Goal:** Upload Streamlit files to stage and deploy the application.

**Action:** Upload the Streamlit files to the Snowflake stage, then create the Streamlit app.

**Upload files using PUT commands:**

```sql
PUT 'file://oss-deploy-a-fleet-intelligence-solution-for-food-delivery/streamlit/Delivery_Control_Center.py' @OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.STREAMLIT_STAGE/swiftbite/ AUTO_COMPRESS=FALSE OVERWRITE=TRUE;
PUT 'file://oss-deploy-a-fleet-intelligence-solution-for-food-delivery/streamlit/extra.css' @OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.STREAMLIT_STAGE/swiftbite/ AUTO_COMPRESS=FALSE OVERWRITE=TRUE;
PUT 'file://oss-deploy-a-fleet-intelligence-solution-for-food-delivery/streamlit/logo.svg' @OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.STREAMLIT_STAGE/swiftbite/ AUTO_COMPRESS=FALSE OVERWRITE=TRUE;
PUT 'file://oss-deploy-a-fleet-intelligence-solution-for-food-delivery/streamlit/environment.yml' @OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.STREAMLIT_STAGE/swiftbite/ AUTO_COMPRESS=FALSE OVERWRITE=TRUE;
PUT 'file://oss-deploy-a-fleet-intelligence-solution-for-food-delivery/streamlit/city_config.py' @OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.STREAMLIT_STAGE/swiftbite/ AUTO_COMPRESS=FALSE OVERWRITE=TRUE;
PUT 'file://oss-deploy-a-fleet-intelligence-solution-for-food-delivery/streamlit/pages/1_Courier_Routes.py' @OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.STREAMLIT_STAGE/swiftbite/pages/ AUTO_COMPRESS=FALSE OVERWRITE=TRUE;
PUT 'file://oss-deploy-a-fleet-intelligence-solution-for-food-delivery/streamlit/pages/2_Heat_Map.py' @OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.STREAMLIT_STAGE/swiftbite/pages/ AUTO_COMPRESS=FALSE OVERWRITE=TRUE;
PUT 'file://oss-deploy-a-fleet-intelligence-solution-for-food-delivery/streamlit/pages/3_Travel_Time_Matrix.py' @OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.STREAMLIT_STAGE/swiftbite/pages/ AUTO_COMPRESS=FALSE OVERWRITE=TRUE;
PUT 'file://oss-deploy-a-fleet-intelligence-solution-for-food-delivery/streamlit/pages/3_Travel_Time_Analysis.py' @OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.STREAMLIT_STAGE/swiftbite/pages/ AUTO_COMPRESS=FALSE OVERWRITE=TRUE;
```

**Verify files uploaded:**

```sql
LIST @OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.STREAMLIT_STAGE/swiftbite/;
```

**Deploy the Streamlit app:**

```sql
CREATE STREAMLIT OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.SWIFTBITE_DELIVERY_DASHBOARD
  FROM '@OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.STREAMLIT_STAGE/swiftbite'
  MAIN_FILE = 'Delivery_Control_Center.py';

ALTER STREAMLIT OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.SWIFTBITE_DELIVERY_DASHBOARD
  SET QUERY_WAREHOUSE = 'COMPUTE_WH';
```

**Set the live version so other users can access the app without edit mode:**

```sql
ALTER STREAMLIT OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.SWIFTBITE_DELIVERY_DASHBOARD ADD LIVE VERSION FROM LAST;
```

**Verify deployment:**

```sql
SHOW STREAMLITS IN SCHEMA OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY;
```

**Get app URL:**

```sql
SELECT CONCAT('https://app.snowflake.com/', CURRENT_ORGANIZATION_NAME(), '/', CURRENT_ACCOUNT_NAME(), '/#/streamlit-apps/OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.SWIFTBITE_DELIVERY_DASHBOARD') AS STREAMLIT_URL;
```

**Output:** Streamlit app deployed. Provide the user with the generated URL to open the app directly in Snowsight.

---

## Task: Build California Statewide Routing Graph

This task configures ORS to use California statewide map data instead of the default San Francisco region. Required for DoorDash-style tiered travel time matrices covering all of California.

### Prerequisites
- OpenRouteService Native App installed from Snowflake Marketplace
- ACCOUNTADMIN or equivalent privileges
- ~2GB local disk space for OSM download

### Step-by-Step Instructions

#### Step 1: Download California OSM Data (~5 min)

Download the California OpenStreetMap data from Geofabrik:

```bash
mkdir -p /tmp/California
curl -L -o /tmp/California/California.osm.pbf "https://download.geofabrik.de/north-america/us/california-latest.osm.pbf"
```

Verify the download (~1.3 GB):
```bash
ls -la /tmp/California/California.osm.pbf
```

#### Step 2: Create California Config File

Create a minimal ORS config optimized for delivery routing at `/tmp/California/ors-config.yml`:

```yaml
ors:
  engine:
    source_file: "/home/ors/files/California.osm.pbf"
    graphs_root_path: /home/ors/graphs
    graph_management:
      enabled: false
    profiles:
      car:
        enabled: true
        profile: driving-car
        encoder_options:
          maximum_speed: 120
        preparation:
          methods:
            ch:
              enabled: true
              threads: 2
              weightings: fastest
            lm:
              enabled: false
            core:
              enabled: false
```

#### Step 3: Copy California File with Correct Name (~3 min)

The ORS service reads from `/home/ors/files/SanFrancisco.osm.pbf` by default. Copy California data with that name:

```bash
cp /tmp/California/California.osm.pbf /tmp/SanFrancisco.osm.pbf
```

#### Step 4: Upload to ORS App Stage

**CRITICAL:** Upload to `@OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SPCS_STAGE` (NOT `@OPENROUTESERVICE_SETUP.PUBLIC.ORS_SPCS_STAGE`).

```sql
-- Remove existing SF data
REMOVE @OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SPCS_STAGE/SanFrancisco/SanFrancisco.osm.pbf;

-- Upload California data as SanFrancisco.osm.pbf
PUT 'file:///tmp/SanFrancisco.osm.pbf' @OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SPCS_STAGE/SanFrancisco/ AUTO_COMPRESS=FALSE OVERWRITE=TRUE;
```

Verify upload (should show ~1.3 GB):
```sql
LIST @OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SPCS_STAGE;
```

#### Step 5: Clear Cached Graphs

Remove existing routing graphs so they rebuild from California data:

```sql
REMOVE @OPENROUTESERVICE_NATIVE_APP.CORE.ORS_GRAPHS_SPCS_STAGE PATTERN='.*';
```

#### Step 6: Restart ORS Service

```sql
ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SERVICE SUSPEND;
-- Wait 5 seconds
ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SERVICE RESUME;
```

#### Step 7: Monitor Graph Build (~20-30 min)

Check build progress:
```sql
SELECT SYSTEM$GET_SERVICE_LOGS('OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SERVICE', 0, 'ors', 50);
```

**Look for these milestones:**
1. `start creating graph from /home/ors/files/SanFrancisco.osm.pbf`
2. `nodes: 4 149 351, edges: 5 248 588` - Confirms California data loaded
3. `bounds:-124.40,-114.13,32.50,42.19` - California bounding box
4. `Finished CH preparation` - CH shortcuts built
5. `Total time: XXXs` - Graph ready

#### Step 8: Verify California Routing Works

Test a route spanning California:
```sql
-- LA to SF route test
SELECT OPENROUTESERVICE_NATIVE_APP.CORE.DIRECTIONS(
    'driving-car',
    [-118.25, 34.05],  -- Los Angeles
    [-122.42, 37.77]   -- San Francisco
);
```

If successful, returns route geometry covering ~380 miles.

---

## California Statewide Routing Graph Build Times

When configuring ORS for California statewide routing (required for DoorDash-style tiered travel time matrices), the following time estimates apply:

| Phase | Duration | Notes |
|-------|----------|-------|
| **OSM Data Download** | 5-10 min | California.osm.pbf from Geofabrik (~1.3 GB) |
| **Upload to Stage** | 3-5 min | To `@OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SPCS_STAGE/SanFrancisco/` |
| **Graph Build - Parsing** | 2-3 min | 4.1M nodes, 5.2M edges |
| **Graph Build - CH Preparation** | 15-25 min | Contraction Hierarchies for fast routing |
| **Graph Build - Core/LM Preparation** | 10-15 min | Additional optimization structures |
| **Service Restart & Ready** | 2-3 min | Service becomes available |
| **TOTAL** | **45-75 minutes** | End-to-end from start to routing ready |

### Key Stage Paths
- **Data Stage**: `@OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SPCS_STAGE` (NOT `@OPENROUTESERVICE_SETUP.PUBLIC.ORS_SPCS_STAGE`)
- **Graphs Stage**: `@OPENROUTESERVICE_NATIVE_APP.CORE.ORS_GRAPHS_SPCS_STAGE`
- **Config Location**: `@OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SPCS_STAGE/SanFrancisco/ors-config.yml`

### California Graph Statistics
- **Nodes**: ~4,150,000
- **Edges**: ~5,250,000
- **Bounding Box**: (-124.40, -114.13, 32.50, 42.19)
- **Memory Usage**: ~9-10 GB during build

### Tiered Matrix Build Times (After Graph Ready)
| Resolution | Hexagons | Cutoff | Sparse Pairs | Est. Time |
|------------|----------|--------|--------------|-----------|
| 9 (Last Mile) | 480,621 | 2 mi | ~12M | 3-4 hrs |
| 8 (Delivery Zone) | 144,636 | 10 mi | ~45M | 5-6 hrs |
| 7 (Long Range) | 38,239 | 50 mi | ~45M | 3-4 hrs |
| **TOTAL** | - | - | ~102M pairs | **11-14 hrs** |

---

## Matrix Scaling Performance

### San Francisco Proof of Concept (Measured)

The SF travel time matrix demonstrates the speed of the ORS MATRIX function in Snowflake:

| Metric | Value |
|--------|-------|
| **Hexagons** | 1,065 (H3 Resolution 9) |
| **Total Pairs** | 1,134,225 (1,065 × 1,065) |
| **ORS MATRIX Computation** | **36 seconds** (single SQL call, all 1,065 origins processed) |
| **INSERT into Snowflake** | 2.4 seconds |
| **End-to-end pipeline** | ~3 minutes (hex creation → matrix INSERT) |
| **Table** | `OPENROUTESERVICE_SETUP.ROUTING.SF_TRAVEL_TIME_MATRIX` |

The ORS MATRIX function accepts an array of origin/destination coordinates and returns a full NxN distance/duration matrix in a single call. For 1,065 hexagons, this means computing 1.1M+ travel time pairs in just 36 seconds.

### California Scaling Projection

Scaling from San Francisco to all of California:

| Scope | Hexagons (Res 9) | All-Pairs | Sparse Pairs (distance cutoff) | Projected Time |
|-------|-------------------|-----------|--------------------------------|----------------|
| **San Francisco** | 1,065 | 1.1M | 1.1M (no cutoff) | 3 min (measured) |
| **Single CA city** | ~5,000-20,000 | 25M-400M | ~500K-2M (2mi cutoff) | 10-30 min |
| **All CA cities** | ~480,000 | 230B | ~12M (2mi cutoff) | 3-4 hrs |
| **Full CA (all res)** | 630,000+ | - | **~102M** | **11-14 hrs** |

> **Key Insight:** The 1.8 billion+ theoretical all-pairs matrix is not needed. By using distance-based cutoffs (last-mile: 2mi, delivery zone: 10mi, long-range: 50mi) the sparse matrix reduces to ~102M practical pairs — a 95% reduction that completes in under 14 hours.

### Stored Procedure Approach (Alternative)

For automated/scheduled builds, the `BUILD_TRAVEL_TIME_MATRIX_RES7` stored procedure completed in **41 minutes** for the SF area. This approach processes origins in batches with progress tracking and is suitable for Snowflake Task scheduling.

---

## Search Optimization for Large Tables

Enable Snowflake Search Optimization on large tables for fast point lookups. This is critical for the H3 hexagon tables and travel time matrices.

### H3 Hexagon Tables

```sql
ALTER TABLE OPENROUTESERVICE_SETUP.PUBLIC.CA_H3_RES7
    ADD SEARCH OPTIMIZATION ON EQUALITY(H3_INDEX);

ALTER TABLE OPENROUTESERVICE_SETUP.PUBLIC.CA_H3_RES8
    ADD SEARCH OPTIMIZATION ON EQUALITY(H3_INDEX);

ALTER TABLE OPENROUTESERVICE_SETUP.PUBLIC.CA_H3_RES9
    ADD SEARCH OPTIMIZATION ON EQUALITY(H3_INDEX);
```

### Travel Time Matrix Tables

```sql
ALTER TABLE OPENROUTESERVICE_SETUP.PUBLIC.CA_TRAVEL_TIME_RES7
    ADD SEARCH OPTIMIZATION ON EQUALITY(ORIGIN_H3, DEST_H3);

ALTER TABLE OPENROUTESERVICE_SETUP.PUBLIC.CA_TRAVEL_TIME_RES8
    ADD SEARCH OPTIMIZATION ON EQUALITY(ORIGIN_H3, DEST_H3);

ALTER TABLE OPENROUTESERVICE_SETUP.PUBLIC.CA_TRAVEL_TIME_RES9
    ADD SEARCH OPTIMIZATION ON EQUALITY(ORIGIN_H3, DEST_H3);
```

### SF Travel Time Matrix

```sql
ALTER TABLE OPENROUTESERVICE_SETUP.ROUTING.SF_TRAVEL_TIME_MATRIX
    ADD SEARCH OPTIMIZATION ON EQUALITY(ORIGIN_HEX_ID, DESTINATION_HEX_ID);
```

### Overture Maps-derived Tables

```sql
ALTER TABLE OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.RESTAURANTS
    ADD SEARCH OPTIMIZATION ON EQUALITY(CITY);

ALTER TABLE OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.CUSTOMER_ADDRESSES
    ADD SEARCH OPTIMIZATION ON EQUALITY(CITY);
```

> **Note:** Search Optimization is a serverless feature billed separately. It dramatically improves lookup performance on tables with millions of rows by maintaining an access path index.

---

## Using Pre-computed Travel Time Matrix for Realistic ETAs

Instead of calling ORS DIRECTIONS for every delivery (slow), use the pre-computed tiered travel time matrix for instant ETA lookups. This enables DoorDash-style delivery time predictions.

### Prerequisites

Ensure the scalable travel time matrix pipeline has completed (see `.cortex/skills/travel-time-matrix/SKILL.md`):

**Pipeline stages:** BUILD_HEXAGONS → BUILD_WORK_QUEUE → BUILD_TRAVEL_TIME_RANGE (workers) → FLATTEN_MATRIX_RAW

**Tables per resolution (7, 8, 9):**
- `CA_H3_RES{N}` — H3 hexagon cells with coordinates
- `CA_WORK_QUEUE_RES{N}` — Pre-computed origin + destinations (1 row = 1 API call)
- `CA_MATRIX_RAW_RES{N}` — Raw VARIANT payloads from MATRIX_TABULAR
- `CA_TRAVEL_TIME_RES{N}` — Final flattened travel time pairs

**Convenience wrappers** (call the full pipeline for a resolution):
- `BUILD_TRAVEL_TIME_MATRIX_RES7()` / `BUILD_TRAVEL_TIME_MATRIX_RES8()` / `BUILD_TRAVEL_TIME_MATRIX_RES9()`

**Progress monitoring:**
```sql
CALL FLEET_INTELLIGENCE_APP.DATA.MATRIX_PROGRESS();
```
Returns JSON per resolution:
```json
{
  "RES7": {"stage": "COMPLETE", "hexagons": 38, "work_queue": 38, "raw_ingested": 38, "flattened": 1406, "pct": 100},
  "RES8": {"stage": "BUILDING", "hexagons": 191, "work_queue": 191, "raw_ingested": 100, "flattened": 0, "pct": 52},
  "RES9": {"stage": "NOT_STARTED", "hexagons": 0, "work_queue": 0, "raw_ingested": 0, "flattened": 0, "pct": 0}
}
```
Pipeline stages: NOT_STARTED → HEXAGONS_READY → QUEUED → BUILDING → FLATTENING → COMPLETE
- `CA_H3_RES10_PAIRS` - Ultra-last-mile (500m cutoff)

### Step 1: Create Travel Time Results Tables

After the pairs tables are built, populate with actual travel times from ORS MATRIX:

```sql
-- Create travel time result tables (run after pairs are built)
CREATE OR REPLACE TABLE OPENROUTESERVICE_SETUP.PUBLIC.CA_TRAVEL_TIME_RES9 (
    origin_h3 VARCHAR,
    dest_h3 VARCHAR,
    travel_time_seconds FLOAT,
    travel_distance_meters FLOAT,
    calculated_at TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP()
);

CREATE OR REPLACE TABLE OPENROUTESERVICE_SETUP.PUBLIC.CA_TRAVEL_TIME_RES8 (
    origin_h3 VARCHAR,
    dest_h3 VARCHAR,
    travel_time_seconds FLOAT,
    travel_distance_meters FLOAT,
    calculated_at TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP()
);

CREATE OR REPLACE TABLE OPENROUTESERVICE_SETUP.PUBLIC.CA_TRAVEL_TIME_RES7 (
    origin_h3 VARCHAR,
    dest_h3 VARCHAR,
    travel_time_seconds FLOAT,
    travel_distance_meters FLOAT,
    calculated_at TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP()
);
```

### Step 2: Add Travel Time Lookup to Orders

Create a view that joins delivery orders with pre-computed travel times:

```sql
CREATE OR REPLACE VIEW OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.ORDERS_WITH_TRAVEL_TIMES AS
WITH order_h3 AS (
    SELECT 
        o.*,
        -- Convert restaurant/customer locations to H3 at different resolutions
        H3_POINT_TO_CELL_STRING(o.RESTAURANT_LOCATION, 9) AS restaurant_h3_res9,
        H3_POINT_TO_CELL_STRING(o.CUSTOMER_LOCATION, 9) AS customer_h3_res9,
        H3_POINT_TO_CELL_STRING(o.RESTAURANT_LOCATION, 8) AS restaurant_h3_res8,
        H3_POINT_TO_CELL_STRING(o.CUSTOMER_LOCATION, 8) AS customer_h3_res8,
        H3_POINT_TO_CELL_STRING(o.RESTAURANT_LOCATION, 7) AS restaurant_h3_res7,
        H3_POINT_TO_CELL_STRING(o.CUSTOMER_LOCATION, 7) AS customer_h3_res7,
        -- Calculate straight-line distance for tier selection
        ST_DISTANCE(o.RESTAURANT_LOCATION, o.CUSTOMER_LOCATION) / 1000 AS straight_line_km
    FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.ORDERS_WITH_LOCATIONS o
)
SELECT 
    oh.*,
    -- Select appropriate resolution based on distance
    CASE 
        WHEN oh.straight_line_km <= 3.2 THEN 'res9'      -- 2mi = 3.2km
        WHEN oh.straight_line_km <= 16 THEN 'res8'       -- 10mi = 16km
        ELSE 'res7'                                       -- 50mi = 80km
    END AS travel_time_tier,
    -- Join with pre-computed travel times (try res9 first, fall back to res8, then res7)
    COALESCE(
        tt9.travel_time_seconds,
        tt8.travel_time_seconds,
        tt7.travel_time_seconds
    ) AS est_travel_time_seconds,
    COALESCE(
        tt9.travel_distance_meters,
        tt8.travel_distance_meters,
        tt7.travel_distance_meters
    ) AS est_travel_distance_meters
FROM order_h3 oh
LEFT JOIN OPENROUTESERVICE_SETUP.PUBLIC.CA_TRAVEL_TIME_RES9 tt9 
    ON (oh.restaurant_h3_res9 = tt9.origin_h3 AND oh.customer_h3_res9 = tt9.dest_h3)
    OR (oh.restaurant_h3_res9 = tt9.dest_h3 AND oh.customer_h3_res9 = tt9.origin_h3)
LEFT JOIN OPENROUTESERVICE_SETUP.PUBLIC.CA_TRAVEL_TIME_RES8 tt8 
    ON (oh.restaurant_h3_res8 = tt8.origin_h3 AND oh.customer_h3_res8 = tt8.dest_h3)
    OR (oh.restaurant_h3_res8 = tt8.dest_h3 AND oh.customer_h3_res8 = tt8.origin_h3)
LEFT JOIN OPENROUTESERVICE_SETUP.PUBLIC.CA_TRAVEL_TIME_RES7 tt7 
    ON (oh.restaurant_h3_res7 = tt7.origin_h3 AND oh.customer_h3_res7 = tt7.dest_h3)
    OR (oh.restaurant_h3_res7 = tt7.dest_h3 AND oh.customer_h3_res7 = tt7.origin_h3);
```

### Step 3: Create ETA Prediction Function

```sql
CREATE OR REPLACE FUNCTION OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.PREDICT_DELIVERY_ETA(
    restaurant_lon FLOAT,
    restaurant_lat FLOAT,
    customer_lon FLOAT,
    customer_lat FLOAT,
    prep_time_mins INT DEFAULT 15
)
RETURNS OBJECT
LANGUAGE SQL
AS
$$
    WITH locations AS (
        SELECT 
            ST_MAKEPOINT(restaurant_lon, restaurant_lat) AS restaurant_loc,
            ST_MAKEPOINT(customer_lon, customer_lat) AS customer_loc
    ),
    h3_cells AS (
        SELECT 
            H3_POINT_TO_CELL_STRING(restaurant_loc, 9) AS r_h3_9,
            H3_POINT_TO_CELL_STRING(customer_loc, 9) AS c_h3_9,
            H3_POINT_TO_CELL_STRING(restaurant_loc, 8) AS r_h3_8,
            H3_POINT_TO_CELL_STRING(customer_loc, 8) AS c_h3_8,
            H3_POINT_TO_CELL_STRING(restaurant_loc, 7) AS r_h3_7,
            H3_POINT_TO_CELL_STRING(customer_loc, 7) AS c_h3_7,
            ST_DISTANCE(restaurant_loc, customer_loc) / 1000 AS dist_km
        FROM locations
    ),
    travel_lookup AS (
        SELECT 
            h.*,
            COALESCE(
                (SELECT travel_time_seconds FROM OPENROUTESERVICE_SETUP.PUBLIC.CA_TRAVEL_TIME_RES9 
                 WHERE (origin_h3 = h.r_h3_9 AND dest_h3 = h.c_h3_9) 
                    OR (origin_h3 = h.c_h3_9 AND dest_h3 = h.r_h3_9) LIMIT 1),
                (SELECT travel_time_seconds FROM OPENROUTESERVICE_SETUP.PUBLIC.CA_TRAVEL_TIME_RES8 
                 WHERE (origin_h3 = h.r_h3_8 AND dest_h3 = h.c_h3_8) 
                    OR (origin_h3 = h.c_h3_8 AND dest_h3 = h.r_h3_8) LIMIT 1),
                (SELECT travel_time_seconds FROM OPENROUTESERVICE_SETUP.PUBLIC.CA_TRAVEL_TIME_RES7 
                 WHERE (origin_h3 = h.r_h3_7 AND dest_h3 = h.c_h3_7) 
                    OR (origin_h3 = h.c_h3_7 AND dest_h3 = h.r_h3_7) LIMIT 1),
                -- Fallback: estimate from straight-line distance (avg 30 km/h in city)
                h.dist_km * 120
            ) AS travel_secs
        FROM h3_cells h
    )
    SELECT OBJECT_CONSTRUCT(
        'prep_time_mins', prep_time_mins,
        'travel_time_mins', ROUND(travel_secs / 60, 1),
        'total_eta_mins', prep_time_mins + ROUND(travel_secs / 60, 0),
        'distance_km', ROUND(dist_km, 2),
        'resolution_used', CASE 
            WHEN dist_km <= 3.2 THEN 'res9 (last mile)'
            WHEN dist_km <= 16 THEN 'res8 (delivery zone)'
            ELSE 'res7 (long range)'
        END
    )
    FROM travel_lookup
$$;
```

### Step 4: Use ETA Predictions in Delivery Routes

Replace ORS DIRECTIONS calls with matrix lookups for faster route generation:

```sql
CREATE OR REPLACE TABLE OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ROUTE_GEOMETRIES_V2 AS
WITH order_timing AS (
    SELECT 
        o.*,
        -- Get pre-computed travel time from matrix
        OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.PREDICT_DELIVERY_ETA(
            ST_X(o.RESTAURANT_LOCATION),
            ST_Y(o.RESTAURANT_LOCATION),
            ST_X(o.CUSTOMER_LOCATION),
            ST_Y(o.CUSTOMER_LOCATION),
            o.PREP_TIME_MINS
        ) AS eta_info,
        ROW_NUMBER() OVER (PARTITION BY o.COURIER_ID ORDER BY o.ORDER_HOUR, o.ORDER_NUMBER) AS COURIER_ORDER_SEQ
    FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.ORDERS_WITH_LOCATIONS o
),
cumulative_timing AS (
    SELECT 
        t.*,
        t.eta_info:travel_time_mins::FLOAT * 60 AS route_duration_secs,
        t.eta_info:distance_km::FLOAT * 1000 AS route_distance_meters,
        SUM(COALESCE(t.eta_info:total_eta_mins::FLOAT * 60, 0) + 120) OVER (
            PARTITION BY t.COURIER_ID 
            ORDER BY t.COURIER_ORDER_SEQ 
            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
        ) AS TIME_OFFSET_SECS
    FROM order_timing t
)
SELECT 
    COURIER_ID,
    ORDER_ID,
    DATEADD('second', COALESCE(TIME_OFFSET_SECS, 0), 
        DATEADD('hour', ORDER_HOUR, '2025-01-15'::TIMESTAMP_NTZ)
    ) AS ORDER_TIME,
    DATEADD('second', COALESCE(TIME_OFFSET_SECS, 0) + (PREP_TIME_MINS * 60), 
        DATEADD('hour', ORDER_HOUR, '2025-01-15'::TIMESTAMP_NTZ)
    ) AS PICKUP_TIME,
    DATEADD('second', COALESCE(TIME_OFFSET_SECS, 0) + (PREP_TIME_MINS * 60) + route_duration_secs, 
        DATEADD('hour', ORDER_HOUR, '2025-01-15'::TIMESTAMP_NTZ)
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
    route_duration_secs AS ROUTE_DURATION_SECS,
    route_distance_meters AS ROUTE_DISTANCE_METERS,
    -- For geometry, use ORS only when needed (or store pre-computed routes)
    NULL AS GEOMETRY,
    SHIFT_TYPE,
    VEHICLE_TYPE,
    eta_info:resolution_used::STRING AS TRAVEL_TIME_SOURCE
FROM cumulative_timing;
```

### Step 5: Real-time ETA Updates View

Create a view for real-time courier tracking with updated ETAs:

```sql
CREATE OR REPLACE VIEW OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.LIVE_DELIVERY_ETAS AS
SELECT 
    cl.COURIER_ID,
    cl.ORDER_ID,
    cl.COURIER_STATE,
    cl.CURR_TIME AS last_update,
    cl.POINT_GEOM AS current_location,
    cl.KMH AS current_speed,
    -- Calculate remaining travel time from current position
    CASE 
        WHEN cl.COURIER_STATE = 'delivered' THEN 0
        WHEN cl.COURIER_STATE IN ('at_restaurant', 'picking_up') THEN
            DATEDIFF('second', cl.PICKUP_TIME, cl.DROPOFF_TIME)
        ELSE
            -- Remaining distance to customer / current speed
            GREATEST(0, 
                DATEDIFF('second', cl.CURR_TIME, cl.DROPOFF_TIME)
            )
    END AS remaining_seconds,
    cl.DROPOFF_TIME AS original_eta,
    CASE 
        WHEN cl.COURIER_STATE = 'delivered' THEN cl.CURR_TIME
        ELSE DATEADD('second', 
            CASE 
                WHEN cl.COURIER_STATE IN ('at_restaurant', 'picking_up') THEN
                    DATEDIFF('second', cl.PICKUP_TIME, cl.DROPOFF_TIME)
                ELSE
                    GREATEST(0, DATEDIFF('second', cl.CURR_TIME, cl.DROPOFF_TIME))
            END,
            cl.CURR_TIME)
    END AS updated_eta,
    CASE 
        WHEN cl.KMH < 5 THEN 'stopped'
        WHEN cl.KMH < 15 THEN 'slow traffic'
        WHEN cl.KMH < 30 THEN 'normal'
        ELSE 'fast'
    END AS traffic_status
FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.COURIER_LOCATIONS cl
WHERE cl.POINT_INDEX = (
    SELECT MAX(POINT_INDEX) 
    FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.COURIER_LOCATIONS cl2 
    WHERE cl2.ORDER_ID = cl.ORDER_ID
);
```

### Performance Comparison: Matrix Lookup vs ORS Calls

| Method | 1,000 Orders | 10,000 Orders | 100,000 Orders |
|--------|--------------|---------------|----------------|
| **ORS DIRECTIONS** | ~5 min | ~50 min | ~8 hours |
| **Matrix Lookup** | ~2 sec | ~5 sec | ~30 sec |
| **Speedup** | 150x | 600x | 960x |

### Usage Example: Get ETA for New Order

```sql
-- Instant ETA prediction using pre-computed matrix
SELECT OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.PREDICT_DELIVERY_ETA(
    -122.4194, 37.7749,  -- Restaurant (SF City Hall)
    -122.3894, 37.7649,  -- Customer (Mission District)
    12                    -- Prep time (minutes)
) AS delivery_eta;

-- Result:
-- {
--   "prep_time_mins": 12,
--   "travel_time_mins": 8.5,
--   "total_eta_mins": 21,
--   "distance_km": 4.2,
--   "resolution_used": "res9 (last mile)"
-- }
```

---

### Step 12: Deploy Fleet Intelligence React Native App

**Goal:** Build the Docker image for the Fleet Intelligence React app, push it to Snowflake, create a native app package, install it, and configure it so the web UI is accessible via SPCS.

**Prerequisites:**
- Docker installed locally (`docker --version`)
- `snow` CLI authenticated with the target connection
- All data tables from Steps 4-10 already exist in `OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY`

---

#### Sub-step 12a: Fix Dockerfile Port for SPCS

The SPCS service spec expects port 8080. Verify the Dockerfile in `fleet-intelligence-app/Dockerfile` has:

```dockerfile
ENV PORT=8080
EXPOSE 8080
```

The Express server reads `process.env.PORT` so this is all that's needed.

---

#### Sub-step 12b: Build Docker Image

```bash
cd fleet-intelligence-app
docker build --platform linux/amd64 -t fleet-intelligence:v1.1 .
```

This takes ~1-2 minutes. The multi-stage build compiles the React frontend (`npm run build`) and TypeScript server (`npx tsc -p tsconfig.server.json`).

---

#### Sub-step 12c: Create Image Repository in Snowflake

```sql
CREATE DATABASE IF NOT EXISTS FLEET_INTELLIGENCE_SETUP;
CREATE IMAGE REPOSITORY IF NOT EXISTS FLEET_INTELLIGENCE_SETUP.PUBLIC.FLEET_INTEL_REPO;
```

Then get the repository URL:

```sql
SHOW IMAGE REPOSITORIES IN SCHEMA FLEET_INTELLIGENCE_SETUP.PUBLIC;
```

Extract the `repository_url` from the result. It will look like:
`<orgname>-<acctname>.registry.snowflakecomputing.com/fleet_intelligence_setup/public/fleet_intel_repo`

---

#### Sub-step 12d: Tag and Push Docker Image

```bash
# Login to Snowflake registry
snow spcs image-registry login -c {CONNECTION_NAME}

# Tag the image with the Snowflake registry URL
docker tag fleet-intelligence:v1.1 {REPO_URL}/fleet-intelligence:v1.1

# Push to Snowflake (takes 1-2 minutes)
docker push {REPO_URL}/fleet-intelligence:v1.1
```

Where `{REPO_URL}` is the `repository_url` from the previous step.

---

#### Sub-step 12e: Create Application Package

```sql
CREATE APPLICATION PACKAGE IF NOT EXISTS FLEET_INTELLIGENCE_PKG;
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE_PKG.stage_content;
CREATE OR REPLACE STAGE FLEET_INTELLIGENCE_PKG.stage_content.app_code
    DIRECTORY = (ENABLE = TRUE)
    ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE');
```

---

#### Sub-step 12f: Upload Native App Files to Stage

Upload all files from `fleet-intelligence-app/native-app/` to the stage:

```bash
APP_DIR="fleet-intelligence-app/native-app"

snow stage copy "${APP_DIR}/manifest.yml" @FLEET_INTELLIGENCE_PKG.stage_content.app_code/ -c {CONNECTION_NAME} --overwrite
snow stage copy "${APP_DIR}/setup_script.sql" @FLEET_INTELLIGENCE_PKG.stage_content.app_code/ -c {CONNECTION_NAME} --overwrite
snow stage copy "${APP_DIR}/README.md" @FLEET_INTELLIGENCE_PKG.stage_content.app_code/ -c {CONNECTION_NAME} --overwrite
snow stage copy "${APP_DIR}/services/fleet_intelligence_service.yaml" @FLEET_INTELLIGENCE_PKG.stage_content.app_code/services/ -c {CONNECTION_NAME} --overwrite
snow stage copy "${APP_DIR}/streamlit/status.py" @FLEET_INTELLIGENCE_PKG.stage_content.app_code/streamlit/ -c {CONNECTION_NAME} --overwrite
```

Verify all 5 files are staged:

```sql
LS @FLEET_INTELLIGENCE_PKG.stage_content.app_code;
```

Expected files: `manifest.yml`, `setup_script.sql`, `README.md`, `services/fleet_intelligence_service.yaml`, `streamlit/status.py`

---

#### Sub-step 12g: Register Version and Install Application

**IMPORTANT:** If release channels are enabled (default on newer accounts), use `REGISTER VERSION` not `ADD VERSION`.

```sql
ALTER APPLICATION PACKAGE FLEET_INTELLIGENCE_PKG
    REGISTER VERSION v1_0
    USING '@FLEET_INTELLIGENCE_PKG.stage_content.app_code';
```

If you get error `512020` about release channels, you're using the right syntax above. If release channels are NOT enabled, use:

```sql
ALTER APPLICATION PACKAGE FLEET_INTELLIGENCE_PKG
    ADD VERSION v1_0
    USING '@FLEET_INTELLIGENCE_PKG.stage_content.app_code';
```

Install the application:

```sql
CREATE APPLICATION FLEET_INTELLIGENCE_APP
    FROM APPLICATION PACKAGE FLEET_INTELLIGENCE_PKG
    USING VERSION v1_0;
```

> **Note:** If an object named `FLEET_INTELLIGENCE` already exists (e.g., a database), use `FLEET_INTELLIGENCE_APP` as the application name to avoid conflicts.

---

#### Sub-step 12h: Grant Required Privileges

```sql
GRANT CREATE COMPUTE POOL ON ACCOUNT TO APPLICATION FLEET_INTELLIGENCE_APP;
GRANT CREATE WAREHOUSE ON ACCOUNT TO APPLICATION FLEET_INTELLIGENCE_APP;
GRANT BIND SERVICE ENDPOINT ON ACCOUNT TO APPLICATION FLEET_INTELLIGENCE_APP;
```

**CRITICAL: Grant Cortex AI access (required for the AI agent to function):**

```sql
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO APPLICATION FLEET_INTELLIGENCE_APP;
```

**Grant data access:**

```sql
GRANT USAGE ON DATABASE OPENROUTESERVICE_SETUP TO APPLICATION FLEET_INTELLIGENCE_APP;
GRANT USAGE ON SCHEMA OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY TO APPLICATION FLEET_INTELLIGENCE_APP;
GRANT SELECT ON ALL TABLES IN SCHEMA OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY TO APPLICATION FLEET_INTELLIGENCE_APP;
GRANT SELECT ON ALL VIEWS IN SCHEMA OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY TO APPLICATION FLEET_INTELLIGENCE_APP;
```

**Grant app role to installer's role:**

```sql
GRANT APPLICATION ROLE FLEET_INTELLIGENCE_APP.APP_USER TO ROLE <YOUR_ROLE>;
```

---

#### Sub-step 12i: Create External Access Integration for Map Tiles

The React app uses Carto basemap tiles and needs egress network access:

```sql
CREATE OR REPLACE NETWORK RULE fleet_intel_map_tiles_rule
    MODE = EGRESS
    TYPE = HOST_PORT
    VALUE_LIST = ('a.basemaps.cartocdn.com:443', 'b.basemaps.cartocdn.com:443', 'c.basemaps.cartocdn.com:443', 'd.basemaps.cartocdn.com:443');

CREATE OR REPLACE EXTERNAL ACCESS INTEGRATION fleet_intel_map_tiles_eai
    ALLOWED_NETWORK_RULES = (fleet_intel_map_tiles_rule)
    ENABLED = TRUE;
```

Grant the EAI to the application and bind the reference:

```sql
GRANT USAGE ON INTEGRATION fleet_intel_map_tiles_eai TO APPLICATION FLEET_INTELLIGENCE_APP;
```

**IMPORTANT:** To bind the EAI reference, you must use `SYSTEM$REFERENCE()` to create a reference handle and pass it to the app's register callback:

```sql
USE DATABASE FLEET_INTELLIGENCE_APP;
USE SCHEMA CORE;
CALL core.register_single_callback(
    'EXTERNAL_ACCESS_REF',
    'ADD',
    SYSTEM$REFERENCE('EXTERNAL_ACCESS_INTEGRATION', 'FLEET_INTEL_MAP_TILES_EAI', 'persistent', 'USAGE')
);
```

> **Note:** Passing the raw integration name (e.g., `'FLEET_INTEL_MAP_TILES_EAI'`) to `register_single_callback` will fail with "Object does not exist or not authorized". You MUST use the `SYSTEM$REFERENCE()` handle.

---

#### Sub-step 12j: Deploy the Service

```sql
USE DATABASE FLEET_INTELLIGENCE_APP;
CALL core.deploy();
```

This creates:
1. A compute pool (`FLEET_INTELLIGENCE_APP_compute_pool`, CPU_X64_S)
2. A warehouse (`FLEET_INTEL_WH`, XSMALL)
3. The SPCS service with the Docker container

---

#### Sub-step 12k: Verify Deployment

Check container status (should show READY):

```sql
SELECT SYSTEM$GET_SERVICE_STATUS('FLEET_INTELLIGENCE_APP.core.fleet_intelligence_service');
```

Check the endpoint URL (takes 2-3 minutes after container is READY):

```sql
SHOW ENDPOINTS IN SERVICE FLEET_INTELLIGENCE_APP.core.fleet_intelligence_service;
```

The `ingress_url` will show "Endpoints provisioning in progress..." for 2-3 minutes, then resolve to a URL like `xxxxx-orgname-acctname.snowflakecomputing.app`.

Check service logs to confirm it started correctly:

```sql
SELECT SYSTEM$GET_SERVICE_LOGS('FLEET_INTELLIGENCE_APP.core.fleet_intelligence_service', 0, 'fleet-intelligence', 50);
```

Expected log output:
```
Server running on http://localhost:8080
Mode: SPCS (service token)
SNOWFLAKE_HOST: xxxxxx.snowflakecomputing.com
```

**Output:** The Fleet Intelligence React app is accessible at `https://{ingress_url}`. The Snowsight Streamlit status page is available under Apps → FLEET_INTELLIGENCE_APP.

---

#### Native App Architecture Summary

| Component | Details |
|-----------|---------|
| **App Package** | `FLEET_INTELLIGENCE_PKG` |
| **Application** | `FLEET_INTELLIGENCE_APP` |
| **Image Repo** | `FLEET_INTELLIGENCE_SETUP.PUBLIC.FLEET_INTEL_REPO` |
| **Docker Image** | `fleet-intelligence:v1.1` (linux/amd64, Node 20) |
| **Active Version** | V1_4 patch 0 |
| **Compute Pool** | `FLEET_INTELLIGENCE_APP_compute_pool` (CPU_X64_S) |
| **Service** | `FLEET_INTELLIGENCE_APP.core.fleet_intelligence_service` |
| **Port** | 8080 (SPCS) / 3001 (local dev) |
| **Auth Mode** | SPCS service token (`/snowflake/session/token`) |
| **EAI** | `fleet_intel_map_tiles_eai` (Carto basemap tiles) |
| **Streamlit** | Status/launcher page at `core.status_app` |

#### Updating the App

> **CRITICAL — SPCS Image Caching:** Pushing a Docker image over the same tag (e.g. `v1.1` → `v1.1`) does **NOT** force SPCS to re-pull. The cached image continues running. You **MUST** use a new tag (e.g. `v1.1` → `v1.2`) and update both `manifest.yml` and `services/fleet_intelligence_service.yaml` to reference it.

To push a new version after code changes:

```bash
# Rebuild with NEW tag (increment from current)
cd fleet-intelligence-app
docker build --platform linux/amd64 -t fleet-intelligence:{NEW_TAG} .

# Push (login if session expired: snow spcs image-registry login -c {CONNECTION_NAME})
docker tag fleet-intelligence:{NEW_TAG} {REPO_URL}/fleet-intelligence:{NEW_TAG}
docker push {REPO_URL}/fleet-intelligence:{NEW_TAG}
```

**Update image references in native app files:**
- `fleet-intelligence-app/native-app/manifest.yml` — update image reference line
- `fleet-intelligence-app/native-app/services/fleet_intelligence_service.yaml` — update `image:` field

```bash
# Re-upload all changed native app files
APP_DIR="fleet-intelligence-app/native-app"
snow stage copy "${APP_DIR}/manifest.yml" @FLEET_INTELLIGENCE_PKG.stage_content.app_code/ -c {CONNECTION_NAME} --overwrite
snow stage copy "${APP_DIR}/setup_script.sql" @FLEET_INTELLIGENCE_PKG.stage_content.app_code/ -c {CONNECTION_NAME} --overwrite
snow stage copy "${APP_DIR}/services/fleet_intelligence_service.yaml" @FLEET_INTELLIGENCE_PKG.stage_content.app_code/services/ -c {CONNECTION_NAME} --overwrite
snow stage copy "${APP_DIR}/streamlit/status.py" @FLEET_INTELLIGENCE_PKG.stage_content.app_code/streamlit/ -c {CONNECTION_NAME} --overwrite
```

**If manifest.yml changed (image references, privileges)** — MUST register a full new VERSION:

> Under `manifest_version: 2`, changing the manifest (including image references or privileges) requires a full new version. Patches will fail with error 093359. Max 2 unassigned versions — deregister old ones first.

```sql
-- Deregister old version if needed (max 2 unassigned)
ALTER APPLICATION PACKAGE FLEET_INTELLIGENCE_PKG DEREGISTER VERSION {OLD_VERSION};

-- Register new version
ALTER APPLICATION PACKAGE FLEET_INTELLIGENCE_PKG
    REGISTER VERSION {NEW_VERSION}
    USING '@FLEET_INTELLIGENCE_PKG.stage_content.app_code';
```

**If only setup_script.sql / service specs / Streamlit changed** — use a PATCH:

```sql
ALTER APPLICATION PACKAGE FLEET_INTELLIGENCE_PKG
    ADD PATCH FOR VERSION {CURRENT_VERSION}
    USING '@FLEET_INTELLIGENCE_PKG.stage_content.app_code';
```

**Upgrade the installed app:**

```sql
ALTER APPLICATION FLEET_INTELLIGENCE_APP UPGRADE USING VERSION {VERSION};
```

The service will automatically restart with the new image.

---

## Scalable Travel Time Matrix Pipeline (Native App)

The native app includes a scalable travel time matrix pipeline built into `setup_script.sql`. The React UI's Matrix Builder page triggers and monitors the pipeline.

### Pipeline Architecture

```
BUILD_HEXAGONS → BUILD_WORK_QUEUE → BUILD_TRAVEL_TIME_RANGE (workers) → FLATTEN_MATRIX_RAW
```

**Stages:** NOT_STARTED → HEXAGONS_READY → QUEUED → BUILDING → FLATTENING → COMPLETE

### Key Stored Procedures (in DATA schema)

| Procedure | Purpose |
|-----------|---------|
| `BUILD_HEXAGONS(P_RES, P_MIN_LAT, P_MAX_LAT, P_MIN_LON, P_MAX_LON)` | Generate H3 hexagon grid for a resolution |
| `BUILD_WORK_QUEUE(P_RES)` | Pre-compute origin + destination batches (1 row = 1 API call) |
| `BUILD_TRAVEL_TIME_RANGE(P_RES, P_START_SEQ, P_END_SEQ)` | Worker: ingest raw MATRIX_TABULAR responses |
| `FLATTEN_MATRIX_RAW(P_RES)` | Post-process raw VARIANT into travel time pairs |
| `BUILD_TRAVEL_TIME_MATRIX_RES7()` / `RES8()` / `RES9()` | Convenience wrappers — run full pipeline for a resolution |
| `MATRIX_PROGRESS()` | Returns JSON with per-resolution stage, counts, and pct |

### Tables (per resolution 7, 8, 9)

| Table | Schema | Purpose |
|-------|--------|---------|
| `CA_H3_RES{N}` | h3_index, lon, lat | Hexagon cells covering the region |
| `CA_WORK_QUEUE_RES{N}` | seq_id, origin_h3, origin_lon, origin_lat, dest_coords, dest_hex_ids | Pre-computed API call batches |
| `CA_MATRIX_RAW_RES{N}` | seq_id, origin_h3, dest_hex_ids, matrix_result (VARIANT) | Raw API responses |
| `CA_TRAVEL_TIME_RES{N}` | origin_h3, dest_h3, travel_time_seconds, travel_distance_meters | Final flattened pairs |

### Server API Endpoints (server/index.ts)

The Express server exposes two endpoints for the React Matrix Builder:

**`POST /api/matrix/build`** — Triggers the full pipeline for selected resolutions. Calls convenience wrapper `BUILD_TRAVEL_TIME_MATRIX_RES{N}()` for each resolution. Runs asynchronously (fire-and-forget per resolution).

**`GET /api/matrix/status`** — Polls `MATRIX_PROGRESS()` for real-time stage-level data. Returns per-resolution: stage, hexagons, work_queue, raw_ingested, flattened, percent_complete.

### React MatrixBuilder UI (src/components/MatrixBuilder.tsx)

The Matrix Builder page shows:
- Pipeline stage indicators per resolution: Hexagons → Work Queue → API Calls → Flatten → Complete
- Active stage has pulsing animation, completed stages show green checkmark
- Progress bar with percentage
- Detailed counts: hex cells, queued origins, raw ingested, flattened pairs
- Time estimate during BUILDING stage

### Key Design Decisions

- **Raw dump then FLATTEN:** API responses are stored as raw VARIANT. FLATTEN happens in bulk after all API calls complete. This avoids blocking during ingestion.
- **Resume-safe workers:** `BUILD_TRAVEL_TIME_RANGE` checks last completed SEQ_ID and resumes from there.
- **Adaptive batch sizing:** RES7=100, RES8=1000, RES9=2000 origins per batch (tuned to stay under ORS 500K matrix element limit).
- **K-ring radii:** RES7=33 (~50mi), RES8=17 (~10mi), RES9=9 (~2mi).

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| ORS routes returning NULL | Location outside ORS configured region - verify map data |
| ORS routes failing | Verify OpenRouteService Native App is installed and running |
| No restaurants found | Bounding box may be too restrictive; try expanding coordinates |
| No addresses found | Verify Overture Maps Addresses share is installed |
| Out of memory | Use larger warehouse or reduce NUM_COURIERS |
| Missing Overture data | Install shares from Snowflake Marketplace |
| Streamlit not loading | Check all files uploaded to stage via `LIST @STREAMLIT_STAGE/swiftbite/` |
| Map centered wrong | Update `get_city()` call in Streamlit files |
| PUT command fails | Ensure the file path is absolute and the file exists locally |
| Bicycle routes failing | ORS may not have cycling profile enabled; check ors-config.yml |
| Docker build fails | Ensure Docker is running and has linux/amd64 platform support |
| Image push fails | Run `snow spcs image-registry login -c {CONNECTION_NAME}` to refresh auth |
| `ADD VERSION` error 512020 | Account has release channels enabled; use `REGISTER VERSION` instead |
| App install name conflict | If `FLEET_INTELLIGENCE` database exists, use `FLEET_INTELLIGENCE_APP` as the app name |
| EAI bind fails with "Object does not exist" | Must use `SYSTEM$REFERENCE()` handle, not raw integration name |
| Endpoint "provisioning in progress" | Normal — wait 2-3 minutes after container shows READY |
| Service container not starting | Check logs: `SELECT SYSTEM$GET_SERVICE_LOGS(...)`. Verify image was pushed correctly |
| Map tiles not loading in SPCS | EAI not bound. Re-run `register_single_callback` with `SYSTEM$REFERENCE()` |
| Server shows "Mode: local" in SPCS | `/snowflake/session/token` file missing; check service spec mounts |
| Agent error "Unknown function SNOWFLAKE.CORTEX.COMPLETE" | Missing Cortex grant: `GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO APPLICATION FLEET_INTELLIGENCE_APP` |
| Agent shows "error generating response" | Check Cortex grant AND data grants (USAGE on database/schema, SELECT on tables/views) |
| SPCS not picking up new Docker image | Same tag won't re-pull. Must use NEW tag (e.g. v1.1 → v1.2) and update manifest.yml + service YAML |
| `ADD PATCH` error 093359 | Cannot change manifest under `manifest_version: 2` via patch; must register a full new VERSION |
| `REGISTER VERSION` max versions error | Max 2 unassigned versions. Deregister old: `ALTER APPLICATION PACKAGE ... DEREGISTER VERSION ...` |
| `ALTER APPLICATION UPGRADE` fails | Use explicit version: `ALTER APPLICATION ... UPGRADE USING VERSION {VERSION}` |
| `REGISTER PATCH` syntax error | Use `ADD PATCH FOR VERSION` (not `REGISTER PATCH FOR VERSION`) |
| Matrix build shows 0/0 progress | Server endpoints may reference old tables. Verify `/api/matrix/status` calls `MATRIX_PROGRESS()` |
| `SYSTEM$REGISTRY_LIST_IMAGES` 401 | Use `snow spcs image-repository list-images` CLI command instead |
