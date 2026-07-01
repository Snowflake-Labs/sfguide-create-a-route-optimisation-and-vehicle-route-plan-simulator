# Data Studio Extension: branded first-party estate facts

The Location Diagnostics demo derives its commercial layer (revenue, EBITDA, interaction-type mix, sqft, rent) **synthetically and deterministically** in `scripts/analytic_layer.sql` (HASH-seeded over the store id, with `HH_20MIN` a real drive-time household count). That is enough to make the Site Impact and Closure Impact views run end-to-end from data the accelerator already has.

To make the demo reflect a customer's **real first-party data** - actual store sales, EBITDA, Home Visit / Sample / Walk-in splits, and a proper geodemographic segmentation (Experian Mosaic / CACI Acorn style) - extend the Data Studio generator instead of hand-loading tables. This keeps the "self-building, contract-bound data" tenet: the analytic layer stays derivable and reproducible.

## Where it fits

Data Studio generator modules live in:
```
.cortex/skills/install-fleet-apps/fleet_admin_app/ui/src/server/studio/engine/
  fleet.ts          # vehicles
  places.ts         # Overture POIs -> ROUTE_OPTIMIZATION.PLACES
  anchors.ts        # health facilities / key sites / depots (Overture)
  demographics.ts   # DIM_AREA_DEMOGRAPHICS (SafeGraph, US-only)
  ...
```
Each writes dataset-versioned rows into `SYNTHETIC_DATASETS.UNIFIED.*` keyed by `JOB_ID`, with the active row flagged in `FLEET_INTELLIGENCE.CORE.DIM_DATASETS` and consumed via `V_*_CURRENT` projection views (see the DIM_DATASETS / projection-view notes in `AGENTS.md`).

## Proposed `engine/estate.ts`

A new generator that produces a branded, versioned store estate + segmentation, so the LOCATION layer can bind to it instead of the SQL proxy.

Tables to add to `SYNTHETIC_DATASETS.UNIFIED` (via `server/studio/ensure-tables.ts`), all `JOB_ID`-scoped:

| Table | Grain | Key columns |
|---|---|---|
| `DIM_STORE` | one row per store | `STORE_ID, REGION, BRAND, STORE_NAME, STORE_ROLE (OWNED/CANDIDATE), LAT, LNG, GEOM, SQFT, ANNUAL_RENT, RATES` |
| `FACT_STORE_SALES` | store x interaction type x period | `STORE_ID, PERIOD, INTERACTION_TYPE (HV/SAMPLE/WALKIN), REVENUE, EBITDA, ORDERS, ATV, CONVERSION_PCT, MARGIN_PCT` |
| `DIM_SEGMENTATION` | household cell x segment | `AREA_ID (H3 or postcode), REGION, SEGMENT_CODE, SEGMENT_LABEL, DECILE, HOUSEHOLDS, GEOM` |

Generation approach (mirrors the existing modules):
- **Stores**: seed from Overture POIs of a chosen brand/category within the region boundary (reuse the `places.ts` Overture query + `REGION_CATALOG.BOUNDARY` join), or accept a customer-provided list.
- **Sales**: draw revenue/EBITDA/ATV/conversion from configurable per-region, per-interaction-type distributions (so the demo is plausible without real data), or `COPY INTO` the customer's export.
- **Segmentation**: assign each household cell a segment + decile. For a demo, derive deciles from address density (as the current proxy does); for real use, join a licensed Mosaic/Acorn postcode table.

## Binding the LOCATION layer to it

Add `V_DIM_STORE_CURRENT`, `V_FACT_STORE_SALES_CURRENT`, `V_DIM_SEGMENTATION_CURRENT` projection views (define in BOTH `projection_views.sql` and `init.ts` per the ownership rule in `AGENTS.md`), then change `BUILD_LOCATION_DIAGNOSTICS` in `scripts/analytic_layer.sql`:
- `STORES` reads `V_DIM_STORE_CURRENT` (real estate) instead of the deterministic POI subset.
- `STORE_FACTS` reads `V_FACT_STORE_SALES_CURRENT` aggregated to store level (real revenue/EBITDA/interaction split) instead of the HASH formulas; keep `HH_20MIN` from the isochrone household count.
- The gap / penetration workstream (deferred) reads `V_DIM_SEGMENTATION_CURRENT` for Mosaic decile penetration.

The isochrone, cannibalisation, and closure logic stay unchanged - only the estate/facts source seam moves from synthetic to first-party, exactly like the SAP connector repoints `UNIFIED_FLEET`. No app-view or semantic-view edits are needed because they bind the neutral `FLEET_APP.LOCATION` contract.
