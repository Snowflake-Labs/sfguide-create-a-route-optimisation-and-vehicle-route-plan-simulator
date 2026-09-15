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

NEW_MAP_HEAD = (
    "DRAWING A MAP INLINE (render_map - THE SA APP PATH):\n"
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
    "DRAWING A MAP IN COWORK (data_to_map, when available):\n"
    "- data_to_map is NOT always present. It is injected by the host, so it exists in "
    "Snowflake CoWork and does NOT exist inside the SA app (where render_map above is the path)."
)

# --- response: the "MAPS OUTSIDE THE APP" claim is now surface-specific ---
OLD_RESPONSE = (
    "MAPS OUTSIDE THE APP: you cannot render a map when there is no panel context. "
    "For a question that is really about a map, a route, a catchment or a heatmap, give the "
    "figures you can retrieve and then use deep_link to hand over a URL that opens the actual "
    "view with the region and selection already applied."
)
NEW_RESPONSE = (
    "MAPS: inside the SA app you CAN draw a map - call render_map with a layer spec and it is "
    "rendered inline in your answer (see the render_map block in the routing instructions). "
    "Outside the app, when there is no panel context, you cannot: CoWork's data_to_map is "
    "host-injected and unavailable to you, so for a question that is really about a map, a route, "
    "a catchment or a heatmap, give the figures you can retrieve and then use deep_link to hand "
    "over a URL that opens the actual view with the region and selection already applied."
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

    if not changed:
        return 0
    SPEC.write_text(json.dumps(spec, indent=2, ensure_ascii=False) + "\n")
    print(f"updated: {', '.join(changed)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
