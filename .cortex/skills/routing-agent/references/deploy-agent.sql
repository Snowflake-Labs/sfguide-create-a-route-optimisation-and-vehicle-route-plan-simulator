-- deploy-agent.sql
-- Generated from agent-definitions.md
-- Deploys all routing agent procedures and Cortex Agent to FLEET_INTELLIGENCE.ROUTING_AGENT

-- Prerequisites: FLEET_INTELLIGENCE database and ROUTING_AGENT schema must exist

USE WAREHOUSE ROUTING_ANALYTICS;

----------------------------------------------------------------------
-- TOOL_DIRECTIONS: Wraps ORS DIRECTIONS with AI geocoding
----------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_DIRECTIONS(
    LOCATIONS_DESCRIPTION VARCHAR,
    PROFILE VARCHAR DEFAULT 'driving-car'
)
RETURNS VARIANT
LANGUAGE SQL
AS
$$
DECLARE
    result_cursor CURSOR FOR
        WITH geocoded AS (
            SELECT AI_COMPLETE(
                'claude-sonnet-4-5',
                CONCAT('Extract all locations from this description and return their coordinates. Be precise with worldwide lat/lon coordinates. Description: ', ?),
                {'temperature': 0, 'max_tokens': 2000},
                {'type': 'json', 'schema': {'type': 'object', 'properties': {'locations': {'type': 'array', 'items': {'type': 'object', 'properties': {'name': {'type': 'string'}, 'longitude': {'type': 'number'}, 'latitude': {'type': 'number'}}, 'required': ['name', 'longitude', 'latitude']}}}}}
            ) AS geocoded_result
        ),
        coordinates AS (
            SELECT ARRAY_AGG(ARRAY_CONSTRUCT(value:longitude::FLOAT, value:latitude::FLOAT)) AS coords,
                   geocoded_result AS geo
            FROM geocoded, TABLE(FLATTEN(geocoded.geocoded_result, 'locations'))
            GROUP BY geocoded_result
        ),
        directions AS (
            SELECT geo, coords, d.RESPONSE AS dir_result
            FROM coordinates,
                 TABLE(OPENROUTESERVICE_APP.CORE.DIRECTIONS(?, OBJECT_CONSTRUCT('coordinates', coords)::VARIANT)) d
        )
        SELECT
            geo:locations AS locations,
            ? AS profile,
            dir_result:features[0]:properties:summary:distance::FLOAT AS distance_raw,
            dir_result:features[0]:properties:summary:duration::FLOAT AS duration_raw,
            dir_result:features[0]:properties:segments AS segments,
            dir_result:features[0]:geometry AS geometry,
            dir_result:error AS ors_error
        FROM directions;
    v_locations VARIANT;
    v_profile VARCHAR;
    v_distance_raw FLOAT;
    v_duration_raw FLOAT;
    v_segments VARIANT;
    v_geometry VARIANT;
    v_ors_error VARIANT;
BEGIN
    OPEN result_cursor USING (LOCATIONS_DESCRIPTION, PROFILE, PROFILE);
    FETCH result_cursor INTO v_locations, v_profile, v_distance_raw, v_duration_raw, v_segments, v_geometry, v_ors_error;
    CLOSE result_cursor;

    IF (v_locations IS NULL) THEN
        RETURN OBJECT_CONSTRUCT('error', 'ROUTING FAILED: Geocoding returned no locations. Could not parse locations from the description.', 'status', 'FAILED');
    END IF;

    IF (v_ors_error IS NOT NULL) THEN
        RETURN OBJECT_CONSTRUCT('error', CONCAT('ROUTING FAILED: OpenRouteService returned an error: ', v_ors_error::VARCHAR), 'locations_requested', v_locations, 'status', 'FAILED');
    END IF;

    IF (v_distance_raw IS NULL OR v_geometry IS NULL) THEN
        RETURN OBJECT_CONSTRUCT(
            'error', 'ROUTING FAILED: OpenRouteService could not compute a route between the requested locations. This typically means the locations are OUTSIDE the loaded map region. The routing engine only has map data for a specific geographic area. Please request routes only within the supported region.',
            'locations_requested', v_locations,
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
        'status', 'SUCCESS'
    );
