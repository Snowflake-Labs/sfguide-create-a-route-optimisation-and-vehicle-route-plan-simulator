CREATE APPLICATION ROLE IF NOT EXISTS app_user;
CREATE SCHEMA IF NOT EXISTS core
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"core"}}';
GRANT USAGE ON SCHEMA core TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.version_init()
RETURNS STRING
LANGUAGE SQL
AS
$$
BEGIN
   -- ensure latest specifications are applied
   ALTER SERVICE IF EXISTS core.downloader
      FROM SPECIFICATION_FILE='services/downloader/downloader_spec.yaml';

   ALTER SERVICE IF EXISTS core.ors_service
      FROM SPECIFICATION_FILE='services/openrouteservice/openrouteservice.yaml';

   ALTER SERVICE IF EXISTS core.vroom_service
      FROM SPECIFICATION_FILE='services/vroom/vroom-service.yaml';

   ALTER SERVICE IF EXISTS core.routing_gateway_service
      FROM SPECIFICATION_FILE='services/gateway/routing-gateway-service.yaml';

   ALTER SERVICE IF EXISTS core.ors_control_app
      FROM SPECIFICATION_FILE='services/ors_control_app/ors_control_app_service.yaml';

   RETURN 'DONE';
END;
$$;

GRANT USAGE ON PROCEDURE core.version_init() TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.create_compute_pool()
RETURNS string
LANGUAGE sql
AS
$$
BEGIN
   LET pool_name := (SELECT CURRENT_DATABASE()) || '_compute_pool';

   CREATE COMPUTE POOL IF NOT EXISTS IDENTIFIER(:pool_name)
      INSTANCE_FAMILY = HIGHMEM_X64_S
      MIN_NODES = 1
      MAX_NODES = 10
      AUTO_RESUME = true
      AUTO_SUSPEND_SECS = 600;

   ALTER COMPUTE POOL IDENTIFIER(:pool_name) SET MIN_NODES = 10 MAX_NODES = 10;

   RETURN 'Compute Pool Created Successfully';

END;
$$;
GRANT USAGE ON PROCEDURE core.create_compute_pool() TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.create_stages()
RETURNS string
LANGUAGE sql
AS
$$
BEGIN
   CREATE OR ALTER STAGE core.ORS_SPCS_STAGE ENCRYPTION = ( TYPE = 'SNOWFLAKE_SSE' ) DIRECTORY = ( ENABLE = TRUE );
   CREATE OR ALTER STAGE core.ORS_GRAPHS_SPCS_STAGE ENCRYPTION = ( TYPE = 'SNOWFLAKE_SSE' ) DIRECTORY = ( ENABLE = TRUE );
   CREATE OR ALTER STAGE core.ORS_elevation_cache_SPCS_STAGE ENCRYPTION = ( TYPE = 'SNOWFLAKE_SSE' ) DIRECTORY = ( ENABLE = TRUE );
   GRANT READ ON STAGE core.ORS_SPCS_STAGE TO APPLICATION ROLE app_user;
   GRANT READ ON STAGE core.ORS_GRAPHS_SPCS_STAGE TO APPLICATION ROLE app_user;
   GRANT READ ON STAGE core.ORS_elevation_cache_SPCS_STAGE TO APPLICATION ROLE app_user;

   GRANT WRITE ON STAGE core.ORS_SPCS_STAGE TO APPLICATION ROLE app_user;
   GRANT WRITE ON STAGE core.ORS_GRAPHS_SPCS_STAGE TO APPLICATION ROLE app_user;
   GRANT WRITE ON STAGE core.ORS_elevation_cache_SPCS_STAGE TO APPLICATION ROLE app_user;

   RETURN 'Stages Created Successfully';
END;
$$;
GRANT USAGE ON PROCEDURE core.create_stages() TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.start_downloader()
RETURNS string
LANGUAGE sql
AS
$$
BEGIN
   LET pool_name := (SELECT CURRENT_DATABASE()) || '_compute_pool';
   
   ALTER SERVICE IF EXISTS core.downloader
      FROM SPECIFICATION_FILE='services/downloader/downloader_spec.yaml';

   CREATE SERVICE IF NOT EXISTS core.downloader
      IN COMPUTE POOL identifier(:pool_name)
      FROM spec='services/downloader/downloader_spec.yaml'
      AUTO_SUSPEND_SECS = 14400
      EXTERNAL_ACCESS_INTEGRATIONS = (reference('external_access_integration_ref'));

   GRANT OPERATE ON SERVICE core.downloader TO APPLICATION ROLE app_user;
   GRANT MONITOR ON SERVICE core.downloader TO APPLICATION ROLE app_user;

   CREATE OR REPLACE FUNCTION core.download (folder VARCHAR, filename VARCHAR, URL VARCHAR)
      RETURNS varchar
      SERVICE=core.downloader
      ENDPOINT='downloader'
      MAX_BATCH_ROWS = 1000
      AS '/download_to_stage';

   GRANT USAGE ON FUNCTION core.download (varchar, varchar, varchar) TO APPLICATION ROLE app_user;

   SELECT CORE.DOWNLOAD(STAGE, RELATIVE_PATH, DOWNLOAD_URL) FROM SHARED_SCHEMA.OSM_DATA;

   RETURN 'Service successfully started';
END;
$$;
GRANT USAGE ON PROCEDURE core.start_downloader() TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.create_services()
RETURNS string
LANGUAGE sql
AS
$$
BEGIN
   -- account-level compute pool object prefixed with app name to prevent clashes
   LET pool_name := (SELECT CURRENT_DATABASE()) || '_compute_pool';

   ALTER SERVICE IF EXISTS core.ors_service SET MIN_INSTANCES = 10 MAX_INSTANCES = 10;

   ALTER SERVICE IF EXISTS core.ors_service
      FROM SPECIFICATION_FILE='services/openrouteservice/openrouteservice.yaml';

   ALTER SERVICE IF EXISTS core.vroom_service
      FROM SPECIFICATION_FILE='services/vroom/vroom-service.yaml';

   ALTER SERVICE IF EXISTS core.routing_gateway_service
      FROM SPECIFICATION_FILE='services/gateway/routing-gateway-service.yaml';

   CREATE SERVICE IF NOT EXISTS core.ors_service
      IN COMPUTE POOL identifier(:pool_name)
      FROM spec='services/openrouteservice/openrouteservice.yaml'
      MIN_INSTANCES = 10
      MAX_INSTANCES = 10
      AUTO_SUSPEND_SECS = 14400;

   CREATE SERVICE IF NOT EXISTS core.vroom_service
      IN COMPUTE POOL identifier(:pool_name)
      FROM spec='services/vroom/vroom-service.yaml'
      MIN_INSTANCES = 1
      MAX_INSTANCES = 1
      AUTO_SUSPEND_SECS = 14400;

   CREATE SERVICE IF NOT EXISTS core.routing_gateway_service
      IN COMPUTE POOL identifier(:pool_name)
      FROM spec='services/gateway/routing-gateway-service.yaml'
      MIN_INSTANCES = 10
      MAX_INSTANCES = 10
      AUTO_SUSPEND_SECS = 14400;

   ALTER SERVICE IF EXISTS core.routing_gateway_service SET MIN_INSTANCES = 10 MAX_INSTANCES = 10;

   GRANT OPERATE ON SERVICE core.ors_service TO APPLICATION ROLE app_user;
   GRANT MONITOR ON SERVICE core.ors_service TO APPLICATION ROLE app_user;
   GRANT OPERATE ON SERVICE core.vroom_service TO APPLICATION ROLE app_user;
   GRANT MONITOR ON SERVICE core.vroom_service TO APPLICATION ROLE app_user;
   GRANT OPERATE ON SERVICE core.routing_gateway_service TO APPLICATION ROLE app_user;
   GRANT MONITOR ON SERVICE core.routing_gateway_service TO APPLICATION ROLE app_user;

   RETURN 'Service successfully created';
