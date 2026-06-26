/*
 * extend_routing_agent.sql — adds 9 Cortex Analyst (text-to-SQL) tools to the
 * existing FLEET_INTELLIGENCE.ROUTING_AGENT.ROUTING_AGENT, one per semantic view
 * in FLEET_INTELLIGENCE.SEMANTIC, while preserving the 7 existing ORS/demo
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
       and the config-driven catchment / delivery / network-optimization demo tools.

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
    - Full distribution-network plan (all key sites, 3 vehicles, pre-loaded): tool_network_optimization
    - Pre-geocoded 30-stop fleet delivery demo: tool_delivery_optimization
    - Drive-time catchment / area profile around a site: tool_catchment

    ANALYTICS (Cortex Analyst over semantic views) — use for aggregate/historical questions:
    - Universal fleet analytics (any asset mode - car/hgv/ebike): trips (distance, duration,
      speed, detours, status), operator breakdowns (shift, profile), and top origins,
      by region/vehicle_type/operator => query_fleet_ops
    - Freight marketplace: offers, prices, price-vs-market, partner trust/credit, lane on-time
      reliability => query_deliveries
    - Dwell analysis: dwell time, facility utilization, H3 congestion, per-driver SLA breaches
      => query_dwell_analytics
    - Route deviation: planned-vs-actual per trip, deviation rate, excess km, time lost, by driver
      => query_route_deviation
    - Catchment: POI counts by category/city/state => query_catchment
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
      name: tool_network_optimization
      description: "Run the FULL pre-configured distribution-network delivery plan. Uses ALL pre-loaded data. Do NOT ask the user for any data. Requires setup-agent-playground."
      input_schema:
        type: object
        properties:
          profile:
            type: string
            description: "Transport mode. Default: driving-car"
  - tool_spec:
      type: generic
      name: tool_delivery_optimization
      description: "Run the pre-configured 30-stop fleet delivery optimization with 3 skill-tier vehicles. Do NOT ask the user for addresses. Requires setup-agent-playground."
      input_schema:
        type: object
        properties:
          profile:
            type: string
            description: "Transport mode. Default: driving-car"
  - tool_spec:
      type: generic
      name: tool_catchment
      description: "Analyse the area within a drive-time catchment of a site. Requires setup-agent-playground."
      input_schema:
        type: object
        properties:
          site_description:
            type: string
            description: "Description of the site location, e.g. 'a store at 498 Castro Street'"
          range_minutes:
            type: number
            description: "Drive time in minutes for catchment area. Default: 10"
          profile:
            type: string
            description: "Transport mode. Default: driving-car"
        required: [site_description]
  - tool_spec:
      type: generic
      name: tool_overture_search
      description: "Region-wide (NON-isochrone) Overture Maps place search/aggregation. Use for 'how many <category> in <region>', 'top cities by <category> count', or 'list <category> in <region>'. Bound by a provisioned region name OR a full bbox (min/max lon/lat). For 'within N minutes of a point' use tool_poi_in_isochrone instead."
      input_schema:
        type: object
        properties:
          region:
            type: string
            description: "Provisioned region name (e.g. 'SanFrancisco'). Pass the active region unless the user names a different place. Provide this OR a full bbox."
          poi_category:
            type: string
            description: "Optional category filter. Lowercase Overture BASIC_CATEGORY, e.g. coffee_shop, restaurant, grocery_store, supermarket, gas_station, pharmacy, hospital, hotel, bank, school. Matched with a LIKE fallback. Omit to count/list all places."
          group_by:
            type: string
            description: "'list' (default; individual places), 'city' (counts per city), or 'category' (counts per basic_category)."
          max_results:
            type: number
            description: "Max rows/groups. Default 100, capped at 500."
          min_lon:
            type: number
            description: "West longitude of the bbox (provide all four bbox bounds together, or none)."
          min_lat:
            type: number
            description: "South latitude of the bbox."
          max_lon:
            type: number
            description: "East longitude of the bbox."
          max_lat:
            type: number
            description: "North latitude of the bbox."
        required: []
  - tool_spec:
      type: generic
      name: tool_overture_addresses
      description: "Region/bbox-bounded Overture Maps address density. Use for 'how many addresses in <region>' or 'address coverage per city'. Bound by a provisioned region name OR a full bbox."
      input_schema:
        type: object
        properties:
          region:
            type: string
            description: "Provisioned region name. Pass the active region unless the user names a different place. Provide this OR a full bbox."
          group_by:
            type: string
            description: "'city' (default; address counts per city) or 'list' (sampled addresses)."
          max_results:
            type: number
            description: "Max rows/groups. Default 100, capped at 500."
          min_lon:
            type: number
            description: "West longitude of the bbox."
          min_lat:
            type: number
            description: "South latitude of the bbox."
          max_lon:
            type: number
            description: "East longitude of the bbox."
          max_lat:
            type: number
            description: "North latitude of the bbox."
        required: []
      description: "Universal, mode-agnostic fleet analytics: trips (distance, duration, speed, detours, status), operator breakdowns (shift, profile), and top origins, broken down by region, asset mode (vehicle_type: car/hgv/ebike/...), and operator. Use for 'how many trips', 'total/average distance or duration', 'detour rate', 'average speed', 'busiest origins', 'operators by shift'."
  - tool_spec:
      type: cortex_analyst_text_to_sql
      name: query_deliveries
      description: "Analytics over the vehicle-agnostic deliveries marketplace: live delivery offers with price, weight, vehicle equipment, price-vs-market benchmark, partner trust/credit/KYC, and historical partner-lane on-time reliability. Use for 'deliveries by equipment', 'average price', 'below/above market', 'green-trust partners', 'on-time delivery rate'."
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
      name: query_catchment
      description: "Analytics over the Catchment demo: points of interest by category, city, and state. Use for 'how many POIs by category/city', 'competition density', 'distinct categories'."
  - tool_spec:
      type: cortex_analyst_text_to_sql
      name: query_overture_global
      description: "Global Overture Maps places catalog (66M+ POIs worldwide) via the vendor semantic view. Use for WORLDWIDE place questions outside the active region and for place attributes/quality: filter or list by category, brand, country, region, city, name, and data confidence. NOTE: exposes only confidence metrics (no row count) - for counts use query_catchment or tool_overture_search."
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
  tool_network_optimization:
    type: procedure
    identifier: FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_NETWORK_OPTIMIZATION
    execution_environment:
      warehouse: ROUTING_ANALYTICS
  tool_delivery_optimization:
    type: procedure
    identifier: FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_DELIVERY_OPTIMIZATION
    execution_environment:
      warehouse: ROUTING_ANALYTICS
  tool_catchment:
    type: procedure
    identifier: FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_CATCHMENT
    execution_environment:
      warehouse: ROUTING_ANALYTICS
  tool_overture_search:
    type: procedure
    identifier: FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_OVERTURE_SEARCH
    execution_environment:
      warehouse: ROUTING_ANALYTICS
  tool_overture_addresses:
    type: procedure
    identifier: FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_OVERTURE_ADDRESSES
    execution_environment:
      warehouse: ROUTING_ANALYTICS
  query_fleet_ops:
    semantic_view: FLEET_INTELLIGENCE.SEMANTIC.SV_FLEET_OPS
    execution_environment:
      warehouse: ROUTING_ANALYTICS
  query_deliveries:
    semantic_view: FLEET_INTELLIGENCE.SEMANTIC.SV_DELIVERIES
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
  query_catchment:
    semantic_view: FLEET_INTELLIGENCE.SEMANTIC.SV_CATCHMENT
    execution_environment:
      warehouse: ROUTING_ANALYTICS
  query_overture_global:
    semantic_view: OVERTURE_MAPS__PLACES.CARTO.OVERTUREMAPS_PLACES_SEMANTIC_VIEW
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
