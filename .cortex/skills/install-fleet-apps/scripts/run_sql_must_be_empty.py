#!/usr/bin/env python3
"""Run a SQL invariant file; PASS only if every query in it returns zero rows.

Why this exists: check_stream_invariants.sql was a manual query - "non-zero
rows is a FAILURE" lived in a comment, so it ran only when someone remembered,
and its pass condition carried a memorised exception (one pre-fix dataset in one
region). As a live gate it runs after every fresh install, where that dataset
cannot exist, so the condition is strict: every result set empty.

A failed execution is a FAILURE, never "zero rows": a query that cannot compile
returns nothing, and reading that as clean is the false pass this guards against.

Usage:  python3 run_sql_must_be_empty.py -c <connection> <file.sql>
        python3 run_sql_must_be_empty.py -c <conn> --status-column STATUS \
                -D REGION=SanFrancisco verify_labor_layer.sql
        (status mode: every row is an assertion; PASS only if none is FAIL and
         at least one assertion row exists. WARN rows are printed, not failed.)
Exit:   0 every query empty, 1 a query returned rows or did not run
Env:    SNOW_BIN overrides the `snow` executable (the negative test injects a fake)
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("-c", "--connection", required=True)
    ap.add_argument("--status-column")
    ap.add_argument("-D", dest="defines", action="append", default=[])
    ap.add_argument("sql_file")
    a = ap.parse_args()
    snow = os.environ.get("SNOW_BIN", "snow")
    cmd = [snow, "sql", "-c", a.connection, "-f", a.sql_file, "--format", "json"]
    for d in a.defines:
        cmd += ["-D", d]
    p = subprocess.run(cmd, capture_output=True, text=True)
    name = os.path.basename(a.sql_file)
    if p.returncode != 0:
        print(f"{name}: FAILED - the SQL did not run (rc={p.returncode}):")
        print("  " + (p.stderr or p.stdout).strip().replace("\n", "\n  ")[:2000])
        return 1
    try:
        results = json.loads(p.stdout)
    except json.JSONDecodeError:
        print(f"{name}: FAILED - unparseable output from snow:\n  {p.stdout[:500]}")
        return 1
    # A single statement prints a bare list of rows; several print a list of lists.
    if results and isinstance(results[0], dict):
        results = [results]
    if a.status_column:
        col = a.status_column
        rows = [r for s in results for r in s if isinstance(r, dict) and col in r]
        if not rows:
            print(f"{name}: FAILED - no row carries a {col} column; the file "
                  "asserted nothing")
            return 1
        bad = [r for r in rows if str(r[col]).upper() == "FAIL"]
        warn = [r for r in rows if str(r[col]).upper() == "WARN"]
        for r in bad + warn:
            print(f"  {str(r[col]).upper():4}  {r}")
        if bad:
            print(f"{name}: FAILED - {len(bad)} of {len(rows)} assertion(s) FAIL")
            return 1
        print(f"{name}: OK - {len(rows)} assertion(s), 0 FAIL"
              + (f", {len(warn)} WARN" if warn else ""))
        return 0
    queries = [r for r in results
               if not (r and all(set(row) == {"status"} for row in r))]
    if not queries:
        print(f"{name}: FAILED - no query result found; the file checked nothing")
        return 1
    dirty = [(i, r) for i, r in enumerate(queries, 1) if r]
    for i, rows in dirty:
        print(f"{name}: query {i} returned {len(rows)} row(s), expected 0:")
        for row in rows[:10]:
            print(f"    {row}")
    if dirty:
        print(f"{name}: FAILED - {len(dirty)} of {len(queries)} invariant(s) violated")
        return 1
    print(f"{name}: OK - {len(queries)} invariant quer(ies), all empty")
    return 0


if __name__ == "__main__":
    sys.exit(main())
