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
    v_coords VARIANT;
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

    -- Step 1: Geocode. Pull locations + coords array out as bound variables
    -- so step 2 can pass them to DIRECTIONS without inlining a CTE-derived
    -- expression into the table function (Snowflake rejects that with
    -- "Unsupported subquery type cannot be evaluated inside Function object").
    v_sql := 'WITH geocoded AS (
            SELECT AI_COMPLETE(
                ''claude-sonnet-4-5'',
                CONCAT(''Extract all locations from this description and return their coordinates. Be precise with worldwide lat/lon coordinates. Description: '', ?),
                {''temperature'': 0, ''max_tokens'': 2000},
                {''type'': ''json'', ''schema'': {''type'': ''object'', ''properties'': {''locations'': {''type'': ''array'', ''items'': {''type'': ''object'', ''properties'': {''name'': {''type'': ''string''}, ''longitude'': {''type'': ''number''}, ''latitude'': {''type'': ''number''}}, ''required'': [''name'', ''longitude'', ''latitude'']}}}}}
            ) AS geocoded_result
        )
        SELECT
            geocoded_result:locations AS locations,
            (SELECT ARRAY_AGG(ARRAY_CONSTRUCT(value:longitude::FLOAT, value:latitude::FLOAT))
             FROM TABLE(FLATTEN(geocoded_result, ''locations''))) AS coords
        FROM geocoded';

    res := (EXECUTE IMMEDIATE :v_sql USING (LOCATIONS_DESCRIPTION));
    LET c CURSOR FOR res;
    OPEN c;
    FETCH c INTO v_locations, v_coords;
    CLOSE c;
    v_profile := v_safe_profile;

    IF (v_locations IS NULL OR v_coords IS NULL) THEN
        RETURN OBJECT_CONSTRUCT('error', 'ROUTING FAILED: Geocoding returned no locations. Could not parse locations from the description.', 'status', 'FAILED');
    END IF;

    -- Step 1b: Region validation (best-effort; non-fatal). Done as a
    -- separate, simple FLATTEN that calls REGION_FOR_POINT per coord.
    -- Failures here just leave the region info NULL.
    BEGIN
        LET val_sql VARCHAR := 'WITH pts AS (
            SELECT
                OPENROUTESERVICE_APP.CORE.REGION_FOR_POINT(c.value[0]::FLOAT, c.value[1]::FLOAT):lookup_name::STRING AS region_name
            FROM TABLE(FLATTEN(PARSE_JSON(?))) c
        )
        SELECT
            ARRAY_AGG(DISTINCT region_name) WITHIN GROUP (ORDER BY region_name),
            COUNT_IF(region_name IS NULL),
            COUNT(*)
        FROM pts';
        LET v_coords_str VARCHAR := v_coords::STRING;
        res := (EXECUTE IMMEDIATE :val_sql USING (v_coords_str));
        LET cv CURSOR FOR res;
        OPEN cv;
        FETCH cv INTO v_detected_regions, v_out_of_region_count, v_total_coords;
        CLOSE cv;
    EXCEPTION
        WHEN OTHER THEN
            v_detected_regions := NULL;
            v_out_of_region_count := 0;
            v_total_coords := 0;
    END;

    -- Step 2: Call DIRECTIONS with coords as a bound VARIANT parameter.
    LET dir_sql VARCHAR := 'SELECT
            d.RESPONSE:features[0]:properties:summary:distance::FLOAT,
            d.RESPONSE:features[0]:properties:summary:duration::FLOAT,
            d.RESPONSE:features[0]:properties:segments,
            d.RESPONSE:features[0]:geometry,
            d.RESPONSE:error
        FROM TABLE(OPENROUTESERVICE_APP.CORE.DIRECTIONS(
            ''' || v_safe_profile || ''',
            OBJECT_CONSTRUCT(''coordinates'', PARSE_JSON(?))::VARIANT)) d';

    LET v_coords_str2 VARCHAR := v_coords::STRING;
    res := (EXECUTE IMMEDIATE :dir_sql USING (v_coords_str2));
    LET c2 CURSOR FOR res;
    OPEN c2;
    FETCH c2 INTO v_distance_raw, v_duration_raw, v_segments, v_geometry, v_ors_error;
    CLOSE c2;

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

    -- If the gateway returned service_unreachable, the resolved region's ORS
    -- service is suspended or not provisioned. Surface an actionable error
    -- naming the region instead of silently falling back to the default region
    -- (which would hide the real failure and route Berlin queries to SF).
    IF (v_ors_error IS NOT NULL AND v_ors_error::STRING = 'service_unreachable' AND v_detected_region IS NOT NULL) THEN
        LET v_region_name VARCHAR := v_detected_region:lookup_name::VARCHAR;
        RETURN OBJECT_CONSTRUCT(
            'error', CONCAT(
                'ISOCHRONE FAILED: ORS service for region ',
                v_region_name,
                ' is not running. Resume it with: ALTER SERVICE OPENROUTESERVICE_APP.CORE.ORS_SERVICE_',
                UPPER(v_region_name),
                ' RESUME;'
            ),
            'detected_region', v_detected_region,
            'location_requested', v_center,
            'status', 'FAILED'
        );
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

    -- If the gateway returned service_unreachable, the resolved region's ORS
    -- service is suspended or not provisioned. Surface an actionable error
    -- naming the region instead of silently falling back to the default region.
    IF (v_ors_error IS NOT NULL AND v_ors_error::STRING = 'service_unreachable' AND v_detected_region IS NOT NULL) THEN
        LET v_region_name VARCHAR := v_detected_region:lookup_name::VARCHAR;
        RETURN OBJECT_CONSTRUCT(
            'error', CONCAT(
                'POI SEARCH FAILED: ORS service for region ',
                v_region_name,
                ' is not running. Resume it with: ALTER SERVICE OPENROUTESERVICE_APP.CORE.ORS_SERVICE_',
                UPPER(v_region_name),
                ' RESUME;'
            ),
            'detected_region', v_detected_region,
            'location_requested', v_center,
            'status', 'FAILED'
        );
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

