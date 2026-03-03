# OpenRouteService Functions for Snowflake

Complete reference for all ORS routing functions available in the Snowflake Native App. All examples use San Francisco Bay Area coordinates.

---

## Function Overview

| Function | Returns Geometry? | Description |
|----------|:-:|-------------|
| **DIRECTIONS** | Yes | Route between two points with distance/duration |
| **DIRECTIONS_GEO** | Yes (parsed) | Same as above with pre-parsed GEOJSON and GEOGRAPHY columns |
| **ISOCHRONES** | Yes | Travel-time reachability polygons |
| **ISOCHRONES_GEO** | Yes (parsed) | Same as above with pre-parsed GEOJSON and GEOGRAPHY columns |
| **MATRIX** | No | Distance/duration matrix between multiple points |
| **OPTIMIZATION** | Yes | Vehicle routing problem solver (single payload) |
| **OPTIMIZATION** (jobs/vehicles) | Yes | Vehicle routing problem solver (separate arrays) |
| **OPTIMIZATION_GEO** | Yes (parsed) | Same as above with per-vehicle GEOJSON and GEOGRAPHY columns |

> **Note:** `MATRIX` has no `_GEO` variant because it returns numerical distance/duration arrays, not geometry.

---

## Base Functions

### DIRECTIONS

Calculate the optimal route between two points.

**Signature:** `DIRECTIONS(method VARCHAR, start ARRAY, end ARRAY) → VARIANT`

```sql
-- Route from Union Square to Fisherman's Wharf
SELECT OPENROUTESERVICE_NATIVE_APP.CORE.DIRECTIONS(
    'driving-car',
    [-122.4075, 37.7881],   -- Union Square
    [-122.4169, 37.8080]    -- Fisherman's Wharf
) AS DIRECTIONS;
```

**Response structure:** GeoJSON FeatureCollection. The route geometry is at `DIRECTIONS:features[0]:geometry` and the summary (distance in meters, duration in seconds) is at `DIRECTIONS:features[0]:properties:summary`.

```sql
-- Extract useful fields from the response
SELECT
    d:features[0]:geometry AS route_geojson,
    TO_GEOGRAPHY(d:features[0]:geometry) AS route_geo,
    d:features[0]:properties:summary:distance::FLOAT AS distance_m,
    d:features[0]:properties:summary:duration::FLOAT AS duration_s
FROM (
    SELECT OPENROUTESERVICE_NATIVE_APP.CORE.DIRECTIONS(
        'driving-car',
        [-122.4075, 37.7881],
        [-122.4169, 37.8080]
    ) AS d
);
```

---

### DIRECTIONS (with options)

Pass additional ORS parameters via the VARIANT overload.

**Signature:** `DIRECTIONS(method VARCHAR, options VARIANT) → VARIANT`

```sql
-- Route avoiding highways
SELECT OPENROUTESERVICE_NATIVE_APP.CORE.DIRECTIONS(
    'driving-car',
    PARSE_JSON('{
        "coordinates": [[-122.4075, 37.7881], [-122.4169, 37.8080]],
        "options": {"avoid_features": ["highways"]}
    }')
) AS DIRECTIONS;
```

---

### ISOCHRONES

Generate travel-time reachability polygons from a center point.

**Signature:** `ISOCHRONES(method TEXT, lon FLOAT, lat FLOAT, minutes INT) → VARIANT`

> **Note:** Longitude and latitude are passed as separate `FLOAT` values, not as an array.

```sql
-- 10-minute driving isochrone from Ferry Building
SELECT OPENROUTESERVICE_NATIVE_APP.CORE.ISOCHRONES(
    'driving-car',
    -122.3936,   -- lon (Ferry Building)
    37.7956,     -- lat
    10           -- minutes
) AS ISOCHRONE;
```

**Response structure:** GeoJSON FeatureCollection. The polygon geometry is at `ISOCHRONE:features[0]:geometry`.

```sql
-- Extract the isochrone polygon
SELECT
    i:features[0]:geometry AS iso_geojson,
    TO_GEOGRAPHY(i:features[0]:geometry) AS iso_geo
FROM (
    SELECT OPENROUTESERVICE_NATIVE_APP.CORE.ISOCHRONES(
        'driving-car',
        -122.3936,
        37.7956,
        10
    ) AS i
);
```

