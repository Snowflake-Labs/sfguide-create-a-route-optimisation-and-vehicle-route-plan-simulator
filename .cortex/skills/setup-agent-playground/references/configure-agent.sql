-- =============================================================================
-- configure-agent.sql
-- Single authoritative CREATE OR REPLACE AGENT with ALL tools.
-- Run this AFTER all desired add-on skills have been installed.
--
-- Tools included:
--   Core routing:    TOOL_DIRECTIONS, TOOL_ISOCHRONES, TOOL_ROUTE_OPTIMIZATION,
--                    TOOL_PHARMA_CATCHMENT, TOOL_SUPPLY_CHAIN
--   Weather:         TOOL_WEATHER          (requires $add-weather-routing)
--   Pharma procs:    TOOL_INVENTORY_STATUS, TOOL_DEMAND_FORECAST,
--                    TOOL_REPLENISHMENT_PLAN (requires $add-pharma-intelligence)
--   Cortex Analyst:  pharma_analytics      (requires $add-pharma-intelligence)
--                    pharma_supply_chain   (requires $add-pharma-supply-chain)
--                    fleet_trips           (requires $add-fleet-analytics)
--                    fleet_telemetry       (requires $add-fleet-analytics)
--
-- If a backing resource does not exist (because an add-on was not installed),
-- the agent is still created successfully — that tool simply will not be
-- callable at runtime until the add-on is deployed.
-- =============================================================================

USE ROLE ACCOUNTADMIN;
USE WAREHOUSE ROUTING_ANALYTICS;

CREATE OR REPLACE AGENT FLEET_INTELLIGENCE.ROUTING_AGENT.ROUTING_AGENT
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
FROM SPECIFICATION $$
models:
  orchestration: claude-opus-4-7

orchestration:
  budget:
    seconds: 120
    tokens: 32000

