# Plan: Fix City ORS Service Auto-Suspend

## Root Cause

The Berlin service (`ORS_SERVICE_BERLIN`) gets suspended frequently because its `AUTO_SUSPEND_SECS` is **4x shorter** than the default service, and it's excluded from scaling operations.

### Comparison

| Setting | ORS_SERVICE (default) | ORS_SERVICE_BERLIN (city) |
|---------|----------------------|--------------------------|
| AUTO_SUSPEND_SECS | 14400 (4 hours) | 3600 (1 hour) |
| MIN_INSTANCES | 3 | 1 |
| MAX_INSTANCES | 3 | 1 |

Source: [01_core_infra.sql](native_app/output/deploy/modules/01_core_infra.sql) line 153-158 vs [03_city_management.sql](native_app/app/modules/03_city_management.sql) line 208.

### Why This Causes Problems

1. After 1 hour of no direct requests, SPCS auto-suspends `ORS_SERVICE_BERLIN`
2. When matrix build or any function needs Berlin, it must resume first
3. After resume, ORS needs 3-10 minutes to **reload routing graphs from scratch**
4. During graph loading, all requests fail, triggering retries and wasting time
5. The default service (`ORS_SERVICE`) stays alive 4x longer and has 3 replicas for load distribution

### Additional Issue: SCALE_SERVICES Ignores City Services

[04_service_lifecycle.sql](native_app/app/modules/04_service_lifecycle.sql) line 115-116:
```sql
ALTER SERVICE IF EXISTS core.ors_service SET MIN_INSTANCES = ...
ALTER SERVICE IF EXISTS core.routing_gateway_service SET MIN_INSTANCES = ...
-- City services are NOT scaled
```

The 3-arg version (line 139) counts city services for pool sizing but doesn't actually scale them.

## Proposed Changes

### 1. Align AUTO_SUSPEND_SECS in create_city_ors_service

In [03_city_management.sql](native_app/app/modules/03_city_management.sql) line 208:

```sql
-- Before:
AUTO_SUSPEND_SECS = 3600

-- After:
AUTO_SUSPEND_SECS = 14400
```

This gives city services the same 4-hour idle timeout as the default service.

### 2. Include City Services in SCALE_SERVICES (2-arg version)

In [04_service_lifecycle.sql](native_app/app/modules/04_service_lifecycle.sql), after scaling `ors_service` and `routing_gateway_service`, loop through `ORS_SERVICE_%` services and scale them too.

### 3. Deploy and verify

Run `snow app run` to apply changes. Existing Berlin service will need a one-time ALTER to update its auto-suspend since the CREATE uses IF NOT EXISTS.
