#!/usr/bin/env python3
"""One-shot editor for agent-spec.json: add render_map guidance.

Kept as a script (not hand-editing 300-char JSON strings) because the
orchestration value is one enormous single-line string and a hand edit there is
how a quoted brace or a stray newline silently breaks the whole spec. Round-trip
is asserted identical before and after, so the file's formatting cannot drift.
"""
import json
import sys
from pathlib import Path

SPEC = Path(__file__).resolve().parent.parent / "fleet_sa_app" / "app" / "agent-spec.json"

# --- orchestration: the new inline-map block, inserted before the CoWork one ---
OLD_MAP_HEAD = (
    "DRAWING A MAP (data_to_map, when available):\n"
    "- data_to_map is NOT always present. It is injected by the host, so it exists in "
    "Snowflake CoWork and does NOT exist inside the SA app."
)

# The block header line, used as the insertion anchor by the SURFACE pass below.
MAP_BLOCK_HEADER = "DRAWING A MAP INLINE (render_map - THE SA APP PATH):"

# --- the surface discriminator ---------------------------------------------------
# The defect this fixes: asked for "dwell density in the SF" in CoWork, the agent
# called render_map THREE times, each returned OUTCOME='ok' (the verb only echoes
# the spec back - it touches no data and cannot see its caller), and no map ever
# appeared, because CoWork has no renderer for an MCP render_map result. The agent
# then wrote confident prose about a picture nobody could see. Measured on
# tib85385: three render_map rows at 02:40:06, 02:41:26 and 02:41:58, all 'ok'.
# It reached data_to_map only when the user NAMED the tool, which made it
# enumerate its own inventory and find it.
#
# The agent has exactly ONE runtime-observable signal for which surface it is on:
# its own tool list. render_map sits on ROUTING_MCP with no per-surface allowlist
# and cowork_binding.sql adds FLEET_AGENT to the CoWork object, so render_map is in
# the inventory in BOTH surfaces; data_to_map is host-injected and appears in CoWork
# only. Presence of data_to_map is therefore the discriminator, and it is stated as
# the FIRST bullet because everything after it reads as encouragement to call
# render_map.
#
# The CONSEQUENCE has to be spelled out ("returns ok and NO MAP APPEARS"). Naming
# both tools is not enough: the previous text named both and the agent still chose
# the championed path.
SURFACE_MARKER = "SURFACE FIRST: LOOK AT YOUR OWN TOOL LIST"
SURFACE_BULLET = (
    "- SURFACE FIRST: LOOK AT YOUR OWN TOOL LIST. If data_to_map is present you are in CoWork - "
    "draw with data_to_map (see the CoWork block below) and do NOT call render_map: CoWork has no "
    "renderer for a render_map result, so the call returns ok, you will believe it worked, and NO "
    "MAP APPEARS. If data_to_map is absent you are in the SA app and render_map is the path. Your "
    "tool list is the ONLY signal for this - never infer the surface from the question, the region "
    "or the phrasing.\n"
)

# --- the CoWork block, v2 -> v3 --------------------------------------------------
# v2 hedged ("when available", "is NOT always present") while the render_map block
# above it was titled THE SA APP PATH and closed with "Do not let it talk you out
# of calling render_map". One championed path plus one conditional path, with no
# stated way to tell the surfaces apart, is why the agent picked render_map.
#
# The header must keep its trailing colon: check_map_guidance.py's BLOCK_END_RE
# finds the end of the render_map block by matching a non-bullet line ending in ':'.
OLD_COWORK = (
    "DRAWING A MAP IN COWORK (data_to_map, when available):\n"
    "- data_to_map is NOT always present. It is injected by the host, so it exists in "
    "Snowflake CoWork and does NOT exist inside the SA app (where render_map above is the path). "
    "Never claim you drew a map unless you actually called it and it succeeded; if it is absent, "
    "fall through to VISUAL HANDOVER below."
)
NEW_COWORK_HEADER = "DRAWING A MAP IN COWORK (data_to_map - THE COWORK PATH):"
NEW_COWORK = (
    "DRAWING A MAP IN COWORK (data_to_map - THE COWORK PATH):\n"
    "- If data_to_map is in your tool list you are in CoWork, and data_to_map is THE way to draw a "
    "map here: use it, and do NOT call render_map - CoWork cannot render a render_map result, so "
    "that call returns ok and NO MAP APPEARS. data_to_map is injected by the host, so it does NOT "
    "exist inside the SA app (where render_map above is the path). Never claim you drew a map "
    "unless you called data_to_map and it succeeded - a successful render_map call is NOT evidence "
    "that a map appeared; if data_to_map is absent, fall through to VISUAL HANDOVER below."
)

