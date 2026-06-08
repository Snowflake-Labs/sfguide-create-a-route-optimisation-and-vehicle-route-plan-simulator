-- SV_ASSET_VELOCITY — Route Optimization (asset velocity) semantic view
-- Source: FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.VW_TRAILER_COST_OF_IDLENESS + VW_LANE_DEMAND
-- Deploy target: FLEET_INTELLIGENCE.SEMANTIC (via fleet_test_evals connection)
-- GEOGRAPHY columns (LAST_LOCATION_GEOM, TERMINAL_GEOM) excluded. Two independent facts.

CREATE OR REPLACE SEMANTIC VIEW FLEET_INTELLIGENCE.SEMANTIC.SV_ASSET_VELOCITY

  TABLES (
    idle AS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.VW_TRAILER_COST_OF_IDLENESS
      PRIMARY KEY (VEHICLE_ID)
    , lane AS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.VW_LANE_DEMAND
      PRIMARY KEY (TERMINAL_ID)
  )

  FACTS (
    idle.idle_minutes AS IDLE_MINUTES COMMENT = 'Minutes idle'
    , idle.idle_hours AS IDLE_HOURS COMMENT = 'Hours idle'
    , idle.idle_days AS IDLE_DAYS COMMENT = 'Days idle'
    , idle.cost_of_idleness_usd AS COST_OF_IDLENESS_USD COMMENT = 'Cost of idleness USD'
    , idle.projected_savings_usd AS PROJECTED_SAVINGS_USD COMMENT = 'Projected savings from repositioning USD'
    , idle.weight_tons AS WEIGHT_TONS COMMENT = 'Vehicle weight tons'
    , lane.outbound AS OUTBOUND COMMENT = 'Outbound trips (30-day)'
    , lane.inbound AS INBOUND COMMENT = 'Inbound trips (30-day)'
    , lane.net_outbound_trips AS NET_OUTBOUND_TRIPS COMMENT = 'Net outbound trips'
    , lane.demand_score AS DEMAND_SCORE COMMENT = 'Weighted demand score'
  )

  DIMENSIONS (
    idle.region AS REGION COMMENT = 'Operating region'
    , idle.last_location_name AS LAST_LOCATION_NAME WITH SYNONYMS ('parked at', 'location') COMMENT = 'Where the trailer is parked'
    , idle.last_location_type AS LAST_LOCATION_TYPE COMMENT = 'Type of parking location'
    , idle.assigned_dispatcher AS ASSIGNED_DISPATCHER WITH SYNONYMS ('dispatcher') COMMENT = 'Assigned dispatcher'
    , idle.driver_profile AS DRIVER_PROFILE COMMENT = 'Driver profile'
    , idle.idle_severity AS IDLE_SEVERITY WITH SYNONYMS ('severity') COMMENT = 'Idle severity (OK/WATCH/WARNING/CRITICAL)'
    , idle.vehicle_subtype AS VEHICLE_SUBTYPE WITH SYNONYMS ('trailer type') COMMENT = 'Vehicle subtype (DRY/REEFER/FLAT/TANKER)'
    , idle.hazmat AS HAZMAT COMMENT = 'Hazmat flag'
    , idle.ors_profile AS ORS_PROFILE COMMENT = 'Routing profile'
    , idle.vehicle_id AS VEHICLE_ID WITH SYNONYMS ('trailer', 'trailer id') COMMENT = 'Vehicle/trailer id'
    , lane.terminal_name AS TERMINAL_NAME WITH SYNONYMS ('terminal', 'depot') COMMENT = 'Terminal name'
    , lane.lane_region AS REGION COMMENT = 'Region (lane demand)'
    , lane.location_type AS LOCATION_TYPE COMMENT = 'Terminal location type'
  )

  METRICS (
    idle.idle_vehicle_count AS COUNT(DISTINCT VEHICLE_ID) WITH SYNONYMS ('number of idle trailers', 'idle vehicles') COMMENT = 'Distinct idle vehicles'
    , idle.total_cost_of_idleness AS SUM(cost_of_idleness_usd) WITH SYNONYMS ('total idle cost', 'cost of idleness') COMMENT = 'Total cost of idleness (USD)'
    , idle.total_projected_savings AS SUM(projected_savings_usd) WITH SYNONYMS ('potential savings') COMMENT = 'Total projected savings (USD)'
    , idle.avg_idle_hours AS AVG(idle_hours) COMMENT = 'Average idle hours'
    , idle.avg_idle_days AS AVG(idle_days) COMMENT = 'Average idle days'
    , idle.max_idle_days AS MAX(idle_days) WITH SYNONYMS ('longest idle') COMMENT = 'Maximum idle days'
    , lane.total_outbound AS SUM(outbound) COMMENT = 'Total outbound trips'
    , lane.total_inbound AS SUM(inbound) COMMENT = 'Total inbound trips'
    , lane.total_net_outbound AS SUM(net_outbound_trips) WITH SYNONYMS ('net demand') COMMENT = 'Total net outbound trips'
    , lane.avg_demand_score AS AVG(demand_score) COMMENT = 'Average demand score'
  )

  COMMENT = 'Asset velocity (Route Optimization demo): idle trailers with cost of idleness and projected savings, plus terminal lane demand for repositioning.'

  AI_SQL_GENERATION 'Asset velocity semantic view.
Entities (two independent facts):
- idle (VW_TRAILER_COST_OF_IDLENESS): one row per idle trailer with cost/savings and idle duration. Use for idle fleet, cost of idleness, projected savings; group by idle_severity, region, vehicle_subtype.
- lane (VW_LANE_DEMAND): terminal-level demand for repositioning idle assets; use total_net_outbound to find reposition target terminals.
Conventions:
- "idle trailers over N days" -> filter idle_days; "cost of idleness" -> total_cost_of_idleness; "savings" -> total_projected_savings.
- "where to reposition" -> lane.total_net_outbound by terminal_name.'
;
