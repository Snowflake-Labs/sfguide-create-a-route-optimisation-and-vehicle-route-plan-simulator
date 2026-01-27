---
name: openrouteservice-intelligence-demo
description: "Create Snowflake Intelligence agent for OpenRouteService routing functions. Use when: setting up ORS demo, creating route planning agent, integrating directions/isochrones/optimization with Cortex. Triggers: openrouteservice demo, routing agent, ORS agent, routing intelligence."
---

# OpenRouteService Intelligence Demo

Create a Snowflake Intelligence agent that provides AI-powered route planning using OpenRouteService functions with natural language geocoding.

## Configuration

This skill uses the following values:
- **Database:** `OPENROUTESERVICE_NATIVE_APP`
- **Schema:** `CORE`
- **Warehouse:** `ROUTING_ANALYTICS`
- **Agent Name:** `ROUTING_AGENT`

## Prerequisites

- OpenRouteService Native App installed with functions: `DIRECTIONS`, `ISOCHRONES`, `OPTIMIZATION`
- Cortex AI access (claude-sonnet-4-5 for geocoding)
- ACCOUNTADMIN or equivalent role for agent creation

## Workflow

### Step 1: Verify ORS Functions and Services

**Goal:** Confirm OpenRouteService functions are available AND services are running.

**1a. Check functions exist:**
```sql
SHOW USER FUNCTIONS IN SCHEMA OPENROUTESERVICE_NATIVE_APP.CORE;
```

Verify these functions exist:
- `DIRECTIONS(VARCHAR, VARIANT)` or `DIRECTIONS(VARCHAR, FLOAT, FLOAT, FLOAT, FLOAT)`
- `ISOCHRONES(VARCHAR, FLOAT, FLOAT, NUMBER)`
- `OPTIMIZATION(VARIANT, VARIANT)`

**If missing:** Ask User to Install OpenRouteService Native App.

**1b. Check services are running (CRITICAL):**
```sql
SHOW SERVICES IN SCHEMA OPENROUTESERVICE_NATIVE_APP.CORE;
```

Verify these services have status=RUNNING:
- `ORS_SERVICE` - powers DIRECTIONS and ISOCHRONES
- `VROOM_SERVICE` - powers OPTIMIZATION
- `ROUTING_GATEWAY_SERVICE` - API gateway

**If any service is SUSPENDED, resume it immediately:**
```sql
ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SERVICE RESUME;
ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.VROOM_SERVICE RESUME;
ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.ROUTING_GATEWAY_SERVICE RESUME;
```

Wait 15-30 seconds for services to start before proceeding.

### Step 2: Create TOOL_DIRECTIONS Procedure

**Goal:** Wrap DIRECTIONS with AI geocoding for natural language input.

```sql
CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_NATIVE_APP.CORE.TOOL_DIRECTIONS(
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
            SELECT geo, coords,
                   OPENROUTESERVICE_NATIVE_APP.CORE.DIRECTIONS(?, OBJECT_CONSTRUCT('coordinates', coords)) AS dir_result
            FROM coordinates
        )
        SELECT OBJECT_CONSTRUCT(
            'locations', geo:locations,
            'profile', ?,
            'distance_km', ROUND(DIV0(dir_result:features[0]:properties:summary:distance::FLOAT, 1000), 2),
            'duration_mins', ROUND(DIV0(dir_result:features[0]:properties:summary:duration::FLOAT, 60), 1),
            'segments', dir_result:features[0]:properties:segments,
            'geometry', dir_result:features[0]:geometry
        ) AS result
        FROM directions;
    result_row VARIANT;
BEGIN
    OPEN result_cursor USING (LOCATIONS_DESCRIPTION, PROFILE, PROFILE);
    FETCH result_cursor INTO result_row;
    CLOSE result_cursor;
    RETURN result_row;
END;
$$;
```

### Step 3: Create TOOL_ISOCHRONE Procedure