NEW_MAP_HEAD = (
    "DRAWING A MAP INLINE (render_map - THE SA APP PATH):\n"
    + SURFACE_BULLET +
    "- When the user asks you to map/plot/show something on a map and no saved view already "
    "answers it, call render_map with spec_json. The map is drawn INLINE in your answer, next "
    "to the prose that explains it. This works inside the SA app and does NOT depend on "
    "data_to_map.\n"
    "- Choose between the three visual paths deliberately: an existing saved view via a "
    "[label](view:id) link when one matches (always prefer this); render_map for an ad-hoc map; "
    "render_view when the map needs surrounding KPIs and tables on a page; deep_link when the "
    "user needs toggles, click-through to a record, or a replayed time window - a render_map "
    "map is a static picture, not a workspace.\n"
    "- SPEC CONTRACT (spec_json is a JSON object STRING): {title?, height?, layers:[...], "
    "legend?:[{label,color,shape?}], emptyMessage?}. 1 to 4 layers. Each layer is "
    "{type, data:{query, params?}, ...encoding}. type is one of scatterplot, path, h3, geojson, arc.\n"
    "- Layer queries MUST read the neutral FLEET_APP contract - never SYNTHETIC_DATASETS, "
    "OPENROUTESERVICE_APP or FLEET_INTELLIGENCE. Use "
    "TABLE(FLEET_APP.CORE.F_FACT_*_SCOPED(CAST(:region AS VARCHAR), CAST(:dataset_id AS VARCHAR))) "
    "or FLEET_APP.<DWELL|CATCHMENT|ROUTE_OPTIMIZATION|ROUTE_DEVIATION|LOCATION>.VW_*, and always "
    "pass :region and :dataset_id on a contract function.\n"
    "- params may bind ONLY context.* (region, vehicle_type, dataset_id, date_range_start, "
    "date_range_end) or a literal. A viewState.* param is rejected: an inline map has no view "
    "state, so it would bind NULL and return zero rows.\n"
    "- Encodings per type: scatterplot needs lng + lat; path needs geojsonColumn (or start/end "
    "lng/lat); h3 needs hexColumn (+ valueColumn to shade); geojson needs geojsonColumn; arc "
    "needs source {lng,lat} + target {lng,lat}. Add a tooltip template using {COLUMN} tokens.\n"
    "- Pick the layer type for the QUESTION, not the data shape: positions -> scatterplot, "
    "density over an area -> h3, origin/destination pairs -> arc, movement along a route -> path, "
    "a value per boundary -> geojson. Encode on more than one channel where you can, and never "
    "use a rainbow palette.\n"
    "- GEOMETRY SIZING IS THE MAIN FAILURE MODE: project lines and polygons as "
    "ST_ASGEOJSON(ST_SIMPLIFY(<geog>, 250))::STRING and filter to a region or a band FIRST. An "
    "oversized payload renders a BLANK map with no error. Rows are capped per layer and the cap "
    "is shown on screen, so say you filtered rather than implying the map is the whole set.\n"
    "- LIVE ROUTING GEOMETRY IS MAPPABLE HERE: a layer query may call the routing contract "
    "(ROUTING_PLATFORM.CONTRACT.DIRECTIONS / ISOCHRONES / OPTIMIZATION return a GEOJSON GEOGRAPHY "
    "column), so a drive-time ring or a solved tour can be drawn inline by projecting "
    "ST_ASGEOJSON(GEOJSON)::STRING in the layer's SELECT. The four contract traps still apply "
    "(profile alone as METHOD, ::FLOAT casts, NULL::VARCHAR provider, scalar-subquery challenge).\n"
    "- One layer per idea. If you need more than 4, UNION into one layer with a category column "
    "and colour by it, and say that is what you did.\n"
    "- THE HOST'S CHART GUIDANCE DOES NOT FORBID YOUR MAPS. A chart skill is injected into your "
    "turn because this agent declares data_to_chart, and it says maps must not be created because "
    "map JSON is blocked and will not render. That statement is about data_to_chart, which renders "
    "Vega-Lite and genuinely cannot draw a map. It is NOT about render_map, which is a different "
    "tool with its own renderer. Do not let it talk you out of calling render_map.\n"
    "- NEVER SUBSTITUTE A CATEGORICAL CHART FOR A SPATIAL QUESTION. When the user asks WHERE "
    "something happens - density, heatmap, hotspots, congestion, a route, a catchment, 'on a map' - "
    "a bar chart of a breakdown by facility type, city or category answers a DIFFERENT question. "
    "Call render_map. If you also show a breakdown chart, say explicitly that it is a supporting "
    "view and not the spatial answer.\n"
    + NEW_COWORK
)

