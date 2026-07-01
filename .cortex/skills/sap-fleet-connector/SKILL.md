---
name: sap-fleet-connector
description: "Bind landed SAP (EAM/SD/TM) plus fleet telematics into the existing FLEET_APP neutral contract and SV_FLEET_OPS semantic view, so the fleet dashboards, Cortex agent, and Cortex Analyst run on a customer's real SAP data with no edits above the contract. The connector maps SAP equipment/delivery/maintenance + telematics to the neutral entities via a mandatory configurable ASSET_CROSSWALK, dedupes CDC-landed SAP tables to current rows, and repoints the UNIFIED_FLEET source seam. Use when: onboarding an SAP fleet customer, swapping synthetic demo data for SAP+telematics, joining EQUI/IFLOT/IMRG/AUFK/QMEL/LIKP to GPS telemetry, building an SAP fleet POC. Do NOT use for: ingesting SAP into Snowflake (that is Fivetran/SLT/Datasphere); generating synthetic data (use install-fleet-apps + Data Studio); non-SAP fleet demos (use fleet-intelligence-car/ebike). Triggers: SAP connector, SAP fleet, EQUI telematics join, asset crosswalk, bind SAP to FLEET_APP, SAP semantic layer, SAP EAM analytics."
depends_on:
  - install-fleet-apps
metadata:
  author: Snowflake SIT-IS
  version: 1.0.0
  category: infrastructure
---

# SAP Fleet Connector

Binds a customer's landed SAP data (Plant Maintenance / EAM, Sales & Distribution deliveries,
optionally Transportation Management) plus their fleet telematics into the **existing** neutral
`FLEET_APP` contract. Because every consumer (the 13 SA-app views, the Cortex agent, and
`SV_FLEET_OPS`) reads the contract and never a physical source, swapping the source from
synthetic data to SAP lights up the whole accelerator with zero edits above the contract.

This is a **semantic-binding** skill, not an ingestion connector. SAP and telematics are assumed
already in Snowflake (Fivetran / SLT-ODP / Datasphere / Qlik Replicate). The skill maps the
landed tables to the contract, it does not extract from SAP.

> **Co-location first (Step 0).** Discovery shows SAP and telematics almost always land in
> SEPARATE Snowflake accounts, with effectively no in-Snowflake join today (any existing
> SAP<->telematics co-joins are a tiny, exploratory fraction). Before binding, the two sources
> must be co-located into ONE queryable account via a data share or replication. The connector
> treats this as Step 0; the crosswalk and binding assume both sources are reachable from the
> account where `FLEET_APP` lives.

## Scope

- IN: co-locate SAP + telematics into one account (data share / replication); discover landed
  SAP + telematics; build the `ASSET_CROSSWALK` and `normalize_serial`; dedupe CDC tables to
  current rows; emit SAP source views shaped to the contract; repoint the
  `FLEET_APP.UNIFIED_FLEET` seam; an install-time join self-check.
- OUT (later phases): predictive-maintenance dashboards over the new `fact_maintenance` entity
  (Phase 3); write-back to SAP notifications/orders + delivery ETA (Phase 4); marine template
  for vessel fleets (Phase 5).
- NOT this skill: SAP->Snowflake ingestion, synthetic data generation, ORS engine provisioning.

## Prerequisites

1. `install-fleet-apps` already deployed (provides `FLEET_APP.CORE`, `FLEET_APP.UNIFIED_FLEET`,
   `FLEET_INTELLIGENCE.SEMANTIC.SV_FLEET_OPS`, and the consumer roles).
2. SAP and telematics reachable from ONE account. They typically land in SEPARATE accounts, so
   co-locate first via a data share (preferred) or replication into the account where `FLEET_APP`
   lives. See [references/colocation.md](references/colocation.md).
3. SAP landed: at minimum EQUI, IFLOT (EAM) and/or LIKP/LIPS (deliveries). For the maintenance
   pack: IMRG, AUFK, QMEL. (When SAP is finance-only - BSEG/EKKO, no EQUI - see the mapping spec.)
4. Telematics landed: a GPS fact with a device identifier, timestamp, lat, lon.
5. A `sap-mapping.yaml` filled in for the account (co-location source, object names, device key,
   CDC tool, join strategy). A default `serial_direct` block is provided.