---

### MATRIX

Compute a distance/duration matrix between multiple origins and destinations.

**Signature:** `MATRIX(method VARCHAR, locations ARRAY) → VARIANT`

```sql
-- Travel matrix between 3 SF landmarks
SELECT OPENROUTESERVICE_NATIVE_APP.CORE.MATRIX(
    'driving-car',
    [
        [-122.4075, 37.7881],   -- Union Square
        [-122.3936, 37.7956],   -- Ferry Building
        [-122.4169, 37.8080]    -- Fisherman's Wharf
    ]
) AS MATRIX;
```

**Response structure:** Contains `durations` and `distances` arrays (numerical). No geometry is returned.

```sql
-- Extract the duration matrix
SELECT
    m:durations AS duration_matrix,
    m:distances AS distance_matrix
FROM (
    SELECT OPENROUTESERVICE_NATIVE_APP.CORE.MATRIX(
        'driving-car',
        [
            [-122.4075, 37.7881],
            [-122.3936, 37.7956],
            [-122.4169, 37.8080]
        ]
    ) AS m
);
```

---

### MATRIX (with options)

**Signature:** `MATRIX(method VARCHAR, options VARIANT) → VARIANT`

```sql
-- Asymmetric matrix: 1 origin to 3 destinations
SELECT OPENROUTESERVICE_NATIVE_APP.CORE.MATRIX(
    'driving-car',
    PARSE_JSON('{
        "locations": [
            [-122.4075, 37.7881],
            [-122.3936, 37.7956],
            [-122.4169, 37.8080],
            [-122.4786, 37.8199]
        ],
        "sources": [0],
        "destinations": [1, 2, 3]
    }')
) AS MATRIX;
```

---

### OPTIMIZATION (jobs + vehicles)

Solve a vehicle routing problem with separate job and vehicle arrays.

**Signature:** `OPTIMIZATION(jobs ARRAY, vehicles ARRAY, matrices ARRAY DEFAULT []) → VARIANT`

```sql
-- 3 delivery jobs, 1 vehicle starting from Union Square
SELECT OPENROUTESERVICE_NATIVE_APP.CORE.OPTIMIZATION(
    -- Jobs (deliveries)
    [
        {'id': 1, 'location': [-122.3936, 37.7956]},   -- Ferry Building
        {'id': 2, 'location': [-122.4169, 37.8080]},   -- Fisherman's Wharf
        {'id': 3, 'location': [-122.4786, 37.8199]}    -- Golden Gate Bridge
    ],
    -- Vehicles
    [
        {'id': 1, 'profile': 'driving-car', 'start': [-122.4075, 37.7881], 'end': [-122.4075, 37.7881]}  -- Union Square depot
    ]
) AS OPTIMIZATION;
```

**Response structure:** VROOM format. Routes are at `OPTIMIZATION:routes` (one per vehicle). Each route has `geometry` (coordinate array), `duration`, `steps`, and `vehicle` id.

```sql
-- Extract per-vehicle routes
SELECT
    f.value:vehicle::INT AS vehicle_id,
    OBJECT_CONSTRUCT('type', 'LineString', 'coordinates', f.value:geometry) AS route_geojson,
    f.value:duration::INT AS duration_s,
    f.value:steps AS steps
FROM (
    SELECT OPENROUTESERVICE_NATIVE_APP.CORE.OPTIMIZATION(
        [
            {'id': 1, 'location': [-122.3936, 37.7956]},
            {'id': 2, 'location': [-122.4169, 37.8080]},
            {'id': 3, 'location': [-122.4786, 37.8199]}
        ],
        [
            {'id': 1, 'profile': 'driving-car', 'start': [-122.4075, 37.7881], 'end': [-122.4075, 37.7881]}
        ]
    ) AS opt
), LATERAL FLATTEN(input => opt:routes) f;
```

---

### OPTIMIZATION (single payload)

Pass a complete VROOM challenge object.

**Signature:** `OPTIMIZATION(challenge VARIANT) → VARIANT`

