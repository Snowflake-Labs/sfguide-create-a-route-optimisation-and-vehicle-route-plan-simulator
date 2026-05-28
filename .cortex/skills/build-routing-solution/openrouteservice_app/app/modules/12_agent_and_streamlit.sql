-- =============================================================================
-- 12_agent_and_streamlit.sql
-- Creates the ROUTING_AGENT, deploys Streamlit, uploads agent-demos.json,
-- creates the FLEET_ANALYTICS_VIEW semantic view.
-- Run AFTER: 11_pharma_supply_chain_data.sql
-- =============================================================================

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- Upload agent-demos.json to ORS stage (must exist in workspace root)
COPY FILES INTO @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/config/
FROM 'snow://workspace/USER$.PUBLIC."sfguide-build-fleet-intelligence-with-cortex-code"/versions/live/'
FILES=('agent-demos.json');

-- Semantic View for Fleet Analytics
CREATE OR REPLACE SEMANTIC VIEW FLEET_INTELLIGENCE.ROUTING_AGENT.FLEET_ANALYTICS_VIEW
  TABLES (
    trips AS SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS PRIMARY KEY (TRIP_ID),
    telemetry AS SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY PRIMARY KEY (TELEMETRY_ID),
    fleet AS SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET PRIMARY KEY (VEHICLE_ID),
    pois AS SYNTHETIC_DATASETS.UNIFIED.DIM_POIS PRIMARY KEY (LOCATION_ID)
  )
  RELATIONSHIPS (
    trips(VEHICLE_ID) REFERENCES fleet,
    trips(ORIGIN_POI_ID) REFERENCES pois,
    telemetry(VEHICLE_ID) REFERENCES fleet
  )
  FACTS (
    trips.distance AS trips.DISTANCE_KM COMMENT = 'Trip distance in km',
    trips.duration AS trips.DURATION_MINUTES COMMENT = 'Trip duration in minutes',
    telemetry.speed AS telemetry.SPEED_KMH COMMENT = 'Vehicle speed km/h',
    telemetry.battery AS telemetry.BATTERY_PCT COMMENT = 'Battery percentage'
  )
  DIMENSIONS (
    trips.vehicle_type AS trips.VEHICLE_TYPE COMMENT = 'Vehicle type: ebike, hgv',
    trips.region AS trips.REGION COMMENT = 'Geographic region',
    trips.trip_start AS trips.TRIP_START COMMENT = 'Trip start timestamp',
    trips.is_detour AS trips.IS_DETOUR COMMENT = 'Whether trip had a detour',
    fleet.vehicle_id_dim AS fleet.VEHICLE_ID COMMENT = 'Vehicle identifier',
    fleet.shift_type AS fleet.SHIFT_TYPE COMMENT = 'Shift type',
    pois.poi_name AS pois.NAME COMMENT = 'POI name',
    pois.poi_category AS pois.CATEGORY COMMENT = 'POI category',
    telemetry.status AS telemetry.STATUS COMMENT = 'Vehicle status: MOVING, DWELL, IDLE'
  )
  METRICS (
    trips.total_trips AS COUNT(trips.TRIP_ID) COMMENT = 'Total trips',
    trips.avg_distance AS AVG(trips.DISTANCE_KM) COMMENT = 'Average distance km',
    trips.avg_duration AS AVG(trips.DURATION_MINUTES) COMMENT = 'Average duration minutes',
    fleet.active_vehicles AS COUNT(DISTINCT fleet.VEHICLE_ID) COMMENT = 'Active vehicle count',
    telemetry.avg_speed AS AVG(telemetry.SPEED_KMH) COMMENT = 'Average speed km/h'
  )
  COMMENT = 'Fleet intelligence analytics covering trips, telemetry, vehicles, and POIs.';

-- Enable cross-region inference
ALTER ACCOUNT SET CORTEX_ENABLED_CROSS_REGION = 'ANY_REGION';

-- CREATE AGENT with all tools
CREATE OR REPLACE AGENT FLEET_INTELLIGENCE.ROUTING_AGENT.ROUTING_AGENT
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
FROM SPECIFICATION $$
models:
  orchestration: claude-opus-4-7
orchestration:
  budget:
    seconds: 120
    tokens: 32000
instructions:
  system: |
    You are a routing, fleet intelligence, and pharma supply chain assistant.
    CRITICAL: ALL routing data MUST come from tool results. Never guess distances or durations.
    For fleet-wide robot/plant summaries, call TOOL_PLANT_IMPACT with plant_name='ALL'.
    Transport profiles: driving-car, driving-hgv, cycling-electric
  response: |
    Distances in km, durations in minutes, costs in USD, stock in batches/kg, speeds in km/h.
  orchestration: |
    ROUTING: directions=TOOL_DIRECTIONS, isochrone=TOOL_ISOCHRONES, VRP=TOOL_ROUTE_OPTIMIZATION
    WEATHER: conditions=TOOL_WEATHER
    PLANT OPS: single plant or ALL plants=TOOL_PLANT_IMPACT, create=TOOL_CREATE_PLANT, remove=TOOL_REMOVE_PLANT
    For robot fleet health across ALL plants, call TOOL_PLANT_IMPACT('ALL')
