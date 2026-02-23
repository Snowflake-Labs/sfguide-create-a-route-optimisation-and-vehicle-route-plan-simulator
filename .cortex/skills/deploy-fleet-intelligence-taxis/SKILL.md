---
name: generate-taxi-driver-locations
description: "Generate realistic taxi driver location data for the Fleet Intelligence solution using Overture Maps data and OpenRouteService for actual road routes. Configurable location (San Francisco, New York, London, etc.), number of drivers (default 80), days of simulation (default 1), and shift patterns. Use when: setting up driver location data, generating route-based simulation, deploying fleet dashboard. Triggers: generate driver locations, create driver data, setup fleet data, deploy streamlit, fleet intelligence dashboard."
---

# Generate Driver Locations & Deploy Fleet Intelligence Dashboard

Generates realistic taxi driver location data for the Fleet Intelligence solution using:
- **Overture Maps Places & Addresses** - Points of interest and street addresses for pickup/dropoff locations
- **OpenRouteService Native App** - Real road routing for actual driving paths
- **Route Interpolation** - Driver positions along actual roads
- **Configurable Location** - San Francisco, New York, London, Paris, and more
- **Configurable Fleet Size** - Set number of drivers and simulation days

---

## ⚠️ IMPORTANT: Location Must Match OpenRouteService Configuration

> **Before selecting a location, verify your OpenRouteService Native App is configured for that region.**
>
> The OpenRouteService app uses map data (OSM PBF files) for a specific geographic area. If you select a location that is **outside** the area configured in your ORS app, route generation will fail.
>
> **To check your ORS configuration:**
> 1. Look at the OSM PBF file used during ORS setup (e.g., `SanFrancisco.osm.pbf`, `NewYork.osm.pbf`)
> 2. Or test a route in your target city using the ORS function tester
>
> **Common configurations:**
> - `SanFrancisco.osm.pbf` → Use **San Francisco** location
> - `new-york.osm.pbf` → Use **New York** location
> - `great-britain.osm.pbf` → Use **London** location
> - `europe.osm.pbf` → Use any European city

---

## Configuration Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `LOCATION` | San Francisco | City/region for the simulation |
| `NUM_DRIVERS` | 80 | Total number of taxi drivers |
| `NUM_DAYS` | 1 | Number of days to simulate |
| `START_DATE` | 2015-06-24 | First day of simulation |
| `WAREHOUSE_SIZE` | MEDIUM | Warehouse size for data generation |

---

## Supported Locations (Pre-configured)

| Location | Bounding Box | Center Coords | Notes |
|----------|--------------|---------------|-------|
| **San Francisco** | -122.52 to -122.35, 37.70 to 37.82 | -122.42, 37.77 | Default |
| **New York** | -74.05 to -73.90, 40.65 to 40.85 | -73.97, 40.75 | Manhattan focus |
| **London** | -0.20 to 0.05, 51.45 to 51.55 | -0.12, 51.51 | Central London |
| **Paris** | 2.25 to 2.42, 48.82 to 48.90 | 2.35, 48.86 | Central Paris |
| **Chicago** | -87.75 to -87.55, 41.80 to 41.95 | -87.63, 41.88 | Downtown |
| **Los Angeles** | -118.35 to -118.15, 33.95 to 34.15 | -118.25, 34.05 | Central LA |
| **Seattle** | -122.45 to -122.25, 47.55 to 47.70 | -122.33, 47.61 | Downtown |
| **Boston** | -71.15 to -70.95, 42.30 to 42.40 | -71.06, 42.36 | Central Boston |
| **Sydney** | 151.15 to 151.30, -33.92 to -33.82 | 151.21, -33.87 | CBD area |
| **Singapore** | 103.75 to 103.95, 1.25 to 1.40 | 103.85, 1.35 | Central |

---

## Using a Custom Location (Any City)

**The skill works with ANY city worldwide** - the pre-configured locations above are just examples. To use a different city:

### Step 1: Find Your City's Bounding Box

Use one of these methods to get the bounding box coordinates (min/max longitude and latitude):

