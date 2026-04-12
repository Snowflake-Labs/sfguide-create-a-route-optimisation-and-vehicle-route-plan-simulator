# OpenRouteService Native App

**Enterprise-grade routing, optimization, and fleet analytics powered by OpenRouteService, running natively in Snowflake.**

---

## What This App Does

This application provides geospatial routing capabilities directly within your Snowflake environment, with a full-featured management dashboard and support for multiple cities and regions.

| Capability | Description |
|------------|-------------|
| **Directions** | Calculate optimal routes between locations with turn-by-turn instructions. Returns route geometry as `GEOGRAPHY`. |
| **Isochrones** | Generate travel-time catchment areas (e.g., "all areas within 15 min drive"). Returns catchment polygons as `GEOGRAPHY`. |
| **Matrix** | Compute distance/duration matrices between multiple origins and destinations. |
| **Optimization** | Solve vehicle routing problems (VRP) with capacity, time window, and fleet constraints via the VROOM engine. |
| **Multi-City Routing** | Provision dedicated routing engines for any city or region. Download OpenStreetMap data and build routing graphs on demand. |
| **Travel-Time Matrices** | Build pre-computed H3 origin-destination travel-time matrices for large-scale analytics. |
| **ORS Control Panel** | Full-featured React dashboard for service management, city provisioning, matrix building, interactive demos, and diagnostics. |
| **Lifecycle Management** | Resume, suspend, and scale all services programmatically via SQL procedures. |

### Routing Profiles

All routing functions accept a `method` parameter supporting these profiles:

| Profile | Use Case |
|---------|----------|
| `driving-car` | Passenger vehicle routing |
| `driving-hgv` | Heavy goods / truck routing with dimensional restrictions |
| `cycling-regular` | General cycling |
| `cycling-road` | Road cycling (prefers paved surfaces) |
| `cycling-mountain` | Mountain biking (prefers trails) |
| `cycling-electric` | E-bike routing (extended range) |
| `foot-walking` | Pedestrian routing |
| `foot-hiking` | Hiking trails |
| `wheelchair` | Wheelchair-accessible routing |

---

## Getting Started

### Step 1: Grant Permissions

Click the **Permissions** tab above and grant the required privileges:
- **CREATE COMPUTE POOL** — for the container services that run the routing engines
- **Network access** — for downloading OpenStreetMap data and CARTO basemap tiles

### Step 2: Launch the App

Click the **Launch app** button in the upper right corner. The app will:
- Create a compute pool and start all services (takes 2-3 minutes on first launch)
- Download OpenStreetMap data for the default region
- Open the **ORS Control Panel** — a management dashboard where you can monitor services, provision new cities, build travel-time matrices, and explore interactive demos

### Step 3: Use the Functions

Once services are running, call the routing functions from any SQL worksheet:

```sql
-- Route between San Francisco and Oakland
SELECT * FROM TABLE(OPENROUTESERVICE_NATIVE_APP.CORE.DIRECTIONS(
    'driving-car',
    ARRAY_CONSTRUCT(-122.4194, 37.7749),   -- start [lon, lat]
    ARRAY_CONSTRUCT(-122.2711, 37.8044)    -- end   [lon, lat]
));
-- Returns: RESPONSE (VARIANT), GEOJSON (GEOGRAPHY), DISTANCE (meters), DURATION (seconds)

-- 15-minute walking isochrone
SELECT * FROM TABLE(OPENROUTESERVICE_NATIVE_APP.CORE.ISOCHRONES(
    'foot-walking',
    -122.4194, 37.7749,   -- center [lon, lat]
    15                     -- minutes
));
-- Returns: RESPONSE (VARIANT), GEOJSON (GEOGRAPHY)

-- Distance/duration matrix between 3 locations
SELECT OPENROUTESERVICE_NATIVE_APP.CORE.MATRIX(
    'driving-car',
    ARRAY_CONSTRUCT(
        ARRAY_CONSTRUCT(-122.4194, 37.7749),
        ARRAY_CONSTRUCT(-122.2711, 37.8044),
        ARRAY_CONSTRUCT(-122.0322, 37.3230)
    )
);
-- Returns: VARIANT with durations and distances arrays

-- Check if routing engine is healthy
SELECT OPENROUTESERVICE_NATIVE_APP.CORE.CHECK_HEALTH();

-- List all provisioned regions
SELECT * FROM TABLE(OPENROUTESERVICE_NATIVE_APP.CORE.LIST_REGIONS());
```

### Step 4: Add More Regions (Optional)

Use the **City Builder** page in the ORS Control Panel to provision additional cities, or call the routing functions with a `region` parameter to target a specific city:

```sql
-- Route in London (after provisioning)
SELECT * FROM TABLE(OPENROUTESERVICE_NATIVE_APP.CORE.DIRECTIONS(
    'driving-car',
    ARRAY_CONSTRUCT(-0.1276, 51.5074),
    ARRAY_CONSTRUCT(-0.0763, 51.5155),
    'london'                                -- region parameter
));
```

---

## SQL Function Reference

### DIRECTIONS

Calculate a route between two or more locations.

