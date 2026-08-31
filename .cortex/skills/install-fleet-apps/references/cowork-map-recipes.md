# Cowork map recipes (`data_to_map`)

Tested SQL for drawing SA-style maps in Snowflake CoWork. Every statement here was
executed against a live deployment (tib85385, region `SanFrancisco`) - the traps below
are observed, not theoretical.

## What `data_to_map` is, and what it is not

`data_to_map` is a **system tool injected by the host**, not something this repo declares.
It is registered server-side only when the account parameter is on **and** the request is
a Snowflake Intelligence request, and it deliberately never appears in
`tool_inventory.json`. Consequences:

- It exists in **CoWork**. It does **not** exist in the SA app, in `DATA_AGENT_RUN`, or in
  an agent evaluation run. Nothing goes into `agent-spec.json` to enable it, and nothing
  can enable it elsewhere.
- Because it is absent in some surfaces, the agent instructions treat it as optional and
  fall back to `deep_link`. An agent that assumes it exists will claim to have drawn a map
  that nobody can see.

The contract, from the upstream source:

| Property | Value |
|---|---|
| Layers per map | **exactly one** (`MapSpec.Layer` is a single struct, not a slice) |
| Layer types | `latlon` (lat + lon columns), `geojson` (GeoJSON string), `h3` (H3 cell strings) |
| Colour | one optional `color_column` + `color_scheme` (`sequential`, `categorical`, `divergent`, `snowflake`) |
| Source | `tool_result_id` = the `tool_use_id` of a **prior SQL / analyst tool result** |
| Citation | a **map** tag, never a chart tag (charts are Vega-Lite; a map cited as a chart does not render) |
| Row payload | rows are inlined into the spec with a cap - an oversized payload renders **blank**, not an error |

Account switches (already set on tib85385, internal so `SHOW PARAMETERS` will not display
them): `COPILOT_ORCHESTRATOR_PARAM_474`, `AI_ML__SI_ENABLE_MAP_CHART`,
`_DP_WORKSPACES_ENABLE_MAP_CHART`.

## Map-ready columns in the semantic layer

A GEOGRAPHY column cannot exist in a semantic view, so geometry is projected into shapes
`data_to_map` can read. These are the dimensions to select:

| Layer | Tool | Dimensions |
|---|---|---|
| `latlon` | `query_location` | `store_lat`, `store_lon` (+ `store_role` to colour) |
| `latlon` | `query_backload` | `pickup_lat`/`pickup_lon`, `home_lat`/`home_lon`, `current_lat`/`current_lon` |
| `latlon` | `query_emergency` | `center_lat`/`center_lon`, `participant_lat`/`participant_lon` |
| `latlon` | `query_fleet_ops` | trip origin / destination pairs |
| `geojson` | `query_emergency` | `hazard_geojson` (already a Polygon string - no conversion) |
| `geojson` | `query_location` | `zip_geojson` (ZIP boundary, simplified to 100 m) |
| `geojson` | `query_backload` | `lane_geojson` - a **straight line**, not a routed path |
| `h3` | `query_location` | `cell_h3` (household density) |
| `h3` | `query_dwell` | `h3_cell` (congestion) |

Payload sizes measured on this deployment:

| Geometry | Rows | Max per row | Total |
|---|---|---|---|
| Hazard zones (`hazard_geojson`) | 1182 | 246 B | 289 KB |
| ZIP boundaries, raw | 45 | **100 KB** | 696 KB |
| ZIP boundaries, `ST_SIMPLIFY(GEOG, 100)` | 45 | 7.3 KB | 71 KB |
| ZIP boundaries, `ST_SIMPLIFY(GEOG, 250)` | 45 | 3.2 KB | 32 KB |

Raw ZIP polygons are unusable - hence the 100 m simplification baked into `zip_geojson`.
Hazard cells are individually tiny but there are ~1200 of them, so filter by
`composite_rating` or region before mapping.

## Live routing geometry (Tenet 9)