END;
$$;

GRANT USAGE ON PROCEDURE core.create_services() TO APPLICATION ROLE app_user;

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
      WHEN 'EXTERNAL_ACCESS_INTEGRATION_REF' THEN
          RETURN OBJECT_CONSTRUCT(
              'type', 'CONFIGURATION',
              'payload', OBJECT_CONSTRUCT(
                  'host_ports', ARRAY_CONSTRUCT('0.0.0.0:443','0.0.0.0:80','snowflakecomputing.com'),
                  'allowed_secrets', 'NONE'
                  )
          )::STRING;
      ELSE
          RETURN '';
  END CASE;
END;	
$$;

GRANT USAGE ON PROCEDURE core.get_config_for_ref(STRING) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.create_functions()
RETURNS string
LANGUAGE sql
AS
$$
BEGIN
   CREATE OR REPLACE FUNCTION core.DIRECTIONS (method varchar, jstart array, jend array)
      RETURNS VARIANT
      SERVICE=core.routing_gateway_service
      ENDPOINT='gateway'
      MAX_BATCH_ROWS = 1000
      AS '/directions_tabular';
   GRANT USAGE ON FUNCTION core.DIRECTIONS (varchar, array, array) TO APPLICATION ROLE app_user; 

   CREATE OR REPLACE FUNCTION core.DIRECTIONS(method varchar, locations VARIANT)
      RETURNS VARIANT
      SERVICE=core.routing_gateway_service
      ENDPOINT='gateway'
      MAX_BATCH_ROWS = 1000
      AS '/directions';
   
   GRANT USAGE ON FUNCTION core.DIRECTIONS (varchar, variant) TO APPLICATION ROLE app_user; 

   CREATE OR REPLACE FUNCTION core.ISOCHRONES (method text, lon float, lat float, range int)
      RETURNS VARIANT
      SERVICE=core.routing_gateway_service
      ENDPOINT='gateway'
      MAX_BATCH_ROWS = 1000
      AS '/isochrones_tabular';
   GRANT USAGE ON FUNCTION core.ISOCHRONES (text, float, float, int) TO APPLICATION ROLE app_user; 

   CREATE OR REPLACE FUNCTION core.optimization (jobs ARRAY, vehicles ARRAY, matrices ARRAY DEFAULT [])
      RETURNS VARIANT
      SERVICE=core.routing_gateway_service
      ENDPOINT='gateway'
      MAX_BATCH_ROWS = 1000
      AS '/optimization_tabular';
   GRANT USAGE ON FUNCTION core.optimization (ARRAY, ARRAY, ARRAY) TO APPLICATION ROLE app_user; 

   CREATE OR REPLACE FUNCTION core.optimization (challenge VARIANT)
      RETURNS VARIANT
      SERVICE=core.routing_gateway_service
      ENDPOINT='gateway'
      MAX_BATCH_ROWS = 1000
      AS '/optimization';
   GRANT USAGE ON FUNCTION core.optimization (VARIANT) TO APPLICATION ROLE app_user; 

   CREATE OR REPLACE FUNCTION core.ORS_STATUS()
      RETURNS VARIANT
      SERVICE=core.routing_gateway_service
      ENDPOINT='gateway'
      MAX_BATCH_ROWS = 1
      AS '/ors_status';
   GRANT USAGE ON FUNCTION core.ORS_STATUS() TO APPLICATION ROLE app_user;

   -- Matrix API: Calculate time/distance matrices between multiple locations
   CREATE OR REPLACE FUNCTION core.MATRIX(method varchar, locations ARRAY)
      RETURNS VARIANT
      SERVICE=core.routing_gateway_service
      ENDPOINT='gateway'
      MAX_BATCH_ROWS = 1000
      AS '/matrix_tabular';
   GRANT USAGE ON FUNCTION core.MATRIX(varchar, array) TO APPLICATION ROLE app_user;

   CREATE OR REPLACE FUNCTION core.MATRIX(method varchar, options VARIANT)
      RETURNS VARIANT
      SERVICE=core.routing_gateway_service
      ENDPOINT='gateway'
      MAX_BATCH_ROWS = 100
      AS '/matrix';
   GRANT USAGE ON FUNCTION core.MATRIX(varchar, variant) TO APPLICATION ROLE app_user;

   CREATE OR REPLACE FUNCTION core.MATRIX_TABULAR(method varchar, origin ARRAY, destinations ARRAY)
      RETURNS VARIANT
      SERVICE=core.routing_gateway_service
      ENDPOINT='gateway'
      MAX_BATCH_ROWS = 1000
      AS '/matrix_tabular';
   GRANT USAGE ON FUNCTION core.MATRIX_TABULAR(varchar, array, array) TO APPLICATION ROLE app_user;

   -- GeoJSON wrapper functions: return parsed geometry as separate columns
   -- DIRECTIONS_GEO (tabular overload)
   CREATE OR REPLACE FUNCTION core.DIRECTIONS_GEO(method VARCHAR, jstart ARRAY, jend ARRAY)
      RETURNS TABLE (RESPONSE VARIANT, GEOJSON GEOGRAPHY, DISTANCE FLOAT, DURATION FLOAT)
      LANGUAGE SQL
      AS
      'SELECT resp AS RESPONSE,
            TO_GEOGRAPHY(resp:features[0]:geometry) AS GEOJSON,
            resp:features[0]:properties:summary:distance::FLOAT AS DISTANCE,
            resp:features[0]:properties:summary:duration::FLOAT AS DURATION
         FROM (SELECT core.DIRECTIONS(method, jstart, jend) AS resp)';
   GRANT USAGE ON FUNCTION core.DIRECTIONS_GEO(VARCHAR, ARRAY, ARRAY) TO APPLICATION ROLE app_user;

   -- DIRECTIONS_GEO (raw overload with locations variant)
   CREATE OR REPLACE FUNCTION core.DIRECTIONS_GEO(method VARCHAR, locations VARIANT)
      RETURNS TABLE (RESPONSE VARIANT, GEOJSON GEOGRAPHY, DISTANCE FLOAT, DURATION FLOAT)
      LANGUAGE SQL
      AS
      'SELECT resp AS RESPONSE,
            TO_GEOGRAPHY(resp:features[0]:geometry) AS GEOJSON,
            resp:features[0]:properties:summary:distance::FLOAT AS DISTANCE,
            resp:features[0]:properties:summary:duration::FLOAT AS DURATION
         FROM (SELECT core.DIRECTIONS(method, locations) AS resp)';
   GRANT USAGE ON FUNCTION core.DIRECTIONS_GEO(VARCHAR, VARIANT) TO APPLICATION ROLE app_user;

   -- ISOCHRONES_GEO
   CREATE OR REPLACE FUNCTION core.ISOCHRONES_GEO(method TEXT, lon FLOAT, lat FLOAT, range INT)
      RETURNS TABLE (RESPONSE VARIANT, GEOJSON GEOGRAPHY)
      LANGUAGE SQL
      AS
      'SELECT resp AS RESPONSE,
            TO_GEOGRAPHY(resp:features[0]:geometry) AS GEOJSON
         FROM (SELECT core.ISOCHRONES(method, lon, lat, range) AS resp)';
   GRANT USAGE ON FUNCTION core.ISOCHRONES_GEO(TEXT, FLOAT, FLOAT, INT) TO APPLICATION ROLE app_user;

   -- OPTIMIZATION_GEO (tabular overload)
   CREATE OR REPLACE FUNCTION core.OPTIMIZATION_GEO(jobs ARRAY, vehicles ARRAY, matrices ARRAY DEFAULT [])
      RETURNS TABLE (RESPONSE VARIANT, GEOJSON GEOGRAPHY, VEHICLE INT, DURATION INT, STEPS VARIANT)
      LANGUAGE SQL
      AS
      'SELECT resp AS RESPONSE,
            TO_GEOGRAPHY(OBJECT_CONSTRUCT(''type'', ''LineString'', ''coordinates'', f.value:geometry)) AS GEOJSON,
            f.value:vehicle::INT AS VEHICLE,
            f.value:duration::INT AS DURATION,
            f.value:steps::VARIANT AS STEPS
         FROM (SELECT core.OPTIMIZATION(jobs, vehicles, matrices) AS resp),
            LATERAL FLATTEN(input => resp:routes) f';
   GRANT USAGE ON FUNCTION core.OPTIMIZATION_GEO(ARRAY, ARRAY, ARRAY) TO APPLICATION ROLE app_user;

   -- OPTIMIZATION_GEO (raw overload)
   CREATE OR REPLACE FUNCTION core.OPTIMIZATION_GEO(challenge VARIANT)
      RETURNS TABLE (RESPONSE VARIANT, GEOJSON GEOGRAPHY, VEHICLE INT, DURATION INT, STEPS VARIANT)
      LANGUAGE SQL
      AS
      'SELECT resp AS RESPONSE,
            TO_GEOGRAPHY(OBJECT_CONSTRUCT(''type'', ''LineString'', ''coordinates'', f.value:geometry)) AS GEOJSON,
            f.value:vehicle::INT AS VEHICLE,
            f.value:duration::INT AS DURATION,
            f.value:steps::VARIANT AS STEPS
         FROM (SELECT core.OPTIMIZATION(challenge) AS resp),
            LATERAL FLATTEN(input => resp:routes) f';
   GRANT USAGE ON FUNCTION core.OPTIMIZATION_GEO(VARIANT) TO APPLICATION ROLE app_user;

   -- Create MAP_CONFIG table to store map metadata for the function tester
   CREATE TABLE IF NOT EXISTS core.MAP_CONFIG (
      city_name VARCHAR,
      center_lat FLOAT,
      center_lon FLOAT,
      min_lat FLOAT,
      max_lat FLOAT,
      min_lon FLOAT,
      max_lon FLOAT,
      osm_file_name VARCHAR,
      sample_addresses VARIANT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP(),
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP()
   )
   COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"routing"}}';
   GRANT SELECT ON TABLE core.MAP_CONFIG TO APPLICATION ROLE app_user;
   GRANT INSERT ON TABLE core.MAP_CONFIG TO APPLICATION ROLE app_user;
   GRANT UPDATE ON TABLE core.MAP_CONFIG TO APPLICATION ROLE app_user;
   GRANT DELETE ON TABLE core.MAP_CONFIG TO APPLICATION ROLE app_user;

   RETURN 'Functions successfully created';