```sql
-- Two-point (start/end arrays)
SELECT * FROM TABLE(CORE.DIRECTIONS(
    method   => 'driving-car',
    jstart   => ARRAY_CONSTRUCT(-122.4194, 37.7749),
    jend     => ARRAY_CONSTRUCT(-122.2711, 37.8044),
    region   => NULL  -- optional, defaults to primary region
));

-- Multi-point (locations variant)
SELECT * FROM TABLE(CORE.DIRECTIONS(
    method    => 'driving-car',
    locations => ARRAY_CONSTRUCT(
        ARRAY_CONSTRUCT(-122.4194, 37.7749),
        ARRAY_CONSTRUCT(-122.2711, 37.8044),
        ARRAY_CONSTRUCT(-122.0322, 37.3230)
    )
));
```

**Returns:** `TABLE(RESPONSE VARIANT, GEOJSON GEOGRAPHY, DISTANCE FLOAT, DURATION FLOAT)`

### ISOCHRONES

Generate a travel-time catchment polygon.

```sql
SELECT * FROM TABLE(CORE.ISOCHRONES(
    'foot-walking', -122.4194, 37.7749, 15
));
```

**Returns:** `TABLE(RESPONSE VARIANT, GEOJSON GEOGRAPHY)`

### OPTIMIZATION

Solve a vehicle routing problem (VRP).

```sql
SELECT * FROM TABLE(CORE.OPTIMIZATION(
    jobs     => :jobs_array,
    vehicles => :vehicles_array,
    matrices => ARRAY_CONSTRUCT()   -- optional pre-computed matrices
));
```

**Returns:** `TABLE(RESPONSE VARIANT, GEOJSON GEOGRAPHY, VEHICLE INT, DURATION INT, STEPS VARIANT)`

### MATRIX

Compute a distance/duration matrix.

```sql
-- Simple (locations array)
SELECT CORE.MATRIX('driving-car', :locations_array);

-- Advanced (options variant with sources/destinations)
SELECT CORE.MATRIX('driving-car', :options_variant);

-- Tabular (single origin to many destinations)
SELECT CORE.MATRIX_TABULAR('driving-car', :origin_array, :destinations_array);
```

**Returns:** `VARIANT`

### Utility Functions

```sql
SELECT CORE.CHECK_HEALTH();                -- BOOLEAN: TRUE if routing engine is responding
SELECT CORE.ORS_STATUS();                  -- VARIANT: detailed engine status
SELECT * FROM TABLE(CORE.LIST_REGIONS());  -- TABLE: all provisioned regions with bounding boxes
```

---

## Lifecycle Management

Manage services programmatically from any SQL worksheet:

```sql
-- Check service status
CALL OPENROUTESERVICE_NATIVE_APP.CORE.GET_STATUS();

-- Suspend all services (except the Control Panel)
CALL OPENROUTESERVICE_NATIVE_APP.CORE.SUSPEND_ALL_SERVICES();

-- Resume all services
CALL OPENROUTESERVICE_NATIVE_APP.CORE.RESUME_ALL_SERVICES();

-- Scale ORS and gateway instances (min_instances, max_instances)
CALL OPENROUTESERVICE_NATIVE_APP.CORE.SCALE_SERVICES(3, 5);
```

---

## Architecture

This app runs 5 containerized services in Snowpark Container Services (SPCS):

| Service | Purpose |
|---------|---------|
| **OpenRouteService** | Core routing engine built on OpenStreetMap data. One instance per provisioned region. |
| **VROOM** | Vehicle routing optimization solver for VRP problems. |
| **Gateway** | API proxy with multi-region routing, request dispatch, and geometry reconstruction. |
| **Downloader** | Downloads and manages OpenStreetMap PBF data files. |
| **ORS Control Panel** | React-based admin dashboard and interactive demo UI. |

### Infrastructure

- **Compute Pool:** `HIGHMEM_X64_S` (5 nodes, auto-scaling)
- **Internal Stages:** 3 stages for OSM data, routing graphs, and elevation cache
- **Multi-Region:** Each provisioned city gets a dedicated ORS service instance with its own routing graphs

### ORS Control Panel

The built-in dashboard (accessible via **Launch app**) provides:

**Admin Pages:**

| Page | Description |
|------|-------------|
| Status | Service health monitoring and compute pool status |
| City Builder | Provision new cities/regions with custom bounding boxes and routing profiles |
| Travel Matrix Builder | Build H3 travel-time matrices with cost estimation and progress tracking |
| Travel Matrix Viewer | Visualize and explore completed matrix data |
| Functions Tester | Interactive testing of all routing functions |
| Diagnostics | Service logs, environment info, and connectivity probes |

**Demo Pages:**

| Category | Description |
|----------|-------------|
| Dwell Analysis | Congestion heatmaps, facility utilization, SLA alerts, driver performance (7 pages) |
| Fleet Delivery | Food delivery fleet dashboard, courier tracking, catchment analysis (4 pages) |
| Fleet Taxis | Taxi fleet overview, driver routes, heat maps (3 pages) |
| Route Optimization | Interactive VRP solver with map visualization |
| Retail Catchment | Isochrone-based trade area and competitor analysis |
| Route Deviation | Detour detection, route comparison, trip inspection (3 pages) |
| Routing Agent | AI-powered natural language routing assistant |
| Travel Time Matrix | Interactive matrix data explorer |
| Data Studio | Synthetic fleet data generation |

---

## Support

- **Documentation:** [OpenRouteService API Docs](https://openrouteservice.org/dev/#/api-docs)
- **Region Setup:** Use the **City Builder** in the ORS Control Panel to add new cities and regions
- **Service Management:** Use the lifecycle procedures above, or the **Status** page in the Control Panel

---

*Powered by OpenRouteService, VROOM, and Snowpark Container Services*
