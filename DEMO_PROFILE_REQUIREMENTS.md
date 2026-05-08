# Demo Routing Profile Requirements

## Analysis: Which Demos Need Which Profiles

### 1. Fleet Intelligence: Food Delivery
**Primary Use Case:** E-bike couriers delivering food  
**Required Profiles:**
- ✅ `cycling-electric` - Primary courier vehicle (e-bikes)
- ✅ `cycling-regular` - Backup for regular bike couriers
- ⚠️ `driving-car` - Optional for car-based delivery (Uber Eats, DoorDash cars)

**Catchment Analysis Needs:** 3 modes (Car, E-Bike, Bike) or (E-Bike, Bike, Walking)

---

### 2. Fleet Intelligence: Taxis
**Primary Use Case:** Taxi GPS telemetry and routing  
**Required Profiles:**
- ✅ `driving-car` - Standard taxi vehicles
- ❌ No cycling or walking needed

**Route Planning:** Car-only

---

### 3. Route Deviation
**Primary Use Case:** Detour detection comparing planned vs actual routes  
**Required Profiles:**
- ✅ `cycling-electric` - If using ebike telemetry data
- ✅ `driving-car` - If using car/taxi data
- Depends on vehicle type in `FACT_TRIPS.VEHICLE_TYPE`

**Current Seed Data:** Uses `ebike` vehicle type → needs `cycling-electric`

---

### 4. Dwell Analysis
**Primary Use Case:** Traffic congestion and dwell time detection  
**Required Profiles:**
- ✅ `driving-car` - Most relevant for traffic analysis
- ✅ `cycling-electric` - If analyzing bike courier dwell/congestion
- Depends on vehicle type in telemetry data

**Current Seed Data:** Uses `ebike` vehicle type → needs `cycling-electric`

---

### 5. Retail Catchment
**Primary Use Case:** Store location analysis with drive-time zones  
**Required Profiles:**
- ✅ `driving-car` - Primary mode for retail (customers driving to store)
- ✅ `foot-walking` - Urban/pedestrian catchment analysis
- ✅ `cycling-regular` - Bike-friendly cities, urban areas
- ⚠️ `cycling-electric` - Optional for e-bike accessibility

**Catchment Analysis Needs:** ALL 3 transport modes (Driving, Cycling, Walking)

---

### 6. Route Optimization
**Primary Use Case:** VRP (Vehicle Routing Problem) solving  
**Required Profiles:**
- ✅ `driving-car` - Standard delivery vehicle routing
- ⚠️ `cycling-electric` - Optional for bike courier optimization
- ⚠️ `driving-hgv` - Optional for truck fleet optimization

**VROOM Service:** Can use any enabled profile, typically `driving-car`

---

### 7. Routing Agent
**Primary Use Case:** Natural language routing queries  
**Required Profiles:**
- ✅ ALL profiles - Agent should support any user query
- User might ask: "What's the bike route from X to Y?"
- Agent needs flexibility to handle any transport mode

---

## Recommended Profile Configuration

### Minimal Configuration (Core Demos Only)
**Enable:** `driving-car`, `cycling-electric`  
**Covers:** Food Delivery, Taxis, Route Deviation, Dwell Analysis  
**Missing:** Retail Catchment (no walking), limited Agent capability

### Standard Configuration (Most Demos)
**Enable:** `driving-car`, `cycling-electric`, `foot-walking`  
**Covers:** All demos except specialized use cases  
**Graph Build Time:** ~35-40 minutes

### Comprehensive Configuration (All Demos + Full Agent)
**Enable:** `driving-car`, `driving-hgv`, `cycling-electric`, `cycling-regular`, `foot-walking`  
**Covers:** ALL demos, full Agent capability, all catchment modes  
**Graph Build Time:** ~50-60 minutes  
**Recommended:** ✅ This configuration

---

## Current Deployment Gap Analysis

**Currently Enabled:**
- ✅ `driving-car`
- ✅ `driving-hgv`
- ✅ `cycling-electric`
- ✅ `cycling-regular`
- ✅ `foot-walking`

