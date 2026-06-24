# install-fleet-apps — Friction-Status Assessment & Source Hardening

- **Date:** 2026-06-24 12:42
- **Skill:** install-fleet-apps
- **Connection:** n/a (static source audit + source edits; no live install run)
- **Role:** n/a
- **Warehouse:** n/a
- **Outcome:** COMPLETED_WITH_WORKAROUNDS (source-only; live clean-account validation DEFERRED per user)

## Purpose

Verify whether the friction points from the three most recent from-scratch logs
(`2026-06-23_23-07`, `2026-06-24_02-05`, `2026-06-24_07-30`) are addressed in source,
fix anything still open, and identify what is needed for a correct from-scratch install.
Per plan `verify-clean-install-frictions.plan.md`.

## Friction status (recent logs cross-checked against current source)

| Friction (log) | Fix location | Status |
|---|---|---|
| F1/F2 02-05, F4 06-23 — loader aborts on missing `ROUTING_ANALYTICS` / `OPENROUTESERVICE_APP` / `ROUTE_OPTIMIZATION.PLACES` | `scripts/seed_data.sql` (warehouse + engine-DB + REGION_CATALOG + PLACES/LOOKUP stubs) | FIXED |
| F3 02-05 — `install.json` dirties tree, blocks app deploy guard | `.gitignore:57` `**/_installed/**/install.json` | FIXED |
| F5 02-05 — routing contract applied before engine -> 0 functions | orchestrator `[3/8]` "Engine FIRST then contract" | FIXED |
| F1 07-30 — `docker push` SPCS manifest hang | `provision_engine.sh` auto crane fallback (`USE_CRANE_PUSH`) | FIXED |
| F2 07-30 — podman preferred / 2 GB OOM | `provision_engine.sh` docker-first + <4 GB warn; documented `SKILL.md:42-43` | FIXED |
| F3 07-30 — `SKIP_DATA=1` skips DIM_FLEET stamp + projection views | catalog+projection moved to `[2.5/8]`, decoupled from `SKIP_DATA` (own `SKIP_PROJECTIONS`) | FIXED |
| F4 07-30 + F4 02-05 — `COMPUTE_POOL` unbound under `SKIP_INFRA` | infra step always resolves `COMPUTE_POOL`; guard at apps step (`:?`) | FIXED |
| F5 07-30 — contract grants `FLEET_APP_USER` before roles exist | roles pre-created at `[0.5/8]` before packs/contract | FIXED |
| F6 07-30 — `FLEET_INTELLIGENCE.SEMANTIC` grant on nonexistent schema | `semantic_views.sql` creates the schema at `[4.5/8]` (first DDL) before role grants `[6/8]` | FIXED |
| F7b 07-30 — no-arg `ROUTING_STATUS()` reported `ors-service-europe` | source already `DEFAULT_REGION_NAME: SanFrancisco` (gateway yaml + app); was a stale live value | NO ACTION (source correct) |
| F1-F11 06-23 (10 source fixes) | all committed (`--recursive`, `--format=CSV`, legacy control-app removal, loader stubs, pack resolver, substrate, projection views, catalog, best-effort packs, role ordering) | FIXED |

## Friction Points (this session)

### F1: Seed stage copy had no 0-file sanity check + looked stalled (F7a from 07-30)

- **Step:** `[2/8]` data
- **Severity:** Low
- **What happened:** The recursive `snow stage copy` of the ~85 MB `datasets/` tree
  has no post-copy verification; a silent 0-file upload would only surface much later
  as empty tables. It also runs file-by-file with no progress output, looking stalled.
- **Resolution:** Added a post-copy `LIST @...SEED_DATA_STAGE` + `RESULT_SCAN` COUNT that
  hard-fails (matching the existing `exit 1` pattern) when 0 files are staged, plus a
  one-line "expect a few minutes" duration note before the copy. Commit
  `fix(install-fleet-apps): seed-stage file-count sanity check + duration note (F7a)`.
