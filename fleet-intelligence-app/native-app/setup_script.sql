CREATE APPLICATION ROLE IF NOT EXISTS app_user;

CREATE SCHEMA IF NOT EXISTS core;
GRANT USAGE ON SCHEMA core TO APPLICATION ROLE app_user;

CREATE SCHEMA IF NOT EXISTS routing;
GRANT USAGE ON SCHEMA routing TO APPLICATION ROLE app_user;

CREATE SCHEMA IF NOT EXISTS data;
GRANT USAGE ON SCHEMA data TO APPLICATION ROLE app_user;

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
        WHEN 'EXTERNAL_ACCESS_DOWNLOAD_REF' THEN
            RETURN OBJECT_CONSTRUCT(
                'type', 'CONFIGURATION',
                'payload', OBJECT_CONSTRUCT(
                    'host_ports', ARRAY_CONSTRUCT('download.bbbike.org:443', 'download.geofabrik.de:443'),
                    'allowed_secrets', 'NONE'
                )
            )::STRING;
        ELSE
            RETURN '';
    END CASE;
END;
$$;
GRANT USAGE ON PROCEDURE core.get_config_for_ref(STRING) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.create_ui_compute_pool()
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
    RETURN 'UI compute pool created: ' || pool_name;
END;
$$;
GRANT USAGE ON PROCEDURE core.create_ui_compute_pool() TO APPLICATION ROLE app_user;

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

CREATE OR REPLACE PROCEDURE core.create_ui_service()
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
    RETURN 'UI service created';
END;
$$;
GRANT USAGE ON PROCEDURE core.create_ui_service() TO APPLICATION ROLE app_user;

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
                    RETURN 'Version init - service deferred. Run DEPLOY() after grants.';
            END;
    END;
    GRANT USAGE ON SERVICE core.fleet_intelligence_service TO APPLICATION ROLE app_user;
    GRANT SERVICE ROLE core.fleet_intelligence_service!ALL_ENDPOINTS_USAGE TO APPLICATION ROLE app_user;
    GRANT OPERATE ON SERVICE core.fleet_intelligence_service TO APPLICATION ROLE app_user;
    GRANT MONITOR ON SERVICE core.fleet_intelligence_service TO APPLICATION ROLE app_user;
    RETURN 'Version initialized';
EXCEPTION
    WHEN OTHER THEN
        RETURN 'Version init deferred: ' || SQLERRM;
END;
$$;
GRANT USAGE ON PROCEDURE core.version_init() TO APPLICATION ROLE app_user;

-- =============================================================================
-- ROUTING: ORS compute pool, stages, services, SQL functions
-- =============================================================================

CREATE OR REPLACE PROCEDURE routing.create_routing_pool()
RETURNS STRING
LANGUAGE SQL
AS
$$
BEGIN
    LET pool_name := (SELECT CURRENT_DATABASE()) || '_routing_pool';
    CREATE COMPUTE POOL IF NOT EXISTS IDENTIFIER(:pool_name)
        INSTANCE_FAMILY = HIGHMEM_X64_S
        MIN_NODES = 1
        MAX_NODES = 10
        AUTO_RESUME = TRUE
        AUTO_SUSPEND_SECS = 14400;
    RETURN 'Routing compute pool created: ' || pool_name;
END;
$$;
GRANT USAGE ON PROCEDURE routing.create_routing_pool() TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE routing.create_stages()
RETURNS STRING
LANGUAGE SQL
AS
$$
BEGIN
    CREATE STAGE IF NOT EXISTS routing.ORS_SPCS_STAGE ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE') DIRECTORY = (ENABLE = TRUE);
    CREATE STAGE IF NOT EXISTS routing.ORS_GRAPHS_SPCS_STAGE ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE') DIRECTORY = (ENABLE = TRUE);
    CREATE STAGE IF NOT EXISTS routing.ORS_ELEVATION_CACHE_SPCS_STAGE ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE') DIRECTORY = (ENABLE = TRUE);

    GRANT READ ON STAGE routing.ORS_SPCS_STAGE TO APPLICATION ROLE app_user;
    GRANT WRITE ON STAGE routing.ORS_SPCS_STAGE TO APPLICATION ROLE app_user;
    GRANT READ ON STAGE routing.ORS_GRAPHS_SPCS_STAGE TO APPLICATION ROLE app_user;
    GRANT WRITE ON STAGE routing.ORS_GRAPHS_SPCS_STAGE TO APPLICATION ROLE app_user;
    GRANT READ ON STAGE routing.ORS_ELEVATION_CACHE_SPCS_STAGE TO APPLICATION ROLE app_user;
    GRANT WRITE ON STAGE routing.ORS_ELEVATION_CACHE_SPCS_STAGE TO APPLICATION ROLE app_user;

    RETURN 'Routing stages created';
END;
$$;
GRANT USAGE ON PROCEDURE routing.create_stages() TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE routing.start_downloader()
RETURNS STRING
LANGUAGE SQL
AS
$$
BEGIN
    LET pool_name := (SELECT CURRENT_DATABASE()) || '_routing_pool';

    ALTER SERVICE IF EXISTS routing.downloader_service
        FROM SPECIFICATION_FILE='services/downloader/downloader_spec.yaml';

    CREATE SERVICE IF NOT EXISTS routing.downloader_service
        IN COMPUTE POOL IDENTIFIER(:pool_name)
        FROM SPECIFICATION_FILE='services/downloader/downloader_spec.yaml'
        MIN_INSTANCES = 1
        MAX_INSTANCES = 1
        AUTO_SUSPEND_SECS = 600
        EXTERNAL_ACCESS_INTEGRATIONS = (reference('external_access_download_ref'));

    GRANT OPERATE ON SERVICE routing.downloader_service TO APPLICATION ROLE app_user;
    GRANT MONITOR ON SERVICE routing.downloader_service TO APPLICATION ROLE app_user;

    CREATE OR REPLACE FUNCTION routing.DOWNLOAD_PBF(folder VARCHAR, filename VARCHAR, url VARCHAR)
        RETURNS VARCHAR
        SERVICE=routing.downloader_service
        ENDPOINT='downloader'
        MAX_BATCH_ROWS = 1
        AS '/download_to_stage';
    GRANT USAGE ON FUNCTION routing.DOWNLOAD_PBF(VARCHAR, VARCHAR, VARCHAR) TO APPLICATION ROLE app_user;

    RETURN 'Downloader service started and DOWNLOAD_PBF function created';
END;
$$;
GRANT USAGE ON PROCEDURE routing.start_downloader() TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE routing.create_services()
RETURNS STRING
LANGUAGE SQL
AS
$$
BEGIN
    LET pool_name := (SELECT CURRENT_DATABASE()) || '_routing_pool';

    DROP SERVICE IF EXISTS routing.ors_service;
    DROP SERVICE IF EXISTS routing.vroom_service;
    DROP SERVICE IF EXISTS routing.routing_gateway_service;

    CREATE SERVICE routing.ors_service
        IN COMPUTE POOL IDENTIFIER(:pool_name)
        FROM SPECIFICATION_FILE='services/ors_service.yaml'
        MIN_INSTANCES = 1
        MAX_INSTANCES = 10
        AUTO_SUSPEND_SECS = 14400;

    CREATE SERVICE routing.vroom_service
        IN COMPUTE POOL IDENTIFIER(:pool_name)
        FROM SPECIFICATION_FILE='services/vroom_service.yaml'
        MIN_INSTANCES = 1
        MAX_INSTANCES = 1
        AUTO_SUSPEND_SECS = 14400;

    CREATE SERVICE routing.routing_gateway_service
        IN COMPUTE POOL IDENTIFIER(:pool_name)
        FROM SPECIFICATION_FILE='services/routing_gateway_service.yaml'
        MIN_INSTANCES = 1
        MAX_INSTANCES = 10
        AUTO_SUSPEND_SECS = 14400;

    GRANT OPERATE ON SERVICE routing.ors_service TO APPLICATION ROLE app_user;
    GRANT MONITOR ON SERVICE routing.ors_service TO APPLICATION ROLE app_user;
    GRANT OPERATE ON SERVICE routing.vroom_service TO APPLICATION ROLE app_user;
    GRANT MONITOR ON SERVICE routing.vroom_service TO APPLICATION ROLE app_user;
    GRANT OPERATE ON SERVICE routing.routing_gateway_service TO APPLICATION ROLE app_user;
    GRANT MONITOR ON SERVICE routing.routing_gateway_service TO APPLICATION ROLE app_user;

    RETURN 'Routing services created';
