-- =============================================================================
-- sap-fleet-connector : sap_source_views.sql  (Step 5)
-- =============================================================================
-- L1 current-row dedup views over the CDC-landed SAP tables, then L4 source
-- views shaped to the column contract that FLEET_APP.UNIFIED_FLEET.F_VW_*_SCOPED
-- pass through. Defaults below are the serial_direct / native_serial / Qlik block;
-- other accounts override the L1 dedup pattern (cdc-dedup.md) and the column
-- expressions (sap-entity-mapping.md) via sap-mapping.yaml. Placeholders {{...}}.
-- =============================================================================
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-sap-fleet-connector","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","module":"source-views"}}';

-- ===== L1 current-row views (Qlik Replicate pattern; swap per cdc.tool) ======
CREATE OR REPLACE VIEW SAP_SOURCE.FLEET.SRC_EQUI_CURRENT
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-sap-fleet-connector","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS SELECT EQUNR, SERNR, MATNR, EQTYP, EQART, EQKTX, TPLNR, S_FLEET, WERK
   FROM (SELECT t.*, ROW_NUMBER() OVER (PARTITION BY EQUNR ORDER BY HEADER__TIMESTAMP DESC) rn
         FROM {{SAP_SCHEMA}}.EQUI t WHERE MANDT = '{{CLIENT}}')
   WHERE rn = 1 AND HEADER__CHANGE_OPER <> 'D';

CREATE OR REPLACE VIEW SAP_SOURCE.FLEET.SRC_IFLOT_CURRENT
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-sap-fleet-connector","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS SELECT TPLNR, PLTXT, FLTYP, IWERK
   FROM (SELECT t.*, ROW_NUMBER() OVER (PARTITION BY TPLNR ORDER BY HEADER__TIMESTAMP DESC) rn
         FROM {{SAP_SCHEMA}}.IFLOT t WHERE MANDT = '{{CLIENT}}')
   WHERE rn = 1 AND HEADER__CHANGE_OPER <> 'D';

CREATE OR REPLACE VIEW SAP_SOURCE.FLEET.SRC_LIKP_CURRENT
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-sap-fleet-connector","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS SELECT VBELN, LFDAT, KUNNR, ROUTE, VSTEL, WBSTK, WADAT_IST
   FROM (SELECT t.*, ROW_NUMBER() OVER (PARTITION BY VBELN ORDER BY HEADER__TIMESTAMP DESC) rn
         FROM {{SAP_SCHEMA}}.LIKP t WHERE MANDT = '{{CLIENT}}')
   WHERE rn = 1 AND HEADER__CHANGE_OPER <> 'D';

-- ===== L4 contract-shaped source views (match synthetic base-table columns) ==
-- dim_fleet shape (consumed via F_VW_DIM_FLEET_SCOPED). Sparse attrs NULL for EAM.
CREATE OR REPLACE VIEW SAP_SOURCE.FLEET.SRC_DIM_FLEET
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-sap-fleet-connector","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT e.EQUNR                         AS VEHICLE_ID,
       '{{REGION}}'                    AS REGION,
       COALESCE(e.EQTYP, 'asset')      AS VEHICLE_TYPE,
       CAST(NULL AS VARCHAR)           AS ORS_PROFILE,
       CAST(NULL AS VARCHAR)           AS SHIFT_TYPE,
       CAST(NULL AS NUMBER)            AS SHIFT_START_HOUR,
       CAST(NULL AS NUMBER)            AS SHIFT_END_HOUR,
       e.TPLNR                         AS HOME_LOCATION_ID,
       CAST(NULL AS VARCHAR)           AS DRIVER_PROFILE,
       e.EQART                         AS OPERATING_MODE,
       CAST(NULL AS FLOAT)             AS BASE_SPEED_KMH,
       CAST(NULL AS FLOAT)             AS BATTERY_RANGE_KM,
       'sap-live'                      AS JOB_ID,
       CAST(NULL AS NUMBER(6,2))       AS WEIGHT_TONS,
       CAST(NULL AS NUMBER(4,2))       AS HEIGHT_M,
       CAST(NULL AS NUMBER(4,2))       AS LENGTH_M,
       CAST(NULL AS NUMBER(4,2))       AS WIDTH_M,
       CAST(NULL AS NUMBER(4,2))       AS AXLELOAD_T,
       FALSE                           AS HAZMAT,
       e.MATNR                         AS VEHICLE_SUBTYPE