END;
$$;

GRANT USAGE ON PROCEDURE core.create_functions() TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.grant_callback(privileges array)
RETURNS string
LANGUAGE sql
AS
$$
BEGIN
   IF (ARRAY_CONTAINS('CREATE COMPUTE POOL'::VARIANT, privileges)) THEN
      CALL CORE.create_compute_pool();
      CALL CORE.create_stages();
      CALL CORE.start_downloader();
      CALL CORE.create_services();
      CALL CORE.create_functions();
      CALL CORE.create_control_app();
      -- Wait untill all graphs are created in the consumer stage (~approx 40 seconds) before completing the procedure
      SELECT SYSTEM$WAIT(40);
   END IF;
   RETURN 'App successfully deployed';
END;
$$;

GRANT USAGE ON PROCEDURE core.grant_callback(array) TO APPLICATION ROLE app_user;

-- =============================================================================
-- MULTI-CITY: Per-region ORS instances with city-prefixed functions
-- =============================================================================

CREATE TABLE IF NOT EXISTS core.CITY_ORS_MAP (
    REGION VARCHAR,
    DISPLAY_NAME VARCHAR,
    PBF_URL VARCHAR,
    MIN_LAT FLOAT,
    MAX_LAT FLOAT,
    MIN_LON FLOAT,
    MAX_LON FLOAT,
    STATUS VARCHAR DEFAULT 'NOT_DEPLOYED',
    CREATED_AT TIMESTAMP DEFAULT CURRENT_TIMESTAMP(),
    UPDATED_AT TIMESTAMP DEFAULT CURRENT_TIMESTAMP()
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"multi-city"}}';
GRANT SELECT ON TABLE core.CITY_ORS_MAP TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE core.CITY_ORS_MAP TO APPLICATION ROLE app_user;
GRANT UPDATE ON TABLE core.CITY_ORS_MAP TO APPLICATION ROLE app_user;
GRANT DELETE ON TABLE core.CITY_ORS_MAP TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.create_city_ors_service(P_REGION VARCHAR)
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
    pool_name := db_name || '_compute_pool';
    svc_name := 'ORS_SERVICE_' || UPPER(:P_REGION);

    CREATE COMPUTE POOL IF NOT EXISTS IDENTIFIER(:pool_name)
        INSTANCE_FAMILY = HIGHMEM_X64_S
        MIN_NODES = 1
        MAX_NODES = 10
        AUTO_RESUME = TRUE
        AUTO_SUSPEND_SECS = 14400;

    ors_spec := '{"spec":{"containers":[{"name":"ors","image":"/openrouteservice_setup/public/image_repository/openrouteservice:v9.0.0","volumeMounts":[{"name":"files","mountPath":"/home/ors/files"},{"name":"graphs","mountPath":"/home/ors/graphs"},{"name":"elevation-cache","mountPath":"/home/ors/elevation_cache"}],"env":{"REBUILD_GRAPHS":"true","ORS_CONFIG_LOCATION":"/home/ors/files/ors-config.yml","XMS":"3G","XMX":"200G"}}],"endpoints":[{"name":"ors","port":8082,"public":false}],"volumes":[{"name":"files","source":"@CORE.ORS_SPCS_STAGE/' || :P_REGION || '"},{"name":"graphs","source":"@CORE.ORS_GRAPHS_SPCS_STAGE/' || :P_REGION || '"},{"name":"elevation-cache","source":"@CORE.ORS_elevation_cache_SPCS_STAGE/' || :P_REGION || '"}]}}';

    EXECUTE IMMEDIATE 'DROP SERVICE IF EXISTS core.' || svc_name;
    create_sql := 'CREATE SERVICE core.' || svc_name || ' IN COMPUTE POOL ' || pool_name || ' FROM SPECIFICATION ''' || ors_spec || ''' MIN_INSTANCES = 1 MAX_INSTANCES = 1 AUTO_SUSPEND_SECS = 3600';
    EXECUTE IMMEDIATE :create_sql;

    EXECUTE IMMEDIATE 'GRANT OPERATE ON SERVICE core.' || svc_name || ' TO APPLICATION ROLE app_user';
    EXECUTE IMMEDIATE 'GRANT MONITOR ON SERVICE core.' || svc_name || ' TO APPLICATION ROLE app_user';

    UPDATE core.CITY_ORS_MAP SET STATUS = 'DEPLOYED', UPDATED_AT = CURRENT_TIMESTAMP() WHERE REGION = :P_REGION;

    RETURN 'City ORS service created for region ' || :P_REGION || ': ' || svc_name;
END;
$$;
GRANT USAGE ON PROCEDURE core.create_city_ors_service(VARCHAR) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.create_city_functions(P_REGION VARCHAR)
RETURNS STRING
LANGUAGE SQL
AS
$$
BEGIN
    LET fn_dir VARCHAR := 'DIRECTIONS_' || UPPER(:P_REGION);
    LET city_path VARCHAR := '/city/' || :P_REGION;

    EXECUTE IMMEDIATE '
    CREATE OR REPLACE FUNCTION core.' || fn_dir || '(method VARCHAR, jstart ARRAY, jend ARRAY)
        RETURNS VARIANT
        SERVICE=core.routing_gateway_service
        ENDPOINT=''gateway''
        MAX_BATCH_ROWS = 1000
        AS ''' || city_path || '/directions_tabular''';
    EXECUTE IMMEDIATE 'GRANT USAGE ON FUNCTION core.' || fn_dir || '(VARCHAR, ARRAY, ARRAY) TO APPLICATION ROLE app_user';

    EXECUTE IMMEDIATE '
    CREATE OR REPLACE FUNCTION core.' || fn_dir || '(method VARCHAR, locations VARIANT)
        RETURNS VARIANT
        SERVICE=core.routing_gateway_service
        ENDPOINT=''gateway''
        MAX_BATCH_ROWS = 1000
        AS ''' || city_path || '/directions''';
    EXECUTE IMMEDIATE 'GRANT USAGE ON FUNCTION core.' || fn_dir || '(VARCHAR, VARIANT) TO APPLICATION ROLE app_user';

    EXECUTE IMMEDIATE '
    CREATE OR REPLACE FUNCTION core.ISOCHRONES_' || UPPER(:P_REGION) || '(method TEXT, lon FLOAT, lat FLOAT, range INT)
        RETURNS VARIANT
        SERVICE=core.routing_gateway_service
        ENDPOINT=''gateway''
        MAX_BATCH_ROWS = 1000
        AS ''' || city_path || '/isochrones_tabular''';
    EXECUTE IMMEDIATE 'GRANT USAGE ON FUNCTION core.ISOCHRONES_' || UPPER(:P_REGION) || '(TEXT, FLOAT, FLOAT, INT) TO APPLICATION ROLE app_user';

    EXECUTE IMMEDIATE '
    CREATE OR REPLACE FUNCTION core.MATRIX_' || UPPER(:P_REGION) || '(method VARCHAR, origin ARRAY, destinations ARRAY)
        RETURNS VARIANT
        SERVICE=core.routing_gateway_service
        ENDPOINT=''gateway''
        MAX_BATCH_ROWS = 1000
        AS ''' || city_path || '/matrix_tabular''';
    EXECUTE IMMEDIATE 'GRANT USAGE ON FUNCTION core.MATRIX_' || UPPER(:P_REGION) || '(VARCHAR, ARRAY, ARRAY) TO APPLICATION ROLE app_user';

    EXECUTE IMMEDIATE '
    CREATE OR REPLACE FUNCTION core.OPTIMIZATION_' || UPPER(:P_REGION) || '(jobs ARRAY, vehicles ARRAY, matrices ARRAY DEFAULT [])
        RETURNS VARIANT
        SERVICE=core.routing_gateway_service
        ENDPOINT=''gateway''
        MAX_BATCH_ROWS = 1000
        AS ''' || city_path || '/optimization_tabular''';
    EXECUTE IMMEDIATE 'GRANT USAGE ON FUNCTION core.OPTIMIZATION_' || UPPER(:P_REGION) || '(ARRAY, ARRAY, ARRAY) TO APPLICATION ROLE app_user';

    RETURN 'City routing functions created for region ' || :P_REGION;
