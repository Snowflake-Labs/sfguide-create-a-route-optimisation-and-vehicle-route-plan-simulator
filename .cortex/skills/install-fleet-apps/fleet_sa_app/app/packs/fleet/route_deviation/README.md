# Route Deviation - data contract (pilot)

This domain pack demonstrates the Solution-Accelerator **data-contract** pattern: the
solution depends on a stable LOGICAL layer, not on physical table names. Synthetic data
is just one *source* behind that layer; pointing the solution at customer data is a
config + regenerate step, with **zero changes to dashboards or the semantic view**.

## Layers

```
data-model.yaml        logical entities + columns (the contract)
entity-mapping.yaml    binds logical -> a SOURCE (synthetic, the default)
        |  generate.py
        v
FLEET_APP.ROUTE_DEVIATION.*   generated views (the stable layer consumers bind to)
        ^
SV_ROUTE_DEVIATION + deviation_overview / deviation_routes dashboards
```

- `VW_TRIP_DEVIATION` - mapped 1:1 from the source.
- `VW_DRIVER_DEVIATION_SUMMARY`, `VW_DAILY_DEVIATION_TRENDS` - **derived** (solution-computed
  aggregates of `VW_TRIP_DEVIATION`; the customer maps only raw trips).
- `VW_CONFIG` - region/vehicle context.

## Files

| File | Purpose |
|------|---------|
| `data-model.yaml` | Logical entity/column contract (mapped / derived / context). |
| `entity-mapping.yaml` | Active source binding -> bundled synthetic data. |
| `entity-mapping.customer-demo.yaml` | Proof: a differently-shaped mock customer source (renamed cols, seconds, 0/1 flags, WKT paths). |
| `generate.py` | Deterministic mapping -> `CREATE VIEW` DDL generator (SA Phase-6 style). |
| `setup.sql` | Generated DDL for the active (synthetic) mapping; the deploy source of truth. |

## Point the solution at YOUR data

1. Copy `entity-mapping.yaml` and edit `source_table` / `source_column` / `transform`
   per logical column. Use `transform` for renames, unit conversions, type casts, and
   geometry normalization (e.g. `TO_GEOGRAPHY({src})`, `{src} / 60.0`, `(flag = 1)`).
   Leave derived entities as `materialization: derived`.
2. Regenerate and deploy:
   ```
   python3 generate.py --mapping entity-mapping.<your>.yaml --out setup.<your>.sql
   snow sql -c <conn> -f setup.<your>.sql
   ```
3. Done. `SV_ROUTE_DEVIATION` and the `deviation_overview` / `deviation_routes`
   dashboards bind to `FLEET_APP.ROUTE_DEVIATION.*` and need no changes.

## Verified swap (proof)

Regenerating with `entity-mapping.customer-demo.yaml` (a source with renamed columns,
durations in seconds, 0/1 flags, and WKT path strings) reproduced **identical** results
vs the synthetic-direct path - including geometry length and total time-lost - confirming
the transforms reconstruct exactly and the contract is source-agnostic:

| metric | synthetic-direct | FLEET_APP (customer-demo) |
|--------|------------------|---------------------------|
| total trips | 394 | 394 |
| deviated trips | 44 | 44 |
| excess km | 727 | 727 |
| time lost (min) | 1419.1 | 1419.1 |
| sum(ST_LENGTH actual_path) | 78,649,845 | 78,649,845 |

## Notes
- Grants in `fleet_sa_app/app/role_binding.sql` (FLEET_APP schema). `generate.py` also emits them.
- This pack seeds the 4C domain-pack layout (`packs/fleet/<domain>/`); the generator and
  contract format generalize to the other fleet domains.