**Goal:** Wrap ISOCHRONES with AI geocoding.

```sql
CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_NATIVE_APP.CORE.TOOL_ISOCHRONE(
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
            SELECT geocoded_result AS geo,
                   OPENROUTESERVICE_NATIVE_APP.CORE.ISOCHRONES(?, geo:longitude::FLOAT, geo:latitude::FLOAT, ?) AS iso_result
            FROM geocoded
        )
        SELECT OBJECT_CONSTRUCT(
            'center', geo,
            'range_minutes', ?,
            'profile', ?,
            'area_km2', ROUND(DIV0(iso_result:features[0]:properties:area::FLOAT, 1000000), 2),
            'geometry', iso_result:features[0]:geometry
        ) AS result
        FROM isochrone;
    result_row VARIANT;
BEGIN
    OPEN result_cursor USING (LOCATION_DESCRIPTION, PROFILE, RANGE_MINUTES, RANGE_MINUTES, PROFILE);
    FETCH result_cursor INTO result_row;
    CLOSE result_cursor;
    RETURN result_row;
END;
$$;
```

### Step 4: Create TOOL_OPTIMIZATION Procedure

**Goal:** Wrap OPTIMIZATION with AI geocoding for multi-stop routing.

```sql
CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_NATIVE_APP.CORE.TOOL_OPTIMIZATION(
    DELIVERY_LOCATIONS VARCHAR,
    DEPOT_LOCATION VARCHAR,
    NUM_VEHICLES NUMBER,
    PROFILE VARCHAR DEFAULT 'driving-car'
)
RETURNS VARIANT
LANGUAGE SQL
AS
$$
DECLARE
    result_cursor CURSOR FOR
        WITH delivery_geocoded AS (
            SELECT AI_COMPLETE(
                'claude-sonnet-4-5',
                CONCAT('Extract all delivery locations and return coordinates. Description: ', ?),
                {'temperature': 0, 'max_tokens': 3000},
                {'type': 'json', 'schema': {'type': 'object', 'properties': {'locations': {'type': 'array', 'items': {'type': 'object', 'properties': {'name': {'type': 'string'}, 'longitude': {'type': 'number'}, 'latitude': {'type': 'number'}}, 'required': ['name', 'longitude', 'latitude']}}}}}
            ) AS delivery_result
        ),
        depot_geocoded AS (
            SELECT AI_COMPLETE(
                'claude-sonnet-4-5',
                CONCAT('Extract the depot location coordinates. Description: ', ?),
                {'temperature': 0, 'max_tokens': 1000},
                {'type': 'json', 'schema': {'type': 'object', 'properties': {'name': {'type': 'string'}, 'longitude': {'type': 'number'}, 'latitude': {'type': 'number'}}, 'required': ['name', 'longitude', 'latitude']}}
            ) AS depot_result
        ),
        jobs_built AS (
            SELECT delivery_result,
                   ARRAY_AGG(OBJECT_CONSTRUCT(
                       'id', ROW_NUMBER() OVER (ORDER BY value:name),
                       'location', ARRAY_CONSTRUCT(value:longitude::FLOAT, value:latitude::FLOAT),
                       'description', value:name::STRING
                   )) AS jobs
            FROM delivery_geocoded, TABLE(FLATTEN(delivery_geocoded.delivery_result, 'locations'))
            GROUP BY delivery_result
        ),
        vehicles_built AS (
            SELECT depot_result,
                   ARRAY_AGG(OBJECT_CONSTRUCT(
                       'id', seq4(),
                       'profile', ?,
                       'start', ARRAY_CONSTRUCT(depot_result:longitude::FLOAT, depot_result:latitude::FLOAT),
                       'end', ARRAY_CONSTRUCT(depot_result:longitude::FLOAT, depot_result:latitude::FLOAT)
                   )) AS vehicles
            FROM depot_geocoded, TABLE(GENERATOR(ROWCOUNT => ?))
            GROUP BY depot_result
        ),
        optimized AS (
            SELECT j.delivery_result, v.depot_result, j.jobs, v.vehicles,
                   OPENROUTESERVICE_NATIVE_APP.CORE.OPTIMIZATION(j.jobs, v.vehicles) AS opt_result
            FROM jobs_built j, vehicles_built v
        )
        SELECT OBJECT_CONSTRUCT(
            'deliveries', delivery_result:locations,
            'depot', depot_result,
            'num_vehicles', ?,
            'routes', opt_result:routes,
            'unassigned', opt_result:unassigned,
            'summary', opt_result:summary
        ) AS result
        FROM optimized;
    result_row VARIANT;
BEGIN
    OPEN result_cursor USING (DELIVERY_LOCATIONS, DEPOT_LOCATION, PROFILE, NUM_VEHICLES, NUM_VEHICLES);
    FETCH result_cursor INTO result_row;
    CLOSE result_cursor;
    RETURN result_row;
END;
$$;
```

