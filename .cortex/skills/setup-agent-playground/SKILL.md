---
name: setup-agent-playground
description: "Deploy the Agent Playground: semantic view, demo data, stored procedures, agent config. Run AFTER build-routing-solution and routing-agent. Triggers: setup agent playground, deploy agent demos, configure agent playground, install agent tools."
depends_on:
  - build-routing-solution
  - routing-agent
metadata:
  author: Snowflake SIT-IS
  version: 2.0.0
  category: demo-setup
---

# Setup Agent Playground

Deploys everything the Agent Playground needs: semantic view for analytics, demo data tables, stored procedures, and the agent-demos.json config.

## Prerequisites

```sql
SHOW AGENTS IN SCHEMA FLEET_INTELLIGENCE.ROUTING_AGENT;
SHOW SERVICES IN SCHEMA OPENROUTESERVICE_APP.CORE;
```

Required: ROUTING_AGENT exists, all 5 services RUNNING.

## Step 1: Create Semantic View

Creates `FLEET_ANALYTICS_VIEW` over trips, telemetry, fleet, and POIs for Cortex Analyst text-to-SQL. Covers ALL demo data.

```sql
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
    trips.distance_km AS DISTANCE_KM COMMENT = 'Trip distance in km',
    trips.duration_min AS DURATION_MINUTES COMMENT = 'Trip duration in minutes',
    trips.pickup_wait AS PICKUP_WAIT_MINUTES COMMENT = 'Wait at pickup in minutes',
    trips.delivery_wait AS DELIVERY_WAIT_MINUTES COMMENT = 'Wait at delivery in minutes',
    telemetry.speed AS SPEED_KMH COMMENT = 'Vehicle speed km/h',
    telemetry.battery AS BATTERY_PCT COMMENT = 'Battery charge percentage 0-100',
    telemetry.odometer AS ODOMETER_KM COMMENT = 'Cumulative distance driven km'
  )
  DIMENSIONS (
    trips.vehicle_type AS trips.VEHICLE_TYPE WITH SYNONYMS = ('fleet type', 'transport mode') COMMENT = 'Vehicle type: ebike, taxi, hgv',
    trips.region AS trips.REGION WITH SYNONYMS = ('city', 'area') COMMENT = 'Geographic region',
    trips.trip_status AS trips.STATUS WITH SYNONYMS = ('trip status', 'delivery status') COMMENT = 'Trip status: COMPLETED',
    trips.ors_profile AS trips.ORS_PROFILE WITH SYNONYMS = ('routing profile') COMMENT = 'ORS routing profile',
    trips.is_detour AS trips.IS_DETOUR WITH SYNONYMS = ('detour', 'deviation', 'off route') COMMENT = 'Whether trip had route deviation',
    trips.trip_start AS trips.TRIP_START WITH SYNONYMS = ('date', 'start time', 'when') COMMENT = 'Trip start timestamp',
    trips.trip_date AS DATE_TRUNC('day', trips.TRIP_START) WITH SYNONYMS = ('day', 'trip date') COMMENT = 'Trip date',
    trips.trip_hour AS HOUR(trips.TRIP_START) WITH SYNONYMS = ('hour', 'time of day') COMMENT = 'Hour of day 0-23',
    fleet.vehicle_name AS fleet.VEHICLE_NAME WITH SYNONYMS = ('driver', 'courier', 'vehicle') COMMENT = 'Vehicle/driver name',
    fleet.capacity AS fleet.CAPACITY_KG WITH SYNONYMS = ('load capacity') COMMENT = 'Vehicle capacity kg',
    pois.poi_name AS pois.NAME WITH SYNONYMS = ('restaurant', 'place', 'POI', 'location') COMMENT = 'Point of interest name',
    pois.poi_category AS pois.CATEGORY WITH SYNONYMS = ('POI type', 'business type') COMMENT = 'POI category',
    pois.location_type AS pois.LOCATION_TYPE WITH SYNONYMS = ('POI classification') COMMENT = 'Location classification',
    telemetry.vehicle_status AS telemetry.STATUS WITH SYNONYMS = ('state', 'activity', 'what is vehicle doing') COMMENT = 'MOVING, DWELL_ORIGIN, DWELL_DESTINATION, DWELL_RECHARGE, IDLE',
    telemetry.is_speeding AS telemetry.IS_SPEEDING WITH SYNONYMS = ('speeding', 'over limit', 'speed violation') COMMENT = 'Whether exceeding speed limit',
    telemetry.is_detour_point AS telemetry.IS_DETOUR WITH SYNONYMS = ('off route point') COMMENT = 'Whether GPS point was off planned route',
    telemetry.location_type AS telemetry.LOCATION_TYPE WITH SYNONYMS = ('stop type', 'dwell location') COMMENT = 'Type of dwell location'
  )
  METRICS (
    trips.total_trips AS COUNT(trips.TRIP_ID) WITH SYNONYMS = ('trip count', 'deliveries', 'number of trips') COMMENT = 'Total trips',
    trips.avg_distance_km AS AVG(trips.distance_km) WITH SYNONYMS = ('average distance') COMMENT = 'Average trip distance km',
    trips.avg_duration_min AS AVG(trips.duration_min) WITH SYNONYMS = ('average duration', 'delivery time') COMMENT = 'Average trip duration minutes',
    trips.total_distance_km AS SUM(trips.distance_km) WITH SYNONYMS = ('total km', 'fleet mileage') COMMENT = 'Total fleet distance km',
    trips.detour_rate AS AVG(CASE WHEN trips.IS_DETOUR THEN 1.0 ELSE 0.0 END) WITH SYNONYMS = ('deviation rate', 'off-route rate') COMMENT = 'Fraction of trips with detours',
    fleet.active_vehicles AS COUNT(DISTINCT fleet.VEHICLE_ID) WITH SYNONYMS = ('fleet size', 'vehicle count', 'active couriers') COMMENT = 'Active vehicle count',
    telemetry.total_readings AS COUNT(telemetry.TELEMETRY_ID) WITH SYNONYMS = ('GPS points', 'telemetry count') COMMENT = 'Total telemetry readings',
    telemetry.avg_speed AS AVG(telemetry.speed) WITH SYNONYMS = ('average speed', 'mean speed') COMMENT = 'Average vehicle speed km/h',
    telemetry.speeding_events AS SUM(CASE WHEN telemetry.IS_SPEEDING THEN 1 ELSE 0 END) WITH SYNONYMS = ('speed violations', 'speeding count') COMMENT = 'Number of speeding events',
    telemetry.avg_battery AS AVG(telemetry.battery) WITH SYNONYMS = ('average battery', 'mean charge') COMMENT = 'Average battery percentage'
  )
  COMMENT = 'Fleet intelligence analytics covering trips, telemetry, vehicles, and POIs. Supports trip performance, speed/compliance, dwell time, battery monitoring, and delivery metrics across all demos.'
  AI_SQL_GENERATION 'Round numeric results to 1 decimal. Use TRIM(pois.NAME, chr(34)) for POI names. For percentages multiply by 100 and add %. Group by VEHICLE_NAME for vehicle comparison.'
  AI_VERIFIED_QUERIES (
    trips_by_day AS (
      QUESTION 'How many trips were completed each day?'
      VERIFIED_AT 1748200000
      VERIFIED_BY '(STEWARD = fleet_admin)'
      SQL 'SELECT DATE_TRUNC(''day'', TRIP_START) AS TRIP_DATE, COUNT(*) AS TOTAL_TRIPS FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS GROUP BY TRIP_DATE ORDER BY TRIP_DATE'
    ),
    top_vehicles AS (
      QUESTION 'Which vehicles completed the most trips?'
      VERIFIED_AT 1748200000
      VERIFIED_BY '(STEWARD = fleet_admin)'
      SQL 'SELECT t.VEHICLE_ID, f.VEHICLE_NAME, COUNT(*) AS TRIP_COUNT, ROUND(AVG(t.DISTANCE_KM),1) AS AVG_KM, ROUND(AVG(t.DURATION_MINUTES),1) AS AVG_MIN FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS t JOIN SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET f ON t.VEHICLE_ID=f.VEHICLE_ID GROUP BY t.VEHICLE_ID, f.VEHICLE_NAME ORDER BY TRIP_COUNT DESC LIMIT 10'
    ),
    busiest_pois AS (
      QUESTION 'Which locations have the most pickups?'
      VERIFIED_AT 1748200000
      VERIFIED_BY '(STEWARD = fleet_admin)'
      SQL 'SELECT TRIM(p.NAME, chr(34)) AS POI_NAME, p.CATEGORY, COUNT(*) AS PICKUPS FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS t JOIN SYNTHETIC_DATASETS.UNIFIED.DIM_POIS p ON t.ORIGIN_POI_ID=p.LOCATION_ID GROUP BY p.NAME, p.CATEGORY ORDER BY PICKUPS DESC LIMIT 10'
    ),
    speed_compliance AS (
      QUESTION 'What is the speeding rate by vehicle?'
      VERIFIED_AT 1748200000
      VERIFIED_BY '(STEWARD = fleet_admin)'
      SQL 'SELECT t.VEHICLE_ID, f.VEHICLE_NAME, COUNT(*) AS TOTAL_READINGS, SUM(CASE WHEN t.IS_SPEEDING THEN 1 ELSE 0 END) AS SPEEDING_EVENTS, ROUND(SUM(CASE WHEN t.IS_SPEEDING THEN 1 ELSE 0 END)*100.0/COUNT(*),1) AS SPEEDING_PCT FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY t JOIN SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET f ON t.VEHICLE_ID=f.VEHICLE_ID GROUP BY t.VEHICLE_ID, f.VEHICLE_NAME ORDER BY SPEEDING_PCT DESC LIMIT 10'
    ),
    vehicle_status_breakdown AS (
      QUESTION 'What percentage of time do vehicles spend moving vs dwelling vs idle?'
      VERIFIED_AT 1748200000
      VERIFIED_BY '(STEWARD = fleet_admin)'
      SQL 'SELECT STATUS, COUNT(*) AS READINGS, ROUND(COUNT(*)*100.0/(SELECT COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY),1) AS PCT FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY GROUP BY STATUS ORDER BY READINGS DESC'
    ),
    hourly_distribution AS (
      QUESTION 'What is the trip distribution by hour of day?'
      VERIFIED_AT 1748200000
      VERIFIED_BY '(STEWARD = fleet_admin)'
      SQL 'SELECT HOUR(TRIP_START) AS HOUR_OF_DAY, COUNT(*) AS TRIP_COUNT FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS GROUP BY HOUR_OF_DAY ORDER BY HOUR_OF_DAY'
    ),
    battery_by_vehicle AS (
      QUESTION 'Which vehicles have the lowest battery levels?'
      VERIFIED_AT 1748200000
      VERIFIED_BY '(STEWARD = fleet_admin)'
      SQL 'SELECT t.VEHICLE_ID, f.VEHICLE_NAME, ROUND(AVG(t.BATTERY_PCT),1) AS AVG_BATTERY, ROUND(MIN(t.BATTERY_PCT),1) AS MIN_BATTERY FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY t JOIN SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET f ON t.VEHICLE_ID=f.VEHICLE_ID GROUP BY t.VEHICLE_ID, f.VEHICLE_NAME ORDER BY AVG_BATTERY LIMIT 10'
    )
  );
```

