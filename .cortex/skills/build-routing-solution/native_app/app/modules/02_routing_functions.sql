CREATE OR REPLACE PROCEDURE core.create_functions()
RETURNS string
LANGUAGE sql
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"routing"}}'
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
      MAX_BATCH_ROWS=50
      AS '/r/matrix_tabular';
   GRANT USAGE ON FUNCTION core.MATRIX(VARCHAR, VARCHAR, ARRAY) TO APPLICATION ROLE app_user;

   CREATE OR REPLACE FUNCTION core.MATRIX(region VARCHAR, method VARCHAR, options VARIANT)
      RETURNS VARIANT
      SERVICE=core.routing_gateway_service
      ENDPOINT='gateway'
      MAX_BATCH_ROWS=50
      AS '/r/matrix';
   GRANT USAGE ON FUNCTION core.MATRIX(VARCHAR, VARCHAR, VARIANT) TO APPLICATION ROLE app_user;

   CREATE OR REPLACE FUNCTION core.MATRIX_TABULAR(region VARCHAR, method VARCHAR, origin ARRAY, destinations ARRAY)
      RETURNS VARIANT
      SERVICE=core.routing_gateway_service
      ENDPOINT='gateway'
      MAX_BATCH_ROWS=50
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
