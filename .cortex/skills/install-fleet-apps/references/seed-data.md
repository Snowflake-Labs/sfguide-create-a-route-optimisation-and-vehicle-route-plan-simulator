# Data layer: reuse-else-seed (agnostic)

The dashboards and Cortex Analyst read agnostic fleet rows from
`SYNTHETIC_DATASETS.UNIFIED.*` and `FLEET_INTELLIGENCE.*`. These are the SAME
tables the legacy demos use, so an account that already generated data (via the
control app's Data Studio or a prior install) is reused as-is.

## 1. Probe (reuse if present)

```sql
SELECT
  (SELECT COUNT(*) FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS)              AS datasets,
  (SELECT COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS)            AS trips,
  (SELECT COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY) AS telemetry;
```

If `datasets > 0 AND trips > 0` -> REUSE; skip the create path entirely. The
orchestrator wraps this probe and treats any error (missing object) as "absent".

## 2. Create path (standalone seed)

Used only when the probe finds no rows. Loads the canonical SF / ebike preset --
a mode-AGNOSTIC dataset (`VEHICLE_TYPE = ebike` is just a data dimension):

1. **Ensure base tables + FLEET-owned stage** - run `scripts/seed_data.sql`
   (creates `SYNTHETIC_DATASETS.UNIFIED`, `FLEET_INTELLIGENCE.CORE`, the FLEET
   seed stage, and the parquet file format). Base table DDL is created by the
   admin app boot (`fleet_admin_app/.../server/studio/ensure-tables.ts`) or the
   routing engine; the orchestrator ensures it before loading.
2. **Stage the parquet payload** -
   ```bash
   snow stage copy datasets/ @FLEET_INTELLIGENCE.CORE.SEED_DATA_STAGE/ -c <conn> --overwrite
   ```
3. **Load** - run the canonical loader with its stage name retargeted to the
   FLEET-owned stage so no `OPENROUTESERVICE_APP` object is required:
   ```bash
   sed 's|OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE|FLEET_INTELLIGENCE.CORE.SEED_DATA_STAGE|g; s|OPENROUTESERVICE_APP.CORE.PARQUET_FF|FLEET_INTELLIGENCE.CORE.PARQUET_FF|g' \
     datasets/load-seed-data.sql | snow sql -c <conn> -i
   ```
   The loader lives at repo-root `datasets/` (NOT under any skill folder),
   so it survives deprecation of the routing-engine skill.
4. **Agnostic guard** - re-run `scripts/seed_data.sql`; its step 3 PURGES any
   industry-vertical rows the loader created (freight offers, partners, partner
   history, and the MARKETPLACE/BACKLOAD/DHL schemas) so only agnostic data
   persists.

## Agnostic scope of the seed

| Loaded (agnostic) | Purged / not loaded (vertical) |
|---|---|
| `FACT_TRIPS`, `FACT_VEHICLE_TELEMETRY`, `DIM_FLEET`, `DIM_POIS`, `DIM_TRIP_SCHEDULE`, `DIM_DATASETS`, `GENERATION_JOBS`, `ROUTE_OPTIMIZATION.{PLACES,LOOKUP,CONFIG}` | `FACT_FREIGHT_OFFERS`, `DIM_PARTNERS`, `FACT_PARTNER_HISTORY`, `MARKETPLACE.*`, `BACKLOAD_MATCHING.*`, `DHL_NTBO.*` |

This feeds the agnostic packs: `unified_fleet`, `fleet_ops`, `dwell`,
`route_deviation`, `route_optimization`.

## Catchment note

The `catchment` pack reads `FLEET_INTELLIGENCE.CATCHMENT.{POIS,CITIES_BY_STATE,REGIONAL_ADDRESSES}`,
which are NOT part of this seed (they are normally ingested from Overture Maps
shares). The catchment dashboard surfaces only once those base tables hold rows;
until then the rest of the agnostic stack is unaffected.