```sql
-- Full VROOM payload with time windows
SELECT OPENROUTESERVICE_NATIVE_APP.CORE.OPTIMIZATION(
    {
        'jobs': [
            {'id': 1, 'location': [-122.3936, 37.7956], 'service': 300},
            {'id': 2, 'location': [-122.4169, 37.8080], 'service': 300}
        ],
        'vehicles': [
            {'id': 1, 'profile': 'driving-car', 'start': [-122.4075, 37.7881], 'end': [-122.4075, 37.7881]}
        ]
    }
) AS OPTIMIZATION;
```

---

## _GEO Wrapper Functions

The `_GEO` variants are SQL table functions that call the base function and return pre-parsed columns — including native `GEOGRAPHY` types ready for spatial operations.

### DIRECTIONS_GEO

**Signature:** `DIRECTIONS_GEO(method VARCHAR, start ARRAY, end ARRAY) → TABLE(RESPONSE, GEOJSON, GEO, DISTANCE, DURATION)`

| Column | Type | Description |
|--------|------|-------------|
| RESPONSE | VARIANT | Full ORS response |
| GEOJSON | VARIANT | Route geometry as GeoJSON |
| GEO | GEOGRAPHY | Native Snowflake geography |
| DISTANCE | FLOAT | Distance in meters |
| DURATION | FLOAT | Duration in seconds |

```sql
-- Get route with pre-parsed geography
SELECT *
FROM TABLE(OPENROUTESERVICE_NATIVE_APP.CORE.DIRECTIONS_GEO(
    'driving-car',
    [-122.4075, 37.7881],   -- Union Square
    [-122.4169, 37.8080]    -- Fisherman's Wharf
));
```

```sql
-- Use the GEOGRAPHY column for spatial operations
SELECT
    GEO,
    ROUND(DISTANCE / 1000, 2) AS distance_km,
    ROUND(DURATION / 60, 1) AS duration_min,
    ST_LENGTH(GEO) AS geo_length
FROM TABLE(OPENROUTESERVICE_NATIVE_APP.CORE.DIRECTIONS_GEO(
    'driving-car',
    [-122.4075, 37.7881],
    [-122.4169, 37.8080]
));
```

---

### DIRECTIONS_GEO (with options)

**Signature:** `DIRECTIONS_GEO(method VARCHAR, options VARIANT) → TABLE(RESPONSE, GEOJSON, GEO, DISTANCE, DURATION)`

```sql
SELECT *
FROM TABLE(OPENROUTESERVICE_NATIVE_APP.CORE.DIRECTIONS_GEO(
    'driving-car',
    PARSE_JSON('{
        "coordinates": [[-122.4075, 37.7881], [-122.4169, 37.8080]],
        "options": {"avoid_features": ["highways"]}
    }')
));
```

---

### ISOCHRONES_GEO

**Signature:** `ISOCHRONES_GEO(method TEXT, lon FLOAT, lat FLOAT, minutes INT) → TABLE(RESPONSE, GEOJSON, GEO)`

| Column | Type | Description |
|--------|------|-------------|
| RESPONSE | VARIANT | Full ORS response |
| GEOJSON | VARIANT | Isochrone polygon as GeoJSON |
| GEO | GEOGRAPHY | Native Snowflake geography |

```sql
-- Get driving isochrone with native geography
SELECT *
FROM TABLE(OPENROUTESERVICE_NATIVE_APP.CORE.ISOCHRONES_GEO(
    'driving-car',
    -122.3936::FLOAT,   -- lon (Ferry Building)
    37.7956::FLOAT,     -- lat
    10
));
```

```sql
-- Calculate the area of the isochrone polygon
SELECT
    GEO,
    ROUND(ST_AREA(GEO) / 1000000, 3) AS area_sq_km
FROM TABLE(OPENROUTESERVICE_NATIVE_APP.CORE.ISOCHRONES_GEO(
    'driving-car',
    -122.3936::FLOAT,
    37.7956::FLOAT,
    10
));
```

---

### OPTIMIZATION_GEO

Flattens the response into one row per vehicle with pre-built GeoJSON LineStrings.

**Signature:** `OPTIMIZATION_GEO(jobs ARRAY, vehicles ARRAY, matrices ARRAY DEFAULT []) → TABLE(RESPONSE, VEHICLE, GEOJSON, DURATION, STEPS)`

