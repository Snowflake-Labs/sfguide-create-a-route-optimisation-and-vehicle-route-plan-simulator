#!/usr/bin/env python3
"""Guard: trip-path GeoJSON is simplified by a SIZE BUDGET, never a fixed tolerance.

What happened (wgb26798, Chicago demo in CoWork): VW_TRIP_PATHS built PATH_GEOJSON
as ST_ASGEOJSON(ST_SIMPLIFY(path, 250)). The fixed 250 m existed so UK long-haul
paths (317 KB raw) would not render a blank map, but it collapsed every city trip
to a few chords - 357 -> 7 vertices on a 16 km Chicago trip - so the driven and
planned lines cut across blocks instead of following streets.

Rule (SQL `--` comments stripped first), in BOTH the pack model and its generated
setup.sql:
  1. no ST_SIMPLIFY applied directly to ACTUAL_PATH or EXPECTED_PATH;
  2. PATH_GEOJSON is a `CASE ... END AS PATH_GEOJSON` whose FIRST branch sends the
     unsimplified ST_ASGEOJSON(<x>.PATH_GEOM) when it fits the budget;
  3. every WHEN tests LENGTH(...) against the SAME budget, at most 31,000 bytes
     (the size at which data_to_map renders a blank map);
  4. an ELSE exists, so an oversized path is drawn coarse rather than NULL.

Usage:  python3 .cortex/skills/install-fleet-apps/scripts/check_trip_path_budget.py
Exit:   0 clean, 1 violation
"""
from __future__ import annotations

import pathlib
import re
import sys

REPO = pathlib.Path.cwd()
PACK = ".cortex/skills/install-fleet-apps/fleet_sa_app/app/packs/fleet/route_deviation"
FILES = (f"{PACK}/data-model.yaml", f"{PACK}/setup.sql")
MAX_BUDGET = 31000


def check(rel: str) -> list[str]:
    path = REPO / rel
    if not path.is_file():
        return [f"{rel} not found"]
    sql = re.sub(r"--[^\n]*", "", path.read_text())
    errs = []
    if re.search(r"ST_SIMPLIFY\(\s*(\w+\.)?(ACTUAL|EXPECTED)_PATH\b", sql, re.I):
        errs.append(f"{rel}: ST_SIMPLIFY applied directly to a trip path; use the "
                    "size-budgeted CASE ladder (a fixed tolerance draws city trips "
                    "as chords across blocks)")
    end = re.search(r"\bEND\s+AS\s+PATH_GEOJSON\b", sql, re.I)
    starts = [c.end() for c in re.finditer(r"\bCASE\b", sql[:end.start()], re.I)] if end else []
    if not starts:
        errs.append(f"{rel}: no `CASE ... END AS PATH_GEOJSON` size-budget ladder")
        return errs
    # The NEAREST CASE before the alias: an earlier CASE in the file (the
    # telemetry teleport flag) must not be read as the ladder.
    body = sql[starts[-1]:end.start()]
    whens = re.findall(r"\bWHEN\b(.*?)\bTHEN\b", body, re.I | re.S)
    if not whens:
        errs.append(f"{rel}: PATH_GEOJSON ladder has no WHEN branch")
        return errs
    first = " ".join(whens[0].split())
    if not re.fullmatch(r"LENGTH\(ST_ASGEOJSON\((\w+\.)?PATH_GEOM\)::VARCHAR\) <= \d+",
                        first, re.I):
        errs.append(f"{rel}: first branch is `{first}`; it must send the "
                    "unsimplified path when it fits the budget")
    budgets = set()
    for w in whens:
        b = re.search(r"LENGTH\(.*\)\s*<=\s*(\d+)\s*$", " ".join(w.split()), re.I)
        if not b:
            errs.append(f"{rel}: branch `{' '.join(w.split())}` does not test "
                        "LENGTH(...) <= <budget>")
            continue
        budgets.add(int(b.group(1)))
    if len(budgets) > 1:
        errs.append(f"{rel}: branches use different budgets {sorted(budgets)}")
    if budgets and max(budgets) > MAX_BUDGET:
        errs.append(f"{rel}: budget {max(budgets)} exceeds {MAX_BUDGET} bytes, "
                    "above which data_to_map renders a blank map")
    if not re.search(r"\bELSE\b", body, re.I):
        errs.append(f"{rel}: PATH_GEOJSON ladder has no ELSE; an oversized path "
                    "would become NULL instead of drawing coarse")
    return errs


def main() -> int:
    errs = [e for rel in FILES for e in check(rel)]
    if errs:
        for e in errs:
            print(f"FAIL {e}")
        return 1
    print("OK trip-path GeoJSON is size-budgeted in model and generated setup")
    return 0


if __name__ == "__main__":
    sys.exit(main())
