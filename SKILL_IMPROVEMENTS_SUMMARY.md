# Skill Improvements Summary
**Date:** 2026-05-08  
**Changes:** Fixed file upload workflow and data quality issues

## Issues Identified

### 1. Missing San Francisco Map File
- **Problem:** `SanFrancisco.osm.pbf` (~25MB) was never uploaded to stage during `build-routing-solution`
- **Impact:** ORS service started with only example Heidelberg test file, causing all routing profiles to show as "unknown"
- **Symptom:** All isochrone calls returned empty results, fleet delivery catchment analysis failed

### 2. Nested Path Upload Issue (Workspace)
- **Problem:** Workspace `COPY FILES` command with nested source paths created nested stage directories
- **Example:** `.cortex/skills/.../file.pbf` uploaded as `stage/.cortex/skills/.../file.pbf` instead of `stage/file.pbf`
- **Impact:** ORS service couldn't find map files at expected paths (`/home/ors/files/SanFrancisco.osm.pbf`)

### 3. Restaurant Names with Quotes
- **Problem:** Seed data had restaurant names wrapped in quotes (e.g., `"Starbucks"`)
- **Impact:** UI displayed restaurant names with visible quotes

### 4. Missing Profile Configuration
- **Problem:** `cycling-regular` profile was disabled in ors-config.yml
- **Impact:** Catchment panel defaulted to `cycling-electric` which wasn't enabled in default config

## Solutions Implemented

### A. Enhanced Step 4: Upload Configuration Files

**New Structure:**
- **Step 4a:** Upload service specification files (YAML)
- **Step 4b:** Upload ORS configuration and map files (CRITICAL)
- **Step 4c:** Verify uploads (MANDATORY stopping point)

**Key Improvements:**

1. **Explicit Workspace Instructions**
   - Clear guidance on copying files to workspace root first
   - Two-step SQL approach for large binary files
   - `REMOVE` commands to clean up nested uploads

2. **Mandatory Verification Step (4c)**
   - File size validation table
   - Nested path detection
   - Config content verification
   - Clear pass/fail criteria before proceeding

3. **Critical File Warnings**
   - Highlighted SanFrancisco.osm.pbf as MANDATORY (~25MB)
   - Emphasized ors-config.yml profile requirements
   - Added specific error messages for missing files

**Example Workspace Workflow:**
```sql
-- 1. Write ors-config.yml to workspace root (using read + write tools)
-- 2. Upload from flat path
COPY FILES INTO @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/SanFrancisco/
FROM 'snow://workspace/.../versions/live/'
FILES=('ors-config.yml');

-- 3. Copy OSM file within workspace stage (nested → root)
COPY FILES INTO 'snow://workspace/.../versions/live/'
FROM 'snow://workspace/.../versions/live/'
FILES=('.cortex/skills/.../SanFrancisco.osm.pbf');

-- 4. Upload from root to ORS stage
COPY FILES INTO @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/SanFrancisco/
FROM 'snow://workspace/.../versions/live/'
FILES=('SanFrancisco.osm.pbf');

-- 5. Verify (MANDATORY)
LIST @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE;
```

### B. Updated ors-config.yml Defaults

**Changed:**
```yaml
cycling-regular:
  enabled: true    # Was: false
cycling-electric:
  enabled: true    # Already true
```

**Rationale:**
- Provides fallback profile for catchment analysis
- Supports both regular and electric bike routing

### C. Fixed Restaurant Name Display

**Updated View:**
```sql
SELECT
    p.LOCATION_ID AS RESTAURANT_ID,
    REPLACE(p.NAME, '"', '') AS RESTAURANT_NAME,  -- Strip quotes
    ...
FROM SYNTHETIC_DATASETS.UNIFIED.DIM_POIS p
```

**Files Updated:**
- `.cortex/skills/fleet-intelligence-food-delivery/references/sql-projection-views.sql`
- Already applied to deployed `RESTAURANTS_ENRICHED` view

### D. Updated CatchmentPanel Default Profile

**Changed:**
```typescript
const [travelMode, setTravelMode] = useState('cycling-regular');  // Was: 'cycling-electric'
```

**File:** `.cortex/skills/build-routing-solution/openrouteservice_app/services/ors_control_app/src/components/fleet-delivery/CatchmentPanel.tsx`

