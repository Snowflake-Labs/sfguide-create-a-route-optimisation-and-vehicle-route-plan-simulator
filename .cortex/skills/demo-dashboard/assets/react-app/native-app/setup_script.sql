CREATE APPLICATION ROLE IF NOT EXISTS app_user;

CREATE SCHEMA IF NOT EXISTS core;
GRANT USAGE ON SCHEMA core TO APPLICATION ROLE app_user;

-- =============================================================================
-- DEMO_REGISTRY: dynamic page/demo registration
-- =============================================================================

CREATE TABLE IF NOT EXISTS core.DEMO_REGISTRY (
    DEMO_ID VARCHAR NOT NULL,
    DEMO_NAME VARCHAR NOT NULL,
    DEMO_DESCRIPTION VARCHAR,
    CATEGORY VARCHAR,
    ICON VARCHAR,
    SORT_ORDER NUMBER DEFAULT 100,
    ENABLED BOOLEAN DEFAULT TRUE,
    REQUIRED_DATABASE VARCHAR,
    REQUIRED_SCHEMA VARCHAR,
    REGISTERED_AT TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP(),
    REGISTERED_BY VARCHAR DEFAULT CURRENT_USER(),
    PRIMARY KEY (DEMO_ID)
);
GRANT SELECT ON TABLE core.DEMO_REGISTRY TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE core.DEMO_REGISTRY TO APPLICATION ROLE app_user;
GRANT UPDATE ON TABLE core.DEMO_REGISTRY TO APPLICATION ROLE app_user;
GRANT DELETE ON TABLE core.DEMO_REGISTRY TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.REGISTER_DEMO(
    P_DEMO_ID VARCHAR,
    P_DEMO_NAME VARCHAR,
    P_DESCRIPTION VARCHAR,
    P_CATEGORY VARCHAR,
    P_ICON VARCHAR DEFAULT 'LayoutDashboard',
    P_SORT_ORDER NUMBER DEFAULT 100,
    P_REQUIRED_DATABASE VARCHAR DEFAULT NULL,
    P_REQUIRED_SCHEMA VARCHAR DEFAULT NULL
)
RETURNS STRING
LANGUAGE SQL
AS
$$
BEGIN
    MERGE INTO core.DEMO_REGISTRY t
    USING (SELECT
        :P_DEMO_ID AS DEMO_ID,
        :P_DEMO_NAME AS DEMO_NAME,
        :P_DESCRIPTION AS DEMO_DESCRIPTION,
        :P_CATEGORY AS CATEGORY,
        :P_ICON AS ICON,
        :P_SORT_ORDER AS SORT_ORDER,
        :P_REQUIRED_DATABASE AS REQUIRED_DATABASE,
        :P_REQUIRED_SCHEMA AS REQUIRED_SCHEMA
    ) s ON t.DEMO_ID = s.DEMO_ID
    WHEN MATCHED THEN UPDATE SET
        DEMO_NAME = s.DEMO_NAME,
        DEMO_DESCRIPTION = s.DEMO_DESCRIPTION,
        CATEGORY = s.CATEGORY,
        ICON = s.ICON,
        SORT_ORDER = s.SORT_ORDER,
        REQUIRED_DATABASE = s.REQUIRED_DATABASE,
        REQUIRED_SCHEMA = s.REQUIRED_SCHEMA,
        REGISTERED_AT = CURRENT_TIMESTAMP(),
        REGISTERED_BY = CURRENT_USER()
    WHEN NOT MATCHED THEN INSERT (DEMO_ID, DEMO_NAME, DEMO_DESCRIPTION, CATEGORY, ICON, SORT_ORDER, REQUIRED_DATABASE, REQUIRED_SCHEMA)
    VALUES (s.DEMO_ID, s.DEMO_NAME, s.DEMO_DESCRIPTION, s.CATEGORY, s.ICON, s.SORT_ORDER, s.REQUIRED_DATABASE, s.REQUIRED_SCHEMA);
    RETURN 'Registered demo: ' || :P_DEMO_ID;
END;
$$;
GRANT USAGE ON PROCEDURE core.REGISTER_DEMO(VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, NUMBER, VARCHAR, VARCHAR) TO APPLICATION ROLE app_user;

