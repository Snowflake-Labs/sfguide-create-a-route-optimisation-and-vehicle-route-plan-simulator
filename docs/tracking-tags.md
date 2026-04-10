# Tracking Tags Reference

This document describes the tracking tag system used across all skills in this repository. It is designed to be self-contained so that Cortex Code (or any other AI agent) can read it and build internal Snowflake dashboards for monitoring solution usage, cost attribution, and object lifecycle.

## Overview

Every skill in this repository uses two complementary tracking mechanisms:

1. **Session `query_tag`** -- a JSON string set via `ALTER SESSION SET query_tag` at the start of every SQL session. This tags every query executed in that session in `SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY`.
2. **Object `COMMENT`** -- a JSON string attached to every Snowflake object created by a skill. This enables object discovery via `INFORMATION_SCHEMA` and `SHOW` commands.

Both mechanisms use the same origin identifier: `sf_sit-is-fleet`.

### Why Two Mechanisms?

| Mechanism | Tracks | Queryable Via | Use Case |
|-----------|--------|---------------|----------|
| `query_tag` | Queries (SELECT, INSERT, CALL, etc.) | `QUERY_HISTORY` | Cost attribution, query volume, performance analysis |
| Object `COMMENT` | Created objects (TABLE, VIEW, etc.) | `INFORMATION_SCHEMA`, `SHOW` | Object inventory, cleanup automation, lifecycle tracking |

Together they provide full observability: which skill created which objects, and which skill ran which queries.

## Tag Formats

### Skill-Level Tags

Used by all deployment/demo skills (everything except native app internal modules).

#### query_tag Format

```sql
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-<skill-name>","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

#### Object COMMENT Format

```sql
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-<skill-name>","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"<sql|notebook|native-app>"}}';
```

For CTAS (CREATE TABLE AS SELECT) or objects that don't support inline COMMENT:

```sql
CREATE TABLE ... AS SELECT ...;
ALTER TABLE <name> SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-<skill-name>","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

#### JSON Schema (Skill-Level)