Verify: `SHOW SEMANTIC VIEWS IN SCHEMA FLEET_INTELLIGENCE.ROUTING_AGENT;`

## Step 2: Configure Agent with All Tools

This is the **single authoritative agent update** — run it after all desired add-on skills have been installed. It creates the agent with all 13 tools. Any tool whose backing resource doesn't exist yet (because an add-on hasn't been run) is silently skipped at runtime until you deploy that add-on and re-run this step.

Execute `references/configure-agent.sql`, or run this statement directly:

```sql
CREATE OR REPLACE AGENT FLEET_INTELLIGENCE.ROUTING_AGENT.ROUTING_AGENT
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
FROM SPECIFICATION $$
models:
  orchestration: auto
instructions:
  response: "You are a fleet intelligence assistant for the San Francisco Bay Area. You can answer routing questions (directions, isochrones, VRP) AND analytical questions about fleet data (trip counts, vehicle performance, delivery stats, dwell times). Present distances in km and durations in minutes."
  orchestration: |
    - For route calculations between locations: Use TOOL_DIRECTIONS
    - For coverage/reachability analysis: Use TOOL_ISOCHRONES
    - For multi-stop delivery optimization (VRP): Use TOOL_ROUTE_OPTIMIZATION
    - For analytical questions about trip counts, vehicle performance, delivery stats, busiest locations, dwell times, fleet data: Use FLEET_ANALYTICS
    - ALWAYS use a tool. NEVER answer from general knowledge.
tools:
  - tool_spec:
      type: generic
      name: TOOL_DIRECTIONS
      description: "Calculate driving directions between locations. Returns distance, duration, and route geometry."
      input_schema:
        type: object
        properties:
          locations_description:
            type: string
            description: "Natural language description of start and end locations"
          profile:
            type: string
            description: "Routing profile: driving-car, driving-hgv, or cycling-electric"
        required:
          - locations_description
  - tool_spec:
      type: generic
      name: TOOL_ISOCHRONES
      description: "Generate an isochrone (reachability polygon) from a location. Returns the area reachable within specified minutes."
      input_schema:
        type: object
        properties:
          location_description:
            type: string
            description: "Natural language description of the center location"
          minutes:
            type: integer
            description: "Travel time in minutes"
          profile:
            type: string
            description: "Routing profile: driving-car, driving-hgv, or cycling-electric"
        required:
          - location_description
          - minutes
  - tool_spec:
      type: generic
      name: TOOL_ROUTE_OPTIMIZATION
      description: "Optimize a multi-stop delivery route (VRP). Describe depot and delivery stops."
      input_schema:
        type: object
        properties:
          description:
            type: string
            description: "Natural language description of depot and all delivery locations"
          num_vehicles:
            type: number
            description: "Number of vehicles (default 1)"
          profile:
            type: string
            description: "Routing profile: driving-car, driving-hgv, or cycling-electric"
        required:
          - description
  - tool_spec:
      type: cortex_analyst_text_to_sql
      name: FLEET_ANALYTICS
      description: "Answer analytical questions about fleet data: trip counts, vehicle performance, delivery times, busiest POIs, hourly distributions, detour rates, and fleet utilization."
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
  FLEET_ANALYTICS:
    type: semantic_view
    semantic_view: FLEET_INTELLIGENCE.ROUTING_AGENT.FLEET_ANALYTICS_VIEW
    execution_environment:
      type: warehouse
      warehouse: ROUTING_ANALYTICS
$$;
```

