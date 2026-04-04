/*
 * Region-Aware Provisioning Framework
 * Creates FLEET_INTELLIGENCE.CORE schema with registry tables and orchestration procedures.
 * 
 * Tables:
 *   REGION_REGISTRY       - Available regions with bbox/center metadata
 *   SKILL_DATA_REGISTRY   - Per-skill, per-region data loading status
 *
 * Procedures:
 *   PROVISION_REGION      - Master orchestrator dispatching S3 seed or synthetic generation
 *   LOAD_SEED_DATA        - Load pre-baked data from S3 for a given skill+region
 *   GENERATE_SKILL_DATA   - Generate synthetic data for a skill+region via ORS+Overture
 */

--------------------------------------------------------------------
-- 1. CORE SCHEMA
--------------------------------------------------------------------
CREATE DATABASE IF NOT EXISTS FLEET_INTELLIGENCE;
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.CORE;

--------------------------------------------------------------------
-- 2. REGION REGISTRY
--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.CORE.REGION_REGISTRY (
    REGION_NAME       VARCHAR    NOT NULL,
    DISPLAY_NAME      VARCHAR    NOT NULL,
    CENTER_LAT        FLOAT      NOT NULL,
    CENTER_LON        FLOAT      NOT NULL,
    BBOX_MIN_LAT      FLOAT,
    BBOX_MAX_LAT      FLOAT,
    BBOX_MIN_LON      FLOAT,
    BBOX_MAX_LON      FLOAT,
    ZOOM_LEVEL        INT        DEFAULT 11,
    ORS_REGION_KEY    VARCHAR,
    DATA_SOURCE       VARCHAR    NOT NULL,
    IS_DEFAULT        BOOLEAN    DEFAULT FALSE,
    PROVISIONED_AT    TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    PRIMARY KEY (REGION_NAME)
);

MERGE INTO FLEET_INTELLIGENCE.CORE.REGION_REGISTRY t
USING (SELECT 'SanFrancisco' AS REGION_NAME) s
ON t.REGION_NAME = s.REGION_NAME
WHEN NOT MATCHED THEN INSERT
    (REGION_NAME, DISPLAY_NAME, CENTER_LAT, CENTER_LON,
     BBOX_MIN_LAT, BBOX_MAX_LAT, BBOX_MIN_LON, BBOX_MAX_LON,
     ZOOM_LEVEL, ORS_REGION_KEY, DATA_SOURCE, IS_DEFAULT)
VALUES
    ('SanFrancisco', 'San Francisco', 37.7749, -122.4194,
     37.700, 37.820, -122.520, -122.350,
     11, 'SanFrancisco', 'S3_BASELINE', TRUE);

--------------------------------------------------------------------
-- 3. SKILL DATA REGISTRY
--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.CORE.SKILL_DATA_REGISTRY (
    REGION_NAME       VARCHAR    NOT NULL,
    SKILL_NAME        VARCHAR    NOT NULL,
    SCHEMA_NAME       VARCHAR    NOT NULL,
    STATUS            VARCHAR    NOT NULL DEFAULT 'NOT_STARTED',
    TABLE_COUNT       INT,
    ROW_COUNT         BIGINT,
    GENERATED_AT      TIMESTAMP_NTZ,
    GENERATION_METHOD VARCHAR,
    ERROR_MESSAGE     VARCHAR,
    PRIMARY KEY (REGION_NAME, SKILL_NAME)
);

--------------------------------------------------------------------
-- 4. SKILL CATALOG (static metadata about each skill)
--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.CORE.SKILL_CATALOG (
    SKILL_NAME        VARCHAR    NOT NULL PRIMARY KEY,
    SCHEMA_NAME       VARCHAR    NOT NULL,
    DISPLAY_NAME      VARCHAR    NOT NULL,
    REQUIRES_ORS      BOOLEAN    DEFAULT FALSE,
    REQUIRES_OVERTURE  BOOLEAN   DEFAULT FALSE,
    HAS_S3_SEED       BOOLEAN    DEFAULT FALSE,
    POST_SEED_DDL     BOOLEAN    DEFAULT FALSE,
    SORT_ORDER        INT        DEFAULT 100
);

