---
name: deploy-fleet-intelligence-food-delivery
description: "Deploy the Fleet Intelligence food delivery solution: native app with built-in OpenRouteService routing, Overture Maps data, courier simulation, and Streamlit dashboard. Supports 11 cities worldwide. Triggers: deploy fleet intelligence, install fleet app, food delivery demo, generate courier data."
---

# Deploy Fleet Intelligence Food Delivery Solution

## Configuration Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `LOCATION` | San Francisco | City for the simulation (see Supported Locations) |
| `NUM_COURIERS` | 50 | Total number of delivery couriers |
| `NUM_DAYS` | 1 | Number of days to simulate |
| `START_DATE` | 2025-01-15 | First day of simulation |
| `VEHICLE_TYPE` | cycling-electric | ORS routing profile for courier vehicle type (E-Bike default, suited for food delivery) |

### Vehicle Types

The solution supports multiple vehicle types via OpenRouteService routing profiles. Each courier uses the selected vehicle type for route generation, speed simulation, and travel time matrix computation.

| UI Label | ORS Profile | Description |
|----------|-------------|-------------|
| E-Bike | `cycling-electric` | Electric bicycle (default) |
| Car | `driving-car` | Standard car driving |
| HGV | `driving-hgv` | Heavy goods vehicle routing |
| Bicycle | `cycling-regular` | Regular cycling |
| Road Bike | `cycling-road` | Road cycling |
| Walking | `foot-walking` | Pedestrian routing |

**Key behaviors:**
- One vehicle type per data build — all couriers in a build use the same type
- Matrix builds support one vehicle type per build; building again with a different type **appends** data (does not overwrite)
- `CA_TRAVEL_TIME_RES7/8/9` tables include a `VEHICLE_TYPE` column to support multiple types coexisting
- The ORS config defaults to `cycling-electric` (E-Bike); additional profiles require ORS service reconfiguration
- Speed simulation profiles differ per vehicle type (e.g., cycling ~15-30 km/h, walking ~4-7 km/h, driving ~15-55 km/h)

---

## Supported Maps & Locations

The native app supports cities worldwide. ORS routing uses PBF map files downloaded automatically per-city from BBBike (`https://download.bbbike.org/osm/bbbike/`).

### Default Supported Maps

These 11 cities are pre-configured with verified BBBike PBF URLs, bounding boxes, and Overture Maps filters:

| Location | Country | State | Center LON | Center LAT | ORS Region | BBBike PBF Name |
|----------|---------|-------|------------|------------|------------|-----------------|
| **San Francisco** | US | CA | -122.44 | 37.76 | SanFrancisco | `SanFrancisco` |
| **Los Angeles** | US | CA | -118.24 | 34.05 | LosAngeles | `LosAngeles` |
| **San Jose** | US | CA | -121.89 | 37.34 | SanJose | `SanJose` |
| **Sacramento** | US | CA | -121.49 | 38.58 | Sacramento | `Sacramento` |
| **Santa Barbara** | US | CA | -119.70 | 34.42 | SantaBarbara | `SantaBarbara` |
| **Stockton** | US | CA | -121.29 | 37.97 | Stockton | `Stockton` |
| **New York** | US | NY | -73.98 | 40.71 | NewYork | `NewYork` |
| **Chicago** | US | IL | -87.73 | 41.83 | Chicago | `Chicago` |
| **London** | GB | | -0.09 | 51.51 | London | `London` |
| **Paris** | FR | | 2.35 | 48.86 | Paris | `Paris` |
| **Berlin** | DE | BE | 13.40 | 52.52 | Berlin | `Berlin` |

### Adding Additional Maps (Before Native App Deployment)

Before building and deploying the React native app (Step 12), the user may want to add support for cities not in the default list. Follow this workflow:

**1. Show the user the default maps above and ask:**
> "Would you like to add any additional city maps beyond the 11 defaults?"

**2. If the user requests a city, verify it exists on the BBBike download server:**

Fetch the BBBike city list to check availability:
```
URL: https://download.bbbike.org/osm/bbbike/
```

The page lists all available cities as directory links. Search for the requested city name (case-sensitive, no spaces — e.g., `SanDiego`, `Toronto`, `Sydney`).

- The BBBike PBF URL pattern is: `https://download.bbbike.org/osm/bbbike/{CityName}/{CityName}.osm.pbf`
- City names on BBBike use PascalCase with no spaces (e.g., `SanDiego`, `LasVegas`, `RiodeJaneiro`)

**3. If the city IS found on BBBike:**

Confirm with the user:
> "✅ **{CityName}** is available on BBBike. The PBF map URL is:
> `https://download.bbbike.org/osm/bbbike/{CityName}/{CityName}.osm.pbf`
>
> Would you like to add this as a supported city? (The map will NOT be downloaded now — it will be downloaded automatically when ORS routing is provisioned for this city after deployment.)"

If confirmed, you must add the city to the `CITY_ORS_MAP` in `server/index.ts` before building the Docker image in Step 12. The entry format is:

```typescript
'{city_key}': {
  pbfUrl: 'https://download.bbbike.org/osm/bbbike/{CityName}/{CityName}.osm.pbf',
  bounds: [[{sw_lon}, {sw_lat}], [{ne_lon}, {ne_lat}]],
  center: [{center_lon}, {center_lat}],
  zoom: 12,
  country: '{COUNTRY_CODE}',
  state: '{STATE_CODE}',  // empty string for non-US cities
}
```

Also add the city to the Overture Maps filter tables below so data generation works.

**4. If the city is NOT found on BBBike:**

Notify the user:
> "❌ **{CityName}** was not found on the BBBike download server. Available cities can be browsed at:
> `https://download.bbbike.org/osm/bbbike/`
>
> Note: BBBike city names are PascalCase with no spaces. Try variations like `{suggestions}`.
> Alternatively, check Geofabrik downloads at `https://download.geofabrik.de/` for region-level PBF files."

**5. Do NOT download the map.** The map is downloaded automatically by the native app's downloader service when `ROUTING.CREATE_CITY_ORS_SERVICE('{CityName}')` is called after deployment.

### Overture Maps Filter by City

