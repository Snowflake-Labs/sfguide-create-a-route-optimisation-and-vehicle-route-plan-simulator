# SAP -> FLEET_APP.CORE column-level mapping spec

This is the authoritative field-level mapping from landed SAP (EAM/SD) + telematics to the
neutral contract in
[`scoped_contract.sql`](../../install-fleet-apps/fleet_sa_app/app/scoped_contract.sql).

## How the binding works (where these columns land)

The connector does NOT touch `FLEET_APP.CORE` or `SV_FLEET_OPS`. It produces SAP-sourced
views shaped to the column contract that the `FLEET_APP.UNIFIED_FLEET.F_VW_*_SCOPED`
functions pass through, then repoints those functions at the SAP source (see
[`binding.md`](binding.md)). Because the `FLEET_APP.CORE.F_*_SCOPED` UDTFs read the
`UNIFIED_FLEET` layer, swapping the source below it leaves every consumer unchanged.

SAP is always-live: the SAP source views ignore dataset versioning (`P_DATASET_ID`) and
filter only on `P_REGION`. The telematics->SAP join always goes through
`SAP_SOURCE.FLEET.ASSET_CROSSWALK` (see [`asset-crosswalk.md`](asset-crosswalk.md));
`normalize_serial()` is applied on both sides of any serial/VIN comparison.

Legend: `xwalk` = `SAP_SOURCE.FLEET.ASSET_CROSSWALK`. All `<...>` are per-account
column names resolved by `sap-mapping.yaml` (defaults shown are the `serial_direct` profile).

---

## 1. dim_entity  <-  EQUI (+ IFLOT)

Consumed by `FLEET_APP.CORE.F_DIM_ENTITY_SCOPED`. Source: equipment master.

| Contract column | SAP source expression | Notes |
|---|---|---|
| ENTITY_ID | `EQUI.EQUNR` | neutral asset id = SAP equipment number |
| ENTITY_TYPE | `EQUI.EQTYP` (or constant `'asset'`) | equipment category |
| ENTITY_LABEL | `EQUI.EQKTX` (short text) else `EQUI.EQUNR` | |
| ENTITY_GROUP_ID | `EQUI.EQART` (object type) or fleet class | maps to OPERATING_MODE slot |
| CAPACITY_JSON | `OBJECT_CONSTRUCT('material',MATNR,'plant',WERK,'fleet',S_FLEET,'serial',SERNR)` | sparse attrs union |
| HOME_SITE_ID | `EQUI.TPLNR` (functional location) | FK to dim_site |
| STATUS_ENUM | derive from `EQUI` system status (`I0076` deleted, etc.) else NULL | |
| ICON_KEY | `EQUI.EQTYP` | |
| REGION | resolved region key (plant `WERK` -> region map) | partition key |

VIN is typically NOT in EQUI (it often lives outside SAP, in dealer or vehicle-master
systems). Do not map VIN here; the crosswalk holds it, and the `native_serial` strategy joins on
SERIAL, not VIN.

## 2. dim_site  <-  IFLOT

Consumed by `FLEET_APP.CORE.F_DIM_SITE_SCOPED`. Source: functional locations / plants.

| Contract column | SAP source expression | Notes |
|---|---|---|
| SITE_ID | `IFLOT.TPLNR` | functional location id |
| SITE_TYPE | constant `'functional_location'` (or `IFLOT.FLTYP`) | |
| SITE_LABEL | `IFLOT.PLTXT` (description) | join IFLOTX for text if separate |
| SITE_CATEGORY | `IFLOT.FLTYP` | |
| SITE_GEOG | `ST_MAKEPOINT(<lon>,<lat>)` if plant coords available, else `TO_GEOGRAPHY(NULL)` | many IFLOT rows have no geo |
| GEOFENCE_GEOG | `TO_GEOGRAPHY(NULL)` | not modeled in EAM |
| REGION | plant `IWERK` -> region map | |

## 3. fact_position  <-  telematics (via crosswalk)

Consumed by `FLEET_APP.CORE.F_FACT_POSITION_SCOPED`. Source: telematics GPS fact, joined to
`xwalk` to resolve `ENTITY_ID`. Per-account device key + column names from `sap-mapping.yaml`.