Verify: `DESCRIBE AGENT FLEET_INTELLIGENCE.ROUTING_AGENT.ROUTING_AGENT;` — should show 4 tools (3 generic + 1 cortex_analyst_text_to_sql).

## Step 3: Deploy Demo Data

Execute `references/deploy-demo-data.sql` statement-by-statement. Creates:

| Table | Rows | Purpose |
|-------|------|---------|
| SF_PHARMA_JOBS | 30 | Pre-geocoded delivery stops |
| SF_HEALTH_DEMOGRAPHICS | 55 | Population health by neighborhood |
| SF_DRUG_FORMULARY | 25 | Drug demand by condition |
| SF_TOP_PHARMACIES | 6 | SF pharmacy locations |

## Step 4: Upload Config + JSON Format

```sql
CREATE FILE FORMAT IF NOT EXISTS OPENROUTESERVICE_APP.CORE.JSON_FORMAT
  TYPE = JSON STRIP_OUTER_ARRAY = FALSE;

COPY FILES INTO @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/config/
FROM 'snow://workspace/USER$.PUBLIC."sfguide-build-fleet-intelligence-with-cortex-code"/versions/live/'
FILES=('agent-demos.json');
```

Verify:
```sql
SELECT PARSE_JSON($1):scenarios[1]:id::VARCHAR FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/config/agent-demos.json (FILE_FORMAT => 'OPENROUTESERVICE_APP.CORE.JSON_FORMAT');
```
Expected: `analytics`

