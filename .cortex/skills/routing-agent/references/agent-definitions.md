# Agent Definitions Reference

SQL and Python definitions for the OpenRouteService Routing Agent.

---

## TOOL_DIRECTIONS Procedure

Wraps ORS DIRECTIONS with AI geocoding for natural language location input.

```sql
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

    -- Check if geocoding returned anything
    IF (v_locations IS NULL) THEN
        RETURN OBJECT_CONSTRUCT('error', 'ROUTING FAILED: Geocoding returned no locations. Could not parse locations from the description.', 'status', 'FAILED');
    END IF;

    -- Check if ORS returned an error
    IF (v_ors_error IS NOT NULL) THEN
        RETURN OBJECT_CONSTRUCT('error', CONCAT('ROUTING FAILED: OpenRouteService returned an error: ', v_ors_error::VARCHAR), 'locations_requested', v_locations, 'status', 'FAILED');
    END IF;

    -- Check if ORS returned actual route data (distance/geometry)
    IF (v_distance_raw IS NULL OR v_geometry IS NULL) THEN
        RETURN OBJECT_CONSTRUCT(
            'error', 'ROUTING FAILED: OpenRouteService could not compute a route between the requested locations. This typically means the locations are OUTSIDE the loaded map region. The routing engine only has map data for a specific geographic area. Please request routes only within the supported region.',
            'locations_requested', v_locations,
            'status', 'FAILED'
        );
    END IF;

    -- All good - return full result
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
```

```sql
ALTER PROCEDURE FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_DIRECTIONS(VARCHAR, VARCHAR) SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

---

## TOOL_ISOCHRONE Procedure

Wraps ORS ISOCHRONES with AI geocoding for natural language location input.

```sql
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
                 TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES(?, geocoded_result:longitude::FLOAT, geocoded_result:latitude::FLOAT, ?::NUMBER)) i
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

    -- Check if geocoding returned anything
    IF (v_center IS NULL) THEN
        RETURN OBJECT_CONSTRUCT('error', 'ISOCHRONE FAILED: Geocoding returned no location. Could not parse location from the description.', 'status', 'FAILED');
    END IF;

    -- Check if ORS returned an error
    IF (v_ors_error IS NOT NULL) THEN
        RETURN OBJECT_CONSTRUCT('error', CONCAT('ISOCHRONE FAILED: OpenRouteService returned an error: ', v_ors_error::VARCHAR), 'location_requested', v_center, 'status', 'FAILED');
    END IF;

    -- Check if ORS returned actual isochrone data
    IF (v_geometry IS NULL) THEN
        RETURN OBJECT_CONSTRUCT(
            'error', 'ISOCHRONE FAILED: OpenRouteService could not compute an isochrone for the requested location. This typically means the location is OUTSIDE the loaded map region. The routing engine only has map data for a specific geographic area. Please request isochrones only within the supported region.',
            'location_requested', v_center,
            'status', 'FAILED'
        );
    END IF;

    -- All good - return full result
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
        RETURN OBJECT_CONSTRUCT('error', 'TOOL_ISOCHRONE failed: ' || SQLERRM, 'sqlcode', SQLCODE, 'status', 'FAILED');
END;
$$;
```

```sql
ALTER PROCEDURE FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ISOCHRONE(VARCHAR, NUMBER, VARCHAR) SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

---

## TOOL_OPTIMIZATION Procedure

Wraps ORS OPTIMIZATION with AI geocoding for multi-stop delivery routing (Python).

```sql
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_OPTIMIZATION(
    DELIVERY_LOCATIONS VARCHAR,
    DEPOT_LOCATION VARCHAR,
    NUM_VEHICLES NUMBER,
    PROFILE VARCHAR DEFAULT 'driving-car'
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

def run(session: Session, delivery_locations: str, depot_location: str, num_vehicles: int, profile: str) -> dict:
    try:
        # Geocode delivery locations
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

        # Geocode depot location
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

        # Build jobs array
        jobs = []
        for i, loc in enumerate(delivery_data.get('locations', []), start=1):
            jobs.append({
                'id': i,
                'location': [loc['longitude'], loc['latitude']],
                'description': loc['name']
            })

        # Build vehicles array
        vehicles = []
        for i in range(1, num_vehicles + 1):
            vehicles.append({
                'id': i,
                'profile': profile,
                'start': [depot_data['longitude'], depot_data['latitude']],
                'end': [depot_data['longitude'], depot_data['latitude']]
            })

        # Call optimization
        jobs_json = json.dumps(jobs).replace("'", "''")
        vehicles_json = json.dumps(vehicles).replace("'", "''")

        opt_query = f"""
        SELECT RESPONSE AS result FROM TABLE(OPENROUTESERVICE_APP.CORE.OPTIMIZATION(
            PARSE_JSON('{jobs_json}')::ARRAY,
            PARSE_JSON('{vehicles_json}')::ARRAY
        ))
        """
        opt_result = session.sql(opt_query).collect()[0]['RESULT']
        opt_data = json.loads(opt_result) if isinstance(opt_result, str) else opt_result

        # Check for ORS error in response
        if 'error' in opt_data:
            return {
                'error': f"OPTIMIZATION FAILED: OpenRouteService returned an error: {opt_data['error']}",
                'deliveries_requested': delivery_data.get('locations', []),
                'depot_requested': depot_data,
                'status': 'FAILED'
            }

        # Check if routes were actually computed
        routes = opt_data.get('routes', [])
        if not routes:
            return {
                'error': 'OPTIMIZATION FAILED: OpenRouteService could not compute routes for the requested locations. This typically means the locations are OUTSIDE the loaded map region. The routing engine only has map data for a specific geographic area.',
                'deliveries_requested': delivery_data.get('locations', []),
                'depot_requested': depot_data,
                'status': 'FAILED'
            }

        # Check for unassigned jobs (all unassigned means routing failure)
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
```

```sql
ALTER PROCEDURE FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_OPTIMIZATION(VARCHAR, VARCHAR, NUMBER, VARCHAR) SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

---

## CREATE AGENT Specification

Creates the Cortex Agent with tool bindings to the three stored procedures.

```sql
CREATE OR REPLACE AGENT FLEET_INTELLIGENCE.ROUTING_AGENT.ROUTING_AGENT
COMMENT = 'Routing agent using OpenRouteService for directions, isochrones, and optimization within the loaded map region.'
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
    - Reachability questions: Use tool_isochrone
    - Multi-stop optimization: Use tool_optimization
    - ALWAYS use a tool for routing questions. NEVER answer from general knowledge.
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
  tool_optimization:
    type: procedure
    identifier: FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_OPTIMIZATION
    execution_environment:
      warehouse: ROUTING_ANALYTICS
$$;
```

---

## Register Agent with Snowflake Intelligence

```sql
ALTER SNOWFLAKE INTELLIGENCE SNOWFLAKE_INTELLIGENCE_OBJECT_DEFAULT 
ADD AGENT FLEET_INTELLIGENCE.ROUTING_AGENT.ROUTING_AGENT;
```
