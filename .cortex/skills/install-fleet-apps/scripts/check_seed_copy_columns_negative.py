#!/usr/bin/env python3
"""Negative for check_seed_copy_columns: each mutation must be convicted."""
import re
import sys

import seed_contract as sc

RAW = sc.LOADER.read_text()
SHAPES = sc.table_shapes()


def run(label, text, expect):
    path = sc.LOADER.with_name(".neg_load-seed-data.sql")
    path.write_text(text)
    try:
        problems = sc.violations(SHAPES, sc.copies(path))
    finally:
        path.unlink()
    hit = any(expect in p for p in problems)
    print(("PASS" if hit else "FAIL") + f": {label}" + ("" if hit else f" (got {problems})"))
    return hit


def drop_list(table):
    """Remove the column list that follows `COPY INTO <table>`."""
    return re.sub(r"(COPY INTO " + re.escape(table) + r")\s*\([^)]*\)", r"\1", RAW, count=1)


ok = all([
    # The shipped defect: LOOKUP's transform COPY with no column list.
    run("LOOKUP column list removed", drop_list("FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP"),
        "binds by position"),
    # A list one short of the SELECT (a column added to the SELECT only).
    run("list shorter than SELECT",
        RAW.replace("DEPOT_CTYPE, DEPOT_LABEL, JOB_ID)", "DEPOT_CTYPE, DEPOT_LABEL)", 1),
        "13 SELECT values"),
    # A column named in the list that no CREATE/ADD COLUMN declares.
    run("undeclared column in list",
        RAW.replace("DEPOT_CTYPE, DEPOT_LABEL, JOB_ID)", "DEPOT_CTYPE, DEPOT_LABL, JOB_ID)", 1),
        "DEPOT_LABL is not declared"),
    # A by-name COPY that loses MATCH_BY_COLUMN_NAME degrades to positional.
    run("MATCH_BY_COLUMN_NAME removed",
        RAW.replace("MATCH_BY_COLUMN_NAME = CASE_INSENSITIVE\n", "", 1),
        "without MATCH_BY_COLUMN_NAME"),
])
sys.exit(0 if ok else 1)
