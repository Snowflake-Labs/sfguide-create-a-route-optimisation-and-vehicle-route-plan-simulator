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

   -- control app is DROP+CREATE'd (not ALTER'd) to ensure EAI bindings are applied
   BEGIN
      CALL core.create_control_app();
   EXCEPTION
      WHEN OTHER THEN NULL;
   END;

   BEGIN
      CALL core.create_functions();
   EXCEPTION
      WHEN OTHER THEN NULL;
   END;

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

   LET svc_status VARCHAR := 'PENDING';
   LET wait_count INT := 0;
   WHILE (:svc_status != 'READY' AND :wait_count < 30) DO
      SELECT SYSTEM$WAIT(10);
      svc_status := (SELECT PARSE_JSON(SYSTEM$GET_SERVICE_STATUS('core.downloader'))[0]['status']::VARCHAR);
      wait_count := :wait_count + 1;
   END WHILE;

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
                  'host_ports', ARRAY_CONSTRUCT('0.0.0.0:443','0.0.0.0:80','snowflakecomputing.com','download.bbbike.org:443','download.geofabrik.de:443'),
                  'allowed_secrets', 'NONE'
                  )
          )::STRING;
      WHEN 'EXTERNAL_ACCESS_CARTO_REF' THEN
          RETURN OBJECT_CONSTRUCT(
              'type', 'CONFIGURATION',
              'payload', OBJECT_CONSTRUCT(
                  'host_ports', ARRAY_CONSTRUCT('a.basemaps.cartocdn.com:443','b.basemaps.cartocdn.com:443','c.basemaps.cartocdn.com:443','d.basemaps.cartocdn.com:443'),
                  'allowed_secrets', 'NONE'
                  )
          )::STRING;
      ELSE
          RETURN '';
  END CASE;
END;	
$$;

GRANT USAGE ON PROCEDURE core.get_config_for_ref(STRING) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.cleanup_legacy_functions()
RETURNS STRING
LANGUAGE SQL
AS
$$
DECLARE
  fn_name VARCHAR;
  fn_args VARCHAR;
  drop_sql VARCHAR;
  c CURSOR FOR
    SELECT FUNCTION_NAME, ARGUMENT_SIGNATURE
    FROM INFORMATION_SCHEMA.FUNCTIONS
    WHERE FUNCTION_SCHEMA = 'CORE'
      AND (
        FUNCTION_NAME LIKE '%\_BERLIN' ESCAPE '\\'
        OR FUNCTION_NAME LIKE '%\_MUNICH' ESCAPE '\\'
        OR FUNCTION_NAME LIKE '%\_LONDON' ESCAPE '\\'
        OR FUNCTION_NAME LIKE '%\_PARIS' ESCAPE '\\'
        OR FUNCTION_NAME LIKE '%\_AMSTERDAM' ESCAPE '\\'
      );
BEGIN
  FOR fn IN c DO
    drop_sql := 'DROP FUNCTION IF EXISTS core.' || fn.FUNCTION_NAME || fn.ARGUMENT_SIGNATURE;
    EXECUTE IMMEDIATE drop_sql;
  END FOR;
  RETURN 'Legacy per-city functions cleaned up';
EXCEPTION
  WHEN OTHER THEN RETURN 'Cleanup skipped: ' || SQLERRM;
END;
$$;
GRANT USAGE ON PROCEDURE core.cleanup_legacy_functions() TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.pre_upgrade_cleanup()
RETURNS STRING
LANGUAGE SQL
AS
$$
DECLARE
  fn_name VARCHAR;
  fn_args VARCHAR;
  drop_sql VARCHAR;
  dropped INT DEFAULT 0;
  c CURSOR FOR
    SELECT FUNCTION_NAME, ARGUMENT_SIGNATURE
    FROM INFORMATION_SCHEMA.FUNCTIONS
    WHERE FUNCTION_SCHEMA = 'CORE'
      AND FUNCTION_OWNER != CURRENT_DATABASE();
BEGIN
  FOR fn IN c DO
    BEGIN
      drop_sql := 'DROP FUNCTION IF EXISTS core.' || fn.FUNCTION_NAME || fn.ARGUMENT_SIGNATURE;
      EXECUTE IMMEDIATE drop_sql;
      dropped := dropped + 1;
    EXCEPTION
      WHEN OTHER THEN NULL;
    END;
  END FOR;
  RETURN 'Dropped ' || dropped || ' non-app-owned functions';
EXCEPTION
  WHEN OTHER THEN RETURN 'Pre-upgrade cleanup error: ' || SQLERRM;
END;
$$;
GRANT USAGE ON PROCEDURE core.pre_upgrade_cleanup() TO APPLICATION ROLE app_user;