END;
$$;
GRANT USAGE ON PROCEDURE routing.create_services() TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE routing.create_functions()
RETURNS STRING
LANGUAGE SQL
AS
$$
BEGIN
    CREATE OR REPLACE FUNCTION routing.DIRECTIONS(method VARCHAR, jstart ARRAY, jend ARRAY)
        RETURNS VARIANT
        SERVICE=routing.routing_gateway_service
        ENDPOINT='gateway'
        MAX_BATCH_ROWS = 1000
        AS '/directions_tabular';
    GRANT USAGE ON FUNCTION routing.DIRECTIONS(VARCHAR, ARRAY, ARRAY) TO APPLICATION ROLE app_user;

    CREATE OR REPLACE FUNCTION routing.DIRECTIONS(method VARCHAR, locations VARIANT)
        RETURNS VARIANT
        SERVICE=routing.routing_gateway_service
        ENDPOINT='gateway'
        MAX_BATCH_ROWS = 1000
        AS '/directions';
    GRANT USAGE ON FUNCTION routing.DIRECTIONS(VARCHAR, VARIANT) TO APPLICATION ROLE app_user;

    CREATE OR REPLACE FUNCTION routing.ISOCHRONES(method TEXT, lon FLOAT, lat FLOAT, range INT)
        RETURNS VARIANT
        SERVICE=routing.routing_gateway_service
        ENDPOINT='gateway'
        MAX_BATCH_ROWS = 1000
        AS '/isochrones_tabular';
    GRANT USAGE ON FUNCTION routing.ISOCHRONES(TEXT, FLOAT, FLOAT, INT) TO APPLICATION ROLE app_user;

    CREATE OR REPLACE FUNCTION routing.MATRIX(method VARCHAR, locations ARRAY)
        RETURNS VARIANT
        SERVICE=routing.routing_gateway_service
        ENDPOINT='gateway'
        MAX_BATCH_ROWS = 1000
        AS '/matrix_tabular';
    GRANT USAGE ON FUNCTION routing.MATRIX(VARCHAR, ARRAY) TO APPLICATION ROLE app_user;

    CREATE OR REPLACE FUNCTION routing.MATRIX(method VARCHAR, options VARIANT)
        RETURNS VARIANT
        SERVICE=routing.routing_gateway_service
        ENDPOINT='gateway'
        MAX_BATCH_ROWS = 100
        AS '/matrix';
    GRANT USAGE ON FUNCTION routing.MATRIX(VARCHAR, VARIANT) TO APPLICATION ROLE app_user;

    CREATE OR REPLACE FUNCTION routing.MATRIX_TABULAR(method VARCHAR, origin ARRAY, destinations ARRAY)
        RETURNS VARIANT
        SERVICE=routing.routing_gateway_service
        ENDPOINT='gateway'
        MAX_BATCH_ROWS = 1000
        AS '/matrix_tabular';
    GRANT USAGE ON FUNCTION routing.MATRIX_TABULAR(VARCHAR, ARRAY, ARRAY) TO APPLICATION ROLE app_user;

    CREATE OR REPLACE FUNCTION routing.OPTIMIZATION(jobs ARRAY, vehicles ARRAY, matrices ARRAY DEFAULT [])
        RETURNS VARIANT
        SERVICE=routing.routing_gateway_service
        ENDPOINT='gateway'
        MAX_BATCH_ROWS = 1000
        AS '/optimization_tabular';
    GRANT USAGE ON FUNCTION routing.OPTIMIZATION(ARRAY, ARRAY, ARRAY) TO APPLICATION ROLE app_user;

    CREATE OR REPLACE FUNCTION routing.OPTIMIZATION(challenge VARIANT)
        RETURNS VARIANT
        SERVICE=routing.routing_gateway_service
        ENDPOINT='gateway'
        MAX_BATCH_ROWS = 1000
        AS '/optimization';
    GRANT USAGE ON FUNCTION routing.OPTIMIZATION(VARIANT) TO APPLICATION ROLE app_user;

    CREATE OR REPLACE FUNCTION routing.ORS_STATUS()
        RETURNS VARIANT
        SERVICE=routing.routing_gateway_service
        ENDPOINT='gateway'
        MAX_BATCH_ROWS = 1
        AS '/ors_status';
    GRANT USAGE ON FUNCTION routing.ORS_STATUS() TO APPLICATION ROLE app_user;

    RETURN 'Routing functions created';
END;
$$;
GRANT USAGE ON PROCEDURE routing.create_functions() TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE routing.setup_ors()
RETURNS STRING
LANGUAGE SQL
AS
$$
BEGIN
    CALL routing.create_routing_pool();
    CALL routing.create_stages();
    BEGIN
        CALL routing.start_downloader();
    EXCEPTION
        WHEN OTHER THEN NULL;
    END;
    CALL routing.create_services();
    SELECT SYSTEM$WAIT(30);
    CALL routing.create_functions();
    RETURN 'ORS routing engine deployed (with downloader service)';
END;
$$;
GRANT USAGE ON PROCEDURE routing.setup_ors() TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE routing.create_city_pool(P_REGION VARCHAR)
RETURNS STRING
LANGUAGE SQL
AS
$$
BEGIN
    LET pool_name := (SELECT CURRENT_DATABASE()) || '_' || UPPER(:P_REGION) || '_ORS_POOL';
    CREATE COMPUTE POOL IF NOT EXISTS IDENTIFIER(:pool_name)
        INSTANCE_FAMILY = HIGHMEM_X64_S
        MIN_NODES = 1
        MAX_NODES = 1
        AUTO_RESUME = TRUE
        AUTO_SUSPEND_SECS = 3600;
    RETURN 'City ORS pool created: ' || pool_name;
END;
$$;
GRANT USAGE ON PROCEDURE routing.create_city_pool(VARCHAR) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE routing.create_city_ors_service(P_REGION VARCHAR)
RETURNS STRING
LANGUAGE SQL
AS
$$
DECLARE
    db_name VARCHAR;
    pool_name VARCHAR;
    svc_name VARCHAR;
    gw_name VARCHAR;
    ors_dns VARCHAR;
    ors_spec VARCHAR;
    gw_spec VARCHAR;
    create_sql VARCHAR;
BEGIN
    db_name := (SELECT CURRENT_DATABASE());
    pool_name := db_name || '_' || UPPER(:P_REGION) || '_ORS_POOL';
    svc_name := 'ORS_SERVICE_' || UPPER(:P_REGION);
    gw_name := 'ROUTING_GATEWAY_' || UPPER(:P_REGION);
    ors_dns := LOWER(REPLACE(svc_name, '_', '-'));

    CREATE COMPUTE POOL IF NOT EXISTS IDENTIFIER(:pool_name)
        INSTANCE_FAMILY = HIGHMEM_X64_S
        MIN_NODES = 1
        MAX_NODES = 1
        AUTO_RESUME = TRUE
        AUTO_SUSPEND_SECS = 3600;

    ors_spec := '{"spec":{"containers":[{"name":"ors","image":"/openrouteservice_setup/public/image_repository/openrouteservice:v9.0.0","volumeMounts":[{"name":"files","mountPath":"/home/ors/files"},{"name":"graphs","mountPath":"/home/ors/graphs"},{"name":"elevation-cache","mountPath":"/home/ors/elevation_cache"}],"env":{"REBUILD_GRAPHS":"false","ORS_CONFIG_LOCATION":"/home/ors/files/ors-config.yml","XMS":"3G","XMX":"200G"}}],"endpoints":[{"name":"ors","port":8082,"public":false}],"volumes":[{"name":"files","source":"@ROUTING.ORS_SPCS_STAGE/' || :P_REGION || '"},{"name":"graphs","source":"@ROUTING.ORS_GRAPHS_SPCS_STAGE/' || :P_REGION || '"},{"name":"elevation-cache","source":"@ROUTING.ORS_ELEVATION_CACHE_SPCS_STAGE/' || :P_REGION || '"}]}}';

    EXECUTE IMMEDIATE 'DROP SERVICE IF EXISTS routing.' || svc_name;
    create_sql := 'CREATE SERVICE routing.' || svc_name || ' IN COMPUTE POOL ' || pool_name || ' FROM SPECIFICATION ''' || ors_spec || ''' MIN_INSTANCES = 1 MAX_INSTANCES = 1 AUTO_SUSPEND_SECS = 3600';
    EXECUTE IMMEDIATE :create_sql;

    gw_spec := '{"spec":{"containers":[{"name":"reverse-proxy","image":"/openrouteservice_setup/public/image_repository/routing_reverse_proxy:v0.8.1","env":{"SERVER_HOST":"0.0.0.0","SERVER_PORT":"8000","VROOM_HOST":"vroom-service","VROOM_PORT":"3000","ORS_HOST":"' || ors_dns || '","ORS_PORT":"8082","ORS_API_PATH":"/ors/v2"}}],"endpoints":[{"name":"gateway","port":8000,"public":false}]}}';

    EXECUTE IMMEDIATE 'DROP SERVICE IF EXISTS routing.' || gw_name;
    create_sql := 'CREATE SERVICE routing.' || gw_name || ' IN COMPUTE POOL ' || pool_name || ' FROM SPECIFICATION ''' || gw_spec || ''' MIN_INSTANCES = 1 MAX_INSTANCES = 1 AUTO_SUSPEND_SECS = 3600';
    EXECUTE IMMEDIATE :create_sql;

    EXECUTE IMMEDIATE 'GRANT OPERATE ON SERVICE routing.' || svc_name || ' TO APPLICATION ROLE app_user';
    EXECUTE IMMEDIATE 'GRANT MONITOR ON SERVICE routing.' || svc_name || ' TO APPLICATION ROLE app_user';
    EXECUTE IMMEDIATE 'GRANT OPERATE ON SERVICE routing.' || gw_name || ' TO APPLICATION ROLE app_user';
    EXECUTE IMMEDIATE 'GRANT MONITOR ON SERVICE routing.' || gw_name || ' TO APPLICATION ROLE app_user';

    RETURN 'City ORS services created for region ' || :P_REGION || ': ' || svc_name || ', ' || gw_name;
END;
$$;
GRANT USAGE ON PROCEDURE routing.create_city_ors_service(VARCHAR) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE routing.create_city_functions(P_REGION VARCHAR)
RETURNS STRING
LANGUAGE SQL
AS
$$
BEGIN
    LET gw_name VARCHAR := 'ROUTING_GATEWAY_' || UPPER(:P_REGION);
    LET fn_dir VARCHAR := 'DIRECTIONS_' || UPPER(:P_REGION);

    EXECUTE IMMEDIATE '
    CREATE OR REPLACE FUNCTION routing.' || fn_dir || '(method VARCHAR, jstart ARRAY, jend ARRAY)
        RETURNS VARIANT
        SERVICE=routing.' || gw_name || '
        ENDPOINT=''gateway''
        MAX_BATCH_ROWS = 1000
        AS ''/directions_tabular''';
    EXECUTE IMMEDIATE 'GRANT USAGE ON FUNCTION routing.' || fn_dir || '(VARCHAR, ARRAY, ARRAY) TO APPLICATION ROLE app_user';

    EXECUTE IMMEDIATE '
    CREATE OR REPLACE FUNCTION routing.' || fn_dir || '(method VARCHAR, locations VARIANT)
        RETURNS VARIANT
        SERVICE=routing.' || gw_name || '
        ENDPOINT=''gateway''
        MAX_BATCH_ROWS = 1000
        AS ''/directions''';
    EXECUTE IMMEDIATE 'GRANT USAGE ON FUNCTION routing.' || fn_dir || '(VARCHAR, VARIANT) TO APPLICATION ROLE app_user';

    EXECUTE IMMEDIATE '
    CREATE OR REPLACE FUNCTION routing.MATRIX_' || UPPER(:P_REGION) || '(method VARCHAR, origin ARRAY, destinations ARRAY)
        RETURNS VARIANT
        SERVICE=routing.' || gw_name || '
        ENDPOINT=''gateway''
        MAX_BATCH_ROWS = 1000
        AS ''/matrix_tabular''';
    EXECUTE IMMEDIATE 'GRANT USAGE ON FUNCTION routing.MATRIX_' || UPPER(:P_REGION) || '(VARCHAR, ARRAY, ARRAY) TO APPLICATION ROLE app_user';

    RETURN 'City routing functions created for region ' || :P_REGION;