-- =============================================================================
-- CORE: Callbacks, deploy, status
-- =============================================================================

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
    CREATE WAREHOUSE IF NOT EXISTS DEMO_DASHBOARD_WH
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
    DROP SERVICE IF EXISTS core.demo_dashboard_service;
    BEGIN
        CREATE SERVICE core.demo_dashboard_service
            IN COMPUTE POOL IDENTIFIER(:pool_name)
            FROM SPECIFICATION_FILE='services/demo_dashboard_service.yaml'
            MIN_INSTANCES = 1
            MAX_INSTANCES = 1
            AUTO_SUSPEND_SECS = 0
            EXTERNAL_ACCESS_INTEGRATIONS = (reference('external_access_ref'));
    EXCEPTION
        WHEN OTHER THEN
            CREATE SERVICE core.demo_dashboard_service
                IN COMPUTE POOL IDENTIFIER(:pool_name)
                FROM SPECIFICATION_FILE='services/demo_dashboard_service.yaml'
                MIN_INSTANCES = 1
                MAX_INSTANCES = 1
                AUTO_SUSPEND_SECS = 0;
    END;
    GRANT USAGE ON SERVICE core.demo_dashboard_service TO APPLICATION ROLE app_user;
    GRANT SERVICE ROLE core.demo_dashboard_service!ALL_ENDPOINTS_USAGE TO APPLICATION ROLE app_user;
    GRANT OPERATE ON SERVICE core.demo_dashboard_service TO APPLICATION ROLE app_user;
    GRANT MONITOR ON SERVICE core.demo_dashboard_service TO APPLICATION ROLE app_user;
    RETURN 'Dashboard service created';
END;
$$;
GRANT USAGE ON PROCEDURE core.create_service() TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.version_init()
RETURNS STRING
LANGUAGE SQL
AS
$$
BEGIN
    LET pool_name := (SELECT CURRENT_DATABASE()) || '_compute_pool';
    DROP SERVICE IF EXISTS core.demo_dashboard_service;
    BEGIN
        CREATE SERVICE core.demo_dashboard_service
            IN COMPUTE POOL IDENTIFIER(:pool_name)
            FROM SPECIFICATION_FILE='services/demo_dashboard_service.yaml'
            MIN_INSTANCES = 1
            MAX_INSTANCES = 1
            AUTO_SUSPEND_SECS = 0
            EXTERNAL_ACCESS_INTEGRATIONS = (reference('external_access_ref'));
    EXCEPTION
        WHEN OTHER THEN
            BEGIN
                CREATE SERVICE core.demo_dashboard_service
                    IN COMPUTE POOL IDENTIFIER(:pool_name)
                    FROM SPECIFICATION_FILE='services/demo_dashboard_service.yaml'
                    MIN_INSTANCES = 1
                    MAX_INSTANCES = 1
                    AUTO_SUSPEND_SECS = 0;
            EXCEPTION
                WHEN OTHER THEN
                    RETURN 'Version init - service deferred. Run DEPLOY() after grants.';
            END;
    END;
    GRANT USAGE ON SERVICE core.demo_dashboard_service TO APPLICATION ROLE app_user;
    GRANT SERVICE ROLE core.demo_dashboard_service!ALL_ENDPOINTS_USAGE TO APPLICATION ROLE app_user;
    GRANT OPERATE ON SERVICE core.demo_dashboard_service TO APPLICATION ROLE app_user;
    GRANT MONITOR ON SERVICE core.demo_dashboard_service TO APPLICATION ROLE app_user;
    RETURN 'Version initialized';
EXCEPTION
    WHEN OTHER THEN
        RETURN 'Version init deferred: ' || SQLERRM;
END;
$$;
GRANT USAGE ON PROCEDURE core.version_init() TO APPLICATION ROLE app_user;

-- =============================================================================
-- CORE: grant_callback, deploy, status
-- =============================================================================

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
    RETURN 'Dashboard deployment complete';
END;
$$;
GRANT USAGE ON PROCEDURE core.deploy() TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.get_service_url()
RETURNS STRING
LANGUAGE SQL
AS
$$
DECLARE
    url STRING;
BEGIN
    SHOW ENDPOINTS IN SERVICE core.demo_dashboard_service;
    SELECT "ingress_url" INTO :url
    FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
    WHERE "name" = 'dashboard-ui';
    RETURN url;
EXCEPTION
    WHEN OTHER THEN
        RETURN '';