CREATE TABLE IF NOT EXISTS core.VERSION_INFO (
  COMPONENT VARCHAR NOT NULL,
  VERSION VARCHAR NOT NULL,
  UPDATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
  UPDATED_BY VARCHAR DEFAULT CURRENT_USER()
)
COMMENT = 'Tracks deployed versions of app components';
GRANT SELECT ON TABLE core.VERSION_INFO TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE core.VERSION_INFO TO APPLICATION ROLE app_user;
GRANT UPDATE ON TABLE core.VERSION_INFO TO APPLICATION ROLE app_user;
GRANT DELETE ON TABLE core.VERSION_INFO TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.create_functions()
RETURNS string
LANGUAGE sql
AS
$$
BEGIN
   BEGIN
     CALL core.cleanup_legacy_functions();
   EXCEPTION
     WHEN OTHER THEN NULL;
   END;

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

   CREATE OR REPLACE FUNCTION core.CHECK_HEALTH()
   RETURNS BOOLEAN
   LANGUAGE SQL
   AS
   'SELECT CASE WHEN core.ORS_STATUS() IS NOT NULL THEN TRUE ELSE FALSE END';
   GRANT USAGE ON FUNCTION core.CHECK_HEALTH() TO APPLICATION ROLE app_user;

   -- ===== REGION-AWARE OVERLOADS (multi-city) =====

   CREATE OR REPLACE FUNCTION core.DIRECTIONS(region VARCHAR, method VARCHAR, jstart ARRAY, jend ARRAY)
      RETURNS VARIANT
      SERVICE=core.routing_gateway_service
      ENDPOINT='gateway'
      MAX_BATCH_ROWS=10
      AS '/r/directions_tabular';
   GRANT USAGE ON FUNCTION core.DIRECTIONS(VARCHAR, VARCHAR, ARRAY, ARRAY) TO APPLICATION ROLE app_user;

   CREATE OR REPLACE FUNCTION core.DIRECTIONS(region VARCHAR, method VARCHAR, locations VARIANT)
      RETURNS VARIANT
      SERVICE=core.routing_gateway_service
      ENDPOINT='gateway'
      MAX_BATCH_ROWS=10
      AS '/r/directions';
   GRANT USAGE ON FUNCTION core.DIRECTIONS(VARCHAR, VARCHAR, VARIANT) TO APPLICATION ROLE app_user;

   CREATE OR REPLACE FUNCTION core.ISOCHRONES(region VARCHAR, method TEXT, lon FLOAT, lat FLOAT, range INT)
      RETURNS VARIANT
      SERVICE=core.routing_gateway_service
      ENDPOINT='gateway'
      MAX_BATCH_ROWS=10
      AS '/r/isochrones_tabular';
   GRANT USAGE ON FUNCTION core.ISOCHRONES(VARCHAR, TEXT, FLOAT, FLOAT, INT) TO APPLICATION ROLE app_user;

   CREATE OR REPLACE FUNCTION core.MATRIX(region VARCHAR, method VARCHAR, locations ARRAY)
      RETURNS VARIANT
      SERVICE=core.routing_gateway_service
      ENDPOINT='gateway'
      MAX_BATCH_ROWS=10
      AS '/r/matrix_tabular';
   GRANT USAGE ON FUNCTION core.MATRIX(VARCHAR, VARCHAR, ARRAY) TO APPLICATION ROLE app_user;

   CREATE OR REPLACE FUNCTION core.MATRIX(region VARCHAR, method VARCHAR, options VARIANT)
      RETURNS VARIANT
      SERVICE=core.routing_gateway_service
      ENDPOINT='gateway'
      MAX_BATCH_ROWS=10
      AS '/r/matrix';
   GRANT USAGE ON FUNCTION core.MATRIX(VARCHAR, VARCHAR, VARIANT) TO APPLICATION ROLE app_user;

   CREATE OR REPLACE FUNCTION core.MATRIX_TABULAR(region VARCHAR, method VARCHAR, origin ARRAY, destinations ARRAY)
      RETURNS VARIANT
      SERVICE=core.routing_gateway_service
      ENDPOINT='gateway'
      MAX_BATCH_ROWS=10
      AS '/r/matrix_tabular';
   GRANT USAGE ON FUNCTION core.MATRIX_TABULAR(VARCHAR, VARCHAR, ARRAY, ARRAY) TO APPLICATION ROLE app_user;

   CREATE OR REPLACE FUNCTION core.OPTIMIZATION(region VARCHAR, jobs ARRAY, vehicles ARRAY, matrices ARRAY DEFAULT [])
      RETURNS VARIANT
      SERVICE=core.routing_gateway_service
      ENDPOINT='gateway'
      MAX_BATCH_ROWS=10
      AS '/r/optimization_tabular';
   GRANT USAGE ON FUNCTION core.OPTIMIZATION(VARCHAR, ARRAY, ARRAY, ARRAY) TO APPLICATION ROLE app_user;

   CREATE OR REPLACE FUNCTION core.ORS_STATUS(region VARCHAR)
      RETURNS VARIANT
      SERVICE=core.routing_gateway_service
      ENDPOINT='gateway'
      MAX_BATCH_ROWS=1
      AS '/r/ors_status';
   GRANT USAGE ON FUNCTION core.ORS_STATUS(VARCHAR) TO APPLICATION ROLE app_user;

   -- ===== REGION-AWARE _GEO WRAPPERS =====

   CREATE OR REPLACE FUNCTION core.DIRECTIONS_GEO(region VARCHAR, method VARCHAR, jstart ARRAY, jend ARRAY)
      RETURNS TABLE (RESPONSE VARIANT, GEOJSON GEOGRAPHY, DISTANCE FLOAT, DURATION FLOAT)
      LANGUAGE SQL
      AS
      'SELECT resp AS RESPONSE,
            TO_GEOGRAPHY(resp:features[0]:geometry) AS GEOJSON,
            resp:features[0]:properties:summary:distance::FLOAT AS DISTANCE,
            resp:features[0]:properties:summary:duration::FLOAT AS DURATION
         FROM (SELECT core.DIRECTIONS(region, method, jstart, jend) AS resp)';
   GRANT USAGE ON FUNCTION core.DIRECTIONS_GEO(VARCHAR, VARCHAR, ARRAY, ARRAY) TO APPLICATION ROLE app_user;

   CREATE OR REPLACE FUNCTION core.DIRECTIONS_GEO(region VARCHAR, method VARCHAR, locations VARIANT)
      RETURNS TABLE (RESPONSE VARIANT, GEOJSON GEOGRAPHY, DISTANCE FLOAT, DURATION FLOAT)
      LANGUAGE SQL
      AS
      'SELECT resp AS RESPONSE,
            TO_GEOGRAPHY(resp:features[0]:geometry) AS GEOJSON,
            resp:features[0]:properties:summary:distance::FLOAT AS DISTANCE,
            resp:features[0]:properties:summary:duration::FLOAT AS DURATION
         FROM (SELECT core.DIRECTIONS(region, method, locations) AS resp)';
   GRANT USAGE ON FUNCTION core.DIRECTIONS_GEO(VARCHAR, VARCHAR, VARIANT) TO APPLICATION ROLE app_user;

   CREATE OR REPLACE FUNCTION core.ISOCHRONES_GEO(region VARCHAR, method TEXT, lon FLOAT, lat FLOAT, range INT)
      RETURNS TABLE (RESPONSE VARIANT, GEOJSON GEOGRAPHY)
      LANGUAGE SQL
      AS
      'SELECT resp AS RESPONSE,
            TO_GEOGRAPHY(resp:features[0]:geometry) AS GEOJSON
         FROM (SELECT core.ISOCHRONES(region, method, lon, lat, range) AS resp)';
   GRANT USAGE ON FUNCTION core.ISOCHRONES_GEO(VARCHAR, TEXT, FLOAT, FLOAT, INT) TO APPLICATION ROLE app_user;

   CREATE OR REPLACE FUNCTION core.OPTIMIZATION_GEO(region VARCHAR, jobs ARRAY, vehicles ARRAY, matrices ARRAY DEFAULT [])
      RETURNS TABLE (RESPONSE VARIANT, GEOJSON GEOGRAPHY, VEHICLE INT, DURATION INT, STEPS VARIANT)
      LANGUAGE SQL
      AS
      'SELECT resp AS RESPONSE,
            TO_GEOGRAPHY(OBJECT_CONSTRUCT(''type'', ''LineString'', ''coordinates'', f.value:geometry)) AS GEOJSON,
            f.value:vehicle::INT AS VEHICLE,
            f.value:duration::INT AS DURATION,
            f.value:steps::VARIANT AS STEPS
         FROM (SELECT core.OPTIMIZATION(region, jobs, vehicles, matrices) AS resp),
            LATERAL FLATTEN(input => resp:routes) f';
   GRANT USAGE ON FUNCTION core.OPTIMIZATION_GEO(VARCHAR, ARRAY, ARRAY, ARRAY) TO APPLICATION ROLE app_user;

   CREATE OR REPLACE FUNCTION core.LIST_REGIONS()
      RETURNS TABLE (REGION VARCHAR, DISPLAY_NAME VARCHAR, STATUS VARCHAR, MIN_LAT FLOAT, MAX_LAT FLOAT, MIN_LON FLOAT, MAX_LON FLOAT)
      LANGUAGE SQL
      AS
      'SELECT REGION, DISPLAY_NAME, STATUS, MIN_LAT, MAX_LAT, MIN_LON, MAX_LON FROM core.CITY_ORS_MAP';
   GRANT USAGE ON FUNCTION core.LIST_REGIONS() TO APPLICATION ROLE app_user;

   MERGE INTO core.VERSION_INFO t USING (SELECT 'setup_script' AS COMPONENT) s
     ON t.COMPONENT = s.COMPONENT
     WHEN MATCHED THEN UPDATE SET VERSION = '1.1.0', UPDATED_AT = CURRENT_TIMESTAMP()
     WHEN NOT MATCHED THEN INSERT (COMPONENT, VERSION) VALUES ('setup_script', '1.1.0');

   RETURN 'Functions successfully created';
END;
$$;

GRANT USAGE ON PROCEDURE core.create_functions() TO APPLICATION ROLE app_user;

CREATE TABLE IF NOT EXISTS core.CITY_PROVISION_JOBS (
    JOB_ID VARCHAR NOT NULL,
    REGION VARCHAR NOT NULL,
    DISPLAY_NAME VARCHAR,
    PBF_URL VARCHAR,
    PROFILES VARCHAR,
    STATUS VARCHAR DEFAULT 'PENDING',
    STAGE VARCHAR DEFAULT 'NOT_STARTED',
    MESSAGE VARCHAR,
    STATEMENT_HANDLE VARCHAR,
    CREATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    STARTED_AT TIMESTAMP_NTZ,
    COMPLETED_AT TIMESTAMP_NTZ,
    ERROR_MSG VARCHAR
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"provisioner"}}';
GRANT SELECT ON TABLE core.CITY_PROVISION_JOBS TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE core.CITY_PROVISION_JOBS TO APPLICATION ROLE app_user;
GRANT UPDATE ON TABLE core.CITY_PROVISION_JOBS TO APPLICATION ROLE app_user;
GRANT DELETE ON TABLE core.CITY_PROVISION_JOBS TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.PROVISION_CITY_WRAPPER(
    P_JOB_ID VARCHAR,
    P_REGION VARCHAR,
    P_DISPLAY_NAME VARCHAR,
    P_PBF_URL VARCHAR,
    P_MIN_LAT FLOAT, P_MAX_LAT FLOAT, P_MIN_LON FLOAT, P_MAX_LON FLOAT,
    P_PROFILES VARCHAR
)
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    pbf_filename VARCHAR;
    svc_name VARCHAR;
    svc_status VARCHAR DEFAULT '';
    status_raw VARCHAR;
    status_json VARIANT;
    profile_count INTEGER DEFAULT 0;
    rs RESULTSET;