# --- response: the "MAPS OUTSIDE THE APP" claim is now surface-specific ---
OLD_RESPONSE = (
    "MAPS OUTSIDE THE APP: you cannot render a map when there is no panel context. "
    "For a question that is really about a map, a route, a catchment or a heatmap, give the "
    "figures you can retrieve and then use deep_link to hand over a URL that opens the actual "
    "view with the region and selection already applied."
)
# The middle clause below used to read "CoWork's data_to_map is host-injected and
# unavailable to you", which is FALSE and was the second half of the three-failed-
# attempts defect. The same spec's orchestration carries a full data_to_map layer
# contract, and the fourth turn of that session drew a map with it. instructions.
# response is what governs how the answer is composed, so it was telling the agent
# the working path did not exist while the orchestration told it how to use it.
RESPONSE_FALSE_CLAUSE = (
    "Outside the app, when there is no panel context, you cannot: CoWork's data_to_map is "
    "host-injected and unavailable to you, so for a question that is really about a map, a route, "
    "a catchment or a heatmap, give the figures you can retrieve and then use deep_link to hand "
    "over a URL that opens the actual view with the region and selection already applied."
)
RESPONSE_TRUE_CLAUSE = (
    "In CoWork - which you can tell because data_to_map is in your tool list - draw with "
    "data_to_map instead, and do not call render_map there: CoWork cannot render its result, so "
    "the call succeeds and no map appears. When NEITHER is available, or the geometry has no "
    "SQL/analyst source to pass to data_to_map, give the figures you can retrieve and then use "
    "deep_link to hand over a URL that opens the actual view with the region and selection "
    "already applied."
)
NEW_RESPONSE = (
    "MAPS: inside the SA app you CAN draw a map - call render_map with a layer spec and it is "
    "rendered inline in your answer (see the render_map block in the routing instructions). "
    + RESPONSE_TRUE_CLAUSE
)

