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
   --
   -- v1.1.0 — Region semantics:
   --   * Pass an explicit region name (e.g. 'SanFrancisco', 'Berlin') to route
   --     the call to ORS_SERVICE_<REGION> / VROOM_SERVICE_<REGION>.
   --   * Pass NULL or omit the argument to route to the default region. The
   --     gateway resolves it via DEFAULT_REGION_NAME (configured at the gateway
   --     service spec level). After the v1.1.0 unification there is no global
   --     ORS_SERVICE — every region (including the default) is per-region.
   -- DEFAULT NULL is preserved for backward-compat with notebooks / agents that
   -- pre-date the unified model.

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

   -- ISOCHRONES_CLIPPED: same as ISOCHRONES but clips the returned polygon
   -- to the named region's actual boundary so catchment zones don't claim
   -- foreign territory or water. Falls through (no clip) when the catalog
   -- has no boundary for the region.
   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE.ISOCHRONES_CLIPPED(method TEXT, lon FLOAT, lat FLOAT, range INT, region VARCHAR)
      RETURNS TABLE (RESPONSE VARIANT, GEOJSON GEOGRAPHY)
      LANGUAGE SQL
      COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"2.0","attributes":{"component":"routing","feature":"boundary-clip"}}'
      AS
      $$
      SELECT
        resp AS RESPONSE,
        COALESCE(
          ST_INTERSECTION(
            TO_GEOGRAPHY(resp:features[0]:geometry),
            (SELECT BOUNDARY FROM OPENROUTESERVICE_APP.CORE.REGION_CATALOG rc
             WHERE rc.BOUNDARY IS NOT NULL
               AND (UPPER(rc.LOOKUP_NAME) = UPPER(region)
                    OR UPPER(rc.REGION_KEY) = UPPER(region))
             ORDER BY COALESCE(rc.BOUNDARY_AREA_KM2, 1e15) ASC LIMIT 1)
          ),
          TO_GEOGRAPHY(resp:features[0]:geometry)
        ) AS GEOJSON
      FROM (SELECT OPENROUTESERVICE_APP.CORE._ISOCHRONES_RAW(method, lon, lat, range, region) AS resp)
      $$;

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

   -- MATRIX_TABULAR_W (region-first arg order wrapper for BUILD_TRAVEL_TIME_RANGE_REGION non-default path) - returns VARIANT
   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE.MATRIX_TABULAR_W(region VARCHAR, method VARCHAR, origin ARRAY, destinations ARRAY)
      RETURNS VARIANT
      LANGUAGE SQL
      COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"2.0","attributes":{"component":"routing"}}'
      AS
      'SELECT OPENROUTESERVICE_APP.CORE.MATRIX_TABULAR(method, origin, destinations, region)';

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
      created_at TIMESTAMP DEFAULT SYSDATE(),
      updated_at TIMESTAMP DEFAULT SYSDATE()
   )
   COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"2.0","attributes":{"component":"routing"}}';
 
   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE.CHECK_HEALTH()
   RETURNS BOOLEAN
   LANGUAGE SQL
   COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"2.0","attributes":{"component":"routing"}}'
   AS
   'SELECT CASE WHEN OPENROUTESERVICE_APP.CORE._ORS_STATUS_RAW(NULL) IS NOT NULL THEN TRUE ELSE FALSE END';

   -- =====================================================================
   -- REVERSE-REGION LOOKUP: given a point, return the smallest containing
   -- region from REGION_CATALOG. Useful for:
   --   * Auto-picking region from a user-pasted lat/lon
   --   * Tagging fact-table rows with the resolved region
   --   * Detecting cross-region drift in fleet telemetry
   --   * Validating LLM-extracted coordinates from the routing agent
   -- =====================================================================
   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE.REGION_FOR_POINT(LON FLOAT, LAT FLOAT)
   RETURNS OBJECT
   LANGUAGE SQL
   COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"2.0","attributes":{"component":"region-catalog","feature":"reverse-lookup"}}'
   AS
   $$
   SELECT OBJECT_CONSTRUCT(
     'region_name',     rc.REGION_NAME,
     'lookup_name',     rc.LOOKUP_NAME,
     'region_key',      rc.REGION_KEY,
     'iso_country_a2',  rc.ISO_COUNTRY_A2,
     'iso_country_a3',  rc.ISO_COUNTRY_A3,
     'iso_subdivision', rc.ISO_SUBDIVISION,
     'level',           rc.LEVEL,
     'area_km2',        rc.BOUNDARY_AREA_KM2
   )
   FROM OPENROUTESERVICE_APP.CORE.REGION_CATALOG rc
   WHERE rc.BOUNDARY IS NOT NULL
     AND ST_CONTAINS(rc.BOUNDARY, ST_MAKEPOINT(LON, LAT))
   ORDER BY COALESCE(rc.BOUNDARY_AREA_KM2, 1e15) ASC
   LIMIT 1
   $$;

   -- Boolean variant: is the given point inside the named region?
   -- Returns FALSE when the region has no boundary (no false positives).
   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE.POINT_IN_REGION(LON FLOAT, LAT FLOAT, REGION VARCHAR)
   RETURNS BOOLEAN
   LANGUAGE SQL
   COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"2.0","attributes":{"component":"region-catalog","feature":"reverse-lookup"}}'
   AS
   $$
   SELECT COALESCE(
     (SELECT ST_CONTAINS(rc.BOUNDARY, ST_MAKEPOINT(LON, LAT))
      FROM OPENROUTESERVICE_APP.CORE.REGION_CATALOG rc
      WHERE rc.BOUNDARY IS NOT NULL
        AND (UPPER(rc.LOOKUP_NAME) = UPPER(REGION)
             OR UPPER(rc.REGION_KEY) = UPPER(REGION))
      ORDER BY COALESCE(rc.BOUNDARY_AREA_KM2, 1e15) ASC
      LIMIT 1),
     FALSE)
   $$;

   -- Filter MAP_CONFIG sample_addresses to those falling inside the region's
   -- BOUNDARY. Drops curated addresses that drifted out of region (different
   -- city of same name, edge-case admin moves). Falls through if no boundary.
   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE.SAMPLE_ADDRESSES_FOR_REGION(P_REGION VARCHAR)
   RETURNS ARRAY
   LANGUAGE SQL
   COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"2.0","attributes":{"component":"region-catalog","feature":"address-validation"}}'
   AS
   $$
   SELECT ARRAY_AGG(addr.value)
   FROM OPENROUTESERVICE_APP.CORE.MAP_CONFIG mc,
        TABLE(FLATTEN(mc.sample_addresses)) addr
   WHERE UPPER(mc.city_name) = UPPER(P_REGION)
     AND COALESCE(
       OPENROUTESERVICE_APP.CORE.POINT_IN_REGION(
         addr.value:lng::FLOAT,
         addr.value:lat::FLOAT,
         P_REGION),
       TRUE)
   $$;

