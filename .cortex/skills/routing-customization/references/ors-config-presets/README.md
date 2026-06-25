# ORS Configuration Presets

Annotated, validated `ors-config.yml` templates that replace the most common edits users currently make by hand to the live file. Picking a preset is safer than copy-pasting from the forum and easier than understanding every nested key.

> Source-of-truth: when the ORS engine guardrails widen via a preset, the gateway-side request-size guardrails added in **#51** must read from the same file. There is **one** active config per region, and limits there are authoritative.

## Available presets

| Preset | Use when | Notes |
|---|---|---|
| [`standard.yml`](standard.yml) | Single city / region (San Francisco, Munich, Berlin). Default for new installs. | Mirrors the values baked into `staged_files/ors-config.yml`. Driving-car + e-bike enabled (HGV opt-in via `hgv.yml`), isochrone range capped at 5 h / 1 500 km. |
| [`hgv.yml`](hgv.yml) | Trucking-heavy demos with long-distance HGV legs across a single region. | Enables `driving-hgv` with full HGV preparation; relaxes `maximum_distance` to 100M for cross-state trips inside the region. |
| [`bikes.yml`](bikes.yml) | Cycling, food-delivery e-bike, and last-mile demos. | Enables all four cycling profiles + `foot-walking`. Tightens HGV/car if you do not need them (faster builds, smaller graphs). |
| [`continental.yml`](continental.yml) | Continental extracts — entire USA, EU, or a multi-country region. **Opt-in only.** | Sets `graphs_data_access: MMAP`, an explicit `maximum_snapping_radius: 5000`, and `maximum_waypoints` raised to 5000. Pair with `INSTANCE_FAMILY = HIGHMEM_X64_M` (or larger) on the per-region compute pool. |

## How a preset is applied

Presets are applied **per region**. The flow is:

1. Choose the preset from this folder.
2. Either:
   - **One-shot** for the default region: copy the chosen file over `staged_files/ors-config.yml` and re-deploy the ORS image.
   - **Per-region** (recommended for multi-region installs): pass the preset filename when calling `PROVISION_REGION_WRAPPER(...)`. The procedure stages a region-specific copy under `@ORS_GRAPHS_SPCS_STAGE/<region>/config/ors-config.yml` before starting the build.
3. Trigger a graph rebuild for the affected region — preset changes are honoured only on a fresh graph build (the persisted graph encodes the build-time profile/preparation settings).

## Cross-preset invariants

All presets in this folder satisfy the same invariants, so it is safe to swap between them:

- `ors.engine.profile_default.build.instructions: false` — turn-by-turn text is generated client-side.
- `ors.engine.profile_default.service.maximum_distance: 100000000` — gateway-side guardrails enforce realistic caps; the engine limit is a hard backstop.
- `ors.endpoints.matrix.maximum_routes_flexible: 2000000` — large matrix calls succeed; the gateway pre-rejects payloads above the region's documented per-call cap (see #51).
- `ors.endpoints.isochrones.maximum_locations: 2`, `maximum_intervals: 10` — keep isochrone payloads small enough to fit the gateway timeout budget.

## Choosing the right preset by demo

| Skill | Recommended preset |
|---|---|
| `route-optimization`, `fleet-intelligence-car` | `standard` |
| `fleet-intelligence-ebike`, `retail-catchment` | `bikes` |
| `backload-matching`, `freight-exchange` | `hgv` |
| Any demo running on a continental region (USA, EU) | `continental` |

## Related issues

- **#54** — this folder.
- **#43** — US `connection_failed` on long routes; install the `continental` preset for the US region.
- **#51** — gateway-side guardrails read limits from the active preset (single source of truth).
- **#52** — graph-build preflight uses preset metadata to flag under-provisioned pools.
