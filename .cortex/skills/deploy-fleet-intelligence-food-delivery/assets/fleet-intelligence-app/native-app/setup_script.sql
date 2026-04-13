CREATE APPLICATION ROLE IF NOT EXISTS app_user;
CREATE APPLICATION ROLE IF NOT EXISTS all_agents_role;

CREATE SCHEMA IF NOT EXISTS core;
GRANT USAGE ON SCHEMA core TO APPLICATION ROLE app_user;
GRANT USAGE ON SCHEMA core TO APPLICATION ROLE all_agents_role;

CREATE SCHEMA IF NOT EXISTS routing;
GRANT USAGE ON SCHEMA routing TO APPLICATION ROLE app_user;

CREATE SCHEMA IF NOT EXISTS data;
GRANT USAGE ON SCHEMA data TO APPLICATION ROLE app_user;
GRANT USAGE ON SCHEMA data TO APPLICATION ROLE all_agents_role;

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
    ALTER COMPUTE POOL IF EXISTS IDENTIFIER(:pool_name) SET AUTO_SUSPEND_SECS = 600;
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
        MAX_CLUSTER_COUNT = 4
        MIN_CLUSTER_COUNT = 1
        SCALING_POLICY = 'STANDARD'
        AUTO_SUSPEND = 60
        AUTO_RESUME = TRUE
        INITIALLY_SUSPENDED = TRUE;
    ALTER WAREHOUSE FLEET_INTEL_WH SET
        MAX_CLUSTER_COUNT = 4
        MIN_CLUSTER_COUNT = 1
        SCALING_POLICY = 'STANDARD';
    RETURN 'Multi-cluster warehouse created';
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
    BEGIN
        ALTER SERVICE IF EXISTS routing.ors_service SET AUTO_SUSPEND_SECS = 600;
        ALTER SERVICE IF EXISTS routing.vroom_service SET AUTO_SUSPEND_SECS = 600;
        ALTER SERVICE IF EXISTS routing.routing_gateway_service SET AUTO_SUSPEND_SECS = 600;
        ALTER SERVICE IF EXISTS routing.ors_service_sanfrancisco SET AUTO_SUSPEND_SECS = 600;
        ALTER SERVICE IF EXISTS routing.downloader_service SET AUTO_SUSPEND_SECS = 600;
    EXCEPTION
        WHEN OTHER THEN NULL;
    END;
    DROP SERVICE IF EXISTS core.fleet_intelligence_service;
    BEGIN
        CREATE SERVICE core.fleet_intelligence_service
            IN COMPUTE POOL IDENTIFIER(:pool_name)
            FROM SPECIFICATION_FILE='services/fleet_intelligence_service.yaml'
            MIN_INSTANCES = 1
            MAX_INSTANCES = 1
            EXTERNAL_ACCESS_INTEGRATIONS = (reference('external_access_ref'));
    EXCEPTION
        WHEN OTHER THEN
            CREATE SERVICE core.fleet_intelligence_service
                IN COMPUTE POOL IDENTIFIER(:pool_name)
                FROM SPECIFICATION_FILE='services/fleet_intelligence_service.yaml'
                MIN_INSTANCES = 1
                MAX_INSTANCES = 1;
    END;
    GRANT USAGE ON SERVICE core.fleet_intelligence_service TO APPLICATION ROLE app_user;
    GRANT SERVICE ROLE core.fleet_intelligence_service!ALL_ENDPOINTS_USAGE TO APPLICATION ROLE app_user;
    GRANT OPERATE ON SERVICE core.fleet_intelligence_service TO APPLICATION ROLE app_user;
    GRANT MONITOR ON SERVICE core.fleet_intelligence_service TO APPLICATION ROLE app_user;
    CALL core.create_fleet_data_query_function();
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
            EXTERNAL_ACCESS_INTEGRATIONS = (reference('external_access_ref'));
    EXCEPTION
        WHEN OTHER THEN
            BEGIN
                CREATE SERVICE core.fleet_intelligence_service
                    IN COMPUTE POOL IDENTIFIER(:pool_name)
                    FROM SPECIFICATION_FILE='services/fleet_intelligence_service.yaml'
                    MIN_INSTANCES = 1
                    MAX_INSTANCES = 1;
            EXCEPTION
                WHEN OTHER THEN
                    RETURN 'Version init - service deferred. Run DEPLOY() after grants.';
            END;
    END;
    GRANT USAGE ON SERVICE core.fleet_intelligence_service TO APPLICATION ROLE app_user;
    GRANT SERVICE ROLE core.fleet_intelligence_service!ALL_ENDPOINTS_USAGE TO APPLICATION ROLE app_user;
    GRANT OPERATE ON SERVICE core.fleet_intelligence_service TO APPLICATION ROLE app_user;
    GRANT MONITOR ON SERVICE core.fleet_intelligence_service TO APPLICATION ROLE app_user;
    BEGIN
        CALL core.create_fleet_data_query_function();
    EXCEPTION
        WHEN OTHER THEN NULL;
    END;
    BEGIN
        CALL core.setup_semantic_view();
    EXCEPTION
        WHEN OTHER THEN NULL;
    END;
    BEGIN
        CALL core.create_agent();
    EXCEPTION
        WHEN OTHER THEN NULL;
    END;
    BEGIN
        ALTER SERVICE core.fleet_intelligence_service SUSPEND;
    EXCEPTION
        WHEN OTHER THEN NULL;
    END;
    RETURN 'Version initialized - service created and suspended';
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
        AUTO_SUSPEND_SECS = 600;
    ALTER COMPUTE POOL IF EXISTS IDENTIFIER(:pool_name) SET AUTO_SUSPEND_SECS = 600;
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
        AUTO_SUSPEND_SECS = 600;

    CREATE SERVICE routing.vroom_service
        IN COMPUTE POOL IDENTIFIER(:pool_name)
        FROM SPECIFICATION_FILE='services/vroom_service.yaml'
        MIN_INSTANCES = 1
        MAX_INSTANCES = 1
        AUTO_SUSPEND_SECS = 600;

    CREATE SERVICE routing.routing_gateway_service
        IN COMPUTE POOL IDENTIFIER(:pool_name)
        FROM SPECIFICATION_FILE='services/routing_gateway_service.yaml'
        MIN_INSTANCES = 1
        MAX_INSTANCES = 10
        AUTO_SUSPEND_SECS = 600;

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
        MAX_BATCH_ROWS = 10
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

    CREATE OR REPLACE FUNCTION routing.DIRECTIONS_GEO(method VARCHAR, jstart ARRAY, jend ARRAY)
        RETURNS TABLE (RESPONSE VARIANT, GEOJSON GEOGRAPHY, DISTANCE FLOAT, DURATION FLOAT)
        LANGUAGE SQL
        AS
        'SELECT
            resp AS RESPONSE,
            TO_GEOGRAPHY(resp:features[0]:geometry) AS GEOJSON,
            resp:features[0]:properties:summary:distance::FLOAT AS DISTANCE,
            resp:features[0]:properties:summary:duration::FLOAT AS DURATION
         FROM (SELECT routing.DIRECTIONS(method, jstart, jend) AS resp)';
    GRANT USAGE ON FUNCTION routing.DIRECTIONS_GEO(VARCHAR, ARRAY, ARRAY) TO APPLICATION ROLE app_user;

    CREATE OR REPLACE FUNCTION routing.DIRECTIONS_GEO(method VARCHAR, locations VARIANT)
        RETURNS TABLE (RESPONSE VARIANT, GEOJSON GEOGRAPHY, DISTANCE FLOAT, DURATION FLOAT)
        LANGUAGE SQL
        AS
        'SELECT
            resp AS RESPONSE,
            TO_GEOGRAPHY(resp:features[0]:geometry) AS GEOJSON,
            resp:features[0]:properties:summary:distance::FLOAT AS DISTANCE,
            resp:features[0]:properties:summary:duration::FLOAT AS DURATION
         FROM (SELECT routing.DIRECTIONS(method, locations) AS resp)';
    GRANT USAGE ON FUNCTION routing.DIRECTIONS_GEO(VARCHAR, VARIANT) TO APPLICATION ROLE app_user;

    CREATE OR REPLACE FUNCTION routing.ISOCHRONES_GEO(method TEXT, lon FLOAT, lat FLOAT, range INT)
        RETURNS TABLE (RESPONSE VARIANT, GEOJSON GEOGRAPHY)
        LANGUAGE SQL
        AS
        'SELECT
            resp AS RESPONSE,
            TO_GEOGRAPHY(resp:features[0]:geometry) AS GEOJSON
         FROM (SELECT routing.ISOCHRONES(method, lon, lat, range) AS resp)';
    GRANT USAGE ON FUNCTION routing.ISOCHRONES_GEO(TEXT, FLOAT, FLOAT, INT) TO APPLICATION ROLE app_user;

    CREATE OR REPLACE FUNCTION routing.OPTIMIZATION_GEO(jobs ARRAY, vehicles ARRAY, matrices ARRAY DEFAULT [])
        RETURNS TABLE (RESPONSE VARIANT, GEOJSON GEOGRAPHY, VEHICLE INT, DURATION INT, STEPS VARIANT)
        LANGUAGE SQL
        AS
        'SELECT
            resp AS RESPONSE,
            TO_GEOGRAPHY(OBJECT_CONSTRUCT(''type'', ''LineString'', ''coordinates'', f.value:geometry)) AS GEOJSON,
            f.value:vehicle::INT AS VEHICLE,
            f.value:duration::INT AS DURATION,
            f.value:steps::VARIANT AS STEPS
         FROM
            (SELECT routing.OPTIMIZATION(jobs, vehicles, matrices) AS resp),
            LATERAL FLATTEN(input => resp:routes) f';
    GRANT USAGE ON FUNCTION routing.OPTIMIZATION_GEO(ARRAY, ARRAY, ARRAY) TO APPLICATION ROLE app_user;

    CREATE OR REPLACE FUNCTION routing.OPTIMIZATION_GEO(challenge VARIANT)
        RETURNS TABLE (RESPONSE VARIANT, GEOJSON GEOGRAPHY, VEHICLE INT, DURATION INT, STEPS VARIANT)
        LANGUAGE SQL
        AS
        'SELECT
            resp AS RESPONSE,
            TO_GEOGRAPHY(OBJECT_CONSTRUCT(''type'', ''LineString'', ''coordinates'', f.value:geometry)) AS GEOJSON,
            f.value:vehicle::INT AS VEHICLE,
            f.value:duration::INT AS DURATION,
            f.value:steps::VARIANT AS STEPS
         FROM
            (SELECT routing.OPTIMIZATION(challenge) AS resp),
            LATERAL FLATTEN(input => resp:routes) f';
    GRANT USAGE ON FUNCTION routing.OPTIMIZATION_GEO(VARIANT) TO APPLICATION ROLE app_user;

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
    CALL routing.create_routing_pool();
    RETURN 'Using shared routing pool for region ' || :P_REGION;
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
    ors_spec VARCHAR;
    create_sql VARCHAR;
