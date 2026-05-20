# scripts/

Maintainer-only helper scripts. **Not** part of the installer or runtime — these are one-shot tools used to (re)generate seed artifacts that ship in `datasets/`.

## Inventory

| Script | Purpose | Output |
|---|---|---|
| `region_catalog/build_boundaries.py` | Bakes Geofabrik `.poly` + BBBike bbox polygons (with ISO codes) into the region catalog parquet. Re-run when Geofabrik publishes new regions or boundaries change. | `datasets/region_catalog/data_0_0_0.snappy.parquet` |

## Conventions

- Each script must be runnable from repo root: `python3 scripts/<area>/<script>.py`
- Output artifacts live in `datasets/`, not `scripts/`
- Commit the script **and** its regenerated artifact in the same commit so the recipe stays in sync with the output