EXCEPTION
    WHEN OTHER THEN
        RETURN OBJECT_CONSTRUCT('error', 'TOOL_DIRECTIONS failed: ' || SQLERRM, 'sqlcode', SQLCODE, 'status', 'FAILED');
END;
$$;

ALTER PROCEDURE FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_DIRECTIONS(VARCHAR, VARCHAR) SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

----------------------------------------------------------------------
-- TOOL_ISOCHRONES: Wraps ORS ISOCHRONES with AI geocoding
----------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ISOCHRONES(
    LOCATION_DESCRIPTION VARCHAR,
    RANGE_MINUTES NUMBER DEFAULT 10,
    PROFILE VARCHAR DEFAULT 'driving-car'
)
RETURNS VARIANT
LANGUAGE SQL
AS
$$
DECLARE
    result_cursor CURSOR FOR
        WITH geocoded AS (
            SELECT AI_COMPLETE(
                'claude-sonnet-4-5',
                CONCAT('Extract the location from this description and return its coordinates. Be precise with worldwide lat/lon. Description: ', ?),
                {'temperature': 0, 'max_tokens': 1000},
                {'type': 'json', 'schema': {'type': 'object', 'properties': {'name': {'type': 'string'}, 'longitude': {'type': 'number'}, 'latitude': {'type': 'number'}}, 'required': ['name', 'longitude', 'latitude']}}
            ) AS geocoded_result
        ),
        isochrone AS (
            SELECT geocoded_result AS geo, i.RESPONSE AS iso_result
            FROM geocoded,
                 TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES(?, geocoded_result:longitude::FLOAT, geocoded_result:latitude::FLOAT, ?::INT)) i
        )
        SELECT
            geo AS center,
            ?::NUMBER AS range_minutes,
            ? AS profile,
            iso_result:features[0]:properties:area::FLOAT AS area_raw,
            iso_result:features[0]:geometry AS geometry,
            iso_result:error AS ors_error
        FROM isochrone;
    v_center VARIANT;
    v_range_minutes NUMBER;
    v_profile VARCHAR;
    v_area_raw FLOAT;
    v_geometry VARIANT;
    v_ors_error VARIANT;
BEGIN
    OPEN result_cursor USING (LOCATION_DESCRIPTION, PROFILE, RANGE_MINUTES, RANGE_MINUTES, PROFILE);
    FETCH result_cursor INTO v_center, v_range_minutes, v_profile, v_area_raw, v_geometry, v_ors_error;
    CLOSE result_cursor;

    IF (v_center IS NULL) THEN
        RETURN OBJECT_CONSTRUCT('error', 'ISOCHRONE FAILED: Geocoding returned no location. Could not parse location from the description.', 'status', 'FAILED');
    END IF;

    IF (v_ors_error IS NOT NULL) THEN
        RETURN OBJECT_CONSTRUCT('error', CONCAT('ISOCHRONE FAILED: OpenRouteService returned an error: ', v_ors_error::VARCHAR), 'location_requested', v_center, 'status', 'FAILED');
    END IF;

    IF (v_geometry IS NULL) THEN
        RETURN OBJECT_CONSTRUCT(
            'error', 'ISOCHRONE FAILED: OpenRouteService could not compute an isochrone for the requested location. This typically means the location is OUTSIDE the loaded map region. The routing engine only has map data for a specific geographic area. Please request isochrones only within the supported region.',
            'location_requested', v_center,
            'status', 'FAILED'
        );
    END IF;

    RETURN OBJECT_CONSTRUCT(
        'center', v_center,
        'range_minutes', v_range_minutes,
        'profile', v_profile,
        'area_km2', ROUND(DIV0(v_area_raw, 1000000), 2),
        'geometry', v_geometry,
        'status', 'SUCCESS'
    );
EXCEPTION
    WHEN OTHER THEN
        RETURN OBJECT_CONSTRUCT('error', 'TOOL_ISOCHRONES failed: ' || SQLERRM, 'sqlcode', SQLCODE, 'status', 'FAILED');