# --- orchestration, second pass -------------------------------------------------
# Applied SEPARATELY from NEW_MAP_HEAD so a spec that was already patched by an
# earlier run of this script still receives it. The two bullets below are also
# present inside NEW_MAP_HEAD, which covers the fresh-apply path; this pass covers
# the already-patched path. Both are guarded, so neither can double-apply.
#
# These exist because the FIRST version of the render_map guidance lost the
# argument. A chart skill is injected into every turn (because the spec declares
# data_to_chart) stating that maps must not be created, and the agent obeyed that
# over a paragraph in its system prompt: asked for "dwell density in the US" it
# emitted two facility-type bar charts and a deep link, never calling render_map.
EXTRA_ANCHOR = (
    "- One layer per idea. If you need more than 4, UNION into one layer with a category column "
    "and colour by it, and say that is what you did.\n"
)
EXTRA_BULLETS = (
    "- THE HOST'S CHART GUIDANCE DOES NOT FORBID YOUR MAPS. A chart skill is injected into your "
    "turn because this agent declares data_to_chart, and it says maps must not be created because "
    "map JSON is blocked and will not render. That statement is about data_to_chart, which renders "
    "Vega-Lite and genuinely cannot draw a map. It is NOT about render_map, which is a different "
    "tool with its own renderer. Do not let it talk you out of calling render_map.\n"
    "- NEVER SUBSTITUTE A CATEGORICAL CHART FOR A SPATIAL QUESTION. When the user asks WHERE "
    "something happens - density, heatmap, hotspots, congestion, a route, a catchment, 'on a map' - "
    "a bar chart of a breakdown by facility type, city or category answers a DIFFERENT question. "
    "Call render_map. If you also show a breakdown chart, say explicitly that it is a supporting "
    "view and not the spatial answer.\n"
)
EXTRA_MARKER = "THE HOST'S CHART GUIDANCE DOES NOT FORBID YOUR MAPS"

# --- orchestration, sixth pass: H3 resolution is a parameter --------------------
# The r7 map drew fine and "use resolution 9" then failed for 4 minutes. The h3
# bullet named the two pre-binned columns and nothing else, so the agent read the
# resolution as a fixed property of the data, went hunting for a way to convert
# cells, invented three Snowflake functions that do not exist
# (H3_CELL_TO_BOUNDARY_WKT, H3_CELL_TO_GEOGRAPHY, H3_CELL_TO_CHILDREN), fell back
# to run_sql, and then could not map the result because data_to_map rejects an MCP
# result. Every semantic view that carries an H3 cell now also documents its own
# resolution rule, so this bullet only has to say the rule EXISTS and that the two
# views differ - the detail belongs next to the columns, not here.
H3_RES_MARKER = "H3 RESOLUTION IS A PARAMETER"
H3_RES_ANCHOR = (
    "* h3 -> an H3 cell STRING. Available as cell_h3 (query_location, household "
    "density) and h3_cell (query_dwell, congestion)."
)
H3_RES_BULLET = (
    "* h3 -> an H3 cell STRING. Available as cell_h3 (query_location, household "
    "density) and h3_cell (query_dwell, congestion). H3 RESOLUTION IS A PARAMETER, "
    "not a fixed property of the data: each of those views states its own stored "
    "resolution and how to change it, so read its instructions before answering "
    "\"use resolution N\". query_dwell can re-bin to ANY resolution from its "
    "dwell_lat/dwell_lon pair; query_location is COARSEN-ONLY, and dividing a "
    "cell's measure among child cells to fake a finer map is fabrication, not an "
    "answer - refuse it and say what the stored grain is."
)


