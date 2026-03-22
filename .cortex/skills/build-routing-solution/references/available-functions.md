# Available Functions

The app registers the following SQL functions in the `CORE` schema.

## Scalar Functions

Return VARIANT with full ORS JSON response:

- `DIRECTIONS(method, jstart, jend)` / `DIRECTIONS(method, locations)`
- `ISOCHRONES(method, lon, lat, range)`
- `OPTIMIZATION(jobs, vehicles, matrices)` / `OPTIMIZATION(challenge)`
- `MATRIX(method, sources, destinations)` / `MATRIX_TABULAR(...)`

## GEO Table Functions

Return parsed GEOGRAPHY column alongside response:

- `DIRECTIONS_GEO(method, jstart, jend)` → RESPONSE, GEOJSON, DISTANCE, DURATION
- `DIRECTIONS_GEO(method, locations)` → RESPONSE, GEOJSON, DISTANCE, DURATION
- `ISOCHRONES_GEO(method, lon, lat, range)` → RESPONSE, GEOJSON
- `OPTIMIZATION_GEO(jobs, vehicles, matrices)` → RESPONSE, GEOJSON, VEHICLE, DURATION, STEPS
- `OPTIMIZATION_GEO(challenge)` → RESPONSE, GEOJSON, VEHICLE, DURATION, STEPS

The `_GEO` variants are table functions that parse the GeoJSON from ORS responses into Snowflake GEOGRAPHY columns, making it easy to use with spatial joins and visualization.

## Lifecycle Management Procedures

- `RESUME_ALL_SERVICES()` — Resumes all suspended services and the compute pool
- `SUSPEND_ALL_SERVICES()` — Suspends all services except the control app
- `SCALE_SERVICES(min, max)` — Scales ORS + gateway instances and pool nodes
- `GET_STATUS()` — Returns JSON with compute pool state and all service statuses
- `CHECK_HEALTH()` — Returns BOOLEAN, true if ORS gateway responds

## Multi-City Procedures

- `SETUP_CITY_ORS(region)` — Provisions a new city with its own ORS service + functions
- `DROP_CITY_ORS(region)` — Removes a city's service, functions, and metadata
- `LIST_CITIES()` — Returns JSON array of all provisioned cities
- City-specific functions: `DIRECTIONS_{REGION}`, `ISOCHRONES_{REGION}`, `MATRIX_{REGION}`, `OPTIMIZATION_{REGION}`

## Travel Time Matrix Procedures

- `BUILD_MATRIX_FOR_REGION(res, min_lat, max_lat, min_lon, max_lon, matrix_fn, region, profile)` — End-to-end matrix build with parallel ASYNC workers
- `BUILD_HEXAGONS(res, min_lat, max_lat, min_lon, max_lon, region, profile)` — Generates H3 hex grid using H3_POLYGON_TO_CELLS_STRINGS (native polygon coverage)
- `BUILD_WORK_QUEUE(res, region, profile)` — Creates origin→destinations work queue with H3_GRID_DISK neighbors
- `BUILD_TRAVEL_TIME_RANGE_REGION(res, start_seq, end_seq, matrix_fn, region, profile)` — Processes batch range with retry logic
- `FLATTEN_MATRIX_RAW(res, region, profile)` — Flattens VARIANT results into travel time pairs (ORDER BY ORIGIN_H3)
- `MATRIX_PROGRESS(region, profile)` — Returns JSON with per-resolution build status
- `ENSURE_MATRIX_TABLES(region, profile, res)` — Creates region/profile-specific matrix tables if not exists

## Matrix Builder Optimizations (v1.1)

- **H3_POLYGON_TO_CELLS_STRINGS**: Replaces brute-force CROSS JOIN grid generation with native Snowflake polygon-to-H3 coverage. Eliminates GENERATOR + SEQ4() + DISTINCT approach. ~10x faster hex generation.
- **ASYNC/AWAIT parallel workers**: BUILD_MATRIX_FOR_REGION splits the work queue into 4 parallel chunks, each processed by an async BUILD_TRAVEL_TIME_RANGE_REGION call. Up to 4x faster ORS API throughput.
- **ORDER BY ORIGIN_H3**: FLATTEN_MATRIX_RAW writes travel time pairs ordered by origin hex, ensuring optimal physical data layout for spatial queries and the Matrix Viewer.

## Matrix Viewer (ORS Control App)

- Interactive deck.gl heatmap visualization of travel time matrices
- SQL API v2 multi-partition pagination (handles 1M+ row matrices)
- 5-minute discrete color gradient buckets
- Region/resolution/profile selector with row count and build time display
- Build Time column in Matrix Builder inventory

## Default Routing Profiles

| Profile | Enabled |
|---------|--------|
| driving-car | Yes |
| driving-hgv | Yes |
| cycling-electric | Yes |

All other profiles (cycling-regular, cycling-road, cycling-mountain, foot-walking, foot-hiking, wheelchair) are disabled by default. When provisioning new cities via the Cities tab, users can select which routing profiles to install using the profile checkboxes. Use the `routing-customization` skill to change profiles on the default (San Francisco) instance.

## Default Service Limits

| Setting | Value | Description |
|---------|-------|-------------|
| maximum_distance | 1,500 km | Max route distance for all profiles |
| maximum_range_time (isochrones) | 18,000 s (5 hours) | Max isochrone travel time |
| maximum_range_distance (isochrones) | 1,500 km | Max isochrone travel distance |
| maximum_intervals (isochrones) | 10 | Max isochrone intervals per request |
| maximum_routes (matrix) | 250,000 | Max matrix routes |
