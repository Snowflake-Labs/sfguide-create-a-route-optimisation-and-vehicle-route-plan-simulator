-- =============================================================================
-- deploy-fleet-analytics.sql
-- Creates FLEET_TRIPS_SV and FLEET_TELEMETRY_SV semantic views and adds
-- fleet_trips + fleet_telemetry Cortex Analyst tools to ROUTING_AGENT.
-- =============================================================================

USE ROLE ACCOUNTADMIN;
USE WAREHOUSE ROUTING_ANALYTICS;
USE DATABASE FLEET_INTELLIGENCE;

-- =============================================================================
-- 1. FLEET TRIPS SEMANTIC VIEW
--    FACT_TRIPS: TRIP_ID, VEHICLE_ID, VEHICLE_TYPE, TRIP_START, TRIP_END,
--                DISTANCE_KM, DURATION_MINUTES, STATUS, ORS_PROFILE,
--                IS_DETOUR, DETOUR_DISTANCE_KM, PLANNED_DISTANCE_KM,
--                ORIGIN_POI_ID, PICKUP_WAIT_MINUTES, DELIVERY_WAIT_MINUTES
--    DIM_FLEET:  VEHICLE_ID, REGION, VEHICLE_TYPE, VEHICLE_NAME, ORS_PROFILE, CAPACITY_KG
--    DIM_POIS:   LOCATION_ID, REGION, NAME, LOCATION_TYPE, CATEGORY
-- =============================================================================