END;
$$;
GRANT USAGE ON PROCEDURE core.create_city_functions(VARCHAR) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.setup_city_ors(P_REGION VARCHAR)
RETURNS STRING
LANGUAGE SQL
AS
$$
BEGIN
    CALL core.create_compute_pool();
    CALL core.create_stages();
    CALL core.create_city_ors_service(:P_REGION);
    CALL core.create_services();
    SELECT SYSTEM$WAIT(30);
    CALL core.create_city_functions(:P_REGION);
    RETURN 'City ORS deployed for region: ' || :P_REGION;
END;
$$;
GRANT USAGE ON PROCEDURE core.setup_city_ors(VARCHAR) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.resume_city_ors(P_REGION VARCHAR)
RETURNS STRING
LANGUAGE SQL
AS
$$
BEGIN
    LET svc_name VARCHAR := 'ORS_SERVICE_' || UPPER(:P_REGION);
    EXECUTE IMMEDIATE 'ALTER SERVICE core.' || svc_name || ' RESUME';
    BEGIN
        ALTER SERVICE IF EXISTS core.routing_gateway_service RESUME;
    EXCEPTION WHEN OTHER THEN NULL;
    END;
    RETURN 'Resumed ORS services for ' || :P_REGION;
END;
$$;
GRANT USAGE ON PROCEDURE core.resume_city_ors(VARCHAR) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.drop_city_ors(P_REGION VARCHAR)
RETURNS STRING
LANGUAGE SQL
AS
$$
BEGIN
    LET svc_name VARCHAR := 'ORS_SERVICE_' || UPPER(:P_REGION);
    LET fn_dir VARCHAR := 'DIRECTIONS_' || UPPER(:P_REGION);
    LET fn_matrix VARCHAR := 'MATRIX_' || UPPER(:P_REGION);

    EXECUTE IMMEDIATE 'DROP SERVICE IF EXISTS core.' || svc_name;
    EXECUTE IMMEDIATE 'DROP FUNCTION IF EXISTS core.' || fn_dir || '(VARCHAR, ARRAY, ARRAY)';
    EXECUTE IMMEDIATE 'DROP FUNCTION IF EXISTS core.' || fn_dir || '(VARCHAR, VARIANT)';
    EXECUTE IMMEDIATE 'DROP FUNCTION IF EXISTS core.ISOCHRONES_' || UPPER(:P_REGION) || '(TEXT, FLOAT, FLOAT, INT)';
    EXECUTE IMMEDIATE 'DROP FUNCTION IF EXISTS core.' || fn_matrix || '(VARCHAR, ARRAY, ARRAY)';
    EXECUTE IMMEDIATE 'DROP FUNCTION IF EXISTS core.OPTIMIZATION_' || UPPER(:P_REGION) || '(ARRAY, ARRAY, ARRAY)';

    DELETE FROM core.CITY_ORS_MAP WHERE REGION = :P_REGION;

    RETURN 'Dropped city ORS for ' || :P_REGION;
