# Available Functions (v2.0 — Consolidated)

The app registers the following SQL functions in the `CORE` schema.
All routing functions accept an optional `region` as the **last** parameter (DEFAULT NULL).
When omitted, the default ORS instance is used. When provided, routes to the named city ORS instance.

## Routing Table Functions

Return structured TABLE results with parsed GEOGRAPHY columns:

| Function | Returns |
|----------|---------|
| `DIRECTIONS(method, jstart, jend [, region])` | TABLE (RESPONSE, GEOJSON, DISTANCE, DURATION) |
| `DIRECTIONS(method, locations [, region])` | TABLE (RESPONSE, GEOJSON, DISTANCE, DURATION) |
| `ISOCHRONES(method, lon, lat, range [, region])` | TABLE (RESPONSE, GEOJSON) |
| `OPTIMIZATION(jobs, vehicles [, matrices, region])` | TABLE (RESPONSE, GEOJSON, VEHICLE, DURATION, STEPS) |
| `OPTIMIZATION(challenge [, region])` | TABLE (RESPONSE, GEOJSON, VEHICLE, DURATION, STEPS) |

Usage: `SELECT * FROM TABLE(CORE.DIRECTIONS('driving-car', start_arr, end_arr))`
With region: `SELECT * FROM TABLE(CORE.DIRECTIONS('driving-car', start_arr, end_arr, 'berlin'))`

## Matrix / Status Scalar Functions

Return VARIANT:

| Function | Description |
|----------|-------------|
| `MATRIX(method, locations [, region])` | Full NxN distance/duration matrix |
| `MATRIX(method, options [, region])` | Matrix with advanced options |
| `MATRIX_TABULAR(method, origin, destinations [, region])` | Origin-to-destinations matrix |
| `ORS_STATUS([region])` | Service status JSON |

Usage: `SELECT CORE.MATRIX_TABULAR('driving-car', origin_arr, dests_arr)`

## Utility Functions

| Function | Returns | Description |
|----------|---------|-------------|
| `CHECK_HEALTH()` | BOOLEAN | True if ORS gateway responds |
| `LIST_REGIONS()` | TABLE (REGION, DISPLAY_NAME, STATUS, ...) | All provisioned regions |
| `DOWNLOAD(folder, filename, URL)` | VARIANT | Downloads a file to stage |

## Lifecycle Management Procedures

- `RESUME_ALL_SERVICES()` — Resumes all suspended services and the compute pool
- `SUSPEND_ALL_SERVICES()` — Suspends all services except the control app
- `SCALE_SERVICES(min, max)` — Scales ORS + gateway + all city ORS instances and pool nodes
- `GET_STATUS()` — Returns JSON with compute pool state and all service statuses

## Multi-Region Procedures

- `SETUP_REGION_ORS(region)` — Provisions a new region with its own ORS service
- `DROP_REGION_ORS(region)` — Removes a region's service and metadata
- `LIST_REGIONS()` — Returns JSON array of all provisioned regions
- `REFRESH_REGION_CATALOG()` — Fetches available regions from Geofabrik + BBBike into REGION_CATALOG table

Note: Per-region function aliases (e.g. `DIRECTIONS_BERLIN`) have been removed. Use the `region` parameter instead:
```sql
SELECT * FROM TABLE(CORE.DIRECTIONS('driving-car', start, end, 'berlin'))
```

## Travel Time Matrix Procedures

- `BUILD_MATRIX_FOR_REGION(res, min_lat, max_lat, min_lon, max_lon, matrix_fn, region, profile)` — End-to-end matrix build with parallel ASYNC workers
- `BUILD_HEXAGONS(res, min_lat, max_lat, min_lon, max_lon, region, profile)` — Generates H3 hex grid using H3_POLYGON_TO_CELLS_STRINGS (native polygon coverage)
- `BUILD_WORK_QUEUE(res, region, profile)` — Creates chunked origin→destinations work queue (max 1000 destinations per row)
- `BUILD_TRAVEL_TIME_RANGE_REGION(res, start_seq, end_seq, matrix_fn, region, profile)` — Processes batch range with retry logic
- `FLATTEN_MATRIX_RAW(res, region, profile)` — Flattens VARIANT results into travel time pairs (ORDER BY ORIGIN_H3)
- `MATRIX_PROGRESS(region, profile)` — Returns JSON with per-resolution build status
- `ENSURE_MATRIX_TABLES(region, profile, res)` — Creates region/profile-specific matrix tables if not exists

## Matrix Builder Architecture

### Hexagon Generation
- **H3_POLYGON_TO_CELLS_STRINGS**: Native Snowflake polygon-to-H3 coverage. ~10x faster than brute-force CROSS JOIN grid generation.

### Work Queue & Destination Chunking
- BUILD_WORK_QUEUE splits each origin's destinations into groups of max **1000** using `FLOOR((dest_seq - 1) / 1000)` partitioning.
- Each work queue row is a 1×1000 matrix call regardless of resolution or total hex count.
- This prevents ORS 6099 "too many locations" errors and keeps individual API calls manageable.

### Adaptive Parallelism
- Worker count formula: `LEAST(GREATEST(service_instances * 2, 2), 4)`
- Default ORS (3 instances) → **4 workers**; city ORS (1 instance) → **2 workers**.
- Each worker processes a contiguous SEQ_ID range via ASYNC BUILD_TRAVEL_TIME_RANGE_REGION calls.

### Batch Size
- Uniform `batch_size = 50` for all resolutions. Each batch INSERT...SELECTs 50 work queue rows, each calling MATRIX_TABULAR.

### Gateway Concurrency
- Gateway v1.0.0 uses **ThreadPoolExecutor** to process rows concurrently within each batch.
- `MATRIX_CONCURRENCY=6` (configurable via env var in `routing-gateway-service.yaml`).
- Gunicorn server: 2 workers, 4 threads, 300s timeout.
- Effective throughput: 50 rows × 6 concurrent = ~8-10 ORS calls in flight per gateway instance.
- Benchmark: Berlin RES8 (2,611 hexagons, ~6.8M pairs) completes in **6 minutes** with 1-instance city ORS + 2 SQL workers.

### 3-Layer Error Recovery
1. **Per-batch retry**: Each INSERT...SELECT is wrapped in BEGIN/EXCEPTION. On failure, retries up to 5 times with exponential backoff (5s, 10s, 20s, 40s, 80s).
2. **Per-worker batched retry**: After processing all batches, each worker runs up to 3 passes. Each pass deletes NULL-result rows and re-processes missing SEQ_IDs in groups of `batch_size`.
3. **Wrapper-level sweep**: After AWAIT ALL workers complete, BUILD_MATRIX_JOB_WRAPPER runs up to 2 single-threaded passes (batch=25) to catch any remaining gaps.

### Data Layout
- **ORDER BY ORIGIN_H3**: FLATTEN_MATRIX_RAW writes travel time pairs ordered by origin hex for optimal spatial queries and Matrix Viewer performance.

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