| City | Places Filter | Addresses Filter |
|------|--------------|------------------|
| California cities | `ADDRESSES[0]:country::STRING = 'US' AND ADDRESSES[0]:region::STRING = 'CA'` | `COUNTRY = 'US' AND ADDRESS_LEVELS[0]:value::STRING = 'CA'` |
| New York | `ADDRESSES[0]:country::STRING = 'US' AND ADDRESSES[0]:region::STRING = 'NY'` | `COUNTRY = 'US' AND ADDRESS_LEVELS[0]:value::STRING = 'NY'` |
| Chicago | `ADDRESSES[0]:country::STRING = 'US' AND ADDRESSES[0]:region::STRING = 'IL'` | `COUNTRY = 'US' AND ADDRESS_LEVELS[0]:value::STRING = 'IL'` |
| London | `ADDRESSES[0]:country::STRING = 'GB'` | `COUNTRY = 'GB'` |
| Paris | `ADDRESSES[0]:country::STRING = 'FR'` | `COUNTRY = 'FR'` |
| Berlin | `ADDRESSES[0]:country::STRING = 'DE'` | `COUNTRY = 'DE'` |

> **Adding filters for new cities:** For US cities, use the appropriate state code. For international cities, use the country code only. Add a new row to this table when adding a custom city.

---

## Prerequisites

1. **Snowflake Account** with ACCOUNTADMIN (or equivalent) privileges
2. **Overture Maps Data** shares — installed in Step 1b from Snowflake Marketplace
3. **Docker** installed locally (for building the Fleet Intelligence React app image)
4. **Snow CLI** (`snow`) authenticated with your target Snowflake connection

---

## Workflow

Execute each step in order. Substitute `{PLACEHOLDER}` values based on the user's chosen configuration before executing.

### CRITICAL: Execution Rules

> 1. **One statement per `snowflake_sql_execute` call.** Multi-statement blocks can silently fail.
> 2. **Always use fully qualified object names.** `USE` statements do not persist across calls.
> 3. **Never use `SET` session variables.** Substitute literal values directly into SQL.
> 4. **Verify row counts after each CTAS.**

### Step 1: Set Query Tag and Install Overture Maps Data

**Sub-step 1a: Set Query Tag**

```sql
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is","name":"oss-deploy-a-fleet-intelligence-solution-for-food-delivery","version":{"major":1, "minor":0},"attributes":{"is_quickstart":1, "source":"sql"}}';
```

**Sub-step 1b: Install Overture Maps Datasets from Marketplace**

```sql
SHOW DATABASES LIKE 'OVERTURE_MAPS%';
```

If `OVERTURE_MAPS__PLACES` is **not** listed:

```sql
CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZT0Z4CM1E9KR');
```
```sql
CREATE DATABASE IF NOT EXISTS OVERTURE_MAPS__PLACES FROM LISTING GZT0Z4CM1E9KR;
```

If `OVERTURE_MAPS__ADDRESSES` is **not** listed:

```sql
CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZT0Z4CM1E9NQ');
```
```sql
CREATE DATABASE IF NOT EXISTS OVERTURE_MAPS__ADDRESSES FROM LISTING GZT0Z4CM1E9NQ;
```

Verify:

```sql
SELECT COUNT(*) FROM OVERTURE_MAPS__PLACES.CARTO.PLACE LIMIT 1;
```
```sql
SELECT COUNT(*) FROM OVERTURE_MAPS__ADDRESSES.CARTO.ADDRESS WHERE COUNTRY = 'US' LIMIT 1;
```

---

### Step 2: Choose Location, Manage Maps, and Deploy Fleet Intelligence Native App

> The Fleet Intelligence Native App is **fully self-contained** — it bundles ORS, VROOM, routing gateway, and PBF downloader. No separate ORS installation needed.

**Sub-step 2a: Ask User to Choose Location**

Present the pre-configured cities from the **Default Supported Maps** table. Store `{LOCATION}`, `{COUNTRY}`, and `{STATE}` from the filter table.

**Sub-step 2b: Check for Additional Maps**

Follow the **Adding Additional Maps** workflow in the "Supported Maps & Locations" section above:
1. Ask the user if they want to add any cities beyond the 11 defaults.
2. If yes, search BBBike (`https://download.bbbike.org/osm/bbbike/`) to verify the city exists.
3. Confirm with the user before adding.
4. If confirmed, add the city to `CITY_ORS_MAP` in `server/index.ts` and to the Overture Maps filter table — this MUST happen before the Docker image is built in Step 12.
5. If the city is not found on BBBike, notify the user and suggest alternatives.

**Sub-step 2c: Deploy the Native App**

Follow **Step 12** to build Docker image, push to Snowflake, create app package, install, grant privileges, and deploy.

**Sub-step 2d: Provision ORS Routing for the Selected City**

```sql
CALL FLEET_INTELLIGENCE_APP.ROUTING.SETUP_ORS();
```

```sql
CALL FLEET_INTELLIGENCE_APP.ROUTING.CREATE_CITY_ORS_SERVICE('{LOCATION}');
CALL FLEET_INTELLIGENCE_APP.ROUTING.CREATE_CITY_FUNCTIONS('{LOCATION}');
```

**Sub-step 2e: Verify Routing**

```sql
SELECT FLEET_INTELLIGENCE_APP.ROUTING.DIRECTIONS(
    'driving-car',
    [{CENTER_LON}, {CENTER_LAT}],
    [{CENTER_LON} + 0.02, {CENTER_LAT} + 0.02]
);
```

If it fails, check logs:

```sql
CALL SYSTEM$GET_SERVICE_LOGS('FLEET_INTELLIGENCE_APP.ROUTING.ORS_SERVICE', 0, 'ors', 50);
```

---

### Step 3: Configure Database, Warehouse, and Schema

```sql
CREATE DATABASE IF NOT EXISTS FLEET_INTELLIGENCE_SETUP
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
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY
    COMMENT = '{"origin":"sf_sit-is", "name":"oss-deploy-a-fleet-intelligence-solution-for-food-delivery", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';
```

```sql
CREATE STAGE IF NOT EXISTS FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.STREAMLIT_STAGE
    DIRECTORY = (ENABLE = TRUE);
```

---

### Step 4: Create Restaurant Locations

> **Filter:** Use `{COUNTRY}` and `{STATE_FILTER}` from the filter table. US cities: filter by country + state. International: country only (`{STATE_FILTER}` = `1=1`).

```sql
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.RESTAURANTS AS
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
    ADDRESSES[0]:country::STRING = '{COUNTRY}'
    AND ({STATE_FILTER})
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

> **Filter Substitution:**
> - **US cities:** `{COUNTRY}` = `US`, `{STATE_FILTER}` = `ADDRESSES[0]:region::STRING = '{STATE}'`
> - **International:** `{COUNTRY}` = country code, `{STATE_FILTER}` = `1=1`

Verify:

```sql
SELECT CITY, COUNT(*) AS RESTAURANT_COUNT
FROM FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.RESTAURANTS
GROUP BY CITY ORDER BY RESTAURANT_COUNT DESC LIMIT 15;
```

---

### Step 5: Create Customer Delivery Addresses

```sql
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.CUSTOMER_ADDRESSES AS
SELECT 
    ID AS ADDRESS_ID,
    GEOMETRY AS LOCATION,
    COALESCE(ADDRESS_LEVELS[0]:value::STRING || ' ' || STREET, STREET) AS FULL_ADDRESS,
    STREET,
    POSTCODE,
    ADDRESS_LEVELS[0]:value::STRING AS STATE,
    ADDRESS_LEVELS[1]:value::STRING AS CITY
