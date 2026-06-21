-- Fleet Intelligence Native App setup script (tier-B config-extensible).
--
-- Codifies the application roles and the logical->application-role binding for
-- the three skill bundles (user / ops / admin; see app/install.json). The
-- synapse tool procs, the FLEET_USER_MCP / FLEET_ADMIN_MCP servers, and the
-- FLEET_AGENT are created by their own materialize/deploy steps (fleet_tools/)
-- and by 2D; this script wires CONSUMER-FACING access to them.
--
-- NOTE: This is the tier-C template. The live Step-2 deploy runs the objects
-- directly on the provider account (wgb26798) rather than as an installed app.

-- 1. Application roles (the consumer grants these to user roles).
CREATE APPLICATION ROLE IF NOT EXISTS app_user;   -- consumers: dashboards + agent (User tools)
CREATE APPLICATION ROLE IF NOT EXISTS app_ops;     -- operators: config/region (Step 3 surface)
CREATE APPLICATION ROLE IF NOT EXISTS app_admin;   -- installer/admin

-- 2. Schemas holding the app objects.
CREATE SCHEMA IF NOT EXISTS synapse_user;
CREATE SCHEMA IF NOT EXISTS synapse_admin;
CREATE SCHEMA IF NOT EXISTS config;

-- 3. Consumer access bindings (logical role -> application role).
--    The end-user agent sees ONLY the User MCP server (role isolation).
GRANT USAGE ON SCHEMA synapse_user TO APPLICATION ROLE app_user;
-- Granted once the objects exist (created by fleet_tools materialize/deploy):
--   GRANT USAGE ON MCP SERVER synapse_user.FLEET_USER_MCP TO APPLICATION ROLE app_user;
--   GRANT USAGE ON AGENT      synapse_user.FLEET_AGENT     TO APPLICATION ROLE app_user;
--   (each User proc) GRANT USAGE ON PROCEDURE ... TO APPLICATION ROLE app_user;

-- Admin bundle is bound to app_admin only; never to app_user.
GRANT USAGE ON SCHEMA synapse_admin TO APPLICATION ROLE app_admin;
--   GRANT USAGE ON MCP SERVER synapse_admin.FLEET_ADMIN_MCP TO APPLICATION ROLE app_admin;

-- 4. Tier-B config stage: Ops edits app-config.json / app-views.json / agent
--    prompts here, then restarts the UI service to reload (no image rebuild).
CREATE STAGE IF NOT EXISTS config.FLEET_APP_STAGE
  DIRECTORY = (ENABLE = TRUE)
  COMMENT = 'Editable app bundle (dashboards, agent prompts, region context).';
GRANT READ ON STAGE config.FLEET_APP_STAGE TO APPLICATION ROLE app_user;
GRANT WRITE ON STAGE config.FLEET_APP_STAGE TO APPLICATION ROLE app_ops;

-- 5. The SA UI runs as an SPCS service created from fleet_sa_app_service.yaml
--    (mounts the config stage; agent-object mode -> FLEET_AGENT). In a published
--    app this is created here via CREATE SERVICE IN COMPUTE POOL ...; the live
--    Step-2 deploy creates it directly on the provider account.