MERGE INTO FLEET_INTELLIGENCE.CORE.SKILL_CATALOG t
USING (
    SELECT column1 AS SKILL_NAME, column2 AS SCHEMA_NAME, column3 AS DISPLAY_NAME,
           column4 AS REQUIRES_ORS, column5 AS REQUIRES_OVERTURE, column6 AS HAS_S3_SEED,
           column7 AS POST_SEED_DDL, column8 AS SORT_ORDER
    FROM VALUES
        ('fleet-intelligence-taxis',          'FLEET_INTELLIGENCE_TAXIS',          'Fleet Taxis',      TRUE,  TRUE,  TRUE, TRUE,  10),
        ('fleet-intelligence-food-delivery',  'FLEET_INTELLIGENCE_FOOD_DELIVERY',  'Food Delivery',    TRUE,  TRUE,  TRUE, FALSE, 20),
        ('retail-catchment',                  'RETAIL_CATCHMENT',                  'Retail Catchment', FALSE, TRUE,  TRUE, FALSE, 30),
        ('route-deviation',                   'ROUTE_DEVIATION',                   'Route Deviation',  TRUE,  FALSE, TRUE, FALSE, 40),
        ('route-optimization',                'ROUTE_OPTIMIZATION',                'Route Optimization', FALSE, TRUE, TRUE, FALSE, 50),
        ('dwell-analysis',                    'DWELL_ANALYSIS',                    'Dwell Analysis',   FALSE, FALSE, TRUE, TRUE,  60),
        ('travel-time-matrix',                'TRAVEL_TIME_MATRIX',                'Travel Time Matrix', TRUE, FALSE, TRUE, FALSE, 70),
        ('routing-agent',                     'ROUTING_AGENT',                     'Routing Agent',    FALSE, FALSE, FALSE, TRUE, 80)
) s ON t.SKILL_NAME = s.SKILL_NAME
WHEN NOT MATCHED THEN INSERT
    (SKILL_NAME, SCHEMA_NAME, DISPLAY_NAME, REQUIRES_ORS, REQUIRES_OVERTURE, HAS_S3_SEED, POST_SEED_DDL, SORT_ORDER)
VALUES
    (s.SKILL_NAME, s.SCHEMA_NAME, s.DISPLAY_NAME, s.REQUIRES_ORS, s.REQUIRES_OVERTURE, s.HAS_S3_SEED, s.POST_SEED_DDL, s.SORT_ORDER);

--------------------------------------------------------------------
-- 5. PROVISION_REGION ORCHESTRATOR
--------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.CORE.PROVISION_REGION(
    P_REGION VARCHAR,
    P_SKILLS ARRAY DEFAULT NULL
)
RETURNS VARIANT
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    v_skills ARRAY;
    v_skill VARCHAR;
    v_schema VARCHAR;
    v_data_source VARCHAR;
    v_result ARRAY DEFAULT ARRAY_CONSTRUCT();
    v_skill_status OBJECT;
    v_row_count BIGINT;
    v_table_count INT;
    v_has_seed BOOLEAN;