FROM OVERTURE_MAPS__ADDRESSES.CARTO.ADDRESS
WHERE 
    COUNTRY = '{COUNTRY}'
    AND ({ADDRESS_STATE_FILTER})
    AND STREET IS NOT NULL;
```

> **Filter Substitution:**
> - **US cities:** `{COUNTRY}` = `US`, `{ADDRESS_STATE_FILTER}` = `ADDRESS_LEVELS[0]:value::STRING = '{STATE}'`
> - **International:** `{COUNTRY}` = country code, `{ADDRESS_STATE_FILTER}` = `1=1`

Verify:

```sql
SELECT CITY, COUNT(*) AS ADDRESS_COUNT
FROM FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.CUSTOMER_ADDRESSES
GROUP BY CITY ORDER BY ADDRESS_COUNT DESC LIMIT 15;
```

---

### Step 6: Create Couriers with Shift Patterns

For default 50 couriers: BREAKFAST=5, LUNCH=15, AFTERNOON=8, DINNER=17, LATE_NIGHT=5.

```sql
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.COURIERS AS
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
    SELECT ADDRESS_ID, ROW_NUMBER() OVER (ORDER BY RANDOM()) AS rn
    FROM FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.CUSTOMER_ADDRESSES
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

Verify:

```sql
SELECT SHIFT_TYPE, VEHICLE_TYPE, COUNT(*) AS NUM_COURIERS
FROM FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.COURIERS
GROUP BY SHIFT_TYPE, VEHICLE_TYPE ORDER BY SHIFT_TYPE, NUM_COURIERS DESC;
```

---

### Step 7: Generate Delivery Orders

Materialize numbered tables for stable joins:

```sql
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.RESTAURANTS_NUMBERED AS
SELECT RESTAURANT_ID, LOCATION, NAME, CUISINE_TYPE, ADDRESS,
    ROW_NUMBER() OVER (ORDER BY HASH(RESTAURANT_ID)) AS rn
FROM FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.RESTAURANTS
WHERE NAME IS NOT NULL AND LENGTH(NAME) > 2;
```

```sql
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.ADDRESSES_NUMBERED AS
SELECT ADDRESS_ID, LOCATION, FULL_ADDRESS,
    ROW_NUMBER() OVER (ORDER BY HASH(ADDRESS_ID)) AS rn
FROM FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.CUSTOMER_ADDRESSES
WHERE FULL_ADDRESS IS NOT NULL AND LENGTH(FULL_ADDRESS) > 3;
```

Generate orders:

```sql
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ORDERS AS
WITH 
courier_order_counts AS (
    SELECT c.COURIER_ID, c.SHIFT_TYPE, c.SHIFT_START_HOUR, c.SHIFT_END_HOUR,
        c.SHIFT_CROSSES_MIDNIGHT, c.VEHICLE_TYPE,
        CASE c.SHIFT_TYPE
            WHEN 'Lunch' THEN UNIFORM(12, 18, RANDOM())
            WHEN 'Dinner' THEN UNIFORM(14, 20, RANDOM())
            WHEN 'Breakfast' THEN UNIFORM(6, 10, RANDOM())
            WHEN 'Afternoon' THEN UNIFORM(8, 12, RANDOM())
            WHEN 'Late Night' THEN UNIFORM(4, 8, RANDOM())
        END AS NUM_ORDERS
    FROM FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.COURIERS c
),
order_sequence AS (
    SELECT c.COURIER_ID, c.SHIFT_TYPE, c.SHIFT_START_HOUR, c.SHIFT_END_HOUR,
        c.SHIFT_CROSSES_MIDNIGHT, c.VEHICLE_TYPE, c.NUM_ORDERS,
        ROW_NUMBER() OVER (PARTITION BY c.COURIER_ID ORDER BY RANDOM()) AS ORDER_NUMBER
    FROM courier_order_counts c
    CROSS JOIN TABLE(GENERATOR(ROWCOUNT => 25)) g
    QUALIFY ORDER_NUMBER <= c.NUM_ORDERS
),
orders_with_hours AS (
    SELECT os.*,
        CASE 
            WHEN os.SHIFT_CROSSES_MIDNIGHT = 'True' THEN
                MOD(os.SHIFT_START_HOUR + FLOOR((os.ORDER_NUMBER - 1) * 6.0 / os.NUM_ORDERS) + UNIFORM(0, 1, RANDOM()), 24)
            ELSE
                os.SHIFT_START_HOUR + FLOOR((os.ORDER_NUMBER - 1) * (os.SHIFT_END_HOUR - os.SHIFT_START_HOUR) / os.NUM_ORDERS) + UNIFORM(0, 1, RANDOM())
        END AS ORDER_HOUR
    FROM order_sequence os
),
rest_count AS (SELECT COUNT(*) AS cnt FROM FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.RESTAURANTS_NUMBERED),
addr_count AS (SELECT COUNT(*) AS cnt FROM FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.ADDRESSES_NUMBERED)
SELECT 
    MD5(o.COURIER_ID || '-' || o.ORDER_NUMBER || '-' || RANDOM()) AS ORDER_ID,
    o.COURIER_ID, o.ORDER_HOUR::INT AS ORDER_HOUR, o.ORDER_NUMBER::INT AS ORDER_NUMBER,
    o.SHIFT_TYPE, o.VEHICLE_TYPE,
    MOD(ABS(HASH(o.COURIER_ID || o.ORDER_NUMBER || 'R')), rc.cnt) + 1 AS RESTAURANT_IDX,
    MOD(ABS(HASH(o.COURIER_ID || o.ORDER_NUMBER || 'C')), ac.cnt) + 1 AS CUSTOMER_IDX,
    UNIFORM(5, 25, RANDOM()) AS PREP_TIME_MINS,
    CASE 
        WHEN UNIFORM(1, 100, RANDOM()) <= 92 THEN 'delivered'
        WHEN UNIFORM(1, 100, RANDOM()) <= 97 THEN 'in_transit'
        ELSE 'picked_up'
    END AS ORDER_STATUS
FROM orders_with_hours o CROSS JOIN rest_count rc CROSS JOIN addr_count ac;
```

