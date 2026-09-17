#!/usr/bin/env python3
"""Fail when guidance forbids a map without naming the tool that can draw one.

Why this exists
---------------
`render_map` shipped fully working - the verb validated specs, rejected bad ones
with typed codes, and the client drew them - and the agent never called it. Asked
"show me dwell density in the us" it emitted two facility-type bar charts and a
deep link.

Three instructions were stacked against the map, and the two this gate protects
were both PROHIBITIONS WITH NO ALTERNATIVE, sitting in the semantic views'
`chart_customization` blocks:

    - H3 congestion is a MAP, not a chart. Do not plot cell ids on an axis.
    - A path or a route is a MAP (path_geojson), never a chart.

Each correctly refuses the chart and then stops. Combined with a host-injected
chart skill that says maps cannot be created at all, the agent's most salient
local instructions read "do not chart this, and maps do not work" - so it did the
only remaining thing and handed off to a link. Naming the tool is what converts a
dead end into a path.

The third defect was a missing trigger word: the dwell Conventions mapped only
"congestion"/"heatmap" onto `h3_cell`, so the word the user actually typed -
"density" - never produced map-ready data. That is checked too, because the
prettiest map guidance is inert if the analyst never selects the geometry.

This is a gate and not a review note for the same reason as
check_chart_source_constraint.py: the constraint lives in prose inside SQL string
literals that several workstreams edit, deleting a sentence breaks no test, fails
no build, produces no error at runtime - and produces a bar chart where a map
belongs. Nothing else reads these strings.

What it checks
--------------
RULE A  A `chart_customization` block that says something "is a map" (or "is a
        MAP, not a chart") must name `render_map` in the SAME block. Scoped to the
        block, not the file: a mention 400 lines away does not help an agent
        reading one view's instructions.

RULE B  A semantic view exposing a map-ready column (an h3 cell, a `*_geojson`
        string, or a `*_lat`/`*_lon` pair) must name `render_map` somewhere in its
        AI_SQL_GENERATION prose. These columns were projected specifically to be
        mapped; before this gate every one of them was documented as existing for
        CoWork's `data_to_map`, a tool that does not exist inside the app.

RULE C  The dwell view's h3 trigger list must include the spatial words users
        actually type, and must require a measure alongside the cell id. A bare
        `h3_cell` list cannot be shaded, so it is not an answer.

RULE D  the agent specs must carry the sentence that stops a DUPLICATE map, in the
        same block as the instruction to call `render_map`, and it must name a
        routing tool by name. Asked for a route the agent produced TWO maps: the
        automatic one from `get_directions` (every tool in app-config `mapTools` is
        bound to the inline map client-side, with no instruction involved) and a
        second `render_map` that failed. Nothing in the spec said the first map
        exists, so "show me on a map -> call render_map" was the only rule the
        agent had. Like RULE A this is prose in a giant single-line JSON string that
        no test reads: deleting it breaks no build and silently restores the double
        map.

RULE G  The `DRAWING A MAP INLINE` block must state the SURFACE DISCRIMINATOR: that
        the presence of `data_to_map` in the agent's own tool list means CoWork,
        where `render_map` must NOT be called. And it must state the CONSEQUENCE -
        that the call succeeds anyway and no map appears.

        This is the defect the rule exists for. Asked for dwell density in CoWork
        the agent called `render_map` three times, each returning OUTCOME='ok'
        (measured on tib85385: 02:40:06, 02:41:26, 02:41:58), and wrote three
        confident answers about a heatmap that was never drawn. `render_map` only
        echoes the spec back, so it cannot detect its caller and its success is
        unfalsifiable; the agent's tool list is the ONLY signal, because
        `render_map` is in the inventory on both surfaces while `data_to_map` is
        host-injected into CoWork alone.

        Naming both tools is deliberately NOT sufficient. The text this replaced
        named both - it titled `render_map` "THE SA APP PATH" and hedged
        `data_to_map` as "when available" - and the agent still took the
        championed path. So the consequence phrasing is what is asserted.

RULE H  `instructions.response` must not claim `data_to_map` is unavailable. It
        used to read "CoWork's data_to_map is host-injected and unavailable to
        you", contradicted by the same spec's own `data_to_map` layer contract and
        by the turn that drew a map with it. `response` governs how the answer is
        composed, so a false claim there outranks a correct orchestration.

Deliberately NOT checked: that every map-capable view has a chart_customization
block. Several have none and are correct as-is; requiring one would add noise
without preventing this defect.

Run with no arguments. Exits non-zero naming the view and what is missing.
"""

