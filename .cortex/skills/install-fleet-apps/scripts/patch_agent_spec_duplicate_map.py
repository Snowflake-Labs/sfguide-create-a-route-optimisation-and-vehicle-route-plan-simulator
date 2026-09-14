#!/usr/bin/env python3
"""One-shot editor for agent-spec.json: stop the duplicate map, and stop lying
about which databases a map layer may read.

WHAT WENT WRONG
---------------
Asked "show me route from SF airport international terminal to civic center" the
agent produced TWO maps: a correct route, and an empty one carrying "Some layers
could not be drawn / Dynamic query may only reference FLEET_APP, SNOWFLAKE; found
'ROUTING_PLATFORM'". Ground truth for the turn, from the oracle rather than from
the screenshot:

    SELECT TOOLS_USED FROM FLEET_INTELLIGENCE.SEMANTIC_OPS.AGENT_TURN
    WHERE QUESTION ILIKE '%civic center%'
    -> routing_mcp_get_directions, routing_mcp_render_map

Two defects, both of them ours and both in this file:

1. NOTHING TOLD THE AGENT THAT A ROUTING TOOL RESULT IS ALREADY DRAWN.
   `get_directions` is in app-config.json `tools.mapTools`, and the client's
   `registerToolMaps` binds every mapTool to RouteMapInline, which scavenges the
   GeoJSON out of the payload and draws it. So the FIRST map was automatic. The
   agent, told only that "map/plot/show me on a map" means call render_map, then
   called render_map for the same route. A duplicate by construction, not a
   one-off - it would recur for isochrones, POIs and VRP tours identically.

2. THE ORCHESTRATION CONTRADICTED ITSELF, and the agent followed the specific
   half. Two bullets apart it said:

     - "Layer queries MUST read the neutral FLEET_APP contract - never
        SYNTHETIC_DATASETS, OPENROUTESERVICE_APP or FLEET_INTELLIGENCE."
     - "LIVE ROUTING GEOMETRY IS MAPPABLE HERE: a layer query may call the routing
        contract (ROUTING_PLATFORM.CONTRACT.DIRECTIONS / ...)"

   The second was false in BOTH layers that enforce it: ALLOWED_DYNAMIC_DBS in
   api/query/route.ts listed only FLEET_APP and SNOWFLAKE, and
   FLEET_APP_DYNAMIC_READER (the owner of QUERY_DYNAMIC, the authoritative
   boundary) held zero grants on ROUTING_PLATFORM - measured against
   SNOWFLAKE.ACCOUNT_USAGE.GRANTS_TO_ROLES.

The capability has now been enabled rather than the sentence deleted: the
allowlist includes ROUTING_PLATFORM and the reader holds USAGE on
ROUTING_PLATFORM.CONTRACT. This script makes the prose agree with that, and adds
the missing sentence about the automatic map.

WHY A SCRIPT
------------
`instructions.orchestration` is one ~20,000-character single-line JSON string. A
hand edit there is how a stray quote or newline silently breaks the whole spec, so
edits go through a script that round-trips the file and asserts canonical form
before rewriting. Idempotent: safe to re-run.
"""
import json
import sys
from pathlib import Path

SPEC = Path(__file__).resolve().parent.parent / "fleet_sa_app" / "app" / "agent-spec.json"

# --- 1. the missing sentence: a routing tool result is already on a map --------
# Inserted at the TOP of the inline-map block, before the bullet that says to call
# render_map when asked for a map. Order matters: the agent reads the block in
# sequence, and the exception has to arrive before the rule it qualifies.
ANCHOR_MAP_HEAD = "DRAWING A MAP INLINE (render_map - THE SA APP PATH):\n"

DUP_MARKER = "A ROUTING TOOL RESULT IS ALREADY ON A MAP"

DUP_BULLET = (
    "- A ROUTING TOOL RESULT IS ALREADY ON A MAP. get_directions, compute_isochrone, "
    "optimize_routes, find_poi, catchment, vrp_solve, snap_to_road, map_match and the other "
    "routing tools have their geometry drawn inline automatically, under your answer. Do NOT "
    "follow one with render_map for the same geometry - that produces TWO maps of one answer, "
    "and if the second one fails the user reads an error beside a perfectly good map. Say "
    "'shown on the map above' and move on. Call render_map for geometry NO routing tool "
    "returned (a query over the fleet contract), or to combine several sources in one picture.\n"
)

