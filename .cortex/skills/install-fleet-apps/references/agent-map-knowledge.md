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

## 4. Authoring a map (render_view)

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
