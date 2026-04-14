# Retail Catchment SQL Pipeline

## Step 1: Set Query Tag

```sql
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-retail-catchment","version":{"major":1, "minor":0},"attributes":{"is_quickstart":1, "source":"sql"}}';
```

## Step 2: Verify OpenRouteService Installation
**2a. Resume suspended services:**

```sql
SHOW SERVICES IN DATABASE OPENROUTESERVICE_APP;
```

**2b. Resume suspended services:**

```sql
CALL OPENROUTESERVICE_APP.CORE.RESUME_ALL_SERVICES();
```

**2c. Verify ORS is healthy:**

```sql
SELECT OPENROUTESERVICE_APP.CORE.CHECK_HEALTH();
```

## Step 3: Get Carto Overture Datasets

**3a. Get Overture Maps Places (POI data):**

```sql
CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZT0Z4CM1E9KR');
CREATE DATABASE IF NOT EXISTS OVERTURE_MAPS__PLACES FROM LISTING GZT0Z4CM1E9KR;
```

**3b. Get Overture Maps Addresses (for H3 density):**

```sql
CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZT0Z4CM1E9NQ');
CREATE DATABASE IF NOT EXISTS OVERTURE_MAPS__ADDRESSES FROM LISTING GZT0Z4CM1E9NQ;
```

**3c. Verify datasets:**

```sql
SELECT COUNT(*) FROM OVERTURE_MAPS__PLACES.CARTO.PLACE LIMIT 1;
SELECT COUNT(*) FROM OVERTURE_MAPS__ADDRESSES.CARTO.ADDRESS WHERE COUNTRY = 'US' LIMIT 1;
```

## Step 4: Create Database, Schema, Warehouse, and CONFIG

```sql
CREATE WAREHOUSE IF NOT EXISTS ROUTING_ANALYTICS
    WAREHOUSE_SIZE = 'XSMALL'
    AUTO_SUSPEND = 60
    AUTO_RESUME = TRUE
    COMMENT = '{"origin":"sf_sit-is-fleet", "name":"oss-retail-catchment", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';

CREATE DATABASE IF NOT EXISTS FLEET_INTELLIGENCE
    COMMENT = '{"origin":"sf_sit-is-fleet", "name":"oss-retail-catchment", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';

CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.RETAIL_CATCHMENT
    COMMENT = '{"origin":"sf_sit-is-fleet", "name":"oss-retail-catchment", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';
```

```sql
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.RETAIL_CATCHMENT.CONFIG (
    VEHICLE_TYPE VARCHAR NOT NULL,
    REGION       VARCHAR NOT NULL
)
    COMMENT = '{"origin":"sf_sit-is-fleet", "name":"oss-retail-catchment", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';
MERGE INTO FLEET_INTELLIGENCE.RETAIL_CATCHMENT.CONFIG tgt
USING (SELECT 'ebike' AS VEHICLE_TYPE, 'SanFrancisco' AS REGION) src
ON TRUE
WHEN NOT MATCHED THEN INSERT (VEHICLE_TYPE, REGION) VALUES (src.VEHICLE_TYPE, src.REGION);
```

## Step 5: Create Optimized Data Tables

> **Execution note:** The SET variables in step 5a must persist across all sub-steps 5a-5e.
> When using the `snowflake_sql_execute` tool (which creates new sessions per call),
> prepend the SET statements to EACH SQL block that references `$REGION_KEY`, `$BBOX_*`, or `$REGION_NAME`.
> Alternatively, run the entire Step 5 as a single `snow sql -f` file.

**5a. Set bounding box configuration (customize for your region):**

```sql
SET REGION_KEY = 'SanFrancisco';
SET BBOX_MIN_LON = -123.0;
SET BBOX_MIN_LAT = 36.8;
SET BBOX_MAX_LON = -121.5;
SET BBOX_MAX_LAT = 38.5;
SET REGION_NAME = 'San Francisco Bay Area';
```

Common bounding boxes:
- San Francisco Bay Area: (-123.0, 36.8, -121.5, 38.5)
- New York Metro: (-74.5, 40.4, -73.5, 41.2)
- Los Angeles: (-118.8, 33.5, -117.5, 34.5)
- Chicago: (-88.5, 41.5, -87.2, 42.2)
- London: (-0.6, 51.2, 0.4, 51.8)

**5b. Create and populate filtered POI table:**