**Graph Status:**
- ✅ `driving-car` - Built (21:40:54)
- ✅ `driving-hgv` - Built (21:41:17)
- ✅ `cycling-electric` - Built (21:41:53)
- ⚠️ `cycling-regular` - Built but not loading (profile unknown error)
- ⚠️ `foot-walking` - Not built yet (recently enabled)

**Action Required:**
1. ✅ Config already has all 5 profiles enabled
2. ⚠️ Need to rebuild graphs for `cycling-regular` and `foot-walking`
3. ⚠️ Service restart in progress (will load all graphs)

---

## Profile-to-Demo Mapping Matrix

| Demo | driving-car | driving-hgv | cycling-electric | cycling-regular | foot-walking |
|------|-------------|-------------|------------------|-----------------|--------------|
| **Food Delivery** | Optional | ❌ | **Required** | Recommended | Optional |
| **Taxis** | **Required** | ❌ | ❌ | ❌ | ❌ |
| **Route Deviation** | Optional | ❌ | **Required** | ❌ | ❌ |
| **Dwell Analysis** | Optional | ❌ | **Required** | ❌ | ❌ |
| **Retail Catchment** | **Required** | ❌ | Optional | **Required** | **Required** |
| **Route Optimization** | **Required** | Optional | Optional | ❌ | ❌ |
| **Routing Agent** | **Required** | Recommended | **Required** | **Required** | **Required** |

**Key:**
- **Required** = Demo won't work without this profile
- Recommended = Demo works better with this profile
- Optional = Nice to have, not essential
- ❌ = Not needed for this demo

---

## Catchment Analysis Mode Mapping

### Fleet Delivery Catchment Panel
**Modes Available:**
1. 🚗 **Car** → `driving-car`
2. ⚡ **E-Bike** → `cycling-electric`
3. 🚴 **Bike** → `cycling-regular`

**Current Status:**
- ✅ `driving-car` - Working
- ✅ `cycling-electric` - Working
- ⚠️ `cycling-regular` - Needs graph reload

---

### Retail Catchment Panel
**Modes Available:**
1. 🚗 **Driving** → `driving-car`
2. 🚴 **Cycling** → `cycling-regular`
3. 🚶 **Walking** → `foot-walking`

**Current Status:**
- ✅ `driving-car` - Working
- ⚠️ `cycling-regular` - Needs graph reload
- ⚠️ `foot-walking` - Needs graph build

---

## Graph Rebuild Strategy

### Option A: Fast Rebuild (30 minutes)
**Rebuild Only:**
- `cycling-regular` (needed for Retail Catchment)
- `foot-walking` (needed for Retail Catchment)

**Graphs to Keep:**
- `driving-car` (already working)
- `driving-hgv` (already working)
- `cycling-electric` (already working)

**Issue:** Can't rebuild selectively - ORS rebuilds ALL enabled profiles

---

### Option B: Full Rebuild (50-60 minutes) - RECOMMENDED
**Steps:**
1. Clear all graphs: `REMOVE @ORS_GRAPHS_SPCS_STAGE/SanFrancisco/;`
2. Restart service: Service detects empty graphs and rebuilds ALL 5 profiles
3. Wait for completion: Monitor graph files appearing in stage

**Benefits:**
- ✅ All demos work
- ✅ All catchment modes available
- ✅ Agent supports all transport modes
- ✅ Consistent graph versions
- ✅ Future-proof configuration

---

## Implementation Checklist

### Phase 1: Configuration ✅
- [x] Enable `driving-car`
- [x] Enable `driving-hgv`
- [x] Enable `cycling-electric`
- [x] Enable `cycling-regular`
- [x] Enable `foot-walking`
- [x] Upload ors-config.yml to stage

### Phase 2: Graph Rebuild ⏳
- [ ] Clear old graphs (optional - service already restarting)
- [ ] Service restart completes (~30 seconds)
- [ ] Wait for graph building (50-60 minutes for all 5 profiles)
- [ ] Verify all profiles return valid isochrones