## Step 5: Configure Demo Defaults

```sql
UPDATE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.CONFIG SET VEHICLE_TYPE = 'ebike', REGION = 'SanFrancisco';
UPDATE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.CONFIG SET VEHICLE_TYPE = 'ebike', REGION = 'SanFrancisco';
UPDATE FLEET_INTELLIGENCE.DWELL_ANALYSIS.CONFIG SET VEHICLE_TYPE = 'ebike', REGION = 'SanFrancisco';
UPDATE FLEET_INTELLIGENCE.ROUTE_DEVIATION.CONFIG SET VEHICLE_TYPE = 'ebike', REGION = 'SanFrancisco';
UPDATE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG SET VEHICLE_TYPE = 'ebike', REGION = 'SanFrancisco';
UPDATE FLEET_INTELLIGENCE.RETAIL_CATCHMENT.CONFIG SET VEHICLE_TYPE = 'ebike', REGION = 'SanFrancisco';
```

## Verification Summary

| Check | Expected |
|-------|----------|
| `SHOW SEMANTIC VIEWS IN SCHEMA FLEET_INTELLIGENCE.ROUTING_AGENT` | FLEET_ANALYTICS_VIEW |
| `DESCRIBE AGENT ...ROUTING_AGENT` | 4 tools (3 generic + 1 cortex_analyst) |
| `SELECT COUNT(*) FROM ...SF_HEALTH_DEMOGRAPHICS` | 55 |
| Config loads from stage | JSON with "analytics" scenario |

## Agent Spec Rules

> - Routing tools: `type: generic` with `tool_resources.type: procedure`
> - Analytics tool: `type: cortex_analyst_text_to_sql` with `tool_resources.type: semantic_view`
> - Do NOT use `type: custom_tool` (causes runtime error)

## Cleanup

```sql
DROP SEMANTIC VIEW IF EXISTS FLEET_INTELLIGENCE.ROUTING_AGENT.FLEET_ANALYTICS_VIEW;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_PHARMA_JOBS;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_HEALTH_DEMOGRAPHICS;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_DRUG_FORMULARY;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_TOP_PHARMACIES;
```
