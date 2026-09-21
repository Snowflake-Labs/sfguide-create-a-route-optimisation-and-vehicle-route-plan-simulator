#!/usr/bin/env python3
"""Negative tests for check_h3_resolution.py.

Every mutation runs against a THROWAWAY COPY of the app directory and the gate must
FAIL. Nothing under the real repo is written.

The mutations are chosen to be the shapes that actually occurred or were one step
away in the transcript, not arbitrary damage:

  M2 is the ORIGINAL DEFECT - an H3 cell with no point to re-bin from.
  M5 and M6 are the FABRICATION shapes. M6 is the important one: it states the
     stored grain as a FACT and drops the prohibition, which is exactly how the
     agent read it before composing SUM(measure / 49.0).
  M7 prescribes a function that does not exist, the dead end the agent found.
  M8 is vacuity - no H3 view in scope must FAIL, not pass silently.
"""
from __future__ import annotations

import importlib.util
import io
import re
import shutil
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parent
GATE = HERE / "check_h3_resolution.py"
APP_SRC = HERE.parent / "fleet_sa_app" / "app"
SV = "semantic_views.sql"


def load_gate():
    spec = importlib.util.spec_from_file_location("h3_gate", GATE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def stage(tmp: Path) -> Path:
    dst = tmp / "app"
    shutil.copytree(APP_SRC, dst)
    return dst


def run_gate(app_dir: Path) -> tuple[int, str]:
    mod = load_gate()
    mod.APP_DIR = app_dir
    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = mod.main()
    return rc, buf.getvalue()


def edit_view(app_dir: Path, view: str, fn) -> None:
    """Apply fn to ONE view's body so a mutation cannot leak into its neighbour."""
    mod = load_gate()
    p = app_dir / SV
    sql = p.read_text()
    bodies = dict(mod.split_semantic_views(sql))
    body = bodies[view]
    new = fn(body)
    assert new != body, f"mutation did not change {view}"
    p.write_text(sql.replace(body, new, 1))


def sub(pattern: str, repl: str, *, flags: int = 0):
    def _f(body: str) -> str:
        out = re.sub(pattern, repl, body, flags=flags)
        assert out != body, f"pattern {pattern!r} did not match"
        return out
    return _f


# --- mutations -----------------------------------------------------------------

def m1_drop_stored_resolution(app):
    edit_view(app, "SV_DWELL_ANALYTICS",
              sub(r"STORED at resolution 7", "used for heatmaps"))


def m2_drop_the_point(app):
    """The original defect: an H3 cell with nothing to re-bin from."""
    def f(body: str) -> str:
        out = re.sub(r"\n\s*,\s*sessions\.dwell_(?:lat|lon) AS DWELL_(?:LAT|LON)"
                     r"(?:\n(?!\s*,).*)*", "", body)
        assert "DWELL_LAT" not in out.split("DIMENSIONS")[1].split("METRICS")[0], \
            "lat/lon dimensions survived the mutation"
        return out
    edit_view(app, "SV_DWELL_ANALYTICS", f)


def m3_drop_rebin_function(app):
    edit_view(app, "SV_DWELL_ANALYTICS",
              sub(r"H3_LATLNG_TO_CELL_STRING", "the binning function"))


def m4_drop_coarsen_only_declaration(app):
    edit_view(app, "SV_LOCATION",
              sub(r"COARSER ONLY", "NOTES", flags=re.IGNORECASE))


def m5_drop_parent_function(app):
    edit_view(app, "SV_LOCATION",
              sub(r"H3_CELL_TO_PARENT\(cell_h3, N\)", "a roll-up"))


def m6_fact_instead_of_prohibition(app):
    """Keeps every true statement, drops only the prohibition.

    This is the shape that produced the near-miss: "resolution 8 is the finest
    grain" is a fact about storage, and the agent treated the absent finer grain as
    something to approximate.
    """
    edit_view(app, "SV_LOCATION",
              sub(r"NEVER divide[^.]*\.", "Resolution 8 is the finest grain stored."))


def m7_prescribe_a_fake_function(app):
    edit_view(app, "SV_DWELL_ANALYTICS",
              sub(r"- These are the functions that EXIST:[^\n]*\n",
                  "- To go finer, expand each cell with H3_CELL_TO_CHILDREN and "
                  "share the measure across the children.\n"))


def m8_no_h3_view_in_scope(app):
    """Vacuity: rename both H3 dimensions so no view is in scope."""
    p = app / SV
    s = p.read_text()
    s = s.replace("sessions.h3_cell AS H3_CELL_R7", "sessions.zone_id AS ZONE_ID")
    s = s.replace("hh_cells.cell_h3 AS H3", "hh_cells.zone_id AS ZONE_ID")
    p.write_text(s)


MUTATIONS = [
    ("M1 stored resolution not stated", m1_drop_stored_resolution, "never states the STORED resolution"),
    ("M2 H3 cell with no point (THE ORIGINAL DEFECT)", m2_drop_the_point, "NO point dimension"),
    ("M3 point exposed but no re-bin function named", m3_drop_rebin_function, "names no re-bin function CALLED ON"),
    ("M4 coarsen-only declaration removed", m4_drop_coarsen_only_declaration, "NO point dimension"),
    ("M5 coarsen-only but H3_CELL_TO_PARENT not named", m5_drop_parent_function, "never names H3_CELL_TO_PARENT"),
    ("M6 prohibition replaced by a FACT (fabrication shape)", m6_fact_instead_of_prohibition, "never FORBIDS dividing"),
    ("M7 prescribes a non-existent function", m7_prescribe_a_fake_function, "does not exist in Snowflake"),
]


def main() -> int:
    failures: list[str] = []
    print("Negative tests for check_h3_resolution.py\n")

    with tempfile.TemporaryDirectory() as td:
        app = stage(Path(td))
        rc, out = run_gate(app)
        if rc != 0:
            print("  FAIL  positive control: a clean staged copy does not pass")
            print("\n".join("        " + l for l in out.strip().split("\n")))
            return 1
        print("  ok    positive control: clean staged copy passes")

    for label, mutate, expect in MUTATIONS:
        with tempfile.TemporaryDirectory() as td:
            app = stage(Path(td))
            mutate(app)
            rc, out = run_gate(app)
            if rc == 0:
                failures.append(f"{label}: gate PASSED on a mutated tree")
                print(f"  FAIL  {label} (gate passed)")
            elif expect not in out:
                failures.append(
                    f"{label}: gate failed but not for the stated reason "
                    f"(expected {expect!r} in the output)"
                )
                print(f"  FAIL  {label} (failed for the wrong reason)")
            else:
                print(f"  ok    {label}")

    with tempfile.TemporaryDirectory() as td:
        app = stage(Path(td))
        m8_no_h3_view_in_scope(app)
        rc, out = run_gate(app)
        if rc == 0:
            failures.append("M8 no H3 view in scope: gate PASSED having checked nothing")
            print("  FAIL  M8 no H3 view in scope (gate passed vacuously)")
        elif "checked NOTHING" not in out:
            failures.append("M8 no H3 view in scope: failed, but not via the vacuity guard")
            print("  FAIL  M8 no H3 view in scope (wrong reason)")
        else:
            print("  ok    M8 no H3 view in scope (vacuity guard fired)")

    print()
    if failures:
        print(f"FAIL: {len(failures)} mutation(s) were not caught:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print(f"PASSED: all {len(MUTATIONS) + 1} mutations rejected, clean copy accepted")
    return 0


if __name__ == "__main__":
    sys.exit(main())
