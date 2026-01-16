CREATE APPLICATION ROLE IF NOT EXISTS app_user;
CREATE SCHEMA IF NOT EXISTS core;
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
      MAX_NODES = 1
      AUTO_RESUME = true
      AUTO_SUSPEND_SECS = 600;

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

   ALTER SERVICE IF EXISTS core.ors_service
      FROM SPECIFICATION_FILE='services/openrouteservice/openrouteservice.yaml';

   ALTER SERVICE IF EXISTS core.vroom_service
      FROM SPECIFICATION_FILE='services/vroom/vroom-service.yaml';

   ALTER SERVICE IF EXISTS core.routing_gateway_service
      FROM SPECIFICATION_FILE='services/gateway/routing-gateway-service.yaml';

   CREATE SERVICE IF NOT EXISTS core.ors_service
      IN COMPUTE POOL identifier(:pool_name)
      FROM spec='services/openrouteservice/openrouteservice.yaml'
      MIN_INSTANCES = 1
      MAX_INSTANCES = 1
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
      MIN_INSTANCES = 1
      MAX_INSTANCES = 1
      AUTO_SUSPEND_SECS = 14400;

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
   );
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
      -- Wait untill all graphs are created in the consumer stage (~approx 40 seconds) before completing the procedure
      SELECT SYSTEM$WAIT(40);
   END IF;
   RETURN 'App successfully deployed';
END;
$$;

GRANT USAGE ON PROCEDURE core.grant_callback(array) TO APPLICATION ROLE app_user;

CREATE OR REPLACE STREAMLIT core.control_app
     FROM '/streamlit'
     MAIN_FILE = '/app.py';

GRANT USAGE ON STREAMLIT core.control_app TO APPLICATION ROLE app_user;