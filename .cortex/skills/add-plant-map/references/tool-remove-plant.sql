-- =============================================================================
-- TOOL_REMOVE_PLANT — Decommission a manufacturing plant and remove all
-- associated data (robots, buildings, batches, shipments, inventory).
-- =============================================================================

USE ROLE ACCOUNTADMIN;
USE WAREHOUSE ROUTING_ANALYTICS;

CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_REMOVE_PLANT(
    PLANT_NAME VARCHAR
)
RETURNS VARIANT
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-add-plant-map","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    v_plant_id NUMBER;
    v_plant_code VARCHAR;
    v_robots_deleted NUMBER DEFAULT 0;
    v_buildings_deleted NUMBER DEFAULT 0;
    v_batches_deleted NUMBER DEFAULT 0;
    v_shipments_deleted NUMBER DEFAULT 0;
    v_inventory_deleted NUMBER DEFAULT 0;
BEGIN
    -- Resolve plant by name (case-insensitive partial match)
    SELECT PLANT_ID, PLANT_CODE INTO :v_plant_id, :v_plant_code
    FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANTS
    WHERE UPPER(PLANT_NAME) LIKE '%' || UPPER(:PLANT_NAME) || '%'
       OR UPPER(PLANT_CODE) = UPPER(:PLANT_NAME)
       OR UPPER(CITY) LIKE '%' || UPPER(:PLANT_NAME) || '%'
    LIMIT 1;

    IF (:v_plant_id IS NULL) THEN
        RETURN OBJECT_CONSTRUCT(
            'status', 'FAILED',
            'error', 'Plant not found: ' || :PLANT_NAME,
            'hint', 'Try using the plant name, code, or city'
        );
    END IF;

    -- Delete in dependency order (children first)
    DELETE FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.ROBOT_TELEMETRY
    WHERE PLANT_ID = :v_plant_id;
    v_robots_deleted := SQLROWCOUNT;

    DELETE FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANT_ALERT_STATUS
    WHERE PLANT_ID = :v_plant_id;

    DELETE FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANT_PRIMARY_BUILDING
    WHERE PLANT_ID = :v_plant_id;

    DELETE FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANT_CAMPUS_BUILDINGS
    WHERE PLANT_ID = :v_plant_id;
    v_buildings_deleted := SQLROWCOUNT;

    DELETE FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANT_BUILDING_FOOTPRINTS
    WHERE PLANT_ID = :v_plant_id;

    DELETE FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.SHIPMENTS
    WHERE ORIGIN_PLANT_ID = :v_plant_id;
    v_shipments_deleted := SQLROWCOUNT;

    DELETE FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PRODUCTION_BATCHES
    WHERE PLANT_ID = :v_plant_id;
    v_batches_deleted := SQLROWCOUNT;

    DELETE FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.MATERIAL_INVENTORY
    WHERE PLANT_ID = :v_plant_id;
    v_inventory_deleted := SQLROWCOUNT;

    -- Finally remove the plant itself
    DELETE FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANTS
    WHERE PLANT_ID = :v_plant_id;

    RETURN OBJECT_CONSTRUCT(
        'status', 'SUCCESS',
        'message', 'Plant decommissioned: ' || :PLANT_NAME,
        'plant_id', :v_plant_id,
        'plant_code', :v_plant_code,
        'deleted', OBJECT_CONSTRUCT(
            'robots', :v_robots_deleted,
            'campus_buildings', :v_buildings_deleted,
            'batches', :v_batches_deleted,
            'shipments', :v_shipments_deleted,
            'material_inventory', :v_inventory_deleted
        )
    );
EXCEPTION
    WHEN OTHER THEN
        RETURN OBJECT_CONSTRUCT(
            'status', 'FAILED',
            'error', SQLERRM,
            'plant_name', :PLANT_NAME
        );
END;
$$;
