-- SV_DWELL_ANALYTICS - dwell analysis semantic view
-- Source: FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DWELL_ENRICHED (dwell sessions),
--         FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DRIVER_DWELL_SUMMARY (per-driver SLA)
-- Deploy target: FLEET_INTELLIGENCE.SEMANTIC (via fleet_test_evals connection)
-- AVG_POINT GEOGRAPHY excluded. Two independent facts.

CREATE OR REPLACE SEMANTIC VIEW FLEET_INTELLIGENCE.SEMANTIC.SV_DWELL_ANALYTICS

  TABLES (
    sessions AS FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DWELL_ENRICHED
      PRIMARY KEY (VEHICLE_ID, SESSION_ID)
    , driver_dwell AS FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DRIVER_DWELL_SUMMARY
      PRIMARY KEY (VEHICLE_ID)
  )

  FACTS (
    sessions.dwell_minutes AS DWELL_MINUTES COMMENT = 'Dwell session length in minutes'
    , sessions.dwell_seconds AS DWELL_SECONDS COMMENT = 'Dwell session length in seconds'
    , sessions.ping_count AS PING_COUNT COMMENT = 'GPS pings in the dwell session'
    , driver_dwell.d_total_dwell_min AS TOTAL_DWELL_MIN COMMENT = 'Per-driver total dwell minutes'
    , driver_dwell.d_total_dwell_hours AS TOTAL_DWELL_HOURS COMMENT = 'Per-driver total dwell hours'
    , driver_dwell.d_avg_session_min AS AVG_SESSION_MIN COMMENT = 'Per-driver average session minutes'
    , driver_dwell.d_sla_breach_count AS SLA_BREACH_COUNT COMMENT = 'Per-driver SLA breach count'
    , driver_dwell.d_critical_breach_count AS CRITICAL_BREACH_COUNT COMMENT = 'Per-driver critical SLA breach count'
  )

  DIMENSIONS (
    sessions.dwell_status AS STATUS WITH SYNONYMS ('dwell type', 'session status') COMMENT = 'Dwell status (DWELL_WAREHOUSE, DWELL_STORE, DWELL_REST, etc.)'
    , sessions.facility_type AS FACILITY_TYPE WITH SYNONYMS ('facility') COMMENT = 'Facility type at the dwell location'
    , sessions.loc_type AS LOC_TYPE COMMENT = 'Location type'
    , sessions.city AS CITY WITH SYNONYMS ('dwell city') COMMENT = 'City of the dwell location'
    , sessions.location_name AS LOCATION_NAME WITH SYNONYMS ('facility name', 'place') COMMENT = 'Dwell location name'
    , sessions.h3_cell AS H3_CELL_R7 WITH SYNONYMS ('hex cell', 'h3') COMMENT = 'H3 resolution-7 cell for congestion heatmaps'
    , sessions.driver_profile AS DRIVER_PROFILE COMMENT = 'Driver profile'
    , sessions.operating_mode AS OPERATING_MODE COMMENT = 'Operating mode'
    , sessions.session_start AS SESSION_START WITH SYNONYMS ('dwell start') COMMENT = 'Dwell session start timestamp'
    , driver_dwell.dd_driver_profile AS DRIVER_PROFILE COMMENT = 'Driver profile (driver summary)'
    , driver_dwell.dd_operating_mode AS OPERATING_MODE COMMENT = 'Operating mode (driver summary)'
    , driver_dwell.home_base_name AS HOME_BASE_NAME WITH SYNONYMS ('home base', 'depot') COMMENT = 'Driver home base name'
    , driver_dwell.dd_vehicle_id AS VEHICLE_ID COMMENT = 'Vehicle id (driver summary)'
  )

  METRICS (
    sessions.total_sessions AS COUNT(*) WITH SYNONYMS ('dwell sessions', 'number of dwells') COMMENT = 'Total dwell sessions'
    , sessions.total_dwell_minutes AS SUM(dwell_minutes) WITH SYNONYMS ('total dwell time') COMMENT = 'Total dwell minutes'
    , sessions.total_dwell_hours AS SUM(dwell_minutes) / 60.0 COMMENT = 'Total dwell hours'
    , sessions.avg_dwell_minutes AS AVG(dwell_minutes) WITH SYNONYMS ('average dwell time') COMMENT = 'Average dwell minutes per session'
    , sessions.max_dwell_minutes AS MAX(dwell_minutes) COMMENT = 'Longest dwell session in minutes'
    , sessions.unique_vehicles AS COUNT(DISTINCT VEHICLE_ID) WITH SYNONYMS ('vehicles dwelling') COMMENT = 'Distinct vehicles with dwells'
    , sessions.unique_dwell_locations AS COUNT(DISTINCT LOCATION_ID) WITH SYNONYMS ('locations') COMMENT = 'Distinct dwell locations'
    , driver_dwell.total_sla_breaches AS SUM(d_sla_breach_count) WITH SYNONYMS ('SLA breaches', 'sla violations') COMMENT = 'Total SLA breaches across drivers'
    , driver_dwell.total_critical_breaches AS SUM(d_critical_breach_count) WITH SYNONYMS ('critical breaches') COMMENT = 'Total critical SLA breaches'
    , driver_dwell.driver_total_dwell_hours AS SUM(d_total_dwell_hours) COMMENT = 'Total dwell hours (driver summary)'
    , driver_dwell.avg_driver_session_min AS AVG(d_avg_session_min) COMMENT = 'Average per-driver session minutes'
  )

  COMMENT = 'Dwell analysis: vehicle dwell sessions (where/how long vehicles stop), facility utilization, H3 congestion, and per-driver SLA breaches.'

  AI_SQL_GENERATION 'Dwell analysis semantic view for the Route Optimisation & Fleet Intelligence solution.

Entities (two independent facts):
- sessions (DT_DWELL_ENRICHED): one row per dwell session (a vehicle stopped at a location). Use for dwell time, facility utilization (group by facility_type/city/location_name), and congestion (group by h3_cell).
- driver_dwell (DT_DRIVER_DWELL_SUMMARY): per-driver aggregates including SLA breach counts. Use for SLA / per-driver dwell questions.

Conventions:
- "congestion" / "heatmap" -> group sessions by h3_cell.
- "SLA breaches" / "violations" -> driver_dwell.total_sla_breaches or total_critical_breaches.
- "dwell time" -> sessions.total_dwell_minutes or avg_dwell_minutes.
- status values look like DWELL_WAREHOUSE, DWELL_STORE, DWELL_REST.'
;
