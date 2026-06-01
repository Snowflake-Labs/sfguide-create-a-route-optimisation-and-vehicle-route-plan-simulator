# Synthetic Innovage Dataset Generator

The `EMERGENCY_RESPONSE.CORE.GENERATE_INNOVAGE_DATASET(REGION_NAME)` procedure (defined inline in `sql-pipeline.sql`) populates the four core entity tables using:

- `OPENROUTESERVICE_APP.CORE.REGION_CATALOG.BOUNDARY` for the active region polygon (per AGENTS.md "Prefer Boundary Polygons over Bounding Boxes" rule).
- `public_data.us_addresses` (NAD) for realistic address points (lat/lon present).
- ACS pct_age_65_plus weighting (optional Phase 2; v1.0.0 uses uniform sampling).

## Tables populated

| Table | Source | Notes |
|---|---|---|
| `CORE.PARTICIPANTS` | NAD addresses inside region BOUNDARY | Frailty 40-95, 15% require lift, 4-language mix |
| `CORE.STAFF` | NAD addresses inside region BOUNDARY | 5 role types, assigned to a center |
| `CORE.CENTERS` | Random NAD addresses (or Overture `health` POIs in Phase 2) | 60% have generators, 30% are shelters |
| `CORE.DRIVERS` | NAD addresses, mostly ON_SHIFT | Schema mirrors `fleet-intelligence-taxis` |

## Frailty score model

```
FRAILTY_SCORE = UNIFORM(40, 95)
```

Phase 2 will replace this with an ACS-weighted score:

```
FRAILTY_SCORE = 50 + 30 * (pct_age_65_plus_in_tract / 100) + 20 * (pct_disability / 100)
```

## Re-run safely

The procedure starts with `TRUNCATE TABLE` for all four entities, so it is fully idempotent. Re-run after changing `CONFIG.PARAMS.NUM_PARTICIPANTS` etc.