### Step 5: Create the Agent

**Goal:** Create Cortex Agent with tools pointing to procedures.

```sql
CREATE OR REPLACE AGENT OPENROUTESERVICE_NATIVE_APP.CORE.ROUTING_AGENT
COMMENT = 'Routing agent using OpenRouteService for directions, isochrones, and optimization. Works with any location worldwide.'
PROFILE = '{"display_name": "Routing Agent", "color": "green"}'
FROM SPECIFICATION $$
models:
  orchestration: claude-4-sonnet
orchestration:
  budget:
    seconds: 120
    tokens: 16000
instructions:
  system: |
    You are a routing agent powered by OpenRouteService. You help users with:
    1. Driving/cycling/walking directions between locations
    2. Reachability analysis (isochrones) - areas reachable within X minutes
    3. Multi-stop delivery route optimization
    
    You work with ANY location worldwide. Users describe locations naturally.
    
    Transport profiles: driving-car, driving-hgv, cycling-regular, cycling-mountain, cycling-road, cycling-electric, foot-walking, foot-hiking, wheelchair
  response: |
    Be concise. Format results clearly:
    - Distances in km, durations in minutes
    - For optimization, summarize vehicle assignments
  orchestration: |
    - Directions between locations: Use tool_directions
    - Reachability questions: Use tool_isochrone
    - Multi-stop optimization: Use tool_optimization
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
            description: "Locations to route between, e.g. 'from Times Square to Central Park'"
          profile:
            type: string
            description: "Transport mode. Default: driving-car"
        required: [locations_description]
  - tool_spec:
      type: generic
      name: tool_isochrone
      description: "Get area reachable within specified minutes from a location."
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
      description: "Optimize delivery routes for multiple stops with multiple vehicles."
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
    identifier: OPENROUTESERVICE_NATIVE_APP.CORE.TOOL_DIRECTIONS
    execution_environment:
      warehouse: ROUTING_ANALYTICS
  tool_isochrone:
    type: procedure
    identifier: OPENROUTESERVICE_NATIVE_APP.CORE.TOOL_ISOCHRONE
    execution_environment:
      warehouse: ROUTING_ANALYTICS
  tool_optimization:
    type: procedure
    identifier: OPENROUTESERVICE_NATIVE_APP.CORE.TOOL_OPTIMIZATION
    execution_environment:
      warehouse: ROUTING_ANALYTICS
$;
```

### Step 6: Register Agent with Snowflake Intelligence

**Goal:** Make agent visible in Snowsight UI.

```sql
ALTER SNOWFLAKE INTELLIGENCE SNOWFLAKE_INTELLIGENCE_OBJECT_DEFAULT 
ADD AGENT OPENROUTESERVICE_NATIVE_APP.CORE.ROUTING_AGENT;
```

### Step 7: Test the Agent

**Goal:** Verify agent works.

