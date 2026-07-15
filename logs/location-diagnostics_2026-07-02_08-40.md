# Location Diagnostics (Isochrone Overlap Mode) - Execution Log

- **Date:** 2026-07-02 08:40
- **Skill:** location-diagnostics
- **Connection:** fleet_test_evals (account wgb26798)
- **Role:** ACCOUNTADMIN
- **Warehouse:** MY_WH
- **Outcome:** COMPLETED_WITH_WORKAROUNDS

Added Isochrone Overlap Mode (computed ST_INTERSECTION overlaps + metric selector) to Site Impact and Closure Impact. Config-only: four new live UDTFs in `analytic_layer.sql`, view changes in `app-views.json`, no fleet-kit TypeScript. Deployed via config-stage upload + FLEET_SA_APP suspend/resume.

## Issues

### Issue 1: ST_ISEMPTY is not a Snowflake function

- **Step:** Create LIVE_OVERLAPS
- **Severity:** ERROR
- **Category:** SQL_ERROR

**What happened:**
Filtered empty `ST_INTERSECTION` results with `NOT ST_ISEMPTY(g)`. Snowflake has no `ST_ISEMPTY`.

**Error message:**
```
SQL compilation error: Unknown function ST_ISEMPTY.
```

**Resolution (this run):** Replaced `NOT ST_ISEMPTY(g)` with `ST_AREA(g) > 0` in all four UDTFs. Non-intersecting isochrone pairs yield an empty geometry whose `ST_AREA` is 0, so this filters them out cleanly and also drops degenerate (line/point) intersections.

**Prevention:** Use `ST_AREA(g) > 0` (or `ST_DIMENSION`) as the empty-geometry filter for GEOGRAPHY intersections; `ST_ISEMPTY` does not exist in Snowflake.

### Issue 2: Table function inside a scalar subquery raised misleading 42501

- **Step:** Create LIVE_CLOSURE_OVERLAPS
- **Severity:** ERROR
- **Category:** PERMISSION_ERROR (misleading; not an actual grant issue)

**What happened:**
`LIVE_CLOSURE_OVERLAPS` referenced a CTE derived from `TABLE(LIVE_OWNED_CATCHMENTS(...))` inside a scalar subquery (`ST_INTERSECTION((SELECT GEO FROM closed_cat), s.GEO)`), which threw a misleading insufficient-privileges error even as ACCOUNTADMIN.

**Error message:**
```
SQL access control error: Insufficient privileges to operate on Table function 'FLEET_APP.LOCATION.LIVE_OWNED_CATCHMENTS'.
```

**Resolution (this run):** Hoisted the single-row table-function-derived CTEs to CROSS JOINs (`closed_cat`, `cfact`, `tot`) instead of scalar subqueries, per the existing project-memory gotcha. Function then created and returned correct rows.

**Prevention:** Never reference a table-function-derived CTE inside a scalar subquery; join it (CROSS JOIN for single-row CTEs). Already captured in project memory `table-fn-scalar-subquery-gotcha`.

## Verification

- All four UDTFs create and return rows in ~1-2s (2 ORS calls each). SanFrancisco, ORS `service_ready:true`.
- Subset-correctness: max Site Impact overlap households (83,916) <= candidate catchment total (88,942).
- sql-verify: PASS (no fanout within an overlap row; NULLIF/COALESCE guards correct; single-row CROSS JOINs safe).
- Consumer role FLEET_APP_USER can execute all four UDTFs.
- Dash-ban scan clean on both edited files.
- Manual step outstanding (OAuth-gated): in-app visual check of overlap choropleth, map<->table selection sync, metric re-shade, and drawer.