END;
$$;

ALTER PROCEDURE FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ISOCHRONES(VARCHAR, NUMBER, VARCHAR) SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

----------------------------------------------------------------------
-- TOOL_ROUTE_OPTIMIZATION: Wraps ORS OPTIMIZATION with AI geocoding (JavaScript)
-- NOTE: Uses JavaScript because it handles JSON manipulation more naturally
-- for building VROOM-format payloads.
----------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ROUTE_OPTIMIZATION(
    DESCRIPTION VARCHAR,
    NUM_VEHICLES FLOAT DEFAULT 1,
    PROFILE VARCHAR DEFAULT 'driving-car'
)
RETURNS VARIANT
LANGUAGE JAVASCRIPT
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
try {
    var geocodeSQL = "SELECT AI_COMPLETE(" +
        "'claude-sonnet-4-5'," +
        "CONCAT('Parse this routing problem into separate lists for jobs (deliveries/stops) and vehicles (start/end points). Use worldwide lat/lon coordinates. Description: ', ?)," +
        "{'temperature': 0, 'max_tokens': 3000}," +
        "{'type': 'json', 'schema': {'type': 'object', 'properties': {" +
            "'jobs': {'type': 'array', 'items': {'type': 'object', 'properties': {'name': {'type': 'string'}, 'longitude': {'type': 'number'}, 'latitude': {'type': 'number'}}, 'required': ['name', 'longitude', 'latitude']}}," +
            "'vehicles': {'type': 'array', 'items': {'type': 'object', 'properties': {'name': {'type': 'string'}, 'start_longitude': {'type': 'number'}, 'start_latitude': {'type': 'number'}, 'end_longitude': {'type': 'number'}, 'end_latitude': {'type': 'number'}}, 'required': ['name', 'start_longitude', 'start_latitude', 'end_longitude', 'end_latitude']}}" +
        "}, 'required': ['jobs', 'vehicles']}}" +
        ") AS result";
    var geocodeStmt = snowflake.createStatement({ sqlText: geocodeSQL, binds: [DESCRIPTION] });
    var geocodeRes = geocodeStmt.execute();
    geocodeRes.next();
    var raw = geocodeRes.getColumnValue(1);
    var geocoded = (typeof raw === 'string') ? JSON.parse(raw) : raw;
    if (!geocoded.jobs || geocoded.jobs.length === 0) {
        return { error: 'Geocoding returned no jobs', status: 'FAILED' };
    }
    if (!geocoded.vehicles || geocoded.vehicles.length === 0) {
        return { error: 'Geocoding returned no vehicles', status: 'FAILED' };
    }
    var jobs = geocoded.jobs.map(function(j, i) {
        return { id: i + 1, location: [j.longitude, j.latitude], amount: [1], description: j.name };
    });
    var vehicles = geocoded.vehicles.map(function(v, i) {
        return { id: i + 1, start: [v.start_longitude, v.start_latitude], end: [v.end_longitude, v.end_latitude], profile: PROFILE, capacity: [jobs.length] };
    });
    var vroomPayload = JSON.stringify({ jobs: jobs, vehicles: vehicles });
    var optSQL = "SELECT o.RESPONSE, ST_ASGEOJSON(o.GEOJSON) AS GEOJSON FROM TABLE(OPENROUTESERVICE_APP.CORE.OPTIMIZATION(PARSE_JSON(?), ?)) o LIMIT 1";
    var optStmt = snowflake.createStatement({ sqlText: optSQL, binds: [vroomPayload, PROFILE] });
    var optRes = optStmt.execute();
    if (!optRes.next()) {
        return { error: 'OPTIMIZATION returned no results', status: 'FAILED', jobs: geocoded.jobs, vehicles: geocoded.vehicles };
    }
    var rawResp = optRes.getColumnValue(1);
    var response = (typeof rawResp === 'string') ? JSON.parse(rawResp || '{}') : (rawResp || {});
    var geojsonRaw = optRes.getColumnValue(2);
    var geojson = geojsonRaw ? ((typeof geojsonRaw === 'string') ? JSON.parse(geojsonRaw) : geojsonRaw) : null;
    if (response.code && response.code !== 0) {
        return { error: 'VROOM error: ' + JSON.stringify(response), status: 'FAILED' };
    }
    return { status: 'SUCCESS', num_vehicles: geocoded.vehicles.length, jobs: geocoded.jobs, vehicles: geocoded.vehicles, routes: response.routes || [], depot: geocoded.vehicles[0] ? { longitude: geocoded.vehicles[0].start_longitude, latitude: geocoded.vehicles[0].start_latitude, name: geocoded.vehicles[0].name } : null, geometry: geojson };
} catch(err) {
    return { error: err.message, status: 'FAILED' };
}
$$;

