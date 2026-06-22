# Data-contract domain packs

Each pack puts a neutral logical layer (`FLEET_APP.<DOMAIN>`) between the solution's
consumers (dashboards in `app/app-views.json`, custom TSX views, and the
`SV_*` semantic views) and the physical source data. Synthetic data is one
swappable source; a customer points the solution at their tables by editing the
pack's `entity-mapping.yaml` and regenerating - **consumers do not change**.

## Pattern (per pack, under `fleet/<domain>/`)
- `data-model.yaml` - logical entities/columns (the contract). Entities are `mapped`
  (bound to a source), `derived` (COMPUTED by the solution), or `context`.
- `entity-mapping.yaml` - binds the contract to the active source (synthetic).
  Source-specific shaping (WHERE/QUALIFY/CASE) goes in a per-entity `sql:` block here.
- `entity-mapping.customer-demo.yaml` - optional swap proof (different shape).
- `setup.sql` - generated DDL (do not hand-edit).
- Generate: `python3 ../../_lib/generate.py --model <pack>/data-model.yaml --mapping <pack>/entity-mapping.yaml --out <pack>/setup.sql`
- SV repoint: add `--sv-repoint <DB.SCHEMA.SV,...>` to emit a base-table rebind script,
  wrapped in `EXECUTE IMMEDIATE $$...$$` so it applies as a SINGLE statement via `snow sql -f`
  (a bare `DECLARE/BEGIN/END;` block is split on its internal `;` and fails). The committed
  `<pack>/sv_repoint.sql` is the durable, idempotent reproducibility artifact for self-building
  packs whose SV absorbs physical DTs via `replaces:` (route_optimization, backload, dhl_ntbo).
  It rebinds an already-existing SV; it does NOT author the SV (SV CREATE DDL is not yet a repo
  source-of-truth - see caveat below).
- Verify variant: `--app-schema FLEET_APP_VERIFY.<pack> --materialization view` builds the
  whole chain as instant views in a scratch schema for bit-for-bit checks (no DT refresh wait).

## Installer (`_lib/install.py`)
Manifest-driven deploy-all, idempotent, in inter-pack `depends_on` order:
- `python3 install.py [-c <conn>]` - apply every pack's `setup.sql`.
- `--regenerate` - regenerate `setup.sql` (and `sv_repoint.sql` when `--sv-repoint`) first.
- `--sv-repoint` - after each pack's `setup.sql`, apply its `sv_repoint.sql` (rebinds the
  manifest `semantic_views` onto FLEET_APP; idempotent no-op once already repointed).
- `--probe` - report which packs resolve with data (the surfacing-gate signal).
- `--dry-run` - print the ordered plan only.

## Self-building packs (`derived` primitives)
A pack can REBUILD its analytic layer instead of facading pre-built physical DTs.
A `derived` entity computes from sibling pack objects via either:
- `expr` + `group_by` (simple rollups), or
- a `sql:` body (windows, sessionization, joins, H3, multi-step DAG). In `sql:` use
  `{src}` (the `derived_from` view) and `{schema}.VW_<NAME>` for siblings.
Entities emit in topological order (`derived_from` + `depends_on`). Any entity may set
`materialization: dynamic_table` and `replaces: <PHYSICAL_FQN>` (so SV-repoint rebinds the
absorbed DT). `dwell` is the reference self-building pack: one mapped telemetry leaf +
a derived DT chain reproducing the former `DT_*` outputs (verified bit-for-bit).


## Packs (all migrated to FLEET_APP)
| Pack | FLEET_APP schema | Consumers |
|------|------------------|-----------|
| route_deviation | FLEET_APP.ROUTE_DEVIATION | deviation_overview, deviation_routes; SV_ROUTE_DEVIATION |
| taxi | FLEET_APP.TAXI | taxi_overview, taxi_routes; SV_TAXIS |
| food_delivery | FLEET_APP.FOOD_DELIVERY | food_delivery; SV_FOOD_DELIVERY |
| retail_catchment | FLEET_APP.RETAIL_CATCHMENT | retail_catchment; SV_RETAIL_CATCHMENT |
| route_optimization | FLEET_APP.ROUTE_OPTIMIZATION | asset_velocity; SV_ASSET_VELOCITY |
| dwell | FLEET_APP.DWELL | dwell_overview/congestion/facilities/drivers/sla; SV_DWELL_ANALYTICS (self-building: derived DT chain) |
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
  FQN's last identifier, referenced by `relationships`/facts). The 3 committed
  `sv_repoint.sql` SVs all use aliased base tables, so the blind FQN replace is safe.
- SV-DDL source caveat: `sv_repoint.sql` rebinds an EXISTING semantic view's base tables;
  the SV CREATE DDL itself is not yet committed as a repo artifact. A truly-fresh account
  must create the 10 `SV_*` first (live source-of-truth), then `install.py --sv-repoint`
  converges them onto FLEET_APP.
