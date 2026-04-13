# SQL Setup Reference

SQL commands for Steps 1, 2, and 4 of the route-optimization workflow.
Step 5 (database, schema, warehouse, tables, grants) is handled by `seed-data.sql`.

## Step 1: Set Query Tag

```sql
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-route-optimization","version":{"major":1, "minor":0},"attributes":{"is_quickstart":1, "source":"sql"}}';
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
CALL OPENROUTESERVICE_NATIVE_APP.CORE.RESUME_ALL_SERVICES();
-- Verify:
SELECT OPENROUTESERVICE_NATIVE_APP.CORE.CHECK_HEALTH();
```

## Step 4: Get Carto Overture Dataset

```sql
CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZT0Z4CM1E9KR');
CREATE DATABASE IF NOT EXISTS OVERTURE_MAPS__PLACES FROM LISTING GZT0Z4CM1E9KR;
```

Requires IMPORT SHARE privilege.
