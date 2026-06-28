# Phase C - Absorb the ORS engine substrate into install-fleet-apps

> Goal: make `install-fleet-apps` able to build and deploy the live ORS/VROOM
> routing engine end-to-end, so `build-routing-solution` can be deleted with
> ZERO loss of capability (live routing verbs + dynamic Data Studio generation).
> After Phase C, `install-fleet-apps` is fully self-contained and deletion-proof.

This is the optional, largest, highest-risk slice deferred from the
`install-fleet-apps-agnostic-primary` plan (Phases A+B are DONE on
`feature/sa-synapse-app`). Run it in a fresh context using the kickoff prompt at
the bottom.

## Current state (post Phase A+B)

- `install-fleet-apps` OWNS: `fleet_sa_app/`, `fleet_admin_app/` (incl. the Data
  Studio generation engine under `ui/src/server/studio/`), `fleet_tools/`,
  `routing_platform/setup.sql` (the neutral `ROUTING_PLATFORM.CONTRACT` seam),
  the two deploy scripts, `infra.sql`, `seed_data.sql`, `create_agents.sh`,
  `install_synapse_bundles.sh`, `install_fleet_apps.sh`.
- `build-routing-solution` STILL OWNS the engine substrate:
  - SQL modules `openrouteservice_app/app/modules/{01_core_infra,02_routing_functions,03_region_management,04_service_lifecycle,05_matrix_pipeline,06_matrix_ops,07_studio_jobs,08_observability,15_route_optimization_seed}.sql`
  - 4 engine Dockerfiles/service dirs `openrouteservice_app/services/{downloader,gateway,openrouteservice,vroom}/` (+ the legacy Vite `ors_control_app/`)
  - `scripts/deploy.sh` (171 lines), `scripts/run_sql_module.sh`, `scripts/download_map.py`, `scripts/check_image_versions.sh`
  - engine image tags in `openrouteservice_app/image-versions.env` (OPENROUTESERVICE_TAG, DOWNLOADER_TAG, ROUTING_REVERSE_PROXY_TAG, VROOM_DOCKER_TAG, OPENROUTESERVICE_BASE_TAG, VROOM_BASE_TAG)
  - the runtime namespace `OPENROUTESERVICE_APP.CORE.*` (services, procs `PROVISION_REGION_WRAPPER`, `create_region_ors_service`, `create_region_vroom_service`, matrix builders, `RECONCILE_AUTO_SUSPEND`, `_*_RAW` functions) that `ROUTING_PLATFORM.PROVIDERS.ORS_*_RAW` dispatches to.

## Key design decision (recommended)

KEEP the runtime namespace name `OPENROUTESERVICE_APP.CORE` (do NOT rename the
engine DB). The `ROUTING_PLATFORM.PROVIDERS` adapters already abstract it, so the
DB name is an implementation detail. Phase C RELOCATES the *build scripts that
create* those objects into `install-fleet-apps`; the created objects keep their
current FQNs. This avoids touching hundreds of `OPENROUTESERVICE_APP.CORE`
references across modules, the gateway, VROOM config, Data Studio, and the
contract providers.

Rationale: renaming the engine DB is a separate, enormous refactor with no user
benefit (the seam already hides it). Absorption = ownership of the build flow,
not a namespace rename.

## Implementation steps

### C1. Relocate the engine substrate (git mv, keep FQNs)
- `git mv` into the skill:
  - `build-routing-solution/openrouteservice_app/app/modules/` -> `install-fleet-apps/openrouteservice_app/app/modules/`
  - `build-routing-solution/openrouteservice_app/services/{downloader,gateway,openrouteservice,vroom}/` -> `install-fleet-apps/openrouteservice_app/services/`
  - `build-routing-solution/scripts/{deploy.sh,run_sql_module.sh,download_map.py,check_image_versions.sh}` -> `install-fleet-apps/scripts/`
  - any `openrouteservice_app/app/setup*.sql` / module driver + `datasets/` references the engine build needs.
- Decide the fate of the legacy Vite `ors_control_app/`: it is superseded by
  `fleet_admin_app` (R7 cutover). RECOMMEND: do NOT relocate it; mark it for
  deletion (its only remaining unique capability is the engine build console,
  now in fleet_admin_app). Confirm fleet_admin_app covers region/matrix/Data
  Studio before deleting.

### C2. Merge engine image tags into the owned image-versions.env
- Add OPENROUTESERVICE_TAG / DOWNLOADER_TAG / ROUTING_REVERSE_PROXY_TAG /
  VROOM_DOCKER_TAG / *_BASE_TAG to `install-fleet-apps/image-versions.env`
  (next to FLEET_SA_APP_TAG / FLEET_ADMIN_APP_TAG).
- Relocate `check_image_versions.sh` and repoint its file paths + the
  `image-versions.env` location to the skill.

### C3. Repoint deploy.sh + module driver paths
- `deploy.sh`, `run_sql_module.sh`, and any module loader compute paths relative
  to `build-routing-solution`; repoint REPO_ROOT-relative paths to
  `install-fleet-apps`. The engine still creates `OPENROUTESERVICE_APP.*` objects
  (unchanged SQL), just driven from the new location.