# --- seventh pass: routing verbs return a drawable row set -----------------------
# Every routing verb now returns top-level `rows` beside `result` on success (see
# fleet_tools/user/src/map_rows.ts), which is exactly the row-set shape CoWork's
# data_to_map draws. The spec still said an MCP result can never be mapped and told
# the agent to deep_link, so a successful route produced no map in CoWork.
ROUTING_ROWS_MARKER = "DRAWING A ROUTING RESULT IN COWORK"
ROUTING_ROWS_VERBS = (
    "get_directions, compute_isochrone, map_match, snap_to_road, optimize_routes, "
    "delivery_optimization, network_optimization, catchment, find_poi, evac_seed, evac_solve, "
    "vrp_solve, query_overture_places, query_overture_addresses"
)
ROUTING_ROWS_ORCH = [
    (
        "- Source constraint: data_to_map accepts ONLY a SQL/analyst tool result as tool_result_id. "
        "An MCP tool result (run_sql, get_directions, or any synapse verb) is NOT accepted and will "
        "silently fail. Sequence: retrieve geometry with a query_* Cortex Analyst tool, then pass THAT "
        "step's tool_use_id to data_to_map. For live routing geometry that no semantic view projects, "
        "report the figures (distance, duration) and use deep_link to hand over to the app view. Cite "
        "the map result with a map tag, never a chart tag.",
        "- Source constraint: data_to_map accepts ONLY two sources as tool_result_id: (a) a query_* "
        "Cortex Analyst result, and (b) a routing verb result that carries a top-level rows array ("
        + ROUTING_ROWS_VERBS
        + "). A backload_solve or backload_chain_solve result, or a routing verb result with no rows, "
        "is NOT a map source and will silently fail. Cite the map result with a map tag, never a "
        "chart tag.\n"
        "- DRAWING A ROUTING RESULT IN COWORK: after one of those routing verbs returns status SUCCESS "
        "and its payload has rows, call data_to_map ONCE with THAT call's tool_use_id. Rows with "
        "GEOJSON -> layer_type \"geojson\", geo_column \"GEOJSON\". Rows with LAT and LON -> layer_type "
        "\"latlon\", lat_column \"LAT\", lon_column \"LON\". Do NOT call render_map for that geometry "
        "(CoWork cannot draw a render_map result), and do NOT deep_link instead of drawing it. rows "
        "holds only the primary geometry (the route lines, or the polygon of a catchment or isochrone; "
        "never the POIs beside it), simplified for the map; quote figures from result. A FAILED result "
        "has no rows: report the refusal and do not draw. If data_to_map returns unmappable_rows, say "
        "the geometry was too large to draw and still report the figures (distance, duration, area, "
        "unsnapped count). If data_to_map is absent you are in the SA app: the routing verb's geometry "
        "is drawn inline from result, so do not call render_map for the same geometry.",
    ),
    (
        "Geometry computed LIVE by the routing engine (DIRECTIONS/ISOCHRONES/OPTIMIZATION) is still "
        "not mappable: it can only be fetched through run_sql, and an MCP result is rejected as a map "
        "source - report the figures and deep_link instead.",
        "Geometry computed LIVE by the routing engine is drawn from the routing verb's own rows (see "
        "DRAWING A ROUTING RESULT IN COWORK), not from a column here.",
    ),
    (
        "Source constraint, the same one data_to_map has: data_to_chart accepts",
        "Source constraint (data_to_chart only): data_to_chart accepts",
    ),
]
ROUTING_ROWS_RESP = (
    "When NEITHER is available, or the geometry has no SQL/analyst source to pass to data_to_map,",
    "After a routing verb succeeds with rows, pass that call's tool_use_id to data_to_map. When "
    "NEITHER is available, or the geometry has no source data_to_map accepts (a query_* result, or "
    "a routing verb result carrying rows),",
)


def apply_routing_rows(spec: dict) -> bool:
    """Seventh pass. Returns True when it changed the spec; raises on a half-applied spec."""
    ins = spec["instructions"]
    if ROUTING_ROWS_MARKER in ins["orchestration"]:
        return False
    o = ins["orchestration"]
    for old, new in ROUTING_ROWS_ORCH:
        if o.count(old) != 1:
            raise SystemExit(f"ERROR: routing-rows anchor not found once: {old[:60]!r}")
        o = o.replace(old, new, 1)
    old, new = ROUTING_ROWS_RESP
    if ins["response"].count(old) != 1:
        raise SystemExit("ERROR: routing-rows response anchor not found")
    ins["orchestration"] = o
    ins["response"] = ins["response"].replace(old, new, 1)
    return True


