# ORS Routing Profile Mapping

**Date:** 2026-05-08  
**Application:** Fleet Intelligence - Catchment Analysis  

## UI Travel Mode → ORS Profile Mapping

The Catchment Analysis panel in the ORS Control App displays **3 user-friendly travel modes** that map to specific OpenRouteService routing profiles:

| UI Display | ORS Profile | Config Status | Graph Status | Use Case |
|------------|-------------|---------------|--------------|----------|
| **EBike** | `cycling-electric` | ✅ Enabled | ✅ Built | Electric bike couriers (most common for food delivery) |
| **Bicycle** | `cycling-regular` | ✅ Enabled | ✅ Built | Regular bicycle couriers |
| **Walking** | `foot-walking` | ✅ Enabled | ✅ Built | Pedestrian delivery (short distances) |

## Additional Enabled Profiles (Not in UI)

These profiles are enabled for other use cases but not exposed in the Catchment Analysis UI:

| ORS Profile | Config Status | Graph Status | Use Case |
|-------------|---------------|--------------|----------|
| `driving-car` | ✅ Enabled | ✅ Built | Car-based delivery (future use) |
| `driving-hgv` | ✅ Enabled | ✅ Built | Heavy vehicle routing (future use) |

## Disabled Profiles

| ORS Profile | Reason |
|-------------|--------|
| `cycling-road` | Specialized road bike (not needed for delivery) |
| `cycling-mountain` | Off-road cycling (not relevant for urban delivery) |
| `foot-hiking` | Trail hiking (not needed for urban delivery) |
| `wheelchair` | Accessibility routing (future consideration) |

---

## Technical Details

### Profile Configuration Location
- **Config file:** `@OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/SanFrancisco/ors-config.yml`
- **Map file:** `@OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/SanFrancisco/.cortex/skills/.../SanFrancisco.osm.pbf` (25MB)
- **Graphs:** `@OPENROUTESERVICE_APP.CORE.ORS_GRAPHS_SPCS_STAGE/SanFrancisco/`

### Profile Build Status
All 5 enabled profiles were built on **2026-05-08 21:40-21:42** from San Francisco OSM map:

```
✅ driving-car (21:40:40 - 21:40:54)
✅ driving-hgv (21:40:55 - 21:41:17)
✅ cycling-regular (21:41:17 - 21:41:34)
✅ cycling-electric (21:41:34 - 21:41:53)
✅ foot-walking (21:41:53 - graphs exist)
```

**Total build time:** ~13 minutes for 5 profiles

### API Testing
```sql
-- Test EBike profile
SELECT OPENROUTESERVICE_APP.CORE._ISOCHRONES_RAW(
    'cycling-electric', 
    -122.4194::FLOAT, 
    37.7749::FLOAT, 
    10::INT, 
    NULL
) AS response;

-- Test Bicycle profile
SELECT OPENROUTESERVICE_APP.CORE._ISOCHRONES_RAW(
    'cycling-regular', 
    -122.4194::FLOAT, 
    37.7749::FLOAT, 
    10::INT, 
    NULL
) AS response;

-- Test Walking profile
SELECT OPENROUTESERVICE_APP.CORE._ISOCHRONES_RAW(
    'foot-walking', 
    -122.4194::FLOAT, 
    37.7749::FLOAT, 
    10::INT, 
    NULL
) AS response;
```

---

## Catchment Panel Implementation

**Component:** `CatchmentPanel.tsx` (Fleet Delivery dashboard)

**Travel Mode State:**
```typescript
const [travelMode, setTravelMode] = useState('cycling-regular');
```

**Default:** Bicycle (`cycling-regular`)

**Options:** User can switch between:
1. EBike (`cycling-electric`)
2. Bicycle (`cycling-regular`)
3. Walking (`foot-walking`)

---

## Changing Travel Modes

### To Add a New Travel Mode to UI:

1. **Update CatchmentPanel.tsx:**
   ```typescript
   const travelModeOptions = [
     { label: 'EBike', value: 'cycling-electric' },
     { label: 'Bicycle', value: 'cycling-regular' },
     { label: 'Walking', value: 'foot-walking' },
     { label: 'Driving', value: 'driving-car' },  // NEW
   ];
   ```

