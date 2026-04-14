   USE SCHEMA OPENROUTESERVICE_APP.CORE;

   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE.DOWNLOAD (folder VARCHAR, filename VARCHAR, URL VARCHAR)
      RETURNS varchar
      SERVICE=OPENROUTESERVICE_APP.CORE.downloader
      ENDPOINT='downloader'
      MAX_BATCH_ROWS = 1000
      AS '/download_to_stage';

   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE._DIRECTIONS_TABULAR_RAW(method VARCHAR, jstart ARRAY, jend ARRAY, region VARCHAR)
      RETURNS VARIANT
      SERVICE=OPENROUTESERVICE_APP.CORE.routing_gateway_service
      ENDPOINT='gateway'
      MAX_BATCH_ROWS = 1000
      AS '/directions_tabular';

   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE._DIRECTIONS_RAW(method VARCHAR, locations VARIANT, region VARCHAR)
      RETURNS VARIANT
      SERVICE=OPENROUTESERVICE_APP.CORE.routing_gateway_service
      ENDPOINT='gateway'
      MAX_BATCH_ROWS = 1000
      AS '/directions';

   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE._ISOCHRONES_RAW(method TEXT, lon FLOAT, lat FLOAT, range INT, region VARCHAR)
      RETURNS VARIANT
      SERVICE=OPENROUTESERVICE_APP.CORE.routing_gateway_service
      ENDPOINT='gateway'
      MAX_BATCH_ROWS = 1000
      AS '/isochrones_tabular';

   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE._OPTIMIZATION_TABULAR_RAW(jobs ARRAY, vehicles ARRAY, matrices ARRAY, region VARCHAR)
      RETURNS VARIANT
      SERVICE=OPENROUTESERVICE_APP.CORE.routing_gateway_service
      ENDPOINT='gateway'
      MAX_BATCH_ROWS = 1000
      AS '/optimization_tabular';

   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE._OPTIMIZATION_RAW(challenge VARIANT, region VARCHAR)
      RETURNS VARIANT
      SERVICE=OPENROUTESERVICE_APP.CORE.routing_gateway_service
      ENDPOINT='gateway'
      MAX_BATCH_ROWS = 1000
      AS '/optimization';

   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE._ORS_STATUS_RAW(region VARCHAR)
      RETURNS VARIANT
      SERVICE=OPENROUTESERVICE_APP.CORE.routing_gateway_service
      ENDPOINT='gateway'
      MAX_BATCH_ROWS = 1
      AS '/ors_status';

   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE._MATRIX_TABULAR_RAW(method VARCHAR, origin ARRAY, destinations ARRAY, region VARCHAR)
      RETURNS VARIANT
      SERVICE=OPENROUTESERVICE_APP.CORE.routing_gateway_service
      ENDPOINT='gateway'
      MAX_BATCH_ROWS = 1000
      AS '/matrix_tabular';

   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE._MATRIX_RAW(method VARCHAR, options VARIANT, region VARCHAR)
      RETURNS VARIANT
      SERVICE=OPENROUTESERVICE_APP.CORE.routing_gateway_service
      ENDPOINT='gateway'
      MAX_BATCH_ROWS = 100
      AS '/matrix';

   -- NOTE: Service functions (SERVICE=...) do not support ALTER FUNCTION SET COMMENT.
   -- They are tracked via the parent procedure's COMMENT and the session query_tag.

   -- ===== PUBLIC TABLE FUNCTIONS (granted to app_user) =====
   -- These wrap _RAW internals and parse GEOGRAPHY columns.
   -- Region uses DEFAULT NULL so callers can omit it for default routing.

   -- DIRECTIONS (tabular: start/end arrays)
   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE.DIRECTIONS(method VARCHAR, jstart ARRAY, jend ARRAY, region VARCHAR DEFAULT NULL)
      RETURNS TABLE (RESPONSE VARIANT, GEOJSON GEOGRAPHY, DISTANCE FLOAT, DURATION FLOAT)
      LANGUAGE SQL
      COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"2.0","attributes":{"component":"routing"}}'
      AS
      'SELECT resp AS RESPONSE,
            TO_GEOGRAPHY(resp:features[0]:geometry) AS GEOJSON,
            resp:features[0]:properties:summary:distance::FLOAT AS DISTANCE,
            resp:features[0]:properties:summary:duration::FLOAT AS DURATION
         FROM (SELECT OPENROUTESERVICE_APP.CORE._DIRECTIONS_TABULAR_RAW(method, jstart, jend, region) AS resp)';

   -- DIRECTIONS (raw: locations variant)
   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE.DIRECTIONS(method VARCHAR, locations VARIANT, region VARCHAR DEFAULT NULL)
      RETURNS TABLE (RESPONSE VARIANT, GEOJSON GEOGRAPHY, DISTANCE FLOAT, DURATION FLOAT)
      LANGUAGE SQL
      COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"2.0","attributes":{"component":"routing"}}'
      AS
      'SELECT resp AS RESPONSE,
            TO_GEOGRAPHY(resp:features[0]:geometry) AS GEOJSON,
            resp:features[0]:properties:summary:distance::FLOAT AS DISTANCE,
            resp:features[0]:properties:summary:duration::FLOAT AS DURATION
         FROM (SELECT OPENROUTESERVICE_APP.CORE._DIRECTIONS_RAW(method, locations, region) AS resp)';

   -- ISOCHRONES
   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE.ISOCHRONES(method TEXT, lon FLOAT, lat FLOAT, range INT, region VARCHAR DEFAULT NULL)
      RETURNS TABLE (RESPONSE VARIANT, GEOJSON GEOGRAPHY)
      LANGUAGE SQL
      COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"2.0","attributes":{"component":"routing"}}'
      AS
      'SELECT resp AS RESPONSE,
            TO_GEOGRAPHY(resp:features[0]:geometry) AS GEOJSON
         FROM (SELECT OPENROUTESERVICE_APP.CORE._ISOCHRONES_RAW(method, lon, lat, range, region) AS resp)';

   -- OPTIMIZATION (tabular: jobs/vehicles/matrices)
   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE.OPTIMIZATION(jobs ARRAY, vehicles ARRAY, matrices ARRAY DEFAULT [], region VARCHAR DEFAULT NULL)
      RETURNS TABLE (RESPONSE VARIANT, GEOJSON GEOGRAPHY, VEHICLE INT, DURATION INT, STEPS VARIANT)
      LANGUAGE SQL
      COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"2.0","attributes":{"component":"routing"}}'
      AS
      'SELECT resp AS RESPONSE,
            TO_GEOGRAPHY(OBJECT_CONSTRUCT(''type'', ''LineString'', ''coordinates'', f.value:geometry)) AS GEOJSON,
            f.value:vehicle::INT AS VEHICLE,
            f.value:duration::INT AS DURATION,
            f.value:steps::VARIANT AS STEPS
         FROM (SELECT OPENROUTESERVICE_APP.CORE._OPTIMIZATION_TABULAR_RAW(jobs, vehicles, matrices, region) AS resp),
            LATERAL FLATTEN(input => resp:routes) f';

   -- OPTIMIZATION (challenge variant)
   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE.OPTIMIZATION(challenge VARIANT, region VARCHAR DEFAULT NULL)
      RETURNS TABLE (RESPONSE VARIANT, GEOJSON GEOGRAPHY, VEHICLE INT, DURATION INT, STEPS VARIANT)
      LANGUAGE SQL
      COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"2.0","attributes":{"component":"routing"}}'
      AS
      'SELECT resp AS RESPONSE,
            TO_GEOGRAPHY(OBJECT_CONSTRUCT(''type'', ''LineString'', ''coordinates'', f.value:geometry)) AS GEOJSON,
            f.value:vehicle::INT AS VEHICLE,
            f.value:duration::INT AS DURATION,
            f.value:steps::VARIANT AS STEPS
         FROM (SELECT OPENROUTESERVICE_APP.CORE._OPTIMIZATION_RAW(challenge, region) AS resp),
            LATERAL FLATTEN(input => resp:routes) f';

   -- MATRIX (locations array) - returns VARIANT (no geography to parse)
   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE.MATRIX(method VARCHAR, locations ARRAY, region VARCHAR DEFAULT NULL)
      RETURNS VARIANT
      LANGUAGE SQL
      COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"2.0","attributes":{"component":"routing"}}'
      AS
      'SELECT OPENROUTESERVICE_APP.CORE._MATRIX_RAW(method, OBJECT_CONSTRUCT(''locations'', locations, ''metrics'', ARRAY_CONSTRUCT(''distance'', ''duration''), ''resolve_locations'', true), region)';

   -- MATRIX (options variant) - returns VARIANT
   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE.MATRIX(method VARCHAR, options VARIANT, region VARCHAR DEFAULT NULL)
      RETURNS VARIANT
      LANGUAGE SQL
      COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"2.0","attributes":{"component":"routing"}}'
      AS
      'SELECT OPENROUTESERVICE_APP.CORE._MATRIX_RAW(method, options, region)';

   -- MATRIX_TABULAR (origin + destinations) - returns VARIANT
   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE.MATRIX_TABULAR(method VARCHAR, origin ARRAY, destinations ARRAY, region VARCHAR DEFAULT NULL)
      RETURNS VARIANT
      LANGUAGE SQL
      COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"2.0","attributes":{"component":"routing"}}'
      AS
      'SELECT OPENROUTESERVICE_APP.CORE._MATRIX_TABULAR_RAW(method, origin, destinations, region)';

   -- ORS_STATUS - returns VARIANT
   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE.ORS_STATUS(region VARCHAR DEFAULT NULL)
      RETURNS VARIANT
      LANGUAGE SQL
      COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"2.0","attributes":{"component":"routing"}}'
      AS
      'SELECT OPENROUTESERVICE_APP.CORE._ORS_STATUS_RAW(region)';

   -- ===== UTILITY FUNCTIONS (unchanged) =====
   CREATE TABLE IF NOT EXISTS OPENROUTESERVICE_APP.CORE.MAP_CONFIG (
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
 
   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE.CHECK_HEALTH()
   RETURNS BOOLEAN
   LANGUAGE SQL
   COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"2.0","attributes":{"component":"routing"}}'
   AS
   'SELECT CASE WHEN OPENROUTESERVICE_APP.CORE._ORS_STATUS_RAW(NULL) IS NOT NULL THEN TRUE ELSE FALSE END';

