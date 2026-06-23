# Routing engine: native, owned by install-fleet-apps

This skill **owns** both the neutral routing seam `ROUTING_PLATFORM.CONTRACT.*`
(`routing_platform/setup.sql`, applied by the orchestrator) **and** the live
ORS/VROOM engine build (Phase C). Consumers and the synapse User verbs bind to
the contract, never to a named engine — so the engine is a swappable provider
behind the seam (TENETS.md tenet 1), while remaining fully self-contained here.

The engine keeps the `OPENROUTESERVICE_APP.CORE` runtime namespace. That DB name
is an implementation detail hidden by the `ROUTING_PLATFORM.PROVIDERS` adapters
(`ORS_*_RAW`); Phase C relocated the *build scripts that create* those objects
into this skill without renaming the created objects.

## Detection (run by install_fleet_apps.sh, layer 3)

```sql
SHOW SERVICES IN DATABASE OPENROUTESERVICE_APP;  -- expect ORS_SERVICE_* + ROUTING_GATEWAY_SERVICE
```

| Engine state | Result |
|---|---|
| Services present | Routing verbs are LIVE (directions, isochrones, optimization, matrix, find_poi, catchment). |
| Absent, `--with-engine` set | Engine is built + provisioned natively (see below), then verbs go LIVE once `ORS_SERVICE_<region>` finishes building its graph. |
| Absent, no flag | Routing verbs install but are INERT. Analytics dashboards + Cortex Analyst + agents are UNAFFECTED. |

## Native provisioning (`--with-engine`)

When the engine is absent and `--with-engine` (or `PROVISION_ENGINE=1`) is set,
layer 3 runs `scripts/provision_engine.sh <connection>`, which:

1. Ensures `OPENROUTESERVICE_APP` infra (DB, `CORE` + `TRAVEL_MATRIX` schemas,
   image repository, `ORS_SPCS_STAGE` / `ORS_GRAPHS_SPCS_STAGE` /
   `ORS_ELEVATION_CACHE_SPCS_STAGE`, `ROUTING_ANALYTICS` warehouse) — all
   `IF NOT EXISTS`, independent of whatever infra the app images use.
2. Validates engine image tags (`scripts/check_image_versions.sh`).
3. Builds + pushes the 4 engine images to `OPENROUTESERVICE_APP.core.image_repository`
   (`references/build-images.md`): `openrouteservice`, `downloader`,
   `routing_reverse_proxy`, `vroom-docker`.
4. Stages the map (`SanFrancisco.osm.pbf`), `ors-config.yml`, `download_map.py`,
   and the downloader/gateway service specs to `@ORS_SPCS_STAGE`.
5. Loads SQL modules `01_core_infra` … `08_observability`, `15_route_optimization_seed`
   via `scripts/run_sql_module.sh` (fail-fast), then resumes the observability tasks.
6. The tail of `03_region_management.sql` bootstraps the default region
   (SanFrancisco) via the per-region ORS + VROOM creation path.

This is HEAVY (4 image builds + a region graph, tens of minutes). It is off by
default and skipped automatically when an engine is already present. ARM-Mac
podman / stuck-push (`crane`) caveats are in `references/troubleshooting.md`.

### Invariants preserved verbatim (do not break in a move)
- **AUTO_SUSPEND_SECS**: engine services pin to `0` only while a region graph or
  matrix build is active; restored to the steady-state default on every exit.
  `OPENROUTESERVICE_APP.CORE.RECONCILE_AUTO_SUSPEND()` is the idempotent safety net.
- **REBUILD_GRAPHS reuse**: graphs persist on `@ORS_GRAPHS_SPCS_STAGE/<region>/`
  and are reused across suspend/resume; the provisioner flips the flag to `false`
  after the first build so resumes are fast.
- **Per-region VROOM**: each region gets `VROOM_SERVICE_<REGION>` co-located in
  `ORS_POOL_<REGION>`; the gateway resolves `vroom-service-<region>` per region.

## After provisioning

`ORS_SERVICE_<region>` takes 5–15 min to build graphs on first boot. Re-running
`install_fleet_apps.sh` (idempotent) re-detects the engine and reports LIVE;
nothing else re-installs. Confirm health with
`ROUTING_PLATFORM.CONTRACT.ROUTING_STATUS()`.

## What is fully self-contained now

| Capability | Owned here? |
|---|---|
| SA app + Admin console UI, dashboards, Cortex Analyst | Yes |
| FLEET_APP data contract, packs, roles, agents, synapse MCP servers | Yes |
| Routing contract seam (`ROUTING_PLATFORM.CONTRACT`) | Yes |
| LIVE routing verbs (directions/isochrone/VRP/matrix) | Yes (`--with-engine`) |
| Dynamic data generation (Data Studio) | Yes (FLEET_ADMIN_APP) |

There is no external skill dependency for any of the above — `build-routing-solution`
has been retired (Phase C).
