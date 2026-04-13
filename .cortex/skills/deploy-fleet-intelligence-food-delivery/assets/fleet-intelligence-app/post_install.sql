-- =============================================================================
-- Fleet Intelligence - Post-Installation Consumer Setup Script
-- =============================================================================
-- Run this script on the CONSUMER account after installing the Fleet Intelligence
-- native app from the Snowflake Marketplace / direct share.
--
-- Prerequisites:
--   - ACCOUNTADMIN role (or equivalent with MANAGE GRANTS)
--   - The app must already be installed as FLEET_INTELLIGENCE
-- =============================================================================

USE ROLE ACCOUNTADMIN;

-- =============================================================================
-- 1. WAREHOUSE: Create a warehouse for the agent and query execution
-- =============================================================================
CREATE WAREHOUSE IF NOT EXISTS FLEET_INTEL_WH
  WAREHOUSE_SIZE = 'XSMALL'
  AUTO_SUSPEND = 60
  AUTO_RESUME = TRUE
  INITIALLY_SUSPENDED = TRUE;

-- =============================================================================
-- 2. GRANTS TO APPLICATION: Cortex database roles + warehouse
-- =============================================================================
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_AGENT_USER TO APPLICATION FLEET_INTELLIGENCE;
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_ANALYST_USER TO APPLICATION FLEET_INTELLIGENCE;
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO APPLICATION FLEET_INTELLIGENCE;
GRANT USAGE ON WAREHOUSE FLEET_INTEL_WH TO APPLICATION FLEET_INTELLIGENCE;

-- =============================================================================
-- 3. GRANTS TO ROLE: The native app creates a ROLE with the same name as the app.
--    The Cortex Agent executes tools in a SQL session using this role, so it needs
--    Cortex privileges and warehouse access.
-- =============================================================================
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_AGENT_USER TO ROLE FLEET_INTELLIGENCE;
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_ANALYST_USER TO ROLE FLEET_INTELLIGENCE;
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_REST_API_USER TO ROLE FLEET_INTELLIGENCE;
GRANT USAGE ON WAREHOUSE FLEET_INTEL_WH TO ROLE FLEET_INTELLIGENCE;
GRANT OPERATE ON WAREHOUSE FLEET_INTEL_WH TO ROLE FLEET_INTELLIGENCE;

-- =============================================================================
-- 4. ROLE TO PUBLIC: CRITICAL for Cortex Agent tool execution.
--    The Cortex Agent system user needs to assume this role. Granting to PUBLIC
--    ensures the agent's internal session can use it.
-- =============================================================================
GRANT ROLE FLEET_INTELLIGENCE TO ROLE PUBLIC;

-- =============================================================================
-- 5. APPLICATION ROLES: Grant app roles to the FLEET_INTELLIGENCE role and to
--    the SNOWFLAKE application (required for Cortex Agent integration).
-- =============================================================================
GRANT APPLICATION ROLE FLEET_INTELLIGENCE.APP_USER TO ROLE FLEET_INTELLIGENCE;
GRANT APPLICATION ROLE FLEET_INTELLIGENCE.ALL_AGENTS_ROLE TO ROLE FLEET_INTELLIGENCE;
GRANT APPLICATION ROLE FLEET_INTELLIGENCE.APP_USER TO APPLICATION SNOWFLAKE;
GRANT APPLICATION ROLE FLEET_INTELLIGENCE.ALL_AGENTS_ROLE TO APPLICATION SNOWFLAKE;

-- =============================================================================
-- 6. DEPLOY: Initialize the app services and create the Cortex Agent.
--    grant_callback creates the compute pool, warehouse, and SPCS services.
--    create_agent creates the Cortex Agent with warehouse-based tool execution.
-- =============================================================================
CALL FLEET_INTELLIGENCE.CORE.GRANT_CALLBACK(PARSE_JSON('["FLEET_INTEL_POOL", "FLEET_INTEL_WH"]'));
CALL FLEET_INTELLIGENCE.CORE.CREATE_AGENT('FLEET_INTEL_WH');

-- =============================================================================
-- DONE! The app should now be fully operational.
-- Access it via the SPCS endpoint URL shown in:
--   SHOW ENDPOINTS IN SERVICE FLEET_INTELLIGENCE.CORE.FLEET_INTELLIGENCE_SERVICE;
-- =============================================================================
