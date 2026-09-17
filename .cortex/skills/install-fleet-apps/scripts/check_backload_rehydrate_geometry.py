#!/usr/bin/env python3
"""Every plan on the Backload map must get its road geometry, however it arrived.

WHY THIS GATE EXISTS
--------------------
The polylines the Backload map draws (ROUTE_GEOJSON, EMPTY_GEOJSON,
EMPTY_RETURN_GEOJSON) are not in the solver response: the solve runs with VROOM
geometry disabled, so a later ORS DIRECTIONS pass is the ONLY producer. That pass
lived inside `solve`, and a plan collected from an agent solve
(`?solve_key=...`, lib/backload-rehydrate.ts) never goes through `solve`. The
result was a plan that rendered its stop markers, its assignment card and its
distances - every number correct - with nothing joining the stops. Nothing threw,
no note said anything was missing, and the honest reading of the screen was that
the route had failed to plan.

So the invariant is not "geometry is fetched" but "the fetch is SHARED": one
producer at component scope, reachable from BOTH the local solve and the
rehydrate path. A gate on the fetch existing would have passed the whole time the
bug was live.

RULES
  A  A single component-scope `enrichGeometry` producer exists, and is NOT nested
     inside `solve` (nesting is exactly the shape that stranded the rehydrate
     path).
  B  It is called from at least two sites: the solve path and a rehydrate-facing
     one keyed off REHYDRATED assignments.
  C  Every assignment-level write of a geometry field happens inside that
     producer, so no second, unshared fetch path can grow back.
  D  The rehydrate collection path does not claim to draw routes it never asks
     for: if it sets assignments, a REHYDRATED marker must reach them.
  E  The agent memo publishes a revenue/cost breakdown only when it HAS one. A
     collected plan carries the solver's margin and no split, and `|| 0` turned
     that into `rev $0 cost $0 net +$1432` - a self-contradicting line quoted to
     the user as fact.
  F  Internal vs external is decided by the IS_INTERNAL flag, never by the SOURCE
     label, which has carried the literal word INTERNAL on external offers.
  G  The reposition-baseline pass is SHARED the same way, for the same reason: it
     lived inside `solve`, so every collected card silently lost BASELINE_EMPTY_KM,
     "deadhead avoided" and the baseline tooltip while looking complete.
  H  No render site emits a place column raw. 316 of 800 internal loads have no
     delivery city and 235 no pickup city (the POI ids exist in no POI table), so
     a raw column renders "A -> " or a bare "->" - a data gap that reads exactly
     like a broken renderer. The agent memo must not publish '?' either.
  I  "Already at its end point" is a STATED outcome. 35 of 89 vehicles in the live
     USA pool are parked at their own end point and they carry the highest margins,
     so the top card of a collected plan usually has no baseline line to draw.
  J  A collected plan's return empty leg is fetched. `(EMPTY_BACK_KM ?? 0) > 0` is
     the solver's statement that a tour repositions; a proposal makes no such
     statement, so gating on it alone left every rehydrated row with no return leg,
     no "(out + back)" split, and less deadhead than the same tour solved locally.
  K  Waypoints are deduped with the samePlace tolerance, not `===`. A pair differing
     in the 15th decimal reached DIRECTIONS and failed with "LineString ... at least
     2 elements" (measured 3 times in QUERY_HISTORY).

Run: python3 .cortex/skills/install-fleet-apps/scripts/check_backload_rehydrate_geometry.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
VIEW = REPO / ".cortex/skills/install-fleet-apps/fleet_sa_app/ui/src/components/views/areas/backload-matching.tsx"
REHYDRATE = REPO / ".cortex/skills/install-fleet-apps/fleet_sa_app/ui/src/lib/backload-rehydrate.ts"

GEOM_FIELDS = ("ROUTE_GEOJSON", "EMPTY_GEOJSON", "EMPTY_RETURN_GEOJSON")

AREA = REPO / ".cortex/skills/install-fleet-apps/fleet_sa_app/ui/src/components/views/areas/backload-matching"
CARD = AREA / "AssignmentList.tsx"
STOPS = AREA / "StopsPanel.tsx"
HELPERS = AREA / "helpers.ts"

failures: list[str] = []
checked = 0


def fail(rule: str, msg: str) -> None:
    failures.append(f"  [{rule}] {msg}")


def block_of(src: str, decl: str) -> tuple[int, int] | None:
    """Span of a `const <name> = useCallback(...)` by brace depth from its line."""
    i = src.find(decl)
    if i < 0:
        return None
    depth = 0
    started = False
    for j in range(i, len(src)):
        c = src[j]
        if c == "{":
            depth += 1
            started = True
        elif c == "}":
            depth -= 1
            if started and depth == 0:
                return (i, j)
    return None


def strip_comments(text: str) -> str:
    """Code only.

    The REHYDRATED-keying rules below ask whether the CODE selects collected
    plans. Tested against raw text they are satisfied by the prose that explains
    the keying - M14 removed the predicate `a.REHYDRATED &&` from the filter and
    the gate still passed, because the comment block above it says REHYDRATED
    three times. A rule that a comment can satisfy is not a rule.
    """
    text = re.sub(r"\{\s*/\*.*?\*/\s*\}", " ", text, flags=re.S)
    text = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)
    text = re.sub(r"^[ \t]*//.*$", " ", text, flags=re.M)
    return re.sub(r"//.*$", " ", text, flags=re.M)


def callback_body(src: str, decl: str) -> tuple[int, int] | None:
    """Span of a useCallback BODY, brace-matched from its arrow.

    `block_of` matches the first `{` after the declaration, which for a callback
    whose parameters carry an inline object type (`opts: { kmh: number }`) is that
    TYPE - so the block closed before the body began and every call inside the
    body read as "outside the wrapper". The arrow is the only reliable start.
    """
    i = src.find(decl)
    if i < 0:
        return None
    arrow = src.find("=> {", i)
    if arrow < 0:
        return None
    depth = 0
    for j in range(arrow + 3, len(src)):
        if src[j] == "{":
            depth += 1
        elif src[j] == "}":
            depth -= 1
            if depth == 0:
                return (i, j)
    return None


def main() -> int:
    global checked
    for p in (VIEW, REHYDRATE):
        if not p.exists():
            print(f"FAILED: expected file is missing: {p}")
            return 1
    src = VIEW.read_text()
    checked += 1

    # ---- RULE A: one shared producer, at component scope.
    decls = re.findall(r"const enrichGeometry\s*=", src)
    if len(decls) != 1:
        fail("A", f"expected exactly 1 `const enrichGeometry =` producer, found {len(decls)}")

    enrich = block_of(src, "const enrichGeometry")
    solve = block_of(src, "const solve = useCallback")
    if enrich is None:
        fail("A", "no `const enrichGeometry` block found - the shared geometry producer is gone")
    if solve is None:
        fail("A", "no `const solve = useCallback` block found (has it been renamed?)")
    if enrich and solve and solve[0] < enrich[0] < solve[1]:
        fail(
            "A",
            "enrichGeometry is nested INSIDE solve, so a rehydrated plan cannot reach it - "
            "this is the exact shape of the missing-route-line bug",
        )
    if enrich and solve and enrich[0] > solve[0]:
        fail(
            "A",
            "enrichGeometry is declared after solve; hoist it, or the effects listing it as a "
            "dependency hit a temporal dead zone at render",
        )

    # ---- RULE B: called from the solve path AND a rehydrate-facing site.
    calls = [m.start() for m in re.finditer(r"\benrichGeometry\(", src)]
    if len(calls) < 2:
        fail("B", f"enrichGeometry is called from {len(calls)} site(s); the solve path and the "
                  "rehydrate path must BOTH call it")
    if solve:
        if not any(solve[0] < c < solve[1] for c in calls):
            fail("B", "the solve path never calls enrichGeometry, so a locally solved plan draws no routes")
        outside = [c for c in calls if not (solve[0] < c < solve[1])]
        if not outside:
            fail("B", "every enrichGeometry call is inside solve, so a collected agent plan draws no routes")
        else:
            # The non-solve caller must actually be the rehydrate path: keyed on
            # REHYDRATED assignments. A call from an unrelated effect would
            # satisfy a bare count while leaving the collected plan blank.
            near = min(
                (strip_comments(src[max(0, c - 1200):c]) for c in outside),
                key=lambda s: 0 if "a.REHYDRATED" in s else 1,
            )
            if "a.REHYDRATED" not in near:
                fail(
                    "B",
                    "the non-solve enrichGeometry call is not keyed off REHYDRATED assignments, so "
                    "nothing proves a collected agent plan is what gets enriched",
                )

    # ---- RULE C: no unshared geometry writes.
    for field in GEOM_FIELDS:
        for m in re.finditer(rf"\ba\.{field}\s*=(?!=)", src):
            if not (enrich and enrich[0] < m.start() < enrich[1]):
                line = src[: m.start()].count("\n") + 1
                fail(
                    "C",
                    f"{VIEW.name}:{line} writes {field} outside enrichGeometry - a second, "
                    "unshared fetch path is how one entry point ends up with no route line",
                )

    # ---- RULE D: collected plans are marked, or rule B's keying is a lie.
    # The marker must be SET on the emitted object, not merely declared on the
    # interface or named in a comment - both survive commenting out the one line
    # that assigns it, which is what makes the collected plan unrecognisable.
    reh = REHYDRATE.read_text()
    checked += 1
    if not re.search(r"^\s*REHYDRATED:\s*true\s*,", reh, re.M):
        fail("D", f"{REHYDRATE.name} never sets `REHYDRATED: true` on a collected assignment, so the "
                  "enrichment effect cannot recognise it")
    helpers = REPO / (".cortex/skills/install-fleet-apps/fleet_sa_app/ui/src/components/views/"
                      "areas/backload-matching/helpers.ts")
    if helpers.exists():
        checked += 1
        helpers_src = helpers.read_text()
        if not re.search(r"REHYDRATED\??:\s*boolean", helpers_src):
            fail("D", "the Assignment type has no REHYDRATED field, so the marker is dropped by the "
                      "type the page actually renders")

    # ---- RULE E: the agent memo must not publish an economics breakdown it does
    # not have. A collected plan carries the solver's margin and no revenue/cost
    # split - the proposal has no per-offer price, so revenue is not derivable for
    # an external offer - and coercing the absent terms with `|| 0` produced
    # `rev $0 cost $0 net +$1432`: three defensible numbers in a line that does
    # not add up, published to the agent as fact.
    memo_econ = re.search(r"rev \$\$\{[^}]*\}", src)
    if memo_econ:
        window = src[max(0, memo_econ.start() - 1500):memo_econ.start()]
        if "REVENUE_USD !== undefined" not in window or "COST_USD !== undefined" not in window:
            line = src[: memo_econ.start()].count("\n") + 1
            fail(
                "E",
                f"{VIEW.name}:{line} publishes a rev/cost breakdown to the agent memo without first "
                "proving BOTH REVENUE_USD and COST_USD exist; a collected plan has neither, so this "
                "prints rev $0 cost $0 against a non-zero net",
            )
        if re.search(r"REVENUE_USD \|\| 0|COST_USD \|\| 0", src):
            fail(
                "E",
                "the memo coerces REVENUE_USD/COST_USD with `|| 0`, which is exactly what turned an "
                "absent breakdown into a measured-looking zero",
            )

    # ---- RULE F: internal vs external is decided by the FLAG, never by the label.
    # SOURCE has carried the literal word INTERNAL on external offers (measured 75
    # of 300 rows still in VW_LOADS). The page counts internal matches on
    # IS_INTERNAL, so deriving the badge from SOURCE let one plan show INTERNAL and
    # report 0 internal matches simultaneously.
    if not re.search(r"IS_INTERNAL:\s*channel\.internal", reh):
        fail("F", f"{REHYDRATE.name} does not carry IS_INTERNAL from the resolved channel, so a "
                  "collected plan reports 0 internal matches however its badge reads")
    if re.search(r"is_internal\s*\?\s*'INTERNAL'\s*:\s*String\(", reh):
        fail("F", f"{REHYDRATE.name} derives the channel label from `source` again - that echoes an "
                  "INTERNAL label back out for a load the flag calls external")
    if "resolveChannel" not in reh:
        fail("F", f"{REHYDRATE.name} has no resolveChannel helper, so nothing scrubs an untrue "
                  "INTERNAL label")
    # Asserted on the rehydrate module's OWN interface, not on the page's
    # Assignment type. The page casts collected rows through `as unknown as
    # Assignment[]`, so this module is where the field is actually declared and
    # owned; asserting it in helpers.ts instead would couple this gate to whatever
    # else is in flight on that shared type.
    if not re.search(r"IS_INTERNAL:\s*boolean", reh):
        fail("F", f"{REHYDRATE.name} does not declare IS_INTERNAL on its assignment shape, so the "
                  "authoritative flag is not carried at all")

    # ---- RULE G: the baseline pass is shared, exactly like the geometry pass.
    # It was called in ONE place, inside solve, so a collected plan had no
    # BASELINE_EMPTY_KM at all: no "deadhead avoided ~X km", no baseline tooltip,
    # and nothing on screen saying either was missing.
    raw_calls = [m.start() for m in re.finditer(r"\bcomputeEmptyLegBaselines\(", src)]
    wrapper = callback_body(src, "const computeBaselines = useCallback")
    if wrapper is None:
        fail("G", "no `const computeBaselines` wrapper - the baseline pass has no shared producer")
    if len(raw_calls) != 1:
        fail(
            "G",
            f"computeEmptyLegBaselines is called from {len(raw_calls)} site(s) directly; it must be "
            "reached ONLY through computeBaselines, or the two paths can drift apart",
        )
    if wrapper and raw_calls and not (wrapper[0] < raw_calls[0] < wrapper[1]):
        fail("G", "the direct computeEmptyLegBaselines call is outside computeBaselines")
    if wrapper and solve and solve[0] < wrapper[0] < solve[1]:
        fail("G", "computeBaselines is nested inside solve, which is what stranded the collected plan")
    bl_calls = [m.start() for m in re.finditer(r"\bcomputeBaselines\(", src)]
    if wrapper:
        bl_calls = [c for c in bl_calls if not (wrapper[0] <= c <= wrapper[1])]
        if any(c < wrapper[0] for c in bl_calls):
            fail("G", "computeBaselines is called before it is declared - a dependency array is "
                      "evaluated during render, so this is a temporal dead zone")
    if len(bl_calls) < 2:
        fail("G", f"computeBaselines has {len(bl_calls)} caller(s); the solve path and the "
                  "collected-plan path must BOTH use it")
    elif solve:
        if not any(solve[0] < c < solve[1] for c in bl_calls):
            fail("G", "the solve path no longer uses computeBaselines")
        outside_bl = [c for c in bl_calls if not (solve[0] < c < solve[1])]
        if not outside_bl:
            fail("G", "every computeBaselines call is inside solve, so a collected plan has no baseline")
        else:
            near_bl = min((strip_comments(src[max(0, c - 1500):c]) for c in outside_bl),
                          key=lambda w: 0 if "a.REHYDRATED" in w else 1)
            if "a.REHYDRATED" not in near_bl:
                fail("G", "the non-solve computeBaselines call is not keyed off REHYDRATED "
                          "assignments, so nothing proves the collected plan is what gets a baseline")
    # The arithmetic must have ONE owner. Two copies are free to disagree, and the
    # 'fixed-open' exclusion is the part that quietly invents a saving when dropped.
    if not re.search(r"export function deriveSavedKm", HELPERS.read_text() if HELPERS.exists() else ""):
        fail("G", "helpers.ts has no deriveSavedKm - the saved-km rule has no single owner")
    if len(re.findall(r"SAVED_KM\s*=\s*Math\.max", src)) > 0:
        fail("G", "the page re-implements SAVED_KM instead of calling deriveSavedKm")

    # ---- RULES H/I: what the CARD and the STOPS panel are allowed to render.
    for path in (CARD, STOPS):
        if not path.exists():
            fail("H", f"expected render file is missing: {path}")
    if CARD.exists():
        checked += 1
        card = CARD.read_text()
        # A raw interpolation of a city column. This is the defect verbatim:
        # `{a.PICKUP_CITY} -> {a.PROPOSAL_DROPOFF_CITY}`.
        for col in ("PICKUP_CITY", "PROPOSAL_DROPOFF_CITY"):
            for m in re.finditer(rf"\{{\s*a\.{col}\s*\}}", card):
                line = card[: m.start()].count("\n") + 1
                fail("H", f"AssignmentList.tsx:{line} renders a.{col} raw; an unnamed POI is blank, "
                          "so the card reads as a broken renderer rather than as a data gap")
        for col in ("PICKUP_CITY", "PROPOSAL_DROPOFF_CITY"):
            if f"placeLabel(a.{col}" not in card:
                fail("H", f"AssignmentList.tsx does not pass a.{col} through placeLabel")
        if "isAtEndBaseline(" not in card:
            fail("I", "AssignmentList.tsx never checks isAtEndBaseline, so a vehicle already at its "
                      "end point shows no baseline and no reason for its absence")
    if STOPS.exists():
        checked += 1
        stops_src = STOPS.read_text()
        if re.search(r"\{\s*s\.city\s*\|\|", stops_src):
            fail("H", "StopsPanel.tsx falls back on a raw s.city, so a placeholder token like "
                      "'Destination' renders as though it named a real site")
        if "realPlace(s.city)" not in stops_src:
            fail("H", "StopsPanel.tsx does not pass s.city through realPlace")
    if HELPERS.exists():
        h = HELPERS.read_text()
        if "export function placeLabel" not in h:
            fail("H", "helpers.ts exports no placeLabel, so every render site invents its own fallback")
        if "export function isAtEndBaseline" not in h:
            fail("I", "helpers.ts exports no isAtEndBaseline")
        else:
            at_end = h[h.index("export function isAtEndBaseline"):]
            at_end = at_end[: at_end.index("\n}") + 2]
            if "samePlace" not in at_end:
                fail("I", "isAtEndBaseline does not use samePlace, so it compares coordinates exactly - "
                          "the same mistake that sent a zero-length leg to DIRECTIONS")
        # ---- RULE K: tolerance dedupe.
        clean = re.search(r"function cleanWaypoints\(.*?\n\}", h, re.S)
        if not clean:
            fail("K", "cleanWaypoints is gone; nothing filters degenerate waypoint pairs")
        elif "samePlace" not in clean.group(0):
            fail("K", "cleanWaypoints dedupes without samePlace, so a pair differing in the last "
                      "decimal still reaches DIRECTIONS and fails as a one-point LineString")
    # The map readout must explain the ABSENT line in the same breath as the 0 km.
    at_end_branch = re.search(r"baseline\?\.status === 'at-end'", src)
    if not at_end_branch:
        fail("I", "the map readout has no 'at-end' branch, so a 0 km baseline is indistinguishable "
                  "from a fetch that never returned")
    else:
        window = src[at_end_branch.start(): at_end_branch.start() + 600]
        if "adds empty km" not in window:
            fail("I", "the 'at-end' readout does not say a backload ADDS empty km here; "
                      "'0 km' alone leaves the missing grey line unexplained")

    # ---- RULE H (memo): never publish '?' as a place to the agent.
    for m in re.finditer(r"realPlace\(a\.(?:PICKUP_CITY|PROPOSAL_DROPOFF_CITY)\)\s*(?:\?\?|\|\|)\s*'\?'", src):
        line = src[: m.start()].count("\n") + 1
        fail("H", f"{VIEW.name}:{line} publishes '?' to the agent memo as a place; use placeLabel, "
                  "which names the load instead of inviting a guess")

    # ---- RULE J: the collected plan's return leg is actually fetched.
    has_return = re.search(r"const hasReturn = (.*?);", src, re.S)
    if not has_return:
        fail("J", "no hasReturn expression found - the return empty leg gate has been renamed")
    elif "REHYDRATED" not in has_return.group(1):
        fail(
            "J",
            "hasReturn does not branch on REHYDRATED: a proposal carries no EMPTY_BACK_KM, so "
            "gating on `(EMPTY_BACK_KM ?? 0) > 0` alone means a collected plan never fetches its "
            "reposition leg and reports less deadhead than the same tour solved on this page",
        )

    if checked < 5:
        print(f"FAILED: gate inspected only {checked} file(s) - it is passing vacuously")
        return 1
    if failures:
        print("FAILED: backload rehydrate geometry gate\n" + "\n".join(failures))
        return 1
    print(f"PASSED: backload rehydrate geometry gate ({checked} files inspected)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