```sql
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.ORDERS_WITH_LOCATIONS AS
SELECT 
    o.ORDER_ID, o.COURIER_ID, o.ORDER_HOUR, o.ORDER_NUMBER, o.SHIFT_TYPE, o.VEHICLE_TYPE,
    r.RESTAURANT_ID, r.NAME AS RESTAURANT_NAME, r.CUISINE_TYPE,
    r.LOCATION AS RESTAURANT_LOCATION, r.ADDRESS AS RESTAURANT_ADDRESS,
    a.ADDRESS_ID AS CUSTOMER_ADDRESS_ID, a.FULL_ADDRESS AS CUSTOMER_ADDRESS,
    a.LOCATION AS CUSTOMER_LOCATION, o.PREP_TIME_MINS, o.ORDER_STATUS
FROM FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ORDERS o
JOIN FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.RESTAURANTS_NUMBERED r ON o.RESTAURANT_IDX = r.rn
JOIN FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.ADDRESSES_NUMBERED a ON o.CUSTOMER_IDX = a.rn;
```

---

### Step 8: Generate ORS Routes

**WARNING:** This step makes many ORS API calls. ~500 orders: 2-4 min, ~1500: 8-12 min, ~3000: 20-30 min.

```sql
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ROUTES AS
SELECT 
    COURIER_ID, ORDER_ID, ORDER_HOUR, ORDER_NUMBER, SHIFT_TYPE, VEHICLE_TYPE,
    RESTAURANT_ID, RESTAURANT_NAME, CUISINE_TYPE, RESTAURANT_LOCATION, RESTAURANT_ADDRESS,
    CUSTOMER_ADDRESS_ID, CUSTOMER_ADDRESS, CUSTOMER_LOCATION, PREP_TIME_MINS, ORDER_STATUS,
    FLEET_INTELLIGENCE_APP.ROUTING.DIRECTIONS(
        CASE VEHICLE_TYPE WHEN 'bicycle' THEN 'cycling-regular' ELSE 'driving-car' END,
        ARRAY_CONSTRUCT(ST_X(RESTAURANT_LOCATION), ST_Y(RESTAURANT_LOCATION)),
        ARRAY_CONSTRUCT(ST_X(CUSTOMER_LOCATION), ST_Y(CUSTOMER_LOCATION))
    ) AS ROUTE_RESPONSE
FROM FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.ORDERS_WITH_LOCATIONS;
```

```sql
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ROUTES_PARSED AS
SELECT 
    COURIER_ID, ORDER_ID, ORDER_HOUR, ORDER_NUMBER, SHIFT_TYPE, VEHICLE_TYPE,
    RESTAURANT_ID, RESTAURANT_NAME, CUISINE_TYPE, RESTAURANT_LOCATION, RESTAURANT_ADDRESS,
    CUSTOMER_ADDRESS_ID, CUSTOMER_ADDRESS, CUSTOMER_LOCATION, PREP_TIME_MINS, ORDER_STATUS,
    TRY_TO_GEOGRAPHY(PARSE_JSON(ROUTE_RESPONSE):features[0]:geometry) AS ROUTE_GEOMETRY,
    PARSE_JSON(ROUTE_RESPONSE):features[0]:properties:summary:distance::FLOAT AS ROUTE_DISTANCE_METERS,
    PARSE_JSON(ROUTE_RESPONSE):features[0]:properties:summary:duration::FLOAT AS ROUTE_DURATION_SECS
FROM FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ROUTES
WHERE ROUTE_RESPONSE IS NOT NULL;
```

```sql
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ROUTE_GEOMETRIES AS
WITH order_timing AS (
    SELECT *,
        ROW_NUMBER() OVER (PARTITION BY COURIER_ID ORDER BY ORDER_HOUR, ORDER_NUMBER) AS COURIER_ORDER_SEQ
    FROM FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ROUTES_PARSED
    WHERE ROUTE_GEOMETRY IS NOT NULL
),
cumulative_timing AS (
    SELECT t.*,
        SUM(COALESCE(ROUTE_DURATION_SECS, 0) + (PREP_TIME_MINS * 60) + 120) OVER (
            PARTITION BY COURIER_ID ORDER BY COURIER_ORDER_SEQ 
            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
        ) AS TIME_OFFSET_SECS
    FROM order_timing t
)
SELECT 
    COURIER_ID, ORDER_ID,
    DATEADD('second', COALESCE(TIME_OFFSET_SECS, 0), DATEADD('hour', ORDER_HOUR, '{START_DATE}'::TIMESTAMP_NTZ)) AS ORDER_TIME,
    DATEADD('second', COALESCE(TIME_OFFSET_SECS, 0) + (PREP_TIME_MINS * 60), DATEADD('hour', ORDER_HOUR, '{START_DATE}'::TIMESTAMP_NTZ)) AS PICKUP_TIME,
    DATEADD('second', COALESCE(TIME_OFFSET_SECS, 0) + (PREP_TIME_MINS * 60) + ROUTE_DURATION_SECS, DATEADD('hour', ORDER_HOUR, '{START_DATE}'::TIMESTAMP_NTZ)) AS DELIVERY_TIME,
    RESTAURANT_ID, RESTAURANT_NAME, CUISINE_TYPE, RESTAURANT_LOCATION, RESTAURANT_ADDRESS,
    CUSTOMER_ADDRESS_ID, CUSTOMER_ADDRESS, CUSTOMER_LOCATION,
    PREP_TIME_MINS, ORDER_STATUS, ROUTE_DURATION_SECS, ROUTE_DISTANCE_METERS,
    ROUTE_GEOMETRY AS GEOMETRY, SHIFT_TYPE, VEHICLE_TYPE
FROM cumulative_timing;
```

Verify:

```sql
SELECT COUNT(*) AS TOTAL_ROUTES, COUNT(DISTINCT COURIER_ID) AS COURIERS,
    ROUND(AVG(ROUTE_DISTANCE_METERS)/1000, 2) AS AVG_DISTANCE_KM,
    ROUND(AVG(ROUTE_DURATION_SECS)/60, 1) AS AVG_DURATION_MINS
FROM FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ROUTE_GEOMETRIES;
```

---

### Step 9: Create Courier Locations

Creates 15 interpolated points per delivery with states: `at_restaurant`, `picking_up`, `en_route`, `arriving`, `delivered`.

