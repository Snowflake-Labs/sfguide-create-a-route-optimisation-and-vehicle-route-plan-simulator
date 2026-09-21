#!/usr/bin/env python3
"""Mutation tests for check_chart_dual_axis.py.

A gate that has never been shown to FAIL is a gate that proves nothing. Each
mutation below reverts exactly one part of the fix; the gate must reject every
one of them, naming the right rule. Two of these are the wordings that actually
shipped:

  M5  labor_overtime/team as two bars on one axis  - the live pre-fix state
  M4  `type: "line"` authored but no second axis   - the trend panel's live state

Every mutation is written to a TEMPORARY COPY of the tree? No - it edits in
place and restores in a `finally`, because the gate resolves its own paths from
`__file__` and cannot be pointed at a copy. That makes the restore mandatory:
an earlier driver in this repo left a file mutated after an abort and a later
`git checkout --` wiped uncommitted work in an untouched file to recover. Each
gate run is bounded by a timeout, since one mutation can send a gate into a loop
it would otherwise never reach.
"""

from __future__ import annotations

import pathlib
import re
import subprocess
import sys

SCRIPTS = pathlib.Path(__file__).resolve().parent
GATE = SCRIPTS / "check_chart_dual_axis.py"
SKILL = SCRIPTS.parent
CHART = SKILL / "fleet_sa_app" / "ui" / "src" / "components" / "views" / "areas" / "view-chart.tsx"
APP_VIEWS = SKILL / "fleet_sa_app" / "app" / "app-views.json"

TIMEOUT_S = 60


def run_gate() -> tuple[int, str]:
    try:
        p = subprocess.run(
            [sys.executable, str(GATE)], capture_output=True, text=True, timeout=TIMEOUT_S)
    except subprocess.TimeoutExpired:
        return 99, f"gate did not finish within {TIMEOUT_S}s"
    return p.returncode, p.stdout + p.stderr


def move_combo_after_bar(src: str) -> str:
    """Relocate the whole combo branch below the bar branch.

    The mutation that every substring check in the gate passes: ComposedChart is
    still imported, still rendered, still carries yAxisId - and never runs,
    because `hasBar` returns first for any config containing a bar.
    """
    combo = re.search(r"\n  if \(isCombo\) \{", src)
    bar = re.search(r"\n  if \(hasBar\) \{", src)
    if not combo or not bar or combo.start() > bar.start():
        raise RuntimeError("M2: could not locate the two branches to swap")
    block = src[combo.start():bar.start()]
    rest = src[bar.start():]
    anchor = rest.index("\n  return (")
    return src[:combo.start()] + rest[:anchor] + block + rest[anchor:]


def drop_yaxisid_from_bar(src: str) -> str:
    """Remove yAxisId from the <Bar> in the combo branch only."""
    out, n = re.subn(
        r"(return <Bar key=\{s\.field\}[^>]*?)\s*yAxisId=\{axisId\}", r"\1", src)
    if n != 1:
        raise RuntimeError(f"M3: expected 1 Bar yAxisId in the combo branch, found {n}")
    return out


def never_target_right(src: str) -> str:
    """Make every mark resolve to the left axis."""
    out, n = re.subn(
        r"const axisId = s\.yAxis === 'right' \? 'right' : 'left';",
        "const axisId = 'left';", src)
    if n != 1:
        raise RuntimeError(f"M6: expected 1 axisId assignment, found {n}")
    return out


def strip_trend_right_axis(src: str) -> str:
    """The trend panel's live pre-fix state: `type: "line"` and no second axis."""
    needle = """              "label": "At-Risk {{labels.operator_plural}}",
              "yAxis": "right"
"""
    if src.count(needle) != 2:
        raise RuntimeError(f"M4: expected 2 right-axis series, found {src.count(needle)}")
    replacement = """              "label": "At-Risk {{labels.operator_plural}}"
"""
    # Only the FIRST (trend); team keeps its axis, so the failure is attributable
    # to one panel rather than to "all of them".
    return src.replace(needle, replacement, 1)


