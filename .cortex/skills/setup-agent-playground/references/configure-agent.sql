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
       suppliers): use pharma_supply_chain tool.

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
          minutes:
            type: integer
          profile:
            type: string
        required: [location_description, minutes]
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
    identifier: FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ISOCHRONES
    execution_environment:
      type: warehouse
      warehouse: ROUTING_ANALYTICS
  TOOL_ROUTE_OPTIMIZATION:
    type: procedure
    identifier: FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ROUTE_OPTIMIZATION
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

-- =============================================================================
-- VERIFY
-- =============================================================================

SHOW SEMANTIC VIEWS IN SCHEMA FLEET_INTELLIGENCE.PUBLIC;
SHOW AGENTS IN SCHEMA FLEET_INTELLIGENCE.ROUTING_AGENT;


-- =============================================================================
-- VERIFY
-- =============================================================================
SHOW AGENTS IN SCHEMA FLEET_INTELLIGENCE.ROUTING_AGENT;