----------------------------------------------------------------------
-- TOOL_SUPPLY_CHAIN: Pharmaceutical supply chain plan (SF-only demo).
-- Reads SF_TOP_PHARMACIES, SF_HEALTH_DEMOGRAPHICS, SF_DRUG_FORMULARY
-- (created by setup-agent-playground). Builds a 3-vehicle VROOM payload
-- and returns the optimized routes with population-derived drug demand.
-- The proc compiles lazily, so it can be created BEFORE the data tables
-- exist — but it will only execute correctly once setup-agent-playground
-- has been run.
----------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_SUPPLY_CHAIN(
    PROFILE VARCHAR DEFAULT 'driving-car'
)
RETURNS VARIANT
LANGUAGE JAVASCRIPT
EXECUTE AS OWNER
AS
$$
try {
    var depotLon = -122.3946;
    var depotLat = 37.7941;
    var depotName = 'SF Medical Supply Depot, 1 Market St';

    var pharmaStmt = snowflake.createStatement({
        sqlText: "SELECT PHARMACY_ID, NAME, ADDRESS, LONGITUDE, LATITUDE, PRIORITY " +
                 "FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_TOP_PHARMACIES ORDER BY PRIORITY"
    });
    var pharmaRes = pharmaStmt.execute();
    var pharmacies = [];
    while (pharmaRes.next()) {
        pharmacies.push({
            id: pharmaRes.getColumnValue(1),
            name: pharmaRes.getColumnValue(2),
            address: pharmaRes.getColumnValue(3),
            longitude: pharmaRes.getColumnValue(4),
            latitude: pharmaRes.getColumnValue(5),
            priority: pharmaRes.getColumnValue(6)
        });
    }

    var drugStmt = snowflake.createStatement({
        sqlText: "SELECT DRUG_ID, CONDITION, DRUG_NAME, DRUG_CATEGORY, DELIVERY_SKILL, " +
                 "SKILL_LABEL, UNITS_PER_1000, PRIORITY " +
                 "FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_DRUG_FORMULARY ORDER BY PRIORITY"
    });
    var drugRes = drugStmt.execute();
    var formulary = [];
    while (drugRes.next()) {
        formulary.push({
            drug_id: drugRes.getColumnValue(1),
            condition: drugRes.getColumnValue(2),
            drug_name: drugRes.getColumnValue(3),
            drug_category: drugRes.getColumnValue(4),
            delivery_skill: drugRes.getColumnValue(5),
            skill_label: drugRes.getColumnValue(6),
            units_per_1000: drugRes.getColumnValue(7),
            priority: drugRes.getColumnValue(8)
        });
    }

    var demoStmt = snowflake.createStatement({
        sqlText: "SELECT NEIGHBORHOOD, TOTAL_POPULATION, DIABETES_PCT, HYPERTENSION_PCT, " +
                 "CARDIOVASCULAR_PCT, RESPIRATORY_PCT, MOBILITY_ISSUES_PCT " +
                 "FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_HEALTH_DEMOGRAPHICS"
    });
    var demoRes = demoStmt.execute();
    var totalDiabetes = 0, totalHypertension = 0, totalCardio = 0, totalResp = 0, totalMobility = 0, totalPop = 0;
    while (demoRes.next()) {
        var pop = demoRes.getColumnValue(2);
        totalPop += pop;
        totalDiabetes += demoRes.getColumnValue(3) * pop / 100;
        totalHypertension += demoRes.getColumnValue(4) * pop / 100;
        totalCardio += demoRes.getColumnValue(5) * pop / 100;
        totalResp += demoRes.getColumnValue(6) * pop / 100;
        totalMobility += demoRes.getColumnValue(7) * pop / 100;
    }

    var priorityWeights = { 1: 0.25, 2: 0.15, 3: 0.10 };
    var vroomJobs = [];
    var jobDetails = [];
    var jobId = 1;

    for (var p = 0; p < pharmacies.length; p++) {
        var pharmacy = pharmacies[p];
        var weight = priorityWeights[pharmacy.priority] || 0.10;
        var primarySkill = (p % 3) + 1;

        var conditions = {
            'DIABETES': totalDiabetes * weight,
            'HYPERTENSION': totalHypertension * weight,
            'CARDIOVASCULAR': totalCardio * weight,
            'RESPIRATORY': totalResp * weight,
            'MOBILITY': totalMobility * weight
        };

        var pharmaOrders = [];
        for (var d = 0; d < formulary.length; d++) {
            var drug = formulary[d];
            if (drug.delivery_skill !== primarySkill) continue;
            var condPop = conditions[drug.condition] || 0;
            var units = Math.round(condPop / 1000 * drug.units_per_1000);
            if (units > 0) {
                pharmaOrders.push({
                    drug_name: drug.drug_name, drug_category: drug.drug_category,
                    skill: drug.delivery_skill, skill_label: drug.skill_label,
                    units: units, priority: drug.priority
                });
            }
        }
        pharmaOrders.sort(function(a, b) { return a.priority - b.priority || b.units - a.units; });
        var topOrders = pharmaOrders.slice(0, 5);

        if (topOrders.length > 0) {
            var drugNames = topOrders.map(function(o2) { return o2.drug_name; });
            var totalUnits = 0;
            for (var t = 0; t < topOrders.length; t++) totalUnits += topOrders[t].units;

            vroomJobs.push({
                id: jobId,
                location: [pharmacy.longitude, pharmacy.latitude],
                amount: [1], skills: [primarySkill],
                description: pharmacy.name + ' - ' + topOrders[0].skill_label + ': ' + drugNames.join(', ')
            });
            jobDetails.push({
                job_id: jobId, pharmacy: pharmacy.name, address: pharmacy.address,
                longitude: pharmacy.longitude, latitude: pharmacy.latitude,
                skill: primarySkill, skill_label: topOrders[0].skill_label,
                drugs: drugNames, total_units: totalUnits
            });
            jobId++;
        }
    }

    var vehicles = [
        { id: 1, start: [depotLon, depotLat], end: [depotLon, depotLat],
          profile: PROFILE, capacity: [vroomJobs.length], skills: [1],
          description: 'Cold Chain Van (Insulin, Biologics, Nitroglycerin)' },
        { id: 2, start: [depotLon, depotLat], end: [depotLon, depotLat],
          profile: PROFILE, capacity: [vroomJobs.length], skills: [2],
          description: 'Controlled Substances Van (Opioids, Anticoagulants, Steroids)' },
        { id: 3, start: [depotLon, depotLat], end: [depotLon, depotLat],
          profile: PROFILE, capacity: [vroomJobs.length], skills: [3],
          description: 'Standard Delivery Van (Oral medications, Inhalers, Topicals)' }
    ];

    var vroomPayload = JSON.stringify({ jobs: vroomJobs, vehicles: vehicles });
    var optSQL = "SELECT o.RESPONSE, ST_ASGEOJSON(o.GEOJSON) AS GEOJSON " +
                 "FROM TABLE(OPENROUTESERVICE_APP.CORE.OPTIMIZATION(PARSE_JSON(?), ?)) o LIMIT 1";
    var optStmt = snowflake.createStatement({ sqlText: optSQL, binds: [vroomPayload, 'SanFrancisco'] });
    var optRes = optStmt.execute();
    if (!optRes.next()) {
        return { error: 'OPTIMIZATION returned no results', status: 'FAILED', jobs: jobDetails };
    }
    var rawResp = optRes.getColumnValue(1);
    var response = (typeof rawResp === 'string') ? JSON.parse(rawResp || '{}') : (rawResp || {});
    var geojsonRaw = optRes.getColumnValue(2);
    var geojson = geojsonRaw ? ((typeof geojsonRaw === 'string') ? JSON.parse(geojsonRaw) : geojsonRaw) : null;

    var vroomRoutes = response.routes || [];
    var routesWithGeometry = [];
    for (var r = 0; r < vroomRoutes.length; r++) {
        var route = vroomRoutes[r];
        routesWithGeometry.push({
            vehicle: route.vehicle, cost: route.cost,
            duration: route.duration, distance: route.distance,
            steps: route.steps || [], geometry: route.geometry || []
        });
    }
    var skill1Jobs = jobDetails.filter(function(j) { return j.skill === 1; });
    var skill2Jobs = jobDetails.filter(function(j) { return j.skill === 2; });
    var skill3Jobs = jobDetails.filter(function(j) { return j.skill === 3; });

    return {
        status: 'SUCCESS', num_vehicles: 3,
        total_jobs: vroomJobs.length, pharmacies_served: pharmacies.length,
        jobs: jobDetails, vehicles: vehicles,
        routes: routesWithGeometry, unassigned: response.unassigned || [],
        depot: { longitude: depotLon, latitude: depotLat, name: depotName },
        geometry: geojson,
        demand_summary: {
            cold_chain_stops: skill1Jobs.length,
            controlled_substance_stops: skill2Jobs.length,
            standard_medicine_stops: skill3Jobs.length,
            cold_chain_drugs: skill1Jobs.map(function(j) { return j.drugs; }).reduce(function(a, b) { return a.concat(b); }, []),
            controlled_drugs: skill2Jobs.map(function(j) { return j.drugs; }).reduce(function(a, b) { return a.concat(b); }, []),
            standard_drugs: skill3Jobs.map(function(j) { return j.drugs; }).reduce(function(a, b) { return a.concat(b); }, [])
        },
        population_basis: {
            total_population: totalPop,
            diabetes_patients: Math.round(totalDiabetes),
            hypertension_patients: Math.round(totalHypertension),
            cardiovascular_patients: Math.round(totalCardio),
            respiratory_patients: Math.round(totalResp),
            mobility_patients: Math.round(totalMobility)
        }
    };
} catch(err) {
    return { error: err.message, status: 'FAILED' };
}
$$;