END;
$$;
GRANT USAGE ON PROCEDURE routing.create_city_functions(VARCHAR) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE routing.setup_city_ors(P_REGION VARCHAR)
RETURNS STRING
LANGUAGE SQL
AS
$$
BEGIN
    CALL routing.create_stages();
    CALL routing.create_city_ors_service(:P_REGION);
    SELECT SYSTEM$WAIT(30);
    CALL routing.create_city_functions(:P_REGION);
    RETURN 'City ORS deployed for region: ' || :P_REGION;
END;
$$;
GRANT USAGE ON PROCEDURE routing.setup_city_ors(VARCHAR) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE routing.resume_city_ors(P_REGION VARCHAR)
RETURNS STRING
LANGUAGE SQL
AS
$$
BEGIN
    LET svc_name VARCHAR := 'ORS_SERVICE_' || UPPER(:P_REGION);
    LET gw_name VARCHAR := 'ROUTING_GATEWAY_' || UPPER(:P_REGION);
    EXECUTE IMMEDIATE 'ALTER SERVICE routing.' || svc_name || ' RESUME';
    BEGIN
        EXECUTE IMMEDIATE 'ALTER SERVICE routing.' || gw_name || ' RESUME';
    EXCEPTION WHEN OTHER THEN NULL;
    END;
    RETURN 'Resumed ORS services for ' || :P_REGION;
END;
$$;
GRANT USAGE ON PROCEDURE routing.resume_city_ors(VARCHAR) TO APPLICATION ROLE app_user;

-- =============================================================================
-- DATA: Tables for food delivery + travel time matrix
-- =============================================================================

CREATE TABLE IF NOT EXISTS data.RESTAURANTS (
    RESTAURANT_ID VARCHAR,
    LOCATION GEOGRAPHY,
    NAME VARCHAR,
    CUISINE_TYPE VARCHAR,
    ADDRESS VARCHAR,
    CITY VARCHAR,
    STATE VARCHAR
);
GRANT SELECT ON TABLE data.RESTAURANTS TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE data.RESTAURANTS TO APPLICATION ROLE app_user;
GRANT DELETE ON TABLE data.RESTAURANTS TO APPLICATION ROLE app_user;

CREATE TABLE IF NOT EXISTS data.CUSTOMER_ADDRESSES (
    ADDRESS_ID VARCHAR,
    LOCATION GEOGRAPHY,
    FULL_ADDRESS VARCHAR,
    STREET VARCHAR,
    POSTCODE VARCHAR,
    STATE VARCHAR,
    CITY VARCHAR
);
GRANT SELECT ON TABLE data.CUSTOMER_ADDRESSES TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE data.CUSTOMER_ADDRESSES TO APPLICATION ROLE app_user;
GRANT DELETE ON TABLE data.CUSTOMER_ADDRESSES TO APPLICATION ROLE app_user;

CREATE TABLE IF NOT EXISTS data.COURIERS (
    COURIER_ID VARCHAR,
    HOME_ADDRESS_ID VARCHAR,
    SHIFT_TYPE VARCHAR,
    SHIFT_START_HOUR NUMBER,
    SHIFT_END_HOUR NUMBER,
    SHIFT_CROSSES_MIDNIGHT VARCHAR,
    VEHICLE_TYPE VARCHAR
);
GRANT SELECT ON TABLE data.COURIERS TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE data.COURIERS TO APPLICATION ROLE app_user;
GRANT DELETE ON TABLE data.COURIERS TO APPLICATION ROLE app_user;

CREATE TABLE IF NOT EXISTS data.DELIVERY_ORDERS (
    ORDER_ID VARCHAR,
    COURIER_ID VARCHAR,
    ORDER_HOUR NUMBER,
    ORDER_NUMBER NUMBER,
    SHIFT_TYPE VARCHAR,
    VEHICLE_TYPE VARCHAR,
    RESTAURANT_IDX NUMBER,
    CUSTOMER_IDX NUMBER,
    PREP_TIME_MINS NUMBER,
    ORDER_STATUS VARCHAR
);
GRANT SELECT ON TABLE data.DELIVERY_ORDERS TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE data.DELIVERY_ORDERS TO APPLICATION ROLE app_user;
GRANT DELETE ON TABLE data.DELIVERY_ORDERS TO APPLICATION ROLE app_user;

CREATE TABLE IF NOT EXISTS data.ORDERS_WITH_LOCATIONS (
    ORDER_ID VARCHAR,
    COURIER_ID VARCHAR,
    ORDER_HOUR NUMBER,
    ORDER_NUMBER NUMBER,
    SHIFT_TYPE VARCHAR,
    VEHICLE_TYPE VARCHAR,
    RESTAURANT_ID VARCHAR,
    RESTAURANT_NAME VARCHAR,
    CUISINE_TYPE VARCHAR,
    RESTAURANT_LOCATION GEOGRAPHY,
    RESTAURANT_ADDRESS VARCHAR,
    CUSTOMER_ADDRESS_ID VARCHAR,
    CUSTOMER_ADDRESS VARCHAR,
    CUSTOMER_LOCATION GEOGRAPHY,
    PREP_TIME_MINS NUMBER,
    ORDER_STATUS VARCHAR
);
GRANT SELECT ON TABLE data.ORDERS_WITH_LOCATIONS TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE data.ORDERS_WITH_LOCATIONS TO APPLICATION ROLE app_user;
GRANT DELETE ON TABLE data.ORDERS_WITH_LOCATIONS TO APPLICATION ROLE app_user;

CREATE TABLE IF NOT EXISTS data.DELIVERY_ROUTES (
    COURIER_ID VARCHAR,
    ORDER_ID VARCHAR,
    ORDER_HOUR NUMBER,
    ORDER_NUMBER NUMBER,
    SHIFT_TYPE VARCHAR,
    VEHICLE_TYPE VARCHAR,
    RESTAURANT_ID VARCHAR,
    RESTAURANT_NAME VARCHAR,
    CUISINE_TYPE VARCHAR,
    RESTAURANT_LOCATION GEOGRAPHY,
    RESTAURANT_ADDRESS VARCHAR,
    CUSTOMER_ADDRESS_ID VARCHAR,
    CUSTOMER_ADDRESS VARCHAR,
    CUSTOMER_LOCATION GEOGRAPHY,
    PREP_TIME_MINS NUMBER,
    ORDER_STATUS VARCHAR,
    ROUTE_RESPONSE VARIANT
);
GRANT SELECT ON TABLE data.DELIVERY_ROUTES TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE data.DELIVERY_ROUTES TO APPLICATION ROLE app_user;
GRANT DELETE ON TABLE data.DELIVERY_ROUTES TO APPLICATION ROLE app_user;

CREATE TABLE IF NOT EXISTS data.DELIVERY_ROUTES_PARSED (
    COURIER_ID VARCHAR,
    ORDER_ID VARCHAR,
    ORDER_HOUR NUMBER,
    ORDER_NUMBER NUMBER,
    SHIFT_TYPE VARCHAR,
    VEHICLE_TYPE VARCHAR,
    RESTAURANT_ID VARCHAR,
    RESTAURANT_NAME VARCHAR,
    CUISINE_TYPE VARCHAR,
    RESTAURANT_LOCATION GEOGRAPHY,
    RESTAURANT_ADDRESS VARCHAR,
    CUSTOMER_ADDRESS_ID VARCHAR,
    CUSTOMER_ADDRESS VARCHAR,
    CUSTOMER_LOCATION GEOGRAPHY,
    PREP_TIME_MINS NUMBER,
    ORDER_STATUS VARCHAR,
    ROUTE_GEOMETRY GEOGRAPHY,
    ROUTE_DISTANCE_METERS FLOAT,
    ROUTE_DURATION_SECS FLOAT
);
GRANT SELECT ON TABLE data.DELIVERY_ROUTES_PARSED TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE data.DELIVERY_ROUTES_PARSED TO APPLICATION ROLE app_user;
GRANT DELETE ON TABLE data.DELIVERY_ROUTES_PARSED TO APPLICATION ROLE app_user;

CREATE TABLE IF NOT EXISTS data.DELIVERY_ROUTE_GEOMETRIES (
    COURIER_ID VARCHAR,
    ORDER_ID VARCHAR,
    ORDER_TIME TIMESTAMP_NTZ,
    PICKUP_TIME TIMESTAMP_NTZ,
    DELIVERY_TIME TIMESTAMP_NTZ,
    RESTAURANT_ID VARCHAR,
    RESTAURANT_NAME VARCHAR,
    CUISINE_TYPE VARCHAR,
    RESTAURANT_LOCATION GEOGRAPHY,
    RESTAURANT_ADDRESS VARCHAR,
    CUSTOMER_ADDRESS_ID VARCHAR,
    CUSTOMER_ADDRESS VARCHAR,
    CUSTOMER_LOCATION GEOGRAPHY,
    PREP_TIME_MINS NUMBER,
    ORDER_STATUS VARCHAR,
    ROUTE_DURATION_SECS FLOAT,
    ROUTE_DISTANCE_METERS FLOAT,
    GEOMETRY GEOGRAPHY,
    SHIFT_TYPE VARCHAR,
    VEHICLE_TYPE VARCHAR,
    CITY VARCHAR
);
GRANT SELECT ON TABLE data.DELIVERY_ROUTE_GEOMETRIES TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE data.DELIVERY_ROUTE_GEOMETRIES TO APPLICATION ROLE app_user;
GRANT DELETE ON TABLE data.DELIVERY_ROUTE_GEOMETRIES TO APPLICATION ROLE app_user;

