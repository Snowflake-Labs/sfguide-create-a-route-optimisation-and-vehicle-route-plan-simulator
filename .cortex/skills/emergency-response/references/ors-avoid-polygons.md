# ORS avoid_polygons Integration

The differentiating capability vs ArcGIS Online is calling ORS isochrones and OPTIMIZATION (VROOM) with the active hazard polygon passed as `avoid_polygons`. This makes routing automatically detour around fires, floods, evacuation orders.

## Reference: GIScience Ahrtal Avoid Areas Isochrones

This pattern is a direct port of [`Ahrtal-Avoid-Areas-Isochrones.ipynb`](https://github.com/GIScience/openrouteservice-examples/blob/main/python/Ahrtal-Avoid-Areas-Isochrones.ipynb) adapted for US wildfire/flood NWS alert geometries.

## Polygon hygiene

NWS alerts ship with `Polygon` or `MultiPolygon` GeoJSON. Issues to handle:

1. Some alerts have Z-values; strip with `ST_FORCE2D(boundary)`.
2. ORS expects `avoid_polygons` as a single `MultiPolygon` Feature. Pass:
   ```sql
   PARSE_JSON(ST_ASGEOJSON(ST_FORCE2D(boundary)))
   ```
3. Very large multi-county polygons (e.g. statewide tornado watch) may exceed VROOM's body-parser limit (50mb per AGENTS.md). Pre-simplify with `ST_SIMPLIFY(boundary, 100)` (100m tolerance).

## ISOCHRONES wrapper

The UDF `EMERGENCY_RESPONSE.CORE.ORS_ISOCHRONE_AVOIDING(center_loc, alert_boundary, profile, range_seconds)` calls:

```sql
OPENROUTESERVICE_APP.CORE.ISOCHRONES(OBJECT_CONSTRUCT(
  'locations',      ARRAY_CONSTRUCT(ARRAY_CONSTRUCT(ST_X(center_loc), ST_Y(center_loc))),
  'range',          range_seconds,
  'profile',        profile,
  'avoid_polygons', PARSE_JSON(ST_ASGEOJSON(alert_boundary))
))
```

Validation: with a known SF fire scenario, the 30-min isochrone area with `avoid_polygons` must be SMALLER than the unblocked one. If equal, ORS is silently ignoring the polygon argument (check service version).

## OPTIMIZATION wrapper

Per AGENTS.md "Per-region VROOM" section, `OPTIMIZATION` routes via `routing_gateway_service` to the per-region `VROOM_SERVICE_<REGION>`. Pass `region` explicitly to be self-documenting:

```sql
OPENROUTESERVICE_APP.CORE.OPTIMIZATION(OBJECT_CONSTRUCT(
  'jobs',           jobs_array,
  'vehicles',       vehicles_array,
  'options',        OBJECT_CONSTRUCT('g', TRUE),
  'avoid_polygons', PARSE_JSON(ST_ASGEOJSON(alert_boundary)),
  'region',         'SanFrancisco'
))
```

`avoid_polygons` flows through to ORS Matrix step, so all leg geometries detour around the hazard.

## Performance notes

- Cross product of (alerts x centers) for `FACT_REACHABILITY_BY_CENTER` is bounded: typically 1-3 active alerts x 12 centers = 36 isochrone calls. Each ~500ms = 18s pipeline refresh.
- For dispatch, jobs > 50 will exceed VROOM default solve time. Pre-filter to top 50 highest-vulnerability impacted participants.
- Cache results aggressively: Dynamic Table TARGET_LAG of 15 min is appropriate (alert polygons rarely change within an event window).

## Failure modes

| Failure | Cause | Recovery |
|---|---|---|
| ORS 400 "InvalidGeoJsonObject" | Polygon has self-intersection | Wrap with `ST_BUFFER(boundary, 0)` |
| VROOM 422 "no route found" | Hazard polygon completely encloses a job location | Skip those jobs, mark `unreachable=true` in dispatch plan |
| Matrix step 504 timeout | Polygon too complex | `ST_SIMPLIFY(boundary, 200)` |
| Empty isochrones | All routes blocked | Center is fully cut off; flag for emergency relocation |
