-- OpenStreetMap Generator Native App Setup
-- This script initializes the native app with all required components

-- Create application role and schema
CREATE APPLICATION ROLE IF NOT EXISTS app_public;
CREATE SCHEMA IF NOT EXISTS core;
GRANT USAGE ON SCHEMA core TO APPLICATION ROLE app_public;

-- Callback functions for external access integration
CREATE OR REPLACE FUNCTION core.register_external_access(config OBJECT)
RETURNS STRING
LANGUAGE SQL
AS
$$
BEGIN
  RETURN 'External access integration registered successfully';
END;
$$;

CREATE OR REPLACE FUNCTION core.get_external_access_config()
RETURNS OBJECT
LANGUAGE SQL
AS
$$
BEGIN
  RETURN OBJECT_CONSTRUCT(
    'allowed_network_rules', ARRAY_CONSTRUCT('osm_network_rule'),
    'allowed_authentication_secrets', ARRAY_CONSTRUCT(),
    'enabled', TRUE,
    'comment', 'External access for OpenStreetMap APIs'
  );
END;
$$;

-- Version initialization callback
CREATE OR REPLACE FUNCTION core.version_init()
RETURNS STRING
LANGUAGE SQL
AS
$$
BEGIN
  RETURN 'OpenStreetMap Generator v1.0.0 initialized';
END;
$$;

-- Execute the main setup script
EXECUTE IMMEDIATE FROM '/src/setup.sql';