CREATE TABLE IF NOT EXISTS data.COURIER_LOCATIONS (
    ORDER_ID VARCHAR,
    COURIER_ID VARCHAR,
    ORDER_TIME TIMESTAMP_NTZ,
    PICKUP_TIME TIMESTAMP_NTZ,
    DROPOFF_TIME TIMESTAMP_NTZ,
    RESTAURANT_LOCATION GEOGRAPHY,
    CUSTOMER_LOCATION GEOGRAPHY,
    ROUTE GEOGRAPHY,
    POINT_GEOM GEOGRAPHY,
    CURR_TIME TIMESTAMP_NTZ,
    POINT_INDEX NUMBER,
    COURIER_STATE VARCHAR,
    KMH NUMBER,
    CITY VARCHAR
);
GRANT SELECT ON TABLE data.COURIER_LOCATIONS TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE data.COURIER_LOCATIONS TO APPLICATION ROLE app_user;
GRANT DELETE ON TABLE data.COURIER_LOCATIONS TO APPLICATION ROLE app_user;

CREATE TABLE IF NOT EXISTS data.RESTAURANTS_NUMBERED (
    RESTAURANT_ID VARCHAR,
    LOCATION GEOGRAPHY,
    NAME VARCHAR,
    CUISINE_TYPE VARCHAR,
    ADDRESS VARCHAR,
    RN NUMBER
);
GRANT SELECT ON TABLE data.RESTAURANTS_NUMBERED TO APPLICATION ROLE app_user;

CREATE TABLE IF NOT EXISTS data.ADDRESSES_NUMBERED (
    ADDRESS_ID VARCHAR,
    LOCATION GEOGRAPHY,
    FULL_ADDRESS VARCHAR,
    RN NUMBER
);
GRANT SELECT ON TABLE data.ADDRESSES_NUMBERED TO APPLICATION ROLE app_user;

-- Travel time matrix tables (final flattened output)
CREATE TABLE IF NOT EXISTS data.CA_TRAVEL_TIME_RES7 (
    ORIGIN_H3 VARCHAR,
    DEST_H3 VARCHAR,
    TRAVEL_TIME_SECONDS FLOAT,
    TRAVEL_DISTANCE_METERS FLOAT,
    CALCULATED_AT TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP(),
    REGION VARCHAR
);
GRANT SELECT ON TABLE data.CA_TRAVEL_TIME_RES7 TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE data.CA_TRAVEL_TIME_RES7 TO APPLICATION ROLE app_user;
GRANT DELETE ON TABLE data.CA_TRAVEL_TIME_RES7 TO APPLICATION ROLE app_user;
ALTER TABLE IF EXISTS data.CA_TRAVEL_TIME_RES7 ADD COLUMN IF NOT EXISTS REGION VARCHAR;

CREATE TABLE IF NOT EXISTS data.CA_TRAVEL_TIME_RES8 (
    ORIGIN_H3 VARCHAR,
    DEST_H3 VARCHAR,
    TRAVEL_TIME_SECONDS FLOAT,
    TRAVEL_DISTANCE_METERS FLOAT,
    CALCULATED_AT TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP(),
    REGION VARCHAR
);
GRANT SELECT ON TABLE data.CA_TRAVEL_TIME_RES8 TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE data.CA_TRAVEL_TIME_RES8 TO APPLICATION ROLE app_user;
GRANT DELETE ON TABLE data.CA_TRAVEL_TIME_RES8 TO APPLICATION ROLE app_user;
ALTER TABLE IF EXISTS data.CA_TRAVEL_TIME_RES8 ADD COLUMN IF NOT EXISTS REGION VARCHAR;

CREATE TABLE IF NOT EXISTS data.CA_TRAVEL_TIME_RES9 (
    ORIGIN_H3 VARCHAR,
    DEST_H3 VARCHAR,
    TRAVEL_TIME_SECONDS FLOAT,
    TRAVEL_DISTANCE_METERS FLOAT,
    CALCULATED_AT TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP(),
    REGION VARCHAR
);
GRANT SELECT ON TABLE data.CA_TRAVEL_TIME_RES9 TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE data.CA_TRAVEL_TIME_RES9 TO APPLICATION ROLE app_user;
GRANT DELETE ON TABLE data.CA_TRAVEL_TIME_RES9 TO APPLICATION ROLE app_user;
ALTER TABLE IF EXISTS data.CA_TRAVEL_TIME_RES9 ADD COLUMN IF NOT EXISTS REGION VARCHAR;

-- H3 hexagon tables
CREATE TABLE IF NOT EXISTS data.CA_H3_RES7 (H3_INDEX VARCHAR, CENTER_LAT FLOAT, CENTER_LON FLOAT);
GRANT SELECT ON TABLE data.CA_H3_RES7 TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE data.CA_H3_RES7 TO APPLICATION ROLE app_user;

CREATE TABLE IF NOT EXISTS data.CA_H3_RES8 (H3_INDEX VARCHAR, CENTER_LAT FLOAT, CENTER_LON FLOAT);
GRANT SELECT ON TABLE data.CA_H3_RES8 TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE data.CA_H3_RES8 TO APPLICATION ROLE app_user;

CREATE TABLE IF NOT EXISTS data.CA_H3_RES9 (H3_INDEX VARCHAR, CENTER_LAT FLOAT, CENTER_LON FLOAT);
GRANT SELECT ON TABLE data.CA_H3_RES9 TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE data.CA_H3_RES9 TO APPLICATION ROLE app_user;

-- Work queue tables (pre-computed origin + destinations per row, ready for MATRIX_TABULAR)
CREATE TABLE IF NOT EXISTS data.CA_WORK_QUEUE_RES7 (
    SEQ_ID INTEGER, ORIGIN_H3 VARCHAR, ORIGIN_LON FLOAT, ORIGIN_LAT FLOAT,
    DEST_COORDS ARRAY, DEST_HEX_IDS ARRAY
);
GRANT SELECT ON TABLE data.CA_WORK_QUEUE_RES7 TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE data.CA_WORK_QUEUE_RES7 TO APPLICATION ROLE app_user;

CREATE TABLE IF NOT EXISTS data.CA_WORK_QUEUE_RES8 (
    SEQ_ID INTEGER, ORIGIN_H3 VARCHAR, ORIGIN_LON FLOAT, ORIGIN_LAT FLOAT,
    DEST_COORDS ARRAY, DEST_HEX_IDS ARRAY
);
GRANT SELECT ON TABLE data.CA_WORK_QUEUE_RES8 TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE data.CA_WORK_QUEUE_RES8 TO APPLICATION ROLE app_user;

CREATE TABLE IF NOT EXISTS data.CA_WORK_QUEUE_RES9 (
    SEQ_ID INTEGER, ORIGIN_H3 VARCHAR, ORIGIN_LON FLOAT, ORIGIN_LAT FLOAT,
    DEST_COORDS ARRAY, DEST_HEX_IDS ARRAY
);
GRANT SELECT ON TABLE data.CA_WORK_QUEUE_RES9 TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE data.CA_WORK_QUEUE_RES9 TO APPLICATION ROLE app_user;

-- Raw staging tables (VARIANT payload from MATRIX_TABULAR — no FLATTEN during ingestion)
CREATE TABLE IF NOT EXISTS data.CA_MATRIX_RAW_RES7 (
    SEQ_ID INTEGER, ORIGIN_H3 VARCHAR, DEST_HEX_IDS ARRAY, MATRIX_RESULT VARIANT
);
GRANT SELECT ON TABLE data.CA_MATRIX_RAW_RES7 TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE data.CA_MATRIX_RAW_RES7 TO APPLICATION ROLE app_user;

CREATE TABLE IF NOT EXISTS data.CA_MATRIX_RAW_RES8 (
    SEQ_ID INTEGER, ORIGIN_H3 VARCHAR, DEST_HEX_IDS ARRAY, MATRIX_RESULT VARIANT
);
GRANT SELECT ON TABLE data.CA_MATRIX_RAW_RES8 TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE data.CA_MATRIX_RAW_RES8 TO APPLICATION ROLE app_user;

CREATE TABLE IF NOT EXISTS data.CA_MATRIX_RAW_RES9 (
    SEQ_ID INTEGER, ORIGIN_H3 VARCHAR, DEST_HEX_IDS ARRAY, MATRIX_RESULT VARIANT
);
GRANT SELECT ON TABLE data.CA_MATRIX_RAW_RES9 TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE data.CA_MATRIX_RAW_RES9 TO APPLICATION ROLE app_user;

-- =============================================================================
-- DATA: Build Travel Time Matrix — Scalable Architecture
-- =============================================================================
-- Pipeline: BUILD_HEXAGONS → BUILD_WORK_QUEUE → BUILD_TRAVEL_TIME_RANGE (workers) → FLATTEN_MATRIX_RAW
-- Key insight: Raw dump VARIANT payloads first, FLATTEN in bulk after.

CREATE OR REPLACE PROCEDURE data.BUILD_HEXAGONS(P_RES VARCHAR, P_MIN_LAT FLOAT, P_MAX_LAT FLOAT, P_MIN_LON FLOAT, P_MAX_LON FLOAT)
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    resolution INTEGER;
    lat_step FLOAT;
    lon_step FLOAT;
    hex_table VARCHAR;
    row_count INTEGER;
    rs RESULTSET;
