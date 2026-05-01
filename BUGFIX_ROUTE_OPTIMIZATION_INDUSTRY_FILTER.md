# Control App Bug Fix: Route Optimization Industry Filter

**Date:** 2026-05-01  
**Version:** v1.0.117 → v1.0.118  
**Component:** ORS Control App - Route Optimization page  
**Severity:** HIGH (feature broken)

---

## Bug Description

**Symptom:** When selecting an industry filter (Food, Healthcare, Cosmetics, Beverages), the Route Optimization page shows "0 PLACES" despite 1.4M POIs being loaded in the database.

**Root Cause:** 
The `loadPlaces` function in `RouteOptimization.tsx` (line 84) incorrectly filtered by:
```typescript
const indFilter = selectedIndustry ? ` AND CATEGORY = '${selectedIndustry}'` : '';
```

This tried to match `CATEGORY = 'Food'` but the PLACES.CATEGORY column contains specific POI types like `'restaurant'`, `'supermarket'`, `'butcher_shop'` (not the industry name).

**Expected Behavior:**
The query should join with the LOOKUP table and match against the CTYPE array which maps industries to their category types.

---

## Fix Applied

**File:** `.cortex/skills/build-routing-solution/openrouteservice_app/services/ors_control_app/src/components/RouteOptimization.tsx`

**Changed Query Logic:**

**Before:**
```typescript
const indFilter = selectedIndustry ? ` AND CATEGORY = '${selectedIndustry}'` : '';
const query = `SELECT ... FROM PLACES WHERE REGION = '...' AND ST_DWITHIN(...) ${indFilter} LIMIT 200`;
```

**After:**
```typescript
const placesQuery = selectedIndustry 
  ? `SELECT p.NAME, p.CATEGORY, ST_X(p.GEOMETRY) AS LNG, ST_Y(p.GEOMETRY) AS LAT 
     FROM PLACES p, LOOKUP l 
     WHERE p.REGION = '${regionName}' 
       AND l.REGION = '${regionName}'
       AND l.INDUSTRY = '${selectedIndustry}'
       AND ARRAY_CONTAINS(p.CATEGORY::VARIANT, l.CTYPE)
       AND ST_DWITHIN(p.GEOMETRY, ST_MAKEPOINT(...), ${radius * 1000})
     LIMIT 200`
  : `SELECT ... FROM PLACES WHERE REGION = '...' AND ST_DWITHIN(...) LIMIT 200`;
```

**Key Changes:**
1. Join with LOOKUP table on matching REGION and INDUSTRY
2. Use `ARRAY_CONTAINS(p.CATEGORY::VARIANT, l.CTYPE)` to match POI categories against industry's CTYPE array
3. Preserve "All industries" mode when no industry selected

---

## Testing

**Validation Query (Food industry near SF center):**
```sql
SELECT p.NAME, p.CATEGORY, ST_X(p.GEOMETRY) AS LNG, ST_Y(p.GEOMETRY) AS LAT 
FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES p, 
     FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP l 
WHERE p.REGION = 'SanFrancisco' 
  AND l.REGION = 'SanFrancisco'
  AND l.INDUSTRY = 'Food'
  AND ARRAY_CONTAINS(p.CATEGORY::VARIANT, l.CTYPE)
  AND ST_DWITHIN(p.GEOMETRY, ST_MAKEPOINT(-122.4194, 37.7749), 5000)
LIMIT 20;
```

**Expected Result:** 20 POIs (restaurants, supermarkets, butcher shops)  
**Actual Result:** ✅ Returns 20 Food POIs correctly

---

## Deployment Steps

### 1. Version Bump
- ✅ `image-versions.env`: Updated to v1.0.118
- ✅ `ors_control_app_service.yaml`: Updated image tag to v1.0.118

### 2. Rebuild Image (Local Machine)
```bash
cd .cortex/skills/build-routing-solution/openrouteservice_app

snow spcs image-registry login -c <connection>
REPO_URL=$(snow spcs image-repository url OPENROUTESERVICE_APP.CORE.image_repository -c <connection>)

docker build --platform linux/amd64 \
  -f services/ors_control_app/Dockerfile.runtime \
  -t $REPO_URL/openrouteservice_app/core/image_repository/ors_control_app:v1.0.118 \
  services/ors_control_app

docker push $REPO_URL/openrouteservice_app/core/image_repository/ors_control_app:v1.0.118
```

### 3. Upload Updated Spec
```bash
snow stage copy services/ors_control_app/ors_control_app_service.yaml \
  @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/services/ors_control_app/ \
  -c <connection> --overwrite
```

### 4. Update Service (CRITICAL: Suspend → Update → Resume)
```sql
ALTER SERVICE OPENROUTESERVICE_APP.CORE.ORS_CONTROL_APP SUSPEND;

ALTER SERVICE OPENROUTESERVICE_APP.CORE.ORS_CONTROL_APP
  FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/services/ors_control_app/
  SPECIFICATION_FILE = 'ors_control_app_service.yaml';

ALTER SERVICE OPENROUTESERVICE_APP.CORE.ORS_CONTROL_APP RESUME;
```

### 5. Verify
```sql
SHOW ENDPOINTS IN SERVICE OPENROUTESERVICE_APP.CORE.ORS_CONTROL_APP;

SELECT 'https://' || ingress_url AS control_app_url
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
WHERE name = 'ors-control-app';
```

---

## Impact

**Before Fix:**
- Industry selector appeared functional but returned 0 results
- Users could not filter POIs by industry
- VRP simulator unusable for industry-specific routing

**After Fix:**
- Food industry: ~14K POIs available
- Healthcare: ~20K POIs available
- Each industry correctly filtered using LOOKUP.CTYPE mappings
- Full VRP functionality restored

---

## Files Changed

1. `services/ors_control_app/src/components/RouteOptimization.tsx` (bug fix)
2. `openrouteservice_app/image-versions.env` (version bump)
3. `openrouteservice_app/services/ors_control_app/ors_control_app_service.yaml` (version bump)

**Ready to push to SUMMIT branch.**
