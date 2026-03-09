CREATE APPLICATION ROLE IF NOT EXISTS app_user;
CREATE SCHEMA IF NOT EXISTS core;
GRANT USAGE ON SCHEMA core TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.version_init()
RETURNS STRING
LANGUAGE SQL
AS
$$
BEGIN
    LET pool_name := (SELECT CURRENT_DATABASE()) || '_compute_pool';

    DROP SERVICE IF EXISTS core.fleet_intelligence_service;
    BEGIN
        CREATE SERVICE core.fleet_intelligence_service
            IN COMPUTE POOL IDENTIFIER(:pool_name)
            FROM SPECIFICATION_FILE='services/fleet_intelligence_service.yaml'
            MIN_INSTANCES = 1
            MAX_INSTANCES = 1
            AUTO_SUSPEND_SECS = 0
            EXTERNAL_ACCESS_INTEGRATIONS = (reference('external_access_ref'));
    EXCEPTION
        WHEN OTHER THEN
            BEGIN
                CREATE SERVICE core.fleet_intelligence_service
                    IN COMPUTE POOL IDENTIFIER(:pool_name)
                    FROM SPECIFICATION_FILE='services/fleet_intelligence_service.yaml'
                    MIN_INSTANCES = 1
                    MAX_INSTANCES = 1
                    AUTO_SUSPEND_SECS = 0;
            EXCEPTION
                WHEN OTHER THEN
                    RETURN 'Version initialized - service creation skipped (compute pool may not exist yet). Run DEPLOY() after grants.';
            END;
    END;
    GRANT USAGE ON SERVICE core.fleet_intelligence_service TO APPLICATION ROLE app_user;
    GRANT SERVICE ROLE core.fleet_intelligence_service!ALL_ENDPOINTS_USAGE TO APPLICATION ROLE app_user;
    GRANT OPERATE ON SERVICE core.fleet_intelligence_service TO APPLICATION ROLE app_user;
    GRANT MONITOR ON SERVICE core.fleet_intelligence_service TO APPLICATION ROLE app_user;
    RETURN 'Version initialized - service recreated with new image';
EXCEPTION
    WHEN OTHER THEN
        RETURN 'Version initialized - service deployment deferred: ' || SQLERRM;
END;
$$;
GRANT USAGE ON PROCEDURE core.version_init() TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.register_single_callback(ref_name STRING, operation STRING, ref_or_alias STRING)
RETURNS STRING
LANGUAGE SQL
AS
$$
BEGIN
    CASE (operation)
        WHEN 'ADD' THEN
            SELECT SYSTEM$SET_REFERENCE(:ref_name, :ref_or_alias);
        WHEN 'REMOVE' THEN
            SELECT SYSTEM$REMOVE_REFERENCE(:ref_name);
        WHEN 'CLEAR' THEN
            SELECT SYSTEM$REMOVE_REFERENCE(:ref_name);
        ELSE
            RETURN 'unknown operation: ' || operation;
    END CASE;
    RETURN 'SUCCESS';
END;
$$;
GRANT USAGE ON PROCEDURE core.register_single_callback(STRING, STRING, STRING) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.get_config_for_ref(ref_name STRING)
RETURNS STRING
LANGUAGE SQL
AS
$$
BEGIN
    CASE (UPPER(ref_name))
        WHEN 'EXTERNAL_ACCESS_REF' THEN
            RETURN OBJECT_CONSTRUCT(
                'type', 'CONFIGURATION',
                'payload', OBJECT_CONSTRUCT(
                    'host_ports', ARRAY_CONSTRUCT('a.basemaps.cartocdn.com:443', 'b.basemaps.cartocdn.com:443', 'c.basemaps.cartocdn.com:443', 'd.basemaps.cartocdn.com:443'),
                    'allowed_secrets', 'NONE'
                )
            )::STRING;
        ELSE
            RETURN '';
    END CASE;
END;
$$;
GRANT USAGE ON PROCEDURE core.get_config_for_ref(STRING) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.create_compute_pool()
RETURNS STRING
LANGUAGE SQL
AS
$$
BEGIN
    LET pool_name := (SELECT CURRENT_DATABASE()) || '_compute_pool';
    CREATE COMPUTE POOL IF NOT EXISTS IDENTIFIER(:pool_name)
        INSTANCE_FAMILY = CPU_X64_S
        MIN_NODES = 1
        MAX_NODES = 1
        AUTO_RESUME = TRUE
        AUTO_SUSPEND_SECS = 600;
    RETURN 'Compute pool created: ' || pool_name;