```sql
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.COURIER_LOCATIONS AS
WITH 
route_info AS (
    SELECT COURIER_ID, ORDER_ID, ORDER_TIME, PICKUP_TIME, DELIVERY_TIME,
        RESTAURANT_LOCATION, CUSTOMER_LOCATION, GEOMETRY AS ROUTE,
        ROUTE_DURATION_SECS, ROUTE_DISTANCE_METERS, VEHICLE_TYPE, SHIFT_TYPE,
        ST_NPOINTS(GEOMETRY)::NUMBER(10,0) AS NUM_POINTS, PREP_TIME_MINS
    FROM FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ROUTE_GEOMETRIES
    WHERE GEOMETRY IS NOT NULL
),
point_seq AS (SELECT SEQ4()::NUMBER(10,0) AS POINT_INDEX FROM TABLE(GENERATOR(ROWCOUNT => 15))),
expanded AS (
    SELECT r.COURIER_ID, r.ORDER_ID, r.ORDER_TIME, r.PICKUP_TIME, r.DELIVERY_TIME,
        r.RESTAURANT_LOCATION, r.CUSTOMER_LOCATION, r.ROUTE, r.NUM_POINTS,
        r.ROUTE_DURATION_SECS, r.VEHICLE_TYPE, p.POINT_INDEX,
        UNIFORM(1, 100, RANDOM()) AS SPEED_ROLL,
        CASE 
            WHEN p.POINT_INDEX = 0 THEN 'at_restaurant'
            WHEN p.POINT_INDEX = 1 THEN 'picking_up'
            WHEN p.POINT_INDEX BETWEEN 2 AND 12 THEN 'en_route'
            WHEN p.POINT_INDEX = 13 THEN 'arriving'
            WHEN p.POINT_INDEX = 14 THEN 'delivered'
        END AS COURIER_STATE,
        CASE 
            WHEN p.POINT_INDEX = 0 THEN r.ORDER_TIME
            WHEN p.POINT_INDEX = 1 THEN r.PICKUP_TIME
            WHEN p.POINT_INDEX BETWEEN 2 AND 12 THEN
                DATEADD('second', FLOOR(r.ROUTE_DURATION_SECS * (p.POINT_INDEX - 2) / 10.0)::INT, r.PICKUP_TIME)
            WHEN p.POINT_INDEX = 13 THEN DATEADD('second', -30, r.DELIVERY_TIME)
            ELSE r.DELIVERY_TIME
        END AS CURR_TIME,
        CASE 
            WHEN p.POINT_INDEX IN (0, 1) THEN 1::NUMBER(10,0)
            WHEN p.POINT_INDEX IN (13, 14) THEN r.NUM_POINTS
            ELSE GREATEST(1::NUMBER(10,0), LEAST(r.NUM_POINTS, CEIL((p.POINT_INDEX - 2) * r.NUM_POINTS / 10.0)::NUMBER(10,0)))
        END AS GEOM_IDX
    FROM route_info r CROSS JOIN point_seq p
)
SELECT ORDER_ID, COURIER_ID, ORDER_TIME, PICKUP_TIME, DELIVERY_TIME AS DROPOFF_TIME,
    RESTAURANT_LOCATION, CUSTOMER_LOCATION, ROUTE,
    ST_POINTN(ROUTE, GEOM_IDX::INT) AS POINT_GEOM, CURR_TIME, POINT_INDEX, COURIER_STATE,
    CASE 
        WHEN COURIER_STATE = 'at_restaurant' THEN 0
        WHEN COURIER_STATE = 'picking_up' THEN 0
        WHEN COURIER_STATE = 'arriving' THEN UNIFORM(2, 8, RANDOM())
        WHEN COURIER_STATE = 'delivered' THEN 0
        WHEN COURIER_STATE = 'en_route' THEN
            CASE VEHICLE_TYPE
                WHEN 'bicycle' THEN
                    CASE WHEN SPEED_ROLL <= 20 THEN UNIFORM(8, 15, RANDOM())
                         WHEN SPEED_ROLL <= 60 THEN UNIFORM(15, 22, RANDOM())
                         ELSE UNIFORM(20, 30, RANDOM()) END
                WHEN 'scooter' THEN
                    CASE WHEN SPEED_ROLL <= 15 THEN UNIFORM(10, 20, RANDOM())
                         WHEN SPEED_ROLL <= 50 THEN UNIFORM(20, 35, RANDOM())
                         ELSE UNIFORM(30, 45, RANDOM()) END
                ELSE
                    CASE WHEN HOUR(CURR_TIME) BETWEEN 11 AND 13 THEN
                            CASE WHEN SPEED_ROLL <= 25 THEN UNIFORM(5, 15, RANDOM())
                                 WHEN SPEED_ROLL <= 60 THEN UNIFORM(15, 30, RANDOM())
                                 ELSE UNIFORM(25, 45, RANDOM()) END
                         WHEN HOUR(CURR_TIME) BETWEEN 18 AND 20 THEN
                            CASE WHEN SPEED_ROLL <= 30 THEN UNIFORM(5, 15, RANDOM())
                                 WHEN SPEED_ROLL <= 65 THEN UNIFORM(15, 30, RANDOM())
                                 ELSE UNIFORM(25, 40, RANDOM()) END
                         ELSE
                            CASE WHEN SPEED_ROLL <= 15 THEN UNIFORM(10, 20, RANDOM())
                                 WHEN SPEED_ROLL <= 45 THEN UNIFORM(20, 35, RANDOM())
                                 ELSE UNIFORM(30, 55, RANDOM()) END
                    END
            END
    END AS KMH
FROM expanded;
```

Verify:

```sql
SELECT COUNT(*) AS TOTAL_POINTS, COUNT(DISTINCT COURIER_ID) AS COURIERS,
    COUNT(DISTINCT ORDER_ID) AS ORDERS
FROM FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.COURIER_LOCATIONS;
```

---

### Step 10: Create Analytics Views

Execute each view as a separate statement:

```sql
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.COURIER_LOCATIONS_V AS
SELECT ORDER_ID, COURIER_ID, ORDER_TIME, PICKUP_TIME, DROPOFF_TIME,
    RESTAURANT_LOCATION, CUSTOMER_LOCATION, ROUTE, POINT_GEOM,
    ST_X(POINT_GEOM) AS LON, ST_Y(POINT_GEOM) AS LAT,
    CURR_TIME, CURR_TIME AS POINT_TIME, POINT_INDEX, COURIER_STATE, KMH
FROM FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.COURIER_LOCATIONS;
```

```sql
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.ORDERS_ASSIGNED_TO_COURIERS AS
SELECT COURIER_ID, ORDER_ID, RESTAURANT_ID, GEOMETRY,
    RESTAURANT_LOCATION, CUSTOMER_LOCATION, RESTAURANT_NAME, RESTAURANT_ADDRESS,
    CUSTOMER_ADDRESS, ORDER_TIME, PICKUP_TIME, DELIVERY_TIME, ORDER_STATUS
FROM FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ROUTE_GEOMETRIES;
```

