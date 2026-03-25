CREATE OR REPLACE PROCEDURE core.version_init()
RETURNS STRING
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"core"}}'
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
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"core"}}'
AS
$$
BEGIN
   LET pool_name := (SELECT CURRENT_DATABASE()) || '_compute_pool';

   CREATE COMPUTE POOL IF NOT EXISTS IDENTIFIER(:pool_name)
      INSTANCE_FAMILY = HIGHMEM_X64_S
      MIN_NODES = 1
      MAX_NODES = 5
      AUTO_RESUME = true
      AUTO_SUSPEND_SECS = 600;

   ALTER COMPUTE POOL IDENTIFIER(:pool_name) SET MIN_NODES = 5 MAX_NODES = 5;

   RETURN 'Compute Pool Created Successfully';

END;
$$;
GRANT USAGE ON PROCEDURE core.create_compute_pool() TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.create_stages()
RETURNS string
LANGUAGE sql
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"core"}}'
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
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"core"}}'
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
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"core"}}'
AS
$$
BEGIN
   -- account-level compute pool object prefixed with app name to prevent clashes
   LET pool_name := (SELECT CURRENT_DATABASE()) || '_compute_pool';

   ALTER SERVICE IF EXISTS core.ors_service SET MIN_INSTANCES = 3 MAX_INSTANCES = 3;

   ALTER SERVICE IF EXISTS core.ors_service
      FROM SPECIFICATION_FILE='services/openrouteservice/openrouteservice.yaml';

   ALTER SERVICE IF EXISTS core.vroom_service
      FROM SPECIFICATION_FILE='services/vroom/vroom-service.yaml';

   ALTER SERVICE IF EXISTS core.routing_gateway_service
      FROM SPECIFICATION_FILE='services/gateway/routing-gateway-service.yaml';

   CREATE SERVICE IF NOT EXISTS core.ors_service
      IN COMPUTE POOL identifier(:pool_name)
      FROM spec='services/openrouteservice/openrouteservice.yaml'
      MIN_INSTANCES = 3
      MAX_INSTANCES = 3
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
      MIN_INSTANCES = 3
      MAX_INSTANCES = 3
      AUTO_SUSPEND_SECS = 14400;

   ALTER SERVICE IF EXISTS core.routing_gateway_service SET MIN_INSTANCES = 3 MAX_INSTANCES = 3;

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
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"core"}}'
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
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"core"}}'
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
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"core"}}'
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
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"core"}}'
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
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"core"}}';
GRANT SELECT ON TABLE core.VERSION_INFO TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE core.VERSION_INFO TO APPLICATION ROLE app_user;
GRANT UPDATE ON TABLE core.VERSION_INFO TO APPLICATION ROLE app_user;
GRANT DELETE ON TABLE core.VERSION_INFO TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.grant_callback(privileges array)
RETURNS string
LANGUAGE sql
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"core"}}'
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

CREATE OR REPLACE PROCEDURE core.create_control_app()
RETURNS STRING
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"ui"}}'
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

CREATE OR REPLACE PROCEDURE core.create_demo_dashboard()
RETURNS STRING
LANGUAGE SQL
AS
$$
BEGIN
    LET pool_name VARCHAR := (SELECT CURRENT_DATABASE()) || '_compute_pool';

    DROP SERVICE IF EXISTS core.demo_dashboard;

    BEGIN
        CREATE SERVICE core.demo_dashboard
            IN COMPUTE POOL IDENTIFIER(:pool_name)
            FROM SPECIFICATION_FILE='services/demo_dashboard/demo_dashboard_service.yaml'
            MIN_INSTANCES = 1
            MAX_INSTANCES = 1
            EXTERNAL_ACCESS_INTEGRATIONS = (reference('external_access_carto_ref'));
    EXCEPTION
        WHEN OTHER THEN
            CREATE SERVICE core.demo_dashboard
                IN COMPUTE POOL IDENTIFIER(:pool_name)
                FROM SPECIFICATION_FILE='services/demo_dashboard/demo_dashboard_service.yaml'
                MIN_INSTANCES = 1
                MAX_INSTANCES = 1;
    END;

    GRANT USAGE ON SERVICE core.demo_dashboard TO APPLICATION ROLE app_user;
    GRANT SERVICE ROLE core.demo_dashboard!ALL_ENDPOINTS_USAGE TO APPLICATION ROLE app_user;
    GRANT OPERATE ON SERVICE core.demo_dashboard TO APPLICATION ROLE app_user;
    GRANT MONITOR ON SERVICE core.demo_dashboard TO APPLICATION ROLE app_user;

    BEGIN
        ALTER SERVICE core.demo_dashboard SET QUERY_WAREHOUSE = ROUTING_ANALYTICS;
    EXCEPTION
        WHEN OTHER THEN NULL;
    END;

    RETURN 'Demo dashboard service created';
END;
$$;
GRANT USAGE ON PROCEDURE core.create_demo_dashboard() TO APPLICATION ROLE app_user;

CREATE OR REPLACE STREAMLIT core.control_app
     FROM '/streamlit'
     MAIN_FILE = '/app.py'
     COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"ui"}}';

GRANT USAGE ON STREAMLIT core.control_app TO APPLICATION ROLE app_user;
