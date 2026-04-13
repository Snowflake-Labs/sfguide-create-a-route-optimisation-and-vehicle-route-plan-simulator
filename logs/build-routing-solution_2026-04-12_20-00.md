# Build Routing Solution — Execution Log

- **Date:** 2026-04-12 20:00
- **Skill:** build-routing-solution (full deployment + all demos)
- **Connection:** fleet_test_evals
- **Role:** ACCOUNTADMIN
- **Warehouse:** ROUTING_ANALYTICS
- **Outcome:** COMPLETED_WITH_WORKAROUNDS

## Issues

### Issue 1: LIST_REGIONS name collision — FUNCTION vs PROCEDURE

- **Step:** Step 7 (GRANT_CALLBACK)
- **Severity:** BLOCKER
- **Category:** SQL_ERROR

**What happened:**
`GRANT_CALLBACK` → `create_functions()` (module 02) tries to `CREATE OR REPLACE FUNCTION core.LIST_REGIONS()` but during setup_script execution, module 03 already created `core.LIST_REGIONS` as a PROCEDURE. `CREATE OR REPLACE FUNCTION` fails because a PROCEDURE with the same name already exists. The initial `snow app run` succeeds (setup_script runs modules sequentially creating FUNCTION then overwriting with PROCEDURE), but `GRANT_CALLBACK` calls `create_functions()` again which tries to recreate it as a FUNCTION — but now the PROCEDURE from module 03 already exists.

**SQL/Command that failed:**
```sql
CALL OPENROUTESERVICE_NATIVE_APP.CORE.GRANT_CALLBACK(ARRAY_CONSTRUCT('CREATE COMPUTE POOL', 'BIND SERVICE ENDPOINT'));
```

**Error message:**
```
Uncaught exception of type 'STATEMENT_ERROR' on line 8 at position 6 : 
Uncaught exception of type 'STATEMENT_ERROR' on line 208 at position 3 : 
SQL compilation error: Object 'LIST_REGIONS' already exists as PROCEDURE
```

**Resolution:**
Added `DROP PROCEDURE IF EXISTS core.LIST_REGIONS();` before the `CREATE OR REPLACE FUNCTION core.LIST_REGIONS()` in `02_routing_functions.sql` line 213. This ensures the PROCEDURE (created by module 03 during setup_script) is dropped before recreating as FUNCTION.

**Suggested fix:**
Either:
1. Add `DROP PROCEDURE IF EXISTS core.LIST_REGIONS();` before the CREATE FUNCTION in module 02 (applied fix)
2. Or reconcile LIST_REGIONS to be consistently either a FUNCTION or a PROCEDURE in both modules 02 and 03 (better long-term fix)

---

### Issue 2: Version mismatch in snowflake-scripting-guidelines.md

- **Step:** Step 5 (Build images)
- **Severity:** INFO
- **Category:** DOCS_GAP

**What happened:**
`references/snowflake-scripting-guidelines.md` Section 12 lists image versions that don't match the build instructions:
- Guidelines say: `routing_reverse_proxy:v0.9.6`, `ors_control_app:v1.0.28`
- Build instructions say: `routing_reverse_proxy:v1.0.0`, `ors_control_app:v1.0.95`

The `check_image_versions.sh` script only checks manifest.yml, service YAMLs, and build-images.md — it does NOT check snowflake-scripting-guidelines.md. So the validation passed even though the guidelines doc has stale versions.

**Resolution:**
Non-blocking — used the versions from build-images.md and manifest.yml (which are consistent). The scripting-guidelines doc is reference documentation, not deployment config.

**Suggested fix:**
Update Section 12 of `snowflake-scripting-guidelines.md` to match the current image versions, or remove the version table from that doc (since it duplicates build-images.md and goes stale).

---

### Issue 3: snow CLI version warning on every command

- **Step:** All steps using `snow` CLI
- **Severity:** INFO
- **Category:** DOCS_GAP

**What happened:**
Every `snow` CLI command outputs a warning: `New version of Snowflake CLI available. Newest: 3.16.0, current: 3.9.0`. This is noisy but non-blocking (mentioned in SKILL.md Step 2 notes).

**Resolution:**
Ignored as instructed.

**Suggested fix:**
Add `export SNOWFLAKE_CLI_NO_UPDATE_CHECK=true` as a recommended environment variable in the Prerequisites section.

---

### Issue 4: Routing Agent — Snowflake Intelligence registration failed

- **Step:** Step 9g (Routing Agent deployment)
- **Severity:** WARNING
- **Category:** MISSING_OBJECT

**What happened:**
The routing-agent skill's Step 8 tries to register the agent with Snowflake Intelligence via `ALTER SNOWFLAKE INTELLIGENCE ... ADD AGENT`. This failed because Snowflake Intelligence is not configured/enabled on this account.

**Resolution:**
Skipped — the agent is fully functional via direct `INVOKE_AGENT` calls. SI registration is optional.

**Suggested fix:**
Add a pre-check in the skill: `SHOW SNOWFLAKE INTELLIGENCE` and make Step 8 conditional on SI being available. Document that SI registration is optional.

---

### Issue 5: Dwell Analysis — VW_REST_STOPS returns 0 rows

- **Step:** Step 9c (Dwell Analysis deployment)
- **Severity:** INFO
- **Category:** UNEXPECTED_DATA

**What happened:**
The `VW_REST_STOPS` view returns 0 rows because the seed data in `DIM_POIS` has no records with `LOCATION_TYPE = 'REST_STOP'`. All POIs are typed as 'RESTAURANT' or 'CUSTOMER'.

**Resolution:**
Non-blocking — the view definition is correct, just no matching data in seed dataset. Dwell analysis still works with geofence-based analysis.

**Suggested fix:**
Add a few REST_STOP records to the seed data, or note in the dwell-analysis SKILL.md that VW_REST_STOPS will be empty with seed data.

---

### Issue 6: Fleet Intelligence Taxis — CONFIG uses 'ebike' not 'taxi'

- **Step:** Step 9d (Fleet Intelligence Taxis deployment)
- **Severity:** INFO
- **Category:** DOCS_GAP

**What happened:**
The seed-data.sql for taxis creates a CONFIG row with `vehicle_type=ebike` and `region=SanFrancisco` because the UNIFIED seed data is ebike data. This means the "Taxis" demo actually shows ebike data, which may confuse users.

**Resolution:**
Deployed as designed — the views project UNIFIED data through the CONFIG filter. Since only ebike seed data exists, this is the expected behavior.

**Suggested fix:**
Either add real taxi seed data to UNIFIED, or add a note in the SKILL.md that the taxis demo shows ebike data when using seed data and should be re-generated via Data Studio with a taxi profile for realistic taxi data.

## Summary

| Metric | Value |
|--------|-------|
| Total issues | 6 |
| Blockers resolved | 1 (LIST_REGIONS collision) |
| Code changes required | 1 (02_routing_functions.sql) |
| Docs improvements suggested | 4 |
| Deployment time | ~45 minutes (including image builds) |
