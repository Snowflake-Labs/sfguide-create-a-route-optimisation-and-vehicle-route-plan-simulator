# Diagnose ORS "profile unknown" Error

## Root Cause Analysis

The error `"Parameter 'profile' has incorrect value of 'unknown'"` (code 2003) occurs because **ORS graphs have not finished building yet**.

### Why this happens

After the native app is first activated, the ORS service must:
1. Start the Java process
2. Load the San Francisco OSM data (~25MB PBF file)
3. Build routing graphs for each enabled profile (`driving-car`, `driving-hgv`, `cycling-electric`)

This process takes **3-10 minutes**. During graph building, ORS is responsive (the API returns JSON), but no profiles are registered — so any profile name is mapped to `"unknown"`.

### Evidence

- The response includes valid `engine` info (`version: 9.0.0`, `graph_version: 1`) — ORS IS running
- The error says `"unknown"` rather than `"DRIVING-CAR"` — ORS has no profiles loaded yet, not a case mismatch

## Diagnostic Steps

### Step 1: Check ORS graph build status

```sql
SELECT OPENROUTESERVICE_NATIVE_APP.CORE.ORS_STATUS();
```

**If graphs are still building**, the response will show `"service_ready": false` or have an empty/missing `profiles` key.

**If graphs are ready**, you will see something like:
```json
{
  "profiles": {
    "driving-car": { "encoder_name": "driving-car", ... },
    "driving-hgv": { "encoder_name": "driving-hgv", ... },
    "cycling-electric": { "encoder_name": "cycling-electric", ... }
  },
  "service_ready": true
}
```

### Step 2: Retry with lowercase profile

Once `ORS_STATUS()` confirms profiles are loaded, retry the call. Use **lowercase** profile name (best practice, since ORS profile matching is case-sensitive):

```sql
SELECT OPENROUTESERVICE_NATIVE_APP.CORE.DIRECTIONS(
    'driving-car',
    ARRAY_CONSTRUCT(-122.445, 37.755),
    ARRAY_CONSTRUCT(-122.435, 37.765)
);
```

### Step 3: If still failing after graphs are ready

Check service logs for deeper diagnostics:

```sql
-- ORS engine logs (graph build progress, errors)
CALL SYSTEM$GET_SERVICE_LOGS('OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SERVICE', 0, 'openrouteservice', 100);

-- Gateway logs (request routing, profile mapping)
CALL SYSTEM$GET_SERVICE_LOGS('OPENROUTESERVICE_NATIVE_APP.CORE.ROUTING_GATEWAY_SERVICE', 0, 'gateway', 100);
```

## Summary

**Action needed: Wait 3-10 minutes**, then check `ORS_STATUS()`. Once profiles appear, `DIRECTIONS('driving-car', ...)` will work. Always use lowercase profile names.