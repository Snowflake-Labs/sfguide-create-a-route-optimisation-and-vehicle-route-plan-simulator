-- =============================================================================
-- 10_pharma_agent_tools.sql
-- Pharma agent tools: TOOL_PLANT_IMPACT + TOOL_CREATE_PLANT
-- Run AFTER: 09_weather_tool.sql
-- =============================================================================

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-add-pharma-supply-chain","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- TOOL_PLANT_IMPACT: Full plant operational assessment
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_PLANT_IMPACT(PLANT_NAME_INPUT VARCHAR)
RETURNS VARIANT LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-add-pharma-supply-chain","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS $$
DECLARE
    v_plant_id NUMBER; v_plant_name VARCHAR;
    v_batches VARIANT; v_inventory VARIANT; v_shipments VARIANT; v_robots VARIANT;
BEGIN
    SELECT p.PLANT_ID, p.PLANT_NAME INTO v_plant_id, v_plant_name
    FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANTS p
    WHERE UPPER(p.PLANT_NAME) LIKE '%' || UPPER(:PLANT_NAME_INPUT) || '%'
       OR UPPER(CITY) = UPPER(:PLANT_NAME_INPUT) OR PLANT_CODE = UPPER(:PLANT_NAME_INPUT) LIMIT 1;
    IF (v_plant_id IS NULL) THEN RETURN OBJECT_CONSTRUCT('error', 'Plant not found: ' || PLANT_NAME_INPUT, 'status', 'FAILED'); END IF;
    SELECT ARRAY_AGG(OBJECT_CONSTRUCT('batch_id',BATCH_ID,'batch_number',BATCH_NUMBER,'product_id',PRODUCT_ID,'status',STATUS,'yield_pct',YIELD_PCT,'deviation_count',DEVIATION_COUNT,'deviation_severity',DEVIATION_SEVERITY,'qc_result',QC_RESULT,'start',PLANNED_START::VARCHAR,'cost_usd',COST_USD)) INTO v_batches FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PRODUCTION_BATCHES WHERE PLANT_ID=:v_plant_id;
    SELECT ARRAY_AGG(OBJECT_CONSTRUCT('inventory_id',INVENTORY_ID,'type',MATERIAL_TYPE,'stock_kg',STOCK_KG,'days_coverage',DAYS_OF_COVERAGE,'stock_status',STOCK_STATUS,'temp_excursion',TEMP_EXCURSION_FLAG)) INTO v_inventory FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.MATERIAL_INVENTORY WHERE PLANT_ID=:v_plant_id;
    SELECT ARRAY_AGG(OBJECT_CONSTRUCT('shipment_id',SHIPMENT_ID,'status',STATUS,'delay_days',DELAY_DAYS,'temp_excursion',TEMP_EXCURSION,'material_type',MATERIAL_TYPE,'value_usd',TOTAL_VALUE_USD)) INTO v_shipments FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.SHIPMENTS WHERE PLANT_ID=:v_plant_id;
    SELECT ARRAY_AGG(OBJECT_CONSTRUCT('robot_id',ROBOT_ID,'type',ROBOT_TYPE_LABEL,'status',STATUS,'building',BUILDING_ROLE_NAME,'zone',CURRENT_ZONE,'battery_pct',BATTERY_PCT,'maint_due_hrs',MAINT_DUE_HRS,'cargo_batch',CARGO_BATCH,'cargo_kg',CARGO_KG)) INTO v_robots FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.ROBOT_TELEMETRY WHERE PLANT_ID=:v_plant_id;
    RETURN OBJECT_CONSTRUCT('status','SUCCESS','plant_id',v_plant_id,'plant_name',v_plant_name,
        'batches',COALESCE(v_batches,ARRAY_CONSTRUCT()),'material_inventory',COALESCE(v_inventory,ARRAY_CONSTRUCT()),
        'inbound_shipments',COALESCE(v_shipments,ARRAY_CONSTRUCT()),'robots',COALESCE(v_robots,ARRAY_CONSTRUCT()),
        'summary',OBJECT_CONSTRUCT('total_batches',ARRAY_SIZE(COALESCE(v_batches,ARRAY_CONSTRUCT())),
            'critical_batches',(SELECT COUNT(*) FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PRODUCTION_BATCHES WHERE PLANT_ID=:v_plant_id AND STATUS IN ('ON_HOLD','REJECTED')),
            'critical_materials',(SELECT COUNT(*) FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.MATERIAL_INVENTORY WHERE PLANT_ID=:v_plant_id AND STOCK_STATUS='CRITICAL'),
            'delayed_shipments',(SELECT COUNT(*) FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.SHIPMENTS WHERE PLANT_ID=:v_plant_id AND STATUS IN ('DELAYED','CUSTOMS')),
            'robots_needing_maintenance',(SELECT COUNT(*) FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.ROBOT_TELEMETRY WHERE PLANT_ID=:v_plant_id AND MAINT_DUE_HRS<4)));
