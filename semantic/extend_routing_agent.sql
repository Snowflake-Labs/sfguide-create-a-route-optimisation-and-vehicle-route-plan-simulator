/*
 * extend_routing_agent.sql — adds 9 Cortex Analyst (text-to-SQL) tools to the
 * existing FLEET_INTELLIGENCE.ROUTING_AGENT.ROUTING_AGENT, one per semantic view
 * in FLEET_INTELLIGENCE.SEMANTIC, while preserving the 7 existing ORS/pharma
 * procedure tools. Re-creates ONLY the AGENT object (the procedures already exist).
 *
 * Deploy: snow sql -c fleet_test_evals -f semantic/extend_routing_agent.sql
 */

CREATE OR REPLACE AGENT FLEET_INTELLIGENCE.ROUTING_AGENT.ROUTING_AGENT
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1,"minor":1},"attributes":{"is_quickstart":1,"source":"sql"}}'
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
    You are a routing AND fleet-analytics agent for the Route Optimisation & Fleet
    Intelligence solution on Snowflake. You have two kinds of tools:

    A) LIVE ROUTING tools (OpenRouteService procedures) for on-demand geospatial calls:
       directions, isochrones (reachability), POI-in-isochrone, multi-stop optimization,
       and the San Francisco pharmaceutical supply-chain demo tools.

    B) ANALYTICS tools (Cortex Analyst over semantic views) for questions about DATA
       already generated/stored by the solution — both the raw Data Studio telemetry
       and every demo's analytics layer. Use these for counts, sums, averages, rates,
       rankings, breakdowns, and trends.

    CRITICAL RULES:
    1. For LIVE routing/POI/optimization questions, ALWAYS call a routing tool; never answer
       from your own knowledge. Report tool errors verbatim and do not invent distances.
    2. For ANALYTICAL questions about stored fleet/freight/demo data, call the matching
       query_* analytics tool. Do not fabricate numbers.
    3. Pick exactly one tool family per question based on intent: "what is the route / how far /
       reachable / optimize these stops" => routing tools; "how many / total / average / rate /
       top / by region / by driver / trend" => analytics tools.

    Transport profiles loaded in the default install: driving-car, driving-hgv, cycling-electric.
  response: |
    Be concise. Format results clearly:
    - Distances in km, durations in minutes; analytics results as tables when multi-row.
    - If a routing tool returns an "error" field or "status": "FAILED", report the error clearly
      and do NOT supplement with your own knowledge.
    - For analytics answers, state the metric and grouping used.
  orchestration: |
    LIVE ROUTING (OpenRouteService procedures):
    - Directions between locations: tool_directions
    - Reachability ("areas reachable", "how far"): tool_isochrone
    - POI / amenity within travel time ("cafes/restaurants/pharmacies near"): tool_poi_in_isochrone
      Map travel mode to profile: cycle/bike/ebike -> cycling-electric; truck/HGV/freight -> driving-hgv;
      drive/by car/unspecified -> driving-car.
    - Multi-stop optimization (ad hoc locations): tool_optimization
    - SF pharma supply chain (all pharmacies, 3 vehicles, pre-loaded): tool_supply_chain
    - SF pharma 30-stop fleet demo: tool_pharma_optimization
    - SF pharmacy population/catchment health profile: tool_pharma_catchment

    ANALYTICS (Cortex Analyst over semantic views) — use for aggregate/historical questions:
    - Raw fleet movement: GPS telemetry, actual trips, distance/duration, detours, speeding,
      HOS violations, dwell status, planned schedules, by region/vehicle_type/driver/shift/POI
      => query_fleet_operations
    - Freight marketplace: offers, prices, price-vs-market, partner trust/credit, lane on-time
      reliability => query_freight_marketplace
    - Dwell analysis: dwell time, facility utilization, H3 congestion, per-driver SLA breaches
      => query_dwell_analytics
    - Route deviation: planned-vs-actual per trip, deviation rate, excess km, time lost, by driver
      => query_route_deviation
    - Fleet taxis: taxi trips, distance, duration, speed by shift/driver => query_taxis
    - Food delivery: deliveries, delivery time, couriers, restaurant order volume => query_food_delivery
    - Retail catchment: retail POI counts by category/city/state => query_retail_catchment
    - Route optimization / asset velocity: idle trailers, cost of idleness, projected savings,
      terminal lane demand => query_asset_velocity
    - Backload matching: matching decisions, empty/deadhead km, net benefit, by source/type
      => query_backload_matching

    ALWAYS use a tool. NEVER answer routing or analytics questions from general knowledge.
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
            description: "Transport mode. Loaded in default install: driving-car, driving-hgv, cycling-electric. Default: driving-car."
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
            description: "Transport mode. Loaded in default install: driving-car, driving-hgv, cycling-electric. Default: driving-car."
        required: [location_description, range_minutes]
  - tool_spec:
      type: generic
      name: tool_poi_in_isochrone
      description: "Find points of interest (cafes, restaurants, shops, pharmacies, parks, etc.) reachable within a given travel time of a location. Combines an OpenRouteService isochrone with Overture Maps POI data via spatial intersection."
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
            description: "Transport mode. Map cycle/bike/ebike to cycling-electric, truck/HGV to driving-hgv, otherwise driving-car. Default: driving-car."
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
            description: "Transport mode. Loaded in default install: driving-car, driving-hgv, cycling-electric. Default: driving-car."
          region:
            type: string
            description: "Provisioned ORS region for routing (e.g. California, Germany, UnitedStatesOfAmerica). Default: California"
        required: [delivery_locations, depot_location, num_vehicles]
  - tool_spec:
      type: generic
      name: tool_supply_chain
      description: "Run the FULL pre-configured pharmaceutical supply chain delivery plan for San Francisco. Uses ALL pre-loaded data. Do NOT ask the user for any data. Requires setup-agent-playground."
      input_schema:
        type: object
        properties:
          profile:
            type: string
            description: "Transport mode. Default: driving-car"
  - tool_spec:
      type: generic
      name: tool_pharma_optimization
      description: "Run the pre-configured 30-stop SF pharmaceutical fleet delivery optimization with 3 specialist vehicles. Do NOT ask the user for addresses. Requires setup-agent-playground."
      input_schema:
        type: object
        properties:
          profile:
            type: string
            description: "Transport mode. Default: driving-car"
  - tool_spec:
      type: generic
      name: tool_pharma_catchment
      description: "Analyse population health demographics within a drive-time catchment of a San Francisco pharmacy. Requires setup-agent-playground."
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
  - tool_spec:
      type: cortex_analyst_text_to_sql
      name: query_fleet_operations
      description: "Analytics over RAW fleet movement (Data Studio unified dataset): GPS telemetry (speed, speeding, HOS violations, dwell status), actual trips (distance, duration, detours), and planned schedules. Break down by region, vehicle type, driver profile, shift, and origin/destination POI. Use for 'how many trips', 'total/average distance or duration', 'detour rate', 'speeding rate', 'average speed', 'scheduled trips'."
  - tool_spec:
      type: cortex_analyst_text_to_sql
      name: query_freight_marketplace
      description: "Analytics over the freight marketplace: live offers with price, weight, equipment, price-vs-market benchmark, partner trust/credit/KYC, and historical partner-lane on-time reliability. Use for 'offers by equipment', 'average price', 'below/above market', 'green-trust partners', 'on-time delivery rate'."
  - tool_spec:
      type: cortex_analyst_text_to_sql
      name: query_dwell_analytics
      description: "Analytics over dwell analysis: dwell sessions (where/how long vehicles stop), facility utilization, H3 congestion cells, and per-driver SLA breaches. Use for 'total/average dwell time', 'dwell by facility/city', 'congestion', 'SLA breaches by driver'."
  - tool_spec:
      type: cortex_analyst_text_to_sql
      name: query_route_deviation
      description: "Analytics over route deviation: per-trip planned-vs-actual comparison with deviation distance/time and rates. Use for 'deviation rate by driver', 'trips that deviated', 'total excess km', 'time lost', 'daily deviation trend'."
  - tool_spec:
      type: cortex_analyst_text_to_sql
      name: query_taxis
      description: "Analytics over the Fleet Taxis demo: taxi trip summaries with distance, duration, and speed. Use for 'taxi trips by shift', 'average/ max speed', 'average trip distance', 'active drivers'."
  - tool_spec:
      type: cortex_analyst_text_to_sql
      name: query_food_delivery
      description: "Analytics over the Food Delivery demo: courier deliveries (time, distance, status) and restaurants (order volume, avg delivery time). Use for 'deliveries by status', 'average delivery time by courier', 'busiest restaurants', 'active couriers'."
  - tool_spec:
      type: cortex_analyst_text_to_sql
      name: query_retail_catchment
      description: "Analytics over the Retail Catchment demo: retail points of interest by category, city, and state. Use for 'how many POIs by category/city', 'competition density', 'distinct categories'."
  - tool_spec:
      type: cortex_analyst_text_to_sql
      name: query_asset_velocity
      description: "Analytics over the Route Optimization / asset-velocity demo: idle trailers with cost of idleness and projected savings, plus terminal lane demand. Use for 'idle trailers by severity', 'total cost of idleness', 'projected savings', 'where to reposition'."
  - tool_spec:
      type: cortex_analyst_text_to_sql
      name: query_backload_matching
      description: "Analytics over the Backload Matching demo: external freight offers, available trailers, and recorded matching decisions (match score, empty/deadhead km, net benefit). Use for 'decisions by type/source', 'average empty km', 'total net benefit', 'average match score'."
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
  query_fleet_operations:
    semantic_view: FLEET_INTELLIGENCE.SEMANTIC.SV_FLEET_OPERATIONS
    execution_environment:
      warehouse: ROUTING_ANALYTICS
  query_freight_marketplace:
    semantic_view: FLEET_INTELLIGENCE.SEMANTIC.SV_FREIGHT_MARKETPLACE
    execution_environment:
      warehouse: ROUTING_ANALYTICS
  query_dwell_analytics:
    semantic_view: FLEET_INTELLIGENCE.SEMANTIC.SV_DWELL_ANALYTICS
    execution_environment:
      warehouse: ROUTING_ANALYTICS
  query_route_deviation:
    semantic_view: FLEET_INTELLIGENCE.SEMANTIC.SV_ROUTE_DEVIATION
    execution_environment:
      warehouse: ROUTING_ANALYTICS
  query_taxis:
    semantic_view: FLEET_INTELLIGENCE.SEMANTIC.SV_TAXIS
    execution_environment:
      warehouse: ROUTING_ANALYTICS
  query_food_delivery:
    semantic_view: FLEET_INTELLIGENCE.SEMANTIC.SV_FOOD_DELIVERY
    execution_environment:
      warehouse: ROUTING_ANALYTICS
  query_retail_catchment:
    semantic_view: FLEET_INTELLIGENCE.SEMANTIC.SV_RETAIL_CATCHMENT
    execution_environment:
      warehouse: ROUTING_ANALYTICS
  query_asset_velocity:
    semantic_view: FLEET_INTELLIGENCE.SEMANTIC.SV_ASSET_VELOCITY
    execution_environment:
      warehouse: ROUTING_ANALYTICS
  query_backload_matching:
    semantic_view: FLEET_INTELLIGENCE.SEMANTIC.SV_BACKLOAD_MATCHING
    execution_environment:
      warehouse: ROUTING_ANALYTICS
$$;