```sql
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_NAMES AS
SELECT ORDER_ID, RESTAURANT_NAME || ' -> ' || CUSTOMER_ADDRESS AS DELIVERY_NAME
FROM FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ROUTE_GEOMETRIES;
```

```sql
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ROUTE_PLAN AS
SELECT rg.ORDER_ID, rg.COURIER_ID, rg.RESTAURANT_NAME, rg.RESTAURANT_ADDRESS,
    rg.CUSTOMER_ADDRESS, rg.CUSTOMER_ADDRESS AS CUSTOMER_STREET,
    rg.ORDER_TIME, rg.PICKUP_TIME, rg.DELIVERY_TIME,
    rg.RESTAURANT_LOCATION, rg.CUSTOMER_LOCATION, rg.GEOMETRY,
    rg.ROUTE_DISTANCE_METERS AS DISTANCE_METERS, rg.SHIFT_TYPE, rg.VEHICLE_TYPE, rg.ORDER_STATUS
FROM FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ROUTE_GEOMETRIES rg;
```

```sql
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_SUMMARY AS
WITH delivery_stats AS (
    SELECT ORDER_ID, AVG(KMH) AS AVERAGE_KMH, MAX(KMH) AS MAX_KMH
    FROM FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.COURIER_LOCATIONS GROUP BY ORDER_ID
)
SELECT rg.COURIER_ID, rg.ORDER_ID, rg.ORDER_TIME, rg.PICKUP_TIME, rg.DELIVERY_TIME,
    rg.RESTAURANT_ID, rg.RESTAURANT_NAME, rg.CUISINE_TYPE,
    rg.RESTAURANT_LOCATION, rg.RESTAURANT_ADDRESS,
    rg.CUSTOMER_ADDRESS_ID, rg.CUSTOMER_ADDRESS, rg.CUSTOMER_LOCATION,
    rg.PREP_TIME_MINS, rg.ORDER_STATUS, rg.ROUTE_DURATION_SECS, rg.ROUTE_DISTANCE_METERS,
    rg.GEOMETRY, rg.SHIFT_TYPE, rg.VEHICLE_TYPE, ds.AVERAGE_KMH, ds.MAX_KMH
FROM FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ROUTE_GEOMETRIES rg
LEFT JOIN delivery_stats ds ON rg.ORDER_ID = ds.ORDER_ID;
```

---

### Step 11: Deploy Streamlit App

Upload files using PUT commands:

```sql
PUT 'file://oss-deploy-a-fleet-intelligence-solution-for-food-delivery/streamlit/Delivery_Control_Center.py' @FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.STREAMLIT_STAGE/swiftbite/ AUTO_COMPRESS=FALSE OVERWRITE=TRUE;
PUT 'file://oss-deploy-a-fleet-intelligence-solution-for-food-delivery/streamlit/extra.css' @FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.STREAMLIT_STAGE/swiftbite/ AUTO_COMPRESS=FALSE OVERWRITE=TRUE;
PUT 'file://oss-deploy-a-fleet-intelligence-solution-for-food-delivery/streamlit/logo.svg' @FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.STREAMLIT_STAGE/swiftbite/ AUTO_COMPRESS=FALSE OVERWRITE=TRUE;
PUT 'file://oss-deploy-a-fleet-intelligence-solution-for-food-delivery/streamlit/environment.yml' @FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.STREAMLIT_STAGE/swiftbite/ AUTO_COMPRESS=FALSE OVERWRITE=TRUE;
PUT 'file://oss-deploy-a-fleet-intelligence-solution-for-food-delivery/streamlit/city_config.py' @FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.STREAMLIT_STAGE/swiftbite/ AUTO_COMPRESS=FALSE OVERWRITE=TRUE;
PUT 'file://oss-deploy-a-fleet-intelligence-solution-for-food-delivery/streamlit/pages/1_Courier_Routes.py' @FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.STREAMLIT_STAGE/swiftbite/pages/ AUTO_COMPRESS=FALSE OVERWRITE=TRUE;
PUT 'file://oss-deploy-a-fleet-intelligence-solution-for-food-delivery/streamlit/pages/2_Heat_Map.py' @FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.STREAMLIT_STAGE/swiftbite/pages/ AUTO_COMPRESS=FALSE OVERWRITE=TRUE;
PUT 'file://oss-deploy-a-fleet-intelligence-solution-for-food-delivery/streamlit/pages/3_Travel_Time_Matrix.py' @FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.STREAMLIT_STAGE/swiftbite/pages/ AUTO_COMPRESS=FALSE OVERWRITE=TRUE;
PUT 'file://oss-deploy-a-fleet-intelligence-solution-for-food-delivery/streamlit/pages/3_Travel_Time_Analysis.py' @FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.STREAMLIT_STAGE/swiftbite/pages/ AUTO_COMPRESS=FALSE OVERWRITE=TRUE;
```

Deploy:

```sql
CREATE STREAMLIT FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.SWIFTBITE_DELIVERY_DASHBOARD
  FROM '@FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.STREAMLIT_STAGE/swiftbite'
  MAIN_FILE = 'Delivery_Control_Center.py';
```

```sql
ALTER STREAMLIT FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.SWIFTBITE_DELIVERY_DASHBOARD
  SET QUERY_WAREHOUSE = 'COMPUTE_WH';
```

```sql
ALTER STREAMLIT FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.SWIFTBITE_DELIVERY_DASHBOARD ADD LIVE VERSION FROM LAST;
```

---

### Step 12: Deploy Fleet Intelligence React Native App

**Prerequisites:** Docker Desktop installed and running, `snow` CLI authenticated, `linux/amd64` platform support enabled.

> **Docker Provisioning Notes:**
> - Docker Desktop must be installed and running (macOS/Windows/Linux)
> - Ensure `linux/amd64` platform builds are enabled (Docker Desktop > Settings > General > "Use Rosetta for x86_64/amd64 emulation" on Apple Silicon)
> - All images must be built with `--platform linux/amd64` — SPCS only runs `linux/amd64` containers
> - Multi-stage Dockerfiles are recommended to keep image size small (builder + runtime stages)
> - The Fleet Intelligence app uses `node:20-slim` as the base image
> - Image tags must match exactly between `manifest.yml` (artifacts.container_services.images) and the service YAML (spec.containers[].image)
> - When updating an image, always use a NEW tag (e.g. v1.2 → v1.3) — SPCS caches images by tag and won't pick up changes to the same tag
> - To verify Docker is ready: `docker info` should show the server running
> - Registry login is per-session: `snow spcs image-registry login -c {CONNECTION_NAME}`

