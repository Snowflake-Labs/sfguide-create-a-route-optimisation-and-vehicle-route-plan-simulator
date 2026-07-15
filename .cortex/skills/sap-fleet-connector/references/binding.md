# Binding approach - repoint the UNIFIED_FLEET seam, leave the contract unchanged

## The layer stack (from `install-fleet-apps`)

```
SV_FLEET_OPS                              (semantic view - Cortex Analyst / agent)
  -> FLEET_APP.FLEET_OPS.VW_*             (analytics views)
     -> FLEET_APP.CORE.F_*_SCOPED         (neutral contract UDTFs)
        -> FLEET_APP.UNIFIED_FLEET.F_VW_*_SCOPED   <= THE SWAP SEAM
           -> SYNTHETIC_DATASETS.UNIFIED.F_*_SCOPED -> base tables (synthetic, default)
```

`FLEET_APP.CORE.F_*_SCOPED` (see
[`scoped_contract.sql`](../../install-fleet-apps/fleet_sa_app/app/scoped_contract.sql)) call the
`FLEET_APP.UNIFIED_FLEET.F_VW_*_SCOPED` functions. Those functions are the single seam: by
default they read the synthetic physical layer; the connector replaces their bodies to read the
SAP source views instead. Nothing above the seam (CORE, FLEET_OPS, SV_FLEET_OPS, dashboards,
agent) changes.

## Why the seam is the UNIFIED_FLEET functions (not the V_*_CURRENT views)

There are two candidate swap points:
- The `FLEET_APP.UNIFIED_FLEET.VW_*` views (`SELECT * FROM V_*_CURRENT`) - read by the
  FLEET_OPS analytics views.
- The `FLEET_APP.UNIFIED_FLEET.F_VW_*_SCOPED` functions - read by the CORE UDTFs.

The CORE contract (what the SA app + agent actually consume) flows through the **functions**, so
the connector repoints the functions. It also repoints the sibling `VW_*` views for the few
FLEET_OPS paths that read them. Both are owned by the `UNIFIED_FLEET` pack and are safe to
`CREATE OR REPLACE`.

## SAP is always-live: dataset versioning is bypassed

The synthetic seam scopes by `DIM_DATASETS.IS_ACTIVE` and a `(REGION, VEHICLE_TYPE, JOB_ID)`
join. SAP has a single live state, so the SAP `F_VW_*_SCOPED` replacements:
- honor `P_REGION` (filter on the resolved region key),
- ignore `P_DATASET_ID` (always return the live SAP rows),
- carry a constant `JOB_ID` so one registered `DIM_DATASETS` row keeps the SA app's dataset
  picker and grants happy.

`bind_sap_source.sql` inserts that one row:
```sql
INSERT INTO FLEET_INTELLIGENCE.CORE.DIM_DATASETS
  (DATASET_ID, REGION, VEHICLE_TYPE, LABEL, IS_ACTIVE, CREATED_AT, ROW_COUNTS, NOTES)
SELECT 'sap-live', '<region>', '<vehicle_type>', 'SAP live (sap-fleet-connector)',
       TRUE, CURRENT_TIMESTAMP(), NULL, 'sap-fleet-connector';
```

## What the connector creates vs. replaces

Creates (new, in `SAP_SOURCE.FLEET`):
- `normalize_serial` UDF, `ASSET_CROSSWALK` table/view
- L1 current-row views over the CDC tables
- L4 contract-shaped source views: `SRC_DIM_FLEET`, `SRC_DIM_POIS`, `SRC_FACT_TRIPS`,
  `SRC_FACT_VEHICLE_TELEMETRY`, `SRC_DIM_TRIP_SCHEDULE` (column shapes match the synthetic base
  tables that `F_VW_*_SCOPED` pass through). `fact_position` source is a Dynamic Table when
  `materialize_position=true`.

Replaces (existing, owned by `UNIFIED_FLEET`):
- `FLEET_APP.UNIFIED_FLEET.F_VW_DIM_FLEET_SCOPED`, `F_VW_DIM_POIS_SCOPED`,
  `F_VW_FACT_TRIPS_SCOPED`, `F_VW_FACT_VEHICLE_TELEMETRY_SCOPED`,
  `F_VW_DIM_TRIP_SCHEDULE_SCOPED` (and the sibling `VW_*` views) - bodies now read
  `SAP_SOURCE.FLEET.SRC_*`, filtering `P_REGION`.

Never touched:
- `FLEET_APP.CORE.*` (the contract), `FLEET_APP.FLEET_OPS.*`, `SV_FLEET_OPS`, dashboards, agent.

## Non-invasiveness proof (verification step)

1. Snapshot `GET_DDL('VIEW','FLEET_INTELLIGENCE.SEMANTIC.SV_FLEET_OPS')` before and after bind;
   assert byte-identical.
2. Snapshot the `FLEET_APP.CORE` function DDLs before/after; assert unchanged.
3. `SELECT COUNT(*) FROM FLEET_APP.CORE.VW_FACT_JOURNEY` returns SAP-derived rows post-bind.
4. The SA app + agent are not redeployed and require no config change.

## Maintenance extension (Phase 3)

`fact_maintenance` is net-new (no synthetic equivalent), so it is added as a new
`FLEET_APP.CORE.F_FACT_MAINTENANCE_SCOPED` UDTF + `VW_FACT_MAINTENANCE` view, sourced from
`SAP_SOURCE.FLEET.SRC_FACT_MAINTENANCE` (AUFK/QMEL/IMRG). New dashboards/agent tools consume it;
existing ones are unaffected. This is the one place the contract is *extended* (additively), not
just rebound.