BEGIN
    db_name := (SELECT CURRENT_DATABASE());
    pool_name := db_name || '_routing_pool';
    svc_name := 'ORS_SERVICE_' || UPPER(:P_REGION);

    CREATE COMPUTE POOL IF NOT EXISTS IDENTIFIER(:pool_name)
        INSTANCE_FAMILY = HIGHMEM_X64_S
        MIN_NODES = 1
        MAX_NODES = 10
        AUTO_RESUME = TRUE
        AUTO_SUSPEND_SECS = 600;
    ALTER COMPUTE POOL IF EXISTS IDENTIFIER(:pool_name) SET AUTO_SUSPEND_SECS = 600;

    ors_spec := '{"spec":{"containers":[{"name":"ors","image":"/fleet_intelligence_setup/public/fleet_intel_repo/openrouteservice:v9.0.0","volumeMounts":[{"name":"files","mountPath":"/home/ors/files"},{"name":"graphs","mountPath":"/home/ors/graphs"},{"name":"elevation-cache","mountPath":"/home/ors/elevation_cache"}],"env":{"REBUILD_GRAPHS":"false","ORS_CONFIG_LOCATION":"/home/ors/files/ors-config.yml","XMS":"3G","XMX":"200G","ORS_ENGINE_PROFILES_CYCLING_ELECTRIC_ENABLED":"true","ORS_ENGINE_PROFILES_DRIVING_CAR_ENABLED":"false","ORS_ENGINE_PROFILES_DRIVING_HGV_ENABLED":"false","ORS_ENGINE_PROFILES_CYCLING_REGULAR_ENABLED":"false","ORS_ENGINE_PROFILES_CYCLING_ROAD_ENABLED":"false","ORS_ENGINE_PROFILES_CYCLING_MOUNTAIN_ENABLED":"false","ORS_ENGINE_PROFILES_FOOT_WALKING_ENABLED":"false","ORS_ENGINE_PROFILES_FOOT_HIKING_ENABLED":"false","ORS_ENGINE_PROFILES_WHEELCHAIR_ENABLED":"false"}}],"endpoints":[{"name":"ors","port":8082,"public":false}],"volumes":[{"name":"files","source":"@ROUTING.ORS_SPCS_STAGE/' || :P_REGION || '"},{"name":"graphs","source":"@ROUTING.ORS_GRAPHS_SPCS_STAGE/' || :P_REGION || '"},{"name":"elevation-cache","source":"@ROUTING.ORS_ELEVATION_CACHE_SPCS_STAGE/' || :P_REGION || '"}]}}';

    EXECUTE IMMEDIATE 'DROP SERVICE IF EXISTS routing.' || svc_name;
    create_sql := 'CREATE SERVICE routing.' || svc_name || ' IN COMPUTE POOL ' || pool_name || ' FROM SPECIFICATION ''' || ors_spec || ''' MIN_INSTANCES = 1 MAX_INSTANCES = 1 AUTO_SUSPEND_SECS = 600';
    EXECUTE IMMEDIATE :create_sql;



    EXECUTE IMMEDIATE 'GRANT OPERATE ON SERVICE routing.' || svc_name || ' TO APPLICATION ROLE app_user';
    EXECUTE IMMEDIATE 'GRANT MONITOR ON SERVICE routing.' || svc_name || ' TO APPLICATION ROLE app_user';

    RETURN 'City ORS service created for region ' || :P_REGION || ': ' || svc_name || ' (shared pool and gateway)';
END;
$$;
GRANT USAGE ON PROCEDURE routing.create_city_ors_service(VARCHAR) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE routing.create_city_functions(P_REGION VARCHAR)
RETURNS STRING
LANGUAGE SQL
AS
$$
BEGIN
    LET fn_dir VARCHAR := 'DIRECTIONS_' || UPPER(:P_REGION);
    LET city_path VARCHAR := '/city/' || :P_REGION;

    EXECUTE IMMEDIATE '
    CREATE OR REPLACE FUNCTION routing.' || fn_dir || '(method VARCHAR, jstart ARRAY, jend ARRAY)
        RETURNS VARIANT
        SERVICE=routing.routing_gateway_service
        ENDPOINT=''gateway''
        MAX_BATCH_ROWS = 1000
        AS ''' || city_path || '/directions_tabular''';
    EXECUTE IMMEDIATE 'GRANT USAGE ON FUNCTION routing.' || fn_dir || '(VARCHAR, ARRAY, ARRAY) TO APPLICATION ROLE app_user';

    EXECUTE IMMEDIATE '
    CREATE OR REPLACE FUNCTION routing.' || fn_dir || '(method VARCHAR, locations VARIANT)
        RETURNS VARIANT
        SERVICE=routing.routing_gateway_service
        ENDPOINT=''gateway''
        MAX_BATCH_ROWS = 1000
        AS ''' || city_path || '/directions''';
    EXECUTE IMMEDIATE 'GRANT USAGE ON FUNCTION routing.' || fn_dir || '(VARCHAR, VARIANT) TO APPLICATION ROLE app_user';

    EXECUTE IMMEDIATE '
    CREATE OR REPLACE FUNCTION routing.MATRIX_' || UPPER(:P_REGION) || '(method VARCHAR, origin ARRAY, destinations ARRAY)
        RETURNS VARIANT
        SERVICE=routing.routing_gateway_service
        ENDPOINT=''gateway''
        MAX_BATCH_ROWS = 10
        AS ''' || city_path || '/matrix_tabular''';
    EXECUTE IMMEDIATE 'GRANT USAGE ON FUNCTION routing.MATRIX_' || UPPER(:P_REGION) || '(VARCHAR, ARRAY, ARRAY) TO APPLICATION ROLE app_user';

    LET fn_dir_geo VARCHAR := 'DIRECTIONS_GEO_' || UPPER(:P_REGION);
    LET fn_iso_geo VARCHAR := 'ISOCHRONES_GEO_' || UPPER(:P_REGION);
    LET fn_opt_geo VARCHAR := 'OPTIMIZATION_GEO_' || UPPER(:P_REGION);

    EXECUTE IMMEDIATE '
    CREATE OR REPLACE FUNCTION routing.' || fn_dir_geo || '(method VARCHAR, jstart ARRAY, jend ARRAY)
        RETURNS TABLE (RESPONSE VARIANT, GEOJSON GEOGRAPHY, DISTANCE FLOAT, DURATION FLOAT)
        LANGUAGE SQL
        AS
        ''SELECT
            resp AS RESPONSE,
            TO_GEOGRAPHY(resp:features[0]:geometry) AS GEOJSON,
            resp:features[0]:properties:summary:distance::FLOAT AS DISTANCE,
            resp:features[0]:properties:summary:duration::FLOAT AS DURATION
         FROM (SELECT routing.' || fn_dir || '(method, jstart, jend) AS resp)''';
    EXECUTE IMMEDIATE 'GRANT USAGE ON FUNCTION routing.' || fn_dir_geo || '(VARCHAR, ARRAY, ARRAY) TO APPLICATION ROLE app_user';

    EXECUTE IMMEDIATE '
    CREATE OR REPLACE FUNCTION routing.' || fn_dir_geo || '(method VARCHAR, locations VARIANT)
        RETURNS TABLE (RESPONSE VARIANT, GEOJSON GEOGRAPHY, DISTANCE FLOAT, DURATION FLOAT)
        LANGUAGE SQL
        AS
        ''SELECT
            resp AS RESPONSE,
            TO_GEOGRAPHY(resp:features[0]:geometry) AS GEOJSON,
            resp:features[0]:properties:summary:distance::FLOAT AS DISTANCE,
            resp:features[0]:properties:summary:duration::FLOAT AS DURATION
         FROM (SELECT routing.' || fn_dir || '(method, locations) AS resp)''';
    EXECUTE IMMEDIATE 'GRANT USAGE ON FUNCTION routing.' || fn_dir_geo || '(VARCHAR, VARIANT) TO APPLICATION ROLE app_user';

    EXECUTE IMMEDIATE '
    CREATE OR REPLACE FUNCTION routing.' || fn_iso_geo || '(method TEXT, lon FLOAT, lat FLOAT, range INT)
        RETURNS TABLE (RESPONSE VARIANT, GEOJSON GEOGRAPHY)
        LANGUAGE SQL
        AS
        ''SELECT
            resp AS RESPONSE,
            TO_GEOGRAPHY(resp:features[0]:geometry) AS GEOJSON
         FROM (SELECT routing.ISOCHRONES(method, lon, lat, range) AS resp)''';
    EXECUTE IMMEDIATE 'GRANT USAGE ON FUNCTION routing.' || fn_iso_geo || '(TEXT, FLOAT, FLOAT, INT) TO APPLICATION ROLE app_user';

    EXECUTE IMMEDIATE '
    CREATE OR REPLACE FUNCTION routing.' || fn_opt_geo || '(jobs ARRAY, vehicles ARRAY, matrices ARRAY DEFAULT [])
        RETURNS TABLE (RESPONSE VARIANT, GEOJSON GEOGRAPHY, VEHICLE INT, DURATION INT, STEPS VARIANT)
        LANGUAGE SQL
        AS
        ''SELECT
            resp AS RESPONSE,
            TO_GEOGRAPHY(OBJECT_CONSTRUCT(''''type'''', ''''LineString'''', ''''coordinates'''', f.value:geometry)) AS GEOJSON,
            f.value:vehicle::INT AS VEHICLE,
            f.value:duration::INT AS DURATION,
            f.value:steps::VARIANT AS STEPS
         FROM
            (SELECT routing.OPTIMIZATION(jobs, vehicles, matrices) AS resp),
            LATERAL FLATTEN(input => resp:routes) f''';
    EXECUTE IMMEDIATE 'GRANT USAGE ON FUNCTION routing.' || fn_opt_geo || '(ARRAY, ARRAY, ARRAY) TO APPLICATION ROLE app_user';

    EXECUTE IMMEDIATE '
    CREATE OR REPLACE FUNCTION routing.' || fn_opt_geo || '(challenge VARIANT)
        RETURNS TABLE (RESPONSE VARIANT, GEOJSON GEOGRAPHY, VEHICLE INT, DURATION INT, STEPS VARIANT)
        LANGUAGE SQL
        AS
        ''SELECT
            resp AS RESPONSE,
            TO_GEOGRAPHY(OBJECT_CONSTRUCT(''''type'''', ''''LineString'''', ''''coordinates'''', f.value:geometry)) AS GEOJSON,
            f.value:vehicle::INT AS VEHICLE,
            f.value:duration::INT AS DURATION,
            f.value:steps::VARIANT AS STEPS
         FROM
            (SELECT routing.OPTIMIZATION(challenge) AS resp),
            LATERAL FLATTEN(input => resp:routes) f''';
    EXECUTE IMMEDIATE 'GRANT USAGE ON FUNCTION routing.' || fn_opt_geo || '(VARIANT) TO APPLICATION ROLE app_user';

    RETURN 'City routing functions created for region ' || :P_REGION || ' (shared gateway with /city/ prefix, includes _GEO wrappers)';
END;
$$;
GRANT USAGE ON PROCEDURE routing.create_city_functions(VARCHAR) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE routing.setup_city_ors(P_REGION VARCHAR)
RETURNS STRING
LANGUAGE SQL
AS
$$
BEGIN
    CALL routing.create_routing_pool();
    CALL routing.create_stages();
    CALL routing.create_city_ors_service(:P_REGION);
    CALL routing.create_services();
    SELECT SYSTEM$WAIT(30);
    CALL routing.create_city_functions(:P_REGION);
    RETURN 'City ORS deployed for region: ' || :P_REGION || ' (shared pool and gateway)';
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
    EXECUTE IMMEDIATE 'ALTER SERVICE routing.' || svc_name || ' RESUME';
    BEGIN
        ALTER SERVICE IF EXISTS routing.routing_gateway_service RESUME;
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
    REGION VARCHAR,
    VEHICLE_TYPE VARCHAR DEFAULT 'cycling-electric'
);
GRANT SELECT ON TABLE data.CA_TRAVEL_TIME_RES7 TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE data.CA_TRAVEL_TIME_RES7 TO APPLICATION ROLE app_user;
GRANT DELETE ON TABLE data.CA_TRAVEL_TIME_RES7 TO APPLICATION ROLE app_user;

CREATE TABLE IF NOT EXISTS data.CA_TRAVEL_TIME_RES8 (
    ORIGIN_H3 VARCHAR,
    DEST_H3 VARCHAR,
    TRAVEL_TIME_SECONDS FLOAT,
    TRAVEL_DISTANCE_METERS FLOAT,
    CALCULATED_AT TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP(),
    REGION VARCHAR,
    VEHICLE_TYPE VARCHAR DEFAULT 'cycling-electric'
);
GRANT SELECT ON TABLE data.CA_TRAVEL_TIME_RES8 TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE data.CA_TRAVEL_TIME_RES8 TO APPLICATION ROLE app_user;
GRANT DELETE ON TABLE data.CA_TRAVEL_TIME_RES8 TO APPLICATION ROLE app_user;


CREATE TABLE IF NOT EXISTS data.CA_TRAVEL_TIME_RES9 (
    ORIGIN_H3 VARCHAR,
    DEST_H3 VARCHAR,
    TRAVEL_TIME_SECONDS FLOAT,
    TRAVEL_DISTANCE_METERS FLOAT,
    CALCULATED_AT TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP(),
    REGION VARCHAR,
    VEHICLE_TYPE VARCHAR DEFAULT 'cycling-electric'
);
GRANT SELECT ON TABLE data.CA_TRAVEL_TIME_RES9 TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE data.CA_TRAVEL_TIME_RES9 TO APPLICATION ROLE app_user;
GRANT DELETE ON TABLE data.CA_TRAVEL_TIME_RES9 TO APPLICATION ROLE app_user;

CREATE TABLE IF NOT EXISTS data.CA_TRAVEL_TIME_RES10 (
    ORIGIN_H3 VARCHAR,
    DEST_H3 VARCHAR,
    TRAVEL_TIME_SECONDS FLOAT,
    TRAVEL_DISTANCE_METERS FLOAT,
    CALCULATED_AT TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP(),
    REGION VARCHAR,
    VEHICLE_TYPE VARCHAR DEFAULT 'cycling-electric'
);
GRANT SELECT ON TABLE data.CA_TRAVEL_TIME_RES10 TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE data.CA_TRAVEL_TIME_RES10 TO APPLICATION ROLE app_user;
GRANT DELETE ON TABLE data.CA_TRAVEL_TIME_RES10 TO APPLICATION ROLE app_user;


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

CREATE TABLE IF NOT EXISTS data.CA_H3_RES10 (H3_INDEX VARCHAR, CENTER_LAT FLOAT, CENTER_LON FLOAT);
GRANT SELECT ON TABLE data.CA_H3_RES10 TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE data.CA_H3_RES10 TO APPLICATION ROLE app_user;

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

CREATE TABLE IF NOT EXISTS data.CA_WORK_QUEUE_RES10 (
    SEQ_ID INTEGER, ORIGIN_H3 VARCHAR, ORIGIN_LON FLOAT, ORIGIN_LAT FLOAT,
    DEST_COORDS ARRAY, DEST_HEX_IDS ARRAY
);
GRANT SELECT ON TABLE data.CA_WORK_QUEUE_RES10 TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE data.CA_WORK_QUEUE_RES10 TO APPLICATION ROLE app_user;

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

CREATE TABLE IF NOT EXISTS data.CA_MATRIX_RAW_RES10 (
    SEQ_ID INTEGER, ORIGIN_H3 VARCHAR, DEST_HEX_IDS ARRAY, MATRIX_RESULT VARIANT
);
GRANT SELECT ON TABLE data.CA_MATRIX_RAW_RES10 TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE data.CA_MATRIX_RAW_RES10 TO APPLICATION ROLE app_user;

-- =============================================================================
-- DATA: Weather, Flood Monitoring, Delivery Incidents, Customer Calls
-- =============================================================================

CREATE TABLE IF NOT EXISTS data.WEATHER_OBSERVATIONS (
    OBSERVATION_ID VARCHAR,
    OBSERVATION_TIME TIMESTAMP_NTZ,
    STATION_NAME VARCHAR,
    STATION_LOCATION GEOGRAPHY,
    TEMPERATURE_C FLOAT,
    FEELS_LIKE_C FLOAT,
    WIND_SPEED_MPH FLOAT,
    WIND_GUST_MPH FLOAT,
    WIND_DIRECTION VARCHAR,
    HUMIDITY_PCT FLOAT,
    PRESSURE_HPA FLOAT,
    VISIBILITY_KM FLOAT,
    PRECIPITATION_MM FLOAT,
    WEATHER_CONDITION VARCHAR,
    WEATHER_SEVERITY VARCHAR,
    UV_INDEX INTEGER,
    CITY VARCHAR
);
GRANT SELECT ON TABLE data.WEATHER_OBSERVATIONS TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE data.WEATHER_OBSERVATIONS TO APPLICATION ROLE app_user;
GRANT DELETE ON TABLE data.WEATHER_OBSERVATIONS TO APPLICATION ROLE app_user;

CREATE TABLE IF NOT EXISTS data.WEATHER_FORECASTS (
    FORECAST_ID VARCHAR,
    ISSUED_AT TIMESTAMP_NTZ,
    FORECAST_TIME TIMESTAMP_NTZ,
    STATION_NAME VARCHAR,
    STATION_LOCATION GEOGRAPHY,
    TEMPERATURE_C FLOAT,
    FEELS_LIKE_C FLOAT,
    WIND_SPEED_MPH FLOAT,
    WIND_GUST_MPH FLOAT,
    PRECIPITATION_PROB_PCT FLOAT,
    PRECIPITATION_MM FLOAT,
    WEATHER_CONDITION VARCHAR,
    WEATHER_SEVERITY VARCHAR,
    CITY VARCHAR
);
GRANT SELECT ON TABLE data.WEATHER_FORECASTS TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE data.WEATHER_FORECASTS TO APPLICATION ROLE app_user;
GRANT DELETE ON TABLE data.WEATHER_FORECASTS TO APPLICATION ROLE app_user;

CREATE TABLE IF NOT EXISTS data.FLOOD_MONITORING (
    FLOOD_ID VARCHAR,
    FLOOD_NAME VARCHAR,
    SEVERITY VARCHAR,
    FLOOD_AREA GEOGRAPHY,
    CENTROID GEOGRAPHY,
    START_TIME TIMESTAMP_NTZ,
    END_TIME TIMESTAMP_NTZ,
    PEAK_TIME TIMESTAMP_NTZ,
    WATER_LEVEL_M FLOAT,
    IS_ACTIVE BOOLEAN,
    AFFECTED_ROADS_EST INTEGER,
    DESCRIPTION VARCHAR,
    CITY VARCHAR
);
GRANT SELECT ON TABLE data.FLOOD_MONITORING TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE data.FLOOD_MONITORING TO APPLICATION ROLE app_user;
GRANT DELETE ON TABLE data.FLOOD_MONITORING TO APPLICATION ROLE app_user;

CREATE TABLE IF NOT EXISTS data.DELIVERY_INCIDENTS (
    INCIDENT_ID VARCHAR,
    ORDER_ID VARCHAR,
    COURIER_ID VARCHAR,
    INCIDENT_TYPE VARCHAR,
    INCIDENT_TIME TIMESTAMP_NTZ,
    DELAY_MINUTES FLOAT,
    INCIDENT_LOCATION GEOGRAPHY,
    DESCRIPTION VARCHAR,
    RELATED_FLOOD_ID VARCHAR,
    WEATHER_CONDITION VARCHAR,
    RESOLVED_TIME TIMESTAMP_NTZ,
    CITY VARCHAR
);
GRANT SELECT ON TABLE data.DELIVERY_INCIDENTS TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE data.DELIVERY_INCIDENTS TO APPLICATION ROLE app_user;
GRANT DELETE ON TABLE data.DELIVERY_INCIDENTS TO APPLICATION ROLE app_user;

CREATE TABLE IF NOT EXISTS data.CUSTOMER_CALLS (
    CALL_ID VARCHAR,
    ORDER_ID VARCHAR,
    CALL_TIME TIMESTAMP_NTZ,
    CUSTOMER_NAME VARCHAR,
    CALL_DURATION_SECS INTEGER,
    CALL_TYPE VARCHAR,
    SENTIMENT VARCHAR,
    ISSUE_CATEGORY VARCHAR,
    CALL_NOTES VARCHAR,
    RESOLUTION VARCHAR,
    RELATED_INCIDENT_ID VARCHAR,
    CITY VARCHAR
);
GRANT SELECT ON TABLE data.CUSTOMER_CALLS TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE data.CUSTOMER_CALLS TO APPLICATION ROLE app_user;
GRANT DELETE ON TABLE data.CUSTOMER_CALLS TO APPLICATION ROLE app_user;

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
    ELSEIF (P_RES = 'RES9') THEN
        resolution := 9; lat_step := 0.003; lon_step := 0.003;
    ELSE
        resolution := 10; lat_step := 0.001; lon_step := 0.001;
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
    ELSEIF (P_RES = 'RES9') THEN
        k_ring := 9;
    ELSE
        k_ring := 5;
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
    max_retries INTEGER DEFAULT 10;
    retry_wait INTEGER DEFAULT 10;
BEGIN
    queue_table := 'data.CA_WORK_QUEUE_' || P_RES;
    raw_table := 'data.CA_MATRIX_RAW_' || P_RES;

    IF (P_RES = 'RES7') THEN
        batch_size := 100;
    ELSEIF (P_RES = 'RES8') THEN
        batch_size := 1000;
    ELSEIF (P_RES = 'RES9') THEN
        batch_size := 1000;
    ELSE
        batch_size := 500;
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
                ''cycling-electric'',
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

CREATE OR REPLACE PROCEDURE data.BUILD_TRAVEL_TIME_RANGE_REGION(P_RES VARCHAR, P_START_SEQ INTEGER, P_END_SEQ INTEGER, P_MATRIX_FN VARCHAR, P_VEHICLE_PROFILE VARCHAR)
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
                ''' || P_VEHICLE_PROFILE || ''',
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
           ' (resumed from seq ' || max_done || ', fn=' || P_MATRIX_FN || ', profile=' || P_VEHICLE_PROFILE || ')';
END;
$$;
GRANT USAGE ON PROCEDURE data.BUILD_TRAVEL_TIME_RANGE_REGION(VARCHAR, INTEGER, INTEGER, VARCHAR, VARCHAR) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE data.BUILD_MATRIX_FOR_REGION(P_RES VARCHAR, P_MIN_LAT FLOAT, P_MAX_LAT FLOAT, P_MIN_LON FLOAT, P_MAX_LON FLOAT, P_MATRIX_FN VARCHAR, P_REGION VARCHAR, P_VEHICLE_PROFILE VARCHAR)
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
    LET raw_table VARCHAR := 'data.CA_MATRIX_RAW_' || P_RES;

    BEGIN
        ALTER SERVICE IF EXISTS routing.routing_gateway_service RESUME;
    EXCEPTION WHEN OTHER THEN NULL;
    END;
    BEGIN
        EXECUTE IMMEDIATE 'ALTER SERVICE IF EXISTS routing.ORS_SERVICE_' || UPPER(P_REGION) || ' RESUME';
    EXCEPTION WHEN OTHER THEN NULL;
    END;
    EXECUTE IMMEDIATE 'SELECT SYSTEM$WAIT(5)';

    CALL data.BUILD_HEXAGONS(:P_RES, :P_MIN_LAT, :P_MAX_LAT, :P_MIN_LON, :P_MAX_LON);

    count_sql := 'SELECT COUNT(*) AS CNT FROM ' || hex_table;
    rs := (EXECUTE IMMEDIATE :count_sql);
    LET c2 CURSOR FOR rs;
    FOR r IN c2 DO hex_count := r.CNT; END FOR;

    CALL data.BUILD_WORK_QUEUE(:P_RES);

    count_sql := 'SELECT COUNT(*) AS CNT FROM ' || queue_table;
    rs := (EXECUTE IMMEDIATE :count_sql);
    LET c4 CURSOR FOR rs;
    FOR r IN c4 DO queue_count := r.CNT; END FOR;

    EXECUTE IMMEDIATE 'DELETE FROM ' || raw_table;
    EXECUTE IMMEDIATE 'CALL data.BUILD_TRAVEL_TIME_RANGE_REGION(''' || P_RES || ''', 1, ' || queue_count || ', ''' || P_MATRIX_FN || ''', ''' || P_VEHICLE_PROFILE || ''')';
    EXECUTE IMMEDIATE 'CALL data.FLATTEN_MATRIX_RAW(''' || P_RES || ''', ''' || P_REGION || ''', ''' || P_VEHICLE_PROFILE || ''')';

    count_sql := 'SELECT COUNT(*) AS CNT FROM ' || travel_table || ' WHERE REGION = ''' || P_REGION || ''' AND VEHICLE_TYPE = ''' || P_VEHICLE_PROFILE || '''';
    rs := (EXECUTE IMMEDIATE :count_sql);
    LET c5 CURSOR FOR rs;
    FOR r IN c5 DO travel_count := r.CNT; END FOR;

    RETURN P_RES || ' complete (' || P_MATRIX_FN || '/' || P_VEHICLE_PROFILE || '): ' || hex_count || ' hexagons, ' ||
           queue_count || ' origins, ' || travel_count || ' travel times';
END;
$$;
GRANT USAGE ON PROCEDURE data.BUILD_MATRIX_FOR_REGION(VARCHAR, FLOAT, FLOAT, FLOAT, FLOAT, VARCHAR, VARCHAR, VARCHAR) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE data.SCALE_MATRIX_INFRASTRUCTURE(P_REGION VARCHAR, P_SCALE_UP BOOLEAN)
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    wh_name VARCHAR;
    pool_name VARCHAR;
    ors_svc VARCHAR;
    gw_svc VARCHAR;
    max_clusters INTEGER;
    max_instances INTEGER;
    max_nodes INTEGER;
BEGIN
    wh_name := 'FLEET_INTEL_WH';
    pool_name := (SELECT CURRENT_DATABASE()) || '_ROUTING_POOL';
    ors_svc := 'routing.ORS_SERVICE_' || UPPER(P_REGION);
    gw_svc := 'routing.ROUTING_GATEWAY_SERVICE';

    IF (P_SCALE_UP) THEN
        max_clusters := 4;
        max_instances := 4;
        max_nodes := 10;
    ELSE
        max_clusters := 1;
        max_instances := 1;
        max_nodes := 1;
    END IF;

    BEGIN
        EXECUTE IMMEDIATE 'ALTER WAREHOUSE IF EXISTS ' || wh_name || ' SET MAX_CLUSTER_COUNT = ' || max_clusters || ' MIN_CLUSTER_COUNT = 1 SCALING_POLICY = ''STANDARD''';
    EXCEPTION WHEN OTHER THEN NULL;
    END;

    BEGIN
        EXECUTE IMMEDIATE 'ALTER COMPUTE POOL IF EXISTS ' || pool_name || ' SET MAX_NODES = ' || max_nodes;
    EXCEPTION WHEN OTHER THEN NULL;
    END;

    BEGIN
        EXECUTE IMMEDIATE 'ALTER SERVICE IF EXISTS ' || ors_svc || ' SET MAX_INSTANCES = ' || max_instances;
    EXCEPTION WHEN OTHER THEN NULL;
    END;

    BEGIN
        EXECUTE IMMEDIATE 'ALTER SERVICE IF EXISTS ' || gw_svc || ' SET MAX_INSTANCES = ' || max_instances;
    EXCEPTION WHEN OTHER THEN NULL;
    END;

    IF (P_SCALE_UP) THEN
        RETURN 'Scaled UP for ' || P_REGION || ': warehouse max_clusters=' || max_clusters || ', pool max_nodes=' || max_nodes || ', ORS max_instances=' || max_instances;
    ELSE
        RETURN 'Scaled DOWN for ' || P_REGION || ': warehouse max_clusters=1, pool max_nodes=1, ORS max_instances=1';
    END IF;
END;
$$;
GRANT USAGE ON PROCEDURE data.SCALE_MATRIX_INFRASTRUCTURE(VARCHAR, BOOLEAN) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE data.FLATTEN_MATRIX_RAW(P_RES VARCHAR, P_REGION VARCHAR, P_VEHICLE_TYPE VARCHAR)
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

    EXECUTE IMMEDIATE 'DELETE FROM ' || target_table || ' WHERE REGION = ''' || P_REGION || ''' AND (VEHICLE_TYPE = ''' || P_VEHICLE_TYPE || ''' OR VEHICLE_TYPE IS NULL)';

    EXECUTE IMMEDIATE '
    INSERT INTO ' || target_table || ' (ORIGIN_H3, DEST_H3, TRAVEL_TIME_SECONDS, TRAVEL_DISTANCE_METERS, REGION, VEHICLE_TYPE)
    SELECT
        r.ORIGIN_H3,
        r.DEST_HEX_IDS[f.INDEX]::VARCHAR AS DEST_H3,
        r.MATRIX_RESULT:durations[0][f.INDEX]::FLOAT AS TRAVEL_TIME_SECONDS,
        r.MATRIX_RESULT:distances[0][f.INDEX]::FLOAT AS TRAVEL_DISTANCE_METERS,
        ''' || P_REGION || ''',
        ''' || P_VEHICLE_TYPE || '''
    FROM ' || raw_table || ' r,
        LATERAL FLATTEN(input => r.MATRIX_RESULT:durations[0]) f
    WHERE r.MATRIX_RESULT:durations IS NOT NULL
      AND f.value IS NOT NULL';

    rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || target_table || ' WHERE REGION = ''' || P_REGION || ''' AND VEHICLE_TYPE = ''' || P_VEHICLE_TYPE || '''');
    LET c CURSOR FOR rs;
    FOR row_val IN c DO
        row_count := row_val.CNT;
    END FOR;

    RETURN P_RES || ' flatten complete (' || P_REGION || '/' || P_VEHICLE_TYPE || '): ' || row_count || ' travel time pairs';
END;
$$;
GRANT USAGE ON PROCEDURE data.FLATTEN_MATRIX_RAW(VARCHAR, VARCHAR, VARCHAR) TO APPLICATION ROLE app_user;

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
    CALL data.FLATTEN_MATRIX_RAW('RES7', 'SanFrancisco', 'cycling-electric');

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
    CALL data.FLATTEN_MATRIX_RAW('RES8', 'SanFrancisco', 'cycling-electric');

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
    CALL data.FLATTEN_MATRIX_RAW('RES9', 'SanFrancisco', 'cycling-electric');

    RETURN 'RES9 complete: ' || hex_count || ' hexagons, ' ||
           queue_count || ' origins, ' ||
           (SELECT COUNT(*) FROM data.CA_TRAVEL_TIME_RES9) || ' travel times';
END;
$$;
GRANT USAGE ON PROCEDURE data.BUILD_TRAVEL_TIME_MATRIX_RES9() TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE data.BUILD_TRAVEL_TIME_MATRIX_RES10()
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
    SELECT COUNT(*) INTO hex_count FROM data.CA_H3_RES10;
    IF (hex_count = 0) THEN
        CALL data.BUILD_HEXAGONS('RES10', 37.71, 37.81, -122.51, -122.37);
    END IF;
    SELECT COUNT(*) INTO hex_count FROM data.CA_H3_RES10;

    SELECT COUNT(*) INTO queue_count FROM data.CA_WORK_QUEUE_RES10;
    IF (queue_count = 0) THEN
        CALL data.BUILD_WORK_QUEUE('RES10');
    END IF;
    SELECT COUNT(*) INTO queue_count FROM data.CA_WORK_QUEUE_RES10;

    EXECUTE IMMEDIATE 'CALL data.BUILD_TRAVEL_TIME_RANGE(''RES10'', 1, ' || queue_count || ')';
    CALL data.FLATTEN_MATRIX_RAW('RES10', 'SanFrancisco', 'cycling-electric');

    RETURN 'RES10 complete: ' || hex_count || ' hexagons, ' ||
           queue_count || ' origins, ' ||
           (SELECT COUNT(*) FROM data.CA_TRAVEL_TIME_RES10) || ' travel times';
END;
$$;
GRANT USAGE ON PROCEDURE data.BUILD_TRAVEL_TIME_MATRIX_RES10() TO APPLICATION ROLE app_user;

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
    r10_hex INTEGER DEFAULT 0; r10_queue INTEGER DEFAULT 0; r10_raw INTEGER DEFAULT 0; r10_flat INTEGER DEFAULT 0;
    r7_stage VARCHAR; r8_stage VARCHAR; r9_stage VARCHAR; r10_stage VARCHAR;
    r7_pct FLOAT DEFAULT 0; r8_pct FLOAT DEFAULT 0; r9_pct FLOAT DEFAULT 0; r10_pct FLOAT DEFAULT 0;
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

    SELECT COUNT(*) INTO r10_hex FROM data.CA_H3_RES10;
    SELECT COUNT(*) INTO r10_queue FROM data.CA_WORK_QUEUE_RES10;
    SELECT COUNT(*) INTO r10_raw FROM data.CA_MATRIX_RAW_RES10;
    SELECT COUNT(*) INTO r10_flat FROM data.CA_TRAVEL_TIME_RES10;

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

    IF (r10_flat > 0 AND r10_queue > 0 AND r10_raw = r10_queue) THEN r10_stage := 'COMPLETE';
    ELSEIF (r10_raw > 0 AND r10_raw = r10_queue) THEN r10_stage := 'FLATTENING';
    ELSEIF (r10_raw > 0) THEN r10_stage := 'BUILDING';
    ELSEIF (r10_queue > 0) THEN r10_stage := 'QUEUED';
    ELSEIF (r10_hex > 0) THEN r10_stage := 'HEXAGONS_READY';
    ELSE r10_stage := 'NOT_STARTED';
    END IF;
    IF (r10_queue > 0) THEN r10_pct := ROUND(r10_raw * 100.0 / r10_queue, 1); END IF;

    RETURN OBJECT_CONSTRUCT(
        'RES7', OBJECT_CONSTRUCT(
            'stage', r7_stage, 'hexagons', r7_hex, 'work_queue', r7_queue,
            'raw_ingested', r7_raw, 'flattened', r7_flat, 'pct', r7_pct),
        'RES8', OBJECT_CONSTRUCT(
            'stage', r8_stage, 'hexagons', r8_hex, 'work_queue', r8_queue,
            'raw_ingested', r8_raw, 'flattened', r8_flat, 'pct', r8_pct),
        'RES9', OBJECT_CONSTRUCT(
            'stage', r9_stage, 'hexagons', r9_hex, 'work_queue', r9_queue,
            'raw_ingested', r9_raw, 'flattened', r9_flat, 'pct', r9_pct),
        'RES10', OBJECT_CONSTRUCT(
            'stage', r10_stage, 'hexagons', r10_hex, 'work_queue', r10_queue,
            'raw_ingested', r10_raw, 'flattened', r10_flat, 'pct', r10_pct)
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
    TRUNCATE TABLE data.CA_H3_RES10;
    TRUNCATE TABLE data.CA_WORK_QUEUE_RES7;
    TRUNCATE TABLE data.CA_WORK_QUEUE_RES8;
    TRUNCATE TABLE data.CA_WORK_QUEUE_RES9;
    TRUNCATE TABLE data.CA_WORK_QUEUE_RES10;
    TRUNCATE TABLE data.CA_MATRIX_RAW_RES7;
    TRUNCATE TABLE data.CA_MATRIX_RAW_RES8;
    TRUNCATE TABLE data.CA_MATRIX_RAW_RES9;
    TRUNCATE TABLE data.CA_MATRIX_RAW_RES10;
    TRUNCATE TABLE data.CA_TRAVEL_TIME_RES7;
    TRUNCATE TABLE data.CA_TRAVEL_TIME_RES8;
    TRUNCATE TABLE data.CA_TRAVEL_TIME_RES9;
    TRUNCATE TABLE data.CA_TRAVEL_TIME_RES10;
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
),
incident_stats AS (
    SELECT ORDER_ID,
        MAX(INCIDENT_TYPE) AS DELAY_REASON,
        SUM(DELAY_MINUTES) AS TOTAL_DELAY_MINUTES,
        MAX(RELATED_FLOOD_ID) AS FLOOD_ID,
        MAX(WEATHER_CONDITION) AS INCIDENT_WEATHER
    FROM data.DELIVERY_INCIDENTS
    GROUP BY ORDER_ID
)
SELECT
    rg.COURIER_ID, rg.ORDER_ID, rg.ORDER_TIME, rg.PICKUP_TIME, rg.DELIVERY_TIME,
    rg.RESTAURANT_ID, rg.RESTAURANT_NAME, rg.CUISINE_TYPE,
    rg.RESTAURANT_LOCATION, rg.RESTAURANT_ADDRESS,
    rg.CUSTOMER_ADDRESS_ID, rg.CUSTOMER_ADDRESS, rg.CUSTOMER_LOCATION,
    rg.PREP_TIME_MINS, rg.ORDER_STATUS, rg.ROUTE_DURATION_SECS, rg.ROUTE_DISTANCE_METERS,
    rg.GEOMETRY, rg.SHIFT_TYPE, rg.VEHICLE_TYPE, rg.CITY,
    ds.AVERAGE_KMH, ds.MAX_KMH,
    COALESCE(ins.DELAY_REASON, 'none') AS DELAY_REASON,
    COALESCE(ins.TOTAL_DELAY_MINUTES, 0) AS DELAY_MINUTES,
    CASE WHEN ins.FLOOD_ID IS NOT NULL THEN TRUE ELSE FALSE END AS FLOOD_AFFECTED,
    ins.INCIDENT_WEATHER AS DELAY_WEATHER_CONDITION
FROM data.DELIVERY_ROUTE_GEOMETRIES rg
LEFT JOIN delivery_stats ds ON rg.ORDER_ID = ds.ORDER_ID
LEFT JOIN incident_stats ins ON rg.ORDER_ID = ins.ORDER_ID;
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
-- CORE: Semantic View + Cortex Agent
-- =============================================================================

CREATE OR REPLACE PROCEDURE core.setup_semantic_view()
RETURNS STRING
LANGUAGE PYTHON
RUNTIME_VERSION = '3.11'
PACKAGES = ('snowflake-snowpark-python')
HANDLER = 'run'
AS
$$
def run(session):
    db = session.sql("SELECT CURRENT_DATABASE()").collect()[0][0]
    results = []
    try:
        session.sql(f"""CREATE OR REPLACE SEMANTIC VIEW {db}.DATA.FLEET_ANALYTICS
TABLES (
    DELIVERIES AS {db}.DATA.DELIVERY_SUMMARY PRIMARY KEY (ORDER_ID),
    WEATHER AS {db}.DATA.WEATHER_OBSERVATIONS PRIMARY KEY (OBSERVATION_ID),
    FORECASTS AS {db}.DATA.WEATHER_FORECASTS PRIMARY KEY (FORECAST_ID),
    FLOODS AS {db}.DATA.FLOOD_MONITORING PRIMARY KEY (FLOOD_ID),
    INCIDENTS AS {db}.DATA.DELIVERY_INCIDENTS PRIMARY KEY (INCIDENT_ID),
    CALLS AS {db}.DATA.CUSTOMER_CALLS PRIMARY KEY (CALL_ID)
)
RELATIONSHIPS (
    INCIDENTS (ORDER_ID) REFERENCES DELIVERIES (ORDER_ID),
    CALLS (ORDER_ID) REFERENCES DELIVERIES (ORDER_ID),
    INCIDENTS (RELATED_FLOOD_ID) REFERENCES FLOODS (FLOOD_ID)
)
FACTS (
    DELIVERIES.ROUTE_DISTANCE_METERS as ROUTE_DISTANCE_METERS comment='Delivery route distance in meters',
    DELIVERIES.ROUTE_DURATION_SECS as ROUTE_DURATION_SECS comment='Delivery route duration in seconds',
    DELIVERIES.PREP_TIME_MINS as PREP_TIME_MINS comment='Restaurant food preparation time in minutes',
    DELIVERIES.AVERAGE_KMH as AVERAGE_KMH comment='Average courier speed in kmh',
    DELIVERIES.MAX_KMH as MAX_KMH comment='Maximum courier speed in kmh',
    DELIVERIES.DELAY_MINUTES as DELAY_MINUTES comment='Total delay in minutes due to incidents',
    WEATHER.TEMPERATURE_C as TEMPERATURE_C comment='Observed temperature in celsius',
    WEATHER.WIND_SPEED_MPH as WIND_SPEED_MPH comment='Observed wind speed in mph',
    WEATHER.PRECIPITATION_MM as PRECIPITATION_MM comment='Observed precipitation amount in mm',
    WEATHER.HUMIDITY_PCT as HUMIDITY_PCT comment='Observed humidity percentage',
    FORECASTS.PRECIPITATION_PROB_PCT as PRECIPITATION_PROB_PCT comment='Forecast probability of precipitation 0 to 100 percent',
    INCIDENTS.DELAY_MINUTES as DELAY_MINUTES comment='Delay minutes caused by this incident',
    CALLS.CALL_DURATION_SECS as CALL_DURATION_SECS comment='Customer call duration in seconds'
)
DIMENSIONS (
    DELIVERIES.ORDER_ID as ORDER_ID comment='Unique delivery order identifier',
    DELIVERIES.COURIER_ID as COURIER_ID comment='Courier assigned to the delivery',
    DELIVERIES.RESTAURANT_ID as RESTAURANT_ID comment='Restaurant identifier',
    DELIVERIES.RESTAURANT_NAME as RESTAURANT_NAME comment='Name of the restaurant',
    DELIVERIES.CUISINE_TYPE as CUISINE_TYPE comment='Type of cuisine',
    DELIVERIES.RESTAURANT_ADDRESS as RESTAURANT_ADDRESS comment='Restaurant street address',
    DELIVERIES.CUSTOMER_ADDRESS_ID as CUSTOMER_ADDRESS_ID comment='Customer address identifier',
    DELIVERIES.CUSTOMER_ADDRESS as CUSTOMER_ADDRESS comment='Customer delivery address',
    DELIVERIES.CITY as CITY comment='City where the delivery takes place',
    DELIVERIES.ORDER_TIME as ORDER_TIME comment='Timestamp when the order was placed',
    DELIVERIES.PICKUP_TIME as PICKUP_TIME comment='Timestamp when courier picked up order',
    DELIVERIES.DELIVERY_TIME as DELIVERY_TIME comment='Timestamp when the order was delivered',
    DELIVERIES.ORDER_STATUS as ORDER_STATUS comment='Delivery status',
    DELIVERIES.SHIFT_TYPE as SHIFT_TYPE comment='Shift period Lunch Dinner or Afternoon',
    DELIVERIES.VEHICLE_TYPE as VEHICLE_TYPE comment='Courier vehicle car scooter or bicycle',
    DELIVERIES.DELAY_REASON as DELAY_REASON comment='Reason for delivery delay: traffic, flooding, weather, or none',
    DELIVERIES.FLOOD_AFFECTED as FLOOD_AFFECTED comment='Whether delivery was affected by flooding',
    DELIVERIES.DELAY_WEATHER_CONDITION as DELAY_WEATHER_CONDITION comment='Weather condition that caused the delay',
    WEATHER.OBSERVATION_TIME as OBSERVATION_TIME comment='Time of weather observation hourly intervals',
    WEATHER.STATION_NAME as STATION_NAME comment='Met Office weather station name',
    WEATHER.WEATHER_CONDITION as WEATHER_CONDITION comment='Observed weather condition: Clear, Cloudy, Light Rain, Heavy Rain, Thunderstorm, Fog, Snow',
    WEATHER.WEATHER_SEVERITY as WEATHER_SEVERITY comment='Observed weather severity: normal, advisory, warning, severe',
    FORECASTS.ISSUED_AT as ISSUED_AT comment='When the forecast was issued',
    FORECASTS.FORECAST_TIME as FORECAST_TIME comment='Future time the forecast is for use this to find tomorrow or upcoming weather',
    FORECASTS.CITY as CITY comment='City for the forecast',
    INCIDENTS.INCIDENT_TYPE as INCIDENT_TYPE comment='Type of delivery incident: traffic, flooding, weather',
    INCIDENTS.INCIDENT_TIME as INCIDENT_TIME comment='Time when the incident occurred',
    INCIDENTS.DESCRIPTION as DESCRIPTION comment='Description of the delivery incident',
    FLOODS.FLOOD_NAME as FLOOD_NAME comment='Name of the flood event',
    FLOODS.SEVERITY as SEVERITY comment='Flood severity level: minor, moderate, severe',
    FLOODS.START_TIME as START_TIME comment='When the flood event started',
    FLOODS.END_TIME as END_TIME comment='When the flood event ended',
    FLOODS.IS_ACTIVE as IS_ACTIVE comment='Whether the flood event is currently active',
    CALLS.CALL_TIME as CALL_TIME comment='Time of customer call',
    CALLS.CALL_TYPE as CALL_TYPE comment='Type of call: complaint, enquiry, cancellation',
    CALLS.SENTIMENT as SENTIMENT comment='Customer sentiment: angry, frustrated, neutral, understanding',
    CALLS.ISSUE_CATEGORY as ISSUE_CATEGORY comment='Issue category: late delivery, weather delay, flood delay, missing items, wrong order',
    CALLS.RESOLUTION as RESOLUTION comment='How the call was resolved'
)
METRICS (
    DELIVERIES.TOTAL_DELIVERIES AS COUNT(DELIVERIES.ORDER_ID) comment='Total number of deliveries',
    DELIVERIES.AVG_DISTANCE AS AVG(DELIVERIES.ROUTE_DISTANCE_METERS) comment='Average delivery distance in meters',
    DELIVERIES.AVG_DURATION AS AVG(DELIVERIES.ROUTE_DURATION_SECS) comment='Average delivery duration in seconds',
    DELIVERIES.AVG_PREP AS AVG(DELIVERIES.PREP_TIME_MINS) comment='Average food preparation time in minutes',
    DELIVERIES.AVG_COURIER_SPEED AS AVG(DELIVERIES.AVERAGE_KMH) comment='Average courier speed in kmh',
    DELIVERIES.DELAYED_DELIVERIES AS COUNT_IF(DELIVERIES.DELAY_REASON != 'none') comment='Number of delayed deliveries',
    DELIVERIES.AVG_DELAY AS AVG(IFF(DELIVERIES.DELAY_MINUTES > 0, DELIVERIES.DELAY_MINUTES, NULL)) comment='Average delay in minutes for affected deliveries',
    DELIVERIES.FLOOD_AFFECTED_COUNT AS COUNT_IF(DELIVERIES.FLOOD_AFFECTED = TRUE) comment='Number of deliveries affected by flooding',
    CALLS.TOTAL_CALLS AS COUNT(CALLS.CALL_ID) comment='Total customer calls',
    INCIDENTS.TOTAL_INCIDENTS AS COUNT(INCIDENTS.INCIDENT_ID) comment='Total delivery incidents'
)
""").collect()
        results.append("Semantic view created")
    except Exception as e:
        results.append(f"Semantic view error: {e}")
    try:
        session.sql(f"GRANT SELECT ON ALL SEMANTIC VIEWS IN SCHEMA {db}.DATA TO APPLICATION ROLE app_user").collect()
        session.sql(f"GRANT SELECT ON ALL SEMANTIC VIEWS IN SCHEMA {db}.DATA TO APPLICATION ROLE all_agents_role").collect()
        session.sql(f"GRANT SELECT ON ALL VIEWS IN SCHEMA {db}.DATA TO APPLICATION ROLE all_agents_role").collect()
        session.sql(f"GRANT SELECT ON ALL TABLES IN SCHEMA {db}.DATA TO APPLICATION ROLE all_agents_role").collect()
        results.append("Grants applied")
    except Exception as e:
        results.append(f"Grant error: {e}")
    return " | ".join(results)
$$;
GRANT USAGE ON PROCEDURE core.setup_semantic_view() TO APPLICATION ROLE app_user;

CREATE OR REPLACE FUNCTION core.FLEET_MAP_FILTER(filter_type VARCHAR, filter_value VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
AS 'SELECT filter_type || '':'' || filter_value';
GRANT USAGE ON FUNCTION core.FLEET_MAP_FILTER(VARCHAR, VARCHAR) TO APPLICATION ROLE app_user;
GRANT USAGE ON FUNCTION core.FLEET_MAP_FILTER(VARCHAR, VARCHAR) TO APPLICATION ROLE all_agents_role;

DROP PROCEDURE IF EXISTS core.FLEET_DATA_QUERY(VARCHAR);
DROP FUNCTION IF EXISTS core.FLEET_DATA_QUERY(VARCHAR);

CREATE OR REPLACE PROCEDURE core.create_fleet_data_query_function()
RETURNS STRING
LANGUAGE SQL
AS
$$
BEGIN
    CREATE OR REPLACE FUNCTION core.FLEET_DATA_QUERY(query VARCHAR)
    RETURNS VARIANT
    SERVICE = core.fleet_intelligence_service
    ENDPOINT = 'fleet-intel-ui'
    COMMENT = 'Query fleet delivery data via natural language. Routes to SPCS service for SQL generation and execution.'
    AS '/api/query';
    GRANT USAGE ON FUNCTION core.FLEET_DATA_QUERY(VARCHAR) TO APPLICATION ROLE app_user;
    GRANT USAGE ON FUNCTION core.FLEET_DATA_QUERY(VARCHAR) TO APPLICATION ROLE all_agents_role;
    RETURN 'FLEET_DATA_QUERY function created';
EXCEPTION
    WHEN OTHER THEN
        RETURN 'FLEET_DATA_QUERY deferred: ' || SQLERRM;
END;
$$;
GRANT USAGE ON PROCEDURE core.create_fleet_data_query_function() TO APPLICATION ROLE app_user;

DROP PROCEDURE IF EXISTS core.create_agent();
DROP PROCEDURE IF EXISTS core.create_agent(VARCHAR);
CREATE OR REPLACE PROCEDURE core.create_agent(AGENT_WAREHOUSE STRING DEFAULT 'FLEET_INTEL_WH')
RETURNS STRING
LANGUAGE PYTHON
RUNTIME_VERSION = '3.11'
PACKAGES = ('snowflake-snowpark-python')
HANDLER = 'run'
AS
$$
import json as _json
def run(session, agent_warehouse):
    db = session.sql("SELECT CURRENT_DATABASE()").collect()[0][0]
    wh = agent_warehouse if agent_warehouse else "FLEET_INTEL_WH"
    spec = {
        "models": {"orchestration": "claude-4-sonnet"},
        "instructions": {
            "orchestration": (
                "You are Yum Drop Online Food Deliveries, an AI analyst for a food delivery company. "
                "IMPORTANT EFFICIENCY RULES: "
                "1. Always ask ONE comprehensive question per fleet_data call. Never break a query into multiple calls. "
                "2. For weather summaries, ask for aggregated data across all stations in one query. "
                "3. For forecasts, ask about WEATHER_FORECASTS table data directly. "
                "4. Aim to answer every question in 1-2 fleet_data calls maximum. "
                "AVAILABLE DATA: "
                "DELIVERY_SUMMARY - Deliveries with DELAY_REASON (none/traffic/flooding/weather), DELAY_MINUTES, FLOOD_AFFECTED, AVERAGE_KMH, ORDER_STATUS (delivered/in_transit/picked_up), ORDER_TIME/PICKUP_TIME/DELIVERY_TIME, SHIFT_TYPE (Lunch/Dinner/Afternoon), VEHICLE_TYPE, CUISINE_TYPE, CITY, COURIER_ID (e.g. SAN-0029). "
                "WEATHER_OBSERVATIONS - Hourly weather: OBSERVATION_TIME, STATION_NAME, TEMPERATURE_C, WIND_SPEED_MPH, HUMIDITY_PCT, PRECIPITATION_MM, WEATHER_CONDITION (Clear/Cloudy/Light Rain/Heavy Rain/Thunderstorm/Fog/Snow), WEATHER_SEVERITY (normal/advisory/warning/severe). "
                "WEATHER_FORECASTS - Future predictions: FORECAST_TIME (the future datetime), ISSUED_AT, STATION_NAME, TEMPERATURE_C, PRECIPITATION_PROB_PCT, WEATHER_CONDITION, WEATHER_SEVERITY. Use FORECAST_TIME to find tomorrow or upcoming weather. "
                "FLOOD_MONITORING - Flood events: FLOOD_NAME, SEVERITY (minor/moderate/severe), START_TIME, END_TIME, WATER_LEVEL_M, IS_ACTIVE, AFFECTED_ROADS_EST. "
                "DELIVERY_INCIDENTS - Delay events: INCIDENT_TYPE (traffic/flooding/weather), DELAY_MINUTES, RELATED_FLOOD_ID, WEATHER_CONDITION. Joins to DELIVERY_SUMMARY on ORDER_ID. "
                "CUSTOMER_CALLS - Customer calls: CALL_TYPE (complaint/enquiry/cancellation), SENTIMENT (angry/frustrated/neutral/understanding), ISSUE_CATEGORY, CALL_NOTES (verbatim comments), RESOLUTION. Joins to DELIVERY_SUMMARY on ORDER_ID. "
                "MAP CONTROL: Use fleet_map_control to filter the dashboard map. filter_type: restaurant/courier/status/cuisine/vehicle/shift/all. "
                "Examples: filter_type=courier, filter_value=SAN-0029; filter_type=all, filter_value= (reset). "
                "Always query fleet_data alongside map actions to provide data context. "
                "IMPORTANT: Do NOT use native chart or table visualization tools. Respond with plain text using GFM markdown tables."
            )
        },
        "tools": [
            {"tool_spec": {"type": "generic", "name": "fleet_data", "description": "Query Yum Drop food delivery fleet data including deliveries, couriers, restaurants, routes, timing, and speeds across multiple cities. Pass the user question as the query parameter.", "input_schema": {"type": "object", "properties": {"query": {"type": "string", "description": "The natural language question about fleet delivery data"}}, "required": ["query"]}}},
            {"tool_spec": {"type": "generic", "name": "fleet_map_control", "description": "Control the dashboard map to filter and display specific delivery routes. Use filter_type and filter_value together to dynamically filter the map.", "input_schema": {"type": "object", "properties": {"filter_type": {"type": "string", "description": "The category to filter by: restaurant (filter by restaurant name), courier (filter by courier ID), status (filter by order status: active, in_transit, picked_up, delivered), cuisine (filter by cuisine type), vehicle (filter by vehicle type), shift (filter by shift type), or all (reset/show everything)"}, "filter_value": {"type": "string", "description": "The value to filter by within the chosen filter_type. For example: Starbucks, SAN-0029, active, Italian, bicycle, Lunch, or empty string for all"}}, "required": ["filter_type", "filter_value"]}}}
        ],
        "tool_resources": {
            "fleet_data": {
                "type": "function",
                "identifier": db + ".CORE.FLEET_DATA_QUERY",
                "execution_environment": {"type": "warehouse", "warehouse": wh}
            },
            "fleet_map_control": {
                "type": "function",
                "identifier": db + ".CORE.FLEET_MAP_FILTER",
                "execution_environment": {"type": "warehouse", "warehouse": wh}
            }
        }
    }
    spec_str = _json.dumps(spec)
    escaped_spec = spec_str.replace("'", "''")
    create_sql = f"CREATE OR REPLACE AGENT core.FLEET_INTELLIGENCE_AGENT COMMENT = 'Yum Drop Online Food Deliveries agent' FROM SPECIFICATION '{escaped_spec}'"
    session.sql(create_sql).collect()
    session.sql("GRANT USAGE ON AGENT core.FLEET_INTELLIGENCE_AGENT TO APPLICATION ROLE app_user").collect()
    session.sql("GRANT USAGE ON AGENT core.FLEET_INTELLIGENCE_AGENT TO APPLICATION ROLE all_agents_role").collect()
    return "Agent created with warehouse: " + wh
$$;
GRANT USAGE ON PROCEDURE core.create_agent(STRING) TO APPLICATION ROLE app_user;

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
    IF (ARRAY_CONTAINS('IMPORTED PRIVILEGES ON SNOWFLAKE DB'::VARIANT, privileges)) THEN
        BEGIN
            CALL core.setup_semantic_view();
        EXCEPTION
            WHEN OTHER THEN NULL;
        END;
        BEGIN
            CALL core.create_agent();
        EXCEPTION
            WHEN OTHER THEN NULL;
        END;
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
    BEGIN
        CALL core.setup_semantic_view();
    EXCEPTION
        WHEN OTHER THEN NULL;
    END;
    BEGIN
        CALL core.create_agent();
    EXCEPTION
        WHEN OTHER THEN NULL;
    END;
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

CREATE OR REPLACE PROCEDURE core.resume_services()
RETURNS STRING
LANGUAGE SQL
AS
$$
DECLARE
    pool_name STRING;
    pool_status STRING DEFAULT 'UNKNOWN';
    ui_status STRING DEFAULT 'NOT_FOUND';
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
        SHOW SERVICES LIKE 'FLEET_INTELLIGENCE_SERVICE' IN SCHEMA core;
        SELECT "status" INTO :ui_status FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) LIMIT 1;
    EXCEPTION WHEN OTHER THEN ui_status := 'NOT_FOUND'; END;

    IF (ui_status = 'SUSPENDED') THEN
        ALTER SERVICE core.fleet_intelligence_service RESUME;
        resumed_items := ARRAY_APPEND(resumed_items, 'service:fleet_intelligence_service');
    END IF;

    BEGIN
        LET routing_pool STRING := pool_name || '_routing';
        LET rp_status STRING := 'NOT_FOUND';
        SHOW COMPUTE POOLS LIKE :routing_pool;
        SELECT "state" INTO :rp_status FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) LIMIT 1;
        IF (rp_status IN ('SUSPENDED', 'STOPPING')) THEN
            ALTER COMPUTE POOL IDENTIFIER(:routing_pool) RESUME;
            resumed_items := ARRAY_APPEND(resumed_items, 'compute_pool:' || routing_pool);
        END IF;
    EXCEPTION WHEN OTHER THEN NULL; END;

    BEGIN
        LET ors_status STRING := 'NOT_FOUND';
        SHOW SERVICES LIKE 'ORS_SERVICE' IN SCHEMA routing;
        SELECT "status" INTO :ors_status FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) LIMIT 1;
        IF (ors_status = 'SUSPENDED') THEN
            ALTER SERVICE routing.ors_service RESUME;
            resumed_items := ARRAY_APPEND(resumed_items, 'service:ors_service');
        END IF;
    EXCEPTION WHEN OTHER THEN NULL; END;

    BEGIN
        LET gw_status STRING := 'NOT_FOUND';
        SHOW SERVICES LIKE 'ROUTING_GATEWAY_SERVICE' IN SCHEMA routing;
        SELECT "status" INTO :gw_status FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) LIMIT 1;
        IF (gw_status = 'SUSPENDED') THEN
            ALTER SERVICE routing.routing_gateway_service RESUME;
            resumed_items := ARRAY_APPEND(resumed_items, 'service:routing_gateway_service');
        END IF;
    EXCEPTION WHEN OTHER THEN NULL; END;

    BEGIN
        LET vroom_status STRING := 'NOT_FOUND';
        SHOW SERVICES LIKE 'VROOM_SERVICE' IN SCHEMA routing;
        SELECT "status" INTO :vroom_status FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) LIMIT 1;
        IF (vroom_status = 'SUSPENDED') THEN
            ALTER SERVICE routing.vroom_service RESUME;
            resumed_items := ARRAY_APPEND(resumed_items, 'service:vroom_service');
        END IF;
    EXCEPTION WHEN OTHER THEN NULL; END;

    IF (ARRAY_SIZE(resumed_items) = 0) THEN
        RETURN 'All services already running';
    END IF;
    RETURN 'Resumed ' || ARRAY_SIZE(resumed_items) || ' items: ' || ARRAY_TO_STRING(resumed_items, ', ');
END;
$$;
GRANT USAGE ON PROCEDURE core.resume_services() TO APPLICATION ROLE app_user;

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
        SELECT 1 INTO :ors_db FROM FLEET_INTELLIGENCE_SETUP.INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = 'PUBLIC' LIMIT 1;
        ors_db := TRUE;
    EXCEPTION WHEN OTHER THEN ors_db := FALSE; END;

    BEGIN
        SHOW IMAGE REPOSITORIES LIKE 'FLEET_INTEL_REPO' IN SCHEMA FLEET_INTELLIGENCE_SETUP.PUBLIC;
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
--    GRANT USAGE ON DATABASE FLEET_INTELLIGENCE_SETUP TO APPLICATION FLEET_INTELLIGENCE_APP;
--    GRANT USAGE ON SCHEMA FLEET_INTELLIGENCE_SETUP.PUBLIC TO APPLICATION FLEET_INTELLIGENCE_APP;
--    GRANT READ ON IMAGE REPOSITORY FLEET_INTELLIGENCE_SETUP.PUBLIC.FLEET_INTEL_REPO TO APPLICATION FLEET_INTELLIGENCE_APP;
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