END;
$$;
GRANT USAGE ON PROCEDURE core.get_service_url() TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.get_status()
RETURNS STRING
LANGUAGE SQL
AS
$$
DECLARE
    svc_status STRING DEFAULT 'NOT_FOUND';
    endpoint_url STRING DEFAULT '';
    demo_count NUMBER DEFAULT 0;
BEGIN
    BEGIN
        SHOW SERVICES LIKE 'DEMO_DASHBOARD_SERVICE' IN SCHEMA core;
        SELECT "status" INTO :svc_status FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) LIMIT 1;
    EXCEPTION WHEN OTHER THEN svc_status := 'NOT_FOUND'; END;

    BEGIN
        SHOW ENDPOINTS IN SERVICE core.demo_dashboard_service;
        SELECT "ingress_url" INTO :endpoint_url FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) WHERE "name" = 'dashboard-ui' LIMIT 1;
    EXCEPTION WHEN OTHER THEN endpoint_url := ''; END;

    BEGIN
        SELECT COUNT(*) INTO :demo_count FROM core.DEMO_REGISTRY WHERE ENABLED = TRUE;
    EXCEPTION WHEN OTHER THEN demo_count := 0; END;

    RETURN OBJECT_CONSTRUCT(
        'service', svc_status,
        'endpoint_url', endpoint_url,
        'registered_demos', demo_count
    )::STRING;
END;
$$;
GRANT USAGE ON PROCEDURE core.get_status() TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.resume_services()
RETURNS STRING
LANGUAGE SQL
AS
$$
DECLARE
    pool_name STRING;
    pool_status STRING DEFAULT 'UNKNOWN';
    svc_status STRING DEFAULT 'NOT_FOUND';
    resumed_items ARRAY DEFAULT ARRAY_CONSTRUCT();
BEGIN
    pool_name := (SELECT CURRENT_DATABASE()) || '_compute_pool';

    BEGIN
        SHOW COMPUTE POOLS LIKE :pool_name;
        SELECT "state" INTO :pool_status FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) LIMIT 1;
    EXCEPTION WHEN OTHER THEN pool_status := 'NOT_FOUND'; END;

    IF (pool_status IN ('SUSPENDED', 'STOPPING')) THEN
        ALTER COMPUTE POOL IDENTIFIER(:pool_name) RESUME;
        resumed_items := ARRAY_APPEND(resumed_items, 'compute_pool:' || pool_name);
    END IF;

    BEGIN
        SHOW SERVICES LIKE 'DEMO_DASHBOARD_SERVICE' IN SCHEMA core;
        SELECT "status" INTO :svc_status FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) LIMIT 1;
    EXCEPTION WHEN OTHER THEN svc_status := 'NOT_FOUND'; END;

    IF (svc_status = 'SUSPENDED') THEN
        ALTER SERVICE core.demo_dashboard_service RESUME;
        resumed_items := ARRAY_APPEND(resumed_items, 'service:demo_dashboard_service');
    END IF;

    IF (ARRAY_SIZE(resumed_items) = 0) THEN
        RETURN 'All services already running';
    END IF;
    RETURN 'Resumed ' || ARRAY_SIZE(resumed_items) || ' items: ' || ARRAY_TO_STRING(resumed_items, ', ');
END;
$$;
GRANT USAGE ON PROCEDURE core.resume_services() TO APPLICATION ROLE app_user;

-- =============================================================================
-- Seed default demos
-- =============================================================================

