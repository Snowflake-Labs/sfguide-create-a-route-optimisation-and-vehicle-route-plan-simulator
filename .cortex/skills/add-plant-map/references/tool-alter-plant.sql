-- =============================================================================
-- TOOL_ALTER_PLANT — Resize and customize the robot/sensor fleet at a plant.
-- Can change robot count, rename robot types, and set custom activity descriptions.
-- =============================================================================

USE ROLE ACCOUNTADMIN;
USE WAREHOUSE ROUTING_ANALYTICS;

CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ALTER_PLANT(
    PLANT_NAME VARCHAR,
    ROBOT_COUNT NUMBER DEFAULT NULL,
    BUILDING_ROLE VARCHAR DEFAULT NULL,
    ROBOT_TYPE_FILTER VARCHAR DEFAULT NULL,
    ROBOT_TYPE_LABELS VARCHAR DEFAULT NULL,
    STATUS_DESCRIPTIONS VARCHAR DEFAULT NULL
)
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-add-plant-map","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    v_plant_id NUMBER;
    v_plant_code VARCHAR;
    v_old_count NUMBER;
    v_new_count NUMBER;
    v_target_building_name VARCHAR;
    v_updated_labels NUMBER DEFAULT 0;
    v_updated_status NUMBER DEFAULT 0;