- **Recommendation:** Done.

### F2: `vehicle_profile_catalog.sql` car OPERATING_MODE drift vs TS source of truth

- **Step:** `[2.5/8]` vehicle-profile catalog
- **Severity:** Low (value-only; default seed is the ebike preset, not car)
- **What happened:** Static drift audit of the SQL port against
  `fleet_admin_app/.../studio/vehicle-profile-catalog.ts` found the `car` row's
  `OPERATING_MODE` set to `'driving'` in SQL vs `'urban_mobility'` in TS
  (hgv->`trucking` and ebike->`food_delivery` already matched). Categorical value mismatch.
- **Resolution:** Changed the SQL port's car row to `'urban_mobility'`. Commit
  `fix(install-fleet-apps): align car OPERATING_MODE with TS source of truth`.
- **Recommendation:** Done.

### F3: VEHICLE_SUBTYPE / HAZMAT bulk-stamp fidelity gap (TOLERATED, not fixed)

- **Step:** `[2.5/8]` vehicle-profile catalog
- **Severity:** Info
- **What happened:** The TS generator stamps `DIM_FLEET.VEHICLE_SUBTYPE` per-vehicle via a
  hash-bucketed distribution and sets `HAZMAT=TRUE` for ~18% of TANKER-subtype hgv vehicles.
  The SQL bulk-stamp leaves `VEHICLE_SUBTYPE` NULL and `HAZMAT` always FALSE (it only reads
  mode-level catalog columns, not per-vehicle randomization).
- **Resolution:** Left as-is. Columns exist (no "invalid identifier"); the 02-05 clean run
  proved packs tolerate NULL VEHICLE_SUBTYPE (the substrate ASSETS view dropped that column
  in 06-23 F6), and the default ebike preset has no subtypes and HAZMAT_PROB=0. Faithfully
  reproducing per-vehicle hash distribution in a bulk SQL UPDATE is out of scope and risky.
- **Recommendation:** Accept as a documented SQL-port fidelity gap; only matters for hgv
  datasets, which are not the default seed. Revisit only if a pack hard-requires non-NULL
  VEHICLE_SUBTYPE on the agnostic path.

### Drift audit — clean (no action)

- `scripts/analytic_layer.sql`: NO clean-install dependency risk — all sources resolve to
  earlier orchestrator steps (seed_data -> loader -> projection_views -> self) or Overture
  Marketplace shares acquired idempotently within the file. No demo-skill / init.ts coupling.
- `scripts/projection_views.sql`: 5 shared `V_*_CURRENT` views identical to `init.ts`; the 3
  freight/partner views are intentionally + documentedly omitted (their base tables are
  purged on the agnostic path). No accidental drift.

## Step Timing

| Step | Status | Notes |
|------|--------|-------|
| 1: F7a sanity-check edit + commit | OK | `install_fleet_apps.sh`, bash -n clean, pushed |
| 2: Drift audit (3 parallel explore agents) | OK | analytic_layer / projection_views clean; vehicle_profile_catalog 3 drifts |
| 2b: car OPERATING_MODE fix + commit | OK | pushed |
| 3: Clean-account --with-engine validation | DEFERRED | user chose to skip the destructive ~75-90 min run |
| 4: This assessment log + memory refresh | OK | |

## Summary

- **Live install run:** none (deferred per user).
- **Recent-log frictions:** all addressed in source; F7b needed no action; F7a fixed this session.
- **New source fixes this session:** 2 (F7a seed-stage sanity check + duration note; car
  OPERATING_MODE drift). 1 tolerated fidelity gap documented (VEHICLE_SUBTYPE/HAZMAT).
- **Open validation gap:** the post-07:30 commits (F1-F6) plus this session's 2 edits have NOT
  been proven together in a single clean-account `--with-engine` pass. Static review found no
  remaining clean-install blockers, but an end-to-end run is still the only proof.
- **Recommendations count:** 0 new actionable skill changes beyond the 2 fixes already applied.