from __future__ import annotations

import json
import pathlib
import re
import sys

APP_DIR = pathlib.Path(__file__).resolve().parent.parent / "fleet_sa_app" / "app"
SV_FILES = ["semantic_views.sql", "semantic_views_emergency.sql"]
AGENT_SPECS = ["agent-spec.json", "super-agent-spec.json"]

# The block that instructs inline maps, and the sentence that must lead it.
MAP_BLOCK_HEAD = "DRAWING A MAP INLINE"
BLOCK_END_RE = re.compile(r"^(?!-)[^\n]*:$")
ALREADY_DRAWN_RE = re.compile(r"already on a map", re.IGNORECASE)
# At least one routing tool must be named, or the rule is abstract enough to ignore.
ROUTING_TOOLS = ["get_directions", "compute_isochrone", "optimize_routes"]

# RULE E. A travel-time-scoped measure ("POI density within 45 min ebike travel
# time of SFO") is a ring AND a measure inside it. RULE D does not cover it: the
# two are DIFFERENT geometry, so "do not redraw the same geometry" reads as
# permission to make two calls - and that is what happened, giving one isochrone
# map plus one H3 map where the user asked for one picture. The fix has to name
# the composition (a contract ISOCHRONES layer + an h3 layer joined with
# ST_WITHIN), because "combine several sources in one picture" was already in the
# prose and was not concrete enough to be acted on.
ONE_MAP_RE = re.compile(r"ONE MAP, NOT TWO", re.IGNORECASE)
ONE_MAP_INGREDIENTS = ["ISOCHRONES", "ST_WITHIN"]

# RULE F. Only driving-car, driving-hgv and cycling-electric are loaded. A live
# ISOCHRONES layer with any other profile returns NULL geometry with the reason
# buried in RESPONSE and NO exception, so the layer silently draws nothing - and
# "ebike" is exactly the word that invites `cycling-regular`. Measured on
# tib85385: 'cycling-regular' -> {"error":{"code":3003,...'profile' has incorrect
# value of 'unknown'}} with GEOJSON NULL. The verb's EXPLAIN gate cannot catch it
# because the statement compiles perfectly.
LOADED_PROFILES = ["driving-car", "driving-hgv", "cycling-electric"]

# RULES G/H. The host-injected CoWork map tool, and the two things the guidance has
# to say about it. COWORK_TOOL must be named in the SAME BULLET as render_map for
# the discriminator to be actionable - the previous text named both tools in the
# same BLOCK and lost the argument anyway.
COWORK_TOOL = "data_to_map"
# The consequence, not just the pairing: a mutation that keeps "use data_to_map in
# CoWork" and drops "the call still returns ok and nothing is drawn" leaves the
# agent with no reason to believe its successful call failed.
CONSEQUENCE_RE = re.compile(
    r"no map appears|nothing is drawn|draws nothing|no map is drawn", re.IGNORECASE
)
# The signal the agent can actually observe. "You are in CoWork" is not a rule if
# nothing says how to tell.
TOOL_LIST_RE = re.compile(r"tool list|your own tools|in your tools", re.IGNORECASE)
# RULE H. Any of these next to data_to_map is the false claim returning.
UNAVAILABLE_RE = re.compile(
    r"data_to_map is[^.]{0,80}?(unavailable|not available|inaccessible)"
    r"|(unavailable|not available|inaccessible) to you[^.]{0,40}?data_to_map",
    re.IGNORECASE,
)

MAP_TOOL = "render_map"

# Map-ready column shapes. A view carrying any of these can be drawn.
MAP_COLUMN_RE = re.compile(
    r"\b(?:[a-z_]+\.)?(?:"
    r"h3_cell[a-z_0-9]*"          # h3_cell, h3_cell_r7, cell_h3 (below)
    r"|cell_h3"
    r"|[a-z_]*_geojson"           # path_geojson, zip_geojson, hazard_geojson, lane_geojson
    r"|[a-z_]*_lat"               # store_lat, pickup_lat, center_lat, participant_lat
    r")\b",
    re.IGNORECASE,
)

# "X is a map, not a chart" / "is a MAP (path_geojson), never a chart".
IS_A_MAP_RE = re.compile(r"\bis\s+a\s+map\b", re.IGNORECASE)

# Spatial words a user types that must reach h3_cell in the dwell view.
REQUIRED_DWELL_TRIGGERS = ["congestion", "heatmap", "density", "hotspot"]


