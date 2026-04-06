---
name: cleanup
description: "Discover and remove all Snowflake objects created by skills in this repo. Uses the COMMENT tracking tag (sf_sit-is-fleet) to find objects, generates DROP statements, and optionally executes them. Use when: cleaning up after a demo, removing all skill-created objects, tearing down an environment, uninstalling a specific skill's objects. Do NOT use for: dropping objects not created by these skills, production environment cleanup without review. Triggers: cleanup, teardown, remove, uninstall, drop all, clean up demo, remove skill objects, reset environment."
metadata:
  author: Snowflake SIT-IS
  version: 1.0.0
  category: developer-tools
---

# Cleanup / Teardown

Discovers and removes all Snowflake objects created by skills in this repository using the COMMENT tracking tag `sf_sit-is-fleet`.

## How It Works

Every CREATE statement in every skill includes a COMMENT with JSON metadata:
```json
{"origin":"sf_sit-is-fleet","name":"<skill-tracking-name>","version":{"major":1,"minor":0},...}
```

This skill queries `INFORMATION_SCHEMA` and `SHOW` commands to discover all tagged objects, then generates DROP statements.

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| TRACKING_TAG | `sf_sit-is-fleet` | Origin tag to search for in COMMENT fields |
| SKILL_FILTER | (all) | Optional: filter to a specific skill name (e.g., `oss-oss-route-deviation`) |
| DRY_RUN | `true` | When true, only generates DROP statements without executing |
| INCLUDE_DATABASES | `false` | Whether to DROP entire databases (destructive — requires explicit confirmation) |

## Error Logging

When any step fails or produces unexpected results (SQL errors, missing objects, permission errors), log the issue to `logs/` following the format in `logs/README.md`. Create one log file per execution: `cleanup_{YYYY-MM-DD}_{HH-MM}.md`. Continue execution where possible, logging all issues encountered. If execution completes with no issues, do not create a log file.

## Prerequisites

- Active Snowflake connection with privileges to query INFORMATION_SCHEMA and DROP objects
- The role used must own or have DROP privileges on the target objects

## Step 1: Discover Tagged Objects

Run the discovery query. This searches across all accessible databases for objects tagged with the tracking origin.

```sql
SET TRACKING_TAG = 'sf_sit-is-fleet';

SELECT 
    TABLE_CATALOG AS DATABASE_NAME,
    TABLE_SCHEMA AS SCHEMA_NAME,
    TABLE_NAME AS OBJECT_NAME,
    TABLE_TYPE AS OBJECT_TYPE,
    COMMENT,
    PARSE_JSON(COMMENT):name::STRING AS SKILL_NAME,
    PARSE_JSON(COMMENT):attributes:source::STRING AS SOURCE_TYPE,
    CREATED AS CREATED_AT
FROM INFORMATION_SCHEMA.TABLES
WHERE COMMENT LIKE '%' || $TRACKING_TAG || '%'
ORDER BY DATABASE_NAME, SCHEMA_NAME, OBJECT_NAME;
```

For views specifically:

```sql
SELECT 
    TABLE_CATALOG AS DATABASE_NAME,
    TABLE_SCHEMA AS SCHEMA_NAME,
    TABLE_NAME AS VIEW_NAME,
    'VIEW' AS OBJECT_TYPE,
    COMMENT,
    PARSE_JSON(COMMENT):name::STRING AS SKILL_NAME
FROM INFORMATION_SCHEMA.VIEWS
WHERE COMMENT LIKE '%' || $TRACKING_TAG || '%'
ORDER BY DATABASE_NAME, SCHEMA_NAME, VIEW_NAME;
```

For procedures and functions:

```sql
SELECT 
    PROCEDURE_CATALOG AS DATABASE_NAME,
    PROCEDURE_SCHEMA AS SCHEMA_NAME,
    PROCEDURE_NAME AS OBJECT_NAME,
    'PROCEDURE' AS OBJECT_TYPE,
    COMMENT,
    PARSE_JSON(COMMENT):name::STRING AS SKILL_NAME
FROM INFORMATION_SCHEMA.PROCEDURES
WHERE COMMENT LIKE '%' || $TRACKING_TAG || '%';
```

For stages:

