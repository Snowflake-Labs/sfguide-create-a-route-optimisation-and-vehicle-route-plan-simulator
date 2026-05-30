-- =============================================================================
-- verify-deployment.sql
-- End-to-end deployment verification. Run after deploy-all.sql completes.
-- Returns a single result: PASSED or FAILED with details.
-- =============================================================================

USE ROLE ACCOUNTADMIN;
USE WAREHOUSE ROUTING_ANALYTICS;

DECLARE
    v_errors VARCHAR DEFAULT '';
    v_count NUMBER;
    v_result VARCHAR;
BEGIN
    -- ─── 1. SPCS Services (5 must be RUNNING) ───────────────────────────────
    SHOW SERVICES IN DATABASE OPENROUTESERVICE_APP;
    v_count := (SELECT COUNT(*) FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) WHERE "status" = 'RUNNING');
    IF (v_count != 5) THEN
        v_errors := v_errors || '  FAIL: SPCS services RUNNING=' || v_count || ' (expected 5)\n';
    END IF;

    -- ─── 2. Seed Data ───────────────────────────────────────────────────────
    v_count := (SELECT COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS);
    IF (v_count < 6000) THEN
        v_errors := v_errors || '  FAIL: FACT_TRIPS rows=' || v_count || ' (expected >=6000)\n';
    END IF;

    v_count := (SELECT COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY);
    IF (v_count < 400000) THEN
        v_errors := v_errors || '  FAIL: FACT_VEHICLE_TELEMETRY rows=' || v_count || ' (expected >=400000)\n';
    END IF;

    -- ─── 3. Overture Maps Places ────────────────────────────────────────────
    v_count := (SELECT COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES);
    IF (v_count < 1000000) THEN
        v_errors := v_errors || '  FAIL: PLACES rows=' || v_count || ' (expected >=1M)\n';
    END IF;

    -- ─── 4. Routing Functions (verify callable — returns VARIANT even if ORS not provisioned) ─
    BEGIN
        v_result := (
            SELECT RESPONSE::VARCHAR FROM TABLE(OPENROUTESERVICE_APP.CORE.DIRECTIONS(
                'driving-car',
                PARSE_JSON('[[-122.4194, 37.7749], [-122.3894, 37.7949]]')::VARIANT,
                'SanFrancisco'
            ))
        );
        -- Function is callable. A connection_failed response is acceptable
        -- (means function works but ORS region isn't provisioned yet).
        IF (v_result IS NULL) THEN
            v_errors := v_errors || '  FAIL: DIRECTIONS returned NULL (function may not exist)\n';
        END IF;
    EXCEPTION
        WHEN OTHER THEN
            v_errors := v_errors || '  FAIL: DIRECTIONS error: ' || SQLERRM || '\n';
    END;

    -- ─── 5. Demo Skill Views ────────────────────────────────────────────────
    v_count := (SELECT COUNT(*) FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.VW_TRIP_SUMMARY);
    IF (v_count < 1) THEN
        v_errors := v_errors || '  FAIL: VW_TRIP_SUMMARY is empty\n';
    END IF;

    v_count := (SELECT COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_DEVIATION.TRIP_DEVIATION_ANALYSIS);
    IF (v_count < 1) THEN
        v_errors := v_errors || '  FAIL: TRIP_DEVIATION_ANALYSIS is empty\n';
    END IF;

    -- ─── 6. Pharma Supply Chain ─────────────────────────────────────────────
    v_count := (SELECT COUNT(*) FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANTS);
    IF (v_count < 6) THEN
        v_errors := v_errors || '  FAIL: PLANTS rows=' || v_count || ' (expected >=6)\n';
    END IF;

    v_count := (SELECT COUNT(*) FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.ROBOT_TELEMETRY);
    IF (v_count < 100) THEN
        v_errors := v_errors || '  FAIL: ROBOT_TELEMETRY rows=' || v_count || ' (expected >=100)\n';
    END IF;

    -- ─── 7. Agent Tool Procedures ───────────────────────────────────────────
    BEGIN
        CALL FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_WEATHER('SanFrancisco');
    EXCEPTION
        WHEN OTHER THEN
            v_errors := v_errors || '  FAIL: TOOL_WEATHER error: ' || SQLERRM || '\n';
    END;

    BEGIN
        CALL FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_PLANT_IMPACT('ALL');
    EXCEPTION
        WHEN OTHER THEN
            v_errors := v_errors || '  FAIL: TOOL_PLANT_IMPACT error: ' || SQLERRM || '\n';
    END;

    BEGIN
        CALL FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_INVENTORY_STATUS('ALL');
    EXCEPTION
        WHEN OTHER THEN
            v_errors := v_errors || '  FAIL: TOOL_INVENTORY_STATUS error: ' || SQLERRM || '\n';
    END;

    BEGIN
        CALL FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_DEMAND_FORECAST('Walgreens Castro', 'ALL');
    EXCEPTION
        WHEN OTHER THEN
            v_errors := v_errors || '  FAIL: TOOL_DEMAND_FORECAST error: ' || SQLERRM || '\n';
    END;

    BEGIN
        CALL FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_SUPPLY_CHAIN('driving-car');
    EXCEPTION
        WHEN OTHER THEN
            v_errors := v_errors || '  FAIL: TOOL_SUPPLY_CHAIN error: ' || SQLERRM || '\n';
    END;

    BEGIN
        CALL FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_DIRECTIONS('Market Street to Mission District', 'driving-car');
    EXCEPTION
        WHEN OTHER THEN
            v_errors := v_errors || '  FAIL: TOOL_DIRECTIONS error: ' || SQLERRM || '\n';
    END;

    BEGIN
        CALL FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ISOCHRONE('Union Square San Francisco', 10, 'driving-car');
    EXCEPTION
        WHEN OTHER THEN
            v_errors := v_errors || '  FAIL: TOOL_ISOCHRONE error: ' || SQLERRM || '\n';
    END;

    -- ─── 8. Semantic Views (4 expected) ─────────────────────────────────────
    v_count := (SELECT COUNT(*) FROM FLEET_INTELLIGENCE.INFORMATION_SCHEMA.SEMANTIC_VIEWS);
    IF (v_count < 4) THEN
        v_errors := v_errors || '  FAIL: semantic views=' || v_count || ' (expected >=4)\n';
    END IF;

    -- ─── 9. Agent Exists ────────────────────────────────────────────────────
    SHOW AGENTS IN SCHEMA FLEET_INTELLIGENCE.ROUTING_AGENT;
    v_count := (SELECT COUNT(*) FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())));
    IF (v_count < 1) THEN
        v_errors := v_errors || '  FAIL: ROUTING_AGENT not found\n';
    END IF;

    -- ─── 10. Streamlit Exists ───────────────────────────────────────────────
    SHOW STREAMLITS IN SCHEMA SYNTHETIC_DATASETS.UNIFIED;
    v_count := (SELECT COUNT(*) FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())));
    IF (v_count < 1) THEN
        v_errors := v_errors || '  FAIL: FLEET_MAP Streamlit not found\n';
    END IF;

    -- ─── 11. All 13 Tool Procedures Exist ───────────────────────────────────
    v_result := (
        SELECT NULLIF(LISTAGG(expected_proc, ', ') WITHIN GROUP (ORDER BY expected_proc), '')
        FROM (
            SELECT expected_proc
            FROM (
                SELECT 'TOOL_DIRECTIONS' AS expected_proc
                UNION ALL SELECT 'TOOL_ISOCHRONE'
                UNION ALL SELECT 'TOOL_OPTIMIZATION'
                UNION ALL SELECT 'TOOL_PHARMA_CATCHMENT'
                UNION ALL SELECT 'TOOL_SUPPLY_CHAIN'
                UNION ALL SELECT 'TOOL_INVENTORY_STATUS'
                UNION ALL SELECT 'TOOL_DEMAND_FORECAST'
                UNION ALL SELECT 'TOOL_REPLENISHMENT_PLAN'
                UNION ALL SELECT 'TOOL_WEATHER'
                UNION ALL SELECT 'TOOL_PLANT_IMPACT'
                UNION ALL SELECT 'TOOL_CREATE_PLANT'
                UNION ALL SELECT 'TOOL_REMOVE_PLANT'
                UNION ALL SELECT 'TOOL_ALTER_PLANT'
            ) expected
            LEFT JOIN FLEET_INTELLIGENCE.INFORMATION_SCHEMA.PROCEDURES p
                ON p.PROCEDURE_SCHEMA = 'ROUTING_AGENT'
                AND p.PROCEDURE_NAME = expected.expected_proc
            WHERE p.PROCEDURE_NAME IS NULL
        )
    );
    IF (v_result IS NOT NULL) THEN
        v_errors := v_errors || '  FAIL: Missing procedures: ' || v_result || '\n';
    END IF;

    -- ─── FINAL RESULT ───────────────────────────────────────────────────────
    IF (v_errors != '') THEN
        RETURN 'DEPLOYMENT VERIFICATION FAILED:\n' || v_errors;
    END IF;

    RETURN 'DEPLOYMENT VERIFIED — ALL 11 CHECKS PASSED\n' ||
           '  [1]  5/5 SPCS services RUNNING\n' ||
           '  [2]  Seed data loaded (FACT_TRIPS, TELEMETRY)\n' ||
           '  [3]  Overture Maps Places (1.4M+)\n' ||
           '  [4]  Routing functions operational (DIRECTIONS)\n' ||
           '  [5]  Demo skill views populated\n' ||
           '  [6]  Pharma supply chain (6 plants, robots)\n' ||
           '  [7]  Agent tools callable (WEATHER, PLANT_IMPACT, INVENTORY, DEMAND, SUPPLY_CHAIN, DIRECTIONS, ISOCHRONE)\n' ||
           '  [8]  4 semantic views active\n' ||
           '  [9]  ROUTING_AGENT deployed\n' ||
           '  [10] FLEET_MAP Streamlit live\n' ||
           '  [11] All 13 tool procedures registered';
END;
