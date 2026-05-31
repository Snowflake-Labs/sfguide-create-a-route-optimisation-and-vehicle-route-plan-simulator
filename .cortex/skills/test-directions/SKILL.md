---
name: test-directions
description: "Test the ORS DIRECTIONS function end-to-end. Use when: verifying routing works, testing directions, smoke testing ORS, checking if routes return valid results. Do NOT use for: building or deploying ORS (use build-routing-solution), changing routing profiles (use routing-customization). Triggers: test directions, test routing, smoke test ORS, verify directions, does routing work, test route."
metadata:
  author: Snowflake SIT-IS
  version: 1.0.0
  category: testing
  depends_on:
    - build-routing-solution
---

# Test Directions

Runs an end-to-end smoke test of the ORS DIRECTIONS function to verify the routing service is healthy and returning valid routes.

## Prerequisites

- `build-routing-solution` deployed and all 5 services RUNNING
- At least one region with a PBF loaded (default: SanFrancisco)

## Required Privileges

| Privilege | Object | Purpose |
|-----------|--------|---------|
| USAGE | WAREHOUSE (any) | Execute queries |
| USAGE | DATABASE OPENROUTESERVICE_APP | Access routing functions |
| USAGE | SCHEMA OPENROUTESERVICE_APP.CORE | Access routing functions |

## Execution

### Step 1: Set Session Tag

```sql
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-test-directions","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

### Step 2: Verify Services Are Running

```sql
SHOW SERVICES IN DATABASE OPENROUTESERVICE_APP;
```

All 5 services must show status = RUNNING. If any are PENDING or SUSPENDED, wait or call `CALL OPENROUTESERVICE_APP.CORE.RESUME_ALL_SERVICES();`.

### Step 3: Health Check

```sql
SELECT OPENROUTESERVICE_APP.CORE.CHECK_HEALTH() AS healthy;
```

Must return `TRUE`. If `FALSE`, check service logs with:
```sql
SELECT SYSTEM$GET_SERVICE_LOGS('OPENROUTESERVICE_APP.CORE.ORS_SERVICE', 0, 'ors', 50);
```

### Step 4: Resolve Default Region Bounding Box

```sql
SELECT REGION, DISPLAY_NAME, MIN_LAT, MAX_LAT, MIN_LON, MAX_LON
FROM OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP
WHERE IS_DEFAULT = TRUE;
```

Use this bounding box to confirm test coordinates are within the routable area.

### Step 5: Discover Available Profiles

```sql
SELECT OPENROUTESERVICE_APP.CORE.ORS_STATUS(NULL) AS status;
```

Parse `status:profiles` to identify available routing profiles. The default deployment includes `driving-car`, `driving-hgv`, and `cycling-electric`. Test each available profile in the following steps.

### Step 6: Test DIRECTIONS (driving-car)

Route from Market Street to Union Square in San Francisco:

```sql
SELECT DISTANCE, DURATION, GEOJSON
FROM TABLE(OPENROUTESERVICE_APP.CORE.DIRECTIONS(
  'driving-car',
  ARRAY_CONSTRUCT(-122.4194, 37.7749),
  ARRAY_CONSTRUCT(-122.4098, 37.7858)
));
```

**Pass criteria:**
- DISTANCE > 0 (meters)
- DURATION > 0 (seconds)
- GEOJSON IS NOT NULL (valid LineString geometry)

### Step 7: Test DIRECTIONS (driving-hgv)

```sql
SELECT DISTANCE, DURATION, GEOJSON
FROM TABLE(OPENROUTESERVICE_APP.CORE.DIRECTIONS(
  'driving-hgv',
  ARRAY_CONSTRUCT(-122.4194, 37.7749),
  ARRAY_CONSTRUCT(-122.4098, 37.7858)
));
```

**Pass criteria:** Same as Step 6. HGV route may differ due to vehicle restrictions.

### Step 8: Test DIRECTIONS (cycling-electric)

```sql
SELECT DISTANCE, DURATION, GEOJSON
FROM TABLE(OPENROUTESERVICE_APP.CORE.DIRECTIONS(
  'cycling-electric',
  ARRAY_CONSTRUCT(-122.4194, 37.7749),
  ARRAY_CONSTRUCT(-122.4098, 37.7858)
));
```

**Pass criteria:** Same as Step 6. Cycling distance may differ from driving (different road access).

### Step 9: Test ISOCHRONES

Note: ISOCHRONES requires explicit FLOAT/INT casting for numeric literals.

```sql
SELECT GEOJSON IS NOT NULL AS has_geometry, RESPONSE
FROM TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES(
  'driving-car',
  -122.4194::FLOAT,
  37.7749::FLOAT,
  300::INT
));
```

**Pass criteria:**
- has_geometry = TRUE (valid Polygon geometry)
- RESPONSE contains isochrone features

### Step 10: Summary

Report results as a table:

| Test | Profile | Distance (m) | Duration (s) | Pass |
|------|---------|-------------|-------------|------|
| Directions | driving-car | {value} | {value} | YES/NO |
| Directions | driving-hgv | {value} | {value} | YES/NO |
| Directions | cycling-electric | {value} | {value} | YES/NO |
| Isochrones | driving-car | N/A | N/A | YES/NO |

All tests must pass for the routing service to be considered healthy.

## Cleanup

No objects are created by this skill — it is read-only.
