-- sap_knowledge.sql
-- SAP-data-binding knowledge base for the FLEET_SA_APP chat agent.
--
-- Seeds a small, curated knowledge table (one row per concept, distilled from
-- the sap-fleet-connector reference docs) and builds a Cortex Search service
-- over it. The consumer agent (FLEET_AGENT) attaches this service via a
-- cortex_search tool (search_sap_binding) so users can ask how to bind their
-- SAP EAM/SD + telematics data into the neutral FLEET_APP contract and get
-- grounded, cited answers.
--
-- Source of truth for the content: .cortex/skills/sap-fleet-connector/references/*.md
-- (this file is a distilled, retrieval-friendly copy - keep both in sync).
--
-- Idempotent: table is CREATE IF NOT EXISTS then TRUNCATE + reseed; service is
-- CREATE OR REPLACE. Cortex Search embeds internally (no manual EMBED needed).
-- Runs in install step 4.7, before agents (step 6) and roles (step 8);
-- FLEET_APP_USER is pre-created at step 0.5 so the grant below is safe.

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.SEMANTIC
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.SEMANTIC.SAP_BINDING_KB (
  CHUNK_ID    STRING,
  DOC         STRING,
  SECTION     STRING,
  CHUNK_TEXT  STRING
) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

TRUNCATE TABLE FLEET_INTELLIGENCE.SEMANTIC.SAP_BINDING_KB;

INSERT INTO FLEET_INTELLIGENCE.SEMANTIC.SAP_BINDING_KB (CHUNK_ID, DOC, SECTION, CHUNK_TEXT)
SELECT column1, column2, column3, column4
FROM VALUES
  ('overview', 'SKILL', 'What SAP binding is',
   $$Binding SAP data into the fleet app is a semantic-binding step, not an ingestion connector. SAP (Plant Maintenance/EAM, Sales & Distribution deliveries, optionally Transportation Management) plus fleet telematics are assumed already landed in Snowflake (via Fivetran, SLT-ODP, Datasphere, or Qlik Replicate). The connector maps those landed tables to the neutral FLEET_APP contract and repoints the source seam, so the 13 SA-app views, the Cortex agent, and the SV_FLEET_OPS semantic view light up on real SAP data with zero edits above the contract. It does not extract data from SAP.$$),
  ('prerequisites', 'SKILL', 'Prerequisites',
   $$Before binding SAP data: (1) install-fleet-apps must already be deployed, providing FLEET_APP.CORE, FLEET_APP.UNIFIED_FLEET, FLEET_INTELLIGENCE.SEMANTIC.SV_FLEET_OPS, and the consumer roles. (2) SAP and telematics must be reachable from ONE account (co-locate first, see Step 0). (3) SAP landed: at minimum EQUI and IFLOT (EAM) and/or LIKP/LIPS (deliveries); for maintenance also IMRG, AUFK, QMEL. (4) Telematics landed: a GPS fact with a device id, timestamp, lat, lon. (5) A sap-mapping.yaml block filled in for the account (co-location source, object names, device key, CDC tool, join strategy). A default serial_direct block is provided.$$),
  ('colocation', 'colocation', 'Step 0 - co-locate SAP and telematics',
   $$SAP and telematics almost always land in SEPARATE Snowflake accounts with effectively no in-Snowflake join today, so co-location is net-new work at nearly every account. Before any crosswalk or binding, both sources must be reachable from the ONE account where FLEET_APP lives. Methods (set colocation.method in sap-mapping.yaml): data_share (preferred) - the owning account grants a secure share and the FLEET_APP account mounts it as an inbound database (no data movement, always current; cross-region/cross-cloud needs the provider to replicate the share first); replication - copy only the needed columns into the FLEET_APP account and cluster telematics on (device_id, ts) (heavier, use only when a share is impossible); same_account - both already co-located (rare), skip Step 0.$$),
  ('crosswalk-overview', 'asset-crosswalk', 'ASSET_CROSSWALK - the telematics to SAP join seam',
   $$The single hardest problem is that telematics rows identify a device while SAP rows identify an equipment, and they rarely share a clean key. ASSET_CROSSWALK (in SAP_SOURCE.FLEET) is a per-account bridge that resolves any device identifier to a neutral asset_id (= EQUI.EQUNR when SAP equipment exists). Every fact_position and fact_journey join to a SAP entity goes through it. It is MANDATORY for all accounts. Columns: asset_id, serial, vin, device_id, source (strategy/provenance). Only the native_serial strategy can populate it with a direct view (no manual bridge rows); the others need a 2-hop join or an external master.$$),
  ('normalize-serial', 'asset-crosswalk', 'normalize_serial()',
   $$SAP EQUI.SERNR is TEXT(18), zero-padded and uppercased; telematics serials and VIN feeds are free-text and ungoverned. Apply the SAME normalization on BOTH sides of any serial/VIN comparison: normalize_serial(x) = REGEXP_REPLACE(UPPER(TRIM(x)), '^0+', '') (strip leading zeros, uppercase, trim). Caveat: stripping leading zeros can rarely collide two serials that differ only by leading zeros; the install-time overlap_selfcheck.sql reports any normalized-key collisions so they can be excluded per account.$$),
  ('strategy-native-serial', 'asset-crosswalk', 'Strategy: native_serial',
   $$native_serial: the telematics serial joins directly to EQUI.SERNR after normalization, so the crosswalk is just a VIEW with no manual bridge rows. asset_id = EQUI.EQUNR, serial = normalize_serial(EQUI.SERNR), device_id = the same normalized serial, source = 'native_serial'. This is the cleanest strategy and the serial_direct profile default. Use it when the telematics feed carries the equipment serial.$$),
  ('strategy-vin-2hop', 'asset-crosswalk', 'Strategy: vin_2hop',
   $$vin_2hop: the GPS fact key is a message/device id, not a vehicle id. Resolve in two hops - device -> VIN/chassis (via the telematics vehicle master / device index) -> EQUI.SERNR. The crosswalk is built by joining the device index to EQUI on VIN/chassis. Use it when telemetry identifies a device and a separate master maps device to VIN.$$),
  ('strategy-vin-external', 'asset-crosswalk', 'Strategy: vin_external (finance-only SAP)',
   $$vin_external: SAP is finance-only (BSEG/EKKO) with NO EQUI. VIN binds to an external fleet-asset master, which IS the crosswalk; asset_id comes from that external master, not from SAP. VIN must be normalized and validated (trim, uppercase, length-check to 17, drop non-alphanumerics). In this case dim_entity comes entirely from the external master and SAP joins in ONLY at the finance/cost layer (BSEG/EKKO feeding cost_per_unit / detention_cost metrics keyed by asset/cost-object), never as the equipment record.$$),
  ('strategy-marine', 'asset-crosswalk', 'Strategy: marine',
   $$marine: assets are vessels. The key is MMSI/IMO joined to a vessel master from an AIS provider, and asset_id = IMO. This is a separate template - fact_position lat/lon comes from AIS, and there is no road EQUI.$$),
  ('cdc-dedup', 'cdc-dedup', 'CDC current-row layer (L1)',
   $$SAP lands via a replication tool that streams change-data, so raw landed tables contain multiple versions per business key plus tool metadata. Before any semantic mapping, build "current-row" (L1) views that: (1) dedupe to the latest version per primary key, (2) drop deleted rows, (3) filter to the productive client (MANDT = '<client>', default '100'), (4) tolerate customer custom fields (ZZ*, YY1_CF_*, etc.) by selecting only the columns the mapping needs (never SELECT *). All SAP source views read these L1 views, never the raw CDC tables. Set cdc.tool in sap-mapping.yaml: qlik (header__change_oper/header__timestamp), odp (ODQ_CHANGEMODE/ODQ_ENTITYCNTR), fivetran (_fivetran_synced/_fivetran_deleted, lowercased columns), slt_raw (MANDT + LASTCHANGEDATETIME/AEDAT), or cds_view (S/4HANA CDS views that already deduped and dropped MANDT, so L1 is a thin pass-through).$$),
  ('map-dim-entity', 'sap-entity-mapping', 'Mapping: dim_entity from EQUI',
   $$dim_entity is sourced from the SAP equipment master EQUI (+ IFLOT). Key columns: ENTITY_ID = EQUI.EQUNR (neutral asset id = SAP equipment number); ENTITY_TYPE = EQUI.EQTYP or constant 'asset'; ENTITY_LABEL = EQUI.EQKTX short text else EQUNR; ENTITY_GROUP_ID = EQUI.EQART (maps to the OPERATING_MODE slot); HOME_SITE_ID = EQUI.TPLNR (functional location, FK to dim_site); CAPACITY_JSON = OBJECT_CONSTRUCT of material/plant/fleet/serial; REGION = plant WERK resolved to a region key. VIN is typically NOT in EQUI - do not map it here; the crosswalk holds VIN and the native_serial strategy joins on SERIAL.$$),
  ('map-dim-site', 'sap-entity-mapping', 'Mapping: dim_site from IFLOT',
   $$dim_site is sourced from SAP functional locations / plants IFLOT. SITE_ID = IFLOT.TPLNR; SITE_TYPE = constant 'functional_location' or IFLOT.FLTYP; SITE_LABEL = IFLOT.PLTXT (join IFLOTX for text if separate); SITE_GEOG = ST_MAKEPOINT(lon,lat) when plant coords exist else TO_GEOGRAPHY(NULL) (many IFLOT rows have no geo); REGION = plant IWERK resolved to a region key.$$),
  ('map-fact-position', 'sap-entity-mapping', 'Mapping: fact_position from telematics via crosswalk',
   $$fact_position is sourced from the telematics GPS fact, joined to ASSET_CROSSWALK to resolve ENTITY_ID. POSITION_ID = the telemetry row/message id; ENTITY_ID = xwalk.asset_id (joined on the device key); TS = the feed event timestamp; LOCATION_GEOG = ST_MAKEPOINT(lon::FLOAT, lat::FLOAT) (cast because many feeds store lat/lon as TEXT); SPEED_VALUE normalized to km/h; MOTION_STATUS_ENUM derived (speed < idle_threshold -> 'IDLE' else 'MOVING'); SOURCE_SYSTEM = a constant feed tag (e.g. 'telematics','ais') replacing 'synthetic'; H3_CELL is left to the CORE UDTF (do not precompute). Volume is 45B-135B rows/account, so materialize this as a Dynamic Table clustered on (ENTITY_ID, TS) rather than a plain view.$$),
  ('map-fact-journey', 'sap-entity-mapping', 'Mapping: fact_journey and dim_plan from deliveries',
   $$SAP deliveries (LIKP/LIPS, with VBAK/VBAP) are the closest analogue to a trip. dim_plan (planned): PLAN_ID = LIKP.VBELN (delivery document), PLANNED_START_TS = LIKP.LFDAT, ORIGIN_SITE_ID = shipping point LIKP.VSTEL, DESTINATION_SITE_ID = ship-to LIKP.KUNNR or LIPS.WERKS, STATUS_ENUM = LIKP.WBSTK. fact_journey (actual): JOURNEY_ID = LIKP.VBELN (or freight order id), ENTITY_ID = xwalk.asset_id, START_TS/END_TS = actual goods-issue / POD ts (LIKP.WADAT_IST) or telemetry min/max for the delivery window, ACTUAL_PATH_GEOG = ST_MAKELINE over the delivery's telemetry track, DISTANCE_VALUE = sum of telemetry segments, TRIP_KIND = 'LADEN' if the delivery has goods else 'EMPTY' (return legs). Where SAP TM freight orders exist, prefer freight-order actuals over telemetry-derived.$$),
  ('map-fact-maintenance', 'sap-entity-mapping', 'Mapping: fact_maintenance (net-new extension)',
   $$fact_maintenance has no equivalent in the current contract - it is a net-new, additive entity (Phase 3, the differentiated predictive-maintenance domain and the SAP write-back target). Sourced from AUFK + QMEL + IMRG: MAINT_ID = AUFK.AUFNR (order) or QMEL.QMNUM (notification); ENTITY_ID resolves object to equipment (QMEL.OBJNR / AFIH.EQUNR -> EQUI.EQUNR); MEASURE_POINT = IMRG.POINT; READING_VALUE = IMRG.READG (a genuine odometer/hours/condition time-series that feeds anomaly/forecast models the way fact_position feeds movement analytics). It is added as a new FLEET_APP.CORE.F_FACT_MAINTENANCE_SCOPED UDTF + VW_FACT_MAINTENANCE view - the one place the contract is extended additively rather than just rebound.$$),
  ('binding-seam', 'binding', 'The binding seam - repoint UNIFIED_FLEET, leave the contract unchanged',
   $$The layer stack is: SV_FLEET_OPS -> FLEET_APP.FLEET_OPS.VW_* -> FLEET_APP.CORE.F_*_SCOPED (neutral contract UDTFs) -> FLEET_APP.UNIFIED_FLEET.F_VW_*_SCOPED (THE SWAP SEAM) -> synthetic base tables (default). The connector replaces the bodies of the FLEET_APP.UNIFIED_FLEET.F_VW_*_SCOPED functions (and the sibling VW_* views) so they read the SAP source views instead of the synthetic layer. Nothing above the seam changes - CORE, FLEET_OPS, SV_FLEET_OPS, dashboards, and the agent are all untouched and are not redeployed. The seam is the functions (not the V_*_CURRENT views) because the CORE contract that the app and agent consume flows through the functions.$$),
  ('always-live', 'binding', 'SAP is always-live: dataset versioning is bypassed',
   $$The synthetic seam scopes by DIM_DATASETS.IS_ACTIVE and a (REGION, VEHICLE_TYPE, JOB_ID) join, but SAP has a single live state. So the SAP F_VW_*_SCOPED replacements honor P_REGION (filter on the resolved region key), ignore P_DATASET_ID (always return live SAP rows), and carry a constant JOB_ID. bind_sap_source.sql inserts one DIM_DATASETS row (DATASET_ID='sap-live', IS_ACTIVE=TRUE, NOTES='sap-fleet-connector') so the SA app's dataset picker and grants stay happy.$$),
  ('what-created-replaced', 'binding', 'What the connector creates vs replaces',
   $$Creates (new, in SAP_SOURCE.FLEET): the normalize_serial UDF, the ASSET_CROSSWALK table/view, the L1 current-row views over the CDC tables, and the L4 contract-shaped source views SRC_DIM_FLEET, SRC_DIM_POIS, SRC_FACT_TRIPS, SRC_FACT_VEHICLE_TELEMETRY, SRC_DIM_TRIP_SCHEDULE (fact_position source is a Dynamic Table when materialize_position=true). Replaces (existing, owned by UNIFIED_FLEET): the F_VW_*_SCOPED functions and sibling VW_* views, whose bodies now read SAP_SOURCE.FLEET.SRC_* filtered by P_REGION. Never touched: FLEET_APP.CORE.*, FLEET_APP.FLEET_OPS.*, SV_FLEET_OPS, dashboards, and the agent.$$),
  ('verification', 'binding', 'Non-invasiveness verification',
   $$To prove the bind changed nothing above the seam: (1) snapshot GET_DDL of SV_FLEET_OPS before and after the bind and assert byte-identical; (2) snapshot the FLEET_APP.CORE function DDLs before/after and assert unchanged; (3) SELECT COUNT(*) FROM FLEET_APP.CORE.VW_FACT_JOURNEY returns SAP-derived rows after the bind; (4) the SA app and agent are not redeployed and need no config change. An install-time overlap_selfcheck.sql (run in the customer account, since Snowhouse cannot see row values) reports distinct telemetry keys, distinct EQUI keys, the intersection count and percentage both directions, sample unmatched keys, and normalized-key collisions - a low overlap means the strategy/normalization needs tuning before the POC proceeds.$$),
  ('config-driven', 'sap-entity-mapping', 'Config-driven per-account profiles',
   $$The mapping is config-driven: a new account is a new sap-mapping.yaml block with no SQL edits. Profiles (join strategy): serial_direct -> dim_entity from EQUI, fact_position device key = telematics serial, journey source = deliveries (LIKP/LIPS), join = native_serial; device_vin_bridge -> device/message id to VIN, join = vin_2hop; vin_external -> external master (no EQUI), finance-only limited journey, join = vin_external; marine -> vessel master, MMSI/IMO key, AIS voyages, join = marine.$$)
;

CREATE OR REPLACE CORTEX SEARCH SERVICE FLEET_INTELLIGENCE.SEMANTIC.SAP_BINDING_SEARCH
  ON CHUNK_TEXT
  ATTRIBUTES DOC, SECTION
  WAREHOUSE = MY_WH
  TARGET_LAG = '1 hour'
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
  AS
    SELECT CHUNK_ID, CHUNK_TEXT, DOC, SECTION
    FROM FLEET_INTELLIGENCE.SEMANTIC.SAP_BINDING_KB;

-- Consumer role (pre-created at install step 0.5) needs USAGE to query the
-- service through the agent's cortex_search tool.
GRANT USAGE ON CORTEX SEARCH SERVICE FLEET_INTELLIGENCE.SEMANTIC.SAP_BINDING_SEARCH TO ROLE FLEET_APP_USER;
