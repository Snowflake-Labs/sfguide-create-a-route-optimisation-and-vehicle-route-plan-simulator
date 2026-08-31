   USE SCHEMA OPENROUTESERVICE_APP.CORE;

   ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","module":"02_routing_functions"}}';

   -- =============================================================================
   -- REGION_CATALOG bootstrap (Mirror of REGION_CATALOG DDL in 03_region_management.sql; keep in sync.)
   -- Some functions below (DIRECTIONS, ISOCHRONES_CLIPPED, REGION_FOR_POINT,
   -- POINT_IN_REGION, SAMPLE_ADDRESSES_FOR_REGION) reference REGION_CATALOG. We
   -- create it here idempotently so module 02 compiles standalone - do not rely on
   -- 03 having run first. The DDL is duplicated verbatim from 03; both use
   -- CREATE TABLE IF NOT EXISTS so re-running 03 is a no-op.
   -- =============================================================================
   CREATE TABLE IF NOT EXISTS OPENROUTESERVICE_APP.CORE.REGION_CATALOG (
       CATALOG_ID         VARCHAR NOT NULL,
       SOURCE             VARCHAR NOT NULL,
       REGION_NAME        VARCHAR NOT NULL,
       REGION_KEY         VARCHAR NOT NULL,
       LOOKUP_NAME        VARCHAR,
       HIERARCHY          VARCHAR,
       CONTINENT          VARCHAR,
       COUNTRY            VARCHAR,
       ISO_COUNTRY_A2     VARCHAR(2),
       ISO_COUNTRY_A3     VARCHAR(3),
       ISO_SUBDIVISION    VARCHAR,
       UN_M49             INT,
       PBF_URL            VARCHAR,
       PBF_SIZE_MB        FLOAT,
       LEVEL              VARCHAR NOT NULL,
       MIN_LAT            FLOAT,
       MAX_LAT            FLOAT,
       MIN_LON            FLOAT,
       MAX_LON            FLOAT,
       BOUNDARY           GEOGRAPHY,
       BOUNDARY_SOURCE    VARCHAR,
       BOUNDARY_VERTICES  INT,
       BOUNDARY_AREA_KM2  FLOAT,
       BOUNDARY_BAKED_AT  DATE,
       UPDATED_AT         TIMESTAMP_NTZ DEFAULT SYSDATE()
   )
   COMMENT = '{"origin":"sf_sit-is-fleet","name":"install-fleet-apps","version":"1.0","attributes":{"component":"region-catalog"}}';

   -- =============================================================================
   -- REGION_ORS_MAP bootstrap (Mirror of REGION_ORS_MAP DDL in 03_region_management.sql; keep in sync.)
   -- REGION_FOR_POINT joins REGION_ORS_MAP. Create it here idempotently so module 02
   -- compiles standalone - do not rely on 03 having run first.
   -- =============================================================================
   CREATE TABLE IF NOT EXISTS OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP (
       REGION VARCHAR,
       DISPLAY_NAME VARCHAR,
       PBF_URL VARCHAR,
       MIN_LAT FLOAT,
       MAX_LAT FLOAT,
       MIN_LON FLOAT,
       MAX_LON FLOAT,
       STATUS VARCHAR DEFAULT 'NOT_DEPLOYED',
       COMPUTE_SIZE VARCHAR DEFAULT 'XXL',
       INSTANCE_FAMILY VARCHAR,
       GRAPHS_DATA_ACCESS VARCHAR DEFAULT 'RAM_STORE',
       IS_DEFAULT BOOLEAN DEFAULT FALSE,
       NEEDS_PREWARM BOOLEAN DEFAULT FALSE,
       CREATED_AT TIMESTAMP DEFAULT SYSDATE(),
       UPDATED_AT TIMESTAMP DEFAULT SYSDATE()
   )
   COMMENT = '{"origin":"sf_sit-is-fleet","name":"install-fleet-apps","version":"1.0","attributes":{"component":"multi-region"}}';

   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE.DOWNLOAD (folder VARCHAR, filename VARCHAR, URL VARCHAR)
      RETURNS varchar
      SERVICE=OPENROUTESERVICE_APP.CORE.downloader
      ENDPOINT='downloader'
      MAX_BATCH_ROWS = 1000
      AS '/download_to_stage';

   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE.DOWNLOAD_STATUS (folder VARCHAR, filename VARCHAR)
      RETURNS varchar
      SERVICE=OPENROUTESERVICE_APP.CORE.downloader
      ENDPOINT='downloader'
      MAX_BATCH_ROWS = 1000
      AS '/download_status';

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

   -- Legacy 5-arg form retained for any caller that does not opt into
   -- smoothing yet. The gateway treats the missing smoothing as omitted
   -- (engine default, no smoothing pass). (#113)
   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE._ISOCHRONES_RAW(method TEXT, lon FLOAT, lat FLOAT, range INT, region VARCHAR)
      RETURNS VARIANT
      SERVICE=OPENROUTESERVICE_APP.CORE.routing_gateway_service
      ENDPOINT='gateway'
      MAX_BATCH_ROWS = 1000
      AS '/isochrones_tabular';

   -- 6-arg form: caller-supplied smoothing. 0 = no smoothing (fastest);
   -- 10 = the legacy hard-coded value; 50 = engine maximum. (#113)
   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE._ISOCHRONES_RAW(method TEXT, lon FLOAT, lat FLOAT, range INT, smoothing INT, region VARCHAR)
      RETURNS VARIANT
      SERVICE=OPENROUTESERVICE_APP.CORE.routing_gateway_service
      ENDPOINT='gateway'
      MAX_BATCH_ROWS = 1000
      AS '/isochrones_tabular';

   -- Multi-point / multi-range isochrones via gateway /isochrones (range in seconds
   -- when range_type is time). options VARIANT carries locations, range, range_type.
   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE._ISOCHRONES_RAW(method VARCHAR, options VARIANT, region VARCHAR)
      RETURNS VARIANT
      SERVICE=OPENROUTESERVICE_APP.CORE.routing_gateway_service
      ENDPOINT='gateway'
      MAX_BATCH_ROWS = 100
      AS '/isochrones';

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

   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE._SNAP_RAW(method VARCHAR, options VARIANT, region VARCHAR)
      RETURNS VARIANT
      SERVICE=OPENROUTESERVICE_APP.CORE.routing_gateway_service
      ENDPOINT='gateway'
      MAX_BATCH_ROWS = 100
      AS '/snap';

   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE._MATCH_RAW(method VARCHAR, options VARIANT, region VARCHAR)
      RETURNS VARIANT
      SERVICE=OPENROUTESERVICE_APP.CORE.routing_gateway_service
      ENDPOINT='gateway'
      MAX_BATCH_ROWS = 100
      AS '/match';

   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE._EXPORT_RAW(method VARCHAR, options VARIANT, region VARCHAR)
      RETURNS VARIANT
      SERVICE=OPENROUTESERVICE_APP.CORE.routing_gateway_service
      ENDPOINT='gateway'
      MAX_BATCH_ROWS = 100
      AS '/export/topojson';

   -- NOTE: Service functions (SERVICE=...) do not support ALTER FUNCTION SET COMMENT.
   -- They are tracked via the parent procedure's COMMENT and the session query_tag.

   -- ===== PUBLIC TABLE FUNCTIONS (granted to app_user) =====
   -- These wrap _RAW internals and parse GEOGRAPHY columns.
   --
   -- v1.1.0 - Region semantics:
   --   * Pass an explicit region name (e.g. 'SanFrancisco', 'Berlin') to route
   --     the call to ORS_SERVICE_<REGION> / VROOM_SERVICE_<REGION>.
   --   * Pass NULL or omit the argument to route to the default region. The
   --     gateway resolves it via DEFAULT_REGION_NAME (configured at the gateway
   --     service spec level). After the v1.1.0 unification there is no global
   --     ORS_SERVICE - every region (including the default) is per-region.
   -- DEFAULT NULL is preserved for backward-compat with notebooks / agents that
   -- pre-date the unified model.

   -- DIRECTIONS (tabular: start/end arrays)
   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE.DIRECTIONS(method VARCHAR, jstart ARRAY, jend ARRAY, region VARCHAR DEFAULT NULL)
      RETURNS TABLE (RESPONSE VARIANT, GEOJSON GEOGRAPHY, DISTANCE FLOAT, DURATION FLOAT)
      LANGUAGE SQL
      COMMENT = '{"origin":"sf_sit-is-fleet","name":"install-fleet-apps","version":"2.0","attributes":{"component":"routing"}}'
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
      COMMENT = '{"origin":"sf_sit-is-fleet","name":"install-fleet-apps","version":"2.0","attributes":{"component":"routing"}}'
      AS
      'SELECT resp AS RESPONSE,
            TO_GEOGRAPHY(resp:features[0]:geometry) AS GEOJSON,
            resp:features[0]:properties:summary:distance::FLOAT AS DISTANCE,
            resp:features[0]:properties:summary:duration::FLOAT AS DURATION
         FROM (SELECT OPENROUTESERVICE_APP.CORE._DIRECTIONS_RAW(method, locations, region) AS resp)';

   -- ISOCHRONES (5-arg, legacy default: smoothing=0 i.e. engine default)
   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE.ISOCHRONES(method TEXT, lon FLOAT, lat FLOAT, range INT, region VARCHAR DEFAULT NULL)
      RETURNS TABLE (RESPONSE VARIANT, GEOJSON GEOGRAPHY)
      LANGUAGE SQL
      COMMENT = '{"origin":"sf_sit-is-fleet","name":"install-fleet-apps","version":"2.0","attributes":{"component":"routing"}}'
      AS
      'SELECT resp AS RESPONSE,
            TO_GEOGRAPHY(resp:features[0]:geometry) AS GEOJSON
         FROM (SELECT OPENROUTESERVICE_APP.CORE._ISOCHRONES_RAW(method, lon, lat, range, region) AS resp)';

   -- ISOCHRONES (6-arg with smoothing). 0 = engine default (fastest);
   -- 10 matches the previously hard-coded gateway value; 50 = engine max
   -- (slowest, smoothest polygon). Caller-controlled per #113. (#113)
   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE.ISOCHRONES(method TEXT, lon FLOAT, lat FLOAT, range INT, smoothing INT, region VARCHAR DEFAULT NULL)
      RETURNS TABLE (RESPONSE VARIANT, GEOJSON GEOGRAPHY)
      LANGUAGE SQL
      COMMENT = '{"origin":"sf_sit-is-fleet","name":"install-fleet-apps","version":"2.1","attributes":{"component":"routing","feature":"smoothing"}}'
      AS
      'SELECT resp AS RESPONSE,
            TO_GEOGRAPHY(resp:features[0]:geometry) AS GEOJSON
         FROM (SELECT OPENROUTESERVICE_APP.CORE._ISOCHRONES_RAW(method, lon, lat, range, smoothing, region) AS resp)';

   -- ISOCHRONES (multi-point / multi-range). locations = ARRAY of [lon, lat] pairs;
   -- ranges = ARRAY of range values (seconds when range_type is time).
   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE.ISOCHRONES(
      method VARCHAR, locations ARRAY, ranges ARRAY,
      range_type VARCHAR DEFAULT 'time', region VARCHAR DEFAULT NULL)
      RETURNS TABLE (RESPONSE VARIANT, GEOJSON GEOGRAPHY)
      LANGUAGE SQL
      COMMENT = '{"origin":"sf_sit-is-fleet","name":"install-fleet-apps","version":"2.1","attributes":{"component":"routing","feature":"multi-isochrone"}}'
      AS
      'SELECT resp AS RESPONSE,
            TO_GEOGRAPHY(resp:features[0]:geometry) AS GEOJSON
         FROM (SELECT OPENROUTESERVICE_APP.CORE._ISOCHRONES_RAW(
                  method,
                  OBJECT_CONSTRUCT(
                    ''locations'', locations,
                    ''range'', ranges,
                    ''range_type'', range_type
                  ),
                  region
                ) AS resp)';

   -- ISOCHRONES_CLIPPED: same as ISOCHRONES but clips the returned polygon
   -- to the named region's actual boundary so catchment zones don't claim
   -- foreign territory or water. Falls through (no clip) when the catalog
   -- has no boundary for the region.
   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE.ISOCHRONES_CLIPPED(method TEXT, lon FLOAT, lat FLOAT, range INT, region VARCHAR)
      RETURNS TABLE (RESPONSE VARIANT, GEOJSON GEOGRAPHY)
      LANGUAGE SQL
      COMMENT = '{"origin":"sf_sit-is-fleet","name":"install-fleet-apps","version":"2.0","attributes":{"component":"routing","feature":"boundary-clip"}}'
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
      COMMENT = '{"origin":"sf_sit-is-fleet","name":"install-fleet-apps","version":"2.0","attributes":{"component":"routing"}}'
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
      COMMENT = '{"origin":"sf_sit-is-fleet","name":"install-fleet-apps","version":"2.0","attributes":{"component":"routing"}}'
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
      COMMENT = '{"origin":"sf_sit-is-fleet","name":"install-fleet-apps","version":"2.0","attributes":{"component":"routing"}}'
      AS
      'SELECT OPENROUTESERVICE_APP.CORE._MATRIX_RAW(method, OBJECT_CONSTRUCT(''locations'', locations, ''metrics'', ARRAY_CONSTRUCT(''distance'', ''duration''), ''resolve_locations'', true), region)';

   -- MATRIX (options variant) - returns VARIANT
   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE.MATRIX(method VARCHAR, options VARIANT, region VARCHAR DEFAULT NULL)
      RETURNS VARIANT
      LANGUAGE SQL
      COMMENT = '{"origin":"sf_sit-is-fleet","name":"install-fleet-apps","version":"2.0","attributes":{"component":"routing"}}'
      AS
      'SELECT OPENROUTESERVICE_APP.CORE._MATRIX_RAW(method, options, region)';

   -- MATRIX_TABULAR (origin + destinations) - returns VARIANT
   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE.MATRIX_TABULAR(method VARCHAR, origin ARRAY, destinations ARRAY, region VARCHAR DEFAULT NULL)
      RETURNS VARIANT
      LANGUAGE SQL
      COMMENT = '{"origin":"sf_sit-is-fleet","name":"install-fleet-apps","version":"2.0","attributes":{"component":"routing"}}'
      AS
      'SELECT OPENROUTESERVICE_APP.CORE._MATRIX_TABULAR_RAW(method, origin, destinations, region)';

   -- MATRIX_TABULAR_W (region-first arg order wrapper for BUILD_TRAVEL_TIME_RANGE_REGION non-default path) - returns VARIANT
   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE.MATRIX_TABULAR_W(region VARCHAR, method VARCHAR, origin ARRAY, destinations ARRAY)
      RETURNS VARIANT
      LANGUAGE SQL
      COMMENT = '{"origin":"sf_sit-is-fleet","name":"install-fleet-apps","version":"2.0","attributes":{"component":"routing"}}'
      AS
      'SELECT OPENROUTESERVICE_APP.CORE.MATRIX_TABULAR(method, origin, destinations, region)';

   -- SNAP (locations array + radius) - snaps each point to the nearest routable
   -- edge in the profile's graph. Returns the raw ORS VARIANT response whose
   -- :locations[] entries are either null (nothing within radius) or
   -- {location:[lon,lat], name, snapped_distance}. This is per-point nearest-edge
   -- snapping, NOT trajectory map matching.
   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE.SNAP(method VARCHAR, locations ARRAY, radius INT, region VARCHAR DEFAULT NULL)
      RETURNS VARIANT
      LANGUAGE SQL
      COMMENT = '{"origin":"sf_sit-is-fleet","name":"install-fleet-apps","version":"2.0","attributes":{"component":"routing"}}'
      AS
      'SELECT OPENROUTESERVICE_APP.CORE._SNAP_RAW(method, OBJECT_CONSTRUCT(''locations'', locations, ''radius'', radius), region)';

   -- SNAP_POINTS (tabular convenience) - one row per input point, in input order.
   -- SNAPPED_GEOG is NULL for points that could not be snapped within radius
   -- (LATERAL FLATTEN with OUTER => TRUE preserves those rows).
   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE.SNAP_POINTS(method VARCHAR, locations ARRAY, radius INT, region VARCHAR DEFAULT NULL)
      RETURNS TABLE (IDX INT, INPUT_GEOG GEOGRAPHY, SNAPPED_GEOG GEOGRAPHY, SNAPPED_DISTANCE FLOAT, NAME STRING)
      LANGUAGE SQL
      COMMENT = '{"origin":"sf_sit-is-fleet","name":"install-fleet-apps","version":"2.0","attributes":{"component":"routing","feature":"snap"}}'
      AS
      $$
      SELECT
        f.INDEX::INT AS IDX,
        ST_MAKEPOINT(locations[f.INDEX][0]::FLOAT, locations[f.INDEX][1]::FLOAT) AS INPUT_GEOG,
        IFF(f.VALUE IS NULL, NULL,
            ST_MAKEPOINT(f.VALUE:location[0]::FLOAT, f.VALUE:location[1]::FLOAT)) AS SNAPPED_GEOG,
        f.VALUE:snapped_distance::FLOAT AS SNAPPED_DISTANCE,
        f.VALUE:name::STRING AS NAME
      FROM (SELECT OPENROUTESERVICE_APP.CORE._SNAP_RAW(method, OBJECT_CONSTRUCT('locations', locations, 'radius', radius), region) AS resp),
           LATERAL FLATTEN(input => resp:locations, OUTER => TRUE) f
      $$;

   -- MATCH (map matching) - matches a GeoJSON FeatureCollection to the graph.
   -- LineString features are matched with the HMM map-matcher; the raw ORS response
   -- returns :edge_ids (arrays of internal graph edge ids per feature), NOT geometry.
   -- Use MATCH_PATH for a road-following polyline.
   --
   -- The trailing ''?'' on the profile is load-bearing, do NOT strip it. ORS exposes
   -- POST /v2/match/{profile} ONLY - it has no format-suffixed route (unlike /snap
   -- and /export), and its @PostMapping("/{profile}/*") catch-all answers any extra
   -- path segment with error 9007 "Response format is not supported". The gateway
   -- appends a format segment unconditionally, so ''?'' demotes that ''/json'' to a
   -- query string, which Spring ignores. Harmless on a gateway that stops appending
   -- the format (the query is then simply empty).
   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE.MATCH(method VARCHAR, features VARIANT, region VARCHAR DEFAULT NULL)
      RETURNS VARIANT
      LANGUAGE SQL
      COMMENT = '{"origin":"sf_sit-is-fleet","name":"install-fleet-apps","version":"2.0","attributes":{"component":"routing","feature":"match"}}'
      AS
      'SELECT OPENROUTESERVICE_APP.CORE._MATCH_RAW(method || ''?'', OBJECT_CONSTRUCT(''features'', features), region)';

   -- MATCH_PATH (trajectory snap-to-road) - matches a noisy GPS LineString to the
   -- road network and returns the matched road segments as a single GEOGRAPHY.
   -- Chain: /match (LineString -> ors edge_ids) then /export (bbox TopoJSON) to
   -- resolve those edge ids to real OSM geometry (requires the profile's OsmId
   -- ext storage, enabled by write_ors_config). Reversal of an arc does not change
   -- its shape, so arcs are collected (ST_COLLECT) rather than strictly re-ordered.
   -- GEOJSON is NULL when nothing matched (or OsmId storage is absent); RESPONSE
   -- always carries the raw match result for inspection.
   -- The trailing '?' on the /match profile is load-bearing - see the note on MATCH.
   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE.MATCH_PATH(method VARCHAR, linestring ARRAY, region VARCHAR DEFAULT NULL)
      RETURNS TABLE (RESPONSE VARIANT, GEOJSON GEOGRAPHY, MATCHED_EDGES INT)
      LANGUAGE SQL
      COMMENT = '{"origin":"sf_sit-is-fleet","name":"install-fleet-apps","version":"2.0","attributes":{"component":"routing","feature":"match-path"}}'
      AS
      $$
      WITH m AS (
        SELECT OPENROUTESERVICE_APP.CORE._MATCH_RAW(
                 method || '?',
                 OBJECT_CONSTRUCT('features',
                   OBJECT_CONSTRUCT('type', 'FeatureCollection', 'features',
                     ARRAY_CONSTRUCT(OBJECT_CONSTRUCT(
                       'type', 'Feature',
                       'geometry', OBJECT_CONSTRUCT('type', 'LineString', 'coordinates', linestring))))),
                 region) AS match_resp
      ),
      ids AS (
        SELECT ARRAY_AGG(DISTINCT f.value::INT) AS edge_ids
        FROM m,
             LATERAL FLATTEN(input => m.match_resp:edge_ids) g,
             LATERAL FLATTEN(input => g.value) f
      ),
      bb AS (
        SELECT ARRAY_CONSTRUCT(
                 ARRAY_CONSTRUCT(MIN(c.value[0]::FLOAT) - 0.003, MIN(c.value[1]::FLOAT) - 0.003),
                 ARRAY_CONSTRUCT(MAX(c.value[0]::FLOAT) + 0.003, MAX(c.value[1]::FLOAT) + 0.003)
               ) AS bbox
        FROM LATERAL FLATTEN(input => linestring) c
      ),
      ex AS (
        SELECT OPENROUTESERVICE_APP.CORE._EXPORT_RAW(
                 method,
                 OBJECT_CONSTRUCT('bbox', (SELECT bbox FROM bb), 'geometry', TRUE),
                 region) AS export_resp
      ),
      arcs AS (
        SELECT DISTINCT ABS(a.value::INT) AS arc_idx
        FROM ex,
             LATERAL FLATTEN(input => ex.export_resp:objects:network:geometries) gg,
             LATERAL FLATTEN(input => gg.value:arcs) a
        WHERE ARRAYS_OVERLAP(gg.value:properties:ors_ids::ARRAY, (SELECT edge_ids FROM ids))
      ),
      lines AS (
        SELECT TO_GEOGRAPHY(OBJECT_CONSTRUCT('type', 'LineString', 'coordinates',
                 GET(ex.export_resp:arcs, arcs.arc_idx))) AS line
        FROM ex, arcs
        WHERE arcs.arc_idx IS NOT NULL
      )
      SELECT
        (SELECT match_resp FROM m)                       AS RESPONSE,
        (SELECT ST_COLLECT(line) FROM lines)             AS GEOJSON,
        COALESCE((SELECT ARRAY_SIZE(edge_ids) FROM ids), 0) AS MATCHED_EDGES
      $$;

   -- ORS_STATUS - returns VARIANT
   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE.ORS_STATUS(region VARCHAR DEFAULT NULL)
      RETURNS VARIANT
      LANGUAGE SQL
      COMMENT = '{"origin":"sf_sit-is-fleet","name":"install-fleet-apps","version":"2.0","attributes":{"component":"routing"}}'
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
   COMMENT = '{"origin":"sf_sit-is-fleet","name":"install-fleet-apps","version":"2.0","attributes":{"component":"routing"}}';
 
   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE.CHECK_HEALTH()
   RETURNS BOOLEAN
   LANGUAGE SQL
   COMMENT = '{"origin":"sf_sit-is-fleet","name":"install-fleet-apps","version":"2.0","attributes":{"component":"routing"}}'
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
   COMMENT = '{"origin":"sf_sit-is-fleet","name":"install-fleet-apps","version":"2.0","attributes":{"component":"region-catalog","feature":"reverse-lookup"}}'
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
   JOIN OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP rm
     ON UPPER(rm.REGION) = UPPER(rc.LOOKUP_NAME)
     OR UPPER(rm.REGION) = UPPER(rc.REGION_KEY)
   WHERE rc.BOUNDARY IS NOT NULL
     AND rm.STATUS = 'DEPLOYED'
     AND ST_CONTAINS(rc.BOUNDARY, ST_MAKEPOINT(LON, LAT))
   ORDER BY COALESCE(rc.BOUNDARY_AREA_KM2, 1e15) ASC
   LIMIT 1
   $$;

   -- Boolean variant: is the given point inside the named region?
   -- Returns FALSE when the region has no boundary (no false positives).
   CREATE OR REPLACE FUNCTION OPENROUTESERVICE_APP.CORE.POINT_IN_REGION(LON FLOAT, LAT FLOAT, REGION VARCHAR)
   RETURNS BOOLEAN
   LANGUAGE SQL
   COMMENT = '{"origin":"sf_sit-is-fleet","name":"install-fleet-apps","version":"2.0","attributes":{"component":"region-catalog","feature":"reverse-lookup"}}'
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
   COMMENT = '{"origin":"sf_sit-is-fleet","name":"install-fleet-apps","version":"2.0","attributes":{"component":"region-catalog","feature":"address-validation"}}'
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

