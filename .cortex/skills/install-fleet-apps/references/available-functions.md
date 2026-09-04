# Available Functions (v2.0 - Consolidated)

The app registers the following SQL functions in the `CORE` schema.
All routing functions accept an optional `region` as the **last** parameter (DEFAULT NULL).
When omitted or NULL, the gateway resolves to `DEFAULT_REGION_NAME` (configured at the
gateway service spec, default: `SanFrancisco`). When provided, the call routes to the
named city's per-region service (`ORS_SERVICE_<REGION>` / `VROOM_SERVICE_<REGION>`).
v1.1.0 - there is no longer a separate global `ORS_SERVICE`; even the default region
follows the per-region naming convention.

## Routing Table Functions

Return structured TABLE results with parsed GEOGRAPHY columns:

| Function | Returns |
|----------|---------|
| `DIRECTIONS(method, jstart, jend [, region])` | TABLE (RESPONSE, GEOJSON, DISTANCE, DURATION) |
| `DIRECTIONS(method, locations [, region])` | TABLE (RESPONSE, GEOJSON, DISTANCE, DURATION) |
| `ISOCHRONES(method, lon, lat, range [, region])` | TABLE (RESPONSE, GEOJSON) |
| `OPTIMIZATION(jobs, vehicles [, matrices, region])` | TABLE (RESPONSE, GEOJSON, VEHICLE, DURATION, STEPS) |
| `OPTIMIZATION(challenge [, region])` | TABLE (RESPONSE, GEOJSON, VEHICLE, DURATION, STEPS) |
| `SNAP_POINTS(method, locations, radius [, region])` | TABLE (IDX, INPUT_GEOG, SNAPPED_GEOG, SNAPPED_DISTANCE, NAME) |
| `MATCH_PATH(method, linestring [, region])` | TABLE (RESPONSE, GEOJSON, MATCHED_EDGES) - HMM map matching; GEOJSON = matched road segments. Needs engine >= v9.8.0 (see the note below) |

Usage: `SELECT * FROM TABLE(CORE.DIRECTIONS('driving-car', start_arr, end_arr))`
With region: `SELECT * FROM TABLE(CORE.DIRECTIONS('driving-car', start_arr, end_arr, 'berlin'))`

**IMPORTANT for OPTIMIZATION**: Always pass `region` (e.g. `'California'`, `'Germany'`) as the last argument when running for a specific region. The gateway uses it to route the VRP to the per-region `VROOM_SERVICE_<REGION>` (which talks to `ors-service-<region>`). Omitting `region` falls back to `DEFAULT_REGION_NAME` (SanFrancisco), which will fail for any non-SF data.

## Matrix / Status Scalar Functions

Return VARIANT:

| Function | Description |
|----------|-------------|
| `MATRIX(method, locations [, region])` | Full NxN distance/duration matrix |
| `MATRIX(method, options [, region])` | Matrix with advanced options |
| `MATRIX_TABULAR(method, origin, destinations [, region])` | Origin-to-destinations matrix |
| `SNAP(method, locations, radius [, region])` | Snap each point to nearest routable edge (raw ORS VARIANT: `:locations[]` of null or `{location, name, snapped_distance}`) |
| `MATCH(method, features [, region])` | Map matching: match a GeoJSON FeatureCollection to the graph, returns `:edge_ids` per feature (raw ORS VARIANT). Needs engine >= v9.4.0. Use `MATCH_PATH` for geometry. |
| `ORS_STATUS([region])` | Service status JSON |

Usage: `SELECT CORE.MATRIX_TABULAR('driving-car', origin_arr, dests_arr)`

**Note on `MATCH` / `MATCH_PATH`**: both wrappers pass the profile to `_MATCH_RAW` with a
trailing `?` (e.g. `'cycling-electric?'`). This is load-bearing, do NOT strip it. ORS exposes
`POST /v2/match/{profile}` only - it has no format-suffixed route (unlike `/snap` and
`/export`), and its `@PostMapping("/{profile}/*")` catch-all answers any extra path segment
with error 9007 "Response format is not supported". The gateway appends a format segment
(`/json`) unconditionally in `get_ors_response`, so the `?` demotes it to a query string that
Spring ignores. It stays harmless if the gateway is ever changed to skip the format for
`match` (the query is then simply empty). Side effect: `OBSERVABILITY.ORS_REQUEST_LOG.PROFILE`
records `<profile>?` for match calls.

**Note on `MATCH_PATH` geometry resolution**: `/v2/match` never returns geometry - only
internal graph `edge_ids`. `MATCH_PATH` resolves them by chaining a bbox `/v2/export`
topojson call, joining `edge_id` to the export geometry properties. Four details are
load-bearing:

