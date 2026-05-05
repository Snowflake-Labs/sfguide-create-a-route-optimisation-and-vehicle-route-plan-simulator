# Routing Solution Deployment - Debug Context

## Current State (May 1, 2026 ~16:00 UTC)

### ✅ Working Infrastructure
- **4 ORS Services RUNNING:** ORS_SERVICE (3/3), ROUTING_GATEWAY_SERVICE (3/3), VROOM_SERVICE (1/1), ORS_CONTROL_APP (1/1)
- **Databases:** OPENROUTESERVICE_APP, FLEET_INTELLIGENCE, SYNTHETIC_DATASETS, OVERTURE_MAPS__PLACES, OVERTURE_MAPS__ADDRESSES
- **Seed Data Loaded:** 474K telemetry, 7.7K trips, 150 vehicles, 10K POIs, 1.4M Overture Places, 2.8M Addresses
- **Demos Deployed:** Route Optimization (partial), Fleet Intelligence (views created), Retail Catchment (complete)

### 🌐 Control App
- **URL:** https://iqdpdnb-sfsehol-test-summit-routing-sdnnjc.snowflakecomputing.app
- **Current Version:** v1.0.122 (deployed)
- **Previous Stable:** v1.0.120

---

## Bugs Found & Fix Status

### Bug #1: Industry Filter (FIXED in v1.0.120) ✅
**File:** `services/ors_control_app/src/components/RouteOptimization.tsx`  
**Line:** ~84 (in loadPlaces function)

**Problem:**
```typescript
const indFilter = selectedIndustry ? ` AND CATEGORY = '${selectedIndustry}'` : '';
```
This tried to match `CATEGORY = 'Food'` but CATEGORY contains POI types like 'restaurant', 'supermarket'.

**Fix Applied:**
```typescript
const placesQuery = selectedIndustry 
  ? `SELECT p.NAME, p.CATEGORY, ST_X(p.GEOMETRY) AS LNG, ST_Y(p.GEOMETRY) AS LAT 
     FROM PLACES p, LOOKUP l 
     WHERE p.REGION = '${regionName}' 
       AND l.REGION = '${regionName}'
       AND l.INDUSTRY = '${selectedIndustry}'
       AND ARRAY_CONTAINS(p.CATEGORY::VARIANT, l.CTYPE)
       AND ST_DWITHIN(p.GEOMETRY, ST_MAKEPOINT(${centerCoords[0]}, ${centerCoords[1]}), ${radius * 1000})
     LIMIT 200`
  : `SELECT NAME, CATEGORY, ST_X(GEOMETRY) AS LNG, ST_Y(GEOMETRY) AS LAT 
     FROM PLACES 
     WHERE REGION = '${regionName}' 
       AND ST_DWITHIN(GEOMETRY, ST_MAKEPOINT(${centerCoords[0]}, ${centerCoords[1]}), ${radius * 1000}) 
     LIMIT 200`;
```

**Status:** ✅ WORKING - Selecting "Food" shows 200 POIs on map

---

### Bug #2: VRP Solver Database Context (ATTEMPTED FIX in v1.0.122) ❌
**File:** `services/ors_control_app/src/components/RouteOptimization.tsx`  
**Line:** ~133 (in optimizeRoutes function)

**Problem:**
```typescript
const rows = await sfQuery(`SELECT * FROM TABLE(OPENROUTESERVICE_APP.CORE.OPTIMIZATION(...))`);
```
The sfQuery function defaults to `database='FLEET_INTELLIGENCE', schema='ROUTE_OPTIMIZATION'` (line 9-10, 13).
OPTIMIZATION function exists in `OPENROUTESERVICE_APP.CORE`, not FLEET_INTELLIGENCE.
Query fails silently with "function not found", sfQuery returns empty array.