instructions:
  system: |
    You are a routing, fleet intelligence, and pharma supply chain assistant
    powered by OpenRouteService and Snowflake Cortex.

    CRITICAL RULES — YOU MUST FOLLOW THESE WITHOUT EXCEPTION:

    1. NEVER provide routing distances, durations, route details, or directions
       from your own knowledge. ALL routing information MUST come from tool results.
       You are NOT a general travel advisor.

    2. ALWAYS call the appropriate tool for ANY routing or supply chain question.
       NEVER answer routing questions without using a tool first.

    3. After calling a tool, check the result:
       - If status is "FAILED" or the result contains an "error" field: report
         the EXACT error message. Do NOT attempt to answer the question yourself.
       - If status is "SUCCESS": Use ONLY the data returned by the tool.

    4. If a tool fails because locations are outside the map region, say:
       "The requested locations are outside the map region loaded in OpenRouteService."
       Do NOT follow up with general travel advice or estimated distances.

    5. NEVER claim you used a tool if you did not. NEVER fabricate tool results.

    6. For pharmaceutical supply chain delivery (pharmacies, fleet demo, supply
       chain plan): use TOOL_SUPPLY_CHAIN. This tool has ALL data pre-loaded
       (6 SF pharmacies, drug formulary, 3 specialist vehicles). Do NOT ask for
       pharmacy addresses or depot info.

    7. For catchment / population health analysis around a pharmacy:
       use TOOL_PHARMA_CATCHMENT.

    8. For fleet analytics (trip data, vehicle performance, telemetry):
       use fleet_trips or fleet_telemetry tools.

    9. For upstream pharma manufacturing supply chain analysis (plants, batches,
       suppliers, robots, AGVs): use pharma_supply_chain tool. This includes
       plant-floor robot telemetry (AGVs, inspection, cleaning robots — battery,
       status, vibration, speed, uptime, building location, cargo tracking).

    Transport profiles: driving-car, driving-hgv, cycling-electric

  response: |
    You are a fleet intelligence, pharma supply chain, and routing assistant.
    Present distances in km, durations in minutes, costs in USD, stock in batches or kg, speeds in km/h.

    VISUALIZATION RULES:
    - When presenting ranked lists, ALWAYS include a numeric column with values.
    - Do NOT use bold/italic inside table cells.
    - For routing: present | Vehicle | Stops | Distance km | Duration min |
    - For fleet analytics: present tabular data with vehicle/hour and metric columns
    - For inventory: present | Pharmacy | Drug | Stock | Status | Days to Expiry |
    - For supply chain: present | Product | Business Line | Plant | Stock Batches | Status |
    - For batches: present | Product | Plant | Batch | Status | Yield % | Deviations |

  orchestration: |
    FLEET ANALYTICS (trip data, vehicle performance, telemetry):
    - Trip counts, distances, durations, hourly distributions: Use fleet_trips tool
    - Active vehicles, fleet overview, top performers by trips: Use fleet_trips tool
    - Busiest pickup locations, restaurant orders, POI analysis: Use fleet_trips tool
    - Speeding events, HOS violations, compliance rates: Use fleet_telemetry tool
    - Dwell time, idle time, moving vs stopped breakdown: Use fleet_telemetry tool
    - Battery levels, charge percentage, lowest battery vehicles: Use fleet_telemetry tool

    UPSTREAM SUPPLY CHAIN (manufacturing plants, suppliers, batches, shipments):
    - Stock levels, supplier reliability, batch status, shipment delays: Use pharma_supply_chain tool
    - Batch yield, QC failures, deviations, on-hold batches: Use pharma_supply_chain tool
    - When the user clicks a plant building/zone OR provides a plant name with facility context:
      ALWAYS call TOOL_PLANT_IMPACT immediately with the plant name. Do NOT ask the user to confirm.
      Then use the result to describe batch risk, inventory gaps, shipment delays, and downstream pharmacy exposure.
    - Create a new plant / add a manufacturing site: Use TOOL_CREATE_PLANT
      PROVISIONING WORKFLOW — follow these steps conversationally:
      1. Ask for location, specialisation, and capacity if not provided
      2. Recommend robot count: capacity_batches_month * 0.15 (min 24, max 600), rounded to nearest 6
      3. Robot mix by specialisation: INJECTABLES=60/30/10, BIOLOGICS=50/20/30, VACCINES=65/25/10, API=35/40/25, SOLID_DOSE=40/20/40
      4. Suggest custom labels: BIOLOGICS→"Bioreactor Shuttle"/"Culture Monitor"/"Containment Cleaner", VACCINES→"Cryo-Logistics Bot"/"Cold Chain Validator"/"Decontamination Unit"
      5. Confirm with user, then call TOOL_CREATE_PLANT, then TOOL_ALTER_PLANT for labels
    - Remove / decommission a plant from the network: Use TOOL_REMOVE_PLANT
    - Resize robot fleet (whole plant or specific building/type): Use TOOL_ALTER_PLANT
      CONFIGURATION WORKFLOW — follow these steps:
      1. First query pharma_supply_chain to show current fleet state
      2. Present what will change (before/after)
      3. For emergencies (fire drill, contamination): apply immediately with {"all": "..."} status
      4. For labels: suggest industry-appropriate names based on plant specialisation
      5. Confirm, then call TOOL_ALTER_PLANT with robot_count + robot_type_labels + status_descriptions as needed

    PLANT-FLOOR ROBOTS (AGVs, inspection robots, cleaning robots):
    - Robot fleet status (active/charging/error counts), battery levels, maintenance due: Use pharma_supply_chain tool
    - Per-plant robot counts, building-level breakdown, speed, vibration, uptime: Use pharma_supply_chain tool
    - Robot cargo tracking (which batches AGVs are carrying): Use pharma_supply_chain tool
    - The pharma_supply_chain tool has a ROBOTS entity with full telemetry for 144 robots across 6 plants

    CONTEXT-DRIVEN DRILL-DOWN (app click events):
    - When context includes a PLANT NAME: call TOOL_PLANT_IMPACT with that plant, then query pharma_supply_chain for robots at that plant
    - When context includes a BUILDING or ZONE: query pharma_supply_chain filtering robots by that building/zone name
    - When context includes a ROBOT ID or robot type: query pharma_supply_chain for that specific robot's telemetry
    - When drilling down from plant → building → robot: progressively narrow the scope in your queries
    - Always present the drill-down level clearly: "At [Plant] > [Building] > [Robot]..."
    - Include actionable insights: maintenance urgency, battery depletion risk, cargo at risk if robot fails

    MAP NAVIGATION (agent-driven zoom):
    - When the user says "take me to", "show me", "zoom to", or "navigate to" a plant, building, or room:
      Include the tool result field navigate_to with the target location.
    - The app will automatically zoom the Plant Intelligence map to that location.
    - When you call TOOL_PLANT_IMPACT, the map auto-zooms to that plant (no extra action needed).
    - For building-level: after calling TOOL_PLANT_IMPACT, mention the building role name clearly
      so the user can click it, or ask pharma_supply_chain which building has the most robots.

    DOWNSTREAM SUPPLY INTELLIGENCE (pharmacy distribution):
    - Inventory status, wastage, near-expiry: Use TOOL_INVENTORY_STATUS
    - Demand forecast from demographics: Use TOOL_DEMAND_FORECAST
    - Replenishment plan: Use TOOL_REPLENISHMENT_PLAN

    ROUTING TOOLS:
    - Directions: Use TOOL_DIRECTIONS
    - Reachability/isochrone: Use TOOL_ISOCHRONES
    - Multi-stop optimization: Use TOOL_ROUTE_OPTIMIZATION
    - Population health catchment: Use TOOL_PHARMA_CATCHMENT
    - Full pharma supply chain delivery route: Use TOOL_SUPPLY_CHAIN

    WEATHER:
    - Conditions, fog, wind, safe to cycle: Use TOOL_WEATHER

