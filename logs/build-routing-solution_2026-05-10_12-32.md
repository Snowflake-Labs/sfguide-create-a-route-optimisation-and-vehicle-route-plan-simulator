# build-routing-solution friction log — 2026-05-10 12:32

## Summary
USA deployment with `driving-hgv` profile failed at the `create_region_ors_service` step with:

```
Uncaught exception of type 'EXPRESSION_ERROR' on line 29 at position 27 :
SQL compilation error:
Unknown user-defined function OPENROUTESERVICE_APP.CORE.RESOLVE_LARGEST_HIGHMEM_FAMILY.
```

## Root cause
`OPENROUTESERVICE_APP.CORE.RESOLVE_LARGEST_HIGHMEM_FAMILY` is a stored **PROCEDURE** (uses `EXECUTE IMMEDIATE 'SHOW COMPUTE POOL INSTANCE FAMILIES'`, which is not allowed in UDFs). It was being invoked inline in `create_region_ors_service` as if it were a UDF:

```sql
instance_family := OPENROUTESERVICE_APP.CORE.RESOLVE_LARGEST_HIGHMEM_FAMILY();
```

Snowflake Scripting parses RHS expressions assuming a scalar function and reports `Unknown user-defined function` since no UDF with that name exists. Only the `XXL` branch and the default fallback hit this code path; smaller compute sizes use legacy hardcoded family literals, which is why the bug was hidden until USA / driving-hgv (XXL) was deployed.

## Fix applied
Replaced the two assignment expressions with the supported `CALL ... INTO :var` Snowflake Scripting pattern (already used in [04_service_lifecycle.sql:65](../.cortex/skills/build-routing-solution/openrouteservice_app/app/modules/04_service_lifecycle.sql)):

```sql
CALL OPENROUTESERVICE_APP.CORE.RESOLVE_LARGEST_HIGHMEM_FAMILY() INTO :instance_family;
```

File: [.cortex/skills/build-routing-solution/openrouteservice_app/app/modules/03_region_management.sql](../.cortex/skills/build-routing-solution/openrouteservice_app/app/modules/03_region_management.sql) — lines 542 (XXL branch) and 546 (default fallback).

Module 03 redeployed via `snow sql -f`. Verified:
- `CALL ...RESOLVE_LARGEST_HIGHMEM_FAMILY()` returns `MEM_X64_G2_192` standalone.
- `GET_DDL('PROCEDURE', ...CREATE_REGION_ORS_SERVICE...)` contains `CALL ... INTO :instance_family`.

## Step status
| Step | Status | Notes |
|------|--------|-------|
| Diagnose error | OK | Identified UDF-vs-procedure call mismatch from log line+position. |
| Edit `03_region_management.sql` | OK | Two assignments replaced. |
| `snow sql -f` redeploy | OK | All procedures created successfully. |
| Verify resolver standalone | OK | Returns `MEM_X64_G2_192`. |
| Verify procedure body contains fix | OK | DDL ILIKE check passed. |
| Retry USA driving-hgv build | DEFERRED | Triggered by user from Region Builder UI (long-running, XXL compute). |

## Friction points & recommendations
1. **Procedure invoked as UDF expression compiled successfully at deploy time.** Snowflake does not validate procedure-call expressions until execution, so this latent bug shipped. **Recommendation:** add a compile-time smoke test that calls `CREATE_REGION_ORS_SERVICE` against a no-op region in dry-run mode, or add a lint check that flags `:= IDENT.IDENT.PROC_NAME(` patterns inside procedure bodies.
2. **Bug only triggered for XXL.** Smaller compute sizes used legacy hardcoded family literals and never hit the resolver. **Recommendation:** unify both branches to call the resolver (with optional override list) so all paths exercise the same code.
3. **Existing pattern was already in repo.** [04_service_lifecycle.sql:65](../.cortex/skills/build-routing-solution/openrouteservice_app/app/modules/04_service_lifecycle.sql) uses `CALL ... INTO :var` correctly. **Recommendation:** document the pattern in [snowflake-sql-gotchas.md](../.cortex/skills/build-routing-solution/references/snowflake-sql-gotchas.md) under a new "Calling procedures from procedures" section.

## Total time
~10 minutes from error report to verified deploy of fix.