EXCEPTION WHEN OTHER THEN RETURN OBJECT_CONSTRUCT('error','TOOL_PLANT_IMPACT failed: '||SQLERRM,'status','FAILED');
END; $$;

-- TOOL_CREATE_PLANT: Create new plant from Overture Maps real buildings
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_CREATE_PLANT(
    PLANT_NAME VARCHAR, CITY VARCHAR, COUNTRY VARCHAR, LATITUDE FLOAT, LONGITUDE FLOAT,
    SPECIALISATION VARCHAR DEFAULT 'ORAL_SOLIDS', CAPACITY_BATCHES_MONTH NUMBER DEFAULT 200, SEARCH_RADIUS_M NUMBER DEFAULT 800
)
RETURNS VARIANT LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-add-plant-map","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS $$
DECLARE
    v_plant_id NUMBER; v_plant_code VARCHAR; v_buildings_found NUMBER; v_campus_count NUMBER; v_region VARCHAR;
BEGIN
    SELECT COALESCE(MAX(p.PLANT_ID),0)+1 INTO v_plant_id FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANTS p;
    v_plant_code := UPPER(SUBSTR(:CITY, 1, 3));
    v_region := CASE WHEN :COUNTRY IN ('United States','Canada','Brazil','Mexico') THEN 'AMERICAS'
                     WHEN :COUNTRY IN ('Singapore','China','Japan','India','Australia') THEN 'APAC'
                     ELSE 'EUROPE' END;
    INSERT INTO FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANTS (PLANT_ID,PLANT_CODE,PLANT_NAME,CITY,COUNTRY,REGION,SPECIALISATION,CAPACITY_BATCHES_MONTH,GMP_CERTIFIED,ISO_CERTIFIED,LATITUDE,LONGITUDE)
    VALUES (:v_plant_id,:v_plant_code,:PLANT_NAME,:CITY,:COUNTRY,:v_region,:SPECIALISATION,:CAPACITY_BATCHES_MONTH,TRUE,TRUE,:LATITUDE,:LONGITUDE);
    INSERT INTO FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANT_BUILDING_FOOTPRINTS (PLANT_ID,PLANT_NAME,PLANT_CODE,OVERTURE_ID,GEOJSON,BUILDING_NAME,CLASS,HEIGHT,FOOTPRINT_TYPE)
    SELECT :v_plant_id,:PLANT_NAME,:v_plant_code,b.ID,ST_ASGEOJSON(b.GEOMETRY),TRY_PARSE_JSON(b.NAMES):primary::STRING,b.CLASS,b.HEIGHT,'BUILDING'
    FROM OVERTURE_MAPS__BUILDINGS.CARTO.BUILDING b
    WHERE ST_DWITHIN(b.GEOMETRY,ST_MAKEPOINT(:LONGITUDE,:LATITUDE),:SEARCH_RADIUS_M) AND b.GEOMETRY IS NOT NULL AND ST_AREA(b.GEOMETRY)>=200;
    SELECT COUNT(*) INTO v_buildings_found FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANT_BUILDING_FOOTPRINTS WHERE PLANT_ID=:v_plant_id;
    SELECT COUNT(*) INTO v_campus_count FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANT_BUILDING_FOOTPRINTS WHERE PLANT_ID=:v_plant_id AND ST_AREA(TO_GEOGRAPHY(GEOJSON))>=500;
    INSERT INTO FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.ROBOT_TELEMETRY (PLANT_ID,PLANT_NAME,BUILDING_ROLE,BUILDING_ROLE_NAME,FLOOR_INDEX,ROBOT_ID,ROBOT_TYPE,ROBOT_TYPE_LABEL,STATUS,CURRENT_ZONE,DESTINATION_ZONE,BATTERY_PCT,SPEED_MS,VIBRATION_MM_S,ONBOARD_TEMP_C,DISTANCE_TRAVELLED_M,UPTIME_HRS,MAINT_DUE_HRS,CARGO_BATCH,CARGO_KG)
    WITH buildings AS (SELECT column1 AS role_id,column2 AS role_name FROM (VALUES('api','API Manufacturing'),('form','Formulation & Filling'),('cold','Cold Chain Warehouse'),('qc','QC Laboratory'),('util','Central Utilities'),('dist','Distribution & Dispatch'))),
    robots AS (SELECT column1 AS rtype,column2 AS rletter,column3 AS rlabel FROM (VALUES('AGV','A','Transport AGV'),('AGV','B','Transport AGV'),('INSPECT','C','Inspection Robot'),('CLEAN','D','Cleaning Robot')))
    SELECT :v_plant_id,:PLANT_NAME,b.role_id,b.role_name,0,r.rtype||'-'||r.rletter,r.rtype,r.rlabel,'moving','Zone A','Zone B',
      ROUND(40+RANDOM()/9223372036854775807.0*55,1),ROUND(0.5+RANDOM()/9223372036854775807.0*1.5,2),ROUND(0.5+RANDOM()/9223372036854775807.0*2.0,2),
      ROUND(20+RANDOM()/9223372036854775807.0*3.0,1),ROUND(200+RANDOM()/9223372036854775807.0*800,1),ROUND(10+RANDOM()/9223372036854775807.0*20,2),
      ROUND(RANDOM()/9223372036854775807.0*24,2),
      CASE r.rtype WHEN 'AGV' THEN 'B-NEW-'||LPAD(CAST(ROUND(RANDOM()/9223372036854775807.0*999) AS VARCHAR),3,'0') ELSE NULL END,
      CASE r.rtype WHEN 'AGV' THEN ROUND(50+RANDOM()/9223372036854775807.0*150,1) ELSE NULL END
    FROM buildings b CROSS JOIN robots r;
    RETURN OBJECT_CONSTRUCT('status','SUCCESS','plant_id',v_plant_id,'plant_name',PLANT_NAME,'plant_code',v_plant_code,
        'location',OBJECT_CONSTRUCT('city',CITY,'country',COUNTRY,'lat',LATITUDE,'lon',LONGITUDE),
        'specialisation',SPECIALISATION,'buildings_found',v_buildings_found,'campus_buildings',LEAST(v_campus_count,6),'robots_deployed',24,
        'message','Plant created with '||v_buildings_found::VARCHAR||' real building footprints from Overture Maps. '||LEAST(v_campus_count,6)::VARCHAR||' qualify as campus buildings (>=500 sqm). 24 robots deployed. Open Plant Intelligence to view.');