END;
$$;
GRANT USAGE ON PROCEDURE core.drop_city_ors(VARCHAR) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.list_cities()
RETURNS STRING
LANGUAGE SQL
AS
$$
DECLARE
    result VARCHAR;
BEGIN
    SELECT ARRAY_AGG(OBJECT_CONSTRUCT(
        'region', REGION,
        'display_name', DISPLAY_NAME,
        'status', STATUS,
        'bbox', OBJECT_CONSTRUCT('min_lat', MIN_LAT, 'max_lat', MAX_LAT, 'min_lon', MIN_LON, 'max_lon', MAX_LON)
    ))::VARCHAR INTO result
    FROM core.CITY_ORS_MAP;
    RETURN COALESCE(result, '[]');
END;
$$;
GRANT USAGE ON PROCEDURE core.list_cities() TO APPLICATION ROLE app_user;

-- =============================================================================
-- SERVICE LIFECYCLE: resume, suspend, scale, status, health check
-- =============================================================================

CREATE OR REPLACE PROCEDURE core.RESUME_ALL_SERVICES()
RETURNS STRING
LANGUAGE SQL
AS
$$
DECLARE
    resumed_count INTEGER DEFAULT 0;
    already_running INTEGER DEFAULT 0;
BEGIN
    SHOW SERVICES IN SCHEMA core;

    LET rs RESULTSET := (
        SELECT "name" AS svc_name, "status" AS svc_status
        FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
        WHERE "is_job" = 'false'
    );
    LET cur CURSOR FOR rs;

    FOR rec IN cur DO
        IF (rec.svc_status = 'SUSPENDED') THEN
            BEGIN
                EXECUTE IMMEDIATE 'ALTER SERVICE core.' || rec.svc_name || ' RESUME';
                resumed_count := resumed_count + 1;
            EXCEPTION
                WHEN OTHER THEN NULL;
            END;
        ELSEIF (rec.svc_status IN ('RUNNING', 'READY')) THEN
            already_running := already_running + 1;
        END IF;
    END FOR;

    LET pool_name VARCHAR := (SELECT CURRENT_DATABASE()) || '_compute_pool';
    BEGIN
        LET pool_status VARCHAR := 'UNKNOWN';
        SHOW COMPUTE POOLS LIKE :pool_name;
        SELECT "state" INTO :pool_status FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) LIMIT 1;
        IF (pool_status IN ('SUSPENDED', 'STOPPING')) THEN
            ALTER COMPUTE POOL IDENTIFIER(:pool_name) RESUME;
            resumed_count := resumed_count + 1;
        END IF;
    EXCEPTION WHEN OTHER THEN NULL;
    END;

    RETURN OBJECT_CONSTRUCT(
        'resumed', resumed_count,
        'already_running', already_running
    )::STRING;
END;
$$;
GRANT USAGE ON PROCEDURE core.RESUME_ALL_SERVICES() TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.resume_services()
RETURNS STRING
LANGUAGE SQL
AS
$$
BEGIN
    LET result VARCHAR;
    CALL core.RESUME_ALL_SERVICES() INTO :result;
    RETURN result;
END;
$$;
GRANT USAGE ON PROCEDURE core.resume_services() TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.SUSPEND_ALL_SERVICES()
RETURNS STRING
LANGUAGE SQL
AS
$$
DECLARE
    suspended_count INTEGER DEFAULT 0;
BEGIN
    SHOW SERVICES IN SCHEMA core;

    LET rs RESULTSET := (
        SELECT "name" AS svc_name, "status" AS svc_status
        FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
        WHERE "is_job" = 'false'
    );
    LET cur CURSOR FOR rs;

    FOR rec IN cur DO
        IF (UPPER(rec.svc_name) = 'ORS_CONTROL_APP') THEN
            CONTINUE;
        END IF;
        IF (rec.svc_status IN ('RUNNING', 'READY')) THEN
            BEGIN
                EXECUTE IMMEDIATE 'ALTER SERVICE core.' || rec.svc_name || ' SUSPEND';
                suspended_count := suspended_count + 1;
            EXCEPTION
                WHEN OTHER THEN NULL;
            END;
        END IF;
    END FOR;

    RETURN 'Suspended ' || suspended_count || ' services';
