-- Discovery Queries for Cleanup Skill
-- Finds all Snowflake objects tagged with the sf_sit-is-fleet tracking COMMENT.

-- Step 1a: Set session query tag
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-cleanup","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

SET TRACKING_TAG = 'sf_sit-is-fleet';

-- Step 1b: Discover tagged tables
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

-- Step 1c: Discover tagged views
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

-- Step 1d: Discover tagged procedures and functions
SELECT 
    PROCEDURE_CATALOG AS DATABASE_NAME,
    PROCEDURE_SCHEMA AS SCHEMA_NAME,
    PROCEDURE_NAME AS OBJECT_NAME,
    'PROCEDURE' AS OBJECT_TYPE,
    COMMENT,
    PARSE_JSON(COMMENT):name::STRING AS SKILL_NAME
FROM INFORMATION_SCHEMA.PROCEDURES
WHERE COMMENT LIKE '%' || $TRACKING_TAG || '%';

-- Step 1e: Discover tagged stages
SHOW STAGES;
SELECT "database_name", "schema_name", "name", "comment"
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
WHERE "comment" LIKE '%sf_sit-is-fleet%';

-- Step 1f: Discover tagged warehouses
SHOW WAREHOUSES;
SELECT "name", "comment"
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
WHERE "comment" LIKE '%sf_sit-is-fleet%';

-- Step 1g: Discover tagged schemas
SHOW SCHEMAS;
SELECT "database_name", "name", "comment"
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
WHERE "comment" LIKE '%sf_sit-is-fleet%';

-- Step 1h: Discover tagged databases
SHOW DATABASES;
SELECT "name", "comment"
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
WHERE "comment" LIKE '%sf_sit-is-fleet%';

-- Step 1i: Discover tagged Streamlit apps
SHOW STREAMLITS;
SELECT "database_name", "schema_name", "name", "comment"
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
WHERE "comment" LIKE '%sf_sit-is-fleet%';