END;
$$;
GRANT USAGE ON PROCEDURE core.create_compute_pool() TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.create_warehouse()
RETURNS STRING
LANGUAGE SQL
AS
$$
BEGIN
    CREATE WAREHOUSE IF NOT EXISTS FLEET_INTEL_WH
        WAREHOUSE_SIZE = 'XSMALL'
        AUTO_SUSPEND = 60
        AUTO_RESUME = TRUE
        INITIALLY_SUSPENDED = TRUE;
    RETURN 'Warehouse created';
END;
$$;
GRANT USAGE ON PROCEDURE core.create_warehouse() TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.create_service()
RETURNS STRING
LANGUAGE SQL
AS
$$
BEGIN
    LET pool_name := (SELECT CURRENT_DATABASE()) || '_compute_pool';

    DROP SERVICE IF EXISTS core.fleet_intelligence_service;

    BEGIN
        CREATE SERVICE core.fleet_intelligence_service
            IN COMPUTE POOL IDENTIFIER(:pool_name)
            FROM SPECIFICATION_FILE='services/fleet_intelligence_service.yaml'
            MIN_INSTANCES = 1
            MAX_INSTANCES = 1
            AUTO_SUSPEND_SECS = 0
            EXTERNAL_ACCESS_INTEGRATIONS = (reference('external_access_ref'));
    EXCEPTION
        WHEN OTHER THEN
            CREATE SERVICE core.fleet_intelligence_service
                IN COMPUTE POOL IDENTIFIER(:pool_name)
                FROM SPECIFICATION_FILE='services/fleet_intelligence_service.yaml'
                MIN_INSTANCES = 1
                MAX_INSTANCES = 1
                AUTO_SUSPEND_SECS = 0;
    END;

    GRANT USAGE ON SERVICE core.fleet_intelligence_service TO APPLICATION ROLE app_user;
    GRANT SERVICE ROLE core.fleet_intelligence_service!ALL_ENDPOINTS_USAGE TO APPLICATION ROLE app_user;
    GRANT OPERATE ON SERVICE core.fleet_intelligence_service TO APPLICATION ROLE app_user;
    GRANT MONITOR ON SERVICE core.fleet_intelligence_service TO APPLICATION ROLE app_user;

    RETURN 'Service created';
END;
$$;
GRANT USAGE ON PROCEDURE core.create_service() TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.get_service_url()
RETURNS STRING
LANGUAGE SQL
AS
$$
DECLARE
    url STRING;
BEGIN
    SELECT "ingress_url" INTO :url
    FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
    WHERE "name" = 'fleet-intel-ui';
    RETURN url;
EXCEPTION
    WHEN OTHER THEN
        SHOW ENDPOINTS IN SERVICE core.fleet_intelligence_service;
        SELECT "ingress_url" INTO :url
        FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
        WHERE "name" = 'fleet-intel-ui';
        RETURN url;
END;
$$;
GRANT USAGE ON PROCEDURE core.get_service_url() TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.grant_callback(privileges ARRAY)
RETURNS STRING
LANGUAGE SQL
AS
$$
BEGIN
    IF (ARRAY_CONTAINS('CREATE COMPUTE POOL'::VARIANT, privileges)) THEN
        CALL core.create_compute_pool();
    END IF;
    IF (ARRAY_CONTAINS('CREATE WAREHOUSE'::VARIANT, privileges)) THEN
        CALL core.create_warehouse();
    END IF;
    IF (ARRAY_CONTAINS('BIND SERVICE ENDPOINT'::VARIANT, privileges) OR ARRAY_CONTAINS('CREATE COMPUTE POOL'::VARIANT, privileges)) THEN
        CALL core.create_service();
    END IF;
    RETURN 'App deployed successfully';
END;
$$;
GRANT USAGE ON PROCEDURE core.grant_callback(ARRAY) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.deploy()
RETURNS STRING
LANGUAGE SQL
AS
$$
BEGIN
    CALL core.create_compute_pool();
    CALL core.create_warehouse();
    CALL core.create_service();
    RETURN 'Deployment complete';
END;
$$;
GRANT USAGE ON PROCEDURE core.deploy() TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.get_status()
RETURNS STRING
LANGUAGE SQL
AS
$$
DECLARE
    svc_status STRING DEFAULT 'NOT_FOUND';
    endpoint_url STRING DEFAULT '';