2. **Verify profile is enabled in ors-config.yml**

3. **Rebuild ors_control_app image:**
   ```bash
   docker build --platform linux/amd64 \
     -f Dockerfile.runtime \
     -t <repo>/ors_control_app:vX.Y.Z \
     .
   docker push <repo>/ors_control_app:vX.Y.Z
   ```

4. **Update service and restart**

### To Enable a New ORS Profile:

1. **Edit ors-config.yml:**
   ```yaml
   cycling-road:
     enabled: true  # Change from false
   ```

2. **Upload to stage:**
   ```sql
   COPY FILES INTO @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/SanFrancisco/
   FROM 'snow://workspace/.../versions/live/'
   FILES=('ors-config.yml');
   ```

3. **Clear graphs and rebuild:**
   ```sql
   REMOVE @OPENROUTESERVICE_APP.CORE.ORS_GRAPHS_SPCS_STAGE/SanFrancisco/;
   ALTER SERVICE OPENROUTESERVICE_APP.CORE.ORS_SERVICE SUSPEND;
   ALTER SERVICE OPENROUTESERVICE_APP.CORE.ORS_SERVICE RESUME;
   ```

4. **Wait 10-15 minutes for graph building**

---

## Performance Characteristics

| Profile | Speed | Typical Range (10 min) | Use Case |
|---------|-------|------------------------|----------|
| `foot-walking` | ~5 km/h | ~800m radius | Very short deliveries |
| `cycling-regular` | ~15 km/h | ~2.5 km radius | Standard bike delivery |
| `cycling-electric` | ~20 km/h | ~3.3 km radius | Fast urban delivery |
| `driving-car` | ~40 km/h (urban) | ~6.5 km radius | Car-based delivery |

**Note:** Actual distances vary based on:
- Road network topology
- Traffic restrictions
- One-way streets
- Bike lanes availability
- Elevation changes (San Francisco hills!)

---

## Region Configuration

**Current Region:** San Francisco  
**Config Table:** `FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.CONFIG`

```sql
-- View current config
SELECT VEHICLE_TYPE, REGION FROM FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.CONFIG;

-- Update to match deployed data
UPDATE FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.CONFIG 
SET VEHICLE_TYPE = 'ebike', REGION = 'SanFrancisco';
```

**Map Coverage:**
- Entire San Francisco Bay Area
- OSM file: 25MB (SanFrancisco.osm.pbf)
- Coordinate bounds: Approximately -122.52 to -122.35 (lon), 37.70 to 37.83 (lat)

---

## Troubleshooting

### Travel Mode Not Working

1. **Check profile is enabled:**
   ```sql
   SELECT $1 FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/SanFrancisco/ors-config.yml
   (FILE_FORMAT => text_format) LIMIT 50;
   ```

2. **Verify graphs exist:**
   ```sql
   LIST @OPENROUTESERVICE_APP.CORE.ORS_GRAPHS_SPCS_STAGE/SanFrancisco/<profile>/;
   ```

3. **Test API directly:**
   ```sql
   SELECT OPENROUTESERVICE_APP.CORE._ISOCHRONES_RAW('<profile>', -122.42::FLOAT, 37.77::FLOAT, 5::INT, NULL);
   ```

### Catchment Returns Empty

- **Coordinates outside map bounds:** Verify lat/lon are in San Francisco
- **Time range too small:** Increase from 5 to 10 minutes
- **Service not running:** Check `SHOW SERVICES IN DATABASE OPENROUTESERVICE_APP;`

### Profile Shows as "Unknown"

- **Graphs not built yet:** Wait 10-15 minutes after config change
- **Old graphs cached:** Clear and rebuild (see "To Enable a New ORS Profile" above)
- **Config/graph mismatch:** Verify config profile name matches graph directory name exactly

---

## References

- **ORS Documentation:** https://giscience.github.io/openrouteservice/
- **Profile Specifications:** https://giscience.github.io/openrouteservice/run-instance/configuration/
- **Skill Documentation:** `.cortex/skills/build-routing-solution/SKILL.md`
- **Map Upload Guide:** `.cortex/skills/build-routing-solution/upload-map-files/SKILL.md`