Drive-time rings and solved tours must be computed at interaction time, never read from a
materialised table. Both are reachable from a single SELECT because the routing contract
exposes them as **table functions with a `GEOJSON GEOGRAPHY` column**.

### Drive-time ring

```sql
SELECT 'ring_10min'                        AS LAYER
     , ST_ASGEOJSON(GEOJSON)::VARCHAR      AS GEO
FROM TABLE(ROUTING_PLATFORM.CONTRACT.ISOCHRONES(
       'driving-car',            -- METHOD: the PROFILE only
       (-122.4194)::FLOAT,       -- LON, explicitly cast
       (37.7749)::FLOAT,         -- LAT, explicitly cast
       10,                       -- RANGE: MINUTES on this scalar overload
       'SanFrancisco',
       NULL::VARCHAR));          -- PROVIDER, typed NULL
```

Four traps, all of which cost a debugging cycle here:

1. **`METHOD` is the profile alone.** `'driving-car'`, not `'isochrones/driving-car'` - the
   wrapper prepends the endpoint path. Passing the path yields a 404 in `RESPONSE` and a
   **NULL** `GEOJSON` with no error raised.
2. **The failure is silent.** A bad call returns a row with NULL geometry. Always project
   `RESPONSE` while developing:
   `SELECT TO_JSON(RESPONSE)::string FROM TABLE(...ISOCHRONES(...))`.
3. **Numeric literals are `NUMBER`, not `FLOAT`.** Without `::FLOAT` the call fails with
   `Invalid argument types ... (VARCHAR, NUMBER(7,4), NUMBER(6,4), ...)`.
4. **`NULL` must be typed.** A bare `NULL` for `PROVIDER` fails signature matching; use
   `NULL::VARCHAR`.

`RANGE` is **minutes** on this scalar overload. The ARRAY overload elsewhere in the stack
takes **seconds**, and the two fail silently when confused.

### Solved tour (VRP)

```sql
WITH pts AS (
  SELECT LON, LAT, ROW_NUMBER() OVER (ORDER BY STORE_ID) AS RN
  FROM FLEET_APP.LOCATION.VW_STORE_FACTS WHERE STORE_ROLE = 'OWNED' QUALIFY RN <= 5
), agg AS (
  SELECT MIN_BY(ARRAY_CONSTRUCT(LON, LAT), RN)                                        AS ANCHOR
       , ARRAY_AGG(OBJECT_CONSTRUCT('id', RN, 'location', ARRAY_CONSTRUCT(LON, LAT))) AS JOBS
  FROM pts
)
SELECT VEHICLE
     , DURATION
     , ST_ASGEOJSON(GEOJSON)::VARCHAR AS GEO
FROM TABLE(ROUTING_PLATFORM.CONTRACT.OPTIMIZATION(
       (SELECT OBJECT_CONSTRUCT(
            'vehicles', ARRAY_CONSTRUCT(OBJECT_CONSTRUCT(
                'id', 1, 'profile', 'driving-car', 'start', ANCHOR, 'end', ANCHOR)),
            'jobs',    JOBS,
            'options', OBJECT_CONSTRUCT('g', TRUE))::VARIANT
        FROM agg),                    -- SCALAR SUBQUERY, not a correlated column
       'SanFrancisco', NULL::VARCHAR));
```

Returns one row per vehicle: a routed `LineString` (19.5 KB for 5 stops), `DURATION` in
seconds, and `STEPS`. Colour by `VEHICLE` with the categorical scheme to get the SA
per-vehicle tour colouring.

Two traps:

- **The challenge must be a scalar subquery.** `FROM challenge, TABLE(...OPTIMIZATION(challenge.CH, ...))`
  fails with `Unsupported subquery type cannot be evaluated`: the routing functions accept
  literal, scalar-subquery or bind arguments, never a correlated per-row column.
- **`options.g = true` is what returns geometry.** Without it there is no path to draw. On
  large solves the geometry can exceed the 20 MB external-function response cap, so keep
  the stop count bounded.