```sql
SHOW STAGES;
SELECT "database_name", "schema_name", "name", "comment"
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
WHERE "comment" LIKE '%sf_sit-is-fleet%';
```

For warehouses:

```sql
SHOW WAREHOUSES;
SELECT "name", "comment"
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
WHERE "comment" LIKE '%sf_sit-is-fleet%';
```

For schemas:

```sql
SHOW SCHEMAS;
SELECT "database_name", "name", "comment"
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
WHERE "comment" LIKE '%sf_sit-is-fleet%';
```

For databases:

```sql
SHOW DATABASES;
SELECT "name", "comment"
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
WHERE "comment" LIKE '%sf_sit-is-fleet%';
```

For Streamlit apps:

```sql
SHOW STREAMLITS;
SELECT "database_name", "schema_name", "name", "comment"
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
WHERE "comment" LIKE '%sf_sit-is-fleet%';
```

## Step 2: Generate DROP Statements

**Action:** Based on the discovery results, generate DROP statements in the correct order (reverse dependency):

1. Streamlit apps and agents
2. Procedures and functions
3. Views
4. Tables
5. Stages
6. Schemas (only if empty after dropping objects above)
7. Warehouses
8. Databases (only if `INCLUDE_DATABASES = true` and explicitly confirmed)

**Template for each object type:**

```sql
-- Tables
DROP TABLE IF EXISTS <DATABASE>.<SCHEMA>.<TABLE_NAME>;

-- Views
DROP VIEW IF EXISTS <DATABASE>.<SCHEMA>.<VIEW_NAME>;

-- Procedures (need full signature)
DROP PROCEDURE IF EXISTS <DATABASE>.<SCHEMA>.<PROC_NAME>(<ARG_TYPES>);

-- Stages
DROP STAGE IF EXISTS <DATABASE>.<SCHEMA>.<STAGE_NAME>;

-- Streamlit
DROP STREAMLIT IF EXISTS <DATABASE>.<SCHEMA>.<STREAMLIT_NAME>;

-- Schemas (only if empty)
DROP SCHEMA IF EXISTS <DATABASE>.<SCHEMA_NAME>;

-- Warehouses
DROP WAREHOUSE IF EXISTS <WAREHOUSE_NAME>;

-- Databases (requires explicit confirmation)
DROP DATABASE IF EXISTS <DATABASE_NAME>;
```

## Step 3: Review and Execute

**Action:** Present the generated DROP statements to the user for review.

- If `DRY_RUN = true`: Display the statements and stop. Ask the user to confirm before executing.
- If `DRY_RUN = false`: Execute each DROP statement and report results.

**Always confirm before dropping databases or warehouses.** These are shared resources that may be used by other workloads.

## Cleanup by Skill

To clean up objects from a single skill, filter discovery by the skill's tracking name:

| Skill | Tracking Name |
|-------|--------------|
| build-routing-solution | `oss-build-routing-solution-in-snowflake` |
| route-optimization | `oss-route-optimization` |
| fleet-intelligence-taxis | `oss-fleet-intelligence-taxis` |
| fleet-intelligence-food-delivery | `oss-fleet-intelligence-food-delivery` |
| retail-catchment | `oss-retail-catchment` |
| route-deviation | `oss-route-deviation` |
| dwell-analysis | `oss-dwell-analysis` |
| synthetic-datasets-generator | `synthetic-datasets-genertor` |
| travel-time-matrix | `oss-travel-time-matrix` |
| routing-agent | `oss-deploy-snowflake-intelligence-routing-agent` |

```sql
SET SKILL_FILTER = 'oss-route-optimization';
SELECT * FROM INFORMATION_SCHEMA.TABLES
WHERE COMMENT LIKE '%' || $SKILL_FILTER || '%';
```

## Troubleshooting

| Issue | Solution |
|-------|---------|
| No objects found | Check you're using a role that can see the databases. Try `USE ROLE ACCOUNTADMIN;` |
| Cannot drop table — has dependents | Drop views/procedures first (follow the order in Step 2) |
| Schema not empty after drops | Some objects may not have COMMENT tags (created manually). Check with `SHOW OBJECTS IN SCHEMA` |
| Warehouse in use | `ALTER WAREHOUSE <name> SUSPEND;` first, then DROP |