**Fix Attempted:**
```typescript
const rows = await sfQuery(
  `SELECT * FROM TABLE(OPENROUTESERVICE_APP.CORE.OPTIMIZATION(PARSE_JSON('${JSON.stringify(vrpChallenge).replace(/'/g, "''")}')))`, 
  'OPENROUTESERVICE_APP', 
  'CORE'
);
```

**Current Issue:**
- Button click triggers "SOLVING VRP..." message
- No query appears in Control App server logs
- VROOM logs show old errors with profile='unknown' (from earlier attempts)
- Result: "Routes: 0" displayed

**Additional Context:**
The OPTIMIZATION function works when tested manually:
```sql
SELECT * FROM TABLE(
  OPENROUTESERVICE_APP.CORE.OPTIMIZATION(
    PARSE_JSON('{"jobs":[{"id":1,"location":[-122.42,37.77],"service":300}],"vehicles":[{"id":1,"profile":"driving-car","start":[-122.42,37.77],"end":[-122.42,37.77],"capacity":[10],"time_window":[0,86400]}]}')
  )
)
```
Returns valid route with geometry. So the function itself works - the UI call is broken.

**Possible Root Causes:**
1. TypeScript compilation error in v1.0.122 build
2. sfQuery fetch failing (network/CORS?)
3. vehicles state has profile field corrupted somehow
4. JSON.stringify produces invalid JSON that breaks SQL parsing

**Debug Steps Needed:**
1. Check browser console for JavaScript errors
2. Check Network tab for failed /api/query requests
3. Add server-side logging: In server/index.ts `/api/query` endpoint, log the incoming SQL before execution
4. Verify vehicles array: `console.log('vrpVehicles:', vrpVehicles)` before stringifying

---

### Bug #3: Agent Playground Model Name (ATTEMPTED FIX in v1.0.122) ⚠️
**File:** `services/ors_control_app/server/index.ts`  
**Line:** 1666

**Problem:**
```typescript
const AGENT_MODELS = ['claude-3-5-sonnet', 'mistral-large2'];
```
Snowflake Cortex doesn't have 'claude-3-5-sonnet'. Available models use different naming.

**Fix Applied in Workspace:**
```typescript
const AGENT_MODELS = ['claude-sonnet-4-5', 'mistral-large2'];
```

**Status:** ⚠️ NEEDS VERIFICATION
The v1.0.122 build might not have this fix (depends on when you pulled from workspace).

**Test:**
```sql
SELECT SNOWFLAKE.CORTEX.COMPLETE('claude-sonnet-4-5', 'test') AS result;
```
Should return a response (not "model does not exist").

---

## File Modifications Summary

### Control App Source (needs rebuild):
1. **RouteOptimization.tsx**
   - Line ~81-105: loadPlaces function (LOOKUP join fix)
   - Line ~133: optimizeRoutes sfQuery call (database context fix)

2. **server/index.ts**
   - Line 1666: AGENT_MODELS array (model name fix)

### Version Files:
3. **image-versions.env:** ORS_CONTROL_APP_TAG=v1.0.122
4. **ors_control_app_service.yaml:** image=v1.0.122, APP_VERSION=1.0.122
5. **build-routing-solution/SKILL.md:** Step 3b table updated to v1.0.122
6. **build-images.md:** Build commands updated to v1.0.122

### Skills (inline SQL improvements):
7. **route-optimization/SKILL.md:** Steps 1, 2, 4 with inline SQL
8. **build-routing-solution/SKILL.md:** Step 7 REQUIRED flag + Workspace support
9. **fleet-intelligence-taxis/SKILL.md:** Steps 1, 3b inline SQL
10. **retail-catchment/SKILL.md:** Steps 1, 2, 3 inline SQL
11. **route-deviation/SKILL.md:** Steps 1, 2 inline SQL
12. **routing-customization/read-ors-configuration/SKILL.md:** Workspace alternatives

---

## Testing Checklist

### Industry Filter (Working ✅)
1. Open Route Optimization page
2. Search "San Francisco" → Click Go
3. Select "Food" from Industry dropdown
4. Verify: **200 POIs appear on map**
5. Change to "Healthcare" → Verify different POIs load

### VRP Solver (Broken ❌)
1. With POIs loaded (200 visible)
2. Click "Optimize Routes"
3. **Expected:** Routes drawn on map, "Routes: 1" metric
4. **Actual:** "Routes: 0", no routes displayed
5. **Debug:** Browser console shows errors? Network tab shows failed requests?

### Agent Playground (Unknown Status ⚠️)
1. Go to Agent Playground page
2. Type: "Show me directions from Golden Gate Bridge to Fisherman's Wharf"
3. **Expected:** Map shows route
4. **Actual (before fix):** Error: Model does not exist (claude-3-5-sonnet)
5. **After v1.0.122 with claude-sonnet-4-5:** Should work if build included the fix

---

## Database Schema Reference

### FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION
- **PLACES** (1.4M rows): POI data with GEOMETRY, CATEGORY, NAME, ALTERNATE
- **LOOKUP** (4 rows): Industry → CTYPE category mappings
- **JOB_TEMPLATE** (29 rows): VRP job templates with time windows and skills
- **CONFIG** (1 row): VEHICLE_TYPE='driving-car', REGION='SanFrancisco'

### OPENROUTESERVICE_APP.CORE
- **Functions:** DIRECTIONS, ISOCHRONES, OPTIMIZATION, MATRIX
- **Services:** ORS_SERVICE, ROUTING_GATEWAY_SERVICE, VROOM_SERVICE, ORS_CONTROL_APP

### SYNTHETIC_DATASETS.UNIFIED
- **FACT_VEHICLE_TELEMETRY** (474K rows): GPS telemetry for E-Bike couriers
- **FACT_TRIPS** (7.7K rows): Trip summaries with routes
- **DIM_FLEET** (150 rows): Vehicle/driver metadata
- **DIM_POIS** (10K rows): Location points

---

## Known Issues

### Issue 1: VROOM Receiving profile='unknown'
**Evidence:** VROOM logs show repeated `[Error] Parameter 'profile' has incorrect value of 'unknown'.`

**When:** Occurs during OPTIMIZATION calls (timestamps: 13:35, 13:37, 15:39)

**Analysis:**
- UI shows vehicle dropdown set to "Car" (value='driving-car')
- vrpVehicles array constructed with `profile: v.profile` from vehicles state
- Somewhere between UI → SQL → VROOM, profile becomes 'unknown'

**Possible Causes:**
1. vrpVehicles.profile field not being set correctly in line 127-129
2. JSON.stringify corrupting the profile value
3. VROOM expecting different field name (e.g., 'method' vs 'profile')
4. TypeScript type mismatch causing runtime undefined → 'unknown'

**Debug Commands:**
```typescript
// Add before line 132:
console.log('Vehicles state:', vehicles);
console.log('vrpVehicles constructed:', vrpVehicles);
console.log('vrpChallenge:', vrpChallenge);
console.log('Challenge JSON:', JSON.stringify(vrpChallenge));
```

### Issue 2: OPTIMIZATION Query Not Reaching Server
**Evidence:** Control App server logs show no OPTIMIZATION queries, even though button triggers "SOLVING VRP..."

**This means:**
- JavaScript executes through line 119 (setSolving(true))
- Fails somewhere before/during the fetch in sfQuery (line 133)
- Or sfQuery silently catches error and returns [] (line 19: `catch { return []; }`)

**Debug:** 
- Check browser Network tab for failed /api/query POST requests
- Check browser Console for uncaught exceptions
- Add try/catch with alert() around line 133 to catch errors

### Issue 3: Silent Error Handling
**File:** RouteOptimization.tsx line 13-20

```typescript
async function sfQuery(sql: string, database = RO_DB, schema = RO_SCHEMA): Promise<any[]> {
  try {
    const res = await fetch('/api/query', {...});
    const body = await res.json();
    const rows = Array.isArray(body) ? body : (body.result ?? []);
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }  // ← SWALLOWS ALL ERRORS
}
```

**Problem:** Any error (network, parse, SQL) returns empty array. No error propagates to UI or logs.

**Fix:** Change to:
```typescript
  } catch (err) { 
    console.error('[sfQuery] Error:', err, 'SQL:', sql.slice(0, 200)); 
    return []; 
  }