BEGIN
    hex_table := 'data.CA_H3_' || P_RES;

    IF (P_RES = 'RES7') THEN
        resolution := 7; lat_step := 0.02; lon_step := 0.02;
    ELSEIF (P_RES = 'RES8') THEN
        resolution := 8; lat_step := 0.008; lon_step := 0.008;
    ELSE
        resolution := 9; lat_step := 0.003; lon_step := 0.003;
    END IF;

    EXECUTE IMMEDIATE 'TRUNCATE TABLE ' || hex_table;

    EXECUTE IMMEDIATE '
    INSERT INTO ' || hex_table || ' (H3_INDEX, CENTER_LAT, CENTER_LON)
    WITH lat_series AS (
        SELECT ' || P_MIN_LAT || ' + (SEQ4() * ' || lat_step || ') AS lat
        FROM TABLE(GENERATOR(ROWCOUNT => 100000))
        WHERE ' || P_MIN_LAT || ' + (SEQ4() * ' || lat_step || ') <= ' || P_MAX_LAT || '
    ),
    lon_series AS (
        SELECT ' || P_MIN_LON || ' + (SEQ4() * ' || lon_step || ') AS lon
        FROM TABLE(GENERATOR(ROWCOUNT => 100000))
        WHERE ' || P_MIN_LON || ' + (SEQ4() * ' || lon_step || ') <= ' || P_MAX_LON || '
    ),
    h3_cells AS (
        SELECT DISTINCT H3_POINT_TO_CELL_STRING(ST_MAKEPOINT(lon, lat), ' || resolution || ') AS h3_index
        FROM lat_series CROSS JOIN lon_series
    )
    SELECT h3_index,
           ST_Y(H3_CELL_TO_POINT(h3_index)) AS center_lat,
           ST_X(H3_CELL_TO_POINT(h3_index)) AS center_lon
    FROM h3_cells';

    rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || hex_table);
    LET c CURSOR FOR rs;
    FOR row_val IN c DO
        row_count := row_val.CNT;
    END FOR;

    RETURN P_RES || ' hexagons built: ' || row_count || ' hexagons';
END;
$$;
GRANT USAGE ON PROCEDURE data.BUILD_HEXAGONS(VARCHAR, FLOAT, FLOAT, FLOAT, FLOAT) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE data.BUILD_WORK_QUEUE(P_RES VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    k_ring INTEGER;
    hex_table VARCHAR;
    queue_table VARCHAR;
    row_count INTEGER;
    rs RESULTSET;
BEGIN
    hex_table := 'data.CA_H3_' || P_RES;
    queue_table := 'data.CA_WORK_QUEUE_' || P_RES;

    IF (P_RES = 'RES7') THEN
        k_ring := 33;
    ELSEIF (P_RES = 'RES8') THEN
        k_ring := 17;
    ELSE
        k_ring := 9;
    END IF;

    EXECUTE IMMEDIATE 'TRUNCATE TABLE ' || queue_table;

    EXECUTE IMMEDIATE '
    INSERT INTO ' || queue_table || ' (SEQ_ID, ORIGIN_H3, ORIGIN_LON, ORIGIN_LAT, DEST_COORDS, DEST_HEX_IDS)
    WITH pairs AS (
        SELECT
            a.H3_INDEX AS origin_h3,
            a.CENTER_LON AS origin_lon,
            a.CENTER_LAT AS origin_lat,
            n.value::STRING AS dest_h3
        FROM ' || hex_table || ' a,
        LATERAL FLATTEN(input => H3_GRID_DISK(a.H3_INDEX, ' || k_ring || ')) n
        WHERE n.value::STRING IN (SELECT H3_INDEX FROM ' || hex_table || ')
          AND a.H3_INDEX != n.value::STRING
    ),
    grouped AS (
        SELECT
            origin_h3, origin_lon, origin_lat,
            ARRAY_AGG(ARRAY_CONSTRUCT(d.CENTER_LON, d.CENTER_LAT)) AS dest_coords,
            ARRAY_AGG(p.dest_h3) AS dest_hex_ids
        FROM pairs p
        JOIN ' || hex_table || ' d ON p.dest_h3 = d.H3_INDEX
        GROUP BY origin_h3, origin_lon, origin_lat
    )
    SELECT
        ROW_NUMBER() OVER (ORDER BY origin_h3) AS seq_id,
        origin_h3, origin_lon, origin_lat,
        dest_coords, dest_hex_ids
    FROM grouped';

    rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || queue_table);
    LET c CURSOR FOR rs;
    FOR row_val IN c DO
        row_count := row_val.CNT;
    END FOR;

    RETURN P_RES || ' work queue built: ' || row_count || ' origins ready';
END;
$$;
GRANT USAGE ON PROCEDURE data.BUILD_WORK_QUEUE(VARCHAR) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE data.BUILD_TRAVEL_TIME_RANGE(P_RES VARCHAR, P_START_SEQ INTEGER, P_END_SEQ INTEGER)
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    batch_size INTEGER;
    current_pos INTEGER;
    batch_end INTEGER;
    batch_num INTEGER DEFAULT 0;
    queue_table VARCHAR;
    raw_table VARCHAR;
    insert_sql VARCHAR;
    resume_sql VARCHAR;
    max_done INTEGER DEFAULT 0;
    rs RESULTSET;
    retry_count INTEGER DEFAULT 0;
    max_retries INTEGER DEFAULT 5;
    retry_wait INTEGER DEFAULT 10;
BEGIN
    queue_table := 'data.CA_WORK_QUEUE_' || P_RES;
    raw_table := 'data.CA_MATRIX_RAW_' || P_RES;

    IF (P_RES = 'RES7') THEN
        batch_size := 100;
    ELSEIF (P_RES = 'RES8') THEN
        batch_size := 1000;
    ELSE
        batch_size := 2000;
    END IF;

    resume_sql := 'SELECT COALESCE(MAX(SEQ_ID), ' || (P_START_SEQ - 1) ||
                  ') AS MAX_DONE FROM ' || raw_table ||
                  ' WHERE SEQ_ID BETWEEN ' || P_START_SEQ || ' AND ' || P_END_SEQ;
    rs := (EXECUTE IMMEDIATE :resume_sql);
    LET c CURSOR FOR rs;
    FOR row_val IN c DO
        max_done := row_val.MAX_DONE;
    END FOR;

    current_pos := max_done + 1;

    WHILE (current_pos <= P_END_SEQ) DO
        batch_num := batch_num + 1;
        batch_end := LEAST(current_pos + batch_size - 1, P_END_SEQ);
        retry_count := 0;
        retry_wait := 10;

        insert_sql := '
        INSERT INTO ' || raw_table || '
        SELECT
            q.SEQ_ID,
            q.ORIGIN_H3,
            q.DEST_HEX_IDS,
            routing.MATRIX_TABULAR(
                ''driving-car'',
                ARRAY_CONSTRUCT(q.ORIGIN_LON, q.ORIGIN_LAT),
                q.DEST_COORDS
            )
        FROM ' || queue_table || ' q
        WHERE q.SEQ_ID BETWEEN ' || current_pos || ' AND ' || batch_end;

        WHILE (retry_count <= max_retries) DO
            BEGIN
                EXECUTE IMMEDIATE :insert_sql;
                retry_count := max_retries + 1;
            EXCEPTION
                WHEN OTHER THEN
                    retry_count := retry_count + 1;
                    IF (retry_count > max_retries) THEN
                        RAISE;
                    END IF;
                    EXECUTE IMMEDIATE 'SELECT SYSTEM$WAIT(' || retry_wait || ')';
                    retry_wait := retry_wait * 2;
            END;
        END WHILE;

        current_pos := batch_end + 1;
    END WHILE;

    RETURN P_RES || ' range [' || P_START_SEQ || '-' || P_END_SEQ ||
           '] complete: ' || batch_num || ' batches of ' || batch_size ||
           ' (resumed from seq ' || max_done || ')';