END;
$$;
GRANT USAGE ON PROCEDURE core.SUSPEND_ALL_SERVICES() TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.SCALE_SERVICES(P_MIN_INSTANCES INTEGER, P_MAX_INSTANCES INTEGER)
RETURNS STRING
LANGUAGE SQL
AS
$$
BEGIN
    ALTER SERVICE IF EXISTS core.ors_service SET MIN_INSTANCES = :P_MIN_INSTANCES MAX_INSTANCES = :P_MAX_INSTANCES;
    ALTER SERVICE IF EXISTS core.routing_gateway_service SET MIN_INSTANCES = :P_MIN_INSTANCES MAX_INSTANCES = :P_MAX_INSTANCES;

    LET pool_name VARCHAR := (SELECT CURRENT_DATABASE()) || '_compute_pool';
    LET pool_nodes INTEGER := GREATEST(:P_MAX_INSTANCES + 2, 3);
    ALTER COMPUTE POOL IF EXISTS IDENTIFIER(:pool_name) SET MIN_NODES = :pool_nodes MAX_NODES = :pool_nodes;

    RETURN 'Scaled ORS + gateway to ' || :P_MIN_INSTANCES || '-' || :P_MAX_INSTANCES || ' instances, pool to ' || :pool_nodes || ' nodes';
END;
$$;
GRANT USAGE ON PROCEDURE core.SCALE_SERVICES(INTEGER, INTEGER) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.GET_STATUS()
RETURNS STRING
LANGUAGE SQL
AS
$$
DECLARE
    pool_status VARCHAR DEFAULT 'UNKNOWN';
    services VARIANT DEFAULT ARRAY_CONSTRUCT();
BEGIN
    LET pool_name VARCHAR := (SELECT CURRENT_DATABASE()) || '_compute_pool';
    BEGIN
        SHOW COMPUTE POOLS LIKE :pool_name;
        SELECT "state" INTO :pool_status FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) LIMIT 1;
    EXCEPTION WHEN OTHER THEN pool_status := 'NOT_FOUND'; END;

    SHOW SERVICES IN SCHEMA core;

    LET rs RESULTSET := (
        SELECT "name" AS svc_name, "status" AS svc_status
        FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
        WHERE "is_job" = 'false'
    );
    LET cur CURSOR FOR rs;

    FOR rec IN cur DO
        services := ARRAY_APPEND(services, OBJECT_CONSTRUCT('name', rec.svc_name, 'status', rec.svc_status));
    END FOR;

    RETURN OBJECT_CONSTRUCT(
        'compute_pool', pool_status,
        'services', services
    )::STRING;
END;
$$;
GRANT USAGE ON PROCEDURE core.GET_STATUS() TO APPLICATION ROLE app_user;

CREATE OR REPLACE FUNCTION core.CHECK_HEALTH()
RETURNS BOOLEAN
LANGUAGE SQL
AS
$$
    SELECT CASE
        WHEN core.ORS_STATUS() IS NOT NULL THEN TRUE
        ELSE FALSE
    END
$$;
GRANT USAGE ON FUNCTION core.CHECK_HEALTH() TO APPLICATION ROLE app_user;

-- =============================================================================
-- TRAVEL TIME MATRIX: Tables for H3 hexagon-based travel time computation
-- =============================================================================

CREATE TABLE IF NOT EXISTS core.TRAVEL_TIME_RES7 (
    ORIGIN_H3 VARCHAR, DEST_H3 VARCHAR,
    TRAVEL_TIME_SECONDS FLOAT, TRAVEL_DISTANCE_METERS FLOAT,
    CALCULATED_AT TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP(), REGION VARCHAR
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"matrix"}}';
GRANT SELECT ON TABLE core.TRAVEL_TIME_RES7 TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE core.TRAVEL_TIME_RES7 TO APPLICATION ROLE app_user;
GRANT DELETE ON TABLE core.TRAVEL_TIME_RES7 TO APPLICATION ROLE app_user;

CREATE TABLE IF NOT EXISTS core.TRAVEL_TIME_RES8 (
    ORIGIN_H3 VARCHAR, DEST_H3 VARCHAR,
    TRAVEL_TIME_SECONDS FLOAT, TRAVEL_DISTANCE_METERS FLOAT,
    CALCULATED_AT TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP(), REGION VARCHAR
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"matrix"}}';
GRANT SELECT ON TABLE core.TRAVEL_TIME_RES8 TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE core.TRAVEL_TIME_RES8 TO APPLICATION ROLE app_user;
GRANT DELETE ON TABLE core.TRAVEL_TIME_RES8 TO APPLICATION ROLE app_user;

CREATE TABLE IF NOT EXISTS core.TRAVEL_TIME_RES9 (
    ORIGIN_H3 VARCHAR, DEST_H3 VARCHAR,
    TRAVEL_TIME_SECONDS FLOAT, TRAVEL_DISTANCE_METERS FLOAT,
    CALCULATED_AT TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP(), REGION VARCHAR
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"matrix"}}';
GRANT SELECT ON TABLE core.TRAVEL_TIME_RES9 TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE core.TRAVEL_TIME_RES9 TO APPLICATION ROLE app_user;
GRANT DELETE ON TABLE core.TRAVEL_TIME_RES9 TO APPLICATION ROLE app_user;

CREATE TABLE IF NOT EXISTS core.H3_RES7 (H3_INDEX VARCHAR, CENTER_LAT FLOAT, CENTER_LON FLOAT)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"matrix"}}';
GRANT SELECT ON TABLE core.H3_RES7 TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE core.H3_RES7 TO APPLICATION ROLE app_user;
GRANT TRUNCATE ON TABLE core.H3_RES7 TO APPLICATION ROLE app_user;

CREATE TABLE IF NOT EXISTS core.H3_RES8 (H3_INDEX VARCHAR, CENTER_LAT FLOAT, CENTER_LON FLOAT)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"matrix"}}';
GRANT SELECT ON TABLE core.H3_RES8 TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE core.H3_RES8 TO APPLICATION ROLE app_user;
GRANT TRUNCATE ON TABLE core.H3_RES8 TO APPLICATION ROLE app_user;

