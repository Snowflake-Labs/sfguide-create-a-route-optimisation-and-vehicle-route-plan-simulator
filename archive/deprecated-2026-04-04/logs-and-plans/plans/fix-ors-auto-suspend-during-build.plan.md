# Plan: Fix ORS Auto-Suspend During Matrix Build

## Root Cause

`ORS_SERVICE_BERLIN` has `auto_suspend_secs: 3600`. It was resumed at 08:20:21 and auto-suspended at 09:20:51 (exactly 1 hour later), right in the middle of the matrix build (started 09:18). The wrapper procedure resumes the service and checks profile readiness, but **resuming an already-running service does not reset the auto-suspend timer**. The MATRIX_TABULAR calls then hit a suspended ORS backend and get 500 errors.

```
Timeline:
08:20:21  Berlin ORS resumed
09:14:47  App upgrade (no effect on timer)
09:18:25  Matrix build started, resume called (no-op, already running)
09:18:41  Profile check passed (using cached graphs)
09:20:51  AUTO-SUSPEND fires (1hr from 08:20)
09:28:37  Build fails: 500 Internal Server Error
```

## Fix

### Task 1: Resume Berlin service and re-run (immediate)

```sql
ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SERVICE_BERLIN RESUME;
-- Wait ~2-3 min for graphs to rebuild, then re-trigger via UI
DELETE FROM OPENROUTESERVICE_NATIVE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS WHERE STATUS = 'ERROR';
```

### Task 2: Prevent auto-suspend during builds (root cause fix)

In [setup_script.sql](native_app/app/setup_script.sql) `BUILD_MATRIX_JOB_WRAPPER` (line ~1885), after the service RESUME block but before the profile readiness check, add logic to **suspend then resume** the city service (to reset the auto-suspend timer) and also temporarily increase the timeout:

```sql
-- Reset auto-suspend timer by forcing a fresh resume cycle
BEGIN
    EXECUTE IMMEDIATE 'ALTER SERVICE IF EXISTS core.ORS_SERVICE_' || UPPER(P_REGION) || ' SUSPEND';
    EXECUTE IMMEDIATE 'SELECT SYSTEM$WAIT(3)';
    EXECUTE IMMEDIATE 'ALTER SERVICE IF EXISTS core.ORS_SERVICE_' || UPPER(P_REGION) || ' RESUME';
EXCEPTION WHEN OTHER THEN
    BEGIN ALTER SERVICE IF EXISTS core.ors_service RESUME; EXCEPTION WHEN OTHER THEN NULL; END;
END;
```

This ensures the auto-suspend timer starts fresh from the build start time, giving the build a full 3600s (1 hour) window to complete.

### Task 3: Deploy the fix

Follow the deployment checklist from `references/snowflake-scripting-guidelines.md`:

1. Sandbox-test the suspend/resume pattern
2. PUT to stage ROOT: `@OPENROUTESERVICE_NATIVE_APP_PKG.APP_SRC.STAGE/`
3. `ALTER APPLICATION UPGRADE`
4. Verify procedure ownership and fix presence

### Task 4: Add auto-suspend guardrail to guidelines

Add a new entry to the Common Pitfalls table in [snowflake-scripting-guidelines.md](references/snowflake-scripting-guidelines.md):

```
| City ORS service auto-suspends mid-build | 500 Internal Server Error from MATRIX_TABULAR | Suspend + resume the city service before building to reset the auto-suspend timer |
```

## Files Modified

| File | Change |
|------|--------|
| `native_app/app/setup_script.sql` | Add suspend/resume cycle in BUILD_MATRIX_JOB_WRAPPER before profile readiness check (~line 1885) |
| `references/snowflake-scripting-guidelines.md` | Add auto-suspend pitfall to Common Pitfalls table |