BEGIN
    UPDATE core.CITY_PROVISION_JOBS
    SET STATUS='RUNNING', STAGE='DOWNLOADING', STARTED_AT=CURRENT_TIMESTAMP(),
        MESSAGE='Inserting city metadata and downloading PBF file...'
    WHERE JOB_ID = :P_JOB_ID;

    MERGE INTO core.CITY_ORS_MAP t USING (
        SELECT :P_REGION AS REGION
    ) s ON t.REGION = s.REGION
    WHEN NOT MATCHED THEN INSERT (REGION, DISPLAY_NAME, PBF_URL, MIN_LAT, MAX_LAT, MIN_LON, MAX_LON, STATUS)
        VALUES (:P_REGION, :P_DISPLAY_NAME, :P_PBF_URL, :P_MIN_LAT, :P_MAX_LAT, :P_MIN_LON, :P_MAX_LON, 'PROVISIONING');

    pbf_filename := SPLIT_PART(:P_PBF_URL, '/', -1);
    IF (pbf_filename IS NULL OR pbf_filename = '') THEN
        pbf_filename := 'data.osm.pbf';
    END IF;
    BEGIN
        EXECUTE IMMEDIATE 'SELECT core.DOWNLOAD(''ors_spcs_stage/' || :P_REGION || ''', ''' || :pbf_filename || ''', ''' || :P_PBF_URL || ''')';
    EXCEPTION WHEN OTHER THEN NULL;
    END;

    UPDATE core.CITY_PROVISION_JOBS SET STAGE='CONFIGURING', MESSAGE='Writing ORS configuration...' WHERE JOB_ID = :P_JOB_ID;
    CALL core.WRITE_ORS_CONFIG(:P_REGION, :pbf_filename, :P_PROFILES);

    UPDATE core.CITY_PROVISION_JOBS SET STAGE='STARTING_SERVICE', MESSAGE='Creating ORS service...' WHERE JOB_ID = :P_JOB_ID;
    CALL core.SETUP_CITY_ORS(:P_REGION);

    UPDATE core.CITY_PROVISION_JOBS SET STAGE='WAITING_FOR_SERVICE', MESSAGE='Waiting for ORS service to start...' WHERE JOB_ID = :P_JOB_ID;
    svc_name := 'ORS_SERVICE_' || UPPER(:P_REGION);
    FOR i IN 1 TO 60 DO
        EXECUTE IMMEDIATE 'SELECT SYSTEM$WAIT(10)';
        BEGIN
            EXECUTE IMMEDIATE 'SHOW SERVICES LIKE ''' || :svc_name || ''' IN SCHEMA core';
            rs := (EXECUTE IMMEDIATE 'SELECT "status" AS S FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))');
            LET c1 CURSOR FOR rs;
            FOR r IN c1 DO svc_status := r.S; END FOR;
            IF (:svc_status = 'RUNNING') THEN
                UPDATE core.CITY_PROVISION_JOBS SET MESSAGE='ORS service is RUNNING, waiting for graph...' WHERE JOB_ID = :P_JOB_ID;
                BREAK;
            END IF;
        EXCEPTION WHEN OTHER THEN NULL;
        END;
    END FOR;

    UPDATE core.CITY_PROVISION_JOBS SET STAGE='BUILDING_GRAPH', MESSAGE='Service running — waiting for routing graph to load...' WHERE JOB_ID = :P_JOB_ID;
    FOR i IN 1 TO 40 DO
        EXECUTE IMMEDIATE 'SELECT SYSTEM$WAIT(15)';
        BEGIN
            rs := (EXECUTE IMMEDIATE 'SELECT core.ORS_STATUS(''' || :P_REGION || ''')::VARCHAR AS S');
            LET c2 CURSOR FOR rs;
            FOR r IN c2 DO status_raw := r.S; END FOR;
            status_json := TRY_PARSE_JSON(:status_raw);
            IF (status_json:service_ready::BOOLEAN = TRUE AND status_json:profiles IS NOT NULL) THEN
                profile_count := ARRAY_SIZE(OBJECT_KEYS(status_json:profiles));
                IF (:profile_count > 0) THEN
                    UPDATE core.CITY_ORS_MAP SET STATUS='DEPLOYED' WHERE REGION = :P_REGION;
                    UPDATE core.CITY_PROVISION_JOBS
                    SET STATUS='COMPLETE', STAGE='READY',
                        MESSAGE='City provisioned — ' || :profile_count || ' profile(s) ready',
                        COMPLETED_AT=CURRENT_TIMESTAMP()
                    WHERE JOB_ID = :P_JOB_ID;
                    RETURN 'Job ' || :P_JOB_ID || ' complete: ' || :profile_count || ' profiles ready';
                END IF;
            END IF;
        EXCEPTION WHEN OTHER THEN NULL;
        END;
    END FOR;

    UPDATE core.CITY_ORS_MAP SET STATUS='DEPLOYED' WHERE REGION = :P_REGION;
    UPDATE core.CITY_PROVISION_JOBS
    SET STATUS='COMPLETE', STAGE='READY',
        MESSAGE='Service running but graph may still be loading. Check ORS_STATUS.',
        COMPLETED_AT=CURRENT_TIMESTAMP()
    WHERE JOB_ID = :P_JOB_ID;
    RETURN 'Job ' || :P_JOB_ID || ' complete (graph may still be loading)';

EXCEPTION
    WHEN OTHER THEN
        LET err_msg VARCHAR := SQLERRM;
        UPDATE core.CITY_PROVISION_JOBS
        SET STATUS='ERROR', ERROR_MSG=:err_msg, COMPLETED_AT=CURRENT_TIMESTAMP()
        WHERE JOB_ID = :P_JOB_ID;
        RETURN 'Job ' || :P_JOB_ID || ' failed: ' || :err_msg;
END;
$$;
GRANT USAGE ON PROCEDURE core.PROVISION_CITY_WRAPPER(VARCHAR, VARCHAR, VARCHAR, VARCHAR, FLOAT, FLOAT, FLOAT, FLOAT, VARCHAR) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.GET_PROVISION_STATUS()
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    result VARCHAR;
BEGIN
    SELECT COALESCE(ARRAY_AGG(OBJECT_CONSTRUCT(
        'job_id', JOB_ID, 'region', REGION, 'display_name', COALESCE(DISPLAY_NAME, REGION),
        'profiles', COALESCE(PROFILES, ''), 'status', STATUS, 'stage', STAGE,
        'message', COALESCE(MESSAGE, ''), 'error_msg', COALESCE(ERROR_MSG, ''),
        'statement_handle', COALESCE(STATEMENT_HANDLE, ''),
        'created_at', TO_VARCHAR(CREATED_AT, 'YYYY-MM-DD HH24:MI:SS'),
        'started_at', COALESCE(TO_VARCHAR(STARTED_AT, 'YYYY-MM-DD HH24:MI:SS'), ''),
        'completed_at', COALESCE(TO_VARCHAR(COMPLETED_AT, 'YYYY-MM-DD HH24:MI:SS'), '')
    )), ARRAY_CONSTRUCT())::VARCHAR INTO result
    FROM core.CITY_PROVISION_JOBS
    WHERE CREATED_AT > DATEADD('day', -30, CURRENT_TIMESTAMP())
    ORDER BY CREATED_AT DESC;
    RETURN result;
END;
$$;
GRANT USAGE ON PROCEDURE core.GET_PROVISION_STATUS() TO APPLICATION ROLE app_user;

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

CREATE OR REPLACE PROCEDURE core.write_ors_config(P_REGION VARCHAR, P_PBF_FILE VARCHAR, P_PROFILES VARCHAR)
RETURNS STRING
LANGUAGE PYTHON
RUNTIME_VERSION = '3.11'
PACKAGES = ('snowflake-snowpark-python')
HANDLER = 'run'
AS
$$
def run(session, p_region, p_pbf_file, p_profiles):
    import tempfile, os

    profiles_list = [p.strip() for p in p_profiles.split(',') if p.strip()]
    all_profiles = [
        'driving-car', 'driving-hgv', 'cycling-regular', 'cycling-road',
        'cycling-mountain', 'cycling-electric', 'foot-walking', 'foot-hiking', 'wheelchair'
    ]

    profile_lines = []
    for p in all_profiles:
        enabled = 'true' if p in profiles_list else 'false'
        profile_lines.append('      ' + p + ':\n        enabled: ' + enabled)

    all_profiles_str = ', '.join(all_profiles)
    lines = [
        'ors:',
        '  engine:',
        '    profile_default:',
        '      build:',
        '        source_file: /home/ors/files/' + p_pbf_file,
        '        instructions: false',
        '      service:',
        '        maximum_distance: 1500000',
        '        maximum_distance_dynamic_weights: 1500000',
        '        maximum_distance_avoid_areas: 1500000',
        '        maximum_distance_alternative_routes: 1500000',
        '        maximum_distance_round_trip_routes: 1500000',
        '        maximum_visited_nodes: 100000000',
        '    profiles:',
    ]
    yaml_content = '\n'.join(lines) + '\n' + '\n'.join(profile_lines) + '\n'
    yaml_content += '\n'.join([
        '  endpoints:',
        '    matrix:',
        '      maximum_visited_nodes: 100000000',
        '      maximum_routes: 250000',
        '    isochrones:',
        '      maximum_locations: 2',
        '      maximum_intervals: 10',
        '      maximum_range_distance:',
        '        - profiles: ' + all_profiles_str,
        '          value: 1500000',
        '      maximum_range_time:',
        '        - profiles: ' + all_profiles_str,
        '          value: 18000',
        '',
    ])

    tmpdir = tempfile.mkdtemp()
    config_path = os.path.join(tmpdir, 'ors-config.yml')
    with open(config_path, 'w') as f:
        f.write(yaml_content)

    try:
        stage_path = '@CORE.ORS_SPCS_STAGE/' + p_region + '/'
        session.file.put(config_path, stage_path, auto_compress=False, overwrite=True)
    finally:
        os.unlink(config_path)
        os.rmdir(tmpdir)

    return 'ORS config written for ' + p_region + ' with profiles: ' + p_profiles
$$;
GRANT USAGE ON PROCEDURE core.write_ors_config(VARCHAR, VARCHAR, VARCHAR) TO APPLICATION ROLE app_user;

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

    EXECUTE IMMEDIATE 'DROP SERVICE IF EXISTS core.' || svc_name;

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

-- =============================================================================
-- TRAVEL TIME MATRIX: Schema and dynamic table creation
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS travel_matrix
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"matrix"}}';
GRANT USAGE ON SCHEMA travel_matrix TO APPLICATION ROLE app_user;

CREATE TABLE IF NOT EXISTS travel_matrix.MATRIX_BUILD_JOBS (
    JOB_ID VARCHAR NOT NULL,
    REGION VARCHAR NOT NULL,
    PROFILE VARCHAR NOT NULL,
    RESOLUTION VARCHAR NOT NULL,
    STATUS VARCHAR DEFAULT 'PENDING',
    STAGE VARCHAR DEFAULT 'NOT_STARTED',
    HEXAGONS NUMBER DEFAULT 0,
    WORK_QUEUE_ROWS NUMBER DEFAULT 0,
    RAW_ROWS NUMBER DEFAULT 0,
    MATRIX_ROWS NUMBER DEFAULT 0,
    PCT_COMPLETE FLOAT DEFAULT 0,
    MESSAGE VARCHAR,
    ERROR_MSG VARCHAR,
    STATEMENT_HANDLE VARCHAR,
    CREATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    STARTED_AT TIMESTAMP_NTZ,
    COMPLETED_AT TIMESTAMP_NTZ
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"matrix"}}';
GRANT SELECT ON TABLE travel_matrix.MATRIX_BUILD_JOBS TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE travel_matrix.MATRIX_BUILD_JOBS TO APPLICATION ROLE app_user;
GRANT UPDATE ON TABLE travel_matrix.MATRIX_BUILD_JOBS TO APPLICATION ROLE app_user;
GRANT DELETE ON TABLE travel_matrix.MATRIX_BUILD_JOBS TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.ENSURE_MATRIX_TABLES(P_REGION VARCHAR, P_PROFILE VARCHAR, P_RES VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    safe_profile VARCHAR;
    list_table VARCHAR;
    wq_table VARCHAR;
    raw_table VARCHAR;
    matrix_table VARCHAR;
BEGIN
    safe_profile := REPLACE(UPPER(P_PROFILE), '-', '_');

    list_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_LIST_' || P_RES;
    wq_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_WORK_QUEUE_' || P_RES;
    raw_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_MATRIX_RAW_' || P_RES;
    matrix_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_MATRIX_' || P_RES;

    EXECUTE IMMEDIATE 'CREATE TABLE IF NOT EXISTS ' || list_table || ' (H3_INDEX VARCHAR, CENTER_LAT FLOAT, CENTER_LON FLOAT) COMMENT = ''{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"matrix"}}''';
    EXECUTE IMMEDIATE 'GRANT SELECT ON TABLE ' || list_table || ' TO APPLICATION ROLE app_user';
    EXECUTE IMMEDIATE 'GRANT INSERT ON TABLE ' || list_table || ' TO APPLICATION ROLE app_user';
    EXECUTE IMMEDIATE 'GRANT TRUNCATE ON TABLE ' || list_table || ' TO APPLICATION ROLE app_user';

    EXECUTE IMMEDIATE 'CREATE TABLE IF NOT EXISTS ' || wq_table || ' (SEQ_ID INTEGER, ORIGIN_H3 VARCHAR, ORIGIN_LON FLOAT, ORIGIN_LAT FLOAT, DEST_COORDS ARRAY, DEST_HEX_IDS ARRAY) COMMENT = ''{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"matrix"}}''';
    EXECUTE IMMEDIATE 'GRANT SELECT ON TABLE ' || wq_table || ' TO APPLICATION ROLE app_user';
    EXECUTE IMMEDIATE 'GRANT INSERT ON TABLE ' || wq_table || ' TO APPLICATION ROLE app_user';
    EXECUTE IMMEDIATE 'GRANT TRUNCATE ON TABLE ' || wq_table || ' TO APPLICATION ROLE app_user';

    EXECUTE IMMEDIATE 'CREATE TABLE IF NOT EXISTS ' || raw_table || ' (SEQ_ID INTEGER, ORIGIN_H3 VARCHAR, DEST_HEX_IDS ARRAY, MATRIX_RESULT VARIANT) COMMENT = ''{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"matrix"}}''';
    EXECUTE IMMEDIATE 'GRANT SELECT ON TABLE ' || raw_table || ' TO APPLICATION ROLE app_user';
    EXECUTE IMMEDIATE 'GRANT INSERT ON TABLE ' || raw_table || ' TO APPLICATION ROLE app_user';
    EXECUTE IMMEDIATE 'GRANT TRUNCATE ON TABLE ' || raw_table || ' TO APPLICATION ROLE app_user';

    EXECUTE IMMEDIATE 'CREATE TABLE IF NOT EXISTS ' || matrix_table || ' (ORIGIN_H3 VARCHAR, DEST_H3 VARCHAR, TRAVEL_TIME_SECONDS FLOAT, TRAVEL_DISTANCE_METERS FLOAT, CALCULATED_AT TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP()) COMMENT = ''{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"matrix"}}''';
    EXECUTE IMMEDIATE 'GRANT SELECT ON TABLE ' || matrix_table || ' TO APPLICATION ROLE app_user';
    EXECUTE IMMEDIATE 'GRANT INSERT ON TABLE ' || matrix_table || ' TO APPLICATION ROLE app_user';
    EXECUTE IMMEDIATE 'GRANT DELETE ON TABLE ' || matrix_table || ' TO APPLICATION ROLE app_user';
    RETURN 'Tables ensured: ' || list_table || ', ' || wq_table || ', ' || raw_table || ', ' || matrix_table;