BEGIN
    IF (P_REGION = 'SanFrancisco') THEN
        v_data_source := 'S3_SEED';
    ELSE
        v_data_source := 'SYNTHETIC';
    END IF;

    IF (P_SKILLS IS NULL) THEN
        v_skills := ARRAY_CONSTRUCT(
            'fleet-intelligence-taxis',
            'fleet-intelligence-food-delivery',
            'retail-catchment',
            'route-deviation',
            'route-optimization',
            'dwell-analysis',
            'travel-time-matrix',
            'routing-agent'
        );
    ELSE
        v_skills := P_SKILLS;
    END IF;

    MERGE INTO FLEET_INTELLIGENCE.CORE.REGION_REGISTRY t
    USING (SELECT :P_REGION AS RN) s ON t.REGION_NAME = s.RN
    WHEN NOT MATCHED THEN INSERT
        (REGION_NAME, DISPLAY_NAME, CENTER_LAT, CENTER_LON, DATA_SOURCE, IS_DEFAULT)
    VALUES
        (:P_REGION, :P_REGION, 0, 0, :v_data_source, FALSE);

    FOR i IN 0 TO ARRAY_SIZE(v_skills) - 1 DO
        v_skill := v_skills[i]::VARCHAR;

        SELECT SCHEMA_NAME, HAS_S3_SEED
        INTO v_schema, v_has_seed
        FROM FLEET_INTELLIGENCE.CORE.SKILL_CATALOG
        WHERE SKILL_NAME = :v_skill;

        MERGE INTO FLEET_INTELLIGENCE.CORE.SKILL_DATA_REGISTRY t
        USING (SELECT :P_REGION AS RN, :v_skill AS SN) s
        ON t.REGION_NAME = s.RN AND t.SKILL_NAME = s.SN
        WHEN MATCHED THEN UPDATE SET STATUS = 'GENERATING', GENERATED_AT = CURRENT_TIMESTAMP()
        WHEN NOT MATCHED THEN INSERT
            (REGION_NAME, SKILL_NAME, SCHEMA_NAME, STATUS, GENERATION_METHOD, GENERATED_AT)
        VALUES
            (:P_REGION, :v_skill, :v_schema, 'GENERATING', :v_data_source, CURRENT_TIMESTAMP());

        BEGIN
            IF (v_data_source = 'S3_SEED' AND v_has_seed) THEN
                CALL FLEET_INTELLIGENCE.CORE.LOAD_SEED_DATA(:v_skill, :P_REGION);
            ELSEIF (v_data_source = 'SYNTHETIC') THEN
                CALL FLEET_INTELLIGENCE.CORE.GENERATE_SKILL_DATA(:v_skill, :P_REGION);
            END IF;

            UPDATE FLEET_INTELLIGENCE.CORE.SKILL_DATA_REGISTRY
            SET STATUS = 'LOADED', ERROR_MESSAGE = NULL
            WHERE REGION_NAME = :P_REGION AND SKILL_NAME = :v_skill;
        EXCEPTION
            WHEN OTHER THEN
                UPDATE FLEET_INTELLIGENCE.CORE.SKILL_DATA_REGISTRY
                SET STATUS = 'FAILED', ERROR_MESSAGE = SQLERRM
                WHERE REGION_NAME = :P_REGION AND SKILL_NAME = :v_skill;
        END;

        v_result := ARRAY_APPEND(v_result, OBJECT_CONSTRUCT(
            'skill', v_skill,
            'schema', v_schema,
            'method', v_data_source
        ));
    END FOR;

    RETURN OBJECT_CONSTRUCT(
        'region', P_REGION,
        'data_source', v_data_source,
        'skills', v_result
    );
END;
$$;

--------------------------------------------------------------------
-- 6. LOAD_SEED_DATA (S3 baseline loader stub)
--------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.CORE.LOAD_SEED_DATA(
    P_SKILL VARCHAR,
    P_REGION VARCHAR
)
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    v_schema VARCHAR;
    v_stage_url VARCHAR;
BEGIN
    SELECT SCHEMA_NAME INTO v_schema
    FROM FLEET_INTELLIGENCE.CORE.SKILL_CATALOG
    WHERE SKILL_NAME = :P_SKILL;

    EXECUTE IMMEDIATE 'CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.' || v_schema;

    v_stage_url := 's3://fleet-intelligence/' || P_REGION || '/' || P_SKILL || '/';

    EXECUTE IMMEDIATE '
        CREATE STAGE IF NOT EXISTS FLEET_INTELLIGENCE.' || v_schema || '.SEED_STAGE
        URL = ''' || v_stage_url || '''
        FILE_FORMAT = (TYPE = PARQUET)
    ';

    RETURN 'Seed stage created for ' || P_SKILL || ' region ' || P_REGION || ' at ' || v_stage_url;
