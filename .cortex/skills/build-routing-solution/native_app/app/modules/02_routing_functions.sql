CREATE OR REPLACE PROCEDURE core.create_functions()
RETURNS string
LANGUAGE sql
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"2.0","attributes":{"component":"routing"}}'
AS
$$
BEGIN
   BEGIN
     CALL core.cleanup_legacy_functions();
   EXCEPTION
     WHEN OTHER THEN NULL;
   END;

   -- ===== INTERNAL _RAW SERVICE FUNCTIONS (not granted to app_user) =====
   -- These are scalar VARIANT functions that call the gateway.
   -- Region is always the LAST parameter, passed as the last column in the batch row.

   CREATE OR REPLACE FUNCTION core._DIRECTIONS_TABULAR_RAW(method VARCHAR, jstart ARRAY, jend ARRAY, region VARCHAR)
      RETURNS VARIANT
      SERVICE=core.routing_gateway_service
      ENDPOINT='gateway'
      MAX_BATCH_ROWS = 1000
      AS '/directions_tabular';

   CREATE OR REPLACE FUNCTION core._DIRECTIONS_RAW(method VARCHAR, locations VARIANT, region VARCHAR)
      RETURNS VARIANT
      SERVICE=core.routing_gateway_service
      ENDPOINT='gateway'
      MAX_BATCH_ROWS = 1000
      AS '/directions';

   CREATE OR REPLACE FUNCTION core._ISOCHRONES_RAW(method TEXT, lon FLOAT, lat FLOAT, range INT, region VARCHAR)
      RETURNS VARIANT
      SERVICE=core.routing_gateway_service
      ENDPOINT='gateway'
      MAX_BATCH_ROWS = 1000
      AS '/isochrones_tabular';

   CREATE OR REPLACE FUNCTION core._OPTIMIZATION_TABULAR_RAW(jobs ARRAY, vehicles ARRAY, matrices ARRAY, region VARCHAR)
      RETURNS VARIANT
      SERVICE=core.routing_gateway_service
      ENDPOINT='gateway'
      MAX_BATCH_ROWS = 1000
      AS '/optimization_tabular';

   CREATE OR REPLACE FUNCTION core._OPTIMIZATION_RAW(challenge VARIANT, region VARCHAR)
      RETURNS VARIANT
      SERVICE=core.routing_gateway_service
      ENDPOINT='gateway'
      MAX_BATCH_ROWS = 1000
      AS '/optimization';

   CREATE OR REPLACE FUNCTION core._ORS_STATUS_RAW(region VARCHAR)
      RETURNS VARIANT
      SERVICE=core.routing_gateway_service
      ENDPOINT='gateway'
      MAX_BATCH_ROWS = 1
      AS '/ors_status';

   CREATE OR REPLACE FUNCTION core._MATRIX_TABULAR_RAW(method VARCHAR, origin ARRAY, destinations ARRAY, region VARCHAR)
      RETURNS VARIANT
      SERVICE=core.routing_gateway_service
      ENDPOINT='gateway'
      MAX_BATCH_ROWS = 1000
      AS '/matrix_tabular';

   CREATE OR REPLACE FUNCTION core._MATRIX_RAW(method VARCHAR, options VARIANT, region VARCHAR)
      RETURNS VARIANT
      SERVICE=core.routing_gateway_service
      ENDPOINT='gateway'
      MAX_BATCH_ROWS = 100
      AS '/matrix';

   -- ===== PUBLIC TABLE FUNCTIONS (granted to app_user) =====
   -- These wrap _RAW internals and parse GEOGRAPHY columns.
   -- Region uses DEFAULT NULL so callers can omit it for default routing.

   -- DIRECTIONS (tabular: start/end arrays)
   CREATE OR REPLACE FUNCTION core.DIRECTIONS(method VARCHAR, jstart ARRAY, jend ARRAY, region VARCHAR DEFAULT NULL)
      RETURNS TABLE (RESPONSE VARIANT, GEOJSON GEOGRAPHY, DISTANCE FLOAT, DURATION FLOAT)
      LANGUAGE SQL
      AS
      'SELECT resp AS RESPONSE,
            TO_GEOGRAPHY(resp:features[0]:geometry) AS GEOJSON,
            resp:features[0]:properties:summary:distance::FLOAT AS DISTANCE,
            resp:features[0]:properties:summary:duration::FLOAT AS DURATION
         FROM (SELECT core._DIRECTIONS_TABULAR_RAW(method, jstart, jend, region) AS resp)';
   GRANT USAGE ON FUNCTION core.DIRECTIONS(VARCHAR, ARRAY, ARRAY, VARCHAR) TO APPLICATION ROLE app_user;

   -- DIRECTIONS (raw: locations variant)
   CREATE OR REPLACE FUNCTION core.DIRECTIONS(method VARCHAR, locations VARIANT, region VARCHAR DEFAULT NULL)
      RETURNS TABLE (RESPONSE VARIANT, GEOJSON GEOGRAPHY, DISTANCE FLOAT, DURATION FLOAT)
      LANGUAGE SQL
      AS
      'SELECT resp AS RESPONSE,
            TO_GEOGRAPHY(resp:features[0]:geometry) AS GEOJSON,
            resp:features[0]:properties:summary:distance::FLOAT AS DISTANCE,
            resp:features[0]:properties:summary:duration::FLOAT AS DURATION
         FROM (SELECT core._DIRECTIONS_RAW(method, locations, region) AS resp)';
   GRANT USAGE ON FUNCTION core.DIRECTIONS(VARCHAR, VARIANT, VARCHAR) TO APPLICATION ROLE app_user;

   -- ISOCHRONES
   CREATE OR REPLACE FUNCTION core.ISOCHRONES(method TEXT, lon FLOAT, lat FLOAT, range INT, region VARCHAR DEFAULT NULL)
      RETURNS TABLE (RESPONSE VARIANT, GEOJSON GEOGRAPHY)
      LANGUAGE SQL
      AS
      'SELECT resp AS RESPONSE,
            TO_GEOGRAPHY(resp:features[0]:geometry) AS GEOJSON
         FROM (SELECT core._ISOCHRONES_RAW(method, lon, lat, range, region) AS resp)';
   GRANT USAGE ON FUNCTION core.ISOCHRONES(TEXT, FLOAT, FLOAT, INT, VARCHAR) TO APPLICATION ROLE app_user;

   -- OPTIMIZATION (tabular: jobs/vehicles/matrices)
   CREATE OR REPLACE FUNCTION core.OPTIMIZATION(jobs ARRAY, vehicles ARRAY, matrices ARRAY DEFAULT [], region VARCHAR DEFAULT NULL)
      RETURNS TABLE (RESPONSE VARIANT, GEOJSON GEOGRAPHY, VEHICLE INT, DURATION INT, STEPS VARIANT)
      LANGUAGE SQL
      AS
      'SELECT resp AS RESPONSE,
            TO_GEOGRAPHY(OBJECT_CONSTRUCT(''type'', ''LineString'', ''coordinates'', f.value:geometry)) AS GEOJSON,
            f.value:vehicle::INT AS VEHICLE,
            f.value:duration::INT AS DURATION,
            f.value:steps::VARIANT AS STEPS
         FROM (SELECT core._OPTIMIZATION_TABULAR_RAW(jobs, vehicles, matrices, region) AS resp),
            LATERAL FLATTEN(input => resp:routes) f';
   GRANT USAGE ON FUNCTION core.OPTIMIZATION(ARRAY, ARRAY, ARRAY, VARCHAR) TO APPLICATION ROLE app_user;

   -- OPTIMIZATION (challenge variant)
   CREATE OR REPLACE FUNCTION core.OPTIMIZATION(challenge VARIANT, region VARCHAR DEFAULT NULL)
      RETURNS TABLE (RESPONSE VARIANT, GEOJSON GEOGRAPHY, VEHICLE INT, DURATION INT, STEPS VARIANT)
      LANGUAGE SQL
      AS
      'SELECT resp AS RESPONSE,
            TO_GEOGRAPHY(OBJECT_CONSTRUCT(''type'', ''LineString'', ''coordinates'', f.value:geometry)) AS GEOJSON,
            f.value:vehicle::INT AS VEHICLE,
            f.value:duration::INT AS DURATION,
            f.value:steps::VARIANT AS STEPS
         FROM (SELECT core._OPTIMIZATION_RAW(challenge, region) AS resp),
            LATERAL FLATTEN(input => resp:routes) f';
   GRANT USAGE ON FUNCTION core.OPTIMIZATION(VARIANT, VARCHAR) TO APPLICATION ROLE app_user;

   -- MATRIX (locations array) - returns VARIANT (no geography to parse)
   CREATE OR REPLACE FUNCTION core.MATRIX(method VARCHAR, locations ARRAY, region VARCHAR DEFAULT NULL)
      RETURNS VARIANT
      LANGUAGE SQL
      AS
      'SELECT core._MATRIX_RAW(method, OBJECT_CONSTRUCT(''locations'', locations, ''metrics'', ARRAY_CONSTRUCT(''distance'', ''duration''), ''resolve_locations'', true), region)';
   GRANT USAGE ON FUNCTION core.MATRIX(VARCHAR, ARRAY, VARCHAR) TO APPLICATION ROLE app_user;

   -- MATRIX (options variant) - returns VARIANT
   CREATE OR REPLACE FUNCTION core.MATRIX(method VARCHAR, options VARIANT, region VARCHAR DEFAULT NULL)
      RETURNS VARIANT
      LANGUAGE SQL
      AS
      'SELECT core._MATRIX_RAW(method, options, region)';
   GRANT USAGE ON FUNCTION core.MATRIX(VARCHAR, VARIANT, VARCHAR) TO APPLICATION ROLE app_user;

   -- MATRIX_TABULAR (origin + destinations) - returns VARIANT
   CREATE OR REPLACE FUNCTION core.MATRIX_TABULAR(method VARCHAR, origin ARRAY, destinations ARRAY, region VARCHAR DEFAULT NULL)
      RETURNS VARIANT
      LANGUAGE SQL
      AS
      'SELECT core._MATRIX_TABULAR_RAW(method, origin, destinations, region)';
   GRANT USAGE ON FUNCTION core.MATRIX_TABULAR(VARCHAR, ARRAY, ARRAY, VARCHAR) TO APPLICATION ROLE app_user;

   -- ORS_STATUS - returns VARIANT
   CREATE OR REPLACE FUNCTION core.ORS_STATUS(region VARCHAR DEFAULT NULL)
      RETURNS VARIANT
      LANGUAGE SQL
      AS
      'SELECT core._ORS_STATUS_RAW(region)';
   GRANT USAGE ON FUNCTION core.ORS_STATUS(VARCHAR) TO APPLICATION ROLE app_user;

   -- ===== UTILITY FUNCTIONS (unchanged) =====

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
   COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"2.0","attributes":{"component":"routing"}}';
   GRANT SELECT ON TABLE core.MAP_CONFIG TO APPLICATION ROLE app_user;
   GRANT INSERT ON TABLE core.MAP_CONFIG TO APPLICATION ROLE app_user;
   GRANT UPDATE ON TABLE core.MAP_CONFIG TO APPLICATION ROLE app_user;
   GRANT DELETE ON TABLE core.MAP_CONFIG TO APPLICATION ROLE app_user;

   CREATE OR REPLACE FUNCTION core.CHECK_HEALTH()
   RETURNS BOOLEAN
   LANGUAGE SQL
   AS
   'SELECT CASE WHEN core._ORS_STATUS_RAW(NULL) IS NOT NULL THEN TRUE ELSE FALSE END';
   GRANT USAGE ON FUNCTION core.CHECK_HEALTH() TO APPLICATION ROLE app_user;

   CREATE OR REPLACE FUNCTION core.LIST_REGIONS()
      RETURNS TABLE (REGION VARCHAR, DISPLAY_NAME VARCHAR, STATUS VARCHAR, MIN_LAT FLOAT, MAX_LAT FLOAT, MIN_LON FLOAT, MAX_LON FLOAT)
      LANGUAGE SQL
      AS
      'SELECT REGION, DISPLAY_NAME, STATUS, MIN_LAT, MAX_LAT, MIN_LON, MAX_LON FROM core.CITY_ORS_MAP';
   GRANT USAGE ON FUNCTION core.LIST_REGIONS() TO APPLICATION ROLE app_user;

   MERGE INTO core.VERSION_INFO t USING (SELECT 'setup_script' AS COMPONENT) s
     ON t.COMPONENT = s.COMPONENT
     WHEN MATCHED THEN UPDATE SET VERSION = '2.0.0', UPDATED_AT = CURRENT_TIMESTAMP()
     WHEN NOT MATCHED THEN INSERT (COMPONENT, VERSION) VALUES ('setup_script', '2.0.0');

   RETURN 'Functions successfully created (v2.0 - consolidated)';
END;
$$;

GRANT USAGE ON PROCEDURE core.create_functions() TO APPLICATION ROLE app_user;