def norm(text: str) -> str:
    """Lowercase and collapse whitespace so a rewrapped sentence still matches."""
    return re.sub(r"\s+", " ", text or "").lower()


def split_semantic_views(sql: str) -> list[tuple[str, str]]:
    """Split a semantic-views SQL file into (view_name, body) pairs.

    Body runs from CREATE OR REPLACE SEMANTIC VIEW to the next one (or EOF), so
    the AI_SQL_GENERATION prose and any chart_customization block belong to
    exactly one view. Attributing a block to the wrong view would make RULE A
    pass on a neighbour's mention, which is the failure this scoping prevents.
    """
    starts = [
        (m.start(), m.group(1))
        for m in re.finditer(
            r"CREATE\s+OR\s+REPLACE\s+SEMANTIC\s+VIEW\s+[\w.]*?([A-Z_0-9]+)\s", sql
        )
    ]
    out: list[tuple[str, str]] = []
    for i, (pos, name) in enumerate(starts):
        end = starts[i + 1][0] if i + 1 < len(starts) else len(sql)
        out.append((name, sql[pos:end]))
    return out


def chart_blocks(body: str) -> list[str]:
    """Every <chart_customization>...</chart_customization> block in a view."""
    return re.findall(
        r"<chart_customization>(.*?)</chart_customization>", body, re.DOTALL
    )


def ai_prose(body: str) -> str:
    """The AI_SQL_GENERATION literal - the prose Cortex Analyst returns to the agent.

    Falls back to the whole body when the marker is absent, which is safe: this is
    only ever used to ask whether `render_map` is mentioned, so a wider window can
    only make the gate more lenient, never produce a false failure.
    """
    m = re.search(r"AI_SQL_GENERATION\s+'(.*)", body, re.DOTALL)
    return m.group(1) if m else body