**Option A: Use OpenStreetMap**
1. Go to [OpenStreetMap](https://www.openstreetmap.org)
2. Navigate to your city and zoom to the area you want
3. Click "Export" in the top menu
4. The bounding box coordinates are shown (or click "Manually select a different area")

**Option B: Use Google Maps**
1. Navigate to your city center
2. Note the coordinates from the URL (e.g., `@51.5074,-0.1278,12z`)
3. Add/subtract ~0.1-0.15 degrees for the bounding box

**Option C: Use a Bounding Box Tool**
- [Bounding Box Tool](http://bboxfinder.com) - Draw a box and get coordinates
- [Klokantech Bounding Box](https://boundingbox.klokantech.com/) - Multiple format outputs

### Step 2: Calculate Your Values

For a city centered at `(CENTER_LON, CENTER_LAT)`:

```
Bounding Box (typical city coverage ~15-20km):
  MIN_LON = CENTER_LON - 0.10
  MAX_LON = CENTER_LON + 0.10
  MIN_LAT = CENTER_LAT - 0.08
  MAX_LAT = CENTER_LAT + 0.08

Map Center:
  longitude = CENTER_LON
  latitude = CENTER_LAT
```

### Step 3: Apply to Scripts

**In `02_create_base_locations.sql`:**
```sql
WHERE ST_X(GEOMETRY) BETWEEN <MIN_LON> AND <MAX_LON>
  AND ST_Y(GEOMETRY) BETWEEN <MIN_LAT> AND <MAX_LAT>
```

**In Streamlit files:**
```python
view_state = pdk.ViewState(latitude=<CENTER_LAT>, longitude=<CENTER_LON>, zoom=12)
```

### Example: Custom City (Tokyo)

```sql
-- Tokyo bounding box (central 23 wards)
-- Center: 139.69, 35.69

-- 02_create_base_locations.sql:
WHERE ST_X(GEOMETRY) BETWEEN 139.60 AND 139.85
  AND ST_Y(GEOMETRY) BETWEEN 35.60 AND 35.78

-- Streamlit map center:
view_state = pdk.ViewState(latitude=35.69, longitude=139.69, zoom=12)
```

### Example: Custom City (Dubai)

```sql
-- Dubai bounding box (downtown + marina area)
-- Center: 55.27, 25.20

-- 02_create_base_locations.sql:
WHERE ST_X(GEOMETRY) BETWEEN 55.15 AND 55.40
  AND ST_Y(GEOMETRY) BETWEEN 25.05 AND 25.30

-- Streamlit map center:
view_state = pdk.ViewState(latitude=25.20, longitude=55.27, zoom=12)
```

### Example: Custom City (Toronto)

```sql
-- Toronto bounding box (downtown + midtown)
-- Center: -79.38, 43.65

-- 02_create_base_locations.sql:
WHERE ST_X(GEOMETRY) BETWEEN -79.50 AND -79.30
  AND ST_Y(GEOMETRY) BETWEEN 43.60 AND 43.75

-- Streamlit map center:
view_state = pdk.ViewState(latitude=43.65, longitude=-79.38, zoom=12)
```

> **Remember:** Your OpenRouteService Native App must be configured with map data that covers your chosen city. If using a custom city, ensure you have the appropriate OSM PBF file loaded in ORS.

---

## Customizing Streamlit App for Your Location

When changing the location, you need to update several files in the Streamlit app to reflect the new city name and map center.

### Files to Update

| File | What to Change |
|------|----------------|
| `SF_Taxi_Control_Center.py` | Page title, headers |
| `pages/1_Driver_Routes.py` | Headers, map center |
| `pages/2_Fleet_Heat_Map.py` | Headers, map center |

### Step-by-Step: Update for New City

**1. Main App File (`SF_Taxi_Control_Center.py`)**

Find and replace the city name in headers:

```python
# FROM (San Francisco):
st.markdown('<h0black>San Francisco Taxi |</h0black><h0blue> Fleet Intelligence</h0blue>')

# TO (example for New York):
st.markdown('<h0black>New York Taxi |</h0black><h0blue> Fleet Intelligence</h0blue>')

# TO (example for London):
st.markdown('<h0black>London Taxi |</h0black><h0blue> Fleet Intelligence</h0blue>')
```

**2. Driver Routes Page (`pages/1_Driver_Routes.py`)**

Update headers:
```python
# FROM:
st.markdown(f'<h0black>San Francisco Taxi |</h0black><h0blue> Fleet Intelligence</h0blue>')

# TO (your city):
st.markdown(f'<h0black>New York Taxi |</h0black><h0blue> Fleet Intelligence</h0blue>')
```

**3. Heat Map Page (`pages/2_Fleet_Heat_Map.py`)**

Update headers:
```python
# FROM:
st.markdown('<h0black>San Francisco Taxi |</h0black><h0blue> Fleet Heat Map</h0blue>')

# TO (your city):
st.markdown('<h0black>New York Taxi |</h0black><h0blue> Fleet Heat Map</h0blue>')
```

Update map center coordinates:
```python
# FROM (San Francisco):
view_state = pdk.ViewState(
    latitude=37.76,
    longitude=-122.44,
    zoom=12
)

# TO (New York):
view_state = pdk.ViewState(
    latitude=40.75,
    longitude=-73.97,
    zoom=12
)

# TO (London):
view_state = pdk.ViewState(
    latitude=51.51,
    longitude=-0.12,
    zoom=12
)
```

### Quick Find & Replace

For a quick update, use find and replace in your editor:

| Find | Replace With (example: New York) |
|------|----------------------------------|
| `San Francisco Taxi` | `New York Taxi` |
| `latitude=37.76` | `latitude=40.75` |
| `longitude=-122.44` | `longitude=-73.97` |

### Optional: Rename the Main File

You can also rename the main Streamlit file to match your city:

```bash
# Rename file
mv SF_Taxi_Control_Center.py NYC_Taxi_Control_Center.py

# Update 08_deploy_streamlit.sql to use new filename:
MAIN_FILE = 'NYC_Taxi_Control_Center.py'
```

---

## Location Configuration in Scripts

### Step 1: Modify `02_create_base_locations.sql`

Change the bounding box to match your target location:

```sql
-- ============================================
-- SAN FRANCISCO (Default)
-- ============================================
WHERE ST_X(GEOMETRY) BETWEEN -122.52 AND -122.35
  AND ST_Y(GEOMETRY) BETWEEN 37.70 AND 37.82

-- ============================================
-- NEW YORK
-- ============================================
WHERE ST_X(GEOMETRY) BETWEEN -74.05 AND -73.90
  AND ST_Y(GEOMETRY) BETWEEN 40.65 AND 40.85

-- ============================================
-- LONDON
-- ============================================
WHERE ST_X(GEOMETRY) BETWEEN -0.20 AND 0.05
  AND ST_Y(GEOMETRY) BETWEEN 51.45 AND 51.55

-- ============================================
-- PARIS
-- ============================================
WHERE ST_X(GEOMETRY) BETWEEN 2.25 AND 2.42
  AND ST_Y(GEOMETRY) BETWEEN 48.82 AND 48.90

-- ============================================
-- CHICAGO
-- ============================================
WHERE ST_X(GEOMETRY) BETWEEN -87.75 AND -87.55
  AND ST_Y(GEOMETRY) BETWEEN 41.80 AND 41.95

-- ============================================
-- LOS ANGELES
-- ============================================
WHERE ST_X(GEOMETRY) BETWEEN -118.35 AND -118.15
  AND ST_Y(GEOMETRY) BETWEEN 33.95 AND 34.15

-- ============================================
-- SEATTLE
-- ============================================
WHERE ST_X(GEOMETRY) BETWEEN -122.45 AND -122.25
  AND ST_Y(GEOMETRY) BETWEEN 47.55 AND 47.70

-- ============================================
-- BOSTON
-- ============================================
WHERE ST_X(GEOMETRY) BETWEEN -71.15 AND -70.95
  AND ST_Y(GEOMETRY) BETWEEN 42.30 AND 42.40

-- ============================================
-- SYDNEY
-- ============================================
WHERE ST_X(GEOMETRY) BETWEEN 151.15 AND 151.30
  AND ST_Y(GEOMETRY) BETWEEN -33.92 AND -33.82

-- ============================================
-- SINGAPORE
-- ============================================
WHERE ST_X(GEOMETRY) BETWEEN 103.75 AND 103.95
  AND ST_Y(GEOMETRY) BETWEEN 1.25 AND 1.40
```

### Step 2: Update Streamlit Map Center

Modify `SF_Taxi_Control_Center.py` and page files to center the map on your location:

```python
# San Francisco (default)
view_state = pdk.ViewState(latitude=37.76, longitude=-122.44, zoom=12)

# New York
view_state = pdk.ViewState(latitude=40.75, longitude=-73.97, zoom=12)

# London
view_state = pdk.ViewState(latitude=51.51, longitude=-0.12, zoom=12)

# Paris
view_state = pdk.ViewState(latitude=48.86, longitude=2.35, zoom=12)

# Chicago
view_state = pdk.ViewState(latitude=41.88, longitude=-87.63, zoom=12)

# Los Angeles
view_state = pdk.ViewState(latitude=34.05, longitude=-118.25, zoom=12)

# Seattle
view_state = pdk.ViewState(latitude=47.61, longitude=-122.33, zoom=12)

# Boston
view_state = pdk.ViewState(latitude=42.36, longitude=-71.06, zoom=12)

# Sydney
view_state = pdk.ViewState(latitude=-33.87, longitude=151.21, zoom=12)

# Singapore
view_state = pdk.ViewState(latitude=1.35, longitude=103.85, zoom=12)
```

### Step 3: Rename App Title (Optional)

Update headers in Streamlit files:

```python
# From:
st.markdown('<h0black>San Francisco Taxi |</h0black>...')

# To (example for New York):
st.markdown('<h0black>New York Taxi |</h0black>...')
```

---

## Recommended Warehouse Sizes

| Drivers | Days | Estimated Rows | Warehouse | Est. Time |
|---------|------|----------------|-----------|-----------|
| 20 | 1 | ~4,000 | SMALL | 2-3 min |
| 80 | 1 | ~18,000 | MEDIUM | 5-8 min |
| 80 | 7 | ~125,000 | LARGE | 20-30 min |
| 200 | 1 | ~45,000 | LARGE | 15-20 min |
| 200 | 7 | ~315,000 | XLARGE | 45-60 min |
| 500 | 7 | ~800,000 | XLARGE | 2-3 hours |

*Note: Rows estimated at 15 location points per trip (includes waiting, pickup, driving, dropoff, idle states)*

---

## Prerequisites

1. **Snowflake Account** with appropriate privileges
2. **OpenRouteService Native App** installed from Snowflake Marketplace
   - ⚠️ **Must be configured for your target location's region**
3. **Overture Maps Data** shares:
   - `OVERTURE_MAPS__PLACES`
   - `OVERTURE_MAPS__ADDRESSES`

---

## Scripts Location

All scripts are in: `oss-deploy-a-fleet-intelligence-solution-for-taxis/scripts/`

---

## Workflow

### Step 1: Set Query Tag for Tracking

**Goal:** Set session query tag for attribution tracking.

```sql
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is","name":"oss-deploy-a-fleet-intelligence-solution-for-taxis","version":{"major":1, "minor":0},"attributes":{"is_quickstart":1, "source":"sql"}}';
```

**Output:** Query tag set for session tracking

### Step 2: Verify ORS Configuration

**Goal:** Ensure OpenRouteService can route in your target location

**Action:** Test the ORS DIRECTIONS function with coordinates in your target city:

```sql
-- Test route in San Francisco
SELECT OPENROUTESERVICE_NATIVE_APP.CORE.DIRECTIONS(
    'driving-car',
    [-122.42, 37.77],  -- Origin (lon, lat)
    [-122.40, 37.79]   -- Destination (lon, lat)
);

-- Test route in New York
SELECT OPENROUTESERVICE_NATIVE_APP.CORE.DIRECTIONS(
    'driving-car',
    [-73.99, 40.75],
    [-73.97, 40.76]
);

-- Test route in London
SELECT OPENROUTESERVICE_NATIVE_APP.CORE.DIRECTIONS(
    'driving-car',
    [-0.13, 51.51],
    [-0.10, 51.52]
);
```

If the query returns a route geometry, your ORS is configured for that region. If it fails or returns null, you need to reconfigure ORS with the appropriate map data.

**Output:** Confirmation that ORS can route in target location

---

### Step 3: Configure Database and Warehouse

**Goal:** Create appropriately sized warehouse for data generation

**Action:** Execute `scripts/01_setup_database.sql` with modified warehouse size

See [Recommended Warehouse Sizes](#recommended-warehouse-sizes) table above.

**Output:** Warehouse and database infrastructure ready

---

### Step 4: Create Base Locations

**Goal:** Load locations from Overture Maps for your target city

**Action:** Execute `scripts/02_create_base_locations.sql` with modified bounding box

See [Location Configuration in Scripts](#location-configuration-in-scripts) above.

**Output:** Location pool for pickup/dropoff points in target city

---

### Step 5: Create Drivers with Shift Patterns

**Goal:** Create drivers distributed across shifts

**Action:** Execute `scripts/03_create_drivers.sql` with modified driver counts

**Modify the `shift_patterns` CTE** to change total drivers:

```sql
-- Default: 80 drivers
SELECT 1 AS shift_id, 'Graveyard' AS shift_name, 22 AS shift_start, 6 AS shift_end, 8 AS driver_count UNION ALL
SELECT 2, 'Early', 4, 12, 18 UNION ALL
SELECT 3, 'Morning', 6, 14, 22 UNION ALL
SELECT 4, 'Day', 11, 19, 18 UNION ALL
SELECT 5, 'Evening', 15, 23, 14

-- Example: 200 drivers (proportionally scaled)
SELECT 1 AS shift_id, 'Graveyard' AS shift_name, 22 AS shift_start, 6 AS shift_end, 20 AS driver_count UNION ALL
SELECT 2, 'Early', 4, 12, 45 UNION ALL
SELECT 3, 'Morning', 6, 14, 55 UNION ALL
SELECT 4, 'Day', 11, 19, 45 UNION ALL
SELECT 5, 'Evening', 15, 23, 35
```

**Shift Distribution Formula:**
| Shift | % of Fleet | Purpose |
|-------|------------|---------|
| Graveyard | 10% | Overnight |
| Early | 22.5% | Early morning |
| Morning | 27.5% | Peak AM rush |
| Day | 22.5% | Midday |
| Evening | 17.5% | PM rush |

**Output:** Configured number of drivers with shift schedules

---

### Step 6: Generate Trips

**Goal:** Create trip assignments for each day

**Action:** Execute `scripts/04_create_trips.sql`

For multiple days, modify the script to include a days generator (see scripts/README.md for details).

**Output:** Trips for all configured days

---

### Step 7: Generate ORS Routes

**Goal:** Generate actual road routes using OpenRouteService

**Action:** Execute `scripts/05_generate_routes.sql`

⚠️ **Time scales with trip count:**
- 1,000 trips: ~3-5 minutes
- 5,000 trips: ~15-20 minutes  
- 10,000 trips: ~30-45 minutes

**Output:** Road-following route geometries for all trips

---

### Step 8: Create Driver Locations

**Goal:** Interpolate driver positions along routes with realistic speeds

**Action:** Execute `scripts/06_create_driver_locations.sql`

This creates 15 points per trip with driver states:
- `waiting` - Stationary, waiting for fare
- `pickup` - Stationary, passenger boarding
- `driving` - Variable speed based on time of day
- `dropoff` - Slow, passenger exiting
- `idle` - Stationary, post-trip

**Speed Distribution:**
| Speed Band | Percentage |
|------------|------------|
| 0 km/h (Stationary) | ~23% |
| 1-5 km/h (Crawling) | ~11% |
| 6-15 km/h (Slow) | ~14% |
| 16-30 km/h (Moderate) | ~26% |
| 31-45 km/h (Normal) | ~20% |
| 46+ km/h (Fast) | ~6% |

**Output:** Location points for all trips with realistic speed patterns

---

### Step 9: Create Analytics Views

**Goal:** Create views for Streamlit consumption

**Action:** Execute `scripts/07_create_analytics_views.sql`

**Output:** Analytics views ready for Streamlit

---

### Step 10: Deploy Streamlit App

**Goal:** Upload and deploy the Streamlit application

**Action:** 
1. Run `scripts/deploy_streamlit.py` to upload files
2. Execute `scripts/08_deploy_streamlit.sql` to create the app

```bash
python scripts/deploy_streamlit.py \
    --account <account> \
    --user <user> \
    --password <password>
```

**Output:** Streamlit app deployed and accessible in Snowsight

---

## Quick Start (Run All)

For automated execution with default settings (San Francisco, 80 drivers, 1 day):

```bash
cd oss-deploy-a-fleet-intelligence-solution-for-taxis/scripts

# Install Python dependencies
pip install -r requirements.txt

# Run all SQL scripts (01-07)
python run_all.py \
    --account <account> \
    --user <user> \
    --password <password>

# Deploy Streamlit files
python deploy_streamlit.py \
    --account <account> \
    --user <user> \
    --password <password>

# Then run 08_deploy_streamlit.sql in Snowsight
```

---

## Configuration Examples

### Example 1: New York, 100 drivers, 1 day

```sql
-- 02_create_base_locations.sql - bounding box:
WHERE ST_X(GEOMETRY) BETWEEN -74.05 AND -73.90
  AND ST_Y(GEOMETRY) BETWEEN 40.65 AND 40.85

-- 03_create_drivers.sql - 100 drivers:
SELECT 1, 'Graveyard', 22, 6, 10 UNION ALL
SELECT 2, 'Early', 4, 12, 22 UNION ALL
SELECT 3, 'Morning', 6, 14, 28 UNION ALL
SELECT 4, 'Day', 11, 19, 22 UNION ALL
SELECT 5, 'Evening', 15, 23, 18

-- Streamlit map center:
view_state = pdk.ViewState(latitude=40.75, longitude=-73.97, zoom=12)

-- Warehouse: MEDIUM
-- Estimated rows: ~22,000
```

### Example 2: London, 50 drivers, 3 days

```sql
-- 02_create_base_locations.sql - bounding box:
WHERE ST_X(GEOMETRY) BETWEEN -0.20 AND 0.05
  AND ST_Y(GEOMETRY) BETWEEN 51.45 AND 51.55

-- 03_create_drivers.sql - 50 drivers:
SELECT 1, 'Graveyard', 22, 6, 5 UNION ALL
SELECT 2, 'Early', 4, 12, 11 UNION ALL
SELECT 3, 'Morning', 6, 14, 14 UNION ALL
SELECT 4, 'Day', 11, 19, 11 UNION ALL
SELECT 5, 'Evening', 15, 23, 9

-- 04_create_trips.sql - 3 days:
FROM TABLE(GENERATOR(ROWCOUNT => 3))

-- Streamlit map center:
view_state = pdk.ViewState(latitude=51.51, longitude=-0.12, zoom=12)

-- Warehouse: LARGE
-- Estimated rows: ~33,000
```

### Example 3: Sydney, 200 drivers, 7 days

```sql
-- 02_create_base_locations.sql - bounding box:
WHERE ST_X(GEOMETRY) BETWEEN 151.15 AND 151.30
  AND ST_Y(GEOMETRY) BETWEEN -33.92 AND -33.82

-- 03_create_drivers.sql - 200 drivers:
SELECT 1, 'Graveyard', 22, 6, 20 UNION ALL
SELECT 2, 'Early', 4, 12, 45 UNION ALL
SELECT 3, 'Morning', 6, 14, 55 UNION ALL
SELECT 4, 'Day', 11, 19, 45 UNION ALL
SELECT 5, 'Evening', 15, 23, 35

-- 04_create_trips.sql - 7 days:
FROM TABLE(GENERATOR(ROWCOUNT => 7))

-- Streamlit map center:
view_state = pdk.ViewState(latitude=-33.87, longitude=151.21, zoom=12)

-- Warehouse: XLARGE
-- Estimated rows: ~315,000
```

---

## Data Model

```
FLEET_INTELLIGENCE
├── PUBLIC (schema)
│   ├── SF_TAXI_LOCATIONS      # Location pool for target city
│   ├── TAXI_DRIVERS           # Configured driver count
│   ├── DRIVERS                # Driver display data
│   ├── DRIVER_TRIPS           # Trip assignments
│   ├── DRIVER_TRIPS_WITH_COORDS # Trips with coordinates
│   ├── DRIVER_ROUTES          # Raw ORS responses
│   ├── DRIVER_ROUTES_PARSED   # Parsed route data
│   ├── DRIVER_ROUTE_GEOMETRIES # Routes with timing
│   └── DRIVER_LOCATIONS       # Interpolated positions with driver states
│
└── ANALYTICS (schema)
    ├── DRIVERS                # View
    ├── DRIVER_LOCATIONS       # View with LON/LAT and DRIVER_STATE
    ├── TRIPS_ASSIGNED_TO_DRIVERS # View
    ├── ROUTE_NAMES            # View
    └── TRIP_SUMMARY           # View
```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| ORS routes returning NULL | Location outside ORS configured region - verify map data |
| ORS routes failing | Verify OpenRouteService Native App is installed and running |
| No locations found | Bounding box may be too restrictive or outside Overture coverage |
| Query timeout | Increase warehouse size |
| Out of memory | Use larger warehouse or batch processing |
| Missing Overture data | Install shares from Snowflake Marketplace |
| Streamlit not loading | Check all files uploaded to stage |
| Map centered wrong | Update view_state coordinates in Streamlit files |

See `scripts/README.md` for detailed troubleshooting.
