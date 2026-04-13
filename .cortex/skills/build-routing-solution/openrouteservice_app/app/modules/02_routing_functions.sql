
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

   -- NOTE: Service functions (SERVICE=...) do not support ALTER FUNCTION SET COMMENT.
   -- They are tracked via the parent procedure's COMMENT and the session query_tag.

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
         FROM (SELECT core._DIRECTIONS_TABULAR_RAW(method, jstart, jend, region) AS resp)'
      COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"2.0","attributes":{"component":"routing"}}';

   -- DIRECTIONS (raw: locations variant)
   CREATE OR REPLACE FUNCTION core.DIRECTIONS(method VARCHAR, locations VARIANT, region VARCHAR DEFAULT NULL)
      RETURNS TABLE (RESPONSE VARIANT, GEOJSON GEOGRAPHY, DISTANCE FLOAT, DURATION FLOAT)
      LANGUAGE SQL
      AS
      'SELECT resp AS RESPONSE,
            TO_GEOGRAPHY(resp:features[0]:geometry) AS GEOJSON,
            resp:features[0]:properties:summary:distance::FLOAT AS DISTANCE,
            resp:features[0]:properties:summary:duration::FLOAT AS DURATION
         FROM (SELECT core._DIRECTIONS_RAW(method, locations, region) AS resp)'
         COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"2.0","attributes":{"component":"routing"}}';

   -- ISOCHRONES
   CREATE OR REPLACE FUNCTION core.ISOCHRONES(method TEXT, lon FLOAT, lat FLOAT, range INT, region VARCHAR DEFAULT NULL)
      RETURNS TABLE (RESPONSE VARIANT, GEOJSON GEOGRAPHY)
      LANGUAGE SQL
      AS
      'SELECT resp AS RESPONSE,
            TO_GEOGRAPHY(resp:features[0]:geometry) AS GEOJSON
         FROM (SELECT core._ISOCHRONES_RAW(method, lon, lat, range, region) AS resp)'
      COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"2.0","attributes":{"component":"routing"}}';

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
            LATERAL FLATTEN(input => resp:routes) f'
            COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"2.0","attributes":{"component":"routing"}}';

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
            LATERAL FLATTEN(input => resp:routes) f'
            COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"2.0","attributes":{"component":"routing"}}';

   -- MATRIX (locations array) - returns VARIANT (no geography to parse)
   CREATE OR REPLACE FUNCTION core.MATRIX(method VARCHAR, locations ARRAY, region VARCHAR DEFAULT NULL)
      RETURNS VARIANT
      LANGUAGE SQL
      AS
      'SELECT core._MATRIX_RAW(method, OBJECT_CONSTRUCT(''locations'', locations, ''metrics'', ARRAY_CONSTRUCT(''distance'', ''duration''), ''resolve_locations'', true), region)'
      COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"2.0","attributes":{"component":"routing"}}';

   -- MATRIX (options variant) - returns VARIANT
   CREATE OR REPLACE FUNCTION core.MATRIX(method VARCHAR, options VARIANT, region VARCHAR DEFAULT NULL)
      RETURNS VARIANT
      LANGUAGE SQL
      AS
      'SELECT core._MATRIX_RAW(method, options, region)'
      COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"2.0","attributes":{"component":"routing"}}';

   -- MATRIX_TABULAR (origin + destinations) - returns VARIANT
   CREATE OR REPLACE FUNCTION core.MATRIX_TABULAR(method VARCHAR, origin ARRAY, destinations ARRAY, region VARCHAR DEFAULT NULL)
      RETURNS VARIANT
      LANGUAGE SQL
      AS
      'SELECT core._MATRIX_TABULAR_RAW(method, origin, destinations, region)'
      COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"2.0","attributes":{"component":"routing"}}';

   -- ORS_STATUS - returns VARIANT
   CREATE OR REPLACE FUNCTION core.ORS_STATUS(region VARCHAR DEFAULT NULL)
      RETURNS VARIANT
      LANGUAGE SQL
      AS
      'SELECT core._ORS_STATUS_RAW(region)'
      COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"2.0","attributes":{"component":"routing"}}';

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
 
   CREATE OR REPLACE FUNCTION core.CHECK_HEALTH()
   RETURNS BOOLEAN
   LANGUAGE SQL
   AS
   'SELECT CASE WHEN core._ORS_STATUS_RAW(NULL) IS NOT NULL THEN TRUE ELSE FALSE END'
   COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"2.0","attributes":{"component":"routing"}}';