FROM SAP_SOURCE.FLEET.SRC_EQUI_CURRENT e;

-- dim_pois shape (consumed via F_VW_DIM_POIS_SCOPED). IFLOT functional locations.
CREATE OR REPLACE VIEW SAP_SOURCE.FLEET.SRC_DIM_POIS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-sap-fleet-connector","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT i.TPLNR                         AS LOCATION_ID,
       '{{REGION}}'                    AS REGION,
       i.PLTXT                         AS NAME,
       'functional_location'           AS LOCATION_TYPE,
       i.FLTYP                         AS CATEGORY,
       CAST(NULL AS FLOAT)             AS LAT,
       CAST(NULL AS FLOAT)             AS LNG,
       TO_GEOGRAPHY(NULL)              AS POINT_GEOM,
       'sap'                           AS SOURCE,
       'sap-live'                      AS JOB_ID
FROM SAP_SOURCE.FLEET.SRC_IFLOT_CURRENT i;

-- fact_vehicle_telemetry shape (consumed via F_VW_FACT_VEHICLE_TELEMETRY_SCOPED).
-- Telematics joined to crosswalk for ENTITY_ID. Materialize as Dynamic Table when
-- materialize_position=true (45B-135B rows); shown here as a view for clarity.
CREATE OR REPLACE VIEW SAP_SOURCE.FLEET.SRC_FACT_VEHICLE_TELEMETRY
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-sap-fleet-connector","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT g.{{TEL_PK_COL}}::VARCHAR        AS TELEMETRY_ID,
       '{{REGION}}'                     AS REGION,
       'asset'                          AS VEHICLE_TYPE,
       x.ASSET_ID                       AS VEHICLE_ID,
       CAST(NULL AS VARCHAR)            AS TRIP_ID,
       g.{{TEL_TS_COL}}::TIMESTAMP_NTZ  AS TS,
       g.{{TEL_LAT_COL}}::FLOAT         AS LATITUDE,
       g.{{TEL_LON_COL}}::FLOAT         AS LONGITUDE,
       ST_MAKEPOINT(g.{{TEL_LON_COL}}::FLOAT, g.{{TEL_LAT_COL}}::FLOAT) AS POINT_GEOM,
       g.{{TEL_SPEED_COL}}::FLOAT       AS SPEED_KMH,
       g.{{TEL_HEADING_COL}}::FLOAT     AS HEADING_DEG,
       CAST(NULL AS FLOAT)              AS POSTED_SPEED_KMH,
       CASE WHEN g.{{TEL_SPEED_COL}}::FLOAT < 1 THEN 'IDLE' ELSE 'MOVING' END AS STATUS,
       FALSE                            AS IS_SPEEDING,
       FALSE                            AS IS_HOS_VIOLATION,
       FALSE                            AS IS_DETOUR,
       CAST(NULL AS FLOAT)              AS GPS_ACCURACY_M,
       CAST(NULL AS VARCHAR)            AS LOCATION_ID,
       CAST(NULL AS VARCHAR)            AS LOCATION_TYPE,
       CAST(NULL AS VARCHAR)            AS ORS_PROFILE,
       CAST(NULL AS FLOAT)              AS BATTERY_PCT,
       CAST(NULL AS FLOAT)              AS ODOMETER_KM,
       CAST(NULL AS NUMBER)            AS POINT_INDEX,
       'sap-live'                       AS JOB_ID
FROM {{TELEMATICS_TABLE}} g
JOIN SAP_SOURCE.FLEET.ASSET_CROSSWALK x
  ON x.DEVICE_ID = SAP_SOURCE.FLEET.NORMALIZE_SERIAL(g.{{DEVICE_COL}});