**Important:** Test queries must use locations within the region configured in OpenRouteService. To determine the region:

1. Check the ORS config file at `oss-install-openrouteservice-native-app/Native_app/provider_setup/staged_files/ors-config.yml`
2. Find the `source_file` value under `ors.engine.profile_default.build` (e.g., `SanFrancisco.osm.pbf`)
3. Extract the region name from the filename (e.g., `SanFrancisco` → "San Francisco")

**BEFORE testing any ORS functions, ALWAYS verify all required services are running:**

```sql
SHOW SERVICES IN SCHEMA OPENROUTESERVICE_NATIVE_APP.CORE;
```

Required services and their functions:
- `ORS_SERVICE` → DIRECTIONS, ISOCHRONES (must be RUNNING)
- `VROOM_SERVICE` → OPTIMIZATION (must be RUNNING)
- `ROUTING_GATEWAY_SERVICE` → API gateway (must be RUNNING)

If any service shows `SUSPENDED`, resume it:
```sql
ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.VROOM_SERVICE RESUME;
ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SERVICE RESUME;
ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.ROUTING_GATEWAY_SERVICE RESUME;
```

Wait 15-30 seconds for services to reach RUNNING status before testing.

**Sample queries by region (all locations must be within the map coverage area):**

| Region | Directions | Isochrone | Optimization |
|--------|-----------|-----------|--------------|
| San Francisco | "Get driving directions from Union Square to Fisherman's Wharf" | "Show areas reachable within 15 minutes by car from Union Square" | "Optimize deliveries to Ferry Building, Pier 39, and Ghirardelli Square with 2 vehicles starting from Union Square, San Francisco" |
| New York | "Get driving directions from Times Square to Central Park" | "Show areas reachable within 15 minutes by car from Grand Central Station" | "Optimize deliveries to Empire State Building, Rockefeller Center, and Times Square with 2 vehicles starting from Grand Central Station" |
| London | "Get driving directions from Tower Bridge to Buckingham Palace" | "Show areas reachable within 15 minutes by car from King's Cross Station" | "Optimize deliveries to British Museum, Tower of London, and Westminster Abbey with 2 vehicles starting from Trafalgar Square" |
| Berlin | "Get driving directions from Brandenburg Gate to Alexanderplatz" | "Show areas reachable within 15 minutes by car from Berlin Hauptbahnhof" | "Optimize deliveries to Reichstag, Checkpoint Charlie, and East Side Gallery with 2 vehicles starting from Alexanderplatz" |

**CRITICAL:** Use central city locations as depots.

### Step 8: Open Snowflake Intelligence UI

**Goal:** Open the Snowflake Intelligence interface in the browser so the user can interact with the agent.

After all steps are complete, open the Snowflake Intelligence UI for the user using bash:

```bash
open "https://ai.snowflake.com/<current_region>/<account_locator>#/ai"
```

To get the region and account locator, run:
```sql
SELECT CURRENT_REGION(), CURRENT_ACCOUNT_NAME();
```

Then construct and open the URL with the actual values.

## Stopping Points

- **Step 1**: Verify ORS functions exist before proceeding
- **Step 5**: Review agent spec before creation
- **Step 7**: Confirm all 3 tools work correctly

## Output

- 3 stored procedures with AI geocoding
- 1 Cortex Agent registered in Snowflake Intelligence
- Agent accessible via Snowsight UI and REST API

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Agent not visible in UI | Run `ALTER SNOWFLAKE INTELLIGENCE ... ADD AGENT` |
| Geocoding fails | Check Cortex AI access and model availability |
| Empty directions | Verify ORS map data covers the requested region |
| Skill errors / routing functions fail | Check status of services in `OPENROUTESERVICE_NATIVE_APP.CORE` schema with `SHOW SERVICES IN SCHEMA OPENROUTESERVICE_NATIVE_APP.CORE;` and resume any suspended services with `ALTER SERVICE <service_name> RESUME;` |

