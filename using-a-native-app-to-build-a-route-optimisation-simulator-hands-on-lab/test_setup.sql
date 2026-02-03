-- Minimal OpenStreetMap Generator Native App Setup
-- This is a simplified version for testing

-- Create application role and schema
CREATE APPLICATION ROLE IF NOT EXISTS app_public;
CREATE SCHEMA IF NOT EXISTS core;
GRANT USAGE ON SCHEMA core TO APPLICATION ROLE app_public;

-- Simple test function
CREATE OR REPLACE FUNCTION core.test_function()
RETURNS STRING
LANGUAGE SQL
AS
$$
BEGIN
  RETURN 'OpenStreetMap Generator v1.0.0 - Test successful';
END;
$$;

-- Grant function access
GRANT USAGE ON FUNCTION core.test_function() TO APPLICATION ROLE app_public;