# --- eighth pass: routing results are drawn THROUGH query_routing_results ------
# The seventh pass told the agent to hand the routing verb's own tool_use_id to
# data_to_map. In a real CoWork session that failed: get_directions returned ok,
# data_to_map could not resolve the result, the agent fell back to run_sql (also
# an MCP verb, same failure) and then to deep_link. The managed MCP server
# delivers every verb as {"json":{"result":"<whole document as a STRING>"}}, so
# the top-level `rows` data_to_map needs is never at the top level. The verbs now
# persist their rows and return a result_id; SV_ROUTING_RESULTS serves them back
# as a Cortex Analyst result, which data_to_map does draw.
QUERY_ROUTING_RESULTS_TOOL = "query_routing_results"
QUERY_ROUTING_RESULTS_DESCRIPTION = (
    "Map geometry of a routing result the user just computed, by the result_id a routing verb "
    "returned (get_directions, compute_isochrone, optimize_routes, find_poi, catchment, snap_to_road "
    "and the other routing verbs), or by the result_id run_sql returned for a drawable result "
    "(an H3 density, points or shapes). Use it ONLY to draw that result in CoWork: ask for the "
    "geometry of that exact result_id, then pass THIS call's tool_use_id to data_to_map. It "
    "stores no distance or duration; quote those from the routing verb result."
)
ANALYST_SOURCE_MARKER = "a query_routing_results result for the result_id"
ANALYST_SOURCE_ORCH = [
    (
        "(b) a routing verb result that carries a top-level rows array (",
        "(b) a query_routing_results result for the result_id returned by one of the routing verbs (",
    ),
    (
        "). A backload_solve or backload_chain_solve result, or a routing verb result with no rows, "
        "is NOT a map source and will silently fail.",
        "). The routing verb's OWN result is NOT a source, and neither is run_sql or any other MCP "
        "result: the MCP server hands it over as one JSON string, so data_to_map cannot resolve it "
        "and NO MAP APPEARS. A backload_solve or backload_chain_solve result, or a routing verb "
        "result with no result_id, has nothing to draw.",
    ),
    (
        "returns status SUCCESS and its payload has rows, call data_to_map ONCE with THAT call's "
        "tool_use_id. Rows with GEOJSON",
        "returns status SUCCESS with a result_id, call query_routing_results for the geometry of "
        "that exact result_id, then call data_to_map ONCE with the query_routing_results call's "
        "tool_use_id - never the routing verb's own tool_use_id. Rows with GEOJSON",
    ),
    (
        "A FAILED result has no rows: report the refusal and do not draw.",
        "A FAILED result has no result_id: report the refusal and do not draw. If "
        "query_routing_results returns no rows, report the figures and deep_link.",
    ),
    (
        "is drawn from the routing verb's own rows (see DRAWING A ROUTING RESULT IN COWORK)",
        "is drawn through query_routing_results (see DRAWING A ROUTING RESULT IN COWORK)",
    ),
]
ANALYST_SOURCE_RESP = (
    "After a routing verb succeeds with rows, pass that call's tool_use_id to data_to_map. When "
    "NEITHER is available, or the geometry has no source data_to_map accepts (a query_* result, or "
    "a routing verb result carrying rows),",
    "After a routing verb succeeds with a result_id, fetch its geometry with query_routing_results "
    "and pass THAT call's tool_use_id to data_to_map. When NEITHER is available, or the geometry has "
    "no source data_to_map accepts (a query_* result, including query_routing_results),",
)


def apply_analyst_source(spec: dict) -> bool:
    """Eighth pass. Returns True when it changed the spec; raises on a half-applied spec."""
    changed = False
    tools = spec.setdefault("tools", [])
    entry = {
        "tool_spec": {
            "type": "cortex_analyst_text_to_sql",
            "name": QUERY_ROUTING_RESULTS_TOOL,
            "description": QUERY_ROUTING_RESULTS_DESCRIPTION,
        }
    }
    hit = [i for i, t in enumerate(tools) if t.get("tool_spec", {}).get("name") == QUERY_ROUTING_RESULTS_TOOL]
    if not hit:
        tools.append(entry)
        changed = True
    elif tools[hit[0]] != entry:
        tools[hit[0]] = entry
        changed = True
    res = {
        "semantic_view": "FLEET_INTELLIGENCE.SEMANTIC.SV_ROUTING_RESULTS",
        "execution_environment": {"type": "warehouse", "warehouse": "ROUTING_ANALYTICS"},
    }
    if spec.setdefault("tool_resources", {}).get(QUERY_ROUTING_RESULTS_TOOL) != res:
        spec["tool_resources"][QUERY_ROUTING_RESULTS_TOOL] = res
        changed = True

    ins = spec["instructions"]
    if ANALYST_SOURCE_MARKER in ins["orchestration"]:
        return changed
    o = ins["orchestration"]
    for old, new in ANALYST_SOURCE_ORCH:
        if o.count(old) != 1:
            raise SystemExit(f"ERROR: analyst-source anchor not found once: {old[:60]!r}")
        o = o.replace(old, new, 1)
    old, new = ANALYST_SOURCE_RESP
    if ins["response"].count(old) != 1:
        raise SystemExit("ERROR: analyst-source response anchor not found")
    ins["orchestration"] = o
    ins["response"] = ins["response"].replace(old, new, 1)
    return True


