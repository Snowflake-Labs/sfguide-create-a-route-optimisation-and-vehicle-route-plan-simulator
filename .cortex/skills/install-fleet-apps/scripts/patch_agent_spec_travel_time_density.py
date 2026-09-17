#!/usr/bin/env python3
"""One-shot editor for agent-spec.json: answer a travel-time-scoped density
question with ONE map, and stop reaching for a profile the engine does not have.

WHAT WENT WRONG
---------------
Asked "show me density of pois within 45 min ebike travel time around SF airport"
the agent produced TWO maps - a correct 45-minute isochrone (drawn automatically,
because compute_isochrone is a mapTool) and a separate render_map for the H3
density - plus two content-free "No map geometry in this result." stubs. The user
wanted, reasonably, ONE map: hexes clipped to the ring, shaded by POI count.

The existing rule in this block already forbids following a routing tool with
render_map for the SAME geometry. It did not cover this shape, where the two are
DIFFERENT geometry that belongs in one picture: a ring plus a measure inside it.
Nothing said the ring can be a LAYER, so decomposing into two tool calls looked
correct. The verb even advertises the capability ("or to combine several sources
in one picture") without ever naming the case that needs it.

Measured, so the guidance names the real objects:

    WITH iso AS (SELECT GEOJSON AS G FROM TABLE(ROUTING_PLATFORM.CONTRACT.ISOCHRONES(
      'cycling-electric', -122.3790::FLOAT, 37.6213::FLOAT, 45, 'SanFrancisco', NULL::VARCHAR)))
    SELECT H3_POINT_TO_CELL_STRING(p.GEOMETRY, 8) AS h3_cell, COUNT(*) AS poi_count
    FROM FLEET_APP.CATCHMENT.VW_POIS p, iso
    WHERE p.REGION = 'SanFrancisco' AND ST_WITHIN(p.GEOMETRY, iso.G) GROUP BY 1
    -> 88283092bbfffff / 68 ...

THE PROFILE TRAP, found while verifying the above
-------------------------------------------------
The same call with 'cycling-regular' returns NULL geometry and NO error:

    {"error":{"code":3003,"message":"Parameter 'profile' has incorrect value of 'unknown'."}}

sits inside RESPONSE while GEOJSON is NULL, so the layer draws nothing and the
map is blank. Only driving-car, driving-hgv and cycling-electric are loaded, and
"ebike" is exactly the word that invites cycling-regular. The verb's EXPLAIN gate
cannot see this (the statement compiles fine), so it has to be said here.

WHY A SCRIPT
------------
`instructions.orchestration` is one very long single-line JSON string; a hand edit
is how a stray quote silently breaks the spec. Idempotent: safe to re-run.
"""
import json
import sys
from pathlib import Path

SPEC = Path(__file__).resolve().parent.parent / "fleet_sa_app" / "app" / "agent-spec.json"

# Appended to the END of the existing no-duplicate-map bullet, not added as a new
# one. Adjacency is the point: this is the exception that completes that rule, and
# a reader who stops at the first sentence must not come away thinking a ring plus
# a measure has to be two tool calls. A separate bullet also lets a gate pass on a
# neighbour rather than on the rule itself - which has happened three times in this
# repo.
ANCHOR_TAIL = (
    "Call render_map for geometry NO routing tool "
    "returned (a query over the fleet contract), or to combine several sources in one picture.\n"
)

MARKER = "A TRAVEL-TIME-SCOPED MEASURE IS ONE MAP"

ADDITION = (
    " A TRAVEL-TIME-SCOPED MEASURE IS ONE MAP, NOT TWO: for 'POI / dwell / stop density within N "
    "minutes of X', do NOT call compute_isochrone and then render_map - emit ONE render_map with "
    "two layers, (1) a geojson layer projecting ST_ASGEOJSON(GEOJSON)::STRING from "
    "TABLE(ROUTING_PLATFORM.CONTRACT.ISOCHRONES(profile, lon::FLOAT, lat::FLOAT, minutes, :region, "
    "NULL::VARCHAR)) for the ring, and (2) an h3 layer over the FLEET_APP contract joined to that "
    "same ring with ST_WITHIN and shaded by a COUNT - for example H3_POINT_TO_CELL_STRING(GEOMETRY, 8) "
    "over FLEET_APP.CATCHMENT.VW_POIS. That is the picture the user asked for, and it is one tool "
    "call.\n"
)

# Placed on the live-geometry bullet, where a profile literal actually gets typed.
LIVE_ANCHOR = (
    "The four contract traps still apply "
    "(profile alone as METHOD, ::FLOAT casts, NULL::VARCHAR provider, scalar-subquery challenge). "
)

PROFILE_MARKER = "PROFILES LOADED HERE ARE"

PROFILE_ADDITION = (
    "PROFILES LOADED HERE ARE driving-car, driving-hgv and cycling-electric - map bike / ebike / "
    "cycle to cycling-electric and truck / HGV / freight to driving-hgv. Any other profile name "
    "(cycling-regular, foot-walking, ...) returns NULL geometry with the error buried in RESPONSE "
    "and NO exception, so the layer silently draws nothing. "
)


def patch(orch: str, changed: list[str]) -> str:
    if MARKER in orch:
        print("orchestration: one-map density rule already present")
    elif ANCHOR_TAIL in orch:
        # Append INSIDE the bullet: replace its trailing newline with the addition.
        orch = orch.replace(ANCHOR_TAIL, ANCHOR_TAIL.rstrip("\n") + ADDITION, 1)
        changed.append("one-map density rule")
    else:
        print("ERROR: no-duplicate-map bullet tail not found", file=sys.stderr)
        raise SystemExit(1)

    if PROFILE_MARKER in orch:
        print("orchestration: loaded-profile rule already present")
    elif LIVE_ANCHOR in orch:
        orch = orch.replace(LIVE_ANCHOR, LIVE_ANCHOR + PROFILE_ADDITION, 1)
        changed.append("loaded-profile rule")
    else:
        print("ERROR: live-geometry contract-traps sentence not found", file=sys.stderr)
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
