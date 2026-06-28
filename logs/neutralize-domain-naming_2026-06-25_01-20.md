# Neutralize Domain Naming - Execution Log

- **Date:** 2026-06-25 01:20
- **Skill/Plan:** `.snowflake/cortex/plans/neutralize-domain-naming.plan.md`
- **Connection:** fleet_test_evals (account wgb26798)
- **Role:** ACCOUNTADMIN
- **Warehouse:** MY_WH
- **Outcome:** COMPLETED_WITH_WORKAROUNDS

## Issues

### Issue 1: Plan understated the `mode` blast radius (OPERATING_MODE branches)

- **Step:** Tier A (presets)
- **Severity:** ERROR (caught before edit; would have been a silent data bug)
- **Category:** DOCS_GAP

**What happened:**
The plan asserted "nothing branches on ids/modes" and listed only `TENETS.md:124` as a
mode reference. In fact the preset `mode` value flows into the `OPERATING_MODE` column
(`inserters.ts:137` → `DIM_FLEET`; `vehicle-profile-catalog.ts:95` + `vehicle_profile_catalog.sql`
→ `DIM_VEHICLE_PROFILE`), and `OPERATING_MODE = 'trucking'` is branched on to assign HGV
truck dimensions (HAZMAT/HEIGHT_M/LENGTH_M/WIDTH_M/AXLELOAD_T/WEIGHT_TONS/VEHICLE_SUBTYPE)
in `route_optimization/setup.sql`, `route_optimization/data-model.yaml`, `fleet_admin_app/.../init.ts`,
and `route-optimization/references/extend-dim-fleet-hgv.sql`. Renaming `mode: 'trucking'`
without updating those `= 'trucking'` branches would have silently stopped HGV trucks from
getting truck dimensions.

**Resolution:**
Asked the user; they chose "Rename + fix branches + regenerate". Renamed the 3 modes
(urban_mobility/food_delivery/trucking → urban_car/urban_ebike/regional_hgv) AND updated
every `OPERATING_MODE = 'trucking'` branch to `'regional_hgv'`, plus the seed values in
`vehicle_profile_catalog.sql`. On the live account, migrated the 50 existing SF ebike rows
in `DIM_FLEET` (`food_delivery` → `urban_ebike`) via a tracked UPDATE.

**Suggested fix:**
The plan's blast-radius analysis should grep for `OPERATING_MODE` (not just the literal
`config.mode`) before declaring modes safe to rename. Future renames of any preset `mode`
must treat `OPERATING_MODE` as a dependent physical column with downstream branches.

---

### Issue 2: Demo schemas absent on the live account (ALTER SCHEMA skipped)

- **Step:** Step 5 (live migration)
- **Severity:** INFO
- **Category:** MISSING_OBJECT

**What happened:**
`FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS` / `_FOOD_DELIVERY` did not exist on wgb26798
(only the SF ebike `SYNTHETIC_DATASETS.UNIFIED` dataset + the `_CURRENT` projection views).

**Resolution:**
Skipped the `ALTER SCHEMA RENAME` per the plan's "if absent, skip" guidance. The renamed
skill SQL (`FLEET_INTELLIGENCE_CAR` / `_EBIKE`) will create the new names on next run.

---

### Issue 3: Data Studio regeneration is app/OAuth-driven, not CLI-reproducible

- **Step:** Step 5 (regenerate)
- **Severity:** WARNING
- **Category:** WORKAROUND

**What happened:**
The user approved a "generation run" to refresh `OPERATING_MODE` on existing data, but Data
Studio generation is driven by the OAuth-protected admin-app HTTP API (engine + `inserters.ts`),
not a SQL-callable procedure, so it cannot be triggered from the deploy shell.

**Resolution:**
Used a targeted, tracked `UPDATE` on the active dataset's `DIM_FLEET` rows
(`food_delivery` → `urban_ebike`, 50 rows) - the live-migration equivalent of the schema
ALTER. The only stale value was the cosmetic `OPERATING_MODE` (functionally inert post-rename,
since only the renamed `regional_hgv` branch reads it; joins are keyed on `VEHICLE_TYPE`).
The redeployed admin app's boot already reseeded `DIM_VEHICLE_PROFILE` and
`GENERATION_PROFILE_CATALOG` to the neutral names. A fresh Data Studio run for any preset
now naturally produces the new mode values.

**Suggested fix:**
Consider exposing a SQL-callable / scriptable generation entry point for migrations, or
document the in-place `OPERATING_MODE` migration as the supported path for mode renames.

---

### Issue 4: `for f in $FILES` word-splitting failed on the bulk-rename loop

- **Step:** Tier B (identifier replace)
- **Severity:** INFO
- **Category:** WORKAROUND

**What happened:**
A first `for f in $(git grep -l ...)` sed loop passed the entire newline-joined file list as
a single argument (`sed: <bigstring>: File name too long`); no edits were applied (verified
clean, no partial writes).

**Resolution:**
Switched to `git grep -lz ... | while IFS= read -r -d '' f` (NUL-delimited) for both the
Tier B identifier rename and the Tier C schema rename. Worked cleanly.

## Summary

- **Outcome:** COMPLETED_WITH_WORKAROUNDS - all 8 plan tasks done.
- **Commits (branch feature/sa-synapse-app):** Tier A (2f4ab86c), Tier B (8fe4ad80),
  Tier C (bdda2274), tag bumps (c7d7e4cd), legacy/doc residue cleanup (a2aeb6da). All pushed.
- **Live (wgb26798):** GENERATION_PROFILE_CATALOG → 3 neutral builtin ids;
  DIM_VEHICLE_PROFILE → urban_car/urban_ebike/regional_hgv; DIM_FLEET 50 rows → urban_ebike;
  demo schema ALTER skipped (absent). Apps redeployed: FLEET_ADMIN_APP v0.1.5, FLEET_SA_APP
  v0.1.19 (both RUNNING).
- **Verification:** admin app `tsc --noEmit` clean; evals 61/64 (3 failures pre-existing &
  unrelated: routing-agent trigger sensitivity + `references/deploy-agent.sql` broken xref);
  repo grep clean of all hard identifiers + mode literals (only intentional stale-id DELETE
  in generation-profile-catalog.ts remains, by design).
- **Recommendations count:** 3 (mode/OPERATING_MODE blast-radius grep; scriptable generation
  entry point; NUL-delimited bulk-rename loops).