#### Sub-step 12a: Verify Dockerfile Port

Ensure the Dockerfile has `ENV PORT=8080` and `EXPOSE 8080`.

#### Sub-step 12b: Build Docker Image

```bash
cd oss-deploy-a-fleet-intelligence-solution-for-food-delivery/fleet-intelligence-app
docker build --platform linux/amd64 -t fleet-intelligence:v1.2 .
```

#### Sub-step 12c: Create Image Repository

```sql
CREATE DATABASE IF NOT EXISTS FLEET_INTELLIGENCE_SETUP;
CREATE IMAGE REPOSITORY IF NOT EXISTS FLEET_INTELLIGENCE_SETUP.PUBLIC.FLEET_INTEL_REPO;
```

```sql
SHOW IMAGE REPOSITORIES IN SCHEMA FLEET_INTELLIGENCE_SETUP.PUBLIC;
```

Extract `repository_url`: `<orgname>-<acctname>.registry.snowflakecomputing.com/fleet_intelligence_setup/public/fleet_intel_repo`

#### Sub-step 12d: Tag and Push All Docker Images

```bash
snow spcs image-registry login -c {CONNECTION_NAME}

docker tag fleet-intelligence:v1.2 {REPO_URL}/fleet-intelligence:v1.2
docker push {REPO_URL}/fleet-intelligence:v1.2

docker tag openrouteservice:v9.0.0 {REPO_URL}/openrouteservice:v9.0.0
docker push {REPO_URL}/openrouteservice:v9.0.0

docker tag vroom-docker:v1.0.1 {REPO_URL}/vroom-docker:v1.0.1
docker push {REPO_URL}/vroom-docker:v1.0.1

docker tag routing_reverse_proxy:v0.9.2 {REPO_URL}/routing_reverse_proxy:v0.9.2
docker push {REPO_URL}/routing_reverse_proxy:v0.9.2

docker tag downloader:v0.0.3 {REPO_URL}/downloader:v0.0.3
docker push {REPO_URL}/downloader:v0.0.3
```

#### Sub-step 12e: Create Application Package

```sql
CREATE APPLICATION PACKAGE IF NOT EXISTS FLEET_INTELLIGENCE_PKG;
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE_PKG.stage_content;
CREATE OR REPLACE STAGE FLEET_INTELLIGENCE_PKG.stage_content.app_code
    DIRECTORY = (ENABLE = TRUE) ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE');
```

#### Sub-step 12f: Upload Native App Files

```bash
APP_DIR="oss-deploy-a-fleet-intelligence-solution-for-food-delivery/fleet-intelligence-app/native-app"
snow stage copy "${APP_DIR}/manifest.yml" @FLEET_INTELLIGENCE_PKG.stage_content.app_code/ -c {CONNECTION_NAME} --overwrite
snow stage copy "${APP_DIR}/setup_script.sql" @FLEET_INTELLIGENCE_PKG.stage_content.app_code/ -c {CONNECTION_NAME} --overwrite
snow stage copy "${APP_DIR}/README.md" @FLEET_INTELLIGENCE_PKG.stage_content.app_code/ -c {CONNECTION_NAME} --overwrite
snow stage copy "${APP_DIR}/services/fleet_intelligence_service.yaml" @FLEET_INTELLIGENCE_PKG.stage_content.app_code/services/ -c {CONNECTION_NAME} --overwrite
snow stage copy "${APP_DIR}/streamlit/status.py" @FLEET_INTELLIGENCE_PKG.stage_content.app_code/streamlit/ -c {CONNECTION_NAME} --overwrite
```

#### Sub-step 12g: Register Version and Install

Use `REGISTER VERSION` (release channels enabled) or `ADD VERSION`:

```sql
ALTER APPLICATION PACKAGE FLEET_INTELLIGENCE_PKG
    REGISTER VERSION V1_2
    USING '@FLEET_INTELLIGENCE_PKG.stage_content.app_code';
```

If max versions error (512023), deregister an old version first:

```sql
SHOW VERSIONS IN APPLICATION PACKAGE FLEET_INTELLIGENCE_PKG;
ALTER APPLICATION PACKAGE FLEET_INTELLIGENCE_PKG DEREGISTER VERSION <OLD_VERSION>;
```

For release channel management, add the version to the channel and set the directive:

```sql
ALTER APPLICATION PACKAGE FLEET_INTELLIGENCE_PKG MODIFY RELEASE CHANNEL DEFAULT ADD VERSION V1_2;
ALTER APPLICATION PACKAGE FLEET_INTELLIGENCE_PKG MODIFY RELEASE CHANNEL DEFAULT SET DEFAULT RELEASE DIRECTIVE VERSION=V1_2 PATCH=0;
```

For first install:

```sql
CREATE APPLICATION FLEET_INTELLIGENCE_APP
    FROM APPLICATION PACKAGE FLEET_INTELLIGENCE_PKG
    USING VERSION V1_2;
```

For upgrade of existing app (created from specific version):

```sql
ALTER APPLICATION FLEET_INTELLIGENCE_APP UPGRADE USING VERSION V1_2;
```

#### Sub-step 12h: Grant Required Privileges

```sql
GRANT CREATE COMPUTE POOL ON ACCOUNT TO APPLICATION FLEET_INTELLIGENCE_APP;
GRANT CREATE WAREHOUSE ON ACCOUNT TO APPLICATION FLEET_INTELLIGENCE_APP;
GRANT BIND SERVICE ENDPOINT ON ACCOUNT TO APPLICATION FLEET_INTELLIGENCE_APP;
```

```sql
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO APPLICATION FLEET_INTELLIGENCE_APP;
```

```sql
GRANT USAGE ON DATABASE FLEET_INTELLIGENCE_SETUP TO APPLICATION FLEET_INTELLIGENCE_APP;
GRANT USAGE ON SCHEMA FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY TO APPLICATION FLEET_INTELLIGENCE_APP;
GRANT SELECT ON ALL TABLES IN SCHEMA FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY TO APPLICATION FLEET_INTELLIGENCE_APP;
GRANT SELECT ON ALL VIEWS IN SCHEMA FLEET_INTELLIGENCE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY TO APPLICATION FLEET_INTELLIGENCE_APP;
```

```sql
GRANT IMPORTED PRIVILEGES ON DATABASE OVERTURE_MAPS__PLACES TO APPLICATION FLEET_INTELLIGENCE_APP;
GRANT IMPORTED PRIVILEGES ON DATABASE OVERTURE_MAPS__ADDRESSES TO APPLICATION FLEET_INTELLIGENCE_APP;
```

