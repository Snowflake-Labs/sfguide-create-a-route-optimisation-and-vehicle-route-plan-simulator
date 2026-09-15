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
  F  Internal vs external is decided by the IS_INTERNAL flag, never by the SOURCE
     label, which has carried the literal word INTERNAL on external offers.

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
                (src[max(0, c - 1200):c] for c in outside),
                key=lambda s: 0 if "REHYDRATED" in s else 1,
            )
            if "REHYDRATED" not in near:
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

    if checked < 3:
        print(f"FAILED: gate inspected only {checked} file(s) - it is passing vacuously")
        return 1
    if failures:
        print("FAILED: backload rehydrate geometry gate\n" + "\n".join(failures))
        return 1
    print(f"PASSED: backload rehydrate geometry gate ({checked} files inspected)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