```

---

## Deployment History

| Version | Changes | Status |
|---------|---------|--------|
| v1.0.117 | Original (pre-fixes) | Broken - no industry filter |
| v1.0.118 | Industry filter fix attempt #1 | Partial |
| v1.0.119 | Industry filter completed | Works |
| v1.0.120 | **STABLE** - Industry filter working | ✅ POI display works |
| v1.0.121 | Added database context + agent fix | Crashed - syntax error |
| v1.0.122 | Fixed syntax + claude-sonnet-4-5 | ✅ Service runs, ❌ VRP broken, ⚠️ Agent unknown |

---

## Quick Test Queries

### Test OPTIMIZATION Function Directly:
```sql
-- Verify function exists and works
SELECT * FROM TABLE(
  OPENROUTESERVICE_APP.CORE.OPTIMIZATION(
    PARSE_JSON('{
      "jobs": [
        {"id":1, "location":[-122.4194, 37.7749], "service":300},
        {"id":2, "location":[-122.4094, 37.7849], "service":300}
      ],
      "vehicles": [
        {"id":1, "profile":"driving-car", "start":[-122.4194, 37.7749], "end":[-122.4194, 37.7749], "capacity":[10], "time_window":[0, 86400]}
      ]
    }')
  )
) LIMIT 5;
```

Expected: 1 row with RESPONSE, GEOJSON, VEHICLE=1, DURATION>0, STEPS array

### Test Agent Model:
```sql
SELECT SNOWFLAKE.CORTEX.COMPLETE('claude-sonnet-4-5', 'Say hello') AS result;
```

Expected: JSON response with "hello" message

### Check VROOM Health:
```sql
SELECT SYSTEM$GET_SERVICE_STATUS('OPENROUTESERVICE_APP.CORE.VROOM_SERVICE');
```

Expected: status='READY'

---

## Files to Debug Locally

### Priority 1: RouteOptimization.tsx
**Path:** `.cortex/skills/build-routing-solution/openrouteservice_app/services/ors_control_app/src/components/RouteOptimization.tsx`

**Key Lines:**
- Line 13-20: sfQuery function (add error logging)
- Line 39: vehicles state initialization (verify default profile)
- Line 127-130: vrpVehicles construction (where profile might become 'unknown')
- Line 132-133: OPTIMIZATION call (verify database context parameter)

**Add Debugging:**
```typescript
// Line 131, before vrpChallenge:
console.log('[DEBUG] vehicles state:', vehicles);
console.log('[DEBUG] vrpJobs:', vrpJobs);
console.log('[DEBUG] vrpVehicles:', vrpVehicles);