BEGIN
    -- Resolve plant
    SELECT PLANT_ID, PLANT_CODE INTO v_plant_id, v_plant_code
    FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANTS
    WHERE UPPER(PLANTS.PLANT_NAME) = UPPER(:PLANT_NAME)
       OR UPPER(PLANT_CODE) = UPPER(:PLANT_NAME)
    LIMIT 1;

    IF (v_plant_id IS NULL) THEN
        RETURN OBJECT_CONSTRUCT('status', 'FAILED', 'error', 'Plant not found: ' || :PLANT_NAME)::VARCHAR;
    END IF;

    -- Count existing robots in scope
    SELECT COUNT(*) INTO v_old_count
    FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.ROBOT_TELEMETRY
    WHERE PLANT_ID = :v_plant_id
      AND (:BUILDING_ROLE IS NULL OR UPPER(BUILDING_ROLE) = UPPER(:BUILDING_ROLE))
      AND (:ROBOT_TYPE_FILTER IS NULL OR UPPER(ROBOT_TYPE) = UPPER(:ROBOT_TYPE_FILTER));

    -- ─── Resize logic (only if ROBOT_COUNT is provided) ─────────────────────
    IF (:ROBOT_COUNT IS NOT NULL) THEN

    IF (:BUILDING_ROLE IS NOT NULL) THEN

        -- Get the building role name
        SELECT DISTINCT BUILDING_ROLE_NAME INTO v_target_building_name
        FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.ROBOT_TELEMETRY
        WHERE PLANT_ID = :v_plant_id
          AND UPPER(BUILDING_ROLE) = UPPER(:BUILDING_ROLE)
        LIMIT 1;

        IF (v_target_building_name IS NULL) THEN
            -- Building role doesn't exist yet for this plant, use standard name
            v_target_building_name := CASE UPPER(:BUILDING_ROLE)
                WHEN 'API'  THEN 'API Manufacturing'
                WHEN 'FORM' THEN 'Formulation & Filling'
                WHEN 'COLD' THEN 'Cold Chain Warehouse'
                WHEN 'QC'   THEN 'QC Laboratory'
                WHEN 'UTIL' THEN 'Central Utilities'
                WHEN 'DIST' THEN 'Distribution & Dispatch'
                ELSE :BUILDING_ROLE
            END;
        END IF;

        -- Delete existing robots in scope
        IF (:ROBOT_TYPE_FILTER IS NOT NULL) THEN
            DELETE FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.ROBOT_TELEMETRY
            WHERE PLANT_ID = :v_plant_id
              AND UPPER(BUILDING_ROLE) = UPPER(:BUILDING_ROLE)
              AND UPPER(ROBOT_TYPE) = UPPER(:ROBOT_TYPE_FILTER);
        ELSE
            DELETE FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.ROBOT_TELEMETRY
            WHERE PLANT_ID = :v_plant_id
              AND UPPER(BUILDING_ROLE) = UPPER(:BUILDING_ROLE);
        END IF;

        -- Generate new robots for this building only
        INSERT INTO FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.ROBOT_TELEMETRY
            (SNAPSHOT_TIME, PLANT_ID, PLANT_NAME, BUILDING_ROLE, BUILDING_ROLE_NAME, FLOOR_INDEX,
             ROBOT_ID, ROBOT_TYPE, ROBOT_TYPE_LABEL, STATUS, CURRENT_ZONE, DESTINATION_ZONE,
             BATTERY_PCT, SPEED_MS, VIBRATION_MM_S, ONBOARD_TEMP_C, DISTANCE_TRAVELLED_M,
             UPTIME_HRS, MAINT_DUE_HRS, CARGO_BATCH, CARGO_KG)
        WITH seq AS (
            SELECT ROW_NUMBER() OVER (ORDER BY SEQ4()) - 1 AS rn
            FROM TABLE(GENERATOR(ROWCOUNT => :ROBOT_COUNT))
        )
        SELECT
            CURRENT_TIMESTAMP(),
            :v_plant_id,
            :PLANT_NAME,
            LOWER(:BUILDING_ROLE),
            :v_target_building_name,
            MOD(s.rn, 3),
            -- Robot ID
            CASE
                WHEN :ROBOT_TYPE_FILTER IS NOT NULL THEN UPPER(:ROBOT_TYPE_FILTER)
                WHEN MOD(s.rn, 10) < 5 THEN 'AGV'
                WHEN MOD(s.rn, 10) < 8 THEN 'INSPECT'
                ELSE 'CLEAN'
            END || '-' || :v_plant_code || '-' || UPPER(:BUILDING_ROLE) || '-' || LPAD(CAST(s.rn + 1 AS VARCHAR), 3, '0'),
            -- Robot type
            CASE
                WHEN :ROBOT_TYPE_FILTER IS NOT NULL THEN UPPER(:ROBOT_TYPE_FILTER)
                WHEN MOD(s.rn, 10) < 5 THEN 'AGV'
                WHEN MOD(s.rn, 10) < 8 THEN 'INSPECT'
                ELSE 'CLEAN'
            END,
            -- Robot type label
            CASE
                WHEN UPPER(:ROBOT_TYPE_FILTER) = 'AGV' THEN 'Transport AGV'
                WHEN UPPER(:ROBOT_TYPE_FILTER) = 'INSPECT' THEN 'Inspection Robot'
                WHEN UPPER(:ROBOT_TYPE_FILTER) = 'CLEAN' THEN 'Cleaning Robot'
                WHEN MOD(s.rn, 10) < 5 THEN 'Transport AGV'
                WHEN MOD(s.rn, 10) < 8 THEN 'Inspection Robot'
                ELSE 'Cleaning Robot'
            END,
            -- Status
            CASE MOD(s.rn, 20)
                WHEN 0 THEN 'charging' WHEN 5 THEN 'charging' WHEN 10 THEN 'charging'
                WHEN 15 THEN 'error' ELSE 'moving'
            END,
            'Zone ' || CHR(65 + MOD(s.rn, 6)),
            'Zone ' || CHR(65 + MOD(s.rn + 3, 6)),
            ROUND(15 + ABS(MOD(HASH(s.rn * 7 + :v_plant_id), 85)), 1),
            ROUND(0.3 + ABS(MOD(HASH(s.rn * 13 + :v_plant_id), 170)) / 100.0, 2),
            ROUND(0.3 + ABS(MOD(HASH(s.rn * 17 + :v_plant_id), 320)) / 100.0, 2),
            ROUND(18 + ABS(MOD(HASH(s.rn * 23 + :v_plant_id), 60)) / 10.0, 1),
            ROUND(50 + ABS(MOD(HASH(s.rn * 31 + :v_plant_id), 1150)), 1),
            ROUND(2 + ABS(MOD(HASH(s.rn * 37 + :v_plant_id), 280)) / 10.0, 2),
            ROUND(ABS(MOD(HASH(s.rn * 41 + :v_plant_id), 240)) / 10.0, 2),
            CASE WHEN (UPPER(:ROBOT_TYPE_FILTER) = 'AGV' OR (:ROBOT_TYPE_FILTER IS NULL AND MOD(s.rn, 10) < 5))
                 THEN 'B-' || :v_plant_code || '-' || LPAD(CAST(ABS(MOD(HASH(s.rn * 43), 999)) AS VARCHAR), 3, '0')
                 ELSE NULL END,
            CASE WHEN (UPPER(:ROBOT_TYPE_FILTER) = 'AGV' OR (:ROBOT_TYPE_FILTER IS NULL AND MOD(s.rn, 10) < 5))
                 THEN ROUND(30 + ABS(MOD(HASH(s.rn * 47 + :v_plant_id), 170)), 1)
                 ELSE NULL END
        FROM seq s;

    ELSE
        -- No building specified — resize entire plant's robot fleet
        -- Delete all robots at this plant
        DELETE FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.ROBOT_TELEMETRY
        WHERE PLANT_ID = :v_plant_id;

        -- Regenerate across all 6 building roles
        INSERT INTO FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.ROBOT_TELEMETRY
            (SNAPSHOT_TIME, PLANT_ID, PLANT_NAME, BUILDING_ROLE, BUILDING_ROLE_NAME, FLOOR_INDEX,
             ROBOT_ID, ROBOT_TYPE, ROBOT_TYPE_LABEL, STATUS, CURRENT_ZONE, DESTINATION_ZONE,
             BATTERY_PCT, SPEED_MS, VIBRATION_MM_S, ONBOARD_TEMP_C, DISTANCE_TRAVELLED_M,
             UPTIME_HRS, MAINT_DUE_HRS, CARGO_BATCH, CARGO_KG)
        WITH
        buildings AS (
            SELECT column1 AS idx, column2 AS role_id, column3 AS role_name
            FROM (VALUES
                (0, 'api',  'API Manufacturing'),
                (1, 'form', 'Formulation & Filling'),
                (2, 'cold', 'Cold Chain Warehouse'),
                (3, 'qc',   'QC Laboratory'),
                (4, 'util', 'Central Utilities'),
                (5, 'dist', 'Distribution & Dispatch')
            )
        ),
        seq AS (
            SELECT ROW_NUMBER() OVER (ORDER BY SEQ4()) - 1 AS rn
            FROM TABLE(GENERATOR(ROWCOUNT => :ROBOT_COUNT))
        )
        SELECT
            CURRENT_TIMESTAMP(),
            :v_plant_id,
            :PLANT_NAME,
            b.role_id,
            b.role_name,
            MOD(s.rn, 3),
            CASE
                WHEN MOD(s.rn, 10) < 5 THEN 'AGV'
                WHEN MOD(s.rn, 10) < 8 THEN 'INSPECT'
                ELSE 'CLEAN'
            END || '-' || :v_plant_code || '-' || LPAD(CAST(s.rn + 1 AS VARCHAR), 3, '0'),
            CASE
                WHEN MOD(s.rn, 10) < 5 THEN 'AGV'
                WHEN MOD(s.rn, 10) < 8 THEN 'INSPECT'
                ELSE 'CLEAN'
            END,
            CASE
                WHEN MOD(s.rn, 10) < 5 THEN 'Transport AGV'
                WHEN MOD(s.rn, 10) < 8 THEN 'Inspection Robot'
                ELSE 'Cleaning Robot'
            END,
            CASE MOD(s.rn, 20)
                WHEN 0 THEN 'charging' WHEN 5 THEN 'charging' WHEN 10 THEN 'charging'
                WHEN 15 THEN 'error' ELSE 'moving'
            END,
            'Zone ' || CHR(65 + MOD(s.rn, 6)),
            'Zone ' || CHR(65 + MOD(s.rn + 3, 6)),
            ROUND(15 + ABS(MOD(HASH(s.rn * 7 + :v_plant_id), 85)), 1),
            ROUND(0.3 + ABS(MOD(HASH(s.rn * 13 + :v_plant_id), 170)) / 100.0, 2),
            ROUND(0.3 + ABS(MOD(HASH(s.rn * 17 + :v_plant_id), 320)) / 100.0, 2),
            ROUND(18 + ABS(MOD(HASH(s.rn * 23 + :v_plant_id), 60)) / 10.0, 1),
            ROUND(50 + ABS(MOD(HASH(s.rn * 31 + :v_plant_id), 1150)), 1),
            ROUND(2 + ABS(MOD(HASH(s.rn * 37 + :v_plant_id), 280)) / 10.0, 2),
            ROUND(ABS(MOD(HASH(s.rn * 41 + :v_plant_id), 240)) / 10.0, 2),
            CASE WHEN MOD(s.rn, 10) < 5
                 THEN 'B-' || :v_plant_code || '-' || LPAD(CAST(ABS(MOD(HASH(s.rn * 43), 999)) AS VARCHAR), 3, '0')
                 ELSE NULL END,
            CASE WHEN MOD(s.rn, 10) < 5
                 THEN ROUND(30 + ABS(MOD(HASH(s.rn * 47 + :v_plant_id), 170)), 1)
                 ELSE NULL END
        FROM seq s
        JOIN buildings b ON b.idx = MOD(s.rn, 6);
    END IF;

    END IF; -- END IF ROBOT_COUNT IS NOT NULL

    -- ─── Apply Robot Type Label Renames ─────────────────────────────────────
    -- ROBOT_TYPE_LABELS: {"AGV": "Delivery Drone", "INSPECT": "Quality Scanner", "CLEAN": "Sanitization Bot"}
    IF (:ROBOT_TYPE_LABELS IS NOT NULL) THEN
        -- Update ROBOT_TYPE_LABEL for each key in the object
        UPDATE FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.ROBOT_TELEMETRY t
        SET ROBOT_TYPE_LABEL = lbl.value::VARCHAR
        FROM (
            SELECT key AS rtype, value FROM TABLE(FLATTEN(INPUT => PARSE_JSON(:ROBOT_TYPE_LABELS)))
        ) lbl
        WHERE t.PLANT_ID = :v_plant_id
          AND UPPER(t.ROBOT_TYPE) = UPPER(lbl.rtype)
          AND (:BUILDING_ROLE IS NULL OR UPPER(t.BUILDING_ROLE) = UPPER(:BUILDING_ROLE));

        v_updated_labels := (
            SELECT COUNT(*) FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.ROBOT_TELEMETRY
            WHERE PLANT_ID = :v_plant_id
              AND (:BUILDING_ROLE IS NULL OR UPPER(BUILDING_ROLE) = UPPER(:BUILDING_ROLE))
              AND ROBOT_TYPE_LABEL IN (SELECT value::VARCHAR FROM TABLE(FLATTEN(INPUT => PARSE_JSON(:ROBOT_TYPE_LABELS))))
        );
    END IF;

    -- ─── Apply Status/Activity Descriptions ─────────────────────────────────
    -- STATUS_DESCRIPTIONS: {"moving": "Transporting batch ONC-042 to QC lab", "charging": "Fast-charging at Bay 3"}
    -- Or set ALL robots to same status: {"all": "Evacuating — fire drill in progress"}
    IF (:STATUS_DESCRIPTIONS IS NOT NULL) THEN
        -- Check for "all" key — applies one status to every robot in scope
        IF (PARSE_JSON(:STATUS_DESCRIPTIONS):all IS NOT NULL) THEN
            UPDATE FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.ROBOT_TELEMETRY
            SET STATUS = PARSE_JSON(:STATUS_DESCRIPTIONS):all::VARCHAR
            WHERE PLANT_ID = :v_plant_id
              AND (:BUILDING_ROLE IS NULL OR UPPER(BUILDING_ROLE) = UPPER(:BUILDING_ROLE))
              AND (:ROBOT_TYPE_FILTER IS NULL OR UPPER(ROBOT_TYPE) = UPPER(:ROBOT_TYPE_FILTER));
        ELSE
            -- Map each status key to matching robots
            UPDATE FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.ROBOT_TELEMETRY t
            SET STATUS = sd.value::VARCHAR
            FROM (
                SELECT key AS old_status, value FROM TABLE(FLATTEN(INPUT => PARSE_JSON(:STATUS_DESCRIPTIONS)))
            ) sd
            WHERE t.PLANT_ID = :v_plant_id
              AND UPPER(t.STATUS) = UPPER(sd.old_status)
              AND (:BUILDING_ROLE IS NULL OR UPPER(t.BUILDING_ROLE) = UPPER(:BUILDING_ROLE))
              AND (:ROBOT_TYPE_FILTER IS NULL OR UPPER(t.ROBOT_TYPE) = UPPER(:ROBOT_TYPE_FILTER));
        END IF;

        v_updated_status := (
            SELECT COUNT(*) FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.ROBOT_TELEMETRY
            WHERE PLANT_ID = :v_plant_id
              AND (:BUILDING_ROLE IS NULL OR UPPER(BUILDING_ROLE) = UPPER(:BUILDING_ROLE))
              AND (:ROBOT_TYPE_FILTER IS NULL OR UPPER(ROBOT_TYPE) = UPPER(:ROBOT_TYPE_FILTER))
              AND STATUS IN (SELECT value::VARCHAR FROM TABLE(FLATTEN(INPUT => PARSE_JSON(:STATUS_DESCRIPTIONS))))
        );
    END IF;

    -- Count new total
    SELECT COUNT(*) INTO v_new_count
    FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.ROBOT_TELEMETRY
    WHERE PLANT_ID = :v_plant_id;

    RETURN OBJECT_CONSTRUCT(
        'status', 'SUCCESS',
        'plant_name', PLANT_NAME,
        'plant_id', v_plant_id,
        'scope', CASE
            WHEN :BUILDING_ROLE IS NOT NULL AND :ROBOT_TYPE_FILTER IS NOT NULL
                THEN :BUILDING_ROLE || ' (' || :ROBOT_TYPE_FILTER || ' only)'
            WHEN :BUILDING_ROLE IS NOT NULL THEN :BUILDING_ROLE
            ELSE 'entire plant'
        END,
        'robots_before', v_old_count,
        'robots_requested', ROBOT_COUNT,
        'robots_after', v_new_count,
        'labels_updated', v_updated_labels,
        'statuses_updated', v_updated_status,
        'building_role_targeted', BUILDING_ROLE,
        'robot_type_filter', ROBOT_TYPE_FILTER
    )::VARCHAR;
END;
$$;
