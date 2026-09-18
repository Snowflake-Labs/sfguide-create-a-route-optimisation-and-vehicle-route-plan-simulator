#!/usr/bin/env python3
"""Mutation driver for check_land_clip_simplify.py.

A gate never seen to fail is documentation. Each mutation below is a shape the
fix could plausibly regress into - several of them read as working code - and the
gate must convict every one. The original file is restored in a finally block, so
an interrupted run cannot leave the module mutated.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
TARGET = (
    REPO
    / ".cortex/skills/install-fleet-apps/openrouteservice_app/app/modules/03_region_management.sql"
)
GATE = REPO / ".cortex/skills/install-fleet-apps/scripts/check_land_clip_simplify.py"

UNION_ARG = """SELECT ST_UNION_AGG(IFF(:clip_tol_m > 0,
                                    ST_SIMPLIFY(d.GEOMETRY, :clip_tol_m),
                                    d.GEOMETRY)) AS G,"""

MUTATIONS: list[tuple[str, list[tuple[str, str]]]] = [
    (
        "M1 decimation moved from the union to the final intersection",
        [
            (UNION_ARG, "SELECT ST_UNION_AGG(d.GEOMETRY) AS G,"),
            (
                "            ST_INTERSECTION(src.B, land.G) AS CLIPPED,",
                "            ST_SIMPLIFY(ST_INTERSECTION(src.B, land.G), :clip_tol_m) AS CLIPPED,",
            ),
        ],
    ),
    (
        "M2 pre-union tolerance hardcoded to 1000 m",
        [(UNION_ARG, UNION_ARG.replace("ST_SIMPLIFY(d.GEOMETRY, :clip_tol_m)", "ST_SIMPLIFY(d.GEOMETRY, 1000)"))],
    ),
    (
        "M3 tolerance keyed on area instead of a measured vertex count",
        [
            (
                """    clip_tol_m := CASE WHEN :in_pts <= 2000000  THEN 0
                       WHEN :in_pts <= 15000000 THEN 1000
                       ELSE 3000 END;""",
                "    clip_tol_m := CASE WHEN :orig_area > 20000000 THEN 1000 ELSE 0 END;",
            )
        ],
    ),
    (
        "M4 browser copy back to the metre cap",
        [
            (
                "        ROUTABLE_BOUNDARY_SIMPLE = ST_SIMPLIFY(c.CLIPPED, :simple_tol)",
                """        ROUTABLE_BOUNDARY_SIMPLE = ST_SIMPLIFY(
            c.CLIPPED,
            LEAST(500, GREATEST(25, SQRT(GREATEST(:clip_area, 0)) / 6))
        )""",
            )
        ],
    ),
    (
        "M5 escalation loop keeps the tolerance step but drops the re-measurement",
        [
            (
                """        simple_tol := LEAST(:max_simple_tol, :simple_tol * 2);
        SELECT MAX(ST_NPOINTS(ST_SIMPLIFY(CLIPPED, :simple_tol)))::FLOAT INTO :simple_pts
        FROM OPENROUTESERVICE_APP.CORE.TMP_ROUTABLE_CLIP;""",
                "        simple_tol := LEAST(:max_simple_tol, :simple_tol * 2);",
            )
        ],
    ),
    (
        "M6 ST_NPOINTS measurement left uncast",
        [
            (
                "    SELECT MAX(ST_NPOINTS(ST_SIMPLIFY(CLIPPED, :simple_tol)))::FLOAT INTO :simple_pts",
                "    SELECT MAX(ST_NPOINTS(ST_SIMPLIFY(CLIPPED, :simple_tol))) INTO :simple_pts",
            )
        ],
    ),
    (
        "M7 code deleted, explanatory comments left in place",
        [(UNION_ARG, "SELECT ST_UNION_AGG(d.GEOMETRY) AS G,")],
    ),
]


def main() -> int:
    original = TARGET.read_text()
    failures: list[str] = []
    try:
        # Baseline: the real file must PASS, else a convicted mutation proves nothing.
        base = subprocess.run([sys.executable, str(GATE)], capture_output=True, text=True)
        if base.returncode != 0:
            print("BASELINE FAILED - gate rejects the unmutated file:")
            print(base.stdout + base.stderr)
            return 1
        print("baseline: PASS")

        for name, edits in MUTATIONS:
            text = original
            for old, new in edits:
                if old not in text:
                    failures.append(f"{name}: anchor not found, mutation not applied")
                    text = None
                    break
                text = text.replace(old, new, 1)
            if text is None:
                continue
            TARGET.write_text(text)
            r = subprocess.run([sys.executable, str(GATE)], capture_output=True, text=True)
            if r.returncode == 0:
                failures.append(f"{name}: NOT CAUGHT (gate exited 0)")
                print(f"  {name}: NOT CAUGHT")
            else:
                first = [l for l in (r.stderr or "").split("\n") if l.strip().startswith("-")]
                print(f"  {name}: caught -> {(first[0].strip() if first else r.stderr.strip())[:120]}")
    finally:
        TARGET.write_text(original)
        print("restored original")

    if failures:
        print("\nMUTATIONS NOT CAUGHT:")
        for f in failures:
            print("  " + f)
        return 1
    print(f"\nall {len(MUTATIONS)} mutations caught")
    return 0


if __name__ == "__main__":
    sys.exit(main())
