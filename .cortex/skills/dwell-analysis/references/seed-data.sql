/*
 * seed-data.sql — Dwell Analysis (Simplified)
 *
 * This file is a THIN WRAPPER that runs the full pipeline.
 * The complete pipeline is in sql-pipeline.sql.
 *
 * For workspace environments (no snow sql -f), execute sql-pipeline.sql
 * statement-by-statement via snowflake_sql_execute.
 *
 * Prerequisites:
 *   - SYNTHETIC_DATASETS.UNIFIED tables loaded (build-routing-solution Step 7)
 *   - FACT_VEHICLE_TELEMETRY must have POINT_GEOM (GEOGRAPHY) column
 *   - DIM_POIS must have POINT_GEOM (GEOGRAPHY) column
 *
 * If POINT_GEOM columns are missing, run BEFORE this script:
 *   ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY ADD COLUMN IF NOT EXISTS POINT_GEOM GEOGRAPHY;
 *   UPDATE SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY SET POINT_GEOM = TRY_TO_GEOGRAPHY(POINT_GEOM_WKT) WHERE POINT_GEOM IS NULL AND POINT_GEOM_WKT IS NOT NULL;
 *   ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.DIM_POIS ADD COLUMN IF NOT EXISTS POINT_GEOM GEOGRAPHY;
 *   UPDATE SYNTHETIC_DATASETS.UNIFIED.DIM_POIS SET POINT_GEOM = TRY_TO_GEOGRAPHY(POINT_GEOM_WKT) WHERE POINT_GEOM IS NULL AND POINT_GEOM_WKT IS NOT NULL;
 *
 * Usage:
 *   snow sql -f .cortex/skills/dwell-analysis/references/sql-pipeline.sql -c <connection>
 *
 * The full pipeline creates:
 *   - CONFIG table (ebike/SanFrancisco)
 *   - VW_VEHICLE_TELEMETRY, VW_TRIP_SUMMARY (projection views)
 *   - SLA_THRESHOLDS table
 *   - 8 Dynamic Tables:
 *     - DT_STATE_CHANGES (LiveOperations page)
 *     - DT_DWELL_EVENTS (session detection)
 *     - DT_DWELL_ENRICHED (enriched with POI names, AVG_POINT, STATUS)
 *     - DT_H3_CONGESTION (CongestionMap page)
 *     - DT_SLA_ALERTS (SLAAlerts page)
 *     - DT_FACILITY_UTILIZATION (FacilityUtilization page)
 *     - DT_DRIVER_DWELL_SUMMARY (DriverPerformance page)
 *     - DT_DAILY_TRENDS (DwellOverview page)
 */

-- Point to the full pipeline
-- Execute: snow sql -f .cortex/skills/dwell-analysis/references/sql-pipeline.sql -c <connection>