| Column | Type | Description |
|--------|------|-------------|
| RESPONSE | VARIANT | Full VROOM response |
| VEHICLE | INT | Vehicle id |
| GEOJSON | VARIANT | Route as GeoJSON LineString |
| DURATION | INT | Route duration in seconds |
| STEPS | VARIANT | Ordered visit steps |

```sql
-- Multi-vehicle optimization with pre-parsed routes
SELECT *
FROM TABLE(OPENROUTESERVICE_NATIVE_APP.CORE.OPTIMIZATION_GEO(
    -- Jobs
    [
        {'id': 1, 'location': [-122.3936, 37.7956]},   -- Ferry Building
        {'id': 2, 'location': [-122.4169, 37.8080]},   -- Fisherman's Wharf
        {'id': 3, 'location': [-122.4786, 37.8199]},   -- Golden Gate Bridge
        {'id': 4, 'location': [-122.4098, 37.7786]}    -- SFMOMA
    ],
    -- Vehicles
    [
        {'id': 1, 'profile': 'driving-car', 'start': [-122.4075, 37.7881], 'end': [-122.4075, 37.7881]},
        {'id': 2, 'profile': 'driving-car', 'start': [-122.4194, 37.7749], 'end': [-122.4194, 37.7749]}
    ]
));
```

```sql
-- Convert to geography and analyze each vehicle's route
SELECT
    VEHICLE,
    TO_GEOGRAPHY(GEOJSON) AS route_geo,
    ROUND(DURATION / 60, 1) AS duration_min,
    ARRAY_SIZE(STEPS) AS num_stops
FROM TABLE(OPENROUTESERVICE_NATIVE_APP.CORE.OPTIMIZATION_GEO(
    [
        {'id': 1, 'location': [-122.3936, 37.7956]},
        {'id': 2, 'location': [-122.4169, 37.8080]},
        {'id': 3, 'location': [-122.4786, 37.8199]},
        {'id': 4, 'location': [-122.4098, 37.7786]}
    ],
    [
        {'id': 1, 'profile': 'driving-car', 'start': [-122.4075, 37.7881], 'end': [-122.4075, 37.7881]},
        {'id': 2, 'profile': 'driving-car', 'start': [-122.4194, 37.7749], 'end': [-122.4194, 37.7749]}
    ]
));
```

---

## Routing Profiles

All functions that accept a `method` parameter support these profiles:

| Profile | Description | Default |
|---------|-------------|:-------:|
| `driving-car` | Standard car routing | Enabled |
| `driving-hgv` | Heavy goods vehicle (truck) | Enabled |
| `cycling-regular` | Standard bicycle | Disabled |
| `cycling-mountain` | Mountain bike | Disabled |
| `cycling-road` | Road cycling | Enabled |
| `cycling-electric` | E-bike | Disabled |
| `foot-walking` | Pedestrian walking | Disabled |
| `foot-hiking` | Hiking trails | Disabled |
| `wheelchair` | Wheelchair accessible | Disabled |

> **Note:** Disabled profiles can be enabled in `ors-config.yml` before building the native app. Using a disabled profile returns an "unknown profile" error.

---

## San Francisco Landmark Coordinates

Useful coordinates for testing:

| Landmark | Longitude | Latitude |
|----------|-----------|----------|
| Union Square | -122.4075 | 37.7881 |
| Ferry Building | -122.3936 | 37.7956 |
| Fisherman's Wharf | -122.4169 | 37.8080 |
| Golden Gate Bridge | -122.4786 | 37.8199 |
| SFMOMA | -122.4098 | 37.7786 |
| Coit Tower | -122.4059 | 37.8024 |
| City Hall | -122.4183 | 37.7793 |
| AT&T Park (Oracle Park) | -122.3894 | 37.7786 |
| Presidio | -122.4662 | 37.7989 |
| Twin Peaks | -122.4477 | 37.7544 |

> **Coordinate order:** ORS uses `[longitude, latitude]` (GeoJSON standard), not `[lat, lng]`.

---

*Powered by [OpenRouteService](https://openrouteservice.org/) and Snowpark Container Services*