ALTER PROCEDURE FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ROUTE_OPTIMIZATION(VARCHAR, FLOAT, VARCHAR) SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

----------------------------------------------------------------------
-- ROUTING_AGENT: Cortex Agent with tool bindings
----------------------------------------------------------------------
CREATE OR REPLACE AGENT FLEET_INTELLIGENCE.ROUTING_AGENT.ROUTING_AGENT
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
FROM SPECIFICATION $$
models:
  orchestration: auto
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
    4. Pharmaceutical supply chain planning with pre-loaded SF pharmacy data
    5. Population health catchment analysis around pharmacies

    CRITICAL RULES - YOU MUST FOLLOW THESE WITHOUT EXCEPTION:

    1. NEVER provide distances, durations, route details, or travel advice from your own knowledge.
       ALL routing information MUST come from the tool results. You are NOT a general travel advisor.

    2. ALWAYS call the appropriate tool for ANY routing question. Never answer routing questions
       without using a tool first.

    3. After calling a tool, check the result for a "status" field:
       - If status is "FAILED" or the result contains an "error" field: Report the EXACT error
         message to the user. Do NOT attempt to answer the question yourself.
       - If status is "SUCCESS": Use ONLY the data returned by the tool to answer.

    4. If a tool fails because locations are outside the map region, tell the user:
       "The requested locations are outside the map region loaded in OpenRouteService."
       Do NOT follow up with general travel advice or estimated distances.

    5. NEVER claim you used a tool if you did not. NEVER fabricate tool results.

    6. For pharmaceutical supply chain questions (deliver to pharmacies, fleet demo, supply chain plan),
       use tool_supply_chain. This tool has ALL data pre-loaded: 6 SF pharmacies, health demographics,
       drug formulary, and 3 specialist vehicles. Do NOT ask the user for pharmacy addresses or depot info.

    7. For catchment/population health analysis around a pharmacy, use tool_pharma_catchment.

    8. For the pharma fleet delivery demo with 30 stops, use tool_pharma_optimization.

    Transport profiles: driving-car, driving-hgv, cycling-electric
  response: |
    Be concise. Format results clearly:
    - Distances in km, durations in minutes
    - For optimization, summarize vehicle assignments and total distance/duration
    - For supply chain, summarize by vehicle type (cold chain, controlled, standard)
    - If a tool returns an error, report it clearly without supplementing from your knowledge.
  orchestration: |
    - Directions between locations: Use tool_directions
    - Reachability/isochrone questions: Use tool_isochrone
    - Multi-stop optimization with user-provided locations: Use tool_optimization
    - Full pharmaceutical supply chain plan (all SF pharmacies): Use tool_supply_chain
    - Pharma fleet delivery demo (30 pre-geocoded stops): Use tool_pharma_optimization
    - Population health / catchment analysis around a pharmacy: Use tool_pharma_catchment
    - ALWAYS use a tool for routing questions. NEVER answer from general knowledge.