- The export payload MUST set `additional_info: true`. TopoJSON export has two mutually
  exclusive property branches: with `OsmId` ext storage enabled on the profile it emits
  one geometry per OSM way carrying `ors_ids` (plural), and without `OsmId` it emits one
  geometry per directed edge carrying `ors_id` (singular) - but only when
  `additional_info` is set. Omitting the flag on a non-OsmId profile suppresses the edge
  id entirely, so the join matches nothing and `GEOJSON` comes back NULL while
  `MATCHED_EDGES` still looks healthy. `MATCH_PATH` tests both property names, so
  `OsmId` ext storage is NOT required and no graph rebuild is needed.
- `ors_id` (singular) requires engine >= **v9.8.0** (ORS PR #2244). On v9.4.0 - v9.7.x
  only the `OsmId` / `ors_ids` branch can produce geometry.
- TopoJSON encodes a reversed arc as `-(1 + index)`, and the non-OsmId branch reuses one
  arc for both directions of an edge, so a large share of arc references are negative.
  `ABS()` is NOT the inverse (it yields `index + 1` and silently draws a neighbouring
  road); decode with `IFF(v < 0, -v - 1, v)`.
- **Positional arc-to-edge pairing.** On the `OsmId` branch, `arcs[i]` pairs 1:1 with
  `ors_ids[i]` within each geometry. Matching at the geometry level (e.g.
  `ARRAYS_OVERLAP(ors_ids, edge_ids)`) and then taking ALL arcs of the matching geometry
  over-selects the entire OSM way - measured 78 arcs for 36 matched edges (54% residual),
  painting stray road segments the trajectory never traversed. The predicate must be
  positional: `ors_ids[a.index]` so only the arc whose own edge id was matched is
  included. `COALESCE(ors_ids[a.index], ors_id)` handles both export branches.

**Note on `MATCH_PATH` geometry (`OsmId` ext storage required)**: `MATCH_PATH` resolves matched
edge ids to road geometry by joining `/export` TopoJSON `properties.ors_ids`, which ORS emits
ONLY when the profile's graph was built with the `OsmId` external storage. Without it `/export`
returns the `{node_from, node_to, weight}` shape with no ids to join, so `MATCH_PATH` returns
`MATCHED_EDGES > 0` and `GEOJSON = NULL` (`MATCH` itself is unaffected). `WRITE_ORS_CONFIG`
always emits `OsmId`, so any region provisioned through the normal flow is fine. Deployments
created before `OsmId` was added to `staged_files/ors-config.yml` have an OsmId-less DEFAULT
region, because `BOOTSTRAP_DEFAULT_REGION` boots from that static file and never calls
`WRITE_ORS_CONFIG`. Repair (a graph REBUILD is required - an ext_storages change does not take
effect on a plain restart):

```sql
-- Pass the profiles EXPLICITLY. The region has no REGION_PROVISION_JOBS row, and every
-- implicit derivation in this codebase falls back to 'driving-car' alone, which would
-- silently drop the region's other profiles. Check the current set first with:
--   SELECT ARRAY_TO_STRING(OBJECT_KEYS(TRY_PARSE_JSON(CORE.ORS_STATUS('SanFrancisco')::VARCHAR):profiles), ',');
CALL OPENROUTESERVICE_APP.CORE.WRITE_ORS_CONFIG('SanFrancisco', 'SanFrancisco.osm.pbf', 'driving-car,cycling-electric', 'S');
CALL OPENROUTESERVICE_APP.CORE.REBUILD_REGION_GRAPHS('SanFrancisco');
```

Order matters: the container reads the staged config on start and `REBUILD_REGION_GRAPHS` does
not regenerate it. The rebuild purges the persisted graph and recreates the pool + ORS + VROOM
services, so the region is unavailable for the duration (an S-tier city extract is a few
minutes).

Verify with the authoritative signal - the storages ORS actually loaded - NOT by probing
`/export`, and check the graph really was recomputed:

```sql
WITH s AS (SELECT TRY_PARSE_JSON(OPENROUTESERVICE_APP.CORE.ORS_STATUS('SanFrancisco')::VARCHAR) AS j)
SELECT j:engine:graph_date::STRING AS GRAPH_DATE,                     -- must be NEW
       TO_JSON(OBJECT_KEYS(j:profiles:"cycling-electric":storages))   -- must contain OsmId
FROM s;
```

If `graph_date` did not move, the purge did not take effect. On a deployment still running a
`REBUILD_REGION_GRAPHS` older than the suspend-before-purge fix, the graph stage is purged while
the container is still RUNNING; because the graph dir is a stage-mounted volume the container
flushes its cached copy straight back on shutdown, ORS reloads the identical graph, and the proc
still reports "Rebuild complete". Repair manually in this order: `ALTER SERVICE ... SUSPEND`,
poll `SHOW SERVICES` until `SUSPENDED` (it passes through `SUSPENDING`), then
`CALL WRITE_ORS_CONFIG(...)`, then `REMOVE @ORS_GRAPHS_SPCS_STAGE/<region>/`, confirm the `LIST`
is empty, then `ALTER SERVICE ... RESUME`.

## Utility Functions

| Function | Returns | Description |
|----------|---------|-------------|
| `CHECK_HEALTH()` | BOOLEAN | True if ORS gateway responds |
| `LIST_REGIONS()` | TABLE (REGION, DISPLAY_NAME, STATUS, ...) | All provisioned regions |

## Lifecycle Management Procedures

- `RESUME_ALL_SERVICES()` - Resumes all suspended services and the compute pool
- `SUSPEND_ALL_SERVICES()` - Suspends all services except the control app
- `SCALE_SERVICES(min, max)` - Scales ORS + gateway + all city ORS instances and pool nodes
- `GET_STATUS()` - Returns JSON with compute pool state and all service statuses

## Multi-Region Procedures

- `SETUP_REGION_ORS(region)` - Provisions a new region with its own ORS service
- `DROP_REGION_ORS(region)` - Removes a region's service and metadata
- `LIST_REGIONS()` - Returns JSON array of all provisioned regions
- `REFRESH_REGION_CATALOG()` - Fetches available regions from Geofabrik + BBBike into REGION_CATALOG table

## Region Boundary Helpers

`REGION_CATALOG.BOUNDARY` is a `GEOGRAPHY` column populated at install time
from a shipped snapshot. Coverage (5,194 rows total):

| SOURCE          | LEVEL          | rows  | provenance                                              |
| --------------- | -------------- | ----- | ------------------------------------------------------- |
| `geofabrik`     | continent      | 8     | Geofabrik `.poly` files (real admin polygons)           |
| `geofabrik`     | country        | 257   | Geofabrik `.poly` files                                 |
| `geofabrik`     | sub-region     | 217   | Geofabrik (DE Lander, FR regions, AU/CA states, etc.)   |
| `geofabrik`     | sub-sub-region | 72    | Geofabrik (German Regbez, UK counties, ...)             |
| `geofabrik`     | depth-4        | 1     | Deeply-nested Geofabrik leaf                            |
| `bbbike`        | city           | 238   | BBBike rectangles (true clip mask)                      |
| `natural-earth` | sub-region     | 4,401 | Natural Earth admin-1 (US states, BR/IN/MX states, etc.)|

All boundaries simplified to ~100m tolerance. ISO_3166-2 subdivision codes
filled for ~4,500 sub-regions via Natural Earth. Use `BOUNDARY` to filter
sample points / POIs / hexagons to the region's actual shape instead of
bbox rectangles. See the seed parquet at
`datasets/region_catalog/data_0_0_0.snappy.parquet`.

### Adding new regions

1. Geofabrik publishes a new sub-region: re-run
   `python3 scripts/region_catalog/expand_geofabrik_subregions.py` then
   `python3 scripts/region_catalog/build_boundaries.py`.
2. A state/province Geofabrik does not split (e.g. a new US state - never
   happens, but illustrative): the Natural Earth supplement already covers
   all admin-1 globally. Re-run
   `python3 scripts/region_catalog/supplement_natural_earth.py` only when
   Natural Earth releases a new edition.
3. Custom polygon (org-specific service area): insert directly into
   `REGION_CATALOG` with a unique `REGION_KEY`, valid `BOUNDARY`, and
   `BOUNDARY_SOURCE='manual'`. The matrix builders match on
   `LOOKUP_NAME` or `REGION_KEY` (case-insensitive).

After updating the seed parquet, redeploy:

```sql
TRUNCATE TABLE OPENROUTESERVICE_APP.CORE.REGION_CATALOG;
CALL OPENROUTESERVICE_APP.CORE.LOAD_SEED_CATALOG('@OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE');
```

### bbox-fallback warnings

`BUILD_HEXAGONS` and `BUILD_HEXAGONS_ROAD_AWARE` log a row to
`OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BBOX_FALLBACK_WARNINGS` whenever
they cannot resolve `P_REGION` to a catalog polygon. Any matrix tessellated
after a warning will leak hexes outside the intended boundary (the bbox
rectangle nearly always over-covers - California's bbox spans NV/OR/Pacific,
NSW's bbox spans Lord Howe Island, etc.). Inspect with:

```sql
SELECT * FROM OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BBOX_FALLBACK_WARNINGS
ORDER BY LOGGED_AT DESC;
```

```sql
-- Reverse-region lookup: which region does a coordinate fall in?
SELECT OPENROUTESERVICE_APP.CORE.REGION_FOR_POINT(-122.42, 37.77);

-- Boolean variant: is a coordinate inside a named region?
SELECT OPENROUTESERVICE_APP.CORE.POINT_IN_REGION(-122.42, 37.77, 'SanFrancisco');

-- Filter Overture POIs to a region's actual shape (not bbox):
SELECT p.* FROM OVERTURE_MAPS__PLACES.CARTO.PLACE p
JOIN OPENROUTESERVICE_APP.CORE.REGION_CATALOG rc
  ON UPPER(rc.LOOKUP_NAME) = 'BAYERN'
WHERE rc.BOUNDARY IS NOT NULL
  AND ST_INTERSECTS(p.GEOMETRY, rc.BOUNDARY);

-- Isochrone clipped to region boundary (no foreign-territory bleed):
SELECT GEOJSON FROM TABLE(
  OPENROUTESERVICE_APP.CORE.ISOCHRONES_CLIPPED(
    'driving-car', -122.42, 37.77, 600, 'SanFrancisco'));

-- H3 hexagon coverage over actual region (drops water cells):
SELECT h.VALUE::VARCHAR AS h3_index
FROM OPENROUTESERVICE_APP.CORE.REGION_CATALOG rc,
     TABLE(FLATTEN(H3_POLYGON_TO_CELLS_STRINGS(rc.BOUNDARY, 8))) h
WHERE UPPER(rc.LOOKUP_NAME) = 'SANFRANCISCO';
```

Prefer these patterns over `WHERE ST_X/Y BETWEEN bbox` for cleaner POI sets,
fewer null ORS responses, and faster matrix builds (water cells dropped
upstream).

Note: Per-region function aliases (e.g. `DIRECTIONS_BERLIN`) have been removed. Use the `region` parameter instead:
```sql
SELECT * FROM TABLE(CORE.DIRECTIONS('driving-car', start, end, 'berlin'))
```

## Travel Time Matrix Procedures

- `BUILD_MATRIX_FOR_REGION(res, min_lat, max_lat, min_lon, max_lon, matrix_fn, region, profile)` - End-to-end matrix build with parallel ASYNC workers
- `BUILD_HEXAGONS(res, min_lat, max_lat, min_lon, max_lon, region, profile)` - Generates H3 hex grid using H3_POLYGON_TO_CELLS_STRINGS (native polygon coverage)
- `BUILD_WORK_QUEUE(res, region, profile)` - Creates chunked origin→destinations work queue (max 1000 destinations per row)
- `BUILD_TRAVEL_TIME_RANGE_REGION(res, start_seq, end_seq, matrix_fn, region, profile)` - Processes batch range with retry logic
- `FLATTEN_MATRIX_RAW(res, region, profile)` - Flattens VARIANT results into travel time pairs (ORDER BY ORIGIN_H3)
- `MATRIX_PROGRESS(region, profile)` - Returns JSON with per-resolution build status
- `ENSURE_MATRIX_TABLES(region, profile, res)` - Creates region/profile-specific matrix tables if not exists

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

All configurable ORS service limits are set to `Integer.MAX_VALUE` (**2,147,483,647**) - i.e. effectively unlimited. ORS does not enforce a hard ceiling on these fields; the value is the practical Java `int` upper bound. This applies to:

| Endpoint | Settings raised to 2,147,483,647 |
|---|---|
| routing (`profile_default.service`) | `maximum_distance`, `maximum_distance_dynamic_weights`, `maximum_distance_avoid_areas`, `maximum_distance_alternative_routes`, `maximum_distance_round_trip_routes`, `maximum_visited_nodes`, `maximum_waypoints`, `maximum_snapping_radius`, `maximum_avoid_polygon_area`, `maximum_avoid_polygon_extent` |
| matrix | `maximum_routes`, `maximum_routes_flexible`, `maximum_visited_nodes`, `maximum_search_radius` |
| isochrones | `maximum_locations`, `maximum_intervals`, `maximum_range_distance`, `maximum_range_time` |
| snap | `maximum_locations` |
