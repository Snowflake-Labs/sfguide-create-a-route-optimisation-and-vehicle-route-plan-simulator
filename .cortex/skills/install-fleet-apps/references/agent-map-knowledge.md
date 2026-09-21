# Agent Map Knowledge

Guidance for the FLEET_SA_APP chat agent on reading the map the user is looking
at, diagnosing a blank map, sanity-checking routing results, and authoring a good
map when it emits a `render_view` spec. These are behavior rules for the agent;
the operational subset is embedded in `agent-spec.json`, and this file is the
fuller source of truth.

## 1. Reading the on-screen map context

When a map view is open, the chat request carries a compact summary of what the
deck.gl map is actually rendering, injected as a `[Map on screen: ...]` block in
the turn context. It reports, per layer: the layer id, its kind (scatterplot /
path / h3 / geojson / arc), the feature count under the current scope, the column
it colors by (if any), and whether the layer is blank or hidden. It also reports
the framed extent (`bbox`), the active selection, and the legend labels.

Rules:

- Ground answers about "what am I looking at" in this summary. Report counts and
  layers from it rather than guessing from the view name.
- Answer only about layers that are actually rendered. Never describe features
  that are not on the map.
- The summary carries counts and labels only, never row-level data. To answer a
  question about specific rows, still call the view's preferred tool / query.

## 2. Blank-map playbook

If the summary marks a layer BLANK (zero rows) or HIDDEN (toggle off), or the
user reports an empty map, diagnose before answering. Likely causes in this app,
in rough order of frequency:

1. An active filter or selection is gating the layer's query. Many layers are
   parametrized by `viewState` selection keys; if nothing is selected (or the
   wrong thing is), the query returns no rows. Check the reported selection.
2. Zero rows for the current scope. The active region / vehicle type / date range
   in the context bar narrows most queries; the layer may simply have no data for
   that scope. Suggest widening the scope or switching dataset.
3. A `visibleWhen` toggle is off, so the layer is intentionally hidden. Tell the
   user which toggle to turn on.
4. An unset selection anchor. Views that anchor on a clicked object (for example
   a live catchment or a single journey) render nothing until the user picks an
   anchor on the map or in a table.

State the specific likely cause and the concrete next action; do not claim the
map shows something it does not.

## 3. Routing-result plausibility

After calling a routing, optimization, isochrone, or matrix tool, sanity-check
the result before presenting it. A tool can return a technically valid but wrong
or empty answer, and a confident wrong number is worse than a flagged one.

- Distances and durations should sit in a plausible band for the region and
  vehicle. A total route distance near zero, or absurdly large, means the call
  went wrong (bad coordinates, wrong profile, or a scope mismatch).
- Isochrone area should grow with the drive-time minutes. If a larger time band
  is not larger in area, the call is suspect.
- Optimization must not silently drop stops. If the number of served jobs is less
  than the number requested, some points were unroutable; a single unroutable
  point can abort the whole solve and return zero rows. Call this out and
  investigate (snap the point, or exclude it) rather than reporting success.
- A zero-row result from a routing tool is a signal to debug, not to report "no
  results" as if it were the answer.

If a result is implausible or empty, investigate and explain, then retry with a
corrected call.

## 4. Live routing geometry from SQL

The routing contract (`ROUTING_PLATFORM.CONTRACT`) exposes table functions that
return `GEOJSON GEOGRAPHY` columns. `run_sql` runs as `FLEET_APP_USER`, which
holds `USAGE` on all contract functions, so the agent can query ORS from SQL:

- `DIRECTIONS(method, locations, region, provider)` - returns TABLE with
  `GEOJSON` (LineString), `DISTANCE` (metres), `DURATION` (seconds).
- `ISOCHRONES(method, lon, lat, range, region, provider)` - returns TABLE with
  `GEOJSON` (Polygon). `RANGE` is minutes on this overload.
- `OPTIMIZATION(challenge, region, provider)` - returns TABLE with `GEOJSON`
  (LineString per vehicle), `VEHICLE`, `DURATION`, `STEPS`. Challenge must be
  a scalar subquery.

Prefer `get_directions` (MCP) for a plain A-to-B answer. Use ORS SQL when the
geometry must be joined, aggregated, or projected as columns.

Four traps apply to all contract calls: METHOD is the profile alone
(`'driving-car'`); numeric coords need `::FLOAT`; provider must be
`NULL::VARCHAR`; a bad call returns NULL geometry silently.

**Mapping constraint, by surface**: `data_to_map` (CoWork only) accepts SQL/analyst
tool results and nothing else, so an MCP result (`run_sql`, `get_directions`) is not a
valid source there - report figures and use `deep_link` for the drawn route.