BEGIN
    BEGIN
        SHOW SERVICES LIKE 'FLEET_INTELLIGENCE_SERVICE' IN SCHEMA core;
        SELECT "status" INTO :svc_status FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) LIMIT 1;
    EXCEPTION
        WHEN OTHER THEN
            svc_status := 'NOT_FOUND';
    END;

    BEGIN
        SHOW ENDPOINTS IN SERVICE core.fleet_intelligence_service;
        SELECT "ingress_url" INTO :endpoint_url FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) WHERE "name" = 'fleet-intel-ui' LIMIT 1;
    EXCEPTION
        WHEN OTHER THEN
            endpoint_url := '';
    END;

    RETURN OBJECT_CONSTRUCT('service_status', svc_status, 'endpoint_url', endpoint_url)::STRING;
END;
$$;
GRANT USAGE ON PROCEDURE core.get_status() TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.check_grants()
RETURNS STRING
LANGUAGE SQL
AS
$$
DECLARE
    db_ok BOOLEAN DEFAULT FALSE;
    cortex_ok BOOLEAN DEFAULT FALSE;
    app_name STRING;
BEGIN
    app_name := (SELECT CURRENT_DATABASE());

    BEGIN
        LET r RESULTSET := (SELECT 1 FROM OPENROUTESERVICE_SETUP.INFORMATION_SCHEMA.TABLES LIMIT 1);
        db_ok := TRUE;
    EXCEPTION
        WHEN OTHER THEN
            db_ok := FALSE;
    END;

    BEGIN
        LET r2 RESULTSET := (SHOW DATABASE ROLES IN DATABASE SNOWFLAKE);
        cortex_ok := TRUE;
    EXCEPTION
        WHEN OTHER THEN
            cortex_ok := FALSE;
    END;

    RETURN OBJECT_CONSTRUCT(
        'database_access', :db_ok,
        'cortex_role', :cortex_ok,
        'app_name', :app_name
    )::STRING;
END;
$$;
GRANT USAGE ON PROCEDURE core.check_grants() TO APPLICATION ROLE app_user;

CREATE OR REPLACE STREAMLIT core.status_app
    FROM '/streamlit'
    MAIN_FILE = '/status.py';
GRANT USAGE ON STREAMLIT core.status_app TO APPLICATION ROLE app_user;

-- =============================================================================
-- POST-INSTALL GRANTS (run as ACCOUNTADMIN after CREATE APPLICATION)
-- =============================================================================
-- The following grants must be applied OUTSIDE the setup script by the installer:
--
-- 1. Account-level privileges:
--    GRANT CREATE COMPUTE POOL ON ACCOUNT TO APPLICATION FLEET_INTELLIGENCE_APP;
--    GRANT CREATE WAREHOUSE ON ACCOUNT TO APPLICATION FLEET_INTELLIGENCE_APP;
--    GRANT BIND SERVICE ENDPOINT ON ACCOUNT TO APPLICATION FLEET_INTELLIGENCE_APP;
--
-- 2. Cortex AI access (REQUIRED for the AI agent):
--    GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO APPLICATION FLEET_INTELLIGENCE_APP;
--
-- 3. Data access:
--    GRANT USAGE ON DATABASE OPENROUTESERVICE_SETUP TO APPLICATION FLEET_INTELLIGENCE_APP;
--    GRANT USAGE ON SCHEMA OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY TO APPLICATION FLEET_INTELLIGENCE_APP;
--    GRANT SELECT ON ALL TABLES IN SCHEMA OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY TO APPLICATION FLEET_INTELLIGENCE_APP;
--    GRANT SELECT ON ALL VIEWS IN SCHEMA OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY TO APPLICATION FLEET_INTELLIGENCE_APP;
--
-- 4. External access for map tiles:
--    GRANT USAGE ON INTEGRATION fleet_intel_map_tiles_eai TO APPLICATION FLEET_INTELLIGENCE_APP;
--    CALL FLEET_INTELLIGENCE_APP.core.register_single_callback(
--        'EXTERNAL_ACCESS_REF', 'ADD',
--        SYSTEM$REFERENCE('EXTERNAL ACCESS INTEGRATION', 'FLEET_INTEL_MAP_TILES_EAI', 'PERSISTENT', 'USAGE'));
--
-- 5. App role to user roles:
--    GRANT APPLICATION ROLE FLEET_INTELLIGENCE_APP.APP_USER TO ROLE <YOUR_ROLE>;
--
-- 6. Deploy:
--    CALL FLEET_INTELLIGENCE_APP.core.deploy();
-- =============================================================================