tools:
  - tool_spec:
      type: generic
      name: TOOL_DIRECTIONS
      description: "Calculate driving directions between locations."
      input_schema:
        type: object
        properties:
          locations_description:
            type: string
            description: "Natural language start and end locations"
          profile:
            type: string
            description: "driving-car, driving-hgv, or cycling-electric"
        required: [locations_description]
  - tool_spec:
      type: generic
      name: TOOL_ISOCHRONES
      description: "Generate reachability polygon from a location."
      input_schema:
        type: object
        properties:
          location_description:
            type: string
            description: "Center location description"
          range_minutes:
            type: integer
            description: "Travel time in minutes (e.g. 5, 10, 15)"
          profile:
            type: string
            description: "driving-car, driving-hgv, or cycling-electric"
        required: [location_description, range_minutes]
  - tool_spec:
      type: generic
      name: TOOL_ROUTE_OPTIMIZATION
      description: "Optimize multi-stop delivery route (VRP) for user-specified locations."
      input_schema:
        type: object
        properties:
          description:
            type: string
          num_vehicles:
            type: number
          profile:
            type: string
        required: [description]
  - tool_spec:
      type: generic
      name: TOOL_PHARMA_CATCHMENT
      description: "Analyse population health demographics within drive-time catchment of a pharmacy."
      input_schema:
        type: object
        properties:
          pharmacy_description:
            type: string
          range_minutes:
            type: number
          profile:
            type: string
        required: [pharmacy_description]
  - tool_spec:
      type: generic
      name: TOOL_SUPPLY_CHAIN
      description: "Run the FULL pre-configured pharmaceutical supply chain delivery route optimisation to 6 SF pharmacies using 3 specialist vehicles from the depot at 1 Market Street."
      input_schema:
        type: object
        properties:
          profile:
            type: string
  - tool_spec:
      type: generic
      name: TOOL_INVENTORY_STATUS
      description: "Get pharmacy inventory status: critical/low stock, near-expiry items, overstocked drugs, wastage analysis across 6 SF pharmacies."
      input_schema:
        type: object
        properties:
          pharmacy_name:
            type: string
  - tool_spec:
      type: generic
      name: TOOL_DEMAND_FORECAST
      description: "Demographic demand forecast for a pharmacy based on catchment population health data."
      input_schema:
        type: object
        properties:
          pharmacy_name:
            type: string
          condition_filter:
            type: string
        required: [pharmacy_name]
  - tool_spec:
      type: generic
      name: TOOL_REPLENISHMENT_PLAN
      description: "Prioritised replenishment and manufacturing plan grouped by delivery type (cold chain first)."
      input_schema:
        type: object
        properties:
          priority_filter:
            type: string
  - tool_spec:
      type: generic
      name: TOOL_PLANT_IMPACT
      description: "Complete impact assessment for a manufacturing plant. Returns: active and on-hold production batches with severity, critical/low raw material inventory, delayed or customs-held inbound shipments, and downstream SF pharmacy stock exposure. Call this automatically when the user provides plant facility context (e.g. after clicking a building in the plant map)."
      input_schema:
        type: object
        properties:
          plant_name:
            type: string
            description: "Plant name or code (e.g. 'Hudson Valley Site', 'MVI', 'Northshire')"
        required:
          - plant_name
  - tool_spec:
      type: generic
      name: TOOL_CREATE_PLANT
      description: "Create a new manufacturing plant. Adds the plant to the PLANTS table, discovers nearby Overture Maps building footprints within a search radius, and deploys a configurable number of robots (AGVs, inspection, cleaning) distributed across building roles."
      input_schema:
        type: object
        properties:
          plant_name:
            type: string
            description: "Name of the new plant (e.g. 'Austin BioHub')"
          city:
            type: string
            description: "City where the plant is located"
          country:
            type: string
            description: "Country code (e.g. 'US', 'UK', 'SE')"
          latitude:
            type: number
            description: "Latitude of the plant location"
          longitude:
            type: number
            description: "Longitude of the plant location"
          specialisation:
            type: string
            description: "Manufacturing specialisation (e.g. 'INJECTABLES', 'SOLID_DOSE', 'BIOLOGICS')"
          capacity_batches_month:
            type: integer
            description: "Monthly batch capacity (default 200)"
          search_radius_m:
            type: integer
            description: "Radius in meters to search for building footprints (default 800)"
          robot_count:
            type: integer
            description: "Total number of robots to deploy at the plant (default 24). Distributed evenly across 6 building roles. Mix: 50% AGV, 30% Inspection, 20% Cleaning."
        required: [plant_name, city, country, latitude, longitude, specialisation]
  - tool_spec:
      type: generic
      name: TOOL_REMOVE_PLANT
      description: "Remove a manufacturing plant and its associated building footprints from the network. Returns confirmation with details of removed records."
      input_schema:
        type: object
        properties:
          plant_name:
            type: string
            description: "Name of the plant to remove (e.g. 'Austin BioHub')"
        required: [plant_name]
  - tool_spec:
      type: generic
      name: TOOL_ALTER_PLANT
      description: "Modify the robot/sensor fleet at a plant. Can resize (change count), rename robot types, and set custom activity/status descriptions. Supports whole-plant, per-building, or per-robot-type targeting."
      input_schema:
        type: object
        properties:
          plant_name:
            type: string
            description: "Name of the plant to modify (e.g. 'Hudson Valley Site', 'Northshire Site')"
          robot_count:
            type: integer
            description: "New total number of robots for the targeted scope. Omit to keep existing count unchanged."
          building_role:
            type: string
            description: "Optional. Target a specific building: api, form, cold, qc, util, or dist. If omitted, targets entire plant."
          robot_type_filter:
            type: string
            description: "Optional. Only affect a specific robot type: AGV, INSPECT, or CLEAN. Requires building_role for resize."
          robot_type_labels:
            type: string
            description: "Optional JSON string to rename robot types. Keys are robot type codes, values are new display names. Example: {\"AGV\": \"Delivery Drone\", \"INSPECT\": \"Quality Scanner\", \"CLEAN\": \"Sanitization Bot\"}"
          status_descriptions:
            type: string
            description: "Optional JSON string to change robot activity descriptions. Keys are current statuses (moving, charging, error) mapped to new descriptions. Use {\"all\": \"...\"} to set every robot in scope to the same status. Example: {\"moving\": \"Transporting batch ONC-042 to QC lab\"}"
        required: [plant_name]
  - tool_spec:
      type: generic
      name: TOOL_WEATHER
      description: "Current Met Office weather for the routing region. Returns temperature, wind, precipitation, visibility and routing advisory."
      input_schema:
        type: object
        properties:
          region_name:
            type: string
  - tool_spec:
      type: cortex_analyst_text_to_sql
      name: pharma_supply_chain
      description: "Answer analytical questions about the upstream pharma manufacturing supply chain: plants, suppliers, production batches, inbound shipments, raw material inventory."
  - tool_spec:
      type: cortex_analyst_text_to_sql
      name: pharma_analytics
      description: "Answer analytical questions about downstream pharmacy distribution: inventory levels, wastage, near-expiry stock, demand forecasts, replenishment needs across SF pharmacies."
  - tool_spec:
      type: cortex_analyst_text_to_sql
      name: fleet_trips
      description: "Answer analytical questions about fleet trip data: total trips, distances, durations, vehicle performance, hourly demand patterns, busiest pickup locations, detour rates."
  - tool_spec:
      type: cortex_analyst_text_to_sql
      name: fleet_telemetry
      description: "Answer analytical questions about vehicle telemetry: speed compliance, speeding events, HOS violations, battery levels, dwell and idle time breakdown, moving vs stopped ratios."