**Note:** Requires ors_control_app image rebuild and service restart to take effect

### E. Enhanced Troubleshooting Section

**New Categories:**
- File Upload Issues (Step 4)
- Runtime Issues (missing maps/configs)
- Workspace-specific problems

**Common Issues Added:**
- SanFrancisco.osm.pbf missing from stage
- Files uploaded with nested paths
- ors-config.yml missing required profiles
- "profile unknown" errors
- ORS service logs show "No config file found"

### F. Updated Stopping Points

**Added:**
- **Step 4c:** MANDATORY STOP — Verify all files before proceeding

**Rationale:** Missing map files cause silent failures that are hard to debug later

## Testing Performed

1. ✅ Restaurant names now display without quotes in SQL queries
2. ✅ `ors-config.yml` uploaded to stage successfully
3. ✅ Verified nested file cleanup with `REMOVE @stage/.cortex/`
4. ⚠️ San Francisco OSM map still needs upload (25MB file, workspace limitation)
5. ⚠️ ors_control_app needs rebuild for CatchmentPanel fix (requires Docker locally)

## Deployment Status

**Completed:**
- ✅ Skill documentation updated
- ✅ SQL views fixed for restaurant names
- ✅ ors-config.yml uploaded with correct profiles
- ✅ CatchmentPanel source code updated

**Requires User Action:**
- ⚠️ Upload SanFrancisco.osm.pbf using Step 4b workspace alternative
- ⚠️ Rebuild and redeploy ors_control_app image (requires Docker)
- ⚠️ Restart ORS service after map upload

## Verification Commands

### Check Stage Contents
```sql
LIST @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE;
```

### Verify Map File
```sql
-- Should show ~25MB file at flat path
SELECT * FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
WHERE name = 'ors_spcs_stage/SanFrancisco/SanFrancisco.osm.pbf';
```

### Test Isochrone
```sql
-- Should return valid GeoJSON geometry, not empty
SELECT GEOJSON 
FROM TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES('cycling-regular', -122.43::FLOAT, 37.77::FLOAT, 10::INT))
LIMIT 1;
```

### Verify Restaurant Names
```sql
-- Should show names without quotes
SELECT RESTAURANT_NAME 
FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.RESTAURANTS_ENRICHED 
LIMIT 5;
```

## Impact Assessment

### High Impact (Blocking)
1. Missing San Francisco map → All routing functionality broken
2. Nested path uploads → Services can't find files

### Medium Impact (Degraded UX)
3. Restaurant names with quotes → Poor UI display
4. Wrong default profile → Catchment analysis fails on first load

### Low Impact (Minor UX)
5. Missing verification step → Late-stage failures hard to debug

## Recommendations

### For Users
1. **Always run Step 4c verification** before proceeding to Step 5
2. **In Workspace:** Copy large binary files to root before uploading
3. **Check ORS service logs** after deployment to verify graph building

### For Skill Maintainers
1. Consider providing pre-staged map files in a public stage
2. Add automated verification SQL script for Step 4c
3. Document Workspace file size limitations (<100MB recommended)
4. Create video walkthrough for Workspace file upload workflow

## Files Modified

1. `.cortex/skills/build-routing-solution/SKILL.md`
   - Complete rewrite of Step 4 (4a, 4b, 4c)
   - Updated Stopping Points
   - Enhanced Troubleshooting section

2. `.cortex/skills/fleet-intelligence-food-delivery/references/sql-projection-views.sql`
   - Added `REPLACE(p.NAME, '"', '')` for restaurant names

3. `.cortex/skills/build-routing-solution/openrouteservice_app/services/ors_control_app/src/components/fleet-delivery/CatchmentPanel.tsx`
   - Changed default travelMode to 'cycling-regular'

4. `ors-config.yml` (workspace root)
   - Enabled cycling-regular profile
   - Uploaded to stage

## Next Steps

1. Complete SanFrancisco.osm.pbf upload using updated Step 4b instructions
2. Verify all files with Step 4c queries
3. Restart ORS service to build routing graphs
4. Test isochrones with cycling-regular profile
5. (Optional) Rebuild ors_control_app for CatchmentPanel fix
