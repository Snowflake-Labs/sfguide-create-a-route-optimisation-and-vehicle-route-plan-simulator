#!/usr/bin/env python3
"""Gate: view-verification selection seeds pick the SAME row on every run.

Defect it pins (TIB fresh-laptop cycles 2-3, 2026-11-07): identical installs
reported BY_DESIGN=20 then 17. Most selection seeds were a bare `LIMIT 1` with
no ORDER BY, so each run drilled into an arbitrary row; plan_vs_actual's
`planned`/`actual` layers were excused as "may be excluded by the LIMIT 1
non-deterministic pick", and mix_sourcing's transfer-legs flipped with the
customer drawn. A harness whose verdict depends on luck cannot show a regression.

RULE A - every seed query in `selection_seeds` has an ORDER BY at its top level
         (after the last closing parenthesis, so a CTE's ORDER BY does not count).
RULE B - no `reason` excuses an empty layer with a non-deterministic pick.
"""
from __future__ import annotations

import pathlib
import re
import sys

import yaml

EXP = pathlib.Path(__file__).resolve().parent / "view-expectations.yaml"
EXCUSE = re.compile(r"non-?\s*deterministic|arbitrary row|random(ly)? pick", re.I)


def top_level(sql: str) -> str:
    """The tail of the statement outside any parentheses."""
    depth, last = 0, 0
    for i, ch in enumerate(sql):
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                last = i + 1
    return sql[last:]


def reasons(node):
    if isinstance(node, dict):
        for k, v in node.items():
            if k == "reason" and isinstance(v, str):
                yield v
            else:
                yield from reasons(v)
    elif isinstance(node, list):
        for v in node:
            yield from reasons(v)


def main(path: pathlib.Path = EXP) -> int:
    doc = yaml.safe_load(path.read_text())
    errs = []
    seeds = doc.get("selection_seeds") or {}
    if not seeds:
        errs.append("RULE A selection_seeds is empty or missing")
    n = 0
    for view, binds in seeds.items():
        for bind, sql in (binds or {}).items():
            n += 1
            if not re.search(r"\bORDER\s+BY\b", top_level(str(sql)), re.I):
                errs.append(f"RULE A seed {view}.{bind} has no top-level ORDER BY (picks an arbitrary row)")
    other = {k: v for k, v in doc.items() if k != "selection_seeds"}
    for r in reasons(other):
        if EXCUSE.search(r):
            errs.append(f"RULE B an empty layer is excused by a non-deterministic pick: {r[:90]}")
    for e in errs:
        print("FAIL", e)
    if errs:
        return 1
    print(f"seed_determinism: OK ({n} seeds ordered, no luck-based excuses)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