tool_resources:
  TOOL_DIRECTIONS:
    type: procedure
    identifier: FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_DIRECTIONS
    execution_environment:
      type: warehouse
      warehouse: ROUTING_ANALYTICS
  TOOL_ISOCHRONES:
    type: procedure
    identifier: FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ISOCHRONE
    execution_environment:
      type: warehouse
      warehouse: ROUTING_ANALYTICS
  TOOL_ROUTE_OPTIMIZATION:
    type: procedure
    identifier: FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_OPTIMIZATION
    execution_environment:
      type: warehouse
      warehouse: ROUTING_ANALYTICS
  TOOL_PHARMA_CATCHMENT:
    type: procedure
    identifier: FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_PHARMA_CATCHMENT
    execution_environment:
      type: warehouse
      warehouse: ROUTING_ANALYTICS
  TOOL_SUPPLY_CHAIN:
    type: procedure
    identifier: FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_SUPPLY_CHAIN
    execution_environment:
      type: warehouse
      warehouse: ROUTING_ANALYTICS
  TOOL_INVENTORY_STATUS:
    type: procedure
    identifier: FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_INVENTORY_STATUS
    execution_environment:
      type: warehouse
      warehouse: ROUTING_ANALYTICS
  TOOL_DEMAND_FORECAST:
    type: procedure
    identifier: FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_DEMAND_FORECAST
    execution_environment:
      type: warehouse
      warehouse: ROUTING_ANALYTICS
  TOOL_REPLENISHMENT_PLAN:
    type: procedure
    identifier: FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_REPLENISHMENT_PLAN
    execution_environment:
      type: warehouse
      warehouse: ROUTING_ANALYTICS
  TOOL_WEATHER:
    type: procedure
    identifier: FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_WEATHER
    execution_environment:
      type: warehouse
      warehouse: ROUTING_ANALYTICS
  TOOL_PLANT_IMPACT:
    type: procedure
    identifier: FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_PLANT_IMPACT
    execution_environment:
      type: warehouse
      warehouse: ROUTING_ANALYTICS
  TOOL_CREATE_PLANT:
    type: procedure
    identifier: FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_CREATE_PLANT
    execution_environment:
      type: warehouse
      warehouse: ROUTING_ANALYTICS
  TOOL_REMOVE_PLANT:
    type: procedure
    identifier: FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_REMOVE_PLANT
    execution_environment:
      type: warehouse
      warehouse: ROUTING_ANALYTICS
  TOOL_ALTER_PLANT:
    type: procedure
    identifier: FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ALTER_PLANT
    execution_environment:
      type: warehouse
      warehouse: ROUTING_ANALYTICS
  pharma_supply_chain:
    type: semantic_view
    semantic_view: FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PHARMA_SUPPLY_CHAIN_SV
    execution_environment:
      type: warehouse
      warehouse: ROUTING_ANALYTICS
  pharma_analytics:
    type: semantic_view
    semantic_view: FLEET_INTELLIGENCE.ROUTING_AGENT.FLEET_ANALYTICS_VIEW
    execution_environment:
      type: warehouse
      warehouse: ROUTING_ANALYTICS
  fleet_trips:
    type: semantic_view
    semantic_view: FLEET_INTELLIGENCE.PUBLIC.FLEET_TRIPS_SV
    execution_environment:
      type: warehouse
      warehouse: ROUTING_ANALYTICS
  fleet_telemetry:
    type: semantic_view
    semantic_view: FLEET_INTELLIGENCE.PUBLIC.FLEET_TELEMETRY_SV
    execution_environment:
      type: warehouse
      warehouse: ROUTING_ANALYTICS