CALL core.REGISTER_DEMO('dwell-overview', 'Dwell Overview', 'KPIs, daily trends, and top facilities', 'Dwell Analysis', 'BarChart3', 10, 'FLEET_INTELLIGENCE', 'DWELL_ANALYSIS');
CALL core.REGISTER_DEMO('dwell-congestion', 'Congestion Map', 'H3 hexagon congestion by hour', 'Dwell Analysis', 'Map', 20, 'FLEET_INTELLIGENCE', 'DWELL_ANALYSIS');
CALL core.REGISTER_DEMO('dwell-utilization', 'Facility Utilization', 'Throughput vs dwell time', 'Dwell Analysis', 'Building2', 30, 'FLEET_INTELLIGENCE', 'DWELL_ANALYSIS');
CALL core.REGISTER_DEMO('dwell-sla', 'SLA Alerts', 'SLA breach monitoring by severity', 'Dwell Analysis', 'AlertTriangle', 40, 'FLEET_INTELLIGENCE', 'DWELL_ANALYSIS');
CALL core.REGISTER_DEMO('dwell-trip', 'Trip Inspector', 'Inspect individual trip GPS traces', 'Dwell Analysis', 'Route', 50, 'FLEET_INTELLIGENCE', 'DWELL_ANALYSIS');
CALL core.REGISTER_DEMO('dwell-driver', 'Driver Performance', 'Driver dwell time benchmarks', 'Dwell Analysis', 'Users', 60, 'FLEET_INTELLIGENCE', 'DWELL_ANALYSIS');
CALL core.REGISTER_DEMO('dwell-live', 'Live Operations', 'Real-time courier positions', 'Dwell Analysis', 'Radio', 70, 'FLEET_INTELLIGENCE', 'DWELL_ANALYSIS');
CALL core.REGISTER_DEMO('fleet-map', 'Fleet Map', 'Courier fleet overview', 'Fleet Delivery', 'MapPin', 80, 'FLEET_INTELLIGENCE', 'FLEET_INTELLIGENCE_FOOD_DELIVERY');
CALL core.REGISTER_DEMO('fleet-data', 'Data Builder', 'Data pipeline status', 'Fleet Delivery', 'Database', 90, 'FLEET_INTELLIGENCE', 'FLEET_INTELLIGENCE_FOOD_DELIVERY');
CALL core.REGISTER_DEMO('fleet-matrix', 'Matrix Builder', 'Travel time matrix builder', 'Fleet Delivery', 'Grid3x3', 100, 'FLEET_INTELLIGENCE', 'FLEET_INTELLIGENCE_FOOD_DELIVERY');
CALL core.REGISTER_DEMO('fleet-catchment', 'Catchment Panel', 'Restaurant catchment areas', 'Fleet Delivery', 'Target', 110, 'FLEET_INTELLIGENCE', 'FLEET_INTELLIGENCE_FOOD_DELIVERY');
CALL core.REGISTER_DEMO('taxi-overview', 'Fleet Overview', 'NYC taxi fleet dashboard', 'Fleet Taxis', 'Car', 120, 'FLEET_INTELLIGENCE', 'FLEET_INTELLIGENCE_TAXIS');
CALL core.REGISTER_DEMO('taxi-routes', 'Driver Routes', 'Individual driver route inspection', 'Fleet Taxis', 'Navigation', 130, 'FLEET_INTELLIGENCE', 'FLEET_INTELLIGENCE_TAXIS');
CALL core.REGISTER_DEMO('taxi-heatmap', 'Heat Map', 'H3 hex trip density heatmap', 'Fleet Taxis', 'Flame', 140, 'FLEET_INTELLIGENCE', 'FLEET_INTELLIGENCE_TAXIS');
CALL core.REGISTER_DEMO('route-opt', 'Route Optimization', 'VRP solver with vehicle routing', 'Route Optimization', 'Waypoints', 150, 'FLEET_INTELLIGENCE', 'ROUTE_OPTIMIZATION');
CALL core.REGISTER_DEMO('retail-catch', 'Retail Catchment', 'POI analysis with Overture Maps', 'Retail Catchment', 'Store', 160, 'FLEET_INTELLIGENCE', 'RETAIL_CATCHMENT');
CALL core.REGISTER_DEMO('deviation-dashboard', 'Deviation Dashboard', 'Route deviation analytics', 'Route Deviation', 'TrendingUp', 170, 'FLEET_INTELLIGENCE', 'ROUTE_DEVIATION');
CALL core.REGISTER_DEMO('deviation-compare', 'Route Comparison', 'Expected vs actual route overlay', 'Route Deviation', 'GitCompare', 180, 'FLEET_INTELLIGENCE', 'ROUTE_DEVIATION');
CALL core.REGISTER_DEMO('deviation-inspector', 'Route Inspector', 'GPS telemetry inspection with teleport detection', 'Route Deviation', 'Search', 185, 'FLEET_INTELLIGENCE', 'ROUTE_DEVIATION');
CALL core.REGISTER_DEMO('routing-agent', 'Routing Agent', 'AI-powered routing assistant', 'Routing Agent', 'Bot', 190, 'FLEET_INTELLIGENCE', 'ROUTING_AGENT');
CALL core.REGISTER_DEMO('travel-time', 'Travel Time Explorer', 'H3 isochrone visualization', 'Travel Time Matrix', 'Clock', 200, 'OPENROUTESERVICE_NATIVE_APP', 'TRAVEL_MATRIX');
CALL core.REGISTER_DEMO('data-studio', 'Fleet Data Studio', 'Synthetic data generation', 'Data Studio', 'Wand2', 210, 'FLEET_INTELLIGENCE', 'FLEET_INTELLIGENCE_FOOD_DELIVERY');