```sql
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.RETAIL_CATCHMENT.RETAIL_POIS (
    REGION          VARCHAR NOT NULL,
    POI_ID          VARCHAR,
    POI_NAME        VARCHAR,
    BASIC_CATEGORY  VARCHAR,
    LONGITUDE       FLOAT,
    LATITUDE        FLOAT,
    GEOMETRY        GEOGRAPHY,
    ADDRESS         VARCHAR,
    CITY            VARCHAR,
    STATE           VARCHAR,
    POSTCODE        VARCHAR
)
    COMMENT = '{"origin":"sf_sit-is-fleet", "name":"oss-retail-catchment", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';

DELETE FROM FLEET_INTELLIGENCE.RETAIL_CATCHMENT.RETAIL_POIS WHERE REGION = $REGION_KEY;
INSERT INTO FLEET_INTELLIGENCE.RETAIL_CATCHMENT.RETAIL_POIS
SELECT 
    $REGION_KEY AS REGION,
    ID AS POI_ID,
    NAMES:primary::VARCHAR AS POI_NAME,
    BASIC_CATEGORY,
    ST_X(GEOMETRY) AS LONGITUDE,
    ST_Y(GEOMETRY) AS LATITUDE,
    GEOMETRY,
    COALESCE(ADDRESSES[0]:freeform::VARCHAR, '') AS ADDRESS,
    ADDRESSES[0]:locality::VARCHAR AS CITY,
    ADDRESSES[0]:region::VARCHAR AS STATE,
    ADDRESSES[0]:postcode::VARCHAR AS POSTCODE
FROM OVERTURE_MAPS__PLACES.CARTO.PLACE
WHERE BASIC_CATEGORY IN (
    'coffee_shop', 'fast_food_restaurant', 'restaurant', 'casual_eatery',
    'grocery_store', 'convenience_store', 'gas_station', 'pharmacy',
    'clothing_store', 'electronics_store', 'specialty_store', 'gym',
    'beauty_salon', 'hair_salon', 'bakery', 'bar', 'supermarket'
)
AND GEOMETRY IS NOT NULL
AND ADDRESSES[0]:region IS NOT NULL
AND ST_X(GEOMETRY) BETWEEN $BBOX_MIN_LON AND $BBOX_MAX_LON
AND ST_Y(GEOMETRY) BETWEEN $BBOX_MIN_LAT AND $BBOX_MAX_LAT;
```

```sql
ALTER TABLE FLEET_INTELLIGENCE.RETAIL_CATCHMENT.RETAIL_POIS SET COMMENT = '{"origin":"sf_sit-is-fleet", "name":"oss-retail-catchment", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';
```

**5c. Create and populate pre-aggregated cities table:**

```sql
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.RETAIL_CATCHMENT.CITIES_BY_STATE (
    REGION    VARCHAR NOT NULL,
    STATE     VARCHAR,
    CITY      VARCHAR,
    POI_COUNT INT
)
    COMMENT = '{"origin":"sf_sit-is-fleet", "name":"oss-retail-catchment", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';

DELETE FROM FLEET_INTELLIGENCE.RETAIL_CATCHMENT.CITIES_BY_STATE WHERE REGION = $REGION_KEY;
INSERT INTO FLEET_INTELLIGENCE.RETAIL_CATCHMENT.CITIES_BY_STATE
SELECT 
    $REGION_KEY AS REGION,
    STATE,
    CITY,
    COUNT(*) AS POI_COUNT
FROM FLEET_INTELLIGENCE.RETAIL_CATCHMENT.RETAIL_POIS
WHERE CITY IS NOT NULL AND REGION = $REGION_KEY
GROUP BY STATE, CITY
HAVING COUNT(*) > 10
ORDER BY STATE, POI_COUNT DESC;
```

```sql
ALTER TABLE FLEET_INTELLIGENCE.RETAIL_CATCHMENT.CITIES_BY_STATE SET COMMENT = '{"origin":"sf_sit-is-fleet", "name":"oss-retail-catchment", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';
```

**5d. Create and populate addresses table within bounding box:**