CREATE TABLE IF NOT EXISTS core.H3_RES9 (H3_INDEX VARCHAR, CENTER_LAT FLOAT, CENTER_LON FLOAT)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"matrix"}}';
GRANT SELECT ON TABLE core.H3_RES9 TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE core.H3_RES9 TO APPLICATION ROLE app_user;
GRANT TRUNCATE ON TABLE core.H3_RES9 TO APPLICATION ROLE app_user;

CREATE TABLE IF NOT EXISTS core.WORK_QUEUE_RES7 (
    SEQ_ID INTEGER, ORIGIN_H3 VARCHAR, ORIGIN_LON FLOAT, ORIGIN_LAT FLOAT,
    DEST_COORDS ARRAY, DEST_HEX_IDS ARRAY
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"matrix"}}';
GRANT SELECT ON TABLE core.WORK_QUEUE_RES7 TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE core.WORK_QUEUE_RES7 TO APPLICATION ROLE app_user;
GRANT TRUNCATE ON TABLE core.WORK_QUEUE_RES7 TO APPLICATION ROLE app_user;

CREATE TABLE IF NOT EXISTS core.WORK_QUEUE_RES8 (
    SEQ_ID INTEGER, ORIGIN_H3 VARCHAR, ORIGIN_LON FLOAT, ORIGIN_LAT FLOAT,
    DEST_COORDS ARRAY, DEST_HEX_IDS ARRAY
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"matrix"}}';
GRANT SELECT ON TABLE core.WORK_QUEUE_RES8 TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE core.WORK_QUEUE_RES8 TO APPLICATION ROLE app_user;
GRANT TRUNCATE ON TABLE core.WORK_QUEUE_RES8 TO APPLICATION ROLE app_user;

CREATE TABLE IF NOT EXISTS core.WORK_QUEUE_RES9 (
    SEQ_ID INTEGER, ORIGIN_H3 VARCHAR, ORIGIN_LON FLOAT, ORIGIN_LAT FLOAT,
    DEST_COORDS ARRAY, DEST_HEX_IDS ARRAY
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"matrix"}}';
GRANT SELECT ON TABLE core.WORK_QUEUE_RES9 TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE core.WORK_QUEUE_RES9 TO APPLICATION ROLE app_user;
GRANT TRUNCATE ON TABLE core.WORK_QUEUE_RES9 TO APPLICATION ROLE app_user;

CREATE TABLE IF NOT EXISTS core.MATRIX_RAW_RES7 (
    SEQ_ID INTEGER, ORIGIN_H3 VARCHAR, DEST_HEX_IDS ARRAY, MATRIX_RESULT VARIANT, REGION VARCHAR
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"matrix"}}';
GRANT SELECT ON TABLE core.MATRIX_RAW_RES7 TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE core.MATRIX_RAW_RES7 TO APPLICATION ROLE app_user;
GRANT TRUNCATE ON TABLE core.MATRIX_RAW_RES7 TO APPLICATION ROLE app_user;

CREATE TABLE IF NOT EXISTS core.MATRIX_RAW_RES8 (
    SEQ_ID INTEGER, ORIGIN_H3 VARCHAR, DEST_HEX_IDS ARRAY, MATRIX_RESULT VARIANT, REGION VARCHAR
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"matrix"}}';
GRANT SELECT ON TABLE core.MATRIX_RAW_RES8 TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE core.MATRIX_RAW_RES8 TO APPLICATION ROLE app_user;
GRANT TRUNCATE ON TABLE core.MATRIX_RAW_RES8 TO APPLICATION ROLE app_user;

CREATE TABLE IF NOT EXISTS core.MATRIX_RAW_RES9 (
    SEQ_ID INTEGER, ORIGIN_H3 VARCHAR, DEST_HEX_IDS ARRAY, MATRIX_RESULT VARIANT, REGION VARCHAR
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"matrix"}}';
GRANT SELECT ON TABLE core.MATRIX_RAW_RES9 TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE core.MATRIX_RAW_RES9 TO APPLICATION ROLE app_user;
GRANT TRUNCATE ON TABLE core.MATRIX_RAW_RES9 TO APPLICATION ROLE app_user;

-- =============================================================================
-- TRAVEL TIME MATRIX: Pipeline procedures
-- =============================================================================