EXCEPTION WHEN OTHER THEN RETURN OBJECT_CONSTRUCT('error','TOOL_CREATE_PLANT failed: '||SQLERRM,'status','FAILED');
END; $$;

-- TOOL_REMOVE_PLANT: Decommission a plant and remove all associated data
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_REMOVE_PLANT(PLANT_NAME VARCHAR)
RETURNS VARIANT LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-add-plant-map","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS $$
DECLARE
    v_plant_id NUMBER; v_plant_name VARCHAR;
    v_buildings_removed NUMBER; v_robots_removed NUMBER;
    v_batches_removed NUMBER; v_inventory_removed NUMBER; v_shipments_removed NUMBER;
BEGIN
    SELECT PLANT_ID, PLANT_NAME INTO v_plant_id, v_plant_name
    FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANTS
    WHERE UPPER(p.PLANT_NAME) LIKE '%' || UPPER(:PLANT_NAME) || '%'
       OR UPPER(p.CITY) = UPPER(:PLANT_NAME) OR p.PLANT_CODE = UPPER(:PLANT_NAME) LIMIT 1;
    IF (v_plant_id IS NULL) THEN RETURN OBJECT_CONSTRUCT('error','Plant not found: '||:PLANT_NAME,'status','FAILED'); END IF;
    SELECT COUNT(*) INTO v_buildings_removed FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANT_BUILDING_FOOTPRINTS WHERE PLANT_ID=:v_plant_id;
    SELECT COUNT(*) INTO v_robots_removed FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.ROBOT_TELEMETRY WHERE PLANT_ID=:v_plant_id;
    SELECT COUNT(*) INTO v_batches_removed FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PRODUCTION_BATCHES WHERE PLANT_ID=:v_plant_id;
    SELECT COUNT(*) INTO v_inventory_removed FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.MATERIAL_INVENTORY WHERE PLANT_ID=:v_plant_id;
    SELECT COUNT(*) INTO v_shipments_removed FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.SHIPMENTS WHERE PLANT_ID=:v_plant_id;
    DELETE FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.ROBOT_TELEMETRY WHERE PLANT_ID=:v_plant_id;
    DELETE FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANT_BUILDING_FOOTPRINTS WHERE PLANT_ID=:v_plant_id;
    DELETE FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PRODUCTION_BATCHES WHERE PLANT_ID=:v_plant_id;
    DELETE FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.MATERIAL_INVENTORY WHERE PLANT_ID=:v_plant_id;
    DELETE FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.SHIPMENTS WHERE PLANT_ID=:v_plant_id;
    DELETE FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANTS WHERE PLANT_ID=:v_plant_id;
    RETURN OBJECT_CONSTRUCT('status','SUCCESS','plant_removed',v_plant_name,'plant_id',v_plant_id,
        'removed',OBJECT_CONSTRUCT('buildings',v_buildings_removed,'robots',v_robots_removed,'batches',v_batches_removed,'inventory',v_inventory_removed,'shipments',v_shipments_removed),
        'message','Plant "'||v_plant_name||'" and all associated data removed. It will no longer appear in Plant Intelligence.');
EXCEPTION WHEN OTHER THEN RETURN OBJECT_CONSTRUCT('error','TOOL_REMOVE_PLANT failed: '||SQLERRM,'status','FAILED');
END; $$;
