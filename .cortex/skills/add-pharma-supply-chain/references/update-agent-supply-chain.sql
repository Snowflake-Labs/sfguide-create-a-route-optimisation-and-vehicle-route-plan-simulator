-- =============================================================================
-- update-agent-supply-chain.sql
-- Add pharma_supply_chain Cortex Analyst tool to ROUTING_AGENT
-- =============================================================================

USE ROLE ACCOUNTADMIN;
USE WAREHOUSE ROUTING_ANALYTICS;

-- Add the pharma_supply_chain tool to the existing ROUTING_AGENT
-- This preserves all existing tools and adds the upstream supply chain view

CREATE OR REPLACE AGENT FLEET_INTELLIGENCE.ROUTING_AGENT.ROUTING_AGENT
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
FROM SPECIFICATION $$
models:
  orchestration: auto

instructions:
  response: |
    You are a pharma supply chain, fleet intelligence, and routing assistant.
    Present distances in km, durations in minutes, costs in USD, stock in batches or kg.

    VISUALIZATION RULES:
    - When presenting ranked lists, ALWAYS include a numeric column with values.
    - Do NOT use bold/italic inside table cells.
    - For routing: present | Vehicle | Stops | Distance km | Duration min |
    - For inventory: present | Pharmacy | Drug | Stock | Status | Days to Expiry |
    - For wastage: present | Drug | Category | Wastage Units | Wastage USD |
    - For supply chain: present | Product | Business Line | Plant | Stock Batches | Status |
    - For suppliers: present | Supplier | Country | Reliability | Lead Time | GMP Status |
    - For batches: present | Product | Plant | Batch | Status | Yield % | Deviations |

  orchestration: |
    UPSTREAM SUPPLY CHAIN (manufacturing plants, suppliers, batches, shipments):
    - Stock levels, supplier reliability, batch status, shipment delays: Use pharma_supply_chain
    - Questions about ONCOLOGY / CARDIOVASCULAR / RESPIRATORY / BIOLOGICS product lines: Use pharma_supply_chain
    - Batch yield, QC failures, deviations, on-hold batches: Use pharma_supply_chain
    - Supplier GMP status, audit results, single-source risk: Use pharma_supply_chain
    - Raw material coverage, API inventory, temperature excursions: Use pharma_supply_chain

    DOWNSTREAM SUPPLY INTELLIGENCE (pharmacy distribution):
    - Inventory status, wastage, near-expiry: Use TOOL_INVENTORY_STATUS
    - Demand forecast from demographics: Use TOOL_DEMAND_FORECAST
    - Replenishment plan / manufacturing order: Use TOOL_REPLENISHMENT_PLAN
    - Text-to-SQL analytics on pharmacy inventory/wastage data: Use pharma_analytics

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
      type: cortex_analyst_text_to_sql
      name: pharma_supply_chain
      description: "Upstream pharmaceutical supply chain analytics: manufacturing plants (Macclesfield, Mount Vernon, Södertälje, Singapore), API suppliers, production batches, inbound shipments, raw material inventory. Business lines: ONCOLOGY, CARDIOVASCULAR, RESPIRATORY, BIOLOGICS. Use for: supplier reliability scores, batch status/yield/deviations, shipment delays, API stock coverage, GMP compliance, cold chain temperature excursions, single-source supply risk."
      input_schema:
        type: object
        properties:
          query:
            type: string
            description: "Natural language question about upstream pharma supply chain"
        required: [query]
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
      type: cortex_analyst_text_to_sql
      name: pharma_analytics
      description: "Text-to-SQL analytics on pharmacy-level inventory, wastage, and demand data across 6 SF pharmacies and 25 drugs."
      input_schema:
        type: object
        properties:
          query:
            type: string
        required: [query]
  - tool_spec:
      type: generic
      name: TOOL_WEATHER
      description: "Current Met Office weather for the routing region. Returns temperature, wind, precipitation, visibility and routing advisory."
      input_schema:
        type: object
        properties:
          region_name:
            type: string

tool_resources:
  pharma_supply_chain:
    type: cortex_analyst_text_to_sql
    semantic_view: FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PHARMA_SUPPLY_CHAIN_SV
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
  pharma_analytics:
    type: cortex_analyst_text_to_sql
    semantic_view: FLEET_INTELLIGENCE.ROUTING_AGENT.PHARMA_ANALYTICS_VIEW
  TOOL_WEATHER:
    type: procedure
    identifier: FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_WEATHER
    execution_environment:
      type: warehouse
      warehouse: ROUTING_ANALYTICS
$$;

GRANT USAGE ON AGENT FLEET_INTELLIGENCE.ROUTING_AGENT.ROUTING_AGENT TO ROLE ACCOUNTADMIN;

SHOW AGENTS IN SCHEMA FLEET_INTELLIGENCE.ROUTING_AGENT;