ALTER PROCEDURE FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_SUPPLY_CHAIN(VARCHAR) SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

----------------------------------------------------------------------
-- TOOL_PHARMA_OPTIMIZATION: Pre-geocoded SF pharma fleet demo.
-- 30 stops with 3 specialist vehicles (cold chain, controlled, standard).
-- Reads SF_PHARMA_JOBS (created by setup-agent-playground).
----------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_PHARMA_OPTIMIZATION(
    PROFILE VARCHAR DEFAULT 'driving-car'
)
RETURNS VARIANT
LANGUAGE JAVASCRIPT
EXECUTE AS OWNER
AS
$$
try {
    var depotLon = -122.3946;
    var depotLat =  37.7941;

    var jobsStmt = snowflake.createStatement({
        sqlText: "SELECT JOB_ID, NAME, ADDRESS, LONGITUDE, LATITUDE, SKILL, SKILL_LABEL, AMOUNT " +
                 "FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_PHARMA_JOBS ORDER BY JOB_ID"
    });
    var jobsRes = jobsStmt.execute();
    var vroomJobs = [];
    var jobMeta = [];
    while (jobsRes.next()) {
        var id = jobsRes.getColumnValue(1);
        var name = jobsRes.getColumnValue(2);
        var address = jobsRes.getColumnValue(3);
        var lon = jobsRes.getColumnValue(4);
        var lat = jobsRes.getColumnValue(5);
        var skill = jobsRes.getColumnValue(6);
        var skillLbl = jobsRes.getColumnValue(7);
        var amount = jobsRes.getColumnValue(8);
        vroomJobs.push({ id: id, location: [lon, lat], amount: [amount], skills: [skill], description: name });
        jobMeta.push({ name: name, address: address, longitude: lon, latitude: lat, skill: skill, skill_label: skillLbl });
    }
    if (vroomJobs.length === 0) {
        return { error: 'No jobs found in SF_PHARMA_JOBS table. Run setup-agent-playground first.', status: 'FAILED' };
    }
    var vehicles = [
        { id: 1, start: [depotLon, depotLat], end: [depotLon, depotLat],
          profile: PROFILE, capacity: [12], skills: [1],
          description: 'Cold Chain Van (Vaccines & Refrigerated)' },
        { id: 2, start: [depotLon, depotLat], end: [depotLon, depotLat],
          profile: PROFILE, capacity: [12], skills: [2],
          description: 'Controlled Substances Van (Licensed Pharmacist)' },
        { id: 3, start: [depotLon, depotLat], end: [depotLon, depotLat],
          profile: PROFILE, capacity: [12], skills: [3],
          description: 'Standard Delivery Van' }
    ];
    var vroomPayload = JSON.stringify({ jobs: vroomJobs, vehicles: vehicles });
    var optSQL = "SELECT o.RESPONSE, ST_ASGEOJSON(o.GEOJSON) AS GEOJSON " +
                 "FROM TABLE(OPENROUTESERVICE_APP.CORE.OPTIMIZATION(PARSE_JSON(?), ?)) o LIMIT 1";
    var optStmt = snowflake.createStatement({ sqlText: optSQL, binds: [vroomPayload, 'SanFrancisco'] });
    var optRes = optStmt.execute();
    if (!optRes.next()) {
        return { error: 'OPTIMIZATION returned no results', status: 'FAILED' };
    }
    var rawResp = optRes.getColumnValue(1);
    var response = (typeof rawResp === 'string') ? JSON.parse(rawResp || '{}') : (rawResp || {});
    var geojsonRaw = optRes.getColumnValue(2);
    var geojson = geojsonRaw ? ((typeof geojsonRaw === 'string') ? JSON.parse(geojsonRaw) : geojsonRaw) : null;
    return {
        status: 'SUCCESS', num_vehicles: 3,
        jobs: jobMeta, vehicles: vehicles,
        routes: response.routes || [], unassigned: response.unassigned || [],
        summary: response.summary || {},
        depot: { longitude: depotLon, latitude: depotLat, name: 'SF Medical Supply Depot, 1 Market St' },
        geometry: geojson
    };
} catch(err) {
    return { error: err.message, status: 'FAILED' };
}
$$;