END;
$$;
GRANT USAGE ON PROCEDURE data.BUILD_TRAVEL_TIME_RANGE(VARCHAR, INTEGER, INTEGER) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE data.BUILD_TRAVEL_TIME_RANGE_REGION(P_RES VARCHAR, P_START_SEQ INTEGER, P_END_SEQ INTEGER, P_MATRIX_FN VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    batch_size INTEGER;
    current_pos INTEGER;
    batch_end INTEGER;
    batch_num INTEGER DEFAULT 0;
    queue_table VARCHAR;
    raw_table VARCHAR;
    insert_sql VARCHAR;
    resume_sql VARCHAR;
    max_done INTEGER DEFAULT 0;
    rs RESULTSET;
    retry_count INTEGER DEFAULT 0;
    max_retries INTEGER DEFAULT 5;
    retry_wait INTEGER DEFAULT 10;
BEGIN
    queue_table := 'data.CA_WORK_QUEUE_' || P_RES;
    raw_table := 'data.CA_MATRIX_RAW_' || P_RES;

    IF (P_RES = 'RES7') THEN
        batch_size := 100;
    ELSEIF (P_RES = 'RES8') THEN
        batch_size := 1000;
    ELSE
        batch_size := 2000;
    END IF;

    resume_sql := 'SELECT COALESCE(MAX(SEQ_ID), ' || (P_START_SEQ - 1) ||
                  ') AS MAX_DONE FROM ' || raw_table ||
                  ' WHERE SEQ_ID BETWEEN ' || P_START_SEQ || ' AND ' || P_END_SEQ;
    rs := (EXECUTE IMMEDIATE :resume_sql);
    LET c CURSOR FOR rs;
    FOR row_val IN c DO
        max_done := row_val.MAX_DONE;
    END FOR;

    current_pos := max_done + 1;

    WHILE (current_pos <= P_END_SEQ) DO
        batch_num := batch_num + 1;
        batch_end := LEAST(current_pos + batch_size - 1, P_END_SEQ);
        retry_count := 0;
        retry_wait := 10;

        insert_sql := '
        INSERT INTO ' || raw_table || '
        SELECT
            q.SEQ_ID,
            q.ORIGIN_H3,
            q.DEST_HEX_IDS,
            ' || P_MATRIX_FN || '(
                ''driving-car'',
                ARRAY_CONSTRUCT(q.ORIGIN_LON, q.ORIGIN_LAT),
                q.DEST_COORDS
            )
        FROM ' || queue_table || ' q
        WHERE q.SEQ_ID BETWEEN ' || current_pos || ' AND ' || batch_end;

        WHILE (retry_count <= max_retries) DO
            BEGIN
                EXECUTE IMMEDIATE :insert_sql;
                retry_count := max_retries + 1;
            EXCEPTION
                WHEN OTHER THEN
                    retry_count := retry_count + 1;
                    IF (retry_count > max_retries) THEN
                        RAISE;
                    END IF;
                    EXECUTE IMMEDIATE 'SELECT SYSTEM$WAIT(' || retry_wait || ')';
                    retry_wait := retry_wait * 2;
            END;
        END WHILE;

        current_pos := batch_end + 1;
    END WHILE;

    RETURN P_RES || ' range [' || P_START_SEQ || '-' || P_END_SEQ ||
           '] complete: ' || batch_num || ' batches of ' || batch_size ||
           ' (resumed from seq ' || max_done || ', fn=' || P_MATRIX_FN || ')';
END;
$$;
GRANT USAGE ON PROCEDURE data.BUILD_TRAVEL_TIME_RANGE_REGION(VARCHAR, INTEGER, INTEGER, VARCHAR) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE data.BUILD_MATRIX_FOR_REGION(P_RES VARCHAR, P_MIN_LAT FLOAT, P_MAX_LAT FLOAT, P_MIN_LON FLOAT, P_MAX_LON FLOAT, P_MATRIX_FN VARCHAR, P_REGION VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    hex_count INTEGER;
    queue_count INTEGER;
    travel_count INTEGER;
    hex_table VARCHAR;
    queue_table VARCHAR;
    travel_table VARCHAR;
    count_sql VARCHAR;
    rs RESULTSET;
BEGIN
    hex_table := 'data.CA_H3_' || P_RES;
    queue_table := 'data.CA_WORK_QUEUE_' || P_RES;
    travel_table := 'data.CA_TRAVEL_TIME_' || P_RES;

    count_sql := 'SELECT COUNT(*) AS CNT FROM ' || hex_table;
    rs := (EXECUTE IMMEDIATE :count_sql);
    LET c1 CURSOR FOR rs;
    FOR r IN c1 DO hex_count := r.CNT; END FOR;

    IF (hex_count = 0) THEN
        CALL data.BUILD_HEXAGONS(:P_RES, :P_MIN_LAT, :P_MAX_LAT, :P_MIN_LON, :P_MAX_LON);
    END IF;

    count_sql := 'SELECT COUNT(*) AS CNT FROM ' || hex_table;
    rs := (EXECUTE IMMEDIATE :count_sql);
    LET c2 CURSOR FOR rs;
    FOR r IN c2 DO hex_count := r.CNT; END FOR;

    count_sql := 'SELECT COUNT(*) AS CNT FROM ' || queue_table;
    rs := (EXECUTE IMMEDIATE :count_sql);
    LET c3 CURSOR FOR rs;
    FOR r IN c3 DO queue_count := r.CNT; END FOR;

    IF (queue_count = 0) THEN
        CALL data.BUILD_WORK_QUEUE(:P_RES);
    END IF;

    count_sql := 'SELECT COUNT(*) AS CNT FROM ' || queue_table;
    rs := (EXECUTE IMMEDIATE :count_sql);
    LET c4 CURSOR FOR rs;
    FOR r IN c4 DO queue_count := r.CNT; END FOR;

    EXECUTE IMMEDIATE 'CALL data.BUILD_TRAVEL_TIME_RANGE_REGION(''' || P_RES || ''', 1, ' || queue_count || ', ''' || P_MATRIX_FN || ''')';
    EXECUTE IMMEDIATE 'CALL data.FLATTEN_MATRIX_RAW(''' || P_RES || ''', ''' || P_REGION || ''')';

    count_sql := 'SELECT COUNT(*) AS CNT FROM ' || travel_table || ' WHERE REGION = ''' || P_REGION || '''';
    rs := (EXECUTE IMMEDIATE :count_sql);
    LET c5 CURSOR FOR rs;
    FOR r IN c5 DO travel_count := r.CNT; END FOR;

    RETURN P_RES || ' complete (' || P_MATRIX_FN || '): ' || hex_count || ' hexagons, ' ||
           queue_count || ' origins, ' || travel_count || ' travel times';
END;
$$;
GRANT USAGE ON PROCEDURE data.BUILD_MATRIX_FOR_REGION(VARCHAR, FLOAT, FLOAT, FLOAT, FLOAT, VARCHAR, VARCHAR) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE data.FLATTEN_MATRIX_RAW(P_RES VARCHAR, P_REGION VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    raw_table VARCHAR;
    target_table VARCHAR;
    row_count INTEGER;
    rs RESULTSET;
BEGIN
    raw_table := 'data.CA_MATRIX_RAW_' || P_RES;
    target_table := 'data.CA_TRAVEL_TIME_' || P_RES;

    EXECUTE IMMEDIATE 'DELETE FROM ' || target_table || ' WHERE REGION = ''' || P_REGION || ''' OR REGION IS NULL';

    EXECUTE IMMEDIATE '
    INSERT INTO ' || target_table || ' (ORIGIN_H3, DEST_H3, TRAVEL_TIME_SECONDS, TRAVEL_DISTANCE_METERS, REGION)
    SELECT
        r.ORIGIN_H3,
        r.DEST_HEX_IDS[f.INDEX]::VARCHAR AS DEST_H3,
        r.MATRIX_RESULT:durations[0][f.INDEX]::FLOAT AS TRAVEL_TIME_SECONDS,
        r.MATRIX_RESULT:distances[0][f.INDEX]::FLOAT AS TRAVEL_DISTANCE_METERS,
        ''' || P_REGION || '''
    FROM ' || raw_table || ' r,
        LATERAL FLATTEN(input => r.MATRIX_RESULT:durations[0]) f
    WHERE r.MATRIX_RESULT:durations IS NOT NULL';

    rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || target_table || ' WHERE REGION = ''' || P_REGION || '''');
    LET c CURSOR FOR rs;
    FOR row_val IN c DO
        row_count := row_val.CNT;
    END FOR;

    RETURN P_RES || ' flatten complete (' || P_REGION || '): ' || row_count || ' travel time pairs';
END;
$$;
GRANT USAGE ON PROCEDURE data.FLATTEN_MATRIX_RAW(VARCHAR, VARCHAR) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE data.BUILD_TRAVEL_TIME_MATRIX_RES7()
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    hex_count INTEGER;
    queue_count INTEGER;
    raw_count INTEGER;
    result VARCHAR;
BEGIN
    SELECT COUNT(*) INTO hex_count FROM data.CA_H3_RES7;
    IF (hex_count = 0) THEN
        CALL data.BUILD_HEXAGONS('RES7', 37.71, 37.81, -122.51, -122.37);
    END IF;
    SELECT COUNT(*) INTO hex_count FROM data.CA_H3_RES7;

    SELECT COUNT(*) INTO queue_count FROM data.CA_WORK_QUEUE_RES7;
    IF (queue_count = 0) THEN
        CALL data.BUILD_WORK_QUEUE('RES7');
    END IF;
    SELECT COUNT(*) INTO queue_count FROM data.CA_WORK_QUEUE_RES7;

    EXECUTE IMMEDIATE 'CALL data.BUILD_TRAVEL_TIME_RANGE(''RES7'', 1, ' || queue_count || ')';
    CALL data.FLATTEN_MATRIX_RAW('RES7', 'SanFrancisco');

    RETURN 'RES7 complete: ' || hex_count || ' hexagons, ' ||
           queue_count || ' origins, ' ||
           (SELECT COUNT(*) FROM data.CA_TRAVEL_TIME_RES7) || ' travel times';
END;
$$;
GRANT USAGE ON PROCEDURE data.BUILD_TRAVEL_TIME_MATRIX_RES7() TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE data.BUILD_TRAVEL_TIME_MATRIX_RES8()
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    hex_count INTEGER;
    queue_count INTEGER;
    raw_count INTEGER;
    result VARCHAR;
BEGIN
    SELECT COUNT(*) INTO hex_count FROM data.CA_H3_RES8;
    IF (hex_count = 0) THEN
        CALL data.BUILD_HEXAGONS('RES8', 37.71, 37.81, -122.51, -122.37);
    END IF;
    SELECT COUNT(*) INTO hex_count FROM data.CA_H3_RES8;

    SELECT COUNT(*) INTO queue_count FROM data.CA_WORK_QUEUE_RES8;
    IF (queue_count = 0) THEN
        CALL data.BUILD_WORK_QUEUE('RES8');
    END IF;
    SELECT COUNT(*) INTO queue_count FROM data.CA_WORK_QUEUE_RES8;

    EXECUTE IMMEDIATE 'CALL data.BUILD_TRAVEL_TIME_RANGE(''RES8'', 1, ' || queue_count || ')';
    CALL data.FLATTEN_MATRIX_RAW('RES8', 'SanFrancisco');

    RETURN 'RES8 complete: ' || hex_count || ' hexagons, ' ||
           queue_count || ' origins, ' ||
           (SELECT COUNT(*) FROM data.CA_TRAVEL_TIME_RES8) || ' travel times';
END;
$$;
GRANT USAGE ON PROCEDURE data.BUILD_TRAVEL_TIME_MATRIX_RES8() TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE data.BUILD_TRAVEL_TIME_MATRIX_RES9()
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    hex_count INTEGER;
    queue_count INTEGER;
    raw_count INTEGER;
    result VARCHAR;
BEGIN
    SELECT COUNT(*) INTO hex_count FROM data.CA_H3_RES9;
    IF (hex_count = 0) THEN
        CALL data.BUILD_HEXAGONS('RES9', 37.71, 37.81, -122.51, -122.37);
    END IF;
    SELECT COUNT(*) INTO hex_count FROM data.CA_H3_RES9;

    SELECT COUNT(*) INTO queue_count FROM data.CA_WORK_QUEUE_RES9;
    IF (queue_count = 0) THEN
        CALL data.BUILD_WORK_QUEUE('RES9');
    END IF;
    SELECT COUNT(*) INTO queue_count FROM data.CA_WORK_QUEUE_RES9;

    EXECUTE IMMEDIATE 'CALL data.BUILD_TRAVEL_TIME_RANGE(''RES9'', 1, ' || queue_count || ')';
    CALL data.FLATTEN_MATRIX_RAW('RES9', 'SanFrancisco');

    RETURN 'RES9 complete: ' || hex_count || ' hexagons, ' ||
           queue_count || ' origins, ' ||
           (SELECT COUNT(*) FROM data.CA_TRAVEL_TIME_RES9) || ' travel times';
END;
$$;
GRANT USAGE ON PROCEDURE data.BUILD_TRAVEL_TIME_MATRIX_RES9() TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE data.MATRIX_PROGRESS()
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    r7_hex INTEGER DEFAULT 0; r7_queue INTEGER DEFAULT 0; r7_raw INTEGER DEFAULT 0; r7_flat INTEGER DEFAULT 0;
    r8_hex INTEGER DEFAULT 0; r8_queue INTEGER DEFAULT 0; r8_raw INTEGER DEFAULT 0; r8_flat INTEGER DEFAULT 0;
    r9_hex INTEGER DEFAULT 0; r9_queue INTEGER DEFAULT 0; r9_raw INTEGER DEFAULT 0; r9_flat INTEGER DEFAULT 0;
    r7_stage VARCHAR; r8_stage VARCHAR; r9_stage VARCHAR;
    r7_pct FLOAT DEFAULT 0; r8_pct FLOAT DEFAULT 0; r9_pct FLOAT DEFAULT 0;
BEGIN
    SELECT COUNT(*) INTO r7_hex FROM data.CA_H3_RES7;
    SELECT COUNT(*) INTO r7_queue FROM data.CA_WORK_QUEUE_RES7;
    SELECT COUNT(*) INTO r7_raw FROM data.CA_MATRIX_RAW_RES7;
    SELECT COUNT(*) INTO r7_flat FROM data.CA_TRAVEL_TIME_RES7;

    SELECT COUNT(*) INTO r8_hex FROM data.CA_H3_RES8;
    SELECT COUNT(*) INTO r8_queue FROM data.CA_WORK_QUEUE_RES8;
    SELECT COUNT(*) INTO r8_raw FROM data.CA_MATRIX_RAW_RES8;
    SELECT COUNT(*) INTO r8_flat FROM data.CA_TRAVEL_TIME_RES8;

    SELECT COUNT(*) INTO r9_hex FROM data.CA_H3_RES9;
    SELECT COUNT(*) INTO r9_queue FROM data.CA_WORK_QUEUE_RES9;
    SELECT COUNT(*) INTO r9_raw FROM data.CA_MATRIX_RAW_RES9;
    SELECT COUNT(*) INTO r9_flat FROM data.CA_TRAVEL_TIME_RES9;

    IF (r7_flat > 0 AND r7_queue > 0 AND r7_raw = r7_queue) THEN r7_stage := 'COMPLETE';
    ELSEIF (r7_raw > 0 AND r7_raw = r7_queue) THEN r7_stage := 'FLATTENING';
    ELSEIF (r7_raw > 0) THEN r7_stage := 'BUILDING';
    ELSEIF (r7_queue > 0) THEN r7_stage := 'QUEUED';
    ELSEIF (r7_hex > 0) THEN r7_stage := 'HEXAGONS_READY';
    ELSE r7_stage := 'NOT_STARTED';
    END IF;
    IF (r7_queue > 0) THEN r7_pct := ROUND(r7_raw * 100.0 / r7_queue, 1); END IF;

    IF (r8_flat > 0 AND r8_queue > 0 AND r8_raw = r8_queue) THEN r8_stage := 'COMPLETE';
    ELSEIF (r8_raw > 0 AND r8_raw = r8_queue) THEN r8_stage := 'FLATTENING';
    ELSEIF (r8_raw > 0) THEN r8_stage := 'BUILDING';
    ELSEIF (r8_queue > 0) THEN r8_stage := 'QUEUED';
    ELSEIF (r8_hex > 0) THEN r8_stage := 'HEXAGONS_READY';
    ELSE r8_stage := 'NOT_STARTED';
    END IF;
    IF (r8_queue > 0) THEN r8_pct := ROUND(r8_raw * 100.0 / r8_queue, 1); END IF;

    IF (r9_flat > 0 AND r9_queue > 0 AND r9_raw = r9_queue) THEN r9_stage := 'COMPLETE';
    ELSEIF (r9_raw > 0 AND r9_raw = r9_queue) THEN r9_stage := 'FLATTENING';
    ELSEIF (r9_raw > 0) THEN r9_stage := 'BUILDING';
    ELSEIF (r9_queue > 0) THEN r9_stage := 'QUEUED';
    ELSEIF (r9_hex > 0) THEN r9_stage := 'HEXAGONS_READY';
    ELSE r9_stage := 'NOT_STARTED';
    END IF;
    IF (r9_queue > 0) THEN r9_pct := ROUND(r9_raw * 100.0 / r9_queue, 1); END IF;

    RETURN OBJECT_CONSTRUCT(
        'RES7', OBJECT_CONSTRUCT(
            'stage', r7_stage, 'hexagons', r7_hex, 'work_queue', r7_queue,
            'raw_ingested', r7_raw, 'flattened', r7_flat, 'pct', r7_pct),
        'RES8', OBJECT_CONSTRUCT(
            'stage', r8_stage, 'hexagons', r8_hex, 'work_queue', r8_queue,
            'raw_ingested', r8_raw, 'flattened', r8_flat, 'pct', r8_pct),
        'RES9', OBJECT_CONSTRUCT(
            'stage', r9_stage, 'hexagons', r9_hex, 'work_queue', r9_queue,
            'raw_ingested', r9_raw, 'flattened', r9_flat, 'pct', r9_pct)
    )::VARCHAR;
END;
$$;
GRANT USAGE ON PROCEDURE data.MATRIX_PROGRESS() TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE data.RESET_MATRIX_DATA()
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
BEGIN
    TRUNCATE TABLE data.CA_H3_RES7;
    TRUNCATE TABLE data.CA_H3_RES8;
    TRUNCATE TABLE data.CA_H3_RES9;
    TRUNCATE TABLE data.CA_WORK_QUEUE_RES7;
    TRUNCATE TABLE data.CA_WORK_QUEUE_RES8;
    TRUNCATE TABLE data.CA_WORK_QUEUE_RES9;
    TRUNCATE TABLE data.CA_MATRIX_RAW_RES7;
    TRUNCATE TABLE data.CA_MATRIX_RAW_RES8;
    TRUNCATE TABLE data.CA_MATRIX_RAW_RES9;
    TRUNCATE TABLE data.CA_TRAVEL_TIME_RES7;
    TRUNCATE TABLE data.CA_TRAVEL_TIME_RES8;
    TRUNCATE TABLE data.CA_TRAVEL_TIME_RES9;
    RETURN 'All matrix tables reset';
END;
$$;
GRANT USAGE ON PROCEDURE data.RESET_MATRIX_DATA() TO APPLICATION ROLE app_user;

-- =============================================================================
-- DATA: Analytics views (for the React UI)
-- =============================================================================

CREATE OR REPLACE VIEW data.DELIVERY_SUMMARY AS
WITH delivery_stats AS (
    SELECT ORDER_ID, AVG(KMH) AS AVERAGE_KMH, MAX(KMH) AS MAX_KMH
    FROM data.COURIER_LOCATIONS
    GROUP BY ORDER_ID
)
SELECT
    rg.COURIER_ID, rg.ORDER_ID, rg.ORDER_TIME, rg.PICKUP_TIME, rg.DELIVERY_TIME,
    rg.RESTAURANT_ID, rg.RESTAURANT_NAME, rg.CUISINE_TYPE,
    rg.RESTAURANT_LOCATION, rg.RESTAURANT_ADDRESS,
    rg.CUSTOMER_ADDRESS_ID, rg.CUSTOMER_ADDRESS, rg.CUSTOMER_LOCATION,
    rg.PREP_TIME_MINS, rg.ORDER_STATUS, rg.ROUTE_DURATION_SECS, rg.ROUTE_DISTANCE_METERS,
    rg.GEOMETRY, rg.SHIFT_TYPE, rg.VEHICLE_TYPE, rg.CITY,
    ds.AVERAGE_KMH, ds.MAX_KMH
FROM data.DELIVERY_ROUTE_GEOMETRIES rg
LEFT JOIN delivery_stats ds ON rg.ORDER_ID = ds.ORDER_ID;
GRANT SELECT ON VIEW data.DELIVERY_SUMMARY TO APPLICATION ROLE app_user;

CREATE OR REPLACE VIEW data.COURIER_LOCATIONS_V AS
SELECT
    ORDER_ID, COURIER_ID, ORDER_TIME, PICKUP_TIME, DROPOFF_TIME,
    RESTAURANT_LOCATION, CUSTOMER_LOCATION, ROUTE, POINT_GEOM,
    ST_X(POINT_GEOM) AS LON, ST_Y(POINT_GEOM) AS LAT,
    CURR_TIME, CURR_TIME AS POINT_TIME, POINT_INDEX, COURIER_STATE, KMH, CITY
FROM data.COURIER_LOCATIONS;
GRANT SELECT ON VIEW data.COURIER_LOCATIONS_V TO APPLICATION ROLE app_user;

CREATE OR REPLACE VIEW data.ORDERS_ASSIGNED_TO_COURIERS AS
SELECT
    COURIER_ID, ORDER_ID, RESTAURANT_ID, GEOMETRY,
    RESTAURANT_LOCATION, CUSTOMER_LOCATION, RESTAURANT_NAME, RESTAURANT_ADDRESS,
    CUSTOMER_ADDRESS, ORDER_TIME, PICKUP_TIME, DELIVERY_TIME, ORDER_STATUS, CITY
FROM data.DELIVERY_ROUTE_GEOMETRIES;
GRANT SELECT ON VIEW data.ORDERS_ASSIGNED_TO_COURIERS TO APPLICATION ROLE app_user;

CREATE OR REPLACE VIEW data.DELIVERY_NAMES AS
SELECT ORDER_ID, RESTAURANT_NAME || ' -> ' || CUSTOMER_ADDRESS AS DELIVERY_NAME
FROM data.DELIVERY_ROUTE_GEOMETRIES;
GRANT SELECT ON VIEW data.DELIVERY_NAMES TO APPLICATION ROLE app_user;

CREATE OR REPLACE VIEW data.DELIVERY_ROUTE_PLAN AS
SELECT
    ORDER_ID, COURIER_ID, RESTAURANT_NAME, RESTAURANT_ADDRESS,
    CUSTOMER_ADDRESS, CUSTOMER_ADDRESS AS CUSTOMER_STREET,
    ORDER_TIME, PICKUP_TIME, DELIVERY_TIME,
    RESTAURANT_LOCATION, CUSTOMER_LOCATION, GEOMETRY,
    ROUTE_DISTANCE_METERS AS DISTANCE_METERS, SHIFT_TYPE, VEHICLE_TYPE, ORDER_STATUS, CITY
FROM data.DELIVERY_ROUTE_GEOMETRIES;
GRANT SELECT ON VIEW data.DELIVERY_ROUTE_PLAN TO APPLICATION ROLE app_user;

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
        CALL core.create_ui_compute_pool();
    END IF;
    IF (ARRAY_CONTAINS('CREATE WAREHOUSE'::VARIANT, privileges)) THEN
        CALL core.create_warehouse();
    END IF;
    IF (ARRAY_CONTAINS('BIND SERVICE ENDPOINT'::VARIANT, privileges) OR ARRAY_CONTAINS('CREATE COMPUTE POOL'::VARIANT, privileges)) THEN
        CALL core.create_ui_service();
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
    CALL core.create_ui_compute_pool();
    CALL core.create_warehouse();
    CALL core.create_ui_service();
    RETURN 'UI deployment complete';
END;
$$;
GRANT USAGE ON PROCEDURE core.deploy() TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.deploy_full()
RETURNS STRING
LANGUAGE SQL
AS
$$
BEGIN
    CALL core.create_ui_compute_pool();
    CALL core.create_warehouse();
    CALL core.create_ui_service();
    CALL routing.setup_ors();
    RETURN 'Full deployment complete (UI + ORS routing)';
END;
$$;
GRANT USAGE ON PROCEDURE core.deploy_full() TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.check_grants()
RETURNS STRING
LANGUAGE SQL
AS
$$
DECLARE
    overture_places BOOLEAN DEFAULT FALSE;
    overture_addresses BOOLEAN DEFAULT FALSE;
    ors_db BOOLEAN DEFAULT FALSE;
    ors_schema BOOLEAN DEFAULT FALSE;
    ors_repo BOOLEAN DEFAULT FALSE;
BEGIN
    BEGIN
        SELECT COUNT(*) INTO :overture_places FROM OVERTURE_MAPS__PLACES.INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = 'CARTO' AND TABLE_NAME = 'PLACE' LIMIT 1;
        overture_places := TRUE;
    EXCEPTION WHEN OTHER THEN overture_places := FALSE; END;

    BEGIN
        SELECT COUNT(*) INTO :overture_addresses FROM OVERTURE_MAPS__ADDRESSES.INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = 'CARTO' AND TABLE_NAME = 'ADDRESS' LIMIT 1;
        overture_addresses := TRUE;
    EXCEPTION WHEN OTHER THEN overture_addresses := FALSE; END;

    BEGIN
        SELECT 1 INTO :ors_db FROM OPENROUTESERVICE_SETUP.INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = 'PUBLIC' LIMIT 1;
        ors_db := TRUE;
    EXCEPTION WHEN OTHER THEN ors_db := FALSE; END;

    BEGIN
        SHOW IMAGE REPOSITORIES LIKE 'IMAGE_REPOSITORY' IN SCHEMA OPENROUTESERVICE_SETUP.PUBLIC;
        ors_repo := TRUE;
    EXCEPTION WHEN OTHER THEN ors_repo := FALSE; END;

    RETURN OBJECT_CONSTRUCT(
        'overture_places', overture_places,
        'overture_addresses', overture_addresses,
        'ors_database', ors_db,
        'ors_image_repo', ors_repo
    )::STRING;
END;
$$;
GRANT USAGE ON PROCEDURE core.check_grants() TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.get_service_url()
RETURNS STRING
LANGUAGE SQL
AS
$$
DECLARE
    url STRING;
BEGIN
    SHOW ENDPOINTS IN SERVICE core.fleet_intelligence_service;
    SELECT "ingress_url" INTO :url
    FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
    WHERE "name" = 'fleet-intel-ui';
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
    ui_status STRING DEFAULT 'NOT_FOUND';
    ors_status STRING DEFAULT 'NOT_FOUND';
    endpoint_url STRING DEFAULT '';
    data_rows NUMBER DEFAULT 0;
BEGIN
    BEGIN
        SHOW SERVICES LIKE 'FLEET_INTELLIGENCE_SERVICE' IN SCHEMA core;
        SELECT "status" INTO :ui_status FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) LIMIT 1;
    EXCEPTION WHEN OTHER THEN ui_status := 'NOT_FOUND'; END;

    BEGIN
        SHOW SERVICES LIKE 'ROUTING_GATEWAY_SERVICE' IN SCHEMA routing;
        SELECT "status" INTO :ors_status FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) LIMIT 1;
    EXCEPTION WHEN OTHER THEN ors_status := 'NOT_FOUND'; END;

    BEGIN
        SHOW ENDPOINTS IN SERVICE core.fleet_intelligence_service;
        SELECT "ingress_url" INTO :endpoint_url FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) WHERE "name" = 'fleet-intel-ui' LIMIT 1;
    EXCEPTION WHEN OTHER THEN endpoint_url := ''; END;

    BEGIN
        SELECT COUNT(*) INTO :data_rows FROM data.DELIVERY_ROUTE_GEOMETRIES;
    EXCEPTION WHEN OTHER THEN data_rows := 0; END;

    RETURN OBJECT_CONSTRUCT(
        'ui_service', ui_status,
        'ors_service', ors_status,
        'endpoint_url', endpoint_url,
        'delivery_routes', data_rows
    )::STRING;
END;
$$;
GRANT USAGE ON PROCEDURE core.get_status() TO APPLICATION ROLE app_user;

-- =============================================================================
-- Streamlit status/launcher
-- =============================================================================

CREATE OR REPLACE STREAMLIT core.status_app
    FROM '/streamlit'
    MAIN_FILE = '/status.py';
GRANT USAGE ON STREAMLIT core.status_app TO APPLICATION ROLE app_user;

-- =============================================================================
-- POST-INSTALL GRANTS (run as ACCOUNTADMIN after CREATE APPLICATION)
-- =============================================================================
-- With manifest_version: 2, the following are AUTO-GRANTED at install:
--   - CREATE COMPUTE POOL, CREATE WAREHOUSE, BIND SERVICE ENDPOINT
--
-- Manual grants needed:
--
-- 1. Cortex AI (for the AI agent):
--    GRANT IMPORTED PRIVILEGES ON DATABASE SNOWFLAKE TO APPLICATION FLEET_INTELLIGENCE_APP;
--
-- 2. Image repository access (for ORS Docker images):
--    GRANT USAGE ON DATABASE OPENROUTESERVICE_SETUP TO APPLICATION FLEET_INTELLIGENCE_APP;
--    GRANT USAGE ON SCHEMA OPENROUTESERVICE_SETUP.PUBLIC TO APPLICATION FLEET_INTELLIGENCE_APP;
--    GRANT READ ON IMAGE REPOSITORY OPENROUTESERVICE_SETUP.PUBLIC.IMAGE_REPOSITORY TO APPLICATION FLEET_INTELLIGENCE_APP;
--
-- 3. Overture Maps access (for food delivery data generation):
--    GRANT IMPORTED PRIVILEGES ON DATABASE OVERTURE_MAPS__PLACES TO APPLICATION FLEET_INTELLIGENCE_APP;
--    GRANT IMPORTED PRIVILEGES ON DATABASE OVERTURE_MAPS__ADDRESSES TO APPLICATION FLEET_INTELLIGENCE_APP;
--
-- 4. External access for map tiles:
--    GRANT USAGE ON INTEGRATION fleet_intel_map_tiles_eai TO APPLICATION FLEET_INTELLIGENCE_APP;
--    CALL FLEET_INTELLIGENCE_APP.core.register_single_callback(
--        'EXTERNAL_ACCESS_REF', 'ADD',
--        SYSTEM$REFERENCE('EXTERNAL ACCESS INTEGRATION', 'FLEET_INTEL_MAP_TILES_EAI', 'PERSISTENT', 'USAGE'));
--
-- 4b. External access for PBF map data downloads (BBBike + Geofabrik):
--    CREATE OR REPLACE NETWORK RULE fleet_intel_download_nr
--        MODE = EGRESS TYPE = HOST_PORT
--        VALUE_LIST = ('download.bbbike.org:443', 'download.geofabrik.de:443');
--    CREATE OR REPLACE EXTERNAL ACCESS INTEGRATION fleet_intel_download_eai
--        ALLOWED_NETWORK_RULES = (fleet_intel_download_nr) ENABLED = TRUE;
--    GRANT USAGE ON INTEGRATION fleet_intel_download_eai TO APPLICATION FLEET_INTELLIGENCE_APP;
--    CALL FLEET_INTELLIGENCE_APP.core.register_single_callback(
--        'EXTERNAL_ACCESS_DOWNLOAD_REF', 'ADD',
--        SYSTEM$REFERENCE('EXTERNAL ACCESS INTEGRATION', 'FLEET_INTEL_DOWNLOAD_EAI', 'PERSISTENT', 'USAGE'));
--
-- 5. App role:
--    GRANT APPLICATION ROLE FLEET_INTELLIGENCE_APP.APP_USER TO ROLE <YOUR_ROLE>;
--
-- 6. Deploy UI only:
--    CALL FLEET_INTELLIGENCE_APP.core.deploy();
--
-- 7. Deploy ORS routing engine:
--    CALL FLEET_INTELLIGENCE_APP.routing.setup_ors();
--
-- 8. Stage California map data (option A: use downloader service):
--    CALL FLEET_INTELLIGENCE_APP.routing.start_downloader();
--    SELECT FLEET_INTELLIGENCE_APP.ROUTING.DOWNLOAD_PBF('ors_spcs_stage/SanFrancisco', 'SanFrancisco.osm.pbf', 'https://download.bbbike.org/osm/bbbike/SanFrancisco/SanFrancisco.osm.pbf');
--
--    Option B: manual upload to routing.ORS_SPCS_STAGE:
--    PUT 'file:///tmp/SanFrancisco.osm.pbf' @FLEET_INTELLIGENCE_APP.routing.ORS_SPCS_STAGE/SanFrancisco/ AUTO_COMPRESS=FALSE OVERWRITE=TRUE;
-- =============================================================================