-- fact_trips shape (consumed via F_VW_FACT_TRIPS_SCOPED). Delivery header is the
-- journey skeleton; vehicle resolved via shipment/crosswalk; actual path/distance
-- derived from telemetry in a later phase (left NULL here). See mapping spec sec 4.
CREATE OR REPLACE VIEW SAP_SOURCE.FLEET.SRC_FACT_TRIPS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-sap-fleet-connector","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT h.VBELN                       AS TRIP_ID,
       CAST(NULL AS VARCHAR)         AS VEHICLE_ID,        -- via shipment (VTTK/VTTP) or crosswalk; NULL pre-dispatch
       CAST(NULL AS VARCHAR)         AS DRIVER_ID,
       'asset'                       AS VEHICLE_TYPE,
       '{{REGION}}'                  AS REGION,
       h.VSTEL                       AS ORIGIN_POI_ID,      -- shipping point -> site
       h.KUNNR                       AS DESTINATION_POI_ID, -- ship-to -> site
       CAST(NULL AS FLOAT)           AS ORIGIN_LAT,
       CAST(NULL AS FLOAT)           AS ORIGIN_LON,
       TO_GEOGRAPHY(NULL)            AS ORIGIN,
       CAST(NULL AS FLOAT)           AS DESTINATION_LAT,
       CAST(NULL AS FLOAT)           AS DESTINATION_LON,
       TO_GEOGRAPHY(NULL)            AS DESTINATION,
       TO_GEOGRAPHY(NULL)            AS ROUTE_GEOG,         -- actual path: ST_MAKELINE over telemetry (later phase)
       CAST(NULL AS FLOAT)           AS DISTANCE_KM,        -- actual distance (telemetry-derived)
       CAST(NULL AS FLOAT)           AS DURATION_MINUTES,
       TO_GEOGRAPHY(NULL)            AS PLANNED_ROUTE_GEOG, -- route master (TVRO) geometry if available
       CAST(NULL AS FLOAT)           AS PLANNED_DISTANCE_KM,
       FALSE                         AS IS_DETOUR,
       CAST(NULL AS FLOAT)           AS DETOUR_DISTANCE_KM,
       h.LFDAT::TIMESTAMP_NTZ        AS TRIP_START,         -- planned GI date; actual = WADAT_IST
       h.WADAT_IST::TIMESTAMP_NTZ    AS TRIP_END,
       h.WBSTK                       AS STATUS,             -- goods-movement status
       CAST(NULL AS VARCHAR)         AS ORS_PROFILE,
       'LADEN'                       AS TRIP_KIND,          -- 'EMPTY' for return legs (no goods)
       'sap-live'                    AS JOB_ID
FROM SAP_SOURCE.FLEET.SRC_LIKP_CURRENT h;

-- dim_trip_schedule shape (consumed via F_VW_DIM_TRIP_SCHEDULE_SCOPED). Planned legs
-- from the delivery header (+ route master for distance/lead time when present).
CREATE OR REPLACE VIEW SAP_SOURCE.FLEET.SRC_DIM_TRIP_SCHEDULE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-sap-fleet-connector","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
SELECT h.VBELN                       AS SCHEDULE_ID,
       CAST(NULL AS VARCHAR)         AS VEHICLE_ID,
       CAST(NULL AS VARCHAR)         AS DRIVER_ID,
       'asset'                       AS VEHICLE_TYPE,
       '{{REGION}}'                  AS REGION,
       h.LFDAT::DATE                 AS TRIP_DATE,
       CAST(NULL AS NUMBER)          AS TRIP_SEQ,
       h.VSTEL                       AS ORIGIN_POI_ID,
       h.KUNNR                       AS DESTINATION_POI_ID,
       h.LFDAT::TIMESTAMP_NTZ        AS PLANNED_START,
       CAST(NULL AS TIMESTAMP_NTZ)   AS PLANNED_END,        -- planned arrival/GI from route lead time
       CAST(NULL AS VARCHAR)         AS SHIFT_TYPE,
       CAST(NULL AS VARCHAR)         AS ORS_PROFILE,
       CAST(NULL AS FLOAT)           AS DISTANCE_KM,        -- route master (TVRO) distance if available
       CAST(NULL AS FLOAT)           AS DURATION_MINUTES,
       h.WBSTK                       AS STATUS,
       'sap-live'                    AS JOB_ID
FROM SAP_SOURCE.FLEET.SRC_LIKP_CURRENT h;
