-- Discovery Queries for Cleanup Skill v2
-- Finds ALL Snowflake objects created by skills in this repo.
-- Uses tracking tag (sf_sit-is-fleet) for tagged objects and explicit name matching for untagged ones.

-- ============================================================================
-- Step 1: Set session tag
-- ============================================================================
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-routing-solution-cleanup","version":{"major":2,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- ============================================================================
-- Step 2a: Native Applications
-- ============================================================================
SHOW APPLICATIONS;
SELECT "name", "comment", "owner", "created_on"
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
WHERE "name" ILIKE '%OPENROUTESERVICE%'
   OR "comment" LIKE '%sf_sit-is-fleet%';

-- ============================================================================
-- Step 2b: Application Packages
-- ============================================================================
SHOW APPLICATION PACKAGES;
SELECT "name", "comment", "owner", "created_on"
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
WHERE "name" ILIKE '%OPENROUTESERVICE%'
   OR "comment" LIKE '%sf_sit-is-fleet%';

-- ============================================================================
-- Step 2c: Compute Pools
-- ============================================================================
SHOW COMPUTE POOLS;
SELECT "name", "state", "application", "comment", "min_nodes", "max_nodes", "active_nodes"
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
WHERE "name" ILIKE '%OPENROUTESERVICE%'
   OR "comment" LIKE '%sf_sit-is-fleet%';

-- ============================================================================
-- Step 2d: External Access Integrations
-- ============================================================================
SHOW INTEGRATIONS;
SELECT "name", "type", "category", "comment"
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
WHERE "name" ILIKE '%OPENROUTESERVICE_NATIVE_APP%'
   OR "comment" LIKE '%sf_sit-is-fleet%';

-- ============================================================================
-- Step 2e: Network Rules (in app data database)
-- ============================================================================
SHOW NETWORK RULES;
SELECT "name", "database_name", "schema_name", "comment"
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
WHERE "name" ILIKE '%OPENROUTESERVICE_NATIVE_APP%'
   OR "database_name" ILIKE '%OPENROUTESERVICE_NATIVE_APP%';

-- ============================================================================
-- Step 2f: Databases
-- ============================================================================
SHOW DATABASES;
SELECT "name", "comment", "origin", "kind", "created_on"
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
WHERE "comment" LIKE '%sf_sit-is-fleet%'
   OR "name" IN ('OPENROUTESERVICE_SETUP', 'OPENROUTESERVICE_NATIVE_APP', 'OPENROUTESERVICE_NATIVE_APP_APP_DATA',
                  'SYNTHETIC_DATASETS', 'FLEET_INTELLIGENCE',
                  'OVERTURE_MAPS__PLACES', 'OVERTURE_MAPS__ADDRESSES')
   OR "name" ILIKE '%OPENROUTESERVICE%';

-- ============================================================================
-- Step 2g: Warehouses
-- ============================================================================
SHOW WAREHOUSES;
SELECT "name", "comment", "state", "size", "created_on"
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
WHERE "comment" LIKE '%sf_sit-is-fleet%'
   OR "name" = 'ROUTING_ANALYTICS';

-- ============================================================================
-- Step 2h: Schemas (across tagged databases)
-- ============================================================================
SHOW SCHEMAS IN DATABASE FLEET_INTELLIGENCE;
SELECT "name", "database_name", "comment", "created_on"
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
WHERE "comment" LIKE '%sf_sit-is-fleet%'
   OR "name" NOT IN ('INFORMATION_SCHEMA', 'PUBLIC');

-- ============================================================================
-- Step 2i: Cortex Agents
-- Run inside the known agent schema. If SHOW AGENTS fails, skip.
-- ============================================================================
-- SHOW AGENTS IN SCHEMA FLEET_INTELLIGENCE.ROUTING_AGENT;

-- ============================================================================
-- Step 2j: Tasks
-- ============================================================================
SHOW TASKS IN SCHEMA FLEET_INTELLIGENCE.DWELL_ANALYSIS;
SELECT "name", "database_name", "schema_name", "state", "comment"
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));

-- ============================================================================
-- Step 2k: Dynamic Tables (in tagged schemas)
-- ============================================================================
SHOW DYNAMIC TABLES IN SCHEMA FLEET_INTELLIGENCE.DWELL_ANALYSIS;
SELECT "name", "database_name", "schema_name", "comment"
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));

-- ============================================================================
-- Step 2l: Notebooks
-- ============================================================================
SHOW NOTEBOOKS IN SCHEMA FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION;
SELECT "name", "database_name", "schema_name", "comment"
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));

-- ============================================================================
-- Step 2m: Streamlit Apps
-- ============================================================================
SHOW STREAMLITS;
SELECT "database_name", "schema_name", "name", "comment"
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
WHERE "comment" LIKE '%sf_sit-is-fleet%';

