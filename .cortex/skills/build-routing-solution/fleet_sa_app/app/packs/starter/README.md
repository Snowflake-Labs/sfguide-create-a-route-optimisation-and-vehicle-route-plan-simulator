# Neutral starter pack

A domain-agnostic reference app built entirely on the platform primitives, with
**no fleet, vehicle, trailer, or routing vocabulary**. It proves a non-fleet
domain can be authored on the data-contract + app-bundle pattern with **zero edits
to the app core**.

## What it is
- **Entities:** `LOCATIONS` (named, categorized places) and `MOVEMENTS`
  (origin -> destination moves with distance + duration), plus a derived
  `MOVEMENT_DAILY` rollup.
- **Data source:** the neutral SF substrate `SYNTHETIC_DATASETS.NEUTRAL.*`
  (a zero-copy relabeling of the bundled San Francisco synthetic dataset). The
  mapped leaves are pass-throughs because the substrate columns are already neutral.
- **Contract DB:** `STARTER_APP.CORE` (`VW_LOCATIONS`, `VW_MOVEMENTS`,
  `VW_MOVEMENT_DAILY`) + `STARTER_APP.SEMANTIC.SV_STARTER`.
- **App bundle:** `app/starter/{app-config.json, app-views.json, agent-spec.json}`
  with `domainPacks: []` and pure-YAML dashboards (no custom TSX).

## Files
| File | Purpose |
|------|---------|
| `data-model.yaml` | logical entities/columns (the contract) |
| `entity-mapping.yaml` | binds the contract to the neutral SF substrate |
| `setup.sql` | generated DDL (do not hand-edit) |
| `sv_starter.sql` | committed semantic-view DDL (the "SV as source" reference) |
| `../_substrate/neutral-sf.sql` | the neutral substrate the pack maps from |
| `../../starter/` | the app bundle (config + dashboards + agent-spec) |

## Build / apply
```bash
# 1. neutral substrate (once)
snow sql -c <conn> -f ../_substrate/neutral-sf.sql
# 2. generate + apply the contract
python3 ../_lib/generate.py --model data-model.yaml --mapping entity-mapping.yaml --out setup.sql
snow sql -c <conn> -f setup.sql
# 3. semantic view
snow sql -c <conn> -f sv_starter.sql
```

## Swap to your own data
Repoint `entity-mapping.yaml` `source_table` to your tables (replace
`passthrough: true` with an explicit `mapping:` + transforms), regenerate, and
re-apply. Consumers (dashboards + `SV_STARTER`) do not change.

## Live demo (config-stage rotation)
The live `FLEET_SA_APP` serves the fleet bundle from its config stage. To demo the
starter live without a second service: upload `app/starter/app-config.json` +
`app-views.json` to `@FLEET_INTELLIGENCE.SYNAPSE_USER.FLEET_APP_STAGE/config/`,
suspend/resume the service, verify, then restore the fleet bundle.