6. A role with the privileges in Required Privileges (read on the co-located SAP + telematics
   shares/schemas, ownership of the `SAP_SOURCE` database and the `FLEET_APP.UNIFIED_FLEET`
   functions).

## Configuration

| Parameter | Default | Purpose |
|---|---|---|
| `account_profile` | `serial_direct` | Which `sap-mapping.yaml` block to use |
| `colocation.method` | `data_share` | How SAP + telematics are co-located: `data_share` \| `replication` \| `same_account` |
| `colocation.sap_inbound_db` | (required if shared) | Inbound DB name for the shared SAP data |
| `colocation.telematics_inbound_db` | (required if shared) | Inbound DB name for the shared telematics |
| `sap_schema` | (required) | Schema where SAP tables/CDS views are reachable (post co-location) |
| `telematics_table` | (required) | Fully qualified GPS fact table (post co-location) |
| `cdc.tool` | `qlik` | CDC dedup pattern: `qlik` \| `odp` \| `fivetran` \| `slt_raw` \| `cds_view` |
| `cdc.client` | `100` | SAP client (MANDT) to keep |
| `join.strategy` | `native_serial` | `native_serial` \| `vin_2hop` \| `vin_external` \| `marine` |
| `region` | (required) | Region key the bound data is scoped to |
| `materialize_position` | `true` | Build `fact_position` source as a Dynamic Table clustered on (asset, ts) |

## Required Privileges

| Privilege | Scope | Why |
|---|---|---|
| `USAGE` + `SELECT` | customer SAP schema(s) | read EQUI/IFLOT/IMRG/AUFK/QMEL/LIKP/LIPS |
| `USAGE` + `SELECT` | telematics schema | read the GPS fact |
| `CREATE DATABASE`/`CREATE SCHEMA` | account (for `SAP_SOURCE`) | hold crosswalk + source views |
| `OWNERSHIP` or `CREATE FUNCTION` | `FLEET_APP.UNIFIED_FLEET` | repoint the `F_VW_*_SCOPED` seam |
| `SELECT` | `FLEET_INTELLIGENCE.CORE.DIM_DATASETS` | register the always-live SAP dataset row |

No ACCOUNTADMIN required. The seam repoint needs ownership of the `UNIFIED_FLEET` functions
(granted to the deploying role by `install-fleet-apps`).

## Workflow

1. **Set the query tag** (attribution):
   ```sql
   ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-sap-fleet-connector","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
   ```
2. **Co-locate (Step 0)**: bring SAP and telematics into the account where `FLEET_APP` lives.
   SAP and telematics are typically in separate accounts with no join today, so set up the
   inbound data share(s) (preferred) or replication per
   [references/colocation.md](references/colocation.md), then point `sap-mapping.yaml`
   `colocation.*` at the inbound DBs. Skip only if `colocation.method: same_account`.
3. **Discover** the landed SAP + telematics objects and their exposure form (raw / CDS /
   Datasphere): run [`scripts/introspect_sap.sql`](scripts/introspect_sap.sql). Reconcile the
   output against `sap-mapping.yaml`.
   - **From the app UI (no SQL):** the fleet app's chat agent can run this discovery live via
     the `introspect_sap` verb. Ask, e.g., "Which SAP tables can I bind in `MY_SAP_DB`?" (or
     "scan `MY_SAP_DB` and `MY_TELEMATICS_DB` for bindable tables") and it returns the SAP fleet
     objects, the CDC-tool fingerprint, the telematics columns, and a suggested `cdc.tool` +
     join strategy. The verb wraps the read-only proc
     `FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_SAP_INTROSPECT(P_SAP_DB, P_TELEMATICS_DB)`
     (EXECUTE AS OWNER, so the proc owner needs `USAGE` on the scanned databases). For a demo
     without real SAP data, use `MOCK_SAP` / `MOCK_TELEMATICS`: `install-fleet-apps` lands this
     mock landscape automatically (step 3.5, raw tables only, no bind), so on a fleet install it
     is already present - just ask the agent to scan `MOCK_SAP` / `MOCK_TELEMATICS`. For a
     standalone/SAP-skill-only account, run [scripts/mock_sap_seed.sql](scripts/mock_sap_seed.sql)
     first (it is the single source of truth the installer runs).