## The composite single-layer pattern

`data_to_map` draws one layer, but a `geojson` layer accepts **mixed geometry types**. So a
UNION into one geometry column plus a category column, coloured with
`color_column: LAYER` and `color_scheme: categorical`, gives a multi-class map from one
call. Verified: 59 rows combining owned stores, candidate stores, ZIP boundaries **and a
live 10-minute drive-time ring**.

```sql
WITH ring AS (
  SELECT ST_ASGEOJSON(GEOJSON)::VARCHAR AS GEO
  FROM TABLE(ROUTING_PLATFORM.CONTRACT.ISOCHRONES(
         'driving-car', (-122.4194)::FLOAT, (37.7749)::FLOAT, 10,
         'SanFrancisco', NULL::VARCHAR))
)
SELECT 'OWNED_STORE' AS LAYER, POI_NAME AS LABEL,
       ST_ASGEOJSON(ST_MAKEPOINT(LON, LAT))::VARCHAR AS GEO
FROM FLEET_APP.LOCATION.VW_STORE_FACTS WHERE STORE_ROLE = 'OWNED'
UNION ALL
SELECT 'CANDIDATE_STORE', POI_NAME, ST_ASGEOJSON(ST_MAKEPOINT(LON, LAT))::VARCHAR
FROM FLEET_APP.LOCATION.VW_STORE_FACTS WHERE STORE_ROLE = 'CANDIDATE'
UNION ALL
SELECT 'ZIP_AREA', ZIP, ST_ASGEOJSON(ST_SIMPLIFY(GEOG, 250))::VARCHAR
FROM FLEET_APP.LOCATION.VW_ZIP_AREAS
UNION ALL
SELECT 'DRIVE_10MIN', '10 min from downtown', GEO FROM ring;
```

What this does **not** recover from the SA app: layer toggles, per-layer styling (a dashed
empty leg beside a solid loaded one), tooltips, click-to-drill, and the as-of slider. Those
need upstream changes, filed against `snowflake-eng/cortex`:

| Issue | Item |
|---|---|
| [#156981](https://github.com/snowflake-eng/cortex/issues/156981) | index of all the gaps, with our layer-count evidence |
| [#156983](https://github.com/snowflake-eng/cortex/issues/156983) | multiple layers per MapSpec (the blocker) |
| [#156984](https://github.com/snowflake-eng/cortex/issues/156984) | allow an MCP tool result as a map source |
| [#156985](https://github.com/snowflake-eng/cortex/issues/156985) | column-driven styling: dashed, radius, width, h3 elevation |
| [#156986](https://github.com/snowflake-eng/cortex/issues/156986) | oversized payload renders blank; document the cap, return `truncated` |
| [#156988](https://github.com/snowflake-eng/cortex/issues/156988) | **live defect**: MapViewer basemap tiles are watermarked |

On that last one: MapViewer fetches the unkeyed CARTO **raster** endpoint
(`a.basemaps.cartocdn.com/light_all/...`), which returns HTTP 200 and a valid PNG with
"API KEY REQUIRED" stamped across it. So every CoWork map currently shows a watermarked
basemap, and no server-side check can detect it. This is the same trap that made us migrate
both of our own apps to the keyless vector positron style.

## Choosing between a map and a link

Draw a map when the answer is the **shape** of the data: where the hazard is, where the
estate sits, where density concentrates. Hand over a `deep_link` when the answer is a
**workflow**: comparing overlaid layers, clicking into a record, replaying a window. The
agent instructions encode this, and the honest framing to a user is "here is the shape,
open the view for the detail".

## Reproducing the payload measurements

```sql
-- Per-geometry payload budget for any candidate map query
SELECT COUNT(*)                                              AS ROWS_OUT
     , MAX(LENGTH(<geo_column>))                             AS MAX_BYTES
     , SUM(LENGTH(<geo_column>))                             AS TOTAL_BYTES
FROM <your map query>;
```

If a map renders blank with no error, suspect the payload before anything else.