| Contract column | SAP/telematics source expression | Notes |
|---|---|---|
| POSITION_ID | `<telemetry pk>` (per-feed message/row id) | row id |
| ENTITY_ID | `xwalk.asset_id` (joined on device key) | resolved EQUI.EQUNR |
| JOURNEY_ID | `<delivery/trip ref>` or NULL | NULL when telemetry has no trip linkage |
| TS | `<event_ts>` (the feed's GPS/event timestamp column) | |
| LOCATION_GEOG | `ST_MAKEPOINT(<lon>::FLOAT,<lat>::FLOAT)` | CAST: WM stores lat/lon as TEXT |
| H3_CELL | derived in contract UDTF | leave to CORE (do not precompute) |
| SPEED_VALUE | `<speed>` (the feed's speed column) | normalize to km/h |
| HEADING_VALUE | `<heading>` (HEADING / GPS_HEADING / COURSE) | degrees |
| MOTION_STATUS_ENUM | derive: `CASE WHEN speed < idle_threshold THEN 'IDLE' ELSE 'MOVING' END` | no native status in most feeds |
| DATA_QUALITY_ENUM | derive from GPS accuracy/HDOP if present, else NULL | |
| SOURCE_SYSTEM | constant feed tag from config (e.g. `'telematics'`, `'ais'`) | replaces `'synthetic'` |
| REGION | resolved region key | |
| POSTED_SPEED_VALUE | NULL unless a road-speed enrichment exists | |
| IS_SPEEDING | `(SPEED_VALUE > POSTED_SPEED_VALUE)` else NULL | requires posted speed |

Volume note: telematics is 45B-135B rows/account. Materialize this view as a Dynamic Table
clustered on `(ENTITY_ID, TS)` rather than a plain view (see [`binding.md`](binding.md)).

## 4. fact_journey + dim_plan  <-  LIKP/LIPS (+ VBAK/VBAP)

SAP deliveries are the closest analogue to a "trip". Planned legs come from the delivery
header/route; actuals are derived from telemetry bracketed by the delivery window.

### dim_plan (planned) <- LIKP/LIPS (+ VBAK/VBAP)
Consumed by `FLEET_APP.CORE.F_DIM_PLAN_SCOPED`.

| Contract column | SAP source expression | Notes |
|---|---|---|
| PLAN_ID | `LIKP.VBELN` | delivery document number |
| PLAN_TYPE | constant `'delivery'` | |
| PLAN_LABEL | `LIKP.VBELN` | |
| ENTITY_ID | assigned vehicle via shipment (VTTK/VTTP) or `xwalk` | may be NULL pre-dispatch |
| OPERATOR_ID | driver from shipment if present, else NULL | |
| ORIGIN_SITE_ID | shipping point `LIKP.VSTEL` -> site | |
| DESTINATION_SITE_ID | ship-to `LIKP.KUNNR` -> site, or `LIPS.WERKS` | |
| PLANNED_START_TS | `LIKP.LFDAT` (+ `LFUHR` time if present) | delivery date |
| PLANNED_END_TS | planned GI/arrival ts | |
| PLANNED_DISTANCE_VALUE | route distance from `TVRO` (route master) if available | |
| PLANNED_DURATION_SEC | route lead time `LIKP.TRATY`/`TVRO` | |
| PLAN_DATE | `LIKP.LFDAT::DATE` | |
| SEQUENCE_NUM | `LIPS.POSNR` (item) or stop seq | |
| STATUS_ENUM | delivery status (`LIKP.WBSTK` goods-movement status) | |
| REGION | `LIKP.VSTEL`/plant -> region | |

### fact_journey (actual) <- LIKP/LIPS + telemetry
Consumed by `FLEET_APP.CORE.F_FACT_JOURNEY_SCOPED`. Where the customer has SAP TM
(`/SCMTMS/` freight orders), prefer the freight-order actuals; otherwise derive from telemetry.

| Contract column | SAP source expression | Notes |
|---|---|---|
| JOURNEY_ID | `LIKP.VBELN` (or freight order id) | |
| ENTITY_ID | `xwalk.asset_id` | |
| OPERATOR_ID | driver | |
| ENTITY_TYPE | `EQUI.EQTYP` via entity | |
| ORIGIN_SITE_ID / DESTINATION_SITE_ID | as dim_plan | |
| START_TS / END_TS | actual GI ts / POD ts (`LIKP.WADAT_IST`) or telemetry min/max for the delivery | |
| ACTUAL_PATH_GEOG | `ST_MAKELINE` over the delivery's telemetry track | derived |
| PLANNED_PATH_GEOG | route geometry from `TVRO`/TM if available else NULL | |
| ORIGIN / DESTINATION | site geo points | |
| STATUS_ENUM | `LIKP.WBSTK` | |
| DISTANCE_VALUE | actual distance (sum of telemetry segments) | |
| PLANNED_DISTANCE_VALUE | route distance | |
| DURATION_SEC | `DATEDIFF('second', START_TS, END_TS)` | |
| IS_DEVIATION | `(DISTANCE_VALUE > PLANNED_DISTANCE_VALUE * deviation_ratio)` | ratio from profile |
| DEVIATION_DISTANCE_VALUE | `DISTANCE_VALUE - PLANNED_DISTANCE_VALUE` | |
| REGION | | |
| TRIP_KIND | `'LADEN'` if delivery has goods, else `'EMPTY'` (return legs) | |
| IS_EMPTY | `(TRIP_KIND='EMPTY')` | |

---

## 5. fact_maintenance  <-  AUFK + QMEL + IMRG  (NET-NEW extension)

EAM maintenance has no equivalent in the current contract. This adds a new entity. It is the
differentiated predictive-maintenance domain (Phase 3 dashboards) and the write-back target
(create notification/order back into SAP). Proposed contract UDTF
`FLEET_APP.CORE.F_FACT_MAINTENANCE_SCOPED(P_REGION, P_DATASET_ID)`:

| Contract column | SAP source expression | Source |
|---|---|---|
| MAINT_ID | `AUFK.AUFNR` (order) or `QMEL.QMNUM` (notification) | AUFK / QMEL |
| MAINT_TYPE | `AUFK.AUART` (order type) / `QMEL.QMART` | |
| ENTITY_ID | object -> equipment: `QMEL.OBJNR`/`AFIH.EQUNR` -> `EQUI.EQUNR` | AFIH/QMEL |
| EVENT_TS | order basic start `AUFK.GSTRP`, notification `QMEL.QMDAT` | |
| STATUS_ENUM | system status (`JEST`/`TJ02T`) | |
| MEASURE_POINT | `IMRG.POINT` | IMRG |
| READING_VALUE | `IMRG.READG` (counter/condition reading) | IMRG time-series |
| READING_TS | `IMRG.IDATE + IMRG.ITIME` | |
| SITE_ID | `IFLOT.TPLNR` via equipment | |
| REGION | plant -> region | |

IMRG is a genuine time-series (odometer/hours/condition); it feeds anomaly/forecast models the
same way `fact_position` feeds movement analytics. `MSEG.EQUNR` (goods movement tied to
equipment) is an optional cost/consumption join, not required for v1.

---

## Per-account source resolution (defaults in `sap-mapping.yaml`)

| Profile (strategy) | dim_entity | fact_position device key | journey source | join strategy |
|---|---|---|---|---|
| serial_direct | EQUI | telematics serial | deliveries (LIKP/LIPS) | native_serial |
| device_vin_bridge | EQUI | device/message id -> VIN | deliveries | vin_2hop |
| vin_external | external master (no EQUI) | VIN | finance-only; limited journey | vin_external |
| marine | vessel master | MMSI/IMO | AIS voyages | marine |

The mapping is config-driven: a new account is a new `sap-mapping.yaml` block, no SQL edits.

## Finance-only SAP exception (vin_external)

When SAP has NO EQUI (finance-only: BSEG/EKKO), `dim_entity` comes entirely from the
external fleet-asset master via `vin_external`, and SAP joins in ONLY at the finance/cost layer:
BSEG/EKKO -> the `cost_per_unit` / `detention_cost` metrics keyed by asset/cost-object, never as
the equipment record. In this case, treat the SAP binding as enrichment of the cost-related
metrics, not as the source of the asset, site, or telemetry entities.

## Co-location is a prerequisite (Step 0)

All column expressions above assume SAP and telematics are reachable from one account. They
typically land in separate accounts with no in-Snowflake join today, so co-locate first
(data share / replication) per [`colocation.md`](colocation.md). The `{{SAP_SCHEMA}}` /
`{{TELEMATICS_TABLE}}` placeholders resolve to the co-located (inbound) paths.
