-- cowork_binding.sql - make the four fleet agents visible in Snowflake CoWork.
--
-- WHY THIS EXISTS
-- Nothing in this repo ever registered an agent with the account's Snowflake
-- CoWork object, so Snowsight's agent setup checklist showed "Connect to
-- Snowflake CoWork" as outstanding on all four agents. The consequence is not
-- cosmetic: per the CoWork documentation, "If an account has a Snowflake CoWork
-- object, then the agent must be added to that object to be visible. If not
-- added, the agent can only be accessed using a direct link or the Snowsight UI."
-- So on any account that has ever opened the CoWork settings page (which creates
-- the object automatically), the fleet agents are hidden from the CoWork agent
-- list until this file runs.
--
-- TENET 3 IS UNAFFECTED
-- Adding FLEET_SUPER_AGENT here does NOT widen access. CoWork visibility is
-- filtered by the caller's privileges, and the super agent is granted to
-- FLEET_APP_ADMIN only (role_binding.sql, which documents that grant as the
-- isolation boundary). A FLEET_APP_USER seeing the CoWork object still cannot
-- invoke it.
--
-- IDEMPOTENCY
-- ALTER ... ADD AGENT is NOT idempotent - a second call raises 400203
-- "<agent> is already present in <object>". Each statement is therefore wrapped
-- in its own exception handler so a re-run (or a partially-applied earlier run)
-- is a no-op rather than a failure. This matters because install steps re-run
-- routinely and `snow sql -f` aborts the whole file at the first error.
--
-- The object itself is account-level and only one may exist, so the CREATE is
-- also tolerant: on most accounts it already exists.
--
-- Runs in install step 6.5, AFTER create_agents.sh. Best-effort in the installer:
-- an account whose role lacks CREATE SNOWFLAKE INTELLIGENCE should not fail the
-- install, it just keeps the agents reachable by direct link only.

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","module":"cowork_binding"}}';

EXECUTE IMMEDIATE $$
DECLARE
  -- Reported at the end so a caller can see what actually happened rather than
  -- inferring it from a wall of "Statement executed successfully".
  added   INTEGER DEFAULT 0;
  present INTEGER DEFAULT 0;
  failed  INTEGER DEFAULT 0;
BEGIN
  -- The object is created automatically the first time anyone opens the CoWork
  -- settings page, so this is usually a no-op. Tolerated either way.
  BEGIN
    CREATE SNOWFLAKE INTELLIGENCE IF NOT EXISTS SNOWFLAKE_INTELLIGENCE_OBJECT_DEFAULT;
  EXCEPTION WHEN OTHER THEN
    NULL;
  END;

  BEGIN
    ALTER SNOWFLAKE INTELLIGENCE SNOWFLAKE_INTELLIGENCE_OBJECT_DEFAULT
      ADD AGENT FLEET_INTELLIGENCE.SYNAPSE_USER.FLEET_AGENT;
    added := added + 1;
  EXCEPTION
    WHEN OTHER THEN
      IF (CONTAINS(SQLERRM, 'already present')) THEN present := present + 1;
      ELSE failed := failed + 1;
      END IF;
  END;

  BEGIN
    ALTER SNOWFLAKE INTELLIGENCE SNOWFLAKE_INTELLIGENCE_OBJECT_DEFAULT
      ADD AGENT FLEET_INTELLIGENCE.SYNAPSE_USER.FLEET_OPS_AGENT;
    added := added + 1;
  EXCEPTION
    WHEN OTHER THEN
      IF (CONTAINS(SQLERRM, 'already present')) THEN present := present + 1;
      ELSE failed := failed + 1;
      END IF;
  END;

  BEGIN
    ALTER SNOWFLAKE INTELLIGENCE SNOWFLAKE_INTELLIGENCE_OBJECT_DEFAULT
      ADD AGENT FLEET_INTELLIGENCE.SYNAPSE_USER.FLEET_ADMIN_AGENT;
    added := added + 1;
  EXCEPTION
    WHEN OTHER THEN
      IF (CONTAINS(SQLERRM, 'already present')) THEN present := present + 1;
      ELSE failed := failed + 1;
      END IF;
  END;

  BEGIN
    ALTER SNOWFLAKE INTELLIGENCE SNOWFLAKE_INTELLIGENCE_OBJECT_DEFAULT
      ADD AGENT FLEET_INTELLIGENCE.SYNAPSE_USER.FLEET_SUPER_AGENT;
    added := added + 1;
  EXCEPTION
    WHEN OTHER THEN
      IF (CONTAINS(SQLERRM, 'already present')) THEN present := present + 1;
      ELSE failed := failed + 1;
      END IF;
  END;

  RETURN 'cowork agents added=' || added
      || ' already_present=' || present
      || ' failed=' || failed;
END;
$$;

-- Without USAGE on the CoWork object a role sees an EMPTY agent list rather than
-- an error, which reads as "my agents disappeared". Granting all three app roles
-- keeps every tier able to see the agents it is allowed to invoke; the per-agent
-- USAGE grants in role_binding.sql remain the actual access control.
GRANT USAGE ON SNOWFLAKE INTELLIGENCE SNOWFLAKE_INTELLIGENCE_OBJECT_DEFAULT TO ROLE FLEET_APP_USER;
GRANT USAGE ON SNOWFLAKE INTELLIGENCE SNOWFLAKE_INTELLIGENCE_OBJECT_DEFAULT TO ROLE FLEET_APP_OPS;
GRANT USAGE ON SNOWFLAKE INTELLIGENCE SNOWFLAKE_INTELLIGENCE_OBJECT_DEFAULT TO ROLE FLEET_APP_ADMIN;

SHOW AGENTS IN SNOWFLAKE INTELLIGENCE SNOWFLAKE_INTELLIGENCE_OBJECT_DEFAULT;