# --- ninth pass: run_sql results are drawable too --------------------------------
# Observed in CoWork: "restaurant density within 15 min of the Eiffel Tower at H3
# res 8". run_sql computed the exact answer (ST_WITHIN the isochrone, 118 cells),
# but run_sql persisted nothing, so the agent drew a BOUNDING-BOX approximation
# through a semantic view instead (169 cells, 51 outside the isochrone) and told
# the user a "governance wall" blocked the right query. run_sql now persists
# drawable rows (H3 cell string, LAT+LON or GEOJSON, plus VALUE/LABEL) and returns
# a result_id that query_routing_results serves back.
RUN_SQL_MAP_MARKER = "MAPPING A run_sql RESULT"
RUN_SQL_MAP_EDITS = [
    (
        "query_overture_places, query_overture_addresses). The routing verb's OWN result is NOT a "
        "source, and neither is run_sql or any other MCP result:",
        "query_overture_places, query_overture_addresses), or by run_sql when it returns a "
        "result_id. The routing verb's OWN result is NOT a source, and neither is run_sql's own "
        "result or any other MCP result:",
    ),
    (
        "has nothing to draw.",
        "has nothing to draw. MAPPING A run_sql RESULT (e.g. an H3 density inside an isochrone): "
        "select an H3 cell STRING column (H3_POINT_TO_CELL_STRING(geom, res)), or LAT+LON, or a "
        "GEOJSON column, plus one numeric value column; then draw the result_id it returns through "
        "query_routing_results. NEVER swap a computed result for an approximation (a bounding box, "
        "a coarser or different query) just to get a map; if run_sql returns no result_id, show "
        "the numbers and say the result could not be drawn.",
    ),
]


def apply_run_sql_map(spec: dict) -> bool:
    """Ninth pass. Returns True when it changed the spec; raises on a half-applied spec."""
    ins = spec["instructions"]
    o = ins["orchestration"]
    if RUN_SQL_MAP_MARKER in o:
        return False
    for old, new in RUN_SQL_MAP_EDITS:
        if o.count(old) != 1:
            raise SystemExit(f"ERROR: run_sql-map anchor not found once: {old[:60]!r}")
        o = o.replace(old, new, 1)
    ins["orchestration"] = o
    return True