def main() -> int:
    problems: list[str] = []
    checked_views = 0
    map_capable: list[str] = []
    blocks_checked = 0
    # Vacuity counters. A rule whose scope resolved to nothing passes silently, and
    # that has already happened in this repo: a gate computed its repo root one
    # parent short, inspected zero files, and reported PASSED. Print what each rule
    # actually saw so a zero is visible.
    surface_rules_found = 0
    response_checked = 0

    for fname in SV_FILES:
        path = APP_DIR / fname
        if not path.exists():
            problems.append(f"{fname}: expected semantic-view file is missing")
            continue
        sql = path.read_text()
        views = split_semantic_views(sql)
        if not views:
            problems.append(f"{fname}: no CREATE OR REPLACE SEMANTIC VIEW found")
            continue

        for name, body in views:
            checked_views += 1
            prose = ai_prose(body)

            # --- RULE A: a prohibition must name the tool that can draw it ---
            for block in chart_blocks(body):
                blocks_checked += 1
                for line in block.split("\n"):
                    if IS_A_MAP_RE.search(line) and MAP_TOOL not in norm(block):
                        problems.append(
                            f"{fname} {name}: chart_customization says "
                            f"{line.strip()[:80]!r} but never names {MAP_TOOL} in "
                            f"the same block. A prohibition with no alternative is "
                            f"why the agent deep-linked instead of drawing a map."
                        )
                        break

            # --- RULE B: map-ready columns imply a way to map them ---
            # Search the DIMENSIONS half (the body), since that is where the
            # columns are declared, but require the mention in the PROSE, which is
            # what the agent reads at tool time.
            cols = sorted({m.group(0).split(".")[-1].lower() for m in MAP_COLUMN_RE.finditer(body)})
            if cols:
                map_capable.append(name)
                if MAP_TOOL not in norm(prose):
                    problems.append(
                        f"{fname} {name}: exposes map-ready column(s) "
                        f"{', '.join(cols[:4])} but its AI_SQL_GENERATION prose "
                        f"never names {MAP_TOOL}, so the agent has no way to know "
                        f"the geometry can be drawn in the app."
                    )

            # --- RULE C: the dwell h3 trigger list and its measure requirement ---
            if name == "SV_DWELL_ANALYTICS":
                p = norm(prose)
                missing = [t for t in REQUIRED_DWELL_TRIGGERS if t not in p]
                if missing:
                    problems.append(
                        f"{fname} {name}: h3 trigger list is missing "
                        f"{', '.join(missing)}. The word the user typed was "
                        f"'density'; without it the analyst never selects h3_cell "
                        f"and no map is possible however good the map guidance is."
                    )
                # A cell id alone cannot be shaded. Check EVERY h3_cell mention,
                # not just the first: the first is in the entity description
                # ("congestion (group by h3_cell)"), hundreds of characters from
                # the Conventions line that carries the measure requirement, so
                # anchoring on it alone reported a correct file as failing.
                if not any(
                    re.search(
                        r"measure|total_dwell_minutes|total_sessions",
                        p[max(0, m.start() - 400): m.start() + 400],
                    )
                    for m in re.finditer(r"h3_cell", p)
                ):
                    problems.append(
                        f"{fname} {name}: the h3_cell convention does not require a "
                        f"measure alongside the cell id. A bare h3_cell list cannot "
                        f"be shaded, so it is not a density answer."
                    )

    # --- RULE D: the specs must say a routing tool result is ALREADY drawn ---
    specs_checked = 0
    for sname in AGENT_SPECS:
        spath = APP_DIR / sname
        if not spath.exists():
            problems.append(f"{sname}: expected agent spec is missing")
            continue
        specs_checked += 1
        orch = json.loads(spath.read_text()).get("instructions", {}).get("orchestration", "")
        lines = orch.split("\n")
        start = next(
            (i for i, ln in enumerate(lines) if ln.strip().startswith(MAP_BLOCK_HEAD)), None
        )
        if start is None:
            problems.append(
                f"{sname}: no {MAP_BLOCK_HEAD!r} block in instructions.orchestration, "
                f"so nothing tells the agent how to draw an inline map at all."
            )
            continue
        block_lines = [lines[start]]
        for ln in lines[start + 1:]:
            if BLOCK_END_RE.match(ln.strip()):
                break
            block_lines.append(ln)
        block = "\n".join(block_lines)
        # Scoped to the block on purpose: the same sentence 400 lines away does not
        # reach an agent reading the map instructions, which is RULE A's lesson.
        hit = ALREADY_DRAWN_RE.search(block)
        if not hit:
            problems.append(
                f"{sname}: the {MAP_BLOCK_HEAD!r} block never says a routing tool result "
                f"is already on a map. Without it the agent follows get_directions with "
                f"{MAP_TOOL} and the user gets two maps of one answer."
            )
        else:
            # The tool names must be in the SAME BULLET, not merely somewhere in the
            # block. Block scope false-passed a mutation that reduced the rule to
            # "drawn for you automatically": a neighbouring bullet mentioning
            # get_directions satisfied it from several hundred characters away, which
            # is exactly the adjacency failure this file already learned once.
            bstart = block.rfind("\n-", 0, hit.start()) + 1
            bend = block.find("\n-", hit.end())
            bullet = block[bstart: bend if bend != -1 else len(block)]
            if not any(t in bullet for t in ROUTING_TOOLS):
                problems.append(
                    f"{sname}: the no-duplicate-map rule names no routing tool "
                    f"({', '.join(ROUTING_TOOLS)}) in its own bullet. An abstract "
                    f"'drawn for you automatically' does not tell the agent which tools."
                )

        # --- RULE E: a travel-time-scoped measure is ONE map ---
        # Required in the SAME bullet as the already-drawn rule. As a separate
        # bullet it can be read as an unrelated tip, and the two rules only make
        # sense together: one says do not draw the same geometry twice, the other
        # says different-but-related geometry still belongs in one call.
        one_map = ONE_MAP_RE.search(block)
        if not one_map:
            problems.append(
                f"{sname}: the {MAP_BLOCK_HEAD!r} block never says a travel-time-scoped "
                f"measure is ONE map. Without it the agent calls compute_isochrone and "
                f"then {MAP_TOOL}, and a density-within-N-minutes question draws two maps."
            )
        else:
            estart = block.rfind("\n-", 0, one_map.start()) + 1
            eend = block.find("\n-", one_map.end())
            ebullet = block[estart: eend if eend != -1 else len(block)]
            if hit and not (estart <= hit.start() < (eend if eend != -1 else len(block))):
                problems.append(
                    f"{sname}: the one-map rule is not in the same bullet as the "
                    f"no-duplicate-map rule. Split apart, the agent can honour the first "
                    f"and still make two calls for a ring plus a measure."
                )
            absent = [k for k in ONE_MAP_INGREDIENTS if k not in ebullet]
            if absent:
                problems.append(
                    f"{sname}: the one-map rule does not say HOW to compose it - missing "
                    f"{', '.join(absent)} in its bullet. 'Combine several sources in one "
                    f"picture' was already there and was too abstract to act on."
                )

        # --- RULE F: name the profiles the engine actually has ---
        missing_profiles = [p for p in LOADED_PROFILES if p not in block]
        if missing_profiles:
            problems.append(
                f"{sname}: the {MAP_BLOCK_HEAD!r} block does not name the loaded routing "
                f"profiles (missing {', '.join(missing_profiles)}). A live ISOCHRONES layer "
                f"with an unloaded profile returns NULL geometry and no error, so the map "
                f"is blank and nothing says why."
            )

        # --- RULE G: the surface discriminator ---------------------------------
        # Required in ONE bullet, and required to carry all three parts: the
        # observable signal (my tool list), the verdict (that means CoWork, do not
        # call render_map), and the consequence (it returns ok and draws nothing).
        # Split across bullets each part reads as a separate tip, and the agent
        # that produced this defect had both tool names available to it already.
        surface_bullets = [
            b for b in re.split(r"\n(?=-)", block)
            if COWORK_TOOL in b and MAP_TOOL in b
        ]
        if not surface_bullets:
            # NOTE: no mutation in check_map_guidance_negative.py reaches this
            # branch, because the block's first bullet ("call render_map ... does
            # NOT depend on data_to_map") already names both tools, so deleting the
            # surface bullet trips the completeness check below instead. It is kept
            # as the guard for a block that loses both mentions, and it is UNTESTED.
            problems.append(
                f"{sname}: no bullet in the {MAP_BLOCK_HEAD!r} block names both "
                f"{MAP_TOOL} and {COWORK_TOOL}, so nothing tells the agent which of "
                f"the two to use. {MAP_TOOL} is in its tool list on BOTH surfaces, so "
                f"without this it calls {MAP_TOOL} in CoWork, gets OUTCOME='ok', and "
                f"draws no map."
            )
        else:
            complete = [
                b for b in surface_bullets
                if TOOL_LIST_RE.search(b) and CONSEQUENCE_RE.search(b)
            ]
            if not complete:
                missing = []
                if not any(TOOL_LIST_RE.search(b) for b in surface_bullets):
                    missing.append("the observable signal (the agent's own tool list)")
                if not any(CONSEQUENCE_RE.search(b) for b in surface_bullets):
                    missing.append(
                        f"the consequence (a {MAP_TOOL} call in CoWork succeeds and no "
                        f"map appears)"
                    )
                problems.append(
                    f"{sname}: the surface rule in the {MAP_BLOCK_HEAD!r} block is "
                    f"missing {' and '.join(missing)}. Naming both tools is not enough "
                    f"- the text this replaced named both and the agent still called "
                    f"{MAP_TOOL} three times in CoWork."
                )
            surface_rules_found += 1

        # --- RULE H: response must not deny data_to_map exists -----------------
        resp = json.loads(spath.read_text()).get("instructions", {}).get("response", "")
        bad = UNAVAILABLE_RE.search(resp)
        if bad:
            problems.append(
                f"{sname}: instructions.response claims {bad.group(0).strip()[:70]!r}. "
                f"{COWORK_TOOL} IS available in CoWork - the same spec carries its layer "
                f"contract - and response is what governs how the answer is composed, so "
                f"this outranks the orchestration and stops the agent trying it."
            )
        response_checked += 1

    print("Map guidance gate (a forbidden map must name render_map)\n")
    print(f"  semantic views scanned        {checked_views}")
    print(f"  agent specs scanned           {specs_checked}")
    print(f"  chart_customization blocks    {blocks_checked}")
    print(f"  surface-discriminator bullets {surface_rules_found}")
    print(f"  response sections scanned     {response_checked}")
    print(f"  map-capable views             {len(map_capable)}"
          f"{' (' + ', '.join(map_capable) + ')' if map_capable else ''}")
    print()

    if problems:
        print("FAIL: map guidance is a dead end in " f"{len(problems)} place(s):")
        for p in problems:
            print(f"  - {p}")
        return 1

    if not surface_rules_found or not response_checked:
        print("FAIL: the surface rules inspected nothing - "
              f"{surface_rules_found} discriminator bullet(s), "
              f"{response_checked} response section(s). A rule with an empty scope "
              f"passes without checking anything, which is worse than no rule.")
        return 1

    print(f"PASSED: every map-capable view names {MAP_TOOL}, and no "
          f"chart_customization forbids a map without offering one")
    return 0


if __name__ == "__main__":
    sys.exit(main())
