-- ============================================================================
-- Backload Matching - Cleanup Stale Artifacts
-- ============================================================================
-- Drops objects from earlier iterations of this skill that are no longer
-- referenced by bootstrap.sql, BackloadMatching.tsx, or the Data Studio
-- engine path. Safe and idempotent (uses IF EXISTS).
--
-- Objects removed:
--   * TASK_BACKLOAD_RESCAN          - suspended task calling the dropped SP
--   * SP_SOLVE_REGION_BACKLOAD       - stored procedure tied to old view shapes
--   * EXTERNAL_OFFERS_ENRICHED       - Dynamic Table over now-dropped EXTERNAL_OFFERS
--   * BACKLOAD_PLAN_HISTORY          - empty target of the dead task
--
-- Objects PRESERVED:
--   * CONFIG, PROPOSAL_DECISIONS, VW_TRAILERS, VW_INTERNAL_VOLUMES,
--     VW_EXTERNAL_OFFERS  (the live skill surface)
-- ============================================================================

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-backload-matching","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

ALTER TASK IF EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING.TASK_BACKLOAD_RESCAN SUSPEND;
DROP TASK IF EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING.TASK_BACKLOAD_RESCAN;

DROP PROCEDURE IF EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING.SP_SOLVE_REGION_BACKLOAD(VARCHAR, NUMBER);

DROP DYNAMIC TABLE IF EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING.EXTERNAL_OFFERS_ENRICHED;
DROP TABLE         IF EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING.BACKLOAD_PLAN_HISTORY;

SHOW OBJECTS IN SCHEMA FLEET_INTELLIGENCE.BACKLOAD_MATCHING;