def main() -> int:
    src = SPEC.read_text()
    spec = json.loads(src)
    assert json.dumps(spec, indent=2, ensure_ascii=False) + "\n" == src, (
        "agent-spec.json is not in canonical 2-space JSON form; refusing to rewrite it"
    )

    orch = spec["instructions"]["orchestration"]
    resp = spec["instructions"]["response"]

    changed = []
    if NEW_MAP_HEAD.split("\n", 1)[0] in orch:
        print("orchestration: render_map block already present")
    elif OLD_MAP_HEAD in orch:
        spec["instructions"]["orchestration"] = orch.replace(OLD_MAP_HEAD, NEW_MAP_HEAD, 1)
        changed.append("orchestration")
    else:
        print("ERROR: orchestration anchor not found", file=sys.stderr)
        return 1

    # Second pass: the host-chart-skill counter and the no-substitution rule.
    orch = spec["instructions"]["orchestration"]
    if EXTRA_MARKER in orch:
        print("orchestration: host-chart-skill counter already present")
    elif EXTRA_ANCHOR in orch:
        spec["instructions"]["orchestration"] = orch.replace(
            EXTRA_ANCHOR, EXTRA_ANCHOR + EXTRA_BULLETS, 1
        )
        changed.append("orchestration(host-chart counter)")
    else:
        print("ERROR: extra-guidance anchor not found", file=sys.stderr)
        return 1

    if NEW_RESPONSE[:40] in resp:
        print("response: map guidance already updated")
    elif OLD_RESPONSE in resp:
        spec["instructions"]["response"] = resp.replace(OLD_RESPONSE, NEW_RESPONSE, 1)
        changed.append("response")
    else:
        print("ERROR: response anchor not found", file=sys.stderr)
        return 1

    # --- Third pass: the surface discriminator ---------------------------------
    # Separate from NEW_MAP_HEAD for the reason the second pass is separate: the
    # committed spec is long past its first apply, and the first pass short-circuits
    # on the block header, so anything added inside NEW_MAP_HEAD alone would only
    # ever reach a spec that does not exist any more. Note the guard on the FOURTH
    # pass cannot be NEW_RESPONSE[:40] either - that prefix is unchanged by this
    # release, so it reports "already updated" on a spec still carrying the false
    # clause.
    orch = spec["instructions"]["orchestration"]
    if SURFACE_MARKER in orch:
        print("orchestration: surface discriminator already present")
    elif MAP_BLOCK_HEADER + "\n" in orch:
        spec["instructions"]["orchestration"] = orch.replace(
            MAP_BLOCK_HEADER + "\n", MAP_BLOCK_HEADER + "\n" + SURFACE_BULLET, 1
        )
        changed.append("orchestration(surface discriminator)")
    else:
        print("ERROR: map block header anchor not found", file=sys.stderr)
        return 1

    # --- Fourth pass: the CoWork block stops hedging ---------------------------
    orch = spec["instructions"]["orchestration"]
    if NEW_COWORK_HEADER in orch:
        print("orchestration: CoWork map path already updated")
    elif OLD_COWORK in orch:
        spec["instructions"]["orchestration"] = orch.replace(OLD_COWORK, NEW_COWORK, 1)
        changed.append("orchestration(CoWork path)")
    else:
        print("ERROR: CoWork map block anchor not found", file=sys.stderr)
        return 1

    # --- Fifth pass: delete the false "unavailable to you" claim ---------------
    resp = spec["instructions"]["response"]
    if RESPONSE_TRUE_CLAUSE[:40] in resp:
        print("response: data_to_map availability already corrected")
    elif RESPONSE_FALSE_CLAUSE in resp:
        spec["instructions"]["response"] = resp.replace(
            RESPONSE_FALSE_CLAUSE, RESPONSE_TRUE_CLAUSE, 1
        )
        changed.append("response(data_to_map availability)")
    else:
        print("ERROR: response data_to_map clause not found", file=sys.stderr)
        return 1

    # --- Sixth pass: H3 resolution is a parameter ------------------------------
    orch = spec["instructions"]["orchestration"]
    if H3_RES_MARKER in orch:
        print("orchestration: H3 resolution rule already present")
    elif H3_RES_ANCHOR in orch:
        spec["instructions"]["orchestration"] = orch.replace(
            H3_RES_ANCHOR, H3_RES_BULLET, 1
        )
        changed.append("orchestration(H3 resolution)")
    else:
        print("ERROR: h3 layer bullet anchor not found", file=sys.stderr)
        return 1

    # --- Seventh pass: routing verbs return a drawable row set -----------------
    if apply_routing_rows(spec):
        changed.append("orchestration+response(routing rows)")
    else:
        print("orchestration: routing-rows rule already present")

    # --- Eighth pass: draw routing results through query_routing_results --------
    if apply_analyst_source(spec):
        changed.append("tools+orchestration+response(query_routing_results)")
    else:
        print("orchestration: query_routing_results rule already present")

    # --- Ninth pass: run_sql results draw through query_routing_results --------
    if apply_run_sql_map(spec):
        changed.append("orchestration(run_sql map rows)")
    else:
        print("orchestration: run_sql map rule already present")

    if not changed:
        return 0
    SPEC.write_text(json.dumps(spec, indent=2, ensure_ascii=False) + "\n")
    print(f"updated: {', '.join(changed)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