CREATE OR REPLACE SEMANTIC VIEW FLEET_INTELLIGENCE.PUBLIC.FLEET_TRIPS_SV
    TABLES (
        trips AS SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS
            PRIMARY KEY (TRIP_ID)
            COMMENT = 'Individual fleet trip records with distances, durations, timing, and detour information.',
        fleet AS SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET
            PRIMARY KEY (VEHICLE_ID)
            COMMENT = 'Fleet vehicle configuration including region, vehicle type, and capacity.',
        pois AS SYNTHETIC_DATASETS.UNIFIED.DIM_POIS
            PRIMARY KEY (LOCATION_ID)
            COMMENT = 'Points of interest including restaurants, warehouses, and rest stops.'
    )
    RELATIONSHIPS (
        trips(VEHICLE_ID) REFERENCES fleet,
        trips(ORIGIN_POI_ID) REFERENCES pois
    )
    FACTS (
        trips.DISTANCE_KM AS DISTANCE_KM
            WITH SYNONYMS = ('distance', 'km', 'kilometres', 'how far', 'trip distance')
            COMMENT = 'Actual distance travelled in kilometres',
        trips.DURATION_MINUTES AS DURATION_MINUTES
            WITH SYNONYMS = ('duration', 'time taken', 'minutes', 'how long', 'travel time')
            COMMENT = 'Actual trip duration in minutes',
        trips.PLANNED_DISTANCE_KM AS PLANNED_DISTANCE_KM
            WITH SYNONYMS = ('planned km', 'expected distance')
            COMMENT = 'Planned route distance in kilometres',
        trips.DETOUR_DISTANCE_KM AS DETOUR_DISTANCE_KM
            WITH SYNONYMS = ('extra distance', 'deviation km')
            COMMENT = 'Extra distance from route deviation in kilometres',
        trips.PICKUP_WAIT_MINUTES AS PICKUP_WAIT_MINUTES
            WITH SYNONYMS = ('pickup wait', 'wait at origin', 'collection wait')
            COMMENT = 'Minutes waited at pickup location',
        trips.DELIVERY_WAIT_MINUTES AS DELIVERY_WAIT_MINUTES
            WITH SYNONYMS = ('delivery wait', 'wait at destination', 'drop-off wait')
            COMMENT = 'Minutes waited at delivery location',
        fleet.CAPACITY_KG AS CAPACITY_KG
            WITH SYNONYMS = ('vehicle capacity', 'load capacity', 'kg capacity')
            COMMENT = 'Vehicle payload capacity in kg'
    )
    DIMENSIONS (
        trips.TRIP_ID AS TRIP_ID
            COMMENT = 'Unique identifier for each trip',
        trips.VEHICLE_ID AS VEHICLE_ID
            COMMENT = 'Vehicle identifier',
        trips.VEHICLE_TYPE AS VEHICLE_TYPE
            WITH SYNONYMS = ('mode', 'transport type', 'fleet type', 'courier type')
            COMMENT = 'Type of vehicle: ebike (electric bike) or hgv (heavy goods vehicle)',
        trips.STATUS AS STATUS
            WITH SYNONYMS = ('state', 'outcome', 'completion status', 'trip status')
            COMMENT = 'Trip status: COMPLETED, IN_PROGRESS, or CANCELLED',
        trips.IS_DETOUR AS IS_DETOUR
            WITH SYNONYMS = ('deviation', 'off route', 'route deviation')
            COMMENT = 'Whether the vehicle deviated from the planned route',
        trips.ORS_PROFILE AS ORS_PROFILE
            WITH SYNONYMS = ('profile', 'routing mode', 'travel mode')
            COMMENT = 'Routing profile: driving-car, cycling-electric, or driving-hgv',
        trips.TRIP_START AS TRIP_START
            WITH SYNONYMS = ('start time', 'departure', 'when', 'date', 'trip date', 'hour of day')
            COMMENT = 'Date and time when the trip started',
        trips.TRIP_END AS TRIP_END
            WITH SYNONYMS = ('end time', 'arrival', 'completion time')
            COMMENT = 'Date and time when the trip ended',
        fleet.REGION AS REGION
            WITH SYNONYMS = ('city', 'area', 'location', 'zone')
            COMMENT = 'Geographic region: SanFrancisco, Cambridge, or Barcelona',
        fleet.VEHICLE_NAME AS VEHICLE_NAME
            WITH SYNONYMS = ('courier', 'driver name', 'vehicle label')
            COMMENT = 'Human-readable vehicle or courier name',
        pois.NAME AS NAME
            WITH SYNONYMS = ('pickup', 'start location', 'origin name', 'restaurant', 'from')
            COMMENT = 'Name of the origin point of interest',
        pois.LOCATION_TYPE AS LOCATION_TYPE
            WITH SYNONYMS = ('origin category', 'pickup type', 'start type')
            COMMENT = 'Category of origin POI: RESTAURANT, WAREHOUSE, or REST_STOP',
        pois.CATEGORY AS CATEGORY
            WITH SYNONYMS = ('cuisine', 'restaurant type', 'food category')
            COMMENT = 'Cuisine or category of the origin POI'
    )
    METRICS (
        TOTAL_TRIPS AS COUNT(trips.TRIP_ID)
            WITH SYNONYMS = ('number of trips', 'trip count', 'deliveries', 'how many trips')
            COMMENT = 'Total number of trips',
        ACTIVE_VEHICLES AS COUNT(DISTINCT trips.VEHICLE_ID)
            WITH SYNONYMS = ('vehicles', 'number of vehicles', 'fleet size', 'couriers')
            COMMENT = 'Number of distinct vehicles that made trips',
        AVG_TRIP_DISTANCE_KM AS AVG(trips.DISTANCE_KM)
            WITH SYNONYMS = ('average distance', 'mean distance', 'typical trip distance')
            COMMENT = 'Average trip distance in kilometres',
        AVG_TRIP_DURATION_MINUTES AS AVG(trips.DURATION_MINUTES)
            WITH SYNONYMS = ('average duration', 'mean trip time', 'average trip length')
            COMMENT = 'Average trip duration in minutes',
        TOTAL_DISTANCE_KM AS SUM(trips.DISTANCE_KM)
            WITH SYNONYMS = ('total km', 'total kilometres', 'distance driven', 'fleet mileage')
            COMMENT = 'Total distance driven across all trips in kilometres',
        DETOUR_COUNT AS SUM(CASE WHEN trips.IS_DETOUR THEN 1 ELSE 0 END)
            WITH SYNONYMS = ('deviations', 'route deviations', 'off route trips', 'detours')
            COMMENT = 'Number of trips that deviated from the planned route',
        TOTAL_DETOUR_KM AS SUM(CASE WHEN trips.IS_DETOUR THEN trips.DETOUR_DISTANCE_KM ELSE 0 END)
            WITH SYNONYMS = ('extra kilometres', 'wasted distance', 'total deviation distance')
            COMMENT = 'Total extra distance caused by route deviations in kilometres',
        AVG_PICKUP_WAIT AS AVG(trips.PICKUP_WAIT_MINUTES)
            WITH SYNONYMS = ('average pickup wait', 'collection time', 'wait time')
            COMMENT = 'Average wait time at pickup in minutes'
    )
    COMMENT = 'Fleet trip analytics for Fleet Intelligence demos. Covers ebike food delivery and HGV logistics operations. Supports questions on trip performance, route deviation, hourly demand patterns, busiest pickup locations, and fleet utilisation.'
    WITH EXTENSION (
        CA = '
verified_queries:
  - question: "How many trips were made by each vehicle type?"
    sql: "SELECT VEHICLE_TYPE, COUNT(TRIP_ID) AS TOTAL_TRIPS FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS GROUP BY VEHICLE_TYPE ORDER BY TOTAL_TRIPS DESC"
  - question: "What is the trip distribution by hour of day?"
    sql: "SELECT HOUR(TRIP_START) AS HOUR_OF_DAY, COUNT(TRIP_ID) AS TRIPS FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS WHERE TRIP_START IS NOT NULL GROUP BY HOUR(TRIP_START) ORDER BY HOUR_OF_DAY"
  - question: "Which vehicles completed the most trips?"
    sql: "SELECT VEHICLE_ID, VEHICLE_TYPE, COUNT(TRIP_ID) AS TRIPS, ROUND(AVG(DISTANCE_KM), 2) AS AVG_DISTANCE_KM, ROUND(AVG(DURATION_MINUTES), 1) AS AVG_DURATION_MINS FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS GROUP BY VEHICLE_ID, VEHICLE_TYPE ORDER BY TRIPS DESC LIMIT 10"
  - question: "Which pickup locations have the most orders?"
    sql: "SELECT p.NAME, p.LOCATION_TYPE, COUNT(t.TRIP_ID) AS ORDERS FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS t JOIN SYNTHETIC_DATASETS.UNIFIED.DIM_POIS p ON t.ORIGIN_POI_ID = p.LOCATION_ID GROUP BY p.NAME, p.LOCATION_TYPE ORDER BY ORDERS DESC LIMIT 10"
  - question: "What is the fleet overview: total trips, average distance, average duration, and active vehicles?"
    sql: "SELECT COUNT(TRIP_ID) AS TOTAL_TRIPS, ROUND(AVG(DISTANCE_KM), 2) AS AVG_DISTANCE_KM, ROUND(AVG(DURATION_MINUTES), 1) AS AVG_DURATION_MINS, COUNT(DISTINCT VEHICLE_ID) AS ACTIVE_VEHICLES FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS"
'
    );