- Update `.gitignore` negations / build-output ignores that referenced
  `build-routing-solution/openrouteservice_app/...`.
- FIX the pre-existing xref-eval crash: the eval follows a link to the gitignored
  `build-routing-solution/native_app/output/deploy/setup_script.sql`. After
  relocation, repoint or remove that reference (and consider making
  `evals/lib/xref_eval.py` skip missing gitignored build artifacts gracefully).

### C4. Wire engine provisioning into install_fleet_apps.sh (layer 3)
- Replace the Phase-B "detect -> delegate to build-routing-solution" branch with
  a real provisioning path: when the engine is absent and live routing is wanted,
  call the relocated `deploy.sh` (engine build/push of the 4 images) + the
  module load (`01..08`,`15`) + `PROVISION_REGION_WRAPPER(<region>)`.
- Keep it OPTIONAL/gated behind a flag (e.g. `--with-engine` or
  `PROVISION_ENGINE=1`) because building 4 SPCS images + a region graph is heavy
  (tens of minutes) and many installs reuse an existing engine.
- Preserve the AUTO_SUSPEND_SECS invariant + REBUILD_GRAPHS reuse logic
  (documented in the old AGENTS.md "Common Patterns") - these procs move as-is.

### C5. Update routing-engine.md + the contract providers note
- `references/routing-engine.md`: replace the "delegate to build-routing-solution"
  section with "install_fleet_apps.sh --with-engine provisions it natively".
- Confirm `routing_platform/setup.sql` PROVIDERS still point at
  `OPENROUTESERVICE_APP.CORE._*_RAW` (unchanged) - no edit expected.

### C6. Retire build-routing-solution
- Once the engine builds + provisions from `install-fleet-apps` and a region
  routes end-to-end, DELETE `build-routing-solution/` (or reduce its SKILL.md to
  a 3-line tombstone pointing at `install-fleet-apps`).
- Remove it from the AGENTS.md inventory + dependency graph (install-fleet-apps
  becomes the sole infrastructure skill). Update `routing-customization`,
  `route-optimization`, and the legacy demo skills' `depends_on` to point at
  `install-fleet-apps` (or relocate/delete those legacy vertical demos per the
  agnostic direction).
- Move the engine-specific AGENTS.md "Common Patterns" + "Control App Image
  Deployment" + "AUTO_SUSPEND_SECS Invariant" sections to the skill, repointing
  `ors_control_app` references to the engine services that remain
  (gateway/ors/vroom/downloader); drop the legacy Vite control-app section.

### C7. Optional: relocate ROUTING_MCP to a FLEET-owned schema
- Today the User synapse bundle installs into `OPENROUTESERVICE_APP.ROUTING`. If
  full DB-name independence is wanted, move it to e.g.
  `ROUTING_PLATFORM.ROUTING` and update `install_synapse_bundles.sh` + the
  consumer `agent-spec.json` `mcp_servers` + `role_binding.sql`. Low priority
  (seam already abstracts execution); skip unless the OPENROUTESERVICE_APP name
  must disappear entirely.

## Verification
- Fresh-account test (no OPENROUTESERVICE_APP): `install_fleet_apps.sh
  --connection <c> --with-engine` builds the 4 engine images, loads modules,
  provisions one region, and `ROUTING_PLATFORM.CONTRACT.ROUTING_STATUS()` reports
  healthy; `get_directions` / `optimize_routes` verbs return live geometry.
- Reuse test (engine already present): `--with-engine` detects + skips the build.
- Data generation: FLEET_ADMIN_APP Data Studio generates a dataset end-to-end
  with build-routing-solution absent.
- `grep -r build-routing-solution` across the repo returns only historical
  doc/tombstone references; no functional path depends on it.
- `python3 .cortex/skills/evals/run_evals.py` runs to completion (xref crash
  fixed in C3) and install-fleet-apps passes.
- `check_image_versions.sh` (relocated) validates all 6 engine tags + 2 app tags
  against the service YAMLs.

## Risks / watch-outs
- Heaviest churn is C1/C3 (path repoints across deploy.sh, module loaders, the
  gateway/vroom config that reads ORS_HOST, and the `init.ts` boot of the engine
  services). Grep for `build-routing-solution/openrouteservice_app` after the move.
- The 4 engine images are large; ARM-Mac podman/esbuild caveats from the old
  AGENTS.md "Control App Image Deployment" apply (crane fallback for stuck pushes).
- Preserve the AUTO_SUSPEND_SECS + REBUILD_GRAPHS + per-region VROOM invariants
  verbatim - they are correctness-critical and easy to break in a move.
- Do NOT rename OPENROUTESERVICE_APP.CORE; that is explicitly out of scope (C7 is
  the only optional namespace move, limited to the MCP server).

## Out of scope
- Renaming the OPENROUTESERVICE_APP engine database.
- Re-architecting region/matrix provisioning (move as-is).
- The legacy vertical demo skills (taxis/food/retail/backload/freight/dhl) -
  decide separately whether to relocate or delete under the agnostic direction.