tools:
  - tool_spec:
      type: generic
      name: TOOL_DIRECTIONS
      description: "Calculate driving directions between locations."
      input_schema:
        type: object
        properties:
          locations_description: {type: string}
          profile: {type: string}
        required: [locations_description]
  - tool_spec:
      type: generic
      name: TOOL_ISOCHRONES
      description: "Generate reachability polygon from a location."
      input_schema:
        type: object
        properties:
          location_description: {type: string}
          minutes: {type: integer}
          profile: {type: string}
        required: [location_description, minutes]
  - tool_spec:
      type: generic
      name: TOOL_ROUTE_OPTIMIZATION
      description: "Optimize multi-stop delivery route (VRP)."
      input_schema:
        type: object
        properties:
          description: {type: string}
          num_vehicles: {type: number}
          profile: {type: string}
        required: [description]
  - tool_spec:
      type: generic
      name: TOOL_WEATHER
      description: "Current Met Office weather for a location or plant city."
      input_schema:
        type: object
        properties:
          region_name: {type: string}
  - tool_spec:
      type: generic
      name: TOOL_PLANT_IMPACT
      description: "Plant operational status. Pass a plant name/city/code for single-plant detail, OR pass 'ALL' for fleet-wide summary (robot health, battery levels, maintenance alerts, batch overview across all plants)."
      input_schema:
        type: object
        properties:
          plant_name: {type: string, description: "Plant name/city/code, or 'ALL' for fleet-wide summary"}
        required: [plant_name]
  - tool_spec:
      type: generic
      name: TOOL_CREATE_PLANT
      description: "Create a new manufacturing plant using real Overture Maps building footprints. Immediately visible in Plant Intelligence."
      input_schema:
        type: object
        properties:
          plant_name: {type: string}
          city: {type: string}
          country: {type: string}
          latitude: {type: number}
          longitude: {type: number}
          specialisation: {type: string, description: "ORAL_SOLIDS, INJECTABLES, BIOLOGICS, or FILL_FINISH"}
          capacity_batches_month: {type: number}
          search_radius_m: {type: number}
        required: [plant_name, city, country, latitude, longitude]
  - tool_spec:
      type: generic
      name: TOOL_REMOVE_PLANT
      description: "Remove/decommission a plant and all associated data."
      input_schema:
        type: object
        properties:
          plant_name: {type: string}
        required: [plant_name]
  - tool_spec:
      type: generic
      name: TOOL_INVENTORY_STATUS
      description: "Pharmacy inventory status — critical stock, near-expiry, wastage. Pass pharmacy name or NULL for all."
      input_schema:
        type: object
        properties:
          pharmacy_name: {type: string, description: "Pharmacy name filter, or omit for all pharmacies"}
  - tool_spec:
      type: generic
      name: TOOL_DEMAND_FORECAST
      description: "Demographic-driven drug demand forecast for a pharmacy. Shows catchment population morbidity vs current stock."
      input_schema:
        type: object
        properties:
          pharmacy_name: {type: string}
          condition_filter: {type: string, description: "Optional: filter by condition/drug name"}
        required: [pharmacy_name]
  - tool_spec:
      type: generic
      name: TOOL_REPLENISHMENT_PLAN
      description: "Prioritised replenishment/manufacturing order for understocked pharmacies. Filter by URGENT/HIGH/MEDIUM."
      input_schema:
        type: object
        properties:
          priority_filter: {type: string, description: "URGENT, HIGH, or MEDIUM. Omit for all."}
tool_resources:
  TOOL_DIRECTIONS:
    type: procedure
    identifier: FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_DIRECTIONS
    execution_environment: {type: warehouse, warehouse: ROUTING_ANALYTICS}
  TOOL_ISOCHRONES:
    type: procedure
    identifier: FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ISOCHRONE
    execution_environment: {type: warehouse, warehouse: ROUTING_ANALYTICS}
  TOOL_ROUTE_OPTIMIZATION:
    type: procedure
    identifier: FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ROUTE_OPTIMIZATION
    execution_environment: {type: warehouse, warehouse: ROUTING_ANALYTICS}
  TOOL_WEATHER:
    type: procedure
    identifier: FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_WEATHER
    execution_environment: {type: warehouse, warehouse: ROUTING_ANALYTICS}
  TOOL_PLANT_IMPACT:
    type: procedure
    identifier: FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_PLANT_IMPACT
    execution_environment: {type: warehouse, warehouse: ROUTING_ANALYTICS}
  TOOL_CREATE_PLANT:
    type: procedure
    identifier: FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_CREATE_PLANT
    execution_environment: {type: warehouse, warehouse: ROUTING_ANALYTICS}
  TOOL_REMOVE_PLANT:
    type: procedure
    identifier: FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_REMOVE_PLANT
    execution_environment: {type: warehouse, warehouse: ROUTING_ANALYTICS}
  TOOL_INVENTORY_STATUS:
    type: procedure
    identifier: FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_INVENTORY_STATUS
    execution_environment: {type: warehouse, warehouse: ROUTING_ANALYTICS}
  TOOL_DEMAND_FORECAST:
    type: procedure
    identifier: FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_DEMAND_FORECAST
    execution_environment: {type: warehouse, warehouse: ROUTING_ANALYTICS}
  TOOL_REPLENISHMENT_PLAN:
    type: procedure
    identifier: FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_REPLENISHMENT_PLAN
    execution_environment: {type: warehouse, warehouse: ROUTING_ANALYTICS}
$$;

-- Deploy Fleet Explorer Streamlit
CREATE OR REPLACE STREAMLIT SYNTHETIC_DATASETS.UNIFIED.FLEET_MAP
  FROM 'snow://workspace/USER$.PUBLIC."sfguide-build-fleet-intelligence-with-cortex-code"/versions/live/fleet-map'
  MAIN_FILE = 'streamlit_app.py'
  QUERY_WAREHOUSE = DEFAULT_WH
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-fleet-explorer-app","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}';
