# Emergency Response - Execution Log

- **Date:** 2026-06-11 09:45
- **Skill:** emergency-response (v2 rewrite)
- **Connection:** fleet_test_evals
- **Role:** ACCOUNTADMIN
- **Warehouse:** MY_WH
- **Outcome:** COMPLETED_WITH_WORKAROUNDS

## Issues

### Issue 1: ORS ISOCHRONES range argument is MINUTES, not seconds

- **Step:** Step 3 (ORS_ISOCHRONE_FOR_CENTER) / Step 2 seed
- **Severity:** ERROR
- **Category:** WORKAROUND

**What happened:**
The v1 `ORS_ISOCHRONE_FOR_CENTER(loc, RANGE_SECONDS, region)` passed a seconds
value straight to `OPENROUTESERVICE_APP.CORE.ISOCHRONES(...)`. Passing 900 (15
min in seconds) produced `request_too_large` with `observed_range_s: 54000`
(= 900 × 60), so the wrapped function returned NULL geometry and the seed step
sampled 0 addresses. The ISOCHRONES table function interprets its 4th argument
as **minutes** and converts to seconds internally (guardrail max 18000s).

**Resolution:**
Renamed the UDF parameter to `RANGE_MINUTES` and pass the minutes value
directly. Passing 15 yields a valid ~263 km² Denver isochrone. The wizard's
"drive time (minutes)" input now maps 1:1 to the ORS argument.

**Suggested fix:**
Applied in `references/sql-pipeline.sql`. Any other caller of
`OPENROUTESERVICE_APP.CORE.ISOCHRONES` should treat the range arg as minutes.

### Issue 2: ISOCHRONES requires FLOAT lon/lat (no implicit NUMBER cast)

- **Step:** ad-hoc validation
- **Severity:** WARNING
- **Category:** SQL_ERROR

**What happened:**
`ISOCHRONES('driving-car', -104.98, 39.69, 15, 'UsColorado')` failed with
"Invalid argument types ... (VARCHAR, NUMBER, NUMBER, NUMBER, VARCHAR)" because
the overload requires FLOAT for lon/lat.

**Resolution:**
Cast with `::FLOAT`. The UDF already casts `ST_X(LOC)::FLOAT`, so production
callers via the wrapper are unaffected; only direct literal calls need casts.

### Issue 3: V_ZIP_RISK alias typo

- **Step:** Step 2 (V_ZIP_RISK)
- **Severity:** ERROR
- **Category:** SQL_ERROR

**What happened:**
First `CREATE VIEW V_ZIP_RISK` referenced `z.ZIP_CODE` but the meta table was
aliased `m`; compilation failed with "invalid identifier 'Z.ZIP_CODE'".

**Resolution:**
Fixed alias to `m.ZIP_CODE` in both the live view and
`references/sql-pipeline.sql`.
