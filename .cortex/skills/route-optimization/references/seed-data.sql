/*
 * seed-data.sql — Route Optimization Demo
 *
 * Schema (FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION) and the
 * SEED_ROUTE_OPTIMIZATION_REGION procedure now live inside
 * build-routing-solution (app/modules/15_route_optimization_seed.sql) so
 * they are always present BEFORE any region is provisioned via
 * PROVISION_REGION_WRAPPER. This file is now responsible only for:
 *   1. Seeding the configured demo region (PLACES, LOOKUP, JOB_TEMPLATE,
 *      SEN_STUDENTS) via the proc.
 *   2. Backfilling every already-DEPLOYED region.
 *   3. Provisioning the warehouse, notebook stage, and CONFIG row.
 *
 * Everything is region-parameterized; no city/region is hardcoded.
 *
 * Run via: snow sql -f .cortex/skills/route-optimization/references/seed-data.sql -c <connection>
 *
 * NOTE: This script uses SET session variables. Execute via `snow sql -f` (single session).
 */

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-route-optimization","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

--------------------------------------------------------------------
-- REGION CONFIGURATION (customize for your region)
--------------------------------------------------------------------
SET REGION_NAME = 'SanFrancisco';

--------------------------------------------------------------------
-- WAREHOUSE + NOTEBOOK STAGE
-- (Database, schema, and tables are created by build-routing-solution
-- module 15. Re-creating them here is unnecessary and would just no-op.)
--------------------------------------------------------------------
CREATE WAREHOUSE IF NOT EXISTS ROUTING_ANALYTICS
    WAREHOUSE_SIZE = 'XSMALL'
    AUTO_SUSPEND = 60
    AUTO_RESUME = TRUE
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-route-optimization","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE STAGE IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.NOTEBOOK
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-route-optimization","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

--------------------------------------------------------------------
-- CONFIG (single-row pointer to the active demo region)
--------------------------------------------------------------------
MERGE INTO FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG tgt
USING (
    SELECT COALESCE(
        (SELECT VEHICLE_TYPE
         FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS
         WHERE REGION = $REGION_NAME AND IS_ACTIVE = TRUE
         ORDER BY CREATED_AT DESC
         LIMIT 1),
        'driving-car'
    ) AS VEHICLE_TYPE,
    $REGION_NAME AS REGION
) src
ON TRUE
WHEN MATCHED THEN UPDATE SET tgt.VEHICLE_TYPE = src.VEHICLE_TYPE, tgt.REGION = src.REGION
WHEN NOT MATCHED THEN INSERT (VEHICLE_TYPE, REGION) VALUES (src.VEHICLE_TYPE, src.REGION);

--------------------------------------------------------------------
-- Seed the configured region.
-- The procedure is idempotent: re-running is safe.
--------------------------------------------------------------------
CALL FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SEED_ROUTE_OPTIMIZATION_REGION($REGION_NAME);

--------------------------------------------------------------------
-- Backfill every already-DEPLOYED region.
-- Idempotent: SEED_ROUTE_OPTIMIZATION_REGION skips PLACES if already
-- populated and DELETE+INSERTs LOOKUP/JOB_TEMPLATE/SEN_STUDENTS.
-- Per-region try/catch so a failure on one region (missing bbox,
-- Overture share unmounted, etc.) doesn't abort the loop.
--------------------------------------------------------------------
EXECUTE IMMEDIATE $$
DECLARE
    c CURSOR FOR
        SELECT REGION
        FROM OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP
        WHERE STATUS = 'DEPLOYED';
BEGIN
    FOR rec IN c DO
        BEGIN
            CALL FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SEED_ROUTE_OPTIMIZATION_REGION(:rec.REGION);
        EXCEPTION WHEN OTHER THEN NULL;
        END;
    END FOR;
END;
$$;