**Inside the SA app the constraint does not apply.** `render_map` (section 5a) runs its
own layer queries through the dynamic read boundary, and that boundary allows
`ROUTING_PLATFORM` alongside `FLEET_APP` and `SNOWFLAKE`, so a query that calls the
routing contract and projects `ST_ASGEOJSON(GEOJSON)::STRING` puts live drive-time rings
and solved tours on an inline map. The blocker in CoWork is the tool_result_id contract,
not the geometry.

Two things to hold together here, because they were contradictory for a release and the
contradiction shipped:

- The allowlist is enforced in three places and they must agree: `ALLOWED_DYNAMIC_DBS` in
  `api/query/route.ts` (fast pre-filter), the same constant in `fleet_tools/user/src/codes.ts`
  (the verb rejects a bad database in-turn with `INVALID_MAP_SPEC_DB`), and
  `FLEET_APP_DYNAMIC_READER`'s grants in `role_binding.sql` (authoritative - the reader
  physically cannot reach an ungranted database). `scripts/check_dynamic_allowlist.py`
  asserts one set across all three plus this prose. The verb's EXPLAIN gate CANNOT stand in
  for that check: it runs `EXECUTE AS OWNER`, so a refused database raises "does not exist
  or not authorized", which the gate deliberately ignores as unresolvable.
- **Live geometry is for combining, not for a plain A-to-B.** A routing tool draws its own
  map (section 3a), so re-drawing its route with `render_map` yields two maps of one answer.
  Reach for a contract call in a layer when the geometry has to sit beside contract data,
  be joined, or be aggregated.

## 3a. A routing tool result is ALREADY on a map

Every tool in `app-config.json` `tools.mapTools` - `get_directions`, `compute_isochrone`,
`optimize_routes`, `find_poi`, `catchment`, `vrp_solve`, `snap_to_road`, `map_match`, the
Overture place/address searches - is bound by the client's `registerToolMaps` to
`RouteMapInline`, which deep-scans the tool payload for GeoJSON and draws it inline under
the answer. No tool call, spec or instruction is needed for that map to appear.

So do not follow one of those tools with `render_map` for the same geometry. It produces two
maps of a single answer, and when the second one fails the user reads an error next to a
correct map - which is exactly what "show me the route from SFO to Civic Center" did.
Report the figures, say the route is shown on the map above, and stop.

Only the subset in `tools.geometryTools` is treated as geometry-MANDATORY (directions,
isochrone, the solvers). For the rest, a payload with no GeoJSON falls back to showing the
data: `find_poi` grouped by category is a legitimate answer, and it used to render as the
stub "No map geometry in this result." instead of its rows - two content-free notices under
one correct map, in the same answer as the density defect below.

### A travel-time-scoped measure is ONE map, not two

"Density of POIs within 45 min ebike travel time around SF airport" is a ring AND a measure
inside it. That is different geometry, so the rule above does not forbid it - and it still
must not be two tool calls, because the user is asking for one picture. Emit ONE
`render_map`:

1. a `geojson` layer projecting `ST_ASGEOJSON(GEOJSON)::STRING` from
   `TABLE(ROUTING_PLATFORM.CONTRACT.ISOCHRONES(...))` for the ring, and
2. an `h3` layer over the contract data joined to that same ring with `ST_WITHIN`, shaded by
   a `COUNT`.

```sql
WITH iso AS (SELECT GEOJSON AS G FROM TABLE(ROUTING_PLATFORM.CONTRACT.ISOCHRONES(
  'cycling-electric', -122.3790::FLOAT, 37.6213::FLOAT, 45, :region, NULL::VARCHAR)))
SELECT H3_POINT_TO_CELL_STRING(p.GEOMETRY, 8) AS h3_cell, COUNT(*) AS poi_count
FROM FLEET_APP.CATCHMENT.VW_POIS p, iso
WHERE p.REGION = :region AND ST_WITHIN(p.GEOMETRY, iso.G) GROUP BY 1;
-- 88283092bbfffff / 68 ...
```

**Only `driving-car`, `driving-hgv` and `cycling-electric` are loaded.** Map bike / ebike /
cycle to `cycling-electric`. Any other name - `cycling-regular` is the one "ebike" invites -
returns **NULL geometry and no exception**, with the reason buried in `RESPONSE`
(`{"error":{"code":3003,"message":"Parameter 'profile' has incorrect value of 'unknown'."}}`),
so the layer draws nothing. The verb's EXPLAIN gate cannot see this: the statement compiles.

## 5a. Authoring an inline map (render_map, SA app)

`render_map` takes a JSON spec `{title?, height?, layers:[...], legend?, emptyMessage?}`
and draws it inline in the chat answer. Each layer is `{type, data:{query, params?},
...encoding}` over the same `LayerSpec` DSL the authored dashboard maps use, compiled by
the same shared compiler (`@fleet-kit/core/map`), so an agent-authored map inherits the
colour DSL, `{COLUMN}` tooltip templating and geometry decimation.

