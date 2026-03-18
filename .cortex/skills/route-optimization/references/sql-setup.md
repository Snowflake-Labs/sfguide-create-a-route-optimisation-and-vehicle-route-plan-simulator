# SQL Setup Reference

SQL commands for Steps 1, 2, 4, and 5 of the route-optimization workflow.

## Step 1: Set Query Tag

```sql
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-route-optimization-demo","version":{"major":1, "minor":0},"attributes":{"is_quickstart":1, "source":"sql"}}';
```

## Step 2: Verify Services

Check services status:
```sql
SHOW SERVICES IN APPLICATION OPENROUTESERVICE_NATIVE_APP;
```

All 4 services must be running:
- `OPENROUTESERVICE` - Main routing engine
- `ROUTING_REVERSE_PROXY` - API gateway
- `VROOM` - Vehicle routing optimization
- `DOWNLOADER` - Map download service

Resume if not running:
```sql
ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.DOWNLOADER RESUME;
ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SERVICE RESUME;
ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.ROUTING_GATEWAY_SERVICE RESUME;
ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.VROOM_SERVICE RESUME;
```

## Step 4: Get Carto Overture Dataset

```sql
CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZT0Z4CM1E9KR');
CREATE DATABASE IF NOT EXISTS OVERTURE_MAPS__PLACES FROM LISTING GZT0Z4CM1E9KR;
```

Requires IMPORT SHARE privilege.

## Step 5: Setup Snowflake Objects

```sql
ALTER ACCOUNT SET CORTEX_ENABLED_CROSS_REGION = 'ANY_REGION';

CREATE DATABASE IF NOT EXISTS OPENROUTESERVICE_SETUP
    COMMENT = '{"origin":"sf_sit-is-fleet", "name":"oss-deploy-route-optimization-demo", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';

CREATE SCHEMA IF NOT EXISTS OPENROUTESERVICE_SETUP.VEHICLE_ROUTING_SIMULATOR
    COMMENT = '{"origin":"sf_sit-is-fleet", "name":"oss-deploy-route-optimization-demo", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';

CREATE WAREHOUSE IF NOT EXISTS ROUTING_ANALYTICS
    WAREHOUSE_SIZE = 'XSMALL'
    AUTO_SUSPEND = 60
    AUTO_RESUME = TRUE
    COMMENT = '{"origin":"sf_sit-is-fleet", "name":"oss-deploy-route-optimization-demo", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';
```