SELECT 'FLEET_TRIPS_SV created' AS STATUS,
       COUNT(*) AS FACT_TRIP_ROWS
FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS;

-- =============================================================================
-- 2. FLEET TELEMETRY SEMANTIC VIEW
--    FACT_VEHICLE_TELEMETRY: TELEMETRY_ID, VEHICLE_ID, VEHICLE_TYPE, TRIP_ID,
--                            REGION, TS, SPEED_KMH, POSTED_SPEED_KMH, BATTERY_PCT,
--                            ODOMETER_KM, STATUS, IS_SPEEDING, IS_HOS_VIOLATION,
--                            IS_DETOUR, LOCATION_TYPE, ORS_PROFILE
--    DIM_FLEET: VEHICLE_ID, REGION, VEHICLE_TYPE, VEHICLE_NAME
-- =============================================================================

CREATE OR REPLACE SEMANTIC VIEW FLEET_INTELLIGENCE.PUBLIC.FLEET_TELEMETRY_SV
    TABLES (
        telemetry AS SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY
            PRIMARY KEY (TELEMETRY_ID)
            COMMENT = 'Vehicle telemetry readings including speed, battery, compliance status, and activity state.',
        fleet AS SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET
            PRIMARY KEY (VEHICLE_ID)
            COMMENT = 'Fleet vehicle configuration.'
    )
    RELATIONSHIPS (
        telemetry(VEHICLE_ID) REFERENCES fleet
    )
    FACTS (
        telemetry.SPEED_KMH AS SPEED_KMH
            WITH SYNONYMS = ('speed', 'velocity', 'how fast')
            COMMENT = 'Vehicle speed at the time of reading in km/h',
        telemetry.POSTED_SPEED_KMH AS POSTED_SPEED_KMH
            WITH SYNONYMS = ('speed limit', 'limit', 'posted limit')
            COMMENT = 'Posted speed limit at the vehicle location in km/h',
        telemetry.BATTERY_PCT AS BATTERY_PCT
            WITH SYNONYMS = ('battery', 'charge', 'battery level', 'battery percentage')
            COMMENT = 'Vehicle battery charge level as a percentage (0-100)',
        telemetry.ODOMETER_KM AS ODOMETER_KM
            WITH SYNONYMS = ('odometer', 'total distance', 'mileage')
            COMMENT = 'Total cumulative distance driven by the vehicle in km'
    )
    DIMENSIONS (
        telemetry.TELEMETRY_ID AS TELEMETRY_ID
            COMMENT = 'Unique identifier for each telemetry reading',
        telemetry.VEHICLE_ID AS VEHICLE_ID
            COMMENT = 'Vehicle identifier',
        telemetry.TRIP_ID AS TRIP_ID
            COMMENT = 'Trip identifier this reading belongs to',
        telemetry.VEHICLE_TYPE AS VEHICLE_TYPE
            WITH SYNONYMS = ('mode', 'transport type', 'fleet type')
            COMMENT = 'Type of vehicle: ebike or hgv',
        telemetry.REGION AS REGION
            WITH SYNONYMS = ('city', 'area', 'location', 'zone')
            COMMENT = 'Geographic region: SanFrancisco, Cambridge, or Barcelona',
        telemetry.STATUS AS STATUS
            WITH SYNONYMS = ('vehicle state', 'activity', 'what is the vehicle doing')
            COMMENT = 'Vehicle status: MOVING, DWELL_ORIGIN, DWELL_DESTINATION, DWELL_RECHARGE, or IDLE',
        telemetry.IS_SPEEDING AS IS_SPEEDING
            WITH SYNONYMS = ('speeding', 'over speed limit', 'speed violation')
            COMMENT = 'Whether the vehicle was exceeding the posted speed limit',
        telemetry.IS_HOS_VIOLATION AS IS_HOS_VIOLATION
            WITH SYNONYMS = ('hos violation', 'hours of service', 'compliance violation', 'driving hours violation')
            COMMENT = 'Whether a hours-of-service violation was detected',
        telemetry.IS_DETOUR AS IS_DETOUR
            WITH SYNONYMS = ('deviation', 'off route', 'route deviation')
            COMMENT = 'Whether the vehicle was off the planned route',
        telemetry.TS AS TS
            WITH SYNONYMS = ('timestamp', 'time', 'when', 'date', 'recorded at')
            COMMENT = 'Timestamp of the telemetry reading',
        telemetry.LOCATION_TYPE AS LOCATION_TYPE
            WITH SYNONYMS = ('location category', 'zone type', 'area type')
            COMMENT = 'Type of location at time of reading',
        fleet.VEHICLE_NAME AS VEHICLE_NAME
            WITH SYNONYMS = ('courier', 'driver name', 'vehicle label')
            COMMENT = 'Human-readable vehicle or courier name'
    )
    METRICS (
        TOTAL_READINGS AS COUNT(telemetry.TELEMETRY_ID)
            WITH SYNONYMS = ('readings', 'data points', 'records', 'total records')
            COMMENT = 'Total number of telemetry readings',
        SPEEDING_EVENTS AS SUM(CASE WHEN telemetry.IS_SPEEDING THEN 1 ELSE 0 END)
            WITH SYNONYMS = ('speeding count', 'speed violations', 'how many speeding', 'over limit events')
            COMMENT = 'Number of telemetry readings where vehicle was speeding',
        HOS_VIOLATIONS AS SUM(CASE WHEN telemetry.IS_HOS_VIOLATION THEN 1 ELSE 0 END)
            WITH SYNONYMS = ('compliance violations', 'hours of service violations', 'driving hour violations')
            COMMENT = 'Number of hours-of-service violations detected',
        AVG_SPEED_KMH AS AVG(telemetry.SPEED_KMH)
            WITH SYNONYMS = ('average speed', 'mean speed', 'typical speed')
            COMMENT = 'Average vehicle speed across all readings in km/h',
        AVG_BATTERY_PCT AS AVG(telemetry.BATTERY_PCT)
            WITH SYNONYMS = ('average battery', 'mean battery level', 'typical charge')
            COMMENT = 'Average battery level across all readings as a percentage',
        ACTIVE_VEHICLES AS COUNT(DISTINCT telemetry.VEHICLE_ID)
            WITH SYNONYMS = ('vehicles tracked', 'number of vehicles', 'fleet size')
            COMMENT = 'Number of distinct vehicles with telemetry data'
    )
    COMMENT = 'Fleet telemetry analytics. Covers speed compliance, battery levels, speeding events, HOS violations, and dwell/idle behaviour for ebike and HGV fleets.'
    WITH EXTENSION (
        CA = '
verified_queries:
  - question: "How many speeding events occurred by vehicle type?"
    sql: "SELECT VEHICLE_TYPE, SUM(CASE WHEN IS_SPEEDING THEN 1 ELSE 0 END) AS SPEEDING_EVENTS, COUNT(*) AS TOTAL_READINGS, ROUND(100.0 * SUM(CASE WHEN IS_SPEEDING THEN 1 ELSE 0 END) / COUNT(*), 1) AS SPEEDING_RATE_PCT FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY GROUP BY VEHICLE_TYPE ORDER BY SPEEDING_EVENTS DESC"
  - question: "What is the average battery level by vehicle?"
    sql: "SELECT VEHICLE_ID, VEHICLE_TYPE, ROUND(AVG(BATTERY_PCT), 1) AS AVG_BATTERY_PCT, MIN(BATTERY_PCT) AS MIN_BATTERY_PCT FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY GROUP BY VEHICLE_ID, VEHICLE_TYPE ORDER BY AVG_BATTERY_PCT ASC LIMIT 10"
  - question: "What is the speeding rate by vehicle?"
    sql: "SELECT VEHICLE_ID, VEHICLE_TYPE, ROUND(100.0 * SUM(CASE WHEN IS_SPEEDING THEN 1 ELSE 0 END) / COUNT(*), 1) AS SPEEDING_RATE_PCT FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY GROUP BY VEHICLE_ID, VEHICLE_TYPE ORDER BY SPEEDING_RATE_PCT DESC LIMIT 10"
'
    );

SELECT 'FLEET_TELEMETRY_SV created' AS STATUS,
       COUNT(*) AS TELEMETRY_ROWS
FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY;

-- =============================================================================
-- 3. UPDATE ROUTING_AGENT — add fleet_trips + fleet_telemetry tools
-- =============================================================================

CREATE OR REPLACE AGENT FLEET_INTELLIGENCE.ROUTING_AGENT.ROUTING_AGENT
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
FROM SPECIFICATION $$
models:
  orchestration: auto

instructions:
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