```sql
GRANT APPLICATION ROLE FLEET_INTELLIGENCE_APP.APP_USER TO ROLE <YOUR_ROLE>;
```

#### Sub-step 12i: Create External Access Integration

```sql
CREATE OR REPLACE NETWORK RULE fleet_intel_map_tiles_rule
    MODE = EGRESS TYPE = HOST_PORT
    VALUE_LIST = ('a.basemaps.cartocdn.com:443', 'b.basemaps.cartocdn.com:443', 'c.basemaps.cartocdn.com:443', 'd.basemaps.cartocdn.com:443');
```

```sql
CREATE OR REPLACE EXTERNAL ACCESS INTEGRATION fleet_intel_map_tiles_eai
    ALLOWED_NETWORK_RULES = (fleet_intel_map_tiles_rule) ENABLED = TRUE;
```

```sql
GRANT USAGE ON INTEGRATION fleet_intel_map_tiles_eai TO APPLICATION FLEET_INTELLIGENCE_APP;
```

Bind the reference (**MUST** use `SYSTEM$REFERENCE()`, not raw name):

```sql
USE DATABASE FLEET_INTELLIGENCE_APP;
USE SCHEMA CORE;
CALL core.register_single_callback(
    'EXTERNAL_ACCESS_REF', 'ADD',
    SYSTEM$REFERENCE('EXTERNAL_ACCESS_INTEGRATION', 'FLEET_INTEL_MAP_TILES_EAI', 'persistent', 'USAGE')
);
```

#### Sub-step 12j: Deploy the Service

```sql
USE DATABASE FLEET_INTELLIGENCE_APP;
CALL core.deploy();
```

#### Sub-step 12k: Verify Deployment

```sql
SELECT SYSTEM$GET_SERVICE_STATUS('FLEET_INTELLIGENCE_APP.core.fleet_intelligence_service');
```

```sql
SHOW ENDPOINTS IN SERVICE FLEET_INTELLIGENCE_APP.core.fleet_intelligence_service;
```

The endpoint URL takes 2-3 minutes after READY to resolve.

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| ORS routes returning NULL | City not provisioned — run `ROUTING.CREATE_CITY_ORS_SERVICE()` |
| ORS routes failing | Check: `CALL SYSTEM$GET_SERVICE_LOGS('FLEET_INTELLIGENCE_APP.ROUTING.ORS_SERVICE', 0, 'ors', 50)` |
| No restaurants/addresses found | Verify Overture Maps shares installed (Step 1b) |
| Missing Overture data | `CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZT0Z4CM1E9KR')` then `CREATE DATABASE IF NOT EXISTS OVERTURE_MAPS__PLACES FROM LISTING GZT0Z4CM1E9KR` |
| Docker build fails | Ensure Docker running with linux/amd64 support |
| Image push fails | `snow spcs image-registry login -c {CONNECTION_NAME}` |
| `ADD VERSION` error 512020 | Use `REGISTER VERSION` (release channels enabled) |
| EAI bind fails "Object does not exist" | Must use `SYSTEM$REFERENCE()` handle |
| Endpoint "provisioning in progress" | Wait 2-3 minutes after READY |
| Data not showing after build | UI auto-refreshes when Data Builder completes — if stale, toggle city selector or reload page |
| Agent error "Unknown function SNOWFLAKE.CORTEX.COMPLETE" | `GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO APPLICATION FLEET_INTELLIGENCE_APP` |
| SPCS not picking up new image | Must use NEW tag and update manifest.yml + service YAML |
| `ADD PATCH` error 093359 | Manifest changes require full new VERSION (not patch) |
| Max versions error | Deregister old: `ALTER APPLICATION PACKAGE ... DEREGISTER VERSION ...` |

---

## Uninstall / Complete Teardown

To completely remove Fleet Intelligence and all associated resources, execute these steps in order. Each statement should be run separately.

> **WARNING:** This is destructive and irreversible. All data, services, compute pools, and application objects will be permanently deleted.

### Step 1: Drop the Application

This stops all SPCS services (UI, ORS, VROOM, downloader) and removes the app:

```sql
DROP APPLICATION IF EXISTS FLEET_INTELLIGENCE_APP CASCADE;
```

### Step 2: Drop Compute Pools

The app creates up to two compute pools. Drop them (they may take a moment to drain):

```sql
DROP COMPUTE POOL IF EXISTS FLEET_INTELLIGENCE_APP_compute_pool;
```

```sql
DROP COMPUTE POOL IF EXISTS FLEET_INTELLIGENCE_APP_routing_pool;
```

If the pools are still in use, suspend first:

```sql
ALTER COMPUTE POOL FLEET_INTELLIGENCE_APP_compute_pool SUSPEND;
ALTER COMPUTE POOL FLEET_INTELLIGENCE_APP_routing_pool SUSPEND;
```

Then retry the DROP after pools reach IDLE state.

### Step 3: Drop the Application Package

```sql
DROP APPLICATION PACKAGE IF EXISTS FLEET_INTELLIGENCE_PKG;
```

### Step 4: Drop External Access Integrations and Network Rules

```sql
DROP EXTERNAL ACCESS INTEGRATION IF EXISTS fleet_intel_map_tiles_eai;
DROP EXTERNAL ACCESS INTEGRATION IF EXISTS fleet_intel_download_eai;
DROP NETWORK RULE IF EXISTS fleet_intel_map_tiles_rule;
DROP NETWORK RULE IF EXISTS fleet_intel_download_rule;
```

### Step 5: Drop the Setup Database

This removes all generated data (restaurants, addresses, couriers, delivery routes, analytics views):

```sql
DROP DATABASE IF EXISTS FLEET_INTELLIGENCE_SETUP;
```

### Step 6: Drop the Warehouse (Optional)

Only drop if this warehouse was created specifically for Fleet Intelligence:

```sql
DROP WAREHOUSE IF EXISTS ROUTING_ANALYTICS;
```

### Step 7: Verify Cleanup

```sql
SHOW APPLICATIONS LIKE 'FLEET_INTELLIGENCE%';
SHOW APPLICATION PACKAGES LIKE 'FLEET_INTELLIGENCE%';
SHOW COMPUTE POOLS LIKE 'FLEET_INTELLIGENCE%';
SHOW DATABASES LIKE 'FLEET_INTELLIGENCE%';
SHOW EXTERNAL ACCESS INTEGRATIONS LIKE 'fleet_intel%';
```

All queries should return empty results.