4. **Build the crosswalk**: run [`scripts/build_crosswalk.sql`](scripts/build_crosswalk.sql)
   (creates `SAP_SOURCE.FLEET.normalize_serial` + `ASSET_CROSSWALK` per the chosen strategy).
5. **Validate the join** in-account: run
   [`scripts/overlap_selfcheck.sql`](scripts/overlap_selfcheck.sql). Confirm acceptable overlap %
   and tune normalization if low. This is informational, not a hard gate.
6. **Emit SAP source views**: run [`scripts/sap_source_views.sql`](scripts/sap_source_views.sql)
   (L1 current-row dedup -> L4 contract-shaped views in `SAP_SOURCE.FLEET`).
7. **Bind the seam**: run [`scripts/bind_sap_source.sql`](scripts/bind_sap_source.sql) to repoint
   `FLEET_APP.UNIFIED_FLEET.F_VW_*_SCOPED` (and `VW_*`) at the SAP source, and register one
   always-live `DIM_DATASETS` row. `FLEET_APP.CORE` and `SV_FLEET_OPS` are untouched.
8. **Verify non-invasiveness**: confirm `SV_FLEET_OPS` and `FLEET_APP.CORE.*` definitions are
   unchanged, and that `SELECT * FROM FLEET_APP.CORE.VW_FACT_JOURNEY LIMIT 10` now returns SAP
   rows. See [references/binding.md](references/binding.md).

See [references/sap-entity-mapping.md](references/sap-entity-mapping.md) for the column-level
mapping, [references/asset-crosswalk.md](references/asset-crosswalk.md) for the join seam, and
[references/cdc-dedup.md](references/cdc-dedup.md) for the current-row layer.

## Examples

- "Bind our SAP equipment + telematics to the fleet app" -> run Steps 0-7 with the
  `serial_direct` profile; the dashboards/agent light up on SAP data.
- "Our telematics only has a device/message id, not a serial" -> use the `device_vin_bridge`
  profile (2-hop device -> VIN -> EQUI.SERNR).
- "SAP only has finance data, no equipment master" -> use the `vin_external` profile; assets
  come from an external master, SAP joins only at the cost layer.

## Stopping points

- After Step 0 (co-location): confirm SAP + telematics are both queryable from the `FLEET_APP`
  account before continuing.
- After Step 4 (overlap self-check): if match % is low, stop and tune `normalize_serial` /
  the crosswalk strategy before emitting source views.
- After Step 7 (bind): verify `SV_FLEET_OPS` is unchanged and the contract returns SAP rows.

## Error Logging

When any step fails (missing SAP/telematics objects, low join overlap, a seam repoint error, or
a contract view returning zero rows), log it to `logs/` per `logs/README.md`
(`sap-fleet-connector_{YYYY-MM-DD}_{HH-MM}.md`). Continue where possible, recording each issue.
Common cases: co-location not done (Step 0 skipped); wrong `cdc.tool` so dedup returns
duplicates; `normalize_serial` mismatch so the crosswalk is empty; missing ownership of the
`FLEET_APP.UNIFIED_FLEET` functions so the bind cannot `CREATE OR REPLACE`.

## Cleanup

```sql
-- 1. Restore the synthetic seam (re-run the install-fleet-apps unified_fleet pack), then:
-- 2. Drop the SAP source artifacts.
DROP DATABASE IF EXISTS SAP_SOURCE;
-- 3. Remove the always-live SAP dataset row.
DELETE FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS WHERE NOTES = 'sap-fleet-connector';
```

Re-running `install-fleet-apps`'s `packs/fleet/unified_fleet/setup.sql` repoints the seam back to
`SYNTHETIC_DATASETS.UNIFIED.V_*_CURRENT`, fully reverting the bind.

## References

- [references/colocation.md](references/colocation.md) - Step 0: co-locate SAP + telematics into one account
- [references/sap-entity-mapping.md](references/sap-entity-mapping.md) - column-level SAP -> contract mapping
- [references/asset-crosswalk.md](references/asset-crosswalk.md) - telematics<->SAP join seam + normalize_serial
- [references/cdc-dedup.md](references/cdc-dedup.md) - current-row layer per replication tool
- [references/binding.md](references/binding.md) - how the seam is repointed; non-invasiveness proof
- [references/conventions.md](references/conventions.md) - tracking-tag formats