Rules the verb and the client both enforce, so a violation is a named failure rather
than a blank map:

- **1 to 4 layers.** Each layer is one independent warehouse query. Beyond four, UNION
  into one layer with a category column and colour by it.
- **Layer type** must be one of `scatterplot`, `path`, `h3`, `geojson`, `arc`. An unknown
  type compiles to nothing, which is why it is rejected up front (`UNKNOWN_LAYER_TYPE`).
- **Queries read `FLEET_APP`, `ROUTING_PLATFORM` or `SNOWFLAKE` only**, and run through
  `/api/query` with `dynamic:true`, i.e. as owner's-rights `FLEET_APP_DYNAMIC_READER`
  behind that allowlist. A query naming any other database is refused by the verb with
  `INVALID_MAP_SPEC_DB`, and again at that boundary.
- **Every layer type needs its encoding**: `scatterplot` needs `lng` + `lat`, `h3` needs
  `hexColumn` (plus `valueColumn` to shade), `geojson` needs `geojsonColumn`, `path` needs
  `geojsonColumn` or `start` + `end`, `arc` needs `source` + `target`. A missing one is
  refused with `INVALID_MAP_SPEC_ENCODING`, because the compiler filters its data on that
  column and `undefined` removes every row - a blank basemap at world zoom, with no error.
- **Column names match case-insensitively.** Name the columns your own query projects, in
  whatever case reads best. `/api/query` lowercases every result column, so the spec's
  references are lowercased to match; an UPPERCASE `hexColumn` used to draw nothing at all
  while the legend still showed the correct value domain, which read as broken rendering
  rather than a naming mismatch.
- **A layer that returns rows and draws nothing says so.** The client compares rows fetched
  against features placed and names the layer, its row count and the columns it read. A blank
  map is now a sentence, not a guess - that covers a misspelled column, a column absent from
  the result set, and NULL geometry from a live routing call.
- **Params bind `context.*` or a literal.** `viewState.*` is rejected: a chat message has
  no view state, so the bind would go out as NULL and return zero rows. For the same
  reason `visibleWhen`, `toggles`, `clickEmits` and `focusOn` are rejected - there is
  nothing to toggle or click into.
- **Simplify geometry**: `ST_ASGEOJSON(ST_SIMPLIFY(<geog>, 250))::STRING`, filtered to a
  region or band first. Rows are capped per layer and the cap is displayed as
  "showing N of M features", so a truncated map is visible rather than silently partial.
- **The camera fits once and locks.** A chat message must not re-frame itself when the
  user later changes region on the dashboard beside it.
- **Do not author a legend.** The client derives it from the colours each layer actually
  draws: a layer with a `valueColumn` gets a continuous gradient bar labelled with the real
  min and max of the rows drawn, a layer with a colour palette gets one swatch per entry,
  and a flat-coloured layer gets one swatch. An authored `legend` array is ignored except as
  a source of wording, because an agent cannot know the compiler's default ramp or the
  data's range - a three-bin yellow-to-red key over a blue hex map is the defect this
  replaced. Name a layer with `legendLabel` instead.
- **Tooltips are on.** Picking is forced for you, so give each layer a `tooltip` template of
  `{COLUMN}` tokens (`"<b>{H3_CELL_R7}</b><br/>{DWELL_MINUTES} min"`); tokens resolve
  case-insensitively against the query's output columns. A layer with no template gets one
  synthesized from its columns, which is a fallback and not as good as naming the two or
  three columns that matter.

## 5b. Authoring a page-level map (render_view)

When emitting a `render_view` spec with a `Map` area, choose encodings that make
the insight legible. Available layer types: scatterplot, path, h3, geojson, arc.

- Pick the layer for the question, not the data shape:
  - positions of things -> scatterplot (point)
  - density over an area -> h3 (hex aggregation)
  - origin/destination pairs -> arc
  - movement along a route -> path
  - a value per region/boundary -> geojson choropleth
- Encode with more than one channel when you can: color for the primary category
  or magnitude, radius or line width for a second magnitude. Do not rely on color
  alone when size or width is available.
- Choose the palette by data type: sequential for one-direction magnitude,
  diverging for signed data with a meaningful midpoint, qualitative (up to about
  eight colors) for categories. Never use a rainbow / hue-cycling palette.
- Do not encode the same variable twice (for example a colored fill plus a
  colored outline on the same value). Pick one.
- Keep tooltips to the few columns that matter, and make sure any column bound to
  color or a tooltip actually exists in the query output.
- Frame the map to where the insight reads. Do not leave a world view on a
  city-scale result.