CREATE OR REPLACE PROCEDURE core.BUILD_HEXAGONS(P_RES VARCHAR, P_MIN_LAT FLOAT, P_MAX_LAT FLOAT, P_MIN_LON FLOAT, P_MAX_LON FLOAT)
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
    hex_table := 'core.H3_' || P_RES;

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
GRANT USAGE ON PROCEDURE core.BUILD_HEXAGONS(VARCHAR, FLOAT, FLOAT, FLOAT, FLOAT) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.BUILD_WORK_QUEUE(P_RES VARCHAR)
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
    hex_table := 'core.H3_' || P_RES;
    queue_table := 'core.WORK_QUEUE_' || P_RES;

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
GRANT USAGE ON PROCEDURE core.BUILD_WORK_QUEUE(VARCHAR) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.BUILD_TRAVEL_TIME_RANGE(P_RES VARCHAR, P_START_SEQ INTEGER, P_END_SEQ INTEGER)
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
    queue_table := 'core.WORK_QUEUE_' || P_RES;
    raw_table := 'core.MATRIX_RAW_' || P_RES;

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
            core.MATRIX_TABULAR(
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
GRANT USAGE ON PROCEDURE core.BUILD_TRAVEL_TIME_RANGE(VARCHAR, INTEGER, INTEGER) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.BUILD_TRAVEL_TIME_RANGE_REGION(P_RES VARCHAR, P_START_SEQ INTEGER, P_END_SEQ INTEGER, P_MATRIX_FN VARCHAR)
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
    queue_table := 'core.WORK_QUEUE_' || P_RES;
    raw_table := 'core.MATRIX_RAW_' || P_RES;

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
GRANT USAGE ON PROCEDURE core.BUILD_TRAVEL_TIME_RANGE_REGION(VARCHAR, INTEGER, INTEGER, VARCHAR) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.FLATTEN_MATRIX_RAW(P_RES VARCHAR, P_REGION VARCHAR)
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
    raw_table := 'core.MATRIX_RAW_' || P_RES;
    target_table := 'core.TRAVEL_TIME_' || P_RES;

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
GRANT USAGE ON PROCEDURE core.FLATTEN_MATRIX_RAW(VARCHAR, VARCHAR) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.BUILD_MATRIX_FOR_REGION(P_RES VARCHAR, P_MIN_LAT FLOAT, P_MAX_LAT FLOAT, P_MIN_LON FLOAT, P_MAX_LON FLOAT, P_MATRIX_FN VARCHAR, P_REGION VARCHAR)
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
    hex_table := 'core.H3_' || P_RES;
    queue_table := 'core.WORK_QUEUE_' || P_RES;
    travel_table := 'core.TRAVEL_TIME_' || P_RES;

    BEGIN
        ALTER SERVICE IF EXISTS core.routing_gateway_service RESUME;
    EXCEPTION WHEN OTHER THEN NULL;
    END;
    BEGIN
        EXECUTE IMMEDIATE 'ALTER SERVICE IF EXISTS core.ORS_SERVICE_' || UPPER(P_REGION) || ' RESUME';
    EXCEPTION WHEN OTHER THEN
        BEGIN
            ALTER SERVICE IF EXISTS core.ors_service RESUME;
        EXCEPTION WHEN OTHER THEN NULL;
        END;
    END;
    EXECUTE IMMEDIATE 'SELECT SYSTEM$WAIT(5)';

    CALL core.BUILD_HEXAGONS(:P_RES, :P_MIN_LAT, :P_MAX_LAT, :P_MIN_LON, :P_MAX_LON);

    count_sql := 'SELECT COUNT(*) AS CNT FROM ' || hex_table;
    rs := (EXECUTE IMMEDIATE :count_sql);
    LET c2 CURSOR FOR rs;
    FOR r IN c2 DO hex_count := r.CNT; END FOR;

    CALL core.BUILD_WORK_QUEUE(:P_RES);

    count_sql := 'SELECT COUNT(*) AS CNT FROM ' || queue_table;
    rs := (EXECUTE IMMEDIATE :count_sql);
    LET c4 CURSOR FOR rs;
    FOR r IN c4 DO queue_count := r.CNT; END FOR;

    EXECUTE IMMEDIATE 'CALL core.BUILD_TRAVEL_TIME_RANGE_REGION(''' || P_RES || ''', 1, ' || queue_count || ', ''' || P_MATRIX_FN || ''')';
    EXECUTE IMMEDIATE 'CALL core.FLATTEN_MATRIX_RAW(''' || P_RES || ''', ''' || P_REGION || ''')';

    count_sql := 'SELECT COUNT(*) AS CNT FROM ' || travel_table || ' WHERE REGION = ''' || P_REGION || '''';
    rs := (EXECUTE IMMEDIATE :count_sql);
    LET c5 CURSOR FOR rs;
    FOR r IN c5 DO travel_count := r.CNT; END FOR;

    RETURN P_RES || ' complete (' || P_MATRIX_FN || '): ' || hex_count || ' hexagons, ' ||
           queue_count || ' origins, ' || travel_count || ' travel times';
END;
$$;
GRANT USAGE ON PROCEDURE core.BUILD_MATRIX_FOR_REGION(VARCHAR, FLOAT, FLOAT, FLOAT, FLOAT, VARCHAR, VARCHAR) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.MATRIX_PROGRESS()
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
    SELECT COUNT(*) INTO r7_hex FROM core.H3_RES7;
    SELECT COUNT(*) INTO r7_queue FROM core.WORK_QUEUE_RES7;
    SELECT COUNT(*) INTO r7_raw FROM core.MATRIX_RAW_RES7;
    SELECT COUNT(*) INTO r7_flat FROM core.TRAVEL_TIME_RES7;

    SELECT COUNT(*) INTO r8_hex FROM core.H3_RES8;
    SELECT COUNT(*) INTO r8_queue FROM core.WORK_QUEUE_RES8;
    SELECT COUNT(*) INTO r8_raw FROM core.MATRIX_RAW_RES8;
    SELECT COUNT(*) INTO r8_flat FROM core.TRAVEL_TIME_RES8;

    SELECT COUNT(*) INTO r9_hex FROM core.H3_RES9;
    SELECT COUNT(*) INTO r9_queue FROM core.WORK_QUEUE_RES9;
    SELECT COUNT(*) INTO r9_raw FROM core.MATRIX_RAW_RES9;
    SELECT COUNT(*) INTO r9_flat FROM core.TRAVEL_TIME_RES9;

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
GRANT USAGE ON PROCEDURE core.MATRIX_PROGRESS() TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.RESET_MATRIX_DATA()
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
BEGIN
    TRUNCATE TABLE core.H3_RES7;
    TRUNCATE TABLE core.H3_RES8;
    TRUNCATE TABLE core.H3_RES9;
    TRUNCATE TABLE core.WORK_QUEUE_RES7;
    TRUNCATE TABLE core.WORK_QUEUE_RES8;
    TRUNCATE TABLE core.WORK_QUEUE_RES9;
    TRUNCATE TABLE core.MATRIX_RAW_RES7;
    TRUNCATE TABLE core.MATRIX_RAW_RES8;
    TRUNCATE TABLE core.MATRIX_RAW_RES9;
    TRUNCATE TABLE core.TRAVEL_TIME_RES7;
    TRUNCATE TABLE core.TRAVEL_TIME_RES8;
    TRUNCATE TABLE core.TRAVEL_TIME_RES9;
    RETURN 'All matrix tables reset';
END;
$$;
GRANT USAGE ON PROCEDURE core.RESET_MATRIX_DATA() TO APPLICATION ROLE app_user;

-- =============================================================================
-- UI: React control app (SPCS service) + legacy Streamlit
-- =============================================================================

CREATE OR REPLACE PROCEDURE core.create_control_app()
RETURNS STRING
LANGUAGE SQL
AS
$$
BEGIN
    LET pool_name VARCHAR := (SELECT CURRENT_DATABASE()) || '_compute_pool';

    CREATE SERVICE IF NOT EXISTS core.ors_control_app
        IN COMPUTE POOL IDENTIFIER(:pool_name)
        FROM SPECIFICATION_FILE='services/ors_control_app/ors_control_app_service.yaml'
        MIN_INSTANCES = 1
        MAX_INSTANCES = 1
        AUTO_SUSPEND_SECS = 3600;

    GRANT USAGE ON SERVICE core.ors_control_app TO APPLICATION ROLE app_user;
    GRANT SERVICE ROLE core.ors_control_app!ALL_ENDPOINTS_USAGE TO APPLICATION ROLE app_user;
    GRANT OPERATE ON SERVICE core.ors_control_app TO APPLICATION ROLE app_user;
    GRANT MONITOR ON SERVICE core.ors_control_app TO APPLICATION ROLE app_user;

    RETURN 'ORS Control App service created';
END;
$$;
GRANT USAGE ON PROCEDURE core.create_control_app() TO APPLICATION ROLE app_user;

CREATE OR REPLACE STREAMLIT core.control_app
     FROM '/streamlit'
     MAIN_FILE = '/app.py'
     COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"ui"}}';

GRANT USAGE ON STREAMLIT core.control_app TO APPLICATION ROLE app_user;