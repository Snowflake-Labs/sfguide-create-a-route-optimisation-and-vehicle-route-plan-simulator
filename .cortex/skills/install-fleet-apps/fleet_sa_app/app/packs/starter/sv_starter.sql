-- =============================================================================
-- SV_STARTER - neutral starter pack semantic view (Cortex Analyst)
-- =============================================================================
-- Two independent facts over the neutral starter contract:
--   LOCATIONS (STARTER_APP.CORE.VW_LOCATIONS) - one row per place
--   MOVEMENTS (STARTER_APP.CORE.VW_MOVEMENTS) - one row per origin->destination move
-- No fleet vocabulary. Committed as the pack's SV source of truth.
--
-- Apply: snow sql -c fleet_test_evals -f sv_starter.sql
-- =============================================================================
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-starter-sv","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE SCHEMA IF NOT EXISTS STARTER_APP.SEMANTIC
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"data-contract-semantic"}}';

CREATE OR REPLACE SEMANTIC VIEW STARTER_APP.SEMANTIC.SV_STARTER
  tables (
    LOCATIONS as STARTER_APP.CORE.VW_LOCATIONS primary key (LOCATION_ID),
    MOVEMENTS as STARTER_APP.CORE.VW_MOVEMENTS primary key (MOVEMENT_ID)
  )
  facts (
    MOVEMENTS.DISTANCE_KM as DISTANCE_KM comment='Movement distance in km',
    MOVEMENTS.DURATION_MINUTES as DURATION_MINUTES comment='Movement duration in minutes'
  )
  dimensions (
    LOCATIONS.NAME as NAME with synonyms=('place','location name') comment='Location name',
    LOCATIONS.CATEGORY as CATEGORY with synonyms=('category','type') comment='Location category',
    LOCATIONS.LOCATION_TYPE as LOCATION_TYPE comment='Location type',
    MOVEMENTS.STATUS as STATUS comment='Movement status',
    MOVEMENTS.STARTED_AT as STARTED_AT with synonyms=('start time','date') comment='Movement start timestamp'
  )
  metrics (
    LOCATIONS.TOTAL_LOCATIONS as COUNT(DISTINCT LOCATION_ID) with synonyms=('number of locations','location count','places') comment='Distinct location count',
    LOCATIONS.UNIQUE_CATEGORIES as COUNT(DISTINCT CATEGORY) with synonyms=('number of categories') comment='Distinct location categories',
    MOVEMENTS.TOTAL_MOVEMENTS as COUNT(DISTINCT MOVEMENT_ID) with synonyms=('number of movements','movement count','trips') comment='Distinct movement count',
    MOVEMENTS.AVG_DISTANCE_KM as AVG(DISTANCE_KM) with synonyms=('average distance') comment='Average movement distance (km)',
    MOVEMENTS.AVG_DURATION_MINUTES as AVG(DURATION_MINUTES) with synonyms=('average duration') comment='Average movement duration (min)',
    MOVEMENTS.TOTAL_DISTANCE_KM as SUM(DISTANCE_KM) with synonyms=('total distance') comment='Total movement distance (km)'
  )
  comment='Neutral starter semantic view: locations by category and origin->destination movements with distance/duration. Domain-agnostic reference model.'
  ai_sql_generation 'Neutral starter semantic view. Two independent facts: - locations (VW_LOCATIONS): one row per place; use total_locations grouped by category for density questions. - movements (VW_MOVEMENTS): one row per origin->destination move; use total_movements, avg_distance_km, avg_duration_minutes, total_distance_km, optionally grouped by DATE_TRUNC over started_at for daily trends or by status.';

GRANT SELECT ON SEMANTIC VIEW STARTER_APP.SEMANTIC.SV_STARTER TO ROLE FLEET_APP_USER;
GRANT SELECT ON SEMANTIC VIEW STARTER_APP.SEMANTIC.SV_STARTER TO ROLE FLEET_APP_OPS;
GRANT SELECT ON SEMANTIC VIEW STARTER_APP.SEMANTIC.SV_STARTER TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON SCHEMA STARTER_APP.SEMANTIC TO ROLE FLEET_APP_USER;
GRANT USAGE ON SCHEMA STARTER_APP.SEMANTIC TO ROLE FLEET_APP_OPS;
GRANT USAGE ON SCHEMA STARTER_APP.SEMANTIC TO ROLE FLEET_APP_ADMIN;