END;
$$;
GRANT USAGE ON PROCEDURE core.ENSURE_MATRIX_TABLES(VARCHAR, VARCHAR, VARCHAR) TO APPLICATION ROLE app_user;

-- =============================================================================
-- TRAVEL TIME MATRIX: Pipeline procedures
-- =============================================================================

CREATE OR REPLACE PROCEDURE core.BUILD_HEXAGONS(P_RES VARCHAR, P_MIN_LAT FLOAT, P_MAX_LAT FLOAT, P_MIN_LON FLOAT, P_MAX_LON FLOAT, P_REGION VARCHAR, P_PROFILE VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    resolution INTEGER;
    hex_table VARCHAR;
    safe_profile VARCHAR;
    row_count INTEGER;
    rs RESULTSET;
BEGIN
    safe_profile := REPLACE(UPPER(P_PROFILE), '-', '_');
    hex_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_LIST_' || P_RES;

    IF (P_RES = 'RES5') THEN
        resolution := 5;
    ELSEIF (P_RES = 'RES6') THEN
        resolution := 6;
    ELSEIF (P_RES = 'RES7') THEN
        resolution := 7;
    ELSEIF (P_RES = 'RES8') THEN
        resolution := 8;
    ELSEIF (P_RES = 'RES9') THEN
        resolution := 9;
    ELSE
        resolution := 10;
    END IF;

    EXECUTE IMMEDIATE 'TRUNCATE TABLE ' || hex_table;

    EXECUTE IMMEDIATE '
    INSERT INTO ' || hex_table || ' (H3_INDEX, CENTER_LAT, CENTER_LON)
    SELECT
        h.VALUE::VARCHAR AS h3_index,
        ST_Y(H3_CELL_TO_POINT(h.VALUE::VARCHAR)) AS center_lat,
        ST_X(H3_CELL_TO_POINT(h.VALUE::VARCHAR)) AS center_lon
    FROM TABLE(FLATTEN(
        H3_POLYGON_TO_CELLS_STRINGS(
            TO_GEOGRAPHY(''POLYGON((' ||
                P_MIN_LON || ' ' || P_MIN_LAT || ',' ||
                P_MAX_LON || ' ' || P_MIN_LAT || ',' ||
                P_MAX_LON || ' ' || P_MAX_LAT || ',' ||
                P_MIN_LON || ' ' || P_MAX_LAT || ',' ||
                P_MIN_LON || ' ' || P_MIN_LAT || '))''),
            ' || resolution || '
        )
    )) h';

    rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || hex_table);
    LET c CURSOR FOR rs;
    FOR row_val IN c DO
        row_count := row_val.CNT;
    END FOR;

    RETURN P_RES || ' hexagons built: ' || row_count || ' hexagons';
END;
$$;
GRANT USAGE ON PROCEDURE core.BUILD_HEXAGONS(VARCHAR, FLOAT, FLOAT, FLOAT, FLOAT, VARCHAR, VARCHAR) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.BUILD_WORK_QUEUE(P_RES VARCHAR, P_REGION VARCHAR, P_PROFILE VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    hex_table VARCHAR;
    queue_table VARCHAR;
    safe_profile VARCHAR;
    row_count INTEGER;
    rs RESULTSET;
BEGIN
    safe_profile := REPLACE(UPPER(P_PROFILE), '-', '_');
    hex_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_LIST_' || P_RES;
    queue_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_WORK_QUEUE_' || P_RES;

    EXECUTE IMMEDIATE 'TRUNCATE TABLE ' || queue_table;

    EXECUTE IMMEDIATE '
    INSERT INTO ' || queue_table || ' (SEQ_ID, ORIGIN_H3, ORIGIN_LON, ORIGIN_LAT, DEST_COORDS, DEST_HEX_IDS)
    WITH pairs AS (
        SELECT
            a.H3_INDEX AS origin_h3,
            a.CENTER_LON AS origin_lon,
            a.CENTER_LAT AS origin_lat,
            b.H3_INDEX AS dest_h3
        FROM ' || hex_table || ' a
        CROSS JOIN ' || hex_table || ' b
        WHERE a.H3_INDEX != b.H3_INDEX
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
GRANT USAGE ON PROCEDURE core.BUILD_WORK_QUEUE(VARCHAR, VARCHAR, VARCHAR) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.BUILD_TRAVEL_TIME_RANGE(P_RES VARCHAR, P_START_SEQ INTEGER, P_END_SEQ INTEGER, P_REGION VARCHAR, P_PROFILE VARCHAR)
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
    safe_profile VARCHAR;
    insert_sql VARCHAR;
    resume_sql VARCHAR;
    max_done INTEGER DEFAULT 0;
    rs RESULTSET;
    retry_count INTEGER DEFAULT 0;
    max_retries INTEGER DEFAULT 5;
    retry_wait INTEGER DEFAULT 10;
BEGIN
    safe_profile := REPLACE(UPPER(P_PROFILE), '-', '_');
    queue_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_WORK_QUEUE_' || P_RES;
    raw_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_MATRIX_RAW_' || P_RES;

    IF (P_RES = 'RES5') THEN
        batch_size := 20;
    ELSEIF (P_RES = 'RES6') THEN
        batch_size := 50;
    ELSEIF (P_RES = 'RES7') THEN
        batch_size := 100;
    ELSEIF (P_RES = 'RES8') THEN
        batch_size := 200;
    ELSEIF (P_RES = 'RES9') THEN
        batch_size := 100;
    ELSE
        batch_size := 50;
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
                ''' || P_PROFILE || ''',
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
GRANT USAGE ON PROCEDURE core.BUILD_TRAVEL_TIME_RANGE(VARCHAR, INTEGER, INTEGER, VARCHAR, VARCHAR) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.BUILD_TRAVEL_TIME_RANGE_REGION(P_RES VARCHAR, P_START_SEQ INTEGER, P_END_SEQ INTEGER, P_MATRIX_FN VARCHAR, P_REGION VARCHAR, P_PROFILE VARCHAR)
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
    safe_profile VARCHAR;
    matrix_call VARCHAR;
    insert_sql VARCHAR;
    resume_sql VARCHAR;
    max_done INTEGER DEFAULT 0;
    rs RESULTSET;
    retry_count INTEGER DEFAULT 0;
    max_retries INTEGER DEFAULT 5;
    retry_wait INTEGER DEFAULT 10;
BEGIN
    safe_profile := REPLACE(UPPER(P_PROFILE), '-', '_');
    queue_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_WORK_QUEUE_' || P_RES;
    raw_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_MATRIX_RAW_' || P_RES;

    IF (P_REGION IS NOT NULL AND UPPER(P_REGION) NOT IN ('DEFAULT', 'SAN_FRANCISCO')) THEN
        matrix_call := P_MATRIX_FN || '(''' || P_REGION || ''', ''' || P_PROFILE || ''', ARRAY_CONSTRUCT(q.ORIGIN_LON, q.ORIGIN_LAT), q.DEST_COORDS)';
    ELSE
        matrix_call := P_MATRIX_FN || '(''' || P_PROFILE || ''', ARRAY_CONSTRUCT(q.ORIGIN_LON, q.ORIGIN_LAT), q.DEST_COORDS)';
    END IF;

    IF (P_RES = 'RES5') THEN
        batch_size := 20;
    ELSEIF (P_RES = 'RES6') THEN
        batch_size := 50;
    ELSEIF (P_RES = 'RES7') THEN
        batch_size := 100;
    ELSEIF (P_RES = 'RES8') THEN
        batch_size := 200;
    ELSEIF (P_RES = 'RES9') THEN
        batch_size := 100;
    ELSE
        batch_size := 50;
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
            ' || matrix_call || '
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

    LET error_retry_sql VARCHAR;
    LET error_origin_count INTEGER DEFAULT 0;
    LET fixed_count INTEGER DEFAULT 0;
    LET retry_pass INTEGER DEFAULT 0;
    LET max_error_retries INTEGER DEFAULT 3;

    WHILE (retry_pass < max_error_retries) DO
        error_retry_sql := 'SELECT COUNT(*) AS CNT FROM ' || raw_table ||
            ' WHERE SEQ_ID BETWEEN ' || P_START_SEQ || ' AND ' || P_END_SEQ ||
            ' AND MATRIX_RESULT:durations IS NULL';
        rs := (EXECUTE IMMEDIATE :error_retry_sql);
        LET ec CURSOR FOR rs;
        FOR r IN ec DO error_origin_count := r.CNT; END FOR;

        IF (error_origin_count = 0) THEN
            retry_pass := max_error_retries;
        ELSE
            retry_pass := retry_pass + 1;
            EXECUTE IMMEDIATE 'SELECT SYSTEM$WAIT(15)';

            EXECUTE IMMEDIATE 'DELETE FROM ' || raw_table ||
            ' WHERE SEQ_ID BETWEEN ' || P_START_SEQ || ' AND ' || P_END_SEQ ||
            ' AND MATRIX_RESULT:durations IS NULL';

            EXECUTE IMMEDIATE '
            INSERT INTO ' || raw_table || '
            SELECT q.SEQ_ID, q.ORIGIN_H3, q.DEST_HEX_IDS, ' || matrix_call || '
            FROM ' || queue_table || ' q
            WHERE q.SEQ_ID BETWEEN ' || P_START_SEQ || ' AND ' || P_END_SEQ ||
            ' AND q.SEQ_ID NOT IN (SELECT SEQ_ID FROM ' || raw_table ||
            ' WHERE SEQ_ID BETWEEN ' || P_START_SEQ || ' AND ' || P_END_SEQ || ')';
        END IF;
    END WHILE;

    RETURN P_RES || ' range [' || P_START_SEQ || '-' || P_END_SEQ ||
           '] complete: ' || batch_num || ' batches of ' || batch_size ||
           ' (resumed from seq ' || max_done || ', fn=' || P_MATRIX_FN || ')';
END;
$$;
GRANT USAGE ON PROCEDURE core.BUILD_TRAVEL_TIME_RANGE_REGION(VARCHAR, INTEGER, INTEGER, VARCHAR, VARCHAR, VARCHAR) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.FLATTEN_MATRIX_RAW(P_RES VARCHAR, P_REGION VARCHAR, P_PROFILE VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    raw_table VARCHAR;
    target_table VARCHAR;
    safe_profile VARCHAR;
    row_count INTEGER;
    rs RESULTSET;
BEGIN
    safe_profile := REPLACE(UPPER(P_PROFILE), '-', '_');
    raw_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_MATRIX_RAW_' || P_RES;
    target_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_MATRIX_' || P_RES;

    EXECUTE IMMEDIATE '
    CREATE OR REPLACE TABLE ' || target_table || '
    CLUSTER BY (ORIGIN_H3)
    COMMENT = ''{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"matrix"}}''
    AS
    SELECT
        r.ORIGIN_H3,
        r.DEST_HEX_IDS[f.INDEX]::VARCHAR AS DEST_H3,
        r.MATRIX_RESULT:durations[0][f.INDEX]::FLOAT AS TRAVEL_TIME_SECONDS,
        r.MATRIX_RESULT:distances[0][f.INDEX]::FLOAT AS TRAVEL_DISTANCE_METERS,
        CURRENT_TIMESTAMP() AS CALCULATED_AT
    FROM ' || raw_table || ' r,
        LATERAL FLATTEN(input => r.MATRIX_RESULT:durations[0]) f
    WHERE r.MATRIX_RESULT:durations IS NOT NULL
      AND r.MATRIX_RESULT:durations[0][f.INDEX] IS NOT NULL';

    BEGIN
      EXECUTE IMMEDIATE 'GRANT SELECT ON TABLE ' || target_table || ' TO APPLICATION ROLE app_user';
      EXECUTE IMMEDIATE 'GRANT INSERT ON TABLE ' || target_table || ' TO APPLICATION ROLE app_user';
      EXECUTE IMMEDIATE 'GRANT DELETE ON TABLE ' || target_table || ' TO APPLICATION ROLE app_user';
    EXCEPTION WHEN OTHER THEN NULL;
    END;

    rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || target_table);
    LET c CURSOR FOR rs;
    FOR row_val IN c DO
        row_count := row_val.CNT;
    END FOR;

    RETURN P_RES || ' flatten complete (' || P_REGION || '/' || P_PROFILE || '): ' || row_count || ' travel time pairs';
END;
$$;
GRANT USAGE ON PROCEDURE core.FLATTEN_MATRIX_RAW(VARCHAR, VARCHAR, VARCHAR) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.BUILD_MATRIX_FOR_REGION(P_RES VARCHAR, P_MIN_LAT FLOAT, P_MAX_LAT FLOAT, P_MIN_LON FLOAT, P_MAX_LON FLOAT, P_MATRIX_FN VARCHAR, P_REGION VARCHAR, P_PROFILE VARCHAR)
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
    safe_profile VARCHAR;
    count_sql VARCHAR;
    rs RESULTSET;
    parallel_count INTEGER DEFAULT 4;
    chunk_size INTEGER;
    chunk_start INTEGER;
    chunk_end INTEGER;
BEGIN
    safe_profile := REPLACE(UPPER(P_PROFILE), '-', '_');
    hex_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_LIST_' || P_RES;
    queue_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_WORK_QUEUE_' || P_RES;
    travel_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_MATRIX_' || P_RES;

    CALL core.ENSURE_MATRIX_TABLES(:P_REGION, :P_PROFILE, :P_RES);

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

    CALL core.BUILD_HEXAGONS(:P_RES, :P_MIN_LAT, :P_MAX_LAT, :P_MIN_LON, :P_MAX_LON, :P_REGION, :P_PROFILE);

    count_sql := 'SELECT COUNT(*) AS CNT FROM ' || hex_table;
    rs := (EXECUTE IMMEDIATE :count_sql);
    LET c2 CURSOR FOR rs;
    FOR r IN c2 DO hex_count := r.CNT; END FOR;

    CALL core.BUILD_WORK_QUEUE(:P_RES, :P_REGION, :P_PROFILE);

    count_sql := 'SELECT COUNT(*) AS CNT FROM ' || queue_table;
    rs := (EXECUTE IMMEDIATE :count_sql);
    LET c4 CURSOR FOR rs;
    FOR r IN c4 DO queue_count := r.CNT; END FOR;

    chunk_size := GREATEST(CEIL(queue_count / parallel_count), 1);
    chunk_start := 1;

    WHILE (chunk_start <= queue_count) DO
        chunk_end := LEAST(chunk_start + chunk_size - 1, queue_count);
        ASYNC (CALL core.BUILD_TRAVEL_TIME_RANGE_REGION(:P_RES, :chunk_start, :chunk_end, :P_MATRIX_FN, :P_REGION, :P_PROFILE));
        chunk_start := chunk_end + 1;
    END WHILE;
    AWAIT ALL;

    EXECUTE IMMEDIATE 'CALL core.FLATTEN_MATRIX_RAW(''' || P_RES || ''', ''' || P_REGION || ''', ''' || P_PROFILE || ''')';

    count_sql := 'SELECT COUNT(*) AS CNT FROM ' || travel_table;
    rs := (EXECUTE IMMEDIATE :count_sql);
    LET c5 CURSOR FOR rs;
    FOR r IN c5 DO travel_count := r.CNT; END FOR;

    RETURN P_RES || ' complete (' || P_MATRIX_FN || ', ' || P_PROFILE || '): ' || hex_count || ' hexagons, ' ||
           queue_count || ' origins, ' || travel_count || ' travel times (' || parallel_count || ' parallel workers)';
END;
$$;
GRANT USAGE ON PROCEDURE core.BUILD_MATRIX_FOR_REGION(VARCHAR, FLOAT, FLOAT, FLOAT, FLOAT, VARCHAR, VARCHAR, VARCHAR) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.MATRIX_PROGRESS(P_REGION VARCHAR, P_PROFILE VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    result VARCHAR;
    rs RESULTSET;
BEGIN
    rs := (
        SELECT COALESCE(OBJECT_AGG(
            RESOLUTION,
            OBJECT_CONSTRUCT(
                'stage', CASE STATUS WHEN 'COMPLETE' THEN 'COMPLETE' WHEN 'ERROR' THEN 'ERROR' ELSE STAGE END,
                'hexagons', HEXAGONS,
                'work_queue', WORK_QUEUE_ROWS,
                'raw_ingested', RAW_ROWS,
                'flattened', MATRIX_ROWS,
                'pct', PCT_COMPLETE,
                'status', STATUS,
                'error', COALESCE(ERROR_MSG, '')
            )
        ), OBJECT_CONSTRUCT())::VARCHAR AS OBJ
        FROM travel_matrix.MATRIX_BUILD_JOBS
        WHERE UPPER(REGION) = UPPER(:P_REGION)
          AND UPPER(REPLACE(PROFILE, '-', '_')) = UPPER(REPLACE(:P_PROFILE, '-', '_'))
          AND STATUS IN ('RUNNING', 'COMPLETE', 'ERROR')
          AND CREATED_AT > DATEADD('day', -30, CURRENT_TIMESTAMP())
    );
    LET c CURSOR FOR rs;
    FOR row_val IN c DO result := row_val.OBJ; END FOR;
    RETURN COALESCE(result, '{}');
END;
$$;
GRANT USAGE ON PROCEDURE core.MATRIX_PROGRESS(VARCHAR, VARCHAR) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.RESET_MATRIX_DATA(P_REGION VARCHAR, P_PROFILE VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    safe_profile VARCHAR;
    prefix VARCHAR;
    res_num INTEGER;
    res_label VARCHAR;
BEGIN
    safe_profile := REPLACE(UPPER(P_PROFILE), '-', '_');
    prefix := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile;

    FOR res_num IN 5 TO 10 DO
        res_label := 'RES' || res_num::VARCHAR;
        BEGIN EXECUTE IMMEDIATE 'DROP TABLE IF EXISTS ' || prefix || '_LIST_' || res_label; EXCEPTION WHEN OTHER THEN NULL; END;
        BEGIN EXECUTE IMMEDIATE 'DROP TABLE IF EXISTS ' || prefix || '_WORK_QUEUE_' || res_label; EXCEPTION WHEN OTHER THEN NULL; END;
        BEGIN EXECUTE IMMEDIATE 'DROP TABLE IF EXISTS ' || prefix || '_MATRIX_RAW_' || res_label; EXCEPTION WHEN OTHER THEN NULL; END;
        BEGIN EXECUTE IMMEDIATE 'DROP TABLE IF EXISTS ' || prefix || '_MATRIX_' || res_label; EXCEPTION WHEN OTHER THEN NULL; END;
    END FOR;

    DELETE FROM travel_matrix.MATRIX_BUILD_JOBS
    WHERE UPPER(REGION) = UPPER(:P_REGION)
      AND UPPER(REPLACE(PROFILE, '-', '_')) = :safe_profile;

    RETURN 'Matrix tables dropped for ' || P_REGION || '/' || P_PROFILE;
END;
$$;
GRANT USAGE ON PROCEDURE core.RESET_MATRIX_DATA(VARCHAR, VARCHAR) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.BUILD_MATRIX_JOB_WRAPPER(P_JOB_ID VARCHAR, P_RES VARCHAR, P_MIN_LAT FLOAT, P_MAX_LAT FLOAT, P_MIN_LON FLOAT, P_MAX_LON FLOAT, P_MATRIX_FN VARCHAR, P_REGION VARCHAR, P_PROFILE VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    safe_profile VARCHAR;
    prefix VARCHAR;
    hex_count INTEGER DEFAULT 0;
    queue_count INTEGER DEFAULT 0;
    raw_count INTEGER DEFAULT 0;
    matrix_count INTEGER DEFAULT 0;
    valid_count INTEGER DEFAULT 0;
    error_count INTEGER DEFAULT 0;
    sample_error VARCHAR DEFAULT '';
    rs RESULTSET;
    wait_attempt INTEGER DEFAULT 0;
    max_wait_attempts INTEGER DEFAULT 20;
    profile_ready BOOLEAN DEFAULT FALSE;
    status_json VARIANT;
BEGIN
    safe_profile := REPLACE(UPPER(P_PROFILE), '-', '_');
    prefix := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile;

    UPDATE travel_matrix.MATRIX_BUILD_JOBS
    SET STATUS='RUNNING', STAGE='HEXAGONS', STARTED_AT=CURRENT_TIMESTAMP()
    WHERE JOB_ID = :P_JOB_ID;

    CALL core.ENSURE_MATRIX_TABLES(:P_REGION, :P_PROFILE, :P_RES);

    BEGIN
        ALTER SERVICE IF EXISTS core.routing_gateway_service RESUME;
    EXCEPTION WHEN OTHER THEN NULL;
    END;
    BEGIN
        EXECUTE IMMEDIATE 'ALTER SERVICE IF EXISTS core.ORS_SERVICE_' || UPPER(P_REGION) || ' RESUME';
    EXCEPTION WHEN OTHER THEN
        BEGIN ALTER SERVICE IF EXISTS core.ors_service RESUME; EXCEPTION WHEN OTHER THEN NULL; END;
    END;

    EXECUTE IMMEDIATE 'UPDATE travel_matrix.MATRIX_BUILD_JOBS SET MESSAGE=''Waiting for ORS profile ' || P_PROFILE || ' to become ready...'' WHERE JOB_ID=''' || P_JOB_ID || '''';

    WHILE (wait_attempt < max_wait_attempts AND NOT profile_ready) DO
        EXECUTE IMMEDIATE 'SELECT SYSTEM$WAIT(15)';
        wait_attempt := wait_attempt + 1;
        BEGIN
            LET is_default BOOLEAN := (UPPER(P_REGION) IN ('DEFAULT', 'SAN_FRANCISCO'));
            IF (is_default) THEN
                rs := (SELECT PARSE_JSON(TO_VARCHAR(core.ORS_STATUS())) AS S);
            ELSE
                rs := (EXECUTE IMMEDIATE 'SELECT PARSE_JSON(TO_VARCHAR(core.ORS_STATUS(''' || P_REGION || '''))) AS S');
            END IF;
            LET cs CURSOR FOR rs;
            FOR r IN cs DO
                status_json := r.S;
            END FOR;
            IF (status_json:profiles IS NOT NULL AND status_json:profiles[P_PROFILE] IS NOT NULL) THEN
                profile_ready := TRUE;
            END IF;
        EXCEPTION WHEN OTHER THEN NULL;
        END;
    END WHILE;

    LET wait_secs INTEGER := wait_attempt * 15;

    IF (NOT profile_ready) THEN
        EXECUTE IMMEDIATE 'UPDATE travel_matrix.MATRIX_BUILD_JOBS SET STATUS=''ERROR'', ERROR_MSG=''ORS profile ' || P_PROFILE || ' not ready after ' || wait_secs || ' seconds. Service may need more time to load graphs.'', COMPLETED_AT=CURRENT_TIMESTAMP() WHERE JOB_ID=''' || P_JOB_ID || '''';
        RETURN 'Job ' || :P_JOB_ID || ' failed: profile ' || :P_PROFILE || ' not ready';
    END IF;

    EXECUTE IMMEDIATE 'UPDATE travel_matrix.MATRIX_BUILD_JOBS SET MESSAGE=''ORS profile ' || P_PROFILE || ' ready after ' || wait_secs || 's'' WHERE JOB_ID=''' || P_JOB_ID || '''';

    CALL core.BUILD_HEXAGONS(:P_RES, :P_MIN_LAT, :P_MAX_LAT, :P_MIN_LON, :P_MAX_LON, :P_REGION, :P_PROFILE);

    rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || prefix || '_LIST_' || P_RES);
    LET c1 CURSOR FOR rs; FOR r IN c1 DO hex_count := r.CNT; END FOR;
    UPDATE travel_matrix.MATRIX_BUILD_JOBS
    SET STAGE='WORK_QUEUE', HEXAGONS=:hex_count
    WHERE JOB_ID = :P_JOB_ID;

    CALL core.BUILD_WORK_QUEUE(:P_RES, :P_REGION, :P_PROFILE);

    rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || prefix || '_WORK_QUEUE_' || P_RES);
    LET c2 CURSOR FOR rs; FOR r IN c2 DO queue_count := r.CNT; END FOR;
    UPDATE travel_matrix.MATRIX_BUILD_JOBS
    SET STAGE='BUILDING', WORK_QUEUE_ROWS=:queue_count
    WHERE JOB_ID = :P_JOB_ID;

    LET parallel_count INTEGER := 4;
    LET chunk_size INTEGER := GREATEST(CEIL(queue_count / parallel_count), 1);
    LET chunk_start INTEGER := 1;
    LET chunk_end INTEGER;

    WHILE (chunk_start <= queue_count) DO
        chunk_end := LEAST(chunk_start + chunk_size - 1, queue_count);
        ASYNC (CALL core.BUILD_TRAVEL_TIME_RANGE_REGION(:P_RES, :chunk_start, :chunk_end, :P_MATRIX_FN, :P_REGION, :P_PROFILE));
        chunk_start := chunk_end + 1;
    END WHILE;
    AWAIT ALL;

    rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || prefix || '_MATRIX_RAW_' || P_RES);
    LET c3 CURSOR FOR rs; FOR r IN c3 DO raw_count := r.CNT; END FOR;

    rs := (EXECUTE IMMEDIATE '
        SELECT
            COUNT(CASE WHEN MATRIX_RESULT:durations IS NOT NULL THEN 1 END) AS VALID_CNT,
            COUNT(CASE WHEN MATRIX_RESULT:durations IS NULL THEN 1 END) AS ERROR_CNT
        FROM ' || prefix || '_MATRIX_RAW_' || P_RES);
    LET c3b CURSOR FOR rs;
    FOR r IN c3b DO
        valid_count := r.VALID_CNT;
        error_count := r.ERROR_CNT;
    END FOR;

    IF (error_count > 0 AND valid_count = 0) THEN
        rs := (EXECUTE IMMEDIATE '
            SELECT COALESCE(
                MATRIX_RESULT:error:message::VARCHAR,
                MATRIX_RESULT:metadata:engine:build_date::VARCHAR,
                LEFT(MATRIX_RESULT::VARCHAR, 200)
            ) AS ERR FROM ' || prefix || '_MATRIX_RAW_' || P_RES || ' LIMIT 1');
        LET c3c CURSOR FOR rs;
        FOR r IN c3c DO sample_error := r.ERR; END FOR;
        UPDATE travel_matrix.MATRIX_BUILD_JOBS
        SET STATUS='ERROR', STAGE='BUILDING',
            ERROR_MSG='ORS returned errors for all ' || :raw_count || ' origins. Sample: ' || :sample_error,
            RAW_ROWS=:raw_count, COMPLETED_AT=CURRENT_TIMESTAMP()
        WHERE JOB_ID = :P_JOB_ID;
        RETURN 'Job ' || :P_JOB_ID || ' failed: all ' || raw_count || ' ORS responses were errors';
    END IF;

    IF (error_count > 0) THEN
        UPDATE travel_matrix.MATRIX_BUILD_JOBS
        SET ERROR_MSG='Warning: ' || :error_count || ' of ' || :raw_count || ' origins returned ORS errors'
        WHERE JOB_ID = :P_JOB_ID;
    END IF;

    UPDATE travel_matrix.MATRIX_BUILD_JOBS
    SET STAGE='FLATTENING', RAW_ROWS=:raw_count, PCT_COMPLETE=100
    WHERE JOB_ID = :P_JOB_ID;

    EXECUTE IMMEDIATE 'CALL core.FLATTEN_MATRIX_RAW(''' || P_RES || ''', ''' || P_REGION || ''', ''' || P_PROFILE || ''')';

    rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || prefix || '_MATRIX_' || P_RES);
    LET c4 CURSOR FOR rs; FOR r IN c4 DO matrix_count := r.CNT; END FOR;

    IF (matrix_count = 0 AND raw_count > 0) THEN
        UPDATE travel_matrix.MATRIX_BUILD_JOBS
        SET STATUS='ERROR', STAGE='FLATTENING',
            ERROR_MSG='Flatten produced 0 pairs from ' || :raw_count || ' RAW rows (valid=' || :valid_count || ', errors=' || :error_count || ')',
            RAW_ROWS=:raw_count, COMPLETED_AT=CURRENT_TIMESTAMP()
        WHERE JOB_ID = :P_JOB_ID;
        RETURN 'Job ' || :P_JOB_ID || ' failed: 0 pairs after flatten';
    END IF;

    UPDATE travel_matrix.MATRIX_BUILD_JOBS
    SET STATUS='COMPLETE', STAGE='COMPLETE', MATRIX_ROWS=:matrix_count,
        RAW_ROWS=:raw_count, PCT_COMPLETE=100, COMPLETED_AT=CURRENT_TIMESTAMP()
    WHERE JOB_ID = :P_JOB_ID;

    BEGIN EXECUTE IMMEDIATE 'DROP TABLE IF EXISTS ' || prefix || '_LIST_' || P_RES; EXCEPTION WHEN OTHER THEN NULL; END;
    BEGIN EXECUTE IMMEDIATE 'DROP TABLE IF EXISTS ' || prefix || '_WORK_QUEUE_' || P_RES; EXCEPTION WHEN OTHER THEN NULL; END;
    BEGIN EXECUTE IMMEDIATE 'DROP TABLE IF EXISTS ' || prefix || '_MATRIX_RAW_' || P_RES; EXCEPTION WHEN OTHER THEN NULL; END;

    RETURN 'Job ' || :P_JOB_ID || ' complete: ' || matrix_count || ' travel time pairs';
EXCEPTION
    WHEN OTHER THEN
        LET err_msg VARCHAR := SQLERRM;
        UPDATE travel_matrix.MATRIX_BUILD_JOBS
        SET STATUS='ERROR', ERROR_MSG=:err_msg, COMPLETED_AT=CURRENT_TIMESTAMP()
        WHERE JOB_ID = :P_JOB_ID;
        RETURN 'Job ' || :P_JOB_ID || ' failed: ' || :err_msg;
END;
$$;
GRANT USAGE ON PROCEDURE core.BUILD_MATRIX_JOB_WRAPPER(VARCHAR, VARCHAR, FLOAT, FLOAT, FLOAT, FLOAT, VARCHAR, VARCHAR, VARCHAR) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.GET_BUILD_STATUS()
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    result VARCHAR DEFAULT '[]';
    rs RESULTSET;
BEGIN
    rs := (
        SELECT COALESCE(ARRAY_AGG(OBJECT_CONSTRUCT(
            'job_id', JOB_ID,
            'region', REGION,
            'profile', PROFILE,
            'resolution', RESOLUTION,
            'status', STATUS,
            'stage', STAGE,
            'hexagons', HEXAGONS,
            'work_queue_rows', WORK_QUEUE_ROWS,
            'raw_rows', RAW_ROWS,
            'matrix_rows', MATRIX_ROWS,
            'pct_complete', PCT_COMPLETE,
            'error_msg', COALESCE(ERROR_MSG, ''),
            'created_at', COALESCE(TO_VARCHAR(CONVERT_TIMEZONE('America/Los_Angeles', 'UTC', CREATED_AT), 'YYYY-MM-DD"T"HH24:MI:SS') || 'Z', ''),
            'started_at', COALESCE(TO_VARCHAR(CONVERT_TIMEZONE('America/Los_Angeles', 'UTC', STARTED_AT), 'YYYY-MM-DD"T"HH24:MI:SS') || 'Z', ''),
            'completed_at', COALESCE(TO_VARCHAR(CONVERT_TIMEZONE('America/Los_Angeles', 'UTC', COMPLETED_AT), 'YYYY-MM-DD"T"HH24:MI:SS') || 'Z', ''),
            'statement_handle', COALESCE(STATEMENT_HANDLE, '')
        )), ARRAY_CONSTRUCT())::VARCHAR AS ARR
        FROM travel_matrix.MATRIX_BUILD_JOBS
        WHERE CREATED_AT > DATEADD('day', -30, CURRENT_TIMESTAMP())
        ORDER BY CREATED_AT DESC
    );
    LET c CURSOR FOR rs;
    FOR row_val IN c DO result := row_val.ARR; END FOR;
    RETURN COALESCE(result, '[]');
END;
$$;
GRANT USAGE ON PROCEDURE core.GET_BUILD_STATUS() TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.GET_MATRIX_INVENTORY()
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    result VARCHAR DEFAULT '[]';
    rs RESULTSET;
BEGIN
    rs := (
        SELECT COALESCE(ARRAY_AGG(OBJECT_CONSTRUCT(
            'table_name', t.TABLE_NAME,
            'row_count', t.ROW_COUNT,
            'created', COALESCE(TO_VARCHAR(CONVERT_TIMEZONE('America/Los_Angeles', 'UTC', t.CREATED), 'YYYY-MM-DD"T"HH24:MI:SS') || 'Z', ''),
            'bytes', t.BYTES,
            'execution_time_secs', COALESCE(DATEDIFF('SECOND', j.STARTED_AT, j.COMPLETED_AT), 0)
        )), ARRAY_CONSTRUCT())::VARCHAR AS ARR
        FROM INFORMATION_SCHEMA.TABLES t
        LEFT JOIN (
            SELECT REGION, PROFILE, RESOLUTION, STARTED_AT, COMPLETED_AT,
                   ROW_NUMBER() OVER (PARTITION BY REGION, PROFILE, RESOLUTION ORDER BY COMPLETED_AT DESC) AS RN
            FROM TRAVEL_MATRIX.MATRIX_BUILD_JOBS
            WHERE STATUS = 'COMPLETE'
        ) j
          ON j.RN = 1
          AND t.TABLE_NAME = UPPER(j.REGION) || '_' || REPLACE(UPPER(j.PROFILE), '-', '_') || '_MATRIX_' || j.RESOLUTION
        WHERE t.TABLE_SCHEMA = 'TRAVEL_MATRIX'
          AND t.TABLE_NAME LIKE '%\\_MATRIX\\_%' ESCAPE '\\'
          AND t.TABLE_NAME NOT LIKE '%\\_MATRIX\\_RAW\\_%' ESCAPE '\\'
          AND t.TABLE_NAME != 'MATRIX_BUILD_JOBS'
        ORDER BY t.TABLE_NAME
    );
    LET c CURSOR FOR rs;
    FOR row_val IN c DO result := row_val.ARR; END FOR;
    RETURN COALESCE(result, '[]');
END;
$$;
GRANT USAGE ON PROCEDURE core.GET_MATRIX_INVENTORY() TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.DELETE_MATRIX_CONFIG(P_REGION VARCHAR, P_PROFILE VARCHAR, P_RES VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    safe_profile VARCHAR;
    prefix VARCHAR;
BEGIN
    safe_profile := REPLACE(UPPER(P_PROFILE), '-', '_');
    prefix := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile;

    BEGIN EXECUTE IMMEDIATE 'DROP TABLE IF EXISTS ' || prefix || '_LIST_' || P_RES; EXCEPTION WHEN OTHER THEN NULL; END;
    BEGIN EXECUTE IMMEDIATE 'DROP TABLE IF EXISTS ' || prefix || '_WORK_QUEUE_' || P_RES; EXCEPTION WHEN OTHER THEN NULL; END;
    BEGIN EXECUTE IMMEDIATE 'DROP TABLE IF EXISTS ' || prefix || '_MATRIX_RAW_' || P_RES; EXCEPTION WHEN OTHER THEN NULL; END;
    BEGIN EXECUTE IMMEDIATE 'DROP TABLE IF EXISTS ' || prefix || '_MATRIX_' || P_RES; EXCEPTION WHEN OTHER THEN NULL; END;

    DELETE FROM travel_matrix.MATRIX_BUILD_JOBS
    WHERE UPPER(REGION) = UPPER(:P_REGION)
      AND UPPER(REPLACE(PROFILE, '-', '_')) = :safe_profile
      AND UPPER(RESOLUTION) = UPPER(:P_RES);

    RETURN 'Deleted: ' || P_REGION || '/' || P_PROFILE || '/' || P_RES;
END;
$$;
GRANT USAGE ON PROCEDURE core.DELETE_MATRIX_CONFIG(VARCHAR, VARCHAR, VARCHAR) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.CANCEL_MATRIX_BUILD(P_JOB_ID VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    handle VARCHAR;
    rs RESULTSET;
BEGIN
    rs := (SELECT STATEMENT_HANDLE FROM travel_matrix.MATRIX_BUILD_JOBS WHERE JOB_ID = :P_JOB_ID AND STATUS = 'RUNNING');
    LET c CURSOR FOR rs;
    FOR row_val IN c DO handle := row_val.STATEMENT_HANDLE; END FOR;

    UPDATE travel_matrix.MATRIX_BUILD_JOBS
    SET STATUS='CANCELLED', COMPLETED_AT=CURRENT_TIMESTAMP()
    WHERE JOB_ID = :P_JOB_ID;

    RETURN OBJECT_CONSTRUCT('cancelled', TRUE, 'job_id', :P_JOB_ID, 'statement_handle', handle)::VARCHAR;
END;
$$;
GRANT USAGE ON PROCEDURE core.CANCEL_MATRIX_BUILD(VARCHAR) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.RESTORE_MATRIX_DATA(P_REGION VARCHAR, P_PROFILE VARCHAR, P_RES VARCHAR, P_OFFSET_SECONDS INTEGER DEFAULT 300)
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    safe_profile VARCHAR;
    matrix_table VARCHAR;
    current_count INTEGER DEFAULT 0;
    restored_count INTEGER DEFAULT 0;
    rs RESULTSET;
BEGIN
    safe_profile := REPLACE(UPPER(P_PROFILE), '-', '_');
    matrix_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_MATRIX_' || P_RES;

    BEGIN
        rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || matrix_table);
        LET c1 CURSOR FOR rs; FOR r IN c1 DO current_count := r.CNT; END FOR;
    EXCEPTION WHEN OTHER THEN
        RETURN OBJECT_CONSTRUCT('status', 'error', 'message', 'Table does not exist: ' || matrix_table)::VARCHAR;
    END;

    IF (current_count > 0) THEN
        RETURN OBJECT_CONSTRUCT(
            'status', 'skipped',
            'message', 'Table already has data',
            'table', matrix_table,
            'current_rows', current_count
        )::VARCHAR;
    END IF;

    BEGIN
        EXECUTE IMMEDIATE '
        INSERT INTO ' || matrix_table || ' (ORIGIN_H3, DEST_H3, TRAVEL_TIME_SECONDS, TRAVEL_DISTANCE_METERS, CALCULATED_AT)
        SELECT ORIGIN_H3, DEST_H3, TRAVEL_TIME_SECONDS, TRAVEL_DISTANCE_METERS, CALCULATED_AT
        FROM ' || matrix_table || ' AT(OFFSET => -' || P_OFFSET_SECONDS || ')';
    EXCEPTION WHEN OTHER THEN
        RETURN OBJECT_CONSTRUCT(
            'status', 'error',
            'message', 'Time Travel restore failed: ' || SQLERRM,
            'table', matrix_table,
            'offset_seconds', P_OFFSET_SECONDS
        )::VARCHAR;
    END;

    rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || matrix_table);
    LET c2 CURSOR FOR rs; FOR r IN c2 DO restored_count := r.CNT; END FOR;

    RETURN OBJECT_CONSTRUCT(
        'status', 'restored',
        'table', matrix_table,
        'restored_rows', restored_count,
        'offset_seconds', P_OFFSET_SECONDS
    )::VARCHAR;
END;
$$;
GRANT USAGE ON PROCEDURE core.RESTORE_MATRIX_DATA(VARCHAR, VARCHAR, VARCHAR, INTEGER) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.GET_LIVE_TABLE_COUNT(P_REGION VARCHAR, P_PROFILE VARCHAR, P_RES VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    safe_profile VARCHAR;
    prefix VARCHAR;
    hex_cnt INTEGER DEFAULT 0;
    queue_cnt INTEGER DEFAULT 0;
    raw_cnt INTEGER DEFAULT 0;
    flat_cnt INTEGER DEFAULT 0;
    rs RESULTSET;
BEGIN
    safe_profile := REPLACE(UPPER(P_PROFILE), '-', '_');
    prefix := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile;

    BEGIN rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || prefix || '_LIST_' || P_RES);
    LET c1 CURSOR FOR rs; FOR r IN c1 DO hex_cnt := r.CNT; END FOR;
    EXCEPTION WHEN OTHER THEN hex_cnt := 0; END;

    BEGIN rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || prefix || '_WORK_QUEUE_' || P_RES);
    LET c2 CURSOR FOR rs; FOR r IN c2 DO queue_cnt := r.CNT; END FOR;
    EXCEPTION WHEN OTHER THEN queue_cnt := 0; END;

    BEGIN rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || prefix || '_MATRIX_RAW_' || P_RES);
    LET c3 CURSOR FOR rs; FOR r IN c3 DO raw_cnt := r.CNT; END FOR;
    EXCEPTION WHEN OTHER THEN raw_cnt := 0; END;

    BEGIN rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || prefix || '_MATRIX_' || P_RES);
    LET c4 CURSOR FOR rs; FOR r IN c4 DO flat_cnt := r.CNT; END FOR;
    EXCEPTION WHEN OTHER THEN flat_cnt := 0; END;

    RETURN OBJECT_CONSTRUCT(
        'hexagons', hex_cnt, 'work_queue', queue_cnt,
        'raw_ingested', raw_cnt, 'flattened', flat_cnt
    )::VARCHAR;
END;
$$;
GRANT USAGE ON PROCEDURE core.GET_LIVE_TABLE_COUNT(VARCHAR, VARCHAR, VARCHAR) TO APPLICATION ROLE app_user;

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

    DROP SERVICE IF EXISTS core.ors_control_app;

    BEGIN
        CREATE SERVICE core.ors_control_app
            IN COMPUTE POOL IDENTIFIER(:pool_name)
            FROM SPECIFICATION_FILE='services/ors_control_app/ors_control_app_service.yaml'
            MIN_INSTANCES = 1
            MAX_INSTANCES = 1
            AUTO_SUSPEND_SECS = 0
            EXTERNAL_ACCESS_INTEGRATIONS = (reference('external_access_carto_ref'));
    EXCEPTION
        WHEN OTHER THEN
            CREATE SERVICE core.ors_control_app
                IN COMPUTE POOL IDENTIFIER(:pool_name)
                FROM SPECIFICATION_FILE='services/ors_control_app/ors_control_app_service.yaml'
                MIN_INSTANCES = 1
                MAX_INSTANCES = 1
                AUTO_SUSPEND_SECS = 0;
    END;

    GRANT USAGE ON SERVICE core.ors_control_app TO APPLICATION ROLE app_user;
    GRANT SERVICE ROLE core.ors_control_app!ALL_ENDPOINTS_USAGE TO APPLICATION ROLE app_user;
    GRANT OPERATE ON SERVICE core.ors_control_app TO APPLICATION ROLE app_user;
    GRANT MONITOR ON SERVICE core.ors_control_app TO APPLICATION ROLE app_user;

    BEGIN
        ALTER SERVICE core.ors_control_app SET QUERY_WAREHOUSE = ROUTING_ANALYTICS;
    EXCEPTION
        WHEN OTHER THEN NULL;
    END;

    RETURN 'ORS Control App service created';
END;
$$;
GRANT USAGE ON PROCEDURE core.create_control_app() TO APPLICATION ROLE app_user;

CREATE OR REPLACE STREAMLIT core.control_app
     FROM '/streamlit'
     MAIN_FILE = '/app.py'
     COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"ui"}}';

GRANT USAGE ON STREAMLIT core.control_app TO APPLICATION ROLE app_user;