# Deferred core views (pending synthetic-data generation)

The agnostic-view report (sections 5.2, 5.5) defines two additional universal-core
views that are **not built yet** because the synthetic generator
(`SYNTHETIC_DATASETS.UNIFIED`) does not produce their source data. They are
specified here so the neutral `FLEET_APP.CORE` contract and the generator can be
extended later, after which each becomes a normal YAML view in `app-views.json`
plus one neutral aliasing function in `app/scoped_contract.sql` (mirrored into the
control-app boot `init.ts`), exactly like the shipped CORE entities.

The two shipped data-backed new views (Dispatch Execution Board, Safety / Risk
Scorecard) cover the gaps that existing data supports today.

---

## 1. Maintenance & Health Center (report 5.2)

Canonical job: prevent avoidable downtime; prioritize asset/device/service work.

### Missing source data (generator TODO)
A per-entity health/issue stream does not exist. Add to the generator + a new
base table `SYNTHETIC_DATASETS.UNIFIED.FACT_HEALTH_ISSUE`:

| column | type | note |
|---|---|---|
| ISSUE_ID | VARCHAR | grain: one row per issue |
| VEHICLE_ID | VARCHAR | -> neutral entity_id |
| REGION / VEHICLE_TYPE | VARCHAR | dataset scoping keys |
| ISSUE_TYPE | VARCHAR | DTC, defect, inspection_fail, device_offline |
| SEVERITY | VARCHAR | critical / warning / watch |
| DETECTED_TS / DUE_TS / RESOLVED_TS | TIMESTAMP_NTZ | |
| DIAGNOSTIC_CODE | VARCHAR | |
| DOWNTIME_MINUTES | FLOAT | |
| ESTIMATED_COST | FLOAT | |
| JOB_ID | VARCHAR | dataset key (joins DIM_DATASETS) |

### Neutral contract to add (scoped_contract.sql + init.ts mirror)
`FLEET_APP.CORE.F_FACT_HEALTH_ISSUE_SCOPED(region, dataset_id)` ->
`issue_id, entity_id, issue_type, severity_enum, detected_ts, due_ts, resolved_ts,
diagnostic_code, downtime_sec, estimated_cost, region` + global-active `VW_FACT_HEALTH_ISSUE`.
Thresholds already seeded: `health_open_issue_count` in `DIM_METRIC_DEFINITION` / `display.thresholds`.

### View (app-views.json) when data exists
`maintenance_health_center`: KPI rail (unavailable / critical issues / overdue work
/ due soon / downtime cost) + priority issue worklist (ClickableTable,
exceptionFirst on severity, showFreshness) + maintenance calendar (Chart by due
week) + asset drawer (Map). Competitor analogue: Fleetio, Samsara Device Health.

---

## 2. ETA / Exception Control Tower (report 5.5)

Canonical job: monitor commitments and predicted exceptions across journeys,
milestones, and nodes.

### Missing source data (generator TODO)
There is no committed-ETA / milestone stream and no predicted-ETA model. Add a base
table `SYNTHETIC_DATASETS.UNIFIED.FACT_COMMITMENT`:

| column | type | note |
|---|---|---|
| COMMITMENT_ID | VARCHAR | grain: one row per milestone commitment |
| TRIP_ID / VEHICLE_ID | VARCHAR | -> journey_id / entity_id |
| MILESTONE_TYPE | VARCHAR | pickup, delivery, gate, berth |
| PLANNED_TS / PREDICTED_TS / ACTUAL_TS | TIMESTAMP_NTZ | |
| REASON_CODE | VARCHAR | late reason taxonomy |
| DESTINATION_POI_ID | VARCHAR | -> destination_site_id |
| BUSINESS_IMPACT | FLOAT | |
| JOB_ID | VARCHAR | dataset key |

A predicted_ts requires a (simple) ETA model in the generator (e.g. planned +
historical variance). `eta_variance` thresholds already seeded.

### Neutral contract to add
`FLEET_APP.CORE.F_FACT_COMMITMENT_SCOPED(region, dataset_id)` ->
`commitment_id, journey_id, entity_id, milestone_type, planned_ts, predicted_ts,
actual_ts, eta_variance_sec, reason_code, destination_site_id, business_impact_value,
status_enum, region` + global-active `VW_FACT_COMMITMENT`.

### View (app-views.json) when data exists
`eta_exception_control_tower`: KPI rail (at-risk / late / recovered / avg ETA
variance / business impact) + milestone exception list (ClickableTable,
exceptionFirst on status, showFreshness) + ETA map (current locations +
destination nodes) + root-cause drawer. Competitor analogue: project44, FourKites.

---

## How to un-defer (checklist)
1. Extend the generator to populate the new base table(s) per dataset (JOB_ID keyed).
2. Add the UNIFIED + `FLEET_APP.CORE` scoped function(s) to `app/scoped_contract.sql`;
   mirror the UNIFIED base function into the control-app `server/lib/init.ts` boot path.
3. Add the YAML view to `app/app-views.json` bound to the new CORE function, using
   config tokens (`{{labels.*}}`) and the shared UX patterns (exception sort,
   freshness, KPI-tile filter).
4. Add the view's `category` (core) in the nav taxonomy and a persona mapping.
5. Verify parity (neutral view row count == source) and that the query runs for an
   active dataset, then deploy.