ALTER PROCEDURE FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_PHARMA_OPTIMIZATION(VARCHAR) SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

----------------------------------------------------------------------
-- TOOL_PHARMA_CATCHMENT: Population health profile within drive-time
-- catchment of a SF pharmacy. Reads SF_HEALTH_DEMOGRAPHICS.
----------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_PHARMA_CATCHMENT(
    PHARMACY_DESCRIPTION VARCHAR,
    RANGE_MINUTES        FLOAT DEFAULT 10,
    PROFILE              VARCHAR DEFAULT 'driving-car'
)
RETURNS VARIANT
LANGUAGE JAVASCRIPT
EXECUTE AS OWNER
AS
$$
try {
    var geocodeSQL = "SELECT AI_COMPLETE(" +
        "'claude-sonnet-4-5'," +
        "CONCAT('Return ONLY a JSON object with the latitude and longitude of this location in San Francisco. Location: ', ?)," +
        "{'temperature': 0, 'max_tokens': 100}," +
        "{'type': 'json', 'schema': {'type': 'object', 'properties': {" +
            "'latitude': {'type': 'number'}, 'longitude': {'type': 'number'}, 'name': {'type': 'string'}" +
        "}, 'required': ['latitude', 'longitude', 'name']}}" +
        ") AS result";
    var geocodeStmt = snowflake.createStatement({ sqlText: geocodeSQL, binds: [PHARMACY_DESCRIPTION] });
    var geocodeRes = geocodeStmt.execute();
    geocodeRes.next();
    var rawGeo = geocodeRes.getColumnValue(1);
    var loc = (typeof rawGeo === 'string') ? JSON.parse(rawGeo) : rawGeo;
    if (!loc || !loc.latitude || !loc.longitude) {
        return { error: 'Could not geocode pharmacy location', status: 'FAILED' };
    }
    var isoSQL = "SELECT ST_ASGEOJSON(d.GEOJSON) AS GEOJSON_STR, " +
                 "d.RESPONSE:features[0]:properties:area::FLOAT AS AREA_M2 " +
                 "FROM TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES(?, ?, ?, ?::NUMBER, ?)) d LIMIT 1";
    var isoStmt = snowflake.createStatement({
        sqlText: isoSQL,
        binds: [PROFILE, loc.longitude, loc.latitude, RANGE_MINUTES, 'SanFrancisco']
    });
    var isoRes = isoStmt.execute();
    if (!isoRes.next()) {
        return { error: 'Isochrone returned no results for this location', status: 'FAILED' };
    }
    var isoGeoRaw = isoRes.getColumnValue(1);
    var areaM2 = isoRes.getColumnValue(2) || 0;
    var areaKm2 = Math.round(areaM2 / 1000000 * 100) / 100;
    var isoGeojson = isoGeoRaw ? ((typeof isoGeoRaw === 'string') ? JSON.parse(isoGeoRaw) : isoGeoRaw) : null;
    if (!isoGeojson) {
        return { error: 'Isochrone geometry is null', status: 'FAILED' };
    }
    var isoGeojsonStr = JSON.stringify(isoGeojson).replace(/'/g, "''");
    var demoSQL = "SELECT DEMO_ID, NEIGHBORHOOD, LATITUDE, LONGITUDE, TOTAL_POPULATION, " +
                  "PCT_ELDERLY, PCT_CHILDREN, DIABETES_PCT, HYPERTENSION_PCT, " +
                  "CARDIOVASCULAR_PCT, RESPIRATORY_PCT, MOBILITY_ISSUES_PCT, " +
                  "INCOME_BRACKET, CAR_OWNERSHIP_PCT, TRANSIT_ACCESS " +
                  "FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_HEALTH_DEMOGRAPHICS " +
                  "WHERE ST_WITHIN(" +
                  "  TO_GEOGRAPHY(OBJECT_CONSTRUCT('type','Point','coordinates',ARRAY_CONSTRUCT(LONGITUDE::FLOAT,LATITUDE::FLOAT)))," +
                  "  TO_GEOGRAPHY('" + isoGeojsonStr + "')" +
                  ") ORDER BY TOTAL_POPULATION DESC";
    var demoStmt = snowflake.createStatement({ sqlText: demoSQL });
    var demoRes = demoStmt.execute();
    var neighbourhoods = [];
    var totalPop = 0, totalDiabetes = 0, totalHypertension = 0;
    var totalCardio = 0, totalRespiratory = 0, totalMobility = 0;
    var totalElderly = 0, totalChildren = 0, totalLowCar = 0;
    var lowIncome = 0, medIncome = 0, highIncome = 0;
    while (demoRes.next()) {
        var pop = demoRes.getColumnValue(5);
        var diab = demoRes.getColumnValue(8);
        var hyp = demoRes.getColumnValue(9);
        var card = demoRes.getColumnValue(10);
        var resp = demoRes.getColumnValue(11);
        var mob = demoRes.getColumnValue(12);
        var inc = demoRes.getColumnValue(13);
        var car = demoRes.getColumnValue(14);
        var eld = demoRes.getColumnValue(6);
        var chi = demoRes.getColumnValue(7);
        var riskScore = Math.min(100, Math.round(diab * 1.5 + hyp * 0.8 + card * 1.2 + mob * 0.9));
        neighbourhoods.push({
            id: demoRes.getColumnValue(1), neighborhood: demoRes.getColumnValue(2),
            latitude: demoRes.getColumnValue(3), longitude: demoRes.getColumnValue(4),
            population: pop, pct_elderly: eld, pct_children: chi,
            diabetes_pct: diab, hypertension_pct: hyp, cardiovascular_pct: card,
            respiratory_pct: resp, mobility_issues_pct: mob,
            income_bracket: inc, car_ownership_pct: car,
            transit_access: demoRes.getColumnValue(15), risk_score: riskScore
        });
        totalPop += pop;
        totalDiabetes += diab * pop;
        totalHypertension += hyp * pop;
        totalCardio += card * pop;
        totalRespiratory += resp * pop;
        totalMobility += mob * pop;
        totalElderly += eld * pop;
        totalChildren += chi * pop;
        totalLowCar += (100 - car) * pop;
        if (inc === 'LOW') lowIncome += pop;
        else if (inc === 'MEDIUM') medIncome += pop;
        else highIncome += pop;
    }
    if (neighbourhoods.length === 0) {
        return {
            status: 'SUCCESS',
            pharmacy: { name: loc.name, longitude: loc.longitude, latitude: loc.latitude },
            range_minutes: RANGE_MINUTES, geometry: isoGeojson, area_km2: areaKm2,
            message: 'No population data found within catchment area. Try increasing range_minutes or run setup-agent-playground.',
            population_points: [], summary: {}
        };
    }
    var avgDiab = Math.round(totalDiabetes / totalPop * 10) / 10;
    var avgHyp = Math.round(totalHypertension / totalPop * 10) / 10;
    var avgCard = Math.round(totalCardio / totalPop * 10) / 10;
    var avgResp = Math.round(totalRespiratory / totalPop * 10) / 10;
    var avgMob = Math.round(totalMobility / totalPop * 10) / 10;
    var avgEld = Math.round(totalElderly / totalPop * 10) / 10;
    var avgChi = Math.round(totalChildren / totalPop * 10) / 10;
    var pctNoCar = Math.round(totalLowCar / totalPop * 10) / 10;
    var highRisk = neighbourhoods.filter(function(n) { return n.risk_score >= 55; });
    return {
        status: 'SUCCESS',
        pharmacy: { name: loc.name, longitude: loc.longitude, latitude: loc.latitude },
        center: { name: loc.name, longitude: loc.longitude, latitude: loc.latitude },
        range_minutes: RANGE_MINUTES, geometry: isoGeojson,
        area_km2: Math.round(areaKm2 * 100) / 100,
        population_points: neighbourhoods,
        summary: {
            catchment_population: totalPop,
            neighbourhoods_covered: neighbourhoods.length,
            high_risk_neighbourhoods: highRisk.length,
            avg_diabetes_pct: avgDiab, avg_hypertension_pct: avgHyp,
            avg_cardiovascular_pct: avgCard, avg_respiratory_pct: avgResp,
            avg_mobility_issues_pct: avgMob, pct_elderly: avgEld, pct_children: avgChi,
            pct_without_car: pctNoCar,
            income_low_pct: Math.round(lowIncome / totalPop * 1000) / 10,
            income_medium_pct: Math.round(medIncome / totalPop * 1000) / 10,
            income_high_pct: Math.round(highIncome / totalPop * 1000) / 10,
            top_morbidity: avgDiab > avgHyp ? 'Diabetes' : 'Hypertension',
            accessibility_note: pctNoCar > 40 ? 'HIGH dependency on pharmacy — majority of population has no car' :
                                pctNoCar > 25 ? 'MODERATE car-free population — good transit access needed' :
                                'Most residents have car access to pharmacy'
        }
    };
} catch(err) {
    return { error: err.message, status: 'FAILED' };
}
$$;

ALTER PROCEDURE FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_PHARMA_CATCHMENT(VARCHAR, FLOAT, VARCHAR) SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

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
    5. Pharmaceutical supply chain planning (San Francisco demo) — pharmacy catchment
       analysis, drug demand estimation, and multi-vehicle delivery optimization.

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
      Map the user's mode of travel to the profile arg using the profiles loaded in the
      default ORS_SERVICE (driving-car, driving-hgv, cycling-electric):
        - "cycle" / "bike" / "biking" / "cycling" / "ebike" / "e-bike" -> profile=cycling-electric
        - "truck" / "lorry" / "HGV" / "freight" / "heavy goods" -> profile=driving-hgv
        - "drive" / "driving" / "by car" (or unspecified) -> profile=driving-car
      If the user explicitly asks for a profile that is NOT in
      {driving-car, driving-hgv, cycling-electric} (e.g. "walking", "cycling-regular",
      "foot-walking", "cycling-mountain"), still attempt the call but expect the tool
      to return an error like "Parameter 'profile' has incorrect value of 'unknown'".
      When that happens, explain that this OpenRouteService instance only has
      driving-car, driving-hgv, and cycling-electric loaded, and offer to retry with
      one of those.
      Pass a single lowercase category keyword for poi_category (e.g. "cafe", "restaurant",
      "bar", "pharmacy", "park", "supermarket", "hotel").
    - Pharmaceutical supply chain (full SF plan, all pharmacies, 3 specialist vehicles):
      Use tool_supply_chain. This tool has ALL data pre-loaded — do NOT ask the user
      for pharmacy addresses or depot info.
    - Pharma fleet delivery demo (30 pre-geocoded SF stops with 3 vehicles):
      Use tool_pharma_optimization.
    - Population health / catchment analysis around a SF pharmacy:
      Use tool_pharma_catchment.
    - The pharma tools (tool_supply_chain, tool_pharma_optimization, tool_pharma_catchment)
      require setup-agent-playground to have run. If they return "No jobs found" or similar,
      surface that message to the user.
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
            description: "Transport mode. Loaded in default install: driving-car, driving-hgv, cycling-electric. Default: driving-car. (Other ORS profile names like cycling-regular, cycling-mountain, foot-walking are valid identifiers but require a different ORS install to be available.)"
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
            description: "Transport mode. Loaded in default install: driving-car, driving-hgv, cycling-electric. Default: driving-car. (Other ORS profile names like cycling-regular, cycling-mountain, foot-walking are valid identifiers but require a different ORS install to be available.)"
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
            description: "Transport mode. Loaded in default install: driving-car, driving-hgv, cycling-electric. Map cycle/bike/ebike to cycling-electric, truck/HGV to driving-hgv, otherwise driving-car. Default: driving-car."
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
            description: "Transport mode. Loaded in default install: driving-car, driving-hgv, cycling-electric. Default: driving-car. (Other ORS profile names like cycling-regular, cycling-mountain, foot-walking are valid identifiers but require a different ORS install to be available.)"
          region:
            type: string
            description: "Provisioned ORS region for routing (e.g. California, Germany, UnitedStatesOfAmerica). Default: California"
        required: [delivery_locations, depot_location, num_vehicles]
  - tool_spec:
      type: generic
      name: tool_supply_chain
      description: "Run the FULL pre-configured pharmaceutical supply chain delivery plan for San Francisco. Uses ALL pre-loaded data: 6 SF top pharmacies, SF health demographics (55 neighborhoods), drug formulary (25 drugs across 5 conditions), and 3 specialist vehicles (cold chain, controlled substances, standard). Depot at 1 Market Street. Do NOT ask the user for any data. Requires setup-agent-playground."
      input_schema:
        type: object
        properties:
          profile:
            type: string
            description: "Transport mode. Default: driving-car"
  - tool_spec:
      type: generic
      name: tool_pharma_optimization
      description: "Run the pre-configured 30-stop SF pharmaceutical fleet delivery optimization with 3 specialist vehicles (cold chain van, controlled substances van, standard delivery van). Do NOT ask the user for addresses. Requires setup-agent-playground."
      input_schema:
        type: object
        properties:
          profile:
            type: string
            description: "Transport mode. Default: driving-car"
  - tool_spec:
      type: generic
      name: tool_pharma_catchment
      description: "Analyse population health demographics within a drive-time catchment of a San Francisco pharmacy. Returns morbidity rates (diabetes, hypertension, cardiovascular, respiratory, mobility), population counts, income/car-ownership distribution, and a per-neighborhood risk score. Requires setup-agent-playground."
      input_schema:
        type: object
        properties:
          pharmacy_description:
            type: string
            description: "Description of the pharmacy location, e.g. 'Walgreens at 498 Castro Street, San Francisco'"
          range_minutes:
            type: number
            description: "Drive time in minutes for catchment area. Default: 10"
          profile:
            type: string
            description: "Transport mode. Default: driving-car"
        required: [pharmacy_description]
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
  tool_supply_chain:
    type: procedure
    identifier: FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_SUPPLY_CHAIN
    execution_environment:
      warehouse: ROUTING_ANALYTICS
  tool_pharma_optimization:
    type: procedure
    identifier: FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_PHARMA_OPTIMIZATION
    execution_environment:
      warehouse: ROUTING_ANALYTICS
  tool_pharma_catchment:
    type: procedure
    identifier: FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_PHARMA_CATCHMENT
    execution_environment:
      warehouse: ROUTING_ANALYTICS
$$;

-- Validation
SELECT 'TOOL_DIRECTIONS' AS OBJECT, 'PROCEDURE' AS TYPE FROM INFORMATION_SCHEMA.PROCEDURES WHERE PROCEDURE_SCHEMA = 'ROUTING_AGENT' AND PROCEDURE_NAME = 'TOOL_DIRECTIONS'
UNION ALL SELECT 'TOOL_ISOCHRONE', 'PROCEDURE' FROM INFORMATION_SCHEMA.PROCEDURES WHERE PROCEDURE_SCHEMA = 'ROUTING_AGENT' AND PROCEDURE_NAME = 'TOOL_ISOCHRONE'
UNION ALL SELECT 'TOOL_POI_IN_ISOCHRONE', 'PROCEDURE' FROM INFORMATION_SCHEMA.PROCEDURES WHERE PROCEDURE_SCHEMA = 'ROUTING_AGENT' AND PROCEDURE_NAME = 'TOOL_POI_IN_ISOCHRONE'
UNION ALL SELECT 'TOOL_ROUTE_OPTIMIZATION', 'PROCEDURE' FROM INFORMATION_SCHEMA.PROCEDURES WHERE PROCEDURE_SCHEMA = 'ROUTING_AGENT' AND PROCEDURE_NAME = 'TOOL_ROUTE_OPTIMIZATION'
UNION ALL SELECT 'TOOL_SUPPLY_CHAIN', 'PROCEDURE' FROM INFORMATION_SCHEMA.PROCEDURES WHERE PROCEDURE_SCHEMA = 'ROUTING_AGENT' AND PROCEDURE_NAME = 'TOOL_SUPPLY_CHAIN'
UNION ALL SELECT 'TOOL_PHARMA_OPTIMIZATION', 'PROCEDURE' FROM INFORMATION_SCHEMA.PROCEDURES WHERE PROCEDURE_SCHEMA = 'ROUTING_AGENT' AND PROCEDURE_NAME = 'TOOL_PHARMA_OPTIMIZATION'
UNION ALL SELECT 'TOOL_PHARMA_CATCHMENT', 'PROCEDURE' FROM INFORMATION_SCHEMA.PROCEDURES WHERE PROCEDURE_SCHEMA = 'ROUTING_AGENT' AND PROCEDURE_NAME = 'TOOL_PHARMA_CATCHMENT';
