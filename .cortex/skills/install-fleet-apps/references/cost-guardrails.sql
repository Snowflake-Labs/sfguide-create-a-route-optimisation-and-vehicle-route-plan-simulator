-- =============================================================================
-- Cost guardrails (OPTIONAL, PRIVILEGED) - resource monitor + budget
-- =============================================================================
-- Hard ceiling + alerting so an unattended deployment cannot run away on credits
-- (the guardrail the Fleet Intelligence accelerator was missing). This is NOT
-- part of the default install because it requires ACCOUNTADMIN (or the granted
-- CREATE RESOURCE MONITOR / CREATE SNOWFLAKE.CORE.BUDGET privileges) and a
-- deployment-specific credit budget. Review the placeholders, then run as a
-- role that holds those privileges.
--
-- What this covers:
--   1. A RESOURCE MONITOR on the ROUTING_ANALYTICS warehouse (dynamic tables +
--      tasks + matrix builds all run here). Resource monitors attach to
--      WAREHOUSES only - they cannot govern compute pools.
--   2. A Snowflake BUDGET that tracks the SPCS compute pools + the warehouse and
--      notifies when projected monthly spend crosses the limit. Budgets are the
--      mechanism for compute-pool spend visibility.
--
-- Prerequisites:
--   - Role: ACCOUNTADMIN, or a role granted CREATE RESOURCE MONITOR ON ACCOUNT
--     and (for budgets) the SNOWFLAKE.CORE.BUDGET usage + CREATE privileges.
--   - Set the two placeholders below before running.
-- =============================================================================

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"cost-guardrails"}}';

-- ---- PLACEHOLDERS ----------------------------------------------------------
SET MONTHLY_CREDIT_QUOTA = 100;                 -- <== set to your monthly credit ceiling for ROUTING_ANALYTICS
SET BUDGET_NOTIFY_EMAIL  = 'you@example.com';   -- <== set to the alert recipient (must be a verified Snowflake user email)

-- ---------------------------------------------------------------------------
-- 1. Resource monitor on ROUTING_ANALYTICS
-- ---------------------------------------------------------------------------
-- Triggers: notify at 80%, suspend (let running queries finish) at 100%,
-- suspend-immediately at 110%. Adjust percentages/actions to taste.
CREATE RESOURCE MONITOR IF NOT EXISTS FLEET_ROUTING_ANALYTICS_MONITOR
    WITH CREDIT_QUOTA = $MONTHLY_CREDIT_QUOTA
    FREQUENCY = MONTHLY
    START_TIMESTAMP = IMMEDIATELY
    TRIGGERS
        ON 80 PERCENT DO NOTIFY
        ON 100 PERCENT DO SUSPEND
        ON 110 PERCENT DO SUSPEND_IMMEDIATE;

ALTER WAREHOUSE IF EXISTS ROUTING_ANALYTICS SET RESOURCE_MONITOR = FLEET_ROUTING_ANALYTICS_MONITOR;

-- ---------------------------------------------------------------------------
-- 2. Budget covering the SPCS compute pools + the warehouse
-- ---------------------------------------------------------------------------
-- Budgets live in a schema and expose the SNOWFLAKE.CORE.BUDGET class instance.
-- This creates a dedicated schema + budget, sets a monthly spending limit, adds
-- an email notification, and tags the cost-driving resources onto it.
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.COST_GOVERNANCE
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"cost-guardrails"}}';

CREATE OR REPLACE SNOWFLAKE.CORE.BUDGET FLEET_INTELLIGENCE.COST_GOVERNANCE.FLEET_BUDGET();

-- Configure the budget: monthly limit + notification recipient, then add the
-- resources whose spend it should track.
CALL FLEET_INTELLIGENCE.COST_GOVERNANCE.FLEET_BUDGET!SET_SPENDING_LIMIT($MONTHLY_CREDIT_QUOTA);

-- A notification integration is required for budget email alerts. Create one if
-- you do not already have it (requires the recipient to be a verified user).
CREATE NOTIFICATION INTEGRATION IF NOT EXISTS FLEET_BUDGET_NOTIFICATIONS
    TYPE = EMAIL
    ENABLED = TRUE
    ALLOWED_RECIPIENTS = ($BUDGET_NOTIFY_EMAIL);

CALL FLEET_INTELLIGENCE.COST_GOVERNANCE.FLEET_BUDGET!SET_NOTIFICATION_INTEGRATION('FLEET_BUDGET_NOTIFICATIONS', ARRAY_CONSTRUCT($BUDGET_NOTIFY_EMAIL));

-- Track the cost-driving resources. Add each provisioned region pool as needed
-- (ORS_POOL_<REGION>); the core pool + warehouse are the always-present ones.
CALL FLEET_INTELLIGENCE.COST_GOVERNANCE.FLEET_BUDGET!ADD_RESOURCE(SYSTEM$REFERENCE('COMPUTE POOL', 'OPENROUTESERVICE_APP_COMPUTE_POOL', 'SESSION', 'APPLYBUDGET'));
CALL FLEET_INTELLIGENCE.COST_GOVERNANCE.FLEET_BUDGET!ADD_RESOURCE(SYSTEM$REFERENCE('WAREHOUSE', 'ROUTING_ANALYTICS', 'SESSION', 'APPLYBUDGET'));

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
SHOW RESOURCE MONITORS LIKE 'FLEET_ROUTING_ANALYTICS_MONITOR';
SELECT SYSTEM$SHOW_BUDGETS();

-- ---------------------------------------------------------------------------
-- Cleanup
-- ---------------------------------------------------------------------------
-- ALTER WAREHOUSE IF EXISTS ROUTING_ANALYTICS UNSET RESOURCE_MONITOR;
-- DROP RESOURCE MONITOR IF EXISTS FLEET_ROUTING_ANALYTICS_MONITOR;
-- DROP SNOWFLAKE.CORE.BUDGET IF EXISTS FLEET_INTELLIGENCE.COST_GOVERNANCE.FLEET_BUDGET;
-- DROP NOTIFICATION INTEGRATION IF EXISTS FLEET_BUDGET_NOTIFICATIONS;
-- DROP SCHEMA IF EXISTS FLEET_INTELLIGENCE.COST_GOVERNANCE;
