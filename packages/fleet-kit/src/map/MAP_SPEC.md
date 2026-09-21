# Map layer DSL

The declarative map spec compiled by [layer-compiler.ts](./layer-compiler.ts) and
validated by `fleet_sa_app/ui/src/lib/map-spec-schema.ts`.

Two producers emit it: a `component: "Map"` area in `fleet_sa_app/app/app-views.json`,
and the `render_map` verb (`fleet_tools/user/src/procs/render_map.ts`) for inline
chat maps. One consumer renders it: `ViewMapArea` on a page, `RenderMapInline` in
chat, both over the shared `MapView` deck.gl canvas.

## Why every mistake here is silent

A malformed map does not throw. An unknown layer `type` compiles to `null`, an
oversized geometry payload renders nothing, and a `viewState.*` param on an inline
map binds NULL and returns zero rows. In all three cases the basemap paints and
the result is indistinguishable from "the query legitimately matched no rows".
That is why the validator rejects by name, and why the rules below are rules
rather than advice.

## Shape

```jsonc
{
  "version": 1,                  // optional; absent means 1. Newer than the build supports is REJECTED
  "title": "Empty legs",
  "height": 340,                 // inline maps only, clamped to [200, 600]
  "layers": [ /* 1..4 */ ],
  "legend": [ { "label": "Moving", "color": [41, 181, 232, 230], "shape": "dot" } ],
  "emptyMessage": "No empty legs in this window"
}
```

Area-only keys (`toggles`, `clickEmits`, `focusOn`, `lockCamera`) are legal on a
page and rejected on an inline map: a chat message has no view state to write.

## Layer types

| `type` | Geometry binding | deck.gl layer |
|---|---|---|
| `scatterplot` | `lng`, `lat` (numeric columns) | ScatterplotLayer |
| `path` | `geojsonColumn`, or `start`/`end` `{lng,lat}` | PathLayer |
| `geojson` | `geojsonColumn` | GeoJsonLayer |
| `h3` | `hexColumn` (+ optional `valueColumn`) | H3HexagonLayer |
| `arc` | `source`/`target` `{lng,lat}` | ArcLayer |

At most `MAX_MAP_LAYERS` (4) layers. Each layer is one independent warehouse
query, so the cap bounds cost as much as legibility.

## Data

```jsonc
{
  "type": "path",
  "geojsonColumn": "trail_geojson",
  "tooltip": "<b>Empty leg {trip}</b><br/>{distance_km} km",
  "data": {
    "query": "SELECT ... FROM ... WHERE REGION = :region",
    "params": { "region": "context.region", "dataset_id": "context.dataset_id" }
  }
}
```

`params` maps a `:placeholder` to `context.*`, `viewState.*` (page only), or a
literal. Tooltip `{COLUMN}` tokens are case-insensitive and HTML-escaped.

## Colour

Three forms, in increasing specificity:

```jsonc
"color": [255, 171, 0, 210]                                    // flat RGBA
"fillColor": { "column": "STATUS", "palette": { "MOVING": [...] }, "default": [...] }   // categorical
"fillColor": {                                                  // conditional highlight
  "base": [...], "active": [...],
  "matchColumn": "VEHICLE_ID", "whenViewStateEquals": "selected_entity",
  "baseColumn": "STATUS", "basePalette": { "IDLE": [...] }
}
```

## SQL projection patterns

Geometry never crosses the wire as GEOGRAPHY. Project it:

```sql
-- points
SELECT ST_X(LOCATION) AS lng, ST_Y(LOCATION) AS lat, STATUS FROM ...

-- paths and polygons: SIMPLIFY, then filter to a region or band
SELECT ST_ASGEOJSON(ST_SIMPLIFY(ROUTE_GEOG, 250))::STRING AS trail_geojson FROM ...

-- hexagons
SELECT H3_POINT_TO_CELL_STRING(LOCATION, 8) AS cell, COUNT(*) AS n FROM ... GROUP BY 1
```

Measured payload sizes: a raw ZIP polygon is about 100 KB, about 7 KB at
`ST_SIMPLIFY(GEOG, 100)`. Europe-scale route geometry can exceed 20 MB, which is
why `simplify.ts` decimates line geometry to 500 vertices. Never serialize
`BOUNDARY_GEOJSON` into a query - keep the polygon server-side behind `ST_WITHIN`.

Polygon rings are deliberately never decimated: stride-dropping vertices from an
isochrone ring self-intersects it.

## Detection

[detect-geo.ts](./detect-geo.ts) infers a binding from result metadata plus a row
sample, for the case where nobody authored a spec. It requires a column name AND
its values to agree, because name alone turns a numeric `x` holding prices into a
longitude, and values alone turn any two in-range numbers into a coordinate pair.
Detection suggests a spec; the result still goes through `validateMapLayers`.

## Interop with CoWork MapSpec v1

CoWork's host-injected `data_to_map` takes its own contract, and `render_map`
output cannot be fed to it: `data_to_map` accepts a single layer and only a SQL or
analyst `tool_result_id`, so it rejects an MCP verb result outright. The mapping
below is for porting a spec by hand, not a conversion this code performs.

| This DSL | MapSpec v1 |
|---|---|
| `layers[0].type: 'scatterplot'` | `layer.type: 'latlon'` |
| `layers[0].type: 'geojson'` \| `'path'` | `layer.type: 'geojson'` |
| `layers[0].type: 'h3'` | `layer.type: 'h3'` |
| `lng` / `lat` | `layer.encoding.lonColumn` / `latColumn` |
| `geojsonColumn` | `layer.encoding.geoColumn` |
| `hexColumn` | `layer.encoding.h3Column` |
| categorical `fillColor.column` | `layer.encoding.colorColumn` + `colorScheme` |
| `data.query` (executed client-side) | `data.values` (rows inlined in the spec) |
| `layers[1..3]` | no equivalent - MapSpec v1 is single-layer |
| `tooltip`, `legend`, `toggles`, `clickEmits` | no equivalent |

`arc` has no MapSpec v1 equivalent either. Anything below the line is lost in
translation, which is the reason this DSL exists rather than adopting MapSpec v1
wholesale.