```json
{
  "origin": "sf_sit-is-fleet",
  "name": "oss-<skill-tracking-name>",
  "version": {
    "major": 1,
    "minor": 0
  },
  "attributes": {
    "is_quickstart": 1,
    "source": "<sql|notebook|native-app>"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `origin` | string | Always `sf_sit-is-fleet`. Global identifier for this solution. |
| `name` | string | Skill tracking name, prefixed with `oss-`. Unique per skill. |
| `version.major` | integer | Major version of the skill. |
| `version.minor` | integer | Minor version of the skill. |
| `attributes.is_quickstart` | integer | Always `1`. Indicates this is a quickstart/demo asset. |
| `attributes.source` | string | How the object was created: `sql`, `notebook`, or `native-app`. |

### Native App Module Tags

Used by objects created inside the ORS native app (`OPENROUTESERVICE_NATIVE_APP`).

```sql
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"<1.0|2.0>","attributes":{"component":"<component>"}}';
```

#### JSON Schema (Native App)

```json
{
  "origin": "sf_sit-is-fleet",
  "name": "build-routing-solution",
  "version": "<1.0|2.0>",
  "attributes": {
    "component": "<core|routing|provisioner|multi-city|lifecycle|matrix|ui>"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `origin` | string | Always `sf_sit-is-fleet`. |
| `name` | string | Always `build-routing-solution` for native app objects. |
| `version` | string | Version string (note: string, not object -- differs from skill-level format). |
| `attributes.component` | string | Which module created the object. See component mapping below. |

#### Native App Component Mapping

| Module File | Component Tag | Objects |
|-------------|---------------|---------|
| `01_core_infra.sql` | `core` | Compute pool, stages, services (downloader, ORS, VROOM, gateway), VERSION_INFO table |
| `02_routing_functions.sql` | `routing` | All routing functions (DIRECTIONS, ISOCHRONES, OPTIMIZATION, MATRIX, etc.), MAP_CONFIG table |
| `03_city_management.sql` | `provisioner` | CITY_PROVISION_JOBS table, provisioning procedures |
| `03_city_management.sql` | `multi-city` | CITY_ORS_MAP table, per-region ORS services, city management procedures |
| `04_service_lifecycle.sql` | `lifecycle` | Resume, suspend, scale, status procedures |
| `05_matrix_pipeline.sql` | `matrix` | Matrix build procedures, hexagon/queue/raw tables |
| `06_matrix_ops.sql` | `matrix` | Matrix status, inventory, delete, restore procedures |
| `01_core_infra.sql` | `ui` | ORS Control App service, Streamlit control_app |

## Per-Skill Object Inventory

### build-routing-solution

**Tracking name:** `oss-build-routing-solution-in-snowflake`

| Object | Type | Location |
|--------|------|----------|
| `OPENROUTESERVICE_SETUP` | Database | Account |
| `OPENROUTESERVICE_SETUP.PUBLIC.ORS_SPCS_STAGE` | Stage | Database |
| `OPENROUTESERVICE_SETUP.PUBLIC.ORS_GRAPHS_SPCS_STAGE` | Stage | Database |
| `OPENROUTESERVICE_SETUP.PUBLIC.ORS_ELEVATION_CACHE_SPCS_STAGE` | Stage | Database |
| `OPENROUTESERVICE_SETUP.PUBLIC.IMAGE_REPOSITORY` | Image Repository | Database |
| `ROUTING_ANALYTICS` | Warehouse | Account |
| `OPENROUTESERVICE_SETUP.PUBLIC.SEED_DATA_STAGE` | Stage | Database |
| `SYNTHETIC_DATASETS` | Database | Account |
| `SYNTHETIC_DATASETS.UNIFIED` | Schema | Database |
| `FLEET_INTELLIGENCE` | Database | Account |
| `FLEET_INTELLIGENCE.CORE` | Schema | Database |

### fleet-intelligence-taxis

**Tracking name:** `oss-fleet-intelligence-taxis`

| Object | Type | Location |
|--------|------|----------|
| `FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS` | Schema | Database |
| `FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.STREAMLIT_STAGE` | Stage | Schema |
| `FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.CONFIG` | Table | Schema |
| `FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TAXI_LOCATIONS` | Table | Schema |
| `FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TAXI_DRIVERS` | Table | Schema |
| `FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TAXI_LOCATIONS_NUMBERED` | Table | Schema |
| `FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_TRIPS` | Table | Schema |
| `FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_TRIPS_WITH_COORDS` | Table | Schema |
| `FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_ROUTES` | Table | Schema |
| `FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_ROUTES_PARSED` | Table | Schema |
| `FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_ROUTE_GEOMETRIES` | Table | Schema |
| `FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_LOCATIONS` | Table | Schema |
| `FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.DRIVER_LOCATIONS_V` | View | Schema |
| `FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TRIPS_ASSIGNED_TO_DRIVERS` | View | Schema |
| `FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.ROUTE_NAMES` | View | Schema |
| `FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TRIP_ROUTE_PLAN` | View | Schema |
| `FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TRIP_SUMMARY` | View | Schema |
| `FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.VW_DRIVER_LOCATIONS` | View | Schema |
| `FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.VW_TRIP_SUMMARY` | View | Schema |

### fleet-intelligence-food-delivery

**Tracking name:** `oss-fleet-intelligence-food-delivery`

| Object | Type | Location |
|--------|------|----------|
| `FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY` | Schema | Database |
| `FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.CONFIG` | Table | Schema |
| `FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERIES` | View | Schema |
| `FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.RESTAURANTS_ENRICHED` | View | Schema |

### retail-catchment

**Tracking name:** `oss-retail-catchment`

| Object | Type | Location |
|--------|------|----------|
| `FLEET_INTELLIGENCE.RETAIL_CATCHMENT` | Schema | Database |
| `FLEET_INTELLIGENCE.RETAIL_CATCHMENT.STREAMLIT_STAGE` | Stage | Schema |
| `FLEET_INTELLIGENCE.RETAIL_CATCHMENT.RETAIL_POIS` | Table | Schema |
| `FLEET_INTELLIGENCE.RETAIL_CATCHMENT.CITIES_BY_STATE` | Table | Schema |
| `FLEET_INTELLIGENCE.RETAIL_CATCHMENT.REGIONAL_ADDRESSES` | Table | Schema |
| `FLEET_INTELLIGENCE.RETAIL_CATCHMENT.REGION_CONFIG` | Table | Schema |

### route-deviation

**Tracking name:** `oss-route-deviation`

| Object | Type | Location |
|--------|------|----------|
| `FLEET_INTELLIGENCE.ROUTE_DEVIATION` | Schema | Database |
| `FLEET_INTELLIGENCE.ROUTE_DEVIATION.CONFIG` | Table | Schema |
| `FLEET_INTELLIGENCE.ROUTE_DEVIATION.VW_VEHICLE_TELEMETRY` | View | Schema |
| `FLEET_INTELLIGENCE.ROUTE_DEVIATION.VW_TRIP_DEVIATION` | View | Schema |
| `FLEET_INTELLIGENCE.ROUTE_DEVIATION.VW_FLEET` | View | Schema |
| `FLEET_INTELLIGENCE.ROUTE_DEVIATION.VW_TRIP_SCHEDULE` | View | Schema |
| `FLEET_INTELLIGENCE.ROUTE_DEVIATION.VW_POIS` | View | Schema |
| `FLEET_INTELLIGENCE.ROUTE_DEVIATION.TRIP_DEVIATION_ANALYSIS` | Table | Schema |
| `FLEET_INTELLIGENCE.ROUTE_DEVIATION.DRIVER_DEVIATION_SUMMARY` | Table | Schema |
| `FLEET_INTELLIGENCE.ROUTE_DEVIATION.DAILY_DEVIATION_TRENDS` | Table | Schema |

### route-optimization

**Tracking name:** `oss-route-optimization`

| Object | Type | Location |
|--------|------|----------|
| `FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION` | Schema | Database |
| `FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.NOTEBOOK` | Stage | Schema |
| `FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP` | Table | Schema |
| `FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES` | Table | Schema |
| `FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.JOB_TEMPLATE` | Table | Schema |
| `FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.REGION_DATA` | Table | Schema |
| Notebook: `ADD_CARTO_DATA` | Notebook | Schema |
| Notebook: `ROUTING_FUNCTIONS_AISQL` | Notebook | Schema |

### dwell-analysis

**Tracking name:** `oss-dwell-analysis`

| Object | Type | Location |
|--------|------|----------|
| `FLEET_INTELLIGENCE.DWELL_ANALYSIS` | Schema | Database |
| `FLEET_INTELLIGENCE.DWELL_ANALYSIS.CONFIG` | Table | Schema |
| `FLEET_INTELLIGENCE.DWELL_ANALYSIS.SLA_THRESHOLDS` | Table | Schema |
| `FLEET_INTELLIGENCE.DWELL_ANALYSIS.SLA_ALERT_LOG` | Table | Schema |
| `FLEET_INTELLIGENCE.DWELL_ANALYSIS.GEOFENCE_POLYGONS` | Table | Schema |
| `FLEET_INTELLIGENCE.DWELL_ANALYSIS.VW_VEHICLE_TELEMETRY` | View | Schema |
| `FLEET_INTELLIGENCE.DWELL_ANALYSIS.VW_VEHICLE_FLEET` | View | Schema |
| `FLEET_INTELLIGENCE.DWELL_ANALYSIS.VW_DESTINATIONS` | View | Schema |
| `FLEET_INTELLIGENCE.DWELL_ANALYSIS.VW_REST_STOPS` | View | Schema |
| `FLEET_INTELLIGENCE.DWELL_ANALYSIS.VW_TRIP_SCHEDULE` | View | Schema |
| `FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_STATE_CHANGES` | Dynamic Table | Schema |
| `FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DWELL_SESSIONS` | Dynamic Table | Schema |
| `FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DWELL_ENRICHED` | Dynamic Table | Schema |
| `FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_H3_CONGESTION` | Dynamic Table | Schema |
| `FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_SLA_ALERTS` | Dynamic Table | Schema |
| `FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_FACILITY_UTILIZATION` | Dynamic Table | Schema |
| `FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DRIVER_DWELL_SUMMARY` | Dynamic Table | Schema |
| `FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DAILY_TRENDS` | Dynamic Table | Schema |
| `FLEET_INTELLIGENCE.DWELL_ANALYSIS.LOG_SLA_ALERTS` | Task | Schema |

### routing-agent

**Tracking name:** `oss-deploy-snowflake-intelligence-routing-agent`

| Object | Type | Location |
|--------|------|----------|
| `FLEET_INTELLIGENCE.ROUTING_AGENT` | Schema | Database |
| `FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_DIRECTIONS` | Procedure | Schema |
| `FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ISOCHRONE` | Procedure | Schema |
| `FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_OPTIMIZATION` | Procedure | Schema |
| `FLEET_INTELLIGENCE.ROUTING_AGENT.ROUTING_AGENT` | Cortex Agent | Schema |

### travel-time-matrix

**Tracking name:** `oss-travel-time-matrix`

| Object | Type | Location |
|--------|------|----------|
| `<DB>.TRAVEL_TIME_MATRIX` | Schema | Database |
| `ROUTING_ANALYTICS` | Warehouse | Account |
| `FLATTEN_WH` | Warehouse | Account |
| `<DB>.TRAVEL_TIME_MATRIX.<REGION>_H3_RES<N>` | Table (dynamic) | Schema |
| `<DB>.TRAVEL_TIME_MATRIX.<REGION>_WORK_QUEUE_RES<N>` | Table (dynamic) | Schema |
| `<DB>.TRAVEL_TIME_MATRIX.<REGION>_MATRIX_RAW_RES<N>` | Table (dynamic) | Schema |
| `<DB>.TRAVEL_TIME_MATRIX.<REGION>_TRAVEL_TIME_RES<N>` | Table (dynamic) | Schema |
| `<DB>.TRAVEL_TIME_MATRIX.BUILD_TRAVEL_TIME_RANGE` | Procedure | Schema |
| `<DB>.TRAVEL_TIME_MATRIX.FLATTEN_MATRIX_RAW` | Procedure | Schema |
| `<DB>.TRAVEL_TIME_MATRIX.CREATE_MATRIX_DAG` | Procedure | Schema |
| `<DB>.TRAVEL_TIME_MATRIX.START_MATRIX_DAG` | Procedure | Schema |
| `<DB>.TRAVEL_TIME_MATRIX.STOP_MATRIX_DAG` | Procedure | Schema |
| `<DB>.TRAVEL_TIME_MATRIX.TASK_BUILD_QUEUE_<REGION>_RES<N>` | Task (dynamic) | Schema |
| `<DB>.TRAVEL_TIME_MATRIX.TASK_WORKER_<REGION>_RES<N>_<NN>` | Task (dynamic, x N workers) | Schema |
| `<DB>.TRAVEL_TIME_MATRIX.TASK_FLATTEN_<REGION>_RES<N>` | Task (dynamic) | Schema |

### cleanup

**Tracking name:** `oss-cleanup`

Creates no objects. This skill discovers and removes objects created by other skills.

## Dashboard SQL Queries

The following queries can be used to build Snowflake dashboards for monitoring the solution.

### Query 1: All Tagged Objects by Skill (Tables and Views)

```sql
SELECT
    TABLE_CATALOG AS DATABASE_NAME,
    TABLE_SCHEMA AS SCHEMA_NAME,
    TABLE_NAME AS OBJECT_NAME,
    TABLE_TYPE AS OBJECT_TYPE,
    PARSE_JSON(COMMENT):origin::STRING AS ORIGIN,
    PARSE_JSON(COMMENT):name::STRING AS SKILL_NAME,
    PARSE_JSON(COMMENT):version AS VERSION,
    PARSE_JSON(COMMENT):attributes:source::STRING AS SOURCE_TYPE,
    PARSE_JSON(COMMENT):attributes:component::STRING AS COMPONENT,
    CREATED AS CREATED_AT,
    LAST_ALTERED AS LAST_MODIFIED
FROM SNOWFLAKE.ACCOUNT_USAGE.TABLES
WHERE DELETED IS NULL
  AND COMMENT LIKE '%sf_sit-is-fleet%'
ORDER BY SKILL_NAME, DATABASE_NAME, SCHEMA_NAME, OBJECT_NAME;
```

### Query 2: Object Count by Skill

```sql
SELECT
    PARSE_JSON(COMMENT):name::STRING AS SKILL_NAME,
    TABLE_TYPE AS OBJECT_TYPE,
    COUNT(*) AS OBJECT_COUNT
FROM SNOWFLAKE.ACCOUNT_USAGE.TABLES
WHERE DELETED IS NULL
  AND COMMENT LIKE '%sf_sit-is-fleet%'
GROUP BY 1, 2
ORDER BY 1, 2;
```

### Query 3: All Queries by Skill (from QUERY_HISTORY)

```sql
SELECT
    PARSE_JSON(QUERY_TAG):name::STRING AS SKILL_NAME,
    PARSE_JSON(QUERY_TAG):attributes:source::STRING AS SOURCE_TYPE,
    DATE_TRUNC('day', START_TIME) AS QUERY_DATE,
    COUNT(*) AS QUERY_COUNT,
    SUM(TOTAL_ELAPSED_TIME) / 1000 AS TOTAL_ELAPSED_SECS,
    SUM(CREDITS_USED_CLOUD_SERVICES) AS CLOUD_CREDITS
FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
WHERE QUERY_TAG LIKE '%sf_sit-is-fleet%'
  AND START_TIME >= DATEADD('day', -30, CURRENT_TIMESTAMP())
GROUP BY 1, 2, 3
ORDER BY 3 DESC, 1;
```

### Query 4: Cost Attribution by Skill (Credits)

```sql
SELECT
    PARSE_JSON(QUERY_TAG):name::STRING AS SKILL_NAME,
    WAREHOUSE_NAME,
    DATE_TRUNC('week', START_TIME) AS WEEK,
    COUNT(*) AS QUERY_COUNT,
    ROUND(SUM(CREDITS_USED_CLOUD_SERVICES), 4) AS CLOUD_CREDITS,
    ROUND(AVG(TOTAL_ELAPSED_TIME) / 1000, 2) AS AVG_ELAPSED_SECS,
    ROUND(MAX(TOTAL_ELAPSED_TIME) / 1000, 2) AS MAX_ELAPSED_SECS
FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
WHERE QUERY_TAG LIKE '%sf_sit-is-fleet%'
  AND START_TIME >= DATEADD('day', -90, CURRENT_TIMESTAMP())
GROUP BY 1, 2, 3
ORDER BY 3 DESC, 5 DESC;
```

### Query 5: Object Lifecycle (Recently Created/Modified)

```sql
SELECT
    PARSE_JSON(COMMENT):name::STRING AS SKILL_NAME,
    TABLE_CATALOG || '.' || TABLE_SCHEMA || '.' || TABLE_NAME AS FULL_NAME,
    TABLE_TYPE,
    CREATED,
    LAST_ALTERED,
    DATEDIFF('day', CREATED, CURRENT_TIMESTAMP()) AS AGE_DAYS
FROM SNOWFLAKE.ACCOUNT_USAGE.TABLES
WHERE DELETED IS NULL
  AND COMMENT LIKE '%sf_sit-is-fleet%'
ORDER BY CREATED DESC
LIMIT 50;
```

### Query 6: Tagged Warehouses

```sql
SHOW WAREHOUSES;
SELECT
    "name" AS WAREHOUSE_NAME,
    PARSE_JSON("comment"):name::STRING AS SKILL_NAME,
    "size" AS WAREHOUSE_SIZE,
    "state" AS STATE,
    "auto_suspend" AS AUTO_SUSPEND_SECS
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
WHERE "comment" LIKE '%sf_sit-is-fleet%';
```

### Query 7: Tagged Stages

```sql
SHOW STAGES IN DATABASE FLEET_INTELLIGENCE;
SELECT
    "database_name" AS DB,
    "schema_name" AS SCHEMA,
    "name" AS STAGE_NAME,
    PARSE_JSON("comment"):name::STRING AS SKILL_NAME
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
WHERE "comment" LIKE '%sf_sit-is-fleet%';
```

### Query 8: Tagged Procedures and Functions

```sql
SELECT
    FUNCTION_CATALOG AS DATABASE_NAME,
    FUNCTION_SCHEMA AS SCHEMA_NAME,
    FUNCTION_NAME,
    DATA_TYPE AS RETURN_TYPE,
    PARSE_JSON(COMMENT):name::STRING AS SKILL_NAME,
    PARSE_JSON(COMMENT):attributes:component::STRING AS COMPONENT
FROM SNOWFLAKE.ACCOUNT_USAGE.FUNCTIONS
WHERE DELETED IS NULL
  AND COMMENT LIKE '%sf_sit-is-fleet%'
ORDER BY SKILL_NAME, FUNCTION_NAME;
```

### Query 9: Tagged Schemas

```sql
SHOW SCHEMAS IN DATABASE FLEET_INTELLIGENCE;
SELECT
    "database_name" AS DB,
    "name" AS SCHEMA_NAME,
    PARSE_JSON("comment"):name::STRING AS SKILL_NAME
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
WHERE "comment" LIKE '%sf_sit-is-fleet%';
```

### Query 10: Tagged Databases

```sql
SHOW DATABASES;
SELECT
    "name" AS DATABASE_NAME,
    PARSE_JSON("comment"):name::STRING AS SKILL_NAME,
    "created_on"
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
WHERE "comment" LIKE '%sf_sit-is-fleet%';
```

### Query 11: Native App Objects by Component

```sql
SELECT
    PARSE_JSON(COMMENT):attributes:component::STRING AS COMPONENT,
    TABLE_TYPE AS OBJECT_TYPE,
    TABLE_NAME AS OBJECT_NAME,
    PARSE_JSON(COMMENT):version::STRING AS VERSION
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_CATALOG = 'OPENROUTESERVICE_NATIVE_APP'
  AND COMMENT LIKE '%sf_sit-is-fleet%'
ORDER BY COMPONENT, OBJECT_TYPE, OBJECT_NAME;
```

### Query 12: Cross-Reference Objects vs Queries

Correlate which skills have active queries vs deployed objects:

```sql
WITH objects AS (
    SELECT DISTINCT PARSE_JSON(COMMENT):name::STRING AS SKILL_NAME
    FROM SNOWFLAKE.ACCOUNT_USAGE.TABLES
    WHERE DELETED IS NULL AND COMMENT LIKE '%sf_sit-is-fleet%'
),
queries AS (
    SELECT
        PARSE_JSON(QUERY_TAG):name::STRING AS SKILL_NAME,
        COUNT(*) AS QUERY_COUNT_30D,
        MAX(START_TIME) AS LAST_QUERY
    FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
    WHERE QUERY_TAG LIKE '%sf_sit-is-fleet%'
      AND START_TIME >= DATEADD('day', -30, CURRENT_TIMESTAMP())
    GROUP BY 1
)
SELECT
    COALESCE(o.SKILL_NAME, q.SKILL_NAME) AS SKILL_NAME,
    IFF(o.SKILL_NAME IS NOT NULL, 'YES', 'NO') AS HAS_OBJECTS,
    COALESCE(q.QUERY_COUNT_30D, 0) AS QUERIES_LAST_30D,
    q.LAST_QUERY
FROM objects o
FULL OUTER JOIN queries q ON o.SKILL_NAME = q.SKILL_NAME
ORDER BY SKILL_NAME;
```

## ORS Control App Query Tracking

The ORS Control App (React UI running on SPCS) executes SQL queries against Snowflake. It has two execution modes:

| Mode | Function | query_tag | How |
|------|----------|-----------|-----|
| Local (development) | `snowSqlLocal()` | Set | Prepended via `ALTER SESSION SET query_tag` in SQL file |
| SPCS (production) | `snowSqlSpcs()` | Set | Prepended via multi-statement SQL API call |

Both modes set the tracking name `oss-build-routing-solution`.

## Skill Tracking Name Reference

| Skill | Tracking Name |
|-------|---------------|
| build-routing-solution | `oss-build-routing-solution-in-snowflake` |
| fleet-intelligence-taxis | `oss-fleet-intelligence-taxis` |
| fleet-intelligence-food-delivery | `oss-fleet-intelligence-food-delivery` |
| retail-catchment | `oss-retail-catchment` |
| route-deviation | `oss-route-deviation` |
| route-optimization | `oss-route-optimization` |
| dwell-analysis | `oss-dwell-analysis` |
| routing-agent | `oss-deploy-snowflake-intelligence-routing-agent` |
| travel-time-matrix | `oss-travel-time-matrix` |
| cleanup | `oss-cleanup` |
| ORS Control App | `oss-build-routing-solution` |

## Known Limitations

1. **Service functions** (`CREATE FUNCTION ... SERVICE=...`) in the native app do not support `ALTER FUNCTION SET COMMENT`. These functions (8 internal `_*_RAW` functions) are tracked via their parent procedure's COMMENT tag and the session `query_tag`.

2. **Dynamically named objects** (travel-time-matrix Tasks and tables) use parameterized names like `<REGION>_TRAVEL_TIME_RES<N>`. Discovery queries must use `LIKE '%sf_sit-is-fleet%'` pattern matching rather than exact name matching.

3. **Archived notebooks** (in `archive/` directory) lack tracking tags. These are not deployed and are kept for historical reference only.

## Compliance Rules

Per AGENTS.md, the following rules are mandatory with no exceptions:

- Every new Snowflake object MUST have a COMMENT tracking tag
- Every SQL session MUST set `query_tag` before executing statements
- For CTAS or dynamic SQL, use `ALTER ... SET COMMENT` immediately after creation
- For service functions that don't support COMMENT, document the limitation and ensure the parent procedure has a COMMENT tag
- This applies to all skills, notebooks, stored procedures, dynamic SQL, and any other code path