def team_back_to_two_bars(src: str) -> str:
    """The exact state that shipped for the depot-team panel."""
    needle = """            {
              "type": "line",
              "field": "at_risk_operators",
              "label": "At-Risk {{labels.operator_plural}}",
              "yAxis": "right"
            }
          ]
        }
      },
      "map": {"""
    if needle not in src:
        raise RuntimeError("M5: could not locate the team panel series")
    shipped = """            {
              "type": "bar",
              "field": "at_risk_operators",
              "label": "At-Risk {{labels.operator_plural}}"
            }
          ]
        }
      },
      "map": {"""
    return src.replace(needle, shipped, 1)


def rename_money_field(src: str) -> str:
    """Rename the currency field so the MONEY pattern stops matching it.

    Targets the vacuity counter, not RULE D: after this the gate would find no
    money+count pair anywhere and, without RULE E, would report success on a
    tree where its central rule inspects nothing.
    """
    out, n = re.subn(r'"field": "ot_premium"', '"field": "ot_val"', src)
    if n < 2:
        raise RuntimeError(f"M8: expected >=2 ot_premium series, found {n}")
    return out


def break_gate_path(src: str) -> str:
    """Point the gate one directory short, the way two gates in this repo shipped."""
    out, n = re.subn(
        r'APP_VIEWS = SKILL / "fleet_sa_app" / "app" / "app-views.json"',
        'APP_VIEWS = SKILL / "app" / "app-views.json"', src)
    if n != 1:
        raise RuntimeError("M7: could not locate the APP_VIEWS path")
    return out


MUTATIONS = [
    ("M1 ComposedChart no longer rendered", CHART,
     lambda s: s.replace("<ComposedChart", "<BarChart", 1), "RULE A"),
    ("M2 combo branch moved below the bar branch", CHART, move_combo_after_bar, "RULE B"),
    ("M3 yAxisId dropped from <Bar> only", CHART, drop_yaxisid_from_bar, "RULE C"),
    ("M6 no mark targets the right axis", CHART, never_target_right, "RULE C"),
    ("M4 trend: type line authored, second axis removed (shipped state)",
     APP_VIEWS, strip_trend_right_axis, "RULE D"),
    ("M5 team: two bars on one axis (shipped state)",
     APP_VIEWS, team_back_to_two_bars, "RULE D"),
    ("M8 currency field renamed so MONEY stops matching", APP_VIEWS,
     rename_money_field, "RULE E"),
    ("M7 gate path one directory short", GATE, break_gate_path, "RULE E"),
]


def main() -> int:
    rc, out = run_gate()
    if rc != 0:
        print("FAIL: the gate is already red on an unmutated tree, so no mutation "
              "result below would mean anything:")
        print(out)
        return 1

    failures: list[str] = []
    for name, target, mutate, expect in MUTATIONS:
        original = target.read_text()
        try:
            mutated = mutate(original)
            if mutated == original:
                failures.append(f"{name}: mutation was a no-op, nothing was tested")
                continue
            target.write_text(mutated)
            rc, out = run_gate()
            if rc == 0:
                failures.append(
                    f"{name}: gate PASSED a tree it must reject (expected {expect})")
            elif rc == 99:
                failures.append(f"{name}: {out}")
            elif expect not in out:
                failures.append(
                    f"{name}: gate failed but did not cite {expect}, so it convicts "
                    f"the wrong cause. Output:\n{out}")
            else:
                print(f"  convicted: {name} -> {expect}")
        except Exception as exc:  # a broken mutation is a failure of this driver
            failures.append(f"{name}: mutation could not be applied ({exc})")
        finally:
            # Unconditional, including on KeyboardInterrupt paths that reach here.
            target.write_text(original)

    rc, out = run_gate()
    if rc != 0:
        failures.append(f"tree was NOT restored cleanly after mutation; gate now red:\n{out}")

    if failures:
        print("FAIL: check_chart_dual_axis.py does not reject every reverted fix:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print(f"OK: all {len(MUTATIONS)} mutations convicted, tree restored")
    return 0


if __name__ == "__main__":
    sys.exit(main())
