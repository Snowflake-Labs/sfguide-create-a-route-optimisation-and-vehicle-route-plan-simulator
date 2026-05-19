/*
 * deploy-agent.sql — Routing Agent
 * Creates all 3 tool procedures + Cortex Agent in a single executable file.
 * Run: snow sql -f .cortex/skills/routing-agent/references/deploy-agent.sql -c <connection>
 *
 * For annotated explanations of each procedure, see agent-definitions.md.
 */

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE DATABASE IF NOT EXISTS FLEET_INTELLIGENCE
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.ROUTING_AGENT
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
CREATE WAREHOUSE IF NOT EXISTS ROUTING_ANALYTICS
    WAREHOUSE_SIZE = 'XSMALL' AUTO_SUSPEND = 60 AUTO_RESUME = TRUE
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- TOOL_DIRECTIONS: Wraps ORS DIRECTIONS with AI geocoding
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_DIRECTIONS(
    LOCATIONS_DESCRIPTION VARCHAR,
    PROFILE VARCHAR DEFAULT 'driving-car'
)
RETURNS VARIANT
LANGUAGE SQL
AS
$$
DECLARE
    v_safe_profile VARCHAR;
    v_sql VARCHAR;
    res RESULTSET;
    v_locations VARIANT;
    v_profile VARCHAR;
    v_distance_raw FLOAT;
    v_duration_raw FLOAT;
    v_segments VARIANT;
    v_geometry VARIANT;
    v_ors_error VARIANT;
    v_detected_regions VARIANT;
    v_out_of_region_count INT;
    v_total_coords INT;
BEGIN
    -- Whitelist profile to prevent SQL injection when inlining into dynamic SQL.
    -- ORS DIRECTIONS does not honor bound parameters for the profile arg; inline it instead.
    v_safe_profile := CASE UPPER(PROFILE)
        WHEN 'DRIVING-CAR' THEN 'driving-car'
        WHEN 'DRIVING-HGV' THEN 'driving-hgv'
        WHEN 'CYCLING-REGULAR' THEN 'cycling-regular'
        WHEN 'CYCLING-MOUNTAIN' THEN 'cycling-mountain'
        WHEN 'CYCLING-ROAD' THEN 'cycling-road'
        WHEN 'CYCLING-ELECTRIC' THEN 'cycling-electric'
        WHEN 'FOOT-WALKING' THEN 'foot-walking'
        WHEN 'FOOT-HIKING' THEN 'foot-hiking'
        WHEN 'WHEELCHAIR' THEN 'wheelchair'
        ELSE 'driving-car'
    END;

    v_sql := 'WITH geocoded AS (
            SELECT AI_COMPLETE(
                ''claude-sonnet-4-5'',
                CONCAT(''Extract all locations from this description and return their coordinates. Be precise with worldwide lat/lon coordinates. Description: '', ?),
                {''temperature'': 0, ''max_tokens'': 2000},
                {''type'': ''json'', ''schema'': {''type'': ''object'', ''properties'': {''locations'': {''type'': ''array'', ''items'': {''type'': ''object'', ''properties'': {''name'': {''type'': ''string''}, ''longitude'': {''type'': ''number''}, ''latitude'': {''type'': ''number''}}, ''required'': [''name'', ''longitude'', ''latitude'']}}}}}
            ) AS geocoded_result
        ),
        coordinates AS (
            SELECT ARRAY_AGG(ARRAY_CONSTRUCT(value:longitude::FLOAT, value:latitude::FLOAT)) AS coords,
                   geocoded_result AS geo
            FROM geocoded, TABLE(FLATTEN(geocoded.geocoded_result, ''locations''))
            GROUP BY geocoded_result
        ),
        validated AS (
            -- Cross-check each LLM-extracted coord against REGION_CATALOG
            -- boundaries. detected_region is the smallest containing region;
            -- mismatched_regions captures coords that resolve to different
            -- regions (e.g. user asked for Cambridge UK but LLM returned
            -- Cambridge MA). out_of_region_count is the number of coords
            -- that don''t match any boundary at all.
            SELECT geo, coords,
                ARRAY_AGG(DISTINCT region_obj:lookup_name::STRING) WITHIN GROUP (ORDER BY region_obj:lookup_name::STRING) AS detected_regions,
                COUNT_IF(region_obj IS NULL) AS out_of_region_count,
                COUNT(*) AS total_coords
            FROM coordinates,
                 LATERAL (
                   SELECT OPENROUTESERVICE_APP.CORE.REGION_FOR_POINT(c.value[0]::FLOAT, c.value[1]::FLOAT) AS region_obj
                   FROM TABLE(FLATTEN(coords)) c
                 )
            GROUP BY geo, coords
        ),
        directions AS (
            SELECT v.geo, v.coords, v.detected_regions, v.out_of_region_count, v.total_coords,
                   d.RESPONSE AS dir_result
            FROM validated v,
                 TABLE(OPENROUTESERVICE_APP.CORE.DIRECTIONS(''' || v_safe_profile || ''', OBJECT_CONSTRUCT(''coordinates'', v.coords)::VARIANT)) d
        )
        SELECT
            geo:locations AS locations,
            ''' || v_safe_profile || ''' AS profile,
            dir_result:features[0]:properties:summary:distance::FLOAT AS distance_raw,
            dir_result:features[0]:properties:summary:duration::FLOAT AS duration_raw,
            dir_result:features[0]:properties:segments AS segments,
            dir_result:features[0]:geometry AS geometry,
            dir_result:error AS ors_error,
            detected_regions,
            out_of_region_count,
            total_coords
        FROM directions';

    res := (EXECUTE IMMEDIATE :v_sql USING (LOCATIONS_DESCRIPTION));
    LET c CURSOR FOR res;
    OPEN c;
    FETCH c INTO v_locations, v_profile, v_distance_raw, v_duration_raw, v_segments, v_geometry, v_ors_error, v_detected_regions, v_out_of_region_count, v_total_coords;
    CLOSE c;

    IF (v_locations IS NULL) THEN
        RETURN OBJECT_CONSTRUCT('error', 'ROUTING FAILED: Geocoding returned no locations. Could not parse locations from the description.', 'status', 'FAILED');
    END IF;

    IF (v_ors_error IS NOT NULL) THEN
        RETURN OBJECT_CONSTRUCT('error', CONCAT('ROUTING FAILED: OpenRouteService returned an error: ', v_ors_error::VARCHAR), 'locations_requested', v_locations, 'status', 'FAILED');
    END IF;

    IF (v_distance_raw IS NULL OR v_geometry IS NULL) THEN
        RETURN OBJECT_CONSTRUCT(
            'error',
              CASE
                WHEN v_out_of_region_count > 0 THEN
                  CONCAT(
                    'ROUTING FAILED: ', v_out_of_region_count::VARCHAR, ' of ', v_total_coords::VARCHAR,
                    ' geocoded coordinates fell outside every provisioned region (detected: ',
                    COALESCE(v_detected_regions::VARCHAR, '[]'),
                    '). The LLM may have geocoded to the wrong city of the same name, or the destination is not in any provisioned region. Try specifying the country or region in your prompt.'
                  )
                ELSE
                  CONCAT(
                    'ROUTING FAILED: OpenRouteService could not compute a route between the requested locations. Detected regions: ',
                    COALESCE(v_detected_regions::VARCHAR, '[]'),
                    '. The locations are inside known regions but no routing graph is loaded that covers them all. Provision the necessary region(s) and retry.'
                  )
              END,
            'locations_requested', v_locations,
            'detected_regions', v_detected_regions,
            'out_of_region_count', v_out_of_region_count,
            'total_coords', v_total_coords,
            'status', 'FAILED'
        );
    END IF;

    RETURN OBJECT_CONSTRUCT(
        'locations', v_locations,
        'profile', v_profile,
        'distance_km', ROUND(DIV0(v_distance_raw, 1000), 2),
        'duration_mins', ROUND(DIV0(v_duration_raw, 60), 1),
        'segments', v_segments,
        'geometry', v_geometry,
        'detected_regions', v_detected_regions,
        'status', 'SUCCESS'
    );