END;
$$;

--------------------------------------------------------------------
-- 7. GENERATE_SKILL_DATA (synthetic generation stub)
--------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.CORE.GENERATE_SKILL_DATA(
    P_SKILL VARCHAR,
    P_REGION VARCHAR
)
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
BEGIN
    RETURN 'Synthetic generation for ' || P_SKILL || ' in region ' || P_REGION || ' -- not yet implemented. Use Cortex Code skills to generate data interactively.';
END;
$$;

--------------------------------------------------------------------
-- 8. GET_ACTIVE_REGION helper
--------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.CORE.GET_ACTIVE_REGION()
RETURNS VARIANT
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    v_result VARIANT;
BEGIN
    SELECT OBJECT_CONSTRUCT(
        'REGION_NAME', REGION_NAME,
        'DISPLAY_NAME', DISPLAY_NAME,
        'CENTER_LAT', CENTER_LAT,
        'CENTER_LON', CENTER_LON,
        'BBOX_MIN_LAT', BBOX_MIN_LAT,
        'BBOX_MAX_LAT', BBOX_MAX_LAT,
        'BBOX_MIN_LON', BBOX_MIN_LON,
        'BBOX_MAX_LON', BBOX_MAX_LON,
        'ZOOM_LEVEL', ZOOM_LEVEL,
        'ORS_REGION_KEY', ORS_REGION_KEY,
        'DATA_SOURCE', DATA_SOURCE
    ) INTO v_result
    FROM FLEET_INTELLIGENCE.CORE.REGION_REGISTRY
    WHERE IS_DEFAULT = TRUE
    LIMIT 1;

    RETURN v_result;
END;
$$;

--------------------------------------------------------------------
-- 9. SET_ACTIVE_REGION
--------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.CORE.SET_ACTIVE_REGION(
    P_REGION VARCHAR
)
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
BEGIN
    UPDATE FLEET_INTELLIGENCE.CORE.REGION_REGISTRY SET IS_DEFAULT = FALSE WHERE IS_DEFAULT = TRUE;
    UPDATE FLEET_INTELLIGENCE.CORE.REGION_REGISTRY SET IS_DEFAULT = TRUE WHERE REGION_NAME = :P_REGION;
    RETURN 'Active region set to ' || P_REGION;
END;
$$;

--------------------------------------------------------------------
-- 10. GET_REGION_STATUS (skill readiness for a region)
--------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.CORE.GET_REGION_STATUS(
    P_REGION VARCHAR DEFAULT NULL
)
RETURNS VARIANT
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    v_region VARCHAR;
    v_result VARIANT;
BEGIN
    IF (P_REGION IS NULL) THEN
        SELECT REGION_NAME INTO v_region
        FROM FLEET_INTELLIGENCE.CORE.REGION_REGISTRY
        WHERE IS_DEFAULT = TRUE LIMIT 1;
    ELSE
        v_region := P_REGION;
    END IF;

    SELECT ARRAY_AGG(OBJECT_CONSTRUCT(
        'skill_name', c.SKILL_NAME,
        'display_name', c.DISPLAY_NAME,
        'schema_name', c.SCHEMA_NAME,
        'status', COALESCE(s.STATUS, 'NOT_STARTED'),
        'generated_at', s.GENERATED_AT,
        'generation_method', s.GENERATION_METHOD,
        'error_message', s.ERROR_MESSAGE
    )) INTO v_result
    FROM FLEET_INTELLIGENCE.CORE.SKILL_CATALOG c
    LEFT JOIN FLEET_INTELLIGENCE.CORE.SKILL_DATA_REGISTRY s
        ON c.SKILL_NAME = s.SKILL_NAME AND s.REGION_NAME = :v_region
    ORDER BY c.SORT_ORDER;

    RETURN OBJECT_CONSTRUCT(
        'region', v_region,
        'skills', v_result
    );
END;
$$;