// Line 132:
const vrpChallenge = { jobs: vrpJobs, vehicles: vrpVehicles };
console.log('[DEBUG] vrpChallenge:', vrpChallenge);
console.log('[DEBUG] Challenge JSON string:', JSON.stringify(vrpChallenge));

// Line 133, wrap in try/catch:
try {
  const rows = await sfQuery(`SELECT * FROM TABLE(OPENROUTESERVICE_APP.CORE.OPTIMIZATION(PARSE_JSON('${JSON.stringify(vrpChallenge).replace(/'/g, "''")}')))`, 'OPENROUTESERVICE_APP', 'CORE');
  console.log('[DEBUG] OPTIMIZATION returned', rows.length, 'rows');
  console.log('[DEBUG] First row:', rows[0]);
} catch (err) {
  console.error('[DEBUG] OPTIMIZATION failed:', err);
  alert('VRP Error: ' + err);
}
```

### Priority 2: server/index.ts
**Path:** `.cortex/skills/build-routing-solution/openrouteservice_app/services/ors_control_app/server/index.ts`

**Key Lines:**
- Line 1666: AGENT_MODELS (verify claude-sonnet-4-5)
- Line ~100-150: /api/query endpoint (add request logging)

**Add Server Logging:**
```typescript
// In /api/query endpoint (around line 100-120):
app.post('/api/query', async (req, res) => {
  const { sql, database, schema } = req.body;
  console.log('[API /query] DB:', database, 'Schema:', schema);
  console.log('[API /query] SQL:', sql.slice(0, 300));
  
  try {
    const rows = await runSql(sql, database, schema);
    console.log('[API /query] Returned', rows?.length || 0, 'rows');
    res.json(rows);
  } catch (err: any) {
    console.error('[API /query] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
```

---

## Suspected Root Cause: vrpVehicles.profile Issue

**Hypothesis:** The vehicles array profile is somehow undefined/null, and JavaScript converts it to 'unknown' somewhere.

**Check:**
1. Line 39 default: `profile: 'driving-car'` ✅
2. Line 127-129: `profile: v.profile` - if v.profile is undefined, what happens?
3. Line 132: JSON.stringify - if profile is undefined, becomes `"profile": null` or omitted
4. VROOM parses JSON, gets null/undefined, defaults to 'unknown'

**Solution:**
```typescript
// Line 127-129, add fallback:
const vrpVehicles = vehicles.map((v, i) => ({
  id: i + 1, 
  profile: v.profile || 'driving-car',  // ← ADD FALLBACK
  start: [v.startLng, v.startLat], 
  end: [v.endLng, v.endLat],
  capacity: [v.capacity], 
  time_window: [0, 86400],
}));
```

---

## Build & Deploy Workflow

### After fixing locally:

```bash
cd .cortex/skills/build-routing-solution/openrouteservice_app

# Bump version
# image-versions.env: ORS_CONTROL_APP_TAG=v1.0.123
# services/ors_control_app/ors_control_app_service.yaml: 
#   - image: v1.0.123
#   - APP_VERSION: "1.0.123"

# Build
npm install --legacy-peer-deps
npm run build
npm run build:server

# Push image
snow spcs image-registry login -c <connection>
REPO_URL=$(snow spcs image-repository url OPENROUTESERVICE_APP.CORE.image_repository -c <connection>)

docker build --platform linux/amd64 \
  -f services/ors_control_app/Dockerfile.runtime \
  -t $REPO_URL/ors_control_app:v1.0.123 \
  services/ors_control_app

docker push $REPO_URL/ors_control_app:v1.0.123

# Verify SHA changed
snow spcs image-repository list-images OPENROUTESERVICE_APP.CORE.image_repository -c <connection> | grep v1.0.123

# Deploy via Workspace (already set up)
```

Then in Snowflake Workspace, tell Cortex Code to deploy v1.0.123.

---

## Quick Wins for Debugging

### 1. Enable Verbose Logging
Add to RouteOptimization.tsx top:
```typescript
const DEBUG = true;
function log(...args: any[]) { if (DEBUG) console.log('[RouteOpt]', ...args); }
```

Use `log()` everywhere instead of console.log.

### 2. Add Server Request Logging
In server/index.ts /api/query endpoint:
```typescript
console.log(`[/api/query] ${database}.${schema} | ${sql.slice(0, 200)}`);
```

This will show in Control App service logs.

### 3. Test with Minimal VRP
Hardcode a minimal test:
```typescript
const testChallenge = {
  jobs: [{"id":1, "location":[-122.42, 37.77], "service":300}],
  vehicles: [{"id":1, "profile":"driving-car", "start":[-122.42, 37.77], "end":[-122.42, 37.77], "capacity":[10], "time_window":[0,86400]}]
};
const rows = await sfQuery(`SELECT * FROM TABLE(OPENROUTESERVICE_APP.CORE.OPTIMIZATION(PARSE_JSON('${JSON.stringify(testChallenge)}')))`, 'OPENROUTESERVICE_APP', 'CORE');
```

If this works, the issue is in vrpJobs or vrpVehicles construction from UI state.

---

## Snowflake Account Context

- **Account:** dcb91786.prod3.us-west-2.aws
- **Role:** ACCOUNTADMIN
- **Warehouse:** DEFAULT_WH (also ROUTING_ANALYTICS for queries)
- **Compute Pool:** OPENROUTESERVICE_APP_COMPUTE_POOL (5 HIGHMEM_X64_S nodes, ACTIVE)

---

## Questions for Local Cortex

1. "Why would vehicles[0].profile be 'unknown' when initialized as 'driving-car'?"
2. "Review RouteOptimization.tsx line 127-133 for issues with JSON.stringify and SQL escaping"
3. "Check if OPTIMIZATION function signature matches the challenge object structure"
4. "Why would sfQuery not log anything when fetch fails?"

---

## Expected Working Behavior

When "Optimize Routes" works correctly:
1. User clicks button
2. UI constructs challenge JSON with jobs (30 POIs) + vehicles (1 vehicle)
3. Calls OPTIMIZATION function in OPENROUTESERVICE_APP.CORE
4. VROOM service receives request, solves VRP
5. Returns route steps with geometry
6. UI calls DIRECTIONS for each vehicle's route
7. Map displays optimized route polylines
8. Metrics show "Routes: 1", duration/distance

---

## Contacts & Links

- **Control App:** https://iqdpdnb-sfsehol-test-summit-routing-sdnnjc.snowflakecomputing.app
- **Git Repo:** https://github.com/Snowflake-Labs/sfguide-create-a-route-optimisation-and-vehicle-route-plan-simulator
- **Branch:** SUMMIT
- **Workspace:** USER$.PUBLIC."sfguide-create-a-route-optimisation-and-vehicle-route-plan-simulator"

---

## Next Steps

1. Apply all fixes from workspace to local files
2. Add comprehensive logging (console + server)
3. Build v1.0.123 with logging
4. Test with browser DevTools open
5. Identify exact failure point
6. Fix and rebuild v1.0.124 (final)

The industry filter fix proves the data and infrastructure work. The VRP issue is purely a UI→function integration bug.
