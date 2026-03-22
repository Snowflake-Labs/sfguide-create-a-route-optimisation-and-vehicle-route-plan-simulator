# Fix: Redeploy Native App

## Problem

The deployed `FLATTEN_MATRIX_RAW` has a 2-arg signature (old version), but `BUILD_MATRIX_JOB_WRAPPER` calls it with 3 args. The source code in [setup_script.sql](build-routing-solution/Native_app/app/setup_script.sql) is consistent -- both the definition (line 1521) and call (line 1808) use 3 args. The app just needs upgrading.

## Fix

Upgrade the native app so the deployed stored procedures match the current `setup_script.sql`:

```sql
ALTER APPLICATION OPENROUTESERVICE_NATIVE_APP UPGRADE USING @<stage_path>;
```

Or use the `snow` CLI equivalent, depending on how the app is deployed.

This will deploy:
- The 3-arg `FLATTEN_MATRIX_RAW(P_RES, P_REGION, P_PROFILE)`
- The updated `BUILD_MATRIX_JOB_WRAPPER` with ORS error detection
- Any EXECUTE AS CALLER changes from the other context