# --- 2. the contradiction: name the real allowlist ----------------------------
OLD_DB_RULE = (
    "- Layer queries MUST read the neutral FLEET_APP contract - never SYNTHETIC_DATASETS, "
    "OPENROUTESERVICE_APP or FLEET_INTELLIGENCE."
)

NEW_DB_RULE = (
    "- Layer queries may read ONLY FLEET_APP, ROUTING_PLATFORM and SNOWFLAKE - never "
    "SYNTHETIC_DATASETS, OPENROUTESERVICE_APP or FLEET_INTELLIGENCE. Normally that means the "
    "neutral FLEET_APP contract; ROUTING_PLATFORM.CONTRACT is there for LIVE geometry (see below). "
    "Any other database is refused by the render_map verb up front with INVALID_MAP_SPEC_DB, and "
    "again at the read boundary."
)

# The live-geometry bullet is TRUE now, but it never said what happens when it is
# not, and it invited exactly the duplicate above for a plain A-to-B route. Point
# it back at get_directions.
OLD_LIVE_RULE = (
    "- LIVE ROUTING GEOMETRY IS MAPPABLE HERE: a layer query may call the routing contract "
    "(ROUTING_PLATFORM.CONTRACT.DIRECTIONS / ISOCHRONES / OPTIMIZATION return a GEOJSON GEOGRAPHY "
    "column), so a drive-time ring or a solved tour can be drawn inline by projecting "
    "ST_ASGEOJSON(GEOJSON)::STRING in the layer's SELECT. The four contract traps still apply "
    "(profile alone as METHOD, ::FLOAT casts, NULL::VARCHAR provider, scalar-subquery challenge)."
)

NEW_LIVE_RULE = (
    "- LIVE ROUTING GEOMETRY IS MAPPABLE HERE: a layer query may call the routing contract "
    "(ROUTING_PLATFORM.CONTRACT.DIRECTIONS / ISOCHRONES / OPTIMIZATION return a GEOJSON GEOGRAPHY "
    "column), so a drive-time ring or a solved tour can be drawn inline by projecting "
    "ST_ASGEOJSON(GEOJSON)::STRING in the layer's SELECT. The four contract traps still apply "
    "(profile alone as METHOD, ::FLOAT casts, NULL::VARCHAR provider, scalar-subquery challenge). "
    "Use this to put live geometry NEXT TO contract data in one picture, or when the geometry must "
    "be joined or aggregated. For a plain route or ring on its own, the routing tool "
    "(get_directions / compute_isochrone) is the answer and it draws its own map - calling both is "
    "the duplicate the first bullet forbids."
)


def patch(orch: str, changed: list[str]) -> str:
    if DUP_MARKER in orch:
        print("orchestration: no-duplicate-map rule already present")
    elif ANCHOR_MAP_HEAD in orch:
        orch = orch.replace(ANCHOR_MAP_HEAD, ANCHOR_MAP_HEAD + DUP_BULLET, 1)
        changed.append("no-duplicate-map rule")
    else:
        print("ERROR: inline-map block header not found", file=sys.stderr)
        raise SystemExit(1)

    if NEW_DB_RULE in orch:
        print("orchestration: allowlist rule already updated")
    elif OLD_DB_RULE in orch:
        orch = orch.replace(OLD_DB_RULE, NEW_DB_RULE, 1)
        changed.append("allowlist rule")
    else:
        print("ERROR: FLEET_APP-only layer rule not found", file=sys.stderr)
        raise SystemExit(1)

    if NEW_LIVE_RULE in orch:
        print("orchestration: live-geometry rule already updated")
    elif OLD_LIVE_RULE in orch:
        orch = orch.replace(OLD_LIVE_RULE, NEW_LIVE_RULE, 1)
        changed.append("live-geometry rule")
    else:
        print("ERROR: live-geometry bullet not found", file=sys.stderr)
        raise SystemExit(1)

    return orch


def main() -> int:
    src = SPEC.read_text()
    spec = json.loads(src)
    assert json.dumps(spec, indent=2, ensure_ascii=False) + "\n" == src, (
        "agent-spec.json is not in canonical 2-space JSON form; refusing to rewrite it"
    )

    changed: list[str] = []
    spec["instructions"]["orchestration"] = patch(spec["instructions"]["orchestration"], changed)

    if not changed:
        return 0
    SPEC.write_text(json.dumps(spec, indent=2, ensure_ascii=False) + "\n")
    print(f"updated: {', '.join(changed)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