EXCEPTION
    WHEN OTHER THEN
        RETURN OBJECT_CONSTRUCT('error', 'TOOL_DIRECTIONS failed: ' || SQLERRM, 'sqlcode', SQLCODE, 'status', 'FAILED');
END;
$$;

ALTER PROCEDURE FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_DIRECTIONS(VARCHAR, VARCHAR) SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- TOOL_ISOCHRONE: Wraps ORS ISOCHRONES with AI geocoding
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ISOCHRONE(
    LOCATION_DESCRIPTION VARCHAR,
    RANGE_MINUTES NUMBER,
    PROFILE VARCHAR DEFAULT 'driving-car'
)
RETURNS VARIANT
LANGUAGE SQL
AS
$$
DECLARE
    v_safe_profile VARCHAR;
    v_sql VARCHAR;
    res RESULTSET;
    v_center VARIANT;
    v_range_minutes NUMBER;
    v_profile VARCHAR;
    v_area_raw FLOAT;
    v_geometry VARIANT;
    v_ors_error VARIANT;
    v_detected_region OBJECT;
BEGIN
    v_safe_profile := CASE UPPER(PROFILE)
        WHEN 'DRIVING-CAR' THEN 'driving-car'
        WHEN 'DRIVING-HGV' THEN 'driving-hgv'
        WHEN 'CYCLING-REGULAR' THEN 'cycling-regular'
        WHEN 'CYCLING-MOUNTAIN' THEN 'cycling-mountain'
        WHEN 'CYCLING-ROAD' THEN 'cycling-road'
        WHEN 'CYCLING-ELECTRIC' THEN 'cycling-electric'
        WHEN 'FOOT-WALKING' THEN 'foot-walking'
        WHEN 'FOOT-HIKING' THEN 'foot-hiking'
        WHEN 'WHEELCHAIR' THEN 'wheelchair'
        ELSE 'driving-car'
    END;

    -- First attempt: try with detected region (clips to region boundary).
    v_sql := 'WITH geocoded AS (
            SELECT AI_COMPLETE(
                ''claude-sonnet-4-5'',
                CONCAT(''Extract the location from this description and return its coordinates. Be precise with worldwide lat/lon. Description: '', ?),
                {''temperature'': 0, ''max_tokens'': 1000},
                {''type'': ''json'', ''schema'': {''type'': ''object'', ''properties'': {''name'': {''type'': ''string''}, ''longitude'': {''type'': ''number''}, ''latitude'': {''type'': ''number''}}, ''required'': [''name'', ''longitude'', ''latitude'']}}
            ) AS geocoded_result
        ),
        validated AS (
            -- Resolve LLM-extracted coord to a region; the isochrone is then
            -- clipped to that region''s boundary so it doesn''t extend into
            -- foreign territory or water.
            SELECT geocoded_result,
                   OPENROUTESERVICE_APP.CORE.REGION_FOR_POINT(
                     geocoded_result:longitude::FLOAT,
                     geocoded_result:latitude::FLOAT) AS detected_region
            FROM geocoded
        ),
        isochrone AS (
            SELECT v.geocoded_result AS geo,
                   v.detected_region,
                   i.RESPONSE AS iso_result,
                   i.GEOJSON AS clipped_geom
            FROM validated v,
                 TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES_CLIPPED(
                     ''' || v_safe_profile || ''',
                     v.geocoded_result:longitude::FLOAT,
                     v.geocoded_result:latitude::FLOAT,
                     ?::NUMBER,
                     COALESCE(v.detected_region:lookup_name::STRING, ''''))) i
        )
        SELECT
            geo AS center,
            ?::NUMBER AS range_minutes,
            ''' || v_safe_profile || ''' AS profile,
            iso_result:features[0]:properties:area::FLOAT AS area_raw,
            iso_result:features[0]:geometry AS geometry,
            iso_result:error AS ors_error,
            detected_region AS detected_region
        FROM isochrone';

    res := (EXECUTE IMMEDIATE :v_sql USING (LOCATION_DESCRIPTION, RANGE_MINUTES, RANGE_MINUTES));
    LET c CURSOR FOR res;
    OPEN c;
    FETCH c INTO v_center, v_range_minutes, v_profile, v_area_raw, v_geometry, v_ors_error, v_detected_region;
    CLOSE c;

    -- Fallback: if the gateway returned service_unreachable for the regional
    -- ORS service (typical when the detected region is served by the default
    -- ORS_SERVICE rather than a per-region ors-service-<region>), retry
    -- with empty region which routes to the default ORS_SERVICE.
    IF (v_ors_error IS NOT NULL AND v_ors_error::STRING = 'service_unreachable' AND v_center IS NOT NULL) THEN
        LET v_lon FLOAT := v_center:longitude::FLOAT;
        LET v_lat FLOAT := v_center:latitude::FLOAT;
        LET fb_sql VARCHAR := 'SELECT i.RESPONSE:features[0]:properties:area::FLOAT,
                                      i.RESPONSE:features[0]:geometry,
                                      i.RESPONSE:error
            FROM TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES_CLIPPED(
                ''' || v_safe_profile || ''', ?::FLOAT, ?::FLOAT, ?::NUMBER, '''')) i';
        res := (EXECUTE IMMEDIATE :fb_sql USING (v_lon, v_lat, RANGE_MINUTES));
        LET c2 CURSOR FOR res;
        OPEN c2;
        FETCH c2 INTO v_area_raw, v_geometry, v_ors_error;
        CLOSE c2;
    END IF;

    IF (v_center IS NULL) THEN
        RETURN OBJECT_CONSTRUCT('error', 'ISOCHRONE FAILED: Geocoding returned no location. Could not parse location from the description.', 'status', 'FAILED');
    END IF;

    IF (v_ors_error IS NOT NULL) THEN
        RETURN OBJECT_CONSTRUCT('error', CONCAT('ISOCHRONE FAILED: OpenRouteService returned an error: ', v_ors_error::VARCHAR), 'location_requested', v_center, 'status', 'FAILED');
    END IF;

    IF (v_geometry IS NULL) THEN
        RETURN OBJECT_CONSTRUCT(
            'error',
              CASE
                WHEN v_detected_region IS NULL THEN
                  'ISOCHRONE FAILED: The geocoded coordinates fall outside every provisioned region. The LLM may have geocoded to the wrong city of the same name. Try specifying the country or region in your prompt.'
                ELSE
                  CONCAT(
                    'ISOCHRONE FAILED: OpenRouteService could not compute an isochrone for ',
                    v_detected_region:lookup_name::VARCHAR,
                    '. The point is inside the region''s boundary but no routing graph is loaded for it - provision the region and retry.'
                  )
              END,
            'location_requested', v_center,
            'detected_region', v_detected_region,
            'status', 'FAILED'
        );
    END IF;

    RETURN OBJECT_CONSTRUCT(
        'center', v_center,
        'range_minutes', v_range_minutes,
        'profile', v_profile,
        'area_km2', ROUND(DIV0(v_area_raw, 1000000), 2),
        'geometry', v_geometry,
        'detected_region', v_detected_region,
        'status', 'SUCCESS'
    );
EXCEPTION
    WHEN OTHER THEN
        RETURN OBJECT_CONSTRUCT('error', 'TOOL_ISOCHRONE failed: ' || SQLERRM, 'sqlcode', SQLCODE, 'status', 'FAILED');
END;
$$;

ALTER PROCEDURE FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ISOCHRONE(VARCHAR, NUMBER, VARCHAR) SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- TOOL_POI_IN_ISOCHRONE: Find Overture Maps POIs (cafes, restaurants, shops, etc.) reachable within X minutes of a location.
-- Combines ISOCHRONES_CLIPPED with OVERTURE_MAPS__PLACES.CARTO.PLACE via ST_WITHIN.
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_POI_IN_ISOCHRONE(
    LOCATION_DESCRIPTION VARCHAR,
    RANGE_MINUTES NUMBER,
    POI_CATEGORY VARCHAR,
    PROFILE VARCHAR DEFAULT 'driving-car',
    MAX_RESULTS NUMBER DEFAULT 25
)
RETURNS VARIANT
LANGUAGE SQL
AS
$$
DECLARE
    v_safe_profile VARCHAR;
    v_sql VARCHAR;
    res RESULTSET;
    v_center VARIANT;
    v_range_minutes NUMBER;
    v_profile VARCHAR;
    v_category VARCHAR;
    v_iso_geojson VARIANT;
    v_iso_geojson_str VARCHAR;
    v_center_lon FLOAT;
    v_center_lat FLOAT;
    v_ors_error VARIANT;
    v_detected_region OBJECT;
    v_pois VARIANT;
    v_poi_count NUMBER;
BEGIN
    v_safe_profile := CASE UPPER(PROFILE)
        WHEN 'DRIVING-CAR' THEN 'driving-car'
        WHEN 'DRIVING-HGV' THEN 'driving-hgv'
        WHEN 'CYCLING-REGULAR' THEN 'cycling-regular'
        WHEN 'CYCLING-MOUNTAIN' THEN 'cycling-mountain'
        WHEN 'CYCLING-ROAD' THEN 'cycling-road'
        WHEN 'CYCLING-ELECTRIC' THEN 'cycling-electric'
        WHEN 'FOOT-WALKING' THEN 'foot-walking'
        WHEN 'FOOT-HIKING' THEN 'foot-hiking'
        WHEN 'WHEELCHAIR' THEN 'wheelchair'
        ELSE 'driving-car'
    END;

    -- Step 1: Geocode + isochrone (clipped to detected region)
    v_sql := 'WITH geocoded AS (
            SELECT AI_COMPLETE(
                ''claude-sonnet-4-5'',
                CONCAT(''Extract the location from this description and return its coordinates. Be precise with worldwide lat/lon. Description: '', ?),
                {''temperature'': 0, ''max_tokens'': 1000},
                {''type'': ''json'', ''schema'': {''type'': ''object'', ''properties'': {''name'': {''type'': ''string''}, ''longitude'': {''type'': ''number''}, ''latitude'': {''type'': ''number''}}, ''required'': [''name'', ''longitude'', ''latitude'']}}
            ) AS geocoded_result
        ),
        validated AS (
            SELECT geocoded_result,
                   OPENROUTESERVICE_APP.CORE.REGION_FOR_POINT(
                     geocoded_result:longitude::FLOAT,
                     geocoded_result:latitude::FLOAT) AS detected_region
            FROM geocoded
        ),
        isochrone AS (
            SELECT v.geocoded_result AS geo,
                   v.detected_region,
                   i.RESPONSE AS iso_result
            FROM validated v,
                 TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES_CLIPPED(
                     ''' || v_safe_profile || ''',
                     v.geocoded_result:longitude::FLOAT,
                     v.geocoded_result:latitude::FLOAT,
                     ?::NUMBER,
                     COALESCE(v.detected_region:lookup_name::STRING, ''''))) i
        )
        SELECT
            geo AS center,
            ?::NUMBER AS range_minutes,
            ''' || v_safe_profile || ''' AS profile,
            iso_result:features[0]:geometry AS iso_geojson,
            iso_result:error AS ors_error,
            detected_region AS detected_region
        FROM isochrone';

    res := (EXECUTE IMMEDIATE :v_sql USING (LOCATION_DESCRIPTION, RANGE_MINUTES, RANGE_MINUTES));
    LET c CURSOR FOR res;
    OPEN c;
    FETCH c INTO v_center, v_range_minutes, v_profile, v_iso_geojson, v_ors_error, v_detected_region;
    CLOSE c;

    -- Fallback: if the gateway returned service_unreachable for the regional
    -- ORS service, retry with empty region (routes to default ORS_SERVICE).
    IF (v_ors_error IS NOT NULL AND v_ors_error::STRING = 'service_unreachable' AND v_center IS NOT NULL) THEN
        LET v_lon FLOAT := v_center:longitude::FLOAT;
        LET v_lat FLOAT := v_center:latitude::FLOAT;
        LET fb_sql VARCHAR := 'SELECT i.RESPONSE:features[0]:geometry, i.RESPONSE:error
            FROM TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES_CLIPPED(
                ''' || v_safe_profile || ''', ?::FLOAT, ?::FLOAT, ?::NUMBER, '''')) i';
        res := (EXECUTE IMMEDIATE :fb_sql USING (v_lon, v_lat, RANGE_MINUTES));
        LET c2 CURSOR FOR res;
        OPEN c2;
        FETCH c2 INTO v_iso_geojson, v_ors_error;
        CLOSE c2;
    END IF;

    IF (v_center IS NULL) THEN
        RETURN OBJECT_CONSTRUCT('error', 'POI SEARCH FAILED: Geocoding returned no location. Could not parse location from the description.', 'status', 'FAILED');
    END IF;

    IF (v_ors_error IS NOT NULL) THEN
        RETURN OBJECT_CONSTRUCT('error', CONCAT('POI SEARCH FAILED: OpenRouteService returned an error: ', v_ors_error::VARCHAR), 'location_requested', v_center, 'status', 'FAILED');
    END IF;

    IF (v_iso_geojson IS NULL) THEN
        RETURN OBJECT_CONSTRUCT(
            'error',
              CASE
                WHEN v_detected_region IS NULL THEN
                  'POI SEARCH FAILED: The geocoded coordinates fall outside every provisioned region. The LLM may have geocoded to the wrong city of the same name. Try specifying the country or region in your prompt.'
                ELSE
                  CONCAT(
                    'POI SEARCH FAILED: OpenRouteService could not compute an isochrone for ',
                    v_detected_region:lookup_name::VARCHAR,
                    '. The point is inside the region''s boundary but no routing graph is loaded for it - provision the region and retry.'
                  )
              END,
            'location_requested', v_center,
            'detected_region', v_detected_region,
            'status', 'FAILED'
        );
    END IF;

    -- Step 2: Find Overture POIs inside the isochrone polygon, matching category.
    -- Match against BASIC_CATEGORY and CATEGORIES:primary (case-insensitive).
    v_category := LOWER(POI_CATEGORY);
    v_center_lon := v_center:longitude::FLOAT;
    v_center_lat := v_center:latitude::FLOAT;
    v_iso_geojson_str := v_iso_geojson::STRING;
    LET v_max_results NUMBER := COALESCE(MAX_RESULTS, 25);
    IF (v_max_results > 200) THEN
        v_max_results := 200;
    END IF;

    LET poi_sql VARCHAR := 'SELECT ARRAY_AGG(OBJECT_CONSTRUCT(
                ''name'', name,
                ''longitude'', lon,
                ''latitude'', lat,
                ''distance_m'', distance_m,
                ''primary_category'', primary_cat,
                ''basic_category'', basic_cat
            )) WITHIN GROUP (ORDER BY distance_m) AS pois,
            COUNT(*) AS poi_count
        FROM (
            SELECT
                p.NAMES:primary::STRING AS name,
                ST_X(p.GEOMETRY) AS lon,
                ST_Y(p.GEOMETRY) AS lat,
                ROUND(ST_DISTANCE(p.GEOMETRY, ST_MAKEPOINT(?::FLOAT, ?::FLOAT)), 0) AS distance_m,
                p.CATEGORIES:primary::STRING AS primary_cat,
                p.BASIC_CATEGORY AS basic_cat
            FROM OVERTURE_MAPS__PLACES.CARTO.PLACE p
            WHERE ST_WITHIN(p.GEOMETRY, TO_GEOGRAPHY(?))
              AND p.NAMES:primary IS NOT NULL
              AND (
                LOWER(p.BASIC_CATEGORY) = ?
                OR LOWER(p.CATEGORIES:primary::STRING) = ?
                OR LOWER(p.BASIC_CATEGORY) LIKE ''%'' || ? || ''%''
                OR LOWER(p.CATEGORIES:primary::STRING) LIKE ''%'' || ? || ''%''
              )
            ORDER BY distance_m
            LIMIT ' || v_max_results::STRING || '
        )';

    res := (EXECUTE IMMEDIATE :poi_sql USING (
        v_center_lon,
        v_center_lat,
        v_iso_geojson_str,
        v_category,
        v_category,
        v_category,
        v_category
    ));
    LET pc CURSOR FOR res;
    OPEN pc;
    FETCH pc INTO v_pois, v_poi_count;
    CLOSE pc;

    IF (v_poi_count = 0 OR v_pois IS NULL) THEN
        RETURN OBJECT_CONSTRUCT(
            'center', v_center,
            'range_minutes', v_range_minutes,
            'profile', v_profile,
            'category', POI_CATEGORY,
            'detected_region', v_detected_region,
            'pois', ARRAY_CONSTRUCT(),
            'count', 0,
            'message', CONCAT('No POIs matching category "', POI_CATEGORY, '" were found within the ', v_range_minutes::VARCHAR, '-minute ', v_profile, ' isochrone. Try a broader category (e.g. "restaurant" instead of "specialty bistro") or a longer range.'),
            'status', 'SUCCESS'
        );
    END IF;

    RETURN OBJECT_CONSTRUCT(
        'center', v_center,
        'range_minutes', v_range_minutes,
        'profile', v_profile,
        'category', POI_CATEGORY,
        'detected_region', v_detected_region,
        'pois', v_pois,
        'count', v_poi_count,
        'status', 'SUCCESS'
    );
EXCEPTION
    WHEN OTHER THEN
        RETURN OBJECT_CONSTRUCT('error', 'TOOL_POI_IN_ISOCHRONE failed: ' || SQLERRM, 'sqlcode', SQLCODE, 'status', 'FAILED');
END;
$$;

ALTER PROCEDURE FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_POI_IN_ISOCHRONE(VARCHAR, NUMBER, VARCHAR, VARCHAR, NUMBER) SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- TOOL_ROUTE_OPTIMIZATION: Wraps ORS OPTIMIZATION with AI geocoding (Python)
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ROUTE_OPTIMIZATION(
    DELIVERY_LOCATIONS VARCHAR,
    DEPOT_LOCATION VARCHAR,
    NUM_VEHICLES NUMBER,
    PROFILE VARCHAR DEFAULT 'driving-car',
    REGION VARCHAR DEFAULT 'California'
)
RETURNS VARIANT
LANGUAGE PYTHON
RUNTIME_VERSION = '3.11'
PACKAGES = ('snowflake-snowpark-python')
HANDLER = 'run'
AS
$$
import json
from snowflake.snowpark import Session

def _escape_sql_string(s: str) -> str:
    """Escape single quotes for safe SQL string interpolation."""
    return s.replace("'", "''")

def run(session: Session, delivery_locations: str, depot_location: str, num_vehicles: int, profile: str, region: str) -> dict:
    try:
        safe_delivery = _escape_sql_string(delivery_locations)
        delivery_query = f"""
        SELECT AI_COMPLETE(
            'claude-sonnet-4-5',
            'Extract all delivery locations and return coordinates. Description: {safe_delivery}',
            {{'temperature': 0, 'max_tokens': 3000}},
            {{'type': 'json', 'schema': {{'type': 'object', 'properties': {{'locations': {{'type': 'array', 'items': {{'type': 'object', 'properties': {{'name': {{'type': 'string'}}, 'longitude': {{'type': 'number'}}, 'latitude': {{'type': 'number'}}}}, 'required': ['name', 'longitude', 'latitude']}}}}}}}}}}
        ) AS result
        """
        delivery_result = session.sql(delivery_query).collect()[0]['RESULT']
        delivery_data = json.loads(delivery_result) if isinstance(delivery_result, str) else delivery_result

        if not delivery_data.get('locations'):
            return {'error': 'OPTIMIZATION FAILED: Geocoding returned no delivery locations. Could not parse locations from the description.', 'status': 'FAILED'}

        safe_depot = _escape_sql_string(depot_location)
        depot_query = f"""
        SELECT AI_COMPLETE(
            'claude-sonnet-4-5',
            'Extract the depot location coordinates. Description: {safe_depot}',
            {{'temperature': 0, 'max_tokens': 1000}},
            {{'type': 'json', 'schema': {{'type': 'object', 'properties': {{'name': {{'type': 'string'}}, 'longitude': {{'type': 'number'}}, 'latitude': {{'type': 'number'}}}}, 'required': ['name', 'longitude', 'latitude']}}}}
        ) AS result
        """
        depot_result = session.sql(depot_query).collect()[0]['RESULT']
        depot_data = json.loads(depot_result) if isinstance(depot_result, str) else depot_result

        if 'longitude' not in depot_data or 'latitude' not in depot_data:
            return {'error': 'OPTIMIZATION FAILED: Geocoding failed for the depot location. Could not parse coordinates.', 'status': 'FAILED'}

        jobs = []
        for i, loc in enumerate(delivery_data.get('locations', []), start=1):
            jobs.append({
                'id': i,
                'location': [loc['longitude'], loc['latitude']],
                'description': loc['name']
            })

        vehicles = []
        for i in range(1, num_vehicles + 1):
            vehicles.append({
                'id': i,
                'profile': profile,
                'start': [depot_data['longitude'], depot_data['latitude']],
                'end': [depot_data['longitude'], depot_data['latitude']]
            })

        jobs_json = json.dumps(jobs).replace("'", "''")
        vehicles_json = json.dumps(vehicles).replace("'", "''")

        opt_query = f"""
        SELECT RESPONSE AS result FROM TABLE(OPENROUTESERVICE_APP.CORE.OPTIMIZATION(
            OBJECT_CONSTRUCT('jobs', PARSE_JSON('{jobs_json}')::ARRAY, 'vehicles', PARSE_JSON('{vehicles_json}')::ARRAY)::VARIANT,
            '{region}'
        ))
        """
        opt_result = session.sql(opt_query).collect()[0]['RESULT']
        opt_data = json.loads(opt_result) if isinstance(opt_result, str) else opt_result

        if 'error' in opt_data:
            return {
                'error': f"OPTIMIZATION FAILED: OpenRouteService returned an error: {opt_data['error']}",
                'deliveries_requested': delivery_data.get('locations', []),
                'depot_requested': depot_data,
                'status': 'FAILED'
            }

        routes = opt_data.get('routes', [])
        if not routes:
            return {
                'error': 'OPTIMIZATION FAILED: OpenRouteService could not compute routes for the requested locations. This typically means the locations are OUTSIDE the loaded map region. The routing engine only has map data for a specific geographic area.',
                'deliveries_requested': delivery_data.get('locations', []),
                'depot_requested': depot_data,
                'status': 'FAILED'
            }

        unassigned = opt_data.get('unassigned', [])
        if len(unassigned) == len(jobs):
            return {
                'error': 'OPTIMIZATION FAILED: None of the delivery locations could be routed. This typically means ALL locations are OUTSIDE the loaded map region.',
                'deliveries_requested': delivery_data.get('locations', []),
                'depot_requested': depot_data,
                'status': 'FAILED'
            }

        return {
            'deliveries': delivery_data.get('locations', []),
            'depot': depot_data,
            'num_vehicles': num_vehicles,
            'routes': routes,
            'unassigned': unassigned,
            'summary': opt_data.get('summary', {}),
            'status': 'SUCCESS'
        }

    except json.JSONDecodeError as e:
        return {'error': f'OPTIMIZATION FAILED: Failed to parse geocoding response as JSON: {str(e)}', 'status': 'FAILED'}
    except KeyError as e:
        return {'error': f'OPTIMIZATION FAILED: Missing expected field in geocoding response: {str(e)}', 'status': 'FAILED'}
    except Exception as e:
        return {'error': f'OPTIMIZATION FAILED: {str(e)}', 'status': 'FAILED'}
$$;

ALTER PROCEDURE FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ROUTE_OPTIMIZATION(VARCHAR, VARCHAR, NUMBER, VARCHAR, VARCHAR) SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- CREATE AGENT with tool bindings
CREATE OR REPLACE AGENT FLEET_INTELLIGENCE.ROUTING_AGENT.ROUTING_AGENT
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
PROFILE = '{"display_name": "Routing Agent", "color": "green"}'
FROM SPECIFICATION $$
models:
  orchestration: claude-sonnet-4-5
orchestration:
  budget:
    seconds: 120
    tokens: 32000
instructions:
  system: |
    You are a routing agent powered by OpenRouteService. You help users with:
    1. Driving/cycling/walking directions between locations
    2. Reachability analysis (isochrones) - areas reachable within X minutes
    3. Multi-stop delivery route optimization
    4. Finding points of interest (cafes, restaurants, shops, parks, etc.) reachable
       within X minutes of a location, by combining an isochrone with Overture Maps POI data.

    CRITICAL RULES - YOU MUST FOLLOW THESE WITHOUT EXCEPTION:

    1. NEVER provide distances, durations, route details, or travel advice from your own knowledge.
       ALL routing information MUST come from the tool results. You are NOT a general travel advisor.

    2. ALWAYS call the appropriate tool for ANY routing question. Never answer routing questions
       without using a tool first.

    3. After calling a tool, check the result for a "status" field:
       - If status is "FAILED" or the result contains an "error" field: Report the EXACT error
         message to the user. Do NOT attempt to answer the question yourself. Do NOT provide
         alternative routes, estimated distances, or travel tips from your own knowledge.
       - If status is "SUCCESS": Use ONLY the data returned by the tool to answer.

    4. If a tool fails because locations are outside the map region, tell the user:
       "The requested locations are outside the map region loaded in OpenRouteService.
       This routing engine only has map data for a specific geographic area.
       I cannot provide routing information for locations outside that area."
       Do NOT follow up with general travel advice or estimated distances.

    5. NEVER claim you used a tool if you did not. NEVER fabricate tool results.

    6. If the user asks about locations you suspect may be outside the coverage area,
       still call the tool - let the tool determine if routing is possible. Report whatever
       the tool returns.

    OpenRouteService only has map data for a specific region (the OSM file loaded during setup).

    Transport profiles: driving-car, driving-hgv, cycling-regular, cycling-mountain, cycling-road, cycling-electric, foot-walking, foot-hiking, wheelchair
  response: |
    Be concise. Format results clearly:
    - Distances in km, durations in minutes
    - For optimization, summarize vehicle assignments
    - If a tool returns an "error" field or "status": "FAILED", report the error clearly and
      do NOT supplement with your own knowledge. Simply state that routing failed and why.
    - NEVER provide estimated distances, durations, or travel advice when a tool has failed.
  orchestration: |
    - Directions between locations: Use tool_directions
    - Reachability questions ("areas reachable", "how far"): Use tool_isochrone
    - Multi-stop optimization: Use tool_optimization
    - POI / amenity questions ("what cafes / restaurants / shops / pharmacies can I reach",
      "places to eat near", "closest X within Y minutes"): Use tool_poi_in_isochrone.
      Map the user's mode of travel to the profile arg:
        - "cycle" / "bike" / "biking" -> profile=cycling-regular
        - "walk" / "walking" / "on foot" -> profile=foot-walking
        - "drive" / "driving" / "by car" (or unspecified) -> profile=driving-car
      Pass a single lowercase category keyword for poi_category (e.g. "cafe", "restaurant",
      "bar", "pharmacy", "park", "supermarket", "hotel").
    - ALWAYS use a tool for routing/POI questions. NEVER answer from general knowledge.
tools:
  - tool_spec:
      type: generic
      name: tool_directions
      description: "Get directions between locations with distance, duration, turn-by-turn instructions. Returns status SUCCESS with route data, or status FAILED with error message if locations are outside the map region."
      input_schema:
        type: object
        properties:
          locations_description:
            type: string
            description: "Locations to route between, e.g. 'from Times Square to Central Park'"
          profile:
            type: string
            description: "Transport mode. Default: driving-car"
        required: [locations_description]
  - tool_spec:
      type: generic
      name: tool_isochrone
      description: "Get area reachable within specified minutes from a location. Returns status SUCCESS with isochrone data, or status FAILED with error message if the location is outside the map region."
      input_schema:
        type: object
        properties:
          location_description:
            type: string
            description: "Center location, e.g. 'Tokyo Station'"
          range_minutes:
            type: number
            description: "Minutes of travel time (1-60)"
          profile:
            type: string
            description: "Transport mode. Default: driving-car"
        required: [location_description, range_minutes]
  - tool_spec:
      type: generic
      name: tool_poi_in_isochrone
      description: "Find points of interest (cafes, restaurants, shops, pharmacies, parks, etc.) reachable within a given travel time of a location. Combines an OpenRouteService isochrone with Overture Maps POI data via spatial intersection. Returns status SUCCESS with a ranked list of POIs (by distance from the center), or status FAILED with an error if the location is outside the map region."
      input_schema:
        type: object
        properties:
          location_description:
            type: string
            description: "Center location, e.g. 'Civic Center, San Francisco'"
          range_minutes:
            type: number
            description: "Travel time in minutes (1-60)"
          poi_category:
            type: string
            description: "POI category keyword, e.g. 'cafe', 'restaurant', 'bar', 'pharmacy', 'park', 'supermarket', 'hotel'. Lowercase, single word preferred."
          profile:
            type: string
            description: "Transport mode. Use cycling-regular for cycle/bike, foot-walking for walking, driving-car otherwise. Default: driving-car"
          max_results:
            type: number
            description: "Max POIs to return. Default 25."
        required: [location_description, range_minutes, poi_category]
  - tool_spec:
      type: generic
      name: tool_optimization
      description: "Optimize delivery routes for multiple stops with multiple vehicles. Returns status SUCCESS with optimized routes, or status FAILED with error message if locations are outside the map region."
      input_schema:
        type: object
        properties:
          delivery_locations:
            type: string
            description: "All delivery locations to visit"
          depot_location:
            type: string
            description: "Start/end location for vehicles"
          num_vehicles:
            type: number
            description: "Number of vehicles available"
          profile:
            type: string
            description: "Transport mode. Default: driving-car"
          region:
            type: string
            description: "Provisioned ORS region for routing (e.g. California, Germany, UnitedStatesOfAmerica). Default: California"
        required: [delivery_locations, depot_location, num_vehicles]
tool_resources:
  tool_directions:
    type: procedure
    identifier: FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_DIRECTIONS
    execution_environment:
      warehouse: ROUTING_ANALYTICS
  tool_isochrone:
    type: procedure
    identifier: FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ISOCHRONE
    execution_environment:
      warehouse: ROUTING_ANALYTICS
  tool_poi_in_isochrone:
    type: procedure
    identifier: FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_POI_IN_ISOCHRONE
    execution_environment:
      warehouse: ROUTING_ANALYTICS
  tool_optimization:
    type: procedure
    identifier: FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ROUTE_OPTIMIZATION
    execution_environment:
      warehouse: ROUTING_ANALYTICS
$$;

-- Validation
SELECT 'TOOL_DIRECTIONS' AS OBJECT, 'PROCEDURE' AS TYPE FROM INFORMATION_SCHEMA.PROCEDURES WHERE PROCEDURE_SCHEMA = 'ROUTING_AGENT' AND PROCEDURE_NAME = 'TOOL_DIRECTIONS'
UNION ALL SELECT 'TOOL_ISOCHRONE', 'PROCEDURE' FROM INFORMATION_SCHEMA.PROCEDURES WHERE PROCEDURE_SCHEMA = 'ROUTING_AGENT' AND PROCEDURE_NAME = 'TOOL_ISOCHRONE'
UNION ALL SELECT 'TOOL_POI_IN_ISOCHRONE', 'PROCEDURE' FROM INFORMATION_SCHEMA.PROCEDURES WHERE PROCEDURE_SCHEMA = 'ROUTING_AGENT' AND PROCEDURE_NAME = 'TOOL_POI_IN_ISOCHRONE'
UNION ALL SELECT 'TOOL_ROUTE_OPTIMIZATION', 'PROCEDURE' FROM INFORMATION_SCHEMA.PROCEDURES WHERE PROCEDURE_SCHEMA = 'ROUTING_AGENT' AND PROCEDURE_NAME = 'TOOL_ROUTE_OPTIMIZATION';
