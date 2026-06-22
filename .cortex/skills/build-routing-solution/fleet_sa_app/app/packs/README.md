# Data-contract domain packs

Each pack puts a neutral logical layer (`FLEET_APP.<DOMAIN>`) between the solution's
consumers (dashboards in `app/app-views.json`, custom TSX views, and the
`SV_*` semantic views) and the physical source data. Synthetic data is one
swappable source; a customer points the solution at their tables by editing the
pack's `entity-mapping.yaml` and regenerating - **consumers do not change**.

## Pattern (per pack, under `fleet/<domain>/`)
- `data-model.yaml` - logical entities/columns (the contract).
- `entity-mapping.yaml` - binds the contract to the active source (synthetic).
- `entity-mapping.customer-demo.yaml` - optional swap proof (different shape).
- `setup.sql` - generated DDL (do not hand-edit).
- Generate: `python3 ../../_lib/generate.py --model <pack>/data-model.yaml --mapping <pack>/entity-mapping.yaml --out <pack>/setup.sql`
- SV repoint: add `--sv-repoint <DB.SCHEMA.SV,...>` to emit a base-table rebind script.

## Packs (all migrated to FLEET_APP)
| Pack | FLEET_APP schema | Consumers |
|------|------------------|-----------|
| route_deviation | FLEET_APP.ROUTE_DEVIATION | deviation_overview, deviation_routes; SV_ROUTE_DEVIATION |
| taxi | FLEET_APP.TAXI | taxi_overview, taxi_routes; SV_TAXIS |
| food_delivery | FLEET_APP.FOOD_DELIVERY | food_delivery; SV_FOOD_DELIVERY |
| retail_catchment | FLEET_APP.RETAIL_CATCHMENT | retail_catchment; SV_RETAIL_CATCHMENT |
| route_optimization | FLEET_APP.ROUTE_OPTIMIZATION | asset_velocity; SV_ASSET_VELOCITY |
| dwell | FLEET_APP.DWELL | dwell_overview/congestion/facilities/drivers/sla; SV_DWELL_ANALYTICS |
| unified_fleet | FLEET_APP.UNIFIED_FLEET | fleet_operations, fleet_map; SV_FLEET_OPERATIONS (cross-DB) |
| marketplace | FLEET_APP.MARKETPLACE | freight_exchange (TSX); SV_FREIGHT_MARKETPLACE |
| backload | FLEET_APP.BACKLOAD_MATCHING | backload_matching (TSX); SV_BACKLOAD_MATCHING |
| dhl_ntbo | FLEET_APP.DHL_NTBO | (agent-only) SV_DHL_BACKLOAD |

## Not data-contract migrated (by design)
- `vrp_simulator`, `emergency_wizard`, `ops_console` - call routing/ops verbs only
  (no analytics tables to contract).
- `/api/region` reads/writes the physical `<domain>.CONFIG` tables (writable);
  FLEET_APP views are read-only, so the region write path stays on physical CONFIG.

## Notes
- Grants: database-level + FUTURE grants in `app/role_binding.sql` cover all packs.
- SV repoint gotcha: a semantic view that declares a base table WITHOUT an alias
  needs an explicit alias injected on repoint (its implicit logical name = the
  FQN's last identifier, referenced by `relationships`/facts).
