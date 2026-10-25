#!/usr/bin/env python3
"""Guard: the labour layer's partial-start-week flag must compare at DAY grain.

What happened (wgb26798, fresh-laptop install on a Sunday): the seed is a 7-day
window re-anchored to the install time, so its first trip landed at 13:51 on the
week-start day. IS_PARTIAL_S was `FIRST_TS > WEEK_START::TIMESTAMP_NTZ`, which is
true for any first trip after midnight, so that fully covered week was flagged
partial-start; the only other week lay past the as-of anchor (IS_PARTIAL_E). The
weekly overtime trend filters both out, so the chart was empty and
validate_app_views.py reported labor_overtime / areas.trend EMPTY - one install
day in seven.

Rule (SQL `--` comments stripped first): the expression aliased IS_PARTIAL_S in
labor_layer.sql must be `<x>.FIRST_TS::DATE > <x>.WEEK_START` with no timestamp
cast on WEEK_START. A missing alias also fails, so deleting the flag cannot pass.

Usage:  python3 .cortex/skills/install-fleet-apps/scripts/check_labor_partial_week.py
Exit:   0 clean, 1 violation
"""
from __future__ import annotations

import pathlib
import re
import sys

REPO = pathlib.Path.cwd()
REL = ".cortex/skills/install-fleet-apps/fleet_sa_app/app/labor_layer.sql"


def main() -> int:
    path = REPO / REL
    if not path.is_file():
        print(f"FAIL {REL} not found")
        return 1
    sql = re.sub(r"--[^\n]*", "", path.read_text())
    m = re.search(r"\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s+AS\s+IS_PARTIAL_S\b", sql)
    if not m:
        print(f"FAIL {REL}: no `(...) AS IS_PARTIAL_S` expression")
        return 1
    expr = " ".join(m.group(1).split())
    ok = re.fullmatch(r"(\w+\.)?FIRST_TS::DATE > (\w+\.)?WEEK_START", expr, re.I)
    if not ok:
        print(f"FAIL {REL}: IS_PARTIAL_S is `{expr}`; compare at day grain "
              "(FIRST_TS::DATE > WEEK_START) or a first trip after midnight on the "
              "week-start day marks a full week partial")
        return 1
    print("OK labor IS_PARTIAL_S compares at day grain")
    return 0


if __name__ == "__main__":
    sys.exit(main())