```sql
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.RETAIL_CATCHMENT.REGIONAL_ADDRESSES (
    REGION    VARCHAR NOT NULL,
    ID        VARCHAR,
    GEOMETRY  GEOGRAPHY,
    LONGITUDE FLOAT,
    LATITUDE  FLOAT,
    CITY      VARCHAR,
    POSTCODE  VARCHAR
)
    COMMENT = '{"origin":"sf_sit-is-fleet", "name":"oss-retail-catchment", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';

DELETE FROM FLEET_INTELLIGENCE.RETAIL_CATCHMENT.REGIONAL_ADDRESSES WHERE REGION = $REGION_KEY;
INSERT INTO FLEET_INTELLIGENCE.RETAIL_CATCHMENT.REGIONAL_ADDRESSES
SELECT 
    $REGION_KEY AS REGION,
    ID,
    GEOMETRY,
    ST_X(GEOMETRY) AS LONGITUDE,
    ST_Y(GEOMETRY) AS LATITUDE,
    POSTAL_CITY AS CITY,
    POSTCODE
FROM OVERTURE_MAPS__ADDRESSES.CARTO.ADDRESS
WHERE COUNTRY = 'US'
AND GEOMETRY IS NOT NULL
AND ST_X(GEOMETRY) BETWEEN $BBOX_MIN_LON AND $BBOX_MAX_LON
AND ST_Y(GEOMETRY) BETWEEN $BBOX_MIN_LAT AND $BBOX_MAX_LAT;
```

```sql
ALTER TABLE FLEET_INTELLIGENCE.RETAIL_CATCHMENT.REGIONAL_ADDRESSES SET COMMENT = '{"origin":"sf_sit-is-fleet", "name":"oss-retail-catchment", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';
```

**5e. Store region configuration:**

```sql
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.RETAIL_CATCHMENT.REGION_CONFIG (
    REGION        VARCHAR NOT NULL,
    REGION_NAME   VARCHAR,
    BBOX_MIN_LON  FLOAT,
    BBOX_MIN_LAT  FLOAT,
    BBOX_MAX_LON  FLOAT,
    BBOX_MAX_LAT  FLOAT,
    CREATED_AT    TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
)
    COMMENT = '{"origin":"sf_sit-is-fleet", "name":"oss-retail-catchment", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';

DELETE FROM FLEET_INTELLIGENCE.RETAIL_CATCHMENT.REGION_CONFIG WHERE REGION = $REGION_KEY;
INSERT INTO FLEET_INTELLIGENCE.RETAIL_CATCHMENT.REGION_CONFIG
SELECT 
    $REGION_KEY AS REGION,
    $REGION_NAME AS REGION_NAME,
    $BBOX_MIN_LON AS BBOX_MIN_LON,
    $BBOX_MIN_LAT AS BBOX_MIN_LAT,
    $BBOX_MAX_LON AS BBOX_MAX_LON,
    $BBOX_MAX_LAT AS BBOX_MAX_LAT,
    CURRENT_TIMESTAMP() AS CREATED_AT;
```

```sql
ALTER TABLE FLEET_INTELLIGENCE.RETAIL_CATCHMENT.REGION_CONFIG SET COMMENT = '{"origin":"sf_sit-is-fleet", "name":"oss-retail-catchment", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';
```

**5f. Add search optimization:**

```sql
ALTER TABLE FLEET_INTELLIGENCE.RETAIL_CATCHMENT.RETAIL_POIS ADD SEARCH OPTIMIZATION ON EQUALITY(STATE, CITY, BASIC_CATEGORY);
ALTER TABLE FLEET_INTELLIGENCE.RETAIL_CATCHMENT.REGIONAL_ADDRESSES ADD SEARCH OPTIMIZATION ON GEO(GEOMETRY);
ALTER TABLE FLEET_INTELLIGENCE.RETAIL_CATCHMENT.CITIES_BY_STATE ADD SEARCH OPTIMIZATION ON EQUALITY(STATE);
```

**5g. Add clustering:**

```sql
ALTER TABLE FLEET_INTELLIGENCE.RETAIL_CATCHMENT.RETAIL_POIS CLUSTER BY (STATE, CITY, BASIC_CATEGORY);
ALTER TABLE FLEET_INTELLIGENCE.RETAIL_CATCHMENT.REGIONAL_ADDRESSES CLUSTER BY (LONGITUDE, LATITUDE);
```

**5h. Verify tables:**

```sql
SELECT 'RETAIL_POIS' AS TABLE_NAME, COUNT(*) AS ROW_COUNT FROM FLEET_INTELLIGENCE.RETAIL_CATCHMENT.RETAIL_POIS
UNION ALL
SELECT 'CITIES_BY_STATE', COUNT(*) FROM FLEET_INTELLIGENCE.RETAIL_CATCHMENT.CITIES_BY_STATE
UNION ALL
SELECT 'REGIONAL_ADDRESSES', COUNT(*) FROM FLEET_INTELLIGENCE.RETAIL_CATCHMENT.REGIONAL_ADDRESSES;
```