tools:
  - tool_spec:
      type: generic
      name: tool_directions
      description: "Get directions between locations with distance, duration, turn-by-turn instructions."
      input_schema:
        type: object
        properties:
          locations_description:
            type: string
            description: "Locations to route between, e.g. 'from 498 Castro Street to Union Square, San Francisco'"
          profile:
            type: string
            description: "Transport mode: driving-car, cycling-electric, or driving-hgv. Default: driving-car"
        required: [locations_description]
  - tool_spec:
      type: generic
      name: tool_isochrone
      description: "Get area reachable within specified minutes from a location. Returns an isochrone polygon."
      input_schema:
        type: object
        properties:
          location_description:
            type: string
            description: "Center location, e.g. '498 Castro Street, San Francisco'"
          range_minutes:
            type: number
            description: "Minutes of travel time (1-60)"
          profile:
            type: string
            description: "Transport mode. Default: driving-car"
        required: [location_description, range_minutes]
  - tool_spec:
      type: generic
      name: tool_optimization
      description: "Optimize delivery routes for multiple stops with multiple vehicles. User must provide delivery locations and depot address."
      input_schema:
        type: object
        properties:
          delivery_locations:
            type: string
            description: "All delivery locations to visit"
          depot_location:
            type: string
            description: "Start/end location for vehicles (the depot/warehouse)"
          num_vehicles:
            type: number
            description: "Number of vehicles available"
          profile:
            type: string
            description: "Transport mode. Default: driving-car"
        required: [delivery_locations, depot_location, num_vehicles]
  - tool_spec:
      type: generic
      name: tool_supply_chain
      description: "Run the FULL pre-configured pharmaceutical supply chain delivery plan. Uses ALL pre-loaded data: 6 SF pharmacies, SF health demographics, drug formulary (25 drugs across 5 conditions), and 3 specialist vehicles (cold chain, controlled substances, standard medicines). The depot is at 1 Market Street. Do NOT ask the user for any data - everything is pre-configured."
      input_schema:
        type: object
        properties:
          profile:
            type: string
            description: "Transport mode. Default: driving-car"
  - tool_spec:
      type: generic
      name: tool_pharma_optimization
      description: "Run pre-configured multi-vehicle pharmaceutical delivery optimization using 30 pre-geocoded SF delivery stops and 3 specialist vehicles (cold chain van, controlled substances van, standard delivery van). Do NOT ask the user for addresses."
      input_schema:
        type: object
        properties:
          profile:
            type: string
            description: "Transport mode. Default: driving-car"
  - tool_spec:
      type: generic
      name: tool_pharma_catchment
      description: "Analyse population health demographics within a drive-time catchment of a pharmacy. Returns morbidity rates (diabetes, hypertension, cardiovascular, respiratory, mobility issues), population counts, and drug demand estimates for the area."
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
      type: warehouse
      warehouse: ROUTING_ANALYTICS
  tool_isochrone:
    type: procedure
    identifier: FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ISOCHRONES
    execution_environment:
      type: warehouse
      warehouse: ROUTING_ANALYTICS
  tool_optimization:
    type: procedure
    identifier: FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ROUTE_OPTIMIZATION
    execution_environment:
      type: warehouse
      warehouse: ROUTING_ANALYTICS
  tool_supply_chain:
    type: procedure
    identifier: FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_SUPPLY_CHAIN
    execution_environment:
      type: warehouse
      warehouse: ROUTING_ANALYTICS
  tool_pharma_optimization:
    type: procedure
    identifier: FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_PHARMA_OPTIMIZATION
    execution_environment:
      type: warehouse
      warehouse: ROUTING_ANALYTICS
  tool_pharma_catchment:
    type: procedure
    identifier: FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_PHARMA_CATCHMENT
    execution_environment:
      type: warehouse
      warehouse: ROUTING_ANALYTICS
$$;

----------------------------------------------------------------------
-- Grant access and register with Snowflake Intelligence
----------------------------------------------------------------------
GRANT USAGE ON AGENT FLEET_INTELLIGENCE.ROUTING_AGENT.ROUTING_AGENT TO ROLE ALL_AGENTS_ROLE;

ALTER SNOWFLAKE INTELLIGENCE SNOWFLAKE_INTELLIGENCE_OBJECT_DEFAULT 
ADD AGENT FLEET_INTELLIGENCE.ROUTING_AGENT.ROUTING_AGENT;