### Phase 3: Demo Verification ⏳
- [ ] Test Food Delivery catchment (Car, E-Bike, Bike)
- [ ] Test Retail Catchment (Driving, Cycling, Walking)
- [ ] Test Routing Agent with all transport modes
- [ ] Test Route Deviation with ebike data
- [ ] Verify Taxis work with driving-car

---

## Expected Graph Build Timeline

**Per Profile (San Francisco map, 25MB):**
- `driving-car`: ~14 minutes (largest road network)
- `driving-hgv`: ~22 minutes (truck restrictions, weight limits)
- `cycling-electric`: ~19 minutes (bike lanes, elevation)
- `cycling-regular`: ~17 minutes (similar to electric)
- `foot-walking`: ~15 minutes (pedestrian paths, crosswalks)

**Total Sequential Build Time:** ~87 minutes (profiles built one at a time)  
**Typical Parallel Optimization:** ~50-60 minutes (ORS builds multiple profiles in parallel)

---

## Verification SQL

### After Graph Build Completes
```sql
-- Test all 5 profiles with 10-minute isochrones
SELECT 
    profile,
    CASE 
        WHEN response LIKE '%error%' THEN '❌ Failed'
        WHEN LENGTH(response::STRING) > 500 THEN '✅ Working'
        ELSE '⚠️ Unknown'
    END AS status,
    LENGTH(response::STRING) AS response_size_bytes,
    ROUND((JSON_EXTRACT_PATH_TEXT(response, 'bbox[2]')::FLOAT - 
           JSON_EXTRACT_PATH_TEXT(response, 'bbox[0]')::FLOAT) * 111, 2) AS catchment_width_km
FROM (
    SELECT 'driving-car' AS profile,
           OPENROUTESERVICE_APP.CORE._ISOCHRONES_RAW('driving-car', -122.42::FLOAT, 37.77::FLOAT, 10::INT, NULL) AS response
    UNION ALL
    SELECT 'driving-hgv',
           OPENROUTESERVICE_APP.CORE._ISOCHRONES_RAW('driving-hgv', -122.42::FLOAT, 37.77::FLOAT, 10::INT, NULL)
    UNION ALL
    SELECT 'cycling-electric',
           OPENROUTESERVICE_APP.CORE._ISOCHRONES_RAW('cycling-electric', -122.42::FLOAT, 37.77::FLOAT, 10::INT, NULL)
    UNION ALL
    SELECT 'cycling-regular',
           OPENROUTESERVICE_APP.CORE._ISOCHRONES_RAW('cycling-regular', -122.42::FLOAT, 37.77::FLOAT, 10::INT, NULL)
    UNION ALL
    SELECT 'foot-walking',
           OPENROUTESERVICE_APP.CORE._ISOCHRONES_RAW('foot-walking', -122.42::FLOAT, 37.77::FLOAT, 10::INT, NULL)
)
ORDER BY profile;
```

**Expected Results:**
| Profile | Status | Width (km) |
|---------|--------|------------|
| cycling-electric | ✅ Working | ~8.5 |
| cycling-regular | ✅ Working | ~6.5 |
| driving-car | ✅ Working | ~12 |
| driving-hgv | ✅ Working | ~12 |
| foot-walking | ✅ Working | ~3 |

---

## Recommendation: Comprehensive Configuration

**Enable ALL 5 Profiles:**
✅ `driving-car`, `driving-hgv`, `cycling-electric`, `cycling-regular`, `foot-walking`

**Rationale:**
1. **Complete Demo Coverage** - All demos work out of the box
2. **Flexible Catchment Analysis** - All 3 transport modes available
3. **Full Agent Capability** - Agent can answer any routing question
4. **Future-Proof** - New demos won't need graph rebuilds
5. **Marginal Cost** - Build time is ~60 min vs ~40 min for minimal config

**Trade-off:**
- ⏱️ Longer initial build time (60 min vs 35 min)
- 💾 More storage (~100 MB vs ~60 MB graphs)
- ✅ But: Only rebuild once, all demos work forever

---

**Status:** Configuration complete ✅, graphs rebuilding now ⏳