$$;

GRANT USAGE ON AGENT FLEET_INTELLIGENCE.ROUTING_AGENT.ROUTING_AGENT TO ROLE ACCOUNTADMIN;

-- Grant to ALL_AGENTS_ROLE if it exists (non-blocking)
BEGIN
    GRANT USAGE ON AGENT FLEET_INTELLIGENCE.ROUTING_AGENT.ROUTING_AGENT TO ROLE ALL_AGENTS_ROLE;
EXCEPTION
    WHEN OTHER THEN NULL;
END;

-- Register with Snowflake Intelligence (non-blocking if not configured)
BEGIN
    ALTER SNOWFLAKE INTELLIGENCE SNOWFLAKE_INTELLIGENCE_OBJECT_DEFAULT
    ADD AGENT FLEET_INTELLIGENCE.ROUTING_AGENT.ROUTING_AGENT;
EXCEPTION
    WHEN OTHER THEN NULL;
END;

-- =============================================================================
-- VERIFY: All 15 tool backing resources exist (13 procedures + 4 semantic views)
-- =============================================================================

DECLARE
    v_missing VARCHAR;
    v_missing_sv VARCHAR;
    v_proc_count NUMBER;
    v_sv_count NUMBER;
BEGIN
    -- Check all 13 procedures exist (tool_resources of type: procedure)
    v_missing := (
        SELECT NULLIF(LISTAGG(expected_proc, ', ') WITHIN GROUP (ORDER BY expected_proc), '')
        FROM (
            SELECT expected_proc
            FROM (
                SELECT 'TOOL_DIRECTIONS' AS expected_proc
                UNION ALL SELECT 'TOOL_ISOCHRONE'
                UNION ALL SELECT 'TOOL_OPTIMIZATION'
                UNION ALL SELECT 'TOOL_PHARMA_CATCHMENT'
                UNION ALL SELECT 'TOOL_SUPPLY_CHAIN'
                UNION ALL SELECT 'TOOL_INVENTORY_STATUS'
                UNION ALL SELECT 'TOOL_DEMAND_FORECAST'
                UNION ALL SELECT 'TOOL_REPLENISHMENT_PLAN'
                UNION ALL SELECT 'TOOL_WEATHER'
                UNION ALL SELECT 'TOOL_PLANT_IMPACT'
                UNION ALL SELECT 'TOOL_CREATE_PLANT'
                UNION ALL SELECT 'TOOL_REMOVE_PLANT'
                UNION ALL SELECT 'TOOL_ALTER_PLANT'
            ) expected
            LEFT JOIN FLEET_INTELLIGENCE.INFORMATION_SCHEMA.PROCEDURES p
                ON p.PROCEDURE_SCHEMA = 'ROUTING_AGENT'
                AND p.PROCEDURE_NAME = expected.expected_proc
            WHERE p.PROCEDURE_NAME IS NULL
        )
    );

    -- Check all 4 semantic views exist
    v_missing_sv := (
        SELECT NULLIF(LISTAGG(expected_sv, ', ') WITHIN GROUP (ORDER BY expected_sv), '')
        FROM (
            SELECT expected_sv
            FROM (
                SELECT 'PHARMA_SUPPLY_CHAIN.PHARMA_SUPPLY_CHAIN_SV' AS expected_sv
                UNION ALL SELECT 'ROUTING_AGENT.FLEET_ANALYTICS_VIEW'
                UNION ALL SELECT 'PUBLIC.FLEET_TRIPS_SV'
                UNION ALL SELECT 'PUBLIC.FLEET_TELEMETRY_SV'
            ) expected
            LEFT JOIN FLEET_INTELLIGENCE.INFORMATION_SCHEMA.SEMANTIC_VIEWS sv
                ON sv.SCHEMA || '.' || sv.NAME = expected.expected_sv
            WHERE sv.NAME IS NULL
        )
    );

    IF (v_missing IS NOT NULL OR v_missing_sv IS NOT NULL) THEN
        RETURN 'FAILED — MISSING TOOLS: procs=[' || COALESCE(v_missing, '') || '] views=[' || COALESCE(v_missing_sv, '') || ']';
    END IF;

    v_proc_count := (SELECT COUNT(*) FROM FLEET_INTELLIGENCE.INFORMATION_SCHEMA.PROCEDURES WHERE PROCEDURE_SCHEMA = 'ROUTING_AGENT');
    v_sv_count := (SELECT COUNT(*) FROM FLEET_INTELLIGENCE.INFORMATION_SCHEMA.SEMANTIC_VIEWS);

    RETURN 'ROUTING_AGENT OK — ' || v_proc_count || ' procedures, ' || v_sv_count || ' semantic views. All 15 tool resources verified.';
END;

SHOW AGENTS IN SCHEMA FLEET_INTELLIGENCE.ROUTING_AGENT;
