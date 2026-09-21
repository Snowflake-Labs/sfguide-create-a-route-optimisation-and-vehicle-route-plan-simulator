#!/usr/bin/env python3
"""Negative test for RULE I and RULE J of check_chart_rendering.py.

A gate that has never been seen to FAIL has proved nothing, and this repo has
already shipped three rules in that same file which passed on the comment
describing the defect rather than the code avoiding it. So each mutation below is
a plausible edit someone could make - including the two that LOOK equivalent to
the fix - and the gate must reject every one of them.

Each mutation is applied to a COPY of the tree is not possible here (the gate
reads absolute paths), so the real files are patched and restored in a `finally`.
Nothing else may run against the tree while this is running.
"""

import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
SCRIPTS = Path(__file__).resolve().parent
GATE = SCRIPTS / "check_chart_rendering.py"
UI = REPO / ".cortex/skills/install-fleet-apps/fleet_sa_app/ui/src"
THEME = UI / "lib/vega-theme.ts"
SPEC = UI / "lib/chart-spec.ts"


def run_gate() -> int:
    return subprocess.run([sys.executable, str(GATE)], capture_output=True).returncode


# (label, file, transform) - each must make the gate FAIL.
MUTATIONS = [
    # M1: the whole discrete-axis block deleted - the pre-fix state.
    ("M1 axisXDiscrete removed", THEME,
     lambda s: re.sub(r"\n\s*axisXDiscrete: \{[^}]*\},", "", s, count=1)),
    # M2: the rule demoted to a comment. This is the shape that false-passed
    # three other rules in this gate.
    ("M2 discrete config only in a comment", THEME,
     lambda s: re.sub(r"\n(\s*)axisXDiscrete: (\{[^}]*\}),",
                      r"\n\1// axisXDiscrete: \2,", s, count=1)),
    # M3: rotation dropped, overlap left behind. Looks configured, still collides.
    ("M3 labelAngle dropped from axisXDiscrete", THEME,
     lambda s: s.replace("axisXDiscrete: { labelAngle: -35,", "axisXDiscrete: {", 1)),
    # M4: the angle moved to the blanket axisX. Fixes the bar chart and tilts every
    # quantitative and temporal axis in the app with it.
    ("M4 labelAngle on the blanket axisX", THEME,
     lambda s: s.replace("axisX: { grid: false },",
                         "axisX: { grid: false, labelAngle: -35 },", 1)),
    # M5: back to a constant height - the state that compressed 20 categories into
    # 260px.
    ("M5 sizeSpec height constant again", SPEC,
     lambda s: s.replace(
         "if (out.height === undefined) out.height = stepHeight ? { step: DISCRETE_BAND_STEP } : height;",
         "if (out.height === undefined) out.height = height;", 1)),
    # M6: step applied unconditionally, so a line chart grows with its row count.
    ("M6 step height unconditional", SPEC,
     lambda s: s.replace("const stepHeight = out.height === undefined && hasDiscreteY(out);",
                         "const stepHeight = out.height === undefined;", 1)),
    # M7: step height paired with a two-axis fit.
    ("M7 autosize left as fit beside a step height", SPEC,
     lambda s: s.replace("      ? { type: 'fit-x', contains: 'padding' }",
                         "      ? { type: 'fit', contains: 'padding' }", 1)),
]


def main() -> int:
    if run_gate() != 0:
        print("ABORT: the gate is already failing on an unmutated tree.")
        return 1

    failures = []
    for label, path, mutate in MUTATIONS:
        original = path.read_text()
        try:
            mutated = mutate(original)
            if mutated == original:
                failures.append(f"{label}: mutation did not apply - the anchor text "
                                f"has moved, so this case tested NOTHING")
                continue
            path.write_text(mutated)
            if run_gate() == 0:
                failures.append(f"{label}: gate PASSED on a mutated tree")
            else:
                print(f"  convicted: {label}")
        finally:
            path.write_text(original)

    if run_gate() != 0:
        failures.append("the tree was not restored cleanly - the gate fails after "
                        "the run")

    if failures:
        print("FAIL: check_chart_rendering.py rules I/J are not watertight:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print(f"OK: all {len(MUTATIONS)} mutations convicted by check_chart_rendering.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