-- ============================================================================
-- Step 2n: Procedures (per database)
-- ============================================================================
SELECT
    PROCEDURE_CATALOG AS DATABASE_NAME,
    PROCEDURE_SCHEMA AS SCHEMA_NAME,
    PROCEDURE_NAME AS OBJECT_NAME,
    ARGUMENT_SIGNATURE,
    'PROCEDURE' AS OBJECT_TYPE,
    COMMENT,
    PARSE_JSON(COMMENT):name::STRING AS SKILL_NAME
FROM FLEET_INTELLIGENCE.INFORMATION_SCHEMA.PROCEDURES
WHERE COMMENT LIKE '%sf_sit-is-fleet%';

-- ============================================================================
-- Step 2o: Functions
-- ============================================================================
SELECT
    FUNCTION_CATALOG AS DATABASE_NAME,
    FUNCTION_SCHEMA AS SCHEMA_NAME,
    FUNCTION_NAME AS OBJECT_NAME,
    ARGUMENT_SIGNATURE,
    'FUNCTION' AS OBJECT_TYPE,
    COMMENT
FROM FLEET_INTELLIGENCE.INFORMATION_SCHEMA.FUNCTIONS
WHERE COMMENT LIKE '%sf_sit-is-fleet%';

-- ============================================================================
-- Step 2p: Views (per database)
-- ============================================================================
SELECT
    TABLE_CATALOG AS DATABASE_NAME,
    TABLE_SCHEMA AS SCHEMA_NAME,
    TABLE_NAME AS VIEW_NAME,
    'VIEW' AS OBJECT_TYPE,
    COMMENT,
    PARSE_JSON(COMMENT):name::STRING AS SKILL_NAME
FROM FLEET_INTELLIGENCE.INFORMATION_SCHEMA.VIEWS
WHERE COMMENT LIKE '%sf_sit-is-fleet%'
ORDER BY DATABASE_NAME, SCHEMA_NAME, VIEW_NAME;

-- ============================================================================
-- Step 2q: Tables (per database)
-- ============================================================================
SELECT
    TABLE_CATALOG AS DATABASE_NAME,
    TABLE_SCHEMA AS SCHEMA_NAME,
    TABLE_NAME AS OBJECT_NAME,
    TABLE_TYPE AS OBJECT_TYPE,
    COMMENT,
    PARSE_JSON(COMMENT):name::STRING AS SKILL_NAME,
    ROW_COUNT,
    CREATED AS CREATED_AT
FROM FLEET_INTELLIGENCE.INFORMATION_SCHEMA.TABLES
WHERE COMMENT LIKE '%sf_sit-is-fleet%'
ORDER BY DATABASE_NAME, SCHEMA_NAME, OBJECT_NAME;

SELECT
    TABLE_CATALOG AS DATABASE_NAME,
    TABLE_SCHEMA AS SCHEMA_NAME,
    TABLE_NAME AS OBJECT_NAME,
    TABLE_TYPE AS OBJECT_TYPE,
    COMMENT,
    PARSE_JSON(COMMENT):name::STRING AS SKILL_NAME,
    ROW_COUNT,
    CREATED AS CREATED_AT
FROM SYNTHETIC_DATASETS.INFORMATION_SCHEMA.TABLES
WHERE COMMENT LIKE '%sf_sit-is-fleet%'
ORDER BY DATABASE_NAME, SCHEMA_NAME, OBJECT_NAME;

SELECT
    TABLE_CATALOG AS DATABASE_NAME,
    TABLE_SCHEMA AS SCHEMA_NAME,
    TABLE_NAME AS OBJECT_NAME,
    TABLE_TYPE AS OBJECT_TYPE,
    COMMENT,
    ROW_COUNT,
    CREATED AS CREATED_AT
FROM OPENROUTESERVICE_SETUP.INFORMATION_SCHEMA.TABLES
ORDER BY DATABASE_NAME, SCHEMA_NAME, OBJECT_NAME;

-- ============================================================================
-- Step 2r: Stages
-- ============================================================================
SHOW STAGES IN DATABASE OPENROUTESERVICE_SETUP;
SELECT "database_name", "schema_name", "name", "comment"
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));

SHOW STAGES IN DATABASE FLEET_INTELLIGENCE;
SELECT "database_name", "schema_name", "name", "comment"
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));

-- ============================================================================
-- Step 2s: Image Repositories
-- ============================================================================
SHOW IMAGE REPOSITORIES IN DATABASE OPENROUTESERVICE_SETUP;
SELECT "database_name", "schema_name", "name", "created_on"
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));

-- ============================================================================
-- Step 2t: File Formats
-- ============================================================================
SHOW FILE FORMATS IN DATABASE OPENROUTESERVICE_SETUP;
SELECT "database_name", "schema_name", "name", "comment"
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));