-- =============================================================================
-- POST-INSTALL GRANTS (run as ACCOUNTADMIN after CREATE APPLICATION)
-- =============================================================================
-- With manifest_version: 2, the following are AUTO-GRANTED at install:
--   - CREATE COMPUTE POOL, CREATE WAREHOUSE, BIND SERVICE ENDPOINT
--
-- Manual grants needed:
--
-- 1. Image repository access (for Docker image):
--    GRANT USAGE ON DATABASE DEMO_DASHBOARD_SETUP TO APPLICATION DEMO_DASHBOARD_APP;
--    GRANT USAGE ON SCHEMA DEMO_DASHBOARD_SETUP.PUBLIC TO APPLICATION DEMO_DASHBOARD_APP;
--    GRANT READ ON IMAGE REPOSITORY DEMO_DASHBOARD_SETUP.PUBLIC.DEMO_DASHBOARD_REPO TO APPLICATION DEMO_DASHBOARD_APP;
--
-- 2. External access for Carto map tiles:
--    CREATE OR REPLACE NETWORK RULE demo_dashboard_map_tiles_nr
--        MODE = EGRESS TYPE = HOST_PORT
--        VALUE_LIST = ('a.basemaps.cartocdn.com:443', 'b.basemaps.cartocdn.com:443', 'c.basemaps.cartocdn.com:443', 'd.basemaps.cartocdn.com:443');
--    CREATE OR REPLACE EXTERNAL ACCESS INTEGRATION demo_dashboard_map_tiles_eai
--        ALLOWED_NETWORK_RULES = (demo_dashboard_map_tiles_nr) ENABLED = TRUE;
--    GRANT USAGE ON INTEGRATION demo_dashboard_map_tiles_eai TO APPLICATION DEMO_DASHBOARD_APP;
--    CALL DEMO_DASHBOARD_APP.core.register_single_callback(
--        'EXTERNAL_ACCESS_REF', 'ADD',
--        SYSTEM$REFERENCE('EXTERNAL ACCESS INTEGRATION', 'DEMO_DASHBOARD_MAP_TILES_EAI', 'PERSISTENT', 'USAGE'));
--
-- 3. ORS native app access (for routing demos):
--    GRANT USAGE ON DATABASE OPENROUTESERVICE_NATIVE_APP TO APPLICATION DEMO_DASHBOARD_APP;
--    GRANT USAGE ON SCHEMA OPENROUTESERVICE_NATIVE_APP.ROUTING TO APPLICATION DEMO_DASHBOARD_APP;
--    GRANT USAGE ON SCHEMA OPENROUTESERVICE_NATIVE_APP.DATA TO APPLICATION DEMO_DASHBOARD_APP;
--    GRANT SELECT ON ALL TABLES IN SCHEMA OPENROUTESERVICE_NATIVE_APP.DATA TO APPLICATION DEMO_DASHBOARD_APP;
--    GRANT SELECT ON ALL VIEWS IN SCHEMA OPENROUTESERVICE_NATIVE_APP.DATA TO APPLICATION DEMO_DASHBOARD_APP;
--
-- 4. Overture Maps (for retail catchment):
--    GRANT IMPORTED PRIVILEGES ON DATABASE OVERTURE_MAPS__PLACES TO APPLICATION DEMO_DASHBOARD_APP;
--    GRANT IMPORTED PRIVILEGES ON DATABASE OVERTURE_MAPS__ADDRESSES TO APPLICATION DEMO_DASHBOARD_APP;
--
-- 5. App role:
--    GRANT APPLICATION ROLE DEMO_DASHBOARD_APP.APP_USER TO ROLE <YOUR_ROLE>;
--
-- 6. Deploy:
--    CALL DEMO_DASHBOARD_APP.core.deploy();
-- =============================================================================
