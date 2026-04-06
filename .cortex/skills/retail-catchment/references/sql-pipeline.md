# Retail Catchment SQL Pipeline

## Step 1: Set Query Tag

```sql
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-retail-catchment","version":{"major":1, "minor":0},"attributes":{"is_quickstart":1, "source":"sql"}}';
```

## Step 2: Verify OpenRouteService Installation

**2a. Check ORS application exists:**

```sql
SHOW APPLICATIONS LIKE '%OPENROUTESERVICE%';
```

**2b. Verify services are running:**

```sql
SHOW SERVICES IN APPLICATION OPENROUTESERVICE_NATIVE_APP;
```

**2c. Resume suspended services:**

```sql
CALL OPENROUTESERVICE_NATIVE_APP.CORE.RESUME_ALL_SERVICES();
```

**2d. Verify ORS is healthy:**

```sql
SELECT OPENROUTESERVICE_NATIVE_APP.CORE.CHECK_HEALTH();
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

## Step 4: Create Database, Schema, and Warehouse

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

CREATE STAGE IF NOT EXISTS FLEET_INTELLIGENCE.RETAIL_CATCHMENT.STREAMLIT_STAGE
    DIRECTORY = (ENABLE = TRUE)
    COMMENT = '{"origin":"sf_sit-is-fleet", "name":"oss-retail-catchment", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';
```

## Step 5: Create Optimized Data Tables

**5a. Set bounding box configuration (customize for your region):**

```sql
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

**5b. Create filtered POI table:**

```sql
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.RETAIL_CATCHMENT.RETAIL_POIS AS
SELECT 
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

**5c. Create pre-aggregated cities table:**

```sql
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.RETAIL_CATCHMENT.CITIES_BY_STATE AS
SELECT 
    STATE,
    CITY,
    COUNT(*) AS POI_COUNT
FROM FLEET_INTELLIGENCE.RETAIL_CATCHMENT.RETAIL_POIS
WHERE CITY IS NOT NULL
GROUP BY STATE, CITY
HAVING COUNT(*) > 10
ORDER BY STATE, POI_COUNT DESC;
```

```sql
ALTER TABLE FLEET_INTELLIGENCE.RETAIL_CATCHMENT.CITIES_BY_STATE SET COMMENT = '{"origin":"sf_sit-is-fleet", "name":"oss-retail-catchment", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';
```

**5d. Create addresses table within bounding box:**

```sql
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.RETAIL_CATCHMENT.REGIONAL_ADDRESSES AS
SELECT 
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
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.RETAIL_CATCHMENT.REGION_CONFIG AS
SELECT 
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

## Step 6: Upload Streamlit Files

```bash
snow stage copy assets/streamlit/retail_catchment.py @FLEET_INTELLIGENCE.RETAIL_CATCHMENT.STREAMLIT_STAGE --overwrite
snow stage copy assets/streamlit/environment.yml @FLEET_INTELLIGENCE.RETAIL_CATCHMENT.STREAMLIT_STAGE --overwrite
snow stage copy assets/streamlit/extra.css @FLEET_INTELLIGENCE.RETAIL_CATCHMENT.STREAMLIT_STAGE --overwrite
snow stage copy assets/streamlit/logo.svg @FLEET_INTELLIGENCE.RETAIL_CATCHMENT.STREAMLIT_STAGE --overwrite
snow stage copy assets/streamlit/config.toml @FLEET_INTELLIGENCE.RETAIL_CATCHMENT.STREAMLIT_STAGE --overwrite
```

Verify:

```sql
LIST @FLEET_INTELLIGENCE.RETAIL_CATCHMENT.STREAMLIT_STAGE;
```

## Step 7: Create Streamlit App

```sql
CREATE OR REPLACE STREAMLIT FLEET_INTELLIGENCE.RETAIL_CATCHMENT.RETAIL_CATCHMENT_APP
    FROM @FLEET_INTELLIGENCE.RETAIL_CATCHMENT.STREAMLIT_STAGE
    MAIN_FILE = 'retail_catchment.py'
    QUERY_WAREHOUSE = 'ROUTING_ANALYTICS'
    TITLE = 'Retail Catchment Application'
    COMMENT = '{"origin":"sf_sit-is-fleet", "name":"oss-retail-catchment", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"streamlit"}}';

ALTER STREAMLIT FLEET_INTELLIGENCE.RETAIL_CATCHMENT.RETAIL_CATCHMENT_APP ADD LIVE VERSION FROM LAST;
```

## Step 8: Verify and Launch

```sql
SHOW STREAMLITS IN SCHEMA FLEET_INTELLIGENCE.RETAIL_CATCHMENT;

SELECT CONCAT('https://app.snowflake.com/', CURRENT_ORGANIZATION_NAME(), '/', CURRENT_ACCOUNT_NAME(), '/#/streamlit-apps/FLEET_INTELLIGENCE.RETAIL_CATCHMENT.RETAIL_CATCHMENT_APP') AS streamlit_url;
```
